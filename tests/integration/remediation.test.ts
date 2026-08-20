/**
 * Remediation-focused integration tests:
 *  - IR-03/IR-05/IR-07: duplicate login → 409, no login in audit_event,
 *    generic 'deny/failed' trace (no raw PG message).
 *  - IR-06: login rate limiting (429, Retry-After).
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

test('IR-03/IR-05/IR-07: duplicate login -> 409, clear message, login never in audit', async () => {
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const duplicateLogin = 'admin.a@example.com'; // already exists for client_a (seed)

  const { status, body } = await api(t.baseUrl, '/api/backoffice/users', {
    method: 'POST',
    headers: authHeaders(admin.token),
    body: JSON.stringify({ display_name: 'Duplicado', login: duplicateLogin, password: 'Segura-12345', role: 'operation' }),
  });
  assert.equal(status, 409, 'duplicate login must NOT be a 500');
  assert.equal(body.error.code, 'duplicate_login');
  assert.ok(!/duplicate key|unique constraint|pg|postgres|internal_user/.test(JSON.stringify(body)), 'no internal details leaked');
  assert.ok(!JSON.stringify(body).includes(duplicateLogin), 'login not echoed in the response');

  // The audit trail must not contain the login value in user.manage events, and
  // the failure trace must be generic (deny/failed), never the raw PG message.
  const events = await t.pool.query(
    `SELECT resource, decision, result FROM audit_event
      WHERE tenant_id = $1 AND action = 'user.manage'
      ORDER BY ts DESC LIMIT 4`,
    [SEED.a.tenant],
  );
  const raw = JSON.stringify(events.rows);
  assert.ok(!raw.includes(duplicateLogin), 'login must NOT appear in user.manage audit events');
  assert.ok(!/duplicate key value|unique constraint|SQL state|internal_user/.test(raw), 'no raw DB internals in audit');
  const hasGenericFailure = events.rows.some(
    (r: { decision: string; result: string }) => r.decision === 'deny' && r.result === 'failed',
  );
  const hasDuplicateMarker = events.rows.some(
    (r: { decision: string; result: string }) => r.decision === 'deny' && r.result === 'duplicate_login',
  );
  assert.ok(hasGenericFailure || hasDuplicateMarker, 'failure must leave deny trace (generic failed or duplicate_login)');
  console.log('TEST_PASS IR-03/IR-05/IR-07 duplicate login -> 409, no login/raw internals in audit, deny trace present');
});

test('IR-05: same login in a DIFFERENT tenant is allowed (compound unique per tenant)', async () => {
  const adminB = await login(t.baseUrl, SEED.b.admin.login, SEED.b.admin.password, SEED.b.tenant);
  const { status, body } = await api(t.baseUrl, '/api/backoffice/users', {
    method: 'POST',
    headers: authHeaders(adminB.token),
    body: JSON.stringify({ display_name: 'Mismo acceso otro cliente', login: 'ops.a@example.com', password: 'Segura-12345', role: 'read_only' }),
  });
  assert.equal(status, 201, 'same login in another tenant must be allowed');
  console.log('TEST_PASS IR-05 compound unique: same login OK in another tenant');
});

test('IR-06: repeated failed logins are rate-limited with Retry-After', async () => {
  const ipLogin = `rate.limited.${Date.now()}@example.com`;
  const tenant = SEED.b.tenant;
  for (let i = 0; i < 5; i += 1) {
    const attempt = await api(t.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: ipLogin, password: 'WrongPass-1', tenant_id: tenant }),
    });
    assert.equal(attempt.status, 401, `attempt ${i + 1} should be invalid_credentials`);
  }
  const blocked = await fetch(`${t.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: ipLogin, password: 'WrongPass-1', tenant_id: tenant }),
  });
  assert.equal(blocked.status, 429, 'sixth attempt must be rate-limited');
  const retryAfter = blocked.headers.get('retry-after');
  assert.ok(retryAfter && Number(retryAfter) >= 1, 'Retry-After header present');
  const data = (await blocked.json()) as { error?: { code?: string; message?: string } };
  assert.equal(data.error?.code, 'too_many_attempts');
  assert.ok(data.error?.message && !/ip|regex|internal/.test(data.error.message), 'plain-language message');
  console.log('TEST_PASS IR-06 login rate limit -> 429 + Retry-After, plain message');
});
