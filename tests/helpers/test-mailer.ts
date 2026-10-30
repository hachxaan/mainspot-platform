/**
 * Transporte de correo SOLO para pruebas: guarda los mensajes en memoria. No existe fuera de
 * tests/ a propósito (ningún valor de MAIL_TRANSPORT lo activa en el producto).
 */

import type { Mailer, MailMessage, MailSendResult } from '../../src/mail/mailer.ts';

export class TestMailer implements Mailer {
  readonly provider = 'test';
  readonly enabled = true;
  readonly sent: MailMessage[] = [];
  /** Si es true, el siguiente envío falla como lo haría un proveedor caído. */
  failNext = false;

  async send(message: MailMessage): Promise<MailSendResult> {
    if (this.failNext) {
      this.failNext = false;
      return { sent: false, provider: this.provider, reason: 'transport_error' };
    }
    this.sent.push(message);
    return { sent: true, provider: this.provider, message_id: `test_${this.sent.length}` };
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'transporte de pruebas' };
  }

  /** Mensajes enviados a un destinatario. */
  to(address: string): MailMessage[] {
    return this.sent.filter((m) => m.to === address);
  }

  /** Enlace de restablecimiento del último correo enviado a `address` (o null). */
  lastLink(address: string): string | null {
    const last = this.to(address).at(-1);
    const m = last ? /https?:\/\/\S+/.exec(last.text) : null;
    return m ? m[0] : null;
  }
}

/** El token viaja en el fragmento del enlace (nunca en ruta ni query). */
export function tokenFromLink(link: string): string {
  const i = link.indexOf('#');
  return i >= 0 ? link.slice(i + 1) : '';
}
