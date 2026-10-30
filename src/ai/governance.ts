/**
 * Gates previos a cualquier llamada de IA (BR-0007, NFR-0006):
 *  - Política de datos: proveedores reales solo con AI_REAL_PROVIDERS=on, secreto configurado y
 *    negocio `synthetic` (o evaluación de plataforma sin negocio). Negocios `real` ⇒ BLOCKED_EXTERNAL
 *    hasta una decisión de privacidad (QS-0016 / DEC-0019).
 *  - Presupuesto: reserva del costo máximo de la ruta bajo un candado global; la suma de lo gastado
 *    (costo real) + lo reservado (en curso) no puede superar ningún límite aplicable.
 */

import type { PoolClient, Pool } from 'pg';
import type { AppConfig } from '../shared/config.ts';
import type { ProviderRow } from './registry.ts';

export type PolicyDecision = { allowed: true; dataScope: 'internal' | 'synthetic_tenant' | 'platform_synthetic' } | { allowed: false; reason: 'real_providers_disabled' | 'tenant_data_real' | 'tenant_inactive' | 'secret_missing' | 'provider_disabled' };

export const DATA_POLICY_VERSION = 'ai-data-policy-v1:synthetic-only';

export async function checkDataPolicy(pool: Pool | PoolClient, config: Pick<AppConfig, 'aiRealProviders'>, provider: ProviderRow, tenantId: string | null): Promise<PolicyDecision> {
  if (provider.status !== 'active') return { allowed: false, reason: 'provider_disabled' };
  if (provider.kind === 'simulated') return { allowed: true, dataScope: 'internal' };
  if (!config.aiRealProviders) return { allowed: false, reason: 'real_providers_disabled' };
  if (!provider.secret_ref || !process.env[provider.secret_ref]) return { allowed: false, reason: 'secret_missing' };
  if (!tenantId) return { allowed: true, dataScope: 'platform_synthetic' };
  const r = await pool.query<{ data_classification: string; status: string }>('SELECT data_classification, status FROM client WHERE client_id = $1', [tenantId]);
  const row = r.rows[0];
  if (!row || row.status !== 'active') return { allowed: false, reason: 'tenant_inactive' };
  if (row.data_classification !== 'synthetic') return { allowed: false, reason: 'tenant_data_real' };
  return { allowed: true, dataScope: 'synthetic_tenant' };
}

export interface BudgetLimit { scope: 'lab_total' | 'platform_month' | 'tenant_day'; limitUsd: number; spentUsd: number }
export type BudgetDecision = { allowed: true; limits: BudgetLimit[] } | { allowed: false; limits: BudgetLimit[]; exceeded: BudgetLimit['scope'] };

/** Gasto efectivo: costo real de lo terminado + reserva de lo que sigue en curso. Solo proveedores de pago (OpenRouter). */
const SPENT_SQL = `SELECT COALESCE(SUM(CASE WHEN i.status = 'running' THEN i.reserved_usd ELSE COALESCE(i.cost_usd, i.reserved_usd) END), 0) AS spent
  FROM ai_invocation i JOIN ai_provider p ON p.provider_id = i.provider_id
 WHERE p.kind = 'openrouter' AND i.status IN ('running','succeeded','failed')`;

/**
 * Comprueba y deja el candado tomado: el llamador inserta la invocación `running` con `reserved_usd`
 * en la MISMA transacción, de modo que dos reservas concurrentes nunca superan el techo.
 */
export async function reserveBudget(client: PoolClient, tenantId: string | null, reserveUsd: number): Promise<BudgetDecision> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('ai_budget_reservation'))`);
  const budgets = await client.query<{ scope: BudgetLimit['scope']; tenant_id: string | null; limit_usd: string }>(
    `SELECT scope, tenant_id, limit_usd FROM ai_budget
      WHERE scope IN ('lab_total','platform_month') OR (scope = 'tenant_day' AND (tenant_id = $1 OR tenant_id IS NULL))`, [tenantId]);
  const limits: BudgetLimit[] = [];
  const pick = (scope: BudgetLimit['scope']) => {
    const rows = budgets.rows.filter((b) => b.scope === scope);
    return rows.find((b) => b.tenant_id !== null) ?? rows[0];
  };
  const lab = pick('lab_total');
  if (lab) {
    const s = await client.query<{ spent: string }>(SPENT_SQL);
    limits.push({ scope: 'lab_total', limitUsd: Number(lab.limit_usd), spentUsd: Number(s.rows[0]?.spent ?? 0) });
  }
  const month = pick('platform_month');
  if (month) {
    const s = await client.query<{ spent: string }>(`${SPENT_SQL} AND i.created_at >= date_trunc('month', now())`);
    limits.push({ scope: 'platform_month', limitUsd: Number(month.limit_usd), spentUsd: Number(s.rows[0]?.spent ?? 0) });
  }
  const day = tenantId ? pick('tenant_day') : undefined;
  if (day && tenantId) {
    const s = await client.query<{ spent: string }>(`${SPENT_SQL} AND i.tenant_id = $1 AND i.created_at >= date_trunc('day', now())`, [tenantId]);
    limits.push({ scope: 'tenant_day', limitUsd: Number(day.limit_usd), spentUsd: Number(s.rows[0]?.spent ?? 0) });
  }
  const exceeded = limits.find((l) => l.spentUsd + reserveUsd > l.limitUsd + 1e-9);
  return exceeded ? { allowed: false, limits, exceeded: exceeded.scope } : { allowed: true, limits };
}

/** Costo estimado con el precio publicado guardado en el modelo (USD por millón de tokens / por imagen). */
export function estimateCost(pricing: Record<string, number>, usage: { inputTokens: number; outputTokens: number; images: number }): number | null {
  const inp = pricing['input_per_mtok'];
  const out = pricing['output_per_mtok'];
  const img = pricing['per_image'];
  if (inp === undefined && out === undefined && img === undefined) return null;
  return ((inp ?? 0) * usage.inputTokens + (out ?? 0) * usage.outputTokens) / 1_000_000 + (img ?? 0) * usage.images;
}
