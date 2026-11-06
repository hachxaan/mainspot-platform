/**
 * SEC-CONSENT-01 (DEC-0077 R3/R8; DEC-0078 R5/R6; BR-0007): términos versionados de las autorizaciones que gastan IA.
 *
 * - Cada política de respuestas automáticas guarda el texto literal aceptado, su versión y su huella sha256 (migración
 *   0037; la BD rechaza una huella que no corresponda al texto y cualquier UPDATE de la política). Lo mismo cada
 *   activación de las sugerencias automáticas de comentarios de Facebook (`engagement_suggestion_setting`, 0038).
 * - Las respuestas automáticas redactadas con IA gastan el medidor de su origen: reseñas de Google, la cuota mensual
 *   compartida con «Redactar con IA» (DEC-0076/DEC-0077); comentarios de Facebook, las sugerencias con IA de ese canal,
 *   compartidas con las sugerencias automáticas y a pedido (DEC-0078). Solo pueden gastarlo las políticas cuyo
 *   consentimiento es EXACTAMENTE la versión vigente de estos términos, que explica ese gasto. Las políticas anteriores
 *   (sin versión) o con otra versión siguen respondiendo, pero con el texto seguro sin IA que su consentimiento ya
 *   autorizaba, hasta que el negocio acepte los términos vigentes (`EngagementService.reconsent`): nunca se cambian solas.
 * - Cambiar cualquier texto de abajo exige subir su versión: la persona debe aceptar lo que se le muestra, y el panel
 *   envía la versión que mostró (409 si ya no es la vigente).
 */

import { createHash } from 'node:crypto';
import type { EngagementOrigin } from './classifier.ts';

export interface ConsentTerms {
  version: string;
  text: string;
  sha256: string;
}

export function consentSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function terms(version: string, text: string): ConsentTerms {
  return Object.freeze({ version, text, sha256: consentSha256(text) });
}

/** Términos vigentes de `safe_auto_reply` por origen. */
export const AUTO_REPLY_CONSENT: Readonly<Record<EngagementOrigin, ConsentTerms>> = Object.freeze({
  google_review: terms('auto_reply.google_review.v2',
    'Autorizo a MainSpot a responder públicamente en mi nombre las reseñas de Google de esta categoría que pasen todas las comprobaciones de seguridad (sin riesgos, sin quejas, con datos verificados). Cuando la IA de MainSpot redacta la respuesta, se publica indicando que es una respuesta automática generada con IA. Entiendo que cada respuesta automática redactada con IA usa 1 de las respuestas con IA de mi plan en el ciclo mensual, la misma bolsa que uso al pedir «Redactar con IA», y que estas respuestas automáticas pueden agotarla antes de que termine el ciclo, de modo que no me queden respuestas con IA para pedir propuestas hasta la renovación. Cuando no quedan respuestas con IA, MainSpot responde estas reseñas con un texto seguro sin IA y sin cargos. Las demás interacciones quedan para mi revisión. Puedo revocarlo en cualquier momento.'),
  facebook_comment: terms('auto_reply.facebook_comment.v3',
    'Autorizo a MainSpot a responder públicamente en mi nombre los comentarios de Facebook de esta categoría que pasen todas las comprobaciones de seguridad (sin riesgos, sin quejas, con datos verificados). Cuando la IA de MainSpot redacta la respuesta, se publica indicando que es una respuesta automática generada con IA. Entiendo que cada respuesta automática redactada con IA usa 1 de las sugerencias con IA para comentarios de Facebook de mi plan en el ciclo mensual, la misma bolsa que las sugerencias con IA de esos comentarios (aparte de las respuestas con IA de reseñas de Google), aunque al final no se publique, y que puede agotarla antes de la renovación. MainSpot solo redacta con IA para publicar cuando la respuesta automática todavía puede publicarse: si ya se alcanzó el máximo de respuestas automáticas por hora, el comentario queda para mi revisión sin redactarse con IA para publicarlo. Cuando no quedan sugerencias con IA o la IA no puede redactar la respuesta, MainSpot usa un texto seguro sin IA o deja el comentario para mi revisión. Las demás interacciones quedan para mi revisión. Puedo revocarlo en cualquier momento.'),
});

/** `review_required` no autoriza nada público; se versiona igual para que todo registro nuevo tenga su huella. */
export const REVIEW_REQUIRED_CONSENT: ConsentTerms = terms('review_required.v1',
  'Todas las respuestas públicas de esta categoría quedan pendientes de mi revisión.');

/**
 * DEC-0078 R1 (FB-1): términos de las sugerencias automáticas de comentarios de Facebook (`auto_suggest`). Preparan
 * propuestas para revisión humana; nunca autorizan publicar. Los modos `off` y `on_demand` no gastan nada sin una
 * petición explícita, así que no guardan consentimiento.
 */
export const AUTO_SUGGEST_CONSENT: Readonly<Record<'facebook_comment', ConsentTerms>> = Object.freeze({
  facebook_comment: terms('ai_suggestions.facebook_comment.v1',
    'Autorizo a MainSpot a preparar con IA, sin que yo lo pida cada vez, una sugerencia de respuesta para cada comentario de Facebook que la amerite (no se preparan para comentarios sin texto, solo con menciones o enlaces, ni para comentarios repetidos). Las sugerencias quedan para mi revisión: esta autorización no publica nada; publicar sigue requiriendo mi aprobación o una regla de respuestas automáticas aparte. Entiendo que cada sugerencia preparada usa 1 de las sugerencias con IA para comentarios de Facebook de mi plan en el ciclo mensual, aunque no la use ni la publique; que se usa como máximo 1 por comentario y que puedo agotarlas antes de la renovación. Cuando no quedan sugerencias con IA o se alcanza el presupuesto de IA de mi negocio, MainSpot no prepara sugerencias automáticas y puedo seguir respondiendo a mano. Puedo desactivarlo en cualquier momento.'),
});

export interface ConsentedPolicy {
  origin: EngagementOrigin;
  mode: 'review_required' | 'safe_auto_reply';
  consent_version: string | null;
  consent_sha256: string | null;
}

/** ¿La política guarda EXACTAMENTE los términos vigentes de su origen (versión y huella del texto)? */
export function consentIsCurrent(policy: ConsentedPolicy): boolean {
  const current = AUTO_REPLY_CONSENT[policy.origin];
  return policy.consent_version === current.version && policy.consent_sha256 === current.sha256;
}

/**
 * ¿El consentimiento de esta política cubre gastar IA del medidor de su origen en respuestas automáticas? Solo los
 * términos vigentes, por versión Y huella: una fila con la versión vigente pero otro texto no cubre nada.
 */
export function consentCoversAiSpend(policy: ConsentedPolicy): boolean {
  return policy.mode === 'safe_auto_reply' && consentIsCurrent(policy);
}

/** ¿Debe el negocio aceptar los términos vigentes para que sus respuestas automáticas vuelvan a usar IA? */
export function reconsentRequired(policy: ConsentedPolicy): boolean {
  return policy.mode === 'safe_auto_reply' && !consentCoversAiSpend(policy);
}

/** ¿La activación de sugerencias automáticas guarda EXACTAMENTE los términos vigentes (versión y huella)? */
export function suggestionConsentIsCurrent(setting: { consent_version: string | null; consent_sha256: string | null }): boolean {
  const current = AUTO_SUGGEST_CONSENT.facebook_comment;
  return setting.consent_version === current.version && setting.consent_sha256 === current.sha256;
}

/** Origen cuyos términos vigentes de respuestas automáticas tienen esa versión (para aceptar lo que mostró el panel). */
export function autoReplyOriginOfVersion(version: unknown): EngagementOrigin | null {
  for (const origin of Object.keys(AUTO_REPLY_CONSENT) as EngagementOrigin[]) {
    if (AUTO_REPLY_CONSENT[origin].version === version) return origin;
  }
  return null;
}

/** Términos que el panel muestra literalmente antes de aceptar (sin huellas: las calcula el servidor). */
export function consentTermsView(): Record<EngagementOrigin, { version: string; text: string }> {
  return {
    google_review: { version: AUTO_REPLY_CONSENT.google_review.version, text: AUTO_REPLY_CONSENT.google_review.text },
    facebook_comment: { version: AUTO_REPLY_CONSENT.facebook_comment.version, text: AUTO_REPLY_CONSENT.facebook_comment.text },
  };
}

/** Términos de las sugerencias automáticas que el panel muestra literalmente antes de activarlas. */
export function suggestionTermsView(): { facebook_comment: { version: string; text: string } } {
  const t = AUTO_SUGGEST_CONSENT.facebook_comment;
  return { facebook_comment: { version: t.version, text: t.text } };
}
