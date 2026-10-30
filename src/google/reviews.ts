/**
 * DEV-E2E-04 §2A — reseñas REALES de Google Business Profile (My Business API v4, host
 * mybusiness.googleapis.com), por negocio y a través de su conexión OAuth. Sustituye al
 * adaptador tentativo de src/reputation/google.ts (token global, tenant_id como cuenta).
 *
 *  - Ingesta incremental: `reviews.list` ordenado por updateTime desc, paginado con pageToken;
 *    se detiene al llegar al cursor (updateTime de la última reseña ya conocida). El cursor solo
 *    avanza sobre reseñas que ya existen en `review`, así un lote cuya ingesta falle se vuelve a
 *    ver en el siguiente ciclo. Dedupe por nombre de recurso (UNIQUE tenant+source_review_id).
 *  - source_review_id = `accounts/{a}/locations/{l}/reviews/{r}` (lo que exige updateReply).
 *  - Reconciliación: una reseña que ya tiene `reviewReply` (respondida fuera de MainSpot) pasa a
 *    `published` con reply_origin='google'; el observador cierra su caso (closed_elsewhere).
 *  - Respuesta: `PUT …/reviews/{r}/reply` y lectura posterior para confirmar; idempotente (misma
 *    respuesta ya publicada ⇒ ok sin reenviar). El replier del agente NUNCA pisa una respuesta
 *    distinta existente (already_replied_elsewhere, no reintentable).
 *  - Sin conexión `connected` no se llama a Google y no se inventa nada: lista vacía / error
 *    explícito. Un fallo de Google nunca borra reseñas ni casos.
 */

import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import type { ProviderConnection, ProviderConnectionRepository } from '../connectors/repository.ts';
import type { EngagementReplier, ReplyInput, ReplyResult } from '../engagement/providers.ts';
import type { PublicResponseResult, ReputationProvider, ReviewInput } from '../reputation/provider.ts';
import { log } from '../shared/logger.ts';
import { GOOGLE_PROVIDER, GoogleApiError, GoogleBusinessClient, starRatingToNumber, type GoogleReview } from './client.ts';

export const ANONYMOUS_REVIEWER = 'Cliente de Google';

export interface GoogleReviewsDeps {
  pool: Pool;
  sink: AuditSink;
  connections: ProviderConnectionRepository;
  client: GoogleBusinessClient;
}

function toInput(r: GoogleReview): ReviewInput | null {
  const rating = starRatingToNumber(r.starRating);
  if (!r.name || rating === 0) return null;
  return {
    source_review_id: r.name,
    author_name: (r.reviewer?.isAnonymous ? '' : r.reviewer?.displayName?.trim()) || ANONYMOUS_REVIEWER,
    star_rating: rating,
    review_text: r.comment ?? '',
    source: 'google',
  };
}

/** Lista/reconcilia reseñas y publica respuestas aprobadas (ReputationProvider para el motor y el publisher). */
export class GoogleReputationProvider implements ReputationProvider {
  readonly provider = 'google_business_profile' as const;
  private readonly deps: GoogleReviewsDeps;

  constructor(deps: GoogleReviewsDeps) {
    this.deps = deps;
  }

  /** Conexión utilizable o null (no conectado ⇒ el negocio sigue sin reseñas reales, sin error). */
  async connected(tenantId: string): Promise<{ conn: ProviderConnection; parent: string } | null> {
    const conn = await this.deps.connections.get(tenantId, GOOGLE_PROVIDER);
    const parent = conn?.external_account_id && conn.external_resource_id ? `${conn.external_account_id}/${conn.external_resource_id}` : null;
    if (!conn || !parent || !conn.has_token || conn.status === 'disconnected' || conn.status === 'needs_authorization' || conn.status === 'permission_missing') return null;
    return { conn, parent };
  }

  async listReviews(tenantId: string): Promise<ReviewInput[]> {
    const c = await this.connected(tenantId);
    if (!c) return [];
    const cursorRow = await this.deps.pool.query<{ last_update_time: string | null }>(
      'SELECT last_update_time FROM google_review_cursor WHERE tenant_id = $1 AND location_parent = $2', [tenantId, c.parent]);
    const cursor = cursorRow.rows[0]?.last_update_time ? Date.parse(cursorRow.rows[0].last_update_time) : null;

    const seen = new Map<string, GoogleReview>();
    let pageToken: string | null = null;
    const pageTokens = new Set<string>();
    let reachedCursor = false;
    do {
      if (pageToken) {
        if (pageTokens.has(pageToken)) throw new GoogleApiError('invalid_request', 502, 'repeated_page_token');
        pageTokens.add(pageToken);
      }
      const page = await this.deps.client.listReviews(tenantId, c.parent, pageToken);
      for (const r of page.reviews) {
        const updated = r.updateTime ? Date.parse(r.updateTime) : NaN;
        if (cursor !== null && Number.isFinite(updated) && updated < cursor) { reachedCursor = true; continue; }
        if (!seen.has(r.name)) seen.set(r.name, r);
      }
      pageToken = reachedCursor ? null : page.nextPageToken;
    } while (pageToken);

    const batch = [...seen.values()];
    await this.reconcile(tenantId, c.parent, batch);
    return batch.map(toInput).filter((x): x is ReviewInput => x !== null);
  }

  /**
   * Marca las filas ya existentes como vistas (source_updated_at), cierra como publicadas las que
   * Google ya muestra respondidas y avanza el cursor solo hasta la última reseña conocida.
   */
  private async reconcile(tenantId: string, parent: string, batch: GoogleReview[]): Promise<void> {
    const names = batch.map((r) => r.name);
    const existing = names.length
      ? await this.deps.pool.query<{ source_review_id: string }>(
        'SELECT source_review_id FROM review WHERE tenant_id = $1 AND source_review_id = ANY($2)', [tenantId, names])
      : { rows: [] as Array<{ source_review_id: string }> };
    const known = new Set(existing.rows.map((r) => r.source_review_id));
    let cursorMs: number | null = null;
    for (const r of batch) {
      if (!known.has(r.name)) continue;
      const updated = r.updateTime ? Date.parse(r.updateTime) : NaN;
      if (known.size === names.length && Number.isFinite(updated)) cursorMs = cursorMs === null ? updated : Math.max(cursorMs, updated);
      await this.deps.pool.query(
        `UPDATE review SET source_updated_at = $3, google_synced_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND source_review_id = $2`, [tenantId, r.name, r.updateTime ?? null]);
      if (r.reviewReply?.comment) {
        const closed = await this.deps.pool.query(
          `UPDATE review SET state = 'published', published_text = $3, published_at = COALESCE($4::timestamptz, now()),
                  reply_origin = COALESCE(reply_origin, 'google'), updated_at = now()
            WHERE tenant_id = $1 AND source_review_id = $2 AND state <> 'published' AND content_purged_at IS NULL RETURNING review_id`, [tenantId, r.name, r.reviewReply.comment, r.reviewReply.updateTime ?? null]);
        if (closed.rowCount) {
          await this.deps.sink.write({
            tenant_id: tenantId, actor_id: 'system:google-sync', actor_role: null,
            action: 'reputation.review.reconciled', resource: `review/${closed.rows[0]!.review_id}`,
            request_id: `gsync_${Date.now()}`, decision: 'allow', result: 'answered_outside_mainspot',
          });
        }
      }
    }
    await this.deps.pool.query(
      `INSERT INTO google_review_cursor (tenant_id, location_parent, last_update_time, last_synced_at)
       VALUES ($1, $2, to_timestamp($3::double precision / 1000.0), now())
       ON CONFLICT (tenant_id) DO UPDATE SET location_parent = EXCLUDED.location_parent,
         last_update_time = GREATEST(COALESCE(google_review_cursor.last_update_time, 'epoch'::timestamptz), COALESCE(EXCLUDED.last_update_time, 'epoch'::timestamptz)),
         last_synced_at = now(), updated_at = now()`,
      [tenantId, parent, cursorMs]);
  }

  /**
   * Respuesta pública aprobada por una persona (ReputationPublisher). Idempotente: si Google ya
   * muestra exactamente ese texto no se reenvía. Confirmación por lectura posterior.
   */
  async postPublicResponse(tenantId: string, sourceReviewId: string, text: string): Promise<PublicResponseResult> {
    const r = await this.reply(tenantId, sourceReviewId, text, { overwrite: true });
    return r.ok ? { ok: true, external_ref: r.external_ref } : { ok: false, external_ref: `gbp:${sourceReviewId}:failed`, error: r.error };
  }

  /** Núcleo compartido con el replier del agente. */
  async reply(tenantId: string, reviewName: string, text: string, opts: { overwrite: boolean }): Promise<ReplyResult> {
    const c = await this.connected(tenantId);
    if (!c) return { ok: false, error: 'google_not_connected', retryable: false };
    if (!reviewName.startsWith(`${c.parent}/reviews/`)) return { ok: false, error: 'review_not_in_connected_location', retryable: false };
    const body = text.trim();
    if (!body) return { ok: false, error: 'empty_reply', retryable: false };
    try {
      const before = await this.deps.client.getReview(tenantId, reviewName);
      if (before.reviewReply?.comment) {
        if (before.reviewReply.comment.trim() === body) {
          return { ok: true, external_ref: `${reviewName}/reply@${before.reviewReply.updateTime ?? 'existing'}` };
        }
        if (!opts.overwrite) return { ok: false, error: 'already_replied_elsewhere', retryable: false };
      }
      await this.deps.client.updateReply(tenantId, reviewName, body);
      const after = await this.deps.client.getReview(tenantId, reviewName);
      if (after.reviewReply?.comment?.trim() !== body) {
        log.warn('google.reply.readback_mismatch', 'reply read-back differs from what was sent', { tenant_id: tenantId });
        return { ok: false, error: 'reply_readback_mismatch', retryable: false };
      }
      await this.deps.pool.query(
        `UPDATE review SET reply_origin = 'mainspot', source_updated_at = COALESCE($3::timestamptz, source_updated_at), updated_at = now()
          WHERE tenant_id = $1 AND source_review_id = $2`, [tenantId, reviewName, after.updateTime ?? null]);
      return { ok: true, external_ref: `${reviewName}/reply@${after.reviewReply.updateTime ?? 'confirmed'}` };
    } catch (err) {
      if (err instanceof GoogleApiError) return { ok: false, error: `gbp_${err.kind}:${err.reason}`.slice(0, 120), retryable: err.retryable };
      throw err;
    }
  }
}

/**
 * EngagementReplier para origin `google_review`. Idempotente (PUT + comprobación previa). Otros
 * orígenes van al `fallback` (p. ej. el replier de Meta o el simulador); sin fallback se rechazan.
 */
export class GoogleEngagementReplier implements EngagementReplier {
  readonly mode = 'real' as const;
  readonly idempotent: boolean;
  private readonly google: GoogleReputationProvider;
  private readonly fallback: EngagementReplier | null;

  constructor(google: GoogleReputationProvider, fallback: EngagementReplier | null = null) {
    this.google = google;
    this.fallback = fallback;
    this.idempotent = fallback ? fallback.idempotent : true;
  }

  async reply(input: ReplyInput): Promise<ReplyResult> {
    if (input.origin !== 'google_review') {
      return this.fallback ? this.fallback.reply(input) : { ok: false, error: 'origin_not_supported', retryable: false };
    }
    return this.google.reply(input.tenantId, input.targetRef, input.text, { overwrite: false });
  }
}
