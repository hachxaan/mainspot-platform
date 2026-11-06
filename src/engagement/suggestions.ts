/**
 * DEC-0078 (SRC-0018 = SRC-007 del propietario): IA para comentarios de Facebook.
 *
 * FB-1 — modo de SUGERENCIAS por negocio (nunca de publicación):
 *  - `off`: MainSpot no prepara sugerencias con IA; responder a mano siempre funciona.
 *  - `on_demand` (predeterminado sin configuración): solo «Sugerir con IA» de una persona prepara una propuesta.
 *  - `auto_suggest`: opt-in informado y versionado; prepara una propuesta para cada comentario que la amerite, para
 *    revisión humana. No autoriza publicar: la publicación automática es la política `safe_auto_reply` con su propio
 *    consentimiento y su máximo por hora.
 * FB-2 — antes de gastar: la redacción para PUBLICAR solo ocurre si la respuesta automática todavía puede publicarse
 *   (política vigente, elegibilidad y máximo por hora); la sugerencia automática para revisión puede generarse aunque la
 *   publicación esté limitada, dentro de su propio medidor y del presupuesto. Ninguna de las dos gasta en comentarios
 *   que no la ameritan (`textRelevance` + duplicados).
 * Medidor: `ai_facebook_suggestions` (registro de planes v3), como máximo 1 por comentario entre todos los caminos
 * (clave `fb_suggestion:<case_id>`); sin valor en el plan se deniega (activación comercial BLOCKED).
 */

import type { EngagementOrigin } from './classifier.ts';

export const SUGGESTION_ORIGINS = ['facebook_comment'] as const;
export type SuggestionOrigin = (typeof SUGGESTION_ORIGINS)[number];
export const SUGGESTION_MODES = ['off', 'on_demand', 'auto_suggest'] as const;
export type SuggestionMode = (typeof SUGGESTION_MODES)[number];

/** DEC-0078 R1: modo efectivo de un negocio sin configuración guardada. */
export const DEFAULT_SUGGESTION_MODE: SuggestionMode = 'on_demand';

/** DEC-0078 R5: medidor propio de la IA de comentarios de Facebook (nunca `ai_review_replies`). */
export const AI_FACEBOOK_SUGGESTION_CAPABILITY = 'ai_facebook_suggestions' as const;

/** Clave del libro de cuotas: un comentario consume como máximo una unidad entre todos los caminos. */
export function facebookSuggestionQuotaKey(caseId: string): string {
  return `fb_suggestion:${caseId}`;
}

export function isSuggestionOrigin(origin: EngagementOrigin): origin is SuggestionOrigin {
  return (SUGGESTION_ORIGINS as readonly string[]).includes(origin);
}

/** Fila append-only de `engagement_suggestion_setting` (migración 0038). */
export interface SuggestionSettingRow {
  setting_id: string;
  tenant_id: string;
  origin: SuggestionOrigin;
  version: number;
  mode: SuggestionMode;
  consent_text: string | null;
  consent_version: string | null;
  consent_sha256: string | null;
  decided_by: string;
  created_at: string;
}

/** Modo efectivo con su procedencia; `setting_id` null = predeterminado (sin fila). */
export interface SuggestionSetting {
  origin: SuggestionOrigin;
  mode: SuggestionMode;
  setting_id: string | null;
  version: number;
  default: boolean;
  consent_version: string | null;
  /** `auto_suggest` con EXACTAMENTE los términos vigentes (versión y huella): solo entonces prepara sugerencias solo. */
  consent_current: boolean;
  decided_by: string | null;
  created_at: string | null;
}

/** Motivo por el que un comentario no amerita gastar IA sin que nadie la pida (null = la amerita). */
export type IrrelevanceReason = 'no_text' | 'mention_only' | 'link' | 'duplicate';

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const MENTION_OR_TAG = /[@#][\p{L}\p{N}_.]+/gu;
const LINK = /(?:https?:\/\/|www\.)\S+|\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[a-z]{2,}\/\S*/iu;

/**
 * Filtros deterministas previos al gasto automático (FB-2): un comentario sin letras ni números (solo emojis o signos),
 * hecho solo de menciones o etiquetas, o con un enlace (patrón habitual de spam) no se redacta con IA por sí solo.
 * Una persona siempre puede pedir la sugerencia a mano. Los duplicados se comprueban en la BD (`EngagementService`).
 */
export function textRelevance(body: string): Exclude<IrrelevanceReason, 'duplicate'> | null {
  if (!LETTER_OR_DIGIT.test(body)) return 'no_text';
  if (LINK.test(body)) return 'link';
  if (!LETTER_OR_DIGIT.test(body.replace(MENTION_OR_TAG, ' '))) return 'mention_only';
  return null;
}
