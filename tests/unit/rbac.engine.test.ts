import { test } from 'node:test';
import assert from 'node:assert/strict';
import { can, authorize } from '../../src/rbac/engine.ts';
import { ACTIONS, ACTION_LABELS, MATRIX } from '../../src/rbac/matrix.ts';

// Matrix expectations derived from DESIGN-INC-001 §5 + implementation mapping.
// These tests are the AC-001 "prueba de acceso permitido/denegado" at unit
// level and protect the fail-closed default.

test('AC-001 unit: administration can do every declared action', () => {
  for (const action of ACTIONS) {
    assert.equal(can('administration', action), true, `administration should allow ${action}`);
  }
});

test('AC-001 unit: operation only creates/executes ops, reads/writes data and drives conversations (no approve/reject/users/audit)', () => {
  for (const action of ACTIONS) {
    const expected = [
      'operation.create', 'operation.execute', 'data.read', 'data.write',
      // INC-002/INC-003: opera el flujo conversacional y publica tras aprobación.
      'conversation.read', 'conversation.send', 'conversation.confirm',
      'website.publish', 'website.provision',
    ].includes(action);
    assert.equal(can('operation', action), expected, `operation ${action} expected ${expected}`);
  }
  // governance: aprobar/rechazar es solo administración (TENTATIVA, INC-001).
  assert.equal(can('operation', 'operation.approve'), false);
  assert.equal(can('operation', 'operation.reject'), false);
});

test('AC-001 unit: read_only can only read data and conversation state', () => {
  for (const action of ACTIONS) {
    const expected = action === 'data.read' || action === 'conversation.read';
    assert.equal(can('read_only', action), expected, `read_only ${action} expected ${expected}`);
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

test('AC-001 unit: matrix is complete (every declared ACTION is declared for at least one role)', () => {
  for (const action of ACTIONS) {
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
