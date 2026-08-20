/**
 * HTTP API (minimal backoffice) — AC-001/AC-002/AC-003/AC-008.
 * Every route: session resolved -> tenant override rejected -> permission
 * checked -> action executed and audited (sensitive actions fail-closed via
 * auditedOperation). Tenant scope always comes from the session; body/params
 * never change it.
 */

import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from '../shared/config.ts';
import { getRequestContext, type SessionSummary } from '../shared/context.ts';
import { AppError, DENY_CODES, isUniqueViolation } from '../shared/errors.ts';
import { AuditSink, auditedOperation } from '../audit/sink.ts';
import { AuditQuery } from '../audit/query.ts';
import { IdentityRepository } from '../identity/repository.ts';
import { ROLE_NAMES, type RoleName } from '../identity/entities.ts';
import { MATRIX, ROLE_LABELS, ROLE_DESCRIPTIONS } from '../rbac/matrix.ts';
import { DemoActionRepository, TenantDataRepository, type DemoActionRow } from '../boundary/datasource.ts';
import { LoginRateLimiter } from '../boundary/ratelimit.ts';
import { SessionResolver, UNKNOWN_ACTOR_ID } from '../boundary/session.ts';
import { type LooseRequest, requirePermission } from '../boundary/middleware.ts';
import { signSessionToken } from '../shared/jwt.ts';
import { log } from '../shared/logger.ts';

interface RouteDeps {
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  identityRepo: IdentityRepository;
  sessionResolver: SessionResolver;
  dataRepo: TenantDataRepository;
  actionRepo: DemoActionRepository;
  loginRateLimiter: LoginRateLimiter;
}

function rcOf(lreq: LooseRequest): { request_id: string; session: SessionSummary | null } {
  const ctx = getRequestContext();
  if (ctx) return { request_id: ctx.request_id, session: ctx.session };
  return { request_id: lreq.request_id ?? 'no-ctx', session: lreq.session ?? null };
}

function sessionOf(lreq: LooseRequest): SessionSummary {
  if (!lreq.session) throw new AppError(401, DENY_CODES.MISSING_ACTOR, 'No se encontró una sesión activa.');
  return lreq.session;
}

/** Wraps async handlers so rejections reach the central error handler. */
function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

export function authRouter(deps: RouteDeps): Router {
  const router = Router();

  router.post('/login', ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const { login, password, tenant_id } = (req.body ?? {}) as { login?: string; password?: string; tenant_id?: string };

    if (!login || !password || !tenant_id) {
      return res.status(400).json({
        error: { code: 'validation_error', message: 'Faltan datos para ingresar: escribe usuario, contraseña y cliente.' },
      });
    }

    // IR-06: rate limit by IP + login (fail-closed on lockout).
    const ip = req.ip ?? 'unknown';
    if (!deps.loginRateLimiter.allow(ip, login)) {
      const retryAfter = Math.ceil(deps.loginRateLimiter.lockRemainingMs(ip, login) / 1000);
      res.set('Retry-After', String(Math.max(1, retryAfter)));
      return res.status(429).json({
        error: { code: 'too_many_attempts', message: 'Hubo demasiados intentos de ingreso. Espera un momento y vuelve a intentarlo.' },
      });
    }

    const user = await deps.identityRepo.findLoginInTenant(login, tenant_id);
    if (!user) {
      await deps.sink.write({
        tenant_id,
        actor_id: UNKNOWN_ACTOR_ID,
        actor_role: null,
        action: 'auth.login',
        resource: '/api/auth/login',
        request_id: rc.request_id,
        decision: 'deny',
        result: 'invalid_credentials',
      });
      deps.loginRateLimiter.recordFailure(ip, login);
      return res.status(401).json({ error: { code: 'invalid_credentials', message: 'El usuario, la contraseña o el cliente no coinciden. Revisa los datos o consulta a tu administrador.' } });
    }

    const passwordOk = await deps.identityRepo.verifyPassword(user.user_id, password);
    if (!passwordOk) {
      await deps.sink.write({
        tenant_id,
        actor_id: user.user_id,
        actor_role: null,
        action: 'auth.login',
        resource: '/api/auth/login',
        request_id: rc.request_id,
        decision: 'deny',
        result: 'invalid_credentials',
      });
      deps.loginRateLimiter.recordFailure(ip, login);
      return res.status(401).json({ error: { code: 'invalid_credentials', message: 'El usuario, la contraseña o el cliente no coinciden. Revisa los datos o consulta a tu administrador.' } });
    }

    const roles = await deps.identityRepo.listRolesForUserInTenant(user.user_id, tenant_id);
    const role = roles[0] ?? null;
    if (!role) {
      await deps.sink.write({
        tenant_id,
        actor_id: user.user_id,
        actor_role: null,
        action: 'auth.login',
        resource: '/api/auth/login',
        request_id: rc.request_id,
        decision: 'deny',
        result: 'invalid_role',
      });
      deps.loginRateLimiter.recordFailure(ip, login);
      return res.status(403).json({ error: { code: 'invalid_role', message: 'Tu usuario no tiene un perfil habilitado para este cliente. Consulta a tu administrador.' } });
    }

    const sessionId = `sess_${randomUUID()}`;
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + deps.config.jwtTtlMinutes * 60_000);
    // Snapshot mirrors the code matrix; authz ALWAYS re-checks MATRIX per request.
    const permissions = [...MATRIX[role]];

    await deps.identityRepo.createSession({
      session_id: sessionId,
      user_id: user.user_id,
      tenant_id,
      role_id: role,
      permissions,
      source: deps.config.sessionSource,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      revoked_at: null,
    });

    const token = signSessionToken({ sid: sessionId, uid: user.user_id, tid: tenant_id, rol: role }, deps.config.jwtSecret, deps.config.jwtTtlMinutes);

    await deps.sink.write({
      tenant_id,
      actor_id: user.user_id,
      actor_role: role,
      action: 'auth.login',
      resource: '/api/auth/login',
      request_id: rc.request_id,
      decision: 'allow',
      result: 'success',
    });
    log.info('auth.login.ok', 'user logged in', { tenant_id, actor_id: user.user_id, actor_role: role });
    deps.loginRateLimiter.recordSuccess(ip, login);

    return res.json({
      token,
      expires_at: expiresAt.toISOString(),
      session: {
        session_id: sessionId,
        user_id: user.user_id,
        display_name: user.display_name,
        tenant_id,
        role_id: role,
        permissions,
      },
    });
  }));

  router.post('/logout', ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    // /api/auth is public, so the logout route resolves the session itself.
    const resolved = await deps.sessionResolver.resolve(req.headers.authorization);
    const session = resolved.session ?? lreq.session ?? null;
    if (session) {
      await deps.identityRepo.revokeSession(session.session_id);
      await deps.sink.write({
        tenant_id: session.tenant_id,
        actor_id: session.user_id,
        actor_role: session.role_name,
        action: 'auth.logout',
        resource: '/api/auth/logout',
        request_id: rc.request_id,
        decision: 'allow',
        result: 'success',
      });
    }
    return res.json({ ok: true, message: 'Sesión cerrada. Hasta pronto.' });
  }));

  return router;
}

export function backofficeRouter(deps: RouteDeps): Router {
  const router = Router();
  const auditQuery = new AuditQuery(deps.pool);

  // me — current context (AC-001 evidence). CONTRACT (documented in README §4):
  // { session: { user_id, display_name, tenant_id,
  //              tenant: { id, business_name, status } | null,
  //              role_id, role_label, role_description,
  //              permissions: string[] (ARRAY, never a count),
  //              expires_at } }
  router.get('/me', requirePermission('data.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const [displayName, tenant] = await Promise.all([
      deps.identityRepo.getUserDisplayName(session.user_id),
      deps.identityRepo.getTenantSummary(session.tenant_id),
    ]);
    await deps.sink.write({
      tenant_id: session.tenant_id,
      actor_id: session.user_id,
      actor_role: session.role_name,
      action: 'session.me',
      resource: '/api/backoffice/me',
      request_id: rc.request_id,
      decision: 'allow',
      result: 'success',
    });
    const role = session.role_name as RoleName;
    return res.json({
      session: {
        user_id: session.user_id,
        display_name: displayName ?? session.user_id,
        tenant_id: session.tenant_id,
        tenant: tenant ?? null,
        role_id: session.role_name,
        role_label: ROLE_LABELS[role] ?? session.role_name,
        role_description: ROLE_DESCRIPTIONS[role] ?? null,
        permissions: [...session.permissions],
        expires_at: session.expires_at,
      },
    });
  }));

  // data.read — list own tenant data
  router.get('/data', requirePermission('data.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const rows = await deps.dataRepo.list(session);
    await deps.sink.write({
      tenant_id: session.tenant_id,
      actor_id: session.user_id,
      actor_role: session.role_name,
      action: 'data.read',
      resource: 'tenant:data',
      request_id: rc.request_id,
      decision: 'allow',
      result: 'success',
    });
    return res.json({ data: rows });
  }));

  // data.write — create data record in OWN tenant. If the body tries to force
  // another tenant_id, rejectTenantOverride already denied + audited.
  router.post('/data', requirePermission('data.write', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const { kind, payload } = (req.body ?? {}) as { kind?: string; payload?: Record<string, unknown> };
    const dataId = `data_${randomUUID()}`;
    const created = await auditedOperation(deps.sink, deps.pool, {
      request_id: rc.request_id,
      tenant_id: session.tenant_id,
      actor_id: session.user_id,
      actor_role: session.role_name,
      action: 'data.write',
      resource: `tenant:data/${dataId}`,
    }, (db) => deps.dataRepo.create(session, {
      kind: kind ?? 'client.asset',
      payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {},
    }, db, dataId));
    return res.status(201).json({ data: created });
  }));

  // data.read — scoped read. ANTI-ORACLE (IR-01): an id that does not exist and
  // an id that exists in ANOTHER tenant get the IDENTICAL response (404 with the
  // same body) and the IDENTICAL audit event (allow/not_found). The
  // found/in_tenant marker is used internally to decide, never to differentiate
  // HTTP status or audit outcome.
  router.get('/data/:id', requirePermission('data.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const id = req.params.id as string;
    const found = await deps.dataRepo.findScoped(session, id);
    if (!found.found || !found.in_tenant) {
      await deps.sink.write({
        tenant_id: session.tenant_id,
        actor_id: session.user_id,
        actor_role: session.role_name,
        action: 'data.read',
        resource: `tenant:data/${id}`,
        request_id: rc.request_id,
        decision: 'allow',
        result: 'not_found',
      });
      return res.status(404).json({ error: { code: 'not_found', message: 'No se encontró el dato solicitado.' } });
    }
    await deps.sink.write({
      tenant_id: session.tenant_id,
      actor_id: session.user_id,
      actor_role: session.role_name,
      action: 'data.read',
      resource: `tenant:data/${id}`,
      request_id: rc.request_id,
      decision: 'allow',
      result: 'success',
    });
    return res.json({ data: found.row });
  }));

  // audit.read — own tenant events, optional request_id correlation (AC-003)
  router.get('/audit', requirePermission('audit.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const requestId = typeof req.query.request_id === 'string' ? req.query.request_id : undefined;
    const events = await auditQuery.listByTenant(session.tenant_id, requestId ? { request_id: requestId } : {});
    await deps.sink.write({
      tenant_id: session.tenant_id,
      actor_id: session.user_id,
      actor_role: session.role_name,
      action: 'audit.read',
      resource: requestId ? `audit?request_id=${requestId}` : 'audit',
      request_id: rc.request_id,
      decision: 'allow',
      result: 'success',
    });
    return res.json({ tenant_id: session.tenant_id, correlation: requestId ? { request_id: requestId } : null, events });
  }));

  // audit.export — JSON export (AC-003 evidence)
  router.get('/audit/export', requirePermission('audit.export', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const events = await auditQuery.listByTenant(session.tenant_id, {});
    await deps.sink.write({
      tenant_id: session.tenant_id,
      actor_id: session.user_id,
      actor_role: session.role_name,
      action: 'audit.export',
      resource: 'audit/export',
      request_id: rc.request_id,
      decision: 'allow',
      result: 'success',
    });
    return res.json({ exported_at: new Date().toISOString(), tenant_id: session.tenant_id, count: events.length, events });
  }));

  // user.manage — list users of own tenant (admin)
  router.get('/users', requirePermission('user.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const users = await deps.identityRepo.listUsersInTenant(session);
    // NO password_hash / login exposed.
    const safe = users.map((u) => ({ user_id: u.user_id, display_name: u.display_name, status: u.status, created_at: u.created_at }));
    await deps.sink.write({
      tenant_id: session.tenant_id,
      actor_id: session.user_id,
      actor_role: session.role_name,
      action: 'user.manage',
      resource: 'users',
      request_id: rc.request_id,
      decision: 'allow',
      result: 'success',
    });
    return res.json({ users: safe });
  }));

  // user.manage — create user inside own tenant (admin)
  router.post('/users', requirePermission('user.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const { display_name, login, password, role } = (req.body ?? {}) as { display_name?: string; login?: string; password?: string; role?: string };
    if (!display_name || !login || !password || !(ROLE_NAMES as readonly string[]).includes(role ?? '')) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'Faltan datos para crear el usuario: nombre, usuario, contraseña y perfil válido.' } });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'La contraseña debe tener al menos 8 caracteres.' } });
    }
    // IR-03: audit resource uses the generated user_id, NEVER the login.
    const newUserId = `user_${randomUUID()}`;
    try {
      const user = await auditedOperation(deps.sink, deps.pool, {
        request_id: rc.request_id,
        tenant_id: session.tenant_id,
        actor_id: session.user_id,
        actor_role: session.role_name,
        action: 'user.manage',
        resource: `users/${newUserId}`,
      }, (db) => deps.identityRepo.createUserWithRole({
        user_id: newUserId,
        display_name,
        login,
        password,
        role: role as RoleName,
        tenant_id: session.tenant_id,
      }, db));
      return res.status(201).json({ user: { user_id: user.user_id, display_name: user.display_name, status: user.status } });
    } catch (err) {
      // IR-05: map duplicate-login constraint violations to a clear 409
      // without leaking PostgreSQL internals or the login value.
      if (isUniqueViolation(err)) {
        await deps.sink.write({
          tenant_id: session.tenant_id,
          actor_id: session.user_id,
          actor_role: session.role_name,
          action: 'user.manage',
          resource: `users/${newUserId}`,
          request_id: rc.request_id,
          decision: 'deny',
          result: 'duplicate_login',
        });
        return res.status(409).json({
          error: { code: 'duplicate_login', message: 'Ya existe un usuario con ese acceso para este cliente. Usa otro nombre de usuario.' },
        });
      }
      throw err;
    }
  }));

  // Demo actions for AC-003 (create/approve/reject/execute) — NOT INC-002
  // domain: no preview, no publication, no external effect (TENTATIVA).
  router.post('/actions', requirePermission('operation.create', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const { title } = (req.body ?? {}) as { title?: string };
    if (!title || !title.trim()) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'Escribe un nombre para la operación.' } });
    }
    const actionId = `action_${randomUUID()}`;
    const created = await auditedOperation(deps.sink, deps.pool, {
      request_id: rc.request_id,
      tenant_id: session.tenant_id,
      actor_id: session.user_id,
      actor_role: session.role_name,
      action: 'operation.create',
      resource: `demo_action/${actionId}`,
    }, (db) => deps.actionRepo.create(session, { title: title.trim() }, db, actionId));
    return res.status(201).json({ action: created, message: 'Operación creada.' });
  }));

  // actions — list own tenant demo actions (minimal GET so the panel can offer
  // approve/reject/execute with real state). Tenant-scoped + audited; readable
  // by anyone allowed to create actions (operation/administration).
  router.get('/actions', requirePermission('operation.create', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const rows = await deps.actionRepo.list(session);
    await deps.sink.write({
      tenant_id: session.tenant_id,
      actor_id: session.user_id,
      actor_role: session.role_name,
      action: 'operation.read',
      resource: 'demo_actions',
      request_id: rc.request_id,
      decision: 'allow',
      result: 'success',
    });
    return res.json({ tenant_id: session.tenant_id, actions: rows });
  }));

  // approve / reject / execute — AC-003 verbs (idempotent with replay guards)
  router.post('/actions/:id/approve', requirePermission('operation.approve', deps.sink, deps.pool), ah((req, res) => decideAction(deps, req, res, 'approve')));
  router.post('/actions/:id/reject', requirePermission('operation.reject', deps.sink, deps.pool), ah((req, res) => decideAction(deps, req, res, 'reject')));
  router.post('/actions/:id/execute', requirePermission('operation.execute', deps.sink, deps.pool), ah((req, res) => decideAction(deps, req, res, 'execute')));

  return router;
}

const nextStatusByVerb = { approve: 'approved', reject: 'rejected', execute: 'executed' } as const;
type Verb = keyof typeof nextStatusByVerb;
const actionByVerb: Record<Verb, string> = { approve: 'operation.approve', reject: 'operation.reject', execute: 'operation.execute' };

async function decideAction(deps: RouteDeps, req: Request, res: Response, verb: Verb): Promise<unknown> {
  const lreq = req as LooseRequest;
  const rc = rcOf(lreq);
  const session = sessionOf(lreq);
  const id = req.params.id as string;
  const found = await deps.actionRepo.findScoped(session, id);
  // ANTI-ORACLE (IR-01): nonexistent and other-tenant ids get the SAME 404,
  // same body and same audit event (allow/not_found). The marker is internal.
  if (!found.found || !found.in_tenant) {
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: actionByVerb[verb], resource: `demo_action/${id}`, request_id: rc.request_id,
      decision: 'allow', result: 'not_found',
    });
    return res.status(404).json({ error: { code: 'not_found', message: 'No se encontró la operación solicitada.' } });
  }
  const row = found.row as DemoActionRow;
  const nextStatus = nextStatusByVerb[verb];

  // Replay guard: repeating the same verb is safe and returns the same state.
  if (row.status === nextStatus) {
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: actionByVerb[verb], resource: `demo_action/${id}`, request_id: rc.request_id,
      decision: 'allow', result: `already_${nextStatus}`,
    });
    return res.json({ action: row, message: `La operación ya está ${statusLabel(nextStatus)}.` });
  }
  // State machine of the AC-003 fixture: created -> approved|rejected -> executed.
  if (verb === 'execute' && row.status !== 'approved') {
    return deny(deps.pool, res, lreq, rc.request_id, new AppError(409, 'validation_error', 'La operación debe estar aprobada antes de ejecutarla.'), req.originalUrl ?? req.path, false);
  }
  if (verb === 'approve' && row.status !== 'created') {
    return deny(deps.pool, res, lreq, rc.request_id, new AppError(409, 'validation_error', 'La operación no puede aprobarse en su estado actual.'), req.originalUrl ?? req.path, false);
  }
  if (verb === 'reject' && row.status !== 'created') {
    return deny(deps.pool, res, lreq, rc.request_id, new AppError(409, 'validation_error', 'La operación no puede rechazarse en su estado actual.'), req.originalUrl ?? req.path, false);
  }

  const updated = await auditedOperation(deps.sink, deps.pool, {
    request_id: rc.request_id,
    tenant_id: session.tenant_id,
    actor_id: session.user_id,
    actor_role: session.role_name,
    action: actionByVerb[verb],
    resource: `demo_action/${id}`,
  }, (db) => deps.actionRepo.setStatus(session, id, nextStatus, session.user_id, db));
  return res.json({ action: updated, message: statusLabel(nextStatus) });
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = { created: 'creada', approved: 'aprobada', rejected: 'rechazada', executed: 'ejecutada' };
  return labels[status] ?? status;
}

/** Shared deny response + audit (fail-open for deny records so the 4xx is always returned). */
async function deny(pool: Pool, res: Response, lreq: LooseRequest, requestId: string, err: AppError, resource: string, auditDeny = true): Promise<void> {
  const session = lreq.session ?? null;
  if (auditDeny) {
    err.audited = true;
    const sink = new AuditSink(pool);
    await sink.write({
      tenant_id: session?.tenant_id ?? 'unknown',
      actor_id: session?.user_id ?? UNKNOWN_ACTOR_ID,
      actor_role: session?.role_name ?? null,
      action: 'access.deny',
      resource,
      request_id: requestId,
      decision: 'deny',
      result: err.code,
    }, pool, false).catch(() => undefined);
    log.warn('access.denied', `denied ${resource}`, { reason: err.code, decision: 'deny', result: err.code });
  }
  res.status(err.status).json({ error: { code: err.code, message: err.userMessage } });
}