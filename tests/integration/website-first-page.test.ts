/**
 * DEV-E2E-03 — negocio nuevo sin página y teléfono de la Página web (integración).
 *
 * Regresión: antes, un cambio web sobre un negocio sin `client_website` llegaba a vista previa y
 * al aprobar respondía 502 `client_website_not_found` dejando la propuesta en `failed`. Ahora:
 * el chat orienta a crear la página, la aprobación responde 409 recuperable, la primera versión
 * se prepara una sola vez (aun con solicitudes simultáneas) y el número nuevo de la web se publica
 * solo tras vista previa y aprobación.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApi, authHeaders, api, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows } from '../helpers/tenants.ts';

let t: TestApi;

before(async () => {
  t = await bootApi();
});

after(async () => {
  await t.close();
});

function call(token: string, path: string, method = 'GET', body?: unknown) {
  return api(t.baseUrl, `/api/backoffice${path}`, { method, headers: authHeaders(token), body: body === undefined ? undefined : JSON.stringify(body) });
}

test('sin página: el chat no crea propuesta, la primera versión pide crearla y una propuesta previa no se marca fallida', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { conversations: 10, website: 1 }, 'client_fp');
  const msg = await call(token, '/conversation/messages', 'POST', { text: 'El horario es de 09:00 a 18:00', channel: 'simulated' });
  assert.equal(msg.status, 201);
  assert.equal(msg.body.proposal_id, null);
  assert.match(msg.body.reply, /Todavía no tienes página/);
  const first = await call(token, '/website/first-publication', 'POST');
  assert.deepEqual([first.status, first.body.error.code], [409, 'website_missing']);

  // Propuesta creada antes de este cambio (sitio inexistente): aprobar es un 409 recuperable.
  await t.pool.query(
    `INSERT INTO conversation_request (request_id, tenant_id, actor_id, channel, raw_message, intent, capability_target, action_class, status, response_message, proposal_id)
     VALUES ('req_legacy_${tenant}', $1, 'user_${tenant}', 'simulated', 'horario', 'website.edit', 'website', 'preview_required', 'awaiting_confirmation', NULL, 'prop_legacy_${tenant}')`, [tenant]);
  await t.pool.query(
    `INSERT INTO action_proposal (proposal_id, tenant_id, request_id, capability_target, proposal_type, action_class, summary, detail, status, created_by)
     VALUES ('prop_legacy_${tenant}', $1, 'req_legacy_${tenant}', 'website', 'website.edit', 'preview_required', 'Cambiar el horario.', '{"after":{"name":"x"}}', 'preview_ready', 'user_${tenant}')`, [tenant]);
  const approve = await call(token, `/conversation/proposals/prop_legacy_${tenant}/approve`, 'POST');
  assert.deepEqual([approve.status, approve.body.error.code], [409, 'website_missing']);
  const st = await t.pool.query<{ status: string }>(`SELECT status FROM action_proposal WHERE proposal_id = $1`, [`prop_legacy_${tenant}`]);
  assert.equal(st.rows[0]?.status, 'preview_ready', 'la propuesta sigue lista para cuando exista la página');
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM publication WHERE tenant_id = $1', [tenant]), 0);
});

test('primera página: datos del alta, una sola propuesta con solicitudes simultáneas y publicación tras aprobar', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { conversations: 10, website: 1 }, 'client_fp');
  const created = await call(token, '/website', 'POST', {
    slug: tenant.replaceAll('_', '-'), site_name: 'Panadería Prueba',
    data: { line: 'Pan recién hecho', address: 'Calle 1', hours: 'Lunes a viernes: 7:00 a 20:00', services: ['Pan dulce', 'Pan dulce', 'Café'] },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.website.data.services, ['Pan dulce', 'Café']);
  const withPhone = await call(token, '/website', 'POST', { slug: 'otro', site_name: 'X', data: { phone: '+52 983 000 0000' } });
  assert.equal(withPhone.status, 400, 'el teléfono de la página no se edita por aquí (una sola fuente: Teléfonos)');

  const both = await Promise.all([call(token, '/website/first-publication', 'POST'), call(token, '/website/first-publication', 'POST')]);
  assert.ok(both.every((r) => r.status === 200 || r.status === 201), JSON.stringify(both.map((r) => r.status)));
  assert.equal(both[0]!.body.proposal.proposal_id, both[1]!.body.proposal.proposal_id);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM action_proposal WHERE tenant_id = $1 AND proposal_type = 'website.initial'`, [tenant]), 1);
  const id = both[0]!.body.proposal.proposal_id as string;
  const ready = await call(token, `/conversation/proposals/${id}`);
  assert.equal(ready.body.proposal.status, 'preview_ready');
  assert.equal(ready.body.proposal.detail.after.line, 'Pan recién hecho');

  const pub = await call(token, `/conversation/proposals/${id}/approve`, 'POST');
  assert.equal(pub.body.status, 'published');
  const site = await call(token, '/website');
  assert.equal(site.body.website.published_version, 1);
  assert.equal(site.body.versions.length, 1);
  const again = await call(token, '/website/first-publication', 'POST');
  assert.deepEqual([again.status, again.body.error.code], [409, 'already_published']);
});

test('teléfono de la Página web: vista previa con el número efectivo, reemplazo si cambia y publicación solo tras aprobar', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { conversations: 10, website: 1 }, 'client_fp');
  await call(token, '/website', 'POST', { slug: tenant.replaceAll('_', '-'), site_name: 'Taller' });
  const first = await call(token, '/website/first-publication', 'POST');
  const early = await call(token, '/website/phone-publication', 'POST');
  assert.equal(early.status, 409, 'sin página publicada la primera versión ya usará el número');
  await call(token, `/conversation/proposals/${first.body.proposal.proposal_id}/approve`, 'POST');

  await call(token, '/contact/phones/integrations/website', 'PUT', { mode: 'other', other_phone: { country_iso2: 'MX', national_number: '9831111111' } });
  const p1 = await call(token, '/website/phone-publication', 'POST');
  assert.equal(p1.status, 201);
  assert.equal(p1.body.proposal.detail.after.phone, '+52 983 111 1111');
  const p1again = await call(token, '/website/phone-publication', 'POST');
  assert.equal(p1again.body.proposal.proposal_id, p1.body.proposal.proposal_id, 'mismo número → misma propuesta');

  await call(token, '/contact/phones/integrations/website', 'PUT', { mode: 'other', other_phone: { country_iso2: 'MX', national_number: '9832222222' } });
  const p2 = await call(token, '/website/phone-publication', 'POST');
  assert.notEqual(p2.body.proposal.proposal_id, p1.body.proposal.proposal_id);
  const old = await call(token, `/conversation/proposals/${p1.body.proposal.proposal_id}`);
  assert.equal(old.body.proposal.status, 'rejected', 'la vista previa con el número anterior se descarta');

  const before = await call(token, '/website');
  assert.notEqual(before.body.website.data.phone, '+52 983 222 2222', 'nada cambia antes de aprobar');
  await call(token, `/conversation/proposals/${p2.body.proposal.proposal_id}/approve`, 'POST');
  const afterPub = await call(token, '/website');
  assert.equal(afterPub.body.website.data.phone, '+52 983 222 2222');
  const none = await call(token, '/website/phone-publication', 'POST');
  assert.equal(none.status, 409, 'la página ya muestra ese número');
});
