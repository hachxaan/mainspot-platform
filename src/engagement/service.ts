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
import {
  AUTO_REPLY_CONSENT, AUTO_SUGGEST_CONSENT, REVIEW_REQUIRED_CONSENT, autoReplyOriginOfVersion, consentCoversAiSpend, consentIsCurrent,
  reconsentRequired, suggestionConsentIsCurrent,
} from './consent.ts';
import { newNoticeCode, optionsSha256, type ApprovalOfferRow } from './notice-offer.ts';
import {
  AI_FACEBOOK_SUGGESTION_CAPABILITY, DEFAULT_SUGGESTION_MODE, SUGGESTION_MODES, facebookSuggestionQuotaKey, isSuggestionOrigin, textRelevance,
  type IrrelevanceReason, type SuggestionMode, type SuggestionOrigin, type SuggestionSetting, type SuggestionSettingRow,
} from './suggestions.ts';
import { consumeSimFault, type EngagementReplier, type ReplyResult } from './providers.ts';
import { noticeMessage } from './telegram-ui.ts';

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
/** Cualquier terminador de línea que un cliente puede pintar como salto (también `\r` suelto, NEL, LS y PS). */
const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/g;

/**
 * Aviso obligatorio en respuestas públicas automáticas redactadas por IA (política de uso de Anthropic:
 * los agentes que hablan con usuarios externos deben revelar que son IA; ver ai-providers-data-terms.md §2.7).
 */
export const AI_REPLY_DISCLOSURE = 'Respuesta automática generada con IA.';

/** DEC-0078 R1: «Sugerir con IA» con el modo `off` del negocio (responder a mano sigue igual). */
const SUGGESTIONS_OFF_MESSAGE = 'Las sugerencias con IA para comentarios de Facebook están desactivadas en tu negocio. Puedes elegir una propuesta, escribir tu respuesta o cambiar el modo en Reglas.';

/** DEC-0076 (SRC-0014 C01): cuota periódica de respuestas a reseñas redactadas con IA. */
export const AI_REVIEW_REPLY_CAPABILITY = 'ai_review_replies' as const;

/** Clave del libro de cuotas: un caso consume como máximo una unidad (replay ⇒ sin consumo nuevo). */
export function aiReplyQuotaKey(caseId: string): string {
  return `ai_reply:${caseId}`;
}

/**
 * Medidor de la IA de respuestas por origen: reseñas de Google gastan `ai_review_replies` (DEC-0076); comentarios de
 * Facebook, su propio `ai_facebook_suggestions` (DEC-0078 R5), nunca el de Google. Como máximo 1 unidad por caso.
 */
function replyMeter(origin: EngagementOrigin, caseId: string): { capability: typeof AI_REVIEW_REPLY_CAPABILITY | typeof AI_FACEBOOK_SUGGESTION_CAPABILITY; key: string } {
  return origin === 'google_review'
    ? { capability: AI_REVIEW_REPLY_CAPABILITY, key: aiReplyQuotaKey(caseId) }
    : { capability: AI_FACEBOOK_SUGGESTION_CAPABILITY, key: facebookSuggestionQuotaKey(caseId) };
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

/** DEC-0078: modo de sugerencias de comentarios de Facebook y su medidor, con la misma cuenta que el enforcement. */
export interface AiSuggestionStatus extends AiReplyStatus {
  origin: SuggestionOrigin;
  setting: SuggestionSetting;
  /** `limit` null ⇒ el plan no define el medidor: ninguna IA de pago para estos comentarios (activación BLOCKED). */
  credits_defined: boolean;
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

/** Política vigente con el estado de su consentimiento (SEC-CONSENT-01) para el panel y la API. */
export type PolicyView = (PolicyRow | (Omit<PolicyRow, 'policy_id' | 'decided_by' | 'created_at' | 'consent_text' | 'consent_version' | 'consent_sha256'>
  & { policy_id: null; default: true; consent_version: null })) & {
  /** La autorización de esta política cubre lo que hace hoy (en Google, gastar respuestas con IA). */
  consent_current: boolean;
  /** Respuesta automática a reseñas cuyo consentimiento no cubre la cuota compartida: debe aceptarse de nuevo. */
  reconsent_required: boolean;
};

/**
 * Resultado de `/aprobar <código> <N>` (SEC-TG-APPROVAL-01). `invalid` no distingue inexistente de ajeno. `stale`:
 * `changed` = las propuestas cambiaron (o el aviso fue sustituido); `used` = ese aviso ya aprobó el caso y la
 * publicación falló, así que se decide con el aviso vigente.
 */
export type NoticeApproval =
  | { kind: 'approved'; case: CaseRow }
  | { kind: 'already'; case: CaseRow }
  | { kind: 'stale'; case: CaseRow; reason: 'changed' | 'used' }
  | { kind: 'invalid' };

/** El caso salió de la política que lo clasificó mientras se redactaba (revocación o reconsentimiento). */
class PolicyChangedError extends Error {}

/** Política leída al clasificar, con lo necesario para comprobar su consentimiento al confirmar el caso. */
interface PolicyInForce extends PolicySnapshot {
  origin: EngagementOrigin;
  category: PolicyCategory;
  consent_version: string | null;
  consent_sha256: string | null;
}

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
  /** Sube con cada cambio de `drafts` (trigger de 0037): los avisos de otra revisión no sirven para aprobar. */
  drafts_revision: number;
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
  /** Versión de los términos aceptados (0037); null en políticas anteriores (no cubren la cuota compartida). */
  consent_version: string | null;
  consent_sha256: string | null;
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

  /** Cómo se publican las respuestas (simulación o proveedor real); los avisos lo dicen claramente. */
  get replyMode(): 'simulated' | 'real' {
    return this.deps.replier.mode;
  }

  // ---------------------------------------------------------------- políticas

  async currentPolicies(tenantId: string, db: Db = this.deps.pool): Promise<PolicyView[]> {
    const res = await db.query<PolicyRow>(
      `SELECT DISTINCT ON (origin, category) * FROM engagement_policy
        WHERE tenant_id = $1 ORDER BY origin, category, version DESC`, [tenantId]);
    const byKey = new Map(res.rows.map((r) => [`${r.origin}:${r.category}`, r]));
    const out: PolicyView[] = [];
    for (const origin of ENGAGEMENT_ORIGINS) {
      for (const category of POLICY_CATEGORIES) {
        const row = byKey.get(`${origin}:${category}`);
        if (!row) {
          out.push({
            policy_id: null, default: true, tenant_id: tenantId, origin, category, mode: 'review_required', version: 0,
            max_auto_replies_per_hour: 10, consent_version: null, consent_current: true, reconsent_required: false,
          });
          continue;
        }
        const current = row.mode === 'review_required' || consentIsCurrent(row);
        out.push({ ...row, consent_current: current, reconsent_required: reconsentRequired(row) });
      }
    }
    return out;
  }

  private async policyFor(tenantId: string, origin: EngagementOrigin, category: EngagementCategory, db: Db): Promise<PolicyInForce | null> {
    if (category === 'other') return null;
    const res = await db.query<PolicyRow>(
      `SELECT * FROM engagement_policy WHERE tenant_id = $1 AND origin = $2 AND category = $3
        ORDER BY version DESC LIMIT 1`, [tenantId, origin, category]);
    const p = res.rows[0];
    return p ? {
      policy_id: p.policy_id, version: p.version, mode: p.mode, max_auto_replies_per_hour: p.max_auto_replies_per_hour,
      origin: p.origin, category: p.category, consent_version: p.consent_version, consent_sha256: p.consent_sha256,
    } : null;
  }

  /** Valida la aceptación explícita de los términos que el panel mostró (su versión debe ser la vigente). */
  private acceptedTerms(b: Record<string, unknown>, origin: EngagementOrigin, missing: string) {
    const terms = AUTO_REPLY_CONSENT[origin];
    if (b['consent'] !== true || typeof b['consent_version'] !== 'string') throw new AppError(400, 'validation_error', missing);
    if (b['consent_version'] !== terms.version) {
      throw new AppError(409, 'validation_error', 'Las condiciones de la autorización cambiaron. Revisa el texto actualizado y vuelve a aceptarlo.');
    }
    return terms;
  }

  private async insertPolicy(client: PoolClient, actor: Actor, p: { origin: EngagementOrigin; category: PolicyCategory; mode: PolicyMode; max: number },
    terms: { version: string; text: string; sha256: string }, result: (version: number) => string): Promise<PolicyRow> {
    const v = await client.query<{ v: number }>(
      'SELECT COALESCE(MAX(version), 0) AS v FROM engagement_policy WHERE tenant_id = $1 AND origin = $2 AND category = $3',
      [actor.tenantId, p.origin, p.category]);
    const version = Number(v.rows[0]?.v ?? 0) + 1;
    const res = await client.query<PolicyRow>(
      `INSERT INTO engagement_policy (policy_id, tenant_id, origin, category, mode, version, max_auto_replies_per_hour, consent_text,
         consent_version, consent_sha256, decided_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [`pol_${randomUUID()}`, actor.tenantId, p.origin, p.category, p.mode, version, p.max, terms.text, terms.version, terms.sha256, actor.userId]);
    const row = res.rows[0] as PolicyRow;
    await this.deps.sink.write({
      tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
      action: 'engagement.policy.changed', resource: `engagement_policy/${p.origin}/${p.category}`,
      request_id: actor.requestId, decision: 'allow', result: result(version), evidence_ref: row.policy_id,
    }, client, true);
    return row;
  }

  /**
   * Nueva versión de política (append-only). `safe_auto_reply` exige aceptar explícitamente los términos vigentes de
   * su origen (SEC-CONSENT-01): el cuerpo trae la versión que el panel mostró y se guardan texto, versión y huella.
   */
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
    const terms = mode === 'safe_auto_reply'
      ? this.acceptedTerms(b, origin, 'Para activar respuestas automáticas confirma explícitamente la autorización.')
      : REVIEW_REQUIRED_CONSENT;
    const maxRaw = b['max_auto_replies_per_hour'];
    const max = maxRaw === undefined ? 10 : Number(maxRaw);
    if (!Number.isInteger(max) || max < 1 || max > 60) {
      throw new AppError(400, 'validation_error', 'El límite de respuestas automáticas por hora debe estar entre 1 y 60.');
    }
    return runAtomic(this.deps.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`engagement_policy:${actor.tenantId}:${origin}:${category}`]);
      return this.insertPolicy(client, actor, { origin, category, mode, max }, terms, (version) => `${mode}:v${version}:consent:${terms.version}`);
    });
  }

  /**
   * SEC-CONSENT-01: el negocio acepta los términos vigentes de UN origen para sus respuestas automáticas autorizadas con
   * un consentimiento anterior (reseñas de Google desde DEC-0077; comentarios de Facebook desde DEC-0078, que les dio
   * su propio medidor). El origen es el de la versión que el panel mostró (o el indicado, que debe coincidir). Crea una
   * versión nueva de cada política afectada (mismo modo y límite por hora) con el texto aceptado, su versión y su huella,
   * auditada en la misma transacción. Sin políticas afectadas no cambia nada (repetir es inocuo). Hasta aceptarlo, esas
   * respuestas salen con el texto seguro sin IA.
   */
  async reconsent(actor: Actor, body: unknown): Promise<{ updated: PolicyRow[]; policies: PolicyView[] }> {
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const missing = 'Para aceptar las nuevas condiciones marca explícitamente la autorización.';
    const requested = b['origin'];
    if (requested !== undefined && requested !== 'google_review' && requested !== 'facebook_comment') {
      throw new AppError(400, 'validation_error', 'Elige el origen: reseñas de Google o comentarios de Facebook.');
    }
    if (b['consent'] !== true || typeof b['consent_version'] !== 'string') throw new AppError(400, 'validation_error', missing);
    const origin = (requested as EngagementOrigin | undefined) ?? autoReplyOriginOfVersion(b['consent_version']);
    if (!origin) {
      throw new AppError(409, 'validation_error', 'Las condiciones de la autorización cambiaron. Revisa el texto actualizado y vuelve a aceptarlo.');
    }
    const terms = this.acceptedTerms(b, origin, missing);
    const updated = await runAtomic(this.deps.pool, async (client) => {
      const rows: PolicyRow[] = [];
      for (const category of POLICY_CATEGORIES) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`engagement_policy:${actor.tenantId}:${origin}:${category}`]);
        const cur = await client.query<PolicyRow>(
          `SELECT * FROM engagement_policy WHERE tenant_id = $1 AND origin = $2 AND category = $3
            ORDER BY version DESC LIMIT 1`, [actor.tenantId, origin, category]);
        const row = cur.rows[0];
        if (!row || !reconsentRequired(row)) continue;
        rows.push(await this.insertPolicy(client, actor, { origin, category, mode: 'safe_auto_reply', max: row.max_auto_replies_per_hour },
          terms, (version) => `safe_auto_reply:v${version}:reconsent:${terms.version}`));
      }
      return rows;
    });
    return { updated, policies: await this.currentPolicies(actor.tenantId) };
  }

  // ---------------------------------------------------------------- sugerencias con IA (DEC-0078 R1, FB-1)

  /** Modo efectivo de sugerencias del negocio para el origen (sin fila: `on_demand`, el predeterminado). */
  async suggestionSetting(tenantId: string, origin: SuggestionOrigin, db: Db = this.deps.pool): Promise<SuggestionSetting> {
    const res = await db.query<SuggestionSettingRow>(
      `SELECT * FROM engagement_suggestion_setting WHERE tenant_id = $1 AND origin = $2 ORDER BY version DESC LIMIT 1`, [tenantId, origin]);
    const row = res.rows[0];
    if (!row) {
      return {
        origin, mode: DEFAULT_SUGGESTION_MODE, setting_id: null, version: 0, default: true, consent_version: null, consent_current: false,
        decided_by: null, created_at: null,
      };
    }
    return {
      origin, mode: row.mode, setting_id: row.setting_id, version: row.version, default: false, consent_version: row.consent_version,
      consent_current: row.mode === 'auto_suggest' && suggestionConsentIsCurrent(row), decided_by: row.decided_by, created_at: row.created_at,
    };
  }

  /**
   * Cambia el modo de sugerencias (versión nueva, append-only, auditada en la misma transacción). `auto_suggest` exige
   * aceptar explícitamente los términos vigentes que mostró el panel (versión; 409 si cambiaron) y un medidor definido
   * en el plan: sin valor no hay costo que informar ni límite efectivo, así que no se activa (DEC-0078 R5). `off` y
   * `on_demand` siempre se pueden elegir (apagar nunca se bloquea). Repetir el modo vigente no crea versión.
   */
  async setSuggestionMode(actor: Actor, body: unknown): Promise<AiSuggestionStatus> {
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const origin = b['origin'] ?? 'facebook_comment';
    if (origin !== 'facebook_comment') throw new AppError(400, 'validation_error', 'Las sugerencias con IA se configuran para comentarios de Facebook.');
    const mode = b['mode'];
    if (typeof mode !== 'string' || !(SUGGESTION_MODES as readonly string[]).includes(mode)) {
      throw new AppError(400, 'validation_error', 'Elige cómo prepara MainSpot las sugerencias: desactivadas, bajo demanda o automáticas.');
    }
    const wanted = mode as SuggestionMode;
    let terms: { version: string; text: string; sha256: string } | null = null;
    if (wanted === 'auto_suggest') {
      const current = AUTO_SUGGEST_CONSENT.facebook_comment;
      if (b['consent'] !== true || typeof b['consent_version'] !== 'string') {
        throw new AppError(400, 'validation_error', 'Para activar las sugerencias automáticas confirma explícitamente la autorización.');
      }
      if (b['consent_version'] !== current.version) {
        throw new AppError(409, 'validation_error', 'Las condiciones de las sugerencias automáticas cambiaron. Revisa el texto actualizado y vuelve a aceptarlo.');
      }
      const credits = await this.aiSuggestionStatus(actor.tenantId);
      if (!credits.subscription_active || !credits.limit) {
        throw new AppError(409, 'validation_error', credits.subscription_active
          ? 'Tu plan todavía no incluye sugerencias con IA para comentarios de Facebook, así que no se pueden activar las automáticas. Puedes seguir respondiendo a mano.'
          : 'Necesitas una suscripción activa para activar las sugerencias automáticas.');
      }
      terms = current;
    }
    await runAtomic(this.deps.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`engagement_suggestion:${actor.tenantId}:${origin}`]);
      const now = await this.suggestionSetting(actor.tenantId, origin, client);
      if (now.mode === wanted && (wanted !== 'auto_suggest' || now.consent_current) && !now.default) return;
      const version = now.version + 1;
      const id = `sgs_${randomUUID()}`;
      await client.query(
        `INSERT INTO engagement_suggestion_setting (setting_id, tenant_id, origin, version, mode, consent_text, consent_version, consent_sha256, decided_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, actor.tenantId, origin, version, wanted, terms?.text ?? null, terms?.version ?? null, terms?.sha256 ?? null, actor.userId]);
      await this.deps.sink.write({
        tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
        action: 'engagement.suggestions.changed', resource: `engagement_suggestion_setting/${origin}`,
        request_id: actor.requestId, decision: 'allow', result: `${wanted}:v${version}${terms ? `:consent:${terms.version}` : ''}`, evidence_ref: id,
      }, client, true);
    });
    return this.aiSuggestionStatus(actor.tenantId);
  }

  /**
   * FB-2: ¿el comentario repite el texto de otro anterior de la misma publicación? (misma forma normalizada en la BD).
   * Solo frena el gasto automático; una persona puede pedir la sugerencia igualmente.
   */
  private async isDuplicateComment(row: CaseRow): Promise<boolean> {
    if (!row.post_id) return false;
    const res = await this.deps.pool.query(
      `SELECT 1 FROM engagement_case o
        WHERE o.tenant_id = $1 AND o.origin = 'facebook_comment' AND o.post_id = $2 AND o.case_id <> $3
          AND (o.created_at, o.case_id) < ($4::timestamptz, $3)
          AND lower(btrim(regexp_replace(normalize(o.body, NFKC), '\\s+', ' ', 'g')))
            = lower(btrim(regexp_replace(normalize($5::text, NFKC), '\\s+', ' ', 'g')))
        LIMIT 1`, [row.tenant_id, row.post_id, row.case_id, row.created_at, row.body]);
    return (res.rowCount ?? 0) > 0;
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
    // DEC-0078 (FB-1): modo de sugerencias del negocio, leído aquí y comprobado de nuevo al confirmar el caso.
    const suggestion = isSuggestionOrigin(row.origin) ? await this.suggestionSetting(row.tenant_id, row.origin) : null;
    const autoSuggest = suggestion?.mode === 'auto_suggest' && suggestion.consent_current;
    if (aiEligible && this.deps.semantics) {
      // DEC-0076/DEC-0078 (FB-2): recibir no redacta con IA. Para PUBLICAR solo se redacta si la respuesta automática
      // todavía puede publicarse: `decide` ya exigió política vigente, categoría segura, sin riesgos, confianza, dato
      // verificado y espacio en el máximo por hora; además, el consentimiento vigente debe cubrir el gasto de su medidor.
      const forPublication = decision.decision === 'auto_reply' && policy !== null && consentCoversAiSpend(policy);
      // FB-1: la sugerencia automática para revisión solo con `auto_suggest` y sus términos vigentes; puede prepararse
      // aunque la publicación automática esté limitada (máximo por hora), y nunca publica por sí sola.
      const forSuggestion = decision.decision === 'human_review' && row.origin === 'facebook_comment' && autoSuggest;
      if (decision.decision === 'auto_reply' && !forPublication && await this.deps.semantics.replyAvailable(row.origin)) {
        // SEC-CONSENT-01 (DEC-0077 R8, DEC-0078 R6): el consentimiento de esta política es anterior a su medidor (o de
        // otra versión). Sin aceptar los términos vigentes no se redacta con IA ni se gasta ninguna unidad: sale el
        // texto seguro sin IA, que ese consentimiento ya autorizaba.
        await this.auditAiReply(row, 'deny', 'consent_outdated', policy?.policy_id ?? null);
      }
      if (forPublication || forSuggestion) {
        // FB-2: un comentario sin texto, solo con menciones, con enlaces o repetido no amerita gasto automático.
        const irrelevant: IrrelevanceReason | null = row.origin === 'facebook_comment'
          ? textRelevance(row.body) ?? (await this.isDuplicateComment(row) ? 'duplicate' : null)
          : null;
        if (irrelevant) {
          await this.auditAiReply(row, 'deny', `not_relevant:${irrelevant}`, null);
        } else {
          const metered = await this.meteredReply(row, classification, facts, { actorId: SYSTEM_ACTOR, actorRole: null, requestId: `eng_${row.case_id}` });
          generated = metered.generated;
          reservation = metered.reservation;
        }
      }
    }
    if (decision.decision === 'auto_reply' && generated?.needsHuman) {
      decision = { decision: 'human_review', reason: 'reply_needs_human' };
      if (reservation && !(row.origin === 'facebook_comment' && autoSuggest)) {
        // DEC-0077 R2/R3 y DEC-0078 R1: la redacción para la respuesta automática pidió revisión humana, así que no hubo
        // respuesta automática con IA. El caso pasa a esperar decisión SIN propuesta de IA entre las numeradas y sin
        // gastar la unidad; la IA a pedido sigue disponible y es la que consume. Con sugerencias automáticas de Facebook
        // vigentes, ese texto ES la sugerencia para revisar: una sola generación y una sola unidad para ambos fines.
        await this.deps.quota.release(reservation, null, 'ai_reply_needs_human');
        reservation = null;
        generated = null;
      }
    }
    const persist = (gen: typeof generated, held: QuotaReservationRow | null) => runAtomic(this.deps.pool, async (client) => {
      let res;
      if (decision.decision === 'auto_reply') {
        // La respuesta automática (y su unidad) solo se confirma si la política que la autorizó sigue vigente: mismo
        // candado que `setPolicy`/`reconsent`, así una revocación o unos términos nuevos nunca llegan tarde.
        if (policy) {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`engagement_policy:${row.tenant_id}:${policy.origin}:${policy.category}`]);
          const latest = await client.query<{ policy_id: string }>(
            `SELECT policy_id FROM engagement_policy WHERE tenant_id = $1 AND origin = $2 AND category = $3
              ORDER BY version DESC LIMIT 1`, [row.tenant_id, policy.origin, policy.category]);
          if (latest.rows[0]?.policy_id !== policy.policy_id) throw new PolicyChangedError();
        }
      }
      if (suggestion) {
        // DEC-0078 (FB-1): el modo de sugerencias con que se clasificó debe seguir vigente al confirmar (mismo candado que
        // `setSuggestionMode`): apagar o cambiar el modo mientras se redacta no deja una sugerencia ni gasta su unidad.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`engagement_suggestion:${row.tenant_id}:${suggestion.origin}`]);
        const latest = await client.query<{ setting_id: string }>(
          `SELECT setting_id FROM engagement_suggestion_setting WHERE tenant_id = $1 AND origin = $2 ORDER BY version DESC LIMIT 1`,
          [row.tenant_id, suggestion.origin]);
        if ((latest.rows[0]?.setting_id ?? null) !== suggestion.setting_id) throw new PolicyChangedError();
      }
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
        // Facebook (DEC-0078): la sugerencia de IA es la opción 1 (la que muestra el aviso) y queda también en `ai_draft`
        // para que el panel la identifique; en reseñas de Google aquí nunca hay texto de IA (DEC-0077 R2).
        res = await client.query<CaseRow>(
          `UPDATE engagement_case SET state = 'needs_human', decision = 'human_review', reason = $2, category = $3,
             risk_flags = $4, confidence = $5, policy_id = $6, policy_version = $7, drafts = $8, response_text = $9,
             sentiment = $10, semantic = $11, semantic_source = $12, reply_invocation_id = $13, ai_draft = $14,
             classified_at = now(), notify_status = 'pending', updated_at = now()
           WHERE case_id = $1 AND state = 'received' RETURNING *`,
          [row.case_id, decision.reason, classification.category, JSON.stringify(classification.risk_flags),
            classification.confidence, policy?.policy_id ?? null, policy?.version ?? null, JSON.stringify(drafts), drafts[0] ?? null,
            classification.sentiment, reading ? JSON.stringify(reading) : null, semanticSource, gen?.invocationId ?? null,
            gen && row.origin === 'facebook_comment' ? gen.text : null]);
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
    } catch (err) {
      if (!(err instanceof PolicyChangedError)) throw err;
      // La política cambió mientras se clasificaba: no se confirma nada (ni respuesta ni unidad) y el caso sigue en
      // `received`; el siguiente ciclo lo clasifica con la política vigente.
      log.info('engagement.case.policy_changed', 'policy changed while classifying; the case is retried', { tenant_id: row.tenant_id, case_id: row.case_id });
      return null;
    } finally {
      if (reservation && !consumed) await this.deps.quota.release(reservation, null, 'ai_reply_not_used');
    }
  }

  // ------------------------------------------------- respuestas con IA medidas (DEC-0076; Facebook: DEC-0078 R5)

  /** Rastro de una decisión de gasto de IA de un caso (auditoría best-effort, como la denegación de cuota). */
  private async auditAiReply(row: CaseRow, decision: 'allow' | 'deny', result: string, evidenceRef: string | null): Promise<void> {
    await this.deps.sink.write({
      tenant_id: row.tenant_id, actor_id: SYSTEM_ACTOR, actor_role: null,
      action: 'engagement.ai_reply', resource: `engagement_case/${row.case_id}`,
      request_id: `eng_${row.case_id}`, decision, result, evidence_ref: evidenceRef,
    }, this.deps.pool, false).catch(() => undefined);
  }

  /**
   * Reserva 1 unidad del medidor del origen del caso (`replyMeter`) ANTES de invocar a la IA (bajo el candado del libro:
   * dos procesos no superan el límite). La clave es el caso: ya consumida ⇒ `replay` sin consumo nuevo. Sin cuota, sin
   * suscripción activa o sin valor en la revisión fijada ⇒ `denied` (auditado); en curso en otra petición ⇒ 409
   * request_in_progress (lo decide el llamador).
   */
  private async claimAiReply(row: CaseRow, who: AiReplyActor): Promise<AiReplyClaim> {
    const meter = replyMeter(row.origin, row.case_id);
    try {
      const claim = await this.deps.quota.reserve({
        tenantId: row.tenant_id, capability: meter.capability, units: 1, idempotencyKey: meter.key,
        requestId: who.requestId, actorId: who.actorId, actorRole: who.actorRole,
      });
      return claim.kind === 'replay' ? { kind: 'replay' } : claim;
    } catch (err) {
      if (!(err instanceof AppError) || (err.code !== DENY_CODES.LIMIT_EXCEEDED && err.code !== DENY_CODES.SUBSCRIPTION_REQUIRED)) throw err;
      await this.deps.sink.write({
        tenant_id: row.tenant_id, actor_id: who.actorId, actor_role: who.actorRole,
        action: 'engagement.ai_reply', resource: `engagement_case/${row.case_id}`,
        request_id: who.requestId, decision: 'deny', result: err.code, evidence_ref: meter.capability,
      }, this.deps.pool, false).catch(() => undefined);
      return { kind: 'denied', error: err };
    }
  }

  /**
   * Redacción automática medida (clasificación): reserva y redacta. Sin ruta activa no reserva; si la redacción falla o
   * el medidor no alcanza, devuelve null y el caso sigue sin IA. La reserva devuelta se confirma en la transacción que
   * guarda el caso (o se libera).
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
    if (!generated.ok) {
      await this.deps.quota.release(claim.reservation, who.actorRole, 'ai_reply_failed');
      return { generated: null, reservation: null };
    }
    return { generated: { text: generated.text, needsHuman: generated.needsHuman, invocationId: generated.invocationId }, reservation: claim.reservation };
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
   * «Redactar con IA» (reseñas de Google, DEC-0076) y «Sugerir con IA» (comentarios de Facebook, DEC-0078 R1): una
   * persona pide la propuesta de IA para un caso que espera su decisión. Consume 1 unidad del medidor del origen solo si
   * la propuesta se genera y se guarda en el caso (misma transacción); si la IA falla o el caso cambió, no consume.
   * Repetir no consume otra vez, tampoco si el comentario ya trae la sugerencia automática (una unidad por caso). La
   * propuesta va en `ai_draft`, aparte de las tres numeradas: lo que muestra el aviso de Telegram no cambia y una edición
   * de las numeradas no la borra. En Facebook exige que el negocio no tenga las sugerencias desactivadas. Agotar el
   * medidor solo bloquea esto: elegir otra propuesta o escribir la respuesta sigue igual (panel y Telegram).
   */
  async requestAiDraft(actor: Actor, caseId: string): Promise<{ case: CaseRow; already: boolean }> {
    const found = await this.getCase(actor.tenantId, caseId);
    if (!found) throw this.notFound();
    if (found.reply_invocation_id) return { case: found, already: true };
    const noun = found.origin === 'google_review' ? 'esta reseña' : 'este comentario';
    if (found.origin === 'facebook_comment' && (await this.suggestionSetting(actor.tenantId, 'facebook_comment')).mode === 'off') {
      throw new AppError(409, 'validation_error', SUGGESTIONS_OFF_MESSAGE);
    }
    if (found.state !== 'needs_human' && found.state !== 'failed') {
      throw new AppError(409, 'validation_error', found.state === 'received'
        ? `MainSpot todavía está analizando ${noun}. Inténtalo en unos segundos.`
        : 'Este caso ya no admite cambios en sus respuestas.');
    }
    const classification = this.storedClassification(found);
    if (!classification || (classification.category === 'basic_info' && classification.info_topic === 'phone')) {
      throw new AppError(409, 'validation_error', `${noun === 'esta reseña' ? 'Esta reseña' : 'Este comentario'} no admite redacción con IA. Elige una de las propuestas o escribe tu respuesta.`);
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
      if (!generated.ok) {
        // AC-FB04: un presupuesto técnico agotado se explica como tal (no como un fallo genérico del proveedor).
        if (generated.code === 'budget_exhausted') {
          throw new AppError(429, DENY_CODES.LIMIT_EXCEEDED, generated.reason === 'tenant_day'
            ? 'Tu negocio alcanzó su presupuesto diario de IA (se renueva cada día, hora UTC). No se descontó de tu plan; puedes elegir una propuesta o escribir tu respuesta.'
            : 'MainSpot alcanzó su presupuesto de IA por ahora. No se descontó de tu plan; puedes elegir una propuesta o escribir tu respuesta.');
        }
        throw new AppError(502, 'validation_error', 'No se pudo redactar con IA en este momento. No se descontó de tu plan; puedes elegir una propuesta o escribir tu respuesta.');
      }
      const updated = await runAtomic(this.deps.pool, async (client) => {
        if (found.origin === 'facebook_comment') {
          // Mismo candado que `setSuggestionMode`: si el negocio apagó las sugerencias mientras se redactaba, no se guarda
          // ni se descuenta nada.
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`engagement_suggestion:${actor.tenantId}:facebook_comment`]);
          if ((await this.suggestionSetting(actor.tenantId, 'facebook_comment', client)).mode === 'off') {
            throw new AppError(409, 'validation_error', `${SUGGESTIONS_OFF_MESSAGE} No se descontó de tu plan.`);
          }
        }
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

  /** Medidor de IA de un origen para el negocio: valor fijado, uso del ciclo vigente y su ventana (solo lectura). */
  private async meterStatus(tenantId: string, origin: EngagementOrigin): Promise<AiReplyStatus> {
    const available = this.deps.semantics ? await this.deps.semantics.replyAvailable(origin) : false;
    const policy = await loadPinnedPolicy(this.deps.pool, tenantId);
    if (!policy) return { available, subscription_active: false, limit: null, usage: 0, remaining: null, window: null };
    const capability = replyMeter(origin, '-').capability;
    const status = (await this.deps.quota.capacityStatus(this.deps.pool, policy)).find((s) => s.capability === capability);
    const limit = status?.limit ?? null;
    const usage = status?.usage ?? 0;
    return {
      available, subscription_active: policy.subscription.status === 'active', limit, usage,
      remaining: limit === null ? null : Math.max(0, limit - usage), window: status?.window ?? null,
    };
  }

  /** Cuota de respuestas con IA a reseñas de Google (DEC-0076). */
  async aiReplyStatus(tenantId: string): Promise<AiReplyStatus> {
    return this.meterStatus(tenantId, 'google_review');
  }

  /**
   * DEC-0078: modo de sugerencias y medidor propio de los comentarios de Facebook. `credits_defined` falso ⇒ la revisión
   * fijada del plan no define el medidor: no hay IA de pago para esos comentarios (activación comercial BLOCKED).
   */
  async aiSuggestionStatus(tenantId: string): Promise<AiSuggestionStatus> {
    const [setting, meter] = await Promise.all([this.suggestionSetting(tenantId, 'facebook_comment'), this.meterStatus(tenantId, 'facebook_comment')]);
    return { origin: 'facebook_comment', setting, ...meter, credits_defined: meter.limit !== null };
  }

  // ---------------------------------------------------------------- decisiones humanas

  /**
   * Edita una propuesta numerada. Compara la revisión leída (sin pisar el cambio simultáneo de otra persona en otra
   * opción) y, como las propuestas cambian, los avisos de Telegram ya enviados dejan de servir para aprobar (trigger de
   * 0037) y cada chat recibe uno nuevo con las opciones vigentes (SEC-TG-APPROVAL-01).
   */
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
        `UPDATE engagement_case SET drafts = $2, notify_status = 'pending', updated_at = now()
          WHERE case_id = $1 AND tenant_id = $3 AND state IN ('needs_human','failed') AND drafts_revision = $4 RETURNING *`,
        [caseId, JSON.stringify(drafts.slice(0, 3)), actor.tenantId, found.drafts_revision]);
      if (!res.rows[0]) throw new AppError(409, 'validation_error', 'El caso cambió mientras se editaba. Recarga e inténtalo de nuevo.');
      await client.query(
        `UPDATE engagement_notification SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now()
          WHERE case_id = $1 AND tenant_id = $2`, [caseId, actor.tenantId]);
      await this.deps.sink.write({
        tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
        action: 'engagement.draft.edited', resource: `engagement_case/${caseId}`,
        request_id: actor.requestId, decision: 'allow', result: `draft:${i + 1}:r${res.rows[0].drafts_revision}`,
      }, client);
      return res.rows[0];
    });
  }

  /**
   * Aprueba desde el panel la respuesta: el texto visible (lo que envía el panel) o una propuesta numerada de la
   * revisión que la persona vio (`draft_index` + `drafts_revision`, comparada en el UPDATE). Nunca «la opción vigente»
   * sin más. Idempotente: no responde dos veces. Telegram no pasa por aquí: aprueba la opción de un aviso concreto con
   * `approveFromNotice` (SEC-TG-APPROVAL-01).
   */
  async approve(actor: Actor, caseId: string, body: { draft_index?: unknown; drafts_revision?: unknown; text?: unknown }, channel: 'panel'): Promise<{ case: CaseRow; already: boolean }> {
    const found = await this.getCase(actor.tenantId, caseId);
    if (!found) throw this.notFound();
    if (['approved', 'responding', 'responded', 'retry_pending'].includes(found.state)) return { case: found, already: true };
    if (found.state !== 'needs_human' && found.state !== 'failed') {
      throw new AppError(409, 'validation_error', 'Este caso ya fue resuelto y no puede aprobarse.');
    }
    let text: string;
    let seenRevision: number | null = null;
    if (typeof body.text === 'string' && body.text.trim()) {
      text = body.text.trim();
    } else {
      const idx = Number(body.draft_index);
      const revision = Number(body.drafts_revision);
      if (body.draft_index === undefined || !Number.isInteger(idx) || idx < 0 || idx > 2 || body.drafts_revision === undefined || !Number.isInteger(revision)) {
        throw new AppError(400, 'validation_error', 'Envía el texto que vas a publicar, o el número de la propuesta junto con la revisión de las propuestas que viste.');
      }
      if (revision !== found.drafts_revision) {
        throw new AppError(409, 'validation_error', 'Las propuestas cambiaron después de que las viste. Recarga y vuelve a elegir.');
      }
      text = (found.drafts[idx] ?? '').trim();
      seenRevision = revision;
    }
    if (!text || text.length > MAX_TEXT) throw new AppError(400, 'validation_error', 'Elige una respuesta sugerida o escribe una antes de aprobar.');
    return runAtomic(this.deps.pool, async (client) => {
      const res = await client.query<CaseRow>(
        `UPDATE engagement_case SET state = 'approved', response_text = $2, resolved_by = $3, resolution_channel = $4,
           resolved_at = now(), attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
         WHERE case_id = $1 AND tenant_id = $5 AND state IN ('needs_human','failed') AND ($6::int IS NULL OR drafts_revision = $6) RETURNING *`,
        [caseId, text, actor.userId, channel, actor.tenantId, seenRevision]);
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

  // ------------------------------------------------- aprobación por aviso de Telegram (SEC-TG-APPROVAL-01)

  /** Aviso enviado a ESTE chat y a ESTA persona del negocio; null si no existe o es ajeno (mismo trato: anti-oráculo). */
  private async findNotice(actor: Actor, chatId: string, code: string): Promise<ApprovalOfferRow | null> {
    const res = await this.deps.pool.query<ApprovalOfferRow>(
      'SELECT * FROM engagement_approval_offer WHERE chat_id = $1 AND code = $2', [chatId, code]);
    const offer = res.rows[0];
    if (offer && offer.tenant_id === actor.tenantId && offer.user_id === actor.userId) return offer;
    await this.deps.sink.write({
      tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
      action: 'engagement.approval.ref_invalid', resource: 'telegram:engagement', request_id: actor.requestId,
      decision: 'deny', result: 'unknown_or_foreign_notice',
    }).catch(() => undefined);
    return null;
  }

  /**
   * `/aprobar <código> <N>`: publica EXACTAMENTE la opción N que mostró ese aviso, y solo si el caso sigue abierto y en
   * la misma revisión de propuestas (candado del caso y comparación en la misma sentencia que aprueba). Si cualquier
   * propuesta cambió después del aviso (o el aviso ya no está activo), no publica nada: invalida el aviso, lo audita y
   * programa uno nuevo para ese chat (`stale`). Repetir sobre un caso ya aprobado no publica dos veces (`already`).
   */
  async approveFromNotice(actor: Actor, chatId: string, code: string, option: number): Promise<NoticeApproval> {
    const notice = await this.findNotice(actor, chatId, code);
    if (!notice) return { kind: 'invalid' };
    const idx = option - 1;
    return runAtomic(this.deps.pool, async (client): Promise<NoticeApproval> => {
      // Mismo orden de candados que una edición (caso → avisos, trigger de 0037): sin interbloqueos.
      const c = (await client.query<CaseRow>('SELECT * FROM engagement_case WHERE case_id = $1 AND tenant_id = $2 FOR UPDATE',
        [notice.case_id, actor.tenantId])).rows[0];
      const o = (await client.query<ApprovalOfferRow>('SELECT * FROM engagement_approval_offer WHERE offer_id = $1 FOR UPDATE',
        [notice.offer_id])).rows[0];
      if (!c || !o) return { kind: 'invalid' };
      if (['approved', 'responding', 'responded', 'retry_pending'].includes(c.state)) return { kind: 'already', case: c };
      if (c.state !== 'needs_human' && c.state !== 'failed') {
        throw new AppError(409, 'validation_error', 'Este caso ya fue resuelto y no puede aprobarse.');
      }
      const shown = Number.isInteger(idx) && idx >= 0 && idx < o.options.length ? o.options[idx] : undefined;
      if (o.status === 'active' && !shown?.trim()) {
        throw new AppError(400, 'validation_error', `Ese aviso no tiene una opción ${option}. Elige uno de los números que muestra.`);
      }
      if (o.status !== 'active' || o.drafts_revision !== c.drafts_revision || shown === undefined || c.drafts[idx] !== shown) {
        if (o.status === 'active') {
          await client.query(`UPDATE engagement_approval_offer SET status = 'superseded', superseded_at = now() WHERE offer_id = $1`, [o.offer_id]);
        }
        await client.query(`UPDATE engagement_case SET notify_status = 'pending', updated_at = now() WHERE case_id = $1`, [c.case_id]);
        await client.query(
          `UPDATE engagement_notification SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now()
            WHERE case_id = $1 AND chat_id = $2`, [c.case_id, chatId]);
        await this.deps.sink.write({
          tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
          action: 'engagement.approval.stale', resource: `engagement_case/${c.case_id}`, request_id: actor.requestId,
          decision: 'deny', result: `notice_r${o.drafts_revision}:case_r${c.drafts_revision}:${o.status}`, evidence_ref: o.offer_id,
        }, client);
        return { kind: 'stale', case: c, reason: o.status === 'used' ? 'used' : 'changed' };
      }
      const res = await client.query<CaseRow>(
        `UPDATE engagement_case SET state = 'approved', response_text = $2, resolved_by = $3, resolution_channel = 'telegram',
           resolved_at = now(), attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
         WHERE case_id = $1 AND tenant_id = $4 AND state IN ('needs_human','failed')
           AND drafts_revision = $5 AND drafts ->> $6::int = $7 RETURNING *`,
        [c.case_id, shown.trim(), actor.userId, actor.tenantId, o.drafts_revision, idx, shown]);
      const row = res.rows[0];
      if (!row) throw new Error('engagement.approveFromNotice: compare-and-set failed while holding the case lock');
      await client.query(`UPDATE engagement_approval_offer SET status = 'used', used_option = $2, used_at = now() WHERE offer_id = $1`, [o.offer_id, option]);
      await this.deps.sink.write({
        tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
        action: 'engagement.approved', resource: `engagement_case/${c.case_id}`,
        request_id: actor.requestId, decision: 'allow', result: `approved:telegram:option_${option}:r${o.drafts_revision}`, evidence_ref: o.offer_id,
      }, client, true);
      return { kind: 'approved', case: row };
    });
  }

  /** `/rechazar <código>`: descarta el caso del aviso (no publica nada, así que no depende de la revisión). */
  async rejectFromNotice(actor: Actor, chatId: string, code: string): Promise<{ case: CaseRow; already: boolean } | null> {
    const notice = await this.findNotice(actor, chatId, code);
    return notice ? this.reject(actor, notice.case_id, 'telegram') : null;
  }

  /**
   * Aviso de ESTE chat y persona con su caso, para mostrar un paso de sus botones (elegir una opción o volver al aviso)
   * sin decidir nada; `updated`: sustituyó en este chat a un aviso de una revisión anterior. null si no existe o es
   * ajeno, con el mismo trato y auditoría que `/aprobar` con un código ajeno.
   */
  async noticeFor(actor: Actor, chatId: string, code: string): Promise<{ offer: ApprovalOfferRow; case: CaseRow; updated: boolean } | null> {
    const offer = await this.findNotice(actor, chatId, code);
    const c = offer ? await this.getCase(actor.tenantId, offer.case_id) : null;
    if (!offer || !c) return null;
    return { offer, case: c, updated: await this.earlierNoticeSent(c.case_id, chatId, offer.drafts_revision) };
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
    // Agotado sin publicar: se libera el destino para que otra decisión (humana) pueda responder, y los chats ya
    // avisados reciben el aviso vigente («No pudimos publicar…» o el caso escalado), con instantánea nueva.
    if (exhausted) {
      await this.deps.pool.query('DELETE FROM response_ledger WHERE tenant_id = $1 AND origin = $2 AND target_ref = $3 AND owner_ref = $4 AND state = \'claimed\'',
        [row.tenant_id, row.origin, row.external_ref, owner]).catch(() => undefined);
      await this.deps.pool.query(
        `UPDATE engagement_notification SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now()
          WHERE case_id = $1`, [row.case_id]);
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

  /**
   * Texto del aviso: mismo case_id que el panel, las opciones numeradas EXACTAS de la instantánea y los comandos con el
   * código de ESTE aviso (SEC-TG-APPROVAL-01).
   */
  notificationText(row: CaseRow, notice: { code: string; options: readonly string[]; updated: boolean }): string {
    const origin = row.origin === 'google_review'
      ? `Reseña de Google${row.rating ? ` (${row.rating}★)` : ''}`
      : 'Comentario en Facebook';
    // Texto de terceros (reseña y autor) en una sola línea y sin comandos: nunca parece una opción, otro aviso ni un
    // comando. Cuenta como salto cualquier terminador de línea, no solo `\n`.
    const thirdParty = (s: string) => s.replace(LINE_BREAK, ' ').replace(/\s+/g, ' ').trim().replace(/\/(aprobar|rechazar)\b/gi, '$1');
    const flat = thirdParty(row.body);
    const excerpt = flat.length > 300 ? `${flat.slice(0, 297)}…` : flat;
    const header = row.state === 'failed' ? 'MainSpot · No pudimos publicar la respuesta aprobada'
      : row.reason === 'delivery_uncertain' ? 'MainSpot · No sabemos si se publicó la respuesta aprobada: revisa la reseña antes de decidir'
        : notice.updated ? 'MainSpot · Propuestas actualizadas (el aviso anterior ya no sirve para aprobar)'
          : 'MainSpot · Caso pendiente de tu decisión';
    const lines = [
      `${header} · aviso ${notice.code}`,
      `Caso: ${row.case_id}`,
      `${origin} · ${thirdParty(row.author_label)}`,
      `«${excerpt}»`,
      `Motivo: ${row.reason ?? 'revisión'}`,
    ];
    // Solo las opciones reales empiezan una línea con «N) »: las líneas siguientes de cada opción van sangradas.
    notice.options.forEach((d, i) => lines.push(`${i + 1}) ${d.replace(LINE_BREAK, '\n   ')}`));
    const n = notice.options.length;
    if (n > 0) {
      lines.push(`Para publicar: /aprobar ${notice.code} 1${n === 3 ? ' (o 2, 3)' : n === 2 ? ' (o 2)' : ''} · Para no responder: /rechazar ${notice.code}`);
      lines.push('Este código solo vale para estas opciones: si alguien las cambia, te enviamos un aviso nuevo.');
    } else {
      lines.push(`Sin propuestas: escribe la respuesta en tu panel. Para no responder: /rechazar ${notice.code}`);
    }
    lines.push(`Panel: ${this.deps.panelUrl}#/caso/${row.case_id}`);
    return lines.join('\n');
  }

  /** «Propuestas actualizadas»: este chat ya recibió un aviso del caso con una revisión anterior (no en reenvíos ni reintentos). */
  private async earlierNoticeSent(caseId: string, chatId: string, revision: number): Promise<boolean> {
    const prior = await this.deps.pool.query('SELECT 1 FROM engagement_approval_offer WHERE case_id = $1 AND chat_id = $2 AND drafts_revision < $3 LIMIT 1',
      [caseId, chatId, revision]);
    return (prior.rowCount ?? 0) > 0;
  }

  /**
   * Registra la instantánea inmutable del aviso que se va a enviar (código único en el chat). Si las propuestas del
   * caso ya cambiaron desde que se leyó, no registra nada (null): el caso se avisará con la revisión nueva.
   */
  private async issueNotice(c: CaseRow, notificationId: string, chatId: string, userId: string): Promise<{ code: string; options: string[]; updated: boolean } | null> {
    const options = c.drafts.slice(0, 3);
    const sha = optionsSha256(options);
    const updated = await this.earlierNoticeSent(c.case_id, chatId, c.drafts_revision);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = newNoticeCode();
      const res = await this.deps.pool.query(
        `INSERT INTO engagement_approval_offer (offer_id, tenant_id, case_id, notification_id, chat_id, user_id, code, drafts_revision, options, options_sha256)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
          WHERE EXISTS (SELECT 1 FROM engagement_case WHERE case_id = $3 AND drafts_revision = $8)
         ON CONFLICT (chat_id, code) DO NOTHING`,
        [`ofr_${randomUUID()}`, c.tenant_id, c.case_id, notificationId, chatId, userId, code, c.drafts_revision, JSON.stringify(options), sha]);
      if (res.rowCount) return { code, options, updated };
      const still = await this.deps.pool.query('SELECT 1 FROM engagement_case WHERE case_id = $1 AND drafts_revision = $2', [c.case_id, c.drafts_revision]);
      if (!still.rowCount) return null;
    }
    throw new Error('engagement.issueNotice: could not allocate a unique notice code');
  }

  /**
   * Envía los avisos pendientes por los chats de Telegram VINCULADOS y activos (nunca por el teléfono público). Una fila
   * de entrega por (caso, chat); cada envío registra antes su instantánea con código propio. Si las propuestas cambian
   * mientras se envía, la fila no se marca enviada y el siguiente ciclo manda las vigentes. Sin chat → no_destination
   * (el caso sigue visible en el panel y se reevalúa cuando se vincule un chat).
   */
  async dispatchNotifications(tenantId: string): Promise<{ sent: number; failed: number; no_destination: number }> {
    const out = { sent: 0, failed: 0, no_destination: 0 };
    // Además del resumen del caso, cuenta toda fila de entrega pendiente de un chat activo: una edición o un `/aprobar`
    // obsoleto que reprograma el aviso mientras otro ciclo envía nunca queda sin enviar.
    const cases = await this.deps.pool.query<CaseRow>(
      `SELECT * FROM engagement_case c WHERE c.tenant_id = $1 AND c.state IN ('needs_human','failed')
         AND (c.notify_status IN ('pending','no_destination','failed')
              OR EXISTS (SELECT 1 FROM engagement_notification n
                          JOIN telegram_link l ON l.chat_id = n.chat_id AND l.tenant_id = c.tenant_id AND l.status = 'active'
                         WHERE n.case_id = c.case_id AND n.status IN ('pending','failed') AND n.attempts < $2))
       ORDER BY c.created_at LIMIT 20`, [tenantId, MAX_RESPOND_ATTEMPTS]);
    if (!cases.rows.length) return out;
    const chats = await this.deps.pool.query<{ chat_id: string; user_id: string }>(
      `SELECT chat_id, user_id FROM telegram_link WHERE tenant_id = $1 AND status = 'active'`, [tenantId]);
    const userOf = new Map(chats.rows.map((r) => [r.chat_id, r.user_id]));
    const active = chats.rows.map((r) => r.chat_id);
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
          WHERE case_id = $1 AND chat_id = ANY($3::text[]) AND status IN ('pending','failed') AND attempts < $2
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())`, [c.case_id, MAX_RESPOND_ATTEMPTS, active]);
      for (const n of due.rows) {
        const outcome = await this.deliverNotice(c, n, userOf.get(n.chat_id) ?? '');
        if (outcome === 'sent') out.sent += 1;
        else if (outcome === 'failed') out.failed += 1;
      }
      // `failed` solo si algún envío falló; una fila que quedó pendiente (su aviso se quedó viejo mientras salía) se
      // envía en el siguiente ciclo con la revisión vigente.
      const rows = await this.deps.pool.query<{ status: string }>(
        'SELECT status FROM engagement_notification WHERE case_id = $1 AND chat_id = ANY($2::text[])', [c.case_id, active]);
      const statuses = rows.rows.map((r) => r.status);
      const status = statuses.includes('failed') ? 'failed' : statuses.includes('pending') ? 'pending' : 'sent';
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

  /**
   * Envía UN aviso por su fila de entrega: primero registra su instantánea (código nuevo) y después manda la tarjeta, cuyos
   * botones llevan ese código (SEC-TG-APPROVAL-01). La fila solo queda enviada si las propuestas no cambiaron mientras
   * tanto; un fallo del canal la reintenta con espera creciente.
   */
  private async deliverNotice(c: CaseRow, n: { notification_id: string; chat_id: string; attempts: number }, userId: string): Promise<'sent' | 'failed' | 'skipped'> {
    const notice = await this.issueNotice(c, n.notification_id, n.chat_id, userId);
    if (!notice) return 'skipped';
    const injected = this.deps.channel.name === 'simulated' && await consumeSimFault(this.deps.pool, c.tenant_id, 'telegram', 'error');
    const card = noticeMessage(c, this.notificationText(c, notice), notice, { simulated: this.replyMode === 'simulated', panelUrl: this.deps.panelUrl });
    const sent = injected ? { ok: false, error: 'simulated_telegram_error' } : await this.deps.channel.send(n.chat_id, card);
    if (sent.ok) {
      // Bajo candado compartido del caso (una edición en curso confirma antes): solo queda «enviada» si la revisión
      // enviada sigue siendo la vigente; si no, la fila sigue pendiente y el siguiente ciclo manda la nueva.
      const marked = await runAtomic(this.deps.pool, async (client) => {
        const now = await client.query<{ drafts_revision: number }>('SELECT drafts_revision FROM engagement_case WHERE case_id = $1 FOR SHARE', [c.case_id]);
        if (now.rows[0]?.drafts_revision !== c.drafts_revision) return false;
        await client.query(
          `UPDATE engagement_notification SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL, updated_at = now()
            WHERE notification_id = $1`, [n.notification_id]);
        return true;
      });
      return marked ? 'sent' : 'skipped';
    }
    await this.deps.pool.query(
      `UPDATE engagement_notification SET status = 'failed', attempts = attempts + 1, last_error = $2,
         next_attempt_at = now() + make_interval(secs => $3), updated_at = now() WHERE notification_id = $1`,
      [n.notification_id, (sent.error ?? 'send_failed').slice(0, 120), backoffSeconds(n.attempts + 1)]);
    return 'failed';
  }

  /**
   * Envía ya a ESTE chat vinculado el aviso vigente de un caso pendiente del negocio, con instantánea y código nuevos
   * (tras un `/aprobar` obsoleto o un mensaje anterior a los códigos). Caso de otro negocio, resuelto o chat no activo
   * para esta persona: no hace nada (false). Si el envío falla, la fila queda para el reintento del worker.
   */
  async sendNoticeTo(actor: Actor, chatId: string, caseId: string): Promise<boolean> {
    const c = await this.getCase(actor.tenantId, caseId);
    if (!c || (c.state !== 'needs_human' && c.state !== 'failed')) return false;
    const link = await this.deps.pool.query<{ user_id: string }>(
      `SELECT user_id FROM telegram_link WHERE tenant_id = $1 AND chat_id = $2 AND user_id = $3 AND status = 'active'`,
      [actor.tenantId, chatId, actor.userId]);
    if (!link.rows[0]) return false;
    const row = await this.deps.pool.query<{ notification_id: string; chat_id: string; attempts: number }>(
      `INSERT INTO engagement_notification (notification_id, tenant_id, case_id, chat_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (case_id, chat_id) DO UPDATE SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now()
       RETURNING notification_id, chat_id, attempts`, [`ntf_${randomUUID()}`, actor.tenantId, caseId, chatId]);
    await this.deps.pool.query(`UPDATE engagement_case SET notify_status = 'pending', updated_at = now() WHERE case_id = $1`, [caseId]);
    const n = row.rows[0];
    if (n) await this.deliverNotice(c, n, actor.userId);
    return true;
  }
}
