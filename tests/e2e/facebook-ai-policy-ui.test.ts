/**
 * E2E DEC-0078 — política de IA de comentarios de Facebook recorrida en un NAVEGADOR REAL (Chrome vía playwright-core)
 * por el dominio oficial https://app.mainspot.local.io (proxy HTTPS del LXC, CA local, TLS verificado) contra el servidor
 * real (`node src/api/server.ts`) y la BD de pruebas (recreada por test-prep).
 *
 * FB-1: sin configuración el modo es «bajo demanda»: llega un comentario sin IA, «Sugerir con IA» muestra antes el costo
 * (1 de las sugerencias del ciclo) y genera la propuesta; activar las automáticas muestra el texto literal y el costo, no
 * acepta sin la casilla, guarda versión y huella, y desde entonces la sugerencia llega preparada para revisar, sin
 * publicarse; agotado el medidor no se prepara más; «Desactivadas» apaga todo. Un plan sin medidor definido explica que
 * no incluye la IA y no permite activar las automáticas (fail-closed, sin consumo ilimitado).
 * SEC-TG-APPROVAL-01: la sugerencia automática es la opción 1 del aviso de Telegram (chat SIMULADO del panel) y aprobarla
 * publica exactamente ese texto.
 *
 * Todo proveedor es SIMULADO (Telegram, Meta, IA en el entorno `test`): nada aquí prueba una entrega real ni un cobro.
 * La prueba es dueña del upstream del proxy (E2E_UPSTREAM_PORT, 3100) y falla si está ocupado.
 * Evidencia: evidence/facebook-ai-policy/e2e-ui.txt (+ capturas con EVIDENCE_SCREENSHOTS=1).
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
import { AUTO_SUGGEST_CONSENT, consentSha256 } from '../../src/engagement/consent.ts';

const BASE = (process.env.E2E_BASE_URL ?? 'https://app.mainspot.local.io').replace(/\/$/, '');
const UPSTREAM_PORT = Number(process.env.E2E_UPSTREAM_PORT ?? 3100);
tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);

const SHOTS = process.env.EVIDENCE_SCREENSHOTS === '1';
const EVIDENCE_DIR = 'evidence/facebook-ai-policy';
const SHOT_DIR = `${EVIDENCE_DIR}/ui`;
const PASSWORD = 'E2E-Facebook-IA-2026!';
const TERMS = AUTO_SUGGEST_CONSENT.facebook_comment;
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
      ...env, DATABASE_URL: TEST_URL, TEST_DATABASE_URL: TEST_URL, APP_ENV: 'test', JWT_SECRET: `e2e-fb-${randomUUID()}`,
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
/** Captura de evidencia con las animaciones CSS terminadas (una hoja a medio aparecer saldría translúcida). */
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true, animations: 'disabled' });
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

/** Negocio con su dueña (administración), su plan publicado y una publicación de Facebook publicada. */
async function business(name: string, limits: Record<string, number> | 'plan_piloto_1'): Promise<{ tenant: string; admin: string; post: string }> {
  const tenant = `client_e2e_fb_${randomUUID().slice(0, 8)}`;
  const admin = `admin@${tenant}.example.com`;
  await pool.query(`INSERT INTO client (client_id, business_name, status, contact_email, metadata) VALUES ($1, $2, 'active', $3, '{}')`, [tenant, name, `${tenant}@example.com`]);
  await pool.query(`INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash) VALUES ($1, 'Dueña E2E', $2, 'active', $3, crypt($4, gen_salt('bf', 4)))`, [`user_${tenant}`, admin, tenant, PASSWORD]);
  await pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, 'administration', $2)`, [`user_${tenant}`, tenant]);
  let plan = 'plan_piloto_1';
  if (limits !== 'plan_piloto_1') {
    plan = `plan_e2e_fb_${randomUUID().slice(0, 6)}`;
    await createPublishedPlan(pool, plan, limits, { name: `Plan E2E Facebook ${randomUUID().slice(0, 4)}` });
  }
  await pool.query(`INSERT INTO subscription (subscription_id, tenant_id, plan_id, status) VALUES ($1, $2, $3, 'active')`, [`sub_${tenant}`, tenant, plan]);
  const post = `post_${randomUUID().slice(0, 8)}`;
  await pool.query(`INSERT INTO social_post (post_id, tenant_id, network, content_type, text, status, published_at, external_ref, created_by)
    VALUES ($1, $2, 'facebook', 'post', 'Pan de muerto recién hecho', 'published', now(), $3, 'fixture')`, [post, tenant, `sim:fb:post:${post}`]);
  return { tenant, admin, post };
}

after(async () => {
  try { await browser?.close(); } catch { /* ya cerrado */ }
  for (const c of children) c.kill('SIGTERM');
  await pool.end();
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    const head = execSync('git rev-parse HEAD').toString().trim();
    const dirty = execSync('git status --porcelain').toString().trim() ? ' (+ cambios sin commitear del árbol de trabajo)' : '';
    const assets = ['src/web/panel/assets/js/views-channels.js', 'src/web/panel/assets/js/agent.js', 'src/web/panel/assets/js/main.js', 'src/web/panel/assets/js/store.js']
      .map((f) => `#   ${createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16)}  ${f}`).join('\n');
    writeFileSync(`${EVIDENCE_DIR}/e2e-ui.txt`, `# E2E política de IA de Facebook DEC-0078 (FB-1/FB-2, medidor propio, SEC-CONSENT-01, SEC-TG-APPROVAL-01) — ${new Date().toISOString()}\n# HEAD: ${head}${dirty}\n# Assets (sha256/16):\n${assets}\n# Origen: ${BASE} (proxy HTTPS, TLS verificado) · navegador: Chrome headless · Telegram: chat SIMULADO del panel · Meta: simulador · AI Core: entorno test, rutas simuladas · proveedores reales: ninguno · valores del medidor: fixtures de prueba, no comerciales\n\n${transcript.join('\n')}\n\nErrores de página: ${pageErrors.length ? pageErrors.join(' | ') : 'ninguno'}\n`);
  } catch (err) {
    console.error('no se pudo guardar la evidencia', err);
  }
});

test('E2E DEC-0078: modos de sugerencias con IA de comentarios de Facebook, costo informado, opt-in versionado y medidor propio fail-closed', { timeout: 240_000 }, async () => {
  await assertUpstreamFree(UPSTREAM_PORT);
  // Valor de FIXTURE (no comercial): dos sugerencias por ciclo para recorrer el agotamiento.
  const a = await business('Panadería E2E Facebook', { website: 1, ai_review_replies: 5, ai_facebook_suggestions: 2 });
  const sinMedidor = await business('Café sin medidor', 'plan_piloto_1');
  await startServer();
  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  say(`Origen ${BASE}; negocio ${a.tenant} (medidor de fixture: 2); negocio ${sinMedidor.tenant} (plan_piloto_1, sin medidor)`);

  const { page } = await newPage();
  await login(page, a.admin);
  const api = apiOf(page);

  say('\n-- FB-1: bajo demanda (predeterminado) --');
  await go(page, '#/atencion/reglas');
  await page.locator('#suggestions-card').waitFor();
  check(await page.locator('#sug-on_demand').isChecked() && /predeterminado/.test(await page.locator('#suggestions-card').innerText()), 'sin configuración el modo es «Bajo demanda (predeterminado)»');
  check(/llevas 0 de 2 sugerencias con IA/.test(await page.locator('#sug-state').innerText()), 'la tarjeta muestra el estado y el límite del medidor');
  await shot(page, '01-reglas-bajo-demanda');

  const comment = async (body: string) => {
    const ref = `e2e-fbc-${randomUUID().slice(0, 6)}`;
    const r = await api('POST', '/api/backoffice/dev/simulator/facebook-comments', { post_id: a.post, body, author_label: 'Lucía', external_ref: ref });
    assert.equal(r.status, 201);
    assert.equal((await api('POST', '/api/backoffice/engagement/run')).status, 200);
    return (await one<{ case_id: string; reply_invocation_id: string | null; ai_draft: string | null; drafts: string[]; state: string }>(
      'SELECT case_id, reply_invocation_id, ai_draft, drafts, state FROM engagement_case WHERE tenant_id = $1 AND external_ref = $2', [a.tenant, ref]))!;
  };
  const c1 = await comment('¡Qué rico el pan de muerto! ¿Tienen sin azúcar?');
  check(c1.state === 'needs_human' && c1.reply_invocation_id === null, 'llega el comentario y NO se redacta con IA por sí solo');
  await go(page, `#/caso/${c1.case_id}`);
  await page.locator('#case-ai').waitFor();
  check(/Usa 1 de tus sugerencias con IA de este ciclo: te quedan 2 de 2/.test(await page.locator('#case-ai-text').innerText()), 'antes de invocar se informa el consumo (1 de 2)');
  await shot(page, '02-caso-sugerir-con-ia');
  await page.locator('#case-ai-draft').click();
  check(await toastWith(page, 'la propuesta con IA'), '«Sugerir con IA» genera la propuesta');
  const d1 = await one<{ ai_draft: string | null; reply_invocation_id: string | null }>('SELECT ai_draft, reply_invocation_id FROM engagement_case WHERE case_id = $1', [c1.case_id]);
  check(Boolean(d1?.ai_draft && d1.reply_invocation_id), 'la propuesta queda guardada aparte, ligada a su invocación');
  const used1 = await one<{ fb: string; google: string }>(`SELECT count(*) FILTER (WHERE capability = 'ai_facebook_suggestions' AND state = 'committed') AS fb,
    count(*) FILTER (WHERE capability = 'ai_review_replies') AS google FROM quota_reservation WHERE tenant_id = $1`, [a.tenant]);
  check(used1?.fb === '1' && used1.google === '0', 'consume 1 del medidor de Facebook y nada de la cuota de reseñas');
  await shot(page, '03-propuesta-a-pedido');

  say('\n-- FB-1: sugerencias automáticas con consentimiento informado --');
  await go(page, '#/atencion/reglas');
  await page.locator('#sug-auto_suggest').check();
  const terms = page.locator('#sug-terms');
  await terms.waitFor();
  check((await terms.innerText()).trim() === TERMS.text && (await terms.getAttribute('data-consent-version')) === TERMS.version, `la hoja muestra literalmente las condiciones (${TERMS.version})`);
  check(/1 de tus 2 sugerencias con IA del ciclo/.test(await page.locator('#sug-cost').innerText()) && /aunque no la publiques/.test(await page.locator('#sug-cost').innerText()), 'y el costo antes de aceptar: 1 por comentario aunque no se publique');
  await shot(page, '04-autorizacion-automaticas');
  await page.getByRole('button', { name: 'Activar sugerencias automáticas' }).click();
  check(await page.locator('#sug-consent-err').isVisible(), 'sin marcar la casilla no se activa');
  check(!(await one('SELECT 1 FROM engagement_suggestion_setting WHERE tenant_id = $1', [a.tenant])), 'nada se registró sin aceptación explícita');
  await page.locator('#sug-consent').check();
  await page.getByRole('button', { name: 'Activar sugerencias automáticas' }).click();
  check(await toastWith(page, 'preparará sugerencias'), 'activación confirmada');
  const setting = await one<{ mode: string; consent_version: string; consent_text: string; consent_sha256: string; decided_by: string }>(
    'SELECT mode, consent_version, consent_text, consent_sha256, decided_by FROM engagement_suggestion_setting WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1', [a.tenant]);
  check(setting?.mode === 'auto_suggest' && setting.consent_version === TERMS.version && setting.consent_text === TERMS.text
    && setting.consent_sha256 === consentSha256(TERMS.text) && setting.decided_by === `user_${a.tenant}`, 'guarda modo, texto literal, versión, huella y quién aceptó');

  // El chat de Telegram SIMULADO del panel recibe los avisos (SEC-TG-APPROVAL-01).
  const code = await api('POST', '/api/backoffice/telegram/link-code');
  check(code.status === 201 && (await api('POST', '/api/backoffice/dev/simulator/telegram', { text: `/start ${code.data.code}` })).data.handled === 'linked', 'chat de Telegram simulado vinculado a la dueña');

  const c2 = await comment('Me encantó la concha de vainilla, gracias');
  check(c2.state === 'needs_human' && Boolean(c2.reply_invocation_id) && c2.drafts[0] === c2.ai_draft, 'la sugerencia llega preparada sin pulsar nada, como opción 1');
  check(Number((await one<{ n: string }>('SELECT count(*) AS n FROM sim_provider_reply WHERE tenant_id = $1', [a.tenant]))?.n) === 0, 'preparar no publica nada');
  await go(page, `#/caso/${c2.case_id}`);
  await page.locator(`#draft-${c2.case_id}-0`).waitFor();
  check(/Redactada con IA/.test(await page.locator('.drafts').innerText()), 'el panel identifica la opción redactada con IA');
  await shot(page, '05-sugerencia-automatica');

  say('\n-- SEC-TG-APPROVAL-01: aprobar la sugerencia desde el aviso publica exactamente lo mostrado --');
  await go(page, '#/chat');
  const notice = page.locator('.tg-msg', { hasText: c2.case_id }).first();
  await notice.waitFor();
  const noticeText = await notice.innerText();
  check(Boolean(/\/rechazar ([A-HJ-NP-Z2-9]{6})/.exec(noticeText)) && noticeText.includes(`1) ${c2.ai_draft}`), 'el aviso trae la sugerencia de IA como opción 1, con su código');
  await notice.getByRole('button', { name: 'Usar opción 1' }).click();
  const confirm = page.locator('.tg-msg', { hasText: '¿Publico esta respuesta' }).last();
  await confirm.waitFor();
  check((await confirm.innerText()).includes(c2.ai_draft!), 'la confirmación muestra el texto del aviso');
  await confirm.getByRole('button', { name: 'Sí, publicar' }).click();
  await page.getByText('Respuesta publicada (simulación).').waitFor();
  const done = await one<{ state: string; response_text: string; resolution_channel: string }>('SELECT state, response_text, resolution_channel FROM engagement_case WHERE case_id = $1', [c2.case_id]);
  const reply = await one<{ text: string }>('SELECT text FROM sim_provider_reply WHERE tenant_id = $1', [a.tenant]);
  check(done?.state === 'responded' && done.resolution_channel === 'telegram' && done.response_text === c2.ai_draft && reply?.text === c2.ai_draft,
    'se publicó (simulación) exactamente la sugerencia que mostró el aviso, solo tras la aprobación humana');
  await shot(page, '06-aprobada-desde-telegram');

  const c3 = await comment('¿Hacen pedidos para fiestas?');
  check(c3.reply_invocation_id === null, 'agotado el medidor (2 de 2) no se prepara otra sugerencia');
  await go(page, `#/caso/${c3.case_id}`);
  await page.locator('#case-ai').waitFor();
  check(/Ya usaste 2 de 2 sugerencias con IA de este ciclo/.test(await page.locator('#case-ai-text').innerText()) && await page.locator('#case-ai-draft').count() === 0, 'el caso explica que se agotaron y no ofrece IA');
  await shot(page, '07-medidor-agotado');

  say('\n-- FB-1: desactivar --');
  await go(page, '#/atencion/reglas');
  await page.locator('#sug-off').check();
  check(await toastWith(page, 'ya no prepara sugerencias'), '«Desactivadas» se aplica sin pasos extra');
  check((await one<{ mode: string }>('SELECT mode FROM engagement_suggestion_setting WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1', [a.tenant]))?.mode === 'off', 'versión nueva con el modo desactivado');
  await go(page, `#/caso/${c3.case_id}`);
  await page.locator('#case-ai').waitFor();
  check(/están desactivadas en tu negocio/.test(await page.locator('#case-ai-text').innerText()), 'el caso explica que la IA está desactivada; responder a mano sigue disponible');

  say('\n-- Medidor sin valor en el plan (fail-closed) --');
  const { page: other } = await newPage();
  await login(other, sinMedidor.admin);
  await go(other, '#/atencion/reglas');
  await other.locator('#suggestions-card').waitFor();
  check(/todavía no incluye sugerencias con IA/.test(await other.locator('#sug-state').innerText()), 'explica que el plan no incluye la IA para comentarios de Facebook (sin ofrecer consumo ilimitado)');
  check(await other.locator('#sug-auto_suggest').isDisabled(), 'no se pueden activar las automáticas');
  const refused = await apiOf(other)('PUT', '/api/backoffice/engagement/suggestions', { origin: 'facebook_comment', mode: 'auto_suggest', consent: true, consent_version: TERMS.version });
  check(refused.status === 409, 'el servidor también lo rechaza (409)');
  await shot(other, '08-plan-sin-medidor');
  check(pageErrors.length === 0, `sin errores de JavaScript en las páginas (${pageErrors.length})`);
});
