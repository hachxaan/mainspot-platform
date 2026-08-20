/**
 * Permission engine (C3) — pure, unit-testable.
 * can(role, action) uses the declarative MATRIX; unknown actions and missing
 * contexts resolve to deny (fail-closed).
 */

import type { RoleName } from '../identity/entities.ts';
import { MATRIX, DEFAULT_EFFECT, type ActionName } from './matrix.ts';

export interface AuthorizationDecision {
  allowed: boolean;
  role: RoleName | null;
  action: ActionName | null;
  reason: 'allowed' | 'unknown_role' | 'unknown_action' | 'denied_by_matrix';
}

/** Check authorization for an action in the CURRENT tenant context.
 *  The caller must already have resolved tenant + actor (boundary layer). */
export function can(role: RoleName | null, action: ActionName): boolean {
  if (!role) return false;
  const row = MATRIX[role];
  if (!row) return false;
  return row.includes(action);
}

/** Decision with a structured reason (used by audit events). */
export function authorize(role: RoleName | null, action: ActionName): AuthorizationDecision {
  if (!role) return { allowed: false, role: null, action, reason: 'unknown_role' };
  if (!MATRIX[role]) return { allowed: false, role, action, reason: 'unknown_role' };
  if (!MATRIX[role].includes(action)) {
    return { allowed: false, role, action, reason: MATRIX[role] ? 'denied_by_matrix' : 'unknown_action' };
  }
  return { allowed: true, role, action, reason: 'allowed' };
}

export { DEFAULT_EFFECT };
