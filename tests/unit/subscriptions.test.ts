/**
 * Unit — INC-006 subscriptions: lógica pura de límites (DEC-024), proveedor de
 * pago simulado sin efecto externo y permisos por rol.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageWithinLimit, KNOWN_CAPABILITIES } from '../../src/subscriptions/entitlements.ts';
import { SimulatedPaymentProvider } from '../../src/subscriptions/payment.ts';
import { authorize } from '../../src/rbac/engine.ts';

test('subscriptions: límites fail-closed puros (usage >= max ⇒ deny)', () => {
  // Sin límite configurado ⇒ deny (nada no-listado se permite).
  assert.equal(usageWithinLimit(null, 0), false);
  // Con límite: permitido solo si usage < max (todavía cabe otro).
  assert.equal(usageWithinLimit(10, 0), true);
  assert.equal(usageWithinLimit(10, 9), true);
  assert.equal(usageWithinLimit(10, 10), false);
  assert.equal(usageWithinLimit(1, 1), false, 'al alcanzar el máximo no se permite crear más');
  assert.equal(usageWithinLimit(0, 0), false, 'límite cero ⇒ nada permitido');
});

test('subscriptions: catálogo de capacidades conocido y estable', () => {
  for (const c of ['website', 'social_posts', 'social_ads', 'reviews_managed', 'agents', 'conversations']) {
    assert.ok((KNOWN_CAPABILITIES as readonly string[]).includes(c), `capability ${c}`);
  }
});

test('subscriptions: SimulatedPaymentProvider siempre ok, sin llamadas externas', async () => {
  const p = new SimulatedPaymentProvider();
  const r = await p.charge({ tenantId: 'client_a', subscriptionId: 'sub_a', amountCents: 9900, currency: 'PEN' });
  assert.equal(r.ok, true);
  assert.equal(r.simulated, true, 'pago simulado (piloto sin cobro real)');
  assert.ok(r.external_ref.startsWith('sim_pay:'));
  const r2 = await p.charge({ tenantId: 'client_a', subscriptionId: 'sub_a', amountCents: 9900, currency: 'PEN' });
  assert.equal(r.external_ref, r2.external_ref, 'determinista');
});

test('subscriptions: asignar plan/facturar es admin; leer entitlements es para todos', () => {
  assert.equal(authorize('administration', 'subscription.admin').allowed, true);
  assert.equal(authorize('operation', 'subscription.admin').allowed, false);
  assert.equal(authorize('read_only', 'subscription.admin').allowed, false);
  assert.equal(authorize('read_only', 'subscription.read').allowed, true);
  assert.equal(authorize('operation', 'subscription.read').allowed, true);
});
