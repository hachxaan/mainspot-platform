/**
 * SimulatedReviews — MODO SIMULADO funcional (DEC-026) de Google Business
 * Profile. Dataset determinista por tenant: 2+ reseñas positivas, 1 neutra,
 * 1 negativa (<4 estrellas), SIN fuente de aleatoriedad (pinned).
 *
 * postPublicResponse() es determinista e idempotente: mismo (tenant, review,
 * texto) ⇒ mismo external_ref.
 */

import type { ReputationProvider, ReviewInput, PublicResponseResult } from './provider.ts';
import { createHash } from 'node:crypto';

/** Dataset determinista (pinned). Sin RNG: la misma llamada devuelve lo mismo. */
const DATASET: Record<string, ReviewInput[]> = {
  client_a: [
    { source_review_id: 'g_a_01', author_name: 'María P.', star_rating: 5, review_text: '¡Excelente atención y la comida deliciosa! Volveremos.', source: 'google' },
    { source_review_id: 'g_a_02', author_name: 'José L.', star_rating: 4, review_text: 'Muy buen servicio, con pequeños detalles por mejorar en el tiempo de espera.', source: 'google' },
    { source_review_id: 'g_a_03', author_name: 'Rosa T.', star_rating: 3, review_text: 'La comida está bien, pero el local estaba lleno y el pedido tardó.', source: 'google' },
    { source_review_id: 'g_a_04', author_name: 'Carlos M.', star_rating: 2, review_text: 'Pedí por teléfono y no recogieron; tardé mucho en que me atendieran.', source: 'google' },
  ],
  client_b: [
    { source_review_id: 'g_b_01', author_name: 'Lucía V.', star_rating: 5, review_text: 'Las tortas son espectaculares y el café de origen, increíble.', source: 'google' },
    { source_review_id: 'g_b_02', author_name: 'Andrés C.', star_rating: 4, review_text: 'Buen ambiente y rica repostería. El estacionamiento es complicado.', source: 'google' },
    { source_review_id: 'g_b_03', author_name: 'Diana R.', star_rating: 3, review_text: 'Rico café, pero la atención fue lenta en horas pico.', source: 'google' },
    { source_review_id: 'g_b_04', author_name: 'Pedro S.', star_rating: 1, review_text: 'Mi pedido llegó frío y sin el acompañamiento que pedí.', source: 'google' },
  ],
};

export class SimulatedReviews implements ReputationProvider {
  readonly provider = 'simulated' as const;

  async listReviews(tenantId: string): Promise<ReviewInput[]> {
    // Devuelve una copia: el caller nunca muta el dataset pinned.
    return (DATASET[tenantId] ?? []).map((r) => ({ ...r }));
  }

  async postPublicResponse(tenantId: string, sourceReviewId: string, text: string): Promise<PublicResponseResult> {
    const hash = createHash('sha256').update(`${tenantId}:${sourceReviewId}:${text}`).digest('hex').slice(0, 16);
    return { ok: true, external_ref: `gbp:sim:${tenantId}:${sourceReviewId}:${hash}` };
  }

  /** Para tests: no hay estado mutable (dataset pinned); método por simetría. */
  static reset(): void {
    // no-op: dataset determinista, sin estado.
  }
}
