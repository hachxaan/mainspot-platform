/**
 * Declarative RBAC matrix (C3) — role × context × action.
 * Based on DESIGN-INC-001 §5 (TENTATIVA, ajustado a implementación).
 *
 * FAIL-CLOSED: any action NOT listed => deny (default deny).
 * The tenant context always applies above the role: a role allowed in client A
 * grants nothing in client B (enforced by the boundary layer, not here).
 */

import type { RoleName } from '../identity/entities.ts';

export const ACTIONS = [
  'user.manage',
  'client.config.manage',
  'audit.read',
  'audit.export',
  'operation.create',
  'operation.execute',
  'operation.approve',
  'operation.reject',
  'data.read',
  'data.write',
] as const;

export type ActionName = (typeof ACTIONS)[number];

export interface MatrixEntry {
  role: RoleName;
  action: ActionName;
  /** v1: context is '*'; granular resource contexts arrive with future modules (Q-008/PEND-009). */
  resource: string;
  effect: 'allow' | 'deny';
}

/**
 * Source of truth for authorization. role_permission rows in the DB mirror
 * this matrix for transparency/export and MUST stay in sync (validated by an
 * integration test).
 */
export const MATRIX: Record<RoleName, readonly ActionName[]> = {
  administration: [...ACTIONS],
  operation: ['operation.create', 'operation.execute', 'data.read', 'data.write'],
  read_only: ['data.read'],
};

export const ALLOWED_EFFECT = 'allow' as const;
export const DEFAULT_EFFECT = 'deny' as const;

export function toMatrixEntries(): MatrixEntry[] {
  const entries: MatrixEntry[] = [];
  for (const role of Object.keys(MATRIX) as RoleName[]) {
    for (const action of MATRIX[role]) {
      entries.push({ role, action, resource: '*', effect: ALLOWED_EFFECT });
    }
  }
  return entries;
}

/** Human-readable plain-language label for each action (AC-008). */
export const ACTION_LABELS: Record<ActionName, string> = {
  'user.manage': 'Gestionar usuarios y roles',
  'client.config.manage': 'Configurar el cliente',
  'audit.read': 'Ver el registro de auditoría',
  'audit.export': 'Exportar el registro de auditoría',
  'operation.create': 'Crear una operación de prueba',
  'operation.execute': 'Ejecutar operaciones',
  'operation.approve': 'Aprobar operaciones',
  'operation.reject': 'Rechazar operaciones',
  'data.read': 'Ver los datos del cliente',
  'data.write': 'Registrar datos del cliente',
};

export const ROLE_LABELS: Record<RoleName, string> = {
  administration: 'Administración',
  operation: 'Operación',
  read_only: 'Solo lectura',
};

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  administration: 'Puede gestionar usuarios, configuración y auditoría, y ejecutar todas las acciones del panel.',
  operation: 'Puede ver y registrar datos del cliente, y ejecutar operaciones; no gestiona usuarios ni auditoría.',
  read_only: 'Puede ver los datos del cliente que su contexto le permite; no puede modificar nada.',
};
