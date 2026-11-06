/**
 * Unit — SEC-CONSENT-01 (DEC-0077 R8; BR-0007): cada versión de los términos de consentimiento corresponde a UN texto.
 * Las políticas guardadas solo cubren el gasto de IA si su versión y su huella son las vigentes; si alguien cambia un
 * texto sin subir su versión, las aceptaciones anteriores dejarían de coincidir en silencio. Esta prueba fija la huella
 * de cada versión: cambiar un texto exige versión nueva (y actualizar aquí la pareja versión → huella).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_REPLY_CONSENT, REVIEW_REQUIRED_CONSENT, consentCoversAiSpend, reconsentRequired } from '../../src/engagement/consent.ts';

test('cada versión de los términos tiene su huella fija (cambiar un texto exige subir la versión)', () => {
  const pinned = Object.fromEntries([AUTO_REPLY_CONSENT.google_review, AUTO_REPLY_CONSENT.facebook_comment, REVIEW_REQUIRED_CONSENT]
    .map((terms) => [terms.version, terms.sha256]));
  assert.deepEqual(pinned, {
    'auto_reply.google_review.v2': '83cd01c2b032a5f2a9273deafc149a0fea90cd1b44130e324880d866d08cdb1f',
    'auto_reply.facebook_comment.v2': '3027e16fb35b53f1e2d5192c77498a4583479ccc987bccb51d56ea76460fdd87',
    'review_required.v1': '249b8ec16447e1d6596b46fe8701dc552145d6c6608f2d6ea29e8e870e46382e',
  });
});

test('solo la versión vigente CON su huella cubre el gasto de IA en reseñas de Google', () => {
  const google = AUTO_REPLY_CONSENT.google_review;
  const auto = { origin: 'google_review' as const, mode: 'safe_auto_reply' as const };
  assert.equal(consentCoversAiSpend({ ...auto, consent_version: google.version, consent_sha256: google.sha256 }), true);
  assert.equal(consentCoversAiSpend({ ...auto, consent_version: google.version, consent_sha256: '0'.repeat(64) }), false, 'misma versión, otro texto');
  assert.equal(consentCoversAiSpend({ ...auto, consent_version: 'auto_reply.google_review.v1', consent_sha256: google.sha256 }), false, 'otra versión');
  assert.equal(consentCoversAiSpend({ ...auto, consent_version: null, consent_sha256: null }), false, 'anterior a los términos versionados');
  assert.equal(reconsentRequired({ ...auto, consent_version: google.version, consent_sha256: '0'.repeat(64) }), true);
  const fb = AUTO_REPLY_CONSENT.facebook_comment;
  assert.equal(consentCoversAiSpend({ origin: 'facebook_comment', mode: 'safe_auto_reply', consent_version: fb.version, consent_sha256: fb.sha256 }), false,
    'Facebook nunca gasta la cuota de reseñas');
  assert.equal(reconsentRequired({ origin: 'facebook_comment', mode: 'safe_auto_reply', consent_version: null, consent_sha256: null }), false);
});
