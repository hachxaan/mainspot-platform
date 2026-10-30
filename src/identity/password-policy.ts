/**
 * Política de contraseñas del producto (una sola definición para alta por invitación y
 * restablecimiento): al menos 10 caracteres, máximo 128, con letras y números. La interfaz
 * repite las mismas reglas en vivo (MS.passReqs), pero el servidor es la autoridad.
 */

import { AppError } from '../shared/errors.ts';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

export function passwordMeetsPolicy(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH && /[A-Za-z]/.test(password) && /\d/.test(password);
}

/** Lanza validation_error (400) con el mensaje en lenguaje llano si la contraseña no cumple. */
export function assertPasswordPolicy(password: unknown): string {
  const value = typeof password === 'string' ? password : '';
  if (!passwordMeetsPolicy(value)) {
    throw new AppError(400, 'validation_error', `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres, con letras y números.`);
  }
  return value;
}
