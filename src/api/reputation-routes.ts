/**
 * API interna de reputación/reseñas (INC-004, CAP-002/CAP-004).
 *
 * Invariantes (heredadas de INC-001): scope tenant SIEMPRE de la sesión;
 * anti-oracle 404 idéntico para inexistente/otro tenant; toda acción audita con
 * request_id; fail-closed sobre permisos. La respuesta pública es un cambio
 * visible (DEC-011): aprobar respuesta genera la propuesta de preview; la
 * publicación final usa el flujo conversacional (operation.approve).
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from '../shared/config.ts';
import { getRequestContext, type SessionSummary } from '../shared/context.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import type { AuditSink } from '../audit/sink.ts';
import type { ReputationEngine, ReviewRow } from '../reputation/engine.ts';
import type { ActionRateLimiter } from '../boundary/action-ratelimit.ts';
import { denyAndRespond, type LooseRequest } from '../boundary/middleware.ts';
import { requirePermission } from '../boundary/middleware.ts';

export interface ReputationRouteDeps {
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  engine: ReputationEngine;
  approvalRateLimiter: ActionRateLimiter;
}

function approveAllowed(limiter: ActionRateLimiter, ip: string, actor: string, resource: string): number | null {
  if (limiter.allow(ip, actor, resource)) return null;
  return Math.max(1, Math.ceil(limiter.lockRemainingMs(ip, actor, resource) / 1000));
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

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

/** Maneja deny de dominio (límite/suscripción/prohibited) con auditoría. */
async function handleDomainDeny(req: Request, res: Response, lreq: LooseRequest, err: unknown, pool: Pool): Promise<boolean> {
  if (err instanceof AppError && (err.code === DENY_CODES.LIMIT_EXCEEDED || err.code === DENY_CODES.SUBSCRIPTION_REQUIRED || err.code === DENY_CODES.PROHIBITED)) {
    await denyAndRespond(req, res, lreq, err, pool);
    return true;
  }
  return false;
}

async function notFoundAudit(deps: ReputationRouteDeps, lreq: LooseRequest, rc: { request_id: string; session: SessionSummary | null }, action: string, id: string): Promise<void> {
  const session = lreq.session;
  await deps.sink.write({
    tenant_id: session?.tenant_id ?? 'unknown', actor_id: session?.user_id ?? 'unknown',
    actor_role: session?.role_name ?? null, action, resource: `review/${id}`,
    request_id: rc.request_id, decision: 'allow', result: 'not_found',
  }).catch(() => undefined);
}

export function reputationRouter(deps: ReputationRouteDeps): Router {
  const router = Router();

  // Listar reseñas del tenant (reputation.read, los 3 perfiles).
  router.get('/reputation/reviews', requirePermission('reputation.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const state = typeof req.query.state === 'string' ? (req.query.state as ReviewRow['state']) : undefined;
    const rows = await new (await import('../reputation/engine.ts')).ReviewRepository(deps.pool).list(session.tenant_id, state ? { state } : {});
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: 'reputation.read', resource: 'reviews', request_id: rc.request_id,
      decision: 'allow', result: 'success',
    });
    return res.json({ tenant_id: session.tenant_id, reviews: rows });
  }));

  // Sincronizar reseñas del proveedor (simulado determinista; idempotente).
  router.post('/reputation/reviews/sync', requirePermission('reputation.respond', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    try {
      const { outcome, reviews } = await deps.engine.sync(session.tenant_id, session.user_id, rc.request_id, session.role_name);
      await deps.sink.write({
        tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
        action: 'reputation.synced', resource: 'reviews/sync', request_id: rc.request_id,
        decision: 'allow', result: `synced:${outcome.synced}:skipped:${outcome.skipped}`,
      });
      return res.status(201).json({ synced: outcome.synced, skipped: outcome.skipped, classified: outcome.classified, reviews });
    } catch (err) {
      if (await handleDomainDeny(req, res, lreq, err, deps.pool)) return undefined;
      throw err;
    }
  }));

  // Escalar un caso a revisión humana (FLOW-004).
  router.post('/reputation/reviews/:id/escalate', requirePermission('reputation.escalate', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const id = req.params.id as string;
    try {
      const review = await deps.engine.escalate(session.tenant_id, id, session.user_id, rc.request_id);
      return res.json({ review, status: review.state, message: 'El caso quedó pendiente de revisión humana.' });
    } catch (err) {
      if (err instanceof AppError && (err.code === DENY_CODES.NOT_FOUND)) {
        await notFoundAudit(deps, lreq, rc, 'reputation.escalate', id);
        return res.status(404).json({ error: { code: 'not_found', message: 'No se encontró la reseña solicitada.' } });
      }
      throw err;
    }
  }));

  // Editar el borrador de respuesta (solo antes de aprobar).
  router.post('/reputation/reviews/:id/response', requirePermission('reputation.respond', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const id = req.params.id as string;
    const { text } = (req.body ?? {}) as { text?: string };
    const review = await deps.engine.editResponse(session.tenant_id, id, text ?? '', session.user_id, rc.request_id);
    return res.json({ review, status: review.state, message: 'Borrador de respuesta guardado. Aún no se publica nada.' });
  }));

  // Aprobar la respuesta → crea propuesta de preview/publicación (DEC-011).
  // PR-06: rate limiting de aprobaciones sensibles (IP + operador + reseña).
  router.post('/reputation/reviews/:id/approve', requirePermission('reputation.approve', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const id = req.params.id as string;

    const retryAfter = approveAllowed(deps.approvalRateLimiter, req.ip ?? 'unknown', session.user_id, id);
    if (retryAfter != null) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: { code: 'too_many_attempts', message: 'Hubo demasiados intentos de aprobación. Espera un momento y vuelve a intentarlo.' } });
    }
    deps.approvalRateLimiter.recordAttempt(req.ip ?? 'unknown', session.user_id, id);

    const { review, proposalId } = await deps.engine.approveResponse(session.tenant_id, id, session.user_id, rc.request_id);
    return res.json({
      review,
      proposal_id: proposalId,
      message: 'La respuesta fue aprobada como propuesta. Prepara la vista previa y publica con tu aprobación final.',
    });
  }));

  // Rechazar el caso (antes de publicar).
  router.post('/reputation/reviews/:id/reject', requirePermission('reputation.respond', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const id = req.params.id as string;
    const review = await deps.engine.reject(session.tenant_id, id, session.user_id, rc.request_id);
    return res.json({ review, status: review.state, message: 'Caso rechazado. No se publicó ninguna respuesta.' });
  }));

  // MANIPULACIÓN PROHIBIDA: ocultar/borrar una reseña. El permiso
  // reputation.hide_review está bloqueado para todos los roles (fail-closed),
  // por lo que requirePermission deniega SIEMPRE con auditoría deny exitosa
  // (action='access.deny', result='permission_denied'). El handler es
  // inalcanzable (defensa en profundidad) y devuelve el mensaje de política.
  router.post('/reputation/reviews/:id/hide', requirePermission('reputation.hide_review', deps.sink, deps.pool), ah(async (_req, res) => {
    return res.status(403).json({
      error: { code: DENY_CODES.PROHIBITED, message: 'No está permitido ocultar ni borrar reseñas. Las opiniones de tus clientes no se manipulan.' },
    });
  }));
  router.delete('/reputation/reviews/:id', requirePermission('reputation.hide_review', deps.sink, deps.pool), ah(async (_req, res) => {
    return res.status(403).json({
      error: { code: DENY_CODES.PROHIBITED, message: 'No está permitido ocultar ni borrar reseñas. Las opiniones de tus clientes no se manipulan.' },
    });
  }));

  return router;
}
