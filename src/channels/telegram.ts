/**
 * TelegramAdapter — canal real del piloto (DEC-016) sobre la Bot API.
 *
 * DEC-026: solo se construye con TELEGRAM_BOT_TOKEN; sin token el registro usa SimulatedChannel.
 *
 * - send(): `sendMessage` con `parse_mode=HTML` y teclado en línea (`inline_keyboard`).
 * - edit(): `editMessageText`; sin botones se quita el teclado (acción ya usada).
 * - answerAction(): `answerCallbackQuery` (cierra el indicador del botón pulsado).
 * Los updates entrantes (mensajes y pulsaciones) llegan por el webhook autenticado
 * (`/api/telegram/webhook`) y los procesa TelegramLinkService. Nunca se registra el token.
 */

import { log } from '../shared/logger.ts';
import { htmlToPlain, type ChannelAdapter, type ChannelButton, type ChannelSendResult, type OutgoingMessage } from './types.ts';

interface BotApiReply {
  ok: boolean;
  result?: { message_id?: number } | boolean;
  description?: string;
}

interface CallResult { ok: boolean; result?: BotApiReply['result']; error?: string; description?: string }

function keyboard(rows: ChannelButton[][] | undefined): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return { inline_keyboard: (rows ?? []).map((row) => row.map((b) => ({ text: b.label, callback_data: b.action }))) };
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram' as const;
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl = 'https://api.telegram.org') {
    if (!token) {
      throw new Error('TelegramAdapter requires TELEGRAM_BOT_TOKEN (DEC-026)');
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async send(chatId: string, message: OutgoingMessage): Promise<ChannelSendResult> {
    const r = await this.deliver('sendMessage', { chat_id: chatId, ...(message.buttons?.length ? { reply_markup: keyboard(message.buttons) } : {}) }, message);
    if (!r.ok) return { ok: false, error: r.error };
    const id = typeof r.result === 'object' && r.result ? r.result.message_id : undefined;
    return { ok: true, messageId: id === undefined ? undefined : String(id) };
  }

  async edit(chatId: string, messageId: string, message: OutgoingMessage): Promise<ChannelSendResult> {
    const r = await this.deliver('editMessageText', { chat_id: chatId, message_id: Number(messageId), reply_markup: keyboard(message.buttons) }, message);
    // Pulsación repetida que deja el mensaje igual: no es un fallo.
    if (!r.ok && /message is not modified/i.test(r.description ?? '')) return { ok: true, messageId };
    return r.ok ? { ok: true, messageId } : { ok: false, error: r.error };
  }

  /**
   * Envía o edita con formato HTML. Si Telegram rechaza el formato («can't parse entities»), el mismo mensaje sale
   * una vez como texto plano con sus botones: la persona recibe el aviso y el rechazo queda registrado.
   */
  private async deliver(method: string, target: Record<string, unknown>, message: OutgoingMessage): Promise<CallResult> {
    const preview = { link_preview_options: { is_disabled: true } };
    const r = await this.call(method, { ...target, ...preview, text: message.html, parse_mode: 'HTML' });
    if (r.ok || !/can't parse entities/i.test(r.description ?? '')) return r;
    log.warn('telegram.html_rejected', 'telegram rejected message formatting; sent as plain text', { method });
    return this.call(method, { ...target, ...preview, text: htmlToPlain(message.html) });
  }

  async answerAction(actionId: string, notice?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: actionId, ...(notice ? { text: notice.slice(0, 190) } : {}) });
  }

  private async call(method: string, body: Record<string, unknown>): Promise<CallResult> {
    try {
      const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json().catch(() => ({ ok: false }))) as BotApiReply;
      if (res.ok && data.ok) return { ok: true, result: data.result };
      const description = (data.description ?? '').split(this.token).join('<token>').slice(0, 200);
      log.warn('telegram.api_error', 'telegram bot api call failed', { method, status: res.status, description });
      return { ok: false, error: `telegram_${method}_${res.status}`, description };
    } catch (err) {
      // La causa de fetch puede incluir la URL con el token: solo el tipo.
      log.warn('telegram.api_error', 'telegram bot api unreachable', { method, error: (err as Error).name });
      return { ok: false, error: `telegram_${method}_network` };
    }
  }
}
