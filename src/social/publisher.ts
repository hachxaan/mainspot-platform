/**
 * SocialPublisher (INC-005) — efecto de publicación social. Solo se invoca tras
 * preview/aprobación humana desde la state machine (RULE-003, FLOW-002).
 *
 * - Sin fecha futura ⇒ publicación INMEDIATA (una vez, idempotente).
 * - Con fecha futura ⇒ queda 'scheduled' + cola pending; el tick
 *   (processDueScheduled) "publica" en el simulador al llegar la fecha.
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

    if (future && post.status !== 'scheduled') {
      // Aprobado pero programado a futuro: no publicar aún; la cola se procesa
      // con el tick manual (worker simple). La propuesta ya queda registrada.
      await conn.query(
        `UPDATE social_post SET status = 'scheduled', updated_at = now() WHERE post_id = $1 AND tenant_id = $2 AND status <> 'published'`,
        [postId, ctx.tenantId],
      );
      return { ok: true, version: 1, external_ref: `sim:fb:scheduled:${postId}` };
    }

    // Publicación inmediata (sin fecha o fecha ya vencida).
    const result = await this.provider.publishPost({
      tenantId: ctx.tenantId,
      text: post.text,
      imageUrl: post.image_url,
      contentType: post.content_type,
    });
    if (!result.ok) {
      return { ok: false, external_ref: result.external_ref, error: result.error ?? 'social_publish_failed' };
    }

    await conn.query(
      `UPDATE social_post SET status = 'published', published_at = now(), external_ref = $1, updated_at = now()
       WHERE post_id = $2 AND tenant_id = $3`,
      [result.external_ref, postId, ctx.tenantId],
    );
    // Si había cola pendiente del mismo post (fecha vencida durante la
    // aprobación), marcarla publicada (idempotente: solo si 'pending').
    await conn.query(
      `UPDATE scheduled_post SET status = 'published', external_ref = $1, processed_at = now()
       WHERE post_id = $2 AND tenant_id = $3 AND status = 'pending'`,
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
