/**
 * SEC-TG-APPROVAL-01 (DEC-0077 R9): cada aviso de Telegram lleva un código propio que identifica su instantánea
 * inmutable (`engagement_approval_offer`, migración 0037): el chat y la persona a quien se envió, la revisión de las
 * propuestas del caso y el texto exacto de cada opción mostrada. `/aprobar <código> <N>` solo publica la opción N de
 * ESE aviso y solo si el caso sigue en la misma revisión; cualquier cambio posterior de las propuestas lo invalida.
 */

import { createHash, randomBytes } from 'node:crypto';

/** Mismo alfabeto que el código de vínculo: sin 0/O ni 1/I para dictarlo o escribirlo sin errores. */
export const NOTICE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const NOTICE_CODE_LENGTH = 6;
export const NOTICE_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

/** Código aleatorio de un aviso (256 es múltiplo de 32: el módulo no sesga). */
export function newNoticeCode(): string {
  return Array.from(randomBytes(NOTICE_CODE_LENGTH), (b) => NOTICE_CODE_ALPHABET[b % NOTICE_CODE_ALPHABET.length]).join('');
}

/** Normaliza lo que escribió la persona; null si no tiene forma de código de aviso. */
export function parseNoticeCode(raw: string | undefined): string | null {
  const code = (raw ?? '').trim().toUpperCase();
  return NOTICE_CODE_RE.test(code) ? code : null;
}

/** Huella de las opciones mostradas (orden incluido): queda aunque la purga de Google vacíe el texto. */
export function optionsSha256(options: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(options), 'utf8').digest('hex');
}

export interface ApprovalOfferRow {
  offer_id: string;
  tenant_id: string;
  case_id: string;
  notification_id: string;
  chat_id: string;
  user_id: string;
  code: string;
  drafts_revision: number;
  options: string[];
  options_sha256: string;
  status: 'active' | 'used' | 'superseded' | 'purged';
  used_option: number | null;
  used_at: string | null;
  superseded_at: string | null;
  created_at: string;
}
