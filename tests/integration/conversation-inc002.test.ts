/**
 * INC-002 — flujo conversacional con preview y aprobación humana (integración).
 * Cubre AC-004 (sensible), AC-005 (consulta sin efecto), AC-006 (confirmación
 * detallada previa al preview), AC-007 (publicación idempotente desde preview
 * aprobado), anti-oráculo entre tenants y denegación sin permiso.
 * La BD es recreada por scripts/test-prep.ts (fixtures 2 tenants deterministas).
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

async function sendMsg(token: string, text: string, channel = 'simulated') {
  return api(t.baseUrl, '/api/backoffice/conversation/messages', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ text, channel }),
  });
}

async function lastAudit(tenantId: string, action: string) {
  const res = await t.pool.query(
    `SELECT * FROM audit_event WHERE tenant_id = $1 AND action = $2 ORDER BY ts DESC LIMIT 1`,
    [tenantId, action],
  );
  return res.rows[0] as Record<string, unknown> | undefined;
}

test('AC-005: consulta de solo lectura responde sin approval gate ni efectos externos', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);

  const siteBefore = await t.pool.query('SELECT count(*) AS n FROM website_content WHERE tenant_id = $1', [SEED.a.tenant]);
  const reqCount = await t.pool.query('SELECT count(*) AS n FROM conversation_request WHERE tenant_id = $1', [SEED.a.tenant]);

  const res = await sendMsg(ops.token, '¿cuál es el teléfono de mi negocio?');
  assert.equal(res.status, 201, 'read-only query is answered');
  assert.equal(res.body.request.action_class, 'read_only');
  assert.match(res.body.response, /\+51 999 111 222/, 'responde con el dato autorizado');
  assert.equal(res.body.proposal_id, null, 'sin propuesta');
  assert.equal(res.body.request.status, 'answered');

  // Sin efectos externos: no hay propuestas, publicaciones ni contenido nuevo.
  const proposals = await t.pool.query('SELECT count(*) AS n FROM action_proposal WHERE tenant_id = $1', [SEED.a.tenant]);
  assert.equal(Number(proposals.rows[0]?.n ?? 0), 0);
  const siteAfter = await t.pool.query('SELECT count(*) AS n FROM website_content WHERE tenant_id = $1', [SEED.a.tenant]);
  assert.equal(Number(siteAfter.rows[0]?.n ?? 0), Number(siteBefore.rows[0]?.n ?? 0), 'sin escrituras de sitio');
  const pubs = await t.pool.query('SELECT count(*) AS n FROM publication WHERE tenant_id = $1', [SEED.a.tenant]);
  assert.equal(Number(pubs.rows[0]?.n ?? 0), 0, 'sin publicaciones');

  // Evento de clasificación auditado con request_id correlacionado (REQ-009).
  const cls = await lastAudit(SEED.a.tenant, 'conversation.classified');
  assert.ok(cls, 'classification event exists');
  assert.equal(cls.decision, 'allow');
  assert.ok(String(cls.result).includes('query.read_only'), 'result identifica intent');
  const req = res.body.request.request_id as string;
  const correlated = await t.pool.query(
    'SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND request_id = $2',
    [SEED.a.tenant, req],
  );
  assert.ok(Number(correlated.rows[0]?.n ?? 0) >= 3, 'received+classified+answered correlados por request_id');
  console.log('TEST_PASS AC-005 read-only answered without approval gate, no effect, correlated audit');
});

test('AC-006: cambio visible genera confirmación detallada y estado awaiting_confirmation', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);

  const before = await t.pool.query('SELECT published_version AS v FROM client_website WHERE tenant_id = $1', [SEED.a.tenant]);
  const res = await sendMsg(ops.token, 'necesito cambiar el teléfono a +51 999 888 777');
  assert.equal(res.status, 201);
  assert.equal(res.body.request.action_class, 'preview_required');
  const proposalId = res.body.proposal_id as string;
  assert.ok(proposalId, 'propuesta creada');

  const prop = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}`, { headers: authHeaders(ops.token) });
  assert.equal(prop.status, 200);
  assert.equal(prop.body.proposal.status, 'awaiting_confirmation');
  assert.equal(prop.body.proposal.action_class, 'preview_required');
  // Confirmación detallada (AC-006): diff conceptual en lenguaje claro.
  assert.match(res.body.response, /confirmes estos cambios/i);
  assert.match(res.body.response, /Cambiar el teléfono de \+51 999 111 222 a \+51 999 888 777/, 'diff conceptual con before/after');

  // Aún NO hay publicación (nada visible cambió todavía).
  const after = await t.pool.query('SELECT published_version AS v FROM client_website WHERE tenant_id = $1', [SEED.a.tenant]);
  assert.equal(Number(after.rows[0]?.v ?? 0), Number(before.rows[0]?.v ?? 0), 'published_version unchanged before approval');
  console.log('TEST_PASS AC-006 visible change -> detailed confirmation + awaiting_confirmation');
});

test('AC-007: preview → aprobación → publicado UNA vez; repetir aprobación no duplica', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);

  const res = await sendMsg(ops.token, 'agrega la sección servicios a mi web');
  assert.equal(res.status, 201);
  const proposalId = res.body.proposal_id as string;

  // Confirmar → preview_ready + enlace seguro.
  const confirmed = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/confirm`, {
    method: 'POST',
    headers: authHeaders(ops.token),
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, 'preview_ready');
  assert.ok(confirmed.body.preview.url.startsWith('/preview/pv_'), 'enlace seguro con token');

  // El preview público muestra el cambio y el botón de aplicar.
  const previewPage = await fetch(`${t.baseUrl}${confirmed.body.preview.url}`);
  assert.equal(previewPage.status, 200);
  const html = await previewPage.text();
  assert.ok(html.includes('Agregar la sección'), 'preview muestra diff');
  assert.ok(html.includes('Aplicar cambios'), 'botón aplicar presente');

  // Aprobar (operador autorizado) → publicado.
  const approved = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST',
    headers: authHeaders(admin.token),
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'published');
  assert.equal(approved.body.already_published, false);

  // IDEMPOTENCIA (AC-007): repetir la aprobación NO duplica la publicación.
  const pubs1 = await t.pool.query(
    'SELECT count(*) AS n FROM publication WHERE proposal_id = $1 AND tenant_id = $2',
    [proposalId, SEED.a.tenant],
  );
  assert.equal(Number(pubs1.rows[0]?.n ?? 0), 1, 'una sola publicación');

  const again = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST',
    headers: authHeaders(admin.token),
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.already_published, true, 'replay identificado');
  const pubs2 = await t.pool.query(
    'SELECT count(*) AS n FROM publication WHERE proposal_id = $1 AND tenant_id = $2',
    [proposalId, SEED.a.tenant],
  );
  assert.equal(Number(pubs2.rows[0]?.n ?? 0), 1, 'sigue siendo UNA publicación');
  const replayAudit = await lastAudit(SEED.a.tenant, 'conversation.publish_attempt');
  assert.equal(replayAudit?.result, 'already_published');

  // Rechazo/expiración no publica (probado abajo en su propio caso).
  const wc = await t.pool.query(
    'SELECT version, html FROM website_content WHERE tenant_id = $1 AND proposal_id = $2 ORDER BY version DESC LIMIT 1',
    [SEED.a.tenant, proposalId],
  );
  assert.equal(Number(wc.rows[0]?.version ?? 0), 2, 'versión 2 del sitio publicada');
  assert.ok(String(wc.rows[0]?.html ?? '').includes('Servicios'), 'sección publicada');
  console.log('TEST_PASS AC-007 publish once via approved preview; replay does not duplicate');
});

test('AC-007 EXT: rechazo no publica y expiración marca expired', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);

  // Rechazo.
  const r = await sendMsg(ops.token, 'cambia el horario a 10:00-20:00');
  const rejId = r.body.proposal_id as string;
  await api(t.baseUrl, `/api/backoffice/conversation/proposals/${rejId}/confirm`, { method: 'POST', headers: authHeaders(ops.token) });
  const rejected = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${rejId}/reject`, {
    method: 'POST',
    headers: authHeaders(admin.token),
  });
  assert.equal(rejected.body.status, 'rejected');
  let pubs = await t.pool.query('SELECT count(*) AS n FROM publication WHERE proposal_id = $1', [rejId]);
  assert.equal(Number(pubs.rows[0]?.n ?? 0), 0, 'rechazada ⇒ sin publicar');
  const rejAgain = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${rejId}/reject`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  assert.equal(rejAgain.body.status, 'rejected', 'reject idempotente');

  // Expiración del token (simulada forzando expires_at en BD).
  const r2 = await sendMsg(ops.token, 'cambia el nombre a Restaurante La Terraza');
  const expId = r2.body.proposal_id as string;
  const conf = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${expId}/confirm`, { method: 'POST', headers: authHeaders(ops.token) });
  const token = String(conf.body.preview.url).replace('/preview/', '');
  await t.pool.query(
    'UPDATE preview_session SET expires_at = now() - interval \'1 hour\' WHERE proposal_id = $1',
    [expId],
  );
  const page = await fetch(`${t.baseUrl}/preview/${token}`);
  assert.equal(page.status, 410, 'preview expirado no permite aplicar');
  const pageHtml = await page.text();
  assert.ok(pageHtml.includes('expiró'), 'mensaje claro de expiración');
  const applyExpired = await api(t.baseUrl, `/preview/${token}/apply`, { method: 'POST' });
  assert.equal(applyExpired.status, 410);
  const propAfter = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${expId}`, { headers: authHeaders(admin.token) });
  assert.equal(propAfter.body.proposal.status, 'expired', 'proposal → expired');
  pubs = await t.pool.query('SELECT count(*) AS n FROM publication WHERE proposal_id = $1', [expId]);
  assert.equal(Number(pubs.rows[0]?.n ?? 0), 0, 'expirada ⇒ sin publicar');
  console.log('TEST_PASS AC-007 rejection/expiry never publish; expired token is rejected');
});

test('AC-004: solicitud sensible queda bloqueada sin aprobación y se audita', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);

  const res = await sendMsg(ops.token, 'quiero un descuento del 10% para un cliente');
  assert.equal(res.status, 201);
  assert.equal(res.body.request.action_class, 'human_approval_required');
  assert.equal(res.body.request.status, 'needs_approval');
  const proposalId = res.body.proposal_id as string;
  assert.ok(proposalId, 'borrador de escalamiento creado');

  const prop = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}`, { headers: authHeaders(admin.token) });
  assert.equal(prop.body.proposal.status, 'drafted', 'borrador sin aprobar');

  // Sin aprobación ⇒ sin publicación.
  let pubs = await t.pool.query('SELECT count(*) AS n FROM publication WHERE proposal_id = $1', [proposalId]);
  assert.equal(Number(pubs.rows[0]?.n ?? 0), 0);

  // Aprobación humana → publicado UNA vez.
  const approved = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'published');
  pubs = await t.pool.query('SELECT count(*) AS n FROM publication WHERE proposal_id = $1', [proposalId]);
  assert.equal(Number(pubs.rows[0]?.n ?? 0), 1);

  const again = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  assert.equal(again.body.already_published, true);
  const likelyApprove = await lastAudit(SEED.a.tenant, 'conversation.approved');
  assert.ok(likelyApprove, 'aprobación auditable');
  console.log('TEST_PASS AC-004 sensitive request blocked (human_approval_required) until explicit human approval');
});

test('AC-004/RULE-005: inventar precios queda bloqueado y auditado (prohibited)', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const beforePubs = await t.pool.query('SELECT count(*) AS n FROM publication WHERE tenant_id = $1', [SEED.a.tenant]);
  const res = await sendMsg(ops.token, 'inventa un precio de 20 soles para el menú');
  assert.equal(res.status, 201);
  assert.equal(res.body.request.action_class, 'prohibited');
  assert.equal(res.body.request.status, 'blocked');
  assert.equal(res.body.proposal_id, null, 'sin propuesta para acciones prohibidas');
  assert.match(res.body.response, /No puedo inventar precios/i);

  const denyAudit = await t.pool.query(
    `SELECT * FROM audit_event WHERE tenant_id = $1 AND action = 'conversation.prohibited' ORDER BY ts DESC LIMIT 1`,
    [SEED.a.tenant],
  );
  const ev = denyAudit.rows[0] as Record<string, unknown> | undefined;
  assert.ok(ev, 'evento de bloqueo auditado');
  assert.equal(ev.decision, 'deny');
  assert.equal(ev.result, 'prohibited');
  const afterPubs = await t.pool.query('SELECT count(*) AS n FROM publication WHERE tenant_id = $1', [SEED.a.tenant]);
  assert.equal(Number(afterPubs.rows[0]?.n ?? 0), Number(beforePubs.rows[0]?.n ?? 0), 'la solicitud prohibida no creó publicaciones');
  console.log('TEST_PASS AC-004/RULE-005 price invention blocked and audited (deny/prohibited)');
});

test('INC-001 invariants: cross-tenant ops on a proposal are anti-oracle 404 + no leak', async () => {
  const adminA = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const adminB = await login(t.baseUrl, SEED.b.admin.login, SEED.b.admin.password, SEED.b.tenant);
  // Crear propuesta en tenant A.
  const r = await sendMsg(adminA.token, 'cambia el email a otra@example.com');
  const propA = r.body.proposal_id as string;

  // Tenant B intenta leer/aprobar (debe verse idéntico a inexistente).
  const readB = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${propA}`, { headers: authHeaders(adminB.token) });
  assert.equal(readB.status, 404);
  const approveB = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${propA}/approve`, {
    method: 'POST', headers: authHeaders(adminB.token),
  });
  assert.equal(approveB.status, 404, 'aprobación cross-tenant bloqueada como no encontrada');
  const fict = await api(t.baseUrl, `/api/backoffice/conversation/proposals/does_not_exist`, { headers: authHeaders(adminB.token) });
  assert.equal(fict.status, 404);
  assert.equal(fict.body.error.code, readB.body.error.code, 'mismo body anti-oráculo');

  const pubs = await t.pool.query('SELECT count(*) AS n FROM publication WHERE proposal_id = $1', [propA]);
  assert.equal(Number(pubs.rows[0]?.n ?? 0), 0, 'tenant B no publicó nada en tenant A');
  console.log('TEST_PASS cross-tenant proposal access -> identical 404, no publication');
});

test('read_only profile: can read conversation state but not send/confirm/approve (403 audited)', async () => {
  const reader = await login(t.baseUrl, SEED.a.reader.login, SEED.a.reader.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);

  const list = await api(t.baseUrl, '/api/backoffice/conversation/proposals', { headers: authHeaders(reader.token) });
  assert.equal(list.status, 200, 'reader puede ver estado conversacional (conversation.read)');

  const send = await sendMsg(reader.token, 'cambia el teléfono');
  assert.equal(send.status, 403, 'reader no puede enviar (conversation.send)');

  // reader intenta aprobar una propuesta existente de su tenant.
  const r = await sendMsg(admin.token, 'cambia el teléfono a +51 000 000 001');
  const pid = r.body.proposal_id as string;
  const approve = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${pid}/approve`, {
    method: 'POST', headers: authHeaders(reader.token),
  });
  assert.equal(approve.status, 403, 'reader no aprobar');
  const denyEv = await t.pool.query(
    `SELECT * FROM audit_event WHERE tenant_id = $1 AND actor_id = $2 AND action = 'access.deny' ORDER BY ts DESC LIMIT 1`,
    [SEED.a.tenant, 'user_a_reader'],
  );
  const ev = denyEv.rows[0] as Record<string, unknown> | undefined;
  assert.ok(ev, 'denegación auditada');
  assert.equal(ev.actor_role, 'read_only');
  console.log('TEST_PASS read_only: conversation.read allowed, send/approve denied + audited');
});
