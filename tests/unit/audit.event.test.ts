import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoSecrets, normalizeEvent, newEventId, SENSITIVE_ACTIONS } from '../../src/audit/event.ts';

test('AC-003 unit: normalizeEvent fills event_id/ts/created_by_system and keeps all contract fields', () => {
  const row = normalizeEvent({
    tenant_id: 'client_a',
    actor_id: 'user_a_admin',
    actor_role: 'administration',
    action: 'operation.execute',
    resource: 'demo_action/abc',
    request_id: 'req-1',
    decision: 'allow',
    result: 'success',
    evidence_ref: 'run/2026-08-20/smoke-001',
  });
  assert.match(row.event_id, /^evt_/);
  assert.ok(!Number.isNaN(Date.parse(row.ts)));
  assert.equal(row.created_by_system, 'mainspot-backoffice-api');
  assert.equal(row.tenant_id, 'client_a');
  assert.equal(row.actor_id, 'user_a_admin');
  assert.equal(row.actor_role, 'administration');
  assert.equal(row.decision, 'allow');
  assert.equal(row.result, 'success');
  assert.equal(row.resource, 'demo_action/abc');
  assert.equal(row.request_id, 'req-1');
});

test('AC-003 unit: required fields enforced', () => {
  assert.throws(() => normalizeEvent({ tenant_id: '', actor_id: 'u1', request_id: 'r', action: 'a', decision: 'allow', result: 'success' }));
  assert.throws(() => normalizeEvent({ tenant_id: 't', actor_id: '', request_id: 'r', action: 'a', decision: 'allow', result: 'success' }));
  assert.throws(() => normalizeEvent({ tenant_id: 't', actor_id: 'u1', request_id: '', action: 'a', decision: 'allow', result: 'success' }));
  assert.throws(() => normalizeEvent({ tenant_id: 't', actor_id: 'u1', request_id: 'r', action: '', decision: 'allow', result: 'success' }));
});

test('AC-003 unit: decision is allow|deny only', () => {
  assert.throws(() => normalizeEvent({
    tenant_id: 't', actor_id: 'u1', request_id: 'r', action: 'a',
    decision: 'maybe' as never, result: 'x',
  }));
});

test('INVARIANT unit: audit never accepts secret-like fields', () => {
  assert.throws(() => assertNoSecrets({ password: 'x' }));
  assert.throws(() => assertNoSecrets({ access_token: 'x' }));
  assert.throws(() => assertNoSecrets({ api_key: 'x' }));
  assert.throws(() => assertNoSecrets({ credentials: 'x' }));
  const withSecret = {
    tenant_id: 't', actor_id: 'u1', request_id: 'r', action: 'a', decision: 'allow' as const, result: 'x',
    client_secret: 'topsecret',
  } as unknown as Parameters<typeof normalizeEvent>[0];
  assert.throws(() => normalizeEvent(withSecret), /Refusing to audit field/);
});

test('AC-003 unit: sensitive action set contains write/approve/execute verbs', () => {
  for (const a of ['user.manage', 'client.config.manage', 'operation.execute', 'operation.approve', 'operation.reject', 'data.write']) {
    assert.equal(SENSITIVE_ACTIONS.has(a), true, `${a} should be sensitive`);
  }
});

test('unit: newEventId unique', () => {
  const a = newEventId();
  const b = newEventId();
  assert.notEqual(a, b);
});
