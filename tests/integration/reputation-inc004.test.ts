/**
 * Integration — INC-004 reputación (CAP-002/CAP-004, DEC-011/023).
 *
 * Recorre: sync determinista → positiva acknowledge → <4 sugerida → escalada →
 * edición de borrador (solo antes de aprobar) → propuesta de preview →
 * aprobación → publicación UNA vez → manipulación (hide) PROHIBITED → anti-
 * oracle cross-tenant. Auditoría con request_id en cada transición.
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

async function syncReviews(token: string) {
  return api(t.baseUrl, '/api/backoffice/reputation/reviews/sync', { method: 'POST', headers: authHeaders(token) });
}

test('INC-004: sync determinista, positiva acknowledge, <4 sugerida (sin publicar)', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const sync = await syncReviews(ops.token);
  assert.equal(sync.status, 201, 'sync ok');
  assert.equal(sync.body.synced, 4, 'dataset determinista de 4 reseñas por tenant');
  assert.equal(sync.body.classified.acknowledged, 2, '2 positivas acknowledge');
  assert.equal(sync.body.classified.suggested, 2, 'neutra(3★)+negativa(2★) sugeridas (<4, DEC-023)');

  const list = await api(t.baseUrl, '/api/backoffice/reputation/reviews', { headers: authHeaders(ops.token) });
  assert.equal(list.status, 200);
  const positive = list.body.reviews.find((r: { star_rating: number }) => r.star_rating === 5);
  const negative = list.body.reviews.find((r: { star_rating: number }) => r.star_rating === 2);
  assert.equal(positive.state, 'acknowledged', 'positiva → acknowledge (sin publicación)');
  assert.equal(negative.state, 'suggested', 'negativa <4 → sugerida (sin publicación todavía)');
  assert.equal(negative.published_at, null, 'nada publicado aún');
  assert.ok(Array.isArray(negative.suggested_options) && negative.suggested_options.length === 3, '3 borradores sugeridos (FLOW-004)');
  assert.equal(negative.response_text, negative.suggested_options[0], 'borrador por defecto = primera opción');
  console.log('TEST_PASS INC-004 sync/classification/acnowledge/escalada-sugerida');

  // Idempotencia del sync: repetir no duplica.
  const again = await syncReviews(ops.token);
  assert.equal(again.body.synced, 0);
  assert.equal(again.body.skipped, 4);
});

test('INC-004: reseña <4 → escalamiento humano → respuesta aprobada publica UNA vez', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);

  const list = await api(t.baseUrl, '/api/backoffice/reputation/reviews', { headers: authHeaders(ops.token) });
  const negative = list.body.reviews.find((r: { star_rating: number; state: string }) => r.star_rating === 2 && r.state === 'suggested') as { review_id: string };

  // Escalar a humano (FLOW-004)
  const escalated = await api(t.baseUrl, `/api/backoffice/reputation/reviews/${negative.review_id}/escalate`, {
    method: 'POST', headers: authHeaders(ops.token),
  });
  assert.equal(escalated.status, 200);
  assert.equal(escalated.body.status, 'awaiting_human');

  // Editar borrador (solo antes de aprobar)
  const edited = await api(t.baseUrl, `/api/backoffice/reputation/reviews/${negative.review_id}/response`, {
    method: 'POST', headers: authHeaders(ops.token),
    body: JSON.stringify({ text: 'Gracias por tu comentario, Carlos. Lamento la espera: ya estamos revisando la atención por teléfono.' }),
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.status, 'edited');
  assert.ok(edited.body.review.response_text.includes('Carlos'));

  // Aprobar respuesta → genera propuesta (operación requiere reputation.approve = admin)
  const approved = await api(t.baseUrl, `/api/backoffice/reputation/reviews/${negative.review_id}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  assert.equal(approved.status, 200);
  const proposalId = approved.body.proposal_id as string;
  assert.ok(proposalId, 'propuesta creada para preview');

  // Confirmar → preview
  const conf = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/confirm`, {
    method: 'POST', headers: authHeaders(ops.token),
  });
  assert.equal(conf.status, 200);
  assert.equal(conf.body.status, 'preview_ready');
  const previewUrl = conf.body.preview.url as string;
  assert.ok(previewUrl.startsWith('/preview/pv_'));
  const previewPage = await fetch(`${t.baseUrl}${previewUrl}`);
  assert.equal(previewPage.status, 200);
  const html = await previewPage.text();
  assert.ok(html.includes('Carlos'), 'preview muestra la respuesta propuesta');

  // Publicar (operation.approve = admin): UNA vez
  const published = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.status, 'published');
  assert.equal(published.body.already_published, false);

  const rowAfter = await t.pool.query(
    'SELECT state, published_text, published_at FROM review WHERE review_id = $1',
    [negative.review_id],
  );
  assert.equal(rowAfter.rows[0]?.state, 'published');
  assert.ok(rowAfter.rows[0]?.published_at, 'published_at asignado');
  assert.ok((rowAfter.rows[0]?.published_text as string).includes('Carlos'));

  // Replay: segunda aprobación NO duplica publicación
  const again = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  assert.equal(again.body.already_published, true);
  const pubs = await t.pool.query('SELECT count(*) AS n FROM publication WHERE proposal_id = $1', [proposalId]);
  assert.equal(Number(pubs.rows[0]?.n ?? 0), 1, 'UNA sola publicación');
  const republished = await t.pool.query<{ n: string }>(
    'SELECT count(*) AS n FROM review WHERE review_id = $1 AND state = $2',
    [negative.review_id, 'published'],
  );
  assert.equal(Number(republished.rows[0]?.n ?? 0), 1);

  // Editar DESPUÉS de publicar ⇒ 409 prohibido
  const editAfter = await api(t.baseUrl, `/api/backoffice/reputation/reviews/${negative.review_id}/response`, {
    method: 'POST', headers: authHeaders(ops.token),
    body: JSON.stringify({ text: 'intento de edición posterior' }),
  });
  assert.equal(editAfter.status, 409);
  assert.equal(editAfter.body.error.code, 'prohibited');
  console.log('TEST_PASS INC-004 negative → escalate → approve → publish once (idempotente)');

  // Auditoría correlacionada: las transiciones del flujo llevan request_id.
  const negAudit = await t.pool.query<{ action: string }>(
    `SELECT DISTINCT action FROM audit_event WHERE tenant_id = $1 AND resource = $2`,
    [SEED.a.tenant, `review/${negative.review_id}`],
  );
  const actions = negAudit.rows.map((r) => r.action);
  for (const expected of ['reputation.review.ingested', 'reputation.escalated', 'reputation.response.edited', 'reputation.approved', 'reputation.published']) {
    assert.ok(actions.includes(expected), `audit contiene ${expected}`);
  }
  const reqAudit = await t.pool.query(
    'SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND request_id IS NOT NULL',
    [SEED.a.tenant],
  );
  assert.ok(Number(reqAudit.rows[0]?.n ?? 0) > 0, 'audit con request_id');
  console.log('TEST_PASS INC-004 audit correlacionada (request_id)');
});

test('INC-004: sin manipulación — ocultar/borrar reseña es PROHIBITED con auditoría deny', async () => {
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const list = await api(t.baseUrl, '/api/backoffice/reputation/reviews', { headers: authHeaders(admin.token) });
  const reviewId = (list.body.reviews[0] as { review_id: string }).review_id;

  const hide = await api(t.baseUrl, `/api/backoffice/reputation/reviews/${reviewId}/hide`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  assert.equal(hide.status, 403, 'ocultar bloqueado incluso para admin');
  const del = await api(t.baseUrl, `/api/backoffice/reputation/reviews/${reviewId}`, {
    method: 'DELETE', headers: authHeaders(admin.token),
  });
  assert.equal(del.status, 403, 'borrar bloqueado');

  const denyEv = await t.pool.query<{ decision: string; result: string }>(
    `SELECT decision, result FROM audit_event WHERE tenant_id = $1 AND action = 'access.deny' AND resource LIKE '/api/backoffice/reputation/reviews/%' ORDER BY ts DESC LIMIT 2`,
    [SEED.a.tenant],
  );
  assert.ok(denyEv.rowCount && denyEv.rowCount >= 2, 'denies auditados');
  assert.ok(denyEv.rows.every((r) => r.decision === 'deny'), 'decision=deny auditada');
  const stillThere = await t.pool.query('SELECT count(*) AS n FROM review WHERE review_id = $1', [reviewId]);
  assert.equal(Number(stillThere.rows[0]?.n ?? 0), 1, 'la reseña NO fue borrada');
  console.log('TEST_PASS INC-004 sin manipulación: hide/delete PROHIBITED + audit deny');
});

test('INC-004: anti-oracle — review de OTRO tenant responde 404 idéntico', async () => {
  const opsA = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const adminB = await login(t.baseUrl, SEED.b.admin.login, SEED.b.admin.password, SEED.b.tenant);
  const listA = await api(t.baseUrl, '/api/backoffice/reputation/reviews', { headers: authHeaders(opsA.token) });
  const reviewA = (listA.body.reviews[0] as { review_id: string }).review_id;

  const fake = await api(t.baseUrl, `/api/backoffice/reputation/reviews/rev_no_existe/escalate`, {
    method: 'POST', headers: authHeaders(adminB.token),
  });
  const cross = await api(t.baseUrl, `/api/backoffice/reputation/reviews/${reviewA}/escalate`, {
    method: 'POST', headers: authHeaders(adminB.token),
  });
  assert.equal(cross.status, 404);
  assert.deepEqual(
    { code: cross.body.error.code, message: cross.body.error.message },
    { code: fake.body.error.code, message: fake.body.error.message },
    'respuesta idéntica a inexistente (anti-oracle IR-01)',
  );
  console.log('TEST_PASS INC-004 anti-oracle cross-tenant (404 idéntico)');
});

test('PR-06: rate limiting en el approve de reputación (IP + operador + recurso → 429)', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  // Crear una reseña negativa fresca en estado 'suggested' para aprobar.
  const sync = await api(t.baseUrl, '/api/backoffice/reputation/reviews/sync', { method: 'POST', headers: authHeaders(ops.token) });
  const list = await api(t.baseUrl, '/api/backoffice/reputation/reviews', { headers: authHeaders(ops.token) });
  const suggested = (list.body.reviews as Array<{ review_id: string; state: string }>).find((r) => r.state === 'suggested') as { review_id: string };
  // Sin respuesta editable re-aprobamos la misma propuesta: los intentos
  // posteriores devuelven existing/409; el rate limiter aplica igual (429).
  let rateLimited = 0;
  for (let i = 0; i < 12; i += 1) {
    const res = await api(t.baseUrl, `/api/backoffice/reputation/reviews/${suggested.review_id}/approve`, {
      method: 'POST', headers: authHeaders(admin.token),
    });
    if (res.status === 429) rateLimited += 1;
  }
  assert.ok(rateLimited >= 1, `el approve se rate-limita tras N intentos (429 apareció ${rateLimited} veces)`);
  console.log(`TEST_PASS PR-06 rate limiting approve reputación (429 x${rateLimited})`);
});
