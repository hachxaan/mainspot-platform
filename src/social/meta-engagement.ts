/**
 * Comentarios de Facebook REALES para el agente de atención (DEV-E2E-04 §2B):
 * lectura incremental por polling autorizado (sin webhooks públicos) y respuesta idempotente.
 *
 * - MetaCommentSource: comentarios de las publicaciones PUBLICADAS del negocio (social_post con
 *   id externo de Meta), paginados con los cursores del proveedor y con ventana `since`
 *   solapada; la deduplicación final es por (tenant, origen, id de comentario) en
 *   engagement_case. Los comentarios de la propia Page se excluyen (no son casos).
 * - MetaCommentReplier: Graph no tiene idempotencia nativa; el libro provider_reply_ledger
 *   guarda una fila por (tenant, idempotency_key). Si un envío anterior quedó 'sending'
 *   (timeout/caída), el reintento primero LEE las respuestas del comentario y, si la nuestra
 *   ya está, la adopta: sin duplicados. Read-back obligatorio antes de reportar enviada.
 * - RoutedReplier: compone el replier de Facebook con el de Google por origen.
 *
 * Sin conexión utilizable no se inventan datos: lista vacía y respuesta no reintentable.
 */

import type { Pool } from 'pg';
import type { CommentSource, EngagementReplier, InboundComment, ReplyInput, ReplyResult } from '../engagement/providers.ts';
import { log } from '../shared/logger.ts';
import { META_PROVIDER, MetaGraphError, textHash, type MetaPagesAdapter } from './meta-graph.ts';

interface GraphComment { id?: string; message?: string; from?: { id?: string; name?: string }; created_time?: string }
interface GraphPage<T> { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } }

const OVERLAP_SECONDS = 60;

export class MetaCommentSource implements CommentSource {
  readonly mode = 'real' as const;
  private readonly pool: Pool;
  private readonly meta: MetaPagesAdapter;

  constructor(pool: Pool, meta: MetaPagesAdapter) {
    this.pool = pool;
    this.meta = meta;
  }

  async listSince(tenantId: string, cursor: string | null): Promise<{ items: InboundComment[]; cursor: string | null }> {
    const ctx = await this.meta.pageContext(tenantId);
    if (!ctx) return { items: [], cursor };
    const since = parseCursor(cursor);
    const posts = await this.pool.query<{ external_ref: string }>(
      `SELECT external_ref FROM social_post WHERE tenant_id = $1 AND status = 'published' AND external_ref IS NOT NULL
         AND external_ref NOT LIKE 'sim:%' AND external_ref NOT LIKE 'uncertain:%'
       ORDER BY published_at DESC NULLS LAST`, [tenantId]);
    const items: InboundComment[] = [];
    let maxCreated = since;
    for (const { external_ref: postRef } of posts.rows) {
      let after: string | undefined;
      const seen = new Set<string>();
      while (true) {
        let res: GraphPage<GraphComment>;
        try {
          res = await this.meta.client.get<GraphPage<GraphComment>>(`${postRef}/comments`, {
            token: ctx.pageToken,
            params: { fields: 'id,message,from,created_time', order: 'chronological', filter: 'stream', limit: 100, since: since > 0 ? since : undefined, after },
          });
        } catch (err) {
          if (err instanceof MetaGraphError && err.kind === 'not_found') {
            log.info('meta.comments.post_gone', 'published post no longer readable on Meta; skipped', { tenant_id: tenantId });
            break;
          }
          if (err instanceof MetaGraphError && err.kind === 'invalid_token') {
            await this.meta.noteAuthFailure(tenantId, err);
          }
          throw err;
        }
        for (const c of res.data ?? []) {
          if (!c.id || typeof c.message !== 'string') continue;
          if (c.from?.id && c.from.id === ctx.pageId) continue; // respuestas de la propia Page
          const created = c.created_time ? Math.floor(new Date(c.created_time).getTime() / 1000) : 0;
          if (created > maxCreated) maxCreated = created;
          items.push({ external_ref: c.id, post_ref: postRef, author_label: c.from?.name ?? 'Cliente de Facebook', body: c.message });
        }
        after = res.paging?.next ? res.paging.cursors?.after : undefined;
        if (!after) break;
        if (seen.has(after)) throw new Error('meta_comments_repeated_cursor');
        seen.add(after);
      }
    }
    const next = maxCreated > 0 ? Math.max(0, maxCreated - OVERLAP_SECONDS) : since;
    return { items, cursor: next > 0 ? JSON.stringify({ since: next }) : cursor };
  }
}

function parseCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const v = JSON.parse(cursor) as { since?: unknown };
    return typeof v.since === 'number' && v.since > 0 ? Math.floor(v.since) : 0;
  } catch {
    return 0;
  }
}

export class MetaCommentReplier implements EngagementReplier {
  readonly mode = 'real' as const;
  /** Idempotente por libro local + reconciliación con el proveedor (ver cabecera). */
  readonly idempotent = true;
  private readonly pool: Pool;
  private readonly meta: MetaPagesAdapter;

  constructor(pool: Pool, meta: MetaPagesAdapter) {
    this.pool = pool;
    this.meta = meta;
  }

  async reply(input: ReplyInput): Promise<ReplyResult> {
    if (input.origin !== 'facebook_comment') return { ok: false, error: 'meta_unsupported_origin', retryable: false };
    const owned = await this.pool.query(
      `SELECT 1 FROM engagement_case WHERE tenant_id = $1 AND origin = 'facebook_comment' AND external_ref = $2`,
      [input.tenantId, input.targetRef]);
    if (!owned.rowCount) return { ok: false, error: 'meta_comment_not_in_tenant', retryable: false };
    const ctx = await this.meta.pageContext(input.tenantId);
    if (!ctx) return { ok: false, error: 'meta_not_connected', retryable: false };
    const text = input.text.trim();
    if (!text) return { ok: false, error: 'meta_reply_empty', retryable: false };
    const hash = textHash(text);

    const claimed = await this.pool.query(
      `INSERT INTO provider_reply_ledger (tenant_id, idempotency_key, provider, target_ref, text_hash, state)
       VALUES ($1,$2,$3,$4,$5,'sending') ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
      [input.tenantId, input.idempotencyKey, META_PROVIDER, input.targetRef, hash]);
    if (!claimed.rowCount) {
      const prior = await this.pool.query<{ state: string; external_ref: string | null; target_ref: string; text_hash: string }>(
        'SELECT state, external_ref, target_ref, text_hash FROM provider_reply_ledger WHERE tenant_id = $1 AND idempotency_key = $2',
        [input.tenantId, input.idempotencyKey]);
      const row = prior.rows[0]!;
      if (row.target_ref !== input.targetRef || row.text_hash !== hash) return { ok: false, error: 'meta_reply_key_conflict', retryable: false };
      if (row.state === 'sent' && row.external_ref) return { ok: true, external_ref: row.external_ref };
      if (row.state !== 'failed') {
        const existing = await this.findOwnReply(ctx.pageId, ctx.pageToken, input.targetRef, text);
        if (existing && existing !== 'lookup_failed') {
          await this.markSent(input, existing);
          return { ok: true, external_ref: existing };
        }
        // La respuesta puede estar en vuelo o no ser visible todavía. No reenviar aunque el
        // listado esté vacío: requiere nueva reconciliación o revisión humana.
        return { ok: false, error: 'meta_reply_uncertain', retryable: false };
      }
      const retry = await this.pool.query(
        `UPDATE provider_reply_ledger SET state = 'sending', updated_at = now()
         WHERE tenant_id = $1 AND idempotency_key = $2 AND state = 'failed'`, [input.tenantId, input.idempotencyKey]);
      if (!retry.rowCount) return { ok: false, error: 'meta_reply_in_progress', retryable: false };
    }

    let replyId: string;
    try {
      const created = await this.meta.client.post<{ id?: string }>(`${input.targetRef}/comments`, { token: ctx.pageToken, form: { message: text } });
      if (!created.id) return { ok: false, error: 'meta_reply_uncertain', retryable: true };
      replyId = created.id;
    } catch (err) {
      return this.failure(input, err);
    }
    try {
      const back = await this.meta.client.get<{ id?: string; message?: string }>(replyId, { token: ctx.pageToken, params: { fields: 'id,message' } });
      if (back.id !== replyId || back.message?.trim() !== text) return { ok: false, error: 'meta_reply_readback_mismatch', retryable: false };
    } catch {
      // Enviada pero sin acuse: queda 'sending'; el siguiente intento la encuentra por lectura.
      return { ok: false, error: 'meta_reply_uncertain', retryable: true };
    }
    await this.markSent(input, replyId);
    return { ok: true, external_ref: replyId };
  }

  /** Busca entre las respuestas del comentario una de la Page con el mismo texto. */
  private async findOwnReply(pageId: string, pageToken: string, commentId: string, text: string): Promise<string | null | 'lookup_failed'> {
    let after: string | undefined;
    const seen = new Set<string>();
    while (true) {
      let res: GraphPage<GraphComment>;
      try {
        res = await this.meta.client.get<GraphPage<GraphComment>>(`${commentId}/comments`, {
          token: pageToken, params: { fields: 'id,message,from', limit: 100, after },
        });
      } catch {
        return 'lookup_failed';
      }
      for (const c of res.data ?? []) {
        if (c.id && c.from?.id === pageId && typeof c.message === 'string' && c.message.trim() === text) return c.id;
      }
      after = res.paging?.next ? res.paging.cursors?.after : undefined;
      if (!after) break;
      if (seen.has(after)) return 'lookup_failed';
      seen.add(after);
    }
    return null;
  }

  private async markSent(input: ReplyInput, externalRef: string): Promise<void> {
    await this.pool.query(
      `UPDATE provider_reply_ledger SET state = 'sent', external_ref = $3, last_error = NULL, updated_at = now()
       WHERE tenant_id = $1 AND idempotency_key = $2`, [input.tenantId, input.idempotencyKey, externalRef]);
  }

  private async failure(input: ReplyInput, err: unknown): Promise<ReplyResult> {
    if (err instanceof MetaGraphError) {
      await this.meta.noteAuthFailure(input.tenantId, err);
      if (err.kind === 'timeout' || err.kind === 'duplicate') {
        return { ok: false, error: 'meta_reply_uncertain', retryable: true }; // sigue 'sending' ⇒ reconciliar
      }
      await this.pool.query(
        `UPDATE provider_reply_ledger SET state = 'failed', last_error = $3, updated_at = now() WHERE tenant_id = $1 AND idempotency_key = $2`,
        [input.tenantId, input.idempotencyKey, err.shortCode]);
      const retryable = err.kind === 'rate_limited' || err.kind === 'transient';
      return { ok: false, error: err.shortCode, retryable };
    }
    return { ok: false, error: 'meta_reply_exception', retryable: true };
  }
}

/** Compone repliers por origen (Facebook real + Google real/simulado) para EngagementService. */
export class RoutedReplier implements EngagementReplier {
  readonly mode: 'simulated' | 'real';
  readonly idempotent: boolean;
  private readonly routes: Record<ReplyInput['origin'], EngagementReplier>;

  constructor(routes: Record<ReplyInput['origin'], EngagementReplier>) {
    this.routes = routes;
    const all = Object.values(routes);
    this.mode = all.every((r) => r.mode === 'real') ? 'real' : 'simulated';
    this.idempotent = all.every((r) => r.idempotent);
  }

  reply(input: ReplyInput): Promise<ReplyResult> {
    return this.routes[input.origin].reply(input);
  }
}
