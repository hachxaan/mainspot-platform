/**
 * Application errors with user-facing (plain-language) messages.
 * Codes are stable contract values used in audit events and API responses.
 */

export const DENY_CODES = {
  MISSING_CONTEXT: 'missing_client_context',
  MISSING_ACTOR: 'missing_actor',
  INVALID_ROLE: 'invalid_role',
  PERMISSION_DENIED: 'permission_denied',
  TENANT_BOUNDARY: 'tenant_boundary_denied',
  TENANT_OVERRIDE: 'tenant_override_attempt',
  NOT_FOUND: 'not_found',
  INVALID_CREDENTIALS: 'invalid_credentials',
  AUDIT_FAILED: 'audit_failed',
  INTERNAL: 'internal_error',
  // INC-004/005/006/007 — códigos de deny de dominio nuevos (DEC-023/024/025/026).
  PROHIBITED: 'prohibited',
  LIMIT_EXCEEDED: 'limit_exceeded',
  SUBSCRIPTION_REQUIRED: 'subscription_required',
} as const;

export type DenyCode = (typeof DENY_CODES)[keyof typeof DENY_CODES];

export class AppError extends Error {
  readonly status: number;
  readonly code: DenyCode | 'validation_error';
  /** Plain-language message for non-technical users (AC-008). */
  readonly userMessage: string;
  /** True when this error already produced an audit 'deny' event (avoid double audit). */
  audited = false;

  constructor(status: number, code: DenyCode | 'validation_error', userMessage: string) {
    super(userMessage);
    this.status = status;
    this.code = code;
    this.userMessage = userMessage;
  }
}

export function denied(code: DenyCode, userMessage: string, status = 403): AppError {
  return new AppError(status, code, userMessage);
}

/** True when the error is a PostgreSQL unique violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
