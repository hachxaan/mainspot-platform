/**
 * E2E DEV-E2E-03 — interfaz de Claude Design integrada, recorrida en un NAVEGADOR REAL (Chrome vía
 * playwright-core) por el dominio oficial de desarrollo https://app.mainspot.local.io (proxy HTTPS
 * del LXC webserver, certificado de la CA local) contra el servidor real (`node src/api/server.ts`,
 * worker en proceso), la CLI de alta y PostgreSQL de pruebas (recreada por test-prep).
 * No usa el prototipo file://, ni fixtures, ni el puerto interno como atajo, ni ignora errores TLS.
 *
 * La prueba es dueña del upstream del proxy: arranca el servidor en E2E_UPSTREAM_PORT (3100) y
 * falla de inmediato si ese puerto ya está ocupado (p. ej. scripts/dev-panel.sh en marcha).
 * E2E_BASE_URL permite otro origen HTTPS; por defecto https://app.mainspot.local.io.
 *
 * Recorrido: invitación → contraseña → datos del negocio → primera página (vista previa →
 * aprobación → publicación sin 502) → Telegram simulado vinculado → recarga → tres teléfonos
 * independientes (TEL-01..04) → número nuevo de la web por vista previa → chat (teléfono dirigido a
 * «Teléfonos», horario con vista previa y publicación única) → ficha de Google → post de Facebook →
 * reglas con consentimiento → reseñas/comentarios simulados atendidos por el worker con el navegador
 * CERRADO → decisión por Telegram y por panel, vista en otra sesión → reinicio del servidor →
 * roles (Operación / Solo lectura) → aislamiento entre negocios → cuenta nueva sin página →
 * errores 401/404/429 → XSS escapado.
 *
 * Proveedores Google, Meta y Telegram: SIMULADOS (nada aquí prueba conexiones reales).
 * Evidencia: evidence/e2e-dev-e2e-03.txt (+ capturas con EVIDENCE_SCREENSHOTS=1).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, execSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import tls from 'node:tls';
import pg from 'pg';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { TEST_URL, SEED } from '../helpers/testdb.ts';

const BASE = (process.env.E2E_BASE_URL ?? 'https://app.mainspot.local.io').replace(/\/$/, '');
const UPSTREAM_PORT = Number(process.env.E2E_UPSTREAM_PORT ?? 3100);
// Node confía en la misma CA local que el navegador (almacén del sistema), sin desactivar TLS.
tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);

const transcript: string[] = [];
function say(line: string): void {
  transcript.push(line);
  console.log(line);
}
let step = 0;
function check(ok: boolean, label: string): void {
  step += 1;
  say(`${ok ? 'PASS' : 'FAIL'} ${step}. ${label}`);
  assert.equal(ok, true, label);
}

const SHOTS = process.env.EVIDENCE_SCREENSHOTS === '1';
const SHOT_DIR = 'evidence/dev-e2e-03';
const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
const children = new Set<ChildProcess>();
let browser: Browser | null = null;
const pageErrors: string[] = [];

function chromePath(): string {
  const fromEnv = process.env.CHROME_PATH;
  const candidates = [fromEnv, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter((x): x is string => Boolean(x));
  const cache = `${homedir()}/.cache/ms-playwright`;
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
      candidates.push(`${cache}/${d}/chrome-linux64/chrome`, `${cache}/${d}/chrome-linux/chrome`);
    }
  }
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No se encontró Chrome/Chromium para el E2E de navegador (define CHROME_PATH).');
  return found;
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('JEV_') && !k.startsWith('TELEGRAM_')) env[k] = v;
  return {
    ...env, DATABASE_URL: TEST_URL, TEST_DATABASE_URL: TEST_URL, APP_ENV: 'test', JWT_SECRET: 'e2e-dev-e2e-03-secret-only-for-tests',
    JEV_MODE: 'disabled', CHANNEL_PRIMARY: 'simulated', REPUTATION_PROVIDER: 'simulated', SOCIAL_PROVIDER: 'simulated',
    RATE_LIMIT_MAX: '5',
    ENGAGEMENT_WORKER_INTERVAL_MS: '1000', ENGAGEMENT_POLL_INTERVAL_MS: '0', LOG_LEVEL: 'warn', ...extra,
  };
}

/** El servidor de la prueba debe ser el único upstream del dominio: nunca se comparte ni se reemplaza otro. */
async function assertUpstreamFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const s = createServer();
    s.once('error', (err: NodeJS.ErrnoException) => reject(err.code === 'EADDRINUSE'
      ? new Error(`El upstream de ${BASE} (puerto ${port}) está ocupado, probablemente por scripts/dev-panel.sh. Detenlo antes del E2E de navegador (no se usa otro puerto ni localhost como atajo).`)
      : err));
    s.listen(port, () => s.close(() => resolve()));
  });
}

async function startServer(): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ['src/api/server.ts'], {
    env: childEnv({ PORT: String(UPSTREAM_PORT), ENGAGEMENT_WORKER: 'on', PUBLIC_BASE_URL: BASE }), stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.add(proc);
  proc.once('exit', () => children.delete(proc));
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return proc; // a través del proxy HTTPS, con TLS verificado
    } catch {
      // aún arrancando
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`el servidor no respondió por ${BASE}`);
}

async function kill(proc: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill(signal);
  });
}

/** Sondeo de una condición observable en la BD (procesos independientes: worker, otro servidor). */
async function until<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout esperando: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
async function one<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await pool.query<T>(sql, params)).rows[0];
}

const base = BASE;
async function newPage(width = 390, height = 844): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser!.newContext({ viewport: { width, height }, locale: 'es-MX' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (err) => pageErrors.push(`${page.url()} :: ${err.message}`));
  return { ctx, page };
}
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });
}
async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => { (globalThis as unknown as { location: { hash: string } }).location.hash = h; }, hash);
}
async function confirmSheet(page: Page): Promise<void> {
  await page.locator('.sheet [data-sheet="0"]').click();
}
async function uiLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${base}/`);
  await page.locator('#l-email').fill(email);
  await page.locator('#l-pass').fill(password);
  await page.locator('#login-submit').click();
  await page.waitForURL(/#\/inicio/);
  await page.locator('.hello').waitFor();
}
async function apiFrom(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('mainspot.token')}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, { method, path, body });
}
async function invite(business: string, email: string): Promise<{ tenant_id: string; invitation_link: string }> {
  return JSON.parse(execFileSync(process.execPath, ['scripts/invite-owner.ts', '--business', business, '--email', email, '--base', base], { env: childEnv({}) }).toString());
}
async function phonesOf(tenant: string): Promise<Record<string, { mode: string; other: string | null }>> {
  const rows = (await pool.query<{ channel: string; mode: string; other_e164: string | null }>('SELECT channel, mode, other_e164 FROM integration_phone WHERE tenant_id = $1', [tenant])).rows;
  return Object.fromEntries(rows.map((r) => [r.channel, { mode: r.mode, other: r.other_e164 }]));
}
async function setOther(page: Page, route: string, ch: string, apiCh: string, tenant: string, national: string, e164: string): Promise<void> {
  await go(page, route);
  const card = page.locator(`#phone-${ch}`);
  await card.locator('input[value="other"]').check();
  await page.locator(`#ph-num-${ch}`).fill(national);
  await page.locator(`#ph-save-${ch}`).click();
  await until(`teléfono ${ch}`, async () => (await phonesOf(tenant))[apiCh]?.other === e164 && (await phonesOf(tenant))[apiCh]?.mode === 'other');
}

after(async () => {
  if (browser) await browser.close().catch(() => undefined);
  for (const c of children) await kill(c, 'SIGKILL');
  await pool.end();
  // El worker real recorre también los negocios semilla: se recrea la BD para los demás E2E.
  execFileSync(process.execPath, ['scripts/test-prep.ts'], { stdio: 'ignore' });
  if (step === 0) return; // no arrancó (p. ej. upstream ocupado): no se sobrescribe la evidencia anterior
  try {
    mkdirSync('evidence', { recursive: true });
    const head = execSync('git rev-parse HEAD').toString().trim();
    const dirty = execSync('git status --porcelain -- src tests scripts').toString().trim() ? ' (+ cambios sin commit en src/tests/scripts)' : '';
    writeFileSync('evidence/e2e-dev-e2e-03.txt',
      `# E2E DEV-E2E-03 — navegador real + servidor real + PostgreSQL (run ${new Date().toISOString()})\n# HEAD: ${head}${dirty}\n` +
      `# origen: ${BASE} (proxy HTTPS LXC webserver → upstream :${UPSTREAM_PORT}; TLS verificado, sin ignoreHTTPSErrors)\n` +
      `# navegador: ${chromePath()} (headless) · servidor: node src/api/server.ts (worker en proceso, ciclo 1 s)\n` +
      `# proveedores: simulated (Google, Meta, Telegram); ningún resultado es real\n# DB: mainspot_test (recreada por scripts/test-prep.ts)\n\n${transcript.join('\n')}\n\n# Fin de transcript\n`);
    console.log(`EVIDENCE_SAVED evidence/e2e-dev-e2e-03.txt (HEAD ${head})`);
  } catch (err) {
    console.error('WARN evidence write failed:', (err as Error).message);
  }
});

test('E2E DEV-E2E-03: interfaz de Claude Design en navegador contra servidor, worker y PostgreSQL reales', { timeout: 240_000 }, async () => {
  await assertUpstreamFree(UPSTREAM_PORT);
  let server = await startServer();
  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  say(`servidor real detrás de ${base} (upstream :${UPSTREAM_PORT}) · Chrome headless · worker en proceso [proveedores simulated]`);

  // ---------- Alta: invitación → contraseña → datos del negocio ----------
  say('\n-- FLOW-01: invitación de un solo uso y alta en la interfaz de Claude --');
  const email = `lupita.e2e.${Date.now()}@example.com`;
  const inv = await invite('Panadería Lupita', email);
  const tenant = inv.tenant_id;
  const token = inv.invitation_link.split('#')[1] ?? '';
  let { ctx: ownerCtx, page } = await newPage(390, 844);
  await page.goto(inv.invitation_link);
  await page.getByText('Panadería Lupita ya tiene su lugar en MainSpot').waitFor();
  check(!page.url().includes(token) && (await page.locator('[data-screen="DS-02"]').count()) === 1, 'invitación DS-02 muestra el negocio y retira el token de la barra');
  await shot(page, '01-invitacion-movil');
  await page.locator('a[href="#/activar/contrasena"]').click();
  await page.locator('#p-name').fill('Guadalupe Ramírez');
  await page.locator('#p-pass').fill('corta1');
  await page.locator('#p-pass2').fill('corta1');
  await page.locator('#pass-submit').click();
  check(await page.locator('#f-p-pass .field-error').isVisible(), 'contraseña débil: error en el campo, sin llamar a la API');
  await page.locator('#p-pass').fill('PanDulce2026');
  await page.locator('#p-pass2').fill('PanDulce2026');
  await page.locator('#pass-submit').click();
  await page.waitForURL(/#\/activar\/negocio/);
  const used = await fetch(`${base}/api/auth/invitation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const bogus = await fetch(`${base}/api/auth/invitation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(43) }) });
  check(used.status === 404 && JSON.stringify(await used.json()) === JSON.stringify(await bogus.json()), 'invitación usada = misma respuesta neutra que una inventada');
  const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
  check(!stored.includes('PanDulce2026'), 'la contraseña no queda en sessionStorage ni localStorage');

  await page.locator('#b-line').fill('Pan dulce y salado, recién horneado cada mañana');
  await page.locator('#ph-num-primary').fill('983 000 0000');
  await page.locator('#b-address').fill('Calle de los Fresnos 12, Chetumal');
  await page.locator('#b-hw').fill('7:00 a 20:00');
  await page.locator('#b-hs').fill('7:00 a 15:00');
  await page.locator('#b-hd').fill('Cerrado');
  for (const s of ['Pan dulce', 'Pasteles por encargo']) {
    await page.locator('#b-service').fill(s);
    await page.locator('[data-action="service-add"]').click();
  }
  await page.locator('#biz-submit').click();
  await page.waitForURL(/#\/activar\/telegram/);
  const site = await one<{ published_version: number; data: { line?: string } }>('SELECT published_version, data FROM client_website WHERE tenant_id = $1', [tenant]);
  const initial = await one<{ status: string }>(`SELECT status FROM action_proposal WHERE tenant_id = $1 AND proposal_type = 'website.initial'`, [tenant]);
  check(site?.published_version === 0 && site.data.line === 'Pan dulce y salado, recién horneado cada mañana' && initial?.status === 'preview_ready', 'datos del alta → página creada (cuota website) y primera versión con vista previa, sin publicar');

  // ---------- Telegram (simulado) ----------
  say('\n-- Telegram simulado: mismo webhook que el bot real --');
  await page.locator('[data-action="onb-telegram"]').click();
  await page.locator('#tg-code').waitFor();
  await page.locator('a[href^="#/chat?inicio="]').click();
  await page.locator('[data-action="tg-start"]').click();
  await page.getByText('Listo: este chat recibirá los avisos de MainSpot').waitFor();
  const link = await one<{ chat_id: string }>(`SELECT chat_id FROM telegram_link WHERE tenant_id = $1 AND status = 'active'`, [tenant]);
  check(Boolean(link) && !/\d{10}/.test(link!.chat_id), 'chat vinculado con código de un solo uso (el chat no es el teléfono público)');
  await page.locator('[data-action="tg-close"]').click();

  // ---------- Primera publicación ----------
  say('\n-- Primera página: vista previa → aprobación → publicación (sin 502) --');
  await go(page, '#/inicio');
  await page.getByRole('link', { name: 'Revisar mi primera página' }).first().click();
  await page.locator('#approve-btn').waitFor();
  await shot(page, '02-primera-pagina-vista-previa');
  await page.locator('#approve-btn').click();
  await confirmSheet(page);
  await page.getByText('Ya está en tu página (versión 1)').waitFor();
  const pub1 = await one<{ n: number }>(`SELECT count(*)::int AS n FROM publication WHERE tenant_id = $1 AND status = 'published'`, [tenant]);
  check((await one<{ published_version: number }>('SELECT published_version FROM client_website WHERE tenant_id = $1', [tenant]))?.published_version === 1 && pub1?.n === 1, 'primera página publicada una vez (versión 1), en el entorno de desarrollo');
  await page.reload();
  await go(page, '#/inicio');
  await page.getByText('Tu página ya está en internet').waitFor();
  check(page.url().includes('#/inicio'), 'recarga: la sesión y el estado vienen del backend (sin volver a entrar)');

  // ---------- Teléfonos por integración ----------
  say('\n-- TEL-01..04: tres «Otro número» independientes --');
  await setOther(page, '#/pagina', 'website', 'website', tenant, '983 111 1111', '+529831111111');
  await setOther(page, '#/google', 'google', 'google_business_profile', tenant, '983 222 2222', '+529832222222');
  await setOther(page, '#/facebook', 'facebook', 'facebook', tenant, '983 333 3333', '+529833333333');
  await go(page, '#/negocio');
  const shown = await Promise.all(['website', 'google', 'facebook'].map((ch) => page.locator(`[data-ph-value="${ch}"]`).innerText()));
  say(`   Mi negocio → web=${shown[0]} google=${shown[1]} facebook=${shown[2]}`);
  check(new Set(shown).size === 3 && shown[0] === '+52 983 111 1111', 'TEL-01 tres números distintos guardados y mostrados por canal');
  await setOther(page, '#/facebook', 'facebook', 'facebook', tenant, '983 444 4444', '+529834444444');
  let ph = await phonesOf(tenant);
  check(ph.website?.other === '+529831111111' && ph.google_business_profile?.other === '+529832222222', 'TEL-02 cambiar solo Facebook no toca Página web ni Google');
  await go(page, '#/pagina');
  await page.locator('#phone-website input[value="own"]').check();
  await page.locator('#ph-save-website').click();
  await until('web en modo own', async () => (await phonesOf(tenant)).website?.mode === 'own');
  await go(page, '#/negocio');
  await page.locator('#ph-num-primary').fill('983 555 5555');
  await page.locator('#ph-save-primary').click();
  await until('principal nuevo', async () => (await one<{ e: string }>('SELECT primary_e164 AS e FROM business_contact WHERE tenant_id = $1', [tenant]))?.e === '+529835555555');
  const view = await apiFrom(page, 'GET', '/api/backoffice/contact/phones');
  const eff = view.body.integration_phones;
  check(eff.website.effective_phone === '+529835555555' && eff.google_business_profile.effective_phone === '+529832222222' && eff.facebook.effective_phone === '+529834444444', 'TEL-03 el principal cambia solo los canales en «Usar mi número»');
  await go(page, '#/pagina');
  await page.locator('#phone-website input[value="other"]').check();
  check((await page.locator('#ph-num-website').inputValue()).replace(/\D/g, '') === '9831111111', 'TEL-04 other→own→other recupera el número propio de la web');
  await page.locator('#ph-save-website').click();
  await until('web vuelve a other', async () => (await phonesOf(tenant)).website?.mode === 'other');
  const bad = await apiFrom(page, 'PUT', '/api/backoffice/contact/phones/integrations/facebook', { mode: 'other', other_phone: { country_iso2: 'MX', national_number: '12345' } });
  check(bad.status === 400 && Array.isArray(bad.body.error.fields), 'TEL-04 número inválido para el país → 400 con error por campo');

  // ---------- Número nuevo de la web: vista previa y aprobación ----------
  say('\n-- Página web: el número nuevo se publica con vista previa --');
  await go(page, '#/pagina');
  await page.locator('#phone-website [data-action="ph-web-publish"]').click();
  await page.waitForURL(/#\/vista-previa\//);
  await page.locator('#approve-btn').click();
  await confirmSheet(page);
  await page.getByText('Ya está en tu página (versión 2)').waitFor();
  const v2 = await one<{ data: { phone: string } }>('SELECT data FROM client_website WHERE tenant_id = $1', [tenant]);
  check(v2?.data.phone === '+52 983 111 1111', 'versión 2 publicada con el teléfono propio de la Página web');

  // ---------- Chat ----------
  say('\n-- Chat: una sola fuente del teléfono; cambio de horario con vista previa --');
  await go(page, '#/cambios/nuevo');
  const before = await one<{ n: number }>('SELECT count(*)::int AS n FROM action_proposal WHERE tenant_id = $1', [tenant]);
  await page.locator('#panel-input').fill('Cambia el teléfono a 983 999 9999');
  await page.locator('#panel-send').click();
  await page.getByRole('button', { name: 'Cambiar el teléfono de mi página' }).waitFor();
  const afterPhone = await one<{ n: number }>('SELECT count(*)::int AS n FROM action_proposal WHERE tenant_id = $1', [tenant]);
  check(afterPhone?.n === before?.n, '«cambia el teléfono» por chat dirige a «Teléfonos de contacto» sin crear propuesta');
  await page.locator('#panel-input').fill('El horario es de 08:00 a 19:00');
  await page.locator('#panel-send').click();
  await page.getByRole('button', { name: 'Sí, prepara la vista previa' }).click();
  await page.getByRole('button', { name: 'Ver vista previa' }).last().click();
  await page.locator('#approve-btn').click();
  await confirmSheet(page);
  await page.getByText('Ya está en tu página (versión 3)').waitFor();
  const hoursProp = await one<{ proposal_id: string }>(`SELECT proposal_id FROM action_proposal WHERE tenant_id = $1 AND status = 'published' ORDER BY updated_at DESC LIMIT 1`, [tenant]);
  const again = await apiFrom(page, 'POST', `/api/backoffice/conversation/proposals/${hoursProp!.proposal_id}/approve`);
  const pubs = await one<{ n: number }>('SELECT count(*)::int AS n FROM publication WHERE proposal_id = $1', [hoursProp!.proposal_id]);
  check(again.body.already_published === true && pubs?.n === 1, 'chat → confirmación → vista previa → aprobación → publicado una vez; repetir no duplica');

  // ---------- Google y Facebook (simulados) ----------
  say('\n-- Google (ficha simulada) y Facebook (publicación simulada) --');
  await go(page, '#/google');
  await page.locator('#g-cat').fill('Panadería');
  await page.locator('#g-loc').fill('Chetumal');
  await page.locator('#gbp-submit').click();
  await until('ficha de Google', async () => one('SELECT 1 FROM gbp_profile WHERE tenant_id = $1', [tenant]));
  await page.getByText('Igual que en tu página').waitFor();
  check((await page.locator('main').innerText()).includes('+52 983 222 2222'), 'ficha de Google persistida; muestra el teléfono propio de Google');
  await go(page, '#/facebook/nueva');
  await page.locator('#fb-prompt').fill('ya tenemos pan de muerto recién horneado');
  await page.locator('#fb-prepare').click();
  check((await page.locator('#fb-text').inputValue()).includes('+52 983 444 4444'), 'borrador de Facebook incluye el teléfono propio de Facebook');
  await page.locator('#fb-submit').click();
  await confirmSheet(page);
  await page.waitForURL(/#\/facebook\/post\//);
  await page.getByText('Publicada (simulado)').first().waitFor();
  const post = await one<{ post_id: string; status: string }>(`SELECT post_id, status FROM social_post WHERE tenant_id = $1`, [tenant]);
  check(post?.status === 'published', 'publicación de Facebook aprobada y publicada en el simulador');

  // ---------- Reglas con consentimiento ----------
  say('\n-- Agente: reglas opt-in con consentimiento explícito --');
  const noConsent = await apiFrom(page, 'PUT', '/api/backoffice/engagement/policies', { origin: 'google_review', category: 'gratitude', mode: 'safe_auto_reply' });
  check(noConsent.status === 400, 'API: respuesta automática sin consentimiento → 400');
  await go(page, '#/atencion/reglas');
  await page.locator('#pol-switch').click();
  await page.locator('#pol-thanks-auto').check();
  await page.locator('#pol-info-auto').check();
  await page.locator('#pol-save').click();
  await confirmSheet(page);
  check(await page.locator('#pol-consent-err').isVisible(), 'UI: «Autorizar» sin marcar la casilla no guarda');
  await page.locator('#pol-consent').check();
  await confirmSheet(page);
  const pols = await until('4 políticas', async () => {
    const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM engagement_policy WHERE tenant_id = $1 AND mode = 'safe_auto_reply'`, [tenant]);
    return r && r.n === 4 ? r : null;
  });
  check(pols.n === 4, 'reglas guardadas como versiones con consentimiento (Google y Facebook, agradecimientos y datos)');

  // ---------- Llegadas simuladas, worker con el navegador cerrado ----------
  say('\n-- AG-01..03: el worker atiende con el navegador CERRADO --');
  await go(page, '#/atencion');
  for (const k of ['g_thanks', 'g_complaint', 'f_question', 'f_risk']) {
    await page.locator(`[data-action="arrive"][data-arg="${k}"]`).click();
    await until(`evento ${k}`, async () => {
      const r = await one<{ n: number }>('SELECT count(*)::int AS n FROM sim_provider_event WHERE tenant_id = $1', [tenant]);
      return r && r.n >= ['g_thanks', 'g_complaint', 'f_question', 'f_risk'].indexOf(k) + 1;
    });
  }
  await ownerCtx.close();
  say('   navegador del dueño cerrado; solo el servidor sigue');
  const settled = await until('casos atendidos', async () => {
    const r = (await pool.query<{ state: string; notify_status: string | null }>('SELECT state, notify_status FROM engagement_case WHERE tenant_id = $1', [tenant])).rows;
    return r.length === 4 && r.filter((x) => x.state === 'responded').length === 2 && r.filter((x) => x.state === 'needs_human' && x.notify_status === 'sent').length === 2 ? r : null;
  }, 30_000);
  const autoCases = (await pool.query<{ origin: string; response_text: string; policy_version: number; delivery_mode: string }>(
    `SELECT origin, response_text, policy_version, delivery_mode FROM engagement_case WHERE tenant_id = $1 AND resolution_channel = 'auto'`, [tenant])).rows;
  check(autoCases.length === 2 && autoCases.every((c) => c.policy_version === 1 && c.delivery_mode === 'simulated'), 'AG-01 agradecimiento y pregunta simple respondidos solos (regla v1, simulated)');
  check(autoCases.some((c) => c.origin === 'facebook_comment' && /983 444 4444/.test(c.response_text)), 'AG-03 la pregunta en Facebook se responde con el número de Facebook');
  check(settled.filter((x) => x.state === 'needs_human').length === 2, 'AG-02 queja y amenaza → casos humanos con un aviso por Telegram cada uno (simulado)');

  // ---------- Decisión por Telegram y por panel, dos sesiones ----------
  say('\n-- Telegram y panel deciden el MISMO caso; otra sesión lo ve --');
  ({ ctx: ownerCtx, page } = await newPage(1280, 900));
  await uiLogin(page, email, 'PanDulce2026');
  const { ctx: secondCtx, page: second } = await newPage(390, 844);
  await uiLogin(second, email, 'PanDulce2026');
  const complaint = await one<{ case_id: string }>(`SELECT case_id FROM engagement_case WHERE tenant_id = $1 AND origin = 'google_review' AND state = 'needs_human'`, [tenant]);
  const risk = await one<{ case_id: string }>(`SELECT case_id FROM engagement_case WHERE tenant_id = $1 AND origin = 'facebook_comment' AND state = 'needs_human'`, [tenant]);
  await go(second, `#/caso/${complaint!.case_id}`);
  await second.locator('#case-submit').waitFor();
  await go(page, '#/chat');
  await shot(page, '03-escritorio-telegram-simulado');
  const msg = page.locator('.tg-msg', { hasText: complaint!.case_id }).first();
  await msg.getByRole('button', { name: 'Usar opción 1' }).click();
  await page.getByRole('button', { name: 'Sí, publicar' }).click();
  await page.getByText('Respuesta publicada (simulación).').waitFor();
  const viaTg = await one<{ state: string; resolution_channel: string }>('SELECT state, resolution_channel FROM engagement_case WHERE case_id = $1', [complaint!.case_id]);
  check(viaTg?.state === 'responded' && viaTg.resolution_channel === 'telegram', 'caso aprobado desde Telegram (opción 1, con segundo toque)');
  await second.locator('#case-answer').waitFor({ timeout: 15_000 });
  check((await second.locator('#case-answer').innerText()).includes('desde Telegram'), 'la otra sesión abierta muestra la misma resolución sin recargar');
  await go(page, `#/caso/${risk!.case_id}`);
  await page.locator('#case-reject').click();
  await confirmSheet(page);
  await page.getByText('Se decidió no responder').waitFor();
  check((await one<{ state: string }>('SELECT state FROM engagement_case WHERE case_id = $1', [risk!.case_id]))?.state === 'rejected', 'caso delicado descartado desde el panel (sin respuesta pública)');
  await shot(second, '04-movil-caso-resuelto');

  // ---------- Reinicio ----------
  say('\n-- Reinicio del servidor: estado persistente, sin duplicados --');
  await kill(server, 'SIGKILL');
  server = await startServer();
  await page.reload();
  await go(page, '#/atencion');
  await page.locator('#case-list').waitFor();
  const listed = await page.locator('#case-list li').count();
  await new Promise((r) => setTimeout(r, 2500)); // dos ciclos del worker tras el reinicio
  const replies = await one<{ n: number }>('SELECT count(*)::int AS n FROM sim_provider_reply WHERE tenant_id = $1', [tenant]);
  const notifs = await one<{ n: number }>('SELECT count(*)::int AS n FROM engagement_notification WHERE tenant_id = $1', [tenant]);
  check(listed === 4 && replies?.n === 3 && notifs?.n === 2, 'tras SIGKILL y reinicio: misma sesión, 4 casos, 3 respuestas simuladas y 2 avisos (sin duplicados)');

  // ---------- Roles ----------
  say('\n-- Roles: Administración crea Operación y Solo lectura; RBAC en UI y API --');
  await go(page, '#/negocio');
  for (const [name, mail, role] of [['Toño Ramírez', `tono.${Date.now()}@example.com`, 'operation'], ['Rosa Méndez', `rosa.${Date.now()}@example.com`, 'read_only']]) {
    await page.locator('#t-name').fill(name!);
    await page.locator('#t-email').fill(mail!);
    await page.locator('#t-pass').fill('Equipo2026x');
    await page.locator('#t-role').selectOption(role!);
    await page.locator('#team-submit').click();
    await page.locator('#team-list', { hasText: name! }).waitFor();
  }
  const team = (await pool.query<{ login: string; role_id: string }>('SELECT u.login, r.role_id FROM internal_user u JOIN user_role r ON r.user_id = u.user_id WHERE u.tenant_id = $1 ORDER BY u.created_at', [tenant])).rows;
  check(team.length === 3 && team[1]?.role_id === 'operation' && team[2]?.role_id === 'read_only', 'equipo creado desde «Mi negocio» con su perfil');
  const { ctx: opsCtx, page: ops } = await newPage(1280, 900);
  await uiLogin(ops, team[1]!.login, 'Equipo2026x');
  await go(ops, '#/cambios/nuevo');
  await ops.locator('#panel-input').fill('Agrega un servicio llamado Café de olla');
  await ops.locator('#panel-send').click();
  await ops.getByRole('button', { name: 'Sí, prepara la vista previa' }).click();
  await ops.getByRole('button', { name: 'Ver vista previa' }).last().click();
  await ops.locator('#no-approve').waitFor();
  const cafe = ops.url().split('/').pop()!;
  const forced = await apiFrom(ops, 'POST', `/api/backoffice/conversation/proposals/${cafe}/approve`);
  check((await ops.locator('#approve-btn').count()) === 0 && forced.status === 403, 'Operación prepara la vista previa pero no puede aprobar (UI sin botón; API 403)');
  const { ctx: roCtx, page: ro } = await newPage(390, 844);
  await uiLogin(ro, team[2]!.login, 'Equipo2026x');
  const roHome = await ro.locator('#home-ask').count();
  const roSend = await apiFrom(ro, 'POST', '/api/backoffice/conversation/messages', { text: 'cambia el horario a 10:00 a 12:00', channel: 'simulated' });
  await go(ro, `#/vista-previa/${cafe}`);
  await ro.locator('#no-approve').waitFor();
  check(roHome === 0 && (await ro.locator('#approve-btn, #reject-btn').count()) === 0 && roSend.status === 403, 'Solo lectura ve la vista previa sin controles; enviar por API → 403');
  await go(page, `#/vista-previa/${cafe}`);
  await page.locator('#reject-btn').click();
  await confirmSheet(page);
  await page.waitForURL(new RegExp(`#/cambios/${cafe}`));
  await page.locator('.page-head .tag', { hasText: 'Descartado' }).waitFor();
  check((await one<{ status: string }>('SELECT status FROM action_proposal WHERE proposal_id = $1', [cafe]))?.status === 'rejected', 'Administración descarta la propuesta de Operación (nada se publica)');
  await opsCtx.close();
  await roCtx.close();

  // ---------- Aislamiento ----------
  say('\n-- Aislamiento entre negocios --');
  const { ctx: otherCtx, page: other } = await newPage(390, 844);
  await uiLogin(other, SEED.b.admin.login, SEED.b.admin.password);
  await go(other, `#/caso/${complaint!.case_id}`);
  await other.getByText('No encontramos este caso').waitFor();
  const foreign = await apiFrom(other, 'GET', `/api/backoffice/engagement/cases/${complaint!.case_id}`);
  const ghost = await apiFrom(other, 'GET', '/api/backoffice/engagement/cases/case_inexistente');
  check(foreign.status === 404 && JSON.stringify(foreign.body) === JSON.stringify(ghost.body), 'otro negocio: la UI no encuentra el caso y la API responde el mismo 404 que uno inexistente');
  await otherCtx.close();

  // ---------- Cuenta nueva sin página ----------
  say('\n-- Cuenta nueva sin página: crearla antes de editar o publicar --');
  const email2 = `mary.e2e.${Date.now()}@example.com`;
  const inv2 = await invite('Cocina Doña Mary', email2);
  const { ctx: newCtx, page: fresh } = await newPage(414, 896);
  await fresh.goto(inv2.invitation_link);
  await fresh.locator('a[href="#/activar/contrasena"]').click();
  await fresh.locator('#p-name').fill('Mary');
  await fresh.locator('#p-pass').fill('MolePoblano2026');
  await fresh.locator('#p-pass2').fill('MolePoblano2026');
  await fresh.locator('#pass-submit').click();
  await fresh.waitForURL(/#\/activar\/negocio/);
  await go(fresh, '#/cambios/nuevo');
  await fresh.locator('#panel-input').fill('El horario es de 10:00 a 18:00');
  await fresh.locator('#panel-send').click();
  await fresh.getByRole('button', { name: 'Crear mi página' }).last().waitFor();
  const firstPub = await apiFrom(fresh, 'POST', '/api/backoffice/website/first-publication');
  const props2 = await one<{ n: number }>('SELECT count(*)::int AS n FROM action_proposal WHERE tenant_id = $1', [inv2.tenant_id]);
  check(firstPub.status === 409 && firstPub.body.error.code === 'website_missing' && props2?.n === 0, 'sin página: el chat orienta a crearla (sin propuesta) y la API responde 409 website_missing, no 502');
  await fresh.getByRole('button', { name: 'Crear mi página' }).last().click();
  await fresh.waitForURL(/#\/pagina\/crear/);
  await fresh.locator('#b-line').fill('Comida casera');
  await fresh.locator('#ph-num-primary').fill('983 123 4567');
  await fresh.locator('#b-address').fill('Av. Héroes 100, Chetumal');
  await fresh.locator('#b-hw').fill('9:00 a 18:00');
  await fresh.locator('#b-hs').fill('9:00 a 14:00');
  await fresh.locator('#b-hd').fill('Cerrado');
  await fresh.locator('#b-service').fill('Mole poblano');
  await fresh.locator('#biz-submit').click();
  await fresh.waitForURL(/#\/vista-previa\//);
  await fresh.locator('#approve-btn').click();
  await confirmSheet(fresh);
  await fresh.getByText('Ya está en tu página (versión 1)').waitFor();
  const site2 = await one<{ published_version: number; phone: string }>(`SELECT published_version, data->>'phone' AS phone FROM client_website WHERE tenant_id = $1`, [inv2.tenant_id]);
  check(site2?.published_version === 1 && site2.phone === '+52 983 123 4567', 'cuenta nueva: «Crear mi página» → vista previa → publicada (versión 1) con su teléfono');
  await newCtx.close();

  // ---------- Errores y seguridad ----------
  say('\n-- Errores 401/404/429 y contenido escapado --');
  await go(page, '#/vista-previa/no-existe');
  await page.getByText('Este enlace de vista previa no funciona').waitFor();
  check(true, '404: enlace de vista previa inexistente → mensaje claro');
  await apiFrom(page, 'POST', '/api/backoffice/dev/simulator/google-reviews', { rating: 3, body: '<img src=x onerror="window.__xss=1">hola', author_label: '<b>Hacker</b>' });
  await until('caso con HTML', async () => one(`SELECT 1 FROM engagement_case WHERE tenant_id = $1 AND body LIKE '<img%' AND state <> 'received'`, [tenant]));
  await go(page, '#/atencion');
  await page.locator('#case-list', { hasText: '<b>Hacker</b>' }).waitFor({ timeout: 15_000 });
  check((await page.locator('#case-list img, #case-list b').count()) === 0 && !(await page.evaluate(() => (globalThis as unknown as { __xss?: number }).__xss)), 'texto de clientes con HTML se muestra escapado (sin ejecutar)');
  const csp = (await fetch(`${base}/panel`)).headers.get('content-security-policy') ?? '';
  check(/script-src 'self'(;|$)/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), 'CSP del panel: solo scripts propios (sin inline)');
  const { ctx: lockCtx, page: lock } = await newPage(390, 844);
  await lock.goto(`${base}/`);
  for (let i = 0; i < 6; i += 1) {
    await lock.locator('#l-email').fill('nadie@example.com');
    await lock.locator('#l-pass').fill('incorrecta');
    await lock.locator('#login-submit').click();
    await lock.locator('#login-error').waitFor({ state: 'visible' });
  }
  check((await lock.locator('#login-error-text').innerText()).includes('demasiados intentos'), '429: demasiados intentos de acceso → mensaje con espera, sin revelar cuentas');
  await lock.evaluate(() => sessionStorage.setItem('mainspot.token', 'token-invalido'));
  await lock.goto(`${base}/panel#/inicio`);
  await lock.waitForURL(/#\/entrar/);
  check(true, '401: sesión inválida → vuelve a «Entrar»');
  await lockCtx.close();
  await secondCtx.close();
  await shot(page, '05-escritorio-atencion');
  await ownerCtx.close();

  check(pageErrors.length === 0, `sin errores de JavaScript en el navegador${pageErrors.length ? ': ' + pageErrors.join(' | ') : ''}`);
  await kill(server, 'SIGTERM');
});
