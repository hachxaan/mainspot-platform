import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, authorize } from '../../src/rbac/engine.ts';
import { ACTIONS, ACTION_LABELS, BLOCKED_ACTIONS, MATRIX } from '../../src/rbac/matrix.ts';

// Matrix expectations derived from DESIGN-INC-001 §5 + implementation mapping.
// These tests are the AC-001 "prueba de acceso permitido/denegado" at unit
// level and protect the fail-closed default (INC-004/005/006/007 amplían la
// matriz; las acciones BLOCKED_ACTIONS no se conceden a ningún rol).

test('AC-001 unit: administration can do every declared action except blocked ones', () => {
  for (const action of ACTIONS) {
    if (BLOCKED_ACTIONS.includes(action)) {
      assert.equal(can('administration', action), false, `administration must NOT allow blocked ${action}`);
      continue;
    }
    assert.equal(can('administration', action), true, `administration should allow ${action}`);
  }
});

test('AC-001 unit: operation creates/executes ops, reads/writes data, drives conversations and rep/social/subs/analytics reading (no approve/advanced)', () => {
  for (const action of ACTIONS) {
    const expected = [
      'operation.create', 'operation.execute', 'data.read', 'data.write',
      // INC-002/INC-003: opera el flujo conversacional y publica tras aprobación.
      'conversation.read', 'conversation.send', 'conversation.confirm',
      'website.publish', 'website.provision',
      // INC-004/005/006/007: opera reputación y social, lee suscripción y analítica.
      'reputation.read', 'reputation.respond', 'reputation.escalate',
      'social.read', 'social.create', 'social.schedule',
      'subscription.read', 'analytics.read',
    ].includes(action);
    assert.equal(can('operation', action), expected, `operation ${action} expected ${expected}`);
  }
  // governance: aprobar/rechazar es solo administración (TENTATIVA, INC-001).
  assert.equal(can('operation', 'operation.approve'), false);
  assert.equal(can('operation', 'operation.reject'), false);
});

test('AC-001 unit: read_only can read data, conversation, reputation, social, subscription and analytics', () => {
  for (const action of ACTIONS) {
    const expected = [
      'data.read', 'conversation.read',
      'reputation.read', 'social.read', 'subscription.read', 'analytics.read',
    ].includes(action);
    assert.equal(can('read_only', action), expected, `read_only ${action} expected ${expected}`);
  }
});

test('AC-001 unit: blocked actions (hide reviews / advanced campaigns) are denied for EVERY role', () => {
  for (const role of Object.keys(MATRIX) as (keyof typeof MATRIX)[]) {
    for (const action of BLOCKED_ACTIONS) {
      assert.equal(authorize(role, action).allowed, false, `${role} must not ${action}`);
      assert.equal(MATRIX[role].includes(action), false, `matrix has no grant of ${action} for ${role}`);
    }
  }
});

test('AC-001 unit: deny cases (user.manage / audit.read / data.write by role)', () => {
  assert.equal(can('operation', 'user.manage'), false);
  assert.equal(can('operation', 'audit.read'), false);
  assert.equal(can('read_only', 'data.write'), false);
  assert.equal(can('read_only', 'operation.execute'), false);
  assert.equal(can('read_only', 'audit.read'), false);
});

test('AC-001 unit: fail-closed default deny for unknown action', () => {
  // @ts-expect-error -- deliberate: unknown action at type level
  assert.equal(can('administration', 'billing.charge'), false);
  // @ts-expect-error -- deliberate
  assert.equal(can('read_only', 'billing.charge'), false);
});

test('AC-001 unit: fail-closed default deny for unknown/missing role', () => {
  assert.equal(can(null, 'data.read'), false);
  assert.equal(can('superadmin' as never, 'data.read'), false);
});

test('AC-001 unit: authorize() returns structured reasons', () => {
  assert.deepEqual(authorize('read_only', 'data.read'), { allowed: true, role: 'read_only', action: 'data.read', reason: 'allowed' });
  assert.equal(authorize('read_only', 'data.write').reason, 'denied_by_matrix');
  assert.equal(authorize(null, 'data.read').reason, 'unknown_role');
  assert.equal(authorize('read_only', 'missing.action' as never).reason, 'denied_by_matrix');
});

test('AC-001 unit: matrix is complete (every usable ACTION is declared for at least one role)', () => {
  for (const action of ACTIONS) {
    if (BLOCKED_ACTIONS.includes(action)) continue; // bloqueadas por diseño
    const anyRole = (Object.keys(MATRIX) as (keyof typeof MATRIX)[]).some((r) => MATRIX[r].includes(action));
    assert.equal(anyRole, true, `action ${action} not declared in any role`);
  }
});

test('AC-001 unit: role labels are plain language for UX (AC-008)', () => {
  // ACTION_LABELS must exist for every action to keep the UI non-technical.
  for (const action of ACTIONS) {
    assert.ok(ACTION_LABELS[action] && ACTION_LABELS[action].length > 0, `label missing for ${action}`);
  }
});
