/**
 * E2E DEV-E2E-02 — SOL MAIN integrado, con PROCESOS REALES (servidor `node src/api/server.ts`,
 * CLI de alta asistida y worker independiente) contra la BD de pruebas recreada por test-prep.
 *
 * Recorrido: invitación → cuenta del dueño → acceso sin tenant_id → teléfonos (un «Otro número»
 * por integración) → ficha de Google simulada → políticas opt-in → Telegram vinculado → post de
 * Facebook publicado → reseñas/comentarios simulados atendidos por el worker SIN navegador ni
 * llamadas a /engagement/run → aprobación por Telegram y rechazo en panel → caída del servidor
 * (SIGKILL) y recuperación con el worker independiente → reinicio sin duplicados → aislamiento.
 *
 * Todo proveedor es SIMULADO; nada aquí prueba Google/Meta/Telegram reales.
 * Evidencia: evidence/e2e-dev-e2e-02.txt (transcript + HEAD).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, execSync, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { TEST_URL, SEED, api } from '../helpers/testdb.ts';

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

const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
const children = new Set<ChildProcess>();
/** El webhook exige el secreto en todo entorno; el servidor hijo lo recibe por entorno y las entregas lo envían en la cabecera. */
const WEBHOOK_SECRET = 'e2e-dev-e2e-02-telegram-webhook-secret-only-for-tests';
const WEBHOOK_HEADERS = { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET };

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('JEV_') && !k.startsWith('TELEGRAM_')) env[k] = v;
  return {
    ...env, DATABASE_URL: TEST_URL, TEST_DATABASE_URL: TEST_URL, APP_ENV: 'test', JWT_SECRET: 'e2e-dev-e2e-02-secret-only-for-tests',
    JEV_MODE: 'disabled', CHANNEL_PRIMARY: 'simulated', REPUTATION_PROVIDER: 'simulated', SOCIAL_PROVIDER: 'simulated',
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ENGAGEMENT_WORKER_INTERVAL_MS: '1000', ENGAGEMENT_POLL_INTERVAL_MS: '0', LOG_LEVEL: 'warn', ...extra,
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function startServer(worker: 'on' | 'off'): Promise<{ base: string; proc: ChildProcess }> {
  const port = await freePort();
  const proc = spawn(process.execPath, ['src/api/server.ts'], { env: childEnv({ PORT: String(port), ENGAGEMENT_WORKER: worker }), stdio: ['ignore', 'ignore', 'inherit'] });
  children.add(proc);
  proc.once('exit', () => children.delete(proc));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { base, proc };
    } catch {
      // aún arrancando
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('el servidor no arrancó');
}

async function kill(proc: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill(signal);
  });
}

let base = '';
function call(path: string, opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts.headers };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  return api(base, path, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
/** Entrega de un Update de Telegram al webhook (misma forma que el bot real; simulado). */
function telegram(updateId: number, chatId: number, text: string, headers: Record<string, string> = WEBHOOK_HEADERS) {
  return call('/api/telegram/webhook', { method: 'POST', headers, body: { update_id: updateId, message: { chat: { id: chatId }, text } } });
}
async function page(path: string): Promise<{ status: number; html: string }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, html: await res.text() };
}

interface CaseView { case_id: string; external_ref: string; state: string; resolution_channel: string | null; response_text: string | null; notify_status: string; delivery_mode: string | null; policy_version: number | null }

async function casesOf(token: string): Promise<Map<string, CaseView>> {
  const r = await call('/api/backoffice/engagement/cases', { token });
  return new Map((r.body.cases as CaseView[]).map((c) => [c.external_ref, c]));
}

async function waitFor(label: string, token: string, done: (cases: Map<string, CaseView>) => boolean, timeoutMs = 20_000): Promise<Map<string, CaseView>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const cs = await casesOf(token);
    if (done(cs)) return cs;
    if (Date.now() > until) throw new Error(`timeout esperando: ${label} — ${JSON.stringify([...cs.values()].map((c) => [c.external_ref, c.state, c.notify_status]))}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Espera N ciclos COMPLETOS del worker sobre el tenant (señal observable: last_polled_at avanza). */
async function waitWorkerCycles(tenantId: string, cycles: number): Promise<void> {
  let mark = (await pool.query<{ now: Date }>('SELECT now()')).rows[0]?.now ?? new Date();
  const until = Date.now() + 20_000;
  for (let seen = 0; seen < cycles;) {
    const r = await pool.query<{ at: Date | null }>(
      `SELECT max(last_polled_at) AS at FROM engagement_cursor WHERE tenant_id = $1 AND origin = 'google_review'`, [tenantId]);
    const at = r.rows[0]?.at;
    if (at && at > mark) { mark = at; seen += 1; continue; }
    if (Date.now() > until) throw new Error('el worker no completó ciclos tras el reinicio');
    await new Promise((resolve) => setTimeout(resolve, 200)); // sondeo de una señal en BD de otro proceso
  }
}

after(async () => {
  for (const c of children) await kill(c, 'SIGKILL');
  await pool.end();
  // El worker real recorre TODOS los tenants (también los semilla: ingesta reseñas y consume
  // cuota). Se recrea la BD para que los demás archivos E2E partan del fixture determinista.
  execFileSync(process.execPath, ['scripts/test-prep.ts'], { stdio: 'ignore' });
  try {
    mkdirSync('evidence', { recursive: true });
    const head = execSync('git rev-parse HEAD').toString().trim();
    writeFileSync('evidence/e2e-dev-e2e-02.txt',
      `# E2E DEV-E2E-02 — transcript (run ${new Date().toISOString()})\n# HEAD: ${head}\n# procesos reales: servidor, CLI invite-owner, worker independiente\n` +
      `# proveedores: simulated (Google, Meta, Telegram); ningún resultado es real\n# DB: mainspot_test (recreada por scripts/test-prep.ts)\n\n${transcript.join('\n')}\n\n# Fin de transcript\n`);
    console.log(`EVIDENCE_SAVED evidence/e2e-dev-e2e-02.txt (HEAD ${head})`);
  } catch (err) {
    console.error('WARN evidence write failed:', (err as Error).message);
  }
});

test('E2E DEV-E2E-02: alta → teléfonos → agente sin navegador → Telegram → caída/reinicio → aislamiento', { timeout: 120_000 }, async () => {
  let server = await startServer('on');
  base = server.base;
  say(`servidor real en ${base} (worker en proceso, ciclo 1 s) [simulated]`);

  // ---------- FLOW-01: alta asistida y acceso sin tenant_id ----------
  say('\n-- FLOW-01: alta asistida --');
  const email = `duena.e2e.${Date.now()}@example.com`;
  const cli = JSON.parse(execFileSync(process.execPath, ['scripts/invite-owner.ts', '--business', 'Cocina Doña Mary', '--email', email, '--base', base], { env: childEnv({}) }).toString());
  const link = String(cli.invitation_link);
  check(link.startsWith(`${base}/invitacion#`), 'CLI de operación crea negocio + invitación de un solo uso');
  const invToken = link.split('#')[1] ?? '';
  const desc = await call('/api/auth/invitation', { method: 'POST', body: { token: invToken } });
  check(desc.status === 200 && desc.body.business_name === 'Cocina Doña Mary', 'invitación válida muestra solo el nombre del negocio');
  const accept = await call('/api/auth/invitation/accept', { method: 'POST', body: { token: invToken, display_name: 'Mary', password: 'Mole-Poblano-2026' } });
  check(accept.status === 201, 'dueña elige contraseña; cuenta Administración creada');
  const reuse = await call('/api/auth/invitation/accept', { method: 'POST', body: { token: invToken, display_name: 'X', password: 'Mole-Poblano-2026' } });
  check(reuse.status === 404, 'la invitación no se puede reutilizar');
  const loginRes = await call('/api/auth/login', { method: 'POST', body: { login: email, password: 'Mole-Poblano-2026' } });
  check(loginRes.status === 200 && loginRes.body.session.tenant_id === cli.tenant_id, 'acceso con correo + contraseña, SIN tenant_id');
  const token = String(loginRes.body.token);

  // ---------- FLOW-02: teléfonos ----------
  say('\n-- FLOW-02: teléfono principal + «Otro número» por integración --');
  const bad = await call('/api/backoffice/contact/phones/primary', { method: 'PUT', token, body: { primary_phone: { country_iso2: 'MX', national_number: '12345' } } });
  check(bad.status === 400 && Array.isArray(bad.body.error.fields), 'número inválido para el país → error por campo');
  await call('/api/backoffice/contact/phones/primary', { method: 'PUT', token, body: { primary_phone: { country_iso2: 'MX', national_number: '9831111111' } } });
  await call('/api/backoffice/contact/phones/integrations/website', { method: 'PUT', token, body: { mode: 'own' } });
  await call('/api/backoffice/contact/phones/integrations/google_business_profile', { method: 'PUT', token, body: { mode: 'other', other_phone: { country_iso2: 'MX', national_number: '9832222222' } } });
  await call('/api/backoffice/contact/phones/integrations/facebook', { method: 'PUT', token, body: { mode: 'other', other_phone: { country_iso2: 'US', national_number: '2125550123' } } });
  const phones = (await call('/api/backoffice/contact/phones', { token })).body;
  const eff = ['website', 'google_business_profile', 'facebook'].map((ch) => phones.integration_phones[ch].effective_phone);
  say(`   efectivos: web=${eff[0]} google=${eff[1]} facebook=${eff[2]}`);
  check(new Set(eff).size === 3 && eff[0] === '+529831111111', 'tres integraciones con número propio e independiente');
  const gbp = await call('/api/backoffice/google/profile', { method: 'PUT', token, body: { business_name: 'Cocina Doña Mary', primary_category: 'Restaurante', address_line: 'Av. Héroes 100', locality: 'Chetumal', hours: [{ day: 'mon', open: '09:00', close: '18:00' }] } });
  check(gbp.status === 200 && (await call('/api/backoffice/google/profile', { token })).body.phone.effective_phone === '+529832222222', 'ficha de Google simulada usa el número de Google');

  // ---------- FLOW-02: Página Web → preview → aprobación → publicación (usa el número de la web) ----------
  say('\n-- FLOW-02: Página Web --');
  const site = await call('/api/backoffice/website', { method: 'POST', token, body: { slug: `dona-mary-${Date.now()}`, site_name: 'Cocina Doña Mary' } });
  check(site.status === 201, 'el negocio crea su página web (cuota website del plan piloto)');
  const msg = await call('/api/backoffice/conversation/messages', { method: 'POST', token, body: { text: 'necesito cambiar el horario a lunes a sábado de 8 a 16', channel: 'simulated' } });
  const proposalId = String(msg.body.proposal_id ?? '');
  check(msg.status === 201 && msg.body.request.action_class === 'preview_required' && proposalId !== '', `solicitud de cambio web → propuesta (${msg.body.request?.intent})`);
  const conf = await call(`/api/backoffice/conversation/proposals/${proposalId}/confirm`, { method: 'POST', token });
  const previewHtml = (await page(String(conf.body.preview?.url ?? '/preview/none'))).html;
  check(conf.body.status === 'preview_ready' && /\+52 983 111 1111|\+529831111111/.test(previewHtml), 'vista previa con el teléfono efectivo de la Página Web');
  const webPub = await call(`/api/backoffice/conversation/proposals/${proposalId}/approve`, { method: 'POST', token });
  const webAgain = await call(`/api/backoffice/conversation/proposals/${proposalId}/approve`, { method: 'POST', token });
  check(webPub.body.status === 'published' && webAgain.body.already_published === true, 'aprobación → publicado una sola vez (desarrollo)');

  // ---------- Políticas, Telegram y post publicado ----------
  say('\n-- Agente: políticas opt-in, Telegram y post de Facebook --');
  const p1 = await call('/api/backoffice/engagement/policies', { method: 'PUT', token, body: { origin: 'google_review', category: 'gratitude', mode: 'safe_auto_reply', consent: true } });
  const p2 = await call('/api/backoffice/engagement/policies', { method: 'PUT', token, body: { origin: 'facebook_comment', category: 'basic_info', mode: 'safe_auto_reply', consent: true } });
  check(p1.body.policy.version === 1 && p2.body.policy.version === 1, 'opt-in explícito por origen y categoría (versión 1)');
  const code = await call('/api/backoffice/telegram/link-code', { method: 'POST', token });
  const chat = 880000000 + Math.floor(Math.random() * 1e6);
  const upd = 1_000_000_000 + (Date.now() % 1_000_000_000); // update_id propios de esta corrida
  const noSecret = await telegram(upd + 1, chat, `/start ${code.body.code}`, {});
  check(noSecret.status === 401 && noSecret.body.error?.code === 'unauthorized', 'webhook sin la cabecera del secreto: 401 (también en desarrollo)');
  const tgLink = await telegram(upd + 1, chat, `/start ${code.body.code}`);
  check(tgLink.body.handled === 'linked', 'Telegram vinculado con código de un solo uso (simulado)');
  const post = await call('/api/backoffice/social/posts', { method: 'POST', token, body: { text: 'Hoy: mole poblano y agua de jamaica.' } });
  const postId = String(post.body.post.post_id);
  const sp = await call(`/api/backoffice/social/posts/${postId}/approve`, { method: 'POST', token });
  await call(`/api/backoffice/conversation/proposals/${sp.body.proposal_id}/confirm`, { method: 'POST', token });
  const pub = await call(`/api/backoffice/conversation/proposals/${sp.body.proposal_id}/approve`, { method: 'POST', token });
  check(pub.body.status === 'published', 'publicación de Facebook aprobada y publicada (simulado)');
  const postBefore = (await pool.query('SELECT status, text, external_ref FROM social_post WHERE post_id = $1', [postId])).rows[0];

  // ---------- AG-01..03 por el worker del servidor (sin /engagement/run) ----------
  say('\n-- AG-01..03: el worker atiende sin navegador --');
  await call('/api/backoffice/dev/simulator/google-reviews', { method: 'POST', token, body: { external_ref: 'g-simple', rating: 5, body: '¡Excelente sazón, muchas gracias!', author_label: 'Ana' } });
  await call('/api/backoffice/dev/simulator/google-reviews', { method: 'POST', token, body: { external_ref: 'g-risk', rating: 1, body: 'Me enfermé después de comer, exijo reembolso', author_label: 'Beto' } });
  await call('/api/backoffice/dev/simulator/facebook-comments', { method: 'POST', token, body: { external_ref: 'fb-q', post_id: postId, body: '¿Cuál es su teléfono para pedidos?', author_label: 'Caro' } });
  await call('/api/backoffice/dev/simulator/facebook-comments', { method: 'POST', token, body: { external_ref: 'fb-risk', post_id: postId, body: 'Voy a denunciarlos, me cobraron de más', author_label: 'Dani' } });
  let cs = await waitFor('casos atendidos por el worker', token, (m) =>
    m.get('g-simple')?.state === 'responded' && m.get('fb-q')?.state === 'responded'
    && m.get('g-risk')?.notify_status === 'sent' && m.get('fb-risk')?.notify_status === 'sent');
  const gSimple = cs.get('g-simple');
  check(gSimple?.resolution_channel === 'auto' && gSimple.policy_version === 1 && gSimple.delivery_mode === 'simulated', 'AG-01 reseña simple respondida sola (política v1, simulated)');
  check(/\+1 212-555-0123|\+1 212 555 0123/.test(cs.get('fb-q')?.response_text ?? ''), 'AG-03 pregunta en Facebook respondida con el número de Facebook');
  check(cs.get('g-risk')?.state === 'needs_human' && cs.get('fb-risk')?.state === 'needs_human', 'AG-02/03 casos delicados esperan decisión humana');
  const notif = await pool.query(`SELECT count(*)::int AS n FROM engagement_notification WHERE tenant_id = $1 AND status = 'sent'`, [cli.tenant_id]);
  check(notif.rows[0].n === 2, 'un aviso de Telegram por caso delicado (simulado)');
  const postAfter = (await pool.query('SELECT status, text, external_ref FROM social_post WHERE post_id = $1', [postId])).rows[0];
  check(JSON.stringify(postAfter) === JSON.stringify(postBefore), 'la publicación previa no cambia');

  const gRisk = cs.get('g-risk');
  const approve = await telegram(upd + 2, chat, `/aprobar ${gRisk?.case_id} 1`);
  check(approve.body.handled === 'approved', 'aprobación desde Telegram (alternativa 1)');
  const reject = await call(`/api/backoffice/engagement/cases/${cs.get('fb-risk')?.case_id}/reject`, { method: 'POST', token, body: {} });
  check(reject.body.case.state === 'rejected', 'rechazo desde el panel (mismo caso)');
  cs = await casesOf(token);
  check(cs.get('g-risk')?.state === 'responded' && cs.get('g-risk')?.resolution_channel === 'telegram', 'panel refleja la decisión tomada en Telegram');

  // ---------- AG-04: caída y recuperación ----------
  say('\n-- AG-04: caída del servidor y worker independiente --');
  await call('/api/backoffice/dev/simulator/google-reviews', { method: 'POST', token, body: { external_ref: 'g-crash', rating: 5, body: 'Gracias, todo delicioso', author_label: 'Eli' } });
  await kill(server.proc, 'SIGKILL');
  say('   servidor terminado con SIGKILL');
  const atKill = await pool.query(`SELECT state FROM engagement_case WHERE tenant_id = $1 AND external_ref = 'g-crash'`, [cli.tenant_id]);
  say(`   estado de g-crash al morir el servidor: ${atKill.rows[0]?.state ?? 'aún no ingerido'}`);
  const stuck = await pool.query(`UPDATE engagement_case SET lease_until = now() - interval '1 second' WHERE tenant_id = $1 AND state = 'responding' RETURNING case_id`, [cli.tenant_id]);
  say(`   envíos interrumpidos a recuperar: ${stuck.rowCount ?? 0} (lease vencida forzada)`);
  const once = JSON.parse(execFileSync(process.execPath, ['scripts/engagement-worker.ts', '--once'], { env: childEnv({ ENGAGEMENT_WORKER: 'off' }) }).toString());
  check(once.tenants >= 1, 'worker independiente (proceso propio) ejecuta un ciclo');

  server = await startServer('off');
  base = server.base;
  cs = await casesOf(token);
  check(cs.get('g-crash')?.state === 'responded', 'caso recibido antes de la caída queda respondido');

  await kill(server.proc, 'SIGTERM');
  server = await startServer('on');
  base = server.base;
  await waitWorkerCycles(cli.tenant_id, 2);
  // Telegram reentrega la MISMA aprobación tras el reinicio (otro proceso): dedupe durable, sin segunda publicación.
  const redelivered = await telegram(upd + 2, chat, `/aprobar ${gRisk?.case_id} 1`);
  check(redelivered.status === 200 && redelivered.body.handled === 'duplicate', 'reentrega del mismo update_id tras reiniciar: duplicate (sin actuar)');
  const replies = (await call('/api/backoffice/dev/simulator/replies', { token })).body.replies as Array<{ target_ref: string }>;
  const refs = replies.map((r) => r.target_ref).sort();
  say(`   respuestas públicas simuladas: ${refs.join(', ')}`);
  check(JSON.stringify(refs) === JSON.stringify(['fb-q', 'g-crash', 'g-risk', 'g-simple']), 'reinicio sin dobles respuestas (una por caso, rechazado sin respuesta)');
  const notif2 = await pool.query(`SELECT count(*)::int AS n FROM engagement_notification WHERE tenant_id = $1`, [cli.tenant_id]);
  check(notif2.rows[0].n === 2, 'sin avisos duplicados tras el reinicio');

  // ---------- Aislamiento ----------
  say('\n-- Aislamiento multi-tenant --');
  const other = await call('/api/auth/login', { method: 'POST', body: { login: SEED.b.admin.login, password: SEED.b.admin.password } });
  const foreign = await call(`/api/backoffice/engagement/cases/${gRisk?.case_id}`, { token: String(other.body.token) });
  const ghost = await call('/api/backoffice/engagement/cases/case_inexistente', { token: String(other.body.token) });
  check(foreign.status === 404 && JSON.stringify(foreign.body) === JSON.stringify(ghost.body), 'otro negocio recibe el mismo 404 que un caso inexistente');
  const foreignTg = await telegram(upd + 3, chat + 1, `/aprobar ${gRisk?.case_id} 1`);
  check(foreignTg.body.handled === 'unlinked_chat', 'chat no vinculado no puede decidir');
  await kill(server.proc, 'SIGTERM');
});
