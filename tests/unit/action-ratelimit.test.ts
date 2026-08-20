/**
 * Unit — ActionRateLimiter (aprobaciones sensibles, INC-002).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionRateLimiter } from '../../src/boundary/action-ratelimit.ts';

test('action limiter: permite hasta max en la ventana y bloquea después (aprobación sensible)', () => {
  const limiter = new ActionRateLimiter(3, 60_000, 30_000);
  assert.equal(limiter.allow('ip1', 'user_a', 'prop_1'), true);
  limiter.recordAttempt('ip1', 'user_a', 'prop_1');
  assert.equal(limiter.allow('ip1', 'user_a', 'prop_1'), true);
  limiter.recordAttempt('ip1', 'user_a', 'prop_1');
  assert.equal(limiter.allow('ip1', 'user_a', 'prop_1'), true);
  limiter.recordAttempt('ip1', 'user_a', 'prop_1');
  assert.equal(limiter.allow('ip1', 'user_a', 'prop_1'), false, 'bloqueado tras max');
  assert.ok(limiter.lockRemainingMs('ip1', 'user_a', 'prop_1') > 0);
});

test('action limiter: llaves por ip+actor+recurso (no comparten estado)', () => {
  const limiter = new ActionRateLimiter(1, 60_000, 30_000);
  limiter.recordAttempt('ip1', 'user_a', 'prop_1');
  assert.equal(limiter.allow('ip1', 'user_a', 'prop_1'), false);
  assert.equal(limiter.allow('ip2', 'user_a', 'prop_1'), true, 'otra ip no bloqueada');
  assert.equal(limiter.allow('ip1', 'user_b', 'prop_1'), true, 'otro actor no bloqueado');
  assert.equal(limiter.allow('ip1', 'user_a', 'prop_2'), true, 'otro recurso no bloqueado');
});

test('action limiter: ventana expira y permite reintentar', () => {
  const limiter = new ActionRateLimiter(2, 50, 20);
  limiter.recordAttempt('ip', 'u', 'r');
  limiter.recordAttempt('ip', 'u', 'r');
  assert.equal(limiter.allow('ip', 'u', 'r'), false);
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      // lockMs (20ms) expiró y la ventana (50ms) ya venció ⇒ se resetea.
      assert.equal(limiter.allow('ip', 'u', 'r'), true, 'lock+ventana expirados ⇒ allow');
      resolve();
    }, 80);
  });
});

test('action limiter: configuración inválida falla rápido', () => {
  assert.throws(() => new ActionRateLimiter(0, 100, 100));
  assert.throws(() => new ActionRateLimiter(5, 0, 100));
  assert.throws(() => new ActionRateLimiter(5, 100, -1));
});
