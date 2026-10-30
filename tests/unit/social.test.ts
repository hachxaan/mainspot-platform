/**
 * Unit — INC-005 social: SimulatedMeta determinista/idempotente, página fija
 * por tenant y campaña avanzada BLOQUEADA (fail-closed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedMeta } from '../../src/social/simulated.ts';
import { BLOCKED_ACTIONS, MATRIX } from '../../src/rbac/matrix.ts';
import { authorize } from '../../src/rbac/engine.ts';
import { ROLE_NAMES, type RoleName } from '../../src/identity/entities.ts';

test('social: SimulatedMeta página fija por tenant y sin aleatoriedad', async () => {
  const m = new SimulatedMeta();
  const a1 = await m.getPage('client_a');
  const a2 = await m.getPage('client_a');
  assert.deepEqual(a1, a2, 'determinista');
  assert.equal(a1.page_id, 'fb_page_a');
  assert.ok(a1.page_name.length > 0);
  const b = await m.getPage('client_b');
  assert.equal(b.page_id, 'fb_page_b');
  assert.notEqual(a1.page_id, b.page_id);
});

test('social: publishPost determinista e idempotente por contenido (AC-007 patrón)', async () => {
  const m = new SimulatedMeta();
  const input = { tenantId: 'client_a', text: 'Hola, hoy tenemos lomo saltado', contentType: 'post' as const, imageUrl: null };
  const r1 = await m.publishPost(input);
  const r2 = await m.publishPost(input);
  assert.equal(r1.ok, true);
  assert.equal(r1.external_ref, r2.external_ref, 'mismo contenido ⇒ mismo ref');
  const r3 = await m.publishPost({ ...input, text: 'Hola, hoy tenemos ají de gallina' });
  assert.notEqual(r1.external_ref, r3.external_ref, 'contenido distinto ⇒ ref distinto');
});


test('social: campaña avanzada BLOQUEADA para todos los roles (fail-closed)', () => {
  assert.ok(BLOCKED_ACTIONS.includes('social.campaign_advanced'));
  for (const role of ROLE_NAMES as readonly RoleName[]) {
    assert.equal(authorize(role, 'social.campaign_advanced').allowed, false, `role ${role} cannot create advanced campaigns`);
    assert.equal(MATRIX[role].includes('social.campaign_advanced'), false);
  }
});

test('social: administración aprueba publicaciones; read_only no crea', () => {
  assert.equal(authorize('administration', 'social.approve').allowed, true);
  assert.equal(authorize('operation', 'social.approve').allowed, false, 'operación no aprueba publicaciones sociales');
  assert.equal(authorize('operation', 'social.create').allowed, true);
  assert.equal(authorize('read_only', 'social.create').allowed, false);
  assert.equal(authorize('read_only', 'social.read').allowed, true);
});
