/**
 * API de teléfonos de contacto (DEV-E2E-02, SHARED-CONTRACT §A).
 *
 * Tenant SIEMPRE de la sesión (rejectTenantOverride ya rechaza tenant_id ajenos en el cuerpo);
 * lectura con data.read (los 3 perfiles), escritura con client.config.manage (Administración).
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { getRequestContext, type SessionSummary } from '../shared/context.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { requirePermission, type LooseRequest } from '../boundary/middleware.ts';
import { ContactPhoneService, PhoneValidationError, isPhoneChannel } from '../contact/phones.ts';

export interface ContactRouteDeps {
  pool: Pool;
  sink: AuditSink;
  phones: ContactPhoneService;
}

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

export function actorOf(req: Request): { tenantId: string; userId: string; role: string | null; requestId: string; session: SessionSummary } {
  const lreq = req as LooseRequest;
  const session = lreq.session;
  if (!session) throw new AppError(401, DENY_CODES.MISSING_ACTOR, 'No se encontró una sesión activa.');
  const requestId = getRequestContext()?.request_id ?? lreq.request_id ?? 'no-ctx';
  return { tenantId: session.tenant_id, userId: session.user_id, role: session.role_name, requestId, session };
}

function validationResponse(res: Response, err: PhoneValidationError): Response {
  return res.status(400).json({ error: { code: 'validation_error', message: err.userMessage, fields: err.fields } });
}

export function contactRouter(deps: ContactRouteDeps): Router {
  const router = Router();

  router.get('/contact/phones', requirePermission('data.read', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    const view = await deps.phones.view(actor.tenantId);
    await deps.sink.write({
      tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
      action: 'contact.phone.read', resource: 'contact_phone', request_id: actor.requestId,
      decision: 'allow', result: 'success',
    });
    return res.json(view);
  }));

  router.put('/contact/phones/primary', requirePermission('client.config.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    try {
      return res.json(await deps.phones.setPrimary(actor, req.body?.primary_phone ?? req.body));
    } catch (err) {
      if (err instanceof PhoneValidationError) return validationResponse(res, err);
      throw err;
    }
  }));

  router.put('/contact/phones/integrations/:channel', requirePermission('client.config.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    const channel = String(req.params.channel);
    if (!isPhoneChannel(channel)) {
      return res.status(404).json({ error: { code: 'not_found', message: 'Esa integración no existe.' } });
    }
    try {
      return res.json(await deps.phones.setIntegration(actor, channel, req.body));
    } catch (err) {
      if (err instanceof PhoneValidationError) return validationResponse(res, err);
      throw err;
    }
  }));

  return router;
}
