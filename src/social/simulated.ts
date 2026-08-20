/**
 * SimulatedMeta — MODO SIMULADO funcional (DEC-026) de la API Graph de Meta
 * para Facebook publicaciones y Ads básicos.
 *
 * Determinista y SIN fuente de aleatoriedad (pinned):
 *  - getPage: página fija por tenant.
 *  - publishPost: external_ref = hash SHA-256 del contenido (mismo contenido
 *    ⇒ mismo ref ⇒ idempotente; repetir la aprobación no duplica).
 */

import { createHash } from 'node:crypto';
import type { SocialPage, SocialPostInput, SocialPublishResult, SocialProvider } from './provider.ts';

const PAGES: Record<string, SocialPage> = {
  client_a: { page_id: 'fb_page_a', page_name: 'Restaurante El Sol', profile_picture_url: 'https://sim.mainspot.local/fb/el-sol.png' },
  client_b: { page_id: 'fb_page_b', page_name: 'Cafetería La Luna', profile_picture_url: 'https://sim.mainspot.local/fb/la-luna.png' },
};

const DEFAULT_PAGE: SocialPage = {
  page_id: 'fb_page_default',
  page_name: 'Negocio MainSpot',
  profile_picture_url: 'https://sim.mainspot.local/fb/default.png',
};

export class SimulatedMeta implements SocialProvider {
  readonly provider = 'simulated' as const;

  async getPage(tenantId: string): Promise<SocialPage> {
    return { ...(PAGES[tenantId] ?? DEFAULT_PAGE) };
  }

  async publishPost(input: SocialPostInput): Promise<SocialPublishResult> {
    const canonical = [
      input.tenantId,
      input.contentType,
      input.text.trim(),
      input.imageUrl ?? '',
    ].join('::');
    const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    return { ok: true, external_ref: `sim:fb:${input.contentType}:${hash}` };
  }

  static reset(): void {
    // no-op: dataset pinned sin estado mutable.
  }
}
