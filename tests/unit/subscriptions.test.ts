/**
 * Unit — INC-006 subscriptions: lógica pura de límites (DEC-024), proveedor de
 * pago simulado sin efecto externo y permisos por rol.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitsLimit, KNOWN_CAPABILITIES } from '../../src/subscriptions/entitlements.ts';
import { SimulatedPaymentProvider } from '../../src/subscriptions/payment.ts';
import { authorize } from '../../src/rbac/engine.ts';

test('subscriptions: límites fail-closed puros (usage + units > max ⇒ deny)', () => {
  // Sin límite configurado ⇒ deny (nada no-listado se permite).
  assert.equal(fitsLimit(null, 0), false);
  // Una unidad: permitido solo si todavía cabe otra.
  assert.equal(fitsLimit(10, 0), true);
  assert.equal(fitsLimit(10, 9), true);
  assert.equal(fitsLimit(10, 10), false);
  assert.equal(fitsLimit(1, 1), false, 'al alcanzar el máximo no se permite crear más');
  assert.equal(fitsLimit(0, 0), false, 'límite cero ⇒ nada permitido');
  // Lotes (DEC-0005): el lote entero cabe o no se consume nada.
  assert.equal(fitsLimit(10, 6, 4), true, 'exactamente hasta el máximo');
  assert.equal(fitsLimit(10, 7, 4), false, 'un lote que se pasa por una unidad se rechaza entero');
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
