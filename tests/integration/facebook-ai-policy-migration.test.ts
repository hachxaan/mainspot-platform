/**
 * G-MIG de DEC-0078 — migración 0038 (medidor propio de la IA de Facebook y modo de sugerencias) y su reversión, sobre
 * BD DESECHABLES propias (`mainspot_fbs_mig_<hex>`, mismo servidor que TEST_DATABASE_URL; se borran al terminar):
 *  - 0038 añade la definición `quota.ai_facebook_suggestions.max` (registro 3, sin valor en ninguna revisión publicada:
 *    deny) y la tabla `engagement_suggestion_setting`; no toca revisiones, valores, suscripciones, políticas ni casos;
 *    re-ejecutarla no cambia nada y aborta si la definición ya existe con otra forma;
 *  - la reversión vuelve exactamente al registro 2 y al esquema de 0037, se niega (55000; psql ≠ 0) si ya hay alguna
 *    configuración, valor o reserva del medidor, y fija el orden 0038 → 0037.
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
import { config } from '../../src/shared/config.ts';
import { PLAN_PARAMETERS, definitionRow } from '../../src/plans/registry.ts';
import { AUTO_SUGGEST_CONSENT } from '../../src/engagement/consent.ts';
import { psqlAvailable, runPsql } from '../helpers/psql.ts';

const { Pool } = pg;

const MIGRATION_0038 = '0038_facebook_ai_suggestions.sql';
const FB_KEY = 'quota.ai_facebook_suggestions.max';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const ROLLBACK_0038 = fileURLToPath(new URL('../../scripts/facebook-ai-suggestions-rollback.sql', import.meta.url));
const ROLLBACK_0037 = fileURLToPath(new URL('../../scripts/consent-approval-binding-rollback.sql', import.meta.url));
const TERMS = AUTO_SUGGEST_CONSENT.facebook_comment;

let admin: pg.Pool | undefined;
let through0037Dir: string | undefined;
let only0038Dir: string | undefined;
let rollbackSql = '';
const databases: string[] = [];
const pools: pg.Pool[] = [];

function databaseUrl(database: string): string {
  const url = new URL(config.testDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function stageMigrations(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mainspot-fbs-mig-'));
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
  only0038Dir = await stageMigrations([MIGRATION_0038]);
  rollbackSql = withoutPsqlMeta(await readFile(ROLLBACK_0038, 'utf8'));
});

after(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  if (admin) {
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
  for (const dir of [through0037Dir, only0038Dir]) if (dir) await rm(dir, { recursive: true, force: true });
});

/** BD desechable con 0001..0037 y datos de antes de 0038: una política automática de Facebook y un comentario con IA. */
async function database0037(): Promise<{ url: string; pool: pg.Pool }> {
  assert.ok(admin && through0037Dir);
  const name = `mainspot_fbs_mig_${randomBytes(6).toString('hex')}`;
  databases.push(name);
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = databaseUrl(name);
  const pool = new Pool({ connectionString: url, max: 3 });
  pools.push(pool);
  const migrated = await applyMigrations(url, through0037Dir);
  assert.ok(!migrated.applied.includes(MIGRATION_0038));
  const v2 = 'Autorizo a MainSpot a responder públicamente en mi nombre los comentarios de Facebook de esta categoría (v2).';
  await pool.query(`INSERT INTO engagement_policy (policy_id, tenant_id, origin, category, mode, version, max_auto_replies_per_hour, consent_text, consent_version, consent_sha256, decided_by)
    VALUES ('pol_fb', 'client_a', 'facebook_comment', 'gratitude', 'safe_auto_reply', 1, 10, $1, 'auto_reply.facebook_comment.v2', encode(sha256(convert_to($1, 'UTF8')), 'hex'), 'user_a')`, [v2]);
  await pool.query(`INSERT INTO engagement_case (case_id, tenant_id, origin, external_ref, author_label, body, state, drafts, notify_status)
    VALUES ('case_fb', 'client_a', 'facebook_comment', 'fb-1', 'Ana', 'Qué rico', 'needs_human', '["IA","dos","tres"]', 'sent')`);
  return { url, pool };
}

async function apply0038(url: string): Promise<string[]> {
  assert.ok(only0038Dir);
  return (await applyMigrations(url, only0038Dir)).applied;
}

/** Todo lo que 0038 no debe alterar. */
const dataState = async (pool: pg.Pool) => [
  (await pool.query('SELECT revision_id, plan_id, version, status, checksum, registry_version FROM plan_revision ORDER BY revision_id')).rows,
  (await pool.query('SELECT revision_id, parameter_key, value_int, value_bool, source FROM plan_parameter_value ORDER BY revision_id, parameter_key')).rows,
  (await pool.query('SELECT subscription_id, plan_id, plan_revision_id, status FROM subscription ORDER BY subscription_id')).rows,
  (await pool.query('SELECT policy_id, mode, version, consent_version, consent_sha256 FROM engagement_policy ORDER BY policy_id')).rows,
  (await pool.query('SELECT case_id, state, drafts, drafts_revision FROM engagement_case ORDER BY case_id')).rows,
  (await pool.query('SELECT reservation_id, capability, state FROM quota_reservation ORDER BY reservation_id')).rows,
];

async function schemaShape(pool: pg.Pool): Promise<Record<string, number>> {
  const n = async (sql: string) => Number((await pool.query<{ n: string }>(sql)).rows[0]?.n ?? 0);
  return {
    settingTable: await n(`SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'engagement_suggestion_setting'`),
    trigger: await n(`SELECT count(*) AS n FROM pg_trigger WHERE tgname = 'trg_engagement_suggestion_setting_guard'`),
    func: await n(`SELECT count(*) AS n FROM pg_proc WHERE proname = 'engagement_suggestion_setting_guard'`),
    definition: await n(`SELECT count(*) AS n FROM plan_parameter_definition WHERE parameter_key = '${FB_KEY}'`),
    registry3: await n(`SELECT count(*) AS n FROM plan_parameter_definition WHERE registry_version = 3`),
  };
}

const ADDED = { settingTable: 1, trigger: 1, func: 1, definition: 1, registry3: PLAN_PARAMETERS.length };
const NONE = { settingTable: 0, trigger: 0, func: 0, definition: 0, registry3: 0 };

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

test('0038: añade el medidor de Facebook (registro 3, sin valor publicado) y la configuración de sugerencias; no cambia datos; re-ejecutable', async () => {
  const db = await database0037();
  const before0038 = await dataState(db.pool);
  assert.deepEqual(await schemaShape(db.pool), NONE);
  assert.deepEqual(await apply0038(db.url), [MIGRATION_0038]);
  assert.deepEqual(await dataState(db.pool), before0038, 'revisiones, valores, suscripciones, políticas, casos y libro sin cambios');
  assert.deepEqual(await schemaShape(db.pool), ADDED);

  const rows = (await db.pool.query<Record<string, unknown>>('SELECT * FROM plan_parameter_definition ORDER BY parameter_key')).rows;
  assert.deepEqual(rows.map((r) => r.parameter_key), [...PLAN_PARAMETERS].map((d) => d.key).sort(), 'el espejo tiene exactamente las definiciones del registro 3');
  for (const def of PLAN_PARAMETERS) {
    const row = rows.find((r) => r.parameter_key === def.key);
    for (const [column, expected] of Object.entries(definitionRow(def))) assert.equal(row?.[column] ?? null, expected, `${def.key}.${column}`);
    assert.equal(row?.description, def.description, `${def.key}: descripción`);
  }
  assert.equal((await db.pool.query(`SELECT 1 FROM plan_parameter_value WHERE parameter_key = $1`, [FB_KEY])).rowCount, 0,
    'ninguna revisión publicada define el medidor: la IA de pago de Facebook se deniega hasta una decisión del propietario');

  await db.pool.query('DELETE FROM schema_migrations WHERE file = $1', [MIGRATION_0038]);
  assert.deepEqual(await apply0038(db.url), [MIGRATION_0038], 'aplicada pero no registrada: se re-ejecuta sin error');
  assert.deepEqual(await dataState(db.pool), before0038);
  assert.deepEqual(await schemaShape(db.pool), ADDED);
});

test('0038 aborta sin cambios si la definición del medidor ya existe con otra forma', async () => {
  const db = await database0037();
  await db.pool.query(`INSERT INTO plan_parameter_definition (parameter_key, capability, category, label, description, unit, value_type, semantics, period_kind,
      window_seconds, min_value, max_value, ceiling_reason, suggested_int, suggested_bool, enforcement_state, registry_version, sort_order)
    VALUES ($1, 'ai_facebook_suggestions', 'x', 'x', 'x', 'x', 'int', 'cumulative', 'none', NULL, 0, 5, 'x', 5, NULL, 'enforced', 2, 99)`, [FB_KEY]);
  await assert.rejects(apply0038(db.url), /unexpected shape/);
  assert.equal((await db.pool.query('SELECT 1 FROM schema_migrations WHERE file = $1', [MIGRATION_0038])).rowCount, 0);
  assert.equal((await db.pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'engagement_suggestion_setting'`)).rowCount, 0, 'la transacción se revirtió entera');
});

test('reversión de 0038: vuelve al registro 2 y al esquema de 0037 sin tocar datos (también con psql, código 0) y 0038 se reaplica', async () => {
  const db = await database0037();
  const before0038 = await dataState(db.pool);
  await apply0038(db.url);
  await runRollback(db.pool);
  assert.deepEqual(await schemaShape(db.pool), NONE);
  assert.deepEqual(await dataState(db.pool), before0038);
  assert.equal(Number((await db.pool.query<{ n: string }>('SELECT count(*) AS n FROM plan_parameter_definition WHERE registry_version = 2')).rows[0]?.n), PLAN_PARAMETERS.length - 1);
  assert.equal((await db.pool.query('SELECT 1 FROM schema_migrations WHERE file = $1', [MIGRATION_0038])).rowCount, 0);
  await assert.rejects(runRollback(db.pool), (err: unknown) => sqlState(err) === '55000', 'una segunda reversión se niega');

  assert.deepEqual(await apply0038(db.url), [MIGRATION_0038]);
  const viaPsql = runPsql(db.url, ROLLBACK_0038);
  assert.equal(viaPsql.status, 0, viaPsql.out);
  assert.deepEqual(await schemaShape(db.pool), NONE);
});

test('reversión de 0038 BLOQUEADA sin cambios (55000; psql ≠ 0) si hay una configuración de sugerencias o una reserva del medidor', async () => {
  const db = await database0037();
  await apply0038(db.url);
  await db.pool.query(`INSERT INTO engagement_suggestion_setting (setting_id, tenant_id, origin, version, mode, consent_text, consent_version, consent_sha256, decided_by)
    VALUES ('sgs_mig', 'client_a', 'facebook_comment', 1, 'auto_suggest', $1, $2, $3, 'user_a')`, [TERMS.text, TERMS.version, TERMS.sha256]);
  await assert.rejects(runRollback(db.pool), (err: unknown) => sqlState(err) === '55000' && /BLOCKED: 1 suggestion setting/.test(String((err as Error).message)));
  const blocked = runPsql(db.url, ROLLBACK_0038);
  assert.notEqual(blocked.status, 0, blocked.out);
  assert.deepEqual(await schemaShape(db.pool), ADDED, 'nada cambió');

  const other = await database0037();
  await apply0038(other.url);
  await other.pool.query(`INSERT INTO quota_reservation (reservation_id, tenant_id, capability, units, idempotency_key, request_id, actor_id, state, resource_ref, expires_at, settled_at)
    VALUES ('qres_mig', 'client_a', 'ai_facebook_suggestions', 1, 'fb_suggestion:case_fb', 'req', 'system', 'committed', 'engagement_case/case_fb', now(), now())`);
  await assert.rejects(runRollback(other.pool), (err: unknown) => sqlState(err) === '55000' && /1 reservation/.test(String((err as Error).message)));
  assert.equal((await other.pool.query('SELECT 1 FROM schema_migrations WHERE file = $1', [MIGRATION_0038])).rowCount, 1);
});

test('orden de reversión: con 0038 registrada, la de 0037 se niega; 0038 → 0037 vuelve al esquema previo', async () => {
  const db = await database0037();
  await apply0038(db.url);
  const r37 = runPsql(db.url, ROLLBACK_0037);
  assert.notEqual(r37.status, 0, 'revertir 0037 con 0038 registrada se niega');
  assert.match(r37.out, /migrations after 0037 are applied/);
  // Los datos de prueba (política versionada) bloquean 0037 por diseño: se retiran antes de comprobar la secuencia.
  await db.pool.query(`DELETE FROM engagement_policy WHERE policy_id = 'pol_fb'`);
  for (const script of [ROLLBACK_0038, ROLLBACK_0037]) {
    const r = runPsql(db.url, script);
    assert.equal(r.status, 0, `${path.basename(script)}: ${r.out}`);
  }
  assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'engagement_case' AND column_name = 'drafts_revision'`)).rows[0]?.n, 0);
  assert.deepEqual(await schemaShape(db.pool), NONE);
});
