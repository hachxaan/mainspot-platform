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
 */

import type { ChannelPrimary } from '../shared/config.ts';

export type ChannelKind = 'telegram' | 'simulated';

export interface ChannelMessage {
  channel: ChannelKind;
  /** Texto normalizado recibido del usuario (tenant-scoped, no va a auditoría). */
  text: string;
  /** Identidad ya resuelta por el canal (TENTATIVA en Telegram real) o por la capa de sesión (backoffice). */
  actor_id?: string;
  tenant_id?: string;
}

export interface ChannelSendResult {
  ok: boolean;
  error?: string;
}

/** Interfaz de adaptador de canal (DEC-026: patrón de integraciones externas). */
export interface ChannelAdapter {
  readonly name: ChannelKind;
  /** Envía un mensaje al usuario en el canal (real: API Telegram; simulado: outbox local). */
  sendMessage(userRef: string, text: string): Promise<ChannelSendResult>;
}
