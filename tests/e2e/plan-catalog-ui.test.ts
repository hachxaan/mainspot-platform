/**
 * E2E Planes (DEC-0075 / SRC-0013) — catálogo de planes versionado recorrido en un NAVEGADOR REAL (Chrome
 * vía playwright-core) por el dominio oficial https://app.mainspot.local.io (proxy HTTPS del LXC, CA
 * local, TLS verificado) contra el servidor real (`node src/api/server.ts`) y la BD de pruebas
 * (recreada por test-prep). Sin puerto interno como atajo, sin ignorar TLS, sin proveedores reales.
 *
 * La prueba es dueña del upstream del proxy (E2E_UPSTREAM_PORT, 3100) y falla si está ocupado.
 *
 * Recorrido: soporte solo lee → ingeniería crea un plan clonado (deshabilitado, valores copiados SIN
 * confirmar) → validación en línea del techo → cambiar un valor desmarca su confirmación → publicar
 * bloqueado hasta confirmar los 8 (registro 3: las cuotas de IA de reseñas y de comentarios de Facebook llegan sugeridas en 0 y sin confirmar) → step-up TOTP cuando caduca → publicar v1 → habilitar → v2 →
 * Administration asigna el plan (fijado a v2) → ingeniería publica v3 (downgrade) → el negocio sigue en
 * v2 → vista previa con uso por encima del límite → Administration migra → rollback a v2 (v4) → el panel
 * del negocio muestra plan y uso en solo lectura y no puede asignarse planes → móvil sin desbordes →
 * conflicto de edición (valores del otro, sin confirmaciones implícitas) → descartar con confirmación explícita.
 * Entre medias: «1,000» rechazado, publicar bloqueado con cambios sin guardar, motivo con id de negocio rechazado.
 * Evidencia: evidence/plan-catalog/e2e-ui.txt (+ capturas con EVIDENCE_SCREENSHOTS=1).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import tls from 'node:tls';
import pg from 'pg';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { TEST_URL, SEED } from '../helpers/testdb.ts';
import { PlatformAuth, currentStep, totpAt, type PlatformRole } from '../../src/platform/auth.ts';
import { PLAN_PARAMETERS } from '../../src/plans/registry.ts';

/** Sufijo de los controles del editor por parámetro del registro (`quota.social_posts.max` → `social-posts`). */
const PARAMETER_KEYS = PLAN_PARAMETERS.map((d) => d.key.replace(/^quota\.|\.max$/g, '').replace(/_/g, '-'));

const BASE = (process.env.E2E_BASE_URL ?? 'https://app.mainspot.local.io').replace(/\/$/, '');
const UPSTREAM_PORT = Number(process.env.E2E_UPSTREAM_PORT ?? 3100);
tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);

const MFA_KEY = randomBytes(32).toString('base64');
const JWT = `e2e-plan-catalog-${randomUUID()}`;
const SHOTS = process.env.EVIDENCE_SCREENSHOTS === '1';
const SHOT_DIR = 'evidence/plan-catalog/ui';
const transcript: string[] = [];
const pool = new pg.Pool({ connectionString: TEST_URL, max: 3 });
const children = new Set<ChildProcess>();
const pageErrors: string[] = [];
let browser: Browser | null = null;
let n = 0;

function say(line: string): void {
  transcript.push(line);
  console.log(line);
}
function check(ok: boolean, label: string): void {
  n += 1;
  say(`${ok ? 'PASS' : 'FAIL'} ${n}. ${label}`);
  assert.equal(ok, true, label);
}

function chromePath(): string {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter((x): x is string => Boolean(x));
  const cache = `${homedir()}/.cache/ms-playwright`;
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((x) => x.startsWith('chromium-')).sort().reverse()) candidates.push(`${cache}/${d}/chrome-linux64/chrome`, `${cache}/${d}/chrome-linux/chrome`);
  }
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No se encontró Chrome/Chromium para el E2E de navegador (define CHROME_PATH).');
  return found;
}

async function assertUpstreamFree(port: number): Promise<void> {
  // tsconfig apunta a ES2022: Promise.withResolvers no está tipado, se usa el constructor.
  await new Promise<void>((resolve, reject) => {
    const s = createServer();
    s.once('error', (err: NodeJS.ErrnoException) => reject(err.code === 'EADDRINUSE'
      ? new Error(`El upstream de ${BASE} (puerto ${port}) está ocupado (¿mainspot-local?). Detenlo antes del E2E de navegador.`)
      : err));
    s.listen(port, () => s.close(() => resolve()));
  });
}

async function startServer(): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('JEV_') && !k.startsWith('TELEGRAM_')) env[k] = v;
  const proc = spawn(process.execPath, ['src/api/server.ts'], {
    env: {
      ...env, DATABASE_URL: TEST_URL, TEST_DATABASE_URL: TEST_URL, APP_ENV: 'test', JWT_SECRET: JWT, PLATFORM_MFA_KEY: MFA_KEY,
      PORT: String(UPSTREAM_PORT), PUBLIC_BASE_URL: BASE, JEV_MODE: 'disabled', AI_REAL_PROVIDERS: 'off', CHANNEL_PRIMARY: 'simulated',
      REPUTATION_PROVIDER: 'simulated', SOCIAL_PROVIDER: 'simulated', ENGAGEMENT_POLL_INTERVAL_MS: '0', LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.add(proc);
  proc.once('exit', () => children.delete(proc));
  // Proceso externo real: se sondea /health a través del proxy HTTPS hasta que responde (no hay evento que esperar).
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${BASE}/health`)).ok) return proc; } catch { /* arrancando */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`el servidor no respondió por ${BASE}`);
}

async function newPage(width = 1280, height = 900): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser!.newContext({ viewport: { width, height }, locale: 'es-MX' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (err) => pageErrors.push(`${page.url()} :: ${err.message}`));
  return { ctx, page };
}
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}
async function go(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => { (globalThis as unknown as { location: { hash: string } }).location.hash = h; }, hash);
}
async function one<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await pool.query<T>(sql, params)).rows[0];
}

interface Staff { login: string; password: string; secret: string; step: number }
async function staff(role: PlatformRole, auth: PlatformAuth): Promise<Staff> {
  const login = `${role.replace('_', '-')}-${randomUUID().slice(0, 6)}`;
  const password = `E2E-${role}-Plataforma-2026`;
  const u = await auth.createUser({ login, displayName: `E2E ${role}`, password, roles: [role], grantedBy: 'e2e' });
  return { login, password, secret: u.totp_secret, step: 0 };
}
/**
 * Código TOTP del menor paso aún no usado dentro de la ventana que acepta el servidor (paso actual ±1;
 * anti-replay: cada paso sirve una sola vez). Si los 3 de la ventana ya se usaron, espera al siguiente
 * paso de 30 s: el reloj del servidor es real y no se puede simular desde la prueba.
 */
async function nextCode(s: Staff): Promise<string> {
  for (;;) {
    const now = currentStep();
    const step = Math.max(s.step + 1, now - 1);
    if (step <= now + 1) {
      s.step = step;
      return totpAt(s.secret, step);
    }
    await new Promise((r) => setTimeout(r, (now + 1) * 30_000 - Date.now() + 50));
  }
}
async function platformLogin(page: Page, path: '/ingenieria' | '/plataforma', s: Staff): Promise<void> {
  await page.goto(`${BASE}${path}`);
  await page.locator('#pl-login').fill(s.login);
  await page.locator('#pl-pass').fill(s.password);
  await page.locator('#pl-code').fill(await nextCode(s));
  await page.locator('#pl-submit').click();
  await page.locator('.pc-top').waitFor();
}
/** Si aparece el diálogo de step-up, lo resuelve con el siguiente código. */
async function stepUpIfAsked(page: Page, s: Staff): Promise<boolean> {
  const dialog = page.locator('form[data-form="step-up"]');
  try { await dialog.waitFor({ timeout: 2500 }); } catch { return false; }
  await page.locator('#su-code').fill(await nextCode(s));
  await page.locator('#su-submit').click();
  await dialog.waitFor({ state: 'detached' });
  await page.locator('.pc-top').waitFor({ timeout: 3000 });
  return true;
}
/** Espera el aviso con ese texto; si no llega, deja en el transcript el aviso real (diagnóstico). */
async function toastWith(page: Page, fragment: string): Promise<boolean> {
  try {
    await page.locator('#toasts .toast', { hasText: fragment }).waitFor({ timeout: 8000 });
    return true;
  } catch {
    say(`   aviso observado: «${(await page.locator('#toasts').textContent()) ?? ''}»`);
    return false;
  }
}

after(async () => {
  try { await browser?.close(); } catch { /* ya cerrado */ }
  for (const c of children) c.kill('SIGTERM');
  await pool.end();
  try {
    mkdirSync('evidence/plan-catalog', { recursive: true });
    const head = execSync('git rev-parse HEAD').toString().trim();
    const dirty = execSync('git status --porcelain').toString().trim() ? ' (+ cambios sin commitear del árbol de trabajo)' : '';
    // Huella de los assets servidos: la evidencia queda ligada a la UI exacta que se probó (también sin commit).
    const assets = ['src/web/platform/assets/console.js', 'src/web/platform/assets/console.css', 'src/web/panel/assets/js/views-app.js', 'src/web/panel/assets/js/main.js', 'src/web/panel/assets/js/store.js']
      .map((f) => `#   ${createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16)}  ${f}`).join('\n');
    writeFileSync('evidence/plan-catalog/e2e-ui.txt', `# E2E Planes (DEC-0075) — ${new Date().toISOString()}\n# HEAD: ${head}${dirty}\n# Assets (sha256/16):\n${assets}\n# Origen: ${BASE} (proxy HTTPS, TLS verificado) · navegador: Chrome headless · proveedores reales: ninguno\n\n${transcript.join('\n')}\n\nErrores de página: ${pageErrors.length ? pageErrors.join(' | ') : 'ninguno'}\n`);
  } catch (err) {
    console.error('no se pudo guardar la evidencia', err);
  }
});

test('E2E Planes: catálogo versionado por permisos, confirmación explícita, publicación, asignación fijada, migración y rollback', { timeout: 240_000 }, async () => {
  await assertUpstreamFree(UPSTREAM_PORT);
  await startServer();
  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const auth = new PlatformAuth({ pool, mfaKey: MFA_KEY, jwtSecret: JWT, ttlMinutes: 30 });
  const eng = await staff('ai_engineer', auth);
  const admin = await staff('platform_admin', auth);
  const support = await staff('platform_support', auth);
  say(`Origen ${BASE}; usuarios de plataforma creados: ai_engineer, platform_admin, platform_support`);

  // ---------- Soporte: solo lectura ----------
  const sup = await newPage();
  await platformLogin(sup.page, '/ingenieria', support);
  await sup.page.locator('h1', { hasText: 'Planes' }).waitFor();
  // El encabezado se pinta antes de que llegue el catálogo: se espera a que aparezcan sus enlaces antes de contarlos.
  await sup.page.locator('a[href^="#/plan/"]').nth(2).waitFor().catch(() => undefined);
  check(await sup.page.locator('a[href^="#/plan/"]').count() >= 3, 'soporte llega a Planes y ve el catálogo (plan_piloto_1, plan_basico, plan_completo)');
  check(await sup.page.locator('form[data-form="plan-create"]').count() === 0, 'soporte no ve el formulario de crear plan');
  check((await sup.page.locator('nav.pc-tabs a').allTextContents()).join(',') === 'Planes', 'soporte solo ve la pestaña Planes en Engineering Console (las de IA no son de su rol)');
  await go(sup.page, '#/plan/plan_piloto_1');
  await sup.page.locator('h2', { hasText: 'Historial de revisiones' }).waitFor();
  check(await sup.page.locator('form[data-form^="plan-"]').count() === 0, 'soporte no tiene ninguna acción de escritura en el detalle');
  await shot(sup.page, '01-soporte-detalle-solo-lectura');
  await sup.ctx.close();

  // ---------- Ingeniería: crear plan clonado (deshabilitado, sin confirmar) ----------
  const e = await newPage();
  await platformLogin(e.page, '/ingenieria', eng);
  await go(e.page, '#/planes');
  await e.page.locator('#npl-name').waitFor();
  const planName = `Plan E2E ${randomUUID().slice(0, 4)}`;
  await e.page.locator('#npl-name').fill(planName);
  await e.page.locator('#npl-clone').selectOption('plan_piloto_1');
  await e.page.locator('#npl-reason').fill('E2E: plan clonado del piloto para probar el catálogo');
  await e.page.locator('form[data-form="plan-create"] button[type="submit"]').click();
  await stepUpIfAsked(e.page, eng);
  await e.page.waitForURL(/#\/plan\/plan_/);
  const planId = decodeURIComponent(e.page.url().split('#/plan/')[1] ?? '');
  await e.page.locator('h2', { hasText: 'Borrador v1' }).waitFor();
  const created = await one<{ active: boolean }>('SELECT active FROM plan WHERE plan_id = $1', [planId]);
  check(created?.active === false, `el plan ${planId} nace deshabilitado`);
  const unconfirmed = await one<{ n: string }>(`SELECT count(*) AS n FROM plan_parameter_value v JOIN plan_revision r ON r.revision_id = v.revision_id WHERE r.plan_id = $1 AND v.confirmed_at IS NULL AND v.source = 'copied'`, [planId]);
  check(Number(unconfirmed?.n) === 6, 'los 6 valores copiados quedan SIN confirmar');
  const aiValue = await one<{ value_int: number; source: string; confirmed_at: Date | null }>(`SELECT v.value_int, v.source, v.confirmed_at FROM plan_parameter_value v JOIN plan_revision r ON r.revision_id = v.revision_id WHERE r.plan_id = $1 AND v.parameter_key = 'quota.ai_review_replies.max'`, [planId]);
  check(aiValue?.value_int === 0 && aiValue.source === 'suggested' && aiValue.confirmed_at === null, 'la cuota de respuestas con IA (sin valor en el piloto) llega sugerida en 0 y SIN confirmar (DEC-0076)');
  check(await e.page.locator('form[data-form="plan-publish"] button[disabled]').count() === 1, 'publicar está deshabilitado mientras falten confirmaciones');
  await shot(e.page, '02-borrador-sin-confirmar');

  // Validación en línea del techo técnico (website ≤ 1) sin enviar nada.
  await e.page.locator('#pv-quota-website-max').fill('5');
  await e.page.locator('#pdr-reason').fill('E2E: intento de superar el techo técnico');
  await e.page.locator('form[data-form="plan-draft"] button[type="submit"]').click();
  await e.page.locator('#pe-quota-website-max:not([hidden])').waitFor();
  check(await e.page.locator('#pv-quota-website-max').getAttribute('aria-invalid') === 'true', 'website=5 se marca inválido en línea (techo 1) y no se envía');
  await e.page.locator('#pv-quota-website-max').fill('1');
  // «1,000» no se interpreta como 1 (lo que hace un <input type=number> en algunos navegadores): se rechaza.
  const adsServer = (await e.page.locator('#pv-quota-social-ads-max').getAttribute('data-server')) ?? '';
  await e.page.locator('#pv-quota-social-ads-max').fill('1,000');
  await e.page.locator('form[data-form="plan-draft"] button[type="submit"]').click();
  await e.page.locator('#pe-quota-social-ads-max:not([hidden])').waitFor();
  check(/solo dígitos/.test((await e.page.locator('#pe-quota-social-ads-max').textContent()) ?? ''), '«1,000» se rechaza en línea (solo dígitos) en lugar de guardarse como 1');
  await e.page.locator('#pv-quota-social-ads-max').fill(adsServer);

  // Cambiar un valor desmarca su confirmación; confirmar los 8 uno a uno.
  await e.page.locator('#pc-quota-social-posts-max').check();
  await e.page.locator('#pv-quota-social-posts-max').fill('7');
  check(!(await e.page.locator('#pc-quota-social-posts-max').isChecked()), 'cambiar el valor desmarca «Confirmo este valor»');
  for (const key of PARAMETER_KEYS) await e.page.locator(`#pc-quota-${key}-max`).check();
  // Step-up caducado: la siguiente escritura debe pedir el código.
  await pool.query(`UPDATE platform_session SET step_up_at = now() - interval '11 minutes' WHERE platform_user_id = (SELECT platform_user_id FROM platform_user WHERE login = $1)`, [eng.login]);
  await e.page.locator('#pdr-reason').fill('E2E: confirmar los ocho valores revisados');
  await e.page.locator('form[data-form="plan-draft"] button[type="submit"]').click();
  check(await stepUpIfAsked(e.page, eng), 'con el step-up caducado, guardar pide el código TOTP');
  check(await toastWith(e.page, 'Borrador guardado'), 'borrador guardado tras el step-up');
  await e.page.locator('.banner-nopal', { hasText: 'Todos los valores' }).waitFor();
  const v1 = await one<{ value_int: number; confirmed_by: string }>(`SELECT v.value_int, v.confirmed_by FROM plan_parameter_value v JOIN plan_revision r ON r.revision_id = v.revision_id WHERE r.plan_id = $1 AND v.parameter_key = 'quota.social_posts.max'`, [planId]);
  check(v1?.value_int === 7 && String(v1?.confirmed_by).startsWith('platform:'), 'social_posts=7 confirmado por la persona (actor de plataforma)');
  // Lo publicado es lo guardado: con cambios sin guardar, Publicar avisa y no envía nada.
  const agentsServer = (await e.page.locator('#pv-quota-agents-max').getAttribute('data-server')) ?? '';
  await e.page.locator('#pv-quota-agents-max').fill(agentsServer === '2' ? '3' : '2');
  check(await e.page.locator('#pp-dirty').isVisible(), 'con un valor cambiado sin guardar se avisa junto a Publicar');
  await e.page.locator('#pp-reason').fill('E2E: intento de publicar con cambios sin guardar');
  await e.page.locator('form[data-form="plan-publish"] button[type="submit"]').click();
  await e.page.locator('form[data-form="plan-publish"] [data-form-error]:not([hidden])').waitFor();
  check((await one<{ status: string }>(`SELECT status FROM plan_revision WHERE plan_id = $1 AND version = 1`, [planId]))?.status === 'DRAFT', 'publicar con cambios sin guardar se bloquea (v1 sigue en borrador)');
  await e.page.locator('#pv-quota-agents-max').fill(agentsServer);
  await e.page.locator('#pc-quota-agents-max').check();
  check(!(await e.page.locator('#pp-dirty').isVisible()), 'al deshacer el cambio desaparece el aviso');
  await e.page.locator('#pp-reason').fill('E2E: primera publicación del plan de prueba');
  await e.page.locator('form[data-form="plan-publish"] button[type="submit"]').click();
  await stepUpIfAsked(e.page, eng);
  await e.page.locator('.tag', { hasText: 'Publicada v1' }).waitFor();
  check((await one<{ status: string }>(`SELECT status FROM plan_revision WHERE plan_id = $1 AND version = 1`, [planId]))?.status === 'PUBLISHED', 'v1 publicada');

  await e.page.locator('#pst-on-reason').fill('E2E: habilitar el plan para asignarlo');
  await e.page.locator('form[data-form="plan-status"] button[type="submit"]').click();
  await stepUpIfAsked(e.page, eng);
  await e.page.locator('.tag', { hasText: 'Habilitado' }).first().waitFor();
  check((await one<{ active: boolean }>('SELECT active FROM plan WHERE plan_id = $1', [planId]))?.active === true, 'plan habilitado');

  // v2: social_posts = 3.
  async function publishRevision(value: string, label: string): Promise<void> {
    await e.page.locator('#pnd-reason').fill(`E2E: abrir borrador para ${label}`);
    await e.page.locator('form[data-form="plan-new-draft"] button[type="submit"]').click();
    await stepUpIfAsked(e.page, eng);
    await e.page.locator('form[data-form="plan-draft"]').waitFor();
    await e.page.locator('#pv-quota-social-posts-max').fill(value);
    for (const key of PARAMETER_KEYS) await e.page.locator(`#pc-quota-${key}-max`).check();
    await e.page.locator('#pdr-reason').fill(`E2E: ${label}`);
    await e.page.locator('form[data-form="plan-draft"] button[type="submit"]').click();
    await stepUpIfAsked(e.page, eng);
    await e.page.locator('.banner-nopal', { hasText: 'Todos los valores' }).waitFor();
    await e.page.locator('#pp-reason').fill(`E2E: publicar ${label}`);
    await e.page.locator('form[data-form="plan-publish"] button[type="submit"]').click();
    await stepUpIfAsked(e.page, eng);
    await e.page.locator('form[data-form="plan-new-draft"]').waitFor();
  }
  await publishRevision('3', 'v2 con 3 publicaciones');
  check((await one<{ status: string }>(`SELECT status FROM plan_revision WHERE plan_id = $1 AND version = 1`, [planId]))?.status === 'SUPERSEDED', 'publicar v2 deja v1 como reemplazada (inmutable)');
  await shot(e.page, '03-plan-publicado-v2');

  // ---------- Administration: asignar el plan a client_b (fijado a v2) ----------
  const a = await newPage();
  await platformLogin(a.page, '/plataforma', admin);
  await go(a.page, `#/negocio/${SEED.b.tenant}`);
  await a.page.locator('#tp-plan').waitFor();
  await a.page.locator('#tp-plan').selectOption(planId);
  await a.page.locator('#tp-reason').fill('E2E: asignar el plan de prueba al negocio B');
  await a.page.locator('form[data-form="tenant-plan"] button[type="submit"]').click();
  await stepUpIfAsked(a.page, admin);
  check(await toastWith(a.page, 'fijado'), 'Administration asigna el plan');
  const sub2 = await one<{ version: number }>(`SELECT r.version FROM subscription s JOIN plan_revision r ON r.revision_id = s.plan_revision_id WHERE s.tenant_id = $1`, [SEED.b.tenant]);
  check(sub2?.version === 2, 'la suscripción queda fijada a v2');
  await a.page.locator('h2', { hasText: 'Plan y consumo' }).waitFor();
  await shot(a.page, '04-administration-plan-y-consumo');

  // El negocio tiene más publicaciones que el límite de v3 (downgrade): se crean por API del negocio.
  const biz = await newPage(390, 844);
  await biz.page.goto(`${BASE}/`);
  await biz.page.locator('#l-email').fill(SEED.b.admin.login);
  await biz.page.locator('#l-pass').fill(SEED.b.admin.password);
  await biz.page.locator('#login-submit').click();
  await biz.page.waitForURL(/#\/inicio/);
  const bizApi = (method: string, path: string, body?: unknown): Promise<{ status: number; code: string | null; message: string | null }> => biz.page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('mainspot.token')}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw: unknown = await res.json().catch(() => null);
    const err = raw && typeof raw === 'object' && 'error' in raw && raw.error && typeof raw.error === 'object' ? raw.error : null;
    return { status: res.status, code: err && 'code' in err ? String(err.code) : null, message: err && 'message' in err ? String(err.message) : null };
  }, { method, path, body });
  const used = Number((await one<{ n: string }>(`SELECT count(*) AS n FROM social_post WHERE tenant_id = $1 AND content_type = 'post'`, [SEED.b.tenant]))?.n ?? 0);
  for (let i = used; i < 3; i += 1) assert.equal((await bizApi('POST', '/api/backoffice/social/posts', { text: `E2E plan ${i}` })).status, 201);
  const over = await bizApi('POST', '/api/backoffice/social/posts', { text: 'E2E excede v2' });
  check(over.status === 403 && over.code === 'limit_exceeded', `con 3 de 3 publicaciones el siguiente borrador se deniega (${over.message ?? ''})`);
  const selfAssign = await bizApi('POST', '/api/backoffice/subscriptions/assign', { plan_id: 'plan_completo' });
  check(selfAssign.status === 403, 'el negocio no puede asignarse planes (403)');

  // ---------- Ingeniería publica v3 (1 publicación): el negocio sigue en v2 ----------
  await go(e.page, `#/plan/${encodeURIComponent(planId)}`);
  await publishRevision('1', 'v3 con 1 publicación');
  check((await one<{ version: number }>(`SELECT r.version FROM subscription s JOIN plan_revision r ON r.revision_id = s.plan_revision_id WHERE s.tenant_id = $1`, [SEED.b.tenant]))?.version === 2,
    'publicar v3 NO cambia al negocio (sigue en v2)');

  // ---------- Administration: vista previa y migración (sin borrar nada) ----------
  const ap = await newPage();
  await platformLogin(ap.page, '/ingenieria', admin);
  await go(ap.page, `#/plan/${encodeURIComponent(planId)}`);
  await ap.page.locator('[data-action="plan-migration-preview"]').click();
  await ap.page.locator('.tag-alerta', { hasText: 'usa 3' }).waitFor();
  check(true, 'la vista previa muestra el uso por encima del nuevo límite (publicaciones: usa 3; nuevo límite 1)');
  await shot(ap.page, '05-vista-previa-migracion');
  // Un motivo con el id de un negocio se rechaza (queda en el historial permanente) y el error queda en el formulario.
  await ap.page.locator('#pmg-reason').fill(`E2E: migrar ${SEED.b.tenant} a la revisión vigente`);
  await ap.page.locator('form[data-form="plan-migrate"] button[type="submit"]').click();
  await stepUpIfAsked(ap.page, admin);
  await ap.page.locator('form[data-form="plan-migrate"] [data-form-error]:not([hidden])', { hasText: 'No incluyas datos' }).waitFor();
  check((await one<{ version: number }>(`SELECT r.version FROM subscription s JOIN plan_revision r ON r.revision_id = s.plan_revision_id WHERE s.tenant_id = $1`, [SEED.b.tenant]))?.version === 2,
    'un motivo con el id de un negocio se rechaza en el formulario y no migra nada');
  await ap.page.locator('#pmg-reason').fill('E2E: migrar el negocio B a la revisión vigente');
  await ap.page.locator('form[data-form="plan-migrate"] button[type="submit"]').click();
  await stepUpIfAsked(ap.page, admin);
  check(await toastWith(ap.page, 'migrados'), 'Administration migra la suscripción');
  const migrated = await one<{ version: number; posts: string }>(`SELECT r.version, (SELECT count(*) FROM social_post p WHERE p.tenant_id = s.tenant_id AND p.content_type = 'post') AS posts FROM subscription s JOIN plan_revision r ON r.revision_id = s.plan_revision_id WHERE s.tenant_id = $1`, [SEED.b.tenant]);
  check(migrated?.version === 3 && Number(migrated?.posts) >= 3, 'migrado a v3 sin borrar publicaciones existentes');
  const hist = await one<{ change_kind: string; actor: string }>(`SELECT change_kind, actor FROM subscription_history WHERE tenant_id = $1 ORDER BY changed_at DESC LIMIT 1`, [SEED.b.tenant]);
  check(hist?.change_kind === 'revision_migration' && String(hist?.actor).startsWith('platform:'), 'historial revision_migration con actor de plataforma');

  // ---------- Rollback a v2 (crea v4) ----------
  await go(e.page, `#/plan/${encodeURIComponent(planId)}`);
  await e.page.locator('summary', { hasText: 'v2' }).click();
  const rbForm = e.page.locator('form[data-form="plan-rollback"]').filter({ has: e.page.locator('button', { hasText: 'v2' }) });
  await rbForm.locator('input').fill('E2E: volver a los valores de la revisión 2');
  await rbForm.locator('button[type="submit"]').click();
  await stepUpIfAsked(e.page, eng);
  check(await toastWith(e.page, 'v4'), 'rollback publica v4 con los valores de v2');
  const v4 = await one<{ value_int: number; origin: string }>(`SELECT v.value_int, r.origin FROM plan_revision r JOIN plan_parameter_value v ON v.revision_id = r.revision_id WHERE r.plan_id = $1 AND r.version = 4 AND v.parameter_key = 'quota.social_posts.max'`, [planId]);
  check(v4?.value_int === 3 && v4?.origin === 'rollback', 'v4 = valores de v2, origen rollback; historial conserva v1..v4');
  const events = Number((await one<{ n: string }>('SELECT count(*) AS n FROM plan_catalog_event WHERE plan_id = $1', [planId]))?.n ?? 0);
  check(events >= 12, `cada escritura dejó evento con motivo y diff (${events})`);

  // ---------- Panel del negocio: solo lectura, móvil ----------
  await biz.page.goto(`${BASE}/#/negocio/plan`);
  await biz.page.reload(); // la SPA carga el plan al arrancar: recarga para ver la revisión migrada
  await biz.page.locator('h3', { hasText: 'Lo que incluye' }).waitFor();
  await shot(biz.page, '06-panel-mi-plan-movil');
  const panelText = ((await biz.page.locator('h3', { hasText: 'Lo que incluye' }).locator('xpath=..').textContent()) ?? '').replace(/\s+/g, ' ');
  check(/\d+ de 1 publicaciones/.test(panelText), `el panel del negocio muestra uso de máximo de su revisión fijada v3 (solo lectura): «${panelText.slice(0, 160)}…»`);
  check(await biz.page.locator('#app select, form[data-form*="plan"], form[data-form*="assign"]').count() === 0, 'el panel no ofrece asignar ni editar planes');

  // ---------- Responsive y accesibilidad básica del editor ----------
  const m = await newPage(390, 844);
  await platformLogin(m.page, '/ingenieria', eng);
  await go(m.page, `#/plan/${encodeURIComponent(planId)}`);
  await m.page.locator('#pnd-reason').fill('E2E: borrador para revisar en móvil');
  await m.page.locator('form[data-form="plan-new-draft"] button[type="submit"]').click();
  await stepUpIfAsked(m.page, eng);
  await m.page.locator('form[data-form="plan-draft"]').waitFor();
  const layout = await m.page.evaluate(() => {
    const d = globalThis as unknown as { document: { scrollingElement: { scrollWidth: number }; querySelectorAll: (s: string) => ArrayLike<{ labels: ArrayLike<unknown> | null; getAttribute: (n: string) => string | null }> }; innerWidth: number };
    const inputs = Array.from(d.document.querySelectorAll('form[data-form="plan-draft"] input'));
    return { overflow: d.document.scrollingElement.scrollWidth - d.innerWidth, unlabeled: inputs.filter((i) => !i.labels || i.labels.length === 0).length, described: inputs.filter((i) => i.getAttribute('aria-describedby')).length };
  });
  check(layout.overflow <= 1, `editor sin desplazamiento horizontal a 390 px (exceso ${layout.overflow} px)`);
  check(layout.unlabeled === 0 && layout.described >= 6, 'cada campo del editor tiene etiqueta y descripción asociada');
  await shot(m.page, '07-editor-movil');

  // Otra persona guarda el mismo borrador mientras se edita: se ven sus valores y se avisa; no se reenvía lo viejo.
  const draftRow = await one<{ revision_id: string }>(`SELECT revision_id FROM plan_revision WHERE plan_id = $1 AND status = 'DRAFT'`, [planId]);
  await m.page.locator('#pv-quota-social-posts-max').fill('9');
  await m.page.locator('#pc-quota-agents-max').check(); // confirma el valor que ve, sin cambiarlo
  await pool.query(`UPDATE plan_parameter_value SET value_int = 37, confirmed_at = NULL, confirmed_by = NULL WHERE revision_id = $1 AND parameter_key = 'quota.agents.max'`, [draftRow?.revision_id]);
  await pool.query(`UPDATE plan_revision SET lock_version = lock_version + 1, updated_at = now() WHERE revision_id = $1`, [draftRow?.revision_id]);
  await m.page.locator('#pdr-reason').fill('E2E: guardar sobre una versión ya cambiada');
  await m.page.locator('form[data-form="plan-draft"] button[type="submit"]').click();
  await stepUpIfAsked(m.page, eng);
  await m.page.locator('.banner-ocre', { hasText: 'Otra persona guardó' }).waitFor();
  check(await m.page.locator('#pv-quota-agents-max').inputValue() === '37' && await m.page.locator('#pv-quota-social-posts-max').inputValue() === '9',
    'conflicto de edición: se muestra el valor que guardó la otra persona y el cambio propio queda sin enviar');
  check(!(await m.page.locator('#pc-quota-agents-max').isChecked()), 'tras el conflicto, la confirmación dada a un valor que cambió en el servidor no se conserva (no se confirma un valor no visto)');
  await shot(m.page, '08-conflicto-de-edicion');

  // Descartar: acción aparte, con motivo propio y confirmación explícita.
  await m.page.locator('summary', { hasText: 'Descartar el borrador' }).click();
  await m.page.locator('#pdx-reason').fill('E2E: descartar el borrador de prueba móvil');
  await m.page.locator('form[data-form="plan-discard"] button[type="submit"]').click();
  await m.page.locator('form[data-form="plan-discard"] [data-form-error]:not([hidden])').waitFor();
  check((await one<{ status: string }>(`SELECT status FROM plan_revision WHERE revision_id = $1`, [draftRow?.revision_id]))?.status === 'DRAFT', 'descartar sin marcar la confirmación no envía nada');
  await m.page.locator('#pdx-ok').check();
  await m.page.locator('form[data-form="plan-discard"] button[type="submit"]').click();
  await stepUpIfAsked(m.page, eng);
  check(await toastWith(m.page, 'Borrador descartado'), 'con la confirmación marcada el borrador se descarta');
  check((await one<{ status: string }>(`SELECT status FROM plan_revision WHERE revision_id = $1`, [draftRow?.revision_id]))?.status === 'DISCARDED', 'el borrador queda DISCARDED (no se borra)');
  check(pageErrors.length === 0, `sin errores de JavaScript en las páginas (${pageErrors.length})`);
  say(`plan de prueba: ${planId}`);
});
