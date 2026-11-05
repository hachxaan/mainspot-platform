/**
 * Agente de atención por políticas (DEV-E2E-02, SHARED-CONTRACT §B).
 *
 * Flujo: ingesta → dedupe (tenant+origin+external_ref) → lectura Jev (AI Core, FR-0016; sin ruta
 *   activa: reglas deterministas) → política opt-in vigente + acción segura → respuesta con evidencia
 *   resto → caso humano (hasta 3 borradores) → panel + Telegram → aprobar/editar/rechazar →
 *   respuesta (simulada).
 *
 * Garantías: una sola respuesta pública por caso (claim atómico + idempotency key en el
 * proveedor), reintentos acotados con backoff, recuperación de envíos interrumpidos (lease),
 * auditoría de cada transición con la versión de política aplicada, aislamiento por tenant y
 * anti-oracle (404 idéntico). Los resultados del simulador se marcan `delivery_mode=simulated`.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import type { ChannelAdapter } from '../channels/types.ts';
import { formatInternational, type ContactPhoneService, type PhoneChannel } from '../contact/phones.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import { loadPinnedPolicy } from '../plans/policy.ts';
import type { QuotaLedger, QuotaReservationRow } from '../subscriptions/quota.ts';
import { autoReplyText, classify, decide, humanDrafts, type Classification, type Decision, type EngagementCategory, type EngagementOrigin, type InfoTopic, type PolicySnapshot } from './classifier.ts';
import type { EngagementSemantics } from './ai-semantics.ts';
import { consumeSimFault, type EngagementReplier, type ReplyResult } from './providers.ts';

export const ENGAGEMENT_ORIGINS = ['google_review', 'facebook_comment'] as const;
export const POLICY_CATEGORIES = ['gratitude', 'basic_info'] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];
export type PolicyMode = 'review_required' | 'safe_auto_reply';
export type CaseState =
  | 'received' | 'classified' | 'responding' | 'responded' | 'needs_human'
  | 'approved' | 'rejected' | 'retry_pending' | 'failed' | 'closed_elsewhere';

export const SYSTEM_ACTOR = 'system:engagement-agent';
export const MAX_RESPOND_ATTEMPTS = 5;
export const RESPOND_LEASE_SECONDS = 120;
export const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_TEXT = 1000;

/**
 * Aviso obligatorio en respuestas públicas automáticas redactadas por IA (política de uso de Anthropic:
 * los agentes que hablan con usuarios externos deben revelar que son IA; ver ai-providers-data-terms.md §2.7).
 */
export const AI_REPLY_DISCLOSURE = 'Respuesta automática generada con IA.';

/** DEC-0076 (SRC-0014 C01): cuota periódica de respuestas a reseñas redactadas con IA. */
export const AI_REVIEW_REPLY_CAPABILITY = 'ai_review_replies' as const;

/** Clave del libro de cuotas: un caso consume como máximo una unidad (replay ⇒ sin consumo nuevo). */
export function aiReplyQuotaKey(caseId: string): string {
  return `ai_reply:${caseId}`;
}

/**
 * Vigencia de la reserva de una respuesta con IA: cubre la redacción completa (timeout por intento de la ruta,
 * hasta 300 s, con sus reparaciones) con margen. Si aun así vence, la respuesta automática sale con el texto seguro.
 */
export const AI_REPLY_RESERVATION_TTL_MS = 15 * 60_000;

/** Estado de la cuota de respuestas con IA para el panel (misma cuenta que el enforcement). */
export interface AiReplyStatus {
  /** Hay ruta activa de redacción para reseñas en este entorno. */
  available: boolean;
  subscription_active: boolean;
  /** Valor de la revisión fijada; null si el plan no lo define (se deniega). */
  limit: number | null;
  usage: number;
  remaining: number | null;
  /** Ciclo mensual vigente [start, end) en UTC. */
  window: { start: string; end: string } | null;
}

type AiReplyClaim =
  | { kind: 'reserved'; reservation: QuotaReservationRow }
  | { kind: 'replay' }
  | { kind: 'denied'; error: AppError };

interface AiReplyActor {
  actorId: string;
  actorRole: string | null;
  requestId: string;
}

export const CONSENT_TEXT: Record<PolicyMode, string> = {
  safe_auto_reply:
    'Autorizo a MainSpot a responder públicamente en mi nombre solo los casos de esta categoría que pasen todas las comprobaciones de seguridad (sin riesgos, sin quejas, con datos verificados). Cuando la respuesta la redacta la IA de MainSpot, se publica indicando que es una respuesta automática generada con IA. En reseñas de Google, cada respuesta redactada con IA usa 1 de las respuestas con IA de mi plan en el ciclo; si no quedan, MainSpot responde con un texto seguro sin IA. Las demás interacciones quedan para mi revisión. Puedo revocarlo en cualquier momento.',
  review_required: 'Todas las respuestas públicas de esta categoría quedan pendientes de mi revisión.',
};

export interface CaseRow {
  case_id: string;
  tenant_id: string;
  origin: EngagementOrigin;
  external_ref: string;
  review_id: string | null;
  post_id: string | null;
  author_label: string;
  body: string;
  rating: number | null;
  category: EngagementCategory | null;
  risk_flags: string[];
  confidence: string | null;
  policy_id: string | null;
  policy_version: number | null;
  decision: 'auto_reply' | 'human_review' | null;
  reason: string | null;
  classified_at: string | null;
  state: CaseState;
  drafts: string[];
  response_text: string | null;
  resolved_by: string | null;
  resolution_channel: 'auto' | 'panel' | 'telegram' | null;
  resolved_at: string | null;
  attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  last_error: string | null;
  delivery_mode: 'simulated' | 'real' | null;
  /** Lectura de Jev (sin texto del cliente) y su fuente; null sin AI Core. */
  sentiment: Classification['sentiment'] | null;
  semantic: Record<string, unknown> | null;
  semantic_source: 'jev' | 'blocked_external' | 'unavailable' | null;
  /** Invocación que redactó el borrador de IA (null: ninguno). */
  reply_invocation_id: string | null;
  /** Propuesta pedida con «Redactar con IA» (aparte de `drafts`, cuya numeración usa el aviso de Telegram). */
  ai_draft: string | null;
  responded_external_ref: string | null;
  responded_at: string | null;
  notify_status: 'pending' | 'sent' | 'no_destination' | 'failed' | null;
  created_at: string;
  updated_at: string;
}

export interface PolicyRow {
  policy_id: string;
  tenant_id: string;
  origin: EngagementOrigin;
  category: PolicyCategory;
  mode: PolicyMode;
  version: number;
  max_auto_replies_per_hour: number;
  consent_text: string;
  decided_by: string;
  created_at: string;
}

export interface Actor {
  tenantId: string;
  userId: string;
  role: string | null;
  requestId: string;
}

export interface EngagementServiceDeps {
  pool: Pool;
  sink: AuditSink;
  replier: EngagementReplier;
  phones: ContactPhoneService;
  channel: ChannelAdapter;
  /** DEC-0076: libro de cuotas (redacción con IA de respuestas a reseñas). */
  quota: QuotaLedger;
  /** URL del panel incluida en los avisos (enlace autorizado: exige sesión). */
  panelUrl: string;
  /** AI Core (FR-0016): lectura Jev y respuestas con hechos verificados; ausente = solo reglas deterministas. */
  semantics?: EngagementSemantics;
}

type Db = Pool | PoolClient;

const DAY_LABEL: Record<string, string> = { mon: 'lun', tue: 'mar', wed: 'mié', thu: 'jue', fri: 'vie', sat: 'sáb', sun: 'dom' };

function backoffSeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
}

function originChannel(origin: EngagementOrigin): PhoneChannel {
  return origin === 'google_review' ? 'google_business_profile' : 'facebook';
}

export class EngagementService {
  readonly deps: EngagementServiceDeps;

  constructor(deps: EngagementServiceDeps) {
    this.deps = deps;
  }

  // ---------------------------------------------------------------- políticas

  async currentPolicies(tenantId: string, db: Db = this.deps.pool): Promise<Array<PolicyRow | (Omit<PolicyRow, 'policy_id' | 'decided_by' | 'created_at' | 'consent_text'> & { policy_id: null; default: true })>> {
    const res = await db.query<PolicyRow>(
      `SELECT DISTINCT ON (origin, category) * FROM engagement_policy
        WHERE tenant_id = $1 ORDER BY origin, category, version DESC`, [tenantId]);
    const byKey = new Map(res.rows.map((r) => [`${r.origin}:${r.category}`, r]));
    const out: Array<PolicyRow | (Omit<PolicyRow, 'policy_id' | 'decided_by' | 'created_at' | 'consent_text'> & { policy_id: null; default: true })> = [];
    for (const origin of ENGAGEMENT_ORIGINS) {
      for (const category of POLICY_CATEGORIES) {
        out.push(byKey.get(`${origin}:${category}`) ?? {
          policy_id: null, default: true, tenant_id: tenantId, origin, category,
          mode: 'review_required', version: 0, max_auto_replies_per_hour: 10,
        });
      }
    }
    return out;
  }

  private async policyFor(tenantId: string, origin: EngagementOrigin, category: EngagementCategory, db: Db): Promise<PolicySnapshot | null> {
    if (category === 'other') return null;
    const res = await db.query<PolicyRow>(
      `SELECT * FROM engagement_policy WHERE tenant_id = $1 AND origin = $2 AND category = $3
        ORDER BY version DESC LIMIT 1`, [tenantId, origin, category]);
    const p = res.rows[0];
    return p ? { policy_id: p.policy_id, version: p.version, mode: p.mode, max_auto_replies_per_hour: p.max_auto_replies_per_hour } : null;
  }

  /** Nueva versión de política (append-only). safe_auto_reply exige consentimiento explícito. */
  async setPolicy(actor: Actor, body: unknown): Promise<PolicyRow> {
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const origin = b['origin'];
    const category = b['category'];
    const mode = b['mode'];
    if (origin !== 'google_review' && origin !== 'facebook_comment') {
      throw new AppError(400, 'validation_error', 'Elige el origen: reseñas de Google o comentarios de Facebook.');
    }
    if (category !== 'gratitude' && category !== 'basic_info') {
      throw new AppError(400, 'validation_error', 'Elige una categoría segura: agradecimientos o datos básicos del negocio.');
    }
    if (mode !== 'review_required' && mode !== 'safe_auto_reply') {
      throw new AppError(400, 'validation_error', 'Elige si MainSpot responde por ti o si cada respuesta espera tu revisión.');
    }
    if (mode === 'safe_auto_reply' && b['consent'] !== true) {
      throw new AppError(400, 'validation_error', 'Para activar respuestas automáticas confirma explícitamente la autorización.');
    }
    const maxRaw = b['max_auto_replies_per_hour'];
    const max = maxRaw === undefined ? 10 : Number(maxRaw);
    if (!Number.isInteger(max) || max < 1 || max > 60) {
      throw new AppError(400, 'validation_error', 'El límite de respuestas automáticas por hora debe estar entre 1 y 60.');
    }
    return runAtomic(this.deps.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`engagement_policy:${actor.tenantId}:${origin}:${category}`]);
      const v = await client.query<{ v: number }>(
        'SELECT COALESCE(MAX(version), 0) AS v FROM engagement_policy WHERE tenant_id = $1 AND origin = $2 AND category = $3',
        [actor.tenantId, origin, category]);
      const version = Number(v.rows[0]?.v ?? 0) + 1;
      const res = await client.query<PolicyRow>(
        `INSERT INTO engagement_policy (policy_id, tenant_id, origin, category, mode, version, max_auto_replies_per_hour, consent_text, decided_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [`pol_${randomUUID()}`, actor.tenantId, origin, category, mode, version, max, CONSENT_TEXT[mode], actor.userId]);
      const row = res.rows[0] as PolicyRow;
      await this.deps.sink.write({
        tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
        action: 'engagement.policy.changed', resource: `engagement_policy/${origin}/${category}`,
        request_id: actor.requestId, decision: 'allow', result: `${mode}:v${version}`, evidence_ref: row.policy_id,
      }, client, true);
      return row;
    });
  }

  // ---------------------------------------------------------------- casos (lectura)

  async listCases(tenantId: string, filters: { state?: string; origin?: string; limit?: number } = {}): Promise<CaseRow[]> {
    const where = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];
    if (filters.state) { values.push(filters.state); where.push(`state = $${values.length}`); }
    if (filters.origin) { values.push(filters.origin); where.push(`origin = $${values.length}`); }
    values.push(Math.min(filters.limit ?? 100, 500));
    const res = await this.deps.pool.query<CaseRow>(
      `SELECT * FROM engagement_case WHERE ${where.join(' AND ')} ORDER BY created_at DESC, case_id LIMIT $${values.length}`, values);
    return res.rows;
  }

  /** Anti-oracle: inexistente y de otro tenant devuelven lo mismo (null). */
  async getCase(tenantId: string, caseId: string, db: Db = this.deps.pool): Promise<CaseRow | null> {
    const res = await db.query<CaseRow>('SELECT * FROM engagement_case WHERE case_id = $1', [caseId]);
    const row = res.rows[0];
    return row && row.tenant_id === tenantId ? row : null;
  }

  private notFound(): AppError {
    return new AppError(404, DENY_CODES.NOT_FOUND, 'No se encontró el caso solicitado.');
  }

  // ---------------------------------------------------------------- clasificación

  async businessName(tenantId: string, db: Db = this.deps.pool): Promise<string> {
    const res = await db.query<{ business_name: string }>('SELECT business_name FROM client WHERE client_id = $1', [tenantId]);
    return res.rows[0]?.business_name ?? 'nuestro negocio';
  }

  /** Respuesta con datos VERIFICADOS por el dueño (teléfono del canal o ficha), o null. */
  async verifiedAnswer(tenantId: string, origin: EngagementOrigin, topic: InfoTopic | null, db: Db = this.deps.pool): Promise<string | null> {
    if (!topic) return null;
    if (topic === 'phone') {
      const phone = await this.deps.phones.effectivePhone(tenantId, originChannel(origin), db);
      return phone ? `puedes llamarnos al ${formatInternational(phone)}.` : null;
    }
    const res = await db.query<{ hours: Array<{ day: string; open?: string; close?: string; closed?: boolean }>; address_line: string | null; locality: string | null }>(
      'SELECT hours, address_line, locality FROM gbp_profile WHERE tenant_id = $1', [tenantId]);
    const p = res.rows[0];
    if (!p) return null;
    if (topic === 'hours') {
      const parts = (Array.isArray(p.hours) ? p.hours : []).map((h) =>
        `${DAY_LABEL[h.day] ?? h.day} ${h.closed ? 'cerrado' : `${h.open}–${h.close}`}`);
      return parts.length ? `nuestro horario es: ${parts.join(', ')}.` : null;
    }
    if (!p.address_line) return null;
    return `estamos en ${p.address_line}${p.locality ? `, ${p.locality}` : ''}.`;
  }

  async classifyCase(row: CaseRow): Promise<CaseRow | null> {
    const rules = classify({ body: row.body, rating: row.rating, origin: row.origin });
    let classification: Classification = rules;
    let semanticSource: 'jev' | 'blocked_external' | 'unavailable' | null = null;
    let reading: Record<string, unknown> | null = null;
    if (this.deps.semantics) {
      const read = await this.deps.semantics.read(row);
      if (read.ok) {
        // Las reglas de riesgo deterministas se suman (red de seguridad); nunca quitan una bandera de Jev.
        classification = { ...read.classification, risk_flags: [...new Set([...read.classification.risk_flags, ...rules.risk_flags])] };
        semanticSource = 'jev';
        reading = { ...read.reading, invocation_id: read.invocationId };
      } else if (read.source !== 'not_configured') {
        semanticSource = read.source;
      }
    }
    const business = await this.businessName(row.tenant_id);
    const verified = await this.verifiedAnswer(row.tenant_id, row.origin, classification.info_topic);
    const policy = await this.policyFor(row.tenant_id, row.origin, classification.category, this.deps.pool);
    const rate = await this.deps.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM engagement_case
        WHERE tenant_id = $1 AND origin = $2 AND decision = 'auto_reply' AND classified_at > now() - interval '1 hour'`,
      [row.tenant_id, row.origin]);
    let decision: Decision = semanticSource === 'blocked_external' || semanticSource === 'unavailable'
      // Con el AI Core desplegado y sin lectura semántica, nada se publica solo.
      ? { decision: 'human_review', reason: `semantic_${semanticSource}` }
      : decide({ classification, policy, autoRepliesLastHour: Number(rate.rows[0]?.n ?? 0), verifiedAnswer: verified });
    const author = row.author_label;
    const facts = { name: business, verified_answer: verified };
    // Respuesta redactada con hechos verificados (el teléfono lo inserta el servidor, nunca el modelo).
    const aiEligible = semanticSource === 'jev' && !(classification.category === 'basic_info' && classification.info_topic === 'phone');
    let generated: { text: string; needsHuman: boolean; invocationId: string } | null = null;
    let reservation: QuotaReservationRow | null = null;
    if (aiEligible && this.deps.semantics) {
      if (row.origin !== 'google_review') {
        // Comentarios de Facebook: fuera de la cuota de DEC-0076 (comportamiento sin cambios).
        generated = await this.deps.semantics.reply(row, classification, facts);
      } else if (decision.decision === 'auto_reply') {
        // DEC-0076: recibir una reseña no consume cuota. Solo la respuesta automática que el dueño autorizó se
        // redacta con IA al llegar y consume 1 unidad del ciclo; sin cuota disponible sale el texto seguro sin IA.
        // Las reseñas que esperan decisión llevan solo propuestas sin IA; la de IA se pide con «Redactar con IA».
        const metered = await this.meteredReply(row, classification, facts, { actorId: SYSTEM_ACTOR, actorRole: null, requestId: `eng_${row.case_id}` });
        generated = metered.generated;
        reservation = metered.reservation;
      }
    }
    if (decision.decision === 'auto_reply' && generated?.needsHuman) decision = { decision: 'human_review', reason: 'reply_needs_human' };
    const persist = (gen: typeof generated, held: QuotaReservationRow | null) => runAtomic(this.deps.pool, async (client) => {
      let res;
      if (decision.decision === 'auto_reply') {
        const text = gen ? `${gen.text}\n\n${AI_REPLY_DISCLOSURE}` : autoReplyText({ category: classification.category, author, business, verifiedAnswer: verified });
        res = await client.query<CaseRow>(
          `UPDATE engagement_case SET state = 'classified', decision = 'auto_reply', reason = $2, category = $3,
             risk_flags = $4, confidence = $5, policy_id = $6, policy_version = $7, response_text = $8,
             sentiment = $9, semantic = $10, semantic_source = $11, reply_invocation_id = $12,
             classified_at = now(), next_attempt_at = now(), updated_at = now()
           WHERE case_id = $1 AND state = 'received' RETURNING *`,
          [row.case_id, decision.reason, classification.category, JSON.stringify(classification.risk_flags),
            classification.confidence, policy?.policy_id ?? null, policy?.version ?? null, text,
            classification.sentiment, reading ? JSON.stringify(reading) : null, semanticSource, gen?.invocationId ?? null]);
      } else {
        const rulesDrafts = humanDrafts({ classification, author, business, verifiedAnswer: verified });
        const drafts = [...(gen ? [gen.text] : []), ...rulesDrafts].slice(0, 3);
        res = await client.query<CaseRow>(
          `UPDATE engagement_case SET state = 'needs_human', decision = 'human_review', reason = $2, category = $3,
             risk_flags = $4, confidence = $5, policy_id = $6, policy_version = $7, drafts = $8, response_text = $9,
             sentiment = $10, semantic = $11, semantic_source = $12, reply_invocation_id = $13,
             classified_at = now(), notify_status = 'pending', updated_at = now()
           WHERE case_id = $1 AND state = 'received' RETURNING *`,
          [row.case_id, decision.reason, classification.category, JSON.stringify(classification.risk_flags),
            classification.confidence, policy?.policy_id ?? null, policy?.version ?? null, JSON.stringify(drafts), drafts[0] ?? null,
            classification.sentiment, reading ? JSON.stringify(reading) : null, semanticSource, gen?.invocationId ?? null]);
      }
      const updated = res.rows[0] ?? null;
      if (updated) {
        // La unidad se confirma con el caso que guarda la respuesta de IA: o ambos o ninguno.
        if (held) await this.deps.quota.commitInTx(client, held, `engagement_case/${row.case_id}`, null);
        await this.deps.sink.write({
          tenant_id: row.tenant_id, actor_id: SYSTEM_ACTOR, actor_role: null,
          action: 'engagement.case.classified', resource: `engagement_case/${row.case_id}`,
          request_id: `eng_${row.case_id}`, decision: 'allow',
          result: `${decision.decision}:${decision.reason}`.slice(0, 200), evidence_ref: policy?.policy_id ?? null,
        }, client);
      }
      return updated;
    });
    let consumed = false;
    try {
      try {
        const classified = await persist(generated, reservation);
        consumed = classified !== null;
        return classified;
      } catch (err) {
        if (!reservation || !(err instanceof AppError) || err.code !== DENY_CODES.QUOTA_RESERVATION_EXPIRED) throw err;
        // La redacción tardó más que la reserva: el caso sale con el texto seguro, sin IA ni consumo (nunca se corta el tick).
        log.warn('engagement.ai_reply.reservation_expired', 'AI reply outlived its quota reservation; using the safe text', { tenant_id: row.tenant_id, case_id: row.case_id });
        return await persist(null, null);
      }
    } finally {
      if (reservation && !consumed) await this.deps.quota.release(reservation, null, 'ai_reply_not_used');
    }
  }

  // ---------------------------------------------------------------- respuestas con IA medidas (DEC-0076)

  /**
   * Reserva 1 unidad de `ai_review_replies` del ciclo para el caso, ANTES de invocar a la IA (bajo el candado del
   * libro: dos procesos no superan el límite). La clave es el caso: ya consumida ⇒ `replay` sin consumo nuevo.
   * Sin cuota, sin suscripción activa o sin valor en la revisión fijada ⇒ `denied` (auditado); en curso en otra
   * petición ⇒ 409 request_in_progress (lo decide el llamador).
   */
  private async claimAiReply(row: CaseRow, who: AiReplyActor): Promise<AiReplyClaim> {
    try {
      const claim = await this.deps.quota.reserve({
        tenantId: row.tenant_id, capability: AI_REVIEW_REPLY_CAPABILITY, units: 1, idempotencyKey: aiReplyQuotaKey(row.case_id),
        requestId: who.requestId, actorId: who.actorId, actorRole: who.actorRole,
      });
      return claim.kind === 'replay' ? { kind: 'replay' } : claim;
    } catch (err) {
      if (!(err instanceof AppError) || (err.code !== DENY_CODES.LIMIT_EXCEEDED && err.code !== DENY_CODES.SUBSCRIPTION_REQUIRED)) throw err;
      await this.deps.sink.write({
        tenant_id: row.tenant_id, actor_id: who.actorId, actor_role: who.actorRole,
        action: 'engagement.ai_reply', resource: `engagement_case/${row.case_id}`,
        request_id: who.requestId, decision: 'deny', result: err.code,
      }, this.deps.pool, false).catch(() => undefined);
      return { kind: 'denied', error: err };
    }
  }

  /**
   * Respuesta automática autorizada (clasificación): reserva y redacta. Sin ruta activa no reserva; si la
   * redacción falla o la cuota no alcanza, devuelve null y el caso sigue sin IA. La reserva devuelta se confirma
   * en la transacción que guarda el caso (o se libera).
   */
  private async meteredReply(row: CaseRow, classification: Classification, facts: Record<string, unknown>, who: AiReplyActor):
    Promise<{ generated: { text: string; needsHuman: boolean; invocationId: string } | null; reservation: QuotaReservationRow | null }> {
    const semantics = this.deps.semantics;
    if (!semantics || !(await semantics.replyAvailable(row.origin))) return { generated: null, reservation: null };
    let claim: AiReplyClaim;
    try {
      claim = await this.claimAiReply(row, who);
    } catch (err) {
      // Otra clasificación del mismo caso tiene la reserva: este intento sigue sin IA y su UPDATE perderá la carrera.
      if (err instanceof AppError && err.code === DENY_CODES.REQUEST_IN_PROGRESS) return { generated: null, reservation: null };
      throw err;
    }
    if (claim.kind === 'denied') return { generated: null, reservation: null };
    // Unidad ya confirmada para este caso sin que el caso la refleje: no se redacta otra sin medir (fail-closed).
    if (claim.kind === 'replay') return { generated: null, reservation: null };
    const generated = await semantics.reply(row, classification, facts);
    if (!generated) {
      await this.deps.quota.release(claim.reservation, who.actorRole, 'ai_reply_failed');
      return { generated: null, reservation: null };
    }
    return { generated, reservation: claim.reservation };
  }

  /** Clasificación guardada en el caso (para redactar a pedido); null si no hubo lectura semántica. */
  private storedClassification(row: CaseRow): Classification | null {
    if (row.semantic_source !== 'jev' || !row.category || !row.sentiment) return null;
    const topic = row.semantic && typeof row.semantic['info_topic'] === 'string' ? row.semantic['info_topic'] as InfoTopic : null;
    return {
      category: row.category, risk_flags: row.risk_flags, confidence: Number(row.confidence ?? 0), sentiment: row.sentiment,
      info_topic: row.category === 'basic_info' ? topic : null,
    };
  }

  /**
   * «Redactar con IA» (DEC-0076, SRC-0014 C01): el dueño pide la propuesta de IA para una reseña de Google que
   * espera su decisión. Consume 1 unidad del ciclo solo si la propuesta se genera y se guarda en el caso (misma
   * transacción); si la IA falla o el caso cambió, no consume. Repetir no consume otra vez. La propuesta va en
   * `ai_draft`, aparte de las tres numeradas: lo que muestra el aviso de Telegram y lo que aprueba `/aprobar <caso> N`
   * no cambia, y una edición de las numeradas no la borra. Agotar la cuota solo bloquea esto: elegir otra propuesta
   * o escribir la respuesta sigue igual (panel y Telegram).
   */
  async requestAiDraft(actor: Actor, caseId: string): Promise<{ case: CaseRow; already: boolean }> {
    const found = await this.getCase(actor.tenantId, caseId);
    if (!found) throw this.notFound();
    if (found.reply_invocation_id) return { case: found, already: true };
    if (found.origin !== 'google_review') {
      throw new AppError(409, 'validation_error', 'Redactar con IA a pedido está disponible para reseñas de Google.');
    }
    if (found.state !== 'needs_human' && found.state !== 'failed') {
      throw new AppError(409, 'validation_error', found.state === 'received'
        ? 'MainSpot todavía está analizando esta reseña. Inténtalo en unos segundos.'
        : 'Este caso ya no admite cambios en sus respuestas.');
    }
    const classification = this.storedClassification(found);
    if (!classification || (classification.category === 'basic_info' && classification.info_topic === 'phone')) {
      throw new AppError(409, 'validation_error', 'Esta reseña no admite redacción con IA. Elige una de las propuestas o escribe tu respuesta.');
    }
    const semantics = this.deps.semantics;
    if (!semantics || !(await semantics.replyAvailable(found.origin))) {
      throw new AppError(409, 'validation_error', 'La redacción con IA no está disponible en este momento. Puedes elegir una propuesta o escribir tu respuesta.');
    }
    const who: AiReplyActor = { actorId: actor.userId, actorRole: actor.role, requestId: actor.requestId };
    const claim = await this.claimAiReply(found, who);
    if (claim.kind === 'denied') {
      const err = new AppError(403, claim.error.code, `${claim.error.userMessage} Responder tú mismo no consume tu plan.`);
      err.audited = true;
      throw err;
    }
    if (claim.kind === 'replay') {
      // La unidad de este caso ya se consumió: o ya tiene su propuesta, o el estado es incoherente y no se redacta
      // otra sin medir (fail-closed).
      const now = await this.getCase(actor.tenantId, caseId);
      if (now?.reply_invocation_id) return { case: now, already: true };
      log.error('engagement.ai_draft.replay_without_draft', 'quota unit committed for a case without AI draft', { tenant_id: actor.tenantId, case_id: caseId });
      throw new AppError(409, 'validation_error', 'Este caso ya usó su respuesta con IA. Elige una propuesta o escribe tu respuesta.');
    }
    const business = await this.businessName(actor.tenantId);
    const verified = await this.verifiedAnswer(actor.tenantId, found.origin, classification.info_topic);
    let consumed = false;
    try {
      const generated = await semantics.reply(found, classification, { name: business, verified_answer: verified }, { requestId: actor.requestId, actorId: actor.userId });
      if (!generated) {
        throw new AppError(502, 'validation_error', 'No se pudo redactar con IA en este momento. No se descontó de tu plan; puedes elegir una propuesta o escribir tu respuesta.');
      }
      const updated = await runAtomic(this.deps.pool, async (client) => {
        const res = await client.query<CaseRow>(
          `UPDATE engagement_case SET ai_draft = $2, reply_invocation_id = $3, updated_at = now()
           WHERE case_id = $1 AND tenant_id = $4 AND state IN ('needs_human','failed') AND reply_invocation_id IS NULL RETURNING *`,
          [caseId, generated.text, generated.invocationId, actor.tenantId]);
        const row = res.rows[0];
        if (!row) throw new AppError(409, 'validation_error', 'El caso cambió mientras se redactaba. Recarga la página; no se descontó de tu plan.');
        await this.deps.quota.commitInTx(client, claim.reservation, `engagement_case/${caseId}`, actor.role);
        await this.deps.sink.write({
          tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
          action: 'engagement.ai_draft.generated', resource: `engagement_case/${caseId}`,
          request_id: actor.requestId, decision: 'allow', result: 'consumed:1',
          evidence_ref: generated.invocationId,
        }, client);
        return row;
      });
      consumed = true;
      return { case: updated, already: false };
    } finally {
      if (!consumed) await this.deps.quota.release(claim.reservation, actor.role, 'ai_draft_not_saved');
    }
  }

  /** Cuota de respuestas con IA del negocio: valor fijado, uso del ciclo vigente y su ventana (solo lectura). */
  async aiReplyStatus(tenantId: string): Promise<AiReplyStatus> {
    const available = this.deps.semantics ? await this.deps.semantics.replyAvailable('google_review') : false;
    const policy = await loadPinnedPolicy(this.deps.pool, tenantId);
    if (!policy) return { available, subscription_active: false, limit: null, usage: 0, remaining: null, window: null };
    const status = (await this.deps.quota.capacityStatus(this.deps.pool, policy)).find((s) => s.capability === AI_REVIEW_REPLY_CAPABILITY);
    const limit = status?.limit ?? null;
    const usage = status?.usage ?? 0;
    return {
      available, subscription_active: policy.subscription.status === 'active', limit, usage,
      remaining: limit === null ? null : Math.max(0, limit - usage), window: status?.window ?? null,
    };
  }

  // ---------------------------------------------------------------- decisiones humanas

  async editDraft(actor: Actor, caseId: string, index: unknown, text: unknown): Promise<CaseRow> {
    const i = Number(index);
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!Number.isInteger(i) || i < 0 || i > 2) throw new AppError(400, 'validation_error', 'Elige una de las 3 respuestas sugeridas.');
    if (!clean || clean.length > MAX_TEXT) throw new AppError(400, 'validation_error', `Escribe una respuesta de 1 a ${MAX_TEXT} caracteres.`);
    const found = await this.getCase(actor.tenantId, caseId);
    if (!found) throw this.notFound();
    if (found.state !== 'needs_human' && found.state !== 'failed') {
      throw new AppError(409, 'validation_error', 'Este caso ya no admite cambios en sus respuestas.');
    }
    const drafts = [...found.drafts];
    while (drafts.length <= i) drafts.push('');
    drafts[i] = clean;
    return runAtomic(this.deps.pool, async (client) => {
      const res = await client.query<CaseRow>(
        `UPDATE engagement_case SET drafts = $2, updated_at = now() WHERE case_id = $1 AND tenant_id = $3 AND state IN ('needs_human','failed') RETURNING *`,
        [caseId, JSON.stringify(drafts.slice(0, 3)), actor.tenantId]);
      if (!res.rows[0]) throw new AppError(409, 'validation_error', 'El caso cambió mientras se editaba. Recarga e inténtalo de nuevo.');
      await this.deps.sink.write({
        tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
        action: 'engagement.draft.edited', resource: `engagement_case/${caseId}`,
        request_id: actor.requestId, decision: 'allow', result: `draft:${i + 1}`,
      }, client);
      return res.rows[0];
    });
  }

  /** Aprueba la respuesta (borrador elegido o texto editado). Idempotente: no responde dos veces. */
  async approve(actor: Actor, caseId: string, body: { draft_index?: unknown; text?: unknown }, channel: 'panel' | 'telegram'): Promise<{ case: CaseRow; already: boolean }> {
    const found = await this.getCase(actor.tenantId, caseId);
    if (!found) throw this.notFound();
    if (['approved', 'responding', 'responded', 'retry_pending'].includes(found.state)) return { case: found, already: true };
    if (found.state !== 'needs_human' && found.state !== 'failed') {
      throw new AppError(409, 'validation_error', 'Este caso ya fue resuelto y no puede aprobarse.');
    }
    let text: string;
    if (typeof body.text === 'string' && body.text.trim()) {
      text = body.text.trim();
    } else {
      const idx = body.draft_index === undefined ? 0 : Number(body.draft_index);
      text = Number.isInteger(idx) ? (found.drafts[idx] ?? '').trim() : '';
    }
    if (!text || text.length > MAX_TEXT) throw new AppError(400, 'validation_error', 'Elige una respuesta sugerida o escribe una antes de aprobar.');
    return runAtomic(this.deps.pool, async (client) => {
      const res = await client.query<CaseRow>(
        `UPDATE engagement_case SET state = 'approved', response_text = $2, resolved_by = $3, resolution_channel = $4,
           resolved_at = now(), attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
         WHERE case_id = $1 AND tenant_id = $5 AND state IN ('needs_human','failed') RETURNING *`,
        [caseId, text, actor.userId, channel, actor.tenantId]);
      const row = res.rows[0];
      if (!row) {
        const now = await this.getCase(actor.tenantId, caseId, client);
        if (now && ['approved', 'responding', 'responded', 'retry_pending'].includes(now.state)) return { case: now, already: true };
        throw new AppError(409, 'validation_error', 'El caso cambió mientras se aprobaba. Recarga e inténtalo de nuevo.');
      }
      await this.deps.sink.write({
        tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
        action: 'engagement.approved', resource: `engagement_case/${caseId}`,
        request_id: actor.requestId, decision: 'allow', result: `approved:${channel}`,
      }, client, true);
      return { case: row, already: false };
    });
  }

  async reject(actor: Actor, caseId: string, channel: 'panel' | 'telegram'): Promise<{ case: CaseRow; already: boolean }> {
    const found = await this.getCase(actor.tenantId, caseId);
    if (!found) throw this.notFound();
    if (found.state === 'rejected') return { case: found, already: true };
    if (found.state !== 'needs_human' && found.state !== 'failed') {
      throw new AppError(409, 'validation_error', 'Este caso ya fue resuelto y no puede descartarse.');
    }
    return runAtomic(this.deps.pool, async (client) => {
      const res = await client.query<CaseRow>(
        `UPDATE engagement_case SET state = 'rejected', resolved_by = $2, resolution_channel = $3, resolved_at = now(), updated_at = now()
         WHERE case_id = $1 AND tenant_id = $4 AND state IN ('needs_human','failed') RETURNING *`,
        [caseId, actor.userId, channel, actor.tenantId]);
      const row = res.rows[0];
      if (!row) {
        const now = await this.getCase(actor.tenantId, caseId, client);
        if (now?.state === 'rejected') return { case: now, already: true };
        throw new AppError(409, 'validation_error', 'El caso cambió mientras se descartaba. Recarga e inténtalo de nuevo.');
      }
      await this.deps.sink.write({
        tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
        action: 'engagement.rejected', resource: `engagement_case/${caseId}`,
        request_id: actor.requestId, decision: 'allow', result: `rejected:${channel}`,
      }, client);
      return { case: row, already: false };
    });
  }

  // ---------------------------------------------------------------- respuesta pública

  /**
   * Publica la respuesta del caso UNA vez. Reclama el caso con un UPDATE condicional (un solo
   * ganador entre procesos), llama al proveedor con idempotency key = caso y registra el
   * resultado. Fallos reintentables → retry_pending con backoff; agotados → revisión humana
   * (automáticos) o `failed` con aviso (aprobados).
   */
  async respondCase(caseId: string): Promise<CaseRow | null> {
    const claimed = await this.deps.pool.query<CaseRow>(
      `UPDATE engagement_case SET state = 'responding', attempts = attempts + 1,
         lease_until = now() + make_interval(secs => $2), updated_at = now()
       WHERE case_id = $1 AND response_text IS NOT NULL
         AND (state IN ('classified','approved') OR (state = 'retry_pending' AND next_attempt_at <= now()))
       RETURNING *`,
      [caseId, RESPOND_LEASE_SECONDS]);
    const row = claimed.rows[0];
    if (!row) return null;

    if (row.review_id) {
      const rev = await this.deps.pool.query<{ state: string }>('SELECT state FROM review WHERE review_id = $1 AND tenant_id = $2', [row.review_id, row.tenant_id]);
      if (rev.rows[0]?.state === 'published') {
        return this.closeElsewhere(row);
      }
    }

    // FR-0016: ledger único por destino público (comentario/reseña). Otro camino ya respondió => no se duplica.
    const owner = `case:${row.case_id}`;
    const claim = await this.deps.pool.query(
      `INSERT INTO response_ledger (tenant_id, origin, target_ref, path, owner_ref) VALUES ($1,$2,$3,'engagement',$4)
       ON CONFLICT (tenant_id, origin, target_ref) DO UPDATE SET updated_at = now() WHERE response_ledger.owner_ref = EXCLUDED.owner_ref
       RETURNING owner_ref`, [row.tenant_id, row.origin, row.external_ref, owner]);
    if (!claim.rowCount) return this.closeElsewhere(row, 'answered_elsewhere');

    let result: ReplyResult;
    const timer = new AbortController();
    try {
      // El temporizador nunca rechaza (se aborta al terminar): sin rechazos huérfanos.
      const timeout = sleep(PROVIDER_TIMEOUT_MS, 'timeout' as const, { ref: false, signal: timer.signal }).catch(() => 'aborted' as const);
      const winner = await Promise.race([
        this.deps.replier.reply({
          tenantId: row.tenant_id, origin: row.origin, targetRef: row.external_ref,
          text: row.response_text ?? '', idempotencyKey: `engagement:${row.case_id}`,
        }),
        timeout,
      ]);
      result = typeof winner === 'string' ? { ok: false, error: 'provider_timeout', retryable: true } : winner;
    } catch {
      result = { ok: false, error: 'provider_exception', retryable: true };
    } finally {
      timer.abort();
    }

    if (result.ok) {
      const ok = result;
      return runAtomic(this.deps.pool, async (client) => {
        const auto = row.resolution_channel === null;
        const res = await client.query<CaseRow>(
          `UPDATE engagement_case SET state = 'responded', responded_external_ref = $2, responded_at = now(),
             delivery_mode = $3, lease_until = NULL, last_error = NULL,
             resolution_channel = COALESCE(resolution_channel, 'auto'), resolved_by = COALESCE(resolved_by, $4),
             resolved_at = COALESCE(resolved_at, now()), updated_at = now()
           WHERE case_id = $1 AND state = 'responding' RETURNING *`,
          [row.case_id, ok.external_ref, this.deps.replier.mode, SYSTEM_ACTOR]);
        const done = res.rows[0] ?? null;
        if (row.review_id) {
          await client.query(
            `UPDATE review SET state = 'published', published_text = $1, published_at = now(), updated_at = now()
              WHERE review_id = $2 AND tenant_id = $3 AND state <> 'published'`,
            [row.response_text, row.review_id, row.tenant_id]);
        }
        await client.query(`UPDATE response_ledger SET state = 'sent', external_ref = $5, updated_at = now() WHERE tenant_id = $1 AND origin = $2 AND target_ref = $3 AND owner_ref = $4`,
          [row.tenant_id, row.origin, row.external_ref, owner, ok.external_ref]);
        await this.deps.sink.write({
          tenant_id: row.tenant_id, actor_id: auto ? SYSTEM_ACTOR : (row.resolved_by ?? SYSTEM_ACTOR), actor_role: null,
          action: 'engagement.responded', resource: `engagement_case/${row.case_id}`,
          request_id: `eng_${row.case_id}`, decision: 'allow',
          result: `${auto ? `auto:policy_v${row.policy_version ?? 0}` : row.resolution_channel}:${this.deps.replier.mode}`,
          evidence_ref: ok.external_ref,
        }, client, true);
        log.info('engagement.responded', 'public response delivered', {
          tenant_id: row.tenant_id, case_id: row.case_id, delivery_mode: this.deps.replier.mode, auto,
        });
        return done;
      });
    }

    const fail = result;
    const exhausted = !fail.retryable || row.attempts >= MAX_RESPOND_ATTEMPTS;
    const autoCase = row.resolution_channel === null;
    let sql: string;
    if (!exhausted) {
      sql = `UPDATE engagement_case SET state = 'retry_pending', next_attempt_at = now() + make_interval(secs => $3),
               last_error = $2, lease_until = NULL, updated_at = now() WHERE case_id = $1 AND state = 'responding' RETURNING *`;
    } else if (autoCase) {
      // Un automático que no pudo publicarse pasa a decisión humana (nunca se pierde).
      sql = `UPDATE engagement_case SET state = 'needs_human', decision = 'human_review', reason = 'provider_failed',
               drafts = CASE WHEN jsonb_array_length(drafts) = 0 THEN jsonb_build_array(response_text) ELSE drafts END,
               last_error = $2, lease_until = NULL, notify_status = 'pending', updated_at = now()
             WHERE case_id = $1 AND state = 'responding' AND $3::int >= 0 RETURNING *`;
    } else {
      sql = `UPDATE engagement_case SET state = 'failed', last_error = $2, lease_until = NULL, notify_status = 'pending', updated_at = now()
             WHERE case_id = $1 AND state = 'responding' AND $3::int >= 0 RETURNING *`;
    }
    const res = await this.deps.pool.query<CaseRow>(sql, [row.case_id, fail.error.slice(0, 120), backoffSeconds(row.attempts)]);
    // Agotado sin publicar: se libera el destino para que otra decisión (humana) pueda responder.
    if (exhausted) {
      await this.deps.pool.query('DELETE FROM response_ledger WHERE tenant_id = $1 AND origin = $2 AND target_ref = $3 AND owner_ref = $4 AND state = \'claimed\'',
        [row.tenant_id, row.origin, row.external_ref, owner]).catch(() => undefined);
    }
    await this.deps.sink.write({
      tenant_id: row.tenant_id, actor_id: SYSTEM_ACTOR, actor_role: null,
      action: 'engagement.respond_failed', resource: `engagement_case/${row.case_id}`,
      request_id: `eng_${row.case_id}`, decision: 'allow',
      result: `${fail.error.slice(0, 60)}:attempt_${row.attempts}:${exhausted ? (autoCase ? 'escalated' : 'failed') : 'retry'}`,
    }).catch(() => undefined);
    return res.rows[0] ?? null;
  }

  private async closeElsewhere(row: CaseRow, reason: 'answered_in_reviews' | 'answered_elsewhere' = 'answered_in_reviews'): Promise<CaseRow | null> {
    const res = await this.deps.pool.query<CaseRow>(
      `UPDATE engagement_case SET state = 'closed_elsewhere', lease_until = NULL, reason = $2, updated_at = now()
        WHERE case_id = $1 RETURNING *`, [row.case_id, reason]);
    await this.deps.sink.write({
      tenant_id: row.tenant_id, actor_id: SYSTEM_ACTOR, actor_role: null,
      action: 'engagement.closed_elsewhere', resource: `engagement_case/${row.case_id}`,
      request_id: `eng_${row.case_id}`, decision: 'allow', result: reason === 'answered_in_reviews' ? 'review_already_published' : 'ledger_owned_by_other_path',
    }).catch(() => undefined);
    return res.rows[0] ?? null;
  }

  // ---------------------------------------------------------------- avisos (Telegram)

  /** Texto del aviso: mismo case_id que el panel; borradores numerados y comandos. */
  notificationText(row: CaseRow): string {
    const origin = row.origin === 'google_review'
      ? `Reseña de Google${row.rating ? ` (${row.rating}★)` : ''}`
      : 'Comentario en Facebook';
    const excerpt = row.body.length > 300 ? `${row.body.slice(0, 297)}…` : row.body;
    const lines = [
      row.state === 'failed' ? 'MainSpot · No pudimos publicar la respuesta aprobada' : 'MainSpot · Caso pendiente de tu decisión',
      `Caso: ${row.case_id}`,
      `${origin} · ${row.author_label}`,
      `«${excerpt}»`,
      `Motivo: ${row.reason ?? 'revisión'}`,
    ];
    row.drafts.slice(0, 3).forEach((d, i) => lines.push(`${i + 1}) ${d}`));
    lines.push(`Para aprobar: /aprobar ${row.case_id} 1 (o 2, 3) · Para descartar: /rechazar ${row.case_id}`);
    lines.push(`Panel: ${this.deps.panelUrl}#/caso/${row.case_id}`);
    return lines.join('\n');
  }

  /**
   * Envía los avisos pendientes por el chat de Telegram VINCULADO (nunca por el teléfono
   * público). Una fila por (caso, chat): repetir no duplica. Sin chat → no_destination (el caso
   * sigue visible en el panel y se reevalúa cuando se vincule un chat).
   */
  async dispatchNotifications(tenantId: string): Promise<{ sent: number; failed: number; no_destination: number }> {
    const out = { sent: 0, failed: 0, no_destination: 0 };
    const cases = await this.deps.pool.query<CaseRow>(
      `SELECT * FROM engagement_case WHERE tenant_id = $1 AND state IN ('needs_human','failed')
         AND notify_status IN ('pending','no_destination','failed') ORDER BY created_at LIMIT 20`, [tenantId]);
    if (!cases.rows.length) return out;
    const chats = await this.deps.pool.query<{ chat_id: string }>(
      `SELECT chat_id FROM telegram_link WHERE tenant_id = $1 AND status = 'active'`, [tenantId]);
    for (const c of cases.rows) {
      if (!chats.rows.length) {
        if (c.notify_status !== 'no_destination') {
          await this.deps.pool.query(`UPDATE engagement_case SET notify_status = 'no_destination', updated_at = now() WHERE case_id = $1`, [c.case_id]);
        }
        out.no_destination += 1;
        continue;
      }
      for (const { chat_id } of chats.rows) {
        await this.deps.pool.query(
          `INSERT INTO engagement_notification (notification_id, tenant_id, case_id, chat_id) VALUES ($1,$2,$3,$4)
           ON CONFLICT (case_id, chat_id) DO NOTHING`, [`ntf_${randomUUID()}`, tenantId, c.case_id, chat_id]);
      }
      const due = await this.deps.pool.query<{ notification_id: string; chat_id: string; attempts: number }>(
        `SELECT notification_id, chat_id, attempts FROM engagement_notification
          WHERE case_id = $1 AND status IN ('pending','failed') AND attempts < $2
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())`, [c.case_id, MAX_RESPOND_ATTEMPTS]);
      for (const n of due.rows) {
        const injected = this.deps.channel.name === 'simulated' && await consumeSimFault(this.deps.pool, tenantId, 'telegram', 'error');
        const sent = injected ? { ok: false, error: 'simulated_telegram_error' } : await this.deps.channel.sendMessage(n.chat_id, this.notificationText(c));
        if (sent.ok) {
          await this.deps.pool.query(
            `UPDATE engagement_notification SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL, updated_at = now()
              WHERE notification_id = $1`, [n.notification_id]);
          out.sent += 1;
        } else {
          await this.deps.pool.query(
            `UPDATE engagement_notification SET status = 'failed', attempts = attempts + 1, last_error = $2,
               next_attempt_at = now() + make_interval(secs => $3), updated_at = now() WHERE notification_id = $1`,
            [n.notification_id, (sent.error ?? 'send_failed').slice(0, 120), backoffSeconds(n.attempts + 1)]);
          out.failed += 1;
        }
      }
      const pending = await this.deps.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM engagement_notification WHERE case_id = $1 AND status <> 'sent'`, [c.case_id]);
      const status = Number(pending.rows[0]?.n ?? 0) === 0 ? 'sent' : 'failed';
      await this.deps.pool.query(`UPDATE engagement_case SET notify_status = $2, updated_at = now() WHERE case_id = $1`, [c.case_id, status]);
      if (status === 'sent') {
        await this.deps.sink.write({
          tenant_id: tenantId, actor_id: SYSTEM_ACTOR, actor_role: null,
          action: 'engagement.notified', resource: `engagement_case/${c.case_id}`,
          request_id: `eng_${c.case_id}`, decision: 'allow', result: `telegram:${this.deps.channel.name}`,
        }).catch(() => undefined);
      }
    }
    return out;
  }
}
