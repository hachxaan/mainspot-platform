/**
 * Preview/sandbox token (CAP-008, FLOW-002 "enlace seguro", TENTATIVA).
 *
 * Estrategia TENTATIVA documentada: token aleatorio de alta entropía;
 * almacenamos SOLO el hash SHA-256 (nunca el token crudo, NFR-004); expiración
 * configurable (PREVIEW_TOKEN_TTL_MINUTES); alcance limitado a un proposal
 * (proposal_publish); single-use para "Aplicar cambios" (AC-007).
 *
 * Riesgo conocido (canon 05): los tokens pueden reenviarse — mitigado con
 * expiración + single-use; la audiencia/revocación adicional queda pendiente.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function generatePreviewToken(): string {
  return `pv_${randomBytes(24).toString('hex')}`;
}

export function hashPreviewToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function previewExpiry(ttlMinutes: number): Date {
  return new Date(Date.now() + ttlMinutes * 60_000);
}

export function verifyPreviewToken(token: string, hash: string): boolean {
  const actual = Buffer.from(hashPreviewToken(token), 'hex');
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
