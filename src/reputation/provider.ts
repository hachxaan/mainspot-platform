/**
 * ReputationProvider — reseñas y respuestas públicas de Google Business Profile
 * (INC-004, CAP-002/CAP-004, REQ-015, FLOW-004).
 *
 * DEC-026: interfaz de adaptador + implementación real opcional + MODO SIMULADO
 * funcional (E2E/piloto sin credenciales). El adaptador real SOLO se instancia
 * con GOOGLE_GBP_TOKEN; sin token SIEMPRE se usa SimulatedReviews (fail-safe:
 * nunca se llama a la API real sin credenciales).
 *
 * INVARIANTES: no hay manipulación de opiniones (ocultar/borrar está
 * bloqueado); la respuesta pública es un cambio visible (DEC-011) y se publica
 * solo vía preview/aprobación humana.
 */

import type { AppConfig } from '../shared/config.ts';

export type ReviewSource = 'google';

export type ReviewClassification = 'positive' | 'neutral' | 'negative';

/** Review entrante normalizada desde el proveedor (tenant-scoped). */
export interface ReviewInput {
  source_review_id: string;
  author_name: string;
  star_rating: number;
  review_text: string;
  source: ReviewSource;
}

export interface PublicResponseResult {
  ok: boolean;
  /** Identificador único de la respuesta publicada (evidencia). */
  external_ref: string;
  error?: string;
}

export interface ReputationProvider {
  readonly provider: 'simulated' | 'google_business_profile';
  /** Lista reseñas del tenant (dataset determinista en modo simulado). */
  listReviews(tenantId: string): Promise<ReviewInput[]>;
  /** Publica una respuesta pública (SOLO se invoca tras aprobación humana). */
  postPublicResponse(tenantId: string, sourceReviewId: string, text: string): Promise<PublicResponseResult>;
}

/**
 * Clasificación determinista por calificación (sin sentimiento NLU en esta
 * tanda; TENTATIVA documentada): >=4 positive, ==3 neutral, <=2 negative.
 * El ENRRUTAMIENTO a humano usa REVIEW_THRESHOLD (DEC-023), independiente de
 * la clasificación: una reseña 3 estrellas es "neutral" pero igual se escala.
 */
export function classifyReview(starRating: number): ReviewClassification {
  if (starRating >= 4) return 'positive';
  if (starRating === 3) return 'neutral';
  return 'negative';
}

/** ¿Este caso requiere revisión humana por umbral? (DEC-023: rating < threshold). */
export function belowThreshold(starRating: number, threshold: number): boolean {
  return starRating < threshold;
}
