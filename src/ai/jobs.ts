/**
 * Jobs durables del AI Core (ARC-0001 §7, G4): diseño web, ediciones y composición social.
 *
 * - Cola en `ai_job` con reclamo por fila (`FOR UPDATE SKIP LOCKED`), lease y `claim_token`
 *   (fencing): un dueño que perdió el lease no escribe el resultado.
 * - Idempotente: cada paso invoca la IA con clave `job:<id>:<paso>`; al reintentar tras una caída,
 *   los pasos terminados se reutilizan (replay) en lugar de pagar otra vez.
 * - Las rutas se FIJAN al crear el job (`pinned`): cambiar el rollout no altera un job en curso.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { log } from '../shared/logger.ts';
import { AppError } from '../shared/errors.ts';
import type { AiRegistry } from './registry.ts';

export const JOB_LEASE_SECONDS = 600;
export const JOB_MAX_ATTEMPTS = 3;

export interface AiJobRow {
  job_id: string; tenant_id: string; kind: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  idempotency_key: string; input: Record<string, unknown>; pinned: Record<string, string>; progress: Record<string, unknown>;
  result: Record<string, unknown> | null; error_code: string | null; attempts: number; claim_token: string | null;
  lease_until: string | null; created_by: string; created_at: string; updated_at: string; finished_at: string | null;
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
  private readonly environment: string;
  private readonly handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: { pool: Pool; registry: AiRegistry; environment: string }) {
    this.pool = deps.pool;
    this.registry = deps.registry;
    this.environment = deps.environment;
  }

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Crea (o devuelve, por idempotencia) un job; fija la ruta vigente de cada caso de uso. */
  async enqueue(input: { tenantId: string; kind: string; idempotencyKey: string; input: Record<string, unknown>; useCases: string[]; createdBy: string }): Promise<{ job: AiJobRow; created: boolean }> {
    if (!this.handlers.has(input.kind)) throw new AppError(400, 'validation_error', 'Tipo de trabajo desconocido.');
    const existing = await this.pool.query<AiJobRow>('SELECT * FROM ai_job WHERE tenant_id = $1 AND kind = $2 AND idempotency_key = $3', [input.tenantId, input.kind, input.idempotencyKey]);
    if (existing.rows[0]) return { job: existing.rows[0], created: false };
    const pinned: Record<string, string> = {};
    for (const uc of input.useCases) {
      const resolved = await this.registry.resolve(uc, this.environment, input.tenantId);
      if (resolved) pinned[uc] = resolved.routeId;
    }
    const r = await this.pool.query<AiJobRow>(
      `INSERT INTO ai_job (job_id, tenant_id, kind, idempotency_key, input, pinned, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, kind, idempotency_key) DO NOTHING RETURNING *`,
      [`job_${randomUUID()}`, input.tenantId, input.kind, input.idempotencyKey, JSON.stringify(input.input), JSON.stringify(pinned), input.createdBy]);
    if (r.rows[0]) return { job: r.rows[0], created: true };
    const again = await this.pool.query<AiJobRow>('SELECT * FROM ai_job WHERE tenant_id = $1 AND kind = $2 AND idempotency_key = $3', [input.tenantId, input.kind, input.idempotencyKey]);
    return { job: again.rows[0] as AiJobRow, created: false };
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
      return;
    }
    if (job.attempts > JOB_MAX_ATTEMPTS) {
      await owned(`UPDATE ai_job SET status = 'failed', error_code = COALESCE(error_code, 'attempts_exhausted'), finished_at = now(), updated_at = now() WHERE true`, []);
      return;
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
    }
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    const run = () => {
      if (this.running) return;
      this.running = true;
      this.tick().catch((err: unknown) => log.error('ai.jobs.tick_failed', 'ai job tick failed', { error_name: err instanceof Error ? err.name : 'unknown' }))
        .finally(() => { this.running = false; });
    };
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
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
