/**
 * Boundary enforcement middleware (C2, T-005).
 * Order per request: requestContext -> resolveSession -> requireSession
 * -> rejectTenantOverride -> requirePermission. Each denial is controlled,
 * audited and answered with plain-language messages (AC-008).
 */

import type { NextFunction, Request, Response } from 'express';
import { newRequestContext, runWithRequestContext, getRequestContext, type SessionSummary } from '../shared/context.ts';
import { log } from '../shared/logger.ts';
import { AppError, denied, DENY_CODES } from '../shared/errors.ts';
import { getPool } from '../db/pool.ts';
import { AuditSink } from '../audit/sink.ts';
import { UNKNOWN_TENANT_ID, UNKNOWN_ACTOR_ID, type SessionResolver } from './session.ts';
import { authorize } from '../rbac/engine.ts';
import type { ActionName } from '../rbac/matrix.ts';
import type { IdentityRepository } from '../identity/repository.ts';

export interface LooseRequest extends Request {
  session?: SessionSummary | null;
  request_id?: string;
}

function requestInfo(req: LooseRequest): { request_id: string; session: SessionSummary | null } {
  const ctx = getRequestContext();
  if (ctx) return { request_id: ctx.request_id, session: ctx.session };
  return { request_id: req.request_id ?? 'no-ctx', session: req.session ?? null };
}

/** Opens a per-request AsyncLocalStorage context (correlation) and logs the answer. */
export function requestContext(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const rc = newRequestContext();
    (req as LooseRequest).request_id = rc.request_id;
    runWithRequestContext(rc, () => {
      const started = Date.now();
      res.on('finish', () => {
        log.info('http.request', `${req.method} ${req.path} -> ${res.statusCode}`, {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: Date.now() - started,
        });
      });
      next();
    });
  };
}

/** Resolves the session from the Bearer token BEFORE any data access.
 *  Missing/invalid session => deny (audited) + 401 — never a default-allow. */
export function resolveSession(
  resolver: SessionResolver,
  sink: AuditSink,
  pool = getPool(),
): (req: Request, res: Response, next: NextFunction) => void {
  return async (req, res, next) => {
    const lreq = req as LooseRequest;
    const rc = getRequestContext() ?? newRequestContext();
    const result = await resolver.resolve(req.headers.authorization);
    if (result.session) {
      lreq.session = result.session;
      rc.session = result.session;
      next();
      return;
    }
    const denyResult = result.reason === 'no_token' ? 'missing_actor' : `${result.reason}`;
    const message =
      result.reason === 'no_token'
        ? 'No se encontró una sesión activa. Vuelve a ingresar para continuar.'
        : result.reason === 'invalid_token'
          ? 'La sesión no es válida o expiró. Vuelve a ingresar.'
          : 'La sesión ya no está activa. Vuelve a ingresar.';
    try {
      await sink.write(
        {
          tenant_id: UNKNOWN_TENANT_ID,
          actor_id: UNKNOWN_ACTOR_ID,
          actor_role: null,
          action: 'session.resolve',
          resource: req.path,
          request_id: rc.request_id,
          decision: 'deny',
          result: denyResult,
        },
        pool,
        false, // best-effort: an auth failure must not wedge the response
      );
    } catch (err) {
      log.warn('session.deny.audit_failed', 'could not audit session denial', { error: (err as Error).message });
    }
    res.status(401).json({ error: { code: 'unauthorized', message } });
  };
}

/** Explicit fail-closed guard: no session => 401 (defense in depth). */
export function requireSession(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const lreq = req as LooseRequest;
    const rc = getRequestContext() ?? newRequestContext();
    if (!lreq.session) {
      res.status(401).json({
        error: { code: 'unauthorized', message: 'No se encontró un usuario con contexto activo. Vuelve a ingresar.' },
      });
      return;
    }
    rc.session = lreq.session;
    next();
  };
}

/** Fail-closed protection against attempts to force a tenant context that is
 *  not the session's own (simulated attack surface; AC-002 negative). */
export function rejectTenantOverride(pool = getPool()): (req: Request, res: Response, next: NextFunction) => void {
  return async (req, res, next) => {
    const lreq = req as LooseRequest;
    const rc = getRequestContext() ?? newRequestContext();
    const body = req.body && typeof req.body === 'object' ? (req.body as { tenant_id?: unknown }) : {};
    const forced = req.get('x-force-tenant') ?? (typeof body.tenant_id === 'string' ? body.tenant_id : undefined);
    if (forced && lreq.session && forced !== lreq.session.tenant_id) {
      await denyAndRespond(req, res, lreq, new AppError(403, DENY_CODES.TENANT_OVERRIDE,
        'La operación que intentas no está permitida: tu sesión pertenece a otro cliente.'), pool);
      return;
    }
    next();
  };
}

/** Permission check by context (C3, AC-001). Deny is controlled + audited. */
export function requirePermission(
  action: ActionName,
  sink: AuditSink,
  pool = getPool(),
): (req: Request, res: Response, next: NextFunction) => void {
  return async (req, res, next) => {
    const lreq = req as LooseRequest;
    const session = lreq.session;
    if (!session) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'No se encontró una sesión activa. Vuelve a ingresar.' } });
      return;
    }
    const decision = authorize(session.role_name as ActionNameWithRoleFallback, action);
    if (decision.allowed) {
      next();
      return;
    }
    await denyAndRespond(req, res, lreq, denied(DENY_CODES.PERMISSION_DENIED,
      'Tu perfil no permite esta acción. Si crees que es un error, comunícate con el administrador.'), pool);
  };
}

// Role names are validated at session creation; cast keeps the middleware
// generic while the engine enforces the matrix types.
type ActionNameWithRoleFallback = Parameters<typeof authorize>[0];

/** Shared deny path: audit deny + structured log + JSON error (plain language). */
export async function denyAndRespond(req: Request, res: Response, lreq: LooseRequest, err: AppError, pool: import('pg').Pool = getPool()): Promise<void> {
  const rc = getRequestContext() ?? newRequestContext();
  const session = lreq.session;
  err.audited = true;
  const resource = req.originalUrl ?? req.path;
  try {
    const sink = new AuditSink(pool);
    await sink.write(
      {
        tenant_id: session?.tenant_id ?? UNKNOWN_TENANT_ID,
        actor_id: session?.user_id ?? UNKNOWN_ACTOR_ID,
        actor_role: session?.role_name ?? null,
        action: 'access.deny',
        resource,
        request_id: rc.request_id,
        decision: 'deny',
        result: err.code,
      },
      pool,
      false,
    );
  } catch (auditErr) {
    log.warn('deny.audit_failed', 'could not audit denial', { error: (auditErr as Error).message, code: err.code });
  }
  log.warn('access.denied', `denied ${req.method} ${resource}`, {
    reason: err.code,
    action: 'access.deny',
    decision: 'deny',
    result: err.code,
  });
  res.status(err.status).json({ error: { code: err.code, message: err.userMessage } });
}
