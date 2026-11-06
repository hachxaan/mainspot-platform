/**
 * E2E DEC-0077 — salvaguardas previas a producción recorridas en un NAVEGADOR REAL (Chrome vía playwright-core) por el
 * dominio oficial https://app.mainspot.local.io (proxy HTTPS del LXC, CA local, TLS verificado) contra el servidor real
 * (`node src/api/server.ts`) y la BD de pruebas (recreada por test-prep).
 *
 * SEC-CONSENT-01: un negocio con respuestas automáticas autorizadas ANTES de la cuota compartida ve el aviso, lee las
 * condiciones literales (texto y versión del servidor), no puede aceptar sin marcar la casilla y, al aceptar, queda una
 * versión nueva con texto, versión, huella y actor; activar Facebook muestra también sus condiciones literales.
 * SEC-TG-APPROVAL-01: con el chat de Telegram SIMULADO del panel, Operación edita la opción 1 después del aviso; el
 * botón del mensaje antiguo muestra el texto que vio la persona y, al confirmar, NO publica (aviso obsoleto) y llega
 * un aviso nuevo; con éste se publica exactamente el texto mostrado.
 *
 * Todo proveedor es SIMULADO (Telegram, Google, IA en el entorno `test`): nada aquí prueba una entrega real.
 * La prueba es dueña del upstream del proxy (E2E_UPSTREAM_PORT, 3100) y falla si está ocupado.
 * Evidencia: evidence/commercial-governance/e2e-ui.txt (+ capturas con EVIDENCE_SCREENSHOTS=1).
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
import { AUTO_REPLY_CONSENT, consentSha256 } from '../../src/engagement/consent.ts';

const BASE = (process.env.E2E_BASE_URL ?? 'https://app.mainspot.local.io').replace(/\/$/, '');
const UPSTREAM_PORT = Number(process.env.E2E_UPSTREAM_PORT ?? 3100);
tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);

const SHOTS = process.env.EVIDENCE_SCREENSHOTS === '1';
const EVIDENCE_DIR = 'evidence/commercial-governance';
const SHOT_DIR = `${EVIDENCE_DIR}/ui`;
const PASSWORD = 'E2E-Gobernanza-2026!';
const LEGACY_TEXT = 'Autorizo a MainSpot a responder públicamente en mi nombre solo los casos de esta categoría que pasen todas las comprobaciones de seguridad (sin riesgos, sin quejas, con datos verificados). Las demás interacciones quedan para mi revisión. Puedo revocarlo en cualquier momento.';
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
      ...env, DATABASE_URL: TEST_URL, TEST_DATABASE_URL: TEST_URL, APP_ENV: 'test', JWT_SECRET: `e2e-gov-${randomUUID()}`,
      PORT: String(UPSTREAM_PORT), PUBLIC_BASE_URL: BASE, JEV_MODE: 'disabled', AI_ENVIRONMENT: 'test', AI_REAL_PROVIDERS: 'off',
      CHANNEL_PRIMARY: 'simulated', REPUTATION_PROVIDER: 'simulated', SOCIAL_PROVIDER: 'simulated', ENGAGEMENT_WORKER: 'off',
      ENGAGEMENT_POLL_INTERVAL_MS: '0', LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.add(proc);
  proc.once('exit', () => children.delete(proc));
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
async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${BASE}/`);
  await page.locator('#l-email').fill(email);
  await page.locator('#l-pass').fill(PASSWORD);
  await page.locator('#login-submit').click();
  await page.waitForURL(/#\/inicio/);
}
function apiOf(page: Page) {
  return (method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> => page.evaluate(async ({ method, path, body }) => {
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionStorage.getItem('mainspot.token')}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  }, { method, path, body });
}

after(async () => {
  try { await browser?.close(); } catch { /* ya cerrado */ }
  for (const c of children) c.kill('SIGTERM');
  await pool.end();
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const head = execSync('git rev-parse HEAD').toString().trim();
    const dirty = execSync('git status --porcelain').toString().trim() ? ' (+ cambios sin commitear del árbol de trabajo)' : '';
    const assets = ['src/web/panel/assets/js/views-channels.js', 'src/web/panel/assets/js/agent.js', 'src/web/panel/assets/js/main.js', 'src/web/panel/assets/js/store.js', 'src/web/panel/assets/js/assistant.js', 'src/web/panel/assets/css/app.css']
      .map((f) => `#   ${createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16)}  ${f}`).join('\n');
    writeFileSync(`${EVIDENCE_DIR}/e2e-ui.txt`, `# E2E salvaguardas DEC-0077 (SEC-CONSENT-01, SEC-TG-APPROVAL-01) — ${new Date().toISOString()}\n# HEAD: ${head}${dirty}\n# Assets (sha256/16):\n${assets}\n# Origen: ${BASE} (proxy HTTPS, TLS verificado) · navegador: Chrome headless · Telegram: chat SIMULADO del panel · AI Core: entorno test, rutas simuladas · proveedores reales: ninguno\n\n${transcript.join('\n')}\n\nErrores de página: ${pageErrors.length ? pageErrors.join(' | ') : 'ninguno'}\n`);
  } catch (err) {
    console.error('no se pudo guardar la evidencia', err);
  }
});

test('E2E DEC-0077: reconsentimiento informado y versionado; /aprobar de un aviso antiguo no publica el texto editado', { timeout: 240_000 }, async () => {
  await assertUpstreamFree(UPSTREAM_PORT);
  const tenant = `client_e2e_gov_${randomUUID().slice(0, 8)}`;
  const admin = `admin@${tenant}.example.com`;
  const ops = `ops@${tenant}.example.com`;
  const plan = `plan_e2e_gov_${randomUUID().slice(0, 6)}`;
  await pool.query(`INSERT INTO client (client_id, business_name, status, contact_email, metadata) VALUES ($1, 'Panadería E2E Gobernanza', 'active', $2, '{}')`, [tenant, `${tenant}@example.com`]);
  for (const [id, mail, role, name] of [[`user_${tenant}`, admin, 'administration', 'Dueña E2E'], [`ops_${tenant}`, ops, 'operation', 'Operador E2E']] as const) {
    await pool.query(`INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash) VALUES ($1, $2, $3, 'active', $4, crypt($5, gen_salt('bf', 4)))`, [id, name, mail, tenant, PASSWORD]);
    await pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, $2, $3)`, [id, role, tenant]);
  }
  await createPublishedPlan(pool, plan, { website: 1, ai_review_replies: 2 }, { name: `Plan E2E gobernanza ${randomUUID().slice(0, 4)}` });
  await pool.query(`INSERT INTO subscription (subscription_id, tenant_id, plan_id, status) VALUES ($1, $2, $3, 'active')`, [`sub_${tenant}`, tenant, plan]);
  // Regla automática autorizada ANTES de 0037 (sin versión): se recrea como estaban esas filas.
  const legacy = `pol_${randomUUID()}`;
  const ddl = await pool.connect();
  try {
    await ddl.query('BEGIN');
    await ddl.query('ALTER TABLE engagement_policy DROP CONSTRAINT engagement_policy_auto_reply_consent');
    await ddl.query(`INSERT INTO engagement_policy (policy_id, tenant_id, origin, category, mode, version, max_auto_replies_per_hour, consent_text, decided_by)
      VALUES ($1, $2, 'google_review', 'gratitude', 'safe_auto_reply', 1, 10, $3, $4)`, [legacy, tenant, LEGACY_TEXT, `user_${tenant}`]);
    await ddl.query(`ALTER TABLE engagement_policy ADD CONSTRAINT engagement_policy_auto_reply_consent CHECK (mode <> 'safe_auto_reply' OR consent_version IS NOT NULL) NOT VALID`);
    await ddl.query('COMMIT');
  } finally {
    ddl.release();
  }

  await startServer();
  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  say(`Origen ${BASE}; negocio ${tenant}; regla automática previa a la cuota compartida: ${legacy} (sin versión de consentimiento)`);

  // ====================================================================================== SEC-CONSENT-01
  say('\n-- SEC-CONSENT-01: reconsentimiento informado y versionado --');
  const { page } = await newPage();
  await login(page, admin);
  const api = apiOf(page);
  await go(page, '#/atencion');
  await page.locator('#reconsent-banner').waitFor();
  check(/Actualiza tu autorización de respuestas automáticas/.test(await page.locator('#reconsent-banner').innerText()), 'Atención muestra el aviso para aceptar las nuevas condiciones');
  await shot(page, '01-aviso-reconsentimiento');
  await page.locator('#reconsent-open').click();
  const terms = page.locator('#reconsent-terms');
  await terms.waitFor();
  const served = (await api('GET', '/api/backoffice/engagement/policies')).data.consent_terms.google_review as { version: string; text: string };
  check((await terms.innerText()).trim() === AUTO_REPLY_CONSENT.google_review.text && served.text === AUTO_REPLY_CONSENT.google_review.text, 'la hoja muestra literalmente el texto de las condiciones que guarda el servidor');
  check((await terms.getAttribute('data-consent-version')) === AUTO_REPLY_CONSENT.google_review.version, `versión mostrada: ${AUTO_REPLY_CONSENT.google_review.version}`);
  check(/la misma bolsa que uso al pedir «Redactar con IA»/.test(await terms.innerText()) && /pueden agotarla antes de que termine el ciclo/.test(await terms.innerText()), 'las condiciones informan la cuota compartida y que puede agotarse');
  await shot(page, '02-condiciones-literales');
  await page.getByRole('button', { name: 'Aceptar condiciones' }).click();
  check(await page.locator('#reconsent-err').isVisible(), 'sin marcar la casilla no se acepta');
  check(Number((await one<{ n: string }>(`SELECT count(*) AS n FROM engagement_policy WHERE tenant_id = $1 AND consent_version IS NOT NULL`, [tenant]))?.n) === 0, 'nada se registró sin aceptación explícita');
  await page.locator('#reconsent-check').check();
  await page.getByRole('button', { name: 'Aceptar condiciones' }).click();
  check(await toastWith(page, 'Guardamos tu autorización'), 'aceptación confirmada');
  const accepted = await one<{ version: number; mode: string; consent_version: string; consent_sha256: string; consent_text: string; decided_by: string }>(
    `SELECT version, mode, consent_version, consent_sha256, consent_text, decided_by FROM engagement_policy WHERE tenant_id = $1 AND origin = 'google_review' AND category = 'gratitude' ORDER BY version DESC LIMIT 1`, [tenant]);
  check(accepted?.version === 2 && accepted.mode === 'safe_auto_reply' && accepted.consent_version === AUTO_REPLY_CONSENT.google_review.version, 'nueva versión de la regla con la versión de condiciones aceptada');
  check(accepted?.consent_text === AUTO_REPLY_CONSENT.google_review.text && accepted.consent_sha256 === consentSha256(accepted.consent_text) && accepted.decided_by === `user_${tenant}`, 'guarda el texto literal, su huella sha256 y quién aceptó');
  const audit = await one<{ result: string }>(`SELECT result FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.policy.changed' ORDER BY ts DESC LIMIT 1`, [tenant]);
  check(audit?.result === `safe_auto_reply:v2:reconsent:${AUTO_REPLY_CONSENT.google_review.version}`, `auditado: ${audit?.result}`);
  await page.locator('#reconsent-banner').waitFor({ state: 'detached' });
  check(await page.locator('#reconsent-banner').count() === 0, 'el aviso desaparece al aceptar');
  await go(page, '#/atencion/reglas');
  await page.locator('#policy-versions').waitFor();
  check(/Versión 2/.test(await page.locator('#policy-versions').innerText()), 'el historial de reglas muestra la versión nueva');
  await shot(page, '03-aceptado-historial');

  // Activar otra regla (Facebook) muestra también sus condiciones literales y guarda su versión.
  await page.locator('#pol-scope-facebook').check();
  await page.locator('#pol-save').click();
  const fbTerms = page.locator('.consent-terms', { hasText: 'comentarios de Facebook' });
  await fbTerms.waitFor();
  check((await fbTerms.getAttribute('data-consent-version')) === AUTO_REPLY_CONSENT.facebook_comment.version && (await fbTerms.innerText()).trim() === AUTO_REPLY_CONSENT.facebook_comment.text, 'activar Facebook muestra sus condiciones literales y su versión');
  await shot(page, '04-condiciones-facebook');
  await page.locator('#pol-consent').check();
  await page.getByRole('button', { name: 'Autorizar y guardar' }).click();
  check(await toastWith(page, 'Guardamos tus reglas'), 'reglas guardadas');
  const fb = await one<{ consent_version: string }>(`SELECT consent_version FROM engagement_policy WHERE tenant_id = $1 AND origin = 'facebook_comment' AND category = 'gratitude' ORDER BY version DESC LIMIT 1`, [tenant]);
  check(fb?.consent_version === AUTO_REPLY_CONSENT.facebook_comment.version, 'la regla de Facebook guarda la versión de sus condiciones');

  // ================================================================================== SEC-TG-APPROVAL-01
  say('\n-- SEC-TG-APPROVAL-01: el aviso antiguo no publica lo que no mostró --');
  const code = await api('POST', '/api/backoffice/telegram/link-code');
  check(code.status === 201 && (await api('POST', '/api/backoffice/dev/simulator/telegram', { text: `/start ${code.data.code}` })).data.handled === 'linked', 'chat de Telegram simulado vinculado a la dueña');
  check((await api('POST', '/api/backoffice/dev/simulator/google-reviews', { body: 'Me intoxiqué después de comer, quiero un reembolso', rating: 1, author_label: 'Beto', external_ref: `e2e-${randomUUID().slice(0, 6)}` })).status === 201, 'llega una reseña delicada (simulada)');
  check((await api('POST', '/api/backoffice/engagement/run')).status === 200, 'el agente la procesa y avisa por Telegram');
  const c = await one<{ case_id: string; drafts: string[]; drafts_revision: number }>(`SELECT case_id, drafts, drafts_revision FROM engagement_case WHERE tenant_id = $1 AND state = 'needs_human'`, [tenant]);
  check(Boolean(c && c.drafts.length === 3), 'caso humano con tres propuestas');
  await go(page, '#/chat');
  const first = page.locator('.tg-msg', { hasText: c!.case_id }).first();
  await first.waitFor();
  const firstText = await first.innerText();
  const oldCode = /\/rechazar ([A-HJ-NP-Z2-9]{6})/.exec(firstText)?.[1];
  check(Boolean(oldCode) && firstText.includes(`1) ${c!.drafts[0]}`), `el aviso muestra las opciones y su código (${oldCode})`);
  await shot(page, '05-aviso-telegram');

  // Operación edita la opción 1 en el panel DESPUÉS del aviso.
  const { page: opsPage } = await newPage();
  await login(opsPage, ops);
  await go(opsPage, `#/caso/${c!.case_id}`);
  const box = opsPage.locator(`#case-text-${c!.case_id}`);
  await box.waitFor();
  const edited = 'Hola Beto, sentimos lo ocurrido. Te llamamos hoy para atenderlo en privado.';
  await box.fill(edited);
  await opsPage.locator('#case-submit').click();
  check(await toastWith(opsPage, 'Guardamos tu propuesta'), 'Operación guarda la opción 1 editada');
  const afterEdit = await one<{ drafts: string[]; drafts_revision: number }>('SELECT drafts, drafts_revision FROM engagement_case WHERE case_id = $1', [c!.case_id]);
  check(afterEdit?.drafts[0] === edited && afterEdit.drafts_revision === c!.drafts_revision + 1, 'las propuestas cambian de revisión');
  check((await one<{ status: string }>('SELECT status FROM engagement_approval_offer WHERE code = $1', [oldCode]))?.status === 'superseded', 'el aviso ya enviado queda invalidado');

  // El mensaje ANTIGUO ya no ofrece botones (su aviso quedó sustituido); la dueña escribe su comando, como haría en
  // Telegram con un mensaje viejo, y no se publica nada.
  await page.reload();
  await go(page, '#/chat');
  const oldMsg = page.locator('.tg-msg', { hasText: oldCode! }).first();
  await oldMsg.waitFor();
  check(await oldMsg.getByRole('button', { name: 'Usar opción 1' }).count() === 0, 'el mensaje del aviso sustituido ya no ofrece botones para aprobar');
  await page.getByLabel('Mensaje para MainSpot').first().fill(`/aprobar ${oldCode} 1`);
  await page.getByRole('button', { name: 'Enviar mensaje' }).first().click();
  await page.getByText('Las propuestas de ese aviso cambiaron después de enviártelo').waitFor();
  const stillOpen = await one<{ state: string; response_text: string | null }>('SELECT state, response_text FROM engagement_case WHERE case_id = $1', [c!.case_id]);
  const replies0 = Number((await one<{ n: string }>('SELECT count(*) AS n FROM sim_provider_reply WHERE tenant_id = $1', [tenant]))?.n);
  check(stillOpen?.state === 'needs_human' && replies0 === 0, 'aviso obsoleto: no se publicó nada (ni el texto visto ni el editado)');
  check(Number((await one<{ n: string }>(`SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.approval.stale'`, [tenant]))?.n) === 1, 'el intento queda auditado como aviso obsoleto');
  const fresh = page.locator('.tg-msg', { hasText: 'Propuestas actualizadas' }).last();
  await fresh.waitFor();
  const freshText = await fresh.innerText();
  const newCode = /\/rechazar ([A-HJ-NP-Z2-9]{6})/.exec(freshText)?.[1];
  check(Boolean(newCode) && newCode !== oldCode && freshText.includes(`1) ${edited}`), `llega el aviso vigente con otro código (${newCode}) y el texto editado`);
  await shot(page, '06-aviso-antiguo-no-publica');

  // Con el aviso vigente se publica exactamente lo que muestra.
  await fresh.getByRole('button', { name: 'Usar opción 1' }).click();
  const confirm2 = page.locator('.tg-msg', { hasText: '¿Publico esta respuesta' }).last();
  await confirm2.waitFor();
  check((await confirm2.innerText()).includes(edited), 'la confirmación muestra el texto del aviso vigente');
  await confirm2.getByRole('button', { name: 'Sí, publicar' }).click();
  await page.getByText('Respuesta publicada (simulación).').waitFor();
  const done = await one<{ state: string; response_text: string; resolution_channel: string }>('SELECT state, response_text, resolution_channel FROM engagement_case WHERE case_id = $1', [c!.case_id]);
  const reply = await one<{ text: string }>('SELECT text FROM sim_provider_reply WHERE tenant_id = $1', [tenant]);
  check(done?.state === 'responded' && done.resolution_channel === 'telegram' && done.response_text === edited && reply?.text === edited, 'publicado (simulación) exactamente el texto que mostró el aviso vigente');
  await shot(page, '07-publicado-texto-mostrado');
  check(pageErrors.length === 0, `sin errores de JavaScript en las páginas (${pageErrors.length})`);
});
