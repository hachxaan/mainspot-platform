/**
 * Integration — DEV-E2E-04 §3 (AUTH-RESET): recuperación de contraseña por correo.
 *
 * Transporte de correo de PRUEBAS en memoria (SIMULATED_REGRESSION: no demuestra entrega real).
 * Cubre: respuesta neutra (existe / no existe) con tiempo acotado, límite de intentos por IP y
 * por correo sin oráculo, token solo hasheado en BD y ausente de auditoría, caducidad, un solo
 * uso, solicitud nueva anula la anterior, carrera de canje, sesión antigua rechazada (401) y
 * acceso con la contraseña nueva, contraseña débil, salida sin eco del dato de entrada (XSS) y
 * transporte deshabilitado sin fingir envío.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo, Server } from 'node:net';
import pg from 'pg';
import { createApp, type AppHandle } from '../../src/api/server.ts';
import { OnboardingService } from '../../src/identity/onboarding.ts';
import { AuditSink } from '../../src/audit/sink.ts';
import { TEST_CONFIG, TEST_URL, api, authHeaders } from '../helpers/testdb.ts';
import { TestMailer, tokenFromLink } from '../helpers/test-mailer.ts';
import { captureStdout, type StdoutCapture } from '../helpers/capture-stdout.ts';

const PUBLIC = 'https://app.mainspot.local.io';
const { Pool } = pg;

let pool: pg.Pool;
let handle: AppHandle;
let server: Server;
let baseUrl: string;
let mailer: TestMailer;
let onboarding: OnboardingService;

before(async () => {
  pool = new Pool({ connectionString: TEST_URL, max: 6 });
  mailer = new TestMailer();
  handle = createApp({ config: { ...TEST_CONFIG, engagementPollIntervalMs: 0, publicBaseUrl: PUBLIC }, pool, mailer });
  server = await new Promise((resolve) => { const s = handle.app.listen(0, '127.0.0.1', () => resolve(s)); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onboarding = new OnboardingService({ pool, sink: new AuditSink(pool) });
});

after(async () => {
  handle.engagementWorker.stop();
  await handle.passwordReset.drain();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

beforeEach(() => handle.passwordReset.resetRateLimits());

async function post(path: string, body: unknown) {
  return api(baseUrl, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
const forgot = (login: string) => post('/api/auth/password/forgot', { login });
const reset = (token: string, password: string) => post('/api/auth/password/reset', { token, password });

/** Cuenta de dueño lista para entrar (alta por invitación, como en producto). */
async function owner(business: string, password = 'Clave-Inicial-2026') {
  const email = `p2.${business.toLowerCase().replace(/\W+/g, '')}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@example.com`;
  const inv = await onboarding.createBusinessWithInvitation({ businessName: business, ownerEmail: email, createdBy: 'operator:test' });
  const acc = await post('/api/auth/invitation/accept', { token: inv.token, display_name: 'Dueña', password });
  assert.equal(acc.status, 201);
  return { email, password, tenant_id: inv.tenant_id };
}

async function requestLink(email: string): Promise<string> {
  const before = mailer.to(email).length;
  const r = await forgot(email);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await handle.passwordReset.drain();
  assert.equal(mailer.to(email).length, before + 1, 'se envió exactamente un correo');
  const link = mailer.lastLink(email);
  assert.ok(link, 'el correo trae el enlace');
  return tokenFromLink(link);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

test('AUTH-RESET: misma respuesta y duración acotada exista o no el correo; sin eco de la entrada', async () => {
  const acc = await owner('Florería Neutra');
  const t0 = Date.now();
  const existing = await forgot(acc.email);
  const t1 = Date.now();
  const missing = await forgot(`nadie.${Date.now()}@example.com`);
  const t2 = Date.now();
  assert.equal(existing.status, 200);
  assert.deepEqual(existing.body, missing.body, 'cuerpo idéntico: no revela si el correo existe');
  assert.ok(t1 - t0 >= handle.passwordReset.minResponseMs - 5 && t2 - t1 >= handle.passwordReset.minResponseMs - 5, 'ambas respetan la duración mínima');
  assert.ok(Math.abs((t1 - t0) - (t2 - t1)) < 150, `duraciones similares (${t1 - t0} ms vs ${t2 - t1} ms)`);

  const xss = await forgot('<script>alert(1)</script>@example.com');
  assert.equal(xss.status, 200);
  assert.ok(!JSON.stringify(xss.body).includes('<script>'), 'la respuesta nunca repite lo que escribió quien pide');
  assert.deepEqual(xss.body, missing.body);

  await handle.passwordReset.drain();
  assert.equal(mailer.to(acc.email).length, 1, 'un correo para la cuenta existente');
  assert.equal(mailer.sent.filter((m) => m.to !== acc.email).length, 0, 'ningún correo para cuentas inexistentes');
  const mail = mailer.to(acc.email)[0]!;
  assert.match(mail.subject, /contraseña nueva/i);
  assert.ok(mail.text.includes(`${PUBLIC}/restablecer#`), 'enlace con el origen público y el token en el fragmento');
  assert.ok(!mail.text.includes('Florería'), 'el correo no menciona el negocio');
  assert.ok(!mail.text.includes(acc.password) && !mail.html!.includes(acc.password));
  assert.ok(!/\?token=|\/restablecer\/[A-Za-z0-9_-]{20,}/.test(mail.text), 'el token nunca va en ruta ni query');
  console.log('TEST_PASS AUTH-RESET neutral + sin eco');
});

test('AUTH-RESET: token hasheado en BD; ni token, ni correo, ni contraseña en auditoría', async () => {
  const acc = await owner('Taller Hash');
  const token = await requestLink(acc.email);
  assert.ok(token.length >= 40, 'token de 256 bits en base64url');
  const rows = await pool.query('SELECT token_hash, status, delivery, expires_at, created_at FROM password_reset_token WHERE login = $1', [acc.email]);
  assert.equal(rows.rows.length, 1);
  assert.notEqual(rows.rows[0].token_hash, token);
  assert.equal(rows.rows[0].token_hash, sha256(token), 'solo el SHA-256 queda en la base');
  assert.equal(rows.rows[0].delivery, 'sent');
  const ttlMin = (new Date(rows.rows[0].expires_at).getTime() - new Date(rows.rows[0].created_at).getTime()) / 60_000;
  assert.ok(ttlMin > 29 && ttlMin <= 30, `vigencia de 30 minutos (${ttlMin})`);

  const audit = await pool.query(`SELECT action, result, resource, actor_id FROM audit_event WHERE tenant_id = $1 AND action LIKE 'auth.password.%'`, [acc.tenant_id]);
  const dump = JSON.stringify(audit.rows);
  assert.ok(audit.rows.some((r) => r.action === 'auth.password.reset_requested' && r.result === 'link_issued'));
  assert.ok(audit.rows.some((r) => r.action === 'auth.password.reset_mail' && r.result === 'sent'));
  assert.ok(!dump.includes(token) && !dump.includes(sha256(token)), 'ni el token ni su hash en auditoría');
  assert.ok(!dump.includes(acc.email), 'el correo no queda en auditoría');
  assert.ok(!dump.includes(acc.password));
  console.log('TEST_PASS AUTH-RESET hash en reposo y auditoría limpia');
});

test('AUTH-RESET: contraseña débil no consume; cambio real; un solo uso; sesión antigua fuera (401) y nueva dentro', async () => {
  const acc = await owner('Café Sesiones');
  const oldLogin = await post('/api/auth/login', { login: acc.email, password: acc.password });
  assert.equal(oldLogin.status, 200);
  const oldToken = oldLogin.body.token as string;
  assert.equal((await api(baseUrl, '/api/backoffice/me', { headers: authHeaders(oldToken) })).status, 200, 'la sesión antigua funciona antes del cambio');

  const token = await requestLink(acc.email);
  const weak = await reset(token, 'corta1');
  assert.equal(weak.status, 400);
  assert.match(weak.body.error.message, /al menos 10 caracteres/);
  assert.equal((await pool.query('SELECT status FROM password_reset_token WHERE token_hash = $1', [sha256(token)])).rows[0].status, 'pending', 'una contraseña débil no gasta el enlace');
  assert.equal((await reset(token, 'solo-letras-sin-numero')).status, 400);

  const ok = await reset(token, 'Nueva-Clave-2026');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.message, /Tu contraseña cambió/);

  const reuse = await reset(token, 'Otra-Clave-2026');
  assert.equal(reuse.status, 404, 'el enlace sirve una sola vez');
  const bogus = await reset('x'.repeat(43), 'Otra-Clave-2026');
  assert.deepEqual(reuse.body, bogus.body, 'usado e inexistente son indistinguibles');

  const stale = await api(baseUrl, '/api/backoffice/me', { headers: authHeaders(oldToken) });
  assert.equal(stale.status, 401, 'la sesión emitida antes del cambio queda revocada');
  const revoked = await pool.query(`SELECT revoked_at FROM session_context WHERE session_id = $1`, [oldLogin.body.session.session_id]);
  assert.ok(revoked.rows[0].revoked_at, 'la fila de sesión queda revocada');

  assert.equal((await post('/api/auth/login', { login: acc.email, password: acc.password })).status, 401, 'la contraseña anterior ya no sirve');
  const fresh = await post('/api/auth/login', { login: acc.email, password: 'Nueva-Clave-2026' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal((await api(baseUrl, '/api/backoffice/me', { headers: authHeaders(fresh.body.token) })).status, 200, 'la sesión nueva entra');

  const changed = await pool.query(`SELECT password_hash, password_changed_at FROM internal_user WHERE login = $1`, [acc.email]);
  assert.ok(changed.rows[0].password_changed_at);
  assert.ok(!String(changed.rows[0].password_hash).includes('Nueva-Clave-2026'), 'la contraseña queda hasheada (bcrypt de pgcrypto)');
  const audit = await pool.query(`SELECT action, result FROM audit_event WHERE tenant_id = $1 AND action = 'auth.password.reset'`, [acc.tenant_id]);
  assert.deepEqual(audit.rows, [{ action: 'auth.password.reset', result: 'password_changed' }]);
  console.log('TEST_PASS AUTH-RESET cambio + revocación de sesiones');
});

test('AUTH-RESET: enlace caducado → misma respuesta neutra que inexistente', async () => {
  const acc = await owner('Panadería Caducada');
  const token = await requestLink(acc.email);
  await pool.query(`UPDATE password_reset_token SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [sha256(token)]);
  const expired = await reset(token, 'Clave-Caducada-2026');
  const missing = await reset('y'.repeat(43), 'Clave-Caducada-2026');
  assert.equal(expired.status, 404);
  assert.deepEqual(expired.body, missing.body);
  assert.equal((await post('/api/auth/login', { login: acc.email, password: acc.password })).status, 200, 'la contraseña no cambió');
});

test('AUTH-RESET: dos solicitudes → la anterior deja de valer; la nueva funciona', async () => {
  const acc = await owner('Librería Doble');
  const first = await requestLink(acc.email);
  const second = await requestLink(acc.email);
  assert.notEqual(first, second);
  const st = await pool.query(`SELECT token_hash, status FROM password_reset_token WHERE login = $1 ORDER BY created_at`, [acc.email]);
  assert.deepEqual(st.rows.map((r) => r.status), ['superseded', 'pending']);
  assert.equal((await reset(first, 'Clave-Primera-2026')).status, 404, 'el enlace anterior ya no sirve');
  assert.equal((await reset(second, 'Clave-Segunda-2026')).status, 200);
  assert.equal((await post('/api/auth/login', { login: acc.email, password: 'Clave-Segunda-2026' })).status, 200);
});

test('AUTH-RESET: canje concurrente del mismo enlace → solo uno gana', async () => {
  const acc = await owner('Taquería Carrera');
  const token = await requestLink(acc.email);
  const both = await Promise.all([reset(token, 'Clave-Uno-2026'), reset(token, 'Clave-Dos-2026')]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 404]);
  const winner = both[0]!.status === 200 ? 'Clave-Uno-2026' : 'Clave-Dos-2026';
  const loser = winner === 'Clave-Uno-2026' ? 'Clave-Dos-2026' : 'Clave-Uno-2026';
  assert.equal((await post('/api/auth/login', { login: acc.email, password: winner })).status, 200);
  assert.equal((await post('/api/auth/login', { login: acc.email, password: loser })).status, 401);
  const n = await pool.query(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND action = 'auth.password.reset' AND result = 'password_changed'`, [acc.tenant_id]);
  assert.equal(n.rows[0].n, 1, 'la contraseña cambió una sola vez');
});

test('AUTH-RESET: límite por correo (exista o no) y por IP, sin revelar nada; canje también limitado', async () => {
  const acc = await owner('Boutique Límite');
  const ghost = `fantasma.${Date.now()}@example.com`;
  for (let i = 0; i < 3; i++) {
    assert.equal((await forgot(acc.email)).status, 200);
    assert.equal((await forgot(ghost)).status, 200);
  }
  const realLimited = await forgot(acc.email);
  const ghostLimited = await forgot(ghost);
  assert.equal(realLimited.status, 429);
  assert.equal(ghostLimited.status, 429, 'el correo inexistente se limita igual: el límite no es un oráculo');
  assert.deepEqual(realLimited.body, ghostLimited.body);
  await handle.passwordReset.drain();
  assert.equal(mailer.to(acc.email).length, 3, 'tras el límite no se emiten más correos');

  handle.passwordReset.resetRateLimits();
  for (let i = 0; i < 10; i++) assert.equal((await forgot(`ip.${i}.${Date.now()}@example.com`)).status, 200);
  const ipLimitedRes = await fetch(`${baseUrl}/api/auth/password/forgot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: `ip.final.${Date.now()}@example.com` }) });
  assert.equal(ipLimitedRes.status, 429, 'límite por IP con correos distintos');
  assert.ok(Number(ipLimitedRes.headers.get('retry-after')) >= 1, 'Retry-After presente');

  handle.passwordReset.resetRateLimits();
  for (let i = 0; i < 10; i++) assert.equal((await reset('z'.repeat(43), 'Clave-Fuerza-2026')).status, 404);
  assert.equal((await reset('z'.repeat(43), 'Clave-Fuerza-2026')).status, 429, 'la fuerza bruta sobre el canje se frena');
  console.log('TEST_PASS AUTH-RESET límites por correo e IP');
});

test('AUTH-RESET: mismo correo en dos negocios → un enlace cambia ambas cuentas sin revelar negocios', async () => {
  const email = `multi.p2.${Date.now()}@example.com`;
  const one = await onboarding.createBusinessWithInvitation({ businessName: 'Negocio Alfa', ownerEmail: email, createdBy: 'operator:test' });
  const two = await onboarding.createBusinessWithInvitation({ businessName: 'Negocio Beta', ownerEmail: email, createdBy: 'operator:test' });
  assert.equal((await post('/api/auth/invitation/accept', { token: one.token, display_name: 'Multi', password: 'Multi-Clave-2026' })).status, 201);
  assert.equal((await post('/api/auth/invitation/accept', { token: two.token, display_name: 'Multi', password: 'Multi-Clave-2026' })).status, 201);
  const sessA = await post('/api/auth/login', { login: email, password: 'Multi-Clave-2026', tenant_id: one.tenant_id });
  const sessB = await post('/api/auth/login', { login: email, password: 'Multi-Clave-2026', tenant_id: two.tenant_id });
  assert.equal(sessA.status, 200); assert.equal(sessB.status, 200);

  const token = await requestLink(email);
  const mail = mailer.to(email).at(-1)!;
  assert.ok(!mail.text.includes('Alfa') && !mail.text.includes('Beta'), 'el correo no revela a qué negocios pertenece');
  assert.equal(mailer.to(email).length, 1, 'un solo correo aunque haya dos cuentas');

  assert.equal((await reset(token, 'Multi-Nueva-2026')).status, 200);
  const pick = await post('/api/auth/login', { login: email, password: 'Multi-Nueva-2026' });
  assert.equal(pick.status, 409, 'ambas cuentas aceptan la contraseña nueva');
  assert.equal(pick.body.tenants.length, 2);
  assert.equal((await post('/api/auth/login', { login: email, password: 'Multi-Clave-2026', tenant_id: one.tenant_id })).status, 401);
  assert.equal((await api(baseUrl, '/api/backoffice/me', { headers: authHeaders(sessA.body.token) })).status, 401);
  assert.equal((await api(baseUrl, '/api/backoffice/me', { headers: authHeaders(sessB.body.token) })).status, 401);
  for (const t of [one.tenant_id, two.tenant_id]) {
    const a = await pool.query(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND action = 'auth.password.reset'`, [t]);
    assert.equal(a.rows[0].n, 1, 'auditoría por negocio');
  }
});

test('AUTH-RESET: cuenta suspendida no recibe enlace; el enlace de una cuenta nunca cambia otra', async () => {
  const victim = await owner('Cuenta Ajena');
  const bystander = await owner('Cuenta Vecina');
  const suspended = await owner('Cuenta Suspendida');
  await pool.query(`UPDATE internal_user SET status = 'suspended' WHERE login = $1`, [suspended.email]);
  assert.equal((await forgot(suspended.email)).status, 200);
  await handle.passwordReset.drain();
  assert.equal(mailer.to(suspended.email).length, 0, 'una cuenta suspendida no recibe enlace');

  const token = await requestLink(victim.email);
  assert.equal((await reset(token, 'Victima-Nueva-2026')).status, 200);
  assert.equal((await post('/api/auth/login', { login: victim.email, password: 'Victima-Nueva-2026' })).status, 200);
  assert.equal((await post('/api/auth/login', { login: bystander.email, password: bystander.password })).status, 200, 'la cuenta vecina conserva su contraseña');
  const untouched = await pool.query(`SELECT login FROM internal_user WHERE login = ANY($1::text[]) AND password_changed_at IS NOT NULL`, [[bystander.email, suspended.email]]);
  assert.deepEqual(untouched.rows, [], 'ni la vecina ni la suspendida cambiaron');
});

test('AUTH-RESET: entradas inválidas → 400 claro; el shell del panel atiende /restablecer sin tocar el token', async () => {
  const empty = await post('/api/auth/password/forgot', {});
  assert.equal(empty.status, 400);
  const noToken = await post('/api/auth/password/reset', { password: 'Clave-Sin-Token-2026' });
  assert.equal(noToken.status, 404, 'sin token es como un enlace inválido (misma respuesta neutra)');
  const res = await fetch(`${baseUrl}/restablecer`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('AUTH-RESET: transporte deshabilitado → respuesta neutra, nada enviado y constancia honesta (BLOCKED_EXTERNAL)', async () => {
  const disabledPool = new Pool({ connectionString: TEST_URL, max: 3 });
  const app2 = createApp({ config: { ...TEST_CONFIG, engagementPollIntervalMs: 0, publicBaseUrl: PUBLIC, mail: { ...TEST_CONFIG.mail, transport: 'disabled' } }, pool: disabledPool });
  const srv2: Server = await new Promise((resolve) => { const s = app2.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url2 = `http://127.0.0.1:${(srv2.address() as AddressInfo).port}`;
  let captured: StdoutCapture | null = null;
  try {
    assert.equal(app2.mailer.provider, 'disabled');
    assert.equal(app2.mailer.enabled, false);
    const acc = await owner('Negocio Sin Correo');
    captured = captureStdout();
    const r = await api(url2, '/api/auth/password/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: acc.email }) });
    await app2.passwordReset.drain();
    captured.restore();
    const lines = captured.lines;
    assert.equal(r.status, 200);
    const row = await pool.query(`SELECT delivery, status FROM password_reset_token WHERE login = $1`, [acc.email]);
    assert.equal(row.rows[0].delivery, 'disabled', 'la fila dice que NO se envió');
    const audit = await pool.query(`SELECT result FROM audit_event WHERE tenant_id = $1 AND action = 'auth.password.reset_mail'`, [acc.tenant_id]);
    assert.deepEqual(audit.rows, [{ result: 'disabled' }]);
    const logged = lines.filter((l) => l.includes('"event":"mail.transport_disabled"'));
    assert.equal(logged.length, 1, 'se registra mail.transport_disabled');
    assert.ok(!lines.some((l) => l.includes(acc.email)), 'ningún registro contiene el correo');
    assert.ok(!lines.some((l) => l.includes('"event":"mail.sent"')), 'nunca se registra un envío que no ocurrió');
  } finally {
    captured?.restore();
    app2.engagementWorker.stop();
    await new Promise<void>((resolve) => srv2.close(() => resolve()));
    await disabledPool.end();
  }
  console.log('TEST_PASS AUTH-RESET transporte deshabilitado sin falso envío');
});

test('AUTH-RESET: solicitudes simultáneas dejan un solo enlace vigente', async () => {
  const acc = await owner('Solicitudes Concurrentes');
  await Promise.all([forgot(acc.email), forgot(acc.email)]);
  await handle.passwordReset.drain();
  const messages = mailer.to(acc.email);
  assert.equal(messages.length, 2);
  const states = await pool.query(`SELECT status FROM password_reset_token WHERE login=$1`, [acc.email]);
  assert.equal(states.rows.filter((r) => r.status === 'pending').length, 1);
  const tokens = messages.map((m) => tokenFromLink(/https?:\/\/\S+/.exec(m.text)![0]));
  const results = await Promise.all(tokens.map((token) => reset(token, 'Concurrente-Nueva-2026')));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 404]);
});

test('AUTH-RESET: un login que comprobó la contraseña antes del reset no crea una sesión válida después', async () => {
  const acc = await owner('Login Concurrente');
  const resetToken = await requestLink(acc.email);
  const original = handle.identityRepo.createSession.bind(handle.identityRepo);
  let changed = false;
  handle.identityRepo.createSession = async (session, db, expectedHash) => {
    if (!changed) {
      changed = true;
      await handle.passwordReset.reset({ token: resetToken, password: 'Cambio-Concurrente-2026', requestId: 'reset-during-login' });
    }
    return original(session, db, expectedHash);
  };
  try {
    assert.equal((await post('/api/auth/login', { login: acc.email, password: acc.password })).status, 401);
  } finally { handle.identityRepo.createSession = original; }
  assert.equal((await post('/api/auth/login', { login: acc.email, password: 'Cambio-Concurrente-2026' })).status, 200);
});
