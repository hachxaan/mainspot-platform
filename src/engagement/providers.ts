/**
 * Adaptadores de proveedor del agente de atención (SHARED-CONTRACT §B).
 *
 * - Simulador determinista respaldado por PostgreSQL (sim_provider_*): funciona entre procesos
 *   (servidor, worker, tests), sobrevive a reinicios y permite inyectar fallos. Respuestas
 *   idempotentes por `idempotency_key`: repetir no duplica una respuesta pública.
 * - Adaptadores reales por negocio en google/reviews.ts y social/meta-engagement.ts.
 *   Los fallos reales nunca se convierten en respuestas simuladas.
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { EngagementOrigin } from './classifier.ts';

export interface ReplyInput {
  tenantId: string;
  origin: EngagementOrigin;
  /** Id externo de la reseña o del comentario al que se responde. */
  targetRef: string;
  text: string;
  idempotencyKey: string;
}

export type ReplyResult =
  | { ok: true; external_ref: string }
  | { ok: false; error: string; retryable: boolean };

export interface EngagementReplier {
  readonly mode: 'simulated' | 'real';
  /** true si repetir la misma idempotencyKey nunca duplica la respuesta pública. */
  readonly idempotent: boolean;
  reply(input: ReplyInput): Promise<ReplyResult>;
}

export interface InboundComment {
  external_ref: string;
  post_ref: string;
  author_label: string;
  body: string;
}

export interface CommentSource {
  /** 'real' = lectura autenticada del proveedor (DEV-E2E-04: MetaCommentSource). */
  readonly mode: 'simulated' | 'not_verified' | 'real';
  listSince(tenantId: string, cursor: string | null): Promise<{ items: InboundComment[]; cursor: string | null }>;
}

/** Consume un fallo inyectado del simulador (si queda alguno) para (tenant, origen, tipo). */
export async function consumeSimFault(pool: Pool, tenantId: string, origin: string, kind: 'error' | 'timeout' | 'list_error'): Promise<boolean> {
  const res = await pool.query(
    `UPDATE sim_provider_fault SET remaining = remaining - 1
      WHERE tenant_id = $1 AND origin = $2 AND kind = $3 AND remaining > 0 RETURNING remaining`,
    [tenantId, origin, kind],
  );
  return (res.rowCount ?? 0) > 0;
}

export class SimulatedReplier implements EngagementReplier {
  readonly mode = 'simulated' as const;
  readonly idempotent = true;
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async reply(input: ReplyInput): Promise<ReplyResult> {
    if (await consumeSimFault(this.pool, input.tenantId, input.origin, 'timeout')) {
      return { ok: false, error: 'simulated_timeout', retryable: true };
    }
    if (await consumeSimFault(this.pool, input.tenantId, input.origin, 'error')) {
      return { ok: false, error: 'simulated_provider_error', retryable: true };
    }
    const prefix = input.origin === 'google_review' ? 'sim:gbp:reply' : 'sim:fb:reply';
    const hash = createHash('sha256').update(`${input.tenantId}:${input.idempotencyKey}`).digest('hex').slice(0, 16);
    await this.pool.query(
      `INSERT INTO sim_provider_reply (idempotency_key, tenant_id, origin, target_ref, text, external_ref)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING`,
      [input.idempotencyKey, input.tenantId, input.origin, input.targetRef, input.text, `${prefix}:${hash}`],
    );
    const existing = await this.pool.query<{ external_ref: string }>(
      'SELECT external_ref FROM sim_provider_reply WHERE idempotency_key = $1', [input.idempotencyKey]);
    return { ok: true, external_ref: existing.rows[0]?.external_ref ?? `${prefix}:${hash}` };
  }
}


export class SimulatedCommentSource implements CommentSource {
  readonly mode = 'simulated' as const;
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async listSince(tenantId: string, cursor: string | null): Promise<{ items: InboundComment[]; cursor: string | null }> {
    if (await consumeSimFault(this.pool, tenantId, 'facebook_comment', 'list_error')) {
      throw new Error('simulated_list_error');
    }
    const after = cursor && /^\d+$/.test(cursor) ? cursor : '0';
    const res = await this.pool.query<{ event_seq: string; external_ref: string; post_ref: string | null; author_label: string; body: string }>(
      `SELECT event_seq, external_ref, post_ref, author_label, body FROM sim_provider_event
        WHERE tenant_id = $1 AND origin = 'facebook_comment' AND event_seq > $2::bigint
        ORDER BY event_seq LIMIT 100`,
      [tenantId, after],
    );
    const items = res.rows.map((r) => ({ external_ref: r.external_ref, post_ref: r.post_ref ?? '', author_label: r.author_label, body: r.body }));
    const last = res.rows[res.rows.length - 1];
    return { items, cursor: last ? last.event_seq : cursor };
  }
}

