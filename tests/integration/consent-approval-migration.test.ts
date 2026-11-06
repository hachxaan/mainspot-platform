/**
 * G-MIG de DEC-0077 — migración 0037 (SEC-CONSENT-01 y SEC-TG-APPROVAL-01) y su reversión, sobre BD DESECHABLES propias
 * (`mainspot_cab_mig_<hex>`, mismo servidor que TEST_DATABASE_URL; se borran al terminar):
 *  - 0037 conserva las políticas, casos y avisos existentes (las políticas automáticas previas quedan SIN versión: su
 *    consentimiento no cubre la cuota compartida) y solo añade columnas, restricciones, triggers y la tabla de avisos;
 *    re-ejecutarla no cambia nada;
 *  - la reversión vuelve exactamente al esquema de 0036, se niega (55000; psql ≠ 0) si ya hay consentimientos
 *    versionados o avisos registrados, y fija el orden 0037 → 0036.
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
import { psqlAvailable, runPsql } from '../helpers/psql.ts';

const { Pool } = pg;

const MIGRATION_0037 = '0037_consent_and_approval_binding.sql';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const ROLLBACK_0037 = fileURLToPath(new URL('../../scripts/consent-approval-binding-rollback.sql', import.meta.url));
const ROLLBACK_0036 = fileURLToPath(new URL('../../scripts/commercial-quota-rollback.sql', import.meta.url));
const LEGACY_TEXT = 'Autorizo a MainSpot a responder públicamente en mi nombre solo los casos de esta categoría que pasen todas las comprobaciones de seguridad (sin riesgos, sin quejas, con datos verificados). Las demás interacciones quedan para mi revisión. Puedo revocarlo en cualquier momento.';

let admin: pg.Pool | undefined;
let through0036Dir: string | undefined;
let only0037Dir: string | undefined;
let rollbackSql = '';
const databases: string[] = [];
const pools: pg.Pool[] = [];

function databaseUrl(database: string): string {
  const url = new URL(config.testDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function stageMigrations(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mainspot-cab-mig-'));
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
  through0036Dir = await stageMigrations(files.filter((f) => Number(f.slice(0, 4)) <= 36));
  only0037Dir = await stageMigrations([MIGRATION_0037]);
  rollbackSql = withoutPsqlMeta(await readFile(ROLLBACK_0037, 'utf8'));
});

after(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  if (admin) {
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
  for (const dir of [through0036Dir, only0037Dir]) if (dir) await rm(dir, { recursive: true, force: true });
});

/** BD desechable con 0001..0036 y datos de antes de 0037: una política automática, un caso con propuestas y su aviso. */
async function database0036(): Promise<{ url: string; pool: pg.Pool }> {
  assert.ok(admin && through0036Dir);
  const name = `mainspot_cab_mig_${randomBytes(6).toString('hex')}`;
  databases.push(name);
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = databaseUrl(name);
  const pool = new Pool({ connectionString: url, max: 3 });
  pools.push(pool);
  const migrated = await applyMigrations(url, through0036Dir);
  assert.ok(!migrated.applied.includes(MIGRATION_0037));
  await pool.query(`INSERT INTO engagement_policy (policy_id, tenant_id, origin, category, mode, version, max_auto_replies_per_hour, consent_text, decided_by)
    VALUES ('pol_legacy', 'client_a', 'google_review', 'gratitude', 'safe_auto_reply', 1, 10, $1, 'user_a')`, [LEGACY_TEXT]);
  await pool.query(`INSERT INTO engagement_case (case_id, tenant_id, origin, external_ref, author_label, body, state, drafts, notify_status)
    VALUES ('case_mig', 'client_a', 'google_review', 'mig-1', 'Ana', 'Me intoxiqué', 'needs_human', '["uno","dos","tres"]', 'sent')`);
  await pool.query(`INSERT INTO engagement_notification (notification_id, tenant_id, case_id, chat_id, status, attempts, sent_at)
    VALUES ('ntf_mig', 'client_a', 'case_mig', '700000001', 'sent', 1, now())`);
  return { url, pool };
}

async function apply0037(url: string): Promise<string[]> {
  assert.ok(only0037Dir);
  return (await applyMigrations(url, only0037Dir)).applied;
}

/** Todo lo que 0037 no debe alterar (datos), más la forma del esquema que añade. */
const dataState = async (pool: pg.Pool) => [
  (await pool.query('SELECT policy_id, mode, version, consent_text, decided_by FROM engagement_policy ORDER BY policy_id')).rows,
  (await pool.query('SELECT case_id, state, drafts, notify_status FROM engagement_case ORDER BY case_id')).rows,
  (await pool.query('SELECT notification_id, status, attempts FROM engagement_notification ORDER BY notification_id')).rows,
];

async function schemaShape(pool: pg.Pool): Promise<Record<string, number>> {
  const n = async (sql: string) => Number((await pool.query<{ n: string }>(sql)).rows[0]?.n ?? 0);
  return {
    offerTable: await n(`SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'engagement_approval_offer'`),
    policyColumns: await n(`SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'engagement_policy' AND column_name IN ('consent_version','consent_sha256')`),
    revisionColumn: await n(`SELECT count(*) AS n FROM information_schema.columns WHERE table_name = 'engagement_case' AND column_name = 'drafts_revision'`),
    triggers: await n(`SELECT count(*) AS n FROM pg_trigger WHERE tgname IN ('trg_engagement_policy_guard','trg_engagement_case_drafts_revision','trg_engagement_approval_offer_guard','trg_engagement_case_supersede_offers')`),
    functions: await n(`SELECT count(*) AS n FROM pg_proc WHERE proname IN ('engagement_policy_guard','engagement_case_drafts_revision','engagement_approval_offer_guard','engagement_case_supersede_offers')`),
    constraints: await n(`SELECT count(*) AS n FROM pg_constraint WHERE conname IN ('engagement_policy_consent_shape','engagement_policy_auto_reply_consent','engagement_case_drafts_revision_check')`),
  };
}

const ADDED = { offerTable: 1, policyColumns: 2, revisionColumn: 1, triggers: 4, functions: 4, constraints: 3 };
const NONE = { offerTable: 0, policyColumns: 0, revisionColumn: 0, triggers: 0, functions: 0, constraints: 0 };

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

test('0037: conserva políticas, casos y avisos (las automáticas previas quedan sin versión), añade solo su esquema y es re-ejecutable', async () => {
  const db = await database0036();
  const before0037 = await dataState(db.pool);
  assert.deepEqual(await schemaShape(db.pool), NONE);
  assert.deepEqual(await apply0037(db.url), [MIGRATION_0037]);
  assert.deepEqual(await dataState(db.pool), before0037, 'ningún dato existente cambia');
  assert.deepEqual(await schemaShape(db.pool), ADDED);
  const legacy = await db.pool.query('SELECT consent_version, consent_sha256 FROM engagement_policy WHERE policy_id = $1', ['pol_legacy']);
  assert.deepEqual(legacy.rows[0], { consent_version: null, consent_sha256: null }, 'consentimiento previo: sin versión (no cubre la cuota)');
  assert.equal((await db.pool.query(`SELECT drafts_revision FROM engagement_case WHERE case_id = 'case_mig'`)).rows[0]?.drafts_revision, 1);
  const auto = await db.pool.query(`SELECT convalidated FROM pg_constraint WHERE conname = 'engagement_policy_auto_reply_consent'`);
  assert.equal(auto.rows[0]?.convalidated, false, 'NOT VALID: no recorre ni rechaza las filas previas');
  await assert.rejects(db.pool.query(`INSERT INTO engagement_policy (policy_id, tenant_id, origin, category, mode, version, max_auto_replies_per_hour, consent_text, decided_by)
    VALUES ('pol_new', 'client_a', 'google_review', 'basic_info', 'safe_auto_reply', 1, 10, 'x', 'user_a')`), (err: unknown) => sqlState(err) === '23514');

  await db.pool.query('DELETE FROM schema_migrations WHERE file = $1', [MIGRATION_0037]);
  assert.deepEqual(await apply0037(db.url), [MIGRATION_0037], 'aplicada pero no registrada: se re-ejecuta sin error');
  assert.deepEqual(await dataState(db.pool), before0037);
  assert.deepEqual(await schemaShape(db.pool), ADDED);
});

test('reversión de 0037: vuelve al esquema de 0036 sin tocar datos (también con psql, código 0) y 0037 se reaplica', async () => {
  const db = await database0036();
  const before0037 = await dataState(db.pool);
  await apply0037(db.url);
  await runRollback(db.pool);
  assert.deepEqual(await schemaShape(db.pool), NONE);
  assert.deepEqual(await dataState(db.pool), before0037);
  assert.equal((await db.pool.query('SELECT 1 FROM schema_migrations WHERE file = $1', [MIGRATION_0037])).rowCount, 0);
  await assert.rejects(runRollback(db.pool), (err: unknown) => sqlState(err) === '55000', 'una segunda reversión se niega');

  assert.deepEqual(await apply0037(db.url), [MIGRATION_0037]);
  const viaPsql = runPsql(db.url, ROLLBACK_0037);
  assert.equal(viaPsql.status, 0, viaPsql.out);
  assert.deepEqual(await schemaShape(db.pool), NONE);
});

test('reversión de 0037 BLOQUEADA sin cambios (55000; psql ≠ 0) si hay un consentimiento versionado o un aviso registrado', async () => {
  const db = await database0036();
  await apply0037(db.url);
  await db.pool.query(`INSERT INTO engagement_policy (policy_id, tenant_id, origin, category, mode, version, max_auto_replies_per_hour, consent_text, consent_version, consent_sha256, decided_by)
    VALUES ('pol_v', 'client_a', 'google_review', 'gratitude', 'review_required', 2, 10, 'Todas las respuestas públicas de esta categoría quedan pendientes de mi revisión.',
            'review_required.v1', encode(sha256(convert_to('Todas las respuestas públicas de esta categoría quedan pendientes de mi revisión.', 'UTF8')), 'hex'), 'user_a')`);
  await assert.rejects(runRollback(db.pool), (err: unknown) => sqlState(err) === '55000' && /BLOCKED: 1 versioned consent/.test(String((err as Error).message)));
  const blocked = runPsql(db.url, ROLLBACK_0037);
  assert.notEqual(blocked.status, 0, blocked.out);
  assert.deepEqual(await schemaShape(db.pool), ADDED, 'nada cambió');

  const other = await database0036();
  await apply0037(other.url);
  await other.pool.query(`INSERT INTO engagement_approval_offer (offer_id, tenant_id, case_id, notification_id, chat_id, user_id, code, drafts_revision, options, options_sha256)
    VALUES ('ofr_mig', 'client_a', 'case_mig', 'ntf_mig', '700000001', 'user_a_admin', 'ABCDEF', 1, '["uno","dos","tres"]', repeat('a', 64))`);
  await assert.rejects(runRollback(other.pool), (err: unknown) => sqlState(err) === '55000' && /1 approval notice/.test(String((err as Error).message)));
  assert.equal((await other.pool.query('SELECT 1 FROM schema_migrations WHERE file = $1', [MIGRATION_0037])).rowCount, 1);
});

test('orden de reversión: con 0037 registrada, la de 0036 se niega; 0037 → 0036 vuelve al esquema previo', async () => {
  const db = await database0036();
  await apply0037(db.url);
  const r36 = runPsql(db.url, ROLLBACK_0036);
  assert.notEqual(r36.status, 0, 'revertir 0036 con 0037 registrada se niega');
  assert.match(r36.out, /migrations after 0036 are applied/);
  for (const script of [ROLLBACK_0037, ROLLBACK_0036]) {
    const r = runPsql(db.url, script);
    assert.equal(r.status, 0, `${path.basename(script)}: ${r.out}`);
  }
  assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'engagement_case' AND column_name IN ('ai_draft','drafts_revision')`)).rows[0]?.n, 0);
});
