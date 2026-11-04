/**
 * Integration — INC-006 subscriptions (CAP-012, DEC-024) sobre el catálogo versionado (DEC-0075).
 *
 * Entitlements por rol (solo lectura, con uso) → el negocio ya NO se asigna planes (403 auditado) →
 * asignación de Administration fijada a la revisión publicada con historial → límite excedido
 * deny+audit (HTTP) → facturación de plan sin precio PROHIBITED → límite de reseñas gestionadas en la
 * ingesta (sync) → conversaciones → sitio sin suscripción. La atomicidad del consumo (DEC-0005) está en
 * quota-toctou.test.ts; el mantenimiento del catálogo en plan-catalog.test.ts.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApi, login, authHeaders, api, SEED, type TestApi } from '../helpers/testdb.ts';
import { createPublishedPlan, setTenantPlan } from '../helpers/plans.ts';
import { SubscriptionAssignment } from '../../src/plans/assignment.ts';

let t: TestApi;

before(async () => {
  t = await bootApi();
});

after(async () => {
  await t.close();
});

const PLATFORM_ACTOR = { platformUserId: 'pu_test_admin', login: 'admin-test', roles: ['platform_admin'], requestId: 'req_inc006' };

test('INC-006: entitlements por rol (Piloto 1 sin precio, con uso); el negocio no se asigna planes; Administration sí, fijado y con historial', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const reader = await login(t.baseUrl, SEED.a.reader.login, SEED.a.reader.password, SEED.a.tenant);

  const entitlements = await api(t.baseUrl, '/api/backoffice/subscriptions/entitlements', { headers: authHeaders(reader.token) });
  assert.equal(entitlements.status, 200);
  const view = entitlements.body.entitlements;
  assert.equal(view.plan.plan_id, 'plan_piloto_1');
  assert.equal(view.plan.price_cents, null, 'plan piloto SIN precio (DEC-024)');
  assert.equal(view.revision.version, 1, 'fijado a la revisión 1 del backfill');
  assert.deepEqual(view.limits, { website: 1, social_posts: 10, social_ads: 5, reviews_managed: 20, conversations: 500, agents: 5 },
    'valores vigentes del 0009 explicitados sin cambios');
  assert.equal(typeof view.usage.social_posts, 'number', 'el panel recibe el uso que cuenta para el límite');

  for (const who of [ops, admin, reader]) {
    const res = await api(t.baseUrl, '/api/backoffice/subscriptions/entitlements', { headers: authHeaders(who.token) });
    assert.equal(res.status, 200, `entitlements por rol ${who.session.role_id}`);
    // SRC-0013: la autoasignación del negocio está retirada para TODOS los roles (también administration).
    const assign = await api(t.baseUrl, '/api/backoffice/subscriptions/assign', {
      method: 'POST', headers: authHeaders(who.token), body: JSON.stringify({ plan_id: 'plan_completo' }),
    });
    assert.deepEqual([assign.status, assign.body.error?.code], [403, 'permission_denied'], `el rol ${who.session.role_id} no asigna planes`);
  }
  const still = await t.pool.query<{ plan_id: string }>('SELECT plan_id FROM subscription WHERE tenant_id = $1', [SEED.a.tenant]);
  assert.equal(still.rows[0]?.plan_id, 'plan_piloto_1', 'el intento del negocio no cambió nada');
  const denied = await t.pool.query(`SELECT 1 FROM audit_event WHERE tenant_id = $1 AND action = 'access.deny' AND result = 'permission_denied' AND resource LIKE '%/subscriptions/assign'`, [SEED.a.tenant]);
  assert.ok((denied.rowCount ?? 0) >= 3, 'cada intento quedó auditado como deny');

  // Administration asigna Básico: fija su revisión publicada; historial con actor y motivo.
  const assignment = new SubscriptionAssignment({ pool: t.pool, sink: t.handle.sink });
  const out = await assignment.assign({ tenantId: SEED.a.tenant, planId: 'plan_basico', reason: 'Prueba de asignación de Administration', actor: PLATFORM_ACTOR });
  assert.equal(out.changed, true);
  assert.equal(out.subscription.plan_revision_id, 'prv_plan_basico_v1');
  const after1 = await api(t.baseUrl, '/api/backoffice/subscriptions/entitlements', { headers: authHeaders(ops.token) });
  assert.equal(after1.body.entitlements.limits.social_posts, 3);
  const hist = await t.pool.query<{ change_kind: string; actor: string; reason: string; previous_plan_id: string }>(
    'SELECT change_kind, actor, reason, previous_plan_id FROM subscription_history WHERE tenant_id = $1 ORDER BY changed_at DESC LIMIT 1', [SEED.a.tenant]);
  assert.deepEqual(hist.rows[0], { change_kind: 'plan_change', actor: 'platform:pu_test_admin', reason: 'Prueba de asignación de Administration', previous_plan_id: 'plan_piloto_1' });
  const ev = await t.pool.query<{ decision: string }>(`SELECT decision FROM audit_event WHERE tenant_id = $1 AND action = 'subscription.plan_assigned' ORDER BY ts DESC LIMIT 1`, [SEED.a.tenant]);
  assert.equal(ev.rows[0]?.decision, 'allow', 'el negocio ve la asignación en su auditoría');
  // Repetir la misma asignación no crea otra fila de historial.
  assert.equal((await assignment.assign({ tenantId: SEED.a.tenant, planId: 'plan_basico', reason: 'Repetición sin cambios', actor: PLATFORM_ACTOR })).changed, false);
  await assignment.assign({ tenantId: SEED.a.tenant, planId: 'plan_piloto_1', reason: 'Restaurar plan piloto del seed', actor: PLATFORM_ACTOR });
});

test('INC-006: Administration no asigna planes deshabilitados ni borradores (también por SQL directo)', async () => {
  const disabled = `plan_off_${randomUUID().slice(0, 6)}`;
  await createPublishedPlan(t.pool, disabled, { social_posts: 1 }, { enabled: false });
  const assignment = new SubscriptionAssignment({ pool: t.pool, sink: t.handle.sink });
  await assert.rejects(assignment.assign({ tenantId: SEED.b.tenant, planId: disabled, reason: 'Intento con plan deshabilitado', actor: PLATFORM_ACTOR }),
    (err: Error & { status?: number }) => err.status === 409);
  await assert.rejects(setTenantPlan(t.pool, SEED.b.tenant, disabled), /not assignable/, 'el trigger lo impide aunque se salte el servicio');
  const sub = await t.pool.query<{ plan_id: string }>('SELECT plan_id FROM subscription WHERE tenant_id = $1', [SEED.b.tenant]);
  assert.equal(sub.rows[0]?.plan_id, 'plan_piloto_1');
});

test('INC-006: límite excedido ⇒ deny 403 limit_exceeded + auditoría deny (social)', async () => {
  const ops = await login(t.baseUrl, SEED.b.ops.login, SEED.b.ops.password, SEED.b.tenant);
  // client_b empieza con Piloto 1 (10 posts); Administration asigna Básico (3 posts).
  await setTenantPlan(t.pool, SEED.b.tenant, 'plan_basico');

  const results: number[] = [];
  let lastMessage = '';
  for (let i = 1; i <= 4; i += 1) {
    const res = await api(t.baseUrl, '/api/backoffice/social/posts', {
      method: 'POST', headers: authHeaders(ops.token),
      body: JSON.stringify({ text: `Post límite ${i}` }),
    });
    results.push(res.status);
    lastMessage = res.body?.error?.message ?? '';
  }
  assert.deepEqual(results, [201, 201, 201, 403], '3 creados, el 4º excede el límite');
  assert.match(lastMessage, /3 de 3 publicaciones en toda la suscripción/, 'el mensaje dice uso, máximo, unidad y periodo reales');

  const denyEv = await t.pool.query<{ result: string; decision: string }>(
    `SELECT result, decision FROM audit_event
     WHERE tenant_id = $1 AND action = 'access.deny' AND result = 'limit_exceeded'
     ORDER BY ts DESC LIMIT 1`,
    [SEED.b.tenant],
  );
  assert.ok(denyEv.rowCount && denyEv.rowCount >= 1, 'límite auditado como deny/limit_exceeded');
  assert.equal(denyEv.rows[0]?.decision, 'deny');

  const posts4 = await t.pool.query(
    `SELECT count(*) AS n FROM social_post WHERE tenant_id = $1 AND text LIKE 'Post límite %'`,
    [SEED.b.tenant],
  );
  assert.equal(Number(posts4.rows[0]?.n ?? 0), 3, 'solo quedaron los 3 permitidos');
});

test('INC-006: facturar un plan SIN precio es PROHIBITED (piloto sin cobro)', async () => {
  const admin = await login(t.baseUrl, SEED.b.admin.login, SEED.b.admin.password, SEED.b.tenant);
  // client_b tiene plan_basico (sin precio) tras el test anterior.
  const invoice = await api(t.baseUrl, '/api/backoffice/subscriptions/invoice', {
    method: 'POST', headers: authHeaders(admin.token),
    body: JSON.stringify({}),
  });
  assert.equal(invoice.status, 403);
  assert.equal(invoice.body.error.code, 'prohibited');
  const ev = await t.pool.query<{ decision: string; result: string }>(
    `SELECT decision, result FROM audit_event
     WHERE tenant_id = $1 AND action = 'subscription.invoice' ORDER BY ts DESC LIMIT 1`,
    [SEED.b.tenant],
  );
  assert.equal(ev.rows[0]?.decision, 'deny');
  assert.equal(ev.rows[0]?.result, 'no_price_prohibited');
});

test('INC-006: límite de reseñas gestionadas — lote que excede NO deja estado parcial (PR-03)', async () => {
  const ops = await login(t.baseUrl, SEED.b.ops.login, SEED.b.ops.password, SEED.b.tenant);
  // client_b NO tiene reseñas sincronizadas todavía (la INC-004 usa client_a).
  const plan = `plan_test_reviews_${randomUUID().slice(0, 6)}`;
  await createPublishedPlan(t.pool, plan, { reviews_managed: 2 });
  await setTenantPlan(t.pool, SEED.b.tenant, plan);

  const sync = await api(t.baseUrl, '/api/backoffice/reputation/reviews/sync', {
    method: 'POST', headers: authHeaders(ops.token),
  });
  assert.equal(sync.status, 403, 'el lote (4 nuevas) excede reviews_managed=2');
  assert.equal(sync.body.error.code, 'limit_exceeded');
  const reviewsB = await t.pool.query('SELECT count(*) AS n FROM review WHERE tenant_id = $1', [SEED.b.tenant]);
  assert.equal(Number(reviewsB.rows[0]?.n ?? 0), 0, 'sin estado parcial (cero reseñas insertadas)');
  const ev = await t.pool.query<{ result: string }>(
    `SELECT result FROM audit_event
     WHERE tenant_id = $1 AND action = 'access.deny' AND result = 'limit_exceeded' ORDER BY ts DESC LIMIT 1`,
    [SEED.b.tenant],
  );
  assert.ok(ev.rowCount && ev.rowCount >= 1, 'deny auditado');
  await setTenantPlan(t.pool, SEED.b.tenant, 'plan_piloto_1');
});

test('PR-02: mensajes que exceden el límite de conversaciones ⇒ 403 limit_exceeded + audit deny', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  // conversations=0 ⇒ el primer mensaje ya excede (determinista, independiente del uso previo).
  const plan = `plan_test_conv_${randomUUID().slice(0, 6)}`;
  await createPublishedPlan(t.pool, plan, { conversations: 0 });
  await setTenantPlan(t.pool, SEED.a.tenant, plan);

  const msg = await api(t.baseUrl, '/api/backoffice/conversation/messages', {
    method: 'POST', headers: authHeaders(ops.token),
    body: JSON.stringify({ text: 'mensaje-que-excede-el-limite', channel: 'simulated' }),
  });
  assert.equal(msg.status, 403, 'ingesta denegada por límite de conversaciones');
  assert.equal(msg.body.error.code, 'limit_exceeded');
  const denyEv = await t.pool.query<{ result: string; decision: string }>(
    `SELECT result, decision FROM audit_event
     WHERE tenant_id = $1 AND action = 'access.deny' AND result = 'limit_exceeded'
     ORDER BY ts DESC LIMIT 1`,
    [SEED.a.tenant],
  );
  assert.ok(denyEv.rowCount && denyEv.rowCount >= 1, 'deny auditado');
  assert.equal(denyEv.rows[0]?.decision, 'deny');
  const persisted = await t.pool.query(
    `SELECT count(*) AS n FROM conversation_request WHERE tenant_id = $1 AND raw_message = $2`,
    [SEED.a.tenant, 'mensaje-que-excede-el-limite'],
  );
  assert.equal(Number(persisted.rows[0]?.n ?? 0), 0, 'no se registró la solicitud');
  await setTenantPlan(t.pool, SEED.a.tenant, 'plan_piloto_1');
});

test('PR-02: creación de sitio — sin suscripción (deny subscription_required), con plan (201) y techo 1 por negocio', async () => {
  await t.pool.query(
    `INSERT INTO client (client_id, business_name, status, contact_email, metadata) VALUES
       ('client_c', 'Negocio C de prueba', 'active', 'contacto.c@example.com', '{}')
     ON CONFLICT (client_id) DO NOTHING`,
  );
  await t.pool.query(
    `INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash) VALUES
       ('user_c_admin', 'Carolina Admin C', 'admin.c@example.com', 'active', 'client_c', crypt('Simula-C-Admin-2026!', gen_salt('bf', 10)))
     ON CONFLICT (user_id) DO NOTHING`,
  );
  await t.pool.query(
    `INSERT INTO user_role (user_id, role_id, tenant_id) VALUES
       ('user_c_admin', 'administration', 'client_c')
     ON CONFLICT (user_id, role_id, tenant_id) DO NOTHING`,
  );
  const adminC = await login(t.baseUrl, 'admin.c@example.com', 'Simula-C-Admin-2026!', 'client_c');

  const noPlan = await api(t.baseUrl, '/api/backoffice/website', {
    method: 'POST', headers: authHeaders(adminC.token),
    body: JSON.stringify({ slug: 'negocio-c', site_name: 'Negocio C' }),
  });
  assert.equal(noPlan.status, 403);
  assert.equal(noPlan.body.error.code, 'subscription_required');
  const denyAudit = await t.pool.query(
    `SELECT result FROM audit_event WHERE tenant_id = $1 AND action = 'access.deny' AND result = 'subscription_required'
     ORDER BY ts DESC LIMIT 1`,
    ['client_c'],
  );
  assert.ok(denyAudit.rowCount === 1, 'deny auditado');
  const stillNoSite = await t.pool.query('SELECT count(*) AS n FROM client_website WHERE tenant_id = $1', ['client_c']);
  assert.equal(Number(stillNoSite.rows[0]?.n ?? 0), 0, 'no se creó sitio sin plan');

  const plan = `plan_test_web_${randomUUID().slice(0, 6)}`;
  await createPublishedPlan(t.pool, plan, { website: 1 });
  await setTenantPlan(t.pool, 'client_c', plan);
  const created = await api(t.baseUrl, '/api/backoffice/website', {
    method: 'POST', headers: authHeaders(adminC.token),
    body: JSON.stringify({ slug: 'negocio-c', site_name: 'Negocio C' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.website.tenant_id, 'client_c');
  // Techo técnico 1 (UNIQUE por negocio, registro): la segunda página ya no cabe en el límite.
  const again = await api(t.baseUrl, '/api/backoffice/website', {
    method: 'POST', headers: authHeaders(adminC.token),
    body: JSON.stringify({ slug: 'negocio-c-2', site_name: 'Negocio C 2' }),
  });
  assert.deepEqual([again.status, again.body.error?.code], [403, 'limit_exceeded']);
  await assert.rejects(createPublishedPlan(t.pool, `plan_web5_${randomUUID().slice(0, 6)}`, { website: 5 }), /outside \[0, 1\]/,
    'un plan no puede prometer más páginas que el techo técnico');
});
