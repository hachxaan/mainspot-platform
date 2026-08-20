/**
 * ExportService (INC-007 base, CAP-014, DEC-025) — export ETL mínimo de
 * eventos de auditoría por tenant, con filtro por rango y tipo, formato
 * JSON/CSV, paginación y auditoría del exporte. Los eventos son la fuente de
 * analítica (DEC-025); dashboards complejos y research son fase 2 (fuera).
 */

import type { Pool } from 'pg';
import type { AuditEventRow } from '../audit/event.ts';

export type ExportFormat = 'json' | 'csv';

export interface ExportFilters {
  from?: string;       // ISO datetime (inclusive)
  to?: string;         // ISO datetime (inclusive)
  action?: string;
  format?: ExportFormat;
  page?: number;       // 1-based
  pageSize?: number;
}

export interface ExportResult {
  data: unknown[] | string; // 'json' => rows; 'csv' => texto CSV
  format: ExportFormat;
  page: number;
  page_size: number;
  total: number;
  has_more: boolean;
  generated_at: string;
}

export const EXPORT_COLUMNS = ['event_id', 'ts', 'tenant_id', 'actor_id', 'actor_role', 'action', 'resource', 'request_id', 'decision', 'result', 'evidence_ref', 'created_by_system'] as const;
export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

/** Escapado CSV determinista (RFC 4180 básico). */
export function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(rows: Record<string, unknown>[]): string {
  const header = EXPORT_COLUMNS.map(csvEscape).join(',');
  const body = rows.map((r) => EXPORT_COLUMNS.map((c) => csvEscape(r[c])).join(','));
  return [header, ...body].join('\n');
}

export function normalizePagination(exportFilters: ExportFilters): { page: number; pageSize: number; offset: number } {
  const pageSize = Math.min(Math.max(Math.trunc(exportFilters.pageSize ?? 50), 1), 100);
  const page = Math.max(Math.trunc(exportFilters.page ?? 1), 1);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

export class ExportService {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async exportEvents(tenantId: string, filters: ExportFilters = {}): Promise<ExportResult> {
    const { page, pageSize, offset } = normalizePagination(filters);
    const where: string[] = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (filters.from) {
      where.push(`ts >= $${values.length + 1}`);
      values.push(filters.from);
    }
    if (filters.to) {
      where.push(`ts <= $${values.length + 1}`);
      values.push(filters.to);
    }
    if (filters.action) {
      where.push(`action = $${values.length + 1}`);
      values.push(filters.action);
    }
    const whereSql = where.join(' AND ');

    const countRes = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_event WHERE ${whereSql}`,
      values,
    );
    const total = Number(countRes.rows[0]?.n ?? 0);

    const rowsRes = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM audit_event WHERE ${whereSql} ORDER BY ts, event_id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, pageSize, offset],
    );
    const rows = rowsRes.rows as unknown as AuditEventRow[];

    const format: ExportFormat = filters.format === 'csv' ? 'csv' : 'json';
    const data: unknown[] | string = format === 'csv'
      ? rowsToCsv(rows as unknown as Record<string, unknown>[])
      : rows;

    return {
      data,
      format,
      page,
      page_size: pageSize,
      total,
      has_more: offset + rows.length < total,
      generated_at: new Date().toISOString(),
    };
  }
}
