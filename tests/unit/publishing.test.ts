/**
 * Unit — publisher stub + preview token (INC-002, AC-007).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StubPublisher } from '../../src/publishing/stub.ts';
import type { PublisherContext } from '../../src/publishing/publisher.ts';
import { generatePreviewToken, hashPreviewToken, previewExpiry, verifyPreviewToken } from '../../src/conversation/preview-token.ts';

const CTX: PublisherContext = { tenantId: 'client_a', proposalId: 'prop_x', proposalType: 'website.edit', payload: {} };

test('stub publisher: publica una vez con external_ref único e idempotente', async () => {
  const p = new StubPublisher();
  const r1 = await p.publish(CTX);
  const r2 = await p.publish(CTX);
  assert.equal(r1.ok, true);
  assert.equal(r1.external_ref, r2.external_ref, 'mismo proposal ⇒ mismo external_ref');
  assert.equal(r1.version, 1);
});

test('stub publisher: fallo inyectado devuelve ok=false sin lanzar (rama failed de FLOW-002)', async () => {
  const p = new StubPublisher((ctx) => ctx.proposalType === 'website.edit');
  const r = await p.publish(CTX);
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('preview token: alta entropía, hash estable, verificación con timing-safe', () => {
  const tok = generatePreviewToken();
  assert.ok(tok.startsWith('pv_'));
  assert.ok(tok.length > 40, 'high entropy token');
  const h = hashPreviewToken(tok);
  assert.equal(h, hashPreviewToken(tok));
  assert.equal(verifyPreviewToken(tok, h), true);
  assert.equal(verifyPreviewToken(tok + 'x', h), false);
  assert.equal(verifyPreviewToken('otro', h), false);
});

test('preview token: expiración configurable (PREVIEW_TOKEN_TTL_MINUTES)', () => {
  const exp = previewExpiry(1440);
  const delta = exp.getTime() - Date.now();
  assert.ok(delta > 1439 * 60_000 && delta <= 1441 * 60_000, 'expiración ~24h');
});
