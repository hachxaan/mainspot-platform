/**
 * AC01/AC10 (DEC-0075, SRC-0013) — migración 0034 y su reversión (scripts/plan-catalog-rollback.sql) sobre BD
 * DESECHABLES propias (`mainspot_plancat_mig_<hex>`, mismo servidor y credenciales que TEST_DATABASE_URL; se
 * borran al final aunque las pruebas fallen). Cada BD aplica 0001..0033 y un estado previo realista (plan
 * con límites parciales, plan deshabilitado, plan sin límites, suscripciones en todos los estados y reservas
 * de cuota en todos los estados) antes de 0034:
 *  - backfill EXACTO: revisión 1 PUBLISHED por plan con los valores de plan_limit; capacidad sin fila ⇒ 0
 *    `backfill_absent_deny` (el mismo deny); suscripciones fijadas a v1 con historial `backfill`; reservas
 *    intactas; la huella de SQL coincide con la del servidor; mismas decisiones de cuota;
 *  - 0034 aborta sin pérdida ante una capacidad fuera del registro o un valor sobre el techo de sistema;
 *  - 0034 aplicada pero no registrada en schema_migrations (caída del runner entre ambas sentencias) se
 *    re-ejecuta sin error y sin cambiar el esquema ni los datos;
 *  - BD: TRUNCATE no vacía las tablas append-only o inmutables; con dos conexiones, una escritura de valor y
 *    una publicación simultáneas se serializan (nunca queda PUBLISHED un valor sin confirmar ni con otra
 *    huella, tampoco si la publicación corre en REPEATABLE READ o SERIALIZABLE: falla con 40001) y una
 *    suscripción escrita durante la publicación de su plan queda fijada a la revisión nueva;
 *  - la reversión devuelve el mismo catálogo de BD que antes de 0034 (tablas, columnas, constraints, índices,
 *    triggers y funciones), plan_limit con los valores PUBLICADOS vigentes, funciona con las consultas del
 *    código base 95f9436, aborta ante capacidades ajenas a 0014 y 0034 puede volver a aplicarse;
 *  - G-MIG (PR #14): los preflights (psql, solo lectura) aprueban el estado realista y bloquean exactamente lo que
 *    haría abortar 0034; 0035 se aplica después de 0034 y es re-ejecutable; la reversión de 0034 aborta sin
 *    cambiar nada mientras 0035 esté registrada o haya suscripciones fijadas a revisiones no vigentes, y la
 *    secuencia 0035 → 0034 vuelve al esquema previo.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { applyMigrations } from '../../scripts/migrate.ts';
import { AuditSink } from '../../src/audit/sink.ts';
import { runAtomic } from '../../src/conversation/state-machine.ts';
import { revisionChecksum } from '../../src/plans/catalog.ts';
import { effectiveValue, loadPinnedPolicy, revisionValues } from '../../src/plans/policy.ts';
import { PLAN_PARAMETERS } from '../../src/plans/registry.ts';
import { config } from '../../src/shared/config.ts';
import { AppError } from '../../src/shared/errors.ts';
import { QuotaLedger } from '../../src/subscriptions/quota.ts';
import { createPublishedPlan } from '../helpers/plans.ts';
import { psqlAvailable, resultSets, runPsql } from '../helpers/psql.ts';

const { Pool } = pg;

const MIGRATION_0034 = '0034_plan_policy_catalog.sql';
const MIGRATION_0035 = '0035_platform_auth_shared_attempts.sql';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const ROLLBACK_SCRIPT = new URL('../../scripts/plan-catalog-rollback.sql', import.meta.url);
const HARDENING_ROLLBACK_SCRIPT = new URL('../../scripts/plan-catalog-hardening-rollback.sql', import.meta.url);
const GMIG_PREFLIGHT = fileURLToPath(new URL('../../scripts/plan-catalog-gmig-preflight.sql', import.meta.url));
const ROLLBACK_PREFLIGHT = fileURLToPath(new URL('../../scripts/plan-catalog-rollback-preflight.sql', import.meta.url));

/** Estado previo realista sobre 0001..0033 (además del seed: planes piloto/básico/completo y client_a/b). */
const PRE_STATE_SQL = `
INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active) VALUES
  ('plan_extra',   'Extra',    'Plan con límites parciales', NULL, NULL, false, true),
  ('plan_retired', 'Retirado', 'Plan deshabilitado con todos sus límites', NULL, NULL, false, false),
  ('plan_empty',   'Vacío',    'Plan sin ningún límite', NULL, NULL, false, true);
INSERT INTO plan_limit (limit_id, plan_id, capability, max_value) VALUES
  ('lim_extra_posts',           'plan_extra',   'social_posts',    7),
  ('lim_extra_reviews',         'plan_extra',   'reviews_managed', 0),
  ('lim_extra_conversations',   'plan_extra',   'conversations',   1000000),
  ('lim_retired_website',       'plan_retired', 'website',         1),
  ('lim_retired_posts',         'plan_retired', 'social_posts',    2),
  ('lim_retired_ads',           'plan_retired', 'social_ads',      3),
  ('lim_retired_reviews',       'plan_retired', 'reviews_managed', 4),
  ('lim_retired_agents',        'plan_retired', 'agents',          6),
  ('lim_retired_conversations', 'plan_retired', 'conversations',   8);
INSERT INTO client (client_id, business_name, status, contact_email, metadata) VALUES
  ('client_m_basic',     'Negocio básico',      'active',    'basic@example.com',  '{}'),
  ('client_m_extra',     'Negocio extra',       'active',    'extra@example.com',  '{}'),
  ('client_m_suspended', 'Negocio suspendido',  'suspended', 'susp@example.com',   '{}'),
  ('client_m_cancelled', 'Negocio dado de baja','active',    'cancel@example.com', '{}'),
  ('client_m_empty',     'Negocio sin límites', 'active',    'empty@example.com',  '{}'),
  ('client_m_nosub',     'Negocio sin plan',    'active',    'nosub@example.com',  '{}');
INSERT INTO subscription (subscription_id, tenant_id, plan_id, status, started_at, updated_at) VALUES
  ('sub_m_basic',     'client_m_basic',     'plan_basico',   'active',    now() - interval '40 days',  now() - interval '3 days'),
  ('sub_m_extra',     'client_m_extra',     'plan_extra',    'active',    now() - interval '10 days',  now() - interval '10 days'),
  ('sub_m_suspended', 'client_m_suspended', 'plan_completo', 'suspended', now() - interval '90 days',  now() - interval '1 day'),
  ('sub_m_cancelled', 'client_m_cancelled', 'plan_retired',  'cancelled', now() - interval '400 days', now() - interval '30 days'),
  ('sub_m_empty',     'client_m_empty',     'plan_empty',    'active',    now() - interval '2 days',   now() - interval '2 days');
INSERT INTO quota_reservation (reservation_id, tenant_id, capability, units, idempotency_key, request_id, actor_id, state,
                               resource_ref, created_at, expires_at, settled_at) VALUES
  ('qres_m_committed', 'client_a', 'social_posts', 1, 'k-committed', 'req-1', 'user_a', 'committed', 'social_post/p1',
   now() - interval '10 days', now() - interval '10 days' + interval '2 minutes', now() - interval '10 days'),
  ('qres_m_batch', 'client_m_basic', 'reviews_managed', 3, 'k-batch', 'req-2', 'system:reputation-sync', 'committed', 'review_sync/s1',
   now() - interval '4 days', now() - interval '4 days' + interval '2 minutes', now() - interval '4 days'),
  ('qres_m_live', 'client_a', 'conversations', 1, 'k-live', 'req-3', 'user_a', 'reserved', NULL,
   now(), now() + interval '2 minutes', NULL),
  ('qres_m_stale', 'client_b', 'conversations', 1, 'k-stale', 'req-4', 'user_b', 'reserved', NULL,
   now() - interval '1 hour', now() - interval '58 minutes', NULL),
  ('qres_m_released', 'client_m_extra', 'social_posts', 1, 'k-released', 'req-5', 'user_x', 'released', NULL,
   now() - interval '5 days', now() - interval '5 days' + interval '2 minutes', now() - interval '5 days'),
  ('qres_m_expired', 'client_m_extra', 'website', 1, 'k-expired', 'req-6', 'user_x', 'expired', NULL,
   now() - interval '6 days', now() - interval '6 days' + interval '2 minutes', now() - interval '6 days' + interval '3 minutes');
`;

/** Tablas cuyo contenido compara `snapshot` (si existen en la forma vigente del esquema). */
const TRACKED_TABLES = [
  'schema_migrations', 'permission', 'plan', 'plan_limit', 'plan_limit_legacy_0009', 'subscription', 'subscription_history',
  'quota_reservation', 'plan_parameter_definition', 'plan_revision', 'plan_parameter_value', 'plan_catalog_event',
  'platform_auth_attempt_gate',
];

let admin: pg.Pool | undefined;
let before0034Dir: string | undefined;
let only0034Dir: string | undefined;
let only0035Dir: string | undefined;
let rollbackSql = '';
let hardeningRollbackSql = '';
const databases: string[] = [];
const pools: pg.Pool[] = [];

before(async () => {
  assert.ok(psqlAvailable(), 'los preflights son scripts psql: el cliente psql debe estar instalado');
  admin = new Pool({ connectionString: databaseUrl('postgres'), max: 1 });
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f));
  before0034Dir = await stageMigrations(files.filter((f) => Number(f.slice(0, 4)) < 34));
  only0034Dir = await stageMigrations([MIGRATION_0034]);
  only0035Dir = await stageMigrations([MIGRATION_0035]);
  rollbackSql = withoutPsqlMeta(await readFile(ROLLBACK_SCRIPT, 'utf8'));
  hardeningRollbackSql = withoutPsqlMeta(await readFile(HARDENING_ROLLBACK_SCRIPT, 'utf8'));
});

after(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  if (admin) {
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
  for (const dir of [before0034Dir, only0034Dir, only0035Dir]) if (dir) await rm(dir, { recursive: true, force: true });
});

function databaseUrl(database: string): string {
  const url = new URL(config.testDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function stageMigrations(files: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mainspot-plancat-mig-'));
  for (const file of files) await copyFile(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
  return dir;
}

/** BD desechable en la forma anterior a 0034 (0001..0033) con el estado previo realista. */
async function legacyDatabase(): Promise<{ url: string; pool: pg.Pool }> {
  assert.ok(admin && before0034Dir);
  const name = `mainspot_plancat_mig_${randomBytes(6).toString('hex')}`;
  databases.push(name);
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = databaseUrl(name);
  const pool = new Pool({ connectionString: url, max: 4 });
  pools.push(pool);
  const migrated = await applyMigrations(url, before0034Dir);
  assert.ok(migrated.applied.length > 0 && !migrated.applied.includes(MIGRATION_0034));
  await pool.query(PRE_STATE_SQL);
  return { url, pool };
}

async function apply0034(url: string): Promise<string[]> {
  assert.ok(only0034Dir);
  return (await applyMigrations(url, only0034Dir)).applied;
}

async function apply0035(url: string): Promise<string[]> {
  assert.ok(only0035Dir);
  return (await applyMigrations(url, only0035Dir)).applied;
}

/** BD desechable con 0034 aplicada sobre el estado previo realista. */
async function migratedDatabase(): Promise<{ url: string; pool: pg.Pool }> {
  const db = await legacyDatabase();
  assert.deepEqual(await apply0034(db.url), [MIGRATION_0034]);
  return db;
}

/**
 * Los scripts de reversión imponen `\set ON_ERROR_STOP on` (meta-comando de psql); para ejecutarlos con pg y
 * comprobar su SQLSTATE se omite esa línea. Su código de salida con psql se comprueba aparte (G-MIG).
 */
function withoutPsqlMeta(sql: string): string {
  return sql.split('\n').filter((line) => !/^\\[a-z]/.test(line)).join('\n');
}

/** Ejecuta un script de reversión tal cual (su propio BEGIN … COMMIT); si falla, cierra la transacción abortada. */
async function runScript(pool: pg.Pool, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(sql);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function runRollback(pool: pg.Pool): Promise<void> {
  return runScript(pool, rollbackSql);
}

function pgCode(err: unknown): unknown {
  return err instanceof Error && 'code' in err ? err.code : undefined;
}

/** Catálogo de BD del esquema public: relaciones y columnas, constraints, índices, triggers, funciones y extensiones. */
async function fingerprint(pool: pg.Pool): Promise<Record<string, unknown[]>> {
  const rows = async (sql: string) => (await pool.query(sql)).rows;
  return {
    columns: await rows(`
      SELECT c.relname AS rel, c.relkind AS kind, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type,
             a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_value
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       ORDER BY c.relname COLLATE "C", a.attnum`),
    constraints: await rows(`
      SELECT conrelid::regclass::text AS rel, conname AS name, contype AS type, pg_get_constraintdef(oid) AS def
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace
       ORDER BY conrelid::regclass::text COLLATE "C", conname COLLATE "C"`),
    indexes: await rows(`
      SELECT tablename AS rel, indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname = 'public'
       ORDER BY tablename COLLATE "C", indexname COLLATE "C"`),
    triggers: await rows(`
      SELECT c.relname AS rel, t.tgname AS name, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE NOT t.tgisinternal AND n.nspname = 'public'
       ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C"`),
    functions: await rows(`
      SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, md5(pg_get_functiondef(p.oid)) AS def
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
       ORDER BY p.proname COLLATE "C", pg_get_function_identity_arguments(p.oid) COLLATE "C"`),
    extensions: await rows(`SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname COLLATE "C"`),
  };
}

/** Esquema + contenido completo de las tablas afectadas por 0034 (filas serializadas y ordenadas). */
async function snapshot(pool: pg.Pool): Promise<{ schema: Record<string, unknown[]>; data: Record<string, string[]> }> {
  const data: Record<string, string[]> = {};
  for (const table of TRACKED_TABLES) {
    const exists = (await pool.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${table}`])).rows[0]?.ok;
    if (exists) data[table] = (await pool.query(`SELECT * FROM ${table}`)).rows.map((row) => JSON.stringify(row)).sort();
  }
  return { schema: await fingerprint(pool), data };
}

interface LegacyLimit { limit_id: string; plan_id: string; capability: string; max_value: number }
interface LegacySubscription { subscription_id: string; tenant_id: string; plan_id: string; status: string; started_at: Date; updated_at: Date }
type QuotaRow = { reservation_id: string } & Record<string, unknown>;
interface LegacyState { plans: string[]; limits: LegacyLimit[]; subscriptions: LegacySubscription[]; quota: QuotaRow[] }

const QUOTA_ROWS_SQL = 'SELECT * FROM quota_reservation ORDER BY reservation_id COLLATE "C"';

/** Estado en la forma 0009/0014 (antes de 0034 o tras la reversión). */
async function legacyState(pool: pg.Pool): Promise<LegacyState> {
  return {
    plans: (await pool.query<{ plan_id: string }>('SELECT plan_id FROM plan ORDER BY plan_id COLLATE "C"')).rows.map((r) => r.plan_id),
    limits: (await pool.query<LegacyLimit>('SELECT limit_id, plan_id, capability, max_value FROM plan_limit ORDER BY limit_id COLLATE "C"')).rows,
    subscriptions: (await pool.query<LegacySubscription>(
      'SELECT subscription_id, tenant_id, plan_id, status, started_at, updated_at FROM subscription ORDER BY subscription_id COLLATE "C"')).rows,
    quota: (await pool.query<QuotaRow>(QUOTA_ROWS_SQL)).rows,
  };
}

function limitsOf(limits: readonly LegacyLimit[], planId: string): Record<string, number> {
  return Object.fromEntries(limits.filter((l) => l.plan_id === planId).map((l) => [l.capability, l.max_value]));
}

/**
 * Parámetros que define 0034 (registro 1). Estas pruebas trabajan sobre BD con 0034/0035 sin 0036 ni 0038, así que la
 * cuota de respuestas con IA (registro 2, DEC-0076) y el medidor de sugerencias de Facebook (registro 3, DEC-0078) no
 * existen en ellas; sus migraciones se prueban en commercial-quota-migration y facebook-ai-policy-migration.
 */
const LATER_REGISTRY_KEYS: readonly string[] = ['quota.ai_review_replies.max', 'quota.ai_facebook_suggestions.max'];
const PARAMETERS_0034 = PLAN_PARAMETERS.filter((d) => !LATER_REGISTRY_KEYS.includes(d.key));
const PARAMETERS_BY_KEY = [...PARAMETERS_0034].sort((a, b) => (a.key < b.key ? -1 : 1));

/** Tras aplicar 0034 sobre `legacy`: el catálogo versionado reproduce EXACTAMENTE sus valores y asignaciones. */
async function assertExactBackfill(pool: pg.Pool, legacy: LegacyState): Promise<void> {
  const legacyLimit = (planId: string, capability: string) => legacy.limits.find((l) => l.plan_id === planId && l.capability === capability);

  const revisions = (await pool.query<{ plan_id: string; revision_id: string; version: number; status: string; origin: string; checksum: string; sql_checksum: string }>(
    `SELECT plan_id, revision_id, version, status, origin, checksum, plan_revision_checksum(revision_id) AS sql_checksum
       FROM plan_revision ORDER BY plan_id COLLATE "C", version`)).rows;
  assert.deepEqual(revisions.map((r) => [r.plan_id, r.revision_id, r.version, r.status, r.origin]),
    legacy.plans.map((planId) => [planId, `prv_${planId}_v1`, 1, 'PUBLISHED', 'backfill']), 'una revisión 1 publicada por plan');
  for (const r of revisions) {
    assert.equal(r.checksum, r.sql_checksum, `huella SQL de ${r.plan_id}`);
    assert.equal(r.checksum, revisionChecksum(await revisionValues(pool, r.revision_id)), `huella del servidor de ${r.plan_id}`);
  }

  const values = (await pool.query(
    `SELECT r.plan_id, v.parameter_key, v.value_int, v.value_bool, v.source, v.confirmed_at IS NOT NULL AS confirmed
       FROM plan_parameter_value v JOIN plan_revision r USING (revision_id)
      ORDER BY r.plan_id COLLATE "C", v.parameter_key COLLATE "C"`)).rows;
  assert.deepEqual(values, legacy.plans.flatMap((planId) => PARAMETERS_BY_KEY.map((def) => {
    const row = legacyLimit(planId, def.capability);
    return {
      plan_id: planId, parameter_key: def.key, value_int: row?.max_value ?? 0, value_bool: null,
      source: row ? 'backfill' : 'backfill_absent_deny', confirmed: true,
    };
  })), 'mismos valores; sin fila ⇒ 0 explícito con el mismo deny');

  assert.equal((await pool.query<{ t: string | null }>(`SELECT to_regclass('public.plan_limit')::text AS t`)).rows[0]?.t, null);
  assert.deepEqual(
    (await pool.query<LegacyLimit>('SELECT limit_id, plan_id, capability, max_value FROM plan_limit_legacy_0009 ORDER BY limit_id COLLATE "C"')).rows,
    legacy.limits, 'plan_limit se conserva intacta como legado');
  for (const sql of [
    `INSERT INTO plan_limit_legacy_0009 (limit_id, plan_id, capability, max_value) VALUES ('lim_nuevo', 'plan_basico', 'agents', 1)`,
    'UPDATE plan_limit_legacy_0009 SET max_value = max_value + 1',
    'DELETE FROM plan_limit_legacy_0009',
  ]) {
    await assert.rejects(pool.query(sql), (err: unknown) => pgCode(err) === '42501', `legado de solo lectura: ${sql}`);
  }

  const subscriptions = (await pool.query(
    `SELECT subscription_id, tenant_id, plan_id, status, started_at, updated_at, plan_revision_id
       FROM subscription ORDER BY subscription_id COLLATE "C"`)).rows;
  assert.deepEqual(subscriptions, legacy.subscriptions.map((s) => ({ ...s, plan_revision_id: `prv_${s.plan_id}_v1` })),
    'cada suscripción queda fijada a la revisión 1 de su plan, sin otros cambios');
  const history = (await pool.query(
    `SELECT subscription_id, tenant_id, change_kind, plan_id, plan_revision_id, status, previous_plan_id, previous_revision_id,
            previous_status, actor, reason IS NOT NULL AS has_reason
       FROM subscription_history ORDER BY subscription_id COLLATE "C"`)).rows;
  assert.deepEqual(history, legacy.subscriptions.map((s) => ({
    subscription_id: s.subscription_id, tenant_id: s.tenant_id, change_kind: 'backfill', plan_id: s.plan_id,
    plan_revision_id: `prv_${s.plan_id}_v1`, status: s.status, previous_plan_id: s.plan_id, previous_revision_id: null,
    previous_status: s.status, actor: 'system:migration-0034', has_reason: true,
  })), 'una entrada de historial `backfill` por suscripción');

  assert.deepEqual((await pool.query(QUOTA_ROWS_SQL)).rows, legacy.quota, 'las reservas de cuota no cambian');
  await assert.rejects(pool.query(
    `INSERT INTO quota_reservation (reservation_id, tenant_id, capability, units, idempotency_key, request_id, actor_id, state, expires_at)
     VALUES ('qres_desconocida', 'client_a', 'capacidad_desconocida', 1, 'k-desconocida', 'req-x', 'user_a', 'reserved', now())`),
  (err: unknown) => pgCode(err) === '23503', 'el libro solo admite capacidades del registro');

  for (const s of legacy.subscriptions) {
    const policy = await loadPinnedPolicy(pool, s.tenant_id);
    assert.ok(policy, s.tenant_id);
    assert.deepEqual(PARAMETERS_0034.map((def) => effectiveValue(policy, def)?.value),
      PARAMETERS_0034.map((def) => legacyLimit(s.plan_id, def.capability)?.max_value ?? 0), `valores efectivos de ${s.tenant_id}`);
  }
}

// ------------------------------------------------------------------ catálogo después de 0034 (SQL directo)

const EXTRA_V2 = { website: 1, social_posts: 9, social_ads: 2, reviews_managed: 0, agents: 3, conversations: 50 };
const NEW_V1 = { website: 1, social_posts: 4, social_ads: 0, reviews_managed: 6, agents: 2, conversations: 25 };

/** Borrador siguiente del plan con TODOS los valores confirmados (listo para publicar); devuelve su id. */
async function confirmedDraft(client: pg.PoolClient, planId: string, limits: Record<string, number>): Promise<string> {
  const current = (await client.query<{ revision_id: string; version: number }>(
    `SELECT revision_id, version FROM plan_revision WHERE plan_id = $1 AND status = 'PUBLISHED'`, [planId])).rows[0];
  assert.ok(current);
  const revisionId = `prv_${planId}_v${current.version + 1}`;
  await client.query(
    `INSERT INTO plan_revision (revision_id, plan_id, version, status, origin, based_on_revision_id, registry_version, reason, created_by)
     VALUES ($1, $2, $3, 'DRAFT', 'edit', $4, 1, 'Revisión posterior a 0034 (prueba de migración)', 'platform:test')`,
    [revisionId, planId, current.version + 1, current.revision_id]);
  for (const def of PARAMETERS_0034) {
    await client.query(
      `INSERT INTO plan_parameter_value (revision_id, parameter_key, value_int, source, confirmed_by, confirmed_at, updated_by)
       VALUES ($1, $2, $3, 'explicit', 'platform:test', now(), 'platform:test')`, [revisionId, def.key, limits[def.capability]]);
  }
  return revisionId;
}

/** Publica el borrador como el catálogo: `plan FOR UPDATE`, la publicada vigente pasa a SUPERSEDED y la huella la calcula la BD. */
async function publishDraft(client: pg.PoolClient, planId: string, revisionId: string): Promise<void> {
  await client.query('SELECT 1 FROM plan WHERE plan_id = $1 FOR UPDATE', [planId]);
  await client.query(`UPDATE plan_revision SET status = 'SUPERSEDED', superseded_at = now() WHERE plan_id = $1 AND status = 'PUBLISHED'`, [planId]);
  await client.query(
    `UPDATE plan_revision SET status = 'PUBLISHED', published_by = 'platform:test', published_at = now(),
            publish_reason = 'Publicación posterior a 0034 (prueba de migración)', checksum = plan_revision_checksum(revision_id)
      WHERE revision_id = $1`, [revisionId]);
}

type Step = (client: pg.PoolClient) => Promise<unknown>;

/** `step` en su propia transacción: COMMIT si termina; ROLLBACK y relanza si falla. */
async function inTransaction(client: pg.PoolClient, step: Step): Promise<unknown> {
  await client.query('BEGIN');
  try {
    const result = await step(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/**
 * Dos conexiones a la vez: `first` corre en una transacción que queda ABIERTA y entonces `second` corre en la
 * suya. Espera a que `second` quede bloqueada por la primera (o termine sin esperar), confirma la primera y
 * devuelve si `second` esperó y cómo terminó: 'ok' o el SQLSTATE con que se rechazó.
 */
async function race(pool: pg.Pool, first: Step, second: Step): Promise<{ waited: boolean; outcome: unknown }> {
  const holder = await pool.connect();
  const contender = await pool.connect();
  let running: Promise<Array<PromiseSettledResult<unknown>>> | undefined;
  try {
    await holder.query('BEGIN');
    await first(holder);
    const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    assert.ok(holderPid);
    let settled = false;
    running = Promise.allSettled([inTransaction(contender, second).finally(() => { settled = true; })]);
    let waited = false;
    const deadline = Date.now() + 10_000;
    while (!waited && !settled && Date.now() < deadline) {
      waited = (await pool.query<{ blocked: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))) AS blocked', [holderPid])).rows[0]?.blocked === true;
      if (!waited) await sleep(10);
    }
    await holder.query('COMMIT');
    const [settledSecond] = await running;
    assert.ok(settledSecond);
    return { waited, outcome: settledSecond.status === 'fulfilled' ? 'ok' : (pgCode(settledSecond.reason) ?? settledSecond.reason) };
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined); // sin efecto tras el COMMIT
    await running;
    holder.release();
    contender.release();
  }
}

// ------------------------------------------------------------------ 0034: backfill, aborto sin pérdida y re-ejecución

test('0034: backfill exacto de planes, valores, suscripciones, historial y reservas; mismas decisiones de cuota', async () => {
  const db = await legacyDatabase();
  const legacy = await legacyState(db.pool);
  assert.deepEqual(await apply0034(db.url), [MIGRATION_0034]);
  await assertExactBackfill(db.pool, legacy);

  // Mismas decisiones que con plan_limit: fila ⇒ su máximo; sin fila o 0 ⇒ deny; sin suscripción activa ⇒ deny.
  const ledger = new QuotaLedger({ pool: db.pool, sink: new AuditSink(db.pool) });
  const decide = (tenant: string, capability: string) => runAtomic(db.pool, (client) => ledger.assertCapacity(client, tenant, capability, 1))
    .then(() => 'allow', (err: unknown) => (err instanceof AppError ? err.code : String(err)));
  assert.deepEqual(await Promise.all([
    decide('client_m_basic', 'social_posts'), // plan_basico: 3
    decide('client_m_basic', 'conversations'), // sin fila en 0009
    decide('client_m_extra', 'reviews_managed'), // 0 explícito
    decide('client_m_extra', 'conversations'), // 1 000 000 (techo de validación)
    decide('client_m_empty', 'website'), // plan sin límites
    decide('client_m_suspended', 'social_posts'),
    decide('client_m_cancelled', 'social_posts'),
    decide('client_m_nosub', 'social_posts'),
  ]), ['allow', 'limit_exceeded', 'limit_exceeded', 'allow', 'limit_exceeded', 'subscription_required', 'subscription_required', 'subscription_required']);
});

for (const [label, badRow] of [
  ['una capacidad fuera del registro', `('lim_desconocida', 'plan_basico', 'capacidad_heredada', 4)`],
  ['un valor por encima del techo de sistema', `('lim_extra_websites', 'plan_extra', 'website', 2)`],
] as const) {
  test(`0034 aborta sin pérdida si plan_limit tiene ${label}`, async () => {
    const db = await legacyDatabase();
    await db.pool.query(`INSERT INTO plan_limit (limit_id, plan_id, capability, max_value) VALUES ${badRow}`);
    const before = await snapshot(db.pool);
    await assert.rejects(apply0034(db.url));
    assert.deepEqual(await snapshot(db.pool), before, 'ni el esquema ni los datos cambian');
  });
}

test('0034 aplicada pero no registrada (caída del runner antes de schema_migrations) se re-ejecuta sin error, duplicados ni cambios', async () => {
  const db = await migratedDatabase();
  // Estado que una re-ejecución no idempotente alteraría: plan_extra con v2 publicada (v1 SUPERSEDED, con su
  // suscripción fijada) y un plan deshabilitado creado por SQL sin ninguna revisión (el backfill le crearía una).
  await runAtomic(db.pool, async (client) => publishDraft(client, 'plan_extra', await confirmedDraft(client, 'plan_extra', EXTRA_V2)));
  await db.pool.query(`
    INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active, created_by)
    VALUES ('plan_no_revision', 'Sin revisiones', 'Plan deshabilitado creado por SQL tras 0034', NULL, NULL, false, false, 'platform:test')`);
  const applied = await snapshot(db.pool);
  const runsSql = 'SELECT file FROM schema_migrations ORDER BY file COLLATE "C"';
  const appliedRuns = (await db.pool.query(runsSql)).rows;

  await db.pool.query('DELETE FROM schema_migrations WHERE file = $1', [MIGRATION_0034]);
  assert.deepEqual(await apply0034(db.url), [MIGRATION_0034], 'el runner vuelve a ejecutar 0034 y la registra');
  assert.deepEqual((await db.pool.query(runsSql)).rows, appliedRuns, '0034 registrada una sola vez');
  const rerun = await snapshot(db.pool);
  assert.deepEqual(rerun.schema, applied.schema, 'mismo esquema');
  // schema_migrations queda fuera: su applied_at es el de la re-ejecución.
  const { schema_migrations: _appliedRuns, ...appliedData } = applied.data;
  const { schema_migrations: _rerunRuns, ...rerunData } = rerun.data;
  assert.deepEqual(rerunData, appliedData,
    'sin duplicados ni cambios en planes, revisiones, valores, suscripciones, historial, eventos, reservas ni legado');
});

// ------------------------------------------------------------------ invariantes de BD de 0034

test('BD: TRUNCATE no vacía el historial de suscripciones, los eventos del catálogo, los valores, las revisiones ni el legado', async () => {
  const db = await migratedDatabase();
  await db.pool.query(`
    INSERT INTO plan_catalog_event (event_id, actor_id, action, plan_id, reason)
    VALUES ('pce_m_truncate', 'platform:test', 'plan.updated', 'plan_extra', 'Evento previo al TRUNCATE')`);
  for (const table of ['subscription_history', 'plan_catalog_event', 'plan_parameter_value', 'plan_revision', 'plan_limit_legacy_0009']) {
    const countSql = `SELECT count(*)::int AS n FROM ${table}`;
    const before = (await db.pool.query<{ n: number }>(countSql)).rows;
    assert.ok((before[0]?.n ?? 0) > 0, `${table} tiene filas`);
    // CASCADE: sin él, plan_revision (referenciada por otras tablas) ya falla por la FK antes del trigger.
    await assert.rejects(db.pool.query(`TRUNCATE ${table} CASCADE`), (err: unknown) => pgCode(err) === '42501', table);
    assert.deepEqual((await db.pool.query(countSql)).rows, before, `${table} conserva sus filas`);
  }
});

test('BD: escribir un valor y publicar a la vez se serializa; nunca queda PUBLISHED un valor sin confirmar ni con otra huella', async () => {
  const db = await migratedDatabase();
  const changePosts = (revisionId: string, reconfirm: boolean): Step => (client) => client.query(
    `UPDATE plan_parameter_value SET value_int = value_int + 1${reconfirm ? `, confirmed_by = 'platform:test', confirmed_at = now()` : ''}
      WHERE revision_id = $1 AND parameter_key = 'quota.social_posts.max'`, [revisionId]);
  // Publicación por SQL en `level` con su instantánea tomada ANTES de que la escritura del valor se confirme.
  const isolatedPublish = (level: string, planId: string, revisionId: string): Step => async (client) => {
    await client.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
    await client.query('SELECT 1');
    await publishDraft(client, planId, revisionId);
  };
  const scenarios: Array<[name: string, order: (planId: string, revisionId: string) => [Step, Step], code: string, status: string]> = [
    // Escritura en curso sin confirmar: la publicación espera, ve el valor sin confirmar y se rechaza.
    ['unconfirmed', (planId, revisionId) => [changePosts(revisionId, false), (client) => publishDraft(client, planId, revisionId)], '23514', 'DRAFT'],
    // Escritura en curso reconfirmada: la huella que la publicación calculó antes de esperar ya no coincide.
    ['reconfirmed', (planId, revisionId) => [changePosts(revisionId, true), (client) => publishDraft(client, planId, revisionId)], '23514', 'DRAFT'],
    // Publicación en curso: la escritura del valor espera y la revisión ya publicada la rechaza.
    ['published', (planId, revisionId) => [(client) => publishDraft(client, planId, revisionId), changePosts(revisionId, false)], '42501', 'PUBLISHED'],
    // Escritura en curso que se confirma primero y publicación con instantánea anterior: validaría con los valores
    // viejos; bloquear los valores al publicar la hace fallar con 40001.
    ['repeatable_read', (planId, revisionId) => [changePosts(revisionId, false), isolatedPublish('REPEATABLE READ', planId, revisionId)], '40001', 'DRAFT'],
    ['serializable', (planId, revisionId) => [changePosts(revisionId, false), isolatedPublish('SERIALIZABLE', planId, revisionId)], '40001', 'DRAFT'],
  ];
  for (const [name, order, code, status] of scenarios) {
    const planId = `plan_race_value_${name}`;
    await createPublishedPlan(db.pool, planId, NEW_V1);
    const revisionId = await runAtomic(db.pool, (client) => confirmedDraft(client, planId, EXTRA_V2));
    const { waited, outcome } = await race(db.pool, ...order(planId, revisionId));
    const inconsistent = (await db.pool.query(
      `SELECT r.revision_id FROM plan_revision r
        WHERE r.status IN ('PUBLISHED', 'SUPERSEDED')
          AND (r.checksum IS DISTINCT FROM plan_revision_checksum(r.revision_id)
               OR EXISTS (SELECT 1 FROM plan_parameter_value v WHERE v.revision_id = r.revision_id AND v.confirmed_at IS NULL))`)).rows;
    assert.deepEqual(inconsistent, [], `${name}: ninguna revisión publicada con un valor sin confirmar ni otra huella`);
    const after = (await db.pool.query<{ status: string }>('SELECT status FROM plan_revision WHERE revision_id = $1', [revisionId])).rows[0]?.status;
    assert.deepEqual([waited, outcome, after], [true, code, status], name);
  }
});

test('BD: una suscripción escrita durante la publicación de su plan queda fijada a la revisión nueva', async () => {
  const db = await migratedDatabase();
  const writes: Array<[tenantId: string, write: (planId: string) => Step]> = [
    // Alta por SQL sin candado previo del plan.
    ['client_m_nosub', (planId) => (client) => client.query(
      `INSERT INTO subscription (subscription_id, tenant_id, plan_id, status) VALUES ('sub_m_race', 'client_m_nosub', $1, 'active')`, [planId])],
    // Cambio de plan por SQL.
    ['client_m_basic', (planId) => (client) => client.query(`UPDATE subscription SET plan_id = $1 WHERE tenant_id = 'client_m_basic'`, [planId])],
  ];
  for (const [tenantId, write] of writes) {
    const planId = `plan_race_${tenantId}`;
    await createPublishedPlan(db.pool, planId, NEW_V1);
    const next = await runAtomic(db.pool, (client) => confirmedDraft(client, planId, EXTRA_V2));
    const { waited, outcome } = await race(db.pool, (client) => publishDraft(client, planId, next), write(planId));
    const pinned = (await db.pool.query(
      `SELECT s.plan_revision_id, r.status FROM subscription s JOIN plan_revision r ON r.revision_id = s.plan_revision_id
        WHERE s.tenant_id = $1`, [tenantId])).rows;
    assert.deepEqual(pinned, [{ plan_revision_id: next, status: 'PUBLISHED' }], `${tenantId}: fijada a la revisión que quedó publicada`);
    assert.deepEqual([waited, outcome], [true, 'ok'], tenantId);
  }
});

// ------------------------------------------------------------------ reversión

/** Consultas literales del código base 95f9436 (src/subscriptions/quota.ts y src/subscriptions/entitlements.ts). */
const BASE_95F9436 = {
  subscription: 'SELECT plan_id, status FROM subscription WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1',
  limit: 'SELECT max_value FROM plan_limit WHERE plan_id = $1 AND capability = $2',
  assign: `INSERT INTO subscription (subscription_id, tenant_id, plan_id, status)
       VALUES ($1,$2,$3,'active')
       ON CONFLICT (tenant_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active', updated_at = now()
       RETURNING *`,
  overLimit: `SELECT s.tenant_id, l.capability, l.max_value FROM subscription s
         JOIN plan_limit l ON l.plan_id = s.plan_id WHERE s.status = 'active' ORDER BY s.tenant_id, l.capability`,
  reserve: `INSERT INTO quota_reservation
         (reservation_id, tenant_id, capability, units, idempotency_key, request_id, actor_id, state, resource_ref, expires_at, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               clock_timestamp() + ($10::int * interval '1 millisecond'),
               CASE WHEN $8::text = 'reserved' THEN NULL ELSE clock_timestamp() END)
       ON CONFLICT (tenant_id, capability, idempotency_key) DO UPDATE SET
         units = EXCLUDED.units, request_id = EXCLUDED.request_id, actor_id = EXCLUDED.actor_id,
         state = EXCLUDED.state, resource_ref = EXCLUDED.resource_ref, created_at = clock_timestamp(),
         expires_at = EXCLUDED.expires_at, settled_at = EXCLUDED.settled_at
       RETURNING *`,
};

test('reversión: vuelve al esquema previo a 0034 con los valores publicados vigentes, aborta ante capacidades ajenas a 0014 y 0034 se reaplica', async () => {
  const db = await legacyDatabase();
  const pre = await snapshot(db.pool);
  const preLegacy = await legacyState(db.pool);
  assert.deepEqual(await apply0034(db.url), [MIGRATION_0034]);
  const migratedSchema = await fingerprint(db.pool);

  // 1. Sin cambios en el catálogo, la reversión devuelve EXACTAMENTE el estado previo: plan_limit incluida, sin
  //    uq_plan_name_lower ni los triggers (solo lectura y TRUNCATE) que 0034 puso a plan_limit_legacy_0009.
  await runRollback(db.pool);
  assert.deepEqual(await snapshot(db.pool), pre);
  await assert.rejects(runRollback(db.pool), (err: unknown) => pgCode(err) === '55000', 'sin 0034 no hay nada que revertir');
  assert.deepEqual(await snapshot(db.pool), pre);

  // 2. 0034 se reaplica sobre el esquema revertido: mismo esquema y backfill exacto otra vez.
  assert.deepEqual(await apply0034(db.url), [MIGRATION_0034]);
  assert.deepEqual(await fingerprint(db.pool), migratedSchema);
  await assertExactBackfill(db.pool, preLegacy);

  // 3. Actividad del catálogo después de 0034: plan_extra publica v2 (client_m_extra sigue fijada a v1, SUPERSEDED).
  await runAtomic(db.pool, async (client) => publishDraft(client, 'plan_extra', await confirmedDraft(client, 'plan_extra', EXTRA_V2)));
  await createPublishedPlan(db.pool, 'plan_new', NEW_V1, { name: 'Nuevo' });
  await db.pool.query(`INSERT INTO subscription (subscription_id, tenant_id, plan_id, status) VALUES ('sub_m_new', 'client_m_nosub', 'plan_new', 'active')`);
  await db.pool.query(`
    INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active, created_by)
    VALUES ('plan_draft', 'Borrador', 'Plan creado tras 0034 y aún sin publicar', NULL, NULL, false, false, 'platform:test');
    INSERT INTO plan_revision (revision_id, plan_id, version, status, origin, registry_version, reason, created_by)
    VALUES ('prv_plan_draft_v1', 'plan_draft', 1, 'DRAFT', 'create', 1, 'Plan creado tras 0034, sin publicar', 'platform:test');
    INSERT INTO plan_parameter_value (revision_id, parameter_key, value_int, source, updated_by)
    VALUES ('prv_plan_draft_v1', 'quota.social_posts.max', 10, 'suggested', 'platform:test');
    INSERT INTO quota_reservation (reservation_id, tenant_id, capability, units, idempotency_key, request_id, actor_id, state,
                                   resource_ref, created_at, expires_at, settled_at)
    VALUES ('qres_m_after', 'client_m_nosub', 'social_posts', 1, 'k-after', 'req-after', 'user_new', 'committed', 'social_post/p-after',
            now(), now() + interval '2 minutes', now())`);

  // 4. Una capacidad posterior a 0014 en el libro de cuotas aborta la reversión sin cambiar nada.
  await db.pool.query(`
    INSERT INTO plan_parameter_definition (parameter_key, capability, category, label, description, unit, value_type, semantics, period_kind,
      window_seconds, min_value, max_value, ceiling_reason, suggested_int, suggested_bool, enforcement_state, registry_version, sort_order)
    VALUES ('test.future_units.max', 'future_units', 'Pruebas', 'Unidades futuras', 'Capacidad posterior a 0014', 'unidades', 'int',
      'cumulative', 'none', NULL, 0, 10, 'Techo de prueba', 0, NULL, 'enforced', 1, 990);
    INSERT INTO quota_reservation (reservation_id, tenant_id, capability, units, idempotency_key, request_id, actor_id, state,
                                   resource_ref, created_at, expires_at, settled_at)
    VALUES ('qres_m_future', 'client_a', 'future_units', 1, 'k-future', 'req-future', 'user_a', 'committed', 'future/f1',
            now(), now() + interval '2 minutes', now())`);
  const blocked = await snapshot(db.pool);
  await assert.rejects(runRollback(db.pool), (err: unknown) => pgCode(err) === '23514');
  assert.deepEqual(await snapshot(db.pool), blocked, 'la reversión abortada no cambia nada');
  await db.pool.query(`DELETE FROM quota_reservation WHERE reservation_id = 'qres_m_future'`);
  await db.pool.query(`DELETE FROM plan_parameter_definition WHERE parameter_key = 'test.future_units.max'`);

  // 5. Reversión con el catálogo modificado: si hay suscripciones fijadas a una revisión
  // SUPERSEDED, aborta (no cambia silenciosamente los límites del negocio).
  const unsafeRollback = await snapshot(db.pool);
  await assert.rejects(runRollback(db.pool), (err: unknown) => pgCode(err) === '55000',
    'el rollback bloquea la pérdida de los derechos fijados a v1');
  assert.deepEqual(await snapshot(db.pool), unsafeRollback, 'rollback bloqueado sin escrituras');

  // Tras una migración EXPLÍCITA y autorizada (en esta BD desechable), se permite revertir.
  await db.pool.query(`UPDATE subscription
      SET plan_revision_id = (SELECT revision_id FROM plan_revision WHERE plan_id = 'plan_extra' AND status = 'PUBLISHED')
      WHERE tenant_id = 'client_m_extra'`);
  await runRollback(db.pool);
  const after = await snapshot(db.pool);
  assert.deepEqual(after.schema, pre.schema, 'mismo catálogo de BD que antes de 0034');
  assert.deepEqual([after.data['schema_migrations'], after.data['permission']], [pre.data['schema_migrations'], pre.data['permission']],
    '0034 olvidada y descripciones de permisos de 0009');
  const rolled = await legacyState(db.pool);
  const touched = ['plan_extra', 'plan_new', 'plan_draft'];
  assert.deepEqual(rolled.limits.filter((l) => !touched.includes(l.plan_id)), preLegacy.limits.filter((l) => !touched.includes(l.plan_id)),
    'los planes sin revisiones nuevas conservan exactamente sus filas');
  assert.deepEqual(limitsOf(rolled.limits, 'plan_extra'), EXTRA_V2, 'plan_extra: valores de su revisión PUBLISHED (v2)');
  assert.deepEqual(rolled.limits.filter((l) => l.limit_id.startsWith('lim_extra_')).map((l) => l.limit_id),
    ['lim_extra_conversations', 'lim_extra_posts', 'lim_extra_reviews'], 'las filas de 0009 conservan su limit_id');
  assert.deepEqual(limitsOf(rolled.limits, 'plan_new'), NEW_V1);
  assert.deepEqual(limitsOf(rolled.limits, 'plan_draft'), {}, 'sin revisión publicada: sin filas (deny)');
  assert.deepEqual(rolled.plans, [...preLegacy.plans, 'plan_draft', 'plan_new'].sort());
  assert.deepEqual(rolled.subscriptions.filter((s) => s.subscription_id !== 'sub_m_new'), preLegacy.subscriptions);
  assert.deepEqual(rolled.quota.filter((q) => q.reservation_id !== 'qres_m_after'), preLegacy.quota, 'las reservas previas no cambian');
  assert.deepEqual(rolled.quota.filter((q) => q.reservation_id === 'qres_m_after').map((q) => q['state']), ['committed'],
    'la reserva posterior a 0034 sigue');

  // 6. El código base 95f9436 funciona sobre el esquema revertido (sus consultas literales).
  const base = async (sql: string, params: unknown[]) => (await db.pool.query(sql, params)).rows;
  assert.deepEqual(await base(BASE_95F9436.subscription, ['client_m_extra']), [{ plan_id: 'plan_extra', status: 'active' }]);
  assert.deepEqual(await base(BASE_95F9436.limit, ['plan_extra', 'social_posts']), [{ max_value: 9 }],
    'la suscripción migrada explícitamente a v2 conserva su valor (v2 es la publicada)');
  assert.deepEqual(await base(BASE_95F9436.limit, ['plan_basico', 'conversations']), [], 'sin fila: deny, como antes de 0034');
  const assigned = await base(BASE_95F9436.assign, ['sub_base', 'client_m_basic', 'plan_completo']);
  assert.deepEqual(assigned.map((row) => [Object.keys(row).sort(), row['plan_id']]),
    [[['plan_id', 'started_at', 'status', 'subscription_id', 'tenant_id', 'updated_at'], 'plan_completo']]);
  assert.ok((await base(BASE_95F9436.overLimit, [])).some((row) => row['tenant_id'] === 'client_m_basic' && row['capability'] === 'social_posts'));
  const reserveRow = ['qres_base', 'client_m_basic', 'conversations', 1, 'k-base', 'req-base', 'user_base', 'reserved', null, 120_000];
  assert.equal((await base(BASE_95F9436.reserve, reserveRow))[0]?.['state'], 'reserved');
  await assert.rejects(db.pool.query(BASE_95F9436.reserve, ['qres_base_x', 'client_m_basic', 'future_units', 1, 'k-x', 'req-x', 'user_base', 'reserved', null, 120_000]),
    (err: unknown) => pgCode(err) === '23514', 'CHECK de capacidades de 0014 restaurado');

  // 7. 0034 se reaplica después de la reversión: la revisión 1 de cada plan toma lo que quedó en plan_limit.
  const beforeReapply = await legacyState(db.pool);
  assert.deepEqual(await apply0034(db.url), [MIGRATION_0034]);
  assert.deepEqual(await fingerprint(db.pool), migratedSchema);
  await assertExactBackfill(db.pool, beforeReapply);
});

// ------------------------------------------------------------------ G-MIG (PR #14): preflights, 0035 y orden de reversión

const GMIG_HEADERS = [
  'plan_count|enabled_plans', 'status|subscription_count', 'legacy_limits', 'unknown_capabilities|incompatible_values',
  'duplicate_normalized_name|n', 'subscriptions_without_existing_plan', 'reservations_with_unknown_capability',
  'plan_id|active|explicit_capabilities|currently_missing_capabilities_denied',
];
const ROLLBACK_PREFLIGHT_HEADERS = [
  'subscriptions|pinned_to_current_revision|pinned_to_superseded_revision|inconsistent_pins',
  'capabilities_not_supported_by_0014', 'later_migrations',
  'blocked_0034_not_registered|blocked_later_migrations|blocked_foreign_capabilities|blocked_non_current_pins',
];

test('preflight G-MIG: antes de 0034 solo lee y aprueba el estado realista; tras 0034 se niega con su motivo', async () => {
  const db = await legacyDatabase();
  const before = await snapshot(db.pool);
  const run = runPsql(db.url, GMIG_PREFLIGHT);
  assert.equal(run.status, 0, run.out);
  const sets = resultSets(run.out, GMIG_HEADERS);
  assert.deepEqual(sets.get('plan_count|enabled_plans'), [['6', '5']], run.out);
  assert.deepEqual(sets.get('unknown_capabilities|incompatible_values'), [['0', '0']]);
  assert.deepEqual(sets.get('duplicate_normalized_name|n'), []);
  assert.deepEqual(sets.get('subscriptions_without_existing_plan'), [['0']]);
  assert.deepEqual(sets.get('reservations_with_unknown_capability'), [['0']]);
  const perPlan = new Map((sets.get('plan_id|active|explicit_capabilities|currently_missing_capabilities_denied') ?? []).map((r) => [r[0], r.slice(1)]));
  assert.deepEqual([perPlan.get('plan_extra'), perPlan.get('plan_retired'), perPlan.get('plan_empty')],
    [['t', '3', '3'], ['f', '6', '0'], ['t', '0', '6']], 'capacidades sin fila (hoy deny) que 0034 explicita como 0');
  assert.deepEqual(await snapshot(db.pool), before, 'solo lectura');

  assert.deepEqual(await apply0034(db.url), [MIGRATION_0034]);
  const applied = runPsql(db.url, GMIG_PREFLIGHT);
  assert.notEqual(applied.status, 0);
  assert.match(applied.out, /G-MIG BLOCKED: 0034 appears applied/);
});

for (const [label, dirt, message] of [
  ['una capacidad fuera del registro', `INSERT INTO plan_limit (limit_id, plan_id, capability, max_value) VALUES ('lim_x', 'plan_basico', 'capacidad_heredada', 4)`, /unknown\/out-of-range existing plan limits/],
  ['un valor sobre el techo de sistema', `INSERT INTO plan_limit (limit_id, plan_id, capability, max_value) VALUES ('lim_x', 'plan_extra', 'website', 2)`, /unknown\/out-of-range existing plan limits/],
  ['nombres de plan iguales sin distinguir mayúsculas', `INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active) VALUES ('plan_extra_dup', 'EXTRA', 'Duplicado por mayúsculas', NULL, NULL, false, true)`, /duplicate case-insensitive plan names/],
  ['un libro de cuotas con una capacidad que se desvió del registro', `ALTER TABLE quota_reservation DROP CONSTRAINT quota_reservation_capability_check;
    INSERT INTO quota_reservation (reservation_id, tenant_id, capability, units, idempotency_key, request_id, actor_id, state, expires_at)
    VALUES ('qres_drift', 'client_a', 'legacy_x', 1, 'k-drift', 'req-drift', 'user_a', 'reserved', now())`, /quota_reservation has capabilities outside the registry/],
  ['un objeto de 0034 que ya existe con otra forma', `CREATE TABLE plan_parameter_definition (parameter_key TEXT PRIMARY KEY)`, /objects of 0034 already exist/],
] as const) {
  test(`preflight G-MIG: ${label} ⇒ bloquea (código ≠ 0) y 0034 también aborta, sin cambiar nada`, async () => {
    const db = await legacyDatabase();
    await db.pool.query(dirt);
    const before = await snapshot(db.pool);
    const run = runPsql(db.url, GMIG_PREFLIGHT);
    assert.notEqual(run.status, 0, run.out);
    assert.match(run.out, message);
    assert.deepEqual(await snapshot(db.pool), before);
    await assert.rejects(apply0034(db.url));
    assert.deepEqual(await snapshot(db.pool), before, '0034 aborta sin pérdida');
  });
}

test('G-MIG 0034 → 0035: re-ejecutable; revertir 0034 exige revertir 0035 antes y no fijar negocios a revisiones no vigentes; la secuencia vuelve al esquema previo', async () => {
  const db = await legacyDatabase();
  const pre = await snapshot(db.pool);
  assert.deepEqual(await apply0034(db.url), [MIGRATION_0034]);
  const only0034 = await fingerprint(db.pool);
  assert.deepEqual(await apply0035(db.url), [MIGRATION_0035]);
  const with0035 = await snapshot(db.pool);

  // 0035: solo huellas hexadecimales y como mucho 5 intentos por clave.
  await assert.rejects(db.pool.query(`INSERT INTO platform_auth_attempt_gate (key_hash) VALUES ('login:192.0.2.1|admin')`),
    (err: unknown) => pgCode(err) === '23514', 'ningún login ni IP en claro');
  await assert.rejects(db.pool.query(
    `INSERT INTO platform_auth_attempt_gate (key_hash, attempt_times) VALUES (repeat('b', 64), ARRAY(SELECT now() FROM generate_series(1, 6)))`),
  (err: unknown) => pgCode(err) === '23514', 'tope de 5 intentos');

  // 0035 aplicada pero no registrada: se re-ejecuta sin error ni cambios.
  await db.pool.query('DELETE FROM schema_migrations WHERE file = $1', [MIGRATION_0035]);
  assert.deepEqual(await apply0035(db.url), [MIGRATION_0035]);
  const rerun = await snapshot(db.pool);
  assert.deepEqual(rerun.schema, with0035.schema);
  const { schema_migrations: _a, ...withData } = with0035.data;
  const { schema_migrations: _b, ...rerunData } = rerun.data;
  assert.deepEqual(rerunData, withData);

  // Actividad posterior: un contador vivo y plan_extra publica v2 (client_m_extra sigue fijada a v1, SUPERSEDED).
  await db.pool.query(`INSERT INTO platform_auth_attempt_gate (key_hash, attempt_times) VALUES (repeat('a', 64), ARRAY[now()])`);
  await runAtomic(db.pool, async (client) => publishDraft(client, 'plan_extra', await confirmedDraft(client, 'plan_extra', EXTRA_V2)));

  const rollbackPreflight = (wouldAbort: boolean) => {
    const run = runPsql(db.url, ROLLBACK_PREFLIGHT);
    if (wouldAbort) {
      assert.notEqual(run.status, 0, run.out);
      assert.match(run.out, /G-MIG ROLLBACK BLOCKED/);
    } else {
      assert.equal(run.status, 0, run.out);
    }
    return resultSets(run.out, ROLLBACK_PREFLIGHT_HEADERS);
  };
  let pf = rollbackPreflight(true);
  // 7 suscripciones (sub_a y sub_b de 0009 + las 5 del estado previo): 6 en su revisión vigente, 1 en v1 SUPERSEDED.
  assert.deepEqual(pf.get(ROLLBACK_PREFLIGHT_HEADERS[0]!), [['7', '6', '1', '0']]);
  assert.deepEqual(pf.get('later_migrations'), [['1']]);
  assert.deepEqual(pf.get(ROLLBACK_PREFLIGHT_HEADERS[3]!), [['f', 't', 'f', 't']]);

  // 1. Con 0035 registrada, la reversión de 0034 aborta antes de cualquier DDL; con psql, código distinto de 0.
  let blocked = await snapshot(db.pool);
  await assert.rejects(runRollback(db.pool),
    (err: unknown) => pgCode(err) === '55000' && err instanceof Error && /migrations after 0034/.test(err.message));
  assert.deepEqual(await snapshot(db.pool), blocked, 'aborto sin cambios');
  const viaPsql = runPsql(db.url, fileURLToPath(ROLLBACK_SCRIPT));
  assert.notEqual(viaPsql.status, 0, 'el operador ve el aborto en el código de salida aunque no pase ON_ERROR_STOP');
  assert.match(viaPsql.out, /migrations after 0034/);
  assert.deepEqual(await snapshot(db.pool), blocked);

  // 2. Reversión de 0035: borra la tabla (y sus contadores) y olvida 0035; una segunda ejecución se niega.
  await runScript(db.pool, hardeningRollbackSql);
  assert.equal((await db.pool.query<{ t: string | null }>(`SELECT to_regclass('public.platform_auth_attempt_gate')::text AS t`)).rows[0]?.t, null);
  assert.deepEqual(await fingerprint(db.pool), only0034, 'mismo esquema que con solo 0034');
  blocked = await snapshot(db.pool);
  await assert.rejects(runScript(db.pool, hardeningRollbackSql),
    (err: unknown) => err instanceof Error && /Migration 0035 not registered/.test(err.message));
  assert.notEqual(runPsql(db.url, fileURLToPath(HARDENING_ROLLBACK_SCRIPT)).status, 0);
  assert.deepEqual(await snapshot(db.pool), blocked);

  // 3. Una suscripción fijada a una revisión SUPERSEDED bloquea la reversión de 0034 sin cambiar nada.
  pf = rollbackPreflight(true);
  assert.deepEqual(pf.get(ROLLBACK_PREFLIGHT_HEADERS[3]!), [['f', 'f', 'f', 't']]);
  await assert.rejects(runRollback(db.pool),
    (err: unknown) => pgCode(err) === '55000' && err instanceof Error && /pinned to non-current revisions/.test(err.message));
  assert.deepEqual(await snapshot(db.pool), blocked, 'derechos fijados intactos');

  // 4. Con la migración explícita del negocio (aquí, BD desechable) la secuencia termina en el esquema previo.
  await db.pool.query(`UPDATE subscription SET plan_revision_id = 'prv_plan_extra_v2' WHERE tenant_id = 'client_m_extra'`);
  pf = rollbackPreflight(false);
  assert.deepEqual(pf.get(ROLLBACK_PREFLIGHT_HEADERS[3]!), [['f', 'f', 'f', 'f']]);
  await runRollback(db.pool);
  assert.deepEqual((await snapshot(db.pool)).schema, pre.schema, 'mismo catálogo de BD que antes de 0034');

  // 5. 0034 y 0035 se reaplican.
  assert.deepEqual(await apply0034(db.url), [MIGRATION_0034]);
  assert.deepEqual(await apply0035(db.url), [MIGRATION_0035]);
  assert.deepEqual(await fingerprint(db.pool), with0035.schema);
});

test('G-MIG: la reversión bloquea el catálogo antes de comprobar las fijaciones; una publicación en curso termina antes y la hace abortar', async () => {
  const db = await migratedDatabase();
  const migrated = await fingerprint(db.pool);
  const next = await runAtomic(db.pool, (client) => confirmedDraft(client, 'plan_extra', EXTRA_V2));
  // La publicación de v2 queda abierta; la reversión arranca mientras tanto. Sin el bloqueo previo, la comprobación
  // vería v1 aún PUBLISHED y la regeneración de plan_limit tomaría v2: client_m_extra cambiaría de límites en silencio.
  const { waited, outcome } = await race(db.pool, (client) => publishDraft(client, 'plan_extra', next), (client) => client.query(rollbackSql));
  assert.deepEqual([waited, outcome], [true, '55000'], 'espera a la publicación y aborta por la fijación a v1');
  assert.deepEqual(await fingerprint(db.pool), migrated, 'nada revertido');
  const pinned = (await db.pool.query(
    `SELECT s.plan_revision_id, r.status FROM subscription s JOIN plan_revision r ON r.revision_id = s.plan_revision_id
      WHERE s.tenant_id = 'client_m_extra'`)).rows;
  assert.deepEqual(pinned, [{ plan_revision_id: 'prv_plan_extra_v1', status: 'SUPERSEDED' }], 'la fijación sigue intacta');
});

test('G-MIG: con REPEATABLE READ por defecto en la sesión, la reversión sigue comprobando los datos posteriores a su bloqueo', async () => {
  const db = await migratedDatabase();
  const migrated = await fingerprint(db.pool);
  const next = await runAtomic(db.pool, (client) => confirmedDraft(client, 'plan_extra', EXTRA_V2));
  const holder = await db.pool.connect();
  const contender = await db.pool.connect();
  try {
    await holder.query('BEGIN');
    await publishDraft(holder, 'plan_extra', next);
    const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    // Con la instantánea tomada antes del LOCK (BEGIN sin nivel), vería v1 aún PUBLISHED y revertiría.
    await contender.query(`SET default_transaction_isolation = 'repeatable read'`);
    const running = contender.query(rollbackSql).then(() => 'ok', (err: unknown) => pgCode(err));
    let blocked = false;
    for (let i = 0; i < 500 && !blocked; i++) {
      blocked = (await db.pool.query<{ b: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))) AS b', [holderPid])).rows[0]?.b === true;
      if (!blocked) await sleep(10);
    }
    await holder.query('COMMIT');
    assert.deepEqual([blocked, await running], [true, '55000']);
    await contender.query('ROLLBACK').catch(() => undefined);
  } finally {
    holder.release();
    contender.release();
  }
  assert.deepEqual(await fingerprint(db.pool), migrated, 'nada revertido');
});

test('G-MIG: el preflight de reversión y la reversión se niegan si ya existe una relación plan_limit', async () => {
  const db = await migratedDatabase();
  await db.pool.query('CREATE VIEW plan_limit AS SELECT * FROM plan_limit_legacy_0009');
  const before = await snapshot(db.pool);
  const run = runPsql(db.url, ROLLBACK_PREFLIGHT);
  assert.notEqual(run.status, 0, run.out);
  assert.match(run.out, /a relation named plan_limit already exists/);
  await assert.rejects(runRollback(db.pool), (err: unknown) => err instanceof Error && /a relation named plan_limit already exists/.test(err.message));
  assert.deepEqual(await snapshot(db.pool), before);
});

for (const [label, leftover] of [
  ['una columna plan.created_by de otro tipo', 'ALTER TABLE plan ADD COLUMN created_by INT'],
  ['una restricción con el nombre del FK del libro de cuotas', 'ALTER TABLE quota_reservation ADD CONSTRAINT quota_reservation_capability_fk CHECK (true)'],
  ['un índice con el nombre del índice único de publicadas en otra tabla', 'CREATE UNIQUE INDEX uq_plan_revision_one_published ON client (client_id)'],
] as const) {
  test(`preflight G-MIG: ${label} (0034 la adoptaría en silencio) ⇒ bloquea sin cambiar nada`, async () => {
    const db = await legacyDatabase();
    await db.pool.query(leftover);
    const before = await snapshot(db.pool);
    const run = runPsql(db.url, GMIG_PREFLIGHT);
    assert.notEqual(run.status, 0, run.out);
    assert.match(run.out, /objects of 0034 already exist/);
    assert.deepEqual(await snapshot(db.pool), before);
  });
}
