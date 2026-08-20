/**
 * INC-003 — página web administrable + dominio subdominio simulado (integración).
 * Cubre REQ-012 (edición asistida → preview → aprobación → publicación),
 * REQ-018/FLOW-006 (provisión de subdominio simulada e idempotente),
 * RULE-003 (publicación solo tras aprobación) y denegación sin permiso.
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

async function sendMsg(token: string, text: string) {
  return api(t.baseUrl, '/api/backoffice/conversation/messages', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ text, channel: 'simulated' }),
  });
}

test('INC-003: el sitio del tenant existe en BD con datos de negocio (seed)', async () => {
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const res = await api(t.baseUrl, '/api/backoffice/website', { headers: authHeaders(admin.token) });
  assert.equal(res.status, 200);
  assert.equal(res.body.website.slug, 'el-sol');
  assert.equal(res.body.website.site_name, 'Restaurante El Sol');
  assert.ok(res.body.website.published_version >= 1, 'sitio con al menos v1 publicada');
  assert.equal(res.body.website.data.phone, '+51 999 111 222');
  console.log('TEST_PASS INC-003 seeded client website available with business data');
});

test('INC-003: edición asistida → preview → aprobación → publicación (REQ-012, RULE-003)', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);

  // 1) Instrucción en lenguaje natural → propuesta con diff conceptual.
  // (usa una sección única: la suite conversacional ya publicó "Servicios")
  const r = await sendMsg(ops.token, 'agrega la sección promociones a mi web');
  assert.equal(r.body.request.action_class, 'preview_required');
  const proposalId = r.body.proposal_id as string;
  assert.match(r.body.response, /Agregar la sección "Promociones"/);

  // 2) Sin aprobación NO se publica (RULE-003).
  const siteBefore = await t.pool.query<{ v: number }>('SELECT published_version AS v FROM client_website WHERE tenant_id = $1', [SEED.a.tenant]);
  const versionBefore = Number(siteBefore.rows[0]?.v ?? 0);

  // 3) Confirmar → preview_ready con token.
  const conf = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/confirm`, {
    method: 'POST', headers: authHeaders(ops.token),
  });
  assert.equal(conf.body.status, 'preview_ready');
  const previewUrl = conf.body.preview.url as string;

  // 4) El preview público renderiza el sitio propuesto (INC-003 sitio estático).
  const preview = await fetch(`${t.baseUrl}${previewUrl}`);
  const html = await preview.text();
  assert.ok(html.includes('Vista previa'), 'banner de vista previa presente');
  assert.ok(html.includes('Promociones'), 'sección propuesta visible en el render');
  assert.ok(!/(versión\s+\d)/.test(html), 'el preview no muestra una versión publicada');

  // 5) Aprobar → publicación exactamente UNA vez + versión incrementada.
  const approved = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'published');
  assert.match(approved.body.publication.external_ref, /el-sol\.sim\.mainspot\.local/, 'subdominio simulado provisto al publicar (FLOW-006)');

  const site = await t.pool.query<{ published_version: number; data: { sections?: Array<{ title: string }> } }>(
    'SELECT published_version, data FROM client_website WHERE tenant_id = $1', [SEED.a.tenant],
  );
  assert.equal(Number(site.rows[0]?.published_version ?? 0), versionBefore + 1, 'versión publicada incrementada en 1');
  const sections = site.rows[0]?.data?.sections ?? [];
  assert.equal(sections.some((s) => s.title === 'Promociones'), true, 'sección persistida en la data del sitio');

  const wc = await t.pool.query('SELECT version, html FROM website_content WHERE tenant_id = $1 AND version = $2', [SEED.a.tenant, versionBefore + 1]);
  assert.equal(wc.rowCount, 1, 'website_content de la nueva versión guardada');

  // 6) Idempotencia: repetir aprobación no duplica.
  const again = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  assert.equal(again.body.already_published, true);
  const versions = await t.pool.query('SELECT count(*) AS n FROM website_content WHERE tenant_id = $1', [SEED.a.tenant]);
  assert.equal(Number(versions.rows[0]?.n ?? 0) >= 2, true, 'versiones acumuladas pero no duplicadas');
  console.log('TEST_PASS INC-003 assisted edit -> preview -> approve -> publish once (versioned)');
});

test('INC-003: FLOW-006 provisión de subdominio simulada e idempotente (Hostinger simulated, DEC-019/026)', async () => {
  // client_b no es tocado por los tests conversacionales ⇒ fixture limpio.
  const adminB = await login(t.baseUrl, SEED.b.admin.login, SEED.b.admin.password, SEED.b.tenant);

  const first = await api(t.baseUrl, '/api/backoffice/website/provision', {
    method: 'POST', headers: authHeaders(adminB.token),
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.already_provisioned, false);
  assert.equal(first.body.domain.subdomain, 'la-luna.sim.mainspot.local', 'subdominio determinista del slug del cliente');
  assert.equal(first.body.domain.provider, 'simulated');
  assert.equal(first.body.domain.status, 'active', 'DNS + certificado provistos (simulado)');
  assert.equal(first.body.domain.cert_info.simulated, true);

  // Idempotente: repetir NO duplica y NO falla.
  const second = await api(t.baseUrl, '/api/backoffice/website/provision', {
    method: 'POST', headers: authHeaders(adminB.token),
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.already_provisioned, true);
  const rows = await t.pool.query('SELECT count(*) AS n FROM client_domain WHERE tenant_id = $1', [SEED.b.tenant]);
  assert.equal(Number(rows.rows[0]?.n ?? 0), 1, 'una sola fila de dominio');

  const audit = await t.pool.query(
    `SELECT result FROM audit_event WHERE tenant_id = $1 AND action = 'website.provisioned' AND result = 'already_provisioned' ORDER BY ts DESC LIMIT 1`,
    [SEED.b.tenant],
  );
  assert.ok(audit.rowCount === 1, 'segunda provisión auditada como already_provisioned');
  console.log('TEST_PASS FLOW-006 simulated subdomain provision is deterministic + idempotent + audited');
});

test('INC-003: denegación sin permiso (read_only no publica ni aprovisiona; 403 auditado)', async () => {
  const reader = await login(t.baseUrl, SEED.a.reader.login, SEED.a.reader.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);

  // read_only no puede aprovisionar.
  const prov = await api(t.baseUrl, '/api/backoffice/website/provision', {
    method: 'POST', headers: authHeaders(reader.token),
  });
  assert.equal(prov.status, 403);

  // read_only no puede aprobar una propuesta de su tenant.
  const r = await sendMsg(admin.token, 'cambia el teléfono a +51 111 222 333');
  const pid = r.body.proposal_id as string;
  const approve = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${pid}/approve`, {
    method: 'POST', headers: authHeaders(reader.token),
  });
  assert.equal(approve.status, 403);

  const denies = await t.pool.query(
    `SELECT action, result FROM audit_event WHERE tenant_id = $1 AND actor_id = 'user_a_reader' AND action = 'access.deny' ORDER BY ts DESC LIMIT 2`,
    [SEED.a.tenant],
  );
  assert.ok((denies.rowCount ?? 0) >= 2, 'denegaciones auditadas');
  console.log('TEST_PASS INC-003 deny without permission (reader) audited for provision + approve');
});

test('INC-003: publicación solo tras aprobación — una propuesta confirmada no cambia la versión publicada', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);

  const before = await t.pool.query('SELECT published_version AS v FROM client_website WHERE tenant_id = $1', [SEED.a.tenant]);
  const r = await sendMsg(ops.token, 'cambia la dirección a Av. Nueva 999');
  assert.equal(r.body.request.action_class, 'preview_required');
  const pid = r.body.proposal_id as string;
  await api(t.baseUrl, `/api/backoffice/conversation/proposals/${pid}/confirm`, { method: 'POST', headers: authHeaders(ops.token) });

  const after = await t.pool.query('SELECT published_version AS v FROM client_website WHERE tenant_id = $1', [SEED.a.tenant]);
  assert.equal(Number(after.rows[0]?.v ?? 0), Number(before.rows[0]?.v ?? 0), 'confirmado ≠ publicado');
  console.log('TEST_PASS INC-003 confirmed preview does NOT change published site (RULE-003)');
});
