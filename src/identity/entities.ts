/**
 * Identity/Tenant domain model (C1) — minimal v1 entities.
 * Attribute names follow DESIGN-INC-001 §3 (marcadas TENTATIVA en el plan)
 * and the canonical INVARIANT: audit never exposes credentials/secrets.
 */

/** Client / tenant. The tenant boundary anchor (REQ-008, NFR-002). */
export interface Client {
  client_id: string;
  business_name: string;
  status: 'active' | 'suspended';
  /** Sensitive — stored, never emitted to audit/logs. */
  contact_email: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Explicit tenant boundary marker (DESIGN-INC-001 §3). */
export interface TenantContext {
  tenant_context_id: string;
  client_id: string;
  config: Record<string, unknown>;
  status: 'active' | 'suspended';
  created_at: string;
}

/** Internal backoffice user (REQ-010, DEC-009). */
export interface InternalUser {
  user_id: string;
  display_name: string;
  /** Sensitive — stored, never emitted to audit/logs. */
  login: string;
  status: 'active' | 'suspended';
  /** Sensitive — password hash (pgcrypto bcrypt); never emitted to audit/logs. */
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export const ROLE_NAMES = ['administration', 'operation', 'read_only'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** Backoffice role (administration / operation / read_only) — AC-001. */
export interface Role {
  role_id: RoleName;
  name: RoleName;
  description: string | null;
  created_at: string;
}

/** A role<->tenant activation (a user holds a role within a tenant). */
export interface UserRole {
  user_id: string;
  role_id: RoleName;
  tenant_id: string;
  granted_at: string;
}

/** Server-side session row referenced by the JWT. */
export interface SessionContext {
  session_id: string;
  user_id: string;
  tenant_id: string;
  role_id: RoleName;
  /** Snapshot of the role permissions at session creation (informational; authz always re-checks the code matrix). */
  permissions: string[];
  source: string;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}
