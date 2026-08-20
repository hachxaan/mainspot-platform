/**
 * Audit query/export (C4). Tenant-scoped: a session can only read the audit
 * events of its own tenant (boundary layer enforces this at entry).
 */

import type { Pool } from 'pg';
import type { AuditEventRow } from './event.ts';

export class AuditQuery {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** List events of a tenant, optionally correlated by request_id (AC-003). */
  async listByTenant(tenantId: string, opts: { request_id?: string; limit?: number } = {}): Promise<AuditEventRow[]> {
    const limit = Math.min(opts.limit ?? 200, 500);
    if (opts.request_id) {
      const res = await this.pool.query<AuditEventRow>(
        `SELECT * FROM audit_event WHERE tenant_id = $1 AND request_id = $2 ORDER BY ts, event_id LIMIT $3`,
        [tenantId, opts.request_id, limit],
      );
      return res.rows;
    }
    const res = await this.pool.query<AuditEventRow>(
      `SELECT * FROM audit_event WHERE tenant_id = $1 ORDER BY ts DESC, event_id DESC LIMIT $2`,
      [tenantId, limit],
    );
    return res.rows;
  }

  /** Count events of a tenant (used for rollback preservation evidence). */
  async countByTenant(tenantId: string): Promise<number> {
    const res = await this.pool.query<{ n: string }>('SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1', [tenantId]);
    return Number(res.rows[0]?.n ?? 0);
  }
}
