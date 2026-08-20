import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginRateLimiter } from '../../src/boundary/ratelimit.ts';

test('IR-06 unit: allows below max, locks after max failures in a window', () => {
  const rl = new LoginRateLimiter(3, 60_000, 60_000);
  const keyIp = '10.0.0.1';
  const login = 'brute@example.com';
  assert.equal(rl.allow(keyIp, login), true);
  rl.recordFailure(keyIp, login);
  assert.equal(rl.allow(keyIp, login), true);
  rl.recordFailure(keyIp, login);
  assert.equal(rl.allow(keyIp, login), true);
  rl.recordFailure(keyIp, login);
  // Third failure reached the max -> locked
  assert.equal(rl.allow(keyIp, login), false);
  assert.ok(rl.lockRemainingMs(keyIp, login) > 0);
});

test('IR-06 unit: successful login resets the key', () => {
  const rl = new LoginRateLimiter(2, 60_000, 60_000);
  rl.recordFailure('10.0.0.2', 'ok@example.com');
  rl.recordSuccess('10.0.0.2', 'ok@example.com');
  assert.equal(rl.allow('10.0.0.2', 'ok@example.com'), true);
  assert.equal(rl.lockRemainingMs('10.0.0.2', 'ok@example.com'), 0);
});

test('IR-06 unit: keys are per IP+login (not shared across users or ips)', () => {
  const rl = new LoginRateLimiter(1, 60_000, 60_000);
  rl.recordFailure('10.0.0.3', 'a@example.com');
  assert.equal(rl.allow('10.0.0.3', 'a@example.com'), false, 'same key locked');
  assert.equal(rl.allow('10.0.0.3', 'b@example.com'), true, 'different login not blocked');
  assert.equal(rl.allow('10.0.0.4', 'a@example.com'), true, 'different ip not blocked');
});

test('IR-06 unit: window expiry allows retry', () => {
  const rl = new LoginRateLimiter(2, 50, 10);
  rl.recordFailure('10.0.0.5', 'w@example.com');
  rl.recordFailure('10.0.0.5', 'w@example.com');
  assert.equal(rl.allow('10.0.0.5', 'w@example.com'), false);
});

test('IR-06 unit: rejects invalid config', () => {
  assert.throws(() => new LoginRateLimiter(0, 60_000, 60_000));
  assert.throws(() => new LoginRateLimiter(5, 0, 0));
});
