/**
 * Unit — SEC-CONSENT-01 (DEC-0077 R8; DEC-0078 R5/R6; BR-0007): cada versión de los términos de consentimiento
 * corresponde a UN texto. Las políticas y activaciones guardadas solo cubren el gasto de IA si su versión y su huella son
 * las vigentes; si alguien cambia un texto sin subir su versión, las aceptaciones anteriores dejarían de coincidir en
 * silencio. Esta prueba fija la huella de cada versión: cambiar un texto exige versión nueva (y actualizar aquí la pareja
 * versión → huella).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_REPLY_CONSENT, AUTO_SUGGEST_CONSENT, REVIEW_REQUIRED_CONSENT, autoReplyOriginOfVersion, consentCoversAiSpend, reconsentRequired,
  suggestionConsentIsCurrent,
} from '../../src/engagement/consent.ts';

test('cada versión de los términos tiene su huella fija (cambiar un texto exige subir la versión)', () => {
  const pinned = Object.fromEntries([AUTO_REPLY_CONSENT.google_review, AUTO_REPLY_CONSENT.facebook_comment, AUTO_SUGGEST_CONSENT.facebook_comment, REVIEW_REQUIRED_CONSENT]
    .map((terms) => [terms.version, terms.sha256]));
  assert.deepEqual(pinned, {
    'auto_reply.google_review.v2': '83cd01c2b032a5f2a9273deafc149a0fea90cd1b44130e324880d866d08cdb1f',
    'auto_reply.facebook_comment.v3': '16eaaffe44a404601de010f275596bed5e1d680f851bae1cb98b6db425dfa565',
    'ai_suggestions.facebook_comment.v1': '8d5a9494add06f945f7bbd7a210b6ca4ef63148d8b63210f42a038e02ecdfbf7',
    'review_required.v1': '249b8ec16447e1d6596b46fe8701dc552145d6c6608f2d6ea29e8e870e46382e',
  });
});

test('solo la versión vigente CON su huella cubre el gasto de IA, en cada origen con su propio medidor', () => {
  for (const origin of ['google_review', 'facebook_comment'] as const) {
    const current = AUTO_REPLY_CONSENT[origin];
    const auto = { origin, mode: 'safe_auto_reply' as const };
    assert.equal(consentCoversAiSpend({ ...auto, consent_version: current.version, consent_sha256: current.sha256 }), true, origin);
    assert.equal(consentCoversAiSpend({ ...auto, consent_version: current.version, consent_sha256: '0'.repeat(64) }), false, `${origin}: misma versión, otro texto`);
    assert.equal(consentCoversAiSpend({ ...auto, consent_version: null, consent_sha256: null }), false, `${origin}: anterior a los términos versionados`);
    assert.equal(reconsentRequired({ ...auto, consent_version: null, consent_sha256: null }), true, `${origin}: debe aceptar de nuevo`);
    assert.equal(consentCoversAiSpend({ origin, mode: 'review_required', consent_version: current.version, consent_sha256: current.sha256 }), false,
      `${origin}: revisar no autoriza gasto automático`);
  }
  // DEC-0078 R6: la versión v2 de Facebook (sin el medidor propio) ya no cubre el gasto ni se acepta en silencio.
  assert.equal(consentCoversAiSpend({ origin: 'facebook_comment', mode: 'safe_auto_reply', consent_version: 'auto_reply.facebook_comment.v2', consent_sha256: AUTO_REPLY_CONSENT.facebook_comment.sha256 }), false);
  assert.equal(autoReplyOriginOfVersion(AUTO_REPLY_CONSENT.facebook_comment.version), 'facebook_comment');
  assert.equal(autoReplyOriginOfVersion('auto_reply.facebook_comment.v2'), null, 'una versión anterior no se acepta');
});

test('las sugerencias automáticas solo cuentan con su versión vigente y su huella', () => {
  const t = AUTO_SUGGEST_CONSENT.facebook_comment;
  assert.equal(suggestionConsentIsCurrent({ consent_version: t.version, consent_sha256: t.sha256 }), true);
  assert.equal(suggestionConsentIsCurrent({ consent_version: t.version, consent_sha256: '0'.repeat(64) }), false);
  assert.equal(suggestionConsentIsCurrent({ consent_version: null, consent_sha256: null }), false);
});
