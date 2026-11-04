/**
 * Permisos explícitos de plataforma (BR-0007 × DEC-0075/SRC-0013 authority): cada acción del catálogo de
 * planes se autoriza por permiso, no por rol suelto. Escribir exige además step-up TOTP y motivo. Ver
 * identidades de negocios (ids, nombres) es `tenants.read`: ai_engineer solo ve recuentos (mínimo privilegio).
 * Ninguno concede facturación, precios, cobros, créditos ni secretos; el negocio no tiene ninguno.
 */

import type { Pool } from 'pg';
import { PLATFORM_ROLES, requirePlatform, type PlatformAuth, type PlatformRole } from './auth.ts';

export const PLATFORM_PERMISSIONS = {
  /** Ver catálogo, parámetros, revisiones, diffs, impacto e historial. */
  'plans.read': ['platform_admin', 'ai_engineer', 'platform_support'],
  /** Crear y clonar planes, abrir/editar/descartar borradores y confirmar valores. */
  'plans.edit': ['platform_admin', 'ai_engineer'],
  /** Publicar, revertir (rollback), habilitar/deshabilitar y cambiar nombre o descripción (los negocios lo ven al instante). */
  'plans.publish': ['platform_admin', 'ai_engineer'],
  /** Asignar planes a negocios y migrar suscripciones a la revisión publicada (MainSpot Administration). */
  'subscriptions.assign': ['platform_admin'],
  /** Ver identidades de negocios (ids, nombres, detalle y vista previa de migración por negocio). */
  'tenants.read': ['platform_admin', 'platform_support'],
} as const satisfies Record<string, readonly PlatformRole[]>;

export type PlatformPermission = keyof typeof PLATFORM_PERMISSIONS;

export function permissionsOf(roles: readonly string[]): PlatformPermission[] {
  return (Object.keys(PLATFORM_PERMISSIONS) as PlatformPermission[])
    .filter((p) => PLATFORM_PERMISSIONS[p].some((r) => roles.includes(r)));
}

/** Middleware: sesión de plataforma + permiso (+ step-up para escrituras). Deny auditado con el permiso. */
export function requirePlatformPermission(auth: PlatformAuth, pool: Pool, permission: PlatformPermission, opts: { stepUp?: boolean } = {}) {
  const roles = PLATFORM_ROLES.filter((r) => (PLATFORM_PERMISSIONS[permission] as readonly PlatformRole[]).includes(r));
  return requirePlatform(auth, pool, roles, { action: permission, stepUp: opts.stepUp });
}
