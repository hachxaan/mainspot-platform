/**
 * G-MIG de DEC-0078 (TS-1) — migración 0040 (libro de TypeSafe) y su reversión, sobre BD DESECHABLES propias
 * (`mainspot_tsr_mig_<hex>`, mismo servidor que TEST_DATABASE_URL; se borran al terminar) con las migraciones hasta 0037
 * más 0040 (las intermedias de otros cambios no intervienen):
 *  - 0040 deja el gasto anterior (jev_classification + jev_evaluation_run + ai_invocation TypeSafe, por día UTC, sin
 *    generativos) como una fila `legacy` por día; no toca las tablas de origen; re-ejecutarla no lo cuenta otra vez ni
 *    duplica una llamada registrada después (su fila del libro y su evidencia cuentan una vez);
 *  - la reversión vuelve exactamente al esquema previo sin tocar datos (también con psql, código 0), 0040 se reaplica
 *    con el mismo gasto anterior, y se niega (55000; psql ≠ 0) si 0040 no está registrada, si hay una migración
 *    posterior registrada o si existe alguna reserva posterior a 0040.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { applyMigrations } from '../../scripts/migrate.ts';
import { TypeSafeLedger } from '../../src/ai/typesafe-ledger.ts';
import { config } from '../../src/shared/config.ts';
import { psqlAvailable, runPsql } from '../helpers/psql.ts';

const { Pool } = pg;

const MIGRATION_0040 = '0040_typesafe_reservation.sql';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const ROLLBACK_0040 = fileURLToPath(new URL('../../scripts/typesafe-reservation-rollback.sql', import.meta.url));
const USE_CASE = 'conversation.intent.classify';
/** Días UTC fijos del gasto anterior; D2 empieza justo después de la última llamada de D1. */
const D1 = '2001-03-05';
const D2 = '2001-03-06';

let admin: pg.Pool | undefined;
let through0037Dir: string | undefined;
let only0040Dir: string | undefined;
let rollbackSql = '';
const databases: string[] = [];
const pools: pg.Pool[] = [];

function databaseUrl(database: string): string {
  const url = new URL(config.testDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function stageMigrations(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mainspot-tsr-mig-'));
  for (const file of files) await copyFile(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
  return dir;
}

/** pg no entiende `\set`; el código de salida con psql se prueba aparte. */
function withoutPsqlMeta(sql: string): string {
  return sql.split('\n').filter((line) => !/^\\[a-z]/.test(line)).join('\n');
}

before(async () => {
  assert.ok(psqlAvailable(), 'la reversión es un script psql: el cliente psql debe estar instalado');
  admin = new Pool({ connectionString: databaseUrl('postgres'), max: 1 });
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f));
  through0037Dir = await stageMigrations(files.filter((f) => Number(f.slice(0, 4)) <= 37));
  only0040Dir = await stageMigrations([MIGRATION_0040]);
  rollbackSql = withoutPsqlMeta(await readFile(ROLLBACK_0040, 'utf8'));
});

after(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  if (admin) {
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
  for (const dir of [through0037Dir, only0040Dir]) if (dir) await rm(dir, { recursive: true, force: true });
});

/**
 * BD desechable hasta 0037 con gasto anterior: TypeSafe en D1 (incluida la última milésima del día), en D2 y hoy;
 * un generativo de USD 5 en D1 (no cuenta); clasificaciones del pipeline (una sin costo) y una evaluación.
 */
async function database0037(): Promise<{ url: string; pool: pg.Pool; today: string }> {
  assert.ok(admin && through0037Dir);
  const name = `mainspot_tsr_mig_${randomBytes(6).toString('hex')}`;
  databases.push(name);
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = databaseUrl(name);
  const pool = new Pool({ connectionString: url, max: 3 });
  pools.push(pool);
  const migrated = await applyMigrations(url, through0037Dir);
  assert.ok(!migrated.applied.includes(MIGRATION_0040));
  await pool.query(`INSERT INTO ai_use_case (use_case_id, title, description, modality, risk_level, owner, output_schema)
    VALUES ($1, 'Clasificación', 'Fixture de la prueba de 0040', 'classification', 'medium', 'test', 'jev-answers/v1')`, [USE_CASE]);
  await pool.query(`INSERT INTO ai_provider (provider_id, display_name, kind, data_policy) VALUES
    ('typesafe', 'TypeSafe', 'typesafe', 'fixture'), ('anthropic', 'Anthropic', 'anthropic', 'fixture')`);
  const invocation = (id: string, provider: string, status: string, cost: number | null, at: string) => pool.query(
    `INSERT INTO ai_invocation (invocation_id, request_id, idempotency_key, actor_id, actor_kind, origin, use_case_id, provider_id,
       policy_version, status, cost_usd, cost_source, trace_id, created_at)
     VALUES ($1, 'mig-0040', $1, 'test', 'system', 'test', $2, $3, 'test', $4, $5, $6, 'mig-0040', $7::timestamptz)`,
    [id, USE_CASE, provider, status, cost, cost === null ? 'unknown' : 'reported', at]);
  await invocation('inv_d1_start', 'typesafe', 'succeeded', 0.1, `${D1}T00:00:00Z`);
  await invocation('inv_d1_end', 'typesafe', 'succeeded', 0.05, `${D1}T23:59:59.999Z`);
  await invocation('inv_d2_start', 'typesafe', 'succeeded', 0.2, `${D2}T00:00:00Z`);
  await invocation('inv_d1_generative', 'anthropic', 'succeeded', 5, `${D1}T12:00:00Z`);
  const today = (await pool.query<{ d: string }>(`SELECT (now() AT TIME ZONE 'UTC')::date::text AS d`)).rows[0]!.d;
  await invocation('inv_today', 'typesafe', 'succeeded', 0.07, new Date().toISOString());
  await invocation('inv_today_running', 'typesafe', 'running', null, new Date().toISOString());
  const classification = async (request: string, day: string, cost: number | null) => {
    await pool.query(`INSERT INTO conversation_request (request_id, tenant_id, actor_id, channel, raw_message, intent, capability_target, action_class, status)
      VALUES ($1, 'client_a', 'user_a', 'simulated', 'mensaje', 'query.read_only', 'website', 'read_only', 'answered')`, [request]);
    await pool.query(`INSERT INTO jev_classification (classification_id, tenant_id, request_id, policy_version, mode, decision_source, decision_reason,
        deterministic_intent, deterministic_action_class, final_intent, final_action_class, status, provider, requested_model, cost_usd,
        cost_source, budget_day, latency_ms, error_code)
      VALUES ($1, 'client_a', $2, 'test', 'shadow', 'deterministic', 'shadow', 'query.read_only', 'read_only', 'query.read_only', 'read_only',
        'unavailable', 'typesafe', 'jev-latest', $3, $4, $5::date, 5, 'fixture')`,
      [`jcl_${request}`, request, cost, cost === null ? null : 'reported', day]);
  };
  await classification('req_d1', D1, 0.3);
  await classification('req_d1_nocost', D1, null);
  await classification('req_today', today, 0.01);
  await pool.query(`INSERT INTO jev_evaluation_run (run_id, policy_version, provider, requested_model, resolved_models, dataset_version, dataset_sha256,
      cases_total, cases_evaluated, intent_correct, risky_cases, risky_misses, capability_correct, min_probability, passed, cost_usd, budget_day,
      report, started_at)
    VALUES ('jer_d1', 'test', 'typesafe', 'jev-latest', '[]', 'v3', 'x', 1, 1, 1, 0, 0, 1, 0.7, false, 0.02, $1::date, '{}', now())`, [D1]);
  return { url, pool, today };
}

async function apply0040(url: string): Promise<string[]> {
  assert.ok(only0040Dir);
  return (await applyMigrations(url, only0040Dir)).applied;
}

/** Tablas de origen del gasto anterior: 0040 y su reversión no las tocan. */
const sourceState = async (pool: pg.Pool) => [
  (await pool.query('SELECT classification_id, cost_usd, budget_day::text FROM jev_classification ORDER BY classification_id')).rows,
  (await pool.query('SELECT run_id, cost_usd, budget_day::text FROM jev_evaluation_run ORDER BY run_id')).rows,
  (await pool.query('SELECT invocation_id, status, cost_usd, created_at FROM ai_invocation ORDER BY invocation_id')).rows,
];

const legacyRows = async (pool: pg.Pool) => (await pool.query<{ reservation_id: string; idempotency_key: string; budget_day: string; status: string; reserved: number; cost: number; cost_source: string | null }>(
  `SELECT reservation_id, idempotency_key, budget_day::text AS budget_day, status, reserved_usd::float8 AS reserved, cost_usd::float8 AS cost, cost_source
     FROM typesafe_reservation WHERE source = 'legacy' ORDER BY budget_day`)).rows;

/** Todo el esquema público: lo que 0040 añade y la reversión debe quitar sin dejar rastro. */
async function schemaShape(pool: pg.Pool): Promise<unknown[]> {
  const rows = async (sql: string) => (await pool.query(sql)).rows;
  return [
    await rows(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`),
    await rows(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`),
    await rows(`SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`),
    await rows(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`),
  ];
}

async function runRollback(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(rollbackSql);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Rechazo de la reversión: SQLSTATE 55000 (object_not_in_prerequisite_state) con el motivo esperado. */
const refused = (reason: RegExp) => (err: unknown) => err instanceof Error && 'code' in err && err.code === '55000' && reason.test(err.message);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('0040: el gasto anterior queda como una fila legacy por día UTC (TypeSafe sí, generativos no); re-ejecutarla no lo cuenta otra vez ni duplica una llamada nueva', async () => {
  const db = await database0037();
  const sources = await sourceState(db.pool);
  assert.deepEqual(await apply0040(db.url), [MIGRATION_0040]);
  assert.deepEqual(await sourceState(db.pool), sources, 'las tablas de origen no cambian');
  const legacy = await legacyRows(db.pool);
  assert.deepEqual(legacy.map((r) => [r.idempotency_key, r.budget_day, r.status, r.reserved, r.cost_source]), [
    [`legacy:${D1}`, D1, 'committed', 0, null], [`legacy:${D2}`, D2, 'committed', 0, null], [`legacy:${db.today}`, db.today, 'committed', 0, null],
  ]);
  assert.ok(near(legacy[0]!.cost, 0.3 + 0.02 + 0.1 + 0.05), `D1: pipeline + evaluación + AI Core TypeSafe hasta 23:59:59.999 UTC (${legacy[0]!.cost})`);
  assert.ok(near(legacy[1]!.cost, 0.2), 'la llamada de las 00:00 UTC es del día siguiente');
  assert.ok(near(legacy[2]!.cost, 0.01 + 0.07), 'hoy: la invocación en curso sin costo no suma');
  const ledger = new TypeSafeLedger({ pool: db.pool, dailyLimitUsd: () => 1 });
  assert.ok(near(await ledger.spentOn(D1), 0.47), 'el generativo de USD 5 no entra al tope de TypeSafe');

  // Una llamada nueva hoy: su reserva confirmada y su evidencia en ai_invocation (como la escribe el AI Core).
  const claim = await ledger.reserve({ key: 'ai_invocation:inv_new', source: 'ai_core', useCaseId: USE_CASE, reserveUsd: 0.01 });
  assert.equal(claim.status, 'reserved');
  if (claim.status !== 'reserved') return;
  assert.equal(await ledger.dispatched(claim.hold), true);
  assert.equal(await ledger.commit(claim.hold, { costUsd: 0.004, costSource: 'reported', attempts: 1 }), true);
  await db.pool.query(`INSERT INTO ai_invocation (invocation_id, request_id, idempotency_key, actor_id, actor_kind, origin, use_case_id, provider_id,
      policy_version, status, cost_usd, cost_source, trace_id)
    VALUES ('inv_new', 'mig-0040', 'inv_new', 'test', 'system', 'test', $1, 'typesafe', 'test', 'succeeded', 0.004, 'reported', 'mig-0040')`, [USE_CASE]);
  assert.ok(near(await ledger.spentOn(db.today), 0.08 + 0.004), 'gasto anterior de hoy + la llamada nueva, una vez');

  // Aplicada pero no registrada: se re-ejecuta sin error y sin volver a contar nada.
  await db.pool.query('DELETE FROM schema_migrations WHERE file = $1', [MIGRATION_0040]);
  assert.deepEqual(await apply0040(db.url), [MIGRATION_0040]);
  assert.deepEqual(await legacyRows(db.pool), legacy, 'mismas filas legacy');
  assert.ok(near(await ledger.spentOn(db.today), 0.084), 'la evidencia nueva en ai_invocation no se suma como gasto anterior');
  assert.ok(near(await ledger.spentOn(D1), 0.47));
  assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM typesafe_reservation`)).rows[0]?.n, 4);
});

test('reversión de 0040: vuelve exactamente al esquema previo sin tocar datos (también con psql, código 0) y 0040 se reaplica con el mismo gasto anterior', async () => {
  const db = await database0037();
  const shape = await schemaShape(db.pool);
  const sources = await sourceState(db.pool);
  await apply0040(db.url);
  const legacy = await legacyRows(db.pool);
  assert.notDeepEqual(await schemaShape(db.pool), shape, '0040 añadió su tabla');
  await runRollback(db.pool);
  assert.deepEqual(await schemaShape(db.pool), shape, 'sin tabla, índices ni restricciones de 0040');
  assert.deepEqual(await sourceState(db.pool), sources);
  assert.equal((await db.pool.query('SELECT 1 FROM schema_migrations WHERE file = $1', [MIGRATION_0040])).rowCount, 0);
  await assert.rejects(runRollback(db.pool), refused(/0040 is not applied/), 'una segunda reversión se niega');

  assert.deepEqual(await apply0040(db.url), [MIGRATION_0040]);
  assert.deepEqual(await legacyRows(db.pool), legacy, 'reaplicada: el mismo gasto anterior, una sola vez');
  const viaPsql = runPsql(db.url, ROLLBACK_0040);
  assert.equal(viaPsql.status, 0, viaPsql.out);
  assert.deepEqual(await schemaShape(db.pool), shape);
});

test('reversión de 0040 BLOQUEADA sin cambios (55000; psql ≠ 0) si existe una reserva posterior a 0040 o una migración posterior registrada', async () => {
  const db = await database0037();
  await apply0040(db.url);
  const ledger = new TypeSafeLedger({ pool: db.pool, dailyLimitUsd: () => 1 });
  const claim = await ledger.reserve({ key: 'pipeline:req_in_flight', source: 'pipeline', useCaseId: null, reserveUsd: 0.01 });
  assert.equal(claim.status, 'reserved');
  const added = await schemaShape(db.pool);
  await assert.rejects(runRollback(db.pool), refused(/BLOCKED: 1 TypeSafe reservation/));
  const blocked = runPsql(db.url, ROLLBACK_0040);
  assert.notEqual(blocked.status, 0, blocked.out);
  assert.deepEqual(await schemaShape(db.pool), added, 'nada cambió');
  assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM typesafe_reservation WHERE source = 'pipeline' AND status = 'reserved'`)).rows[0]?.n, 1);
  assert.equal((await db.pool.query('SELECT 1 FROM schema_migrations WHERE file = $1', [MIGRATION_0040])).rowCount, 1);

  const other = await database0037();
  await apply0040(other.url);
  await other.pool.query(`INSERT INTO schema_migrations (file) VALUES ('0041_posterior.sql')`);
  await assert.rejects(runRollback(other.pool), refused(/migrations after 0040 are applied/));
  assert.equal((await other.pool.query(`SELECT count(*)::int AS n FROM typesafe_reservation WHERE source = 'legacy'`)).rows[0]?.n, 3, 'el gasto anterior sigue');
});
