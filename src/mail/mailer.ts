/**
 * Envío de correo transaccional (DEV-E2E-04, P2: recuperación de contraseña).
 *
 * Un solo contrato `Mailer` con tres transportes reales configurados por variables de entorno
 * (nunca valores en código):
 *   - MAIL_TRANSPORT=disabled (por defecto): NO se envía nada; `send` devuelve `sent:false` y
 *     registra el evento no sensible `mail.transport_disabled`. Jamás se simula una entrega.
 *   - MAIL_TRANSPORT=smtp: SMTP con TLS obligatorio (465 implícito o STARTTLS requerido);
 *     sin degradación a texto claro. Variables: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
 *     SMTP_SECURE=implicit|starttls (por defecto según puerto), SMTP_CA_FILE (CA extra, opcional).
 *   - MAIL_TRANSPORT=resend: API HTTP transaccional de Resend (RESEND_API_KEY) sobre HTTPS.
 * MAIL_FROM es el remitente verificado en el proveedor. Los registros nunca incluyen
 * destinatarios, asuntos, cuerpos ni credenciales: solo proveedor, código de error y estado.
 */

import { readFileSync } from 'node:fs';
import { createTransport, type Transporter } from 'nodemailer';
import { log } from '../shared/logger.ts';
import type { MailConfig } from './config.ts';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type MailSendResult =
  | { sent: true; provider: string; message_id: string | null }
  | { sent: false; provider: string; reason: 'transport_disabled' | 'transport_error' };

export interface Mailer {
  /** Nombre del transporte ('disabled' | 'smtp' | 'resend' | 'test'). */
  readonly provider: string;
  /** true solo cuando hay un transporte real configurado (nunca para 'disabled'). */
  readonly enabled: boolean;
  /** Nunca lanza: todo fallo se traduce en `sent:false` y un registro sin datos personales. */
  send(message: MailMessage): Promise<MailSendResult>;
  /** Comprueba conexión y credenciales con el proveedor SIN enviar correo. */
  verify(): Promise<{ ok: boolean; detail: string }>;
}

/** Transporte por defecto: deja constancia de que NO se envió nada (BLOCKED_EXTERNAL). */
export class DisabledMailer implements Mailer {
  readonly provider = 'disabled';
  readonly enabled = false;

  async send(): Promise<MailSendResult> {
    log.warn('mail.transport_disabled', 'correo NO enviado: no hay transporte de correo configurado (MAIL_TRANSPORT=disabled)', { provider: this.provider });
    return { sent: false, provider: this.provider, reason: 'transport_disabled' };
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: 'MAIL_TRANSPORT=disabled: no hay proveedor de correo configurado.' };
  }
}

interface SmtpErrorShape { code?: unknown; responseCode?: unknown; command?: unknown }

/** Solo campos no sensibles del error SMTP (el mensaje puede incluir la dirección del destinatario). */
function smtpErrorFields(err: unknown): Record<string, unknown> {
  const e = (err ?? {}) as SmtpErrorShape;
  return {
    error_code: typeof e.code === 'string' ? e.code : (err instanceof Error ? err.name : 'unknown'),
    smtp_response_code: typeof e.responseCode === 'number' ? e.responseCode : null,
    smtp_command: typeof e.command === 'string' ? e.command : null,
  };
}

/** SMTP real con TLS obligatorio (nodemailer). */
export class SmtpMailer implements Mailer {
  readonly provider = 'smtp';
  readonly enabled = true;
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(cfg: MailConfig) {
    if (!cfg.smtpHost) throw new Error('MAIL_TRANSPORT=smtp requiere SMTP_HOST');
    if (!Number.isInteger(cfg.smtpPort) || cfg.smtpPort < 1 || cfg.smtpPort > 65535) throw new Error('MAIL_TRANSPORT=smtp requiere SMTP_PORT válido');
    if (!cfg.from) throw new Error('MAIL_TRANSPORT=smtp requiere MAIL_FROM');
    if (Boolean(cfg.smtpUser) !== Boolean(cfg.smtpPass)) throw new Error('SMTP_USER y SMTP_PASS deben definirse juntos');
    const ca = cfg.smtpCaFile ? [readFileSync(cfg.smtpCaFile, 'utf8')] : undefined;
    const implicit = cfg.smtpSecure === 'implicit';
    this.from = cfg.from;
    this.transporter = createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      // TLS desde el primer byte (465) o STARTTLS obligatorio: si el servidor no lo ofrece, falla.
      secure: implicit,
      requireTLS: !implicit,
      ignoreTLS: false,
      auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, ...(ca ? { ca } : {}) },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    try {
      const info = await this.transporter.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text, html: message.html });
      const accepted = Array.isArray(info?.accepted) ? info.accepted.length : 0;
      if (accepted < 1) {
        log.warn('mail.send_failed', 'el servidor SMTP no aceptó al destinatario', { provider: this.provider, error_code: 'EENVELOPE' });
        return { sent: false, provider: this.provider, reason: 'transport_error' };
      }
      const messageId = typeof info?.messageId === 'string' ? info.messageId : null;
      log.info('mail.sent', 'correo entregado al servidor SMTP', { provider: this.provider, has_message_id: messageId !== null });
      return { sent: true, provider: this.provider, message_id: messageId };
    } catch (err) {
      log.warn('mail.send_failed', 'no se pudo enviar el correo por SMTP', { provider: this.provider, ...smtpErrorFields(err) });
      return { sent: false, provider: this.provider, reason: 'transport_error' };
    }
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.transporter.verify();
      return { ok: true, detail: 'Conexión SMTP con TLS y credenciales aceptadas.' };
    } catch (err) {
      const f = smtpErrorFields(err);
      return { ok: false, detail: `SMTP no verificado (${String(f['error_code'])}${f['smtp_response_code'] ? ` ${String(f['smtp_response_code'])}` : ''}).` };
    }
  }

  close(): void {
    this.transporter.close();
  }
}

/** API HTTP transaccional de Resend (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendMailer implements Mailer {
  readonly provider = 'resend';
  readonly enabled = true;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly from: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: MailConfig, fetchImpl: typeof fetch = fetch) {
    if (!cfg.resendApiKey) throw new Error('MAIL_TRANSPORT=resend requiere RESEND_API_KEY');
    if (!cfg.from) throw new Error('MAIL_TRANSPORT=resend requiere MAIL_FROM');
    const url = new URL(cfg.resendBaseUrl);
    // Solo HTTPS; la única excepción es el servidor falso en proceso (127.0.0.1) de las pruebas.
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') throw new Error('RESEND_BASE_URL debe usar https');
    this.apiKey = cfg.resendApiKey;
    this.baseUrl = cfg.resendBaseUrl.replace(/\/$/, '');
    this.from = cfg.from;
    this.fetchImpl = fetchImpl;
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        log.warn('mail.send_failed', 'la API de correo rechazó el envío', { provider: this.provider, http_status: res.status });
        return { sent: false, provider: this.provider, reason: 'transport_error' };
      }
      const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
      const messageId = typeof body?.id === 'string' ? body.id : null;
      log.info('mail.sent', 'correo aceptado por la API de correo', { provider: this.provider, has_message_id: messageId !== null });
      return { sent: true, provider: this.provider, message_id: messageId };
    } catch (err) {
      log.warn('mail.send_failed', 'no se pudo contactar la API de correo', { provider: this.provider, error_code: err instanceof Error ? err.name : 'unknown' });
      return { sent: false, provider: this.provider, reason: 'transport_error' };
    }
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      // Lectura autenticada sin efectos: valida clave y conectividad.
      const res = await this.fetchImpl(`${this.baseUrl}/domains`, { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(15_000) });
      return res.ok ? { ok: true, detail: 'API de Resend accesible con la clave configurada.' } : { ok: false, detail: `API de Resend respondió HTTP ${res.status}.` };
    } catch (err) {
      return { ok: false, detail: `API de Resend inaccesible (${err instanceof Error ? err.name : 'error'}).` };
    }
  }
}

/** Construye el transporte según configuración; falla al arrancar si la configuración es incompleta. */
export function createMailer(cfg: MailConfig, deps: { fetchImpl?: typeof fetch } = {}): Mailer {
  switch (cfg.transport) {
    case 'smtp': return new SmtpMailer(cfg);
    case 'resend': return new ResendMailer(cfg, deps.fetchImpl);
    case 'disabled': return new DisabledMailer();
    default: {
      const never: never = cfg.transport;
      throw new Error(`MAIL_TRANSPORT no soportado: ${String(never)}`);
    }
  }
}
