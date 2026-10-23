/**
 * QS-0006 (DEC-0021..DEC-0027): retención global, baja y anonimización contra PostgreSQL.
 * Las fechas se mueven en la BD (created_at/ts/day/anonymize_after) para cruzar cada plazo;
 * nada espera en tiempo real.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootApi, authHeaders, api, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows, failAuditFor } from '../helpers/tenants.ts';
import { AuditSink } from '../../src/audit/sink.ts';
import { PURGED_CONTENT_MARKER, RETENTION_ACTOR, RetentionService, tenantSha256 } from '../../src/retention/service.ts';

let t: TestApi;
let retention: RetentionService;
let exportDir: string;

before(async () => {
  t = await bootApi();
  retention = new RetentionService({ pool: t.pool, sink: new AuditSink(t.pool) });
  exportDir = await mkdtemp(path.join(os.tmpdir(), 'mainspot-exit-'));
});

after(async () => {
  await rm(exportDir, { recursive: true, force: true });
  await t.close();
});

const send = (token: string, text: string) => api(t.baseUrl, '/api/backoffice/conversation/messages', {
  method: 'POST', headers: authHeaders(token), body: JSON.stringify({ text, channel: 'simulated' }),
});

async function age(requestId: string, interval: string): Promise<void> {
  await t.pool.query('UPDATE conversation_request SET created_at = now() - $2::interval WHERE request_id = $1', [requestId, interval]);
}

async function auditAged(tenant: string, interval: string): Promise<string> {
  const eventId = `evt_${randomUUID()}`;
  await t.pool.query(
    `INSERT INTO audit_event (event_id, ts, tenant_id, actor_id, actor_role, action, resource, request_id, decision, result)
     VALUES ($1, now() - $2::interval, $3, $4, 'administration', 'data.read', 'test', $5, 'allow', 'success')`,
    [eventId, interval, tenant, `user_${tenant}`, `req_${randomUUID()}`]);
  return eventId;
}

async function summaryAged(tenant: string, interval: string, count = 1): Promise<string> {
  const id = `smry_${randomUUID()}`;
  await t.pool.query(
    `INSERT INTO analytics_daily_summary (summary_id, tenant_id, day, action, result, count)
     VALUES ($1, $2, (now() - $3::interval)::date, 'data.read', 'success', $4)`, [id, tenant, interval, count]);
  return id;
}

/** Clasificación Jev evaluada (con sus cuerpos raw) ligada a una solicitud. */
async function jevEvaluated(tenant: string, requestId: string): Promise<void> {
  await t.pool.query(
    `INSERT INTO jev_classification (classification_id, tenant_id, request_id, policy_version, mode, decision_source, decision_reason,
       deterministic_intent, deterministic_action_class, final_intent, final_action_class, status, jev_intent, jev_intent_probability,
       jev_intent_confidence, jev_intent_probabilities, jev_action_class, jev_capability_target, jev_capability_confidence,
       jev_capability_probabilities, agreement, provider, requested_model, resolved_model, usage, cost_usd, cost_source, budget_day,
       latency_ms, raw_request, raw_response)
     VALUES ($1, $2, $3, 'test', 'shadow', 'deterministic', 'shadow', 'website.edit', 'preview_required', 'website.edit',
       'preview_required', 'evaluated', 'website.edit', 0.9, 0.9, '{}', 'preview_required', 'website', 0.9, '{}', true,
       'typesafe', 'jev-1.14.0', 'jev-1.14.0', '{}', 0, 'mock', current_date, 5, $4, '{}')`,
    [`jc_${randomUUID()}`, tenant, requestId, JSON.stringify({ text: 'cambia el teléfono a 555-0199' })]);
}

async function dueExit(tenant: string): Promise<void> {
  await t.pool.query(
    `UPDATE tenant_exit SET confirmed_at = now() - interval '31 days', anonymize_after = now() - interval '1 day' WHERE tenant_id = $1`,
    [tenant]);
}

/** Filas, en CUALQUIER columna de texto de la base, que contienen alguno de los valores. */
async function tracesOf(values: string[]): Promise<string[]> {
  const cols = await t.pool.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c
       JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
      WHERE c.table_schema = current_schema() AND tb.table_type = 'BASE TABLE'
        AND c.data_type IN ('text', 'character varying', 'jsonb', 'json')`);
  const patterns = values.map((v) => `%${v}%`);
  const hits: string[] = [];
  for (const { table_name: table, column_name: column } of cols.rows) {
    const n = await countRows(t, `SELECT count(*) AS n FROM "${table}" WHERE "${column}"::text ILIKE ANY($1::text[])`, [patterns]);
    if (n > 0) hits.push(`${table}.${column}`);
  }
  return hits;
}

test('DEC-0021..0023: each kind of data is purged at its own term; structure and fresher data stay', async () => {
  const { tenant, token } = await createTenantWithPlan(t, { conversations: 10 }, 'client_r');
  const old = await send(token, 'cambia el teléfono a 555-0199');
  const edge = await send(token, '¿cuál es el horario de atención?');
  assert.deepEqual([old.status, edge.status], [201, 201]);
  assert.ok(old.body.proposal_id, 'the old message produced a proposal');
  const oldId = old.body.request.request_id as string;
  const edgeId = edge.body.request.request_id as string;
  await jevEvaluated(tenant, oldId);
  await age(oldId, '91 days');
  await age(edgeId, '89 days');
  const oldAudit = await auditAged(tenant, '2 years 1 day');
  const keptAudit = await auditAged(tenant, '2 years -1 day');
  const oldSummary = await summaryAged(tenant, '2 years 1 day');
  const keptSummary = await summaryAged(tenant, '1 day');

  const expected = { conversations: 1, proposals: 1, proposalsExpired: 1, jevBodies: 1, auditEvents: 1, analyticsRows: 1 };
  assert.deepEqual((await retention.preview(tenant)).pending, expected);
  const dry = await retention.run({ trigger: 'manual', dryRun: true });
  assert.equal(dry.status, 'completed');
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM conversation_request WHERE tenant_id = $1 AND content_purged_at IS NOT NULL', [tenant]), 0,
    'a dry run changes nothing');

  const report = await retention.run({ trigger: 'manual', dryRun: false });
  assert.equal(report.status, 'completed');
  const requests = await t.pool.query<{ request_id: string; raw_message: string; response_message: string | null; content_purged_at: Date | null; action_class: string }>(
    'SELECT request_id, raw_message, response_message, content_purged_at, action_class FROM conversation_request WHERE tenant_id = $1', [tenant]);
  const byId = new Map(requests.rows.map((r) => [r.request_id, r]));
  assert.deepEqual([byId.get(oldId)?.raw_message, byId.get(oldId)?.response_message], [PURGED_CONTENT_MARKER, null]);
  assert.ok(byId.get(oldId)?.content_purged_at);
  assert.equal(byId.get(oldId)?.action_class, 'preview_required', 'the structure is kept');
  assert.equal(byId.get(edgeId)?.raw_message, '¿cuál es el horario de atención?', '89 days old: still within the term');

  const proposal = await t.pool.query<{ status: string; summary: string; detail: unknown }>(
    'SELECT status, summary, detail FROM action_proposal WHERE proposal_id = $1', [old.body.proposal_id]);
  assert.deepEqual(proposal.rows[0], { status: 'expired', summary: PURGED_CONTENT_MARKER, detail: {} });
  const jev = await t.pool.query('SELECT raw_request, raw_response, status FROM jev_classification WHERE request_id = $1', [oldId]);
  assert.deepEqual(jev.rows[0], { raw_request: null, raw_response: null, status: 'evaluated' });
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM audit_event WHERE event_id = ANY($1)', [[oldAudit, keptAudit]]), 1);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM audit_event WHERE event_id = $1', [keptAudit]), 1);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM analytics_daily_summary WHERE summary_id = ANY($1)', [[oldSummary, keptSummary]]), 1);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM analytics_daily_summary WHERE summary_id = $1', [keptSummary]), 1);

  const audited = await t.pool.query<{ actor_id: string; result: string; request_id: string }>(
    `SELECT actor_id, result, request_id FROM audit_event WHERE tenant_id = $1 AND action = 'retention.purged'`, [tenant]);
  assert.deepEqual(audited.rows, [{
    actor_id: RETENTION_ACTOR, result: 'conversations:1,proposals:1,expired:1,jev:1,audit:1,analytics:1', request_id: report.runId,
  }]);
  const runRow = await t.pool.query<{ status: string; dry_run: boolean }>('SELECT status, dry_run FROM retention_run WHERE run_id = $1', [report.runId]);
  assert.deepEqual(runRow.rows[0], { status: 'completed', dry_run: false });

  const confirm = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${old.body.proposal_id}/confirm`, {
    method: 'POST', headers: authHeaders(token), body: '{}',
  });
  assert.equal(confirm.status, 409, 'a purged proposal can no longer be applied');

  await retention.run({ trigger: 'manual', dryRun: false });
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'retention.purged'`, [tenant]), 1,
    'a second run finds nothing left to purge');
  assert.deepEqual((await retention.preview(tenant)).pending,
    { conversations: 0, proposals: 0, proposalsExpired: 0, jevBodies: 0, auditEvents: 0, analyticsRows: 0 });
});

test('NFR-0001: if a tenant purge cannot be audited it is rolled back; the other tenants are still purged', async () => {
  const a = await createTenantWithPlan(t, { conversations: 5 }, 'client_r');
  const b = await createTenantWithPlan(t, { conversations: 5 }, 'client_r');
  const fromA = await send(a.token, '¿cuál es el horario de atención?');
  const fromB = await send(b.token, '¿cuál es el horario de atención?');
  await age(fromA.body.request.request_id, '91 days');
  await age(fromB.body.request.request_id, '91 days');
  const restore = await failAuditFor(t, a.tenant, 'retention.purged');
  let report;
  try {
    report = await retention.run({ trigger: 'manual', dryRun: false });
  } finally {
    await restore();
  }
  assert.deepEqual([report.status, report.totals.failures], ['failed', 1]);
  const purged = (tenant: string) => countRows(t, 'SELECT count(*) AS n FROM conversation_request WHERE tenant_id = $1 AND content_purged_at IS NOT NULL', [tenant]);
  assert.equal(await purged(a.tenant), 0, 'no purge without its audit event');
  assert.equal(await purged(b.tenant), 1);
  const runRow = await t.pool.query<{ status: string; error_code: string }>('SELECT status, error_code FROM retention_run WHERE run_id = $1', [report.runId]);
  assert.deepEqual(runRow.rows[0], { status: 'failed', error_code: 'tenant_failures:1' });
  assert.equal((await retention.run({ trigger: 'manual', dryRun: false })).status, 'completed');
  assert.equal(await purged(a.tenant), 1, 'the next run purges what was left');
});

test('DEC-0025: the scheduled run happens once per UTC day, after 03:00, even with concurrent schedulers', async () => {
  const day = (hour: number) => new Date(Date.UTC(2026, 0, 1, hour, 0));
  assert.equal(await retention.runScheduledIfDue(day(2)), null, 'before 03:00 UTC nothing runs');
  const results = await Promise.all([retention.runScheduledIfDue(day(3)), retention.runScheduledIfDue(day(3))]);
  const ran = results.filter((r) => r !== null);
  assert.equal(ran.length, 1, 'exactly one scheduler runs');
  assert.deepEqual([ran[0]?.trigger, ran[0]?.status], ['scheduled', 'completed']);
  assert.equal(await retention.runScheduledIfDue(day(23)), null, 'already done today');
  assert.equal(await countRows(t,
    `SELECT count(*) AS n FROM retention_run WHERE trigger = 'scheduled' AND run_day = (now() AT TIME ZONE 'UTC')::date`, []), 1);
});

test('DEC-0024/0027: a confirmed exit exports first, removes access, and is anonymized only after 30 days without traces', async () => {
  const x = await createTenantWithPlan(t, { conversations: 5 }, 'client_x');
  const email = `${x.tenant}@example.com`;
  const msg = await send(x.token, `escribe a ${email} sobre Negocio ${x.tenant} y Persona ${x.tenant}`);
  assert.equal(msg.status, 201);
  await summaryAged(x.tenant, '1 day', 3);

  const exit = await retention.confirmExit({ tenantId: x.tenant, confirmedBy: 'operador@mainspot', exportDir });
  const bytes = await readFile(exit.exportPath);
  assert.equal((await stat(exit.exportPath)).mode & 0o777, 0o600);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), exit.exportSha256);
  const exported = JSON.parse(bytes.toString('utf8'));
  assert.equal(exported.tenant_id, x.tenant);
  assert.equal(exported.conversation_request.length, 1);
  assert.equal(exported.internal_user[0].login, x.login);
  assert.ok(!bytes.toString('utf8').includes('password_hash'), 'no credentials in the export');

  const state = await t.pool.query<{ client: string; subscription: string; grace_days: number }>(
    `SELECT c.status AS client, s.status AS subscription,
            (EXTRACT(EPOCH FROM (e.anonymize_after - e.confirmed_at)) / 86400)::int AS grace_days
       FROM client c JOIN subscription s ON s.tenant_id = c.client_id JOIN tenant_exit e ON e.tenant_id = c.client_id
      WHERE c.client_id = $1`, [x.tenant]);
  assert.deepEqual(state.rows[0], { client: 'exiting', subscription: 'cancelled', grace_days: 30 });
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'tenant.exit_confirmed' AND evidence_ref = $2`,
    [x.tenant, exit.exportSha256]), 1);
  assert.equal((await api(t.baseUrl, '/api/backoffice/conversation/requests', { headers: authHeaders(x.token) })).status, 401,
    'the existing session loses access');
  await assert.rejects(retention.confirmExit({ tenantId: x.tenant, confirmedBy: 'operador@mainspot', exportDir }));

  const early = await retention.run({ trigger: 'manual', dryRun: false });
  assert.equal(early.totals.tenantsAnonymized, 0, 'not before 30 days');
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM client WHERE client_id = $1', [x.tenant]), 1);

  const auditBefore = await countRows(t, 'SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1', [x.tenant]);
  await dueExit(x.tenant);
  const report = await retention.run({ trigger: 'manual', dryRun: false });
  assert.deepEqual([report.status, report.totals.tenantsAnonymized], ['completed', 1]);

  assert.deepEqual(await tracesOf([x.tenant, x.userId, x.login, email, msg.body.request.request_id]), [],
    'no column anywhere keeps an identifier of the tenant');
  const anon = await t.pool.query<{ tenant_id: string }>(
    `SELECT tenant_id FROM audit_event WHERE action = 'tenant.anonymized' AND request_id = $1`, [report.runId]);
  const anonId = anon.rows[0]?.tenant_id ?? '';
  assert.match(anonId, /^anon_/);
  const anonClient = await t.pool.query('SELECT business_name, status, contact_email FROM client WHERE client_id = $1', [anonId]);
  assert.deepEqual(anonClient.rows[0], { business_name: 'Negocio anonimizado', status: 'anonymized', contact_email: null });
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1', [anonId]), auditBefore + 1,
    'audit history is kept (re-keyed) plus the anonymization event');
  assert.equal(await countRows(t,
    `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND (resource ~ '[/:]' OR evidence_ref IS NOT NULL)`, [anonId]), 0);
  assert.equal(await countRows(t, 'SELECT sum(count) AS n FROM analytics_daily_summary WHERE tenant_id = $1', [anonId]), 3,
    'aggregates are kept under the anonymous id');
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM anonymized_tenant WHERE tenant_sha256 = $1', [tenantSha256(x.tenant)]), 1);
  assert.equal((await retention.run({ trigger: 'manual', dryRun: false })).status, 'completed', 'anonymized tenants are skipped afterwards');
});

test('DEC-0027: if any identifier would survive, the anonymization is rolled back and reported', async () => {
  const w = await createTenantWithPlan(t, {}, 'client_x');
  const y = await createTenantWithPlan(t, {}, 'client_x');
  await retention.confirmExit({ tenantId: w.tenant, confirmedBy: 'operador@mainspot', exportDir });
  await dueExit(w.tenant);
  const plant = `cd_${randomUUID()}`;
  await t.pool.query(`INSERT INTO client_data (data_id, tenant_id, kind, payload) VALUES ($1, $2, 'note', jsonb_build_object('contacto', $3::text))`,
    [plant, y.tenant, w.login]);
  const blocked = await retention.run({ trigger: 'manual', dryRun: false });
  assert.deepEqual([blocked.status, blocked.totals.failures, blocked.totals.tenantsAnonymized], ['failed', 1, 0]);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM client WHERE client_id = $1 AND status = 'exiting'`, [w.tenant]), 1);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM internal_user WHERE tenant_id = $1', [w.tenant]), 1, 'nothing was deleted');
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM anonymized_tenant WHERE tenant_sha256 = $1', [tenantSha256(w.tenant)]), 0);

  await t.pool.query('DELETE FROM client_data WHERE data_id = $1', [plant]);
  const done = await retention.run({ trigger: 'manual', dryRun: false });
  assert.deepEqual([done.status, done.totals.tenantsAnonymized], ['completed', 1]);
  assert.deepEqual(await tracesOf([w.tenant, w.login]), []);
});

test('DEC-0026/0027: after restoring an older backup, exits are re-applied from the registry; the registry expires', async () => {
  const fromFile = await createTenantWithPlan(t, {}, 'client_x');
  const fromDb = await createTenantWithPlan(t, {}, 'client_x');
  const untouched = await createTenantWithPlan(t, {}, 'client_x');
  await t.pool.query(`INSERT INTO anonymized_tenant (tenant_sha256, anonymized_at, run_id) VALUES ($1, now(), 'ret_restore_test')`,
    [tenantSha256(fromDb.tenant)]);

  const viaFile = await retention.reapplyExits([tenantSha256(fromFile.tenant)]);
  assert.equal(viaFile.reanonymized, 1);
  const viaDb = await retention.reapplyExits();
  assert.equal(viaDb.reanonymized, 1);
  assert.deepEqual(await tracesOf([fromFile.tenant, fromFile.login, fromDb.tenant, fromDb.login]), []);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM client WHERE client_id = $1 AND status = 'active'`, [untouched.tenant]), 1);
  const runs = await t.pool.query<{ trigger: string; status: string }>('SELECT trigger, status FROM retention_run WHERE run_id = ANY($1)',
    [[viaFile.runId, viaDb.runId]]);
  assert.deepEqual(runs.rows.map((r) => [r.trigger, r.status]), [['restore_reapply', 'completed'], ['restore_reapply', 'completed']]);

  const stale = createHash('sha256').update(`stale_${randomUUID()}`).digest('hex');
  const recent = createHash('sha256').update(`recent_${randomUUID()}`).digest('hex');
  await t.pool.query(`INSERT INTO anonymized_tenant (tenant_sha256, anonymized_at, run_id) VALUES ($1, now() - interval '31 days', 'r'), ($2, now() - interval '29 days', 'r')`,
    [stale, recent]);
  await retention.run({ trigger: 'manual', dryRun: false });
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM anonymized_tenant WHERE tenant_sha256 = ANY($1)', [[stale, recent]]), 1);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM anonymized_tenant WHERE tenant_sha256 = $1', [recent]), 1,
    'kept while a 14-day backup could still contain the tenant');
});
