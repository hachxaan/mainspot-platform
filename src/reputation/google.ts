/**
 * GoogleBusinessProfileAdapter — implementación REAL opcional (DEC-026).
 *
 * SOLO se instancia con REPUTATION_PROVIDER=google_business_profile Y
 * GOOGLE_GBP_TOKEN. En ausencia de credenciales el servicio usa SimulatedReviews
 * (fail-safe: nunca se llama a la API real sin token). El mapeo exacto a las
 * APIs de Google Business Profile (accounts.locations / reviews / replies) queda
 * TENTATIVA: contrato externo sin validar en esta tanda, sin credenciales.
 */

import type { ReputationProvider, ReviewInput, PublicResponseResult } from './provider.ts';
import { SimulatedReviews } from './simulated.ts';
import type { AppConfig } from '../shared/config.ts';

export class GoogleBusinessProfileAdapter implements ReputationProvider {
  readonly provider = 'google_business_profile' as const;
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl = 'https://mybusinessbusinessinformation.googleapis.com') {
    if (!token) {
      throw new Error('GoogleBusinessProfileAdapter requires GOOGLE_GBP_TOKEN (DEC-026)');
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * TENTATIVA: esqueleto del flujo real — buscar locations del tenant, listar
   * reviews, responder con replies. No probado en esta tanda (sin credenciales).
   * Nunca se invoca sin token.
   */
  async listReviews(tenantId: string): Promise<ReviewInput[]> {
    // Endpoints canónicos TENTATIVA (cuenta del cliente/Google; OAuth por definir).
    const res = await fetch(`${this.baseUrl}/v1/accounts/${tenantId}/locations`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new Error(`google_business_profile list failed: ${res.status}`);
    }
    // TODO(TENTATIVA): mapear locations → reviews. Sin credenciales no se ejecuta.
    return [];
  }

  async postPublicResponse(tenantId: string, sourceReviewId: string, text: string): Promise<PublicResponseResult> {
    const res = await fetch(`${this.baseUrl}/v1/reviews/${encodeURIComponent(sourceReviewId)}/reply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: { text } }),
    });
    if (!res.ok) {
      return { ok: false, external_ref: `gbp:${tenantId}:${sourceReviewId}:failed`, error: `gbp_reply_http_${res.status}` };
    }
    const body = await res.json().catch(() => ({}));
    return { ok: true, external_ref: (body as { name?: string }).name ?? `gbp:${tenantId}:${sourceReviewId}` };
  }
}

export function createReputationProvider(config: Pick<AppConfig, 'reputationProvider' | 'googleGbpToken' | 'googleGbpBaseUrl'>): ReputationProvider {
  if (config.reputationProvider === 'google_business_profile' && config.googleGbpToken) {
    return new GoogleBusinessProfileAdapter(config.googleGbpToken, config.googleGbpBaseUrl);
  }
  // DEC-026: sin credenciales => simulado funcional (E2E/piloto).
  return new SimulatedReviews();
}
