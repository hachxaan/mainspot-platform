/**
 * Evidence hooks for INC-002 (C5, T-015).
 *
 * These contracts expose INC-001 foundations that later increments will use:
 *   - resolve_identity(request): client + user + role from a request/session
 *   - check_authorization(actor, tenant, action, resource): truth of permission
 *   - audit_sink(event): receive/persist audit events with correlation
 *
 * SCOPE: interfaces + thin adapters only. NO consumers are implemented here
 * (INC-002 is out of scope). Validated by a stub consumer in smoke tests.
 */

import type { Pool } from 'pg';
import { AuditSink } from '../audit/sink.ts';
import type { AuditEventInput, AuditEventRow } from '../audit/event.ts';
import { can, authorize } from '../rbac/engine.ts';
import type { ActionName } from '../rbac/matrix.ts';
import { RbacRepository } from '../rbac/repository.ts';
import { IdentityRepository } from '../identity/repository.ts';
import type { SessionSummary } from '../shared/context.ts';
import { SessionResolver } from '../boundary/session.ts';
import type { RoleName } from '../identity/entities.ts';

// --- Contract types (used by INC-002; stable surface) ---------------------

export interface ResolvedIdentity {
  user_id: string;
  tenant_id: string;
  role_id: RoleName;
  permissions: readonly string[];
  session: SessionSummary;
}

export interface AuthorizationResult {
  allowed: boolean;
  reason: string;
}

export type AuditSinkFn = (event: AuditEventInput) => Promise<AuditEventRow>;

// --- Adapters (real INC-001 implementations behind the contract) ----------

export class IdentityHook {
    private readonly resolver: SessionResolver;

  constructor(resolver: SessionResolver) {
    this.resolver = resolver;
  }


  /** resolve_identity(request) — for INC-002 flows that carry a session/header. */
  async resolveIdentity(authorizationHeader: string | undefined): Promise<ResolvedIdentity | null> {
    const result = await this.resolver.resolve(authorizationHeader);
    if (!result.session) return null;
    const s = result.session;
    return {
      user_id: s.user_id,
      tenant_id: s.tenant_id,
      role_id: s.role_id as RoleName,
      permissions: s.permissions,
      session: s,
    };
  }
}

export class AuthorizationHook {
  /** check_authorization(actor, tenant, action, resource) — matrix truth + fail-closed. */
  checkAuthorization(actor: { role_id: RoleName }, _tenantId: string, action: ActionName, _resource: string): AuthorizationResult {
    const decision = authorize(actor.role_id, action);
    return { allowed: decision.allowed, reason: decision.reason };
  }

  // Re-export of the pure primitive keeps INC-002 from touching internals.
  can: typeof can = can;
}

export class AuditHook {
  private readonly sink: AuditSink;
  private readonly pool: Pool;

  constructor(sink: AuditSink, pool: Pool) {
    this.sink = sink;
    this.pool = pool;
  }

  /** audit_sink(event) — persist an event with correlation (request_id). */
  auditSink(event: AuditEventInput): Promise<AuditEventRow> {
    return this.sink.write(event);
  }

  /** Correlation query for INC-002 (list events by request_id within tenant). */
  async eventsForRequest(tenantId: string, requestId: string): Promise<AuditEventRow[]> {
    const res = await this.pool.query<AuditEventRow>(
      'SELECT * FROM audit_event WHERE tenant_id = $1 AND request_id = $2 ORDER BY ts, event_id',
      [tenantId, requestId],
    );
    return res.rows;
  }

  // Re-exported permission mirror for external integrations teams.
  permissionMirror(repo: RbacRepository, role: RoleName): Promise<string[]> {
    return repo.permissionsForRole(role);
  }
}

/** Composed INC-001 surface for INC-002 consumers. */
export interface Inc001Hooks {
  identity: IdentityHook;
  authorization: AuthorizationHook;
  audit: AuditHook;
}

export function buildInc001Hooks(deps: {
  pool: Pool;
  jwtSecret: string;
  sink: AuditSink;
}): Inc001Hooks {
  const identityRepo = new IdentityRepository(deps.pool);
  return {
    identity: new IdentityHook(new SessionResolver(identityRepo, deps.jwtSecret)),
    authorization: new AuthorizationHook(),
    audit: new AuditHook(deps.sink, deps.pool),
  };
}
