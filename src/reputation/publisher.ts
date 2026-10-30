/**
 * ReputationPublisher (INC-004) — efecto de publicación de una respuesta
 * pública a reseña. SOLO se invoca tras preview/aprobación humana desde la
 * state machine (DEC-011, RULE-003, FLOW-002). Idempotente: un proposal ya
 * publicado nunca vuelve a publicar (unique de publication = backstop; este
 * publisher además es seguro por sí mismo).
 */

import type { Pool } from 'pg';
import type { DbExecutor, PublishResult, Publisher, PublisherContext } from '../publishing/publisher.ts';
import type { ReputationProvider } from './provider.ts';
import type { ReviewRow } from './engine.ts';
import type { AuditSink } from '../audit/sink.ts';

export function extractReputationPayload(payload: Record<string, unknown>): { reviewId: string; responseText: string; authorName?: string } {
  const reviewId = typeof payload['review_id'] === 'string' ? payload['review_id'] : '';
  const responseText = typeof payload['response_text'] === 'string' ? payload['response_text'] : '';
  return { reviewId, responseText, authorName: typeof payload['author_name'] === 'string' ? payload['author_name'] : undefined };
}

export class ReputationPublisher implements Publisher {
  readonly name = 'reputation' as const;
  private readonly pool: Pool;
  private readonly provider: ReputationProvider;
  private readonly sink: AuditSink;

  constructor(pool: Pool, provider: ReputationProvider, sink: AuditSink) {
    this.pool = pool;
    this.provider = provider;
    this.sink = sink;
  }

  async publish(ctx: PublisherContext, db?: DbExecutor): Promise<PublishResult> {
    const { reviewId, responseText } = extractReputationPayload(ctx.payload);
    if (!reviewId || !responseText) {
      return { ok: false, external_ref: `reputation_missing_payload:${ctx.proposalId}`, error: 'reputation_payload_invalid' };
    }
    const conn: DbExecutor = db ?? this.pool;
    const res = await conn.query<ReviewRow>('SELECT * FROM review WHERE review_id = $1 AND tenant_id = $2', [reviewId, ctx.tenantId]);
    const review = res.rows[0] ?? null;
    if (!review) {
      return { ok: false, external_ref: `review_not_found:${reviewId}`, error: 'review_not_found' };
    }

    // Idempotencia propia: ya publicada ⇒ devolver el mismo ref (sin duplicar).
    if (review.state === 'published' && review.published_text) {
      const ref = `gbp:sim:${ctx.tenantId}:${review.source_review_id}:reuse`;
      return { ok: true, version: 1, external_ref: ref };
    }

    // FR-0016: una sola respuesta pública por reseña entre todos los caminos (agente de atención,
    // panel, Telegram, reputación). Si otro camino ya la reclamó, aquí no se publica.
    const owner = `proposal:${ctx.proposalId}`;
    const claim = await conn.query(
      `INSERT INTO response_ledger (tenant_id, origin, target_ref, path, owner_ref) VALUES ($1,'google_review',$2,'reputation',$3)
       ON CONFLICT (tenant_id, origin, target_ref) DO UPDATE SET updated_at = now() WHERE response_ledger.owner_ref = EXCLUDED.owner_ref
       RETURNING owner_ref`, [ctx.tenantId, review.source_review_id, owner]);
    if (!claim.rowCount) {
      return { ok: false, external_ref: `answered_elsewhere:${reviewId}`, error: 'answered_elsewhere' };
    }

    // Efecto externo REAL (simulado sin token): publicación de la respuesta.
    const result = await this.provider.postPublicResponse(ctx.tenantId, review.source_review_id, responseText);
    if (!result.ok) {
      return { ok: false, external_ref: result.external_ref, error: result.error ?? 'gbp_publish_failed' };
    }

    await conn.query(
      `UPDATE review SET state = 'published', published_text = $1, published_at = now(), updated_at = now()
       WHERE review_id = $2 AND tenant_id = $3`,
      [responseText, reviewId, ctx.tenantId],
    );
    await conn.query(`UPDATE response_ledger SET state = 'sent', external_ref = $4, updated_at = now() WHERE tenant_id = $1 AND origin = 'google_review' AND target_ref = $2 AND owner_ref = $3`,
      [ctx.tenantId, review.source_review_id, owner, result.external_ref]);
    await this.sink.write({
      tenant_id: ctx.tenantId, actor_id: ctx.proposalId, actor_role: null,
      action: 'reputation.published', resource: `review/${reviewId}`,
      request_id: `pub_${ctx.proposalId}`, decision: 'allow', result: 'published',
      evidence_ref: result.external_ref,
    }, conn);
    return { ok: true, version: 1, external_ref: result.external_ref };
  }
}
