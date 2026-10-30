/**
 * API interna de redes sociales (INC-005, CAP-003, REQ-014).
 *
 * Crear borradores → programar (aprobación previa) → aprobar → preview →
 * publicar UNA vez (FLOW-002). La campaña avanzada es PROHIBITED (permiso
 * social.campaign_advanced bloqueado; deny + audit en la matriz). Fail-closed
 * de INC-001: tenant de la sesión, anti-oracle, auditoría con request_id.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from '../shared/config.ts';
import { getRequestContext, type SessionSummary } from '../shared/context.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import type { AuditSink } from '../audit/sink.ts';
import type { SocialService, SocialPostStatus } from '../social/service.ts';
import { formatInZone } from '../social/timezone.ts';
import { resolveIdempotencyKey } from '../subscriptions/quota.ts';
import type { ActionRateLimiter } from '../boundary/action-ratelimit.ts';
import { denyAndRespond, type LooseRequest } from '../boundary/middleware.ts';
import { requirePermission } from '../boundary/middleware.ts';

export interface SocialRouteDeps {
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  service: SocialService;
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

/** Maneja el deny de límite/suscripción con auditoría (result = err.code). */
async function handleDomainDeny(req: Request, res: Response, lreq: LooseRequest, err: unknown, pool: Pool): Promise<boolean> {
  if (err instanceof AppError && (err.code === DENY_CODES.LIMIT_EXCEEDED || err.code === DENY_CODES.SUBSCRIPTION_REQUIRED || err.code === DENY_CODES.PROHIBITED)) {
    await denyAndRespond(req, res, lreq, err, pool);
    return true;
  }
  return false;
}

export function socialRouter(deps: SocialRouteDeps): Router {
  const router = Router();

  // Crear borrador (social.create). DEC-0005: cuota consumida en la misma
  // transacción que el borrador; Idempotency-Key opcional (replay ⇒ 200).
  router.post('/social/posts', requirePermission('social.create', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const { text, image_url, content_type } = (req.body ?? {}) as { text?: string; image_url?: string | null; content_type?: 'post' | 'ad' };
    try {
      const { post, replayed } = await deps.service.createDraft(session.tenant_id, session.user_id, rc.request_id, {
        text: text ?? '', imageUrl: image_url ?? null, contentType: content_type,
        idempotencyKey: resolveIdempotencyKey(req.get('idempotency-key'), rc.request_id), actorRole: session.role_name,
      });
      if (replayed) {
        return res.status(200).json({ post, replayed: true, message: 'Esta solicitud ya se había procesado: el borrador ya existe.' });
      }
      return res.status(201).json({ post, message: 'Borrador creado. Para publicarlo pasa por revisión y aprobación.' });
    } catch (err) {
      if (await handleDomainDeny(req, res, lreq, err, deps.pool)) return undefined;
      throw err;
    }
  }));

  // Listado (social.read).
  router.get('/social/posts', requirePermission('social.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const status = typeof req.query.status === 'string' ? (req.query.status as SocialPostStatus) : undefined;
    const posts = await deps.service.list(session.tenant_id, status ? { status } : {});
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: 'social.read', resource: 'social_posts', request_id: rc.request_id,
      decision: 'allow', result: 'success',
    });
    return res.json({ tenant_id: session.tenant_id, posts });
  }));

  // Programar borrador (social.schedule). La aprobación llega después.
  // `publish_at` = instante ISO (con offset) o `publish_local` = hora de pared
  // `YYYY-MM-DDTHH:mm` en la zona horaria del negocio (SOCIAL_SCHEDULER_TIMEZONE); se
  // guarda siempre en UTC y la respuesta incluye la hora local equivalente.
  router.post('/social/posts/:id/schedule', requirePermission('social.schedule', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const id = req.params.id as string;
    const { publish_at, publish_local } = (req.body ?? {}) as { publish_at?: string; publish_local?: string };
    try {
      const when = typeof publish_local === 'string' && publish_local ? { local: publish_local } : (publish_at ?? '');
      const post = await deps.service.schedule(session.tenant_id, session.user_id, rc.request_id, id, when);
      const tz = deps.config.socialSchedulerTimezone;
      return res.json({
        post, status: post.status, timezone: tz,
        scheduled_local: post.scheduled_at ? formatInZone(new Date(post.scheduled_at), tz) : null,
        message: 'Publicación programada. Requiere aprobación antes de publicarse.',
      });
    } catch (err) {
      if (err instanceof AppError && err.code === DENY_CODES.NOT_FOUND) {
        await deps.sink.write({
          tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
          action: 'social.schedule', resource: `social_post/${id}`, request_id: rc.request_id,
          decision: 'allow', result: 'not_found',
        }).catch(() => undefined);
        return res.status(404).json({ error: { code: 'not_found', message: 'No se encontró la publicación solicitada.' } });
      }
      throw err;
    }
  }));

  // Aprobar borrador → genera propuesta de preview/publicación (social.approve).
  // PR-06: rate limiting de aprobaciones sensibles (IP + operador + recurso).
  router.post('/social/posts/:id/approve', requirePermission('social.approve', deps.sink, deps.pool), ah(async (req, res) => {
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

    try {
      const { post, proposalId } = await deps.service.approvePost(session.tenant_id, session.user_id, rc.request_id, id);
      return res.json({
        post,
        proposal_id: proposalId,
        message: 'La publicación pasó a revisión. Prepara la vista previa y confirma la publicación.',
      });
    } catch (err) {
      if (err instanceof AppError && err.code === DENY_CODES.NOT_FOUND) {
        await deps.sink.write({
          tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
          action: 'social.approve', resource: `social_post/${id}`, request_id: rc.request_id,
          decision: 'allow', result: 'not_found',
        }).catch(() => undefined);
        return res.status(404).json({ error: { code: 'not_found', message: 'No se encontró la publicación solicitada.' } });
      }
      throw err;
    }
  }));

  // Rechazar publicación (solo antes de publicar; cola → skipped).
  router.post('/social/posts/:id/reject', requirePermission('social.schedule', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const id = req.params.id as string;
    try {
      const post = await deps.service.reject(session.tenant_id, session.user_id, rc.request_id, id);
      return res.json({ post, status: post.status, message: 'Publicación rechazada. No se publicó nada.' });
    } catch (err) {
      if (err instanceof AppError && err.code === DENY_CODES.NOT_FOUND) {
        await deps.sink.write({
          tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
          action: 'social.reject', resource: `social_post/${id}`, request_id: rc.request_id,
          decision: 'allow', result: 'not_found',
        }).catch(() => undefined);
        return res.status(404).json({ error: { code: 'not_found', message: 'No se encontró la publicación solicitada.' } });
      }
      throw err;
    }
  }));

  // Tick manual del worker simple: publica las programaciones vencidas.
  // PR-01: solo publica filas con evidencia de aprobación; las que no la
  // tienen quedan 'blocked' con auditoría deny (NUNCA se auto-publican).
  router.post('/social/process-due', requirePermission('social.schedule', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const { processed, published, blocked } = await deps.service.processDueScheduled(session.tenant_id, rc.request_id);
    return res.json({ processed, blocked, published: published.map((p) => ({ post_id: p.post_id, status: p.status, external_ref: p.external_ref })) });
  }));

  // CAMPAÑA AVANZADA — PROHIBITED (DEC-017: fuera del MVP). El permiso
  // social.campaign_advanced está bloqueado para todos los roles, así que
  // requirePermission deniega SIEMPRE con auditoría deny (fail-closed).
  router.post('/social/campaigns/advanced', requirePermission('social.campaign_advanced', deps.sink, deps.pool), ah(async (_req, res) => {
    return res.status(403).json({
      error: { code: DENY_CODES.PROHIBITED, message: 'Las campañas avanzadas y la segmentación por audiencia aún no están disponibles.' },
    });
  }));

  return router;
}
