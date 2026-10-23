/**
 * Reputation engine (INC-004, CAP-002/CAP-004, REQ-015, FLOW-004, DEC-011/023).
 *
 * Ingesta reseñas → clasifica por calificación vs REVIEW_THRESHOLD (default <4,
 * DEC-023) → sugiere borradores deterministas (solo 3 opciones, FLOW-004) →
 * escala a humano → la RESPUESTA PÚBLICA es un cambio visible que SOLO se
 * publica vía preview/aprobación humana (DEC-011 / RULE-003) reutilizando el
 * flujo conversacional de INC-002 (proposal con capability_target='reputation').
 *
 * Estados del caso (FLOW-004 adaptado):
 *   detected → suggested → awaiting_human → approved → published
 *   suggested/awaiting_human → edited (borrador corregido, nunca publicado)
 *   suggested/awaiting_human/edited/approved → rejected
 *
 * INVARIANTE: sin manipulación de opiniones — ocultar/borrar es PROHIBITED
 * (audit deny + AppError 403); no se publica nada sin preview/aprobación.
 */

import type { Pool, PoolClient } from 'pg';
import type { AppConfig } from '../shared/config.ts';
import type { AuditSink } from '../audit/sink.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import type { ReputationProvider, ReviewClassification, ReviewInput } from './provider.ts';
import { belowThreshold, classifyReview } from './provider.ts';
import { ConversationRepository, newConversationIds } from '../conversation/repositories.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import type { TenantBoundaryResult } from '../conversation/repositories.ts';
import type { QuotaLedger } from '../subscriptions/quota.ts';

export type ReviewState =
  | 'detected'
  | 'suggested'
  | 'awaiting_human'
  | 'approved'
  | 'published'
  | 'rejected'
  | 'edited'
  | 'acknowledged';

export interface ReviewRow {
  review_id: string;
  tenant_id: string;
  source: 'google';
  source_review_id: string;
  author_name: string;
  star_rating: number;
  review_text: string;
  classification: ReviewClassification;
  state: ReviewState;
  suggested_options: string[];
  response_text: string | null;
  proposal_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  published_text: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncOutcome {
  synced: number;
  skipped: number;
  classified: { acknowledged: number; suggested: number };
}

export interface ReputationEngineDeps {
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  provider: ReputationProvider;
  conversationRepo: ConversationRepository;
  /** DEC-0005: cuota `reviews_managed` consumida en la transacción del lote. */
  quota: QuotaLedger;
}

export class ReviewRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private assertTenant(tenantId: string): string {
    if (!tenantId) throw new Error('FAIL-CLOSED: review repository requires a tenant context');
    return tenantId;
  }

  async findScoped(tenantId: string, reviewId: string): Promise<TenantBoundaryResult<ReviewRow>> {
    const t = this.assertTenant(tenantId);
    const res = await this.pool.query<ReviewRow>('SELECT * FROM review WHERE review_id = $1', [reviewId]);
    const row = res.rows[0] ?? null;
    if (!row) return { found: false, in_tenant: false, row: null };
    return { found: true, in_tenant: row.tenant_id === t, row };
  }

  async list(tenantId: string, opts: { state?: ReviewState; limit?: number } = {}): Promise<ReviewRow[]> {
    const t = this.assertTenant(tenantId);
    const limit = Math.min(opts.limit ?? 100, 500);
    const res = await this.pool.query<ReviewRow>(
      `SELECT * FROM review WHERE tenant_id = $1 ${opts.state ? 'AND state = $2' : ''}
       ORDER BY created_at DESC, review_id LIMIT ${opts.state ? '$3' : '$2'}`,
      opts.state ? [t, opts.state, limit] : [t, limit],
    );
    return res.rows;
  }

  /** Ingesta idempotente: mismo (tenant, source_review_id) ⇒ la fila previa.
   *  `db` permite participar en la MISMA transacción (PR-03: batch atómico). */
  async ingest(input: {
    reviewId: string; tenantId: string; r: ReviewInput; classification: ReviewClassification;
    state: ReviewState; suggestedOptions: string[]; responseText: string | null;
  }, db: Pool | PoolClient = this.pool): Promise<{ row: ReviewRow; created: boolean }> {
    const t = this.assertTenant(input.tenantId);
    const res = await db.query<ReviewRow>(
      `INSERT INTO review
        (review_id, tenant_id, source, source_review_id, author_name, star_rating, review_text, classification, state, suggested_options, response_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id, source_review_id) DO NOTHING
       RETURNING *`,
      [input.reviewId, t, input.r.source, input.r.source_review_id, input.r.author_name, input.r.star_rating,
        input.r.review_text, input.classification, input.state, JSON.stringify(input.suggestedOptions), input.responseText],
    );
    const row = res.rows[0] ?? null;
    if (row) return { row, created: true };
    const existing = await db.query<ReviewRow>(
      'SELECT * FROM review WHERE tenant_id = $1 AND source_review_id = $2',
      [t, input.r.source_review_id],
    );
    const existingRow = existing.rows[0] ?? null;
    return { row: existingRow as ReviewRow, created: false };
  }

  /** source_review_id ya presentes del tenant (para medir el lote dentro del candado de cuota). */
  async existingSourceIds(tenantId: string, db: Pool | PoolClient = this.pool): Promise<Set<string>> {
    const t = this.assertTenant(tenantId);
    const res = await db.query<{ source_review_id: string }>(
      'SELECT source_review_id FROM review WHERE tenant_id = $1',
      [t],
    );
    return new Set(res.rows.map((r) => r.source_review_id));
  }

  /** Guard de transición: solo se actualiza si el estado actual ∈ fromStates.
   *  `db` permite participar en la MISMA transacción (fail-closed); por
   *  defecto usa el pool. */
  async updateState(
    tenantId: string,
    reviewId: string,
    state: ReviewState,
    meta: { responseText?: string | null; decidedBy?: string; proposalId?: string | null } = {},
    fromStates: readonly ReviewState[] = [],
    db: Pool | PoolClient = this.pool,
  ): Promise<TenantBoundaryResult<ReviewRow>> {
    const t = this.assertTenant(tenantId);
    const sets = ['state = $3', 'updated_at = now()'];
    const values: unknown[] = [t, reviewId, state];
    if (meta.responseText !== undefined) {
      sets.push(`response_text = $${values.length + 1}`);
      values.push(meta.responseText);
    }
    if (meta.decidedBy) {
      sets.push('decided_by = $' + (values.length + 1));
      values.push(meta.decidedBy);
      sets.push('decided_at = now()');
    }
    if (meta.proposalId !== undefined) {
      sets.push('proposal_id = $' + (values.length + 1));
      values.push(meta.proposalId);
    }
    const guard = fromStates.length
      ? `AND state IN (${fromStates.map((_, i) => `$${values.length + 1 + i}`).join(',')}) `
      : '';
    values.push(...fromStates);
    const sql = `UPDATE review SET ${sets.join(', ')} WHERE tenant_id = $1 AND review_id = $2 ${guard}RETURNING *`;
    const res = await db.query<ReviewRow>(sql, values);
    const row = res.rows[0] ?? null;
    if (!row) return { found: false, in_tenant: false, row: null };
    return { found: true, in_tenant: true, row };
  }

  async businessName(tenantId: string): Promise<string> {
    const res = await this.pool.query<{ business_name: string }>(
      'SELECT business_name FROM client WHERE client_id = $1',
      [tenantId],
    );
    return res.rows[0]?.business_name ?? 'tu negocio';
  }
}

/**
 * Generador determinista de borradores de respuesta (3 opciones, FLOW-004).
 * SIN inventar hechos comerciales (RULE-005): no descuentos, precios ni
 * promesas. Marcado como borrador (nunca se publica sin preview/aprobación).
 */
export function suggestResponses(review: Pick<ReviewRow, 'author_name' | 'classification'>, businessName: string): string[] {
  const author = review.author_name.trim() || 'cliente';
  const biz = businessName.trim() || 'nuestro negocio';
  if (review.classification === 'negative') {
    return [
      `Gracias por tu comentario, ${author}. Lamento la experiencia que tuviste. En ${biz} revisamos cada caso con atención; escríbenos por un canal directo y lo resolvemos.`,
      `Hola ${author}, gracias por avisarnos. Queremos entender mejor lo que ocurrió: contáctanos por mensaje directo y un responsable lo atenderá.`,
      `Hola ${author}, en ${biz} nos importa tu opinión. Ya tomamos nota del caso y un responsable te contactará para resolverlo.`,
    ];
  }
  if (review.classification === 'neutral') {
    return [
      `Gracias por tu reseña, ${author}. Tomamos nota de tu comentario para mejorar la espera en horas de mayor afluencia.`,
      `Hola ${author}, gracias por compartir tu experiencia. Trabajamos cada día para mejorar la atención; tus comentarios nos ayudan.`,
      `Hola ${author}, agradecemos tu tiempo. Ya compartimos tu comentario con el equipo para mejorar el servicio.`,
    ];
  }
  return [
    `Gracias por tu reseña, ${author}. Nos alegra mucho tu comentario y seguimos trabajando para ofrecerte lo mejor.`,
    `Hola ${author}, ¡gracias por tu opinión! Para nosotros significa mucho que valores nuestro trabajo.`,
    `Gracias, ${author}, por recomendarnos. Te esperamos pronto en ${biz}.`,
  ];
}

export class ReputationEngine {
  private readonly deps: ReputationEngineDeps;

  constructor(deps: ReputationEngineDeps) {
    this.deps = deps;
  }

  private get repo(): ReviewRepository {
    return new ReviewRepository(this.deps.pool);
  }

  private get threshold(): number {
    return this.deps.config.reviewThreshold;
  }

  /**
   * Sincroniza/ingesta las reseñas del proveedor (simulado determinista).
   *
   * DEC-0005 + NFR-0001: el lote se mide, se comprueba contra la cuota
   * `reviews_managed` y se inserta con su auditoría en UNA transacción, con el
   * candado de cuota del tenant tomado: dos sincronizaciones concurrentes no
   * pueden superar el límite. Si el lote no cabe ⇒ 403 'limit_exceeded' sin
   * estado parcial; si un insert falla a mitad ⇒ ROLLBACK (sin filas ni consumo).
   * El lote ya es idempotente por source_review_id; la clave de cuota es el request_id.
   */
  async sync(tenantId: string, actorId: string, requestId: string, actorRole: string | null = null): Promise<{ outcome: SyncOutcome; reviews: ReviewRow[] }> {
    const reviews = await this.deps.provider.listReviews(tenantId);
    const outcome: SyncOutcome = { synced: 0, skipped: 0, classified: { acknowledged: 0, suggested: 0 } };
    await runAtomic(this.deps.pool, async (client) => {
      await this.deps.quota.lock(client, tenantId, 'reviews_managed');
      const existing = await this.repo.existingSourceIds(tenantId, client);
      const fresh = reviews.filter((r) => !existing.has(r.source_review_id)).length;
      if (fresh > 0) {
        await this.deps.quota.consumeInTx(client, {
          tenantId, capability: 'reviews_managed', units: fresh, idempotencyKey: requestId, requestId, actorId, actorRole,
        }, async () => {
          for (const r of reviews) {
            const { row, created } = await this.ingestTracked(tenantId, actorId, requestId, r, client);
            if (!created) { outcome.skipped += 1; continue; }
            outcome.synced += 1;
            if (row.state === 'acknowledged') outcome.classified.acknowledged += 1;
            if (row.state === 'suggested') outcome.classified.suggested += 1;
          }
          return { resourceRef: `review_batch/${requestId}`, value: undefined };
        });
      } else {
        outcome.skipped = reviews.length;
      }
    });
    const list = await this.repo.list(tenantId);
    return { outcome, reviews: list };
  }

  private async ingestTracked(
    tenantId: string, actorId: string, requestId: string, r: ReviewInput,
    db?: PoolClient,
  ): Promise<{ row: ReviewRow; created: boolean }> {
    const classification = classifyReview(r.star_rating);
    const business = await this.repo.businessName(tenantId);
    const needsHuman = belowThreshold(r.star_rating, this.threshold);
    const options = suggestResponses(
      { author_name: r.author_name, classification },
      business,
    );
    // Borrador por defecto: la primera opción sugerida (marcado DRAFT; nunca publicado solo).
    const responseText = options[0] ?? null;
    const state: ReviewState = needsHuman ? 'suggested' : 'acknowledged';

    const { row, created } = await this.repo.ingest({
      reviewId: `rev_${crypto.randomUUID()}`,
      tenantId, r, classification, state, suggestedOptions: options, responseText,
    }, db);
    await this.deps.sink.write({
      tenant_id: tenantId, actor_id: actorId, actor_role: null,
      action: 'reputation.review.ingested',
      resource: `review/${row?.review_id ?? r.source_review_id}`,
      request_id: requestId, decision: 'allow',
      result: created ? `${classification}:${state}` : 'already_existing',
    }, db);
    log.info('reputation.ingested', 'review ingested and classified', {
      tenant_id: tenantId, review_id: row?.review_id, classification, state, created,
    });
    if (!row) throw new AppError(500, DENY_CODES.INTERNAL, 'No se pudo registrar la reseña.');
    return { row, created };
  }

  /** Escala un caso sugerido/editado a revisión humana (FLOW-004). */
  async escalate(tenantId: string, reviewId: string, actorId: string, requestId: string): Promise<ReviewRow> {
    const found = await this.repo.findScoped(tenantId, reviewId);
    if (!found.found || !found.in_tenant) {
      throw new AppError(404, DENY_CODES.NOT_FOUND, 'No se encontró la reseña solicitada.');
    }
    const review = found.row as ReviewRow;
    if (['awaiting_human', 'approved', 'published', 'rejected'].includes(review.state)) {
      if (review.state === 'awaiting_human') return review; // idempotente
      throw new AppError(409, 'validation_error', 'La reseña ya no puede escalarse en su estado actual.');
    }
    return runAtomic(this.deps.pool, async (client) => {
      const updated = await this.repo.updateState(tenantId, reviewId, 'awaiting_human', {}, ['suggested', 'edited', 'detected'], client);
      await this.deps.sink.write({
        tenant_id: tenantId, actor_id: actorId, actor_role: null,
        action: 'reputation.escalated', resource: `review/${reviewId}`,
        request_id: requestId, decision: 'allow', result: 'awaiting_human',
      }, client);
      return updated.row as ReviewRow;
    });
  }

  /** Edita el borrador de respuesta — SOLO antes de aprobar (DEC-011). */
  async editResponse(tenantId: string, reviewId: string, text: string, actorId: string, requestId: string): Promise<ReviewRow> {
    const clean = text?.trim() ?? '';
    if (!clean) {
      throw new AppError(400, 'validation_error', 'Escribe el texto de la respuesta antes de guardarla.');
    }
    const found = await this.repo.findScoped(tenantId, reviewId);
    if (!found.found || !found.in_tenant) {
      throw new AppError(404, DENY_CODES.NOT_FOUND, 'No se encontró la reseña solicitada.');
    }
    const review = found.row as ReviewRow;
    if (review.state === 'published') {
      throw new AppError(409, DENY_CODES.PROHIBITED, 'La respuesta ya fue publicada y no puede editarse. No se permite modificar una respuesta pública visible.');
    }
    const allowed: readonly ReviewState[] = ['suggested', 'awaiting_human', 'edited'];
    if (!(allowed as readonly string[]).includes(review.state)) {
      throw new AppError(409, 'validation_error', 'La respuesta solo puede editarse antes de aprobarse.');
    }
    return runAtomic(this.deps.pool, async (client) => {
      const updated = await this.repo.updateState(tenantId, reviewId, 'edited', { responseText: clean }, allowed, client);
      await this.deps.sink.write({
        tenant_id: tenantId, actor_id: actorId, actor_role: null,
        action: 'reputation.response.edited', resource: `review/${reviewId}`,
        request_id: requestId, decision: 'allow', result: 'edited',
      }, client);
      return updated.row as ReviewRow;
    });
  }

  /**
   * Aprueba la respuesta → crea la propuesta de PUBLICACIÓN (preview/aprobación
   * humana, DEC-011). Idempotente: si ya existe una propuesta pendiente la
   * devuelve; solo se publica UNA vez (AC: publica una vez).
   */
  async approveResponse(
    tenantId: string, reviewId: string, actorId: string, requestId: string,
  ): Promise<{ review: ReviewRow; proposalId: string }> {
    const found = await this.repo.findScoped(tenantId, reviewId);
    if (!found.found || !found.in_tenant) {
      throw new AppError(404, DENY_CODES.NOT_FOUND, 'No se encontró la reseña solicitada.');
    }
    const review = found.row as ReviewRow;
    if (review.state === 'published') {
      throw new AppError(409, DENY_CODES.PROHIBITED, 'La respuesta ya fue publicada. No puede volver a aprobarse.');
    }
    const allowed: readonly ReviewState[] = ['suggested', 'awaiting_human', 'edited'];
    if (!(allowed as readonly string[]).includes(review.state)) {
      throw new AppError(409, 'validation_error', 'La reseña no está en un estado que permita aprobar la respuesta.');
    }
    const responseText = review.response_text?.trim() ?? '';
    if (!responseText) {
      throw new AppError(400, 'validation_error', 'Primero redacta la respuesta (borrador) antes de aprobarla.');
    }

    // Idempotencia: devolver la propuesta pendiente si existe.
    if (review.proposal_id) {
      const proposal = await this.deps.conversationRepo.findProposalScoped(tenantId, review.proposal_id);
      if (proposal.found && proposal.in_tenant) {
        const status = (proposal.row as { status: string }).status;
        if (['awaiting_confirmation', 'confirmed', 'preview_ready', 'approved_for_publish'].includes(status)) {
          return { review, proposalId: review.proposal_id };
        }
        if (status === 'published') {
          throw new AppError(409, DENY_CODES.PROHIBITED, 'La respuesta ya fue publicada. No puede volver a aprobarse.');
        }
      }
    }

    const business = await this.repo.businessName(tenantId);
    const ids = newConversationIds();
    const summary = `Respuesta pública a una reseña de ${review.author_name} (${review.star_rating} de 5 estrellas).`;
    await runAtomic(this.deps.pool, async (client) => {
      await this.deps.conversationRepo.createRequest({
        requestId: ids.requestId, tenantId, actorId, channel: 'simulated',
        rawMessage: summary, intent: 'reputation.public_response',
        capabilityTarget: 'reputation', actionClass: 'preview_required',
        status: 'awaiting_confirmation', responseMessage: null, proposalId: ids.proposalId,
      }, client);
      await this.deps.conversationRepo.createProposal({
        proposalId: ids.proposalId, tenantId, requestId: ids.requestId,
        capabilityTarget: 'reputation', proposalType: 'reputation.public_response',
        actionClass: 'preview_required', summary,
        detail: { review_id: review.review_id, response_text: responseText, author_name: review.author_name, business_name: business, star_rating: review.star_rating },
        status: 'awaiting_confirmation', createdBy: actorId,
      }, client);
      // Guard antiraza (TOCTOU): si el estado cambió en paralelo (otra
      // aprobación ganó), la transición falla y la tx se revierte → 409.
      const transitioned = await this.repo.updateState(
        tenantId, reviewId, 'approved', { proposalId: ids.proposalId },
        ['suggested', 'awaiting_human', 'edited'], client,
      );
      if (!transitioned.found || !transitioned.in_tenant) {
        throw new AppError(409, 'validation_error',
          'La reseña cambió de estado mientras se procesaba. Revisa el estado actual e inténtalo de nuevo.');
      }
      await this.deps.sink.write({
        tenant_id: tenantId, actor_id: actorId, actor_role: null,
        action: 'reputation.approved', resource: `review/${reviewId}`,
        request_id: requestId, decision: 'allow', result: 'proposal_created', evidence_ref: ids.proposalId,
      }, client);
    });
    const updated = (await this.repo.findScoped(tenantId, reviewId)).row as ReviewRow;
    return { review: updated, proposalId: ids.proposalId };
  }

  /** Rechaza el caso (solo antes de publicar). */
  async reject(tenantId: string, reviewId: string, actorId: string, requestId: string): Promise<ReviewRow> {
    const found = await this.repo.findScoped(tenantId, reviewId);
    if (!found.found || !found.in_tenant) {
      throw new AppError(404, DENY_CODES.NOT_FOUND, 'No se encontró la reseña solicitada.');
    }
    const review = found.row as ReviewRow;
    if (review.state === 'rejected') return review; // idempotente
    const allowed: readonly ReviewState[] = ['suggested', 'awaiting_human', 'edited', 'approved', 'detected'];
    if (review.state === 'published') {
      throw new AppError(409, DENY_CODES.PROHIBITED, 'La respuesta ya fue publicada y no puede rechazarse.');
    }
    return runAtomic(this.deps.pool, async (client) => {
      const updated = await this.repo.updateState(tenantId, reviewId, 'rejected', { decidedBy: actorId }, allowed, client);
      await this.deps.sink.write({
        tenant_id: tenantId, actor_id: actorId, actor_role: null,
        action: 'reputation.rejected', resource: `review/${reviewId}`,
        request_id: requestId, decision: 'allow', result: 'rejected',
      }, client);
      return updated.row as ReviewRow;
    });
  }

  /**
   * Manipulación de opiniones (ocultar/borrar) — SIEMPRE PROHIBITED
   * (audit deny + 403, NFR: sin manipulación, matriz fail-closed). No hay
   * ningún camino que cambie el estado a oculto/borrado.
   */
  async prohibitedManipulation(tenantId: string, reviewId: string, actorId: string, requestId: string): Promise<never> {
    await this.deps.sink.write({
      tenant_id: tenantId, actor_id: actorId, actor_role: null,
      action: 'reputation.hide_review', resource: `review/${reviewId}`,
      request_id: requestId, decision: 'deny', result: 'prohibited',
    }, this.deps.pool, false).catch(() => undefined);
    const err = new AppError(403, DENY_CODES.PROHIBITED,
      'No está permitido ocultar ni borrar reseñas. Las opiniones de tus clientes no se manipulan.');
    err.audited = true;
    throw err;
  }

  /**
   * Marca la reseña como publicada (invocado por ReputationPublisher DENTRO de
   * la transacción de publicación de FLOW-002). Idempotente: si ya está
   * publicada actualiza published_at sin error.
   */
  async markPublished(tenantId: string, reviewId: string, text: string): Promise<void> {
    await this.deps.pool.query(
      `UPDATE review SET state = 'published', published_text = $1, published_at = now(), updated_at = now()
       WHERE review_id = $2 AND tenant_id = $3`,
      [text, reviewId, tenantId],
    );
  }
}
