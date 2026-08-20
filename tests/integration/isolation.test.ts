/**
 * AC-002 — Tenant isolation (integration, negative + positive).
 * Precondition: test database with 2 tenants (scripts/test-prep.ts).
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

test('AC-002 positive: actor A reads ONLY its own tenant data', async () => {
  const { token } = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const { status, body } = await api(t.baseUrl, '/api/backoffice/data', { headers: authHeaders(token) });
  assert.equal(status, 200);
  const ids = (body.data as Array<{ data_id: string }>).map((r) => r.data_id);
  assert.ok(ids.includes('data_a_001'), 'should see own data');
  assert.ok(!ids.some((id) => id.startsWith('data_b_')), 'must NOT see tenant B data');
  console.log('TEST_PASS AC-002 positive scoped-list (tenant A sees only A data)');
});

test('AC-002 negative: actor A reading resource of tenant B is not-found (anti-oracle)', async () => {
  const { token } = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const { status, body } = await api(t.baseUrl, '/api/backoffice/data/data_b_001', { headers: authHeaders(token) });
  // IR-01: cross-tenant and nonexistent behave IDENTICALLY (404, same code).
  assert.equal(status, 404);
  assert.equal(body.error.code, 'not_found');
  console.log('TEST_PASS AC-002 negative cross-tenant read -> 404 not_found (anti-oracle)');
});

test('IR-01 anti-oracle: other-tenant and nonexistent resources are indistinguishable (data)', async () => {
  const { token } = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const otherTenantId = 'data_b_001'; // exists, but belongs to client_b
  const nonexistentId = 'data_does_not_exist_xyz';

  const a = await api(t.baseUrl, `/api/backoffice/data/${otherTenantId}`, { headers: authHeaders(token) });
  const b = await api(t.baseUrl, `/api/backoffice/data/${nonexistentId}`, { headers: authHeaders(token) });
  assert.equal(a.status, 404);
  assert.equal(b.status, 404);
  assert.deepEqual(a.body, b.body, 'status + body must be identical for other-tenant vs nonexistent');
  // Audit events must NOT differentiate existence either: same action/decision/result.
  const evA = (await t.pool.query(
    `SELECT action, decision, result, resource FROM audit_event WHERE tenant_id='client_a' AND resource=$1 ORDER BY ts DESC LIMIT 1`,
    [`tenant:data/${otherTenantId}`],
  )).rows[0] as Record<string, unknown> | undefined;
  const evB = (await t.pool.query(
    `SELECT action, decision, result, resource FROM audit_event WHERE tenant_id='client_a' AND resource=$1 ORDER BY ts DESC LIMIT 1`,
    [`tenant:data/${nonexistentId}`],
  )).rows[0] as Record<string, unknown> | undefined;
  assert.ok(evA && evB, 'both requests must be audited');
  assert.equal(evA.action, evB.action);
  assert.equal(evA.decision, evB.decision);
  assert.equal(evA.result, evB.result);
  assert.equal(evA.result, 'not_found', 'audit result must NOT reveal existence');
  console.log('TEST_PASS IR-01 anti-oracle data: other-tenant == nonexistent (status, body, audit)');
});

test('IR-01 anti-oracle: other-tenant and nonexistent actions are indistinguishable (approve/execute)', async () => {
  // An action exists in tenant B...
  const bLogin = await login(t.baseUrl, SEED.b.admin.login, SEED.b.admin.password, SEED.b.tenant);
  const created = await api(t.baseUrl, '/api/backoffice/actions', {
    method: 'POST',
    headers: authHeaders(bLogin.token),
    body: JSON.stringify({ title: 'IR01-cross-execute-target' }),
  });
  const otherTenantActionId = (created.body.action as { action_id: string }).action_id;
  const nonexistentActionId = 'action_does_not_exist_xyz';

  const aLogin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const viaOther = await api(t.baseUrl, `/api/backoffice/actions/${otherTenantActionId}/execute`, {
    method: 'POST',
    headers: authHeaders(aLogin.token),
  });
  const viaMissing = await api(t.baseUrl, `/api/backoffice/actions/${nonexistentActionId}/execute`, {
    method: 'POST',
    headers: authHeaders(aLogin.token),
  });
  assert.equal(viaOther.status, 404);
  assert.equal(viaMissing.status, 404);
  assert.deepEqual(viaOther.body, viaMissing.body, 'approve/execute must not reveal existence');
  console.log('TEST_PASS IR-01 anti-oracle actions: other-tenant == nonexistent (status, body)');
});

test('AC-002 negative: actor A executing an action of tenant B is not-found (anti-oracle)', async () => {
  // B creates an action; A tries to execute it (behavior covered by IR-01 too,
  // kept here to correlate the AC-002 scenario with the anti-oracle fix).
  const bLogin = await login(t.baseUrl, SEED.b.admin.login, SEED.b.admin.password, SEED.b.tenant);
  const created = await api(t.baseUrl, '/api/backoffice/actions', {
    method: 'POST',
    headers: authHeaders(bLogin.token),
    body: JSON.stringify({ title: 'AC002-cross-execute-target' }),
  });
  assert.equal(created.status, 201);
  const actionId = (created.body.action as { action_id: string }).action_id;

  const aLogin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const { status, body } = await api(t.baseUrl, `/api/backoffice/actions/${actionId}/execute`, {
    method: 'POST',
    headers: authHeaders(aLogin.token),
  });
  assert.equal(status, 404);
  assert.equal(body.error.code, 'not_found');
  console.log('TEST_PASS AC-002 negative cross-tenant execute -> 404 not_found (anti-oracle)');
});

test('AC-002 negative: actor A writing with forced tenant (body) is denied + audited', async () => {
  const { token } = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const { status, body } = await api(t.baseUrl, '/api/backoffice/data', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ kind: 'client.asset', payload: { name: 'intento' }, tenant_id: SEED.b.tenant }),
  });
  assert.equal(status, 403);
  assert.equal(body.error.code, 'tenant_override_attempt');
  const events = await t.pool.query(
    `SELECT * FROM audit_event WHERE tenant_id = 'client_a' AND result = 'tenant_override_attempt' ORDER BY ts DESC LIMIT 1`,
  );
  assert.ok(events.rows[0], 'tenant override attempt must be audited');
  // No data row may have been created in tenant B by this attempt.
  const bRows = await t.pool.query("SELECT count(*) AS n FROM client_data WHERE tenant_id = 'client_b' AND payload->>'name' = 'intento'");
  assert.equal(Number(bRows.rows[0]?.n ?? 0), 0, 'no cross-tenant write happened');
  console.log('TEST_PASS AC-002 negative forced tenant (body) -> 403 + deny + no write');
});

test('AC-002 negative: forced tenant header (X-Force-Tenant) is denied', async () => {
  const { token } = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const { status, body } = await api(t.baseUrl, '/api/backoffice/data', {
    headers: authHeaders(token, { 'X-Force-Tenant': SEED.b.tenant }),
  });
  assert.equal(status, 403);
  assert.equal(body.error.code, 'tenant_override_attempt');
  console.log('TEST_PASS AC-002 negative forced tenant (header) -> 403');
});

test('AC-002 negative: request without context is denied + audited (fail-closed)', async () => {
  const { status, body } = await api(t.baseUrl, '/api/backoffice/data');
  assert.equal(status, 401);
  assert.ok(body.error.message.length > 0);
  const events = await t.pool.query(
    `SELECT * FROM audit_event WHERE tenant_id = 'unknown' AND action = 'session.resolve' AND result = 'missing_actor' ORDER BY ts DESC LIMIT 1`,
  );
  assert.ok(events.rows[0], 'missing-context denial must be audited');
  console.log('TEST_PASS AC-002 negative no context -> 401 + deny event (tenant unknown)');
});

test('AC-002 unit of enforcement: data layer never runs unscoped queries', async () => {
  const { TenantDataRepository } = await import('../../src/boundary/datasource.ts');
  const repo = new TenantDataRepository(t.pool);
  const brokenSession = {
    session_id: 'sess_broken', user_id: 'user_a_admin', tenant_id: '', role_id: 'administration',
    role_name: 'administration', permissions: [], source: 'test', issued_at: new Date().toISOString(), expires_at: new Date().toISOString(),
  };
  await assert.rejects(() => repo.list(brokenSession), /FAIL-CLOSED/);
  console.log('TEST_PASS AC-002 enforcement: unscoped query fails closed');
});
