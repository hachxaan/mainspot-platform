/**
 * SEC-CONSENT-01 (DEC-0077 R3/R8; BR-0007): términos versionados de la autorización de respuestas automáticas.
 *
 * - Cada política guarda el texto literal aceptado, su versión y su huella sha256 (migración 0037; la BD rechaza una
 *   huella que no corresponda al texto y cualquier UPDATE de la política).
 * - Las respuestas automáticas a reseñas de Google redactadas con IA gastan la cuota mensual compartida con «Redactar
 *   con IA» (DEC-0076/DEC-0077). Solo pueden gastarla las políticas cuyo consentimiento es EXACTAMENTE la versión
 *   vigente de estos términos, que explica ese gasto y que puede agotar la cuota. Las políticas anteriores (sin versión)
 *   o con otra versión siguen respondiendo, pero con el texto seguro sin IA que su consentimiento ya autorizaba, hasta
 *   que el negocio acepte los términos vigentes (`EngagementService.reconsent`).
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
  facebook_comment: terms('auto_reply.facebook_comment.v2',
    'Autorizo a MainSpot a responder públicamente en mi nombre los comentarios de Facebook de esta categoría que pasen todas las comprobaciones de seguridad (sin riesgos, sin quejas, con datos verificados). Cuando la IA de MainSpot redacta la respuesta, se publica indicando que es una respuesta automática generada con IA. Estas respuestas no usan las respuestas con IA de mi plan para reseñas de Google; las limitan el máximo de respuestas automáticas por hora y los presupuestos técnicos de IA de MainSpot. Si se alcanza el máximo por hora, el comentario queda para mi revisión; si la IA no puede redactar la respuesta, MainSpot usa un texto seguro sin IA o deja el comentario para mi revisión. Las demás interacciones quedan para mi revisión. Puedo revocarlo en cualquier momento.'),
});

/** `review_required` no autoriza nada público; se versiona igual para que todo registro nuevo tenga su huella. */
export const REVIEW_REQUIRED_CONSENT: ConsentTerms = terms('review_required.v1',
  'Todas las respuestas públicas de esta categoría quedan pendientes de mi revisión.');

export interface ConsentedPolicy {
  origin: EngagementOrigin;
  mode: 'review_required' | 'safe_auto_reply';
  consent_version: string | null;
  consent_sha256: string | null;
}

/** ¿La política guarda EXACTAMENTE los términos vigentes de su origen (versión y huella del texto)? */
export function consentIsCurrent(policy: ConsentedPolicy): boolean {
  const terms = AUTO_REPLY_CONSENT[policy.origin];
  return policy.consent_version === terms.version && policy.consent_sha256 === terms.sha256;
}

/**
 * ¿El consentimiento de esta política cubre gastar respuestas con IA de la cuota de reseñas? Solo los términos
 * vigentes, por versión Y huella: una fila con la versión vigente pero otro texto no cubre nada.
 */
export function consentCoversAiSpend(policy: ConsentedPolicy): boolean {
  return policy.origin === 'google_review' && policy.mode === 'safe_auto_reply' && consentIsCurrent(policy);
}

/**
 * ¿Debe el negocio aceptar los términos vigentes? Solo las respuestas automáticas a reseñas de Google gastan la cuota;
 * en Facebook el consentimiento anterior sigue cubriendo lo que autoriza (sin cuota).
 */
export function reconsentRequired(policy: ConsentedPolicy): boolean {
  return policy.origin === 'google_review' && policy.mode === 'safe_auto_reply' && !consentCoversAiSpend(policy);
}

/** Términos que el panel muestra literalmente antes de aceptar (sin huellas: las calcula el servidor). */
export function consentTermsView(): Record<EngagementOrigin, { version: string; text: string }> {
  return {
    google_review: { version: AUTO_REPLY_CONSENT.google_review.version, text: AUTO_REPLY_CONSENT.google_review.text },
    facebook_comment: { version: AUTO_REPLY_CONSENT.facebook_comment.version, text: AUTO_REPLY_CONSENT.facebook_comment.text },
  };
}
