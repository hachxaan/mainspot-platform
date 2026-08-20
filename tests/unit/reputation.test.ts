/**
 * Unit — INC-004 reputación: dataset determinista, clasificación por umbral
 * (DEC-023), sugerencias deterministas y guard de manipulación.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedReviews } from '../../src/reputation/simulated.ts';
import { classifyReview, belowThreshold } from '../../src/reputation/provider.ts';
import { suggestResponses } from '../../src/reputation/engine.ts';
import { MATRIX, BLOCKED_ACTIONS } from '../../src/rbac/matrix.ts';
import { authorize } from '../../src/rbac/engine.ts';
import { ROLE_NAMES, type RoleName } from '../../src/identity/entities.ts';

test('reputation: dataset simulado determinista por tenant (2+ positivas, 1 neutra, 1 negativa <4)', async () => {
  const p = new SimulatedReviews();
  for (const tenant of ['client_a', 'client_b']) {
    const a = await p.listReviews(tenant);
    const b = await p.listReviews(tenant);
    assert.deepEqual(a, b, 'determinista (sin aleatoriedad, pinned)');
    assert.ok(a.length >= 4, 'al menos 4 reseñas');
    const positives = a.filter((r) => r.star_rating >= 4);
    const neutral = a.filter((r) => r.star_rating === 3);
    const negatives = a.filter((r) => r.star_rating < 4);
    assert.ok(positives.length >= 2, '2+ reseñas positivas');
    assert.ok(neutral.length >= 1, '1+ reseña neutra');
    assert.ok(negatives.length >= 1, '1+ reseña negativa (<4)');
  }
  assert.equal((await p.listReviews('client_a'))[0]!.source_review_id, 'g_a_01');
});

test('reputation: respuesta pública simulada es determinista e idempotente', async () => {
  const p = new SimulatedReviews();
  const r1 = await p.postPublicResponse('client_a', 'g_a_04', 'Gracias por tu comentario.');
  const r2 = await p.postPublicResponse('client_a', 'g_a_04', 'Gracias por tu comentario.');
  assert.equal(r1.ok, true);
  assert.equal(r1.external_ref, r2.external_ref, 'mismo contenido ⇒ mismo external_ref');
  assert.ok(r1.external_ref.startsWith('gbp:sim:'));
});

test('reputation: clasificación por calificación y umbral configurable (DEC-023)', () => {
  assert.equal(classifyReview(5), 'positive');
  assert.equal(classifyReview(4), 'positive');
  assert.equal(classifyReview(3), 'neutral');
  assert.equal(classifyReview(2), 'negative');
  assert.equal(classifyReview(1), 'negative');
  // Umbral default <4: 3 estrellas (neutral) SÍ requiere humano; 4 no.
  assert.equal(belowThreshold(3, 4), true);
  assert.equal(belowThreshold(4, 4), false);
  assert.equal(belowThreshold(2, 4), true);
  // Umbral configurable (<5): 4 estrellas también escala.
  assert.equal(belowThreshold(4, 5), true);
  assert.equal(belowThreshold(5, 5), false);
});

test('reputation: sugerencias deterministas de 3 opciones sin inventar hechos comerciales (RULE-005)', () => {
  const author = 'María P.';
  const negative = suggestResponses({ author_name: author, classification: 'negative' }, 'Restaurante El Sol');
  const neutral = suggestResponses({ author_name: author, classification: 'neutral' }, 'Restaurante El Sol');
  const positive = suggestResponses({ author_name: author, classification: 'positive' }, 'Restaurante El Sol');
  assert.equal(negative.length, 3);
  assert.equal(neutral.length, 3);
  assert.equal(positive.length, 3);
  for (const option of [...negative, ...neutral, ...positive]) {
    assert.ok(option.includes(author), 'menciona al autor');
    // Prohibido inventar descuentos, precios, devoluciones ni compensaciones.
    assert.ok(!/\b(S\/|descuento|promoción|gratis|reembolso|compensación)\b/i.test(option), `no inventa términos comerciales: ${option}`);
  }
  // Determinismo: misma entrada ⇒ mismas opciones.
  assert.deepEqual(suggestResponses({ author_name: author, classification: 'negative' }, 'Restaurante El Sol'), negative);
});

test('reputation: manipulación de reseñas (hide) está bloqueada para TODOS los roles', () => {
  assert.ok(BLOCKED_ACTIONS.includes('reputation.hide_review'));
  for (const role of ROLE_NAMES as readonly RoleName[]) {
    assert.equal(authorize(role, 'reputation.hide_review').allowed, false, `role ${role} cannot hide reviews`);
    assert.equal(MATRIX[role].includes('reputation.hide_review'), false);
  }
});

test('reputation: administration aprueba respuestas; read_only solo lee', () => {
  assert.equal(authorize('administration', 'reputation.approve').allowed, true);
  assert.equal(authorize('operation', 'reputation.approve').allowed, false, 'operación no aprueba públicaciones de reputación');
  assert.equal(authorize('read_only', 'reputation.respond').allowed, false);
  assert.equal(authorize('read_only', 'reputation.read').allowed, true);
});
