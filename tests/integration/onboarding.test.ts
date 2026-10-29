/**
 * Integration — DEV-E2E-02 FLOW-01: alta asistida con invitación de un solo uso y acceso del
 * dueño con correo + contraseña, sin identificador interno de cliente.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApi, api, authHeaders, type TestApi } from '../helpers/testdb.ts';
import { OnboardingService } from '../../src/identity/onboarding.ts';
import { AuditSink } from '../../src/audit/sink.ts';

let t: TestApi;
let onboarding: OnboardingService;

before(async () => {
  t = await bootApi();
  onboarding = new OnboardingService({ pool: t.pool, sink: new AuditSink(t.pool) });
});

after(async () => {
  await t.close();
});

const NEUTRAL = /no es válido o ya no está disponible/;

async function post(path: string, body: unknown) {
  return api(t.baseUrl, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('FLOW-01: invitación de un solo uso → cuenta del dueño (Administración) → acceso sin tenant_id', async () => {
  const email = `duena.${Date.now()}@example.com`;
  const inv = await onboarding.createBusinessWithInvitation({ businessName: 'Panadería Lupita', ownerEmail: email, createdBy: 'operator:test' });
  assert.match(inv.path, /^\/invitacion#/, 'el token viaja en el fragmento (no llega a registros del servidor)');
  const stored = await t.pool.query('SELECT token_hash, status FROM owner_invitation WHERE invitation_id = $1', [inv.invitation_id]);
  assert.notEqual(stored.rows[0].token_hash, inv.token, 'el token no se guarda en claro');

  const desc = await post('/api/auth/invitation', { token: inv.token });
  assert.equal(desc.status, 200);
  assert.equal(desc.body.business_name, 'Panadería Lupita');
  assert.equal(desc.body.tenant_id, undefined, 'la UI pública no expone el id interno');

  const weak = await post('/api/auth/invitation/accept', { token: inv.token, display_name: 'Lupita', password: 'corta' });
  assert.equal(weak.status, 400);
  assert.equal((await t.pool.query('SELECT status FROM owner_invitation WHERE invitation_id = $1', [inv.invitation_id])).rows[0].status, 'pending', 'un intento inválido no consume la invitación');

  const ok = await post('/api/auth/invitation/accept', { token: inv.token, display_name: 'Lupita', password: 'Pan-Dulce-2026' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.login, email);
  const reuse = await post('/api/auth/invitation/accept', { token: inv.token, display_name: 'Otra', password: 'Pan-Dulce-2026' });
  assert.equal(reuse.status, 404);
  assert.match(reuse.body.error.message, NEUTRAL);

  const login = await post('/api/auth/login', { login: email, password: 'Pan-Dulce-2026' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.session.tenant_id, inv.tenant_id);
  assert.equal(login.body.session.role_id, 'administration');
  const me = await api(t.baseUrl, '/api/backoffice/me', { headers: authHeaders(login.body.token) });
  assert.equal(me.status, 200);
  const sub = await api(t.baseUrl, '/api/backoffice/subscriptions/entitlements', { headers: authHeaders(login.body.token) });
  assert.equal(sub.status, 200, 'el negocio queda con su plan piloto');
  assert.equal(sub.body.tenant_id, inv.tenant_id);

  const bad = await post('/api/auth/login', { login: email, password: 'Incorrecta-2026' });
  const unknown = await post('/api/auth/login', { login: 'nadie@example.com', password: 'Incorrecta-2026' });
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(bad.body.error.message, unknown.body.error.message, 'misma respuesta: no revela si el correo existe');

  const audit = await t.pool.query(`SELECT action, resource, result, request_id, actor_id FROM audit_event WHERE tenant_id = $1`, [inv.tenant_id]);
  assert.ok(audit.rows.some((r) => r.action === 'onboarding.invitation.accepted'));
  assert.ok(!JSON.stringify(audit.rows).includes(email), 'el correo no queda en auditoría');
  assert.ok(!JSON.stringify(audit.rows).includes('Pan-Dulce-2026'));
  console.log('TEST_PASS FLOW-01 onboarding + login sin tenant_id');
});

test('FLOW-01: invitación caducada, inexistente o usada a la vez → respuesta neutra; un solo ganador', async () => {
  const exp = await onboarding.createBusinessWithInvitation({ businessName: 'Tacos Caducados', ownerEmail: `exp.${Date.now()}@example.com`, createdBy: 'operator:test' });
  await t.pool.query(`UPDATE owner_invitation SET expires_at = now() - interval '1 minute' WHERE invitation_id = $1`, [exp.invitation_id]);
  const expired = await post('/api/auth/invitation', { token: exp.token });
  const missing = await post('/api/auth/invitation', { token: 'no-existe' });
  assert.equal(expired.status, 404);
  assert.deepEqual(expired.body, missing.body, 'caducada e inexistente son indistinguibles');

  const race = await onboarding.createBusinessWithInvitation({ businessName: 'Café Carrera', ownerEmail: `race.${Date.now()}@example.com`, createdBy: 'operator:test' });
  const both = await Promise.all([
    post('/api/auth/invitation/accept', { token: race.token, display_name: 'Uno', password: 'Cafe-Carrera-2026' }),
    post('/api/auth/invitation/accept', { token: race.token, display_name: 'Dos', password: 'Cafe-Carrera-2026' }),
  ]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 404]);
  const users = await t.pool.query('SELECT count(*)::int AS n FROM internal_user WHERE tenant_id = $1', [race.tenant_id]);
  assert.equal(users.rows[0].n, 1);
});

test('FLOW-01: mismo correo en dos negocios → elegir negocio (solo tras demostrar la contraseña)', async () => {
  const email = `multi.${Date.now()}@example.com`;
  const one = await onboarding.createBusinessWithInvitation({ businessName: 'Negocio Uno', ownerEmail: email, createdBy: 'operator:test' });
  const two = await onboarding.createBusinessWithInvitation({ businessName: 'Negocio Dos', ownerEmail: email, createdBy: 'operator:test' });
  assert.equal((await post('/api/auth/invitation/accept', { token: one.token, display_name: 'Multi', password: 'Multi-Negocio-2026' })).status, 201);
  assert.equal((await post('/api/auth/invitation/accept', { token: two.token, display_name: 'Multi', password: 'Multi-Negocio-2026' })).status, 201);

  const ambiguous = await post('/api/auth/login', { login: email, password: 'Multi-Negocio-2026' });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.body.error.code, 'tenant_selection_required');
  assert.deepEqual(ambiguous.body.tenants.map((x: { business_name: string }) => x.business_name), ['Negocio Dos', 'Negocio Uno']);
  const wrong = await post('/api/auth/login', { login: email, password: 'Mala-Clave-2026' });
  assert.equal(wrong.status, 401, 'sin contraseña válida no se revela la lista de negocios');
  assert.equal(wrong.body.tenants, undefined);

  const chosen = await post('/api/auth/login', { login: email, password: 'Multi-Negocio-2026', tenant_id: two.tenant_id });
  assert.equal(chosen.status, 200);
  assert.equal(chosen.body.session.tenant_id, two.tenant_id);
  const cross = await api(t.baseUrl, '/api/backoffice/contact/phones', { headers: authHeaders(chosen.body.token) });
  assert.equal(cross.body.tenant_id, two.tenant_id, 'la sesión solo ve su negocio');
});
