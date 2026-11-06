/**
 * Libro de TypeSafe/Jev (DEC-0032; DEC-0078, TS-1): el tope diario GLOBAL de TypeSafe se aplica con una reserva atómica
 * e idempotente ANTES de cada llamada, nunca comprobando lo gastado y gastando después (HUECO-TS-1). Tabla durable
 * `typesafe_reservation` (migración 0040), compartida por el AI Core (rutas de clasificación con TypeSafe), el pipeline
 * del chat y la evaluación sintética. El proveedor simulado (MockJev) no gasta TypeSafe y nunca reserva.
 *
 * Ciclo de vida de una llamada:
 *  1. `reserve` — bajo `pg_advisory_xact_lock(hashtext('typesafe_budget'))` cierra primero las reservas vencidas (sin
 *     enviar ⇒ `released`; enviadas ⇒ `expired`), suma lo gastado del día UTC (reloj de la BD) y aparta el costo máximo
 *     de la llamada solo si gastado + reserva ≤ límite (función inyectada, `typesafeDailyLimitUsd`).
 *  2. `dispatched` — justo antes de la petición HTTP, bajo el mismo candado y solo con la reserva vigente: una reserva
 *     vencida sin enviar dejó de contar (su hueco pudo reutilizarse), así que ya no se envía y queda liberada.
 *  3. `commit` — respuesta válida: costo informado por el proveedor o estimado con su precio, e intentos HTTP
 *     (`measuredCost`). `failAfterDispatch` — fallo tras enviar (HTTP, tiempo agotado, red, contrato): costo
 *     desconocido, cuenta la reserva (un error del proveedor no se supone gratis). `release` — fallo antes de enviar.
 * Cuenta del día (`spentOn`): released ⇒ 0; reserved vigente ⇒ reserved_usd; reserved vencida ⇒ reserved_usd si se
 * envió y 0 si no; committed/expired ⇒ COALESCE(cost_usd, reserved_usd), y GREATEST(cost_usd, reserved_usd) con
 * attempts > 1 (cada reintento pudo cobrarse aparte). Una confirmación tardía de una fila `expired` sustituye la reserva
 * por la medición. Idempotencia por clave: en curso ⇒ `in_progress`; cerrada (committed/expired) ⇒ `replay`, sin
 * reservar ni llamar otra vez; liberada ⇒ puede reservarse de nuevo (con un id de reserva nuevo).
 * Nunca convierte un fallo del proveedor en excepción (lo decide quien llama); los errores de BD se propagan.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { runAtomic } from '../conversation/state-machine.ts';
import type { SystemOneResult } from '../jev/client.ts';
import { JEV_MAX_DAILY_BUDGET_USD, type JevConfig } from '../shared/config.ts';
import { log } from '../shared/logger.ts';

/**
 * Vigencia de una reserva sin confirmar: cubre la llamada (10 s en el pipeline y la evaluación, 15 s en las rutas
 * sembradas, reintentos incluidos) con margen, como QUOTA_RESERVATION_TTL_MS. Solo limita lo que retiene un proceso
 * caído: una llamada enviada sigue contando aunque su reserva venza.
 */
export const TYPESAFE_RESERVATION_TTL_MS = 120_000;
/** Mismo patrón que el CHECK de `typesafe_reservation.idempotency_key`. */
const KEY_PATTERN = /^(ai_invocation|pipeline|evaluation):[A-Za-z0-9._:-]{1,180}$/;
const BUDGET_LOCK = `SELECT pg_advisory_xact_lock(hashtext('typesafe_budget'))`;

/** Gasto del día UTC `$1` con la regla de cuenta del libro (ver cabecera). */
const SPENT_SQL = `SELECT COALESCE(SUM(CASE
    WHEN status = 'reserved' THEN CASE WHEN dispatched_at IS NOT NULL OR expires_at > clock_timestamp() THEN reserved_usd ELSE 0 END
    WHEN attempts > 1 THEN GREATEST(cost_usd, reserved_usd)
    ELSE COALESCE(cost_usd, reserved_usd) END), 0)::text AS spent
  FROM typesafe_reservation WHERE budget_day = $1::date AND status <> 'released'`;

export type TypeSafeSource = 'ai_core' | 'pipeline' | 'evaluation';

export interface TypeSafeReserveInput {
  /** `ai_invocation:<id>` | `pipeline:<uuid opaco>` (nunca un id del negocio: DEC-0027) | `evaluation:<run>:<caso>`. */
  key: string;
  source: TypeSafeSource;
  /** Caso de uso del AI Core; null fuera del AI Core. */
  useCaseId: string | null;
  /** Costo máximo de la llamada (USD). */
  reserveUsd: number;
}

export interface TypeSafeHold {
  reservationId: string;
  key: string;
  budgetDay: string;
  reservedUsd: number;
}

export type TypeSafeReservation =
  | { status: 'reserved'; hold: TypeSafeHold }
  | { status: 'denied'; budgetDay: string; spentUsd: number; limitUsd: number }
  | { status: 'in_progress'; key: string }
  | { status: 'replay'; key: string; previous: 'committed' | 'expired' };

/** Medición de una llamada que respondió bien: importe con su fuente, o desconocido. */
export type TypeSafeMeasurement =
  | { costUsd: number; costSource: 'reported' | 'estimated'; attempts: number }
  | { costUsd: null; costSource: 'unknown'; attempts: number };

/** Lo que usan los llamadores (AI Core, pipeline, evaluación); las pruebas unitarias lo sustituyen. */
export interface TypeSafeBudget {
  reserve(input: TypeSafeReserveInput): Promise<TypeSafeReservation>;
  /** true ⇒ puede enviarse; false ⇒ la reserva venció o ya no está en curso: no se llama al proveedor. */
  dispatched(hold: TypeSafeHold): Promise<boolean>;
  commit(hold: TypeSafeHold, measured: TypeSafeMeasurement): Promise<boolean>;
  failAfterDispatch(hold: TypeSafeHold, reason: string): Promise<boolean>;
  release(hold: TypeSafeHold, reason: string): Promise<boolean>;
}

export interface TypeSafeLedgerDeps {
  pool: Pool;
  /** USD por día UTC; se lee en cada reserva. */
  dailyLimitUsd: () => number;
  reservationTtlMs?: number;
}

export interface TypeSafeReconcileReport {
  released: number;
  expired: number;
}

/** DEC-0032 (regla sin cambios): USD 1 por día con Jev deshabilitado en el chat; si no, JEV_DAILY_BUDGET_USD (0 < v ≤ 1). */
export function typesafeDailyLimitUsd(jev: JevConfig): number {
  return jev.mode === 'disabled' ? JEV_MAX_DAILY_BUDGET_USD : jev.dailyBudgetUsd;
}

/**
 * Contrato de medición de una respuesta válida (src/jev/client.ts, `resultCost`): `usage.cost` del proveedor ⇒
 * `reported`; si no viene, tokens × precio configurado ⇒ `estimated`; sin ninguno ⇒ `unknown` (cuenta la reserva).
 * `attempts` = peticiones HTTP de la llamada: los 429/5xx reintentados pudieron cobrarse.
 */
export function measuredCost(meta: Pick<SystemOneResult['meta'], 'cost' | 'attempts'>): TypeSafeMeasurement {
  const { cost, attempts } = meta;
  if (cost.amount === null || cost.source === 'mock') return { costUsd: null, costSource: 'unknown', attempts };
  return { costUsd: cost.amount, costSource: cost.source, attempts };
}

/** Gasto de TypeSafe del día UTC `day` (YYYY-MM-DD) según el libro: la única fuente del tope DEC-0032. */
export async function typesafeSpentOn(db: Pool | PoolClient, day: string): Promise<number> {
  const r = await db.query<{ spent: string }>(SPENT_SQL, [day]);
  return Number(r.rows[0]?.spent ?? 0);
}

export class TypeSafeLedger implements TypeSafeBudget {
  private readonly deps: TypeSafeLedgerDeps;

  constructor(deps: TypeSafeLedgerDeps) {
    this.deps = deps;
  }

  async reserve(input: TypeSafeReserveInput): Promise<TypeSafeReservation> {
    const prefix = input.source === 'ai_core' ? 'ai_invocation' : input.source;
    if (!KEY_PATTERN.test(input.key) || !input.key.startsWith(`${prefix}:`)) {
      throw new Error(`FAIL-CLOSED: invalid TypeSafe reservation key for source ${input.source}`);
    }
    if ((input.source === 'ai_core') !== (input.useCaseId !== null)) {
      throw new Error('FAIL-CLOSED: only AI Core TypeSafe reservations carry a use case');
    }
    if (!Number.isFinite(input.reserveUsd) || input.reserveUsd <= 0) {
      throw new Error('FAIL-CLOSED: a TypeSafe reservation needs a positive USD amount');
    }
    const limitUsd = this.deps.dailyLimitUsd();
    if (!Number.isFinite(limitUsd) || limitUsd < 0) {
      throw new Error('FAIL-CLOSED: the TypeSafe daily limit must be a finite, non-negative USD amount (DEC-0032)');
    }
    return runAtomic(this.deps.pool, async (client) => {
      await client.query(BUDGET_LOCK);
      await this.sweep(client);
      const existing = (await client.query<{ status: string }>(
        'SELECT status FROM typesafe_reservation WHERE idempotency_key = $1', [input.key])).rows[0];
      // Tras el barrido, una fila `reserved` sigue vigente.
      if (existing?.status === 'reserved') return { status: 'in_progress', key: input.key };
      if (existing?.status === 'committed' || existing?.status === 'expired') {
        return { status: 'replay', key: input.key, previous: existing.status };
      }
      const budgetDay = (await client.query<{ day: string }>(
        `SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day`)).rows[0]!.day;
      const spentUsd = await typesafeSpentOn(client, budgetDay);
      if (spentUsd + input.reserveUsd > limitUsd + 1e-9) {
        log.info('typesafe.reservation.denied', 'TypeSafe daily budget exhausted; the call is not sent', {
          source: input.source, use_case_id: input.useCaseId, budget_day: budgetDay, spent_usd: spentUsd, limit_usd: limitUsd,
        });
        return { status: 'denied', budgetDay, spentUsd, limitUsd };
      }
      const reservationId = `tsr_${randomUUID()}`;
      // Una clave liberada (nunca enviada) se reutiliza con un id nuevo: una reserva anterior no puede cerrarla.
      const r = await client.query(
        `INSERT INTO typesafe_reservation
           (reservation_id, idempotency_key, source, use_case_id, budget_day, reserved_usd, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5::date, $6, 'reserved', clock_timestamp() + ($7::int * interval '1 millisecond'), clock_timestamp())
         ON CONFLICT (idempotency_key) DO UPDATE SET
           reservation_id = EXCLUDED.reservation_id, source = EXCLUDED.source, use_case_id = EXCLUDED.use_case_id,
           budget_day = EXCLUDED.budget_day, reserved_usd = EXCLUDED.reserved_usd, status = 'reserved', dispatched_at = NULL,
           attempts = NULL, cost_usd = NULL, cost_source = NULL, reason = NULL, expires_at = EXCLUDED.expires_at,
           created_at = EXCLUDED.created_at, settled_at = NULL
         WHERE typesafe_reservation.status = 'released'`,
        [reservationId, input.key, input.source, input.useCaseId, budgetDay, input.reserveUsd, this.deps.reservationTtlMs ?? TYPESAFE_RESERVATION_TTL_MS]);
      if (r.rowCount !== 1) throw new Error('FAIL-CLOSED: TypeSafe reservation key changed while holding the budget lock');
      return { status: 'reserved', hold: { reservationId, key: input.key, budgetDay, reservedUsd: input.reserveUsd } };
    });
  }

  async dispatched(hold: TypeSafeHold): Promise<boolean> {
    return runAtomic(this.deps.pool, async (client) => {
      await client.query(BUDGET_LOCK);
      const sent = await client.query(
        `UPDATE typesafe_reservation SET dispatched_at = clock_timestamp()
          WHERE reservation_id = $1 AND status = 'reserved' AND dispatched_at IS NULL AND expires_at > clock_timestamp()`,
        [hold.reservationId]);
      if (sent.rowCount === 1) return true;
      await client.query(
        `UPDATE typesafe_reservation SET status = 'released', reason = 'expired_before_dispatch', settled_at = clock_timestamp()
          WHERE reservation_id = $1 AND status = 'reserved' AND dispatched_at IS NULL`, [hold.reservationId]);
      log.warn('typesafe.reservation.lapsed', 'TypeSafe reservation lapsed before dispatch; the call is not sent', {
        reservation_id: hold.reservationId, budget_day: hold.budgetDay,
      });
      return false;
    });
  }

  async commit(hold: TypeSafeHold, measured: TypeSafeMeasurement): Promise<boolean> {
    if (!Number.isInteger(measured.attempts) || measured.attempts < 1) {
      throw new Error('FAIL-CLOSED: a TypeSafe measurement needs at least one HTTP attempt');
    }
    const r = await this.deps.pool.query(
      `UPDATE typesafe_reservation SET status = 'committed', cost_usd = $2, cost_source = $3, attempts = $4,
              reason = CASE WHEN status = 'expired' THEN 'settled_after_expiry' END, settled_at = clock_timestamp()
        WHERE reservation_id = $1 AND dispatched_at IS NOT NULL AND status IN ('reserved','expired')`,
      [hold.reservationId, measured.costUsd, measured.costSource, measured.attempts]);
    return this.settled(hold, r.rowCount, 'commit');
  }

  async failAfterDispatch(hold: TypeSafeHold, reason: string): Promise<boolean> {
    const r = await this.deps.pool.query(
      `UPDATE typesafe_reservation SET status = 'committed', cost_usd = NULL, cost_source = 'unknown', attempts = NULL,
              reason = $2, settled_at = clock_timestamp()
        WHERE reservation_id = $1 AND dispatched_at IS NOT NULL AND status IN ('reserved','expired')`,
      [hold.reservationId, reason.slice(0, 200) || 'unspecified']);
    return this.settled(hold, r.rowCount, 'fail_after_dispatch');
  }

  async release(hold: TypeSafeHold, reason: string): Promise<boolean> {
    const r = await this.deps.pool.query(
      `UPDATE typesafe_reservation SET status = 'released', reason = $2, settled_at = clock_timestamp()
        WHERE reservation_id = $1 AND status = 'reserved' AND dispatched_at IS NULL`,
      [hold.reservationId, reason.slice(0, 200) || 'unspecified']);
    return this.settled(hold, r.rowCount, 'release');
  }

  /** Cierra las reservas vencidas (proceso caído a mitad); `reserve` hace lo mismo antes de cada reserva. */
  async reconcile(): Promise<TypeSafeReconcileReport> {
    const report = await runAtomic(this.deps.pool, async (client) => {
      await client.query(BUDGET_LOCK);
      return this.sweep(client);
    });
    if (report.released > 0 || report.expired > 0) {
      log.info('typesafe.reconciled', 'expired TypeSafe reservations closed', { released: report.released, expired: report.expired });
    }
    return report;
  }

  async spentOn(day: string): Promise<number> {
    return typesafeSpentOn(this.deps.pool, day);
  }

  /** Vencida sin enviar ⇒ released (no cuenta); vencida enviada ⇒ expired con costo desconocido (cuenta la reserva). */
  private async sweep(client: PoolClient): Promise<TypeSafeReconcileReport> {
    const r = await client.query<{ status: 'released' | 'expired' }>(
      `UPDATE typesafe_reservation
          SET status = CASE WHEN dispatched_at IS NULL THEN 'released' ELSE 'expired' END,
              cost_source = CASE WHEN dispatched_at IS NULL THEN NULL ELSE 'unknown' END,
              reason = CASE WHEN dispatched_at IS NULL THEN 'expired_before_dispatch' ELSE 'expired_after_dispatch' END,
              settled_at = clock_timestamp()
        WHERE status = 'reserved' AND expires_at <= clock_timestamp()
        RETURNING status`);
    return {
      released: r.rows.filter((row) => row.status === 'released').length,
      expired: r.rows.filter((row) => row.status === 'expired').length,
    };
  }

  private settled(hold: TypeSafeHold, rowCount: number | null, action: string): boolean {
    if (rowCount === 1) return true;
    // Ya cerrada (otra confirmación o la reconciliación): nada que cambiar, la cuenta sigue siendo conservadora.
    log.warn('typesafe.reservation.not_settled', 'TypeSafe reservation was not open for this settlement', {
      reservation_id: hold.reservationId, action,
    });
    return false;
  }
}
