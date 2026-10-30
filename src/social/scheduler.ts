/**
 * Scheduler de publicaciones sociales (DEV-E2E-04, P1+P4): publica SOLO publicaciones ya
 * aprobadas cuando llega su hora, sin tick manual, dentro del proceso del servidor o como
 * proceso propio (`scripts/social-scheduler.ts`). Varias instancias pueden convivir.
 *
 * Garantías:
 *  - Reclamo atómico por fila (UPDATE … FOR UPDATE SKIP LOCKED) con lease: dos procesos
 *    nunca publican la misma fila a la vez.
 *  - La aprobación se vuelve a comprobar por fila al procesarla (PR-01): sin evidencia ⇒
 *    'blocked' + auditoría deny; nunca se publica.
 *  - Caída/SIGKILL: al vencer el lease la fila se retoma. Con proveedor idempotente
 *    (simulador) se reintenta sin riesgo; con proveedor real pasa a 'uncertain' y se
 *    RECONCILIA leyendo del proveedor antes de reintentar. Nunca se reenvía a ciegas.
 *  - Timeout de escritura ⇒ 'uncertain' (no reintento inmediato). Si el proveedor no permite
 *    buscar la publicación, o la búsqueda falla demasiado tiempo, la fila termina en 'failed'
 *    con last_error para revisión humana.
 *  - Reintentos acotados (attempts ≤ maxAttempts) con backoff exponencial o Retry-After.
 *  - Todo en UTC; la zona del negocio solo se usa para la hora legible en logs/auditoría.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import { log } from '../shared/logger.ts';
import type { SocialProvider, SocialPublishResult } from './provider.ts';
import { SocialRepository, type ScheduledPostRow, type SocialPostRow } from './service.ts';
import { DEFAULT_SCHEDULER_TIMEZONE, formatInZone } from './timezone.ts';

export const SCHEDULER_ACTOR = 'social_scheduler';

export interface SocialSchedulerDeps {
  pool: Pool;
  sink: AuditSink;
  provider: SocialProvider;
  /** Duración del lease de un intento; al vencer, otro proceso puede retomar la fila. */
  leaseSeconds?: number;
  /** Intentos máximos por fila (reclamos), contando reconciliaciones. */
  maxAttempts?: number;
  batchSize?: number;
  /** Tiempo máximo de la llamada al proveedor; al vencer el resultado es incierto. */
  publishTimeoutMs?: number;
  /** Cuánto puede seguir 'uncertain' sin poder reconciliar antes de pedir revisión humana. */
  uncertainMaxMinutes?: number;
  timezone?: string;
}

export interface SchedulerTickReport {
  claimed: number;
  published: number;
  blocked: number;
  retried: number;
  failed: number;
  uncertain: number;
  /** Leases vencidos devueltos a la cola o pasados a reconciliación. */
  recovered: number;
  skipped: number;
  publishedPosts: SocialPostRow[];
}

export interface TickScope {
  tenantId?: string;
  requestId?: string;
}

interface ClaimedRow extends ScheduledPostRow {
  prev_status: 'scheduled' | 'uncertain';
  attempts: number;
  claim_token: string;
  publish_key: string;
  uncertain_since: string | null;
}

const DEFAULTS = { leaseSeconds: 120, maxAttempts: 5, batchSize: 25, publishTimeoutMs: 20_000, uncertainMaxMinutes: 30 };

export function backoffMs(attempts: number): number {
  return Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}

export class SocialScheduler {
  private readonly deps: Required<Omit<SocialSchedulerDeps, 'timezone'>> & { timezone: string };
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: SocialSchedulerDeps) {
    this.deps = { ...DEFAULTS, timezone: DEFAULT_SCHEDULER_TIMEZONE, ...deps };
  }

  get provider(): SocialProvider {
    return this.deps.provider;
  }

  /** Bucle periódico sin solapes; el temporizador no mantiene vivo el proceso. */
  start(intervalMs: number): void {
    if (this.timer) return;
    const run = () => {
      if (this.running) return;
      this.running = true;
      this.tick()
        .catch((err: unknown) => log.error('social.scheduler.tick_failed', 'social scheduler tick failed', { error_name: err instanceof Error ? err.name : 'unknown' }))
        .finally(() => { this.running = false; });
    };
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  /** Un ciclo: recupera leases vencidos, reclama vencidas/inciertas y las procesa una a una. */
  async tick(scope: TickScope = {}): Promise<SchedulerTickReport> {
    const requestId = scope.requestId ?? `sched_${randomUUID()}`;
    const report: SchedulerTickReport = {
      claimed: 0, published: 0, blocked: 0, retried: 0, failed: 0, uncertain: 0, recovered: 0, skipped: 0, publishedPosts: [],
    };
    report.recovered = await this.recoverExpiredLeases(scope, requestId);
    // Reclamar justo antes de procesar: no dejar un lote esperando hasta que venza su lease.
    for (let index = 0; index < this.deps.batchSize; index += 1) {
      const [row] = await this.claim(scope);
      if (!row) break;
      report.claimed += 1;
      try {
        await this.process(row, requestId, report);
      } catch (err) {
        // Tras una escritura que lanzó (incluido fallo de DB después del POST), su resultado
        // puede ser incierto. Nunca devolver un proveedor no idempotente a la cola de envío.
        if (this.deps.provider.idempotentPublish) {
          await this.retryOrFail(row, requestId, report, 'scheduler_exception', null);
        } else {
          await this.markUncertain(row, requestId, report, 'scheduler_exception');
        }
        throw err; // El tick/API no anuncia éxito cuando falló persistencia o auditoría.
      }
    }
    if (report.claimed || report.recovered) {
      log.info('social.scheduler.tick', 'scheduled posts processed', {
        claimed: report.claimed, published: report.published, blocked: report.blocked, retried: report.retried,
        failed: report.failed, uncertain: report.uncertain, recovered: report.recovered, skipped: report.skipped,
      });
    }
    return report;
  }

  // ------------------------------------------------------------------ reclamo y leases

  private async recoverExpiredLeases(scope: TickScope, requestId: string): Promise<number> {
    const idempotent = this.deps.provider.idempotentPublish;
    const res = await this.deps.pool.query<{ scheduled_post_id: string; tenant_id: string; post_id: string; status: string }>(
      `UPDATE scheduled_post SET
         status = CASE WHEN $1 THEN 'scheduled' ELSE 'uncertain' END,
         claim_token = NULL, lease_until = NULL, last_error = 'lease_expired',
         next_attempt_at = CASE WHEN $1 THEN now() ELSE next_attempt_at END,
         uncertain_since = CASE WHEN $1 THEN uncertain_since ELSE COALESCE(uncertain_since, now()) END,
         updated_at = now()
       WHERE status = 'publishing' AND lease_until < now() AND ($2::text IS NULL OR tenant_id = $2)
       RETURNING scheduled_post_id, tenant_id, post_id, status`,
      [idempotent, scope.tenantId ?? null]);
    for (const r of res.rows) {
      log.warn('social.scheduler.lease_expired', 'scheduled post lease expired; recovered', {
        tenant_id: r.tenant_id, scheduled_post_id: r.scheduled_post_id, recovered_to: r.status,
      });
      await this.audit(r.tenant_id, r.post_id, requestId, 'social.scheduler', 'allow', `lease_expired:${r.status}`, r.scheduled_post_id);
    }
    return res.rowCount ?? 0;
  }

  /**
   * Reclama vencidas ('scheduled', publish_at y next_attempt_at ya pasados) e inciertas
   * ('uncertain') en una sola sentencia con SKIP LOCKED: cada fila tiene UN solo dueño.
   */
  private async claim(scope: TickScope): Promise<ClaimedRow[]> {
    const token = `claim_${randomUUID()}`;
    const res = await this.deps.pool.query<ClaimedRow>(
      `WITH due AS (
         SELECT scheduled_post_id, status AS prev_status FROM scheduled_post
          WHERE ((status = 'scheduled' AND publish_at <= now() AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
                 OR (status = 'uncertain' AND (next_attempt_at IS NULL OR next_attempt_at <= now())))
            AND ($3::text IS NULL OR tenant_id = $3)
          ORDER BY publish_at, scheduled_post_id
          LIMIT $2
          FOR UPDATE SKIP LOCKED)
       UPDATE scheduled_post sp SET status = 'publishing', claim_token = $1, attempts = sp.attempts + 1,
         lease_until = now() + make_interval(secs => $4), publish_key = COALESCE(sp.publish_key, sp.scheduled_post_id), updated_at = now()
         FROM due WHERE sp.scheduled_post_id = due.scheduled_post_id
       RETURNING sp.*, due.prev_status`,
      [token, 1, scope.tenantId ?? null, this.deps.leaseSeconds]);
    return res.rows;
  }

  // ------------------------------------------------------------------ proceso por fila

  private async process(row: ClaimedRow, requestId: string, report: SchedulerTickReport): Promise<void> {
    const repo = new SocialRepository(this.deps.pool);
    const post = (await repo.findScoped(row.tenant_id, row.post_id)).row;
    if (!post || post.tenant_id !== row.tenant_id) {
      await this.release(row, 'skipped', 'post_missing');
      report.skipped += 1;
      return;
    }
    // Replays seguros: ya publicada (otra vía) ⇒ misma referencia; rechazada ⇒ se salta.
    if (post.status === 'published' && post.external_ref) {
      await this.finalizePublished(row, post, post.external_ref, requestId, report, 'already_published');
      return;
    }
    if (post.status === 'rejected') {
      await this.release(row, 'skipped', 'post_rejected');
      report.skipped += 1;
      return;
    }
    // Gate de aprobación (PR-01): se verifica en CADA intento, nunca se confía en la cola.
    if (!(await repo.approvalEvidence(row.tenant_id, post))) {
      await runAtomic(this.deps.pool, async (client) => {
        await this.release(row, 'blocked', 'not_approved', client);
        await this.deps.sink.write({
          tenant_id: row.tenant_id, actor_id: SCHEDULER_ACTOR, actor_role: null,
          action: 'social.published', resource: `social_post/${post.post_id}`,
          request_id: requestId, decision: 'deny', result: 'not_approved', evidence_ref: row.scheduled_post_id,
        }, client);
      });
      report.blocked += 1;
      log.warn('social.scheduler.blocked', 'scheduled row without approval evidence blocked', {
        tenant_id: row.tenant_id, post_id: post.post_id, scheduled_post_id: row.scheduled_post_id,
      });
      return;
    }

    if (row.prev_status === 'uncertain') {
      await this.reconcile(row, post, requestId, report);
      return;
    }

    const result = await this.publishWithTimeout(post, row);
    if (result.ok) {
      await this.finalizePublished(row, post, result.external_ref, requestId, report, 'scheduled_published');
      return;
    }
    if (result.uncertain) {
      if (this.deps.provider.idempotentPublish) {
        await this.retryOrFail(row, requestId, report, result.error ?? 'provider_timeout', result.retryAfterMs ?? null);
        return;
      }
      await this.markUncertain(row, requestId, report, result.error ?? 'provider_timeout', false, result.external_ref);
      return;
    }
    if (result.retryable) {
      await this.retryOrFail(row, requestId, report, result.error ?? 'provider_error', result.retryAfterMs ?? null);
      return;
    }
    await this.fail(row, post, requestId, report, result.error ?? 'provider_error');
  }

  private async publishWithTimeout(post: SocialPostRow, row: ClaimedRow): Promise<SocialPublishResult> {
    const timer = new AbortController();
    try {
      const timeout = sleep(this.deps.publishTimeoutMs, 'timeout' as const, { ref: false, signal: timer.signal }).catch(() => 'aborted' as const);
      const winner = await Promise.race([
        this.deps.provider.publishPost({
          tenantId: row.tenant_id, text: post.text, imageUrl: post.image_url, contentType: post.content_type, idempotencyKey: row.publish_key,
        }),
        timeout,
      ]);
      if (typeof winner === 'string') {
        return { ok: false, external_ref: `timeout:${row.scheduled_post_id}`, error: 'provider_timeout', uncertain: true };
      }
      return winner;
    } catch (err) {
      // Toda excepción tras iniciar una escritura no idempotente tiene resultado desconocido.
      return { ok: false, external_ref: `error:${row.scheduled_post_id}`, error: 'provider_exception',
        uncertain: !this.deps.provider.idempotentPublish, retryable: this.deps.provider.idempotentPublish };
    } finally {
      timer.abort();
    }
  }

  /** Fila incierta: busca en el proveedor antes de decidir reintentar o pedir revisión. */
  private async reconcile(row: ClaimedRow, post: SocialPostRow, requestId: string, report: SchedulerTickReport): Promise<void> {
    const lookup = this.deps.provider.findPublishedPost?.bind(this.deps.provider);
    if (!lookup) {
      await this.fail(row, post, requestId, report, 'uncertain_needs_review');
      return;
    }
    const since = new Date(new Date(row.uncertain_since ?? row.publish_at).getTime() - 60 * 60_000);
    try {
      const found = await lookup({ tenantId: row.tenant_id, text: post.text, since, externalRef: row.external_ref });
      if (found.found) {
        await this.finalizePublished(row, post, found.external_ref, requestId, report, 'scheduled_published:reconciled');
        return;
      }
    } catch (err) {
      const ageMs = Date.now() - new Date(row.uncertain_since ?? row.updated_at ?? row.publish_at).getTime();
      log.warn('social.scheduler.reconcile_failed', 'provider lookup failed while reconciling', {
        tenant_id: row.tenant_id, scheduled_post_id: row.scheduled_post_id, error_name: err instanceof Error ? err.name : 'unknown',
      });
      if (ageMs > this.deps.uncertainMaxMinutes * 60_000) {
        await this.fail(row, post, requestId, report, 'uncertain_unresolved');
      } else {
        await this.markUncertain(row, requestId, report, 'reconcile_lookup_failed', true);
      }
      return;
    }
    // La ausencia en un listado eventual no demuestra que el POST no haya sido aceptado.
    // Revisión humana en lugar de duplicar una publicación tardía o aún no visible.
    await this.fail(row, post, requestId, report, 'uncertain_needs_review');
  }

  // ------------------------------------------------------------------ transiciones

  private async finalizePublished(row: ClaimedRow, post: SocialPostRow, externalRef: string, requestId: string, report: SchedulerTickReport, result: string): Promise<void> {
    const repo = new SocialRepository(this.deps.pool);
    const updated = await runAtomic(this.deps.pool, async (client) => {
      const mine = await client.query(
        `UPDATE scheduled_post SET status = 'published', external_ref = $1, processed_at = now(), claim_token = NULL,
           lease_until = NULL, last_error = NULL, uncertain_since = NULL, updated_at = now()
         WHERE scheduled_post_id = $2 AND tenant_id = $3 AND status = 'publishing' AND claim_token = $4`,
        [externalRef, row.scheduled_post_id, row.tenant_id, row.claim_token]);
      if ((mine.rowCount ?? 0) === 0) {
        // Fencing: un dueño cuyo lease se perdió no modifica el trabajo del nuevo dueño.
        // El reconciliador adoptará el efecto externo; nunca se reenvía a ciegas.
        log.warn('social.scheduler.claim_lost', 'publication completed after lease ownership changed; reconciliation required', {
          tenant_id: row.tenant_id, scheduled_post_id: row.scheduled_post_id,
        });
        return null;
      }
      const u = await repo.updateStatus(row.tenant_id, post.post_id, 'published', {
        publishedAt: new Date().toISOString(), externalRef,
      }, ['scheduled', 'published'], client);
      await this.deps.sink.write({
        tenant_id: row.tenant_id, actor_id: SCHEDULER_ACTOR, actor_role: null,
        action: 'social.published', resource: `social_post/${post.post_id}`,
        request_id: requestId, decision: 'allow', result, evidence_ref: externalRef,
      }, client);
      return u.found ? u.row : null;
    });
    if (updated) {
      report.published += 1;
      report.publishedPosts.push(updated);
      log.info('social.scheduler.published', 'scheduled post published', {
        tenant_id: row.tenant_id, post_id: post.post_id, scheduled_post_id: row.scheduled_post_id,
        publish_at_utc: new Date(row.publish_at).toISOString(), publish_at_local: `${formatInZone(new Date(row.publish_at), this.deps.timezone)} ${this.deps.timezone}`,
        result,
      });
    }
  }

  private async retryOrFail(row: ClaimedRow, requestId: string, report: SchedulerTickReport, error: string, retryAfterMs: number | null, post?: SocialPostRow): Promise<void> {
    if (row.attempts >= this.deps.maxAttempts) {
      const p = post ?? (await new SocialRepository(this.deps.pool).findScoped(row.tenant_id, row.post_id)).row;
      await this.fail(row, p, requestId, report, `${error}:attempts_exhausted`);
      return;
    }
    const waitMs = Math.max(retryAfterMs ?? 0, backoffMs(row.attempts));
    await this.deps.pool.query(
      `UPDATE scheduled_post SET status = 'scheduled', claim_token = NULL, lease_until = NULL, uncertain_since = NULL,
         next_attempt_at = now() + make_interval(secs => $1), last_error = $2, updated_at = now()
       WHERE scheduled_post_id = $3 AND tenant_id = $4 AND status = 'publishing' AND claim_token = $5`,
      [Math.ceil(waitMs / 1000), error.slice(0, 120), row.scheduled_post_id, row.tenant_id, row.claim_token]);
    report.retried += 1;
    await this.audit(row.tenant_id, row.post_id, requestId, 'social.scheduler', 'allow', `retry:${error.slice(0, 60)}:attempt_${row.attempts}`, row.scheduled_post_id);
    log.warn('social.scheduler.retry', 'scheduled post publish failed; will retry', {
      tenant_id: row.tenant_id, scheduled_post_id: row.scheduled_post_id, attempt: row.attempts, wait_ms: waitMs, code: error.slice(0, 60),
    });
  }

  private async markUncertain(row: ClaimedRow, requestId: string, report: SchedulerTickReport, error: string, keepSince = false, externalRef: string | null = null): Promise<void> {
    await this.deps.pool.query(
      `UPDATE scheduled_post SET status = 'uncertain', claim_token = NULL, lease_until = NULL,
         uncertain_since = CASE WHEN $6 THEN COALESCE(uncertain_since, now()) ELSE now() END,
         next_attempt_at = now() + make_interval(secs => $1), last_error = $2, updated_at = now(),
         external_ref = COALESCE($7, external_ref)
       WHERE scheduled_post_id = $3 AND tenant_id = $4 AND status = 'publishing' AND claim_token = $5`,
      [Math.ceil(backoffMs(row.attempts) / 1000), error.slice(0, 120), row.scheduled_post_id, row.tenant_id, row.claim_token, keepSince, externalRef]);
    report.uncertain += 1;
    await this.audit(row.tenant_id, row.post_id, requestId, 'social.scheduler', 'allow', `uncertain:${error.slice(0, 60)}`, row.scheduled_post_id);
    log.warn('social.scheduler.uncertain', 'publish outcome unknown; will reconcile with provider before any retry', {
      tenant_id: row.tenant_id, scheduled_post_id: row.scheduled_post_id, attempt: row.attempts, code: error.slice(0, 60),
    });
  }

  private async fail(row: ClaimedRow, post: SocialPostRow | null, requestId: string, report: SchedulerTickReport, error: string): Promise<void> {
    await runAtomic(this.deps.pool, async (client) => {
      await this.release(row, 'failed', error, client);
      if (post) {
        await client.query(
          `UPDATE social_post SET status = 'failed', updated_at = now() WHERE post_id = $1 AND tenant_id = $2 AND status = 'scheduled'`,
          [post.post_id, row.tenant_id]);
      }
      await this.deps.sink.write({
        tenant_id: row.tenant_id, actor_id: SCHEDULER_ACTOR, actor_role: null,
        action: 'social.published', resource: `social_post/${row.post_id}`,
        request_id: requestId, decision: 'deny', result: `failed:${error.slice(0, 60)}`, evidence_ref: row.scheduled_post_id,
      }, client);
    });
    report.failed += 1;
    log.error('social.scheduler.failed', 'scheduled post needs human review', {
      tenant_id: row.tenant_id, scheduled_post_id: row.scheduled_post_id, post_id: row.post_id, code: error.slice(0, 80),
    });
  }

  private async release(row: ClaimedRow, status: 'skipped' | 'blocked' | 'failed', error: string, db: Pool | PoolClient = this.deps.pool): Promise<void> {
    await db.query(
      `UPDATE scheduled_post SET status = $1, claim_token = NULL, lease_until = NULL, last_error = $2, processed_at = now(), updated_at = now()
       WHERE scheduled_post_id = $3 AND tenant_id = $4 AND status = 'publishing' AND claim_token = $5`,
      [status, error.slice(0, 120), row.scheduled_post_id, row.tenant_id, row.claim_token]);
  }

  private async audit(tenantId: string, postId: string, requestId: string, action: string, decision: 'allow' | 'deny', result: string, evidenceRef: string): Promise<void> {
    await this.deps.sink.write({
      tenant_id: tenantId, actor_id: SCHEDULER_ACTOR, actor_role: null, action, resource: `social_post/${postId}`,
      request_id: requestId, decision, result, evidence_ref: evidenceRef,
    }, this.deps.pool, false).catch(() => undefined);
  }
}
