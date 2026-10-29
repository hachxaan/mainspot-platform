/**
 * Clasificación y decisión deterministas del agente de atención (SHARED-CONTRACT §B).
 *
 * El motor NO usa IA para decidir publicar: reglas explícitas y auditables. La calificación o
 * el sentimiento por sí solos nunca autorizan una respuesta automática; hace falta una política
 * opt-in vigente para el origen y la categoría, confianza suficiente, sin señales de riesgo,
 * datos verificados (si la respuesta los cita) y cupo de frecuencia. Ante cualquier duda:
 * revisión humana.
 */

export type EngagementOrigin = 'google_review' | 'facebook_comment';
export type EngagementCategory = 'gratitude' | 'basic_info' | 'other';
export type InfoTopic = 'phone' | 'hours' | 'address';

export interface Classification {
  category: EngagementCategory;
  risk_flags: string[];
  confidence: number;
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  info_topic: InfoTopic | null;
}

function norm(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const RISK_LEXICON: Record<string, readonly string[]> = {
  legal: ['abogado', 'demanda', 'denuncia', 'profeco', 'tribunal', 'juicio', 'legal'],
  compensation: ['reembolso', 'devolucion', 'devuelvan', 'descuento', 'compensa', 'gratis', 'cupon', 'regalo', 'dinero', 'reponer', 'promocion', 'oferta', '2x1', 'precio'],
  safety: ['intoxi', 'enferm', 'hospital', 'alergi', 'emergencia', 'peligro', 'accidente', 'herid', 'incendio', 'vomit', 'diarrea'],
  threat: ['amenaz', 'matar', 'golpe', 'violencia', 'idiota', 'estupid', 'pendej', 'imbecil'],
  accusation: ['robo', 'robaron', 'estafa', 'fraude', 'ladron', 'engano', 'mentiros'],
};

const NEGATIVE_CUES = ['malo', 'mala ', 'pesimo', 'horrible', 'frio', 'tardo', 'tarde', 'nunca', 'no recog', 'queja', 'mal servicio',
  'sucio', 'grosero', 'decepcion', 'lento', 'no me gusto', 'no volvere', 'caro', 'espera'];
const POSITIVE_CUES = ['gracias', 'excelente', 'delicios', 'rico', 'increible', 'encanto', 'recomiendo', 'buenisim', 'espectacular',
  'felicidades', '10/10', 'volveremos', 'volvere', 'me gusto', 'muy bueno', 'muy buena', 'genial', 'amables', 'perfecto'];
const INFO_CUES: Record<InfoTopic, readonly string[]> = {
  phone: ['telefono', 'numero', 'whatsapp', 'llamar', 'contacto'],
  hours: ['horario', 'a que hora', 'abren', 'cierran', 'que dias'],
  address: ['direccion', 'donde estan', 'ubicacion', 'como llego', 'donde queda'],
};

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LONG_DIGITS_RE = /(?:\d[\s-]?){7,}/;

export function classify(input: { body: string; rating: number | null; origin: EngagementOrigin }): Classification {
  const text = norm(input.body);
  const flags = Object.entries(RISK_LEXICON).filter(([, words]) => words.some((w) => text.includes(w))).map(([flag]) => flag);
  if (EMAIL_RE.test(input.body) || LONG_DIGITS_RE.test(input.body)) flags.push('private_data');
  const negative = NEGATIVE_CUES.some((w) => text.includes(w)) || (input.rating !== null && input.rating <= 3);
  const positive = POSITIVE_CUES.some((w) => text.includes(w));
  const isQuestion = input.body.includes('?') || input.body.includes('¿');
  const topics = (Object.keys(INFO_CUES) as InfoTopic[]).filter((k) => INFO_CUES[k].some((w) => text.includes(w)));
  const sentiment: Classification['sentiment'] = positive && negative ? 'mixed' : positive ? 'positive' : negative ? 'negative' : 'neutral';

  if (flags.length > 0) return { category: 'other', risk_flags: flags, confidence: 0.95, sentiment, info_topic: null };
  if (isQuestion && topics.length === 1 && !negative) {
    return { category: 'basic_info', risk_flags: [], confidence: 0.85, sentiment, info_topic: topics[0] ?? null };
  }
  if (isQuestion) return { category: 'other', risk_flags: [], confidence: 0.5, sentiment, info_topic: null };
  // Agradecimiento: señales positivas en el TEXTO, sin negativas; en reseñas además ≥4★.
  const ratingOk = input.origin !== 'google_review' || (input.rating !== null && input.rating >= 4);
  if (positive && !negative && ratingOk) {
    return { category: 'gratitude', risk_flags: [], confidence: input.body.trim().length >= 8 ? 0.9 : 0.75, sentiment, info_topic: null };
  }
  return { category: 'other', risk_flags: [], confidence: 0.6, sentiment, info_topic: null };
}

export interface PolicySnapshot {
  policy_id: string;
  version: number;
  mode: 'review_required' | 'safe_auto_reply';
  max_auto_replies_per_hour: number;
}

export interface DecisionInput {
  classification: Classification;
  policy: PolicySnapshot | null;
  autoRepliesLastHour: number;
  /** Respuesta con datos verificados (solo basic_info); null si falta el dato. */
  verifiedAnswer: string | null;
}

export type Decision =
  | { decision: 'auto_reply'; reason: string }
  | { decision: 'human_review'; reason: string };

export const MIN_AUTO_CONFIDENCE = 0.8;

export function decide(input: DecisionInput): Decision {
  const c = input.classification;
  if (c.risk_flags.length > 0) return { decision: 'human_review', reason: `risk:${c.risk_flags.join(',')}` };
  if (c.category === 'other') return { decision: 'human_review', reason: 'category_not_safe' };
  if (!input.policy) return { decision: 'human_review', reason: 'no_policy' };
  if (input.policy.mode !== 'safe_auto_reply') return { decision: 'human_review', reason: 'policy_review_required' };
  if (c.confidence < MIN_AUTO_CONFIDENCE) return { decision: 'human_review', reason: 'low_confidence' };
  if (c.category === 'basic_info' && !input.verifiedAnswer) return { decision: 'human_review', reason: 'unverified_data' };
  if (input.autoRepliesLastHour >= input.policy.max_auto_replies_per_hour) return { decision: 'human_review', reason: 'rate_limited' };
  return { decision: 'auto_reply', reason: `policy:${input.policy.policy_id}:v${input.policy.version}` };
}

/** Respuesta automática segura (sin promesas comerciales). */
export function autoReplyText(input: { category: EngagementCategory; author: string; business: string; verifiedAnswer: string | null }): string {
  const author = input.author.trim() || 'gracias por escribirnos';
  if (input.category === 'basic_info' && input.verifiedAnswer) return `Hola ${author}, ${input.verifiedAnswer}`;
  return `¡Gracias por tu comentario, ${author}! Nos alegra mucho que hayas disfrutado ${input.business}. Te esperamos pronto.`;
}

/**
 * Hasta 3 borradores editables para revisión humana. Nunca ofrecen descuentos, reembolsos ni
 * decisiones comerciales; ante riesgo invitan a un canal privado.
 */
export function humanDrafts(input: { classification: Classification; author: string; business: string; verifiedAnswer: string | null }): string[] {
  const author = input.author.trim() || 'hola';
  const biz = input.business.trim() || 'nuestro negocio';
  const c = input.classification;
  if (c.risk_flags.length > 0 || c.sentiment === 'negative' || c.sentiment === 'mixed') {
    return [
      `Hola ${author}, gracias por contarnos tu experiencia. Lamentamos lo ocurrido. En ${biz} queremos revisarlo con calma: escríbenos por mensaje privado y un responsable te atenderá.`,
      `Hola ${author}, tomamos nota de lo que nos cuentas y lo estamos revisando. Te pedimos contactarnos por mensaje privado para darle seguimiento.`,
      `Hola ${author}, gracias por avisarnos. Tu comentario es importante para ${biz}; un responsable se pondrá en contacto contigo por un canal privado.`,
    ];
  }
  if (c.category === 'basic_info' && input.verifiedAnswer) {
    return [
      `Hola ${author}, ${input.verifiedAnswer}`,
      `¡Hola ${author}! ${input.verifiedAnswer} Con gusto te atendemos.`,
      `Hola ${author}, gracias por tu pregunta. ${input.verifiedAnswer}`,
    ];
  }
  if (c.sentiment === 'positive') {
    return [
      `¡Gracias por tu comentario, ${author}! Nos alegra mucho que hayas disfrutado ${biz}.`,
      `Hola ${author}, ¡gracias por tu opinión! Significa mucho para nosotros.`,
      `Gracias, ${author}. Te esperamos pronto en ${biz}.`,
    ];
  }
  return [
    `Hola ${author}, gracias por escribirnos. Lo revisamos y te respondemos a la brevedad.`,
    `Hola ${author}, gracias por tu comentario. Si quieres darnos más detalles, escríbenos por mensaje privado.`,
    `Hola ${author}, tomamos nota de tu mensaje. Gracias por ayudarnos a mejorar ${biz}.`,
  ];
}
