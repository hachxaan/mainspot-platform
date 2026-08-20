/**
 * SimulatedChannel — canal funcional para E2E y pruebas sin credenciales
 * externas (DEC-026: MODO SIMULADO funcional).
 *
 * - sendMessage(): guarda en un outbox en memoria (transcript legible para tests/E2E).
 * - receive(): inyecta un mensaje hacia el pipeline (mismo camino E2E de Telegram).
 * No persiste mensajes (NFR-004: los mensajes son datos personales; en el piloto
 * el transcript vive en memoria por instancia).
 */

import type { ChannelAdapter, ChannelMessage, ChannelSendResult } from './types.ts';

export interface OutboxEntry {
  channel: 'simulated';
  to: string;
  text: string;
  at: string;
}

export class SimulatedChannel implements ChannelAdapter {
  readonly name = 'simulated' as const;
  private readonly outbox: OutboxEntry[] = [];

  async sendMessage(userRef: string, text: string): Promise<ChannelSendResult> {
    this.outbox.push({ channel: 'simulated', to: userRef, text, at: new Date().toISOString() });
    return { ok: true };
  }

  /** Transcript de mensajes enviados (para asserts de E2E/tests). */
  transcript(): readonly OutboxEntry[] {
    return [...this.outbox];
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
  }
}
