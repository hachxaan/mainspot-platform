/**
 * Unit — DEV-E2E-02 motor determinista del agente (SHARED-CONTRACT §B): clasificación y
 * decisión. La calificación o el sentimiento solos nunca autorizan una respuesta automática.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoReplyText, classify, decide, humanDrafts, type PolicySnapshot } from '../../src/engagement/classifier.ts';

const AUTO: PolicySnapshot = { policy_id: 'pol_1', version: 3, mode: 'safe_auto_reply', max_auto_replies_per_hour: 2 };
const REVIEW: PolicySnapshot = { ...AUTO, mode: 'review_required' };

test('agradecimiento simple + política opt-in → respuesta automática con versión de política', () => {
  const c = classify({ body: '¡Excelente atención, muchas gracias!', rating: 5, origin: 'google_review' });
  assert.equal(c.category, 'gratitude');
  assert.deepEqual(c.risk_flags, []);
  const d = decide({ classification: c, policy: AUTO, autoRepliesLastHour: 0, verifiedAnswer: null });
  assert.equal(d.decision, 'auto_reply');
  assert.equal(d.reason, 'policy:pol_1:v3');
});

test('la calificación sola no basta: 5★ sin señales de texto o con queja va a revisión humana', () => {
  const neutral = classify({ body: 'ok', rating: 5, origin: 'google_review' });
  assert.equal(neutral.category, 'other');
  assert.equal(decide({ classification: neutral, policy: AUTO, autoRepliesLastHour: 0, verifiedAnswer: null }).decision, 'human_review');
  const mixed = classify({ body: 'Rico, pero el pedido llegó frío', rating: 5, origin: 'google_review' });
  assert.equal(mixed.sentiment, 'mixed');
  assert.equal(decide({ classification: mixed, policy: AUTO, autoRepliesLastHour: 0, verifiedAnswer: null }).decision, 'human_review');
  const low = classify({ body: 'Gracias, excelente', rating: 3, origin: 'google_review' });
  assert.notEqual(low.category, 'gratitude', 'una reseña ≤3★ nunca es agradecimiento automático');
});

test('riesgo (salud, compensación, legal, amenaza, datos privados) → humano aunque haya política', () => {
  const cases: Array<[string, string]> = [
    ['Me intoxiqué con la comida', 'safety'],
    ['Quiero un reembolso de inmediato', 'compensation'],
    ['Voy a poner una denuncia en Profeco', 'legal'],
    ['Si no me atienden los voy a golpear', 'threat'],
    ['Me robaron el cambio', 'accusation'],
    ['Escríbanme a persona@example.com gracias', 'private_data'],
  ];
  for (const [body, flag] of cases) {
    const c = classify({ body, rating: null, origin: 'facebook_comment' });
    assert.ok(c.risk_flags.includes(flag), `${body} → ${flag}`);
    const d = decide({ classification: c, policy: AUTO, autoRepliesLastHour: 0, verifiedAnswer: null });
    assert.equal(d.decision, 'human_review');
    assert.match(d.reason, /^risk:/);
  }
});

test('sin política, política en revisión, datos sin verificar o cupo agotado → humano', () => {
  const thanks = classify({ body: 'Gracias, todo delicioso', rating: null, origin: 'facebook_comment' });
  assert.equal(decide({ classification: thanks, policy: null, autoRepliesLastHour: 0, verifiedAnswer: null }).reason, 'no_policy');
  assert.equal(decide({ classification: thanks, policy: REVIEW, autoRepliesLastHour: 0, verifiedAnswer: null }).reason, 'policy_review_required');
  assert.equal(decide({ classification: thanks, policy: AUTO, autoRepliesLastHour: 2, verifiedAnswer: null }).reason, 'rate_limited');
  const question = classify({ body: '¿Cuál es su teléfono?', rating: null, origin: 'facebook_comment' });
  assert.equal(question.category, 'basic_info');
  assert.equal(question.info_topic, 'phone');
  assert.equal(decide({ classification: question, policy: AUTO, autoRepliesLastHour: 0, verifiedAnswer: null }).reason, 'unverified_data');
  assert.equal(decide({ classification: question, policy: AUTO, autoRepliesLastHour: 0, verifiedAnswer: 'puedes llamarnos al +52 983 333 3333.' }).decision, 'auto_reply');
  const ambiguous = classify({ body: '¿Tienen promoción y a qué hora abren?', rating: null, origin: 'facebook_comment' });
  assert.equal(decide({ classification: ambiguous, policy: AUTO, autoRepliesLastHour: 0, verifiedAnswer: 'x' }).decision, 'human_review');
});

test('borradores: máximo 3, sin promesas comerciales; respuesta automática usa solo datos verificados', () => {
  const risky = classify({ body: 'Quiero reembolso, me enfermé', rating: 1, origin: 'google_review' });
  const drafts = humanDrafts({ classification: risky, author: 'Ana', business: 'La Luna', verifiedAnswer: null });
  assert.equal(drafts.length, 3);
  for (const d of drafts) assert.ok(!/descuento|reembolso|gratis|regalo|compens/i.test(d), d);
  assert.equal(autoReplyText({ category: 'basic_info', author: 'Ana', business: 'La Luna', verifiedAnswer: 'puedes llamarnos al +52 983 333 3333.' }),
    'Hola Ana, puedes llamarnos al +52 983 333 3333.');
});
