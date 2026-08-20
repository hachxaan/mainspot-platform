/**
 * T-015 — Evidence hooks for INC-002 (integration with a stub consumer).
 * Proves a future consumer can resolve identity, check authorization and sink
 * audit events using INC-001 foundations WITHOUT changing INC-001.
 * No INC-002 consumer is implemented here (out of scope).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AuditSink } from '../../src/audit/sink.ts';
import { buildInc001Hooks } from '../../src/hooks/contracts.ts';
import { bootApi, login, SEED, TEST_CONFIG, type TestApi } from '../helpers/testdb.ts';

let t: TestApi;

before(async () => {
  t = await bootApi();
});

after(async () => {
  await t.close();
});

test('T-015 hook: resolve_identity resolves user + tenant + role from a session header', async () => {
  const { token } = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const hooks = buildInc001Hooks({ pool: t.pool, jwtSecret: TEST_CONFIG.jwtSecret, sink: new AuditSink(t.pool) });
  const identity = await hooks.identity.resolveIdentity(`Bearer ${token}`);
  assert.ok(identity, 'identity must resolve');
  assert.equal(identity.user_id, 'user_a_ops');
  assert.equal(identity.tenant_id, 'client_a');
  assert.equal(identity.role_id, 'operation');
  assert.ok(identity.permissions.includes('data.write'));
  console.log('TEST_PASS T-015 resolve_identity hook works for a real session');
});

test('T-015 hook: check_authorization returns matrix truth + fail-closed deny', async () => {
  const hooks = buildInc001Hooks({ pool: t.pool, jwtSecret: TEST_CONFIG.jwtSecret, sink: new AuditSink(t.pool) });
  assert.equal(hooks.authorization.checkAuthorization({ role_id: 'administration' }, 'client_a', 'user.manage', '*').allowed, true);
  assert.equal(hooks.authorization.checkAuthorization({ role_id: 'operation' }, 'client_a', 'user.manage', '*').allowed, false);
  assert.equal(hooks.authorization.checkAuthorization({ role_id: 'read_only' }, 'client_a', 'data.read', '*').allowed, true);
  assert.equal(hooks.authorization.checkAuthorization({ role_id: 'read_only' }, 'client_a', 'operation.execute', '*').allowed, false);
  console.log('TEST_PASS T-015 check_authorization hook truth + fail-closed');
});

test('T-015 hook: audit_sink persists events with correlation (reusable taxonomy)', async () => {
  const hooks = buildInc001Hooks({ pool: t.pool, jwtSecret: TEST_CONFIG.jwtSecret, sink: new AuditSink(t.pool) });
  const requestId = `req_hook_${Date.now()}`;
  const row = await hooks.audit.auditSink({
    tenant_id: 'client_b',
    actor_id: 'user_b_admin',
    actor_role: 'administration',
    action: 'received', // INC-002 taxonomy example (FLOW-001)
    resource: 'channel:simulated',
    request_id: requestId,
    decision: 'allow',
    result: 'success',
  });
  assert.ok(row.event_id.startsWith('evt_'));
  const events = await hooks.audit.eventsForRequest('client_b', requestId);
  assert.ok(events.length >= 1);
  assert.equal(events[0]?.result, 'success');
  console.log('TEST_PASS T-015 audit_sink hook persists correlated events (stub consumer OK)');
});
