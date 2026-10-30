import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SecretBox, ConnectorKeyError } from '../../src/connectors/secret-box.ts';

const box = SecretBox.fromBase64(randomBytes(32).toString('base64'));
const ctx = { tenantId: 'client_a', provider: 'meta_pages', purpose: 'tokens' };

test('a sealed token opens only for the same tenant, provider and purpose', () => {
  const sealed = box.sealJson({ access_token: 'secret-value' }, ctx);
  assert.deepEqual(box.openJson(sealed, ctx), { access_token: 'secret-value' });
  assert.ok(!sealed.toString('latin1').includes('secret-value'), 'ciphertext must not contain the token');
  assert.throws(() => box.open(sealed, { ...ctx, tenantId: 'client_b' }));
  assert.throws(() => box.open(sealed, { ...ctx, provider: 'google_business_profile' }));
  assert.throws(() => box.open(sealed, { ...ctx, purpose: 'pkce_verifier' }));
});

test('tampered ciphertext or another key is rejected', () => {
  const sealed = box.seal('token', ctx);
  const flipped = Buffer.from(sealed);
  flipped[flipped.length - 1] = flipped.at(-1)! ^ 0x01;
  assert.throws(() => box.open(flipped, ctx));
  const other = SecretBox.fromBase64(randomBytes(32).toString('base64'));
  assert.throws(() => other.open(sealed, ctx));
  assert.notEqual(other.keyId, box.keyId);
});

test('missing or malformed key fails closed with a message that never echoes the value', () => {
  assert.throws(() => SecretBox.fromBase64(''), ConnectorKeyError);
  const short = randomBytes(16).toString('base64');
  assert.throws(() => SecretBox.fromBase64(short), (err: Error) => err instanceof ConnectorKeyError && !err.message.includes(short));
});
