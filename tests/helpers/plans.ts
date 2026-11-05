/**
 * Fixtures del catálogo de planes versionado (migración 0034): un plan de test nace con una revisión
 * PUBLICADA y TODOS los parámetros definidos en la BD con valor confirmado (lo exige el trigger de publicación).
 * Se leen de `plan_parameter_definition` para servir igual a BD con 0034 (registro 1) o con 0036 (registro 2).
 * Una capacidad no indicada vale 0 (deny), igual que la ausencia de fila en el catálogo anterior.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/** Crea `planId` habilitado con la revisión 1 publicada; devuelve el id de la revisión. */
export async function createPublishedPlan(pool: Pool, planId: string, limits: Record<string, number>, opts: { name?: string; enabled?: boolean } = {}): Promise<string> {
  const revisionId = `prv_${planId}_${randomUUID().slice(0, 8)}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active, created_by)
       VALUES ($1, $2, 'test', NULL, NULL, false, false, 'test') ON CONFLICT (plan_id) DO NOTHING`, [planId, opts.name ?? planId]);
    await client.query(
      `INSERT INTO plan_revision (revision_id, plan_id, version, status, origin, registry_version, reason, created_by)
       VALUES ($1, $2, 1, 'DRAFT', 'create', 1, 'Plan de test del catálogo versionado', 'test')`, [revisionId, planId]);
    const defs = await client.query<{ parameter_key: string; capability: string | null; value_type: 'int' | 'bool' }>(
      'SELECT parameter_key, capability, value_type FROM plan_parameter_definition ORDER BY sort_order, parameter_key');
    for (const def of defs.rows) {
      const bool = def.value_type === 'bool';
      await client.query(
        `INSERT INTO plan_parameter_value (revision_id, parameter_key, value_int, value_bool, source, confirmed_by, confirmed_at, updated_by)
         VALUES ($1, $2, $3, $4, 'explicit', 'test', now(), 'test')`,
        [revisionId, def.parameter_key, bool ? null : limits[def.capability ?? ''] ?? 0, bool ? false : null]);
    }
    await client.query(
      `UPDATE plan_revision SET status = 'PUBLISHED', published_by = 'test', published_at = now(), publish_reason = 'Plan de test publicado',
              checksum = plan_revision_checksum(revision_id) WHERE revision_id = $1`, [revisionId]);
    if (opts.enabled !== false) await client.query('UPDATE plan SET active = true WHERE plan_id = $1', [planId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return revisionId;
}

/** Asigna (o cambia) el plan del tenant por SQL: el trigger fija la revisión publicada vigente. */
export async function setTenantPlan(pool: Pool, tenantId: string, planId: string): Promise<void> {
  await pool.query(
    `INSERT INTO subscription (subscription_id, tenant_id, plan_id, status) VALUES ($1, $2, $3, 'active')
     ON CONFLICT (tenant_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, plan_revision_id = EXCLUDED.plan_revision_id, status = 'active', updated_at = now()`,
    [`sub_${tenantId}`, tenantId, planId]);
}
