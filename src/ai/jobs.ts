/**
 * Jobs durables del AI Core (ARC-0001 §7, G4): diseño web, ediciones y composición social.
 *
 * - Cola en `ai_job` con reclamo por fila (`FOR UPDATE SKIP LOCKED`), lease y `claim_token`
 *   (fencing): un dueño que perdió el lease no escribe el resultado.
 * - Idempotente: cada paso invoca la IA con clave `job:<id>:<paso>`; al reintentar tras una caída,
 *   los pasos terminados se reutilizan (replay) en lugar de pagar otra vez.
 * - Las rutas se FIJAN al crear el job (`pinned`): cambiar el rollout no altera un job en curso.
 * - Laboratorio (DEC-0074): un job creado con `labGrantId` fija SOLO las capacidades generativas que el grant
 *   autoriza (clasificación: ruta normal); una generativa fuera del grant queda sin ruta y el dispatcher la
 *   bloquea (nunca cae al rollout). El worker revalida el grant antes de cada intento: revocado o caducado ⇒ el
 *   job falla sin gastar.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { log } from '../shared/logger.ts';
import { AppError } from '../shared/errors.ts';
import { AiLab, type LabGrantView } from './lab.ts';
import type { AiRegistry } from './registry.ts';

export const JOB_LEASE_SECONDS = 600;
export const JOB_MAX_ATTEMPTS = 3;
/** Mucho más que el deadline máximo de una llamada (timeout + reparación): si sigue `running`, su proceso cayó. */
const ABANDONED_AFTER_MINUTES = 15;
const RECONCILE_EVERY_MS = 5 * 60_000;

export interface AiJobRow {
  job_id: string; tenant_id: string; kind: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  idempotency_key: string; input: Record<string, unknown>; pinned: Record<string, string>; progress: Record<string, unknown>;
  result: Record<string, unknown> | null; error_code: string | null; attempts: number; claim_token: string | null;
  lease_until: string | null; lab_grant_id: string | null; created_by: string; created_at: string; updated_at: string; finished_at: string | null;
}

export interface JobContext {
  job: AiJobRow;
  /** Actualiza el progreso visible (solo si el job sigue siendo de este dueño). */
  progress: (p: Record<string, unknown>) => Promise<void>;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown>>;

export class AiJobError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean, message = code) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export class AiJobs {
  private readonly pool: Pool;
  private readonly registry: AiRegistry;
  private readonly lab: AiLab;
  private readonly environment: string;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly settledListeners: Array<(job: AiJobRow) => Promise<void>> = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: { pool: Pool; registry: AiRegistry; environment: string; lab: AiLab }) {
    this.pool = deps.pool;
    this.registry = deps.registry;
    this.environment = deps.environment;
    this.lab = deps.lab;
  }

  private replay(job: AiJobRow, grantId: string | null, userId: string): { job: AiJobRow; created: false } {
    if ((job.lab_grant_id ?? null) !== grantId || (grantId && job.created_by !== userId)) {
      throw new AppError(403, 'permission_denied', 'Esta clave pertenece a otra ejecución. Usa la autorización original o inicia una acción nueva.');
    }
    return { job, created: false };
  }

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Avisa cuando un job termina (con éxito o con un fallo terminal); un listener que falla no afecta al job. */
  onSettled(listener: (job: AiJobRow) => Promise<void>): void {
    this.settledListeners.push(listener);
  }

  private async settled(jobId: string): Promise<void> {
    if (!this.settledListeners.length) return;
    const row = (await this.pool.query<AiJobRow>('SELECT * FROM ai_job WHERE job_id = $1', [jobId])).rows[0];
    if (!row || (row.status !== 'succeeded' && row.status !== 'failed')) return;
    for (const listener of this.settledListeners) {
      await listener(row).catch((err: unknown) => log.warn('ai.job.listener_failed', 'job settled listener failed', { job_id: jobId, error_name: err instanceof Error ? err.name : 'unknown' }));
    }
  }

  /**
   * Rutas que fijaría un job sin crearlo. Con grant: valida el grant para el negocio y el usuario (403 si no es válido:
   * sin fallback) y fija solo las generativas autorizadas más la clasificación normal; sin grant, el rollout del entorno.
   */
  async plan(input: { tenantId: string; useCases: string[]; createdBy: string; labGrantId?: string | null }): Promise<{ grant: LabGrantView | null; pinned: Record<string, string> }> {
    const grant = await this.lab.authorize({ grantId: input.labGrantId ?? null, tenantId: input.tenantId, userId: input.createdBy });
    const pinned: Record<string, string> = {};
    for (const uc of input.useCases) {
      if (grant) {
        const granted = grant.routes.find((r) => r.use_case_id === uc);
        if (granted) { pinned[uc] = granted.route_id; continue; }
        if ((await this.registry.useCase(uc))?.modality !== 'classification') continue;
      }
      const resolved = await this.registry.resolve(uc, this.environment, input.tenantId);
      if (resolved) pinned[uc] = resolved.routeId;
    }
    return { grant, pinned };
  }

  /**
   * Crea (o devuelve, por idempotencia) un job; fija la ruta vigente de cada caso de uso (`plan`). `useCases` enumera las
   * ramas POSIBLES del job (no todas se ejecutan).
   */
  async enqueue(input: { tenantId: string; kind: string; idempotencyKey: string; input: Record<string, unknown>; useCases: string[]; createdBy: string; labGrantId?: string | null }): Promise<{ job: AiJobRow; created: boolean }> {
    if (!this.handlers.has(input.kind)) throw new AppError(400, 'validation_error', 'Tipo de trabajo desconocido.');
    const { grant, pinned } = await this.plan(input);
    const existing = await this.pool.query<AiJobRow>('SELECT * FROM ai_job WHERE tenant_id = $1 AND kind = $2 AND idempotency_key = $3', [input.tenantId, input.kind, input.idempotencyKey]);
    if (existing.rows[0]) return this.replay(existing.rows[0], grant?.grant_id ?? null, input.createdBy);
    const r = await this.pool.query<AiJobRow>(
      `INSERT INTO ai_job (job_id, tenant_id, kind, idempotency_key, input, pinned, lab_grant_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING RETURNING *`,
      [`job_${randomUUID()}`, input.tenantId, input.kind, input.idempotencyKey, JSON.stringify(input.input), JSON.stringify(pinned), grant?.grant_id ?? null, input.createdBy]);
    if (r.rows[0]) return { job: r.rows[0], created: true };
    const again = await this.pool.query<AiJobRow>('SELECT * FROM ai_job WHERE tenant_id = $1 AND kind = $2 AND idempotency_key = $3', [input.tenantId, input.kind, input.idempotencyKey]);
    return this.replay(again.rows[0] as AiJobRow, grant?.grant_id ?? null, input.createdBy);
  }

  /** Anti-oráculo por negocio. */
  async get(tenantId: string, jobId: string): Promise<AiJobRow | null> {
    const r = await this.pool.query<AiJobRow>('SELECT * FROM ai_job WHERE job_id = $1', [jobId]);
    const row = r.rows[0];
    return row && row.tenant_id === tenantId ? row : null;
  }

  private async claim(): Promise<AiJobRow | null> {
    const token = `jc_${randomUUID()}`;
    const r = await this.pool.query<AiJobRow>(
      `WITH due AS (
         SELECT job_id FROM ai_job
          WHERE (status = 'queued' AND next_attempt_at <= now())
             OR (status = 'running' AND lease_until < now())
          ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       UPDATE ai_job j SET status = 'running', claim_token = $1, attempts = j.attempts + 1,
         lease_until = now() + make_interval(secs => $2), updated_at = now()
         FROM due WHERE j.job_id = due.job_id RETURNING j.*`, [token, JOB_LEASE_SECONDS]);
    return r.rows[0] ?? null;
  }

  /** Procesa hasta `max` jobs; devuelve cuántos terminó. */
  async tick(max = 4): Promise<number> {
    let done = 0;
    for (let i = 0; i < max; i++) {
      const job = await this.claim();
      if (!job) break;
      await this.process(job);
      done++;
    }
    return done;
  }

  private async process(job: AiJobRow): Promise<void> {
    const handler = this.handlers.get(job.kind);
    const owned = (sql: string, params: unknown[]) => this.pool.query(`${sql} AND job_id = $${params.length + 1} AND claim_token = $${params.length + 2}`, [...params, job.job_id, job.claim_token]);
    if (!handler) {
      await owned(`UPDATE ai_job SET status = 'failed', error_code = 'unknown_kind', finished_at = now(), updated_at = now() WHERE true`, []);
      await this.settled(job.job_id);
      return;
    }
    if (job.attempts > JOB_MAX_ATTEMPTS) {
      await owned(`UPDATE ai_job SET status = 'failed', error_code = COALESCE(error_code, 'attempts_exhausted'), finished_at = now(), updated_at = now() WHERE true`, []);
      await this.settled(job.job_id);
      return;
    }
    if (job.lab_grant_id) {
      // Revalidación del grant en el worker (vigencia, revocación, negocio, usuario, emisor): un job autorizado
      // ayer no gasta hoy si la autorización ya no existe. Terminal: no se reintenta. Cada invocación vuelve a
      // comprobar la ruta fijada contra la allowlist (dispatcher).
      const check = await this.lab.check({ grantId: job.lab_grant_id, tenantId: job.tenant_id, userId: job.created_by });
      if (!check.ok) {
        log.warn('ai.job.lab_grant_invalid', 'job refused: lab grant no longer valid', { job_id: job.job_id, kind: job.kind, reason: check.reason });
        await owned(`UPDATE ai_job SET status = 'failed', error_code = 'lab_grant_invalid', claim_token = NULL, lease_until = NULL, finished_at = now(), updated_at = now() WHERE true`, []);
        await this.settled(job.job_id);
        return;
      }
    }
    const ctx: JobContext = {
      job,
      progress: async (p) => {
        await owned(`UPDATE ai_job SET progress = progress || $1::jsonb, updated_at = now() WHERE true`, [JSON.stringify(p)]);
      },
    };
    try {
      const result = await handler(ctx);
      const r = await owned(`UPDATE ai_job SET status = 'succeeded', result = $1, error_code = NULL, claim_token = NULL, lease_until = NULL, finished_at = now(), updated_at = now() WHERE status = 'running'`, [JSON.stringify(result)]);
      if (!r.rowCount) log.warn('ai.job.claim_lost', 'job finished after losing its lease; result discarded', { job_id: job.job_id });
      else await this.settled(job.job_id);
    } catch (err) {
      const code = err instanceof AiJobError ? err.code : err instanceof AppError ? err.code : 'job_exception';
      const retryable = err instanceof AiJobError ? err.retryable : !(err instanceof AppError);
      const terminal = !retryable || job.attempts >= JOB_MAX_ATTEMPTS;
      log.warn('ai.job.failed', 'ai job step failed', { job_id: job.job_id, kind: job.kind, code, terminal, error_name: err instanceof Error ? err.name : 'unknown' });
      await owned(
        terminal
          ? `UPDATE ai_job SET status = 'failed', error_code = $1, claim_token = NULL, lease_until = NULL, finished_at = now(), updated_at = now() WHERE true`
          : `UPDATE ai_job SET status = 'queued', error_code = $1, claim_token = NULL, lease_until = NULL, next_attempt_at = now() + interval '15 seconds', updated_at = now() WHERE true`,
        [code.slice(0, 80)]);
      if (terminal) await this.settled(job.job_id);
    }
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    let lastReconcile = 0;
    const run = () => {
      if (this.running) return;
      this.running = true;
      const reconcile = Date.now() - lastReconcile > RECONCILE_EVERY_MS;
      if (reconcile) lastReconcile = Date.now();
      (reconcile ? this.reconcileAbandoned().then(() => this.tick()) : this.tick())
        .catch((err: unknown) => log.error('ai.jobs.tick_failed', 'ai job tick failed', { error_name: err instanceof Error ? err.name : 'unknown' }))
        .finally(() => { this.running = false; });
    };
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  /**
   * Invocaciones que siguen `running` mucho después de cualquier deadline (el proceso cayó a mitad
   * de la llamada): resultado incierto. Se cierran como fallidas SIN costo informado, de modo que
   * el gasto sigue contando la reserva completa (el proveedor pudo haber cobrado). El job dueño se
   * recupera por su lease y reintenta con una clave de intento nueva.
   */
  async reconcileAbandoned(olderThanMinutes = ABANDONED_AFTER_MINUTES): Promise<number> {
    const r = await this.pool.query(
      `UPDATE ai_invocation SET status = 'failed', error_code = 'uncertain_abandoned', finished_at = now()
        WHERE status = 'running' AND created_at < now() - make_interval(mins => $1)`, [olderThanMinutes]);
    if (r.rowCount) log.warn('ai.invocation.abandoned', 'closed invocations left running by a crashed process', { count: r.rowCount });
    return r.rowCount ?? 0;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Espera a que no queden jobs de un negocio por terminar (pruebas y scripts). */
  async drain(tenantId: string, timeoutMs = 60_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await this.tick();
      const r = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM ai_job WHERE tenant_id = $1 AND status IN ('queued','running')`, [tenantId]);
      if (Number(r.rows[0]?.n ?? 0) === 0) return;
      await new Promise((res) => setTimeout(res, 100));
    }
  }
}
