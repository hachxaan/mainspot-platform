/**
 * TelegramAdapter — primer canal conversacional del piloto (DEC-016).
 *
 * DEC-026: implementación REAL opcional (fetch a la Bot API) + modo simulado
 * cuando no hay credenciales. Solo se construye con TELEGRAM_BOT_TOKEN.
 *
 * - sendMessage(): POST real a https://api.telegram.org/bot<token>/sendMessage.
 * - ingest(): TENTATIVA — la resolución identidad actor/tenant desde el
 *   telegram user id necesita un mapeo canal→cliente (Q-005 resuelta solo a
 *   nivel de decisión; el diseño de sesión por canal queda TENTATIVA en canon,
 *   05-GOVERNANCE-SECURITY). Sin mapeo, el pipeline falla-cerrado (RULE-001).
 *
 * El webhook de entrada (receiving updates) queda fuera de alcance: el flujo
 * E2E se ejercita con SimulatedChannel; Telegram real sin token no se prueba.
 */

import type { ChannelAdapter, ChannelSendResult } from './types.ts';

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
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

  /** Envía un mensaje a un chat de Telegram usando la Bot API (HTTP real). */
  async sendMessage(chatId: string, text: string): Promise<ChannelSendResult> {
    try {
      const res = await fetch(`${this.baseUrl}/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) {
        return { ok: false, error: `telegram_send_${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Parse de un update de Telegram (TENTATIVA). Devuelve el texto y el
   * chat id; la resolución de identidad/tenant queda en el pipeline y, sin
   * mapeo canal→cliente, el actor es 'unknown' => fail-closed.
   */
  parseUpdate(update: TelegramUpdate): { text: string | null; chatId: number | null; sender: string } {
    const msg = update.message;
    if (!msg?.text) return { text: null, chatId: null, sender: 'unknown' };
    return {
      text: msg.text,
      chatId: msg.chat.id,
      sender: msg.from ? `telegram:${msg.from.id}` : 'unknown',
    };
  }
}
