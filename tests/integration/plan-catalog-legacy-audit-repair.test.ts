/**
 * G-SEC/R1 — scripts/plan-catalog-legacy-audit-{preflight,repair}.sql ejecutados con `psql` (son scripts psql:
 * \if, \gset), igual que los ejecutaría el DBA, sobre BD DESECHABLES propias (`mainspot_r1_<hex>`, mismo servidor
 * y credenciales que TEST_DATABASE_URL; se borran al final). Nunca toca la BD de desarrollo ni otra real.
 * Antes de 0034 la guarda de plataforma escribía `req.path` (`/tenants/client_x/plan`, en cualquier caja y con
 * barra final opcional) en denegaciones SIN tenant, y un login fallido guardaba el login tecleado en claro: la
 * anonimización (DEC-0027) no puede re-etiquetar esas filas y su verificación falla.
 *  - preflight: solo recuentos, sin identificadores, con los mismos predicados que la reparación: filas
 *    reparables, logins en claro, filas fuera de contrato y negocios que no podrían anonimizarse;
 *  - repair: se niega (código ≠ 0, sin cambiar nada) sin APPLY exactamente 1, sin TARGET_DB de la sesión, sin
 *    EXPECTED_ROWS entero o con otro recuento, y mientras quede otro identificador fuerte de un negocio vivo
 *    (no solo `client_…`: también correos, logins, slugs y subdominios); nunca depende del ON_ERROR_STOP del
 *    operador. Autorizado, cambia SOLO `resource` a la ruta canónica, deja el trigger activo y un evento
 *    agregado, y la anonimización vuelve a funcionar; los logins en claro solo se redactan con su flag.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { anonymizationDryRun } from '../../scripts/anonymization-dry-run.ts';
import { applyMigrations } from '../../scripts/migrate.ts';
import { AuditSink } from '../../src/audit/sink.ts';
import { RetentionService } from '../../src/retention/service.ts';
import { config } from '../../src/shared/config.ts';
import { psqlAvailable, resultSets, runPsql } from '../helpers/psql.ts';

const { Pool } = pg;

const PREFLIGHT = fileURLToPath(new URL('../../scripts/plan-catalog-legacy-audit-preflight.sql', import.meta.url));
const REPAIR = fileURLToPath(new URL('../../scripts/plan-catalog-legacy-audit-repair.sql', import.meta.url));

const SUMMARY = 'legacy_denials_eligible_for_targeted_repair|legacy_failed_logins_with_clear_login';
const BY_ACTION = 'action|candidate_rows';
const OUT_OF_CONTRACT = 'out_of_contract_kind|rows_naming_a_tenant';
const ORPHANS = 'unbound_rows_with_client_id_of_no_live_tenant';
const BLOCKERS = 'store|rows_naming_a_tenant|tenants_whose_anonymization_would_fail';
const HEADERS = [SUMMARY, BY_ACTION, OUT_OF_CONTRACT, ORPHANS, BLOCKERS];

let admin: pg.Pool | undefined;
const databases: string[] = [];
const pools: pg.Pool[] = [];

before(async () => {
  assert.ok(psqlAvailable(), 'these scripts are psql scripts: the psql client must be installed to test them');
  admin = new Pool({ connectionString: databaseUrl('postgres'), max: 1 });
});

after(async () => {
  for (const pool of pools) await pool.end().catch(() => undefined);
  if (admin) {
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});

function databaseUrl(database: string): string {
  const url = new URL(config.testDatabaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

interface Scratch { name: string; url: string; pool: pg.Pool }

/** BD desechable con todas las migraciones aplicadas. */
async function scratchDatabase(): Promise<Scratch> {
  assert.ok(admin);
  const name = `mainspot_r1_${randomBytes(6).toString('hex')}`;
  databases.push(name);
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = databaseUrl(name);
  await applyMigrations(url);
  const pool = new Pool({ connectionString: url, max: 3 });
  pools.push(pool);
  return { name, url, pool };
}

function preflight(db: Scratch): Map<string, string[][]> {
  const run = runPsql(db.url, PREFLIGHT);
  assert.equal(run.status, 0, run.out);
  return resultSets(run.out, HEADERS);
}

function repair(db: Scratch, vars: Record<string, string>): { status: number | null; out: string } {
  return runPsql(db.url, REPAIR, vars);
}

interface LegacyFixture { luna: string; taller: string; tallerEmail: string; lunaLogin: string; repairable: Record<string, string>; clearLogin: string | null }

/**
 * Dos negocios con datos de contacto y las filas que escribía el código anterior (inserción directa: la tabla es
 * append-only). Las 4 denegaciones heredadas, con la ruta canónica que debe quedar; opcionalmente, un login
 * fallido en claro con el login de una persona del café.
 */
async function legacyRows(pool: pg.Pool, opts: { clearLogin: boolean }): Promise<LegacyFixture> {
  const suffix = randomUUID().slice(0, 6);
  const luna = `client_cafe_luna_${suffix}`;
  const taller = `client_taller_${suffix}`;
  const tallerEmail = `taller-${suffix}@example.com`;
  const lunaLogin = `owner-${suffix}@cafe-luna.example`;
  await pool.query(
    `INSERT INTO client (client_id, business_name, status, contact_email, metadata) VALUES
       ($1, 'Café Luna', 'active', $3, '{}'), ($2, 'Taller', 'active', $4, '{}')`,
    [luna, taller, `luna-${suffix}@example.com`, tallerEmail]);
  await pool.query(
    `INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash)
     VALUES ($1, 'Persona Luna', $2, 'active', $3, 'x')`, [`user_luna_${suffix}`, lunaLogin, luna]);
  const repairable: Record<string, string> = {
    [`pae_l1_${suffix}`]: '/api/platform/tenants/:id/plan',
    [`pae_l2_${suffix}`]: '/api/platform/tenants/:id',
    [`pae_l3_${suffix}`]: '/api/platform/tenants/:id/status',
    [`pae_l6_${suffix}`]: '/api/platform/tenants/:id/support-view',
  };
  const [l1, l2, l3, l6] = Object.keys(repairable);
  await pool.query(
    `INSERT INTO platform_audit_event (event_id, actor_id, actor_roles, action, resource, tenant_id, decision, result, reason, request_id) VALUES
       ($1, 'pu_support', '{platform_support}', 'platform.tenant.plan', '/tenants/' || $5 || '/plan', NULL, 'deny', 'role_denied', NULL, 'req_l1'),
       ($2, 'pu_support', '{platform_support}', 'platform.tenant.read', '/tenants/' || $5, NULL, 'deny', 'role_denied', NULL, 'req_l2'),
       ($3, 'pu_admin', '{platform_admin}', 'platform.tenant.status', '/api/platform/tenants/' || $6 || '/status', NULL, 'deny', 'step_up_required', NULL, NULL),
       ($4, 'pu_support', '{platform_support}', 'platform.support.view', '/Tenants/' || $6 || '/Support-View/', NULL, 'deny', 'role_denied', NULL, NULL),
       ($7, 'pu_admin', '{platform_admin}', 'platform.tenant.read', 'client/' || $6, $6, 'allow', 'ok', NULL, 'req_l5')`,
    [l1, l2, l3, l6, luna, taller, `pae_l5_${suffix}`]);
  let clearLogin: string | null = null;
  if (opts.clearLogin) {
    clearLogin = `pae_l4_${suffix}`;
    await pool.query(
      `INSERT INTO platform_audit_event (event_id, actor_id, actor_roles, action, resource, tenant_id, decision, result)
       VALUES ($1, 'login:' || $2, '{}', 'platform.login', NULL, NULL, 'deny', 'bad_password_or_user')`, [clearLogin, lunaLogin]);
  }
  return { luna, taller, tallerEmail, lunaLogin, repairable, clearLogin };
}

async function auditRows(pool: pg.Pool): Promise<Map<string, Record<string, unknown>>> {
  const rows = (await pool.query<Record<string, unknown> & { event_id: string }>('SELECT * FROM platform_audit_event ORDER BY event_id')).rows;
  return new Map(rows.map((r) => [r.event_id, r]));
}

async function triggerEnabled(pool: pg.Pool): Promise<string | undefined> {
  return (await pool.query<{ tgenabled: string }>(
    `SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'platform_audit_event'::regclass AND tgname = 'trg_platform_audit_immutable'`)).rows[0]?.tgenabled;
}

function anonymize(pool: pg.Pool, tenantId: string) {
  return new RetentionService({ pool, sink: new AuditSink(pool) }).anonymizeTenant(tenantId, `ret_${randomUUID()}`);
}

test('R1 preflight: solo recuentos sin identificadores; detecta reparables (también en otra caja), logins en claro y negocios no anonimizables', async () => {
  const db = await scratchDatabase();
  const fx = await legacyRows(db.pool, { clearLogin: true });
  const before = await auditRows(db.pool);

  const run = runPsql(db.url, PREFLIGHT);
  assert.equal(run.status, 0, run.out);
  for (const secret of [fx.luna, fx.taller, fx.lunaLogin, fx.tallerEmail, 'cafe-luna', ...Object.keys(fx.repairable)]) {
    assert.ok(!run.out.includes(secret), 'el preflight no emite identificadores');
  }
  const sets = resultSets(run.out, HEADERS);
  assert.deepEqual(sets.get(SUMMARY), [['4', '1']], run.out);
  assert.deepEqual(sets.get(BY_ACTION), [
    ['platform.support.view', '1'], ['platform.tenant.plan', '1'], ['platform.tenant.read', '1'], ['platform.tenant.status', '1'],
  ]);
  assert.deepEqual(sets.get(OUT_OF_CONTRACT), [['legacy_clear_login', '1']], 'el login en claro nombra a una persona del café');
  assert.deepEqual(sets.get(ORPHANS), [['0']]);
  // 4 denegaciones + 1 login en claro nombran a los 2 negocios; la fila con tenant se re-etiqueta y no cuenta.
  assert.deepEqual(sets.get(BLOCKERS), [['platform_audit_event', '5', '2'], ['TOTAL', '5', '2']]);
  assert.deepEqual(await auditRows(db.pool), before, 'el preflight es de solo lectura');
});

test('R1 repair: se niega sin autorización exacta, sin la BD correcta o con otro recuento, sin ON_ERROR_STOP del operador y sin cambiar nada', async () => {
  const db = await scratchDatabase();
  await legacyRows(db.pool, { clearLogin: false });
  const before = await auditRows(db.pool);
  const ok = { APPLY: '1', TARGET_DB: db.name, EXPECTED_ROWS: '4' };

  const refusals: Array<[Record<string, string>, RegExp]> = [
    [{}, /BLOCKED: require -v APPLY=1/],
    [{ TARGET_DB: db.name, EXPECTED_ROWS: '4' }, /BLOCKED: require -v APPLY=1/],
    [{ ...ok, APPLY: 'yes' }, /BLOCKED: require -v APPLY=1/],
    [{ ...ok, APPLY: 'on' }, /BLOCKED: require -v APPLY=1/],
    [{ ...ok, APPLY: '0' }, /BLOCKED: require -v APPLY=1/],
    [{ APPLY: '1', TARGET_DB: db.name }, /BLOCKED: require -v EXPECTED_ROWS/],
    [{ ...ok, EXPECTED_ROWS: 'abc' }, /BLOCKED: require -v EXPECTED_ROWS/],
    [{ ...ok, EXPECTED_ROWS: '4; DROP TABLE plan' }, /BLOCKED: require -v EXPECTED_ROWS/],
    [{ APPLY: '1', EXPECTED_ROWS: '4' }, /BLOCKED: -v TARGET_DB must name the database/],
    [{ ...ok, TARGET_DB: 'mainspot' }, /BLOCKED: -v TARGET_DB must name the database/],
    [{ ...ok, REDACT_LEGACY_LOGIN_ACTORS: '1' }, /BLOCKED: REDACT_LEGACY_LOGIN_ACTORS must be 0 or 1/],
    [{ ...ok, REDACT_LEGACY_LOGIN_ACTORS: 'yes', EXPECTED_LOGIN_ROWS: '0' }, /BLOCKED: REDACT_LEGACY_LOGIN_ACTORS must be 0 or 1/],
    [{ ...ok, EXPECTED_ROWS: '3' }, /candidate count changed; found 4, expected 3/],
    [{ ...ok, EXPECTED_ROWS: '5' }, /candidate count changed; found 4, expected 5/],
  ];
  for (const [vars, message] of refusals) {
    const run = repair(db, vars);
    assert.notEqual(run.status, 0, `${JSON.stringify(vars)} debe fallar: ${run.out}`);
    assert.match(run.out, message, JSON.stringify(vars));
    assert.deepEqual(await auditRows(db.pool), before, `${JSON.stringify(vars)}: sin cambios`);
    assert.equal(await triggerEnabled(db.pool), 'O');
  }
  assert.equal((await db.pool.query(`SELECT to_regclass('public.plan') IS NOT NULL AS ok`)).rows[0]?.ok, true);
});

for (const [label, reason, boundTo, kind] of [
  ['un id client_ en el motivo de una fila sin tenant', (fx: LegacyFixture) => `ajuste pedido por ${fx.taller}`, () => null, 'unbound.reason'],
  ['el correo de un negocio (no es client_) en el motivo de una fila sin tenant', (fx: LegacyFixture) => `lo pidió ${fx.tallerEmail} por teléfono`, () => null, 'unbound.reason'],
  // Al anonimizar el café se limpia su motivo, pero mientras exista bloquea la anonimización del taller.
  ['el correo de OTRO negocio en el motivo de una fila con tenant', (fx: LegacyFixture) => `lo pidió ${fx.tallerEmail} por teléfono`, (fx: LegacyFixture) => fx.luna, 'bound.reason'],
] as const) {
  test(`R1 repair: ${label} ⇒ revisión manual: el preflight lo cuenta y la reparación no cambia nada`, async () => {
    const db = await scratchDatabase();
    const fx = await legacyRows(db.pool, { clearLogin: false });
    await db.pool.query(
      `INSERT INTO platform_audit_event (event_id, actor_id, actor_roles, action, resource, tenant_id, decision, result, reason)
       VALUES ($1, 'pu_admin', '{platform_admin}', 'platform.support.grant', 'client/x', $3, 'allow', 'ok', $2)`,
      [`pae_other_${randomUUID().slice(0, 6)}`, reason(fx), boundTo(fx)]);
    const before = await auditRows(db.pool);

    assert.deepEqual(preflight(db).get(OUT_OF_CONTRACT), [[kind, '1']]);
    const run = repair(db, { APPLY: '1', TARGET_DB: db.name, EXPECTED_ROWS: '4' });
    assert.notEqual(run.status, 0, run.out);
    assert.match(run.out, new RegExp(`1 row\\(s\\) with tenant identifiers in ${kind.replace('.', '\\.')}`));
    assert.match(run.out, /outside this contract need manual review/);
    assert.deepEqual(await auditRows(db.pool), before);
    assert.equal(await triggerEnabled(db.pool), 'O');
  });
}

test('R1 repair: un client_ que no es de ningún negocio vivo solo se avisa; la reparación sigue y no lo toca', async () => {
  const db = await scratchDatabase();
  await legacyRows(db.pool, { clearLogin: false });
  const ghost = `pae_ghost_${randomUUID().slice(0, 6)}`;
  await db.pool.query(
    `INSERT INTO platform_audit_event (event_id, actor_id, actor_roles, action, resource, tenant_id, decision, result, reason)
     VALUES ($1, 'pu_admin', '{platform_admin}', 'platform.budget.update', 'ai_budget/tenant_day', NULL, 'allow', 'ok', 'ajuste del antiguo client_inexistente_0a1b2c')`,
    [ghost]);
  const ghostRow = (await auditRows(db.pool)).get(ghost);
  assert.deepEqual(preflight(db).get(ORPHANS), [['1']]);
  assert.deepEqual(preflight(db).get(OUT_OF_CONTRACT), []);
  const run = repair(db, { APPLY: '1', TARGET_DB: db.name, EXPECTED_ROWS: '4' });
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /1 row\(s\) without tenant mention a client_ id of no live tenant; left unchanged/);
  assert.deepEqual((await auditRows(db.pool)).get(ghost), ghostRow);
});

test('R1 repair autorizado: solo cambia resource a la ruta canónica, conserva el resto, la inmutabilidad vuelve y la anonimización funciona', async () => {
  const db = await scratchDatabase();
  const fx = await legacyRows(db.pool, { clearLogin: false });
  const before = await auditRows(db.pool);
  const clients = async () => (await db.pool.query('SELECT client_id, status FROM client ORDER BY client_id')).rows;
  const clientsBefore = await clients();

  // Antes: el ensayo (la anonimización real, siempre revertida) bloquea los dos negocios y no cambia nada.
  const dryBefore = await anonymizationDryRun(db.pool);
  assert.deepEqual([dryBefore.tenants, dryBefore.anonymizable, dryBefore.blocked], [4, 2, 2], JSON.stringify(dryBefore));
  assert.deepEqual(Object.keys(dryBefore.byLocation), ['platform_audit_event.resource']);
  assert.deepEqual([await auditRows(db.pool), await clients()], [before, clientsBefore], 'el ensayo no cambia nada');
  await assert.rejects(anonymize(db.pool, fx.taller), /identifier left in platform_audit_event\.resource/);
  assert.deepEqual(await auditRows(db.pool), before);

  const run = repair(db, { APPLY: '1', TARGET_DB: db.name, EXPECTED_ROWS: '4' });
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /OK: legacy denials rewritten/);

  const after = await auditRows(db.pool);
  for (const [eventId, row] of before) {
    const canonical = fx.repairable[eventId];
    assert.deepEqual(after.get(eventId), canonical ? { ...row, resource: canonical } : row, `${eventId}: solo cambia resource de las reparables`);
  }
  const added = [...after.values()].filter((r) => !before.has(r['event_id'] as string));
  assert.equal(added.length, 1);
  assert.deepEqual([added[0]?.['action'], added[0]?.['result'], added[0]?.['tenant_id']],
    ['platform.audit.legacy_deny_sanitized', 'rows:4 login_actors:0', null]);

  assert.equal(await triggerEnabled(db.pool), 'O');
  await assert.rejects(db.pool.query(`UPDATE platform_audit_event SET result = 'x' WHERE event_id = $1`, [Object.keys(fx.repairable)[0]]),
    (err: unknown) => err instanceof Error && 'code' in err && err.code === '42501', 'la inmutabilidad vuelve a regir');

  const again = repair(db, { APPLY: '1', TARGET_DB: db.name, EXPECTED_ROWS: '4' });
  assert.notEqual(again.status, 0, 'una segunda ejecución se niega');
  assert.match(again.out, /nothing to repair/);

  assert.deepEqual(preflight(db).get(BLOCKERS), [['TOTAL', '0', '0']]);
  const dryAfter = await anonymizationDryRun(db.pool);
  assert.deepEqual([dryAfter.anonymizable, dryAfter.blocked], [4, 0], JSON.stringify(dryAfter));
  await anonymize(db.pool, fx.taller);
  await anonymize(db.pool, fx.luna);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM client WHERE client_id = ANY($1)', [[fx.taller, fx.luna]])).rows[0]?.n, 0);
});

test('R1 repair: un login heredado en claro que nombra a una persona bloquea la reparación; solo con su flag y recuento se redacta', async () => {
  const db = await scratchDatabase();
  const fx = await legacyRows(db.pool, { clearLogin: true });
  const before = await auditRows(db.pool);
  const base = { APPLY: '1', TARGET_DB: db.name, EXPECTED_ROWS: '4' };

  const blocked = repair(db, base);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.out, /1 row\(s\) with tenant identifiers in unbound\.actor_id/);
  assert.deepEqual(await auditRows(db.pool), before, 'sin la decisión del propietario no cambia nada');
  const wrongCount = repair(db, { ...base, REDACT_LEGACY_LOGIN_ACTORS: '1', EXPECTED_LOGIN_ROWS: '2' });
  assert.match(wrongCount.out, /legacy login count changed; found 1, expected 2/);
  assert.deepEqual(await auditRows(db.pool), before);

  const run = repair(db, { ...base, REDACT_LEGACY_LOGIN_ACTORS: '1', EXPECTED_LOGIN_ROWS: '1' });
  assert.equal(run.status, 0, run.out);
  const after = await auditRows(db.pool);
  assert.ok(fx.clearLogin);
  assert.deepEqual(after.get(fx.clearLogin), { ...before.get(fx.clearLogin), actor_id: 'login:legacy-redacted' }, 'solo cambia actor_id');
  assert.ok([...after.values()].some((r) => r['result'] === 'rows:4 login_actors:1'));
  await anonymize(db.pool, fx.luna);
});
