/**
 * Tenant-scoped data access layer (C2, T-005).
 *
 * INVARIANT: every query embeds tenant_id from the SESSION (never from the
 * request body/params/headers). Resources that belong to another tenant are
 * returned as found=true,in_tenant=false so the boundary layer can deny +
 * audit without leaking existence. No session => no query (fail-closed).
 */

import type { Pool, PoolClient } from 'pg';
import type { SessionSummary } from '../shared/context.ts';

export interface TenantBoundaryResult<T> {
  found: boolean;
  in_tenant: boolean;
  row: T | null;
}

function tenantOf(session: SessionSummary): string {
  if (!session?.tenant_id) {
    throw new Error('FAIL-CLOSED: no tenant context for data access');
  }
  return session.tenant_id;
}

export interface ClientDataRow {
  data_id: string;
  tenant_id: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export class TenantDataRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(session: SessionSummary, input: { kind: string; payload: Record<string, unknown> }, db: Pool | PoolClient = this.pool, dataId?: string): Promise<ClientDataRow> {
    const tenantId = tenantOf(session);
    const id = dataId ?? `data_${crypto.randomUUID()}`;
    // NOTE: tenant_id comes from the session only; any tenant_id in the body is
    // ignored (the API-level guard rejects mismatches before reaching here).
    await db.query(
      `INSERT INTO client_data (data_id, tenant_id, kind, payload) VALUES ($1,$2,$3,$4)`,
      [id, tenantId, input.kind, JSON.stringify(input.payload)],
    );
    const res = await db.query<ClientDataRow>('SELECT * FROM client_data WHERE data_id = $1', [id]);
    return res.rows[0] as ClientDataRow;
  }

  async list(session: SessionSummary): Promise<ClientDataRow[]> {
    const tenantId = tenantOf(session);
    const res = await this.pool.query<ClientDataRow>(
      'SELECT * FROM client_data WHERE tenant_id = $1 ORDER BY created_at, data_id',
      [tenantId],
    );
    return res.rows;
  }

  /** Scoped read. Cross-tenant id => found=true,in_tenant=false (deny by caller). */
  async findScoped(session: SessionSummary, dataId: string): Promise<TenantBoundaryResult<ClientDataRow>> {
    const tenantId = tenantOf(session);
    const res = await this.pool.query<ClientDataRow>('SELECT * FROM client_data WHERE data_id = $1', [dataId]);
    const row = res.rows[0] ?? null;
    if (!row) return { found: false, in_tenant: false, row: null };
    return { found: true, in_tenant: row.tenant_id === tenantId, row };
  }
}

export type DemoActionStatus = 'created' | 'approved' | 'rejected' | 'executed';

export interface DemoActionRow {
  action_id: string;
  tenant_id: string;
  title: string;
  status: DemoActionStatus;
  created_by: string;
  decided_by: string | null;
  executed_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Demo/evidence fixture for AC-003 (create/approve/reject/execute a test
 * action). This is NOT the INC-002 approval domain: it has no preview,
 * publication or external effect. Marked TENTATIVA in README.
 */
export class DemoActionRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(session: SessionSummary, input: { title: string }, db: Pool | PoolClient = this.pool, actionId?: string): Promise<DemoActionRow> {
    const tenantId = tenantOf(session);
    const id = actionId ?? `action_${crypto.randomUUID()}`;
    await db.query(
      `INSERT INTO demo_action (action_id, tenant_id, title, status, created_by)
       VALUES ($1,$2,$3,'created',$4)`,
      [id, tenantId, input.title, session.user_id],
    );
    const res = await db.query<DemoActionRow>('SELECT * FROM demo_action WHERE action_id = $1', [id]);
    return res.rows[0] as DemoActionRow;
  }

  async findScoped(session: SessionSummary, actionId: string): Promise<TenantBoundaryResult<DemoActionRow>> {
    const res = await this.pool.query<DemoActionRow>('SELECT * FROM demo_action WHERE action_id = $1', [actionId]);
    const row = res.rows[0] ?? null;
    if (!row) return { found: false, in_tenant: false, row: null };
    return { found: true, in_tenant: row.tenant_id === tenantOf(session), row };
  }

  async setStatus(
    session: SessionSummary,
    actionId: string,
    status: DemoActionStatus,
    decidedBy: string,
    db: Pool | PoolClient = this.pool,
  ): Promise<DemoActionRow> {
    const tenantId = tenantOf(session);
    const res = await db.query<DemoActionRow>(
      `UPDATE demo_action
       SET status = $1, updated_at = now(),
           decided_by = coalesce(decided_by, $3),
           executed_by = CASE WHEN $1 = 'executed' THEN $3 ELSE executed_by END
       WHERE action_id = $2 AND tenant_id = $4
       RETURNING *`,
      [status, actionId, decidedBy, tenantId],
    );
    const row = res.rows[0] ?? null;
    if (!row) throw new Error(`demo_action ${actionId} not found in tenant ${tenantId}`);
    return row;
  }
}
