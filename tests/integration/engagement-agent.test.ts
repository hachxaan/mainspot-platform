/**
 * Integration — DEV-E2E-02 agente de atención (SHARED-CONTRACT §B, AG-01..AG-04).
 *
 * Todo contra el SIMULADOR determinista (provider_mode=simulated): ningún resultado de aquí es un
 * envío real a Google/Meta/Telegram. Tenants nuevos por test.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApi, authHeaders, api, login, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan } from '../helpers/tenants.ts';
import type { SimulatedChannel } from '../../src/channels/simulated.ts';
import type { CaseRow } from '../../src/engagement/service.ts';

interface SimReply { origin: string; target_ref: string; text: string; external_ref: string }

let t: TestApi;

before(async () => {
  t = await bootApi();
});

after(async () => {
  await t.close();
});

const LIMITS = { reviews_managed: 100 };

function transcript(): Array<{ to: string; text: string }> {
  const ch = t.handle.channel;
  assert.equal(ch.name, 'simulated', 'los avisos de Telegram en pruebas son simulados');
  return [...(ch as SimulatedChannel).transcript()];
}

async function newTenant(prefix: string) {
  return createTenantWithPlan(t, LIMITS, prefix);
}
async function setPolicy(token: string, origin: string, category: string, mode: string, extra: Record<string, unknown> = {}) {
  return api(t.baseUrl, '/api/backoffice/engagement/policies', {
    method: 'PUT', headers: authHeaders(token), body: JSON.stringify({ origin, category, mode, ...extra }),
  });
}
async function injectReview(token: string, body: string, rating: number, externalRef?: string) {
  return api(t.baseUrl, '/api/backoffice/dev/simulator/google-reviews', {
    method: 'POST', headers: authHeaders(token), body: JSON.stringify({ body, rating, author_label: 'Ana P.', external_ref: externalRef }),
  });
}
async function injectComment(token: string, postId: string, body: string, externalRef?: string) {
  return api(t.baseUrl, '/api/backoffice/dev/simulator/facebook-comments', {
    method: 'POST', headers: authHeaders(token), body: JSON.stringify({ post_id: postId, body, author_label: 'Luis R.', external_ref: externalRef }),
  });
}
async function run(token: string) {
  const r = await api(t.baseUrl, '/api/backoffice/engagement/run', { method: 'POST', headers: authHeaders(token) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.report;
}
async function cases(token: string, query = '') {
  return (await api(t.baseUrl, `/api/backoffice/engagement/cases${query}`, { headers: authHeaders(token) })).body.cases as CaseRow[];
}
function one(list: CaseRow[], ref?: string): CaseRow {
  const found = ref === undefined ? list[0] : list.find((c) => c.external_ref === ref);
  assert.ok(found, `caso ${ref ?? '(primero)'} presente`);
  return found;
}
async function replies(token: string) {
  return (await api(t.baseUrl, '/api/backoffice/dev/simulator/replies', { headers: authHeaders(token) })).body.replies as SimReply[];
}
async function linkTelegram(token: string, chatId: number) {
  const code = await api(t.baseUrl, '/api/backoffice/telegram/link-code', { method: 'POST', headers: authHeaders(token) });
  assert.equal(code.status, 201);
  const hook = await telegram(chatId, `/start ${code.body.code}`);
  assert.equal(hook.body.handled, 'linked');
}
async function telegram(chatId: number, text: string) {
  return api(t.baseUrl, '/api/telegram/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ update_id: Math.floor(Math.random() * 1e9), message: { chat: { id: chatId }, text } }),
  });
}
async function publishedPost(tenant: string, text = 'Menú de la semana') {
  const postId = `post_${randomUUID().slice(0, 8)}`;
  await t.pool.query(
    `INSERT INTO social_post (post_id, tenant_id, network, content_type, text, status, published_at, external_ref, created_by)
     VALUES ($1, $2, 'facebook', 'post', $3, 'published', now(), $4, 'fixture')`, [postId, tenant, text, `sim:fb:post:${postId}`]);
  return postId;
}
async function addUser(tenant: string, role: 'operation' | 'read_only') {
  const id = `user_${role}_${tenant}`;
  const loginName = `${role}@${tenant}.example.com`;
  await t.pool.query(`INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash)
    VALUES ($1, $2, $3, 'active', $4, crypt('Fixture-User-2026!', gen_salt('bf', 4)))`, [id, role, loginName, tenant]);
  await t.pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, $2, $3)`, [id, role, tenant]);
  return (await login(t.baseUrl, loginName, 'Fixture-User-2026!', tenant)).token;
}

test('AG-01: reseña simple + opt-in explícito → respuesta simulada ÚNICA con auditoría y versión de política', async () => {
  const a = await newTenant('client_ag1');
  const noConsent = await setPolicy(a.token, 'google_review', 'gratitude', 'safe_auto_reply');
  assert.equal(noConsent.status, 400, 'activar sin consentimiento explícito se rechaza');
  const pol = await setPolicy(a.token, 'google_review', 'gratitude', 'safe_auto_reply', { consent: true });
  assert.equal(pol.status, 200);
  assert.equal(pol.body.policy.version, 1);
  assert.match(pol.body.policy.consent_text, /Autorizo a MainSpot/);

  await injectReview(a.token, '¡Excelente atención y la comida deliciosa, gracias!', 5);
  const report = await run(a.token);
  assert.equal(report.ingested.google_review, 1);
  assert.equal(report.responded, 1);

  const c = one(await cases(a.token));
  assert.equal(c.state, 'responded');
  assert.equal(c.decision, 'auto_reply');
  assert.equal(c.resolution_channel, 'auto');
  assert.equal(c.policy_version, 1);
  assert.equal(c.delivery_mode, 'simulated', 'nunca se reporta como real');
  assert.match(c.responded_external_ref ?? '', /^sim:gbp:reply:/);
  const review = await t.pool.query(`SELECT state, published_text FROM review WHERE review_id = $1`, [c.review_id]);
  assert.equal(review.rows[0].state, 'published', 'la reseña queda respondida en el módulo de reseñas');

  await run(a.token);
  await run(a.token);
  assert.equal((await replies(a.token)).length, 1, 'sin doble respuesta en ciclos posteriores');
  const audit = await t.pool.query(`SELECT result, evidence_ref FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.responded'`, [a.tenant]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].result, 'auto:policy_v1:simulated');
  console.log('TEST_PASS AG-01 [simulated]');
});

test('AG-01: sin política, o con la política revocada, una reseña positiva espera revisión humana', async () => {
  const a = await newTenant('client_ag1b');
  await injectReview(a.token, 'Gracias, excelente servicio', 5, 'g1');
  await run(a.token);
  const c1 = one(await cases(a.token));
  assert.equal(c1.state, 'needs_human');
  assert.equal(c1.reason, 'no_policy');

  await setPolicy(a.token, 'google_review', 'gratitude', 'safe_auto_reply', { consent: true });
  const revoked = await setPolicy(a.token, 'google_review', 'gratitude', 'review_required');
  assert.equal(revoked.body.policy.version, 2, 'versionado append-only');
  await injectReview(a.token, 'Gracias, excelente servicio otra vez', 5, 'g2');
  await run(a.token);
  const c2 = one(await cases(a.token), 'g2');
  assert.equal(c2.state, 'needs_human');
  assert.equal(c2.reason, 'policy_review_required');
  assert.equal(c2.policy_version, 2);
  assert.equal((await replies(a.token)).length, 0);
});

test('AG-02: reseña delicada → caso humano con 3 alternativas, aviso Telegram, edición y aprobación (una vez)', async () => {
  const a = await newTenant('client_ag2');
  await setPolicy(a.token, 'google_review', 'gratitude', 'safe_auto_reply', { consent: true });
  const chat = 700000000 + Math.floor(Math.random() * 1e6);
  await linkTelegram(a.token, chat);

  await injectReview(a.token, 'Me intoxiqué después de comer, quiero un reembolso', 1);
  const report = await run(a.token);
  assert.equal(report.notifications.sent, 1);
  const c = one(await cases(a.token));
  assert.equal(c.state, 'needs_human');
  assert.match(c.reason ?? '', /^risk:/);
  assert.equal(c.drafts.length, 3, 'tres alternativas editables');
  assert.equal((await replies(a.token)).length, 0, 'nada publicado sin decisión');

  const sent = transcript().filter((m) => m.to === String(chat) && m.text.includes(c.case_id));
  assert.equal(sent.length, 1, 'un solo aviso por caso');
  assert.match(sent[0]!.text, /1\) .+\n2\) .+\n3\) /);
  assert.ok(sent[0]!.text.includes(`/panel#/caso/${c.case_id}`) && /Panel: https?:\/\//.test(sent[0]!.text), 'enlace absoluto al caso (exige sesión)');
  await run(a.token);
  assert.equal(transcript().filter((m) => m.to === String(chat) && m.text.includes(c.case_id)).length, 1, 'sin alertas duplicadas');

  // Operación edita un borrador; no puede aprobar. Solo lectura no puede editar.
  const ops = await addUser(a.tenant, 'operation');
  const reader = await addUser(a.tenant, 'read_only');
  const edited = await api(t.baseUrl, `/api/backoffice/engagement/cases/${c.case_id}/drafts/2`, {
    method: 'POST', headers: authHeaders(ops), body: JSON.stringify({ text: 'Hola Ana, lamentamos lo ocurrido. Escríbenos por mensaje privado para revisarlo.' }),
  });
  assert.equal(edited.status, 200);
  assert.equal((await api(t.baseUrl, `/api/backoffice/engagement/cases/${c.case_id}/approve`, { method: 'POST', headers: authHeaders(ops), body: '{}' })).status, 403);
  assert.equal((await api(t.baseUrl, `/api/backoffice/engagement/cases/${c.case_id}/drafts/1`, { method: 'POST', headers: authHeaders(reader), body: JSON.stringify({ text: 'x' }) })).status, 403);

  // Aprobación desde Telegram (mismo caso que el panel).
  const tg = await telegram(chat, `/aprobar ${c.case_id} 2`);
  assert.equal(tg.body.handled, 'approved');
  const after = (await api(t.baseUrl, `/api/backoffice/engagement/cases/${c.case_id}`, { headers: authHeaders(a.token) })).body.case;
  assert.equal(after.state, 'responded');
  assert.equal(after.resolution_channel, 'telegram');
  assert.equal(after.response_text, 'Hola Ana, lamentamos lo ocurrido. Escríbenos por mensaje privado para revisarlo.');

  const again = await api(t.baseUrl, `/api/backoffice/engagement/cases/${c.case_id}/approve`, { method: 'POST', headers: authHeaders(a.token), body: '{}' });
  assert.equal(again.body.already_approved, true);
  assert.equal((await telegram(chat, `/aprobar ${c.case_id} 1`)).body.handled, 'approve_repeat');
  assert.equal((await replies(a.token)).length, 1, 'una sola respuesta pública');
  console.log('TEST_PASS AG-02 aprobación (panel+Telegram) [simulated]');
});

test('AG-02: rechazo en panel, Telegram ve el mismo estado; chat sin permiso o ajeno no decide', async () => {
  const a = await newTenant('client_ag2b');
  const b = await newTenant('client_ag2c');
  const chatA = 710000000 + Math.floor(Math.random() * 1e6);
  const chatOps = chatA + 1;
  const chatB = chatA + 2;
  await linkTelegram(a.token, chatA);
  await linkTelegram(await addUser(a.tenant, 'operation'), chatOps);
  await linkTelegram(b.token, chatB);
  await injectReview(a.token, 'Pésimo servicio, me trataron mal', 2);
  await run(a.token);
  const c = one(await cases(a.token));

  assert.equal((await telegram(chatOps, `/aprobar ${c.case_id} 1`)).body.handled, 'permission_denied');
  assert.equal((await telegram(chatB, `/aprobar ${c.case_id} 1`)).body.handled, 'not_found', 'tenant ajeno: mismo 404');
  assert.equal((await telegram(999999, `/aprobar ${c.case_id} 1`)).body.handled, 'unlinked_chat');
  assert.equal((await api(t.baseUrl, `/api/backoffice/engagement/cases/${c.case_id}`, { headers: authHeaders(b.token) })).status, 404);

  const rej = await api(t.baseUrl, `/api/backoffice/engagement/cases/${c.case_id}/reject`, { method: 'POST', headers: authHeaders(a.token), body: '{}' });
  assert.equal(rej.body.case.state, 'rejected');
  assert.equal((await telegram(chatA, `/rechazar ${c.case_id}`)).body.handled, 'reject_repeat');
  assert.equal((await telegram(chatA, `/aprobar ${c.case_id} 1`)).body.handled, 'validation_error', 'un caso rechazado no se publica');
  assert.equal((await replies(a.token)).length, 0);
  // Ningún teléfono se usó como destino de Telegram.
  assert.ok(transcript().every((m) => !m.to.startsWith('+')));
});

test('AG-03: Facebook comentario simple (auto) y delicado (humano) sin afectar publicaciones previas; teléfono propio de Facebook', async () => {
  const a = await newTenant('client_ag3');
  await api(t.baseUrl, '/api/backoffice/contact/phones/primary', { method: 'PUT', headers: authHeaders(a.token), body: JSON.stringify({ primary_phone: { country_iso2: 'MX', national_number: '9830000000' } }) });
  await api(t.baseUrl, '/api/backoffice/contact/phones/integrations/facebook', { method: 'PUT', headers: authHeaders(a.token), body: JSON.stringify({ mode: 'other', other_phone: { country_iso2: 'MX', national_number: '9833333333' } }) });
  await api(t.baseUrl, '/api/backoffice/contact/phones/integrations/google_business_profile', { method: 'PUT', headers: authHeaders(a.token), body: JSON.stringify({ mode: 'other', other_phone: { country_iso2: 'MX', national_number: '9832222222' } }) });
  await setPolicy(a.token, 'facebook_comment', 'gratitude', 'safe_auto_reply', { consent: true });
  await setPolicy(a.token, 'facebook_comment', 'basic_info', 'safe_auto_reply', { consent: true });
  await setPolicy(a.token, 'google_review', 'basic_info', 'safe_auto_reply', { consent: true });

  const postId = await publishedPost(a.tenant);
  const before = (await t.pool.query('SELECT status, text, external_ref, published_at FROM social_post WHERE post_id = $1', [postId])).rows[0];
  await injectComment(a.token, postId, '¡Gracias, todo estuvo muy rico!', 'fb1');
  await injectComment(a.token, postId, 'Me robaron el cambio, voy a denunciar', 'fb2');
  await injectComment(a.token, postId, '¿Cuál es su teléfono?', 'fb3');
  await injectReview(a.token, '¿Cuál es su número de teléfono?', 4, 'gq');
  await run(a.token);

  const all = await cases(a.token);
  const byRef = { fb1: one(all, 'fb1'), fb2: one(all, 'fb2'), fb3: one(all, 'fb3'), gq: one(all, 'gq') };
  assert.equal(byRef.fb1.state, 'responded');
  assert.equal(byRef.fb1.post_id, postId);
  assert.equal(byRef.fb2.state, 'needs_human');
  assert.match(byRef.fb2.reason ?? '', /risk:/);
  assert.equal(byRef.fb3.state, 'responded');
  assert.match(byRef.fb3.response_text ?? '', /\+52 983 333 3333/, 'Facebook responde con SU número');
  assert.match(byRef.gq.response_text ?? '', /\+52 983 222 2222/, 'Google responde con SU número');
  assert.ok(!/9830000000|983 000 0000/.test(byRef.fb3.response_text ?? ''));

  const after = (await t.pool.query('SELECT status, text, external_ref, published_at FROM social_post WHERE post_id = $1', [postId])).rows[0];
  assert.deepEqual(after, before, 'la publicación previa no cambia');

  // Comentario sobre una publicación inexistente o no publicada: rechazado por el simulador.
  assert.equal((await injectComment(a.token, 'post_inexistente', 'hola')).status, 404);
  console.log('TEST_PASS AG-03 Facebook simple+delicado [simulated]');
});

test('AG-04: duplicados, carrera, doble worker y reinicio sin dobles respuestas ni casos perdidos', async () => {
  const a = await newTenant('client_ag4');
  await setPolicy(a.token, 'google_review', 'gratitude', 'safe_auto_reply', { consent: true });
  assert.equal((await injectReview(a.token, 'Gracias, excelente', 5, 'dup1')).body.created, true);
  assert.equal((await injectReview(a.token, 'Gracias, excelente', 5, 'dup1')).body.created, false, 'dedupe en origen');

  // Dos workers simultáneos sobre el mismo tenant: uno procesa, el otro respeta el candado.
  const [r1, r2] = await Promise.all([
    t.handle.engagementWorker.tickTenant(a.tenant, true),
    t.handle.engagementWorker.tickTenant(a.tenant, true),
  ]);
  assert.ok(r1.skipped_locked !== r2.skipped_locked || r1.ingested.google_review + r2.ingested.google_review === 1);
  assert.equal((await cases(a.token)).length, 1, 'un caso por (tenant, origen, ref)');

  // Carrera sobre el mismo caso aprobado: solo un ganador.
  await injectReview(a.token, 'Pésimo, nunca llegó mi pedido', 1, 'race1');
  await run(a.token);
  const race = one(await cases(a.token), 'race1');
  await t.pool.query(`UPDATE engagement_case SET state = 'approved', response_text = 'Lo sentimos, escríbenos por privado.' WHERE case_id = $1`, [race.case_id]);
  const results = await Promise.all(Array.from({ length: 5 }, () => t.handle.engagement.respondCase(race.case_id)));
  assert.equal(results.filter((r) => r?.state === 'responded').length, 1);
  assert.equal((await replies(a.token)).filter((r) => r.target_ref === 'race1').length, 1);

  // Reinicio: una instancia nueva del servidor no duplica nada.
  const t2 = await bootApi();
  try {
    await t2.handle.engagementWorker.tickTenant(a.tenant, true);
    await t2.handle.engagementWorker.tickTenant(a.tenant, true);
  } finally {
    await t2.close();
  }
  assert.equal((await cases(a.token)).length, 2);
  assert.equal((await replies(a.token)).length, 2);
  console.log('TEST_PASS AG-04 dedupe/carrera/candado/reinicio');
});

test('AG-04: timeout y error del proveedor → reintentos con backoff; agotados → humano o failed con aviso', async () => {
  const a = await newTenant('client_ag4b');
  await setPolicy(a.token, 'google_review', 'gratitude', 'safe_auto_reply', { consent: true });
  await api(t.baseUrl, '/api/backoffice/dev/simulator/faults', { method: 'POST', headers: authHeaders(a.token), body: JSON.stringify({ origin: 'google_review', kind: 'timeout', count: 1 }) });
  await api(t.baseUrl, '/api/backoffice/dev/simulator/faults', { method: 'POST', headers: authHeaders(a.token), body: JSON.stringify({ origin: 'google_review', kind: 'error', count: 1 }) });
  await injectReview(a.token, 'Muchas gracias, excelente', 5, 'retry1');
  await run(a.token);
  let c = one(await cases(a.token));
  assert.equal(c.state, 'retry_pending');
  assert.equal(c.last_error, 'simulated_timeout');
  assert.ok(new Date(c.next_attempt_at ?? 0).getTime() > Date.now(), 'backoff programado');
  await run(a.token);
  assert.equal(one(await cases(a.token)).state, 'retry_pending', 'no se reintenta antes del backoff');
  await t.pool.query(`UPDATE engagement_case SET next_attempt_at = now() WHERE case_id = $1`, [c.case_id]);
  await run(a.token);
  c = one(await cases(a.token));
  assert.equal(c.state, 'retry_pending');
  assert.equal(c.last_error, 'simulated_provider_error');
  await t.pool.query(`UPDATE engagement_case SET next_attempt_at = now() WHERE case_id = $1`, [c.case_id]);
  await run(a.token);
  c = one(await cases(a.token));
  assert.equal(c.state, 'responded');
  assert.equal(c.attempts, 3);
  assert.equal((await replies(a.token)).length, 1);

  // Fallos persistentes: el automático pasa a decisión humana; el aprobado queda failed y avisa.
  await api(t.baseUrl, '/api/backoffice/dev/simulator/faults', { method: 'POST', headers: authHeaders(a.token), body: JSON.stringify({ origin: 'google_review', kind: 'error', count: 20 }) });
  await injectReview(a.token, 'Gracias, muy rico', 5, 'retry2');
  await run(a.token);
  for (let i = 0; i < 6; i += 1) {
    await t.pool.query(`UPDATE engagement_case SET next_attempt_at = now() WHERE tenant_id = $1 AND state = 'retry_pending'`, [a.tenant]);
    await run(a.token);
  }
  const escalated = one(await cases(a.token), 'retry2');
  assert.equal(escalated.state, 'needs_human');
  assert.equal(escalated.reason, 'provider_failed');
  assert.ok(escalated.drafts.length >= 1);
  await api(t.baseUrl, `/api/backoffice/engagement/cases/${escalated.case_id}/approve`, { method: 'POST', headers: authHeaders(a.token), body: '{}' });
  for (let i = 0; i < 6; i += 1) {
    await t.pool.query(`UPDATE engagement_case SET next_attempt_at = now() WHERE tenant_id = $1 AND state = 'retry_pending'`, [a.tenant]);
    await run(a.token);
  }
  const failed = one(await cases(a.token), 'retry2');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.notify_status, 'no_destination', 'sin chat: queda visible en el panel');
  assert.equal((await replies(a.token)).length, 1, 'ninguna respuesta duplicada ni inventada');
  console.log('TEST_PASS AG-04 timeout/error/backoff [simulated]');
});

test('AG-04: caída del worker a mitad de envío → recuperación sin doble respuesta (proveedor idempotente)', async () => {
  const a = await newTenant('client_ag4c');
  await setPolicy(a.token, 'google_review', 'gratitude', 'safe_auto_reply', { consent: true });
  await injectReview(a.token, 'Excelente, gracias por todo', 5, 'crash1');
  // Ingesta + clasificación, sin responder todavía: el caso queda «classified».
  await t.pool.query(`INSERT INTO sim_provider_fault (tenant_id, origin, kind, remaining) VALUES ($1, 'google_review', 'timeout', 1)`, [a.tenant]);
  await run(a.token);
  let c = one(await cases(a.token));
  // Simula: el proveedor YA recibió la respuesta y el proceso murió antes de registrar el resultado.
  await t.handle.engagement.deps.replier.reply({ tenantId: a.tenant, origin: 'google_review', targetRef: 'crash1', text: c.response_text ?? '', idempotencyKey: `engagement:${c.case_id}` });
  await t.pool.query(`UPDATE engagement_case SET state = 'responding', lease_until = now() - interval '1 minute' WHERE case_id = $1`, [c.case_id]);
  const report = await run(a.token);
  assert.equal(report.recovered, 1);
  c = one(await cases(a.token));
  assert.equal(c.state, 'responded');
  assert.equal((await replies(a.token)).length, 1, 'la recuperación reutiliza la misma respuesta (idempotency key)');
});

test('AG-04: sin chat de Telegram, fallo de envío de aviso y fallo de lectura del proveedor', async () => {
  const a = await newTenant('client_ag4d');
  const other = await newTenant('client_ag4e');
  await injectReview(a.token, 'No me gustó, llegó frío', 2, 'n1');
  const r1 = await run(a.token);
  assert.equal(r1.notifications.no_destination, 1);
  const c = one(await cases(a.token, '?state=needs_human'));
  assert.equal(c.notify_status, 'no_destination', 'el caso sigue visible y pendiente en el panel');

  const chat = 720000000 + Math.floor(Math.random() * 1e6);
  await api(t.baseUrl, '/api/backoffice/dev/simulator/faults', { method: 'POST', headers: authHeaders(a.token), body: JSON.stringify({ origin: 'telegram', kind: 'error', count: 1 }) });
  await linkTelegram(a.token, chat);
  const r2 = await run(a.token);
  assert.equal(r2.notifications.failed, 1);
  await t.pool.query(`UPDATE engagement_notification SET next_attempt_at = now() WHERE case_id = $1`, [c.case_id]);
  const r3 = await run(a.token);
  assert.equal(r3.notifications.sent, 1);
  await run(a.token);
  assert.equal(transcript().filter((m) => m.to === String(chat) && m.text.includes(c.case_id)).length, 1, 'un aviso entregado, sin duplicados');

  // Desconexión: tras desvincular, los casos nuevos quedan visibles en el panel sin destino.
  assert.equal((await api(t.baseUrl, '/api/backoffice/telegram/link', { method: 'DELETE', headers: authHeaders(a.token) })).status, 200);
  const beforeUnlinked = transcript().filter((m) => m.to === String(chat)).length;
  await injectReview(a.token, 'Me cobraron de más, quiero que me regresen el dinero', 1, 'n2');
  const r5 = await run(a.token);
  assert.equal(r5.notifications.no_destination, 1);
  assert.equal(one(await cases(a.token), 'n2').notify_status, 'no_destination');
  assert.equal(transcript().filter((m) => m.to === String(chat)).length, beforeUnlinked, 'el chat desvinculado no recibe más avisos');

  await api(t.baseUrl, '/api/backoffice/dev/simulator/faults', { method: 'POST', headers: authHeaders(a.token), body: JSON.stringify({ origin: 'google_review', kind: 'list_error', count: 1 }) });
  const r4 = await run(a.token);
  assert.deepEqual(r4.ingest_errors, ['google_review:simulated_list_error']);
  const cursor = await t.pool.query(`SELECT consecutive_failures, next_poll_at > now() AS backoff FROM engagement_cursor WHERE tenant_id = $1 AND origin = 'google_review'`, [a.tenant]);
  assert.equal(cursor.rows[0].consecutive_failures, 1);
  assert.equal(cursor.rows[0].backoff, true);
  await injectReview(other.token, 'Gracias', 5, 'iso1');
  const ro = await run(other.token);
  assert.equal(ro.ingested.google_review, 1, 'el fallo de un tenant no afecta a otro');
  assert.equal((await cases(other.token)).length, 1);
  assert.equal((await cases(a.token)).length, 2, 'aislamiento: A no ve casos de B');
});
