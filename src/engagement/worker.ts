/**
 * Observador del agente de atención (DEV-E2E-02, SHARED-CONTRACT §B): corre sin navegador,
 * dentro del proceso del servidor o como proceso propio (`scripts/engagement-worker.ts`).
 *
 * Por tenant activo y con candado consultivo de sesión (un solo procesador por tenant aunque
 * haya varios procesos): ingesta Google (vía ReputationEngine.sync: cuota, clasificación y
 * dedupe existentes) y Facebook (cursor persistente) → recupera envíos interrumpidos → cierra
 * casos ya respondidos por la vía de reseñas → clasifica → responde lo debido → avisa.
 * Fallos de ingesta: backoff exponencial por (tenant, origen), sin detener a los demás.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ReputationEngine } from '../reputation/engine.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import type { CommentSource } from './providers.ts';
import { SYSTEM_ACTOR, type CaseRow, type EngagementService } from './service.ts';

export interface EngagementWorkerDeps {
  pool: Pool;
  service: EngagementService;
  reputationEngine: ReputationEngine;
  comments: CommentSource;
  /** Cadencia de sondeo por origen cuando no hay fallos (0 en pruebas). */
  pollIntervalMs: number;
}

export interface TenantTickReport {
  tenant_id: string;
  skipped_locked: boolean;
  ingested: { google_review: number; facebook_comment: number };
  ingest_errors: string[];
  recovered: number;
  closed_elsewhere: number;
  classified: number;
  responded: number;
  notifications: { sent: number; failed: number; no_destination: number };
}

const BATCH = 20;
const MAX_POLL_BACKOFF_S = 900;

export class EngagementWorker {
  private readonly deps: EngagementWorkerDeps;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: EngagementWorkerDeps) {
    this.deps = deps;
  }

  /** Arranca el bucle periódico (sin solapes; el temporizador no mantiene vivo el proceso). */
  start(intervalMs: number): void {
    if (this.timer) return;
    const run = () => {
      if (this.running) return;
      this.running = true;
      this.tick()
        .catch((err: unknown) => log.error('engagement.tick.failed', 'engagement tick failed', { error_name: err instanceof Error ? err.name : 'unknown' }))
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

  async tick(): Promise<TenantTickReport[]> {
    const tenants = await this.deps.pool.query<{ client_id: string }>(`SELECT client_id FROM client WHERE status = 'active' ORDER BY client_id`);
    const reports: TenantTickReport[] = [];
    for (const { client_id } of tenants.rows) {
      reports.push(await this.tickTenant(client_id));
    }
    return reports;
  }

  /** Procesa un tenant. `force` sondea aunque no toque por cadencia (salvo backoff por fallos). */
  async tickTenant(tenantId: string, force = false): Promise<TenantTickReport> {
    const report: TenantTickReport = {
      tenant_id: tenantId, skipped_locked: false, ingested: { google_review: 0, facebook_comment: 0 }, ingest_errors: [],
      recovered: 0, closed_elsewhere: 0, classified: 0, responded: 0, notifications: { sent: 0, failed: 0, no_destination: 0 },
    };
    const lockKey = `engagement:${tenantId}`;
    const lockClient = await this.deps.pool.connect();
    try {
      const got = await lockClient.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey]);
      if (!got.rows[0]?.ok) {
        report.skipped_locked = true;
        return report;
      }
      try {
        report.ingested.google_review = await this.ingestGoogle(tenantId, force, report);
        report.ingested.facebook_comment = await this.ingestFacebook(tenantId, force, report);
        report.recovered = await this.recoverStale(tenantId);
        report.closed_elsewhere = await this.closeAnsweredElsewhere(tenantId);
        report.classified = await this.classifyReceived(tenantId);
        report.responded = await this.respondDue(tenantId);
        report.notifications = await this.deps.service.dispatchNotifications(tenantId);
      } finally {
        await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
      }
    } finally {
      lockClient.release();
    }
    return report;
  }

  private async pollDue(tenantId: string, origin: string, force: boolean): Promise<{ due: boolean; cursor: string | null }> {
    const res = await this.deps.pool.query<{ cursor: string | null; due: boolean; failures: number }>(
      `SELECT cursor, (next_poll_at IS NULL OR next_poll_at <= now()) AS due, consecutive_failures AS failures
         FROM engagement_cursor WHERE tenant_id = $1 AND origin = $2`, [tenantId, origin]);
    const row = res.rows[0];
    if (!row) return { due: true, cursor: null };
    return { due: row.due || (force && row.failures === 0), cursor: row.cursor };
  }

  private async pollSucceeded(tenantId: string, origin: string, cursor: string | null): Promise<void> {
    await this.deps.pool.query(
      `INSERT INTO engagement_cursor (tenant_id, origin, cursor, last_polled_at, next_poll_at, consecutive_failures, last_error)
       VALUES ($1,$2,$3, now(), now() + make_interval(secs => $4), 0, NULL)
       ON CONFLICT (tenant_id, origin) DO UPDATE SET cursor = EXCLUDED.cursor, last_polled_at = now(),
         next_poll_at = EXCLUDED.next_poll_at, consecutive_failures = 0, last_error = NULL`,
      [tenantId, origin, cursor, this.deps.pollIntervalMs / 1000]);
  }

  private async pollFailed(tenantId: string, origin: string, err: unknown, report: TenantTickReport): Promise<void> {
    const code = err instanceof AppError ? err.code : err instanceof Error ? err.message.slice(0, 60) : 'unknown';
    report.ingest_errors.push(`${origin}:${code}`);
    await this.deps.pool.query(
      `INSERT INTO engagement_cursor (tenant_id, origin, last_polled_at, next_poll_at, consecutive_failures, last_error)
       VALUES ($1,$2, now(), now() + make_interval(secs => 5), 1, $3)
       ON CONFLICT (tenant_id, origin) DO UPDATE SET last_polled_at = now(),
         consecutive_failures = engagement_cursor.consecutive_failures + 1, last_error = EXCLUDED.last_error,
         next_poll_at = now() + make_interval(secs => LEAST($4, 5 * power(2, engagement_cursor.consecutive_failures))::int)`,
      [tenantId, origin, code, MAX_POLL_BACKOFF_S]);
    log.warn('engagement.poll.failed', 'provider poll failed; backing off', { tenant_id: tenantId, origin, code });
  }

  /** Google: reutiliza ReputationEngine.sync (cuota, dedupe por source_review_id, auditoría). */
  private async ingestGoogle(tenantId: string, force: boolean, report: TenantTickReport): Promise<number> {
    const { due } = await this.pollDue(tenantId, 'google_review', force);
    if (!due) return 0;
    try {
      await this.deps.reputationEngine.sync(tenantId, SYSTEM_ACTOR, `eng_sync_${randomUUID()}`, null);
    } catch (err) {
      await this.pollFailed(tenantId, 'google_review', err, report);
      return 0;
    }
    const inserted = await this.deps.pool.query(
      `INSERT INTO engagement_case (case_id, tenant_id, origin, external_ref, review_id, author_label, body, rating, state)
       SELECT 'case_' || replace(gen_random_uuid()::text, '-', ''), r.tenant_id, 'google_review', r.source_review_id,
              r.review_id, r.author_name, r.review_text, r.star_rating, 'received'
         FROM review r
        WHERE r.tenant_id = $1 AND r.state NOT IN ('published','rejected')
       ON CONFLICT (tenant_id, origin, external_ref) DO NOTHING RETURNING case_id`, [tenantId]);
    await this.pollSucceeded(tenantId, 'google_review', null);
    return inserted.rowCount ?? 0;
  }

  /** Facebook: comentarios de publicaciones PUBLICADAS del tenant; cursor avanzado en la misma tx. */
  private async ingestFacebook(tenantId: string, force: boolean, report: TenantTickReport): Promise<number> {
    const { due, cursor } = await this.pollDue(tenantId, 'facebook_comment', force);
    if (!due) return 0;
    let page;
    try {
      page = await this.deps.comments.listSince(tenantId, cursor);
    } catch (err) {
      await this.pollFailed(tenantId, 'facebook_comment', err, report);
      return 0;
    }
    let count = 0;
    const client = await this.deps.pool.connect();
    try {
      await client.query('BEGIN');
      for (const c of page.items) {
        const post = await client.query<{ post_id: string }>(
          `SELECT post_id FROM social_post WHERE tenant_id = $1 AND status = 'published' AND (post_id = $2 OR external_ref = $2)`,
          [tenantId, c.post_ref]);
        const postId = post.rows[0]?.post_id;
        if (!postId) {
          log.warn('engagement.comment.unknown_post', 'comment for an unknown/unpublished post skipped', { tenant_id: tenantId });
          continue;
        }
        const ins = await client.query(
          `INSERT INTO engagement_case (case_id, tenant_id, origin, external_ref, post_id, author_label, body, state)
           VALUES ('case_' || replace(gen_random_uuid()::text, '-', ''), $1, 'facebook_comment', $2, $3, $4, $5, 'received')
           ON CONFLICT (tenant_id, origin, external_ref) DO NOTHING`,
          [tenantId, c.external_ref, postId, c.author_label.slice(0, 120), c.body.slice(0, 4000)]);
        count += ins.rowCount ?? 0;
      }
      await client.query(
        `INSERT INTO engagement_cursor (tenant_id, origin, cursor, last_polled_at, next_poll_at, consecutive_failures, last_error)
         VALUES ($1, 'facebook_comment', $2, now(), now() + make_interval(secs => $3), 0, NULL)
         ON CONFLICT (tenant_id, origin) DO UPDATE SET cursor = EXCLUDED.cursor, last_polled_at = now(),
           next_poll_at = EXCLUDED.next_poll_at, consecutive_failures = 0, last_error = NULL`,
        [tenantId, page.cursor, this.deps.pollIntervalMs / 1000]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      await this.pollFailed(tenantId, 'facebook_comment', err, report);
      return 0;
    } finally {
      client.release();
    }
    return count;
  }

  /**
   * Envíos interrumpidos (lease vencido): con proveedor idempotente se reintentan sin riesgo de
   * duplicar; si no, pasan a revisión humana (entrega incierta) en vez de reenviar a ciegas.
   */
  private async recoverStale(tenantId: string): Promise<number> {
    const idempotent = this.deps.service.deps.replier.idempotent;
    const res = idempotent
      ? await this.deps.pool.query(
        `UPDATE engagement_case SET state = 'retry_pending', next_attempt_at = now(), lease_until = NULL,
           last_error = 'interrupted', updated_at = now()
         WHERE tenant_id = $1 AND state = 'responding' AND lease_until < now()`, [tenantId])
      : await this.deps.pool.query(
        `UPDATE engagement_case SET state = 'needs_human', reason = 'delivery_uncertain', lease_until = NULL,
           drafts = CASE WHEN jsonb_array_length(drafts) = 0 THEN jsonb_build_array(response_text) ELSE drafts END,
           notify_status = 'pending', updated_at = now()
         WHERE tenant_id = $1 AND state = 'responding' AND lease_until < now()`, [tenantId]);
    return res.rowCount ?? 0;
  }

  /** Reseñas respondidas por la vía de reputación (preview/aprobación) cierran su caso: sin doble respuesta. */
  private async closeAnsweredElsewhere(tenantId: string): Promise<number> {
    const res = await this.deps.pool.query(
      `UPDATE engagement_case c SET state = 'closed_elsewhere', reason = 'answered_in_reviews', updated_at = now()
         FROM review r
        WHERE c.tenant_id = $1 AND c.review_id = r.review_id AND r.state = 'published'
          AND c.state IN ('received','classified','needs_human','failed','retry_pending','approved')`, [tenantId]);
    return res.rowCount ?? 0;
  }

  private async classifyReceived(tenantId: string): Promise<number> {
    const rows = await this.deps.pool.query<CaseRow>(
      `SELECT * FROM engagement_case WHERE tenant_id = $1 AND state = 'received' ORDER BY created_at LIMIT $2`, [tenantId, BATCH]);
    let n = 0;
    for (const row of rows.rows) {
      if (await this.deps.service.classifyCase(row)) n += 1;
    }
    return n;
  }

  private async respondDue(tenantId: string): Promise<number> {
    const rows = await this.deps.pool.query<{ case_id: string }>(
      `SELECT case_id FROM engagement_case WHERE tenant_id = $1
         AND (state IN ('classified','approved') OR (state = 'retry_pending' AND next_attempt_at <= now()))
       ORDER BY created_at LIMIT $2`, [tenantId, BATCH]);
    let n = 0;
    for (const { case_id } of rows.rows) {
      const done = await this.deps.service.respondCase(case_id);
      if (done?.state === 'responded') n += 1;
    }
    return n;
  }
}
