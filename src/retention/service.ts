/**
 * Retención global de MainSpot (QS-0006: DEC-0021..DEC-0027).
 *
 * Plazos (RETENTION_POLICY):
 *  - DEC-0021: el contenido conversacional se conserva 90 días. Se redacta (mensaje,
 *    respuesta, propuesta derivada y cuerpos enviados a Jev) y se conserva la estructura
 *    (intención, clase, estado, fechas). Las propuestas abiertas de esas solicitudes
 *    pasan a `expired`: sin su contenido ya no pueden aplicarse.
 *  - DEC-0022 / DEC-0023: eventos de auditoría y agregados de analítica, 2 años.
 *  - DEC-0024 / DEC-0027: baja confirmada (con exportación previa) ⇒ anonimización a los
 *    30 días. Se borra todo dato operativo del tenant; solo quedan los agregados y los
 *    eventos de auditoría re-etiquetados con identificadores nuevos sin correspondencia
 *    guardada, y la verificación de ausencia de rastros es parte de la transacción.
 *  - DEC-0025: ejecución automática diaria para toda la plataforma con informe
 *    (`retention_run`) y un evento de auditoría por tenant.
 *  - DEC-0026/DEC-0027: tras restaurar un respaldo, `reapplyExits` vuelve a anonimizar
 *    los tenants ya anonimizados (registro de huellas sha256, sin ids en claro, que se
 *    borra cuando ningún respaldo vigente puede contenerlos).
 *
 * NFR-0001: cada efecto (redacción, borrado, baja, anonimización) se confirma junto con
 * su evento de auditoría en UNA transacción por tenant.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import { GoogleContentRetention } from '../google/retention.ts';

/** Plazos aprobados, como intervalos de PostgreSQL. */
export const RETENTION_POLICY = {
  conversationContent: { interval: '90 days', decision: 'DEC-0021' },
  auditEvents: { interval: '2 years', decision: 'DEC-0022' },
  analyticsAggregates: { interval: '2 years', decision: 'DEC-0023' },
  exitGrace: { interval: '30 days', decision: 'DEC-0024' },
  /** Respaldos 14 días (DEC-0026) + margen: pasado este plazo ningún respaldo contiene al tenant. */
  anonymizedRegistry: { interval: '30 days', decision: 'DEC-0026, DEC-0027' },
} as const;

export const RETENTION_ACTOR = 'system:retention';
export const PURGED_CONTENT_MARKER = 'Contenido eliminado por la política de retención (90 días, DEC-0021).';
/** La ejecución diaria (DEC-0025) corre a partir de esta hora UTC. */
export const RETENTION_DAILY_HOUR_UTC = 3;

/** Estados de propuesta que aún podrían aplicarse y que caducan al purgar su contenido. */
const OPEN_PROPOSAL_STATES = ['drafted', 'awaiting_confirmation', 'confirmed', 'preview_ready', 'failed'];

/**
 * Tablas con datos del tenant, en orden de borrado compatible con las FK (RESTRICT).
 * `exportSkip`: columnas que nunca salen en la exportación (credenciales derivadas).
 */
const TENANT_TABLES: ReadonlyArray<{ table: string; key: string; exportSkip?: readonly string[] }> = [
  // DEV-E2E-04: conexiones con proveedores reales (tokens cifrados nunca se exportan) y cursor
  // de reseñas de Google. Sin estas filas la baja (DELETE client) fallaría por FK.
  { table: 'provider_oauth_state', key: 'tenant_id', exportSkip: ['state_hash', 'verifier_box'] },
  { table: 'provider_connection', key: 'tenant_id', exportSkip: ['token_box', 'token_key_id'] },
  { table: 'google_review_cursor', key: 'tenant_id' },
  { table: 'provider_reply_ledger', key: 'tenant_id' },
  // DEV-E2E-02: agente de atención, Telegram, ficha de Google y simulador (antes de review,
  // social_post e internal_user por sus FK).
  { table: 'engagement_notification', key: 'tenant_id' },
  { table: 'engagement_case', key: 'tenant_id' },
  { table: 'engagement_policy', key: 'tenant_id' },
  { table: 'engagement_cursor', key: 'tenant_id' },
  { table: 'telegram_link_code', key: 'tenant_id', exportSkip: ['code_hash'] },
  { table: 'telegram_link', key: 'tenant_id' },
  { table: 'sim_provider_reply', key: 'tenant_id' },
  { table: 'sim_provider_event', key: 'tenant_id' },
  { table: 'sim_provider_fault', key: 'tenant_id' },
  { table: 'gbp_profile', key: 'tenant_id' },
  { table: 'owner_invitation', key: 'tenant_id', exportSkip: ['token_hash'] },
  // DEV-E2E-02: teléfonos de contacto por integración.
  { table: 'integration_phone', key: 'tenant_id' },
  { table: 'business_contact', key: 'tenant_id' },
  { table: 'jev_classification', key: 'tenant_id' },
  { table: 'scheduled_post', key: 'tenant_id' },
  { table: 'website_content', key: 'tenant_id' },
  { table: 'publication', key: 'tenant_id' },
  { table: 'approval', key: 'tenant_id' },
  { table: 'preview_session', key: 'tenant_id', exportSkip: ['token_hash'] },
  { table: 'review', key: 'tenant_id' },
  { table: 'social_post', key: 'tenant_id' },
  { table: 'action_proposal', key: 'tenant_id' },
  { table: 'conversation_request', key: 'tenant_id' },
  { table: 'client_domain', key: 'tenant_id' },
  { table: 'client_website', key: 'tenant_id' },
  { table: 'quota_reservation', key: 'tenant_id' },
  { table: 'subscription', key: 'tenant_id' },
  { table: 'session_context', key: 'tenant_id' },
  { table: 'user_role', key: 'tenant_id' },
  { table: 'internal_user', key: 'tenant_id', exportSkip: ['password_hash'] },
  { table: 'client_data', key: 'tenant_id' },
  { table: 'demo_action', key: 'tenant_id' },
  { table: 'tenant_context', key: 'client_id' },
  { table: 'tenant_exit', key: 'tenant_id' },
];

export interface TenantPurgeCounts {
  conversations: number;
  proposals: number;
  proposalsExpired: number;
  jevBodies: number;
  auditEvents: number;
  analyticsRows: number;
}

export type RetentionTrigger = 'scheduled' | 'manual' | 'restore_reapply';

export interface RetentionRunReport {
  runId: string;
  trigger: RetentionTrigger;
  dryRun: boolean;
  status: 'completed' | 'failed';
  totals: TenantPurgeCounts & { tenants: number; tenantsWithChanges: number; tenantsAnonymized: number; exitsDue: number; registryPruned: number; failures: number };
}

export interface RetentionPreview {
  policy: typeof RETENTION_POLICY;
  pending: TenantPurgeCounts;
  exit: { confirmed_at: string; anonymize_after: string } | null;
  lastRun: { run_day: string; status: string; finished_at: string | null } | null;
}

const ZERO: TenantPurgeCounts = { conversations: 0, proposals: 0, proposalsExpired: 0, jevBodies: 0, auditEvents: 0, analyticsRows: 0 };

export function tenantSha256(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex');
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Identificadores del tenant capturados antes de anonimizar, para verificar que no quedan. */
interface TenantIdentifiers {
  /** Identificadores técnicos o de contacto: no pueden aparecer en ninguna columna de texto. */
  strong: string[];
  /** Nombres en lenguaje natural: no pueden aparecer en lo que se conserva del tenant. */
  weak: string[];
}

export interface RetentionServiceDeps {
  pool: Pool;
  sink: AuditSink;
}

export class RetentionService {
  private readonly deps: RetentionServiceDeps;

  constructor(deps: RetentionServiceDeps) {
    this.deps = deps;
  }

  /** Lo que la próxima ejecución purgaría para un tenant (sin efectos). */
  async preview(tenantId: string): Promise<RetentionPreview> {
    const pending = await runAtomic(this.deps.pool, (client) => this.purgeTenant(client, tenantId, true));
    const exit = await this.deps.pool.query<{ confirmed_at: string; anonymize_after: string }>(
      'SELECT confirmed_at, anonymize_after FROM tenant_exit WHERE tenant_id = $1', [tenantId]);
    const last = await this.deps.pool.query<{ run_day: string; status: string; finished_at: string | null }>(
      `SELECT run_day::text, status, finished_at FROM retention_run WHERE NOT dry_run ORDER BY started_at DESC LIMIT 1`);
    return { policy: RETENTION_POLICY, pending, exit: exit.rows[0] ?? null, lastRun: last.rows[0] ?? null };
  }

  /**
   * Ejecución de la política para toda la plataforma: purga por plazo de cada tenant (una
   * transacción y un evento `retention.purged` por tenant), anonimización de las bajas
   * vencidas y poda del registro de huellas. Un tenant que falla no detiene a los demás;
   * el informe queda `failed` con el número de fallos.
   */
  async run(opts: { trigger: RetentionTrigger; dryRun: boolean }): Promise<RetentionRunReport> {
    const runId = `ret_${randomUUID()}`;
    await this.deps.pool.query(
      `INSERT INTO retention_run (run_id, run_day, trigger, dry_run, policy, status)
       VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $2, $3, $4, 'running')`,
      [runId, opts.trigger, opts.dryRun, JSON.stringify(RETENTION_POLICY)]);
    const totals: RetentionRunReport['totals'] = {
      ...ZERO, tenants: 0, tenantsWithChanges: 0, tenantsAnonymized: 0, exitsDue: 0, registryPruned: 0, failures: 0,
    };
    try {
      const google = await new GoogleContentRetention(this.deps).purge({ dryRun: opts.dryRun });
      totals.failures += google.failures;
      if (!opts.dryRun) await this.deps.pool.query("DELETE FROM password_reset_token WHERE expires_at < now() - interval '1 day'");
      const tenants = await this.deps.pool.query<{ client_id: string }>(
        `SELECT client_id FROM client WHERE status <> 'anonymized' ORDER BY client_id`);
      for (const { client_id: tenantId } of tenants.rows) {
        totals.tenants += 1;
        try {
          const counts = await runAtomic(this.deps.pool, async (client) => {
            const c = await this.purgeTenant(client, tenantId, opts.dryRun);
            if (!opts.dryRun && hasChanges(c)) {
              await this.deps.sink.write({
                tenant_id: tenantId, actor_id: RETENTION_ACTOR, actor_role: null, action: 'retention.purged',
                resource: 'retention', request_id: runId, decision: 'allow', result: countsResult(c), evidence_ref: runId,
              }, client);
            }
            return c;
          });
          if (hasChanges(counts)) totals.tenantsWithChanges += 1;
          for (const k of Object.keys(ZERO) as Array<keyof TenantPurgeCounts>) totals[k] += counts[k];
        } catch (err) {
          totals.failures += 1;
          log.error('retention.tenant.failed', 'retention could not be applied to a tenant', {
            run_id: runId, tenant_id: tenantId, error_name: err instanceof Error ? err.name : 'unknown',
          });
        }
      }
      const due = await this.deps.pool.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM tenant_exit WHERE anonymize_after <= now() ORDER BY tenant_id');
      totals.exitsDue = due.rows.length;
      if (!opts.dryRun) {
        for (const { tenant_id: tenantId } of due.rows) {
          try {
            await this.anonymizeTenant(tenantId, runId);
            totals.tenantsAnonymized += 1;
          } catch (err) {
            totals.failures += 1;
            log.error('retention.anonymize.failed', 'tenant anonymization rolled back', {
              run_id: runId, error_name: err instanceof Error ? err.name : 'unknown', error: err instanceof Error ? err.message : '',
            });
          }
        }
        const pruned = await this.deps.pool.query(
          'DELETE FROM anonymized_tenant WHERE anonymized_at < now() - $1::interval', [RETENTION_POLICY.anonymizedRegistry.interval]);
        totals.registryPruned = pruned.rowCount ?? 0;
      }
      const status = totals.failures > 0 ? 'failed' : 'completed';
      await this.finish(runId, status, totals, totals.failures > 0 ? `tenant_failures:${totals.failures}` : null);
      log.info('retention.run', 'retention run finished', { run_id: runId, trigger: opts.trigger, dry_run: opts.dryRun, status, ...totals });
      return { runId, trigger: opts.trigger, dryRun: opts.dryRun, status, totals };
    } catch (err) {
      await this.finish(runId, 'failed', totals, err instanceof Error ? err.name : 'unknown');
      throw err;
    }
  }

  /**
   * DEC-0025: corre la ejecución programada si ya pasó la hora y hoy (UTC) aún no terminó
   * ninguna (completada o con fallos: un fallo queda en el informe y en el log, y la
   * siguiente ejecución recupera lo pendiente porque la purga es por plazo; una ejecución
   * interrumpida queda `running` y se reintenta). Un candado de sesión evita dos ejecuciones
   * simultáneas entre procesos; la comprobación se repite con el candado tomado.
   */
  async runScheduledIfDue(now = new Date()): Promise<RetentionRunReport | null> {
    if (now.getUTCHours() < RETENTION_DAILY_HOUR_UTC) return null;
    const lockClient = await this.deps.pool.connect();
    try {
      const got = await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('retention:daily', 0)) AS ok");
      if (!got.rows[0]?.ok) return null;
      try {
        const done = await lockClient.query(
          `SELECT 1 FROM retention_run WHERE trigger = 'scheduled' AND NOT dry_run AND status <> 'running'
            AND run_day = (now() AT TIME ZONE 'UTC')::date`);
        if ((done.rowCount ?? 0) > 0) return null;
        return await this.run({ trigger: 'scheduled', dryRun: false });
      } finally {
        await lockClient.query("SELECT pg_advisory_unlock(hashtextextended('retention:daily', 0))");
      }
    } finally {
      lockClient.release();
    }
  }

  /**
   * DEC-0024/DEC-0027: confirma la baja de un tenant. Antes exporta sus datos (sin
   * credenciales) a `exportDir` (archivo 0600); después, en una transacción: registro de
   * la baja con la huella del export, tenant `exiting` (sin acceso), suscripción
   * cancelada y evento `tenant.exit_confirmed`. La anonimización llega a los 30 días.
   */
  async confirmExit(input: { tenantId: string; confirmedBy: string; exportDir: string }): Promise<{ exportPath: string; exportSha256: string; anonymizeAfter: string }> {
    if (!input.confirmedBy.trim()) throw new Error('FAIL-CLOSED: exit confirmation requires the confirming operator');
    const client = await this.deps.pool.query<{ status: string }>('SELECT status FROM client WHERE client_id = $1', [input.tenantId]);
    const status = client.rows[0]?.status;
    if (!status) throw new AppError(404, DENY_CODES.NOT_FOUND, 'No existe ese negocio.');
    if (status !== 'active' && status !== 'suspended') {
      throw new AppError(409, 'validation_error', 'La baja de este negocio ya está confirmada o completada.');
    }
    const exported = await this.exportTenant(input.tenantId);
    const bytes = Buffer.from(`${JSON.stringify(exported, null, 2)}\n`, 'utf8');
    const exportSha256 = createHash('sha256').update(bytes).digest('hex');
    await mkdir(input.exportDir, { recursive: true, mode: 0o700 });
    const exportPath = path.join(input.exportDir, `${input.tenantId}-${new Date().toISOString().replace(/[:.]/g, '')}.json`);
    const tmp = `${exportPath}.tmp`;
    await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
    await rename(tmp, exportPath);
    const anonymizeAfter = await runAtomic(this.deps.pool, async (db) => {
      const res = await db.query<{ anonymize_after: string }>(
        `INSERT INTO tenant_exit (tenant_id, confirmed_at, confirmed_by, export_sha256, anonymize_after)
         VALUES ($1, now(), $2, $3, now() + $4::interval) RETURNING anonymize_after`,
        [input.tenantId, input.confirmedBy, exportSha256, RETENTION_POLICY.exitGrace.interval]);
      await db.query(`UPDATE client SET status = 'exiting', updated_at = now() WHERE client_id = $1`, [input.tenantId]);
      await db.query(`UPDATE subscription SET status = 'cancelled', updated_at = now() WHERE tenant_id = $1`, [input.tenantId]);
      const after = new Date(res.rows[0]?.anonymize_after ?? '').toISOString();
      await this.deps.sink.write({
        tenant_id: input.tenantId, actor_id: input.confirmedBy, actor_role: null, action: 'tenant.exit_confirmed',
        resource: 'tenant_exit', request_id: `exit_${randomUUID()}`, decision: 'allow',
        result: `anonymize_after:${after}`, evidence_ref: exportSha256,
      }, db);
      return after;
    });
    return { exportPath, exportSha256, anonymizeAfter };
  }

  /**
   * Anonimiza un tenant en UNA transacción: re-etiqueta agregados y auditoría con
   * identificadores nuevos (sin correspondencia guardada), borra todo dato operativo,
   * registra la huella y verifica que no queda ningún rastro antes de confirmar.
   */
  async anonymizeTenant(tenantId: string, runId: string): Promise<{ anonymousId: string }> {
    return runAtomic(this.deps.pool, async (client) => {
      const ids = await this.identifiers(client, tenantId);
      const logins = (await client.query<{ login: string }>('SELECT login FROM internal_user WHERE tenant_id=$1', [tenantId])).rows.map((r) => r.login);
      const anonymousId = `anon_${randomUUID()}`;
      await client.query(
        `INSERT INTO client (client_id, business_name, status, contact_email, metadata)
         VALUES ($1, 'Negocio anonimizado', 'anonymized', NULL, '{}')`, [anonymousId]);
      const analytics = await client.query('UPDATE analytics_daily_summary SET tenant_id = $2 WHERE tenant_id = $1', [tenantId, anonymousId]);
      const audit = await client.query(
        `WITH actors AS MATERIALIZED (
           SELECT actor_id, CASE WHEN actor_id LIKE 'system:%' THEN actor_id ELSE 'anon_actor_' || gen_random_uuid() END AS anon
             FROM (SELECT DISTINCT actor_id FROM audit_event WHERE tenant_id = $1) a),
         requests AS MATERIALIZED (
           SELECT request_id, 'anon_req_' || gen_random_uuid() AS anon FROM (SELECT DISTINCT request_id FROM audit_event WHERE tenant_id = $1) r)
         UPDATE audit_event e
            SET tenant_id = $2, actor_id = actors.anon, request_id = requests.anon,
                resource = CASE WHEN e.resource IS NULL THEN NULL ELSE regexp_replace(e.resource, '[/:].*$', '') END,
                evidence_ref = NULL
           FROM actors, requests
          WHERE e.tenant_id = $1 AND actors.actor_id = e.actor_id AND requests.request_id = e.request_id`,
        [tenantId, anonymousId]);
      const deleted: Record<string, number> = {};
      for (const { table, key } of TENANT_TABLES) {
        const res = await client.query(`DELETE FROM ${table} WHERE ${key} = $1`, [tenantId]);
        deleted[table] = res.rowCount ?? 0;
      }
      // Un correo compartido conserva su recuperación para los otros negocios.
      await client.query(
        `DELETE FROM password_reset_token p WHERE login=ANY($1::text[])
         AND NOT EXISTS (SELECT 1 FROM internal_user u WHERE u.login=p.login)`, [logins]);
      await client.query('DELETE FROM client WHERE client_id = $1', [tenantId]);
      await client.query(
        `INSERT INTO anonymized_tenant (tenant_sha256, anonymized_at, run_id) VALUES ($1, now(), $2)
         ON CONFLICT (tenant_sha256) DO UPDATE SET anonymized_at = now(), run_id = EXCLUDED.run_id`,
        [tenantSha256(tenantId), runId]);
      const removed = Object.values(deleted).reduce((a, b) => a + b, 0);
      await this.deps.sink.write({
        tenant_id: anonymousId, actor_id: RETENTION_ACTOR, actor_role: null, action: 'tenant.anonymized',
        resource: 'tenant', request_id: runId, decision: 'allow',
        result: `rows_deleted:${removed},audit_rekeyed:${audit.rowCount ?? 0},aggregates_rekeyed:${analytics.rowCount ?? 0}`,
      }, client);
      await this.assertNoTraces(client, ids, anonymousId);
      return { anonymousId };
    });
  }

  /**
   * DEC-0027: tras restaurar un respaldo, vuelve a anonimizar los tenants cuya huella está
   * en el registro (el de la BD restaurada o `registry`, exportado de una fuente más nueva).
   */
  async reapplyExits(registry?: readonly string[]): Promise<{ runId: string; reanonymized: number }> {
    const hashes = new Set(registry ?? (await this.exportRegistry()));
    const runId = `ret_${randomUUID()}`;
    await this.deps.pool.query(
      `INSERT INTO retention_run (run_id, run_day, trigger, dry_run, policy, status)
       VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 'restore_reapply', false, $2, 'running')`,
      [runId, JSON.stringify(RETENTION_POLICY)]);
    let reanonymized = 0;
    try {
      const clients = await this.deps.pool.query<{ client_id: string }>(`SELECT client_id FROM client WHERE status <> 'anonymized'`);
      for (const { client_id: tenantId } of clients.rows) {
        if (!hashes.has(tenantSha256(tenantId))) continue;
        await this.anonymizeTenant(tenantId, runId);
        reanonymized += 1;
      }
      await this.finish(runId, 'completed', { tenantsAnonymized: reanonymized }, null);
      return { runId, reanonymized };
    } catch (err) {
      await this.finish(runId, 'failed', { tenantsAnonymized: reanonymized }, err instanceof Error ? err.name : 'unknown');
      throw err;
    }
  }

  /** Huellas del registro vigente (para restaurar un respaldo más antiguo). */
  async exportRegistry(): Promise<string[]> {
    const res = await this.deps.pool.query<{ tenant_sha256: string }>('SELECT tenant_sha256 FROM anonymized_tenant ORDER BY tenant_sha256');
    return res.rows.map((r) => r.tenant_sha256);
  }

  /** Purga por plazo de un tenant dentro de `client` (o solo cuenta, con dryRun). */
  private async purgeTenant(client: PoolClient, tenantId: string, dryRun: boolean): Promise<TenantPurgeCounts> {
    const conv = RETENTION_POLICY.conversationContent.interval;
    const auditI = RETENTION_POLICY.auditEvents.interval;
    const analyticsI = RETENTION_POLICY.analyticsAggregates.interval;
    const dueRequests = `SELECT request_id FROM conversation_request
       WHERE tenant_id = $1 AND content_purged_at IS NULL AND created_at < now() - $2::interval`;
    if (dryRun) {
      const n = async (sql: string, params: unknown[]) => Number((await client.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);
      return {
        conversations: await n(`SELECT count(*) AS n FROM (${dueRequests}) d`, [tenantId, conv]),
        proposals: await n(`SELECT count(*) AS n FROM action_proposal WHERE tenant_id = $1 AND content_purged_at IS NULL AND request_id IN (${dueRequests})`, [tenantId, conv]),
        proposalsExpired: await n(`SELECT count(*) AS n FROM action_proposal WHERE tenant_id = $1 AND status = ANY($3) AND request_id IN (${dueRequests})`, [tenantId, conv, OPEN_PROPOSAL_STATES]),
        jevBodies: await n(`SELECT count(*) AS n FROM jev_classification WHERE tenant_id = $1 AND content_purged_at IS NULL AND request_id IN (${dueRequests})`, [tenantId, conv]),
        auditEvents: await n('SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND ts < now() - $2::interval', [tenantId, auditI]),
        analyticsRows: await n('SELECT count(*) AS n FROM analytics_daily_summary WHERE tenant_id = $1 AND day < (now() - $2::interval)::date', [tenantId, analyticsI]),
      };
    }
    const purged = await client.query<{ request_id: string }>(
      `UPDATE conversation_request SET raw_message = $3, response_message = NULL, content_purged_at = now()
        WHERE request_id IN (${dueRequests}) AND tenant_id = $1 RETURNING request_id`, [tenantId, conv, PURGED_CONTENT_MARKER]);
    const requestIds = purged.rows.map((r) => r.request_id);
    const expired = await client.query(
      `UPDATE action_proposal SET status = 'expired', updated_at = now()
        WHERE tenant_id = $1 AND request_id = ANY($2) AND status = ANY($3)`, [tenantId, requestIds, OPEN_PROPOSAL_STATES]);
    const proposals = await client.query(
      `UPDATE action_proposal SET summary = $3, detail = '{}'::jsonb, content_purged_at = now()
        WHERE tenant_id = $1 AND request_id = ANY($2) AND content_purged_at IS NULL`, [tenantId, requestIds, PURGED_CONTENT_MARKER]);
    const jev = await client.query(
      `UPDATE jev_classification SET raw_request = NULL, raw_response = NULL, content_purged_at = now()
        WHERE tenant_id = $1 AND request_id = ANY($2) AND content_purged_at IS NULL`, [tenantId, requestIds]);
    const audit = await client.query('DELETE FROM audit_event WHERE tenant_id = $1 AND ts < now() - $2::interval', [tenantId, auditI]);
    const analytics = await client.query(
      'DELETE FROM analytics_daily_summary WHERE tenant_id = $1 AND day < (now() - $2::interval)::date', [tenantId, analyticsI]);
    return {
      conversations: requestIds.length,
      proposals: proposals.rowCount ?? 0,
      proposalsExpired: expired.rowCount ?? 0,
      jevBodies: jev.rowCount ?? 0,
      auditEvents: audit.rowCount ?? 0,
      analyticsRows: analytics.rowCount ?? 0,
    };
  }

  /** Datos del tenant para entregarlos antes de la baja (sin credenciales derivadas). */
  private async exportTenant(tenantId: string): Promise<Record<string, unknown>> {
    const google = await new GoogleContentRetention(this.deps).purge({ tenantId });
    if (google.failures) throw new AppError(503, DENY_CODES.INTERNAL, 'No se pudo aplicar la retención de Google antes de exportar.');
    const out: Record<string, unknown> = {
      format: 'mainspot-tenant-export/v1', tenant_id: tenantId, exported_at: new Date().toISOString(),
    };
    const clientRow = await this.deps.pool.query('SELECT * FROM client WHERE client_id = $1', [tenantId]);
    out.client = clientRow.rows[0] ?? null;
    for (const { table, key, exportSkip } of [...TENANT_TABLES].reverse()) {
      if (table === 'tenant_exit') continue;
      const res = await this.deps.pool.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${key} = $1`, [tenantId]);
      out[table] = res.rows.map((row) => Object.fromEntries(Object.entries(row).filter(([col]) => !exportSkip?.includes(col))));
    }
    return out;
  }

  private async identifiers(client: PoolClient, tenantId: string): Promise<TenantIdentifiers> {
    const strong = new Set<string>([tenantId]);
    const weak = new Set<string>();
    const add = (set: Set<string>, v: unknown) => {
      if (typeof v === 'string' && v.trim().length >= 4) set.add(v.trim());
    };
    const c = await client.query<{ business_name: string; contact_email: string | null }>(
      'SELECT business_name, contact_email FROM client WHERE client_id = $1', [tenantId]);
    if (!c.rows[0]) throw new AppError(404, DENY_CODES.NOT_FOUND, 'No existe ese negocio.');
    add(weak, c.rows[0].business_name);
    add(strong, c.rows[0].contact_email);
    for (const u of (await client.query<{ user_id: string; login: string; display_name: string }>(
      'SELECT user_id, login, display_name FROM internal_user WHERE tenant_id = $1', [tenantId])).rows) {
      add(strong, u.user_id);
      add(strong, u.login);
      add(weak, u.display_name);
    }
    for (const w of (await client.query<{ slug: string; site_name: string }>(
      'SELECT slug, site_name FROM client_website WHERE tenant_id = $1', [tenantId])).rows) {
      add(strong, w.slug);
      add(weak, w.site_name);
    }
    for (const d of (await client.query<{ subdomain: string }>('SELECT subdomain FROM client_domain WHERE tenant_id = $1', [tenantId])).rows) {
      add(strong, d.subdomain);
    }
    // Correlaciones propias del tenant: sus solicitudes y los request_id de su auditoría que no
    // comparte con nadie (las ejecuciones de plataforma, como `ret_*`, abarcan a varios tenants
    // y no lo identifican). Los actores de plataforma tampoco: solo sus propios usuarios.
    for (const r of (await client.query<{ request_id: string }>(
      `SELECT request_id FROM conversation_request WHERE tenant_id = $1
       UNION
       SELECT DISTINCT a.request_id FROM audit_event a
        WHERE a.tenant_id = $1 AND a.request_id NOT LIKE 'ret\\_%'
          AND NOT EXISTS (SELECT 1 FROM audit_event b WHERE b.request_id = a.request_id AND b.tenant_id <> $1)`, [tenantId])).rows) {
      add(strong, r.request_id);
    }
    return { strong: [...strong], weak: [...weak] };
  }

  /**
   * Verificación (DEC-0027) dentro de la transacción de anonimización: ningún identificador
   * técnico o de contacto en ninguna columna de texto de la base, y ningún nombre en lo que se
   * conserva del tenant (agregados y auditoría re-etiquetados). Si algo aparece, lanza y la
   * transacción se revierte. Solo nombra tabla y columna, nunca el valor encontrado.
   */
  private async assertNoTraces(client: PoolClient, ids: TenantIdentifiers, anonymousId: string): Promise<void> {
    const columns = await client.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
          AND c.data_type IN ('text', 'character varying', 'jsonb', 'json')
          AND c.table_name <> 'schema_migrations'`);
    // Límite de identificador: letras, dígitos, `_` y `-` continúan el identificador (así
    // `cafe-luna` no coincide dentro de `cafe-luna-2`); cualquier otro carácter lo cierra.
    const strongPatterns = ids.strong.map((v) => `(^|[^A-Za-z0-9_-])${escapeRegex(v)}([^A-Za-z0-9_-]|$)`);
    for (const { table_name: table, column_name: column } of columns.rows) {
      const hit = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${table}" WHERE "${column}"::text ~ ANY($1::text[])`, [strongPatterns]);
      if (Number(hit.rows[0]?.n ?? 0) > 0) throw new Error(`anonymization verification failed: identifier left in ${table}.${column}`);
    }
    if (ids.weak.length === 0) return;
    const weakPatterns = ids.weak.map((v) => `%${v.replace(/[\\%_]/g, '\\$&')}%`);
    // Columnas que se conservan y admiten texto variable (los roles y las acciones son un
    // vocabulario fijo y no se comprueban).
    const kept: Array<[string, string]> = [
      ['audit_event', 'resource'], ['audit_event', 'result'], ['analytics_daily_summary', 'result'],
    ];
    for (const [table, column] of kept) {
      const hit = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1 AND ${column} ILIKE ANY($2::text[])`, [anonymousId, weakPatterns]);
      if (Number(hit.rows[0]?.n ?? 0) > 0) throw new Error(`anonymization verification failed: name left in ${table}.${column}`);
    }
  }

  private async finish(runId: string, status: 'completed' | 'failed', totals: object, errorCode: string | null): Promise<void> {
    await this.deps.pool.query(
      `UPDATE retention_run SET status = $2, totals = $3, error_code = $4, finished_at = now() WHERE run_id = $1`,
      [runId, status, JSON.stringify(totals), errorCode]);
  }
}

function hasChanges(c: TenantPurgeCounts): boolean {
  return Object.values(c).some((n) => n > 0);
}

function countsResult(c: TenantPurgeCounts): string {
  return `conversations:${c.conversations},proposals:${c.proposals},expired:${c.proposalsExpired},jev:${c.jevBodies},audit:${c.auditEvents},analytics:${c.analyticsRows}`;
}
