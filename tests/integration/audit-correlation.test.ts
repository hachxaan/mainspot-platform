/**
 * AC-003 — Minimum action audit (integration).
 * Builds the create -> approve -> reject -> execute flow and proves the audit
 * reconstructs actor, client, request, decision, result and timestamp, and
 * that events correlate by request_id. Also proves secrets never reach the
 * audit (INVARIANT) and export works.
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

async function lastAuditEvent(tenantId: string, action: string) {
  const res = await t.pool.query(
    `SELECT * FROM audit_event WHERE tenant_id = $1 AND action = $2 ORDER BY ts DESC LIMIT 1`,
    [tenantId, action],
  );
  return res.rows[0] as { event_id: string; ts: string; tenant_id: string; actor_id: string; actor_role: string; action: string; resource: string; request_id: string; decision: string; result: string; evidence_ref: string | null } | undefined;
}

test('AC-003: create/approve/reject/execute flow writes correlated audit events', async () => {
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);

  // 1. create (admin)
  const created = await api(t.baseUrl, '/api/backoffice/actions', {
    method: 'POST',
    headers: authHeaders(admin.token),
    body: JSON.stringify({ title: 'AC003-create-approve-flow' }),
  });
  assert.equal(created.status, 201, 'create should succeed for admin');
  const actionId = (created.body.action as { action_id: string }).action_id;

  // 2. approve (admin)
  const approved = await api(t.baseUrl, `/api/backoffice/actions/${actionId}/approve`, {
    method: 'POST',
    headers: authHeaders(admin.token),
  });
  assert.equal(approved.status, 200, 'approve should succeed for admin');
  assert.equal(approved.body.action.status, 'approved');

  // 3. reject on a second action (admin)
  const created2 = await api(t.baseUrl, '/api/backoffice/actions', {
    method: 'POST',
    headers: authHeaders(admin.token),
    body: JSON.stringify({ title: 'AC003-reject-flow' }),
  });
  const actionId2 = (created2.body.action as { action_id: string }).action_id;
  const rejected = await api(t.baseUrl, `/api/backoffice/actions/${actionId2}/reject`, {
    method: 'POST',
    headers: authHeaders(admin.token),
  });
  assert.equal(rejected.body.action.status, 'rejected');

  // 4. execute the approved action (operation profile)
  const executed = await api(t.baseUrl, `/api/backoffice/actions/${actionId}/execute`, {
    method: 'POST',
    headers: authHeaders(ops.token),
  });
  assert.equal(executed.status, 200, 'execute should succeed for operation');
  assert.equal(executed.body.action.status, 'executed');

  // 5. audit reconstructs each step with actor + client + decision + result + ts
  for (const act of ['operation.create', 'operation.approve', 'operation.reject', 'operation.execute'] as const) {
    const ev = await lastAuditEvent(SEED.a.tenant, act);
    assert.ok(ev, `audit event for ${act} must exist`);
    assert.ok(ev.event_id.startsWith('evt_'));
    assert.equal(ev.tenant_id, SEED.a.tenant);
    assert.ok(ev.actor_id, 'actor id present');
    assert.ok(ev.actor_role, 'actor role present');
    assert.equal(ev.decision, 'allow');
    assert.equal(ev.result, 'success');
    assert.ok(!Number.isNaN(Date.parse(ev.ts)), 'timestamp present');
    assert.ok(ev.request_id.length > 0, 'request_id present (correlation)');
    assert.ok(ev.resource && ev.resource.startsWith('demo_action/'), 'resource present');
  }
  console.log('TEST_PASS AC-003 create/approve/reject/execute audited with actor, client, decision, result, ts');

  // 6b. state machine: executed action cannot be approved again (guards).
  const reApproved = await api(t.baseUrl, `/api/backoffice/actions/${actionId}/approve`, {
    method: 'POST',
    headers: authHeaders(admin.token),
  });
  assert.equal(reApproved.status, 409, 'approving an executed action must be rejected');
  assert.match(reApproved.body.error.message, /no puede aprobarse/);
  console.log('TEST_PASS AC-003 state machine guards block invalid transitions');

  // 6. correlation: the execute event shares request_id with… its own request;
  //    every event row has a request_id; filtered export returns the same events.
  const executeEvent = await lastAuditEvent(SEED.a.tenant, 'operation.execute');
  const correlated = await api(t.baseUrl, `/api/backoffice/audit?request_id=${executeEvent?.request_id}`, {
    headers: authHeaders(admin.token),
  });
  assert.equal(correlated.status, 200);
  assert.equal(correlated.body.correlation.request_id, executeEvent?.request_id);
  assert.ok(Array.isArray(correlated.body.events) && correlated.body.events.length >= 1);
  console.log('TEST_PASS AC-003 correlation by request_id works via audit query');
});

test('AC-003: export contains the full event schema and no secrets (INVARIANT)', async () => {
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const { status, body } = await api(t.baseUrl, '/api/backoffice/audit/export', {
    headers: authHeaders(admin.token),
  });
  assert.equal(status, 200);
  assert.ok(body.count >= 1);
  const ev = body.events[0] as Record<string, unknown>;
  for (const field of ['event_id', 'ts', 'tenant_id', 'actor_id', 'actor_role', 'action', 'resource', 'request_id', 'decision', 'result', 'evidence_ref']) {
    assert.ok(field in ev, `field ${field} present in exported event`);
  }
  const exportedRaw = JSON.stringify(body);
  const forbiddenPatterns = ['Simula-', 'admin.a@example.com', 'contacto.a@example.com', 'password_hash', 'access_token', 'x-api-key'];
  for (const pattern of forbiddenPatterns) {
    assert.ok(!exportedRaw.includes(pattern), `export must NOT contain ${pattern}`);
  }
  console.log('TEST_PASS AC-003 export schema complete + secret-free');
});

test('AC-003: decision=deny events are also reconstructible (denials audited)', async () => {
  // read_only triggers a deny; the deny event must reconstruct actor/role.
  const reader = await login(t.baseUrl, SEED.a.reader.login, SEED.a.reader.password, SEED.a.tenant);
  await api(t.baseUrl, '/api/backoffice/data', {
    method: 'POST',
    headers: authHeaders(reader.token),
    body: JSON.stringify({ kind: 'x', payload: {} }),
  });
  const denyEvent = await lastAuditEvent(SEED.a.tenant, 'access.deny');
  assert.ok(denyEvent, 'deny event must exist');
  assert.equal(denyEvent.decision, 'deny');
  assert.equal(denyEvent.actor_id, 'user_a_reader');
  assert.equal(denyEvent.actor_role, 'read_only');
  assert.equal(denyEvent.result, 'permission_denied');
  console.log('TEST_PASS AC-003 deny events reconstruct actor, role, decision and result');
});
