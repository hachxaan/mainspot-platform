/**
 * API del negocio sobre su plan (INC-006, CAP-012, DEC-024; DEC-0075/SRC-0013), SOLO LECTURA.
 *
 * - POST /subscriptions/assign   RETIRADA: responde 403 permission_denied auditado. La asignación
 *   es exclusiva de MainSpot Administration (platform_admin, step-up, motivo, historial).
 * - GET  /subscriptions/entitlements (subscription.read) plan, revisión fijada, límites y uso.
 * - GET  /subscriptions/plans (subscription.read) planes asignables (nunca borradores).
 * - POST /subscriptions/invoice  (subscription.admin) PROHIBITED si el plan no
 *   tiene precio (piloto sin cobro).
 * Fail-closed INC-001: tenant de la sesión + auditoría con request_id.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { AppConfig } from '../shared/config.ts';
import { getRequestContext, type SessionSummary } from '../shared/context.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import type { AuditSink } from '../audit/sink.ts';
import type { EntitlementService, SubscriptionRepository } from '../subscriptions/entitlements.ts';
import { denyAndRespond, type LooseRequest } from '../boundary/middleware.ts';
import { requirePermission } from '../boundary/middleware.ts';

export interface SubscriptionRouteDeps {
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  entitlements: EntitlementService;
  subscriptionRepo: SubscriptionRepository;
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

export function subscriptionRouter(deps: SubscriptionRouteDeps): Router {
  const router = Router();

  // RETIRADA (SRC-0013 self_assign): el negocio no se asigna planes. Deny auditado para cualquier rol.
  router.post('/subscriptions/assign', requirePermission('subscription.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    await denyAndRespond(req, res, lreq, new AppError(403, DENY_CODES.PERMISSION_DENIED,
      'El plan lo asigna MainSpot. Tu panel muestra tu plan y su consumo; para cambiarlo, escríbenos.'), deps.pool);
  }));

  // Consultar entitlements (los 3 perfiles leen; subscription.read).
  router.get('/subscriptions/entitlements', requirePermission('subscription.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const view = await deps.entitlements.getEntitlements(session.tenant_id);
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: 'subscription.read', resource: 'subscription/entitlements', request_id: rc.request_id,
      decision: 'allow', result: view ? 'success' : 'no_subscription',
    });
    if (!view) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Este cliente todavía no tiene un plan asignado.' } });
    }
    return res.json({ tenant_id: session.tenant_id, entitlements: view });
  }));

  // Listar planes del catálogo (subscription.read; display).
  router.get('/subscriptions/plans', requirePermission('subscription.read', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    const plans = await deps.subscriptionRepo.listAssignablePlans();
    await deps.sink.write({
      tenant_id: session.tenant_id, actor_id: session.user_id, actor_role: session.role_name,
      action: 'subscription.read', resource: 'subscription/plans', request_id: rc.request_id,
      decision: 'allow', result: 'success',
    });
    return res.json({ tenant_id: session.tenant_id, plans });
  }));

  // Facturar — PROHIBITED sin precio aprobado (piloto sin cobro, DEC-024).
  router.post('/subscriptions/invoice', requirePermission('subscription.admin', deps.sink, deps.pool), ah(async (req, res) => {
    const lreq = req as LooseRequest;
    const rc = rcOf(lreq);
    const session = sessionOf(lreq);
    try {
      const outcome = await deps.entitlements.invoice(session.tenant_id, session.user_id, rc.request_id);
      return res.json({ ok: outcome.ok, result: outcome.result, message: 'Pago simulado procesado (sin cobro real en el piloto).' });
    } catch (err) {
      if (await handleDomainDeny(req, res, lreq, err, deps.pool)) return undefined;
      throw err;
    }
  }));

  return router;
}
