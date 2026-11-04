/**
 * QuotaLedger — comprobación y consumo de cuota ATÓMICOS por tenant (DEC-0005,
 * TOCTOU) con auditoría en la misma transacción (NFR-0001, DEC-0014).
 *
 * Invariante: el uso de (tenant, capacidad) se lee y se consume bajo un candado
 * transaccional `pg_advisory_xact_lock` de esa pareja. Dos operaciones
 * concurrentes del mismo tenant y capacidad se serializan y nunca superan el
 * límite; otros tenants no comparten candado ni filas.
 *
 * Límite = valor de la revisión de plan FIJADA en la suscripción (src/plans/policy.ts), acotado por
 * el techo de sistema del registro (src/plans/registry.ts). Uso según la semántica del parámetro:
 *  - cumulative / stock: filas de dominio del tenant (SQL del registro) + reservas vigentes;
 *  - periodic: unidades confirmadas en el ciclo mensual de la suscripción (UTC) + reservas vigentes;
 *  - rate_window: unidades confirmadas en la ventana móvil + reservas vigentes;
 *  - eligibility: sin uso; `assertEligible` comprueba que el plan la incluye.
 * Hoy solo existen parámetros `cumulative` (SRC-0013); las demás semánticas son mecanismo probado.
 *
 * Dos formas de consumir:
 *  - En un paso (`consumeInTx`), dentro de la transacción que crea el recurso:
 *    candado, comprobación, creación, fila `committed` y evento `quota.consumed`
 *    se confirman o se revierten juntos.
 *  - En dos pasos (`reserve` → `commitInTx` | `release`), cuando entre la
 *    comprobación y la creación hay trabajo externo (la clasificación Jev). La
 *    reserva aparta las unidades durante QUOTA_RESERVATION_TTL_MS; si nunca se
 *    confirma (caída a mitad), deja de contar al vencer y `reconcile` la cierra
 *    como `expired`.
 *
 * Idempotencia: (tenant, capacidad, idempotency_key) es único. Repetir la clave
 * de un consumo confirmado devuelve `replay` con su recurso, sin consumir otra
 * vez; repetirla mientras la primera sigue en curso ⇒ 409 request_in_progress;
 * tras un fallo (released/expired) la misma clave puede reintentarse.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import {
  DEFAULT_DEFINITIONS,
  effectiveValue,
  fitsLimit,
  limitExceededMessage,
  loadPinnedPolicy,
  missingParameterMessage,
  monthlyCycle,
  notInPlanMessage,
  resolveEffectivePolicy,
  type EffectivePolicy,
} from '../plans/policy.ts';
import type { CapabilityName, PlanParameterDefinition } from '../plans/registry.ts';

/** Vigencia de una reserva en dos pasos: cubre la llamada a Jev (10 s) con margen. */
export const QUOTA_RESERVATION_TTL_MS = 120_000;
/** Mismo patrón que el CHECK de `quota_reservation.idempotency_key`. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** Actor de los eventos que escribe la reconciliación. */
export const QUOTA_RECONCILER_ACTOR = 'system:quota-reconciler';

export type QuotaState = 'reserved' | 'committed' | 'released' | 'expired';

export interface QuotaReservationRow {
  reservation_id: string;
  tenant_id: string;
  capability: CapabilityName;
  units: number;
  idempotency_key: string;
  request_id: string;
  actor_id: string;
  state: QuotaState;
  resource_ref: string | null;
  created_at: string;
  expires_at: string;
  settled_at: string | null;
}

export interface QuotaRequest {
  tenantId: string;
  capability: CapabilityName;
  units: number;
  idempotencyKey: string;
  requestId: string;
  actorId: string;
  actorRole: string | null;
}

/** `replay`: la clave ya consumió antes; el llamador responde con `resource_ref` sin crear nada. */
export type QuotaClaim =
  | { kind: 'reserved'; reservation: QuotaReservationRow }
  | { kind: 'replay'; reservation: QuotaReservationRow };

export interface QuotaReconcileReport {
  expired: Array<Pick<QuotaReservationRow, 'reservation_id' | 'tenant_id' | 'capability' | 'units'>>;
  /** Uso por encima del límite de la revisión fijada (p. ej. tras un downgrade), solo de parámetros que se aplican: informe, nunca borra. */
  overLimit: Array<{ tenant_id: string; capability: string; usage: number; max: number }>;
}

/** Uso y límite efectivos de una capacidad, con la misma cuenta que aplica el enforcement. */
export interface CapacityStatus {
  capability: string;
  parameter_key: string;
  limit: number | null;
  usage: number;
  capped_by_system: boolean;
  window: { start: string; end: string } | null;
}

/**
 * Clave de idempotencia de una operación: la cabecera `Idempotency-Key` si llega
 * (validada) o el request_id, que es único por petición (sin deduplicación).
 */
export function resolveIdempotencyKey(header: string | undefined, requestId: string): string {
  if (header === undefined || header === '') return requestId;
  if (!IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new AppError(400, 'validation_error',
      'La cabecera Idempotency-Key no es válida: usa de 1 a 128 letras, números o los signos . _ : -');
  }
  return header;
}

/** Id del recurso de una reserva confirmada (`resource_ref` = `<tabla>/<id>`). */
export function resourceIdOf(resourceRef: string | null): string {
  const id = resourceRef?.split('/')[1];
  if (!id) throw new Error(`FAIL-CLOSED: malformed quota resource_ref ${String(resourceRef)}`);
  return id;
}

const inProgress = () => new AppError(409, DENY_CODES.REQUEST_IN_PROGRESS,
  'Esta solicitud ya se está procesando. Espera un momento y consulta el resultado antes de repetirla.');

export interface QuotaLedgerDeps {
  pool: Pool;
  sink: AuditSink;
  reservationTtlMs?: number;
  /** Registro de parámetros (por defecto, el del producto). Los tests del mecanismo inyectan otro. */
  definitions?: readonly PlanParameterDefinition[];
}

export class QuotaLedger {
  private readonly deps: QuotaLedgerDeps;

  constructor(deps: QuotaLedgerDeps) {
    this.deps = deps;
  }

  private get ttlMs(): number {
    return this.deps.reservationTtlMs ?? QUOTA_RESERVATION_TTL_MS;
  }

  private get definitions(): readonly PlanParameterDefinition[] {
    return this.deps.definitions ?? DEFAULT_DEFINITIONS;
  }

  /** Definición con libro de cuotas de la capacidad; 400 si no existe (nada fuera del registro cuenta). */
  private quotaDefinition(capability: string): PlanParameterDefinition {
    const def = this.definitions.find((d) => d.capability === capability && d.semantics !== 'eligibility');
    if (!def) throw new AppError(400, 'validation_error', 'La capacidad consultada no está definida en el catálogo de límites.');
    return def;
  }

  private assertValidRequest(req: QuotaRequest): void {
    if (!req.tenantId || !req.actorId || !req.requestId) {
      throw new Error('FAIL-CLOSED: quota requires tenant, actor and request ids');
    }
    this.quotaDefinition(req.capability);
    if (!Number.isInteger(req.units) || req.units < 1) throw new Error('FAIL-CLOSED: quota units must be a positive integer');
    if (!IDEMPOTENCY_KEY_PATTERN.test(req.idempotencyKey)) throw new Error('FAIL-CLOSED: invalid idempotency key');
  }

  /** Candado de (tenant, capacidad) hasta el final de la transacción de `client`. */
  async lock(client: PoolClient, tenantId: string, capability: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`quota:${tenantId}:${capability}`]);
  }

  /**
   * Unidades de las reservas vigentes del tenant por capacidad, en UNA consulta (reloj de la BD);
   * `capability` la acota a esa capacidad (comprobación bajo su candado).
   */
  private async liveReservations(db: Pool | PoolClient, tenantId: string, capability: string | null = null): Promise<ReadonlyMap<string, number>> {
    const r = await db.query<{ capability: string; n: string }>(
      `SELECT capability, SUM(units)::text AS n FROM quota_reservation
        WHERE tenant_id = $1 AND state = 'reserved' AND expires_at > clock_timestamp() AND ($2::text IS NULL OR capability = $2)
        GROUP BY capability`,
      [tenantId, capability]);
    return new Map(r.rows.map((row) => [row.capability, Number(row.n)]));
  }

  /** Uso de la capacidad según su semántica, más `live` (sus reservas vigentes), con el reloj de la BD. */
  private async usage(db: Pool | PoolClient, policy: EffectivePolicy, def: PlanParameterDefinition, live: number): Promise<{ usage: number; window: { start: Date; end: Date } | null }> {
    const tenantId = policy.subscription.tenant_id;
    if (def.semantics === 'cumulative' || def.semantics === 'stock') {
      if (!def.usageSql) throw new Error(`FAIL-CLOSED: parameter ${def.key} has no usage query`);
      const r = await db.query<{ n: string }>(def.usageSql, [tenantId]);
      return { usage: Number(r.rows[0]?.n ?? 0) + live, window: null };
    }
    const now = (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now ?? new Date();
    let window: { start: Date; end: Date | null };
    if (def.semantics === 'periodic') window = monthlyCycle(new Date(policy.subscription.started_at), now);
    else if (def.period.kind === 'sliding_window') window = { start: new Date(now.getTime() - def.period.seconds * 1000), end: null };
    else throw new Error(`FAIL-CLOSED: parameter ${def.key} has no countable usage`);
    const committed = await db.query<{ n: string }>(
      `SELECT COALESCE(SUM(units), 0)::text AS n FROM quota_reservation
        WHERE tenant_id = $1 AND capability = $2 AND state = 'committed'
          AND settled_at >= $3 AND ($4::timestamptz IS NULL OR settled_at < $4)`,
      [tenantId, def.capability, window.start, window.end]);
    return { usage: Number(committed.rows[0]?.n ?? 0) + live, window: { start: window.start, end: window.end ?? now } };
  }

  /**
   * Con el candado tomado: falla si el tenant no tiene suscripción activa
   * (subscription_required) o si `units` no caben en el límite (limit_exceeded).
   * Un parámetro ausente en la revisión fijada también deniega (limit_exceeded, auditado por el llamador).
   */
  async assertCapacity(client: PoolClient, tenantId: string, capability: string, units: number): Promise<void> {
    const def = this.quotaDefinition(capability);
    const policy = await resolveEffectivePolicy(client, tenantId);
    const limit = effectiveValue(policy, def);
    if (!limit || typeof limit.value !== 'number') {
      // `parameter`, no `parameter_key`: el logger rechaza (lanza) cualquier campo terminado en `_key`.
      log.error('quota.parameter_missing', 'pinned plan revision does not define the parameter', {
        tenant_id: tenantId, parameter: def.key, revision_id: policy.revision.revision_id,
      });
      throw new AppError(403, DENY_CODES.LIMIT_EXCEEDED, missingParameterMessage(def));
    }
    const live = (await this.liveReservations(client, tenantId, capability)).get(capability) ?? 0;
    const { usage } = await this.usage(client, policy, def, live);
    if (!fitsLimit(limit.value, usage, units)) {
      throw new AppError(403, DENY_CODES.LIMIT_EXCEEDED, limitExceededMessage(def, usage, limit.value));
    }
  }

  /**
   * Elegibilidad (semántica `eligibility`): el plan incluye la función. Sin suscripción ⇒
   * subscription_required; valor ausente o `false` ⇒ 403 prohibited. No consume nada.
   */
  async assertEligible(db: Pool | PoolClient, tenantId: string, parameterKey: string): Promise<void> {
    const def = this.definitions.find((d) => d.key === parameterKey && d.semantics === 'eligibility');
    if (!def) throw new Error(`FAIL-CLOSED: ${parameterKey} is not an eligibility parameter`);
    const policy = await resolveEffectivePolicy(db, tenantId);
    const value = effectiveValue(policy, def);
    if (!value) throw new AppError(403, DENY_CODES.PROHIBITED, missingParameterMessage(def));
    if (value.value !== true) throw new AppError(403, DENY_CODES.PROHIBITED, notInPlanMessage(def));
  }

  /** Límite y uso efectivos de cada capacidad del tenant (lectura para paneles y consolas). */
  async capacityStatus(db: Pool | PoolClient, policy: EffectivePolicy): Promise<CapacityStatus[]> {
    const out: CapacityStatus[] = [];
    const live = await this.liveReservations(db, policy.subscription.tenant_id);
    for (const def of this.definitions) {
      if (!def.capability || def.semantics === 'eligibility') continue;
      const limit = effectiveValue(policy, def);
      const { usage, window } = await this.usage(db, policy, def, live.get(def.capability) ?? 0);
      out.push({
        capability: def.capability, parameter_key: def.key, limit: typeof limit?.value === 'number' ? limit.value : null,
        usage, capped_by_system: limit?.cappedBySystem ?? false,
        window: window ? { start: window.start.toISOString(), end: window.end.toISOString() } : null,
      });
    }
    return out;
  }

  /**
   * Consumo en un paso dentro de la transacción del llamador (que debe ser la que
   * crea el recurso). `create` corre con el candado tomado y la capacidad ya
   * comprobada; si lanza, el llamador revierte todo y no queda consumo.
   */
  async consumeInTx<T>(
    client: PoolClient,
    req: QuotaRequest,
    create: () => Promise<{ resourceRef: string; value: T }>,
  ): Promise<{ kind: 'replay'; reservation: QuotaReservationRow } | { kind: 'consumed'; reservation: QuotaReservationRow; value: T }> {
    this.assertValidRequest(req);
    await this.lock(client, req.tenantId, req.capability);
    const existing = await this.findByKey(client, req);
    if (existing?.state === 'committed') return { kind: 'replay', reservation: existing };
    if (existing?.live) throw inProgress();
    await this.assertCapacity(client, req.tenantId, req.capability, req.units);
    const { resourceRef, value } = await create();
    const reservation = await this.upsert(client, req, 'committed', resourceRef);
    await this.audit(client, reservation, req.actorRole, 'quota.consumed', req.requestId);
    return { kind: 'consumed', reservation, value };
  }

  /** Paso 1 de 2: aparta `units` en su propia transacción (con su evento `quota.reserved`). */
  async reserve(req: QuotaRequest): Promise<QuotaClaim> {
    this.assertValidRequest(req);
    return runAtomic(this.deps.pool, async (client) => {
      await this.lock(client, req.tenantId, req.capability);
      const existing = await this.findByKey(client, req);
      if (existing?.state === 'committed') return { kind: 'replay', reservation: existing };
      if (existing?.live) throw inProgress();
      await this.assertCapacity(client, req.tenantId, req.capability, req.units);
      const reservation = await this.upsert(client, req, 'reserved', null);
      await this.audit(client, reservation, req.actorRole, 'quota.reserved', req.requestId);
      return { kind: 'reserved', reservation };
    });
  }

  /**
   * Paso 2 de 2: confirma la reserva dentro de la transacción que persiste el
   * recurso. Si venció o ya no está reservada, falla y esa transacción se revierte.
   */
  async commitInTx(client: PoolClient, reservation: QuotaReservationRow, resourceRef: string, actorRole: string | null): Promise<QuotaReservationRow> {
    const res = await client.query<QuotaReservationRow>(
      `UPDATE quota_reservation SET state = 'committed', resource_ref = $3, settled_at = clock_timestamp()
        WHERE reservation_id = $1 AND tenant_id = $2 AND state = 'reserved' AND expires_at > clock_timestamp()
        RETURNING *`,
      [reservation.reservation_id, reservation.tenant_id, resourceRef]);
    const committed = res.rows[0];
    if (!committed) {
      throw new AppError(409, DENY_CODES.QUOTA_RESERVATION_EXPIRED,
        'La operación tardó demasiado y su reserva de cuota venció. Inténtalo de nuevo.');
    }
    await this.audit(client, committed, actorRole, 'quota.consumed', committed.request_id);
    return committed;
  }

  /**
   * Devuelve las unidades de una reserva que no llegó a confirmarse. Nunca enmascara
   * el error original del llamador: si no puede escribir, lo registra y la reserva
   * vence sola (la cierra `reconcile`).
   */
  async release(reservation: QuotaReservationRow, actorRole: string | null, reason: string): Promise<boolean> {
    try {
      return await runAtomic(this.deps.pool, async (client) => {
        const res = await client.query<QuotaReservationRow>(
          `UPDATE quota_reservation SET state = 'released', settled_at = clock_timestamp()
            WHERE reservation_id = $1 AND tenant_id = $2 AND state = 'reserved' RETURNING *`,
          [reservation.reservation_id, reservation.tenant_id]);
        const released = res.rows[0];
        if (!released) return false;
        await this.audit(client, released, actorRole, 'quota.released', released.request_id, reason);
        return true;
      });
    } catch (err) {
      log.warn('quota.release.failed', 'quota reservation not released; it will expire', {
        reservation_id: reservation.reservation_id, tenant_id: reservation.tenant_id, error_name: err instanceof Error ? err.name : 'unknown',
      });
      return false;
    }
  }

  /**
   * Reconciliación: cierra como `expired` las reservas vencidas (con su evento, en una transacción) e
   * informa del uso por encima del límite de la revisión fijada en los parámetros que se aplican.
   */
  async reconcile(): Promise<QuotaReconcileReport> {
    const runId = `quota_reconcile_${randomUUID()}`;
    const expired = await runAtomic(this.deps.pool, async (client) => {
      const res = await client.query<QuotaReservationRow>(
        `UPDATE quota_reservation SET state = 'expired', settled_at = clock_timestamp()
          WHERE state = 'reserved' AND expires_at <= clock_timestamp() RETURNING *`);
      for (const row of res.rows) {
        await this.deps.sink.write({
          tenant_id: row.tenant_id, actor_id: QUOTA_RECONCILER_ACTOR, actor_role: null,
          action: 'quota.expired', resource: `quota_reservation/${row.reservation_id}`,
          request_id: runId, decision: 'allow', result: `${row.capability}:${row.units}`, evidence_ref: row.request_id,
        }, client);
      }
      return res.rows;
    });
    const tenants = await this.deps.pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM subscription WHERE status = 'active' ORDER BY tenant_id`);
    // Un parámetro que no se aplica (`agents`, DEC-0006/DEC-0017) no es un exceso que reportar.
    const enforced = new Set(this.definitions.filter((d) => d.enforcement.state === 'enforced').map((d) => d.key));
    const overLimit: QuotaReconcileReport['overLimit'] = [];
    for (const { tenant_id: tenantId } of tenants.rows) {
      const policy = await loadPinnedPolicy(this.deps.pool, tenantId);
      if (!policy) continue;
      for (const s of await this.capacityStatus(this.deps.pool, policy)) {
        if (enforced.has(s.parameter_key) && s.limit !== null && s.window === null && s.usage > s.limit) {
          overLimit.push({ tenant_id: tenantId, capability: s.capability, usage: s.usage, max: s.limit });
        }
      }
    }
    const report: QuotaReconcileReport = {
      expired: expired.map((r) => ({ reservation_id: r.reservation_id, tenant_id: r.tenant_id, capability: r.capability, units: r.units })),
      overLimit,
    };
    if (report.expired.length > 0 || report.overLimit.length > 0) {
      log.info('quota.reconciled', 'quota reconciliation', { run_id: runId, expired: report.expired.length, over_limit: report.overLimit.length });
    }
    return report;
  }

  /** Fila de la clave; `live` = reserva en curso según el reloj de la BD (no el del proceso). */
  private async findByKey(client: PoolClient, req: QuotaRequest): Promise<(QuotaReservationRow & { live: boolean }) | null> {
    const res = await client.query<QuotaReservationRow & { live: boolean }>(
      `SELECT *, (state = 'reserved' AND expires_at > clock_timestamp()) AS live
         FROM quota_reservation WHERE tenant_id = $1 AND capability = $2 AND idempotency_key = $3`,
      [req.tenantId, req.capability, req.idempotencyKey]);
    return res.rows[0] ?? null;
  }

  /** Inserta la fila de la clave, o reutiliza la de un intento fallido (released/expired/vencida). */
  private async upsert(client: PoolClient, req: QuotaRequest, state: 'reserved' | 'committed', resourceRef: string | null): Promise<QuotaReservationRow> {
    const res = await client.query<QuotaReservationRow>(
      `INSERT INTO quota_reservation
         (reservation_id, tenant_id, capability, units, idempotency_key, request_id, actor_id, state, resource_ref, expires_at, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               clock_timestamp() + ($10::int * interval '1 millisecond'),
               CASE WHEN $8::text = 'reserved' THEN NULL ELSE clock_timestamp() END)
       ON CONFLICT (tenant_id, capability, idempotency_key) DO UPDATE SET
         units = EXCLUDED.units, request_id = EXCLUDED.request_id, actor_id = EXCLUDED.actor_id,
         state = EXCLUDED.state, resource_ref = EXCLUDED.resource_ref, created_at = clock_timestamp(),
         expires_at = EXCLUDED.expires_at, settled_at = EXCLUDED.settled_at
       RETURNING *`,
      [`qres_${randomUUID()}`, req.tenantId, req.capability, req.units, req.idempotencyKey, req.requestId, req.actorId,
        state, resourceRef, state === 'reserved' ? this.ttlMs : 0]);
    return res.rows[0] as QuotaReservationRow;
  }

  private async audit(
    client: PoolClient, row: QuotaReservationRow, actorRole: string | null,
    action: 'quota.reserved' | 'quota.consumed' | 'quota.released', requestId: string, reason?: string,
  ): Promise<void> {
    await this.deps.sink.write({
      tenant_id: row.tenant_id, actor_id: row.actor_id, actor_role: actorRole,
      action, resource: `quota_reservation/${row.reservation_id}`, request_id: requestId,
      decision: 'allow', result: `${row.capability}:${row.units}${reason ? `:${reason}` : ''}`,
      evidence_ref: row.resource_ref,
    }, client);
  }
}
