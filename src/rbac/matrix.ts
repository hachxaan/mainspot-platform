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
  // INC-002 (CAP-005/CAP-008): flujo conversacional y aprobación.
  'conversation.read',
  'conversation.send',
  'conversation.confirm',
  // INC-003 (CAP-001/CAP-010): publicación web y aprovisionamiento de subdominio.
  'website.publish',
  'website.provision',
  // INC-004 (CAP-002/CAP-004): reputación y reseñas (DEC-011/023).
  'reputation.read',
  'reputation.respond',
  'reputation.escalate',
  'reputation.approve',
  'reputation.hide_review',
  // INC-005 (CAP-003): redes sociales (Facebook publicaciones/Ads; DEC-017).
  'social.read',
  'social.create',
  'social.schedule',
  'social.approve',
  'social.campaign_advanced',
  // INC-006 (CAP-012): suscripciones, planes y límites (DEC-024).
  'subscription.admin',
  'subscription.read',
  // INC-007 (CAP-014, base): analítica mínima y export ETL (DEC-025).
  'analytics.read',
  'analytics.export',
  // QS-0006 (DEC-0025): la retención es automática; solo se consulta su vista previa.
  'analytics.retention',
  // DEV-E2E-02: agente de atención por políticas y avisos por Telegram (SHARED-CONTRACT §B).
  'engagement.read',
  'engagement.respond',
  'engagement.approve',
  'engagement.policy.manage',
  'telegram.link',
] as const;

export type ActionName = (typeof ACTIONS)[number];

/**
 * Acciones que EXISTEN en el catálogo pero están BLOQUEADAS para TODOS los
 * roles (fail-closed): aun el perfil administration no las recibe. Ejemplos:
 * manipulación de reseñas (ocultar/borrar opiniones) y campañas avanzadas.
 */
export const BLOCKED_ACTIONS: readonly ActionName[] = [
  'reputation.hide_review',
  'social.campaign_advanced',
] as const;

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
  administration: ACTIONS.filter((a) => !BLOCKED_ACTIONS.includes(a)),
  operation: [
    'operation.create',
    'operation.execute',
    'data.read',
    'data.write',
    'conversation.read',
    'conversation.send',
    'conversation.confirm',
    'website.publish',
    'website.provision',
    'reputation.read',
    'reputation.respond',
    'reputation.escalate',
    'social.read',
    'social.create',
    'social.schedule',
    'subscription.read',
    'analytics.read',
    'engagement.read',
    'engagement.respond',
    'telegram.link',
  ],
  read_only: ['data.read', 'conversation.read', 'reputation.read', 'social.read', 'subscription.read', 'analytics.read', 'engagement.read'],
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
  'conversation.read': 'Ver solicitudes y propuestas del cliente',
  'conversation.send': 'Enviar y recibir mensajes del canal',
  'conversation.confirm': 'Confirmar una propuesta y preparar su vista previa',
  'website.publish': 'Publicar la web del cliente',
  'website.provision': 'Aprovisionar el subdominio del cliente',
  'reputation.read': 'Ver reseñas y casos de reputación',
  'reputation.respond': 'Redactar o editar borradores de respuesta pública',
  'reputation.escalate': 'Escalar una reseña o caso sensible a revisión humana',
  'reputation.approve': 'Aprobar la respuesta pública a una reseña',
  'reputation.hide_review': 'Ocultar o borrar una reseña (BLOQUEADO: sin manipulación de opiniones)',
  'social.read': 'Ver publicaciones y contenido social',
  'social.create': 'Crear borradores de publicaciones sociales',
  'social.schedule': 'Programar publicaciones sociales con aprobación',
  'social.approve': 'Aprobar una publicación social para revisión y vista previa',
  'social.campaign_advanced': 'Crear campañas avanzadas en redes (BLOQUEADO: fuera del MVP)',
  'subscription.admin': 'Asignar el plan de suscripción del cliente y gestionar su facturación',
  'subscription.read': 'Ver el plan y los límites del cliente',
  'analytics.read': 'Ver resúmenes de actividad del cliente',
  'analytics.export': 'Exportar eventos de auditoría del cliente',
  'analytics.retention': 'Ver qué datos purgará la retención automática',
  'engagement.read': 'Ver casos del agente de atención y sus políticas',
  'engagement.respond': 'Editar borradores de respuesta de un caso',
  'engagement.approve': 'Aprobar o rechazar la respuesta pública de un caso',
  'engagement.policy.manage': 'Activar o revocar respuestas automáticas seguras',
  'telegram.link': 'Vincular el propio chat de Telegram para avisos',
};

export const ROLE_LABELS: Record<RoleName, string> = {
  administration: 'Administración',
  operation: 'Operación',
  read_only: 'Solo lectura',
};

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  administration: 'Puede gestionar usuarios, configuración y auditoría, y ejecutar todas las acciones del panel (salvo las bloqueadas por diseño).',
  operation: 'Puede ver y registrar datos del cliente, ejecutar operaciones, gestionar reseñas y contenido social; no gestiona usuarios, auditoría ni aprobaciones finales.',
  read_only: 'Puede ver los datos del cliente que su contexto le permite; no puede modificar nada.',
};
