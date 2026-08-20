/**
 * SocialService (INC-005, CAP-003, REQ-014) — crear/adaptar/programar/consultar
 * publicaciones de Facebook y Ads básicos.
 *
 * Flujo: draft → awaiting_approval (con fecha programada) → proposal de preview
 * (FLOW-002, INC-002) → aprobación humana → publicado UNA vez (idempotente).
 * La cola scheduled_post se procesa con un tick manual (worker simple) que
 * "publica" en el simulador al llegar la fecha (sin credenciales, DEC-026).
 *
 * Fail-closed: scope tenant SIEMPRE de la sesión; anti-oracle 404 idéntico;
 * campaña avanzada = PROHIBITED (permiso social.campaign_advanced bloqueado).
 */

import type { Pool } from 'pg';
import type { AppConfig } from '../shared/config.ts';
import type { AuditSink } from '../audit/sink.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import type { SocialContentType, SocialProvider } from './provider.ts';
import { ConversationRepository, newConversationIds } from '../conversation/repositories.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import type { TenantBoundaryResult } from '../conversation/repositories.ts';
import type { EntitlementService } from '../subscriptions/entitlements.ts';

export type SocialPostStatus = 'draft' | 'awaiting_approval' | 'scheduled' | 'published' | 'rejected' | 'failed';
export type ScheduledStatus = 'pending' | 'published' | 'skipped';

export interface SocialPostRow {
  post_id: string;
  tenant_id: string;
  network: 'facebook';
  content_type: SocialContentType;
  text: string;
  image_url: string | null;
  status: SocialPostStatus;
  scheduled_at: string | null;
  published_at: string | null;
  proposal_id: string | null;
  external_ref: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ScheduledPostRow {
  scheduled_post_id: string;
  tenant_id: string;
  post_id: string;
  publish_at: string;
  status: ScheduledStatus;
  external_ref: string | null;
  processed_at: string | null;
  created_at: string;
}

export interface SocialServiceDeps {
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  provider: SocialProvider;
  conversationRepo: ConversationRepository;
  entitlements: EntitlementService;
}

export class SocialRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private assertTenant(tenantId: string): string {
    if (!tenantId) throw new Error('FAIL-CLOSED: social repository requires a tenant context');
    return tenantId;
  }

  async findScoped(tenantId: string, postId: string): Promise<TenantBoundaryResult<SocialPostRow>> {
    const t = this.assertTenant(tenantId);
    const res = await this.pool.query<SocialPostRow>('SELECT * FROM social_post WHERE post_id = $1', [postId]);
    const row = res.rows[0] ?? null;
    if (!row) return { found: false, in_tenant: false, row: null };
    return { found: true, in_tenant: row.tenant_id === t, row };
  }

  async list(tenantId: string, opts: { status?: SocialPostStatus; limit?: number } = {}): Promise<SocialPostRow[]> {
    const t = this.assertTenant(tenantId);
    const limit = Math.min(opts.limit ?? 100, 500);
    const res = await this.pool.query<SocialPostRow>(
      `SELECT * FROM social_post WHERE tenant_id = $1 ${opts.status ? 'AND status = $2' : ''}
       ORDER BY created_at DESC, post_id LIMIT ${opts.status ? '$3' : '$2'}`,
      opts.status ? [t, opts.status, limit] : [t, limit],
    );
    return res.rows;
  }

  async create(input: {
    postId: string; tenantId: string; contentType: SocialContentType; text: string; imageUrl: string | null; createdBy: string;
  }): Promise<SocialPostRow> {
    const t = this.assertTenant(input.tenantId);
    const res = await this.pool.query<SocialPostRow>(
      `INSERT INTO social_post (post_id, tenant_id, network, content_type, text, image_url, status, created_by)
       VALUES ($1,$2,'facebook',$3,$4,$5,'draft',$6) RETURNING *`,
      [input.postId, t, input.contentType, input.text, input.imageUrl, input.createdBy],
    );
    return res.rows[0] as SocialPostRow;
  }

  /** Guard de transición por estado previo (antiraza / TOCTOU).
   *  `db` permite participar en la MISMA transacción (fail-closed). */
  async updateStatus(
    tenantId: string, postId: string, status: SocialPostStatus,
    meta: {
      scheduledAt?: string | null; proposalId?: string | null; publishedAt?: string | null; externalRef?: string | null;
    } = {},
    fromStatuses: readonly SocialPostStatus[] = [],
    db: Pool | import('pg').PoolClient = this.pool,
  ): Promise<TenantBoundaryResult<SocialPostRow>> {
    const t = this.assertTenant(tenantId);
    const sets = ['status = $3', 'updated_at = now()'];
    const values: unknown[] = [t, postId, status];
    if (meta.scheduledAt !== undefined) { sets.push('scheduled_at = $' + (values.length + 1)); values.push(meta.scheduledAt); }
    if (meta.proposalId !== undefined) { sets.push('proposal_id = $' + (values.length + 1)); values.push(meta.proposalId); }
    if (meta.publishedAt !== undefined) { sets.push('published_at = $' + (values.length + 1)); values.push(meta.publishedAt); }
    if (meta.externalRef !== undefined) { sets.push('external_ref = $' + (values.length + 1)); values.push(meta.externalRef); }
    const guard = fromStatuses.length
      ? `AND status IN (${fromStatuses.map((_, i) => `$${values.length + 1 + i}`).join(',')}) `
      : '';
    values.push(...fromStatuses);
    const sql = `UPDATE social_post SET ${sets.join(', ')} WHERE tenant_id = $1 AND post_id = $2 ${guard}RETURNING *`;
    const res = await db.query<SocialPostRow>(sql, values);
    const row = res.rows[0] ?? null;
    if (!row) return { found: false, in_tenant: false, row: null };
    return { found: true, in_tenant: true, row };
  }

  async createScheduled(input: { id: string; tenantId: string; postId: string; publishAt: string }): Promise<void> {
    const t = this.assertTenant(input.tenantId);
    await this.pool.query(
      `INSERT INTO scheduled_post (scheduled_post_id, tenant_id, post_id, publish_at, status)
       VALUES ($1,$2,$3,$4,'pending') ON CONFLICT (post_id) DO NOTHING`,
      [input.id, t, input.postId, input.publishAt],
    );
  }

  async scheduledForPost(tenantId: string, postId: string): Promise<ScheduledPostRow | null> {
    const t = this.assertTenant(tenantId);
    const res = await this.pool.query<ScheduledPostRow>(
      'SELECT * FROM scheduled_post WHERE post_id = $1 AND tenant_id = $2',
      [postId, t],
    );
    return res.rows[0] ?? null;
  }

  /** Due pendientes del tenant (worker/tick manual, scope por tenant). */
  async dueScheduled(tenantId: string, now: string): Promise<ScheduledPostRow[]> {
    const t = this.assertTenant(tenantId);
    const res = await this.pool.query<ScheduledPostRow>(
      `SELECT * FROM scheduled_post WHERE tenant_id = $1 AND status = 'pending' AND publish_at <= $2
       ORDER BY publish_at LIMIT 100`,
      [t, now],
    );
    return res.rows;
  }

  /** Marca la cola como publicada/saltada (transición con guard). */
  async markScheduled(
    tenantId: string, scheduledId: string, status: Extract<ScheduledStatus, 'published' | 'skipped'>, externalRef: string | null,
    db: Pool | import('pg').PoolClient = this.pool,
  ): Promise<boolean> {
    const t = this.assertTenant(tenantId);
    const res = await db.query(
      `UPDATE scheduled_post SET status = $1, external_ref = $2, processed_at = now()
       WHERE scheduled_post_id = $3 AND tenant_id = $4 AND status = 'pending'`,
      [status, externalRef, scheduledId, t],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

export class SocialService {
  private readonly deps: SocialServiceDeps;

  constructor(deps: SocialServiceDeps) {
    this.deps = deps;
  }

  private get repo(): SocialRepository {
    return new SocialRepository(this.deps.pool);
  }

  /** Crea un borrador (límite del plan verificado, DEC-024). */
  async createDraft(
    tenantId: string, actorId: string, requestId: string,
    input: { text: string; imageUrl?: string | null; contentType?: SocialContentType },
  ): Promise<SocialPostRow> {
    const text = input.text?.trim() ?? '';
    if (!text) {
      throw new AppError(400, 'validation_error', 'Escribe el texto de la publicación.');
    }
    const contentType = input.contentType === 'ad' ? 'ad' : 'post';
    await this.deps.entitlements.checkLimit(tenantId, contentType === 'ad' ? 'social_ads' : 'social_posts');
    const post = await this.repo.create({
      postId: `post_${crypto.randomUUID()}`,
      tenantId,
      contentType,
      text,
      imageUrl: input.imageUrl ?? null,
      createdBy: actorId,
    });
    await this.deps.sink.write({
      tenant_id: tenantId, actor_id: actorId, actor_role: null,
      action: 'social.created', resource: `social_post/${post.post_id}`,
      request_id: requestId, decision: 'allow', result: 'draft',
    });
    return post;
  }

  /** Programa una publicación DRAFT (la aprobación llega después; DEC-017). */
  async schedule(tenantId: string, actorId: string, requestId: string, postId: string, publishAt: string): Promise<SocialPostRow> {
    const found = await this.repo.findScoped(tenantId, postId);
    if (!found.found || !found.in_tenant) {
      throw new AppError(404, DENY_CODES.NOT_FOUND, 'No se encontró la publicación solicitada.');
    }
    const post = found.row as SocialPostRow;
    if (post.status === 'awaiting_approval' && post.scheduled_at) return post; // idempotente
    if (post.status !== 'draft') {
      throw new AppError(409, 'validation_error', 'La publicación ya no puede programarse en su estado actual.');
    }
    const at = new Date(publishAt);
    if (Number.isNaN(at.getTime())) {
      throw new AppError(400, 'validation_error', 'La fecha de programación no es válida.');
    }
    const updated = await this.repo.updateStatus(tenantId, postId, 'awaiting_approval', { scheduledAt: at.toISOString() }, ['draft']);
    await this.repo.createScheduled({
      id: `sp_${crypto.randomUUID()}`,
      tenantId, postId, publishAt: at.toISOString(),
    });
    await this.deps.sink.write({
      tenant_id: tenantId, actor_id: actorId, actor_role: null,
      action: 'social.scheduled', resource: `social_post/${postId}`,
      request_id: requestId, decision: 'allow', result: 'awaiting_approval',
    });
    return updated.row as SocialPostRow;
  }

  /**
   * Aprueba un borrador → crea la propuesta de preview/publicación (FLOW-002).
   * Idempotente: si ya existe una propuesta pendiente la devuelve.
   * La publicación visible ocurre SOLO tras la aprobación final del preview.
   */
  async approvePost(
    tenantId: string, actorId: string, requestId: string, postId: string,
  ): Promise<{ post: SocialPostRow; proposalId: string }> {
    const found = await this.repo.findScoped(tenantId, postId);
    if (!found.found || !found.in_tenant) {
      throw new AppError(404, DENY_CODES.NOT_FOUND, 'No se encontró la publicación solicitada.');
    }
    const post = found.row as SocialPostRow;
    if (post.status === 'published') {
      throw new AppError(409, DENY_CODES.PROHIBITED, 'La publicación ya fue publicada. No puede volver a aprobarse.');
    }
    if (post.proposal_id) {
      const proposal = await this.deps.conversationRepo.findProposalScoped(tenantId, post.proposal_id);
      if (proposal.found && proposal.in_tenant) {
        const status = (proposal.row as { status: string }).status;
        if (['awaiting_confirmation', 'confirmed', 'preview_ready', 'approved_for_publish'].includes(status)) {
          return { post, proposalId: post.proposal_id };
        }
      }
    }
    const page = await this.deps.provider.getPage(tenantId);
    const ids = newConversationIds();
    const summary = `Publicación en Facebook (${post.content_type}): "${post.text.slice(0, 60)}${post.text.length > 60 ? '…' : ''}"`;
    await runAtomic(this.deps.pool, async (client) => {
      await this.deps.conversationRepo.createRequest({
        requestId: ids.requestId, tenantId, actorId, channel: 'simulated',
        rawMessage: summary, intent: 'social.publish',
        capabilityTarget: 'social', actionClass: 'preview_required',
        status: 'awaiting_confirmation', responseMessage: null, proposalId: ids.proposalId,
      }, client);
      await this.deps.conversationRepo.createProposal({
        proposalId: ids.proposalId, tenantId, requestId: ids.requestId,
        capabilityTarget: 'social', proposalType: post.content_type === 'ad' ? 'social.ad' : 'social.post',
        actionClass: 'preview_required', summary,
        detail: { post_id: post.post_id, text: post.text, image_url: post.image_url, scheduled_at: post.scheduled_at, page_id: page.page_id, page_name: page.page_name },
        status: 'awaiting_confirmation', createdBy: actorId,
      }, client);
      // Guard antiraza (TOCTOU): si el estado cambió en paralelo, la transición
      // falla y la tx se revierte (no se crea una segunda propuesta).
      const transitioned = await this.repo.updateStatus(
        tenantId, postId, 'awaiting_approval', { proposalId: ids.proposalId },
        ['draft', 'awaiting_approval'], client,
      );
      if (!transitioned.found || !transitioned.in_tenant) {
        throw new AppError(409, 'validation_error',
          'La publicación cambió de estado mientras se procesaba. Revisa el estado actual e inténtalo de nuevo.');
      }
    });
    const updated = (await this.repo.findScoped(tenantId, postId)).row as SocialPostRow;
    await this.deps.sink.write({
      tenant_id: tenantId, actor_id: actorId, actor_role: null,
      action: 'social.approved', resource: `social_post/${postId}`,
      request_id: requestId, decision: 'allow', result: 'proposal_created', evidence_ref: ids.proposalId,
    });
    return { post: updated, proposalId: ids.proposalId };
  }

  /** Rechaza la publicación (solo antes de publicar; la cola queda 'skipped'). */
  async reject(tenantId: string, actorId: string, requestId: string, postId: string): Promise<SocialPostRow> {
    const found = await this.repo.findScoped(tenantId, postId);
    if (!found.found || !found.in_tenant) {
      throw new AppError(404, DENY_CODES.NOT_FOUND, 'No se encontró la publicación solicitada.');
    }
    const post = found.row as SocialPostRow;
    if (post.status === 'rejected') return post; // idempotente
    if (post.status === 'published') {
      throw new AppError(409, DENY_CODES.PROHIBITED, 'La publicación ya fue publicada y no puede rechazarse.');
    }
    const scheduled = await this.repo.scheduledForPost(tenantId, postId);
    if (scheduled && scheduled.status === 'pending') {
      await this.repo.markScheduled(tenantId, scheduled.scheduled_post_id, 'skipped', null);
    }
    const updated = await this.repo.updateStatus(tenantId, postId, 'rejected', {}, ['draft', 'awaiting_approval', 'scheduled']);
    await this.deps.sink.write({
      tenant_id: tenantId, actor_id: actorId, actor_role: null,
      action: 'social.rejected', resource: `social_post/${postId}`,
      request_id: requestId, decision: 'allow', result: 'rejected',
    });
    return updated.row as SocialPostRow;
  }

  /** Listado de publicaciones del tenant. */
  async list(tenantId: string, opts: { status?: SocialPostStatus } = {}): Promise<SocialPostRow[]> {
    return this.repo.list(tenantId, opts);
  }

  /**
   * Procesa la cola de programación VENCIDA del tenant (tick manual del worker
   * simple): "publica" en el simulador y marca la cola. Idempotente (solo
   * filas pending se procesan).
   */
  async processDueScheduled(tenantId: string, requestId: string, now = new Date().toISOString()): Promise<{ processed: number; published: SocialPostRow[] }> {
    const due = await this.repo.dueScheduled(tenantId, now);
    const published: SocialPostRow[] = [];
    for (const s of due) {
      const post = (await this.repo.findScoped(tenantId, s.post_id)).row as SocialPostRow;
      if (!post) continue;
      const result = await this.deps.provider.publishPost({
        tenantId,
        text: post.text,
        imageUrl: post.image_url,
        contentType: post.content_type,
      });
      if (!result.ok) continue;
      const marked = await this.repo.markScheduled(tenantId, s.scheduled_post_id, 'published', result.external_ref);
      if (!marked) continue; // otro tick ganó la carrera (idempotencia)
      const updated = await this.repo.updateStatus(tenantId, post.post_id, 'published', {
        publishedAt: new Date().toISOString(), externalRef: result.external_ref,
      }, ['scheduled', 'awaiting_approval']);
      if (updated.found && updated.in_tenant) {
        published.push(updated.row as SocialPostRow);
        await this.deps.sink.write({
          tenant_id: tenantId, actor_id: 'social_scheduler', actor_role: null,
          action: 'social.published', resource: `social_post/${post.post_id}`,
          request_id: requestId, decision: 'allow', result: 'scheduled_published', evidence_ref: result.external_ref,
        });
      }
    }
    if (published.length) {
      log.info('social.scheduler', 'scheduled posts published by tick', { tenant_id: tenantId, count: published.length });
    }
    return { processed: published.length, published };
  }

  /**
   * Campaña avanzada — PROHIBITED por diseño (DEC-017): segmentación avanzada,
   * Instagram y suite completa quedan fuera del MVP. Aunque la matriz bloquea
   * el permiso (fail-closed), este guard es la defensa en profundidad que
   * audita el intento y responde 403/deny.
   */
  async advancedCampaign(tenantId: string, actorId: string, requestId: string): Promise<never> {
    await this.deps.sink.write({
      tenant_id: tenantId, actor_id: actorId, actor_role: null,
      action: 'social.campaign_advanced', resource: 'campaigns/advanced',
      request_id: requestId, decision: 'deny', result: 'prohibited',
    }, this.deps.pool, false).catch(() => undefined);
    const err = new AppError(403, DENY_CODES.PROHIBITED,
      'Las campañas avanzadas y la publicidad segmentada por audiencia aún no están disponibles. Esta capacidad queda fuera del alcance actual.');
    err.audited = true;
    throw err;
  }
}
