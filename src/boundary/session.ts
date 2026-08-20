/**
 * Tenant/actor resolution (C2, T-004). Principle (canonical, non-negotiable):
 * resolve client AND actor BEFORE any data access. Missing context => denial.
 *
 * Flow: JWT (own minimal HS256) is a signed reference to a server-side
 * session row; every request re-validates the session AND that the user, role
 * activation and tenant are still active (fail-closed, no default-allow).
 */

import type { SessionSummary } from '../shared/context.ts';
import { verifySessionToken, type JwtClaims } from '../shared/jwt.ts';
import type { IdentityRepository } from '../identity/repository.ts';

export const UNKNOWN_TENANT_ID = 'unknown';
export const UNKNOWN_ACTOR_ID = 'unknown';

export interface ResolveResult {
  session: SessionSummary | null;
  reason: 'ok' | 'no_token' | 'invalid_token' | 'session_revoked' | 'binding_invalid' | 'tenant_suspended' | 'user_inactive';
}

export class SessionResolver {
  private readonly repo: IdentityRepository;
  private readonly jwtSecret: string;

  constructor(repo: IdentityRepository, jwtSecret: string) {
    this.repo = repo;
    this.jwtSecret = jwtSecret;
  }

  async resolve(header: string | undefined): Promise<ResolveResult> {
    const token = (() => {
      if (!header) return null;
      const m = /^Bearer\s+(.+)$/i.exec(header.trim());
      return m?.[1] ?? null;
    })();

    if (!token) return { session: null, reason: 'no_token' };

    let claims: JwtClaims;
    try {
      claims = verifySessionToken(token, this.jwtSecret);
    } catch {
      return { session: null, reason: 'invalid_token' };
    }

    const row = await this.repo.resolveSession(claims.sid);
    if (!row) return { session: null, reason: 'session_revoked' };

    // Re-validate bindings on every request (fail-closed on revocation).
    const valid = await this.repo.validateSessionBindings(row.user_id, row.tenant_id, row.role_id);
    if (!valid) return { session: null, reason: 'binding_invalid' };

    return {
      session: {
        session_id: row.session_id,
        user_id: row.user_id,
        tenant_id: row.tenant_id,
        role_id: row.role_id,
        role_name: row.role_id,
        permissions: row.permissions,
        source: row.source,
        issued_at: row.issued_at,
        expires_at: row.expires_at,
      },
      reason: 'ok',
    };
  }
}
