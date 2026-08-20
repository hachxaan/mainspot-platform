/**
 * RetentionService (INC-007 base, DEC-025) — retención configurable por env
 * (RETENTION_DAYS, default 90) aplicada como tarea ON-DEMAND (nunca automática
 * en esta tanda). El borrado SOLO ocurre con dryRun=false; el default de la
 * operación es DRY-RUN (seguro): cuenta cuánto se borraría, no borra.
 *
 * Scope: el tenant de la sesión (aislamiento por cliente, NFR-002). La
 * retención global de plataforma queda documentada como riesgo/limitación.
 */

import type { Pool } from 'pg';

export interface PurgeResult {
  tenant_id: string;
  dry_run: boolean;
  cutoff: string;
  retention_days: number;
  events_to_delete: number;
  summaries_to_delete: number;
  events_deleted: number;
  summaries_deleted: number;
}

export interface RetentionServiceDeps {
  pool: Pool;
  retentionDays: number;
}

export function retentionCutoff(retentionDays: number, now = new Date()): Date {
  const d = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  return d;
}

export class RetentionService {
  private readonly deps: RetentionServiceDeps;

  constructor(deps: RetentionServiceDeps) {
    this.deps = deps;
  }

  /**
   * Purga eventos del tenant anteriores al cutoff. Con dryRun=true solo calcula
   * los conteos (NO borra). Con dryRun=false borra los eventos y los resúmenes
   * diarios anteriores al día del cutoff.
   */
  async purge(tenantId: string, opts: { dryRun?: boolean; cutoff?: Date } = {}): Promise<PurgeResult> {
    const dryRun = opts.dryRun !== false; // default seguro: DRY-RUN
    const cutoff = opts.cutoff ?? retentionCutoff(this.deps.retentionDays);
    const cutoffIso = cutoff.toISOString();

    const evCount = await this.deps.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND ts < $2',
      [tenantId, cutoffIso],
    );
    const sumCount = await this.deps.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM analytics_daily_summary WHERE tenant_id = $1 AND day < $2::date',
      [tenantId, cutoffIso],
    );
    const eventsToDelete = Number(evCount.rows[0]?.n ?? 0);
    const summariesToDelete = Number(sumCount.rows[0]?.n ?? 0);

    if (dryRun) {
      return {
        tenant_id: tenantId, dry_run: true, cutoff: cutoffIso, retention_days: this.deps.retentionDays,
        events_to_delete: eventsToDelete, summaries_to_delete: summariesToDelete,
        events_deleted: 0, summaries_deleted: 0,
      };
    }

    const delEvents = await this.deps.pool.query(
      'DELETE FROM audit_event WHERE tenant_id = $1 AND ts < $2',
      [tenantId, cutoffIso],
    );
    const delSummaries = await this.deps.pool.query(
      'DELETE FROM analytics_daily_summary WHERE tenant_id = $1 AND day < $2::date',
      [tenantId, cutoffIso],
    );
    return {
      tenant_id: tenantId, dry_run: false, cutoff: cutoffIso, retention_days: this.deps.retentionDays,
      events_to_delete: eventsToDelete, summaries_to_delete: summariesToDelete,
      events_deleted: delEvents.rowCount ?? 0, summaries_deleted: delSummaries.rowCount ?? 0,
    };
  }
}
