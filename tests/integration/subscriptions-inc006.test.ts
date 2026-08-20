/**
 * Integration — INC-006 subscriptions (CAP-012, DEC-024).
 *
 * Asignar plan (admin) → consulta de entitlements por rol → límite excedido
 * deny+audit (HTTP) → facturación de plan sin precio PROHIBITED → límite de
 * reseñas gestionadas en la ingesta (sync) → checkLimit directo (website).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApi, login, authHeaders, api, SEED, type TestApi } from '../helpers/testdb.ts';
import { EntitlementService, usageWithinLimit } from '../../src/subscriptions/entitlements.ts';
import { AuditSink } from '../../src/audit/sink.ts';
import { AppError } from '../../src/shared/errors.ts';

let t: TestApi;

before(async () => {
  t = await bootApi();
});

after(async () => {
  await t.close();
});

async function assignPlan(token: string, planId: string) {
  return api(t.baseUrl, '/api/backoffice/subscriptions/assign', {
    method: 'POST', headers: authHeaders(token), body: JSON.stringify({ plan_id: planId }),
  });
}

test('INC-006: entitlements por rol (seed: Piloto 1 sin precio) y asignación de plan por admin', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const reader = await login(t.baseUrl, SEED.a.reader.login, SEED.a.reader.password, SEED.a.tenant);

  const entitlements = await api(t.baseUrl, '/api/backoffice/subscriptions/entitlements', { headers: authHeaders(reader.token) });
  assert.equal(entitlements.status, 200);
  assert.equal(entitlements.body.entitlements.plan.plan_id, 'plan_piloto_1');
  assert.equal(entitlements.body.entitlements.plan.price_cents, null, 'plan piloto SIN precio (DEC-024)');
  assert.equal(entitlements.body.entitlements.limits.social_posts, 10);
  assert.equal(entitlements.body.entitlements.limits.reviews_managed, 20);

  // Los 3 roles leen (subscription.read); read_only NO asigna.
  for (const who of [ops, admin, reader]) {
    const res = await api(t.baseUrl, '/api/backoffice/subscriptions/entitlements', { headers: authHeaders(who.token) });
    assert.equal(res.status, 200, `entitlements por rol ${who.session.role_id}`);
  }
  const deniedAssign = await assignPlan(reader.token, 'plan_basico');
  assert.equal(deniedAssign.status, 403, 'read_only no asigna planes');

  // Admin asigna 'Básico' a client_a (upsert idempotente, sin repetir).
  const assigned = await assignPlan(admin.token, 'plan_basico');
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.entitlements.plan.plan_id, 'plan_basico');
  assert.equal(assigned.body.entitlements.limits.social_posts, 3);
  const subs = await t.pool.query('SELECT count(*) AS n FROM subscription WHERE tenant_id = $1', [SEED.a.tenant]);
  assert.equal(Number(subs.rows[0]?.n ?? 0), 1, 'una sola suscripción por tenant');
  console.log('TEST_PASS INC-006 entitlements por rol + asignación admin');

  // Auditoría sensible de asignación (fail-closed): evento allow + decision.
  const assignedEv = await t.pool.query<{ decision: string }>(
    `SELECT decision FROM audit_event WHERE tenant_id = $1 AND action = 'subscription.assigned' ORDER BY ts DESC LIMIT 1`,
    [SEED.a.tenant],
  );
  assert.equal(assignedEv.rows[0]?.decision, 'allow');
});

test('INC-006: límite excedido ⇒ deny 403 limit_exceeded + auditoría deny (social)', async () => {
  const ops = await login(t.baseUrl, SEED.b.ops.login, SEED.b.ops.password, SEED.b.tenant);
  const admin = await login(t.baseUrl, SEED.b.admin.login, SEED.b.admin.password, SEED.b.tenant);
  // client_b empieza con Piloto 1 (10 posts); asignamos Básico (3 posts).
  await assignPlan(admin.token, 'plan_basico');

  const results: number[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const res = await api(t.baseUrl, '/api/backoffice/social/posts', {
      method: 'POST', headers: authHeaders(ops.token),
      body: JSON.stringify({ text: `Post límite ${i}` }),
    });
    results.push(res.status);
  }
  assert.deepEqual(results, [201, 201, 201, 403], '3 creados, el 4º excede el límite');

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
  console.log('TEST_PASS INC-006 límite excedido → 403 limit_exceeded + audit deny');
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
  console.log('TEST_PASS INC-006 facturación sin precio PROHIBITED + audit deny');
});

test('INC-006: límite de reseñas gestionadas — lote que excede NO deja estado parcial (PR-03)', async () => {
  const admin = await login(t.baseUrl, SEED.b.admin.login, SEED.b.admin.password, SEED.b.tenant);
  const ops = await login(t.baseUrl, SEED.b.ops.login, SEED.b.ops.password, SEED.b.tenant);
  // client_b NO tiene reseñas sincronizadas todavía (la INC-004 usa client_a).
  // Creamos un plan de TEST con reviews_managed=2 (catálogo CONFIGURABLE).
  await t.pool.query(
    `INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active) VALUES
       ('plan_test_reviews', 'Plan Test Reseñas', 'Plan de test (catálogo configurable)', NULL, NULL, false, true)
     ON CONFLICT (plan_id) DO NOTHING`,
  );
  await t.pool.query(
    `INSERT INTO plan_limit (limit_id, plan_id, capability, max_value) VALUES
       ('limit_test_reviews', 'plan_test_reviews', 'reviews_managed', 2)
     ON CONFLICT (limit_id) DO NOTHING`,
  );
  await assignPlan(admin.token, 'plan_test_reviews');

  const sync = await api(t.baseUrl, '/api/backoffice/reputation/reviews/sync', {
    method: 'POST', headers: authHeaders(ops.token),
  });
  assert.equal(sync.status, 403, 'el lote (4 nuevas) excede reviews_managed=2');
  assert.equal(sync.body.error.code, 'limit_exceeded');
  // PR-03: validación ANTES de insertar ⇒ NINGUNA reseña quedó registrada.
  const reviewsB = await t.pool.query('SELECT count(*) AS n FROM review WHERE tenant_id = $1', [SEED.b.tenant]);
  assert.equal(Number(reviewsB.rows[0]?.n ?? 0), 0, 'sin estado parcial (cero reseñas insertadas)');
  const ev = await t.pool.query<{ result: string }>(
    `SELECT result FROM audit_event
     WHERE tenant_id = $1 AND action = 'access.deny' AND result = 'limit_exceeded' ORDER BY ts DESC LIMIT 1`,
    [SEED.b.tenant],
  );
  assert.ok(ev.rowCount && ev.rowCount >= 1, 'deny auditado');
  // Restaurar el plan piloto para no romper otros tests.
  await assignPlan(admin.token, 'plan_piloto_1');
  console.log('TEST_PASS PR-03 lote de reseñas que excede límite ⇒ 403 sin estado parcial');
});

test('PR-02: mensajes que exceden el límite de conversaciones ⇒ 403 limit_exceeded + audit deny', async () => {
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  // Plan de TEST con conversations=0 ⇒ el primer mensaje ya excede (límite
  // determinista independiente del uso previo del tenant).
  await t.pool.query(
    `INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active) VALUES
       ('plan_test_conv', 'Plan Test Conversaciones', 'Plan de test (catálogo configurable)', NULL, NULL, false, true)
     ON CONFLICT (plan_id) DO NOTHING`,
  );
  await t.pool.query(
    `INSERT INTO plan_limit (limit_id, plan_id, capability, max_value) VALUES
       ('limit_test_conv', 'plan_test_conv', 'conversations', 0)
     ON CONFLICT (limit_id) DO NOTHING`,
  );
  await assignPlan(admin.token, 'plan_test_conv');

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
  // El mensaje NO se procesó ni se persistió.
  const persisted = await t.pool.query(
    `SELECT count(*) AS n FROM conversation_request WHERE tenant_id = $1 AND raw_message = $2`,
    [SEED.a.tenant, 'mensaje-que-excede-el-limite'],
  );
  assert.equal(Number(persisted.rows[0]?.n ?? 0), 0, 'no se registró la solicitud');
  await assignPlan(admin.token, 'plan_piloto_1');
  console.log('TEST_PASS PR-02 límite de conversaciones en ingesta ⇒ 403 + audit deny');
});

test('PR-02: creación de sitio — política sin suscripción (deny subscription_required) y con plan (201)', async () => {
  // Fixture determinista: nuevo cliente client_c (test only, vía SQL).
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
  // Plan de test para la creación (idempotente; reutilizado por el test directo).
  await t.pool.query(
    `INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active) VALUES
       ('plan_test_web', 'Plan Test Web', 'Plan de test (catálogo configurable)', NULL, NULL, false, true)
     ON CONFLICT (plan_id) DO NOTHING`,
  );
  await t.pool.query(
    `INSERT INTO plan_limit (limit_id, plan_id, capability, max_value) VALUES
       ('limit_test_web', 'plan_test_web', 'website', 5)
     ON CONFLICT (limit_id) DO NOTHING`,
  );
  const adminC = await login(t.baseUrl, 'admin.c@example.com', 'Simula-C-Admin-2026!', 'client_c');

  // Sin suscripción/plan ⇒ 403 subscription_required (política documentada).
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

  // Con plan (website=5) ⇒ 201 creado.
  await assignPlan(adminC.token, 'plan_test_web');
  const created = await api(t.baseUrl, '/api/backoffice/website', {
    method: 'POST', headers: authHeaders(adminC.token),
    body: JSON.stringify({ slug: 'negocio-c', site_name: 'Negocio C' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.website.tenant_id, 'client_c');
  // Ya existe (UNIQUE por tenant) ⇒ 409.
  const again = await api(t.baseUrl, '/api/backoffice/website', {
    method: 'POST', headers: authHeaders(adminC.token),
    body: JSON.stringify({ slug: 'negocio-c-2', site_name: 'Negocio C 2' }),
  });
  assert.equal(again.status, 409);
  console.log('TEST_PASS PR-02 creación de sitio: sin plan 403 + con plan 201 + duplicado 409');
});

test('INC-006: checkLimit directo (website) — fail-closed y lógica pura', async () => {
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  await assignPlan(admin.token, 'plan_basico'); // website=1
  const entitlements = new EntitlementService({ pool: t.pool, sink: new AuditSink(t.pool) });
  // Uso actual de client_a: 1 sitio (seed). plan_basico website=1 ⇒ no cabe otro.
  await assert.rejects(entitlements.checkLimit(SEED.a.tenant, 'website'), (err: unknown) => {
    return err instanceof AppError && err.status === 403 && err.code === 'limit_exceeded';
  });
  // Con un plan de límite mayor sí cabe (catálogo configurable).
  await t.pool.query(
    `INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active) VALUES
       ('plan_test_web', 'Plan Test Web', 'Plan de test (catálogo configurable)', NULL, NULL, false, true)
     ON CONFLICT (plan_id) DO NOTHING`,
  );
  await t.pool.query(
    `INSERT INTO plan_limit (limit_id, plan_id, capability, max_value) VALUES
       ('limit_test_web', 'plan_test_web', 'website', 5)
     ON CONFLICT (limit_id) DO NOTHING`,
  );
  await assignPlan(admin.token, 'plan_test_web');
  await assert.doesNotReject(entitlements.checkLimit(SEED.a.tenant, 'website'));
  await assignPlan(admin.token, 'plan_piloto_1');
  // Lógica pura de límites (misma unidad que usa el servicio).
  assert.equal(usageWithinLimit(5, 1), true);
  assert.equal(usageWithinLimit(1, 1), false);
  console.log('TEST_PASS INC-006 checkLimit directo website (deny/allow configurable)');
});
