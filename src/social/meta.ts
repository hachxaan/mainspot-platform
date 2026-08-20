/**
 * MetaAdapter — implementación REAL opcional (DEC-017/026) de la API Graph de
 * Meta para Facebook publicaciones y Facebook Ads.
 *
 * SOLO se instancia con SOCIAL_PROVIDER=meta Y META_GRAPH_TOKEN. Sin token el
 * servicio usa SimulatedMeta (fail-safe: nunca se llama a la API real sin
 * credenciales). El mapeo exacto a los endpoints v<version>/<page>/feed y
 * adaccounts queda TENTATIVA (contrato externo sujeto a App Review/permisos).
 * Campañas avanzadas / Instagram quedan FUERA (DEC-017).
 */

import type { SocialPage, SocialPostInput, SocialPublishResult, SocialProvider } from './provider.ts';
import { SimulatedMeta } from './simulated.ts';
import type { AppConfig } from '../shared/config.ts';

export class MetaAdapter implements SocialProvider {
  readonly provider = 'meta' as const;
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl = 'https://graph.facebook.com') {
    if (!token) {
      throw new Error('MetaAdapter requires META_GRAPH_TOKEN (DEC-026)');
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async getPage(tenantId: string): Promise<SocialPage> {
    // TENTATIVA: GET /<page-id>?fields=name,picture — sin credenciales no se prueba.
    const res = await fetch(`${this.baseUrl}/v21.0/${tenantId}?fields=name,picture&access_token=${encodeURIComponent(this.token)}`);
    if (!res.ok) {
      throw new Error(`meta graph get page failed: ${res.status}`);
    }
    const body = (await res.json()) as { name?: string; picture?: { data?: { url?: string } } };
    return {
      page_id: tenantId,
      page_name: body.name ?? tenantId,
      profile_picture_url: body.picture?.data?.url ?? '',
    };
  }

  async publishPost(input: SocialPostInput): Promise<SocialPublishResult> {
    const pageId = (await this.getPage(input.tenantId)).page_id;
    const params = new URLSearchParams({
      message: input.text,
      access_token: this.token,
      published: input.contentType === 'ad' ? 'false' : 'true', // Ads: borrador en gestión (básico)
    });
    if (input.imageUrl) params.set('link', input.imageUrl);
    const res = await fetch(`${this.baseUrl}/v21.0/${pageId}/feed`, {
      method: 'POST',
      body: params,
    });
    if (!res.ok) {
      return { ok: false, external_ref: `meta:${pageId}:failed`, error: `meta_graph_http_${res.status}` };
    }
    const body = (await res.json()) as { id?: string };
    return { ok: true, external_ref: body.id ?? `meta:${pageId}` };
  }
}

export function createSocialProvider(config: Pick<AppConfig, 'socialProvider' | 'metaGraphToken' | 'metaGraphBaseUrl'>): SocialProvider {
  if (config.socialProvider === 'meta' && config.metaGraphToken) {
    return new MetaAdapter(config.metaGraphToken, config.metaGraphBaseUrl);
  }
  // DEC-026: sin credenciales => simulado funcional (E2E/piloto).
  return new SimulatedMeta();
}
