/**
 * E2E DEC-0076 (SRC-0014 C01/C04/C05) — cuota mensual de respuestas a reseñas con IA recorrida en un NAVEGADOR REAL
 * (Chrome vía playwright-core) por el dominio oficial https://app.mainspot.local.io (proxy HTTPS del LXC, CA local,
 * TLS verificado) contra el servidor real (`node src/api/server.ts`) y la BD de pruebas (recreada por test-prep).
 * AI Core en el entorno `test`: rutas SIMULADAS etiquetadas; ningún proveedor real ni cobro.
 *
 * La prueba es dueña del upstream del proxy (E2E_UPSTREAM_PORT, 3100) y falla si está ocupado.
 *
 * Recorrido: llegan 3 reseñas (no consumen) → «Mi plan» muestra la cuota de IA del ciclo con su renovación y
 * «Reseñas gestionadas» sin límite → «Redactar con IA» en un caso (1 de 2) → la propuesta de IA es la opción 1 →
 * segundo caso agota la cuota → el tercero ya no ofrece IA y explica la renovación y la respuesta manual → se publica
 * a mano sin consumir → vista móvil sin desbordes.
 * Evidencia: evidence/commercial-quota/e2e-ui.txt (+ capturas con EVIDENCE_SCREENSHOTS=1).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import tls from 'node:tls';
import pg from 'pg';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { TEST_URL } from '../helpers/testdb.ts';
import { createPublishedPlan } from '../helpers/plans.ts';

const BASE = (process.env.E2E_BASE_URL ?? 'https://app.mainspot.local.io').replace(/\/$/, '');
const UPSTREAM_PORT = Number(process.env.E2E_UPSTREAM_PORT ?? 3100);
tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);

const SHOTS = process.env.EVIDENCE_SCREENSHOTS === '1';
const EVIDENCE_DIR = 'evidence/commercial-quota';
const SHOT_DIR = `${EVIDENCE_DIR}/ui`;
const PASSWORD = 'E2E-Cuota-IA-2026!';
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
  await new Promise<void>((resolve, reject) => {
    const s = createServer();
    s.once('error', (err: NodeJS.ErrnoException) => reject(err.code === 'EADDRINUSE'
      ? new Error(`El upstream de ${BASE} (puerto ${port}) está ocupado (¿mainspot-local?). Detenlo antes del E2E de navegador.`)
      : err));
    s.listen(port, () => s.close(() => resolve()));
  });
}

async function startServer(): Promise<void> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('JEV_') && !k.startsWith('TELEGRAM_') && !k.startsWith('AI_')) env[k] = v;
  const proc = spawn(process.execPath, ['src/api/server.ts'], {
    env: {
      ...env, DATABASE_URL: TEST_URL, TEST_DATABASE_URL: TEST_URL, APP_ENV: 'test', JWT_SECRET: `e2e-cq-${randomUUID()}`,
      PORT: String(UPSTREAM_PORT), PUBLIC_BASE_URL: BASE, JEV_MODE: 'disabled', AI_ENVIRONMENT: 'test', AI_REAL_PROVIDERS: 'off',
      CHANNEL_PRIMARY: 'simulated', REPUTATION_PROVIDER: 'simulated', SOCIAL_PROVIDER: 'simulated', ENGAGEMENT_POLL_INTERVAL_MS: '0', LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.add(proc);
  proc.once('exit', () => children.delete(proc));
  // Proceso externo real: se sondea /health a través del proxy HTTPS hasta que responde.
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* arrancando */ }
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
async function toastWith(page: Page, fragment: string): Promise<boolean> {
  try {
    await page.locator('#toasts .toast', { hasText: fragment }).waitFor({ timeout: 8000 });
    return true;
  } catch {
    say(`   aviso observado: «${(await page.locator('#toasts').textContent()) ?? ''}»`);
    return false;
  }
}
const textOf = async (page: Page, selector: string) => ((await page.locator(selector).first().textContent()) ?? '').replace(/\s+/g, ' ').trim();

after(async () => {
  try { await browser?.close(); } catch { /* ya cerrado */ }
  for (const c of children) c.kill('SIGTERM');
  await pool.end();
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const head = execSync('git rev-parse HEAD').toString().trim();
    const dirty = execSync('git status --porcelain').toString().trim() ? ' (+ cambios sin commitear del árbol de trabajo)' : '';
    const assets = ['src/web/panel/assets/js/views-channels.js', 'src/web/panel/assets/js/views-app.js', 'src/web/panel/assets/js/agent.js', 'src/web/panel/assets/js/main.js', 'src/web/panel/assets/js/store.js']
      .map((f) => `#   ${createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16)}  ${f}`).join('\n');
    writeFileSync(`${EVIDENCE_DIR}/e2e-ui.txt`, `# E2E cuota de respuestas con IA (DEC-0076) — ${new Date().toISOString()}\n# HEAD: ${head}${dirty}\n# Assets (sha256/16):\n${assets}\n# Origen: ${BASE} (proxy HTTPS, TLS verificado) · navegador: Chrome headless · AI Core: entorno test, rutas simuladas · proveedores reales: ninguno\n\n${transcript.join('\n')}\n\nErrores de página: ${pageErrors.length ? pageErrors.join(' | ') : 'ninguno'}\n`);
  } catch (err) {
    console.error('no se pudo guardar la evidencia', err);
  }
});

test('E2E DEC-0076: recibir reseñas no consume; «Redactar con IA» consume 1 del ciclo; agotada solo bloquea la IA y se responde a mano', { timeout: 180_000 }, async () => {
  await assertUpstreamFree(UPSTREAM_PORT);
  // Negocio de prueba con un plan publicado de 2 respuestas con IA por ciclo (valor de prueba, no comercial).
  const tenant = `client_e2e_cq_${randomUUID().slice(0, 8)}`;
  const login = `admin@${tenant}.example.com`;
  const plan = `plan_e2e_cq_${randomUUID().slice(0, 6)}`;
  await pool.query(`INSERT INTO client (client_id, business_name, status, contact_email, metadata) VALUES ($1, 'Café E2E Cuota', 'active', $2, '{}')`, [tenant, `${tenant}@example.com`]);
  await pool.query(`INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash) VALUES ($1, 'Dueña E2E', $2, 'active', $3, crypt($4, gen_salt('bf', 4)))`,
    [`user_${tenant}`, login, tenant, PASSWORD]);
  await pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, 'administration', $2)`, [`user_${tenant}`, tenant]);
  await createPublishedPlan(pool, plan, { website: 1, ai_review_replies: 2 }, { name: `Plan E2E cuota IA ${randomUUID().slice(0, 4)}` });
  await pool.query(`INSERT INTO subscription (subscription_id, tenant_id, plan_id, status) VALUES ($1, $2, $3, 'active')`, [`sub_${tenant}`, tenant, plan]);

  await startServer();
  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  say(`Origen ${BASE}; negocio ${tenant} con ${plan} (ai_review_replies = 2 por ciclo, reviews_managed = 0)`);

  const { page } = await newPage();
  await page.goto(`${BASE}/`);
  await page.locator('#l-email').fill(login);
  await page.locator('#l-pass').fill(PASSWORD);
  await page.locator('#login-submit').click();
  await page.waitForURL(/#\/inicio/);
  const api = (method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> => page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('mainspot.token')}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  }, { method, path, body });

  // ---------- Llegan 3 reseñas (simulador) y el agente las atiende: ninguna consume ----------
  for (const [i, text] of ['El pan muy rico, pero tardaron en atenderme.', 'Buen café; el lugar algo ruidoso.', 'Volvería, aunque el precio subió.'].entries()) {
    check((await api('POST', '/api/backoffice/dev/simulator/google-reviews', { body: text, rating: 3, author_label: `Cliente ${i + 1}`, external_ref: `e2e-${randomUUID().slice(0, 6)}` })).status === 201, `llega la reseña ${i + 1} (simulada)`);
  }
  check((await api('POST', '/api/backoffice/engagement/run')).status === 200, 'el agente procesa las reseñas');
  const cases = (await pool.query<{ case_id: string; state: string; reply_invocation_id: string | null }>(
    `SELECT case_id, state, reply_invocation_id FROM engagement_case WHERE tenant_id = $1 ORDER BY created_at, case_id`, [tenant])).rows;
  check(cases.length === 3 && cases.every((c) => c.state === 'needs_human' && c.reply_invocation_id === null), '3 casos esperan decisión, sin redacción automática con IA');
  check(Number((await one<{ n: string }>(`SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1`, [tenant]))?.n) === 0, 'recibir 3 reseñas no consumió ninguna cuota (reviews_managed = 0 ya no bloquea)');

  // ---------- Mi plan ----------
  await go(page, '#/negocio/plan');
  await page.locator('h3', { hasText: 'Lo que incluye' }).waitFor();
  const planText = (await page.locator('h3', { hasText: 'Lo que incluye' }).locator('xpath=..').textContent() ?? '').replace(/\s+/g, ' ');
  check(/Respuestas a reseñas con IA.*Se renueva el .*lo no usado no se acumula.*0 de 2 respuestas/.test(planText), `«Mi plan» muestra la cuota del ciclo y su renovación: «${planText.slice(0, 220)}…»`);
  check(/Reseñas gestionadas.*Recibir reseñas no tiene límite.*Sin límite/.test(planText), '«Reseñas gestionadas» se muestra sin límite (recibir no consume)');
  await shot(page, '01-mi-plan');
  await go(page, '#/atencion/reglas');
  await page.locator('#pol-ai-quota').waitFor();
  check(/cada respuesta automática redactada con IA usa 1 de tus respuestas con IA del ciclo/.test(await textOf(page, '#pol-ai-quota')), 'las reglas de respuestas automáticas avisan que la IA consume la cuota del ciclo');

  // ---------- Caso 1: Redactar con IA ----------
  await go(page, `#/caso/${cases[0]!.case_id}`);
  await page.locator('#case-ai').waitFor();
  check(/te quedan 2 de 2/.test(await textOf(page, '#case-ai-text')), `el caso ofrece «Redactar con IA» con el saldo del ciclo: «${await textOf(page, '#case-ai-text')}»`);
  await shot(page, '02-caso-con-ia-disponible');
  const before = await one<{ drafts: string[] }>('SELECT drafts FROM engagement_case WHERE case_id = $1', [cases[0]!.case_id]);
  await page.locator('#case-ai-draft').click();
  check(await toastWith(page, 'la propuesta con IA quedó elegida'), 'la redacción con IA termina con aviso');
  await page.locator('.d-tone', { hasText: 'Propuesta con IA' }).waitFor();
  const c1 = await one<{ drafts: string[]; ai_draft: string | null; reply_invocation_id: string | null }>('SELECT drafts, ai_draft, reply_invocation_id FROM engagement_case WHERE case_id = $1', [cases[0]!.case_id]);
  check(Boolean(c1?.reply_invocation_id && c1.ai_draft), 'el caso guarda la propuesta de IA y la invocación que la redactó');
  check(JSON.stringify(c1?.drafts) === JSON.stringify(before?.drafts), 'las opciones numeradas (las del aviso de Telegram) no cambian');
  check((await page.locator(`#case-text-${cases[0]!.case_id}`).inputValue()) === c1?.ai_draft, 'el texto de la propuesta de IA queda listo para revisar en «Tu respuesta»');
  check(await page.locator('#case-ai').count() === 0, 'el caso ya no ofrece otra redacción (un caso consume como máximo 1)');
  const after1 = await one<{ committed: string }>(`SELECT COALESCE(SUM(units) FILTER (WHERE state = 'committed'), 0) AS committed FROM quota_reservation WHERE tenant_id = $1 AND capability = 'ai_review_replies'`, [tenant]);
  check(Number(after1?.committed) === 1, 'el libro registra exactamente 1 unidad consumida');
  await shot(page, '03-caso-propuesta-ia');

  // ---------- Caso 2 agota; caso 3 ya no ofrece IA ----------
  await go(page, `#/caso/${cases[1]!.case_id}`);
  await page.locator('#case-ai-draft').click();
  // El aviso del primer caso puede seguir en pantalla: se espera al estado del segundo caso, no al aviso.
  await page.locator('.d-tone', { hasText: 'Propuesta con IA' }).waitFor();
  await page.locator('#case-ai').waitFor({ state: 'detached' });
  check(Number((await one<{ committed: string }>(`SELECT COALESCE(SUM(units) FILTER (WHERE state = 'committed'), 0) AS committed FROM quota_reservation WHERE tenant_id = $1 AND capability = 'ai_review_replies'`, [tenant]))?.committed) === 2, 'segunda redacción con IA (2 de 2)');
  await go(page, `#/caso/${cases[2]!.case_id}`);
  await page.locator('#case-ai').waitFor();
  const exhausted = await textOf(page, '#case-ai-text');
  check(/Ya usaste 2 de 2 respuestas con IA de este ciclo\. Se renuevan el .+ escribir tu respuesta, sin consumir tu plan/.test(exhausted), `agotada: explica la renovación y la respuesta manual: «${exhausted}»`);
  check(await page.locator('#case-ai-draft').count() === 0, 'agotada: no hay botón de IA');
  await shot(page, '04-caso-cuota-agotada');

  // ---------- Respuesta manual: se publica sin consumir ----------
  await page.locator(`#case-text-${cases[2]!.case_id}`).fill('Gracias por tu visita. Ya revisamos los tiempos de atención en la mañana.');
  await page.locator('#case-submit').click();
  await page.locator('button', { hasText: 'Sí, publicar' }).click();
  check(await toastWith(page, 'Respuesta publicada'), 'la respuesta manual se publica (simulación)');
  const manual = await one<{ state: string }>('SELECT state FROM engagement_case WHERE case_id = $1', [cases[2]!.case_id]);
  check(manual?.state === 'responded', 'el caso queda respondido');
  const total = await one<{ committed: string; rows: string }>(`SELECT COALESCE(SUM(units) FILTER (WHERE state = 'committed'), 0) AS committed, count(*) AS rows FROM quota_reservation WHERE tenant_id = $1`, [tenant]);
  check(Number(total?.committed) === 2 && Number(total?.rows) === 2, 'responder a mano no consumió: 2 unidades, ambas de IA');

  // ---------- Móvil ----------
  const mobile = await newPage(390, 844);
  await mobile.page.goto(`${BASE}/`);
  await mobile.page.locator('#l-email').fill(login);
  await mobile.page.locator('#l-pass').fill(PASSWORD);
  await mobile.page.locator('#login-submit').click();
  await mobile.page.waitForURL(/#\/inicio/);
  await go(mobile.page, `#/caso/${cases[1]!.case_id}`);
  await mobile.page.locator('.d-tone', { hasText: 'Propuesta con IA' }).waitFor();
  const overflow = await mobile.page.evaluate(() => {
    const root = (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  check(overflow <= 0, `vista móvil del caso sin desbordes horizontales (${overflow}px)`);
  await shot(mobile.page, '05-caso-movil');
  check(pageErrors.length === 0, `sin errores de JavaScript en las páginas (${pageErrors.length})`);
});
