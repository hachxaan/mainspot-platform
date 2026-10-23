/**
 * Integration — INC-007 base analytics (CAP-014 base, DEC-025).
 *
 * Export ETL JSON/CSV paginado CON aislamiento por tenant, retención en
 * DRY-RUN que NO borra (y purga real solo con dry_run=false), y agregados
 * diarios básicos (source of truth = audit_event).
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

test('INC-007: export ETL por tenant aísla (no filtra datos de otro cliente)', async () => {
  const adminA = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const adminB = await login(t.baseUrl, SEED.b.admin.login, SEED.b.admin.password, SEED.b.tenant);
  // Generar eventos en client_a.
  await api(t.baseUrl, '/api/backoffice/data', { headers: authHeaders(adminA.token) });

  const expA = await api(t.baseUrl, `/api/backoffice/analytics/export?format=json`, { headers: authHeaders(adminA.token) });
  assert.equal(expA.status, 200);
  assert.equal(expA.body.tenant_id, SEED.a.tenant);
  assert.ok(Array.isArray(expA.body.events));
  assert.ok(expA.body.events.length >= 1, 'export no vacío');

  const expB = await api(t.baseUrl, `/api/backoffice/analytics/export?format=json`, { headers: authHeaders(adminB.token) });
  assert.equal(expB.status, 200);
  const tenantIds = new Set((expB.body.events as Array<{ tenant_id: string }>).map((e) => e.tenant_id));
  assert.deepEqual([...tenantIds], [SEED.b.tenant], 'eventos SOLO del cliente B');
  // Aislamiento cruzado: client_a nunca ve tenant de B (ni viceversa).
  const tenantAIds = new Set((expA.body.events as Array<{ tenant_id: string }>).map((e) => e.tenant_id));
  assert.ok(![...tenantAIds].includes(SEED.b.tenant), 'client_a no ve eventos de client_b');
  console.log('TEST_PASS INC-007 export aísla por tenant');
});

test('INC-007: export JSON paginado + CSV con filtro por acción', async () => {
  const adminA = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  // Asegurar varios eventos de data.read (cada GET autenticado genera uno).
  for (let i = 0; i < 3; i += 1) {
    await api(t.baseUrl, '/api/backoffice/data', { headers: authHeaders(adminA.token) });
  }

  const p1 = await api(t.baseUrl, '/api/backoffice/analytics/export?page=1&page_size=2', { headers: authHeaders(adminA.token) });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.page, 1);
  assert.equal(p1.body.page_size, 2);
  assert.equal(p1.body.events.length, 2);
  assert.equal(p1.body.has_more, true, 'hay más páginas');

  const p2 = await api(t.baseUrl, '/api/backoffice/analytics/export?page=2&page_size=2', { headers: authHeaders(adminA.token) });
  assert.equal(p2.status, 200);
  assert.equal(p2.body.page, 2);
  assert.equal(p2.body.events.length, 2);
  const ids1 = new Set((p1.body.events as Array<{ event_id: string }>).map((e) => e.event_id));
  const ids2 = new Set((p2.body.events as Array<{ event_id: string }>).map((e) => e.event_id));
  for (const id of ids1) assert.ok(!ids2.has(id), 'sin solapamiento entre páginas');

  const csvRes = await fetch(`${t.baseUrl}/api/backoffice/analytics/export?format=csv&action=data.read`, {
    headers: authHeaders(adminA.token),
  });
  assert.equal(csvRes.status, 200);
  const csvText = await csvRes.text();
  assert.ok(csvText.startsWith('event_id,ts,tenant_id'), 'CSV con header');
  assert.ok(csvText.includes(SEED.a.tenant), 'CSV contiene su tenant');
  assert.ok(!csvText.includes(SEED.b.tenant), 'CSV NO contiene otro tenant');
  const filterMissing = await api(t.baseUrl, '/api/backoffice/analytics/export?action=no_existe', { headers: authHeaders(adminA.token) });
  assert.equal(filterMissing.body.total, 0);
  console.log('TEST_PASS INC-007 export paginado + CSV + filtro por acción');
});

test('QS-0006: la retención es automática; el tenant solo ve una vista previa sin efectos', async () => {
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const before = await t.pool.query<{ n: string }>('SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1', [SEED.a.tenant]);
  const preview = await api(t.baseUrl, '/api/backoffice/analytics/retention', { headers: authHeaders(admin.token) });
  assert.equal(preview.status, 200);
  assert.deepEqual([preview.body.policy.conversationContent.interval, preview.body.policy.auditEvents.interval], ['90 days', '2 years']);
  assert.equal(typeof preview.body.pending.conversations, 'number');
  const after = await t.pool.query<{ n: string }>('SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1', [SEED.a.tenant]);
  assert.ok(Number(after.rows[0]?.n) >= Number(before.rows[0]?.n), 'la vista previa no borra nada');
  const removed = await api(t.baseUrl, '/api/backoffice/analytics/purge', {
    method: 'POST', headers: authHeaders(admin.token), body: JSON.stringify({ dry_run: false }),
  });
  assert.equal(removed.status, 404, 'la purga manual ya no existe (DEC-0025)');
});

test('INC-007: agregados diarios básicos (count por acción) y refresh del resumen', async () => {
  const opsA = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  await api(t.baseUrl, '/api/backoffice/data', { headers: authHeaders(opsA.token) }); // data.read

  const summary = await api(t.baseUrl, '/api/backoffice/analytics/summary', { headers: authHeaders(opsA.token) });
  assert.equal(summary.status, 200);
  const dataRead = (summary.body.daily as Array<{ action: string; count: number }>).find((r) => r.action === 'data.read');
  assert.ok(dataRead && dataRead.count >= 1, 'agregado de data.read >= 1');

  const refresh = await api(t.baseUrl, '/api/backoffice/analytics/refresh-summary', { method: 'POST', headers: authHeaders(admin.token) });
  assert.equal(refresh.status, 200);
  assert.ok(refresh.body.upserted >= 1, 'resumen materializado (upsert idempotente)');
  const stored = await t.pool.query(
    `SELECT count(*) AS n FROM analytics_daily_summary WHERE tenant_id = $1 AND action = 'data.read'`,
    [SEED.a.tenant],
  );
  assert.equal(Number(stored.rows[0]?.n ?? 0), 1, 'una fila agregada para data.read (día, acción, resultado)');
  // Refresh repetido NO duplica la fila de (tenant, day, action, result) — ON CONFLICT actualiza.
  await api(t.baseUrl, '/api/backoffice/analytics/refresh-summary', { method: 'POST', headers: authHeaders(admin.token) });
  const n2 = await t.pool.query(
    `SELECT count(*) AS n FROM analytics_daily_summary WHERE tenant_id = $1 AND action = 'data.read'`,
    [SEED.a.tenant],
  );
  assert.equal(Number(n2.rows[0]?.n ?? 0), 1, 'refresh idempotente (sin filas duplicadas)');
  console.log('TEST_PASS INC-007 agregados diarios + refresh idempotente');
});
