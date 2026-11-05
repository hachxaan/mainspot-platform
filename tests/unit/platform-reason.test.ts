/**
 * DEC-0027 — motivos de plataforma: un texto que la anonimización consideraría un identificador del negocio
 * (correo o id `client_…` con el límite `[A-Za-z0-9_-]` de su verificación) se rechaza al escribirlo, porque
 * después quedaría en filas que la anonimización no puede limpiar.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPlatformReason } from '../../src/platform/auth.ts';
import { AppError } from '../../src/shared/errors.ts';

const rejected = (reason: string) => assert.throws(() => assertPlatformReason(reason),
  (err: unknown) => err instanceof AppError && err.status === 400 && /datos de negocios/.test(err.message), reason);

test('motivo de plataforma: acepta texto operativo sin datos de negocios', () => {
  assert.equal(assertPlatformReason('  Ajuste mensual del presupuesto de IA  '), 'Ajuste mensual del presupuesto de IA');
});

test('motivo de plataforma: rechaza correos e ids client_, también pegados a letras que no son ASCII', () => {
  rejected('Lo pidió dueña@cafe-luna.example por teléfono');
  rejected('Cambio pedido por client_cafe_luna_a1b2c3');
  rejected('Revisión de (client_taller_9f8e7d) hoy');
  rejected('Revisión de CLIENT_TALLER_9F8E7D hoy');
  // Con `\b` y el flag `u`, ſ (s larga) y el signo Kelvin cuentan como letras y estos pasaban; la verificación de la
  // anonimización, en cambio, sí los reconoce como identificador.
  rejected('Revisión de ſclient_taller_9f8e7d hoy');
  rejected('Revisión de \u212Aclient_taller_9f8e7d hoy');
});
