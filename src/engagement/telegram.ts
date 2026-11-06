/**
 * Telegram como canal de MainSpot (DEV-E2E-02, SHARED-CONTRACT §B): avisos, decisiones y conversación.
 *
 * - Vínculo: la persona genera un código de un solo uso (10 min) en el panel y abre el enlace
 *   t.me/<bot>?start=CÓDIGO (Telegram envía `/start CÓDIGO`). El chat queda ligado a ESA persona y tenant.
 *   Nunca se usa el teléfono público del negocio como destino.
 * - Respuestas públicas a clientes (SEC-TG-APPROVAL-01, DEC-0077): cada aviso de un caso lleva el código de su
 *   instantánea (`engagement_approval_offer`, registrada ANTES de enviarlo) y sus botones llevan ESE código y el número
 *   de opción, nunca el id del caso: «Usar la respuesta N» muestra la opción N de la instantánea, «Publicar esta
 *   respuesta» es `approveFromNotice` y «No responder» es `rejectFromNotice`, igual que `/aprobar <código> <1-3>` y
 *   `/rechazar <código>` escritos. Publica exactamente lo que el aviso mostró y solo si las propuestas no cambiaron;
 *   un aviso obsoleto, usado o ajeno nunca publica: se explica el estado real y, si el caso sigue pendiente en este
 *   negocio, llega el aviso vigente con otro código. Un botón o mensaje con el id del caso (anteriores a los códigos)
 *   nunca decide. Mismos permisos RBAC que el panel.
 * - Un negocio suspendido o en baja no decide, no publica ni conversa desde el chat.
 * - Fuera de esos comandos la persona escribe lenguaje natural: cada mensaje libre entra al MISMO pipeline del panel
 *   (identidad, rol, cuota, Jev, auditoría) con canal `telegram`. Lo demás son botones en línea (`telegram-ui.ts`):
 *   ver cómo queda / publicar / descartar un cambio de la web, publicaciones de Facebook, ver pendientes y usar o
 *   dejar el laboratorio de IA.
 * - Cada pulsación vuelve a comprobar chat vinculado, negocio activo, persona, rol (deny auditado) y estado actual:
 *   un botón viejo nunca actúa sobre algo que ya cambió; el mensaje se edita con el estado real y pierde sus
 *   botones al decidir. Publicar o programar una publicación solo actúa sobre el contenido que mostró su tarjeta.
 * - Una decisión escrita suelta («publicar», «sí», «opción 2») no adivina a qué se refiere: muestra los
 *   pendientes como botones.
 * - Reentregas: un Update (mensaje o pulsación) con `update_id` se reclama en `telegram_update` antes de
 *   actuar, así la misma entrega repetida o concurrente no responde ni decide dos veces (ver handleUpdate).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { plainMessage, type ChannelAdapter, type OutgoingMessage } from '../channels/types.ts';
import type { RoleName } from '../identity/entities.ts';
import { MATRIX, type ActionName } from '../rbac/matrix.ts';
import { AppError } from '../shared/errors.ts';
import type { AiJobRow, AiJobs } from '../ai/jobs.ts';
import type { AiLab } from '../ai/lab.ts';
import type { AiBusinessService } from '../ai/business.ts';
import type { ConversationPipeline } from '../conversation/pipeline.ts';
import type { IngestOutcome } from '../conversation/intents.ts';
import type { ActionProposalRow } from '../conversation/repositories.ts';
import { approveAndPublish, confirmAndPreparePreview, rejectProposal, type StateMachineDeps } from '../conversation/state-machine.ts';
import type { SocialPostRow, SocialService } from '../social/service.ts';
import type { SocialOutcome } from '../social/scheduler.ts';
import { labelInZone, nextWeeklySlot } from '../social/timezone.ts';
import { parseNoticeCode } from './notice-offer.ts';
import type { CaseRow, EngagementService, NoticeApproval } from './service.ts';
import {
  aiEditStartedMessage, answerWithPending, caseResolvedMessage, helpMessage, invalidCodeMessage, labInvalidMessage, labNoneMessage,
  labOffMessage, labOnMessage, linkedMessage, noticeConfirmMessage, noticeMessage, parseAction, pendingCaseItem, pendingMessage,
  pendingProposalItem, postShownRef, proposalMessage, socialComposingMessage, socialDeclinedMessage, socialDroppedMessage,
  socialHintMessage, socialOfferMessage, socialPostMessage, socialVariantsMessage, unlinkedMessage,
  type CaseContext, type ComposeResultView, type LabState, type PendingItem, type SocialContext, type TelegramAction,
} from './telegram-ui.ts';

/** Identificador de caso de los avisos anteriores a los códigos (`/aprobar <case_id> N`). */
const CASE_ID_RE = /^case_[0-9a-f]{32}$/;
const INVALID_NOTICE = 'Ese código no corresponde a un aviso vigente de este chat. Usa el código del aviso más reciente o resuelve el caso en tu panel.';
const TENANT_INACTIVE = 'Tu negocio no está activo en MainSpot, así que desde aquí no se pueden decidir casos ni pedir cambios.';

export const LINK_CODE_TTL_MINUTES = 10;
/** Segundos tras los que un update «en curso» se da por abandonado (proceso caído) y puede reclamarse de nuevo. */
export const UPDATE_LEASE_SECONDS = 120;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Mensajes para el resultado de una edición con IA que terminó sin propuesta (sin datos del modelo). */
const AI_JOB_FAILURE: Record<string, string> = {
  no_active_route: 'La edición con IA no está activa en tu cuenta. No preparé nada.',
  lab_grant_invalid: 'Tu autorización de laboratorio de IA venció o fue revocada. No preparé nada.',
  provider_auth: 'El proveedor de IA rechazó la solicitud (credencial o saldo). No preparé nada.',
  provider_unavailable: 'El proveedor de IA no respondió. No preparé nada; puedes intentarlo de nuevo.',
  timeout: 'El proveedor de IA tardó demasiado. No preparé nada; puedes intentarlo de nuevo.',
  circuit_open: 'El proveedor de IA está fallando ahora. No preparé nada; intenta en unos minutos.',
  budget_exhausted: 'Se alcanzó el presupuesto de IA. No preparé nada.',
  blocked_external: 'La IA real está desactivada en este entorno. No preparé nada.',
  invalid_output: 'La IA propuso un cambio que no cumple las reglas de tu página (por ejemplo, un dato inventado). No preparé nada; intenta decirlo de otra forma.',
  no_visible_change: 'Ese cambio no modificaría nada visible de tu página, así que no preparé ninguna propuesta.',
  image_not_in_library: 'La foto elegida ya no está en tu biblioteca. No preparé nada.',
};

/** Decisiones escritas sueltas: no se adivina a qué se refieren; se muestran los pendientes como botones. */
const LOOSE_DECISION = /^(confirmar|confirmo|publicar|publicalo|publica|descartar|descartalo|descarta|rechazar|rechazalo|rechaza|aprobar|apruebo|aprueba|aceptar|acepto|cancelar|cancela|si|no|ok|vale|listo|(opcion|respuesta|la) ?\d|\d)$/;
/** Preguntas cortas por lo pendiente («¿qué tengo pendiente?», «pendientes»): se responden con los botones, sin IA. */
const PENDING_QUERY = /^(que )?(tengo |hay )?(algo )?pendientes?( por (decidir|revisar|aprobar))?$/;

function hashCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

function normalized(text: string): string {
  return text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^[¡¿/]+/, '').replace(/[.!¡¿?]+$/g, '').trim();
}

/** Resultado de `social.compose` tal como lo guarda el job, reducido a lo que muestra la tarjeta. */
function composeView(result: Record<string, unknown>): ComposeResultView {
  const variants = Array.isArray(result['variants']) ? result['variants'] as Array<Record<string, unknown>> : [];
  const image = result['image'] && typeof result['image'] === 'object' ? result['image'] as ComposeResultView['image'] : null;
  return {
    variants: variants.map((v) => ({
      text: String(v['text'] ?? ''),
      hashtags: Array.isArray(v['hashtags']) ? v['hashtags'].map(String) : [],
      duplicate_of: typeof v['duplicate_of'] === 'string' ? v['duplicate_of'] : null,
    })),
    image,
    warnings: Array.isArray(result['warnings']) ? result['warnings'].map(String) : [],
    simulated: result['simulated'] === true,
  };
}

export interface TelegramUpdateLike {
  update_id?: number;
  message?: { chat?: { id?: number | string }; text?: string };
  /** Pulsación de un botón en línea. */
  callback_query?: { id?: string; data?: string; message?: { message_id?: number | string; chat?: { id?: number | string } } };
}

export interface TelegramUpdateResult {
  /** Código del resultado (nunca texto del chat ni identificadores personales). */
  handled: string;
}

export interface TelegramLinkView {
  linked: boolean;
  linked_at: string | null;
  /** Solo se muestra el final del chat id (sin datos personales completos). */
  chat_hint: string | null;
}

/** Publicaciones de Facebook desde el chat: redacción con IA, borrador, aprobación y programación (mismos servicios del panel). */
export interface TelegramSocialDeps {
  business: Pick<AiBusinessService, 'requestCompose' | 'draftFromCompose'>;
  posts: Pick<SocialService, 'approvePost' | 'schedule' | 'reject'>;
  jobs: Pick<AiJobs, 'get'>;
  /** Nombre de la Página conectada del negocio; null si no hay ninguna. */
  page: (tenantId: string) => Promise<string | null>;
  /** Zona horaria del negocio para programar (SOCIAL_SCHEDULER_TIMEZONE). */
  timezone: string;
}

/** Conversación con MainSpot desde Telegram (pipeline del panel + decisiones de propuestas). */
export interface TelegramConversationDeps {
  pipeline: Pick<ConversationPipeline, 'ingest'>;
  machine: StateMachineDeps;
  lab: Pick<AiLab, 'grantsForUser' | 'check'>;
  /** URL del panel para enlazar la vista previa (`…/panel`). */
  panelUrl: string;
  /** Publicaciones de Facebook pedidas por el chat; ausente = el chat no las ofrece. */
  social?: TelegramSocialDeps;
}

interface LinkedActor { tenant_id: string; user_id: string; role: RoleName | null; lab_grant_id: string | null; tenant_status: string }

type Input =
  | { kind: 'text'; chatId: string; text: string }
  | { kind: 'action'; chatId: string; actionId: string; messageId: string | null; data: string };

/** Pulsación en curso: dónde editar y el aviso breve con que se cierra el botón. */
interface Press { chatId: string; actionId: string; messageId: string | null; notice?: string }

export class TelegramLinkService {
  private readonly pool: Pool;
  private readonly sink: AuditSink;
  private readonly channel: ChannelAdapter;
  private readonly engagement: EngagementService;
  private readonly conversation: TelegramConversationDeps | null;

  constructor(deps: { pool: Pool; sink: AuditSink; channel: ChannelAdapter; engagement: EngagementService; conversation?: TelegramConversationDeps }) {
    this.pool = deps.pool;
    this.sink = deps.sink;
    this.channel = deps.channel;
    this.engagement = deps.engagement;
    this.conversation = deps.conversation ?? null;
  }

  /** Chat vinculado de una persona (para responderle por Telegram); null si no tiene. */
  async chatFor(tenantId: string, userId: string): Promise<string | null> {
    const res = await this.pool.query<{ chat_id: string }>(
      `SELECT chat_id FROM telegram_link WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [tenantId, userId]);
    return res.rows[0]?.chat_id ?? null;
  }

  async status(tenantId: string, userId: string): Promise<TelegramLinkView> {
    const res = await this.pool.query<{ chat_id: string; linked_at: Date }>(
      `SELECT chat_id, linked_at FROM telegram_link WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [tenantId, userId]);
    const row = res.rows[0];
    return row
      ? { linked: true, linked_at: new Date(row.linked_at).toISOString(), chat_hint: `…${row.chat_id.slice(-3)}` }
      : { linked: false, linked_at: null, chat_hint: null };
  }

  /** Código de un solo uso; anula los anteriores sin usar de la misma persona. */
  async createCode(actor: { tenantId: string; userId: string; role: string | null; requestId: string }): Promise<{ code: string; expires_at: string }> {
    const bytes = randomBytes(8);
    const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    const expires = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);
    await this.pool.query(
      `UPDATE telegram_link_code SET used_at = now() WHERE tenant_id = $1 AND user_id = $2 AND used_at IS NULL`,
      [actor.tenantId, actor.userId]);
    await this.pool.query(
      `INSERT INTO telegram_link_code (code_hash, tenant_id, user_id, expires_at) VALUES ($1,$2,$3,$4)`,
      [hashCode(code), actor.tenantId, actor.userId, expires]);
    await this.sink.write({
      tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
      action: 'telegram.link_code.created', resource: 'telegram_link', request_id: actor.requestId,
      decision: 'allow', result: 'created',
    });
    return { code, expires_at: expires.toISOString() };
  }

  async unlink(actor: { tenantId: string; userId: string; role: string | null; requestId: string }): Promise<void> {
    await this.pool.query(
      `UPDATE telegram_link SET status = 'revoked', revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
      [actor.tenantId, actor.userId]);
    await this.sink.write({
      tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
      action: 'telegram.unlinked', resource: 'telegram_link', request_id: actor.requestId,
      decision: 'allow', result: 'revoked',
    });
  }

  private async send(chatId: string, message: OutgoingMessage): Promise<void> {
    await this.channel.send(chatId, message).catch(() => undefined);
  }

  private async reply(chatId: string, text: string): Promise<void> {
    await this.send(chatId, plainMessage(text));
  }

  /** Muestra el resultado de una pulsación en el mismo mensaje (sin botones ya usados); si no se puede, lo envía. */
  private async show(press: Press, message: OutgoingMessage): Promise<void> {
    const edited = press.messageId ? await this.channel.edit(press.chatId, press.messageId, message).catch(() => ({ ok: false })) : { ok: false };
    if (!edited.ok) await this.send(press.chatId, message);
  }

  /**
   * Procesa un Update (mensaje o pulsación de botón). Devuelve un resumen para la respuesta HTTP (sin datos personales).
   *
   * - Un update sin chat, sin texto ni acción se ignora SIN escribir nada (sondas `{}` / `{update_id:0}`).
   * - Con `update_id` entero (webhook real) el update se reclama en `telegram_update` antes de
   *   actuar: la misma entrega repetida devuelve `duplicate` (ya procesada) o `in_progress`
   *   (otro intento la tiene; el webhook responde sin 2xx para que Telegram la reintente luego).
   *   Si el procesamiento falla con error, el reclamo se libera y el reintento lo reprocesa;
   *   decidir y publicar ya son idempotentes por caso/propuesta, así que un reintento nunca decide ni
   *   publica dos veces. NO se garantiza que la respuesta al chat (Bot API) salga exactamente una vez:
   *   si el proceso cae entre enviarla y marcar el update como procesado, el reintento vuelve a responder.
   * - Sin `update_id` (chat simulado del panel) no hay reentregas ni dedupe.
   */
  async handleUpdate(update: TelegramUpdateLike): Promise<TelegramUpdateResult> {
    const input = parseInput(update);
    if (!input) return { handled: 'ignored' };
    const updateId = typeof update.update_id === 'number' && Number.isSafeInteger(update.update_id) && update.update_id >= 0
      ? update.update_id : null;
    if (updateId === null) return this.dispatch(input, `tg_${randomUUID()}`);

    const claimToken = randomUUID();
    const claim = await this.claimUpdate(updateId, claimToken);
    if (claim !== 'claimed') return { handled: claim };
    let result: TelegramUpdateResult;
    try {
      result = await this.dispatch(input, `tg_${updateId}`);
    } catch (err) {
      await this.pool.query(
        `DELETE FROM telegram_update WHERE update_id = $1 AND claim_token = $2 AND status = 'processing'`,
        [updateId, claimToken]).catch(() => undefined);
      throw err;
    }
    await this.pool.query(
      `UPDATE telegram_update SET status = 'done', handled = $3, done_at = now() WHERE update_id = $1 AND claim_token = $2`,
      [updateId, claimToken, result.handled]);
    return result;
  }

  /**
   * Reclama el update para este intento. Inserta la fila o, si otro intento la dejó «en curso»
   * más tiempo que la lease (proceso caído), la toma con un claim_token nuevo; ese token
   * condiciona el cierre y la liberación, así un intento viejo no borra el reclamo de otro.
   */
  private async claimUpdate(updateId: number, claimToken: string): Promise<'claimed' | 'duplicate' | 'in_progress'> {
    const res = await this.pool.query(
      `INSERT INTO telegram_update (update_id, claim_token, status, received_at) VALUES ($1, $2, 'processing', now())
       ON CONFLICT (update_id) DO UPDATE SET claim_token = EXCLUDED.claim_token, received_at = now()
         WHERE telegram_update.status = 'processing' AND telegram_update.received_at < now() - make_interval(secs => $3)
       RETURNING update_id`, [updateId, claimToken, UPDATE_LEASE_SECONDS]);
    if (res.rowCount) return 'claimed';
    const row = await this.pool.query<{ status: string }>('SELECT status FROM telegram_update WHERE update_id = $1', [updateId]);
    return row.rows[0]?.status === 'done' ? 'duplicate' : 'in_progress';
  }

  /** Persona, rol y estado del negocio del chat vinculado (usuario activo); null si el chat no está vinculado. */
  private async linkedActor(chatId: string): Promise<LinkedActor | null> {
    const link = await this.pool.query<{ tenant_id: string; user_id: string; lab_grant_id: string | null; tenant_status: string }>(
      `SELECT l.tenant_id, l.user_id, l.lab_grant_id, c.status AS tenant_status FROM telegram_link l
         JOIN internal_user u ON u.user_id = l.user_id AND u.status = 'active'
         JOIN client c ON c.client_id = l.tenant_id
        WHERE l.chat_id = $1 AND l.status = 'active'`, [chatId]);
    const row = link.rows[0];
    if (!row) return null;
    const roleRes = await this.pool.query<{ role_id: RoleName }>(
      'SELECT role_id FROM user_role WHERE user_id = $1 AND tenant_id = $2', [row.user_id, row.tenant_id]);
    return { ...row, role: roleRes.rows[0]?.role_id ?? null };
  }

  /** RBAC del panel aplicado al chat; el deny queda auditado. */
  private async permitted(actor: LinkedActor, action: ActionName, requestId: string): Promise<boolean> {
    if (actor.role && MATRIX[actor.role].includes(action)) return true;
    await this.sink.write({
      tenant_id: actor.tenant_id, actor_id: actor.user_id, actor_role: actor.role,
      action: 'access.deny', resource: `telegram:${action}`, request_id: requestId, decision: 'deny', result: 'permission_denied',
    }).catch(() => undefined);
    return false;
  }

  /** Ejecuta un mensaje o una pulsación del chat y responde por el canal. */
  private async dispatch(input: Input, requestId: string): Promise<TelegramUpdateResult> {
    if (input.kind === 'action') {
      const press: Press = { chatId: input.chatId, actionId: input.actionId, messageId: input.messageId };
      try {
        return await this.dispatchAction(press, input.data, requestId);
      } finally {
        await this.channel.answerAction(press.actionId, press.notice).catch(() => undefined);
      }
    }
    const { chatId, text } = input;
    const [command = '', ...args] = text.split(/\s+/);
    if (command === '/start' && args[0]) return this.linkChat(chatId, args[0], requestId);

    const linked = await this.linkedActor(chatId);
    if (!linked) {
      await this.send(chatId, unlinkedMessage());
      return { handled: 'unlinked_chat' };
    }
    // Un negocio suspendido o en baja no entra al panel; tampoco decide, publica ni conversa por Telegram.
    if (linked.tenant_status !== 'active') {
      await this.reply(chatId, TENANT_INACTIVE);
      return { handled: 'tenant_inactive' };
    }
    if (command === '/aprobar' || command === '/rechazar') return this.decideByCommand(chatId, linked, command, args, requestId);
    const word = normalized(text);
    if (word === 'start' || word === 'ayuda' || word === 'help' || word === 'menu') {
      await this.send(chatId, helpMessage(await this.labState(linked), { social: this.socialAllowed(linked) }));
      return { handled: 'help' };
    }
    if (LOOSE_DECISION.test(word)) {
      await this.send(chatId, pendingMessage(await this.pendingItems(linked), 'Para decidir, toca el botón del aviso correspondiente.'));
      return { handled: 'pending_listed' };
    }
    if (PENDING_QUERY.test(word)) {
      await this.send(chatId, pendingMessage(await this.pendingItems(linked)));
      return { handled: 'pending_listed' };
    }
    if (!this.conversation) {
      await this.send(chatId, plainMessage('Por ahora aquí te aviso de los casos de tus clientes; decide con los botones de cada aviso o desde tu panel.'));
      return { handled: 'help' };
    }
    try {
      return await this.converse(chatId, linked, text, requestId);
    } catch (err) {
      if (err instanceof AppError) {
        await this.send(chatId, plainMessage(err.userMessage));
        return { handled: err.code };
      }
      throw err;
    }
  }

  /** Pulsación de un botón: chat vinculado, acción válida y luego permiso y estado actual del objeto. */
  private async dispatchAction(press: Press, data: string, requestId: string): Promise<TelegramUpdateResult> {
    const linked = await this.linkedActor(press.chatId);
    if (!linked) {
      press.notice = 'Este chat no está conectado a MainSpot.';
      return { handled: 'unlinked_chat' };
    }
    if (linked.tenant_status !== 'active') {
      press.notice = TENANT_INACTIVE;
      return { handled: 'tenant_inactive' };
    }
    const action = parseAction(data);
    if (!action) {
      press.notice = 'Esta opción ya no está disponible.';
      return { handled: 'invalid_action' };
    }
    try {
      if (action.kind === 'pending') {
        await this.send(press.chatId, pendingMessage(await this.pendingItems(linked)));
        return { handled: 'pending_listed' };
      }
      if (action.kind === 'lab') return await this.labToggle(press, linked, action.on, requestId);
      if (action.kind === 'proposal') return await this.proposalAction(press, linked, action, requestId);
      if (action.kind === 'social') return await this.socialAction(press, linked, action, requestId);
      if (action.kind === 'notice') return await this.noticeAction(press, linked, action, requestId);
      if (action.kind === 'legacy_case') return await this.legacyCaseButton(press, linked, action.id, requestId);
      return await this.caseView(press, linked, action.id, requestId);
    } catch (err) {
      if (err instanceof AppError) {
        press.notice = err.userMessage;
        return { handled: err.code };
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------------------------- cambios web

  /** Dependencias de la conversación (solo se llega aquí si están configuradas). */
  private conv(): TelegramConversationDeps {
    if (!this.conversation) throw new AppError(409, 'validation_error', 'Los cambios de tu página se deciden desde tu panel.');
    return this.conversation;
  }

  private async proposalAction(press: Press, linked: LinkedActor, action: Extract<TelegramAction, { kind: 'proposal' }>, requestId: string): Promise<TelegramUpdateResult> {
    const rule = PROPOSAL_RULES[action.op];
    if (!await this.permitted(linked, rule.permission, requestId)) {
      press.notice = rule.denied;
      return { handled: 'permission_denied' };
    }
    const conv = this.conv();
    const p = await this.ownProposal(linked, action.id);
    if (!p) {
      press.notice = 'No encontré ese cambio.';
      return { handled: 'not_found' };
    }
    const ctx = { panelUrl: conv.panelUrl };
    if (action.op === 'view') {
      await this.send(press.chatId, proposalMessage(p, ctx));
      return { handled: 'proposal_shown' };
    }
    if (!rule.from.includes(p.status)) {
      await this.show(press, proposalMessage(p, ctx));
      press.notice = 'Este cambio ya no está en ese paso.';
      return { handled: 'stale_action' };
    }
    const ref = { tenantId: linked.tenant_id, proposalId: p.proposal_id, actorId: linked.user_id, requestId };
    if (action.op === 'confirm') {
      const prepared = await confirmAndPreparePreview(conv.machine, ref);
      await this.show(press, proposalMessage(prepared.proposal, ctx));
      return { handled: 'confirmed' };
    }
    if (action.op === 'discard') {
      await rejectProposal(conv.machine, ref);
      await this.show(press, proposalMessage(await this.ownProposal(linked, p.proposal_id) ?? p, ctx));
      press.notice = 'Cambio descartado.';
      return { handled: 'discarded' };
    }
    const out = await approveAndPublish(conv.machine, { ...ref, source: 'telegram', actorRole: linked.role });
    await this.show(press, proposalMessage(await this.ownProposal(linked, p.proposal_id) ?? p, ctx));
    press.notice = out.published ? '¡Publicado!' : 'No se pudo publicar; tu página no cambió.';
    return { handled: out.published ? 'published' : 'publish_failed' };
  }

  /** Propuesta web de ESTA persona y negocio (las de otros no existen para el chat). */
  private async ownProposal(linked: LinkedActor, proposalId: string): Promise<ActionProposalRow | null> {
    const r = await this.pool.query<ActionProposalRow>(
      `SELECT * FROM action_proposal WHERE tenant_id = $1 AND created_by = $2 AND capability_target = 'website' AND proposal_id = $3`,
      [linked.tenant_id, linked.user_id, proposalId]);
    return r.rows[0] ?? null;
  }

  // ------------------------------------------------------------------------------ atención (casos)

  private caseContext(): CaseContext {
    return { simulated: this.engagement.replyMode === 'simulated', panelUrl: this.engagement.deps.panelUrl };
  }

  /**
   * `/aprobar <código> <N>` y `/rechazar <código>` (SEC-TG-APPROVAL-01): el código es el de un aviso de ESTE chat y
   * persona. Cualquier otra referencia (el id del caso de los avisos antiguos, un código ajeno) nunca decide; si es un
   * caso pendiente de este negocio, el chat recibe su aviso vigente.
   */
  private async decideByCommand(chatId: string, linked: LinkedActor, command: string, args: string[], requestId: string): Promise<TelegramUpdateResult> {
    const role = linked.role;
    if (!role || !MATRIX[role].includes('engagement.approve')) {
      await this.sink.write({
        tenant_id: linked.tenant_id, actor_id: linked.user_id, actor_role: role,
        action: 'access.deny', resource: 'telegram:engagement', request_id: requestId, decision: 'deny', result: 'permission_denied',
      }).catch(() => undefined);
      await this.reply(chatId, 'Tu perfil no permite aprobar respuestas públicas. Avisamos a la persona administradora.');
      return { handled: 'permission_denied' };
    }
    const actor = { tenantId: linked.tenant_id, userId: linked.user_id, role, requestId };
    const ref = args[0] ?? '';
    const code = parseNoticeCode(ref);
    try {
      if (!code) {
        // Mensajes anteriores a los códigos (`<case_id>`) u otra referencia: nunca se publica ni descarta nada. Si es un
        // caso pendiente de ESTE negocio, se le envía su aviso vigente; la respuesta es la misma en todos los casos.
        await this.sink.write({
          tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: role, action: 'engagement.approval.ref_invalid',
          resource: 'telegram:engagement', request_id: requestId, decision: 'deny', result: 'legacy_or_unknown_reference',
        }).catch(() => undefined);
        await this.reply(chatId, 'Usa el código que trae cada aviso: /aprobar CÓDIGO 1 (o 2, 3) · /rechazar CÓDIGO. Si el caso sigue pendiente, te enviamos su aviso vigente; también puedes resolverlo en tu panel.');
        if (CASE_ID_RE.test(ref)) await this.engagement.sendNoticeTo(actor, chatId, ref);
        return { handled: 'approval_ref_invalid' };
      }
      if (command === '/rechazar') {
        const r = await this.engagement.rejectFromNotice(actor, chatId, code);
        if (!r) {
          await this.reply(chatId, INVALID_NOTICE);
          return { handled: 'approval_ref_invalid' };
        }
        await this.reply(chatId, r.already ? 'Ese caso ya estaba descartado.' : 'Listo: descartamos la respuesta. El caso queda registrado.');
        return { handled: r.already ? 'reject_repeat' : 'rejected' };
      }
      const option = Number(args[1]);
      if (!Number.isInteger(option) || option < 1 || option > 3) {
        await this.reply(chatId, `Indica el número de la opción que quieres publicar: /aprobar ${code} 1 (o 2, 3).`);
        return { handled: 'approval_option_missing' };
      }
      const r = await this.engagement.approveFromNotice(actor, chatId, code, option);
      if (r.kind === 'invalid') {
        await this.reply(chatId, INVALID_NOTICE);
        return { handled: 'approval_ref_invalid' };
      }
      if (r.kind === 'already') {
        await this.reply(chatId, 'Ya habías aprobado este caso. No se publicará dos veces.');
        return { handled: 'approve_repeat' };
      }
      if (r.kind === 'stale') {
        // `used`: ese aviso ya aprobó el caso y la publicación falló o quedó incierta; se decide con el aviso vigente.
        const usedText = r.case.reason === 'delivery_uncertain'
          ? 'Ese aviso ya se usó para aprobar este caso y no pudimos confirmar si la respuesta se publicó. Revisa la reseña antes de decidir; te enviamos el aviso vigente.'
          : 'Ese aviso ya se usó para aprobar este caso y la publicación no salió. Te enviamos el aviso vigente: confirma con su código nuevo.';
        await this.reply(chatId, r.reason === 'used' ? usedText
          : `Las propuestas de ese aviso cambiaron después de enviártelo, así que no publicamos la opción ${option}. Te enviamos el aviso actualizado: revisa las opciones y confirma con su código nuevo.`);
        await this.engagement.sendNoticeTo(actor, chatId, r.case.case_id);
        return { handled: r.reason === 'used' ? 'approval_used' : 'approval_stale' };
      }
      const done = await this.engagement.respondCase(r.case.case_id);
      await this.reply(chatId, done?.state === 'responded'
        ? `Respuesta publicada (${done.delivery_mode === 'simulated' ? 'simulación' : 'proveedor'}).`
        : 'Aprobado. Publicaremos la respuesta en cuanto el proveedor responda; te avisamos si falla.');
      return { handled: 'approved' };
    } catch (err) {
      if (err instanceof AppError) {
        await this.reply(chatId, err.userMessage);
        return { handled: err.code };
      }
      throw err;
    }
  }

  /** «Ver» un caso de la lista de pendientes: si sigue abierto llega su aviso vigente (con código propio); si no, su estado. */
  private async caseView(press: Press, linked: LinkedActor, caseId: string, requestId: string): Promise<TelegramUpdateResult> {
    if (!await this.permitted(linked, 'engagement.read', requestId)) {
      press.notice = 'Tu perfil no permite responder a clientes. Avisamos a quien administra tu negocio.';
      return { handled: 'permission_denied' };
    }
    const c = await this.engagement.getCase(linked.tenant_id, caseId);
    if (!c) {
      press.notice = 'No encontré ese caso.';
      return { handled: 'not_found' };
    }
    const actor = { tenantId: linked.tenant_id, userId: linked.user_id, role: linked.role, requestId };
    if (!await this.engagement.sendNoticeTo(actor, press.chatId, c.case_id)) {
      await this.send(press.chatId, caseResolvedMessage(await this.engagement.getCase(linked.tenant_id, c.case_id) ?? c, this.caseContext()));
    }
    return { handled: 'case_shown' };
  }

  /**
   * Botones de un aviso (SEC-TG-APPROVAL-01): llevan el código del aviso y el número de opción, nunca el id del caso.
   * «Usar la respuesta N» y «Elegir otra» solo muestran la instantánea de ESE aviso mientras siga vigente; «Publicar esta
   * respuesta» es `approveFromNotice` (misma revisión, uso único y auditoría que `/aprobar <código> N`) y «No responder»
   * es `rejectFromNotice`. Un aviso ajeno, obsoleto o ya usado nunca publica: la pulsación explica el estado real, el
   * mensaje pierde sus botones y, si el caso sigue pendiente en este negocio, llega su aviso vigente con otro código.
   */
  private async noticeAction(press: Press, linked: LinkedActor, action: Extract<TelegramAction, { kind: 'notice' }>, requestId: string): Promise<TelegramUpdateResult> {
    if (!await this.permitted(linked, 'engagement.approve', requestId)) {
      press.notice = 'Tu perfil no permite responder a clientes. Avisamos a quien administra tu negocio.';
      return { handled: 'permission_denied' };
    }
    const actor = { tenantId: linked.tenant_id, userId: linked.user_id, role: linked.role, requestId };
    const ctx = this.caseContext();
    const invalid = async (): Promise<TelegramUpdateResult> => {
      await this.show(press, plainMessage('Este aviso ya no sirve para decidir.'));
      press.notice = 'Ese botón no corresponde a un aviso vigente de este chat.';
      return { handled: 'approval_ref_invalid' };
    };
    const resolved = async (c: CaseRow): Promise<TelegramUpdateResult> => {
      await this.show(press, caseResolvedMessage(c, ctx));
      press.notice = 'Este caso ya no necesita tu decisión.';
      return { handled: 'stale_action' };
    };
    const stale = async (c: CaseRow, reason: 'changed' | 'used'): Promise<TelegramUpdateResult> => {
      const resent = await this.engagement.sendNoticeTo(actor, press.chatId, c.case_id);
      const why = reason === 'changed' ? 'Las propuestas de este aviso cambiaron después de enviártelo, así que no publiqué nada.'
        : c.reason === 'delivery_uncertain' ? 'Este aviso ya se usó para aprobar el caso y no pudimos confirmar si la respuesta se publicó: revisa la reseña antes de decidir.'
          : 'Este aviso ya se usó para aprobar el caso y la publicación no salió.';
      await this.show(press, plainMessage(resent ? `${why} Te envié el aviso vigente con su código nuevo.` : why));
      press.notice = reason === 'changed' ? 'Las propuestas cambiaron: no se publicó nada.' : 'Ese aviso ya se usó: no se publicó nada.';
      return { handled: reason === 'changed' ? 'approval_stale' : 'approval_used' };
    };
    // Un caso resuelto por otro camino rechaza la decisión con 409: se muestra cómo quedó.
    const closed = async (err: unknown): Promise<TelegramUpdateResult> => {
      if (!(err instanceof AppError) || err.status !== 409) throw err;
      const found = await this.engagement.noticeFor(actor, press.chatId, action.code);
      return found ? resolved(found.case) : invalid();
    };

    if (action.op === 'approve') {
      let r: NoticeApproval;
      try {
        r = await this.engagement.approveFromNotice(actor, press.chatId, action.code, action.option);
      } catch (err) {
        return closed(err);
      }
      if (r.kind === 'invalid') return invalid();
      if (r.kind === 'stale') return stale(r.case, r.reason);
      if (r.kind === 'already') {
        await this.show(press, caseResolvedMessage(r.case, ctx));
        press.notice = 'Ya habías aprobado este caso; no se publica dos veces.';
        return { handled: 'approve_repeat' };
      }
      const done = await this.engagement.respondCase(r.case.case_id);
      await this.show(press, caseResolvedMessage(done ?? r.case, ctx));
      press.notice = done?.state === 'responded' ? 'Respuesta publicada.' : 'Aprobada; la publicaremos en cuanto se pueda.';
      return { handled: 'approved' };
    }
    if (action.op === 'reject') {
      let r: { case: CaseRow; already: boolean } | null;
      try {
        r = await this.engagement.rejectFromNotice(actor, press.chatId, action.code);
      } catch (err) {
        return closed(err);
      }
      if (!r) return invalid();
      await this.show(press, caseResolvedMessage(r.case, ctx));
      press.notice = r.already ? 'Ese caso ya estaba cerrado sin respuesta.' : 'Listo: no se responderá.';
      return { handled: r.already ? 'reject_repeat' : 'rejected' };
    }
    // Elegir y volver no deciden: muestran la instantánea de ESTE aviso solo mientras sea la vigente del caso.
    const found = await this.engagement.noticeFor(actor, press.chatId, action.code);
    if (!found) return invalid();
    const { offer, case: c } = found;
    if (c.state !== 'needs_human' && c.state !== 'failed') return resolved(c);
    if (offer.status !== 'active' || offer.drafts_revision !== c.drafts_revision) return stale(c, offer.status === 'used' ? 'used' : 'changed');
    if (action.op === 'back') {
      await this.show(press, noticeMessage(c, this.engagement.notificationText(c, { code: offer.code, options: offer.options, updated: found.updated }), offer, ctx));
      return { handled: 'case_shown' };
    }
    const shown = offer.options[action.option - 1];
    if (!shown?.trim()) {
      press.notice = `Ese aviso no tiene una opción ${action.option}.`;
      return { handled: 'validation_error' };
    }
    await this.show(press, noticeConfirmMessage(c, { code: offer.code, option: action.option, text: shown }, ctx));
    return { handled: 'draft_selected' };
  }

  /**
   * Botón con el id del caso, de los mensajes anteriores a los avisos con código: nunca decide (SEC-TG-APPROVAL-01).
   * Igual que `/aprobar <case_id>`: queda auditado, el mensaje pierde sus botones y, si el caso sigue pendiente en ESTE
   * negocio, el chat recibe su aviso vigente; si ya se resolvió, se muestra cómo quedó.
   */
  private async legacyCaseButton(press: Press, linked: LinkedActor, caseId: string, requestId: string): Promise<TelegramUpdateResult> {
    if (!await this.permitted(linked, 'engagement.approve', requestId)) {
      press.notice = 'Tu perfil no permite responder a clientes. Avisamos a quien administra tu negocio.';
      return { handled: 'permission_denied' };
    }
    const actor = { tenantId: linked.tenant_id, userId: linked.user_id, role: linked.role, requestId };
    await this.sink.write({
      tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role, action: 'engagement.approval.ref_invalid',
      resource: 'telegram:engagement', request_id: requestId, decision: 'deny', result: 'legacy_button',
    }).catch(() => undefined);
    const resent = await this.engagement.sendNoticeTo(actor, press.chatId, caseId);
    const resolved = resent ? null : await this.engagement.getCase(linked.tenant_id, caseId);
    await this.show(press, resolved ? caseResolvedMessage(resolved, this.caseContext())
      : plainMessage(`Este aviso ya no sirve para decidir.${resent ? ' Te envié el aviso vigente del caso.' : ''}`));
    press.notice = resent ? 'Ese botón es de un aviso anterior: te envié el aviso vigente.' : resolved ? 'Este caso ya no necesita tu decisión.' : 'Ese botón ya no sirve.';
    return { handled: 'approval_ref_invalid' };
  }

  // ------------------------------------------------------------------------------------- pendientes

  /** Cambios web de la persona y casos del negocio que esperan su decisión. */
  private async pendingItems(linked: LinkedActor): Promise<PendingItem[]> {
    const items: PendingItem[] = [];
    if (linked.role && MATRIX[linked.role].includes('conversation.confirm')) {
      const proposals = await this.pool.query<ActionProposalRow>(
        `SELECT * FROM action_proposal WHERE tenant_id = $1 AND created_by = $2 AND capability_target = 'website'
            AND status IN ('awaiting_confirmation','preview_ready') ORDER BY created_at DESC LIMIT 5`, [linked.tenant_id, linked.user_id]);
      items.push(...proposals.rows.map(pendingProposalItem));
    }
    if (linked.role && MATRIX[linked.role].includes('engagement.approve')) {
      const cases = await this.pool.query<CaseRow>(
        `SELECT * FROM engagement_case WHERE tenant_id = $1 AND state IN ('needs_human','failed') ORDER BY created_at DESC LIMIT 5`, [linked.tenant_id]);
      items.push(...cases.rows.map(pendingCaseItem));
    }
    return items;
  }

  // ---------------------------------------------------------------------------------- conversación

  /** Mensaje libre: mismo pipeline que el panel (cuota, Jev, edición determinista o con IA, auditoría). */
  private async converse(chatId: string, linked: LinkedActor, text: string, requestId: string): Promise<TelegramUpdateResult> {
    if (!await this.permitted(linked, 'conversation.send', requestId)) {
      await this.send(chatId, plainMessage('Tu perfil puede recibir avisos, pero no pedir cambios. Pídele ayuda a quien administra tu negocio.'));
      return { handled: 'permission_denied' };
    }
    let outcome: IngestOutcome;
    try {
      outcome = await this.conv().pipeline.ingest({
        tenantId: linked.tenant_id, actorId: linked.user_id, actorRole: linked.role, channel: 'telegram',
        text: text.slice(0, 2000), requestId, idempotencyKey: requestId, labGrantId: linked.lab_grant_id,
      });
    } catch (err) {
      // Autorización de laboratorio que ya no vale: se deja de usar (sin reintentar sin ella) y se explica.
      if (err instanceof AppError && err.code === 'permission_denied' && linked.lab_grant_id) {
        await this.pool.query(`UPDATE telegram_link SET lab_grant_id = NULL WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [linked.tenant_id, linked.user_id]);
        const lab = await this.labState({ ...linked, lab_grant_id: null });
        await this.send(chatId, labInvalidMessage(err.userMessage, lab.available));
        return { handled: 'lab_grant_invalid' };
      }
      throw err;
    }
    await this.send(chatId, await this.outcomeMessage(linked, outcome));
    return { handled: outcome.aiJob ? 'ai_edit_started' : `conversation:${outcome.requestStatus}` };
  }

  /**
   * Respuesta en el chat al resultado del pipeline: un cambio para confirmar llega como tarjeta con botones; lo que
   * no se entendió muestra debajo los pendientes; el resto es texto.
   */
  private async outcomeMessage(linked: LinkedActor, outcome: IngestOutcome): Promise<OutgoingMessage> {
    if (outcome.aiJob) {
      const models = outcome.aiJob.lab ? outcome.aiJob.routes.map((r) => r.model_id.replace(/^[a-z]+:/, '')) : [];
      return aiEditStartedMessage(models);
    }
    if (outcome.proposalId) {
      const p = await this.ownProposal(linked, outcome.proposalId);
      if (p) return proposalMessage(p, { panelUrl: this.conv().panelUrl });
    }
    // Pedir una publicación de redes no es algo que el asistente haga solo: se ofrece prepararla con un botón (la
    // pulsación es la confirmación); sin ese canal habilitado queda la explicación del pipeline.
    if (outcome.intent === 'capability.unsupported' && outcome.capabilityTarget === 'social' && this.socialAllowed(linked)) {
      return socialOfferMessage(outcome.requestId, await this.socialContext(linked));
    }
    if (outcome.requestStatus === 'needs_clarification') return answerWithPending(outcome.responseText, await this.pendingItems(linked));
    return plainMessage(outcome.responseText);
  }

  /**
   * Respuesta en Telegram a un mensaje que la persona envió desde otra superficie marcado como de Telegram
   * (`POST /conversation/messages` con canal `telegram`): mismo formato que el chat. false si no tiene chat.
   */
  async deliverOutcome(tenantId: string, userId: string, outcome: IngestOutcome): Promise<boolean> {
    const chatId = await this.chatFor(tenantId, userId);
    const linked = chatId ? await this.linkedActor(chatId) : null;
    if (!chatId || !linked || !this.conversation) return false;
    const sent = await this.channel.send(chatId, await this.outcomeMessage(linked, outcome)).catch(() => ({ ok: false }));
    return sent.ok;
  }

  // ------------------------------------------------------------------------------------ laboratorio

  /** ¿Tiene la persona una autorización de laboratorio vigente, y la está usando en el chat? */
  private async labState(linked: LinkedActor): Promise<LabState> {
    if (!this.conversation) return { available: false, active: false };
    const grant = (await this.conversation.lab.grantsForUser(linked.tenant_id, linked.user_id))[0];
    const ok = grant ? (await this.conversation.lab.check({ grantId: grant.grant_id, tenantId: linked.tenant_id, userId: linked.user_id })).ok : false;
    return { available: ok, active: ok && linked.lab_grant_id === grant?.grant_id };
  }

  /** Usar la autorización de laboratorio vigente más reciente de la persona, o dejarla. */
  private async labToggle(press: Press, linked: LinkedActor, on: boolean, requestId: string): Promise<TelegramUpdateResult> {
    const lab = this.conv().lab;
    if (!on) {
      await this.pool.query(`UPDATE telegram_link SET lab_grant_id = NULL WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [linked.tenant_id, linked.user_id]);
      await this.show(press, labOffMessage());
      return { handled: 'lab_off' };
    }
    const grant = (await lab.grantsForUser(linked.tenant_id, linked.user_id))[0];
    const check = grant ? await lab.check({ grantId: grant.grant_id, tenantId: linked.tenant_id, userId: linked.user_id }) : null;
    if (!grant || !check?.ok) {
      await this.show(press, labNoneMessage());
      return { handled: 'lab_none' };
    }
    await this.pool.query(`UPDATE telegram_link SET lab_grant_id = $3 WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`, [linked.tenant_id, linked.user_id, grant.grant_id]);
    await this.sink.write({
      tenant_id: linked.tenant_id, actor_id: linked.user_id, actor_role: linked.role,
      action: 'telegram.lab_grant.selected', resource: `ai_lab_grant/${grant.grant_id}`, request_id: requestId, decision: 'allow', result: 'selected',
    });
    const models = [...new Set(grant.routes.filter((r) => r.modality !== 'classification').map((r) => r.model_id.replace(/^[a-z]+:/, '')))];
    await this.show(press, labOnMessage(new Date(grant.expires_at).toISOString().slice(11, 16), models));
    return { handled: 'lab_on' };
  }

  // ----------------------------------------------------------------------------- avisos de la IA

  /**
   * Fin de un job de IA pedido desde Telegram (edición de la web o propuestas de publicación): avisa en el chat de quien
   * lo pidió con su tarjeta (vista previa o variantes con botones), la pregunta de aclaración o el motivo del fallo.
   * Los pedidos desde el panel no se reenvían.
   */
  async notifyAiJob(job: AiJobRow): Promise<void> {
    const social = job.kind === 'social.compose';
    if (!this.conversation || (job.kind !== 'website.edit' && job.kind !== 'website.design' && !social)) return;
    const requestId = job.input['conversation_request_id'];
    if (typeof requestId !== 'string') return;
    const req = await this.pool.query<{ channel: string; actor_id: string; proposal_id: string | null }>(
      'SELECT channel, actor_id, proposal_id FROM conversation_request WHERE tenant_id = $1 AND request_id = $2', [job.tenant_id, requestId]);
    const row = req.rows[0];
    if (!row || row.channel !== 'telegram' || row.actor_id !== job.created_by) return;
    const chatId = await this.chatFor(job.tenant_id, row.actor_id);
    const linked = chatId ? await this.linkedActor(chatId) : null;
    if (!chatId || !linked) return;
    const result = job.result ?? {};
    let message: OutgoingMessage;
    if (job.status === 'failed') {
      const code = job.error_code ?? '';
      const reason = typeof job.progress['image_reason'] === 'string' ? ` (${job.progress['image_reason']})` : '';
      if (code === 'no_active_route' || code === 'lab_grant_invalid') {
        message = labInvalidMessage(AI_JOB_FAILURE[code] ?? '', (await this.labState({ ...linked, lab_grant_id: null })).available);
      } else if (social) {
        message = plainMessage(AI_JOB_FAILURE[code] ?? `No pude preparar las propuestas de publicación (${code}). No se publicó nada.`);
      } else {
        message = plainMessage(code.startsWith('image_') && code !== 'image_not_in_library'
          ? `No pude obtener la imagen${reason || ` (${code.slice(6)})`}. No preparé ninguna propuesta: puedes subir una foto a tu biblioteca en el panel y pedirme que la use.`
          : AI_JOB_FAILURE[code] ?? `No se pudo preparar el cambio (${code}). Tu página no cambió.`);
      }
    } else if (social) {
      message = socialVariantsMessage(job.job_id, composeView(result), await this.socialContext(linked));
    } else if (row.proposal_id) {
      const p = await this.ownProposal(linked, row.proposal_id);
      message = p ? proposalMessage(p, { panelUrl: this.conversation.panelUrl }) : plainMessage('La propuesta está lista en tu panel.');
    } else if (result['status'] === 'needs_clarification') {
      message = plainMessage(typeof result['question'] === 'string' ? result['question'] : '¿Puedes describir el cambio con más detalle?');
    } else {
      message = plainMessage(typeof result['message'] === 'string' ? result['message'] : 'No preparé ningún cambio.');
    }
    await this.send(chatId, message);
  }

  // ------------------------------------------------------------------------- publicaciones de Facebook

  /** ¿El chat puede ofrecer publicaciones? Canal habilitado y rol que redacta con IA y crea publicaciones. */
  private socialAllowed(linked: LinkedActor): boolean {
    return !!this.conversation?.social && !!linked.role && MATRIX[linked.role].includes('social.create') && MATRIX[linked.role].includes('ai.generate');
  }

  private async socialContext(linked: LinkedActor): Promise<SocialContext> {
    const social = this.conversation?.social;
    return { pageName: social ? await social.page(linked.tenant_id) : null };
  }

  /** Franja sugerida por la redacción con IA para esta publicación (próxima ocurrencia en la zona del negocio). */
  private async suggestedSlot(social: TelegramSocialDeps, post: SocialPostRow): Promise<{ local: string; label: string } | null> {
    const g = await this.pool.query<{ job_id: string | null }>(`SELECT generation->>'job_id' AS job_id FROM social_post WHERE tenant_id = $1 AND post_id = $2`, [post.tenant_id, post.post_id]);
    const jobId = g.rows[0]?.job_id;
    const job = jobId ? await social.jobs.get(post.tenant_id, jobId) : null;
    const slot = job?.result?.['suggested_slot'] as { weekday?: unknown; hour?: unknown } | null | undefined;
    if (!slot || typeof slot.weekday !== 'string' || typeof slot.hour !== 'number') return null;
    return nextWeeklySlot(slot.weekday, slot.hour, social.timezone);
  }

  /** Tarjeta de la publicación con lo que se puede decidir ahora (o lo que ya pasó). */
  private async postCard(social: TelegramSocialDeps, linked: LinkedActor, post: SocialPostRow): Promise<OutgoingMessage> {
    const ctx = await this.socialContext(linked);
    const slot = post.status === 'draft' ? await this.suggestedSlot(social, post) : null;
    const future = post.scheduled_at && new Date(post.scheduled_at).getTime() > Date.now() + 60_000 ? new Date(post.scheduled_at) : null;
    return socialPostMessage(post, { ...ctx, slot, scheduledLabel: future ? labelInZone(future, social.timezone) : null });
  }

  /** Publicación de ESTA persona y negocio (las demás no existen para el chat). */
  private async ownPost(linked: LinkedActor, postId: string): Promise<SocialPostRow | null> {
    const r = await this.pool.query<SocialPostRow>('SELECT * FROM social_post WHERE tenant_id = $1 AND post_id = $2 AND created_by = $3', [linked.tenant_id, postId, linked.user_id]);
    return r.rows[0] ?? null;
  }

  /**
   * Botones de una publicación: ofrecer → redactar con IA (job) → elegir variante (borrador con cuota) → publicar ahora,
   * programar en la franja sugerida o descartar. Publicar sigue la misma aprobación del panel (aprobar la publicación,
   * confirmar y aprobar la propuesta) con los permisos del rol; la salida a Facebook la hace el programador. Elegir una
   * variante crea como mucho UN borrador por tarjeta de propuestas (clave de cuota por job: repetir o pulsar otra
   * variante devuelve el mismo borrador sin consumir otra vez); publicar o programar solo actúa si la publicación sigue
   * siendo exactamente la que mostró la tarjeta (`postShownRef`).
   */
  private async socialAction(press: Press, linked: LinkedActor, action: Extract<TelegramAction, { kind: 'social' }>, requestId: string): Promise<TelegramUpdateResult> {
    const social = this.conversation?.social;
    if (!social || !this.socialAllowed(linked)) {
      press.notice = 'Las publicaciones de Facebook se preparan desde tu panel.';
      return { handled: 'social_unavailable' };
    }
    const actor = { tenantId: linked.tenant_id, userId: linked.user_id, role: linked.role, requestId, permissions: linked.role ? MATRIX[linked.role] : [], labGrantId: linked.lab_grant_id };
    if (action.op === 'hint') {
      await this.send(press.chatId, socialHintMessage());
      return { handled: 'social_hint' };
    }
    if (action.op === 'decline' || action.op === 'drop') {
      await this.show(press, action.op === 'decline' ? socialDeclinedMessage() : socialDroppedMessage());
      return { handled: action.op === 'decline' ? 'social_declined' : 'social_dropped' };
    }
    if (action.op === 'offer') {
      const req = await this.pool.query<{ request_id: string; raw_message: string }>(
        `SELECT request_id, raw_message FROM conversation_request WHERE tenant_id = $1 AND request_id = $2 AND actor_id = $3 AND channel = 'telegram' AND capability_target = 'social'`,
        [linked.tenant_id, action.id, linked.user_id]);
      const row = req.rows[0];
      if (!row) {
        press.notice = 'No encontré ese mensaje.';
        return { handled: 'not_found' };
      }
      const { job, created } = await social.business.requestCompose(actor, { request: row.raw_message, with_image: action.image, conversation_request_id: row.request_id }, `tg:${row.request_id}:${action.image ? 'img' : 'txt'}`);
      await this.show(press, socialComposingMessage(action.image, []));
      return { handled: created ? 'social_compose_started' : `social_compose_${job.status}` };
    }
    if (action.op === 'pick') {
      const job = await social.jobs.get(linked.tenant_id, action.id);
      if (!job || job.kind !== 'social.compose' || job.created_by !== linked.user_id) {
        press.notice = 'No encontré esas propuestas.';
        return { handled: 'not_found' };
      }
      const out = await social.business.draftFromCompose(actor, job.job_id, action.variant, null, true, `compose:${job.job_id}:telegram`);
      // La tarjeta se arma con la fila guardada (incluida la imagen que se adjunta tras crear el borrador).
      await this.show(press, await this.postCard(social, linked, await this.ownPost(linked, out.post.post_id) ?? out.post));
      return { handled: out.replayed ? 'social_draft_repeat' : 'social_draft_created' };
    }
    const post = await this.ownPost(linked, action.id);
    if (!post) {
      press.notice = 'No encontré esa publicación.';
      return { handled: 'not_found' };
    }
    const needs: ActionName[] = action.op === 'discard' ? ['social.schedule']
      : ['social.approve', 'conversation.confirm', 'operation.approve', ...(action.op === 'schedule' ? ['social.schedule' as const] : [])];
    for (const permission of needs) {
      if (!await this.permitted(linked, permission, requestId)) {
        press.notice = action.op === 'discard' ? 'Tu perfil no permite descartar publicaciones.' : 'Tu perfil no permite publicar en Facebook. Quien administra tu negocio decide si se publica.';
        return { handled: 'permission_denied' };
      }
    }
    if (action.op === 'discard') {
      if (post.status !== 'draft' && post.status !== 'awaiting_approval') {
        await this.show(press, await this.postCard(social, linked, post));
        press.notice = 'Esta publicación ya no puede descartarse.';
        return { handled: 'stale_action' };
      }
      const rejected = await social.posts.reject(linked.tenant_id, linked.user_id, requestId, post.post_id);
      await this.show(press, await this.postCard(social, linked, rejected));
      press.notice = 'Publicación descartada.';
      return { handled: 'social_discarded' };
    }
    if (post.status !== 'draft') {
      await this.show(press, await this.postCard(social, linked, post));
      press.notice = 'Esta publicación ya no está en borrador.';
      return { handled: 'stale_action' };
    }
    const slot = action.op === 'schedule' ? await this.suggestedSlot(social, post) : null;
    if (action.op === 'schedule' && !slot) {
      press.notice = 'No hay una hora sugerida para programarla; publícala ahora o prográmala desde tu panel.';
      return { handled: 'social_no_slot' };
    }
    // Solo lo que mostró la tarjeta: mismo texto, imagen y Página y, al programar, la misma hora sugerida.
    if (action.ref !== postShownRef(post, (await this.socialContext(linked)).pageName, slot?.local ?? null)) {
      await this.show(press, await this.postCard(social, linked, post));
      press.notice = 'La publicación cambió desde que te la mostré: revisa la tarjeta actualizada antes de decidir.';
      return { handled: 'social_stale' };
    }
    if (slot) await social.posts.schedule(linked.tenant_id, linked.user_id, requestId, post.post_id, { local: slot.local });
    const { proposalId } = await social.posts.approvePost(linked.tenant_id, linked.user_id, requestId, post.post_id);
    const ref = { tenantId: linked.tenant_id, proposalId, actorId: linked.user_id, requestId };
    await confirmAndPreparePreview(this.conv().machine, ref);
    const out = await approveAndPublish(this.conv().machine, { ...ref, source: 'telegram', actorRole: linked.role });
    const now = await this.ownPost(linked, post.post_id) ?? post;
    await this.show(press, await this.postCard(social, linked, now));
    if (!out.published) {
      press.notice = 'No se pudo enviar a Facebook; no se publicó nada.';
      return { handled: 'social_publish_failed' };
    }
    press.notice = now.status === 'published' ? 'Publicado en Facebook.' : action.op === 'schedule' ? 'Programada. Te aviso cuando se publique.' : 'Enviada a Facebook. Te aviso cuando la confirme.';
    return { handled: now.status === 'published' ? 'social_published' : action.op === 'schedule' ? 'social_scheduled' : 'social_queued' };
  }

  /**
   * Resultado final del programador (publicada o fallida): avisa a quien la aprobó desde Telegram, con su enlace. Las
   * aprobadas en el panel no se reenvían al chat.
   */
  async notifySocialOutcome(outcome: SocialOutcome): Promise<void> {
    const social = this.conversation?.social;
    if (!social) return;
    const r = await this.pool.query<SocialPostRow & { approver: string }>(
      `SELECT p.*, pub.published_by AS approver FROM social_post p
         JOIN publication pub ON pub.proposal_id = p.proposal_id AND pub.tenant_id = p.tenant_id AND pub.source = 'telegram'
        WHERE p.tenant_id = $1 AND p.post_id = $2 ORDER BY pub.published_at DESC LIMIT 1`, [outcome.tenantId, outcome.postId]);
    const post = r.rows[0];
    if (!post) return;
    const chatId = await this.chatFor(outcome.tenantId, post.approver);
    const linked = chatId ? await this.linkedActor(chatId) : null;
    if (!chatId || !linked) return;
    await this.send(chatId, await this.postCard(social, linked, post));
  }

  // --------------------------------------------------------------------------------------- vínculo

  private async linkChat(chatId: string, code: string, requestId: string): Promise<TelegramUpdateResult> {
    const res = await this.pool.query<{ tenant_id: string; user_id: string }>(
      `UPDATE telegram_link_code SET used_at = now()
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING tenant_id, user_id`, [hashCode(code)]);
    const row = res.rows[0];
    if (!row) {
      await this.send(chatId, invalidCodeMessage());
      return { handled: 'invalid_code' };
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // El chat deja cualquier vínculo previo (un chat = una persona activa).
      await client.query(`UPDATE telegram_link SET status = 'revoked', revoked_at = now() WHERE chat_id = $1 AND status = 'active'`, [chatId]);
      await client.query(
        `INSERT INTO telegram_link (tenant_id, user_id, chat_id, status, linked_at) VALUES ($1,$2,$3,'active', now())
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, status = 'active', linked_at = now(), revoked_at = NULL`,
        [row.tenant_id, row.user_id, chatId]);
      await this.sink.write({
        tenant_id: row.tenant_id, actor_id: row.user_id, actor_role: null,
        action: 'telegram.linked', resource: 'telegram_link', request_id: requestId, decision: 'allow', result: 'linked',
      }, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    await this.send(chatId, linkedMessage());
    return { handled: 'linked' };
  }
}

/** Qué permiso exige cada botón de un cambio web y desde qué estados actúa. */
const PROPOSAL_RULES: Record<'confirm' | 'publish' | 'discard' | 'view', { permission: ActionName; from: string[]; denied: string }> = {
  confirm: { permission: 'conversation.confirm', from: ['awaiting_confirmation'], denied: 'Tu perfil no permite preparar cambios.' },
  publish: { permission: 'operation.approve', from: ['preview_ready'], denied: 'Tu perfil no permite publicar cambios. Quien administra tu negocio decide si se publica.' },
  discard: { permission: 'operation.reject', from: ['awaiting_confirmation', 'preview_ready'], denied: 'Tu perfil no permite descartar cambios.' },
  view: { permission: 'conversation.read', from: [], denied: 'Tu perfil no permite ver cambios.' },
};

function idOf(raw: unknown): string | null {
  return typeof raw === 'number' || (typeof raw === 'string' && raw !== '') ? String(raw) : null;
}

/** Mensaje de texto o pulsación de botón; null para todo lo demás (sondas, otros tipos de update). */
function parseInput(update: TelegramUpdateLike): Input | null {
  const cb = update.callback_query;
  if (cb) {
    const chatId = idOf(cb.message?.chat?.id);
    if (!chatId || typeof cb.id !== 'string' || !cb.id || typeof cb.data !== 'string' || !cb.data) return null;
    return { kind: 'action', chatId, actionId: cb.id, messageId: idOf(cb.message?.message_id), data: cb.data };
  }
  const chatId = idOf(update.message?.chat?.id);
  const text = (update.message?.text ?? '').trim();
  if (!chatId || !text) return null;
  return { kind: 'text', chatId, text };
}
