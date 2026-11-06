/**
 * Gates previos a cualquier llamada de IA (BR-0007, NFR-0006):
 *  - Política de datos (DEC-0067, DEC-0071): proveedores reales solo con AI_REAL_PROVIDERS=on y
 *    secreto configurado. Un negocio `synthetic` puede usar cualquier proveedor activo; un negocio
 *    `real` solo los proveedores con cobertura contractual verificada (`ai_provider.real_data =
 *    'allowed'`, con fecha y base documental). Sin verificación ⇒ BLOCKED_EXTERNAL solo para ese
 *    proveedor; las demás capacidades siguen.
 *  - Presupuesto (DEC-0068; FB-3, DEC-0078): reserva del costo máximo de la ruta bajo un candado global; la suma de lo
 *    gastado (costo real o estimado) + lo reservado (en curso) no puede superar ningún límite que aplique. `lab_total`
 *    es el techo global estricto y acumulado (incluye el consumo histórico de OpenRouter) de TODO el gasto de pago.
 *    Por debajo, el gasto se separa por propósito: la operación comercial (sin grant) responde ante el `tenant_day`
 *    de su negocio y el laboratorio (con grant, DEC-0074) ante el `lab_experiment` global; ninguno consume el del
 *    otro. TypeSafe va aparte (DEC-0032).
 */

import type { PoolClient, Pool } from 'pg';
import type { AppConfig } from '../shared/config.ts';
import type { AiChannel, ProviderRow } from './registry.ts';

export type PolicyDecision =
  | { allowed: true; dataScope: 'internal' | 'synthetic_tenant' | 'real_tenant' | 'platform_synthetic' }
  | { allowed: false; reason: 'real_providers_disabled' | 'provider_terms_unverified' | 'tenant_inactive' | 'secret_missing' | 'provider_disabled' };

export const DATA_POLICY_VERSION = 'ai-data-policy-v2:verified-providers';

/** Proveedores con cargo propio que cuentan para el techo de IA generativa (DEC-0068). */
export const PAID_PROVIDER_KINDS = ['anthropic', 'openai', 'openrouter'] as const;

export async function checkDataPolicy(pool: Pool | PoolClient, config: Pick<AppConfig, 'aiRealProviders'>, provider: ProviderRow, tenantId: string | null): Promise<PolicyDecision> {
  if (provider.status !== 'active') return { allowed: false, reason: 'provider_disabled' };
  if (provider.kind === 'simulated') return { allowed: true, dataScope: 'internal' };
  if (!config.aiRealProviders) return { allowed: false, reason: 'real_providers_disabled' };
  if (!provider.secret_ref || !process.env[provider.secret_ref]) return { allowed: false, reason: 'secret_missing' };
  if (!tenantId) return { allowed: true, dataScope: 'platform_synthetic' };
  const r = await pool.query<{ data_classification: string; status: string }>('SELECT data_classification, status FROM client WHERE client_id = $1', [tenantId]);
  const row = r.rows[0];
  if (!row || row.status !== 'active') return { allowed: false, reason: 'tenant_inactive' };
  if (row.data_classification === 'synthetic') return { allowed: true, dataScope: 'synthetic_tenant' };
  if (provider.real_data !== 'allowed') return { allowed: false, reason: 'provider_terms_unverified' };
  return { allowed: true, dataScope: 'real_tenant' };
}

/** Ámbitos de `ai_budget.scope` (CHECK de las migraciones 0025 y 0039). */
export const BUDGET_SCOPES = ['lab_total', 'platform_month', 'tenant_day', 'lab_experiment'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export function isBudgetScope(value: unknown): value is BudgetScope {
  return typeof value === 'string' && (BUDGET_SCOPES as readonly string[]).includes(value);
}

/**
 * Propósito de una invocación (FB-3): `lab` si y solo si va bajo un grant del laboratorio (la traza guarda ese mismo
 * `lab_grant_id`); si no, `operational`. Decide qué presupuesto, además de los techos globales, la limita.
 */
export type BudgetPurpose = 'operational' | 'lab';

export function budgetPurpose(labGrantId: string | null | undefined): BudgetPurpose {
  return labGrantId ? 'lab' : 'operational';
}

/**
 * Regla de cada ámbito: qué gasto cuenta, en qué ventana y si su fila es obligatoria donde aplica. `lab_total` y
 * `platform_month` (opcional) cuentan todo; `tenant_day` solo la operación de su negocio (fila propia o la por
 * defecto) y `lab_experiment` todo el laboratorio (una fila global, sin valor sembrado).
 */
export const SCOPE_RULES: Readonly<Record<BudgetScope, { counts: 'all' | BudgetPurpose; window: 'accumulated' | 'utc_month' | 'utc_day'; required: boolean }>> = {
  lab_total: { counts: 'all', window: 'accumulated', required: true },
  platform_month: { counts: 'all', window: 'utc_month', required: false },
  tenant_day: { counts: 'operational', window: 'utc_day', required: true },
  lab_experiment: { counts: 'lab', window: 'utc_day', required: true },
};

/** Ámbitos que limitan una invocación: los globales siempre; `tenant_day` solo en la operación de un negocio. */
export function applicableScopes(tenantId: string | null, purpose: BudgetPurpose): BudgetScope[] {
  return BUDGET_SCOPES.filter((scope) => {
    const counts = SCOPE_RULES[scope].counts;
    return counts === 'all' || (counts === purpose && (scope !== 'tenant_day' || tenantId !== null));
  });
}

const PAID_KINDS_SQL = PAID_PROVIDER_KINDS.map((kind) => `'${kind}'`).join(',');
/** Costo efectivo de una invocación de pago: la reserva mientras sigue en curso; después, su costo (o la reserva si se desconoce). */
const EFFECTIVE_COST_SQL = `CASE WHEN i.status = 'running' THEN i.reserved_usd ELSE COALESCE(i.cost_usd, i.reserved_usd) END`;
const PAID_FROM_SQL = 'ai_invocation i JOIN ai_provider p ON p.provider_id = i.provider_id';
const PAID_WHERE_SQL = `p.kind IN (${PAID_KINDS_SQL}) AND i.status IN ('running','succeeded','failed')`;

/** Gasto efectivo: costo (reportado o estimado) de lo terminado + reserva de lo que sigue en curso, de proveedores de pago. */
export const SPENT_SQL = `SELECT COALESCE(SUM(${EFFECTIVE_COST_SQL}), 0) AS spent
  FROM ${PAID_FROM_SQL}
 WHERE ${PAID_WHERE_SQL}`;

/** Inicio del día y del mes en UTC (como el tope de TypeSafe, DEC-0032): ventanas de los ámbitos periódicos y de los informes. */
export const UTC_DAY_START_SQL = `(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
export const UTC_MONTH_START_SQL = `(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
/** Propósito sobre `ai_invocation i`: la misma regla que `budgetPurpose`. */
export const LAB_PURPOSE_SQL = 'i.lab_grant_id IS NOT NULL';
const OPERATIONAL_PURPOSE_SQL = 'i.lab_grant_id IS NULL';

function scopeFilters(tenantSql: string): Readonly<Record<BudgetScope, string>> {
  return {
    lab_total: 'true',
    platform_month: `i.created_at >= ${UTC_MONTH_START_SQL}`,
    tenant_day: `${tenantSql} AND ${OPERATIONAL_PURPOSE_SQL} AND i.created_at >= ${UTC_DAY_START_SQL}`,
    lab_experiment: `${LAB_PURPOSE_SQL} AND i.created_at >= ${UTC_DAY_START_SQL}`,
  };
}

/**
 * Predicado exacto del gasto de cada ámbito, sobre `ai_invocation i` y además de los de SPENT_SQL (`$1`: el negocio de
 * `tenant_day`). La reserva, el panel y los informes de plataforma usan estos mismos predicados.
 */
export const SCOPE_SPENT_FILTER = scopeFilters('i.tenant_id = $1');
/** Los mismos predicados con `tenant_day` sumado sobre todos los negocios (informe de plataforma). */
const ALL_TENANTS_SPENT_FILTER = scopeFilters('i.tenant_id IS NOT NULL');

/** Gasto de los cuatro ámbitos en una sola lectura del libro (el candado de la reserva se retiene el menor tiempo). */
function scopeSpentSql(filters: Readonly<Record<BudgetScope, string>>): string {
  return `SELECT ${BUDGET_SCOPES.map((scope) => `COALESCE(SUM(${EFFECTIVE_COST_SQL}) FILTER (WHERE ${filters[scope]}), 0) AS ${scope}`).join(',\n       ')}
  FROM ${PAID_FROM_SQL}
 WHERE ${PAID_WHERE_SQL}`;
}
const SCOPE_SPENT_SQL = scopeSpentSql(SCOPE_SPENT_FILTER);
const ALL_TENANTS_SPENT_SQL = scopeSpentSql(ALL_TENANTS_SPENT_FILTER);

/** Estado de un ámbito: límite, gasto con el predicado de la reserva y margen. */
export interface BudgetScopeStatus {
  scope: BudgetScope;
  counts: 'all' | BudgetPurpose;
  window: 'accumulated' | 'utc_month' | 'utc_day';
  /** Límite de la fila aplicada; null si falta. */
  limit_usd: number | null;
  spent_usd: number;
  /** `limit_usd − spent_usd` (negativo si un costo real superó lo reservado); null sin fila o si el margen es por negocio. */
  remaining_usd: number | null;
  /** Sin fila: si el ámbito es obligatorio, se deniega toda reserva de pago que lo requiera (fail-closed). */
  missing: boolean;
  required: boolean;
}

function usd(value: string | number): number {
  return Math.round(Number(value) * 1e6) / 1e6;
}

function statusOf(scope: BudgetScope, limit: string | null | undefined, spent: string | number): BudgetScopeStatus {
  const rule = SCOPE_RULES[scope];
  const limitUsd = limit === null || limit === undefined ? null : Number(limit);
  const spentUsd = usd(spent);
  return {
    scope, counts: rule.counts, window: rule.window, limit_usd: limitUsd, spent_usd: spentUsd,
    remaining_usd: limitUsd === null ? null : usd(limitUsd - spentUsd), missing: limitUsd === null, required: rule.required,
  };
}

/**
 * Ámbitos que limitan una invocación y su estado, con los predicados de la reserva. Los techos globales solo cuentan
 * con su fila global (`tenant_id` nulo): una fila de un negocio nunca hace de techo de toda la plataforma. El diario
 * prefiere la fila del negocio y, si no hay, la por defecto.
 */
export async function budgetStatus(db: Pool | PoolClient, input: { tenantId: string | null; purpose: BudgetPurpose }): Promise<BudgetScopeStatus[]> {
  const rows = (await db.query<{ scope: BudgetScope; tenant_id: string | null; limit_usd: string }>(
    `SELECT scope, tenant_id, limit_usd FROM ai_budget
      WHERE (scope IN ('lab_total','platform_month','lab_experiment') AND tenant_id IS NULL)
         OR (scope = 'tenant_day' AND (tenant_id = $1 OR tenant_id IS NULL))`, [input.tenantId])).rows;
  const spent = (await db.query<Record<BudgetScope, string>>(SCOPE_SPENT_SQL, [input.tenantId])).rows[0];
  return applicableScopes(input.tenantId, input.purpose).map((scope) => {
    const candidates = rows.filter((r) => r.scope === scope);
    return statusOf(scope, (candidates.find((r) => r.tenant_id !== null) ?? candidates[0])?.limit_usd, spent?.[scope] ?? 0);
  });
}

export type BudgetDecision =
  | { allowed: true; status: BudgetScopeStatus[] }
  | { allowed: false; status: BudgetScopeStatus[]; exceeded: BudgetScope };

/**
 * Comprueba y deja el candado tomado: el llamador inserta la invocación `running` con `reserved_usd` en la MISMA
 * transacción, de modo que reservas concurrentes (de operación y de laboratorio) nunca superan ningún techo.
 *
 * Sin techo no hay gasto (NFR-0006; DEC-0077 R4/R5; FB-3): si falta la fila de un ámbito obligatorio para la
 * invocación (`lab_total` siempre; el `tenant_day` del negocio en operación; `lab_experiment` en laboratorio), la
 * reserva se deniega con ese ámbito. Ninguna migración crea esas filas (`ensureAiCatalog` siembra `lab_total` y el
 * `tenant_day` por defecto; `lab_experiment` solo lo fija un platform_admin): una base sin ellas no gasta nada.
 */
export async function reserveBudget(client: PoolClient, input: { tenantId: string | null; purpose: BudgetPurpose; reserveUsd: number }): Promise<BudgetDecision> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('ai_budget_reservation'))`);
  const status = await budgetStatus(client, input);
  const missing = status.find((s) => s.required && s.missing);
  if (missing) return { allowed: false, status, exceeded: missing.scope };
  const exceeded = status.find((s) => s.limit_usd !== null && s.spent_usd + input.reserveUsd > s.limit_usd + 1e-9);
  return exceeded ? { allowed: false, status, exceeded: exceeded.scope } : { allowed: true, status };
}

/**
 * Presupuesto experimental visto desde el panel de un negocio con grant vigente: el límite es la fila global
 * (configuración de plataforma) y el gasto, solo el de laboratorio de ESE negocio hoy (UTC); nunca el de otros.
 */
export async function tenantLabBudget(db: Pool | PoolClient, tenantId: string): Promise<{ scope: 'lab_experiment'; limit_usd: number | null; missing: boolean; spent_usd: number }> {
  const r = await db.query<{ limit_usd: string | null; spent: string }>(
    `SELECT (SELECT limit_usd FROM ai_budget WHERE scope = 'lab_experiment' AND tenant_id IS NULL) AS limit_usd,
            (${SPENT_SQL} AND i.tenant_id = $1 AND ${SCOPE_SPENT_FILTER.lab_experiment}) AS spent`, [tenantId]);
  const limit = r.rows[0]?.limit_usd ?? null;
  return { scope: 'lab_experiment', limit_usd: limit === null ? null : Number(limit), missing: limit === null, spent_usd: usd(r.rows[0]?.spent ?? 0) };
}

/**
 * Todos los ámbitos para la consola de plataforma, con su gasto y margen; en `tenant_day`, la fila por defecto y el
 * gasto operativo de hoy de todos los negocios, sin margen (es por negocio: `tenantDayStatus`).
 */
export async function platformBudgetStatus(db: Pool | PoolClient): Promise<BudgetScopeStatus[]> {
  const rows = (await db.query<{ scope: BudgetScope; limit_usd: string }>('SELECT scope, limit_usd FROM ai_budget WHERE tenant_id IS NULL')).rows;
  const spent = (await db.query<Record<BudgetScope, string>>(ALL_TENANTS_SPENT_SQL)).rows[0];
  return BUDGET_SCOPES.map((scope) => {
    const status = statusOf(scope, rows.find((r) => r.scope === scope)?.limit_usd, spent?.[scope] ?? 0);
    return scope === 'tenant_day' ? { ...status, remaining_usd: null } : status;
  });
}

export interface TenantDayStatus { tenant_id: string; limit_usd: number | null; own_limit: boolean; spent_usd: number; remaining_usd: number | null; missing: boolean }

/** `tenant_day` por negocio: los que tienen fila propia o gasto operativo hoy (hasta 200, de mayor a menor gasto). */
export async function tenantDayStatus(db: Pool | PoolClient): Promise<TenantDayStatus[]> {
  const tenants = await db.query<{ tenant_id: string; spent: string; own_limit: string | null; default_limit: string | null }>(
    `SELECT COALESCE(s.tenant_id, o.tenant_id) AS tenant_id, COALESCE(s.spent, 0) AS spent, o.limit_usd AS own_limit,
            (SELECT limit_usd FROM ai_budget WHERE scope = 'tenant_day' AND tenant_id IS NULL) AS default_limit
       FROM (SELECT i.tenant_id, SUM(${EFFECTIVE_COST_SQL}) AS spent FROM ${PAID_FROM_SQL}
              WHERE ${PAID_WHERE_SQL} AND ${ALL_TENANTS_SPENT_FILTER.tenant_day} GROUP BY i.tenant_id) s
       FULL JOIN (SELECT tenant_id, limit_usd FROM ai_budget WHERE scope = 'tenant_day' AND tenant_id IS NOT NULL) o ON o.tenant_id = s.tenant_id
      ORDER BY 2 DESC, 1 LIMIT 200`);
  return tenants.rows.map((t) => {
    const status = statusOf('tenant_day', t.own_limit ?? t.default_limit, t.spent);
    return { tenant_id: t.tenant_id, limit_usd: status.limit_usd, own_limit: t.own_limit !== null, spent_usd: status.spent_usd, remaining_usd: status.remaining_usd, missing: status.missing };
  });
}

/** Gasto de pago de un grupo (propósito × canal × caso de uso, o subtotal: los campos agregados quedan en null). */
export interface SpendLine {
  purpose: BudgetPurpose | null; channel: AiChannel | null; use_case_id: string | null;
  calls_today: number; calls_month: number; calls_total: number; today_usd: number; month_usd: number; total_usd: number;
}
export interface SpendBreakdown { by_use_case: SpendLine[]; by_channel: SpendLine[]; by_purpose: SpendLine[]; total: SpendLine }

/**
 * Gasto de pago atribuido (FB-3) por propósito × canal × caso de uso, hoy y este mes (UTC) y acumulado, con subtotales
 * por propósito y canal, por propósito y el total (= gasto de `lab_total`). Mismo costo efectivo que la reserva y
 * una sola lectura del libro: cada invocación cuenta una vez. Atribuye; no impone límites por canal.
 */
export async function spendBreakdown(db: Pool | PoolClient): Promise<SpendBreakdown> {
  const r = await db.query<{ purpose: BudgetPurpose | null; channel: AiChannel | null; use_case_id: string | null; level: number; calls_today: string; calls_month: string; calls_total: string; today_usd: string; month_usd: string; total_usd: string }>(
    `WITH paid AS (
       SELECT CASE WHEN ${LAB_PURPOSE_SQL} THEN 'lab' ELSE 'operational' END AS purpose, uc.channel, i.use_case_id, ${EFFECTIVE_COST_SQL} AS usd,
              i.created_at >= ${UTC_DAY_START_SQL} AS today, i.created_at >= ${UTC_MONTH_START_SQL} AS this_month
         FROM ${PAID_FROM_SQL} JOIN ai_use_case uc ON uc.use_case_id = i.use_case_id
        WHERE ${PAID_WHERE_SQL})
     SELECT purpose, channel, use_case_id, GROUPING(purpose, channel, use_case_id) AS level,
            count(*) FILTER (WHERE today) AS calls_today, count(*) FILTER (WHERE this_month) AS calls_month, count(*) AS calls_total,
            COALESCE(SUM(usd) FILTER (WHERE today), 0) AS today_usd, COALESCE(SUM(usd) FILTER (WHERE this_month), 0) AS month_usd, COALESCE(SUM(usd), 0) AS total_usd
       FROM paid
      GROUP BY GROUPING SETS ((purpose, channel, use_case_id), (purpose, channel), (purpose), ())
      ORDER BY level, purpose, channel, use_case_id`);
  const at = (level: number): SpendLine[] => r.rows.filter((x) => Number(x.level) === level).map((x) => ({
    purpose: x.purpose, channel: x.channel, use_case_id: x.use_case_id, calls_today: Number(x.calls_today), calls_month: Number(x.calls_month),
    calls_total: Number(x.calls_total), today_usd: usd(x.today_usd), month_usd: usd(x.month_usd), total_usd: usd(x.total_usd),
  }));
  const empty: SpendLine = { purpose: null, channel: null, use_case_id: null, calls_today: 0, calls_month: 0, calls_total: 0, today_usd: 0, month_usd: 0, total_usd: 0 };
  return { by_use_case: at(0), by_channel: at(1), by_purpose: at(3), total: at(7)[0] ?? empty };
}

/** Costo estimado con el precio publicado guardado en el modelo (USD por millón de tokens / por imagen). */
export function estimateCost(pricing: Record<string, number>, usage: { inputTokens: number; outputTokens: number; images: number }): number | null {
  const inp = pricing['input_per_mtok'];
  const out = pricing['output_per_mtok'];
  const img = pricing['per_image'];
  if (inp === undefined && out === undefined && img === undefined) return null;
  return ((inp ?? 0) * usage.inputTokens + (out ?? 0) * usage.outputTokens) / 1_000_000 + (img ?? 0) * usage.images;
}
