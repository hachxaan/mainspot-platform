/**
 * Política efectiva de un negocio (FR-0010, DEC-0075): suscripción activa → revisión FIJADA en la
 * suscripción → valor explícito del parámetro → acotado por el techo de sistema del registro.
 *
 * Fail-closed: sin suscripción activa ⇒ 403 `subscription_required`; revisión inexistente o no publicada
 * ⇒ 403 `subscription_required` (no hay condiciones válidas); valor ausente ⇒ sin concesión (el
 * llamador deniega). Nunca hay «ilimitado» ni valor por omisión implícito. Todas las consultas aceptan
 * la conexión de la transacción del llamador (se resuelve dentro del candado de cuota).
 */

import type { Pool, PoolClient } from 'pg';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import { PLAN_PARAMETERS, periodLabel, type ParameterValue, type PlanParameterDefinition } from './registry.ts';

export const SUBSCRIPTION_REQUIRED_MESSAGE =
  'Este cliente no tiene un plan activo. Consulta con el administrador del plan de MainSpot.';

export type SubscriptionStatus = 'active' | 'suspended' | 'cancelled';

export interface PolicySubscription {
  subscription_id: string;
  tenant_id: string;
  plan_id: string;
  plan_revision_id: string;
  status: SubscriptionStatus;
  started_at: Date;
  updated_at: Date;
}

export interface PolicyRevision {
  revision_id: string;
  plan_id: string;
  plan_name: string;
  version: number;
  status: 'PUBLISHED' | 'SUPERSEDED';
  checksum: string;
  published_at: Date;
}

export interface EffectiveValue {
  value: ParameterValue;
  /** El valor publicado supera el techo de sistema vigente: se aplica el techo. */
  cappedBySystem: boolean;
}

export interface EffectivePolicy {
  subscription: PolicySubscription;
  revision: PolicyRevision;
  /** Valores de la revisión fijada, por clave de parámetro (solo los presentes). */
  values: ReadonlyMap<string, ParameterValue>;
}

type Db = Pool | PoolClient;

export async function findSubscription(db: Db, tenantId: string): Promise<PolicySubscription | null> {
  const r = await db.query<PolicySubscription>(
    `SELECT subscription_id, tenant_id, plan_id, plan_revision_id, status, started_at, updated_at
       FROM subscription WHERE tenant_id = $1`, [tenantId]);
  return r.rows[0] ?? null;
}

/** Valores de una revisión: entero o booleano por clave (nulos = sin valor, solo en borradores). */
export async function revisionValues(db: Db, revisionId: string): Promise<Map<string, ParameterValue>> {
  const r = await db.query<{ parameter_key: string; value_int: number | null; value_bool: boolean | null }>(
    'SELECT parameter_key, value_int, value_bool FROM plan_parameter_value WHERE revision_id = $1', [revisionId]);
  const out = new Map<string, ParameterValue>();
  for (const row of r.rows) {
    if (row.value_int !== null) out.set(row.parameter_key, row.value_int);
    else if (row.value_bool !== null) out.set(row.parameter_key, row.value_bool);
  }
  return out;
}

/**
 * Condiciones fijadas de la suscripción del negocio, sin exigir que esté activa (vistas de solo
 * lectura). null si no hay suscripción o si su revisión no es válida (nunca cae a otra revisión).
 */
export async function loadPinnedPolicy(db: Db, tenantId: string): Promise<EffectivePolicy | null> {
  const subscription = await findSubscription(db, tenantId);
  if (!subscription) return null;
  const r = await db.query<PolicyRevision>(
    `SELECT r.revision_id, r.plan_id, p.name AS plan_name, r.version, r.status, r.checksum, r.published_at
       FROM plan_revision r JOIN plan p ON p.plan_id = r.plan_id
      WHERE r.revision_id = $1 AND r.plan_id = $2`, [subscription.plan_revision_id, subscription.plan_id]);
  const revision = r.rows[0];
  if (!revision || (revision.status !== 'PUBLISHED' && revision.status !== 'SUPERSEDED')) {
    log.error('plan.policy.invalid_revision', 'subscription pinned to a missing or unpublished revision', {
      tenant_id: tenantId, subscription_id: subscription.subscription_id, revision_id: subscription.plan_revision_id,
    });
    return null;
  }
  return { subscription, revision, values: await revisionValues(db, revision.revision_id) };
}

/**
 * Política para ACTUAR: suscripción activa con revisión fijada válida. Si no, 403 subscription_required
 * (FR-0010: las lecturas siguen permitidas; las creaciones y consumos se deniegan).
 */
export async function resolveEffectivePolicy(db: Db, tenantId: string): Promise<EffectivePolicy> {
  const policy = await loadPinnedPolicy(db, tenantId);
  if (!policy || policy.subscription.status !== 'active') {
    throw new AppError(403, DENY_CODES.SUBSCRIPTION_REQUIRED, SUBSCRIPTION_REQUIRED_MESSAGE);
  }
  return policy;
}

/**
 * Valor efectivo de un parámetro o null si la revisión no lo define (el llamador deniega). Solo el techo
 * de sistema lo acota: un valor por debajo del mínimo vigente nunca se eleva (sería una concesión que la
 * revisión no publicó).
 */
export function effectiveValue(policy: Pick<EffectivePolicy, 'values'>, def: PlanParameterDefinition): EffectiveValue | null {
  const raw = policy.values.get(def.key);
  if (raw === undefined) return null;
  if (def.valueType === 'bool') return typeof raw === 'boolean' ? { value: raw, cappedBySystem: false } : null;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  const value = Math.min(raw, def.max);
  return { value, cappedBySystem: value !== raw };
}

/** Pura: ¿caben `units` más sobre `usage` con este límite? Sin límite (null) ⇒ no (fail-closed). */
export function fitsLimit(limit: number | null, usage: number, units = 1): boolean {
  if (limit === null) return false;
  return usage + units <= limit;
}

/** Mensaje del 403 limit_exceeded: uso real, máximo, unidad y periodo del parámetro. */
export function limitExceededMessage(def: PlanParameterDefinition, usage: number, max: number): string {
  const label = def.label.charAt(0).toLowerCase() + def.label.slice(1);
  return `Se alcanzó el límite del plan para ${label}: ${usage} de ${max} ${def.unit} ${periodLabel(def)}. Para ampliarlo, consulta con el administrador del plan de MainSpot.`;
}

/** Mensaje cuando la revisión fijada no define el parámetro (deny, nunca concesión implícita). */
export function missingParameterMessage(def: PlanParameterDefinition): string {
  return `El plan de este cliente no define «${def.label}», así que esta acción no está disponible. Consulta con el administrador del plan de MainSpot.`;
}

/** Mensaje cuando la elegibilidad está desactivada en el plan. */
export function notInPlanMessage(def: PlanParameterDefinition): string {
  return `«${def.label}» no está incluido en el plan de este cliente. Consulta con el administrador del plan de MainSpot.`;
}

// ------------------------------------------------------------------ ciclos (semántica periódica)

function addMonthsClamped(anchor: Date, months: number): Date {
  const total = anchor.getUTCMonth() + months;
  const year = anchor.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(anchor.getUTCDate(), lastDay),
    anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
}

/**
 * Ciclo mensual de la suscripción que contiene `now`, en UTC: [ancla + n meses, ancla + n+1 meses).
 * El día del ancla se acota al último día del mes (31 ene → 28/29 feb → 31 mar), siempre desde el ancla
 * original, sin deriva. Un `now` anterior al ancla devuelve el primer ciclo. UTC: sin efectos de DST.
 */
export function monthlyCycle(anchor: Date, now: Date): { start: Date; end: Date } {
  let n = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  if (n < 0) n = 0;
  let start = addMonthsClamped(anchor, n);
  if (start.getTime() > now.getTime() && n > 0) {
    n -= 1;
    start = addMonthsClamped(anchor, n);
  }
  return { start, end: addMonthsClamped(anchor, n + 1) };
}

/** Definiciones por defecto (registro del producto); los tests del mecanismo inyectan otras. */
export const DEFAULT_DEFINITIONS: readonly PlanParameterDefinition[] = PLAN_PARAMETERS;
