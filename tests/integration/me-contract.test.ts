/**
 * /api/backoffice/me — canonical contract (documented in README §4).
 *
 * Locks the shape the panel consumes:
 *   { session: { user_id, display_name, tenant_id,
 *                tenant: { id, business_name, status } | null,
 *                role_id, role_label, role_description,
 *                permissions: string[] (ALWAYS an array, never a count),
 *                expires_at } }
 *
 * Also covers the tenant-scoped GET /actions list used by the panel
 * (operation.create: admin + operation; denied + audited for read_only).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApi, login, authHeaders, api, SEED, type TestApi } from '../helpers/testdb.ts';

let t: TestApi;

before(async () => {
  t = await bootApi();
});

after(async () => {
  await t.close();
});

async function contractOf(creds: { login: string; password: string }, role: string) {
  const loginRes = await login(t.baseUrl, creds.login, creds.password, SEED.a.tenant);
  const me = await api(t.baseUrl, '/api/backoffice/me', { headers: authHeaders(loginRes.token) });
  return { status: me.status, body: me.body, token: loginRes.token };
}

test('ME-CONTRACT: administration /me returns the canonical shape', async () => {
  const { status, body, token } = await contractOf(SEED.a.admin, 'administration');
  assert.equal(status, 200);
  const s = body.session;
  assert.equal(s.user_id, 'user_a_admin');
  assert.equal(s.display_name, 'Ana Administradora');
  assert.equal(s.tenant_id, 'client_a');
  assert.deepEqual(s.tenant, { id: 'client_a', business_name: 'Restaurante El Sol (cliente de prueba A)', status: 'active' });
  assert.equal(s.role_id, 'administration');
  assert.equal(s.role_label, 'Administración');
  assert.equal(typeof s.role_description, 'string');
  assert.ok(Array.isArray(s.permissions), 'permissions is an array');
  assert.ok(s.permissions.length >= 1);
  assert.equal(typeof s.expires_at, 'string');
  // Panel mutation flows keep working (POST /actions -> GET /actions).
  const created = await api(t.baseUrl, '/api/backoffice/actions', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ title: 'ME-CONTRACT action' }),
  });
  assert.equal(created.status, 201);
  const listed = await api(t.baseUrl, '/api/backoffice/actions', { headers: authHeaders(token) });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.actions.some((a: { title: string }) => a.title === 'ME-CONTRACT action'));
  console.log('TEST_PASS ME-CONTRACT administration canonical /me + GET /actions');
});

test('ME-CONTRACT: operation and read_only keep canonical shape too', async () => {
  const ops = await contractOf(SEED.a.ops, 'operation');
  assert.equal(ops.status, 200);
  assert.equal(ops.body.session.role_id, 'operation');
  assert.equal(ops.body.session.role_label, 'Operación');
  assert.ok(Array.isArray(ops.body.session.permissions), 'ops permissions array');

  const reader = await contractOf(SEED.a.reader, 'read_only');
  assert.equal(reader.status, 200);
  assert.equal(reader.body.session.role_id, 'read_only');
  assert.equal(reader.body.session.role_label, 'Solo lectura');
  assert.ok(Array.isArray(reader.body.session.permissions), 'reader permissions array');
  assert.ok(reader.body.session.permissions.length >= 1, 'reader permissions non-empty');
  console.log('TEST_PASS ME-CONTRACT operation/read_only canonical /me');
});

test('ME-CONTRACT: read_only cannot list demo actions (fail-closed + audited)', async () => {
  const reader = await contractOf(SEED.a.reader, 'read_only');
  const denied = await api(t.baseUrl, '/api/backoffice/actions', { headers: authHeaders(reader.token) });
  assert.equal(denied.status, 403);
  assert.ok(denied.body.error && typeof denied.body.error.message === 'string');
  const ev = await t.pool.query(
    `SELECT * FROM audit_event WHERE tenant_id = $1 AND actor_id = $2 AND action = 'access.deny'
     AND resource LIKE '/api/backoffice/actions%' ORDER BY ts DESC LIMIT 1`,
    [SEED.a.tenant, 'user_a_reader'],
  );
  assert.ok((ev.rows[0] as { decision?: string } | undefined)?.decision === 'deny', 'denial is audited');
  console.log('TEST_PASS ME-CONTRACT read_only actions denied + audited');
});
