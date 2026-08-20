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

test('INC-006: límite de reseñas gestionadas en la ingesta (reviews_managed)', async () => {
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  // La integración INC-004 ya sincronizó 4 reseñas en client_a. Creamos un plan
  // de TEST con límite reviews_managed=2 (catálogo CONFIGURABLE, DEC-024).
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
  assert.equal(sync.status, 403, 'la ingesta excede reviews_managed del plan de test');
  assert.equal(sync.body.error.code, 'limit_exceeded');
  const ev = await t.pool.query<{ result: string }>(
    `SELECT result FROM audit_event
     WHERE tenant_id = $1 AND action = 'access.deny' AND result = 'limit_exceeded' ORDER BY ts DESC LIMIT 1`,
    [SEED.a.tenant],
  );
  assert.ok(ev.rowCount && ev.rowCount >= 1, 'deny auditado');
  // Restaurar el plan piloto para no romper otros tests.
  await assignPlan(admin.token, 'plan_piloto_1');
  console.log('TEST_PASS INC-006 reviews_managed limit deny en la ingesta');
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
