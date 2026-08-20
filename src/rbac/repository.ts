/**
 * RBAC repository: persisted mirror of the matrix (role_permission →
 * permission) used for transparency/export and seed verification.
 * Authorization itself always uses the code matrix (src/rbac/matrix.ts).
 */

import type { Pool } from 'pg';
import type { RoleName } from '../identity/entities.ts';
import { toMatrixEntries, type ActionName } from './matrix.ts';

export class RbacRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Re-sync the DB mirror to the code matrix (idempotent). */
  async syncMatrix(): Promise<void> {
    for (const entry of toMatrixEntries()) {
      await this.pool.query(
        `INSERT INTO permission (permission_id, action, resource, effect)
         VALUES ($1, $2, $3, 'allow')
         ON CONFLICT (permission_id) DO NOTHING`,
        [entry.action, entry.action, entry.resource],
      );
      await this.pool.query(
        `INSERT INTO role_permission (role_id, permission_id)
         VALUES ($1, $2)
         ON CONFLICT (role_id, permission_id) DO NOTHING`,
        [entry.role, entry.action],
      );
    }
  }

  /** Permissions granted to a role (mirror); used for session snapshot/display. */
  async permissionsForRole(role: RoleName): Promise<ActionName[]> {
    const res = await this.pool.query<{ action: ActionName }>(
      `SELECT p.action FROM role_permission rp
       JOIN permission p ON p.permission_id = rp.permission_id
       WHERE rp.role_id = $1 ORDER BY p.action`,
      [role],
    );
    return res.rows.map((r) => r.action);
  }
}
