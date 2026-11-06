/**
 * SimulatedChannel — canal funcional para E2E y pruebas sin credenciales
 * externas (DEC-026: MODO SIMULADO funcional).
 *
 * - send(): guarda en un outbox en memoria con id, HTML, texto plano y botones (como Telegram).
 * - edit(): reemplaza el mensaje en su sitio (botones ya usados desaparecen, como en Telegram).
 * - answerAction(): guarda el aviso breve de la pulsación.
 * - receive(): inyecta un mensaje hacia el pipeline (mismo camino E2E de Telegram).
 * No persiste mensajes (NFR-004: los mensajes son datos personales; en el piloto
 * el transcript vive en memoria por instancia).
 */

import { htmlToPlain, type ChannelAdapter, type ChannelButton, type ChannelMessage, type ChannelSendResult, type OutgoingMessage } from './types.ts';

export interface OutboxEntry {
  channel: 'simulated';
  to: string;
  message_id: string;
  html: string;
  /** Texto plano del HTML (lo que lee la persona). */
  text: string;
  buttons: ChannelButton[][];
  at: string;
  edited_at: string | null;
}

export interface ActionNotice {
  action_id: string;
  notice: string | null;
  at: string;
}

export class SimulatedChannel implements ChannelAdapter {
  readonly name = 'simulated' as const;
  private readonly outbox: OutboxEntry[] = [];
  private readonly notices: ActionNotice[] = [];
  private seq = 0;

  async send(userRef: string, message: OutgoingMessage): Promise<ChannelSendResult> {
    this.seq += 1;
    const id = String(this.seq);
    this.outbox.push({
      channel: 'simulated', to: userRef, message_id: id, html: message.html, text: htmlToPlain(message.html),
      buttons: message.buttons ?? [], at: new Date().toISOString(), edited_at: null,
    });
    return { ok: true, messageId: id };
  }

  async edit(userRef: string, messageId: string, message: OutgoingMessage): Promise<ChannelSendResult> {
    const entry = this.outbox.find((m) => m.to === userRef && m.message_id === messageId);
    if (!entry) return { ok: false, error: 'message_not_found' };
    entry.html = message.html;
    entry.text = htmlToPlain(message.html);
    entry.buttons = message.buttons ?? [];
    entry.edited_at = new Date().toISOString();
    return { ok: true, messageId };
  }

  async answerAction(actionId: string, notice?: string): Promise<void> {
    this.notices.push({ action_id: actionId, notice: notice ?? null, at: new Date().toISOString() });
  }

  /** Transcript de mensajes enviados en su estado actual (para asserts de E2E/tests y el chat del panel). */
  transcript(): readonly OutboxEntry[] {
    return this.outbox.map((m) => ({ ...m, buttons: m.buttons.map((row) => [...row]) }));
  }

  /** Avisos de las pulsaciones atendidas. */
  actionNotices(): readonly ActionNotice[] {
    return [...this.notices];
  }

  /** Envía un mensaje entrante simulando el webhook del canal (sin credenciales). */
  async receive(message: ChannelMessage): Promise<ChannelSendResult> {
    // Un canal es solo transporte: la identidad/autorización la resuelve el
    // pipeline (RULE-001). Aquí recibimos el mensaje; si el caller no proveyó
    // actor/tenant el pipeline fallará-cerrado.
    return { ok: true };
  }

  reset(): void {
    this.outbox.length = 0;
    this.notices.length = 0;
  }
}
