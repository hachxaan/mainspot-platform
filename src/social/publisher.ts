/**
 * SocialPublisher (INC-005) — efecto de publicación social. Solo se invoca tras
 * preview/aprobación humana desde la state machine (RULE-003, FLOW-002).
 *
 * - Sin fecha futura ⇒ publicación INMEDIATA (una vez, idempotente). Si el
 *   proveedor real no confirma el resultado (timeout), la fila de cola queda
 *   'uncertain' para que el SocialScheduler la reconcilie: nunca se reenvía a
 *   ciegas ni se marca published sin acuse.
 * - Con fecha futura ⇒ crea/actualiza la fila de cola scheduled_post con
 *   status='scheduled' y proposal_id=ctx.proposalId (PR-01: la cola SOLO
 *   existe tras aprobación); el SocialScheduler publica automáticamente al
 *   llegar la fecha y verifica la aprobación de nuevo.
 */

import type { Pool } from 'pg';
import type { DbExecutor, PublishResult, Publisher, PublisherContext } from '../publishing/publisher.ts';
import type { SocialProvider } from './provider.ts';
import type { SocialPostRow } from './service.ts';
import type { AuditSink } from '../audit/sink.ts';

export function extractSocialPayload(payload: Record<string, unknown>): { postId: string } {
  return { postId: typeof payload['post_id'] === 'string' ? payload['post_id'] : '' };
}

export class SocialPublisher implements Publisher {
  readonly name = 'social' as const;
  private readonly pool: Pool;
  private readonly provider: SocialProvider;
  private readonly sink: AuditSink;

  constructor(pool: Pool, provider: SocialProvider, sink: AuditSink) {
    this.pool = pool;
    this.provider = provider;
    this.sink = sink;
  }

  async publish(ctx: PublisherContext, db?: DbExecutor): Promise<PublishResult> {
    const { postId } = extractSocialPayload(ctx.payload);
    if (!postId) {
      return { ok: false, external_ref: `social_missing_payload:${ctx.proposalId}`, error: 'social_payload_invalid' };
    }
    const conn: DbExecutor = db ?? this.pool;
    const res = await conn.query<SocialPostRow>('SELECT * FROM social_post WHERE post_id = $1 AND tenant_id = $2', [postId, ctx.tenantId]);
    const post = res.rows[0] ?? null;
    if (!post) {
      return { ok: false, external_ref: `social_post_not_found:${postId}`, error: 'social_post_not_found' };
    }

    // Idempotencia: ya publicada ⇒ mismo ref (replay seguro, AC-007).
    if (post.status === 'published' && post.external_ref) {
      return { ok: true, version: 1, external_ref: post.external_ref };
    }

    const scheduledAt = post.scheduled_at ? new Date(post.scheduled_at).getTime() : 0;
    const future = scheduledAt > Date.now();

    // Meta no ofrece idempotencia nativa: encolar incluso «ahora» ANTES de salir a la red.
    // Así un crash tras POST pero antes del COMMIT no pierde la prueba de que pudo enviarse.
    if (future || !this.provider.idempotentPublish) {
      // PR-01: la aprobación HUMANA ya ocurrió (este publisher solo se alcanza
      // desde la state machine). Materializamos la cola CON la referencia a la
      // proposal aprobada; el tick la publicará al llegar la fecha.
      await conn.query(
        `INSERT INTO scheduled_post (scheduled_post_id, tenant_id, post_id, proposal_id, publish_at, status, publish_key, created_at)
         VALUES ($1,$2,$3,$4,$5,'scheduled',$1, now())
         ON CONFLICT (post_id) DO UPDATE SET
           publish_at = EXCLUDED.publish_at,
           status = 'scheduled',
           proposal_id = EXCLUDED.proposal_id,
           external_ref = NULL,
           processed_at = NULL,
           attempts = 0, claim_token = NULL, lease_until = NULL, next_attempt_at = NULL,
           last_error = NULL, uncertain_since = NULL, updated_at = now()`,
        [`sp_${crypto.randomUUID()}`, ctx.tenantId, postId, ctx.proposalId, post.scheduled_at ?? new Date().toISOString()],
      );
      await conn.query(
        `UPDATE social_post SET status = 'scheduled', updated_at = now() WHERE post_id = $1 AND tenant_id = $2 AND status <> 'published'`,
        [postId, ctx.tenantId],
      );
      return { ok: true, version: 1, external_ref: `${this.provider.provider === 'simulated' ? 'sim:fb' : 'meta'}:scheduled:${postId}` };
    }

    // Publicación inmediata (sin fecha o fecha ya vencida durante la aprobación).
    const result = await this.provider.publishPost({
      tenantId: ctx.tenantId,
      text: post.text,
      imageUrl: post.image_url,
      contentType: post.content_type,
      idempotencyKey: `post:${postId}`,
    });
    if (!result.ok && result.uncertain && !this.provider.idempotentPublish) {
      // Resultado desconocido (timeout tras enviar): NO se reintenta a ciegas. La fila de
      // cola queda 'uncertain' y el scheduler reconcilia leyendo del proveedor; el post
      // sigue 'scheduled' (nunca un `published` ficticio) hasta confirmar.
      await conn.query(
        `INSERT INTO scheduled_post (scheduled_post_id, tenant_id, post_id, proposal_id, publish_at, status, uncertain_since, last_error, publish_key, created_at)
         VALUES ($1,$2,$3,$4, now(), 'uncertain', now(), $5, $6, now())
         ON CONFLICT (post_id) DO UPDATE SET
           status = 'uncertain', uncertain_since = now(), last_error = EXCLUDED.last_error,
           proposal_id = EXCLUDED.proposal_id, claim_token = NULL, lease_until = NULL, updated_at = now()`,
        [`sp_${crypto.randomUUID()}`, ctx.tenantId, postId, ctx.proposalId, (result.error ?? 'provider_timeout').slice(0, 120), `post:${postId}`],
      );
      await conn.query(
        `UPDATE social_post SET status = 'scheduled', scheduled_at = COALESCE(scheduled_at, now()), updated_at = now()
         WHERE post_id = $1 AND tenant_id = $2 AND status <> 'published'`,
        [postId, ctx.tenantId],
      );
      await this.sink.write({
        tenant_id: ctx.tenantId, actor_id: ctx.proposalId, actor_role: null,
        action: 'social.published', resource: `social_post/${postId}`,
        request_id: `pub_${ctx.proposalId}`, decision: 'allow', result: 'publish_uncertain:reconcile_pending',
        evidence_ref: result.external_ref,
      }, conn);
      return { ok: true, version: 1, external_ref: `uncertain:fb:${postId}` };
    }
    if (!result.ok) {
      return { ok: false, external_ref: result.external_ref, error: result.error ?? 'social_publish_failed' };
    }

    await conn.query(
      `UPDATE social_post SET status = 'published', published_at = now(), external_ref = $1, updated_at = now()
       WHERE post_id = $2 AND tenant_id = $3`,
      [result.external_ref, postId, ctx.tenantId],
    );
    // Si había cola del mismo post (fecha vencida durante la aprobación),
    // marcarla publicada (idempotente: solo filas aún no publicadas).
    await conn.query(
      `UPDATE scheduled_post SET status = 'published', external_ref = $1, processed_at = now(),
         claim_token = NULL, lease_until = NULL, uncertain_since = NULL, updated_at = now()
       WHERE post_id = $2 AND tenant_id = $3 AND status IN ('scheduled','pending','uncertain','failed')`,
      [result.external_ref, postId, ctx.tenantId],
    );
    await this.sink.write({
      tenant_id: ctx.tenantId, actor_id: ctx.proposalId, actor_role: null,
      action: 'social.published', resource: `social_post/${postId}`,
      request_id: `pub_${ctx.proposalId}`, decision: 'allow', result: 'published',
      evidence_ref: result.external_ref,
    }, conn);
    return { ok: true, version: 1, external_ref: result.external_ref };
  }
}
