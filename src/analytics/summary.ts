/**
 * AnalyticsService (INC-007 base, CAP-014, DEC-025) — agregados mínimos.
 *
 * - dailySummary: contadores por DÍA/acción/resultado consultados en vivo con
 *   SELECT simple (sin ETL externo).
 * - refreshDailySummary: materializa los agregados en analytics_daily_summary
 *   (upsert idempotente) para export/consulta estable.
 *
 * Dashboards completos, ETL externo y research/recomendaciones son FASE 2
 * (INC-007 fuera del alcance de esta base).
 */

import type { Pool } from 'pg';

export interface DailyCountRow {
  day: string;
  action: string;
  result: string;
  count: number;
}

export interface AnalyticsServiceDeps {
  pool: Pool;
}

export class AnalyticsService {
  private readonly pool: Pool;

  constructor(deps: AnalyticsServiceDeps) {
    this.pool = deps.pool;
  }

  /** Agregados en vivo de audit_event por día (source of truth, DEC-025). */
  async dailySummary(tenantId: string, opts: { from?: string; to?: string } = {}): Promise<DailyCountRow[]> {
    const where = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (opts.from) {
      where.push(`ts >= $${values.length + 1}`); values.push(opts.from);
    }
    if (opts.to) {
      where.push(`ts <= $${values.length + 1}`); values.push(opts.to);
    }
    const res = await this.pool.query<DailyCountRow>(
      `SELECT date_trunc('day', ts)::date AS day, action, result, count(*)::int AS count
       FROM audit_event WHERE ${where.join(' AND ')}
       GROUP BY day, action, result ORDER BY day, action, result`,
      values,
    );
    return res.rows;
  }

  /** Materializa el resumen diario (upsert idempotente, ON CONFLICT actualiza). */
  async refreshDailySummary(tenantId: string, opts: { from?: string; to?: string } = {}): Promise<{ upserted: number }> {
    const rows = await this.dailySummary(tenantId, opts);
    let upserted = 0;
    for (const r of rows) {
      // ON CONFLICT (tenant_id, day, action, result) => el SELECT agrupa; el
      // conflicto solo puede darse por replays del mismo refresh (idempotente).
      await this.pool.query(
        `INSERT INTO analytics_daily_summary (summary_id, tenant_id, day, action, result, count)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, day, action, result) DO UPDATE SET count = EXCLUDED.count, updated_at = now()`,
        [`smry_${crypto.randomUUID()}`, tenantId, r.day, r.action, r.result, r.count],
      );
      upserted += 1;
    }
    return { upserted };
  }
}
