/**
 * Telegram como canal de avisos y decisiones (DEV-E2E-02, SHARED-CONTRACT §B).
 *
 * - Vínculo: la persona genera un código de un solo uso (10 min) en el panel y lo envía al bot
 *   con `/start CÓDIGO`. El chat queda ligado a ESA persona y tenant. Nunca se usa el teléfono
 *   público del negocio como destino.
 * - Decisiones: `/aprobar <case_id> <1-3>` y `/rechazar <case_id>` llaman al MISMO servicio que el
 *   panel (mismo caso, misma resolución, mismos permisos RBAC). Un chat no vinculado no cambia
 *   nada. El webhook acepta la forma de un Update de Telegram (real o simulado).
 * - Reentregas: un Update con `update_id` se reclama en `telegram_update` antes de actuar, así la
 *   misma entrega repetida o concurrente no responde ni decide dos veces (ver handleUpdate).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import type { ChannelAdapter } from '../channels/types.ts';
import type { RoleName } from '../identity/entities.ts';
import { MATRIX, type ActionName } from '../rbac/matrix.ts';
import { AppError } from '../shared/errors.ts';
import type { EngagementService } from './service.ts';

export const LINK_CODE_TTL_MINUTES = 10;
/** Segundos tras los que un update «en curso» se da por abandonado (proceso caído) y puede reclamarse de nuevo. */
export const UPDATE_LEASE_SECONDS = 120;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function hashCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

export interface TelegramUpdateLike {
  update_id?: number;
  message?: { chat?: { id?: number | string }; text?: string };
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

export class TelegramLinkService {
  private readonly pool: Pool;
  private readonly sink: AuditSink;
  private readonly channel: ChannelAdapter;
  private readonly engagement: EngagementService;

  constructor(deps: { pool: Pool; sink: AuditSink; channel: ChannelAdapter; engagement: EngagementService }) {
    this.pool = deps.pool;
    this.sink = deps.sink;
    this.channel = deps.channel;
    this.engagement = deps.engagement;
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

  private async reply(chatId: string, text: string): Promise<void> {
    await this.channel.sendMessage(chatId, text).catch(() => undefined);
  }

  /**
   * Procesa un Update. Devuelve un resumen para la respuesta HTTP (sin datos personales).
   *
   * - Un update sin chat o sin texto se ignora SIN escribir nada (sondas `{}` / `{update_id:0}`).
   * - Con `update_id` entero (webhook real) el update se reclama en `telegram_update` antes de
   *   actuar: la misma entrega repetida devuelve `duplicate` (ya procesada) o `in_progress`
   *   (otro intento la tiene; el webhook responde sin 2xx para que Telegram la reintente luego).
   *   Si el procesamiento falla con error, el reclamo se libera y el reintento lo reprocesa;
   *   decidir y publicar ya son idempotentes por caso (approve/reject/respondCase, código de un
   *   solo uso), así que un reintento nunca decide ni publica dos veces. NO se garantiza que la
   *   respuesta al chat (Bot API) salga exactamente una vez: si el proceso cae entre enviarla y
   *   marcar el update como procesado, el reintento vuelve a responder.
   * - Sin `update_id` (chat simulado del panel) no hay reentregas ni dedupe.
   */
  async handleUpdate(update: TelegramUpdateLike): Promise<TelegramUpdateResult> {
    const chatRaw = update.message?.chat?.id;
    const text = (update.message?.text ?? '').trim();
    if ((typeof chatRaw !== 'number' && typeof chatRaw !== 'string') || !text) return { handled: 'ignored' };
    const chatId = String(chatRaw);
    const updateId = typeof update.update_id === 'number' && Number.isSafeInteger(update.update_id) && update.update_id >= 0
      ? update.update_id : null;
    if (updateId === null) return this.dispatch(chatId, text, `tg_${randomUUID()}`);

    const claimToken = randomUUID();
    const claim = await this.claimUpdate(updateId, claimToken);
    if (claim !== 'claimed') return { handled: claim };
    let result: TelegramUpdateResult;
    try {
      result = await this.dispatch(chatId, text, `tg_${updateId}`);
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

  /** Ejecuta el comando del chat (vínculo, ayuda o decisión) y responde por el canal. */
  private async dispatch(chatId: string, text: string, requestId: string): Promise<TelegramUpdateResult> {
    const [command, ...args] = text.split(/\s+/);

    if (command === '/start' && args[0]) return this.linkChat(chatId, args[0], requestId);

    const link = await this.pool.query<{ tenant_id: string; user_id: string }>(
      `SELECT l.tenant_id, l.user_id FROM telegram_link l
         JOIN internal_user u ON u.user_id = l.user_id AND u.status = 'active'
        WHERE l.chat_id = $1 AND l.status = 'active'`, [chatId]);
    const linked = link.rows[0];
    if (!linked) {
      await this.reply(chatId, 'Este chat no está vinculado a MainSpot. En tu panel elige «Conectar Telegram» y envía aquí /start con el código.');
      return { handled: 'unlinked_chat' };
    }
    if (command !== '/aprobar' && command !== '/rechazar') {
      await this.reply(chatId, 'Comandos disponibles: /aprobar <caso> <1-3> · /rechazar <caso>. También puedes resolver los casos en tu panel.');
      return { handled: 'help' };
    }
    const roleRes = await this.pool.query<{ role_id: RoleName }>(
      'SELECT role_id FROM user_role WHERE user_id = $1 AND tenant_id = $2', [linked.user_id, linked.tenant_id]);
    const role = roleRes.rows[0]?.role_id ?? null;
    const needed: ActionName = 'engagement.approve';
    if (!role || !MATRIX[role].includes(needed)) {
      await this.sink.write({
        tenant_id: linked.tenant_id, actor_id: linked.user_id, actor_role: role,
        action: 'access.deny', resource: 'telegram:engagement', request_id: requestId, decision: 'deny', result: 'permission_denied',
      }).catch(() => undefined);
      await this.reply(chatId, 'Tu perfil no permite aprobar respuestas públicas. Avisamos a la persona administradora.');
      return { handled: 'permission_denied' };
    }
    const actor = { tenantId: linked.tenant_id, userId: linked.user_id, role, requestId };
    const caseId = args[0] ?? '';
    try {
      if (command === '/rechazar') {
        const r = await this.engagement.reject(actor, caseId, 'telegram');
        await this.reply(chatId, r.already ? 'Ese caso ya estaba descartado.' : 'Listo: descartamos la respuesta. El caso queda registrado.');
        return { handled: r.already ? 'reject_repeat' : 'rejected' };
      }
      const index = Number(args[1] ?? '1') - 1;
      const r = await this.engagement.approve(actor, caseId, { draft_index: index }, 'telegram');
      if (r.already) {
        await this.reply(chatId, 'Ya habías aprobado este caso. No se publicará dos veces.');
        return { handled: 'approve_repeat' };
      }
      const done = await this.engagement.respondCase(caseId);
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

  private async linkChat(chatId: string, code: string, requestId: string): Promise<TelegramUpdateResult> {
    const res = await this.pool.query<{ tenant_id: string; user_id: string }>(
      `UPDATE telegram_link_code SET used_at = now()
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING tenant_id, user_id`, [hashCode(code)]);
    const row = res.rows[0];
    if (!row) {
      await this.reply(chatId, 'El código no es válido o ya caducó. Genera uno nuevo en tu panel de MainSpot.');
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
    await this.reply(chatId, 'Listo: este chat recibirá los avisos de MainSpot. Puedes desconectarlo desde tu panel.');
    return { handled: 'linked' };
  }
}
