/**
 * G-MIG de FB-3 (DEC-0078) — migración 0039 (ámbito `lab_experiment` y `ai_use_case.channel`) y su reversión, sobre BD
 * DESECHABLES propias (`<BD de pruebas>_mig39_<hex>`, mismo servidor que TEST_DATABASE_URL; se borran al terminar),
 * con las migraciones hasta 0037 más 0039:
 *  - 0039 no crea ninguna fila de presupuesto ni cambia las existentes; rellena el canal de cada caso de uso existente
 *    con el mismo mapa que declara el catálogo (USE_CASE_SEEDS); `lab_experiment` solo existe sin negocio; re-ejecutarla
 *    no cambia nada; un caso de uso fuera del mapa la deshace entera con el motivo;
 *  - la reversión vuelve exactamente al esquema anterior sin tocar datos, se niega (55000; psql ≠ 0) si hay una fila
 *    `lab_experiment` o migraciones posteriores registradas, y fija el orden 0039 → 0037.
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
import { USE_CASE_SEEDS } from '../../src/ai/catalog.ts';
import { config } from '../../src/shared/config.ts';
import { psqlAvailable, runPsql } from '../helpers/psql.ts';

const { Pool } = pg;

const MIGRATION_0039 = '0039_ai_budget_segregation.sql';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const ROLLBACK_0039 = fileURLToPath(new URL('../../scripts/ai-budget-segregation-rollback.sql', import.meta.url));
const ROLLBACK_0037 = fileURLToPath(new URL('../../scripts/consent-approval-binding-rollback.sql', import.meta.url));
const TEST_DB = new URL(config.testDatabaseUrl).pathname.replace(/^\//, '');

let admin: pg.Pool | undefined;
let through0037Dir: string | undefined;
let only0039Dir: string | undefined;
let rollbackSql = '';
const databases: string[] = [];
const pools: pg.Pool[] = [];

function databaseUrl(database: string): string {
  const url = new URL(config.testDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function stageMigrations(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mainspot-fb3-mig-'));
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
  only0039Dir = await stageMigrations([MIGRATION_0039]);
  rollbackSql = withoutPsqlMeta(await readFile(ROLLBACK_0039, 'utf8'));
});

after(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  if (admin) {
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
  for (const dir of [through0037Dir, only0039Dir]) if (dir) await rm(dir, { recursive: true, force: true });
});

/**
 * BD desechable hasta 0037 con lo que ya existía antes de 0039: los casos de uso del catálogo (sin canal), los techos
 * sembrados por `ensureAiCatalog` y un diario propio de un negocio.
 */
async function database0037(extraUseCases: string[] = []): Promise<{ url: string; pool: pg.Pool }> {
  assert.ok(admin && through0037Dir);
  const name = `${TEST_DB}_mig39_${randomBytes(6).toString('hex')}`;
  databases.push(name);
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = databaseUrl(name);
  const pool = new Pool({ connectionString: url, max: 3 });
  pools.push(pool);
  const migrated = await applyMigrations(url, through0037Dir);
  assert.ok(!migrated.applied.includes(MIGRATION_0039));
  for (const uc of [...USE_CASE_SEEDS.map((s) => s.id), ...extraUseCases]) {
    await pool.query(`INSERT INTO ai_use_case (use_case_id, title, description, modality, risk_level, owner, output_schema) VALUES ($1, $1, 'previo a 0039', 'text', 'low', 'ingenieria-ia', 'x/v1')`, [uc]);
  }
  await pool.query(`INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by) VALUES
    ('bud_lab_total', 'lab_total', NULL, 25, 'DEC-0068', 'seed'), ('bud_tenant_day_default', 'tenant_day', NULL, 1, 'OPS-0001', 'seed'),
    ('bud_tenant_day_a', 'tenant_day', 'client_a', 0.5, 'propio', 'seed')`);
  return { url, pool };
}

async function apply0039(url: string): Promise<string[]> {
  assert.ok(only0039Dir);
  return (await applyMigrations(url, only0039Dir)).applied;
}

/** Todo lo que 0039 no debe alterar (datos). */
const dataState = async (pool: pg.Pool) => [
  (await pool.query('SELECT budget_id, scope, tenant_id, limit_usd, source, updated_by, updated_at FROM ai_budget ORDER BY budget_id')).rows,
  (await pool.query('SELECT use_case_id, title, modality, status, updated_at FROM ai_use_case ORDER BY use_case_id')).rows,
];

/** Forma exacta del esquema que toca 0039: columnas y restricciones de ai_budget y ai_use_case. */
async function schemaShape(pool: pg.Pool): Promise<unknown[]> {
  return [
    (await pool.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
                        WHERE table_name IN ('ai_budget','ai_use_case') ORDER BY table_name, column_name`)).rows,
    (await pool.query(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
                        WHERE conrelid IN ('ai_budget'::regclass, 'ai_use_case'::regclass) ORDER BY 1, 2`)).rows,
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

function sqlState(err: unknown): unknown {
  return err instanceof Error && 'code' in err ? err.code : undefined;
}

test('0039: rellena el canal de cada caso de uso existente con el mapa del catálogo, no crea ni cambia presupuestos, admite lab_experiment solo global y es re-ejecutable', async () => {
  const db = await database0037();
  const before0039 = await dataState(db.pool);
  const shape0037 = await schemaShape(db.pool);
  assert.deepEqual(await apply0039(db.url), [MIGRATION_0039]);
  assert.deepEqual(await dataState(db.pool), before0039, 'ningún presupuesto ni caso de uso cambia (sin fila lab_experiment: no hay valor sembrado)');
  const channels = (await db.pool.query<{ use_case_id: string; channel: string }>('SELECT use_case_id, channel FROM ai_use_case ORDER BY use_case_id')).rows;
  assert.deepEqual(channels, USE_CASE_SEEDS.map((s) => ({ use_case_id: s.id, channel: s.channel })).sort((x, y) => (x.use_case_id < y.use_case_id ? -1 : 1)),
    'el mismo canal que el catálogo, uno por caso de uso');
  const rejects = async (sql: string, code: string) => assert.rejects(db.pool.query(sql), (err: unknown) => sqlState(err) === code, sql);
  await rejects(`INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by) VALUES ('b1', 'lab_experiment', 'client_a', 1, 'x', 'x')`, '23514');
  await rejects(`INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by) VALUES ('b2', 'channel_month', NULL, 1, 'x', 'x')`, '23514');
  await rejects(`UPDATE ai_use_case SET channel = 'otro' WHERE use_case_id = 'business.insights.generate'`, '23514');
  await rejects(`UPDATE ai_use_case SET channel = NULL WHERE use_case_id = 'business.insights.generate'`, '23502');
  await rejects(`INSERT INTO ai_use_case (use_case_id, title, description, modality, risk_level, owner, output_schema) VALUES ('nuevo', 'n', 'n', 'text', 'low', 'x', 'x/v1')`, '23502');
  await db.pool.query(`INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by) VALUES ('bud_lab_experiment', 'lab_experiment', NULL, 1, 'x', 'x')`);
  await rejects(`INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by) VALUES ('b3', 'lab_experiment', NULL, 2, 'x', 'x')`, '23505');
  await db.pool.query(`DELETE FROM ai_budget WHERE scope = 'lab_experiment'`);

  const shape0039 = await schemaShape(db.pool);
  assert.notDeepEqual(shape0039, shape0037);
  await db.pool.query('DELETE FROM schema_migrations WHERE file = $1', [MIGRATION_0039]);
  assert.deepEqual(await apply0039(db.url), [MIGRATION_0039], 'aplicada pero no registrada: se re-ejecuta sin error');
  assert.deepEqual(await dataState(db.pool), before0039);
  assert.deepEqual(await schemaShape(db.pool), shape0039);
});

test('0039 se deshace entera, con el motivo, si un caso de uso no tiene canal conocido: nunca recibe uno por omisión', async () => {
  const db = await database0037(['custom.sin_canal']);
  const shape0037 = await schemaShape(db.pool);
  await assert.rejects(apply0039(db.url), (err: unknown) => err instanceof Error && sqlState(err) === '23514' && /0039: casos de uso sin canal de atribución conocido: custom\.sin_canal/.test(err.message));
  assert.equal((await db.pool.query('SELECT 1 FROM schema_migrations WHERE file = $1', [MIGRATION_0039])).rowCount, 0);
  assert.deepEqual(await schemaShape(db.pool), shape0037, 'ni el canal ni el ámbito nuevo quedan a medias');
});

test('reversión de 0039: vuelve exactamente al esquema anterior sin tocar datos (también con psql, código 0) y 0039 se reaplica', async () => {
  const db = await database0037();
  const before0039 = await dataState(db.pool);
  const shape0037 = await schemaShape(db.pool);
  await apply0039(db.url);
  await runRollback(db.pool);
  assert.deepEqual(await schemaShape(db.pool), shape0037);
  assert.deepEqual(await dataState(db.pool), before0039);
  assert.equal((await db.pool.query('SELECT 1 FROM schema_migrations WHERE file = $1', [MIGRATION_0039])).rowCount, 0);
  await assert.rejects(runRollback(db.pool), (err: unknown) => sqlState(err) === '55000', 'una segunda reversión se niega');

  assert.deepEqual(await apply0039(db.url), [MIGRATION_0039]);
  assert.equal((await db.pool.query(`SELECT channel FROM ai_use_case WHERE use_case_id = 'engagement.facebook.comment.reply'`)).rows[0]?.channel, 'facebook_comments', 'reaplicada, el canal se reconstruye igual');
  const viaPsql = runPsql(db.url, ROLLBACK_0039);
  assert.equal(viaPsql.status, 0, viaPsql.out);
  assert.deepEqual(await schemaShape(db.pool), shape0037);
  assert.deepEqual(await dataState(db.pool), before0039);
});

test('reversión de 0039 BLOQUEADA sin cambios (55000; psql ≠ 0) si hay una fila lab_experiment o migraciones posteriores registradas', async () => {
  const db = await database0037();
  await apply0039(db.url);
  const shape0039 = await schemaShape(db.pool);
  await db.pool.query(`INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by) VALUES ('bud_lab_experiment', 'lab_experiment', NULL, 0.5, 'console:prueba', 'pu_admin')`);
  await assert.rejects(runRollback(db.pool), (err: unknown) => err instanceof Error && sqlState(err) === '55000' && /BLOCKED: 1 lab_experiment budget row/.test(err.message));
  const blocked = runPsql(db.url, ROLLBACK_0039);
  assert.notEqual(blocked.status, 0, blocked.out);
  assert.deepEqual(await schemaShape(db.pool), shape0039, 'nada cambió');
  assert.equal((await db.pool.query(`SELECT limit_usd FROM ai_budget WHERE scope = 'lab_experiment'`)).rows[0]?.limit_usd, '0.5000', 'el presupuesto del laboratorio sigue intacto');

  await db.pool.query(`DELETE FROM ai_budget WHERE scope = 'lab_experiment'`);
  await db.pool.query(`INSERT INTO schema_migrations (file) VALUES ('0040_posterior.sql')`);
  await assert.rejects(runRollback(db.pool), (err: unknown) => err instanceof Error && sqlState(err) === '55000' && /migrations after 0039 are applied/.test(err.message));
  assert.equal((await db.pool.query('SELECT 1 FROM schema_migrations WHERE file = $1', [MIGRATION_0039])).rowCount, 1);
  assert.deepEqual(await schemaShape(db.pool), shape0039);
});

test('orden de reversión: con 0039 registrada, la de 0037 se niega; 0039 → 0037 vuelve al esquema previo', async () => {
  const db = await database0037();
  await apply0039(db.url);
  const r37 = runPsql(db.url, ROLLBACK_0037);
  assert.notEqual(r37.status, 0, 'revertir 0037 con 0039 registrada se niega');
  assert.match(r37.out, /migrations after 0037 are applied/);
  for (const script of [ROLLBACK_0039, ROLLBACK_0037]) {
    const r = runPsql(db.url, script);
    assert.equal(r.status, 0, `${path.basename(script)}: ${r.out}`);
  }
  assert.deepEqual((await db.pool.query(`SELECT file FROM schema_migrations WHERE file IN ($1, '0037_consent_and_approval_binding.sql')`, [MIGRATION_0039])).rows, []);
  assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'ai_use_case' AND column_name = 'channel'`)).rows[0]?.n, 0);
});
