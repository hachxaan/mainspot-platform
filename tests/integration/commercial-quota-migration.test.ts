/**
 * G-MIG de DEC-0076 — migración 0036 (registro de parámetros 2) y su reversión, sobre BD DESECHABLES propias
 * (`mainspot_cq_mig_<hex>`, mismo servidor que TEST_DATABASE_URL; se borran al terminar):
 *  - 0036 añade solo la definición periódica `quota.ai_review_replies.max`, retira el enforcement de
 *    `reviews_managed` y deja el espejo igual al registro de código; no toca revisiones, valores, suscripciones ni
 *    el libro; ninguna revisión publicada previa define la cuota nueva (deny); re-ejecutarla no cambia nada;
 *  - la reversión devuelve exactamente las definiciones de 0035, aborta sin cambios (55000, código psql ≠ 0) si un
 *    valor de revisión o una reserva usa la capacidad nueva, y fija el orden 0036 → 0035 → 0034.
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
import { effectiveValue, loadPinnedPolicy } from '../../src/plans/policy.ts';
import { PLAN_PARAMETERS, definitionByKey, definitionRow } from '../../src/plans/registry.ts';
import { config } from '../../src/shared/config.ts';
import { psqlAvailable, runPsql } from '../helpers/psql.ts';

const { Pool } = pg;

const MIGRATION_0036 = '0036_commercial_quota_semantics.sql';
const AI_KEY = 'quota.ai_review_replies.max';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const ROLLBACK_0036 = fileURLToPath(new URL('../../scripts/commercial-quota-rollback.sql', import.meta.url));
const ROLLBACK_0035 = fileURLToPath(new URL('../../scripts/plan-catalog-hardening-rollback.sql', import.meta.url));
const ROLLBACK_0034 = fileURLToPath(new URL('../../scripts/plan-catalog-rollback.sql', import.meta.url));

let admin: pg.Pool | undefined;
let through0035Dir: string | undefined;
let only0036Dir: string | undefined;
let rollbackSql = '';
const databases: string[] = [];
const pools: pg.Pool[] = [];

function databaseUrl(database: string): string {
  const url = new URL(config.testDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function stageMigrations(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mainspot-cq-mig-'));
  for (const file of files) await copyFile(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
  return dir;
}

/** Igual que en plan-catalog-migration: pg no entiende `\set`; el código de salida con psql se prueba aparte. */
function withoutPsqlMeta(sql: string): string {
  return sql.split('\n').filter((line) => !/^\\[a-z]/.test(line)).join('\n');
}

before(async () => {
  assert.ok(psqlAvailable(), 'las reversiones son scripts psql: el cliente psql debe estar instalado');
  admin = new Pool({ connectionString: databaseUrl('postgres'), max: 1 });
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f));
  through0035Dir = await stageMigrations(files.filter((f) => Number(f.slice(0, 4)) <= 35));
  only0036Dir = await stageMigrations([MIGRATION_0036]);
  rollbackSql = withoutPsqlMeta(await readFile(ROLLBACK_0036, 'utf8'));
});

after(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  if (admin) {
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
  for (const dir of [through0035Dir, only0036Dir]) if (dir) await rm(dir, { recursive: true, force: true });
});

/** BD desechable con 0001..0035 aplicadas (seed incluido: planes piloto/básico/completo y client_a/b). */
async function database0035(): Promise<{ url: string; pool: pg.Pool }> {
  assert.ok(admin && through0035Dir);
  const name = `mainspot_cq_mig_${randomBytes(6).toString('hex')}`;
  databases.push(name);
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = databaseUrl(name);
  const pool = new Pool({ connectionString: url, max: 3 });
  pools.push(pool);
  const migrated = await applyMigrations(url, through0035Dir);
  assert.ok(!migrated.applied.includes(MIGRATION_0036));
  return { url, pool };
}

async function apply0036(url: string): Promise<string[]> {
  assert.ok(only0036Dir);
  return (await applyMigrations(url, only0036Dir)).applied;
}

const definitions = async (pool: pg.Pool) => (await pool.query('SELECT * FROM plan_parameter_definition ORDER BY parameter_key COLLATE "C"')).rows;

/** Todo lo que 0036 no debe tocar. */
async function catalogState(pool: pg.Pool): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const sql of [
    'SELECT revision_id, plan_id, version, status, checksum, registry_version FROM plan_revision ORDER BY revision_id',
    'SELECT revision_id, parameter_key, value_int, value_bool, source, confirmed_at FROM plan_parameter_value ORDER BY revision_id, parameter_key',
    'SELECT subscription_id, tenant_id, plan_id, plan_revision_id, status, started_at, updated_at FROM subscription ORDER BY subscription_id',
    'SELECT reservation_id, capability, state FROM quota_reservation ORDER BY reservation_id',
  ]) out.push((await pool.query(sql)).rows);
  return out;
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

const sqlState = (err: unknown) => (err as { code?: string }).code;

/** Columna `engagement_case.ai_draft` (la propuesta pedida con IA) y su restricción. */
async function aiDraftColumn(pool: pg.Pool): Promise<[number, number]> {
  const col = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'engagement_case' AND column_name = 'ai_draft'`);
  const chk = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'engagement_case_ai_draft_check'`);
  return [col.rowCount ?? 0, chk.rowCount ?? 0];
}

test('0036: añade solo la cuota periódica de IA, retira el enforcement de reseñas y deja el espejo igual al registro; nada más cambia; re-ejecutable', async () => {
  const db = await database0035();
  const before0036 = await catalogState(db.pool);
  assert.deepEqual(await apply0036(db.url), [MIGRATION_0036]);

  // El espejo que deja 0036 es el registro 2: el medidor de Facebook (registro 3, DEC-0078) llega con 0038 y se
  // comprueba en facebook-ai-policy-migration.
  const registry2 = PLAN_PARAMETERS.filter((d) => d.key !== 'quota.ai_facebook_suggestions.max');
  const rows = await definitions(db.pool);
  assert.deepEqual(rows.map((r) => r.parameter_key), registry2.map((d) => d.key).sort(), 'el espejo tiene exactamente las definiciones del registro 2');
  for (const def of registry2) {
    const row = rows.find((r) => r.parameter_key === def.key);
    for (const [column, expected] of Object.entries({ ...definitionRow(def), registry_version: 2 })) assert.equal(row?.[column] ?? null, expected, `${def.key}.${column}`);
    assert.equal(row?.description, def.description, `${def.key}: descripción`);
  }
  const ai = rows.find((r) => r.parameter_key === AI_KEY);
  assert.deepEqual([ai?.semantics, ai?.period_kind, ai?.enforcement_state, ai?.suggested_int], ['periodic', 'subscription_month', 'enforced', 0]);
  assert.equal(rows.find((r) => r.parameter_key === 'quota.reviews_managed.max')?.enforcement_state, 'not_enforced');
  assert.deepEqual(await catalogState(db.pool), before0036, 'revisiones, valores, suscripciones y libro sin cambios');
  assert.deepEqual(await aiDraftColumn(db.pool), [1, 1], 'engagement_case.ai_draft con su restricción');
  await assert.rejects(db.pool.query(`INSERT INTO engagement_case (case_id, tenant_id, origin, external_ref, author_label, body, state, ai_draft)
    VALUES ('case_mig_x', 'client_a', 'google_review', 'mig-x', 'A', 'B', 'needs_human', 'sin invocación')`),
  (err: unknown) => sqlState(err) === '23514', 'una propuesta de IA exige la invocación que la redactó');

  // Las revisiones publicadas antes de 0036 no definen la cuota nueva: deny (nunca concesión implícita).
  const def = definitionByKey(AI_KEY);
  assert.ok(def);
  const policy = await loadPinnedPolicy(db.pool, 'client_a');
  assert.ok(policy);
  assert.equal(effectiveValue(policy, def), null);

  // Aplicada pero no registrada: se re-ejecuta sin error ni cambios.
  await db.pool.query('DELETE FROM schema_migrations WHERE file = $1', [MIGRATION_0036]);
  assert.deepEqual(await apply0036(db.url), [MIGRATION_0036]);
  assert.deepEqual(await definitions(db.pool), rows);
});

test('reversión de 0036: vuelve exactamente a las definiciones de 0035 (también con psql, código 0) y 0036 se reaplica', async () => {
  const db = await database0035();
  const at0035 = await definitions(db.pool);
  await apply0036(db.url);
  await runRollback(db.pool);
  assert.deepEqual(await definitions(db.pool), at0035);
  assert.deepEqual(await aiDraftColumn(db.pool), [0, 0], 'la columna ai_draft desaparece');
  assert.equal((await db.pool.query('SELECT 1 FROM schema_migrations WHERE file = $1', [MIGRATION_0036])).rowCount, 0);
  await assert.rejects(runRollback(db.pool), (err: unknown) => sqlState(err) === '55000', 'una segunda reversión se niega');

  assert.deepEqual(await apply0036(db.url), [MIGRATION_0036]);
  const viaPsql = runPsql(db.url, ROLLBACK_0036);
  assert.equal(viaPsql.status, 0, viaPsql.out);
  assert.deepEqual(await definitions(db.pool), at0035);
});

test('reversión de 0036 BLOQUEADA sin cambios (55000; psql ≠ 0) si un valor de revisión, una reserva o una propuesta de IA usan la cuota nueva', async () => {
  const db = await database0035();
  await apply0036(db.url);
  const migrated = await definitions(db.pool);
  // Un borrador (aún sin publicar) con la cuota nueva: sus valores son inmutables en cuanto se publique y nunca se borran.
  await db.pool.query(`INSERT INTO plan_revision (revision_id, plan_id, version, status, origin, registry_version, reason, created_by)
    VALUES ('prv_cq_draft', 'plan_basico', 2, 'DRAFT', 'edit', 2, 'Borrador con la cuota de IA', 'platform:test')`);
  await db.pool.query(`INSERT INTO plan_parameter_value (revision_id, parameter_key, value_int, source, updated_by)
    VALUES ('prv_cq_draft', $1, 0, 'suggested', 'platform:test')`, [AI_KEY]);
  await assert.rejects(runRollback(db.pool), (err: unknown) => sqlState(err) === '55000' && /BLOCKED: 1 plan revision value/.test(String((err as Error).message)));
  const blocked = runPsql(db.url, ROLLBACK_0036);
  assert.notEqual(blocked.status, 0, blocked.out);
  assert.deepEqual(await definitions(db.pool), migrated, 'nada cambió');

  const other = await database0035();
  await apply0036(other.url);
  await other.pool.query(`INSERT INTO quota_reservation (reservation_id, tenant_id, capability, units, idempotency_key, request_id, actor_id, state, resource_ref, expires_at, settled_at)
    VALUES ('qres_cq', 'client_a', 'ai_review_replies', 1, 'ai_reply:case_x', 'req-cq', 'user_a', 'committed', 'engagement_case/case_x', now(), now())`);
  await assert.rejects(runRollback(other.pool), (err: unknown) => sqlState(err) === '55000' && /1 quota ledger row/.test(String((err as Error).message)));
  assert.equal((await other.pool.query('SELECT 1 FROM schema_migrations WHERE file = $1', [MIGRATION_0036])).rowCount, 1);

  // Una propuesta de IA guardada (texto pagado) también bloquea: la columna no se borra con ella dentro.
  const third = await database0035();
  await apply0036(third.url);
  await third.pool.query(`INSERT INTO engagement_case (case_id, tenant_id, origin, external_ref, author_label, body, state, reply_invocation_id, ai_draft)
    VALUES ('case_mig_ai', 'client_a', 'google_review', 'mig-ai', 'A', 'B', 'needs_human', 'inv_mig', 'Propuesta redactada con IA')`);
  await assert.rejects(runRollback(third.pool), (err: unknown) => sqlState(err) === '55000' && /1 AI draft/.test(String((err as Error).message)));
  assert.deepEqual(await aiDraftColumn(third.pool), [1, 1], 'la columna sigue con su propuesta');
});

test('orden de reversión: con 0036 registrada, 0035 y 0034 se niegan; 0036 → 0035 → 0034 vuelve al esquema previo a 0034', async () => {
  const db = await database0035();
  await apply0036(db.url);
  const r35 = runPsql(db.url, ROLLBACK_0035);
  assert.notEqual(r35.status, 0, 'revertir 0035 con 0036 registrada se niega');
  assert.match(r35.out, /Newer migrations detected/);
  const r34 = runPsql(db.url, ROLLBACK_0034);
  assert.notEqual(r34.status, 0);
  assert.match(r34.out, /migrations after 0034 are applied/);

  for (const script of [ROLLBACK_0036, ROLLBACK_0035, ROLLBACK_0034]) {
    const r = runPsql(db.url, script);
    assert.equal(r.status, 0, `${path.basename(script)}: ${r.out}`);
  }
  assert.equal((await db.pool.query(`SELECT to_regclass('public.plan_parameter_definition')::text AS t`)).rows[0]?.t, null);
  assert.ok((await db.pool.query(`SELECT count(*)::int AS n FROM plan_limit`)).rows[0]?.n > 0, 'plan_limit regresa');
});
