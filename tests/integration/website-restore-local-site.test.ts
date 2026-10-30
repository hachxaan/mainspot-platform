/**
 * DEV-E2E-04 (P3) — «Restaurar esta versión» y sitio local por negocio (integración, BD propia).
 *
 * Restaurar = versión NUEVA con el contenido de la elegida (historial intacto), siempre por vista
 * previa → aprobación de Administración → publicación. Guard optimista (409 stale_version),
 * idempotencia por Idempotency-Key, RBAC (Operación/Solo lectura no aprueban), aislamiento por
 * tenant y nada en vivo antes de aprobar. El despacho por Host sirve SOLO la versión publicada del
 * slug (404 para slug desconocido o sin publicar; nunca para el host del panel).
 *
 * SIMULATED_REGRESSION: el proxy HTTPS del LXC no interviene aquí (se prueba el proceso Express con
 * cabecera Host); la verificación real está en evidence/website-restore-local-sites.txt.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { bootApi, authHeaders, api, login, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows } from '../helpers/tenants.ts';
import { WebsitePublisher } from '../../src/publishing/website.ts';

const DOMAIN = 'mainspot.test';
let t: TestApi;

before(async () => {
  t = await bootApi({ localSiteDomain: DOMAIN, publicBaseUrl: `https://app.${DOMAIN}` });
});

after(async () => {
  await t.close();
});

function call(token: string, path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
  return api(t.baseUrl, `/api/backoffice${path}`, { method, headers: authHeaders(token, extra), body: body === undefined ? undefined : JSON.stringify(body) });
}

/** GET crudo con cabecera Host arbitraria (como la reenvía el vhost del LXC). */
function rawGet(path: string, host: string, method = 'GET'): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const u = new URL(t.baseUrl);
  // Executor form: el lib de TypeScript del repo no incluye Promise.withResolvers.
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path, method, headers: { Host: host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : (v ?? '');
        resolve({ status: res.statusCode ?? 0, body, headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const PASSWORD = 'Fixture-Role-2026!';
async function addUser(tenant: string, role: 'operation' | 'read_only'): Promise<string> {
  const userId = `user_${role}_${tenant}`;
  const loginName = `${role}@${tenant}.example.com`;
  await t.pool.query(
    `INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash)
     VALUES ($1, $2, $3, 'active', $4, crypt($5, gen_salt('bf', 4)))`, [userId, `Persona ${role}`, loginName, tenant, PASSWORD]);
  await t.pool.query('INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, $2, $3)', [userId, role, tenant]);
  return (await login(t.baseUrl, loginName, PASSWORD, tenant)).token;
}

interface Published { tenant: string; token: string; slug: string }

/** Negocio con página publicada en v1 (datos del alta) y v2 (horario cambiado por el chat). */
async function publishTwoVersions(slug: string, line: string): Promise<Published> {
  const { tenant, token } = await createTenantWithPlan(t, { conversations: 20, website: 1 }, 'client_rs');
  const created = await call(token, '/website', 'POST', { slug, site_name: `Negocio ${slug}`, data: { line, hours: 'Lunes a viernes: 9 a 18', services: ['Pan', 'Café'] } });
  assert.equal(created.status, 201);
  const first = await call(token, '/website/first-publication', 'POST');
  assert.equal(first.body.proposal.status, 'preview_ready');
  const pub1 = await call(token, `/conversation/proposals/${first.body.proposal.proposal_id}/approve`, 'POST');
  assert.equal(pub1.body.status, 'published');

  const msg = await call(token, '/conversation/messages', 'POST', { text: 'agrega la sección promociones a mi web', channel: 'simulated' });
  assert.equal(msg.status, 201, JSON.stringify(msg.body));
  assert.ok(msg.body.proposal_id, 'el chat propone un cambio visible');
  const conf = await call(token, `/conversation/proposals/${msg.body.proposal_id}/confirm`, 'POST');
  assert.equal(conf.body.status, 'preview_ready');
  const pub2 = await call(token, `/conversation/proposals/${msg.body.proposal_id}/approve`, 'POST');
  assert.equal(pub2.body.status, 'published');
  const site = await call(token, '/website');
  assert.equal(site.body.website.published_version, 2);
  assert.equal(site.body.versions.length, 2);
  return { tenant, token, slug };
}

test('restaurar: versión nueva con el contenido de la elegida, historial intacto, idempotente y guard optimista', async () => {
  const slug = `pan-${randomUUID().slice(0, 6)}`;
  const { tenant, token } = await publishTwoVersions(slug, 'Pan recién hecho');
  const rows = await t.pool.query<{ content_id: string; version: number; html: string; data: { sections: unknown[] } }>(
    'SELECT content_id, version, html, data FROM website_content WHERE tenant_id = $1 ORDER BY version', [tenant]);
  const [v1, v2] = rows.rows;
  assert.ok(v1 && v2);
  assert.equal(v1.data.sections.length, 0);
  assert.equal(v2.data.sections.length, 1, 'v2 tiene la sección nueva');
  assert.match(v2.html, /Promociones/);

  // Guard optimista: la versión que el cliente cree publicada no es la real ⇒ 409, sin propuesta.
  const stale = await call(token, '/website/versions/1/restore', 'POST', { expected_current_version: 1 });
  assert.deepEqual([stale.status, stale.body.error.code], [409, 'stale_version']);
  const same = await call(token, '/website/versions/2/restore', 'POST', { expected_current_version: 2 });
  assert.equal(same.status, 409, 'la versión publicada no se restaura sobre sí misma');
  const missing = await call(token, '/website/versions/9/restore', 'POST', { expected_current_version: 2 });
  assert.equal(missing.status, 404);
  const bad = await call(token, '/website/versions/1/restore', 'POST', {});
  assert.equal(bad.status, 400);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM action_proposal WHERE tenant_id = $1 AND proposal_type = 'website.restore'`, [tenant]), 0);

  // Solicitud correcta: propuesta con vista previa lista, diff «actual vs solicitada» y referencia a la fuente.
  const key = randomUUID();
  const r1 = await call(token, '/website/versions/1/restore', 'POST', { expected_current_version: 2 }, { 'Idempotency-Key': key });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal(r1.body.proposal.status, 'preview_ready');
  assert.match(r1.body.preview.url, /^\/preview\//);
  assert.deepEqual(r1.body.proposal.detail.restore.source_version, 1);
  assert.equal(r1.body.proposal.detail.restore.source_content_id, v1.content_id);
  assert.equal(r1.body.proposal.detail.restore.current_version, 2);
  assert.equal(r1.body.proposal.detail.after.sections.length, 0, 'el after es el contenido de la versión 1');
  assert.ok(r1.body.proposal.detail.patches.some((p: { field: string; before: string }) => p.field === 'site.generic' && p.before === 'Promociones'), 'el diff muestra que la sección desaparece');

  // Idempotencia: misma clave ⇒ misma propuesta; nueva solicitud para la misma versión ⇒ la abierta.
  const r1b = await call(token, '/website/versions/1/restore', 'POST', { expected_current_version: 2 }, { 'Idempotency-Key': key });
  assert.deepEqual([r1b.status, r1b.body.replayed, r1b.body.proposal.proposal_id], [200, true, r1.body.proposal.proposal_id]);
  const r1c = await call(token, '/website/versions/1/restore', 'POST', { expected_current_version: 2 });
  assert.deepEqual([r1c.status, r1c.body.proposal.proposal_id], [200, r1.body.proposal.proposal_id]);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM action_proposal WHERE tenant_id = $1 AND proposal_type = 'website.restore'`, [tenant]), 1);

  // Nada cambia en vivo antes de aprobar: la página y el sitio local siguen en v2.
  const live = await rawGet('/', `${slug}.${DOMAIN}`);
  assert.equal(live.status, 200);
  assert.match(live.body, /Promociones/);
  assert.match(live.body, /versión 2/);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM website_content WHERE tenant_id = $1', [tenant]), 2);

  // RBAC: Operación puede pedir la restauración pero NO aprobar; Solo lectura no puede ni pedirla.
  const ops = await addUser(tenant, 'operation');
  const reader = await addUser(tenant, 'read_only');
  const opsApprove = await call(ops, `/conversation/proposals/${r1.body.proposal.proposal_id}/approve`, 'POST');
  assert.equal(opsApprove.status, 403);
  const readerRestore = await call(reader, '/website/versions/1/restore', 'POST', { expected_current_version: 2 });
  assert.equal(readerRestore.status, 403);
  const readerApprove = await call(reader, `/conversation/proposals/${r1.body.proposal.proposal_id}/approve`, 'POST');
  assert.equal(readerApprove.status, 403);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM website_content WHERE tenant_id = $1', [tenant]), 2, 'sin publicación por roles sin permiso');

  // Administración aprueba ⇒ versión 3 con el contenido de la 1; v1 y v2 quedan intactas.
  const pub = await call(token, `/conversation/proposals/${r1.body.proposal.proposal_id}/approve`, 'POST');
  assert.equal(pub.body.status, 'published', JSON.stringify(pub.body));
  const after = await t.pool.query<{ content_id: string; version: number; html: string; data: { sections: unknown[] }; restored_from_version: number | null; restored_from_content_id: string | null; diff_summary: string }>(
    'SELECT content_id, version, html, data, restored_from_version, restored_from_content_id, diff_summary FROM website_content WHERE tenant_id = $1 ORDER BY version', [tenant]);
  assert.equal(after.rows.length, 3);
  assert.equal(after.rows[0]!.html, v1.html, 'v1 intacta');
  assert.equal(after.rows[1]!.html, v2.html, 'v2 intacta');
  const v3 = after.rows[2]!;
  assert.equal(v3.version, 3);
  assert.equal(v3.restored_from_version, 1);
  assert.equal(v3.restored_from_content_id, v1.content_id);
  assert.equal(v3.data.sections.length, 0);
  assert.equal(v3.html, v1.html.replace('versión 1', 'versión 3'), 'mismo contenido que v1, nuevo número de versión');
  assert.match(v3.diff_summary, /Volver a la versión 1/);
  const site = await call(token, '/website');
  assert.equal(site.body.website.published_version, 3);
  assert.equal(site.body.versions[0].restored_from_version, 1);
  assert.equal(site.body.versions[0].restorable, true);
  assert.equal(site.body.local_site.hostname, `${slug}.${DOMAIN}`);
  assert.equal(site.body.local_site.provisioned, false, 'el proceso web no provisiona: lo registra el comando de operación');
  const liveAfter = await rawGet('/', `${slug}.${DOMAIN}`);
  assert.doesNotMatch(liveAfter.body, /Promociones/);
  assert.match(liveAfter.body, /versión 3/);

  // Repetir aprobación o la misma clave tras publicar: nada se duplica.
  const again = await call(token, `/conversation/proposals/${r1.body.proposal.proposal_id}/approve`, 'POST');
  assert.equal(again.body.already_published, true);
  const replay = await call(token, '/website/versions/1/restore', 'POST', { expected_current_version: 3 }, { 'Idempotency-Key': key });
  assert.deepEqual([replay.status, replay.body.replayed, replay.body.proposal.status], [200, true, 'published']);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM website_content WHERE tenant_id = $1', [tenant]), 3);

  // Auditoría: solicitud y publicación registradas, sin tokens.
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'website.restore.requested'`, [tenant]), 1);
  assert.ok(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'conversation.published' AND result = 'published_v3'`, [tenant]) >= 1);
});

test('restaurar: una propuesta preparada sobre una versión que ya cambió no se publica a ciegas (409) y el publicador no deja éxito ficticio', async () => {
  const slug = `cafe-${randomUUID().slice(0, 6)}`;
  const { tenant, token } = await publishTwoVersions(slug, 'Café de olla');
  const r = await call(token, '/website/versions/1/restore', 'POST', { expected_current_version: 2 });
  assert.equal(r.status, 201);

  // Mientras tanto se publica otra versión (teléfono de la página) ⇒ v3.
  await call(token, '/contact/phones/integrations/website', 'PUT', { mode: 'other', other_phone: { country_iso2: 'MX', national_number: '9831111111' } });
  const ph = await call(token, '/website/phone-publication', 'POST');
  assert.equal(ph.status, 201, JSON.stringify(ph.body));
  const pubPhone = await call(token, `/conversation/proposals/${ph.body.proposal.proposal_id}/approve`, 'POST');
  assert.equal(pubPhone.body.status, 'published');

  // La restauración pendiente ya no es segura: 409 recuperable, propuesta sin marcar como fallida.
  const approve = await call(token, `/conversation/proposals/${r.body.proposal.proposal_id}/approve`, 'POST');
  assert.deepEqual([approve.status, approve.body.error.code], [409, 'stale_version']);
  const st = await call(token, `/conversation/proposals/${r.body.proposal.proposal_id}`);
  assert.equal(st.body.proposal.status, 'preview_ready');
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM website_content WHERE tenant_id = $1', [tenant]), 3);

  // Backstop transaccional del publicador (carrera entre la comprobación y la escritura): sin fila ni éxito.
  const publisher = new WebsitePublisher(t.pool);
  await assert.rejects(publisher.publish({ tenantId: tenant, proposalId: r.body.proposal.proposal_id, proposalType: 'website.restore', payload: r.body.proposal.detail }),
    (err: unknown) => err instanceof Error && 'status' in err && err.status === 409);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM website_content WHERE tenant_id = $1', [tenant]), 3);
  const site = await call(token, '/website');
  assert.equal(site.body.website.published_version, 3);

  // Descartar y pedir de nuevo con la versión vigente ⇒ v4 con el contenido de la 1.
  await call(token, `/conversation/proposals/${r.body.proposal.proposal_id}/reject`, 'POST');
  const r2 = await call(token, '/website/versions/1/restore', 'POST', { expected_current_version: 3 });
  assert.equal(r2.status, 201);
  const pub = await call(token, `/conversation/proposals/${r2.body.proposal.proposal_id}/approve`, 'POST');
  assert.equal(pub.body.status, 'published');
  const v4 = await t.pool.query<{ data: { phone: string; sections: unknown[] }; restored_from_version: number }>(
    'SELECT data, restored_from_version FROM website_content WHERE tenant_id = $1 AND version = 4', [tenant]);
  assert.equal(v4.rows[0]?.restored_from_version, 1);
  assert.equal(v4.rows[0]?.data.sections.length, 0);
  assert.equal(v4.rows[0]?.data.phone, '+52 983 111 1111', 'el teléfono sigue saliendo de «Teléfonos de contacto», no de la versión antigua');
});

test('restaurar: aislamiento por tenant — las versiones de otro negocio no se ven ni se restauran', async () => {
  const slugA = `a-${randomUUID().slice(0, 6)}`;
  const a = await publishTwoVersions(slugA, 'Negocio A');
  const { tenant: tenantB, token: tokenB } = await createTenantWithPlan(t, { conversations: 5, website: 1 }, 'client_rs');
  const noSite = await call(tokenB, '/website/versions/1/restore', 'POST', { expected_current_version: 2 });
  assert.deepEqual([noSite.status, noSite.body.error.code], [409, 'website_missing']);

  const slugB = `b-${randomUUID().slice(0, 6)}`;
  await call(tokenB, '/website', 'POST', { slug: slugB, site_name: 'Negocio B', data: { line: 'Negocio B' } });
  const firstB = await call(tokenB, '/website/first-publication', 'POST');
  await call(tokenB, `/conversation/proposals/${firstB.body.proposal.proposal_id}/approve`, 'POST');
  // B solo tiene v1: la v2 de A no existe para B (misma respuesta que una versión inexistente).
  const cross = await call(tokenB, '/website/versions/2/restore', 'POST', { expected_current_version: 1 });
  assert.equal(cross.status, 404);
  const listB = await call(tokenB, '/website');
  assert.equal(listB.body.versions.length, 1);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM action_proposal WHERE tenant_id = $1 AND proposal_type = 'website.restore'`, [tenantB]), 0);
  // La propuesta de restauración de A no es visible para B.
  const rA = await call(a.token, '/website/versions/1/restore', 'POST', { expected_current_version: 2 });
  const seenByB = await call(tokenB, `/conversation/proposals/${rA.body.proposal.proposal_id}`);
  assert.equal(seenByB.status, 404);
  const approveByB = await call(tokenB, `/conversation/proposals/${rA.body.proposal.proposal_id}/approve`, 'POST');
  assert.equal(approveByB.status, 404);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM website_content WHERE tenant_id = $1', [a.tenant]), 2);

  // Cada hostname sirve solo su negocio.
  const siteA = await rawGet('/', `${slugA}.${DOMAIN}`);
  const siteB = await rawGet('/', `${slugB}.${DOMAIN}`);
  assert.match(siteA.body, /Negocio A/);
  assert.doesNotMatch(siteA.body, /Negocio B/);
  assert.match(siteB.body, /Negocio B/);
  assert.doesNotMatch(siteB.body, /Negocio A/);
});

test('sitio local por Host: publicada vs sin publicar vs desconocida; nunca para el panel; sin API bajo el host del sitio', async () => {
  const slug = `host-${randomUUID().slice(0, 6)}`;
  const { tenant, token } = await createTenantWithPlan(t, { conversations: 5, website: 1 }, 'client_rs');
  await call(token, '/website', 'POST', { slug, site_name: 'Taquería Host', data: { line: 'Tacos al pastor' } });

  // Sitio creado pero sin publicar ⇒ 404 (ningún borrador llega al sitio).
  const draft = await rawGet('/', `${slug}.${DOMAIN}`);
  assert.equal(draft.status, 404);
  assert.doesNotMatch(draft.body, /Tacos al pastor/);

  const first = await call(token, '/website/first-publication', 'POST');
  await call(token, `/conversation/proposals/${first.body.proposal.proposal_id}/approve`, 'POST');
  const live = await rawGet('/', `${slug}.${DOMAIN}`);
  assert.equal(live.status, 200);
  assert.match(live.headers['content-type'] ?? '', /text\/html/);
  assert.equal(live.headers['cache-control'], 'no-store');
  assert.match(live.headers['content-security-policy'] ?? '', /default-src 'self'/);
  assert.match(live.body, /Taquería Host/);
  assert.match(live.body, /Tacos al pastor/);
  assert.match(live.body, /versión 1/);
  const head = await rawGet('/', `${slug}.${DOMAIN}`, 'HEAD');
  assert.equal(head.status, 200);
  const upper = await rawGet('/', `${slug.toUpperCase()}.${DOMAIN}:443`);
  assert.equal(upper.status, 200, 'host insensible a mayúsculas y con puerto');

  // Bajo el host del sitio no existe la API ni el panel.
  const apiUnderSite = await rawGet('/api/backoffice/website', `${slug}.${DOMAIN}`);
  assert.equal(apiUnderSite.status, 404);
  const healthUnderSite = await rawGet('/health', `${slug}.${DOMAIN}`);
  assert.equal(healthUnderSite.status, 404);
  const postUnderSite = await rawGet('/', `${slug}.${DOMAIN}`, 'POST');
  assert.equal(postUnderSite.status, 404);

  // Slug desconocido, etiqueta reservada y host del panel.
  const unknown = await rawGet('/', `no-existe-${randomUUID().slice(0, 6)}.${DOMAIN}`);
  assert.equal(unknown.status, 404);
  assert.match(unknown.body, /no está publicada o no existe/);
  const panelHost = await rawGet('/health', `app.${DOMAIN}`);
  assert.equal(panelHost.status, 200);
  assert.match(panelHost.body, /"ok":true/);
  const otherHost = await rawGet('/health', 'localhost');
  assert.equal(otherHost.status, 200);
  const nested = await rawGet('/', `x.${slug}.${DOMAIN}`);
  assert.equal(nested.status, 200, 'un sub-subdominio no es un slug: sigue al panel (/ = shell)');
  assert.doesNotMatch(nested.body, /Tacos al pastor/);

  // Suspendido ⇒ 404 aunque tenga versión publicada.
  await t.pool.query(`UPDATE client_website SET status = 'suspended' WHERE tenant_id = $1`, [tenant]);
  const suspended = await rawGet('/', `${slug}.${DOMAIN}`);
  assert.equal(suspended.status, 404);
});
