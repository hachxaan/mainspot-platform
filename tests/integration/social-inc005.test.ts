/**
 * Integration — INC-005 social (CAP-003, DEC-017/026).
 *
 * Crear borrador → programar con aprobación → preview → publicar UNA vez →
 * cola programada con tick manual → listado → deny sin permiso → campaña
 * avanzada PROHIBITED + auditoría.
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

async function createPost(token: string, text: string, extra: Record<string, unknown> = {}) {
  return api(t.baseUrl, '/api/backoffice/social/posts', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ text, ...extra }),
  });
}

test('INC-005: crear borrador, deny sin permiso (read_only) y listado', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const reader = await login(t.baseUrl, SEED.a.reader.login, SEED.a.reader.password, SEED.a.tenant);

  const created = await createPost(ops.token, 'Prueba de borrador: hoy lomo saltado 2x1? No, sin promesas.');
  assert.equal(created.status, 201);
  assert.equal(created.body.post.status, 'draft');
  assert.equal(created.body.post.content_type, 'post');

  // publicidad básica (ad) también es del alcance (Ads básicos)
  const ad = await createPost(ops.token, 'Anuncio básico de prueba', { content_type: 'ad' });
  assert.equal(ad.status, 201);
  assert.equal(ad.body.post.content_type, 'ad');

  // deny sin permiso: read_only NO puede crear
  const denied = await createPost(reader.token, 'intento de crear sin permiso');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'permission_denied');
  const ev = await t.pool.query(
    `SELECT 1 FROM audit_event WHERE tenant_id = $1 AND actor_id = $2 AND action = 'access.deny' AND resource LIKE '%/social/posts'`,
    [SEED.a.tenant, 'user_a_reader'],
  );
  assert.ok(ev.rowCount && ev.rowCount >= 1, 'deny auditado con actor');

  const list = await api(t.baseUrl, '/api/backoffice/social/posts', { headers: authHeaders(ops.token) });
  assert.equal(list.status, 200);
  assert.ok(list.body.posts.length >= 2, 'listado incluye borradores');
  console.log('TEST_PASS INC-005 draft + deny sin permiso + listado');
});

test('INC-005: post → preview → aprobación → publicado idempotente', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);

  const created = await createPost(ops.token, 'Aprobación directa: presentamos el menú de la semana.');
  const postId = created.body.post.post_id as string;

  // Operación aprueba para generar propuesta (social.approve = admin)
  const approved = await api(t.baseUrl, `/api/backoffice/social/posts/${postId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  assert.equal(approved.status, 200);
  const proposalId = approved.body.proposal_id as string;

  const conf = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/confirm`, {
    method: 'POST', headers: authHeaders(ops.token),
  });
  assert.equal(conf.status, 200);
  assert.equal(conf.body.status, 'preview_ready');
  const previewUrl = conf.body.preview.url as string;
  const page = await fetch(`${t.baseUrl}${previewUrl}`);
  const html = await page.text();
  assert.ok(html.includes('menú de la semana'), 'preview muestra el texto social');

  const published = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.already_published, false);
  assert.equal(published.body.status, 'published');

  const row = await t.pool.query('SELECT status, external_ref, published_at FROM social_post WHERE post_id = $1', [postId]);
  assert.equal(row.rows[0]?.status, 'published');
  assert.ok(row.rows[0]?.published_at);
  assert.ok(String(row.rows[0]?.external_ref).startsWith('sim:fb:post:'), 'external_ref simulado idempotente');

  // Idempotencia: segunda aprobación no duplica
  const again = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  assert.equal(again.body.already_published, true);
  const pubs = await t.pool.query('SELECT count(*) AS n FROM publication WHERE proposal_id = $1', [proposalId]);
  assert.equal(Number(pubs.rows[0]?.n ?? 0), 1);
  console.log('TEST_PASS INC-005 post → preview → aprobación → publicado UNA vez');

  const postAudit = await t.pool.query<{ action: string }>(
    `SELECT DISTINCT action FROM audit_event WHERE tenant_id = $1 AND resource = $2`,
    [SEED.a.tenant, `social_post/${postId}`],
  );
  const actions = postAudit.rows.map((r) => r.action);
  for (const expected of ['social.created', 'social.approved', 'social.published']) {
    assert.ok(actions.includes(expected), `audit contiene ${expected}`);
  }
});

test('INC-005: programar con aprobación → cola SOLO tras aprobar → tick manual publica UNA vez (PR-01)', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);

  const created = await createPost(ops.token, 'Programado: promoción del fin de semana.');
  const postId = created.body.post.post_id as string;
  const future = new Date(Date.now() + 60_000).toISOString();

  // 1) Programar un borrador: SOLO registra la intención (scheduled_at).
  const scheduled = await api(t.baseUrl, `/api/backoffice/social/posts/${postId}/schedule`, {
    method: 'POST', headers: authHeaders(ops.token),
    body: JSON.stringify({ publish_at: future }),
  });
  assert.equal(scheduled.status, 200);
  assert.equal(scheduled.body.status, 'awaiting_approval');
  // PR-01: schedule() NO crea la cola; la cola se materializa al aprobar.
  const schedCountBefore = await t.pool.query('SELECT count(*) AS n FROM scheduled_post WHERE post_id = $1', [postId]);
  assert.equal(Number(schedCountBefore.rows[0]?.n ?? 0), 0, 'sin fila de cola antes de la aprobación');

  // 2) Aprobación humana → propuesta → preview → publicación (FLOW-002).
  const approved = await api(t.baseUrl, `/api/backoffice/social/posts/${postId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  const proposalId = approved.body.proposal_id as string;
  await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/confirm`, { method: 'POST', headers: authHeaders(ops.token) });
  const pub = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  assert.equal(pub.body.status, 'published');
  // Aprobado pero con fecha futura ⇒ post 'scheduled' + cola materializada.
  const afterApprove = await t.pool.query('SELECT status FROM social_post WHERE post_id = $1', [postId]);
  assert.equal(afterApprove.rows[0]?.status, 'scheduled');
  const schedRow = await t.pool.query<{ status: string; proposal_id: string | null }>(
    'SELECT status, proposal_id FROM scheduled_post WHERE post_id = $1', [postId],
  );
  assert.equal(schedRow.rows[0]?.status, 'scheduled', 'cola creada por el publisher tras aprobación');
  assert.equal(schedRow.rows[0]?.proposal_id, proposalId, 'cola vinculada a la proposal aprobada (PR-01)');

  // 3) Tick manual: antes de la fecha NO publica…
  const early = await api(t.baseUrl, '/api/backoffice/social/process-due', {
    method: 'POST', headers: authHeaders(ops.token),
  });
  assert.equal(early.body.processed, 0, 'antes de la fecha no publica');

  // …se facilita el tick forzando una fecha pasada en BD (determinista).
  await t.pool.query('UPDATE scheduled_post SET publish_at = now() - interval \'1 minute\' WHERE post_id = $1', [postId]);
  const tick = await api(t.baseUrl, '/api/backoffice/social/process-due', {
    method: 'POST', headers: authHeaders(ops.token),
  });
  assert.equal(tick.body.processed, 1, 'tick publica la fila vencida (aprobada)');
  const afterTick = await t.pool.query('SELECT status, external_ref FROM social_post WHERE post_id = $1', [postId]);
  assert.equal(afterTick.rows[0]?.status, 'published');
  assert.ok(String(afterTick.rows[0]?.external_ref).startsWith('sim:fb:post:'));

  // 4) Idempotencia del tick: segundo tick no re-publica
  const tick2 = await api(t.baseUrl, '/api/backoffice/social/process-due', {
    method: 'POST', headers: authHeaders(ops.token),
  });
  assert.equal(tick2.body.processed, 0);
  const pubs = await t.pool.query("SELECT count(*) AS n FROM scheduled_post WHERE post_id = $1 AND status = 'published'", [postId]);
  assert.equal(Number(pubs.rows[0]?.n ?? 0), 1, 'cola publicada UNA vez');
  console.log('TEST_PASS INC-005 programado + aprobación + cola tras aprobar + tick idempotente (PR-01)');
});

test('PR-01: programar sin aprobar ⇒ el tick NO publica (audit deny, fila bloqueada)', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);

  const created = await createPost(ops.token, 'Programado SIN aprobar: no debe publicarse.');
  const postId = created.body.post.post_id as string;
  const future = new Date(Date.now() + 60_000).toISOString();

  // Programar (intención) — sin aprobación, sin propuesta, sin cola.
  const scheduled = await api(t.baseUrl, `/api/backoffice/social/posts/${postId}/schedule`, {
    method: 'POST', headers: authHeaders(ops.token),
    body: JSON.stringify({ publish_at: future }),
  });
  assert.equal(scheduled.status, 200);
  assert.equal(scheduled.body.status, 'awaiting_approval');
  const noQueue = await t.pool.query('SELECT count(*) AS n FROM scheduled_post WHERE post_id = $1', [postId]);
  assert.equal(Number(noQueue.rows[0]?.n ?? 0), 0, 'sin propuesta ni cola antes de aprobar');

  // Reproduce el escenario del Reviewer: fila de cola presente SIN aprobación
  // (legacy/tampering) consultada por el tick como si estuviera programada.
  await t.pool.query(
    `INSERT INTO scheduled_post (scheduled_post_id, tenant_id, post_id, publish_at, status)
     VALUES ($1, $2, $3, now() - interval '1 minute', 'scheduled')`,
    [`sp_rogue_${crypto.randomUUID().slice(0, 8)}`, SEED.a.tenant, postId],
  );

  const tick = await api(t.baseUrl, '/api/backoffice/social/process-due', {
    method: 'POST', headers: authHeaders(ops.token),
  });
  assert.equal(tick.body.processed, 0, 'tick NO publica: no hay aprobación');
  assert.equal(tick.body.blocked, 1, 'fila sin aprobación marcada blocked');

  const postAfter = await t.pool.query('SELECT status, external_ref, published_at FROM social_post WHERE post_id = $1', [postId]);
  assert.equal(postAfter.rows[0]?.status, 'awaiting_approval', 'el post sigue sin publicar');
  assert.equal(postAfter.rows[0]?.external_ref, null);
  assert.equal(postAfter.rows[0]?.published_at, null);

  const queueAfter = await t.pool.query('SELECT status FROM scheduled_post WHERE post_id = $1', [postId]);
  assert.equal(queueAfter.rows[0]?.status, 'blocked', 'fila bloqueada (nunca auto-publicada)');

  // No hay publicaciones del post (ni directas ni por tick).
  const pubs = await t.pool.query('SELECT count(*) AS n FROM publication WHERE proposal_id = (SELECT proposal_id FROM social_post WHERE post_id = $1)', [postId]);
  assert.equal(Number(pubs.rows[0]?.n ?? 0), 0, 'cero publicaciones');

  // Audit: deny 'social.published'/'not_approved'; sin allow 'social.published'.
  const audit = await t.pool.query<{ decision: string; result: string }>(
    `SELECT decision, result FROM audit_event
     WHERE tenant_id = $1 AND resource = $2 AND action = 'social.published'
     ORDER BY ts DESC LIMIT 1`,
    [SEED.a.tenant, `social_post/${postId}`],
  );
  assert.equal(audit.rows[0]?.decision, 'deny');
  assert.equal(audit.rows[0]?.result, 'not_approved');
  const allowPublished = await t.pool.query(
    `SELECT 1 FROM audit_event WHERE tenant_id = $1 AND resource = $2 AND action = 'social.published' AND decision = 'allow'`,
    [SEED.a.tenant, `social_post/${postId}`],
  );
  assert.equal(allowPublished.rowCount ?? 0, 0, 'sin evento allow de publicación');
  console.log('TEST_PASS PR-01 programar sin aprobar ⇒ tick no publica + audit deny + fila blocked');
});

test('INC-005: campaña avanzada PROHIBITED con auditoría deny (fuera del MVP)', async () => {
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const adv = await api(t.baseUrl, '/api/backoffice/social/campaigns/advanced', {
    method: 'POST',
    headers: authHeaders(admin.token),
    body: JSON.stringify({ audience: 'mujeres 25-40 Lima', budget_cents: 5000 }),
  });
  assert.equal(adv.status, 403);
  // El permiso social.campaign_advanced está bloqueado para TODOS los roles:
  // la matriz deniega en el middleware (fail-closed) con código permission_denied.
  assert.equal(adv.body.error.code, 'permission_denied');
  const ev = await t.pool.query<{ decision: string; result: string }>(
    `SELECT decision, result FROM audit_event
     WHERE tenant_id = $1 AND resource LIKE '%/social/campaigns/advanced%' AND decision = 'deny'
     ORDER BY ts DESC LIMIT 1`,
    [SEED.a.tenant],
  );
  assert.ok(ev.rowCount && ev.rowCount === 1, 'intento auditado como deny');
  assert.equal(ev.rows[0]?.result, 'permission_denied');
  const campaignsVisible = await t.pool.query('SELECT count(*) AS n FROM social_post WHERE text LIKE $1', ['%segment%']);
  assert.equal(Number(campaignsVisible.rows[0]?.n ?? 0), 0, 'no se creó ninguna campaña');
  console.log('TEST_PASS INC-005 campaña avanzada PROHIBITED + audit deny');
});

test('PR-06: rate limiting en el approve social (IP + operador + recurso → 429)', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const created = await createPost(ops.token, 'Rate limit approve social.');
  const postId = created.body.post.post_id as string;

  let rateLimited = 0;
  for (let i = 0; i < 12; i += 1) {
    const res = await api(t.baseUrl, `/api/backoffice/social/posts/${postId}/approve`, {
      method: 'POST', headers: authHeaders(admin.token),
    });
    if (res.status === 429) rateLimited += 1;
  }
  assert.ok(rateLimited >= 1, `el approve se rate-limita tras N intentos (429 apareció ${rateLimited} veces)`);
  console.log(`TEST_PASS PR-06 rate limiting approve social (429 x${rateLimited})`);
});
