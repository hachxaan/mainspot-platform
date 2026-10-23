/**
 * DEC-0005 (TOCTOU) + NFR-0001 (DEC-0014) — cuotas atómicas por tenant.
 *
 * Concurrencia (nunca se supera el límite), idempotencia (la misma clave no
 * consume dos veces y nunca cruza tenants), agotamiento (deny auditado sin
 * reserva), fallos intermedios (la auditoría o la persistencia fallan ⇒ no queda
 * recurso ni consumo) y recuperación (una reserva abandonada vence, deja de
 * contar y la reconciliación la cierra). Cada test usa tenants propios.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApi, authHeaders, api, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows, failAuditFor } from '../helpers/tenants.ts';
import { AuditSink } from '../../src/audit/sink.ts';
import { runAtomic } from '../../src/conversation/state-machine.ts';
import { QuotaLedger, QUOTA_RECONCILER_ACTOR } from '../../src/subscriptions/quota.ts';
import { AppError } from '../../src/shared/errors.ts';

let t: TestApi;

before(async () => {
  t = await bootApi();
});

after(async () => {
  await t.close();
});

const postDraft = (token: string, text: string, key?: string) => api(t.baseUrl, '/api/backoffice/social/posts', {
  method: 'POST', headers: authHeaders(token, key ? { 'Idempotency-Key': key } : {}), body: JSON.stringify({ text }),
});

const sendMessage = (token: string, text: string, key?: string) => api(t.baseUrl, '/api/backoffice/conversation/messages', {
  method: 'POST', headers: authHeaders(token, key ? { 'Idempotency-Key': key } : {}), body: JSON.stringify({ text, channel: 'simulated' }),
});

test('DEC-0005: 10 concurrent drafts against 3 free slots create exactly 3 and consume exactly 3', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { social_posts: 3 });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => postDraft(token, `borrador concurrente ${i}`)));
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 403 && r.body.error.code === 'limit_exceeded'));
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM social_post WHERE tenant_id = $1', [tenant]), 3);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1 AND state = 'committed'`, [tenant]), 3);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'quota.consumed'`, [tenant]), 3);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'access.deny' AND result = 'limit_exceeded'`, [tenant]), 7);
});

test('DEC-0005: concurrent messages reserve before processing and never exceed the conversations limit', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { conversations: 2 });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => sendMessage(token, `¿cuál es el horario de atención? ${i}`)));
  assert.equal(results.filter((r) => r.status === 201).length, 2);
  assert.equal(results.filter((r) => r.status === 403).length, 4);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM conversation_request WHERE tenant_id = $1', [tenant]), 2);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1 AND state = 'reserved'`, [tenant]), 0,
    'no reservation is left behind');
});

test('DEC-0005: the same Idempotency-Key replays the original draft and message without consuming again', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { social_posts: 5, conversations: 5 });
  const first = await postDraft(token, 'borrador con clave', 'draft-key-1');
  const again = await postDraft(token, 'borrador con clave', 'draft-key-1');
  assert.equal(first.status, 201);
  assert.deepEqual([again.status, again.body.replayed, again.body.post.post_id], [200, true, first.body.post.post_id]);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM social_post WHERE tenant_id = $1', [tenant]), 1);

  const sent = await sendMessage(token, '¿cuál es el teléfono de mi negocio?', 'msg-key-1');
  const resent = await sendMessage(token, '¿cuál es el teléfono de mi negocio?', 'msg-key-1');
  assert.equal(sent.status, 201);
  assert.equal(resent.status, 200);
  assert.deepEqual([resent.body.replayed, resent.body.channel_sent, resent.body.request.request_id, resent.body.response],
    [true, false, sent.body.request.request_id, sent.body.response]);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM conversation_request WHERE tenant_id = $1', [tenant]), 1);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'quota.consumed'`, [tenant]), 2);

  const invalid = await postDraft(token, 'clave inválida', 'no válida con espacios');
  assert.deepEqual([invalid.status, invalid.body.error.code], [400, 'validation_error']);
});

test('DEC-0005: concurrent duplicates with one key create a single resource', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { conversations: 5 });
  const results = await Promise.all(Array.from({ length: 4 }, () => sendMessage(token, 'cambia el teléfono a 555-0199', 'dup-key')));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.ok(results.every((r) => [201, 200, 409].includes(r.status)), JSON.stringify(results.map((r) => r.status)));
  assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'request_in_progress'));
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM conversation_request WHERE tenant_id = $1', [tenant]), 1);
});

test('DEC-0005: tenants never share quota, keys or replays', async () => {
  const a = await createTenantWithPlan(t, { social_posts: 1 });
  const b = await createTenantWithPlan(t, { social_posts: 1 });
  const fromA = await postDraft(a.token, 'borrador de A', 'shared-key');
  const fromB = await postDraft(b.token, 'borrador de B', 'shared-key');
  assert.deepEqual([fromA.status, fromB.status], [201, 201], 'same key, independent tenants');
  assert.notEqual(fromA.body.post.post_id, fromB.body.post.post_id);
  assert.equal(fromB.body.post.tenant_id, b.tenant);
  const aFull = await postDraft(a.token, 'otro de A');
  assert.equal(aFull.status, 403, 'A is at its limit');
  const replayB = await postDraft(b.token, 'borrador de B', 'shared-key');
  assert.deepEqual([replayB.status, replayB.body.post.post_id], [200, fromB.body.post.post_id], 'B replays its own draft, never A’s');
});

test('DEC-0005: at the limit the deny is audited and nothing is reserved or created', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { social_posts: 0 });
  const denied = await postDraft(token, 'sin cupo');
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'limit_exceeded']);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1', [tenant]), 0);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM social_post WHERE tenant_id = $1', [tenant]), 0);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'access.deny' AND result = 'limit_exceeded'`, [tenant]), 1);
});

test('NFR-0001: if the consumption cannot be audited, the draft and its quota are rolled back together', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { social_posts: 2 });
  const restore = await failAuditFor(t, tenant, 'quota.consumed');
  try {
    const failed = await postDraft(token, 'no debe quedar');
    assert.deepEqual([failed.status, failed.body.error.code], [500, 'audit_failed']);
    assert.equal(await countRows(t, 'SELECT count(*) AS n FROM social_post WHERE tenant_id = $1', [tenant]), 0, 'no draft without its audit');
    assert.equal(await countRows(t, 'SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1', [tenant]), 0, 'no consumption either');
  } finally {
    await restore();
  }
  assert.equal((await postDraft(token, 'ahora sí')).status, 201, 'capacity intact after the rollback');
});

test('NFR-0001: if the site creation cannot be audited, neither the site nor its quota remain', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { website: 1 });
  const restore = await failAuditFor(t, tenant, 'website.created');
  try {
    const failed = await api(t.baseUrl, '/api/backoffice/website', {
      method: 'POST', headers: authHeaders(token), body: JSON.stringify({ slug: `${tenant.replaceAll('_', '-')}`, site_name: 'Sitio' }),
    });
    assert.equal(failed.status, 500);
    assert.equal(await countRows(t, 'SELECT count(*) AS n FROM client_website WHERE tenant_id = $1', [tenant]), 0);
    assert.equal(await countRows(t, 'SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1', [tenant]), 0);
  } finally {
    await restore();
  }
});

test('DEC-0005: a message that fails after reserving releases its unit (audited) and the next one fits', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { conversations: 1 });
  const restore = await failAuditFor(t, tenant, 'conversation.classified');
  try {
    const failed = await sendMessage(token, '¿cuál es el horario?');
    assert.equal(failed.status, 500);
  } finally {
    await restore();
  }
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1 AND state = 'released'`, [tenant]), 1);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'quota.released'`, [tenant]), 1);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM conversation_request WHERE tenant_id = $1', [tenant]), 0);
  assert.equal((await sendMessage(token, '¿cuál es el horario?')).status, 201, 'the released unit is available again');
});

test('DEC-0005: an abandoned reservation expires, stops counting and is closed by reconciliation', async () => {
  const { tenant } = await createTenantWithPlan(t, { conversations: 1 });
  const ledger = new QuotaLedger({ pool: t.pool, sink: new AuditSink(t.pool) });
  const req = (key: string) => ({
    tenantId: tenant, capability: 'conversations' as const, units: 1, idempotencyKey: key,
    requestId: `req_${key}`, actorId: `user_${tenant}`, actorRole: 'administration',
  });
  const crashed = await ledger.reserve(req('crash-1'));
  assert.equal(crashed.kind, 'reserved');
  await assert.rejects(ledger.reserve(req('while-reserved')), (err: unknown) => err instanceof AppError && err.code === 'limit_exceeded');
  // La caída se simula llevando su vencimiento al pasado según el reloj de la BD (el que usa el ledger).
  await t.pool.query(`UPDATE quota_reservation SET expires_at = clock_timestamp() - interval '1 second' WHERE reservation_id = $1`,
    [crashed.reservation.reservation_id]);
  await assert.rejects(runAtomic(t.pool, (client) => ledger.commitInTx(client, crashed.reservation, 'conversation_request/late', null)),
    (err: unknown) => err instanceof AppError && err.code === 'quota_reservation_expired', 'a late commit cannot consume');
  const report = await ledger.reconcile();
  assert.ok(report.expired.some((e) => e.reservation_id === crashed.reservation.reservation_id));
  const audit = await t.pool.query<{ actor_id: string }>(
    `SELECT actor_id FROM audit_event WHERE tenant_id = $1 AND action = 'quota.expired'`, [tenant]);
  assert.deepEqual(audit.rows.map((r) => r.actor_id), [QUOTA_RECONCILER_ACTOR]);
  const retried = await ledger.reserve(req('crash-1'));
  assert.equal(retried.kind, 'reserved', 'capacity restored and the failed key can be retried');
  await assert.rejects(ledger.reserve(req('after-retry')), (err: unknown) => err instanceof AppError && err.code === 'limit_exceeded',
    'the retried reservation holds the only slot again');
});
