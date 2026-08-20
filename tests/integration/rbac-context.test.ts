/**
 * AC-001 — Roles and context of backoffice (integration).
 * Each profile (administration / operation / read_only) sees only authorized
 * actions; denials are controlled and audited with the actor role.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApi, login, authHeaders, api, SEED, type TestApi } from '../helpers/testdb.ts';
import { MATRIX, ACTIONS, toMatrixEntries } from '../../src/rbac/matrix.ts';

let t: TestApi;

before(async () => {
  t = await bootApi();
});

after(async () => {
  await t.close();
});

async function latestDeny(tenantId: string, actorId: string, resourcePrefix: string) {
  const res = await t.pool.query(
    `SELECT * FROM audit_event WHERE tenant_id = $1 AND actor_id = $2 AND action = 'access.deny'
     AND resource LIKE $3 ORDER BY ts DESC LIMIT 1`,
    [tenantId, actorId, `${resourcePrefix}%`],
  );
  return res.rows[0] as Record<string, unknown> | undefined;
}

test('AC-001: administration profile can use all backoffice actions', async () => {
  const { token } = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const me = await api(t.baseUrl, '/api/backoffice/me', { headers: authHeaders(token) });
  assert.equal(me.status, 200);
  assert.equal(me.body.session.role_id, 'administration');
  assert.deepEqual([...me.body.session.permissions].sort(), [...MATRIX.administration].sort());

  const u = { status: 200 } as const;
  const list = await api(t.baseUrl, '/api/backoffice/users', { headers: authHeaders(token) });
  assert.equal(list.status, u.status);
  const audit = await api(t.baseUrl, '/api/backoffice/audit', { headers: authHeaders(token) });
  assert.equal(audit.status, 200);
  const data = await api(t.baseUrl, '/api/backoffice/data', { headers: authHeaders(token) });
  assert.equal(data.status, 200);
  const actionsList = await api(t.baseUrl, '/api/backoffice/actions', { headers: authHeaders(token) });
  assert.equal(actionsList.status, 200, 'admin can list own tenant demo actions');
  assert.ok(Array.isArray(actionsList.body.actions));
  console.log('TEST_PASS AC-001 administration has full authorized access');
});

test('AC-001: operation profile CAN write data and create actions but CANNOT manage users/audit', async () => {
  const { token } = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const me = await api(t.baseUrl, '/api/backoffice/me', { headers: authHeaders(token) });
  assert.equal(me.body.session.role_id, 'operation');
  assert.deepEqual([...me.body.session.permissions].sort(), [...MATRIX.operation].sort());

  const write = await api(t.baseUrl, '/api/backoffice/data', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ kind: 'client.asset', payload: { name: 'AC001-ops-write' } }),
  });
  assert.equal(write.status, 201);

  const createAction = await api(t.baseUrl, '/api/backoffice/actions', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ title: 'AC001-ops-create' }),
  });
  assert.equal(createAction.status, 201);

  const usersDeny = await api(t.baseUrl, '/api/backoffice/users', { headers: authHeaders(token) });
  assert.equal(usersDeny.status, 403);
  const ev = await latestDeny(SEED.a.tenant, 'user_a_ops', '/api/backoffice/users');
  assert.ok(ev, 'operation users denial must be audited');
  assert.equal(ev.decision, 'deny');
  assert.equal(ev.actor_role, 'operation');

  const auditDeny = await api(t.baseUrl, '/api/backoffice/audit', { headers: authHeaders(token) });
  assert.equal(auditDeny.status, 403);
  console.log('TEST_PASS AC-001 operation: allowed writes, denied users/audit (audited with actor_role)');
});

test('AC-001: read_only profile can read but every mutation is denied + audited', async () => {
  const { token } = await login(t.baseUrl, SEED.a.reader.login, SEED.a.reader.password, SEED.a.tenant);
  const me = await api(t.baseUrl, '/api/backoffice/me', { headers: authHeaders(token) });
  assert.equal(me.body.session.role_id, 'read_only');
  assert.deepEqual([...me.body.session.permissions].sort(), [...MATRIX.read_only].sort());

  const read = await api(t.baseUrl, '/api/backoffice/data', { headers: authHeaders(token) });
  assert.equal(read.status, 200);

  const write = await api(t.baseUrl, '/api/backoffice/data', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ kind: 'client.asset', payload: { name: 'AC001-reader-attempt' } }),
  });
  assert.equal(write.status, 403);
  const evWrite = await latestDeny(SEED.a.tenant, 'user_a_reader', '/api/backoffice/data');
  assert.ok(evWrite && evWrite.result === 'permission_denied');

  const usersDeny = await api(t.baseUrl, '/api/backoffice/users', { headers: authHeaders(token) });
  assert.equal(usersDeny.status, 403);

  const exportDeny = await api(t.baseUrl, '/api/backoffice/audit/export', { headers: authHeaders(token) });
  assert.equal(exportDeny.status, 403);

  const actionsDeny = await api(t.baseUrl, '/api/backoffice/actions', { headers: authHeaders(token) });
  assert.equal(actionsDeny.status, 403, 'read_only cannot list demo actions');
  console.log('TEST_PASS AC-001 read_only: reads allowed, all mutations denied + audited');
});

test('AC-001: denied responses use plain language (AC-008) and never leak data', async () => {
  const { token } = await login(t.baseUrl, SEED.a.reader.login, SEED.a.reader.password, SEED.a.tenant);
  const { status, body } = await api(t.baseUrl, '/api/backoffice/data', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ kind: 'client.asset', payload: { x: 1 } }),
  });
  assert.equal(status, 403);
  assert.ok(body.error.message && typeof body.error.message === 'string');
  // The reader must not see audit events or users (no payload leak).
  assert.ok(!JSON.stringify(body).includes('password_hash'));
  console.log('TEST_PASS AC-001/AC-008 denial is plain-language and leak-free');
});

test('AC-001: DB permission mirror matches the code matrix (governance)', async () => {
  const { RbacRepository } = await import('../../src/rbac/repository.ts');
  const res = await t.pool.query<{ role_id: string; action: string }>(
    `SELECT rp.role_id, p.action FROM role_permission rp JOIN permission p ON p.permission_id = rp.permission_id`,
  );
  const dbEntries = res.rows.map((r) => `${r.role_id}:${r.action}`).sort();
  const codeEntries = toMatrixEntries().map((e) => `${e.role}:${e.action}`).sort();
  // 1) the SEED alone must already equal the code matrix (catches seed drift).
  assert.deepEqual(dbEntries, codeEntries, 'seed DB mirror must equal code matrix WITHOUT syncing');
  // 2) syncMatrix() is idempotent (no-op when already in sync).
  const rbac = new RbacRepository(t.pool);
  await rbac.syncMatrix();
  const after = await t.pool.query<{ role_id: string; action: string }>(
    `SELECT rp.role_id, p.action FROM role_permission rp JOIN permission p ON p.permission_id = rp.permission_id`,
  );
  assert.equal(after.rowCount ?? 0, dbEntries.length, 'sync must not duplicate rows');
  // approval verbs are admin-only (design decision, TENTATIVA)
  const adminApprove = await t.pool.query(
    "SELECT 1 FROM role_permission rp WHERE rp.role_id = 'operation' AND rp.permission_id IN ('operation.approve','operation.reject')",
  );
  assert.equal(adminApprove.rowCount ?? 0, 0, 'operation must not approve/reject');
  console.log(`TEST_PASS AC-001 governance: seed DB mirror == code matrix (${dbEntries.length} entries, no sync needed)`);
});
