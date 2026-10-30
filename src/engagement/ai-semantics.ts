/**
 * Atención con el AI Core (FR-0016): Jev lee cada comentario/reseña (sentimiento, categoría,
 * urgencia, riesgos, datos personales) y la respuesta se redacta con hechos verificados.
 *
 * - Ruta activa del caso de uso => Jev es la fuente semántica. Si falla, el caso va a revisión
 *   humana (nunca se cae a palabras clave para decidir publicar).
 * - Sin ruta activa en este entorno (AI Core no desplegado para ese caso de uso) => `not_configured`:
 *   sigue la política determinista aprobada en DEV-E2E-02, marcada sin fuente semántica.
 * - Las banderas de riesgo deterministas se SUMAN a las de Jev (red de seguridad; nunca restan).
 * - La respuesta generada pasa `replyViolations`; si pide humano o falla, se usa el texto seguro.
 */

import type { AiDispatcher } from '../ai/dispatcher.ts';
import { replyViolations, type ReplyOutput } from '../ai/contracts.ts';
import type { Answer, ChoiceAnswer, NoulAnswer } from '../jev/types.ts';
import type { Classification, EngagementCategory, InfoTopic } from './classifier.ts';
import type { CaseRow } from './service.ts';

export const RISK_THRESHOLD = 0.5;

export type SemanticRead =
  | { ok: true; classification: Classification; invocationId: string; reading: Record<string, unknown> }
  | { ok: false; source: 'blocked_external' | 'unavailable' | 'not_configured' };

export interface EngagementSemantics {
  read(row: CaseRow): Promise<SemanticRead>;
  reply(row: CaseRow, c: Classification, facts: Record<string, unknown>): Promise<{ text: string; needsHuman: boolean; invocationId: string } | null>;
}

const choiceOf = (a: Answer | undefined): ChoiceAnswer | null => (a && a.type === 'choice' ? (a as ChoiceAnswer) : null);
const noulOf = (a: Answer | undefined): number => (a && a.type === 'noul' ? (a as NoulAnswer).noul : 0);

/** Lectura de Jev -> clasificación del agente (sin el texto del cliente). */
export function toClassification(answers: Record<string, Answer>): { classification: Classification; reading: Record<string, unknown> } {
  const sentiment = (choiceOf(answers['sentiment'])?.choice ?? 'neutral') as Classification['sentiment'];
  const cat = choiceOf(answers['category']);
  const topic = choiceOf(answers['info_topic'])?.choice ?? 'none';
  const urgency = choiceOf(answers['urgency'])?.choice ?? 'normal';
  const flags: string[] = [];
  if (noulOf(answers['risk_safety']) >= RISK_THRESHOLD) flags.push('safety');
  if (noulOf(answers['risk_legal']) >= RISK_THRESHOLD) flags.push('legal');
  if (noulOf(answers['personal_data']) >= RISK_THRESHOLD) flags.push('private_data');
  if (noulOf(answers['abusive']) >= RISK_THRESHOLD) flags.push('threat');
  if (urgency === 'high') flags.push('urgent');
  const category: EngagementCategory = cat?.choice === 'gratitude' ? 'gratitude' : cat?.choice === 'basic_info' && topic !== 'none' ? 'basic_info' : 'other';
  const classification: Classification = {
    category, risk_flags: flags, confidence: Number((cat?.confidence ?? 0).toFixed(2)), sentiment,
    info_topic: category === 'basic_info' ? (topic as InfoTopic) : null,
  };
  const reading = {
    sentiment, category: cat?.choice ?? null, info_topic: topic, urgency,
    risks: { safety: noulOf(answers['risk_safety']), legal: noulOf(answers['risk_legal']), personal_data: noulOf(answers['personal_data']), abusive: noulOf(answers['abusive']) },
    confidence: cat?.confidence ?? null,
  };
  return { classification, reading };
}

export class AiEngagementSemantics implements EngagementSemantics {
  private readonly dispatcher: AiDispatcher;
  private readonly environment: string;

  constructor(deps: { dispatcher: AiDispatcher; environment: string }) {
    this.dispatcher = deps.dispatcher;
    this.environment = deps.environment;
  }

  private async active(useCase: string): Promise<boolean> {
    return Boolean((await this.dispatcher.registry.rollout(useCase, this.environment))?.active_route_id);
  }

  async read(row: CaseRow): Promise<SemanticRead> {
    const uc = row.origin === 'google_review' ? 'engagement.google.review.classify' : 'engagement.facebook.comment.classify';
    if (!(await this.active(uc))) return { ok: false, source: 'not_configured' };
    const res = await this.dispatcher.invokeClassification(uc, {
      requestId: `eng_${row.case_id}`, idempotencyKey: `case:${row.case_id}:read`, tenantId: row.tenant_id, actorId: 'system:engagement-agent',
      actorKind: 'system', origin: 'engagement.case', consentRef: null,
    }, { message: row.body, ...(row.rating ? { rating_stars: row.rating } : {}) });
    if (!res.ok) return { ok: false, source: res.code === 'blocked_external' ? 'blocked_external' : 'unavailable' };
    return { ok: true, invocationId: res.invocationId, ...toClassification(res.output.answers) };
  }

  async reply(row: CaseRow, c: Classification, facts: Record<string, unknown>): Promise<{ text: string; needsHuman: boolean; invocationId: string } | null> {
    const uc = row.origin === 'google_review' ? 'engagement.google.review.reply' : 'engagement.facebook.comment.reply';
    if (!(await this.active(uc))) return null;
    const res = await this.dispatcher.invokeStructured<ReplyOutput>(uc, {
      requestId: `eng_${row.case_id}`, idempotencyKey: `case:${row.case_id}:reply`, tenantId: row.tenant_id, actorId: 'system:engagement-agent',
      actorKind: 'system', origin: 'engagement.case',
    }, {
      facts, reading: { sentiment: c.sentiment, category: c.category, risks: c.risk_flags },
      author: row.author_label || 'cliente', rating: row.rating ? String(row.rating) : 'n/a', message: row.body,
    }, { domainCheck: (out) => replyViolations(out) });
    if (!res.ok) return null;
    return { text: res.output.reply, needsHuman: res.output.needs_human, invocationId: res.invocationId };
  }
}
