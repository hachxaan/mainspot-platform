import { test } from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../../src/shared/logger.ts';

test('unit: logger refuses sensitive-looking keys (never logs secrets)', () => {
  for (const key of ['password', 'access_token', 'secret', 'authorization', 'api_key']) {
    assert.throws(
      () => log.info('unit', 'should throw', { [key]: 'secret-value' }),
      (err: unknown) => err instanceof Error && /Refusing to log field/.test(err.message),
      `key ${key} must be refused`,
    );
  }
});

test('unit: logger accepts ordinary fields', () => {
  assert.doesNotThrow(() => log.debug('unit.ok', 'fine', { action: 'data.read', decision: 'allow' }));
});
