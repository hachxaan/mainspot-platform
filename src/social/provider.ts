/**
 * SocialProvider — publicaciones de Facebook y Facebook Ads básicos (INC-005,
 * CAP-003, REQ-014, DEC-017).
 *
 * DEC-026: interfaz de adaptador + implementación real opcional (API Graph de
 * Meta) + MODO SIMULADO funcional (E2E/piloto sin credenciales). El adaptador
 * real SOLO se instancia con META_GRAPH_TOKEN; sin token SIEMPRE se usa
 * SimulatedMeta (fail-safe: nunca se llama a la API real sin credenciales).
 *
 * Campañas avanzadas e Instagram QUEDAN FUERA del MVP (DEC-017): el permiso
 * social.campaign_advanced está bloqueado para todos los roles.
 */

import type { AppConfig } from '../shared/config.ts';

export type SocialContentType = 'post' | 'ad';

export interface SocialPostInput {
  tenantId: string;
  text: string;
  imageUrl?: string | null;
  contentType: SocialContentType;
}

export interface SocialPublishResult {
  ok: boolean;
  /** Identificador único de la publicación (idempotente, AC-007). */
  external_ref: string;
  error?: string;
}

export interface SocialPage {
  page_id: string;
  page_name: string;
  profile_picture_url: string;
}

export interface SocialProvider {
  readonly provider: 'simulated' | 'meta';
  /** Página/proyecto de la red del tenant (determinista en modo simulado). */
  getPage(tenantId: string): Promise<SocialPage>;
  /** Publica un post/ad básico. Debe ser idempotente por contenido. */
  publishPost(input: SocialPostInput): Promise<SocialPublishResult>;
}
