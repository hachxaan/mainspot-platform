/** DEV-E2E-04: Graph API FALSO inyectado; scheduler/claims usan PostgreSQL real. No Meta REAL_VERIFIED. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { bootApi, login, api, authHeaders, type TestApi } from '../helpers/testdb.ts';
import { OnboardingService } from '../../src/identity/onboarding.ts';
import { MetaGraphClient, MetaPagesAdapter, META_PROVIDER, REQUIRED_PAGE_SCOPES } from '../../src/social/meta-graph.ts';
import { MetaCommentReplier, MetaCommentSource } from '../../src/social/meta-engagement.ts';
import { SocialScheduler } from '../../src/social/scheduler.ts';
import { SocialPublisher } from '../../src/social/publisher.ts';
import { type SocialProvider } from '../../src/social/provider.ts';

let t: TestApi;
let token: string;
let tenant: string;
let meta: MetaPagesAdapter;
let writes = 0;
let replies = 0;
let rate = 0;
let readback = true;
let delayed = false;
let ownReply: { id: string; message: string; from: { id: string } } | null = null;
const published = new Map<string, string>();
const requests: string[] = [];
const json = (data: unknown, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const fake: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
  const resource = url.pathname.replace(/^\/v26\.0\//, '');
  const method = init?.method ?? 'GET';
  requests.push(`${method} ${resource}`);
  const form = new URLSearchParams(String(init?.body ?? ''));
  if (rate) return json({ error: { code: rate, type: 'OAuthException' } }, rate === 190 ? 400 : 429, { 'Retry-After': '30' });
  if (resource === 'debug_token') return json({ data: { is_valid: true, scopes: [...REQUIRED_PAGE_SCOPES], type: 'PAGE' } });
  if (resource === '123') return json({ id: '123', name: 'Page autorizada falsa' });
  if (resource === '123/feed' && method === 'POST') {
    writes += 1;
    if (delayed) throw new DOMException('timeout fake', 'TimeoutError');
    const id = `123_${writes}`;
    published.set(id, form.get('message') ?? '');
    return json({ id });
  }
  if (resource === '123/feed') return json({ data: [...published].map(([id, message]) => ({ id, message, created_time: new Date().toISOString() })) });
  if (resource === '123_999/comments' && method === 'POST') {
    replies += 1;
    await new Promise((r) => setTimeout(r, 30));
    ownReply = { id: '123_1000', message: form.get('message')!, from: { id: '123' } };
    return json({ id: ownReply.id });
  }
  if (resource === '123_999/comments') return json({ data: ownReply ? [ownReply] : [] });
  if (resource === '123_1000') return json(ownReply);
  if (resource.endsWith('/comments')) return json({ data: [{ id: '123_999', message: 'Gracias', from: { id: '789', name: 'Cliente' }, created_time: '2026-10-29T10:00:00Z' }] });
  if (published.has(resource)) return readback ? json({ id: resource, message: published.get(resource) }) : json({ error: { code: 2 } }, 503);
  throw new Error(`Graph fake unexpected: ${method} ${resource}`);
};

before(async () => {
  t = await bootApi({ connectorTokenKey: randomBytes(32).toString('base64') });
  const owner = await new OnboardingService({ pool: t.pool, sink: t.handle.sink }).createBusinessWithInvitation({ businessName: 'Scheduler Sol', ownerEmail: 'scheduler-sol@example.test', createdBy: 'operator:test' });
  tenant = owner.tenant_id;
  await api(t.baseUrl, '/api/auth/invitation/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: owner.token, display_name: 'Scheduler', password: 'Scheduler-Sol-2026' }) });
  token = (await login(t.baseUrl, 'scheduler-sol@example.test', 'Scheduler-Sol-2026', tenant)).token;
  meta = new MetaPagesAdapter({ client: new MetaGraphClient({ baseUrl: 'https://graph.fake.test', version: 'v26.0', fetchImpl: fake }), connections: t.handle.connections, appId: 'fake-id', appSecret: 'fake-secret' });
  await t.handle.connections.save({ tenantId: tenant, provider: META_PROVIDER, status: 'connected', externalResourceId: '123', externalResourceName: 'Fake Page', tokens: { page_token: 'fake-page-token' } });
});
after(async () => { await t.close(); });
async function post(path: string, body?: unknown) {
  return api(t.baseUrl, '/api/backoffice' + path, { method: 'POST', headers: authHeaders(token, { 'Idempotency-Key': randomUUID() }), body: body === undefined ? undefined : JSON.stringify(body) });
}
async function approvedPost(text: string) {
  const created = await post('/social/posts', { text });
  assert.equal(created.status, 201);
  const id = created.body.post.post_id as string;
  const schedule = await post(`/social/posts/${id}/schedule`, { publish_at: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(schedule.status, 200);
  const p = await post(`/social/posts/${id}/approve`);
  assert.equal(p.status, 200);
  const proposal = p.body.proposal_id as string;
  assert.equal((await post(`/conversation/proposals/${proposal}/confirm`)).status, 200);
  assert.equal((await post(`/conversation/proposals/${proposal}/approve`)).status, 200);
  await t.pool.query(`UPDATE scheduled_post SET publish_at = now() - interval '1 second' WHERE post_id = $1`, [id]);
  return { id, proposal };
}
function scheduler(provider: SocialProvider = meta) { return new SocialScheduler({ pool: t.pool, sink: t.handle.sink, provider }); }
async function status(postId: string) { return (await t.pool.query('SELECT * FROM scheduled_post WHERE post_id = $1', [postId])).rows[0]; }

test('bucle automático publica aprobadas sin process-due manual; dos workers no duplican', async () => {
  const p = await approvedPost('Scheduler automático controlado');
  const count = writes;
  const first = scheduler(), second = scheduler();
  try {
    first.start(20); second.start(20);
    const end = Date.now() + 5000;
    while ((await status(p.id)).status !== 'published' && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await status(p.id)).status, 'published');
    assert.equal(writes, count + 1);
    const stored = (await t.pool.query('SELECT status, external_ref FROM social_post WHERE post_id = $1', [p.id])).rows[0];
    assert.equal(stored.status, 'published');
    assert.ok(published.has(stored.external_ref));
  } finally { first.stop(); second.stop(); }
});

test('fila sin aprobación queda blocked y no toca Graph', async () => {
  const c = await post('/social/posts', { text: 'No aprobado' });
  const id = c.body.post.post_id;
  await t.pool.query(`INSERT INTO scheduled_post (scheduled_post_id, tenant_id, post_id, publish_at, status) VALUES ($1,$2,$3,now(),'scheduled')`, [`sp_${randomUUID()}`, tenant, id]);
  const count = writes;
  await scheduler().tick({ tenantId: tenant });
  assert.equal((await status(id)).status, 'blocked');
  assert.equal(writes, count);
});

test('cancelar una programada impide el envío; una publicación en curso o incierta no se anuncia cancelada', async () => {
  const cancel = await approvedPost('Cancelar antes del claim');
  const count = writes;
  assert.equal((await post(`/social/posts/${cancel.id}/reject`)).status, 200);
  await scheduler().tick({ tenantId: tenant });
  assert.equal((await status(cancel.id)).status, 'skipped');
  assert.equal(writes, count);
  for (const state of ['publishing', 'uncertain']) {
    const active = await approvedPost(`No cancelar ${state}`);
    await t.pool.query(`UPDATE scheduled_post SET status=$2, claim_token='active', lease_until=now()+interval '1 minute' WHERE post_id=$1`, [active.id, state]);
    assert.equal((await post(`/social/posts/${active.id}/reject`)).status, 409);
    assert.equal((await status(active.id)).status, state);
    await t.pool.query("UPDATE scheduled_post SET status='failed' WHERE post_id=$1", [active.id]);
  }
});

test('lease vencida real se reconcilia sin POST adicional; ausencia requiere revisión', async () => {
  const p = await approvedPost('Resultado ya aceptado por Graph');
  published.set('123_9000', 'Resultado ya aceptado por Graph');
  await t.pool.query(`UPDATE scheduled_post SET status = 'publishing', external_ref='123_9000', claim_token='crashed', lease_until=now()-interval '1 second' WHERE post_id=$1`, [p.id]);
  const count = writes;
  await scheduler().tick({ tenantId: tenant });
  assert.equal((await status(p.id)).external_ref, '123_9000');
  assert.equal(writes, count);
  const absent = await approvedPost('Incierto no observable');
  published.set('123_9001', 'Incierto no observable'); // mismo texto no prueba que sea nuestro envío
  await t.pool.query(`UPDATE scheduled_post SET status='uncertain', uncertain_since=now(), next_attempt_at=now() WHERE post_id=$1`, [absent.id]);
  await scheduler().tick({ tenantId: tenant });
  assert.equal((await status(absent.id)).status, 'failed');
  assert.equal((await status(absent.id)).last_error, 'uncertain_needs_review');
  assert.equal(writes, count);
});

test('timeout de escritura no reenvía; read-back ausente no es published', async () => {
  const p = await approvedPost('Timeout con resultado desconocido');
  delayed = true;
  const count = writes;
  try { await scheduler().tick({ tenantId: tenant }); } finally { delayed = false; }
  assert.equal((await status(p.id)).status, 'uncertain');
  assert.equal(writes, count + 1);
  await t.pool.query('UPDATE scheduled_post SET next_attempt_at=now() WHERE post_id=$1', [p.id]);
  await scheduler().tick({ tenantId: tenant });
  assert.equal((await status(p.id)).status, 'failed');
  assert.equal(writes, count + 1);
  readback = false;
  try {
    const r = await meta.publishPost({ tenantId: tenant, text: 'Readback obligatorio', contentType: 'post' });
    assert.equal(r.ok, false); assert.equal(r.uncertain, true);
  } finally { readback = true; }
});

test('429 limita y espera Retry-After; token 190 requiere reconexión; otro tenant nunca usa la Page', async () => {
  const p = await approvedPost('Quota limitada');
  rate = 4;
  const count = writes;
  try { await scheduler().tick({ tenantId: tenant }); } finally { rate = 0; }
  const row = await status(p.id);
  assert.equal(row.status, 'scheduled');
  assert.ok(new Date(row.next_attempt_at).getTime() > Date.now() + 20_000);
  assert.equal(writes, count);
  rate = 190;
  try { assert.equal((await meta.publishPost({ tenantId: tenant, text: 'No auth', contentType: 'post' })).ok, false); } finally { rate = 0; }
  assert.equal((await t.handle.connections.get(tenant, META_PROVIDER))?.status, 'needs_authorization');
  const n = requests.length;
  assert.equal((await meta.publishPost({ tenantId: 'client_b', text: 'Otro tenant', contentType: 'post' })).ok, false);
  assert.equal(requests.length, n);
  await t.handle.connections.markStatus(tenant, META_PROVIDER, 'connected', null);
  await t.pool.query(`UPDATE scheduled_post SET status='failed' WHERE post_id=$1`, [p.id]);
});

test('comentario real-falso se lee y respuesta concurrente no se duplica ni cruza tenant', async () => {
  const source = new MetaCommentSource(t.pool, meta);
  const batch = await source.listSince(tenant, null);
  assert.ok(batch.items.some((c) => c.external_ref === '123_999'));
  await t.pool.query(`INSERT INTO engagement_case (case_id,tenant_id,origin,external_ref,author_label,body,state)
    VALUES ('meta-case-sol',$1,'facebook_comment','123_999','Cliente','Gracias','needs_human') ON CONFLICT DO NOTHING`, [tenant]);
  const replier = new MetaCommentReplier(t.pool, meta);
  const input = { tenantId: tenant, origin: 'facebook_comment' as const, targetRef: '123_999', text: 'Gracias por venir', idempotencyKey: 'meta-reply-sol' };
  const results = await Promise.all([replier.reply(input), replier.reply(input)]);
  assert.ok(results.some((r) => r.ok));
  assert.equal(replies, 1);
  assert.equal((await replier.reply(input)).ok, true);
  assert.equal(replies, 1);
  assert.equal((await replier.reply({ ...input, tenantId: 'client_b' })).ok, false);
});

test('publicación real inmediata se encola antes de salir a la red; no falso published', async () => {
  const c = await approvedPost('Outbox antes de red');
  await t.pool.query('DELETE FROM scheduled_post WHERE post_id = $1', [c.id]);
  await t.pool.query("UPDATE social_post SET scheduled_at = NULL, status = 'awaiting_approval' WHERE post_id = $1", [c.id]);
  const count = writes;
  const publisher = new SocialPublisher(t.pool, meta, t.handle.sink);
  // El contrato del publisher se ejecuta después de aprobación; aquí se prueba su efecto durable.
  const result = await publisher.publish({ tenantId: tenant, proposalId: c.proposal, proposalType: 'social.post', payload: { post_id: c.id } });
  assert.equal(result.ok, true);
  assert.equal((await status(c.id)).status, 'scheduled');
  assert.equal(writes, count);
});
