/**
 * Channel adapters (INC-002, DEC-016 + DEC-026).
 *
 * Channels do NOT substitute identity, authorization or consent (RULE-001,
 * DEC-006). Every channel funnels a message into the intake pipeline, which
 * resolves actor+tenant from INC-001 foundations before producing any effect.
 *
 * DEC-026: adapter interface + optional real implementation + FUNCTIONAL
 * simulated mode. Telegram real sending requires TELEGRAM_BOT_TOKEN; without
 * it the registry falls back to the SimulatedChannel (E2E/pilot sin credenciales).
 *
 * Mensajes salientes: HTML limitado de Telegram (`<b>`, `<i>`, `<a>`, `<blockquote>`) con todo dato
 * variable escapado por `escapeHtml`, y botones en línea. Pulsar un botón llega como acción con su
 * `action` (callback_data, ≤ 64 bytes); quien recibe la acción vuelve a autorizarla siempre.
 */

export type ChannelKind = 'telegram' | 'simulated';

export interface ChannelMessage {
  channel: ChannelKind;
  /** Texto normalizado recibido del usuario (tenant-scoped, no va a auditoría). */
  text: string;
  /** Identidad ya resuelta por el canal (TENTATIVA en Telegram real) o por la capa de sesión (backoffice). */
  actor_id?: string;
  tenant_id?: string;
}

/** Botón en línea: `label` visible; `action` vuelve al servidor al pulsarlo (callback_data de Telegram). */
export interface ChannelButton {
  label: string;
  action: string;
}

/** Mensaje saliente: `html` ya escapado (subconjunto HTML de Telegram) y filas de botones opcionales. */
export interface OutgoingMessage {
  html: string;
  buttons?: ChannelButton[][];
}

export interface ChannelSendResult {
  ok: boolean;
  error?: string;
  /** Id del mensaje enviado en el canal (para editarlo después, p. ej. quitar botones ya usados). */
  messageId?: string;
}

/** Límite de Telegram para callback_data. */
export const MAX_ACTION_BYTES = 64;

/** Interfaz de adaptador de canal (DEC-026: patrón de integraciones externas). */
export interface ChannelAdapter {
  readonly name: ChannelKind;
  /** Envía un mensaje al usuario en el canal (real: API Telegram; simulado: outbox local). */
  send(userRef: string, message: OutgoingMessage): Promise<ChannelSendResult>;
  /** Reemplaza el contenido y los botones de un mensaje ya enviado (sin botones = se quitan). */
  edit(userRef: string, messageId: string, message: OutgoingMessage): Promise<ChannelSendResult>;
  /** Cierra la pulsación de un botón (detiene el indicador de carga) con un aviso breve opcional. */
  answerAction(actionId: string, notice?: string): Promise<void>;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Texto plano legible de un mensaje HTML del canal (transcript, chat simulado del panel). */
export function htmlToPlain(html: string): string {
  return html.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** Mensaje de solo texto (escapado). */
export function plainMessage(text: string): OutgoingMessage {
  return { html: escapeHtml(text) };
}
