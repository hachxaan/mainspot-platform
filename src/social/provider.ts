/**
 * SocialProvider — publicaciones de Facebook y Facebook Ads básicos (INC-005,
 * CAP-003, REQ-014, DEC-017).
 *
 * DEC-026: interfaz de adaptador + implementación real (API Graph de Meta por
 * conexión de cada negocio, src/social/meta-graph.ts) + MODO SIMULADO funcional
 * (E2E/piloto sin credenciales). SOCIAL_PROVIDER=meta exige clave de cifrado y nunca
 * sustituye una conexión real ausente por datos simulados.
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
  /** Clave de idempotencia local (una por publicación programada); el proveedor real la
   *  usa para reconciliar, el simulador la ignora (es idempotente por contenido). */
  idempotencyKey?: string;
}

export interface SocialPublishResult {
  ok: boolean;
  /** Identificador único de la publicación (idempotente, AC-007). */
  external_ref: string;
  error?: string;
  /** Fallo transitorio (cuota, 5xx): el scheduler reintenta con backoff acotado. */
  retryable?: boolean;
  /** Resultado DESCONOCIDO (timeout tras enviar, read-back fallido): no reenviar a ciegas;
   *  el scheduler reconcilia con `findPublishedPost` o pide revisión humana. */
  uncertain?: boolean;
  /** Espera mínima sugerida por el proveedor (Retry-After / cuota). */
  retryAfterMs?: number;
}

export interface SocialPage {
  page_id: string;
  page_name: string;
  profile_picture_url: string;
}

export type SocialPostLookup = { found: true; external_ref: string } | { found: false };

export interface SocialProvider {
  readonly provider: 'simulated' | 'meta';
  /** true si repetir publishPost con el mismo contenido NUNCA duplica (simulador). Con
   *  false, una fila con lease vencido pasa a 'uncertain' y se reconcilia antes de reintentar. */
  readonly idempotentPublish: boolean;
  /** Página/proyecto de la red del tenant (determinista en modo simulado). */
  getPage(tenantId: string): Promise<SocialPage>;
  /** Publica un post/ad básico; idempotentPublish declara si es seguro repetirlo. */
  publishPost(input: SocialPostInput): Promise<SocialPublishResult>;
  /** Reconciliación por identificador confirmado, nunca por texto coincidente de otra publicación. */
  findPublishedPost?(input: { tenantId: string; text: string; since: Date; externalRef: string | null }): Promise<SocialPostLookup>;
}
