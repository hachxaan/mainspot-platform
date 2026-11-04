/**
 * AC06 (DEC-0075, SRC-0013) — semánticas del libro de cuotas sobre una BD DESECHABLE propia
 * (`mainspot_plancat_sem_<hex>`, mismo servidor y credenciales que TEST_DATABASE_URL; se borra al final):
 *  - periódica: ciclo mensual UTC anclado al inicio de la suscripción; solo cuentan las unidades del ciclo;
 *  - ventana móvil (3600 s): solo cuentan las unidades confirmadas dentro de la ventana; reabre al salir;
 *  - stock: cuentan los recursos activos; archivar libera y reactivar vuelve a comprobar el límite;
 *  - elegibilidad: true pasa; false o ausente ⇒ 403 prohibited;
 *  - comunes: deny 403 sin rastro en el libro (lo audita la frontera), replay sin consumo, un fallo de
 *    `create` no consume, reserva viva cuenta y vencida/liberada no, concurrencia real con varias
 *    conexiones, aislamiento entre negocios, sin suscripción activa ⇒ subscription_required y suscripción
 *    fijada a una revisión SUPERSEDED con sus propios valores.
 * Los parámetros de prueba existen solo en esta BD y en el registro inyectado al libro: el producto no
 * tiene parámetros periódicos, de ventana, de stock ni de elegibilidad (SRC-0013, «Mecanismo sin activar»).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations } from '../../scripts/migrate.ts';
import { AuditSink } from '../../src/audit/sink.ts';
import { runAtomic } from '../../src/conversation/state-machine.ts';
import { loadPinnedPolicy } from '../../src/plans/policy.ts';
import {
  PLAN_PARAMETERS,
  definitionRow,
  type CapabilityName,
  type ParameterPeriod,
  type ParameterSemantics,
  type ParameterValue,
  type PlanParameterDefinition,
} from '../../src/plans/registry.ts';
import { config } from '../../src/shared/config.ts';
import { AppError } from '../../src/shared/errors.ts';
import { QuotaLedger, type CapacityStatus, type QuotaClaim, type QuotaRequest } from '../../src/subscriptions/quota.ts';

const { Pool } = pg;

const DB_NAME = `mainspot_plancat_sem_${randomBytes(6).toString('hex')}`;
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
/** Operaciones simultáneas de las pruebas de concurrencia, cada una en su propia conexión y transacción. */
const PARALLEL = 12;

function databaseUrl(database: string): string {
  const url = new URL(config.testDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function testDefinition(
  key: string, capability: string | null, semantics: ParameterSemantics,
  extra: { period?: ParameterPeriod; usageSql?: string } = {},
): PlanParameterDefinition {
  const bool = semantics === 'eligibility';
  return {
    key, capability, category: 'Pruebas del mecanismo', label: `Prueba ${key}`,
    description: 'Parámetro de prueba del libro de cuotas (no es un parámetro del producto).',
    unit: bool ? 'función' : 'unidades', valueType: bool ? 'bool' : 'int', semantics, period: extra.period ?? { kind: 'none' },
    min: 0, max: bool ? 1 : 1000, ceilingReason: 'Techo de prueba.', suggested: bool ? false : 0, suggestedReason: 'Prueba.',
    enforcement: { state: 'enforced', points: [], note: 'Solo pruebas.' }, usageSql: extra.usageSql ?? null, sortOrder: 900,
  };
}

const CAP = { periodic: 'sem_periodic', window: 'sem_window', stock: 'sem_stock', late: 'sem_late' } as const;
const PERIODIC = testDefinition('test.periodic_units.max', CAP.periodic, 'periodic', { period: { kind: 'subscription_month' } });
const WINDOW = testDefinition('test.window_units.max', CAP.window, 'rate_window', { period: { kind: 'sliding_window', seconds: 3600 } });
const STOCK = testDefinition('test.stock_items.max', CAP.stock, 'stock', {
  usageSql: 'SELECT count(*) AS n FROM sem_stock_item WHERE tenant_id = $1 AND archived_at IS NULL',
});
const FEATURE_ON = testDefinition('test.feature_on.enabled', null, 'eligibility');
const FEATURE_OFF = testDefinition('test.feature_off.enabled', null, 'eligibility');
/** Añadidos DESPUÉS de publicar el plan principal: su revisión no los define (ausencia ⇒ deny). */
const LATE_FEATURE = testDefinition('test.late_feature.enabled', null, 'eligibility');
const LATE_UNITS = testDefinition('test.late_units.max', CAP.late, 'periodic', { period: { kind: 'subscription_month' } });
const EARLY = [PERIODIC, WINDOW, STOCK, FEATURE_ON, FEATURE_OFF];
const LATE = [LATE_FEATURE, LATE_UNITS];
const ALL_DEFINITIONS: readonly PlanParameterDefinition[] = [...PLAN_PARAMETERS, ...EARLY, ...LATE];

const LIMIT = 3; // periódica y ventana móvil del plan principal
const STOCK_LIMIT = 2;
const MAIN_PLAN = 'plan_sem_main';

let admin: pg.Pool | undefined;
let pool: pg.Pool;
let ledger: QuotaLedger;

before(async () => {
  admin = new Pool({ connectionString: databaseUrl('postgres'), max: 1 });
  await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  await applyMigrations(databaseUrl(DB_NAME), MIGRATIONS_DIR);
  pool = new Pool({ connectionString: databaseUrl(DB_NAME), max: PARALLEL + 8 });
  await pool.query(`CREATE TABLE sem_stock_item (
    item_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES client(client_id) ON DELETE RESTRICT,
    archived_at TIMESTAMPTZ)`);
  for (const def of EARLY) await mirrorDefinition(def);
  await publishRevision(MAIN_PLAN, 1, planValues([...PLAN_PARAMETERS, ...EARLY], {
    [PERIODIC.key]: LIMIT, [WINDOW.key]: LIMIT, [STOCK.key]: STOCK_LIMIT, [FEATURE_ON.key]: true, [FEATURE_OFF.key]: false,
  }));
  for (const def of LATE) await mirrorDefinition(def);
  ledger = new QuotaLedger({ pool, sink: new AuditSink(pool), definitions: ALL_DEFINITIONS });
});

after(async () => {
  await pool?.end().catch(() => undefined);
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await admin.end();
  }
});

/** Refleja una definición de prueba en `plan_parameter_definition` (FK del libro y de los valores). */
async function mirrorDefinition(def: PlanParameterDefinition): Promise<void> {
  const row = {
    ...definitionRow(def), category: def.category, label: def.label, description: def.description, unit: def.unit,
    ceiling_reason: def.ceilingReason, sort_order: def.sortOrder,
  };
  const columns = Object.keys(row);
  await pool.query(`INSERT INTO plan_parameter_definition (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row));
}

/** Valor de cada definición: el indicado o 0/false. */
function planValues(defs: readonly PlanParameterDefinition[], values: Record<string, ParameterValue>): Map<string, ParameterValue> {
  return new Map(defs.map((d) => [d.key, values[d.key] ?? (d.valueType === 'bool' ? false : 0)]));
}

/** Publica la revisión `version` del plan con todos sus valores confirmados (la anterior pasa a SUPERSEDED). */
async function publishRevision(planId: string, version: number, values: ReadonlyMap<string, ParameterValue>): Promise<string> {
  const revisionId = `prv_${planId}_v${version}`;
  await runAtomic(pool, async (client) => {
    await client.query(
      `INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active)
       VALUES ($1, $1, 'Plan de pruebas de semánticas', NULL, NULL, false, false) ON CONFLICT (plan_id) DO NOTHING`, [planId]);
    await client.query(
      `INSERT INTO plan_revision (revision_id, plan_id, version, status, origin, registry_version, reason, created_by)
       VALUES ($1, $2, $3, 'DRAFT', $4, 1, 'Revisión de prueba de semánticas', 'test')`, [revisionId, planId, version, version === 1 ? 'create' : 'edit']);
    for (const [key, value] of values) {
      await client.query(
        `INSERT INTO plan_parameter_value (revision_id, parameter_key, value_int, value_bool, source, confirmed_by, confirmed_at, updated_by)
         VALUES ($1, $2, $3, $4, 'explicit', 'test', now(), 'test')`,
        [revisionId, key, typeof value === 'number' ? value : null, typeof value === 'boolean' ? value : null]);
    }
    await client.query(`UPDATE plan_revision SET status = 'SUPERSEDED', superseded_at = now() WHERE plan_id = $1 AND status = 'PUBLISHED'`, [planId]);
    await client.query(
      `UPDATE plan_revision SET status = 'PUBLISHED', published_by = 'test', published_at = now(),
              publish_reason = 'Publicación de prueba de semánticas', checksum = plan_revision_checksum(revision_id)
        WHERE revision_id = $1`, [revisionId]);
    await client.query('UPDATE plan SET active = true WHERE plan_id = $1', [planId]);
  });
  return revisionId;
}

/** Negocio nuevo; con plan, su suscripción queda fijada a la revisión publicada vigente (trigger de 0034). */
async function newTenant(planId: string | null = MAIN_PLAN, status: 'active' | 'suspended' = 'active'): Promise<string> {
  const tenant = `client_sem_${randomUUID().slice(0, 8)}`;
  await pool.query(`INSERT INTO client (client_id, business_name, status, contact_email, metadata) VALUES ($1, $2, 'active', $3, '{}')`,
    [tenant, `Negocio ${tenant}`, `${tenant}@example.com`]);
  if (planId) {
    await pool.query('INSERT INTO subscription (subscription_id, tenant_id, plan_id, status) VALUES ($1, $2, $3, $4)',
      [`sub_${tenant}`, tenant, planId, status]);
  }
  return tenant;
}

function request(tenantId: string, capability: string, idempotencyKey: string, units = 1): QuotaRequest {
  return {
    tenantId, capability: capability as CapabilityName, units, idempotencyKey,
    requestId: `req_${randomUUID()}`, actorId: `user_${tenantId}`, actorRole: 'administration',
  };
}

type Create = (client: pg.PoolClient) => Promise<string>;

/** Consumo en un paso en su propia transacción; `create` devuelve el resource_ref (por defecto, uno sintético). */
function consume(tenantId: string, capability: string, key: string, opts: { units?: number; create?: Create } = {}) {
  return runAtomic(pool, (client) => ledger.consumeInTx(client, request(tenantId, capability, key, opts.units), async () => {
    const resourceRef = opts.create ? await opts.create(client) : `sem_resource/${key}`;
    return { resourceRef, value: resourceRef };
  }));
}

/** Deny de dominio que la frontera HTTP audita: 403 con su código y todavía sin auditar. */
function denied(code: string): (err: unknown) => boolean {
  return (err) => {
    assert.ok(err instanceof AppError, `se esperaba AppError: ${String(err)}`);
    assert.deepEqual({ status: err.status, code: err.code, audited: err.audited }, { status: 403, code, audited: false });
    return true;
  };
}

/** Límite y uso efectivos (la misma cuenta que aplica el enforcement). */
async function capacity(tenantId: string, capability: string): Promise<CapacityStatus> {
  const policy = await loadPinnedPolicy(pool, tenantId);
  assert.ok(policy, `política fijada de ${tenantId}`);
  const found = (await ledger.capacityStatus(pool, policy)).find((s) => s.capability === capability);
  assert.ok(found, capability);
  return found;
}

async function ledgerRows(tenantId: string, capability: string): Promise<Array<{ key: string; state: string }>> {
  const r = await pool.query<{ key: string; state: string }>(
    `SELECT idempotency_key AS key, state FROM quota_reservation WHERE tenant_id = $1 AND capability = $2
      ORDER BY idempotency_key COLLATE "C"`, [tenantId, capability]);
  return r.rows;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const r = await pool.query<{ n: string }>(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * `work` en `n` conexiones distintas a la vez: todas abren su transacción ANTES de que ninguna toque el
 * libro, así que compiten de verdad por el candado. Cada una confirma o revierte la suya.
 */
async function simultaneously<T>(n: number, work: (client: pg.PoolClient, i: number) => Promise<T>): Promise<Array<PromiseSettledResult<T>>> {
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  try {
    const pids = await Promise.all(clients.map(async (client) => {
      await client.query('BEGIN');
      return (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    }));
    assert.equal(new Set(pids).size, n, 'una conexión de BD distinta por operación');
    return await Promise.allSettled(clients.map(async (client, i) => {
      try {
        const value = await work(client, i);
        await client.query('COMMIT');
        return value;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }));
  } finally {
    await Promise.all(clients.map((client) => client.query('ROLLBACK').catch(() => undefined)));
    for (const client of clients) client.release();
  }
}

// ------------------------------------------------------------------ periódica y ventana móvil

for (const [label, capability] of [['periódica', CAP.periodic], ['ventana móvil', CAP.window]] as const) {
  test(`${label}: consume hasta el límite; el deny no deja rastro; ni el replay ni un create fallido consumen`, async () => {
    const tenant = await newTenant();
    const first = await consume(tenant, capability, 'k1');
    assert.equal(first.kind, 'consumed');

    let replayCreates = 0;
    const replay = await consume(tenant, capability, 'k1', { create: async () => { replayCreates += 1; return 'sem_resource/otro'; } });
    assert.equal(replay.kind, 'replay');
    assert.equal(replayCreates, 0, 'el replay no vuelve a crear el recurso');
    assert.deepEqual([replay.reservation.reservation_id, replay.reservation.resource_ref], [first.reservation.reservation_id, 'sem_resource/k1']);
    assert.equal((await capacity(tenant, capability)).usage, 1, 'el replay no consume');

    await assert.rejects(consume(tenant, capability, 'k2', { create: async () => { throw new Error('fallo al crear el recurso'); } }),
      /fallo al crear el recurso/);
    assert.equal((await capacity(tenant, capability)).usage, 1, 'un create fallido no consume');
    assert.equal((await consume(tenant, capability, 'k2')).kind, 'consumed', 'la clave del intento fallido se puede reintentar');

    await assert.rejects(consume(tenant, capability, 'lote', { units: 2 }), denied('limit_exceeded'), 'un lote que no cabe se rechaza entero');
    assert.equal((await consume(tenant, capability, 'k3')).kind, 'consumed');
    let deniedCreates = 0;
    await assert.rejects(consume(tenant, capability, 'k4', { create: async () => { deniedCreates += 1; return 'sem_resource/k4'; } }),
      denied('limit_exceeded'));
    assert.equal(deniedCreates, 0, 'al límite el recurso nunca se crea');

    const status = await capacity(tenant, capability);
    assert.deepEqual([status.limit, status.usage], [LIMIT, LIMIT]);
    assert.deepEqual(await ledgerRows(tenant, capability),
      [{ key: 'k1', state: 'committed' }, { key: 'k2', state: 'committed' }, { key: 'k3', state: 'committed' }], 'los denies no dejan filas');
    assert.equal(await count(`SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'quota.consumed'`, [tenant]), LIMIT);
  });

  test(`${label}: una reserva viva cuenta; la liberada y la vencida no (y su commit tardío no consume)`, async () => {
    const tenant = await newTenant();
    await consume(tenant, capability, 'k1');
    await consume(tenant, capability, 'k2');
    const live = await ledger.reserve(request(tenant, capability, 'r-viva'));
    assert.equal(live.kind, 'reserved');
    assert.equal((await capacity(tenant, capability)).usage, 3);
    await assert.rejects(consume(tenant, capability, 'k3'), denied('limit_exceeded'), 'la reserva viva ocupa la última unidad');
    assert.equal(await ledger.release(live.reservation, 'administration', 'prueba'), true);
    assert.equal((await capacity(tenant, capability)).usage, 2, 'la reserva liberada deja de contar');

    const stale = await ledger.reserve(request(tenant, capability, 'r-vencida'));
    assert.equal(stale.kind, 'reserved');
    await pool.query(`UPDATE quota_reservation SET expires_at = clock_timestamp() - interval '1 second' WHERE reservation_id = $1`,
      [stale.reservation.reservation_id]);
    assert.equal((await capacity(tenant, capability)).usage, 2, 'la reserva vencida deja de contar');
    await assert.rejects(runAtomic(pool, (client) => ledger.commitInTx(client, stale.reservation, 'sem_resource/tarde', null)),
      (err: unknown) => err instanceof AppError && err.code === 'quota_reservation_expired', 'un commit tardío no consume');

    const twoStep = await ledger.reserve(request(tenant, capability, 'r-confirmada'));
    assert.equal(twoStep.kind, 'reserved');
    await runAtomic(pool, (client) => ledger.commitInTx(client, twoStep.reservation, 'sem_resource/r-confirmada', 'administration'));
    assert.equal((await capacity(tenant, capability)).usage, 3, 'la reserva confirmada sigue contando como unidad consumida');
    await assert.rejects(consume(tenant, capability, 'k3'), denied('limit_exceeded'));
  });
}

test('periódica: solo cuentan las unidades del ciclo mensual vigente (UTC, anclado al inicio de la suscripción)', async () => {
  const tenant = await newTenant();
  // Ancla 45 días atrás (al milisegundo): el ciclo vigente es el segundo, [ancla + 1 mes, ancla + 2 meses).
  await pool.query(`UPDATE subscription SET started_at = date_trunc('milliseconds', clock_timestamp() - interval '45 days') WHERE tenant_id = $1`,
    [tenant]);
  // Oráculo independiente: aritmética de meses de PostgreSQL en UTC (también acota el día a fin de mes).
  const bounds = (await pool.query<{ start: Date; end: Date }>(
    `SELECT (started_at AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC' AS start,
            (started_at AT TIME ZONE 'UTC' + interval '2 months') AT TIME ZONE 'UTC' AS "end"
       FROM subscription WHERE tenant_id = $1`, [tenant])).rows[0];
  assert.ok(bounds);
  assert.deepEqual((await capacity(tenant, CAP.periodic)).window, { start: bounds.start.toISOString(), end: bounds.end.toISOString() });

  for (const key of ['k1', 'k2', 'k3']) assert.equal((await consume(tenant, CAP.periodic, key)).kind, 'consumed');
  await assert.rejects(consume(tenant, CAP.periodic, 'k4'), denied('limit_exceeded'));

  // k1 se liquidó 1 ms antes del inicio del ciclo (ciclo anterior); k2 en el instante exacto de inicio (cuenta).
  await pool.query(`UPDATE quota_reservation SET settled_at = $3::timestamptz - interval '1 millisecond' WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenant, 'k1', bounds.start]);
  await pool.query('UPDATE quota_reservation SET settled_at = $3::timestamptz WHERE tenant_id = $1 AND idempotency_key = $2', [tenant, 'k2', bounds.start]);
  assert.equal((await capacity(tenant, CAP.periodic)).usage, 2, 'la unidad del ciclo anterior no cuenta; la de la frontera sí');
  assert.equal((await consume(tenant, CAP.periodic, 'k4')).kind, 'consumed');
  await assert.rejects(consume(tenant, CAP.periodic, 'k5'), denied('limit_exceeded'));

  // Todo lo consumido pasa al ciclo anterior ⇒ el ciclo vigente vuelve a tener el cupo completo.
  await pool.query(`UPDATE quota_reservation SET settled_at = $2::timestamptz - interval '1 day' WHERE tenant_id = $1 AND capability = $3`,
    [tenant, bounds.start, CAP.periodic]);
  assert.equal((await capacity(tenant, CAP.periodic)).usage, 0);
  for (const key of ['k5', 'k6', 'k7']) assert.equal((await consume(tenant, CAP.periodic, key)).kind, 'consumed');
  await assert.rejects(consume(tenant, CAP.periodic, 'k8'), denied('limit_exceeded'));
});

test('ventana móvil: solo cuentan las unidades confirmadas en los últimos 3600 s; el cupo reabre al salir de la ventana', async () => {
  const tenant = await newTenant();
  for (const key of ['k1', 'k2', 'k3']) assert.equal((await consume(tenant, CAP.window, key)).kind, 'consumed');
  await assert.rejects(consume(tenant, CAP.window, 'k4'), denied('limit_exceeded'));
  const window = (await capacity(tenant, CAP.window)).window;
  assert.ok(window);
  assert.equal(Date.parse(window.end) - Date.parse(window.start), 3_600_000, 'ventana de 3600 s que termina ahora');

  await pool.query(`UPDATE quota_reservation SET settled_at = clock_timestamp() - interval '3700 seconds' WHERE tenant_id = $1 AND idempotency_key = 'k1'`, [tenant]);
  await pool.query(`UPDATE quota_reservation SET settled_at = clock_timestamp() - interval '3500 seconds' WHERE tenant_id = $1 AND idempotency_key = 'k2'`, [tenant]);
  assert.equal((await capacity(tenant, CAP.window)).usage, 2, 'fuera de la ventana no cuenta; dentro sí');
  assert.equal((await consume(tenant, CAP.window, 'k4')).kind, 'consumed');
  await assert.rejects(consume(tenant, CAP.window, 'k5'), denied('limit_exceeded'));

  await pool.query(`UPDATE quota_reservation SET settled_at = clock_timestamp() - interval '2 hours' WHERE tenant_id = $1 AND capability = $2`,
    [tenant, CAP.window]);
  assert.equal((await capacity(tenant, CAP.window)).usage, 0, 'todo fuera de la ventana: cupo completo de nuevo');
  for (const key of ['k5', 'k6', 'k7']) assert.equal((await consume(tenant, CAP.window, key)).kind, 'consumed');
  await assert.rejects(consume(tenant, CAP.window, 'k8'), denied('limit_exceeded'));
});

// ------------------------------------------------------------------ stock

test('stock: cuentan los recursos activos; archivar libera una unidad y reactivar vuelve a comprobar el límite', async () => {
  const tenant = await newTenant();
  const createItem = (itemId: string): Create => async (client) => {
    await client.query('INSERT INTO sem_stock_item (item_id, tenant_id) VALUES ($1, $2)', [itemId, tenant]);
    return `sem_stock_item/${itemId}`;
  };
  const reactivate = (itemId: string): Create => async (client) => {
    const r = await client.query('UPDATE sem_stock_item SET archived_at = NULL WHERE item_id = $1 AND archived_at IS NOT NULL', [itemId]);
    assert.equal(r.rowCount, 1);
    return `sem_stock_item/${itemId}`;
  };
  const archive = (itemId: string) => pool.query('UPDATE sem_stock_item SET archived_at = clock_timestamp() WHERE item_id = $1', [itemId]);
  const activeItems = () => count('SELECT count(*) AS n FROM sem_stock_item WHERE tenant_id = $1 AND archived_at IS NULL', [tenant]);
  const [a, b, c, d] = [`item_a_${tenant}`, `item_b_${tenant}`, `item_c_${tenant}`, `item_d_${tenant}`];

  assert.equal((await consume(tenant, CAP.stock, 'crear-a', { create: createItem(a) })).kind, 'consumed');
  assert.equal((await consume(tenant, CAP.stock, 'crear-b', { create: createItem(b) })).kind, 'consumed');
  await assert.rejects(consume(tenant, CAP.stock, 'crear-c', { create: createItem(c) }), denied('limit_exceeded'));
  assert.equal((await consume(tenant, CAP.stock, 'crear-a', { create: createItem(`${a}_copia`) })).kind, 'replay');
  assert.deepEqual([await activeItems(), (await capacity(tenant, CAP.stock)).usage], [2, 2], 'ni el deny ni el replay crean recursos');

  await archive(a);
  assert.equal((await capacity(tenant, CAP.stock)).usage, 1, 'archivar libera');
  assert.equal((await consume(tenant, CAP.stock, 'crear-c', { create: createItem(c) })).kind, 'consumed');
  await assert.rejects(consume(tenant, CAP.stock, 'reactivar-a-1', { create: reactivate(a) }), denied('limit_exceeded'),
    'reactivar al límite se deniega');
  assert.equal(await activeItems(), 2, 'el recurso denegado sigue archivado');

  await archive(b);
  assert.equal((await consume(tenant, CAP.stock, 'reactivar-a-2', { create: reactivate(a) })).kind, 'consumed', 'con hueco, reactivar consume');
  await archive(c);
  const claim = await ledger.reserve(request(tenant, CAP.stock, 'r-stock'));
  assert.equal(claim.kind, 'reserved');
  await assert.rejects(consume(tenant, CAP.stock, 'crear-d', { create: createItem(d) }), denied('limit_exceeded'),
    'la reserva viva también ocupa stock');
  assert.deepEqual([await activeItems(), (await capacity(tenant, CAP.stock)).usage], [1, 2]);
});

// ------------------------------------------------------------------ elegibilidad

test('elegibilidad: true pasa; false ⇒ 403 prohibited; ausente en la revisión fijada ⇒ deny; no consume nada', async () => {
  const tenant = await newTenant();
  await ledger.assertEligible(pool, tenant, FEATURE_ON.key);
  await assert.rejects(ledger.assertEligible(pool, tenant, FEATURE_OFF.key), denied('prohibited'));
  // Parámetros añadidos después de publicar: la revisión fijada no los define ⇒ nunca una concesión implícita.
  await assert.rejects(ledger.assertEligible(pool, tenant, LATE_FEATURE.key), denied('prohibited'));
  await assert.rejects(consume(tenant, CAP.late, 'tardio-1'), denied('limit_exceeded'));
  assert.equal((await capacity(tenant, CAP.late)).limit, null);
  // Una clave que no es de elegibilidad es un error de programación (fail-closed), nunca un permiso.
  await assert.rejects(ledger.assertEligible(pool, tenant, PERIODIC.key), (err: unknown) => err instanceof Error && !(err instanceof AppError));
  assert.equal(await count('SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1', [tenant]), 0);
});

// ------------------------------------------------------------------ concurrencia e idempotencia

for (const [label, capability, limit] of [['periódica', CAP.periodic, LIMIT], ['ventana móvil', CAP.window, LIMIT], ['stock', CAP.stock, STOCK_LIMIT]] as const) {
  test(`concurrencia (${label}): ${PARALLEL} consumos simultáneos en ${PARALLEL} conexiones con límite ${limit} ⇒ exactamente ${limit} éxitos`, async () => {
    const tenant = await newTenant();
    const results = await simultaneously(PARALLEL, (client, i) => ledger.consumeInTx(client, request(tenant, capability, `c${i}`), async () => {
      await client.query('SELECT pg_sleep(0.02)'); // ensancha la carrera: sin candado, todas pasarían la comprobación
      if (capability === CAP.stock) await client.query('INSERT INTO sem_stock_item (item_id, tenant_id) VALUES ($1, $2)', [`item_c${i}_${tenant}`, tenant]);
      return { resourceRef: `sem_resource/c${i}`, value: i };
    }));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, limit);
    for (const r of results) if (r.status === 'rejected') denied('limit_exceeded')(r.reason);
    assert.equal((await capacity(tenant, capability)).usage, limit);
    assert.equal(await count(`SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1 AND capability = $2 AND state = 'committed'`,
      [tenant, capability]), limit);
  });
}

test(`concurrencia: la misma clave en ${PARALLEL} conexiones a la vez consume una sola vez (en uno y en dos pasos)`, async () => {
  const tenant = await newTenant();
  let creates = 0;
  const results = await simultaneously(PARALLEL, (client) => ledger.consumeInTx(client, request(tenant, CAP.periodic, 'misma-clave'), async () => {
    creates += 1;
    await client.query('SELECT pg_sleep(0.02)');
    return { resourceRef: 'sem_resource/misma-clave', value: null };
  }));
  const kinds = results.map((r) => (r.status === 'fulfilled' ? r.value.kind : `rechazo: ${String(r.reason)}`)).sort();
  assert.deepEqual(kinds, ['consumed', ...Array<string>(PARALLEL - 1).fill('replay')]);
  assert.equal(creates, 1, 'el recurso se crea una sola vez');
  assert.equal((await capacity(tenant, CAP.periodic)).usage, 1);

  const claims = await Promise.allSettled(Array.from({ length: PARALLEL }, () => ledger.reserve(request(tenant, CAP.window, 'misma-reserva'))));
  const reserved = claims.filter((c): c is PromiseFulfilledResult<QuotaClaim> => c.status === 'fulfilled');
  assert.deepEqual(reserved.map((c) => c.value.kind), ['reserved']);
  for (const c of claims) {
    if (c.status === 'rejected') assert.ok(c.reason instanceof AppError && c.reason.status === 409 && c.reason.code === 'request_in_progress', String(c.reason));
  }
  assert.deepEqual(await ledgerRows(tenant, CAP.window), [{ key: 'misma-reserva', state: 'reserved' }]);
  assert.equal((await capacity(tenant, CAP.window)).usage, 1);
});

test('aislamiento: otro negocio no comparte cupo, claves ni candado', async () => {
  const a = await newTenant();
  const b = await newTenant();
  for (const key of ['k1', 'k2', 'k3']) await consume(a, CAP.periodic, key);
  await assert.rejects(consume(a, CAP.periodic, 'k4'), denied('limit_exceeded'));
  assert.equal((await consume(b, CAP.periodic, 'k1')).kind, 'consumed', 'la misma clave en otro negocio es un consumo propio, no un replay');
  assert.equal((await capacity(b, CAP.periodic)).usage, 1);

  // A retiene el candado de (A, capacidad) en una transacción abierta.
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await ledger.lock(holder, a, CAP.periodic);
    const sameTenant = runAtomic(pool, async (client) => {
      await client.query(`SET LOCAL lock_timeout = '300ms'`);
      return ledger.consumeInTx(client, request(a, CAP.periodic, 'k5'), async () => ({ resourceRef: 'sem_resource/k5', value: null }));
    });
    await assert.rejects(sameTenant, (err: unknown) => err instanceof Error && 'code' in err && err.code === '55P03', 'el mismo negocio espera su candado');
    const otherTenant = await runAtomic(pool, async (client) => {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      return ledger.consumeInTx(client, request(b, CAP.periodic, 'k2'), async () => ({ resourceRef: 'sem_resource/k2', value: null }));
    });
    assert.equal(otherTenant.kind, 'consumed', 'otro negocio no espera el candado de A');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    holder.release();
  }
  assert.deepEqual([(await capacity(a, CAP.periodic)).usage, (await capacity(b, CAP.periodic)).usage], [LIMIT, 2]);
});

// ------------------------------------------------------------------ suscripción

test('sin suscripción activa ⇒ 403 subscription_required al consumir, reservar o comprobar elegibilidad; nada se consume', async () => {
  const withoutPlan = await newTenant(null);
  const suspended = await newTenant(MAIN_PLAN, 'suspended');
  const cancelled = await newTenant();
  await pool.query(`UPDATE subscription SET status = 'cancelled' WHERE tenant_id = $1`, [cancelled]);
  for (const tenant of [withoutPlan, suspended, cancelled]) {
    let creates = 0;
    await assert.rejects(consume(tenant, CAP.periodic, 'k1', { create: async () => { creates += 1; return 'sem_resource/k1'; } }),
      denied('subscription_required'));
    await assert.rejects(consume(tenant, CAP.stock, 'k2'), denied('subscription_required'));
    await assert.rejects(ledger.reserve(request(tenant, CAP.window, 'r1')), denied('subscription_required'));
    await assert.rejects(ledger.assertEligible(pool, tenant, FEATURE_ON.key), denied('subscription_required'));
    assert.equal(creates, 0);
    assert.equal(await count('SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1', [tenant]), 0);
  }
  await pool.query(`UPDATE subscription SET status = 'active' WHERE tenant_id = $1`, [suspended]);
  assert.equal((await consume(suspended, CAP.periodic, 'k1')).kind, 'consumed', 'al reactivarse vuelve a consumir con su revisión');
});

test('una suscripción fijada a una revisión SUPERSEDED sigue resolviendo y aplicando sus valores', async () => {
  const planId = `plan_sem_pin_${randomUUID().slice(0, 8)}`;
  const v1 = await publishRevision(planId, 1, planValues(ALL_DEFINITIONS, { [PERIODIC.key]: 1, [FEATURE_ON.key]: false }));
  const pinned = await newTenant(planId);
  const v2 = await publishRevision(planId, 2, planValues(ALL_DEFINITIONS, { [PERIODIC.key]: 4, [FEATURE_ON.key]: true }));
  const fresh = await newTenant(planId);

  const pinnedPolicy = await loadPinnedPolicy(pool, pinned);
  const freshPolicy = await loadPinnedPolicy(pool, fresh);
  assert.deepEqual([pinnedPolicy?.revision.revision_id, pinnedPolicy?.revision.status, pinnedPolicy?.values.get(PERIODIC.key)], [v1, 'SUPERSEDED', 1]);
  assert.deepEqual([freshPolicy?.revision.revision_id, freshPolicy?.revision.status, freshPolicy?.values.get(PERIODIC.key)], [v2, 'PUBLISHED', 4]);

  assert.equal((await consume(pinned, CAP.periodic, 'k1')).kind, 'consumed');
  await assert.rejects(consume(pinned, CAP.periodic, 'k2'), denied('limit_exceeded'), 'v1 permite una unidad aunque v2 permita cuatro');
  await assert.rejects(ledger.assertEligible(pool, pinned, FEATURE_ON.key), denied('prohibited'), 'v1 no incluye la función');
  for (const key of ['k1', 'k2', 'k3', 'k4']) assert.equal((await consume(fresh, CAP.periodic, key)).kind, 'consumed');
  await assert.rejects(consume(fresh, CAP.periodic, 'k5'), denied('limit_exceeded'));
  await ledger.assertEligible(pool, fresh, FEATURE_ON.key);
});
