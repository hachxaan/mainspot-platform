/**
 * NFR-0001 (DEC-0014): every sensitive local transition and its audit event
 * commit in ONE transaction. Each test injects an audit failure (BEFORE INSERT
 * trigger on audit_event for one action + one fresh tenant) and asserts that
 * the effect was rolled back.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApi, authHeaders, api, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows, failAuditFor } from '../helpers/tenants.ts';

let t: TestApi;

before(async () => {
  t = await bootApi();
});

after(async () => {
  await t.close();
});

async function one<T>(sql: string, params: unknown[]): Promise<T> {
  const res = await t.pool.query(sql, params);
  return res.rows[0] as T;
}

const post = (token: string, path: string, body: unknown = {}) => api(t.baseUrl, `/api/backoffice${path}`, {
  method: 'POST', headers: authHeaders(token), body: JSON.stringify(body),
});

async function draft(token: string): Promise<string> {
  const created = await post(token, '/social/posts', { text: 'Borrador para NFR-0001' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.post.post_id as string;
}

async function seedReview(tenant: string, state: string, responseText: string | null = 'Gracias por tu opinión.'): Promise<string> {
  const reviewId = `rev_${randomUUID()}`;
  await t.pool.query(
    `INSERT INTO review (review_id, tenant_id, source, source_review_id, author_name, star_rating, review_text, classification, state, suggested_options, response_text)
     VALUES ($1, $2, 'google', $3, 'Ana', 2, 'No me gustó', 'negative', $4, '[]', $5)`,
    [reviewId, tenant, `src_${reviewId}`, state, responseText]);
  return reviewId;
}

async function reviewState(reviewId: string): Promise<{ state: string; response_text: string | null; proposal_id: string | null }> {
  return one('SELECT state, response_text, proposal_id FROM review WHERE review_id = $1', [reviewId]);
}

test('NFR-0001: social schedule is rolled back when its audit cannot be written', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { social_posts: 10 });
  const postId = await draft(token);
  const restore = await failAuditFor(t, tenant, 'social.scheduled');
  try {
    const res = await post(token, `/social/posts/${postId}/schedule`, { publish_at: new Date(Date.now() + 86_400_000).toISOString() });
    assert.equal(res.status, 500);
  } finally { await restore(); }
  const row = await one<{ status: string; scheduled_at: string | null }>('SELECT status, scheduled_at FROM social_post WHERE post_id = $1', [postId]);
  assert.deepEqual([row.status, row.scheduled_at], ['draft', null]);
});

test('NFR-0001: social approve leaves no proposal and no state change when its audit fails', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { social_posts: 10 });
  const postId = await draft(token);
  const restore = await failAuditFor(t, tenant, 'social.approved');
  try {
    const res = await post(token, `/social/posts/${postId}/approve`);
    assert.equal(res.status, 500);
  } finally { await restore(); }
  const row = await one<{ status: string; proposal_id: string | null }>('SELECT status, proposal_id FROM social_post WHERE post_id = $1', [postId]);
  assert.deepEqual([row.status, row.proposal_id], ['draft', null]);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM action_proposal WHERE tenant_id = $1`, [tenant]), 0);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM conversation_request WHERE tenant_id = $1`, [tenant]), 0);
});

test('NFR-0001: social reject is rolled back when its audit cannot be written', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { social_posts: 10 });
  const postId = await draft(token);
  const restore = await failAuditFor(t, tenant, 'social.rejected');
  try {
    const res = await post(token, `/social/posts/${postId}/reject`);
    assert.equal(res.status, 500);
  } finally { await restore(); }
  assert.equal((await one<{ status: string }>('SELECT status FROM social_post WHERE post_id = $1', [postId])).status, 'draft');
});

test('NFR-0001: the scheduler does not block a queue row whose deny cannot be audited', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { social_posts: 10 });
  const postId = await draft(token);
  const scheduledId = `sp_${randomUUID()}`;
  await t.pool.query(
    `INSERT INTO scheduled_post (scheduled_post_id, tenant_id, post_id, proposal_id, publish_at, status, created_at)
     VALUES ($1, $2, $3, NULL, now() - interval '1 minute', 'scheduled', now())`,
    [scheduledId, tenant, postId]);
  const restore = await failAuditFor(t, tenant, 'social.published');
  try {
    const res = await post(token, '/social/process-due');
    assert.equal(res.status, 500);
  } finally { await restore(); }
  assert.equal((await one<{ status: string }>('SELECT status FROM scheduled_post WHERE scheduled_post_id = $1', [scheduledId])).status, 'scheduled');
});

test('NFR-0001: reputation escalate is rolled back when its audit cannot be written', async () => {
  const { tenant, token } = await createTenantWithPlan(t, {});
  const reviewId = await seedReview(tenant, 'suggested');
  const restore = await failAuditFor(t, tenant, 'reputation.escalated');
  try {
    assert.equal((await post(token, `/reputation/reviews/${reviewId}/escalate`)).status, 500);
  } finally { await restore(); }
  assert.equal((await reviewState(reviewId)).state, 'suggested');
});

test('NFR-0001: reputation response edit is rolled back when its audit cannot be written', async () => {
  const { tenant, token } = await createTenantWithPlan(t, {});
  const reviewId = await seedReview(tenant, 'suggested', 'Texto original');
  const restore = await failAuditFor(t, tenant, 'reputation.response.edited');
  try {
    assert.equal((await post(token, `/reputation/reviews/${reviewId}/response`, { text: 'Texto nuevo' })).status, 500);
  } finally { await restore(); }
  const row = await reviewState(reviewId);
  assert.deepEqual([row.state, row.response_text], ['suggested', 'Texto original']);
});

test('NFR-0001: reputation approve leaves no proposal and no state change when its audit fails', async () => {
  const { tenant, token } = await createTenantWithPlan(t, {});
  const reviewId = await seedReview(tenant, 'awaiting_human');
  const restore = await failAuditFor(t, tenant, 'reputation.approved');
  try {
    assert.equal((await post(token, `/reputation/reviews/${reviewId}/approve`)).status, 500);
  } finally { await restore(); }
  const row = await reviewState(reviewId);
  assert.deepEqual([row.state, row.proposal_id], ['awaiting_human', null]);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM action_proposal WHERE tenant_id = $1`, [tenant]), 0);
});

test('NFR-0001: reputation reject is rolled back when its audit cannot be written', async () => {
  const { tenant, token } = await createTenantWithPlan(t, {});
  const reviewId = await seedReview(tenant, 'awaiting_human');
  const restore = await failAuditFor(t, tenant, 'reputation.rejected');
  try {
    assert.equal((await post(token, `/reputation/reviews/${reviewId}/reject`)).status, 500);
  } finally { await restore(); }
  assert.equal((await reviewState(reviewId)).state, 'awaiting_human');
});

test('NFR-0001: user creation (user.manage) is rolled back when its audit cannot be written', async () => {
  const { tenant, token } = await createTenantWithPlan(t, {});
  const login = `nuevo@${tenant}.example.com`;
  const restore = await failAuditFor(t, tenant, 'user.manage');
  try {
    const res = await post(token, '/users', { display_name: 'Nuevo', login, password: 'test-password', role: 'operation' });
    assert.deepEqual([res.status, res.body.error?.code], [500, 'audit_failed']);
  } finally { await restore(); }
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM internal_user WHERE login = $1 AND tenant_id = $2', [login, tenant]), 0);
});

test('NFR-0001: plan assignment (subscription.assigned) is rolled back when its audit cannot be written', async () => {
  const { tenant, token, plan } = await createTenantWithPlan(t, {});
  const otherPlan = `plan_other_${tenant}`;
  await t.pool.query(`INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active) VALUES ($1, $1, 'test', NULL, NULL, false, true)`, [otherPlan]);
  const restore = await failAuditFor(t, tenant, 'subscription.assigned');
  try {
    const res = await post(token, '/subscriptions/assign', { plan_id: otherPlan });
    assert.deepEqual([res.status, res.body.error?.code], [500, 'audit_failed']);
  } finally { await restore(); }
  const subs = await t.pool.query<{ plan_id: string; status: string }>('SELECT plan_id, status FROM subscription WHERE tenant_id = $1', [tenant]);
  assert.deepEqual(subs.rows.map((r) => [r.plan_id, r.status]), [[plan, 'active']]);
});
