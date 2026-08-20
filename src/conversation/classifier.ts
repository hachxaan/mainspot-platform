/**
 * Clasificador de intención DETERMINISTA por reglas/keywords en español
 * (INC-002, AC-004/005, REQ-004). TENTATIVA e iterable: en esta tanda no hay
 * modelo de ML; la matriz de autonomía del canon (05-GOVERNANCE-SECURITY,
 * RULE-002/003/004/005) se traduce en reglas explícitas y unit-testeadas.
 *
 * Orden de decisión (fail-closed):
 *   1. PROHIBITED   — inventar precios/condiciones comerciales (RULE-005)
 *   2. HUMAN_APPROVAL_REQUIRED — descuentos, devoluciones, permisos (RULE-004)
 *   3. CHANGE (preview_required/draft) — verbos de cambio sobre capacidades soportadas
 *   4. READ_ONLY    — consulta sin efecto externo (RULE-002)
 *   5. needs_clarification — resto (ambigüedad) sin efecto
 */

import type { ActionClass, CapabilityTarget, ClassificationResult } from './intents.ts';

const TARGETS = {
  website: ['pagina', 'página', 'web', 'sitio', 'website', 'telefono', 'teléfono', 'whatsapp', 'horario', 'direccion', 'dirección', 'menu', 'menú', 'servicios', 'nombre', 'seccion', 'sección', 'contacto', 'eslogan', 'logo', 'fotos', 'galeria', 'galería', 'mi web', 'mi pagina'],
  social: ['facebook', 'instagram', 'redes', 'red social', 'publicacion', 'publicación', 'post', 'tiktok', 'resena', 'reseña', 'google maps', 'google business'],
  domain: ['dominio', 'subdominio', 'url', '.com', '.web', 'hostinger'],
} as const;

const NEGATIVE_VERBS = ['quita', 'quitar', 'elimina', 'eliminar', 'borra', 'borrar', 'saca', 'remueve'];

const CHANGE_VERBS = [
  'cambia', 'cambiar', 'cambio', 'cambie', 'cambiame', 'actualiza', 'actualizar', 'actualizame',
  'agrega', 'agregar', 'agregame', 'añade', 'anade', 'aniade', 'agrega seccion', 'modifica', 'modificar',
  'pon', 'poner', 'ponme', 'ponle', 'edita', 'editar', 'editame', 'sube', 'subir', 'publica', 'publicar',
  'necesito cambiar', 'quiero cambiar', 'hay que cambiar', 'me gustaria cambiar',
  'cambia el', 'cambiar el', 'cambia mi', 'cambia la', 'cambiar la', 'actualiza mi', 'actualiza la',
  'modifica mi', 'modifica la', 'actualicenme', 'me cambia', 'cambiala', 'cambiarlo',
];

// Verbos de solo lectura / consulta (RULE-002).
const READ_SIGNALS = [
  'como', 'cómo', 'cuando', 'cuándo', 'cuanto', 'cuánto', 'cual', 'cuál', 'cuales', 'cuáles',
  'que es', 'qué es', 'que venden', 'qué venden', 'que ofrecen', 'donde', 'dónde', 'quien', 'quién',
  'horario de', 'horarios de', 'informacion', 'información', 'dime', 'muestrame', 'muéstrame',
  'ver', 'consulta', 'consultar', 'estado de', 'historial', 'listado', 'precio de', 'cuanto cuesta',
  'cuánto cuesta', 'que horario', 'que telefono', 'cual es', 'cuál es', 'estado',
];

// Sensibles (RULE-004): impacto comercial/reputacional/legal/financiero/de permisos.
const SENSITIVE_PATTERNS: RegExp[] = [
  /descuento/, /devolucion/, /devolución/, /compensacion/, /compensación/, /reembolso/,
  /indemniza/, /bonificacion/, /bonificación/, /permisos/, /quita.*permiso/, /cambia.*permiso/,
  /elimina.*usuario/, /bloquea.*(usuario|cliente)/, /respuesta.*resen/, /contesta.*resen/,
  /caso negativ/, /queja/, /denuncia/, /garantia/, /garantía/, /promocion de descuento/,
  /politica de/, /política de/, /condiciones de servicio/, /renegocia/, /cli[en]te molesto/,
  /cobro/, /factura/, /precio de los planes/, /plan de pago/, /terminos de/, /términos de/,
];

// Prohibido (RULE-005): el agente NO inventa precios, descuentos, devoluciones,
// compensaciones ni políticas comerciales.
const PROHIBITED_PATTERNS: RegExp[] = [
  /inventa\w*\s+(un |una |el |la )?(precio|costo|tarifa|cuota|descuento|devolucion|devolución|compensacion|compensación|politica|política|plan|paquete|mensualidad)/,
  /inventa\w*\s+(precios|tarifas|cuotas|descuentos|devoluciones)/,
  /(pon|ponle|ponme|fija|fijar|crea|crear|agrega|agregar|define|definir|escribe|actualiza)\w*\s+(un |una |el |la )?(precio|costo|tarifa|cuota|mensualidad|descuento de)/,
  /oculta\w*\s+(la )?(resena|reseña|opinion|opinión|comentario)/,
  /borra\w*\s+(la )?(resena|reseña|opinion|opinión|comentario)/,
  /[0-9]+\s*(soles|sol|usd|dolares|dólares|dolar|dólar|pesos|euros)\s*(con|por|al)?\s*descuento/,
  /pon\w*\s+(precio|costo).*\$(s|\.)?\s*\d+/,
];

// Patrones de edición de web (deterministas, TENTATIVA) — script separado (edit-mapper).
export function detectCapabilityTarget(text: string): CapabilityTarget {
  if (TARGETS.social.some((t) => text.includes(t))) return 'social';
  if (TARGETS.website.some((t) => text.includes(t))) return 'website';
  if (TARGETS.domain.some((t) => text.includes(t))) return 'domain';
  return 'unknown';
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[áàä]/g, 'a')
    .replace(/[éèë]/g, 'e')
    .replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o')
    .replace(/[úùü]/g, 'u')
    .replace(/ñ/g, 'n')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsReadSignal(n: string): boolean {
  return READ_SIGNALS.some((s) => n.includes(s));
}

function containsChangeVerb(n: string): boolean {
  return CHANGE_VERBS.some((v) => n.includes(v));
}

/** Declaración de nuevo valor ("mi teléfono es ...", "el horario ahora es ..."). */
function isStateDirective(n: string): boolean {
  return /(mi|el|la|nuestro|nuestro)\s*(telefono|teléfono|horario|direccion|dirección|whatsapp|nombre|servicio)\s+(es|sera|será|ahora es|queda)/.test(n) &&
    !containsReadSignal(n);
}

function matchesAny(n: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(n));
}

/** Clasifica un mensaje normalizado (paso 2 de FLOW-001). */
export function classifyIntent(rawText: string): ClassificationResult {
  const n = normalize(rawText);
  const target = detectCapabilityTarget(n);

  // 1) PROHIBITED (RULE-005) — prioridad máxima: bloquea sin efecto.
  if (matchesAny(n, PROHIBITED_PATTERNS)) {
    return {
      intent: 'rule.prohibited_commercial',
      actionClass: 'prohibited',
      capabilityTarget: target === 'unknown' ? (n.includes('precio') || n.includes('costo') ? 'unknown' : 'unknown') : target,
      proposalType: null,
      confidence: 'high',
      reason: 'rule_005: cannot invent prices or commercial terms',
    };
  }

  // 2) Sensible (RULE-004): requiere aprobación humana explícita.
  if (matchesAny(n, SENSITIVE_PATTERNS)) {
    return {
      intent: 'sensitive.business_decision',
      actionClass: 'human_approval_required',
      capabilityTarget: target,
      proposalType: 'sensitive.business_decision',
      confidence: 'high',
      reason: 'rule_004: sensitive decision requires human approval',
    };
  }

  // 3) Cambio visible o propuesta (FLOW-002).
  if (containsChangeVerb(n) || isStateDirective(n)) {
    if (target === 'social') {
      // Capacidad no implementada en esta tanda (INC-005 futuro): bloquear sin
      // efecto con mensaje claro (sin base canónica implementada).
      return {
        intent: 'capability.unsupported',
        actionClass: 'prohibited',
        capabilityTarget: target,
        proposalType: null,
        confidence: 'medium',
        reason: 'capability_not_implemented_in_this_increment',
      };
    }
    if (target === 'website' || target === 'domain') {
      return {
        intent: 'website.edit',
        actionClass: 'preview_required',
        capabilityTarget: 'website',
        proposalType: 'website.edit',
        confidence: containsChangeVerb(n) ? 'high' : 'medium',
        reason: 'visible_change_requires_confirmation_and_preview',
      };
    }
    return {
      intent: 'change.ambiguous',
      actionClass: 'preview_required',
      capabilityTarget: 'website',
      proposalType: 'website.edit',
      confidence: 'medium',
      reason: 'change_intent_detected_with_default_website_target',
    };
  }

  // Sugerencia/borrador (matriz DRAFT): propuesta sin publicar ni enviar.
  if (/(sugie(re|r|s)|propo[nr]|propon|redacta|propuesta de|bosquejo de texto|eslogan para)/.test(n)) {
    return {
      intent: 'content.suggestion',
      actionClass: 'draft',
      capabilityTarget: target === 'website' ? 'website' : 'website',
      proposalType: 'content.suggestion',
      confidence: 'high',
      reason: 'draft_suggestion_without_publication',
    };
  }

  // 4) Consulta sin efecto externo (RULE-002, AC-005).
  if (containsReadSignal(n)) {
    return {
      intent: 'query.read_only',
      actionClass: 'read_only',
      capabilityTarget: target === 'unknown' ? 'unknown' : target,
      proposalType: null,
      confidence: 'high',
      reason: 'read_only_query_answered_without_approval',
    };
  }

  // 5) Ambigüedad: sin efecto, pide aclaración.
  return {
    intent: 'request.needs_clarification',
    actionClass: 'draft',
    capabilityTarget: target,
    proposalType: null,
    confidence: 'low',
    reason: 'ambiguous_intent_no_effect',
  };
}

/** Solo para tests/auditoría: expone señales en lenguaje claro. */
export function debugSignals(rawText: string): { change: boolean; read: boolean; target: CapabilityTarget } {
  const n = normalize(rawText);
  return { change: containsChangeVerb(n), read: containsReadSignal(n), target: detectCapabilityTarget(n) };
}

export const CAPABILITY_TARGETS = TARGETS;
export const NEGATIVE_CHANGE_VERBS = NEGATIVE_VERBS;
