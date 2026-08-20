/**
 * Tenant-scoped data repositories (C1/C2).
 *
 * Every read/write receives a session and embeds tenant_id in the SQL scope.
 * FAIL-CLOSED: absence of tenant context => no query is executed; cross-tenant
 * lookups return the `found/in_tenant` marker used INTERNALLY for decision and
 * audit only — it never differentiates the HTTP response (anti-oracle, IR-01).
 */

import type { Pool, PoolClient } from 'pg';
import type { SessionSummary } from '../shared/context.ts';
import type { InternalUser, SessionContext } from './entities.ts';
import { ROLE_NAMES, type RoleName } from './entities.ts';

export interface TenantBoundaryResult<T> {
  found: boolean;
  in_tenant: boolean;
  row: T | null;
}

function hasTenant(session: SessionSummary): boolean {
  return Boolean(session?.tenant_id);
}

function assertTenant(session: SessionSummary): string {
  if (!hasTenant(session)) {
    throw new Error('FAIL-CLOSED: session has no tenant context; refusing to run unscoped query');
  }
  return session.tenant_id;
}

export class IdentityRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Enumerate roles a user has inside a tenant. */
  async listRolesForUserInTenant(userId: string, tenantId: string): Promise<RoleName[]> {
    const res = await this.pool.query<{ role_id: RoleName }>(
      `SELECT ur.role_id FROM user_role ur WHERE ur.user_id = $1 AND ur.tenant_id = $2`,
      [userId, tenantId],
    );
    return res.rows.map((r) => r.role_id);
  }

  /** Login lookup: active user with an active role activation inside an active tenant. */
  async findLoginInTenant(login: string, tenantId: string): Promise<InternalUser | null> {
    const res = await this.pool.query<InternalUser>(`
      SELECT DISTINCT u.* FROM internal_user u
      JOIN user_role ur ON ur.user_id = u.user_id AND ur.tenant_id = u.tenant_id
      JOIN client c ON c.client_id = u.tenant_id
      WHERE u.login = $1 AND u.tenant_id = $2 AND u.status = 'active' AND c.status = 'active'
      LIMIT 1
    `, [login, tenantId]);
    return res.rows[0] ?? null;
  }

  /** Verify a password using pgcrypto crypt(). */
  async verifyPassword(userId: string, password: string, db: Pool | PoolClient = this.pool): Promise<boolean> {
    const res = await db.query<{ ok: boolean }>(
      `SELECT (password_hash = crypt($2, password_hash)) AS ok FROM internal_user WHERE user_id = $1`,
      [userId, password],
    );
    return res.rows[0]?.ok === true;
  }

  async createSession(session: SessionContext, db: Pool | PoolClient = this.pool): Promise<void> {
    await db.query(
      `INSERT INTO session_context
        (session_id, user_id, tenant_id, role_id, permissions, source, issued_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [session.session_id, session.user_id, session.tenant_id, session.role_id,
        JSON.stringify(session.permissions), session.source, session.issued_at, session.expires_at],
    );
  }

  /** Load session and validate it is still usable (fail-closed on any doubt). */
  async resolveSession(sessionId: string): Promise<SessionContext | null> {
    const res = await this.pool.query<SessionContext>('SELECT * FROM session_context WHERE session_id = $1', [sessionId]);
    const row = res.rows[0] ?? null;
    if (!row) return null;
    const now = new Date();
    if (row.revoked_at && new Date(row.revoked_at).getTime() <= now.getTime()) return null;
    if (new Date(row.expires_at).getTime() <= now.getTime()) return null;
    return row;
  }

  /** Re-validate on every request that user+role activation+tenant are still active. */
  async validateSessionBindings(userId: string, tenantId: string, roleId: RoleName): Promise<boolean> {
    const res = await this.pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM internal_user u
         JOIN user_role ur ON ur.user_id = u.user_id AND ur.tenant_id = u.tenant_id
         JOIN client c ON c.client_id = u.tenant_id
         WHERE u.user_id = $1 AND u.tenant_id = $2 AND ur.role_id = $3
           AND u.status = 'active' AND c.status = 'active'
       ) AS ok`,
      [userId, tenantId, roleId],
    );
    return res.rows[0]?.ok === true;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.pool.query('UPDATE session_context SET revoked_at = now() WHERE session_id = $1', [sessionId]);
  }

  /** Demo/admin: create an internal user with a role activation inside a tenant (user.manage). */
  async createUserWithRole(input: {
    user_id: string;
    display_name: string;
    login: string;
    password: string;
    role: RoleName;
    tenant_id: string;
  }, db: Pool | PoolClient = this.pool): Promise<InternalUser> {
    await db.query(
      `INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash)
       VALUES ($1,$2,$3,'active',$4, crypt($5, gen_salt('bf', 10)))`,
      [input.user_id, input.display_name, input.login, input.tenant_id, input.password],
    );
    await db.query(
      `INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, role_id, tenant_id) DO NOTHING`,
      [input.user_id, input.role, input.tenant_id],
    );
    const res = await db.query<InternalUser>('SELECT * FROM internal_user WHERE user_id = $1', [input.user_id]);
    return res.rows[0] as InternalUser;
  }

  async listUsersInTenant(session: SessionSummary): Promise<InternalUser[]> {
    const tenantId = assertTenant(session);
    const res = await this.pool.query<InternalUser>(
      `SELECT u.* FROM internal_user u
       WHERE u.tenant_id = $1 ORDER BY u.created_at`,
      [tenantId],
    );
    return res.rows;
  }
}
