/**
 * API de la conexión de un negocio con Google Business Profile (DEV-E2E-04 §2A).
 *
 * Backoffice (tenant SIEMPRE de la sesión; RBAC por acción):
 *   GET  /connections/google            estado (reputation.read: los 3 perfiles)
 *   POST /connections/google/start      URL de autorización (client.config.manage: Administración)
 *   GET  /connections/google/locations  cuentas/ubicaciones accesibles en vivo (client.config.manage)
 *   POST /connections/google/location   elegir ubicación → `connected` tras leerla (client.config.manage)
 *   POST /connections/google/verify     comprobación bajo demanda (client.config.manage)
 *   POST /connections/google/disconnect revocar en Google + borrar tokens (client.config.manage)
 * Público (sin sesión: el navegador vuelve de Google por navegación de primer nivel):
 *   GET  /api/connections/google/callback?code&state  autenticado SOLO por el state de un solo uso;
 *        redirige al panel con un código de resultado, nunca con tokens ni mensajes del proveedor.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { ActionRateLimiter } from '../boundary/action-ratelimit.ts';
import { requirePermission } from '../boundary/middleware.ts';
import type { GoogleConnectionService } from '../google/connection.ts';
import { GOOGLE_CALLBACK_PATH } from '../google/config.ts';
import { AppError } from '../shared/errors.ts';
import { actorOf } from './contact-routes.ts';

export interface GoogleConnectionRouteDeps {
  pool: Pool;
  sink: AuditSink;
  service: GoogleConnectionService;
  /** Destino del navegador tras el callback (sin barra final), p. ej. PUBLIC_BASE_URL. */
  publicBaseUrl: string;
}

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

/** Rutas protegidas bajo /api/backoffice. */
export function googleConnectionRouter(deps: GoogleConnectionRouteDeps): Router {
  const router = Router();
  const manage = requirePermission('client.config.manage', deps.sink, deps.pool);
  // Inicios de autorización acotados por persona: cada uno crea un state con caducidad.
  const startLimiter = new ActionRateLimiter(10, 60_000, 60_000);

  router.get('/connections/google', requirePermission('reputation.read', deps.sink, deps.pool), ah(async (req, res) => {
    const actor = actorOf(req);
    return res.json(await deps.service.view(actor.tenantId));
  }));

  router.post('/connections/google/start', manage, ah(async (req, res) => {
    const actor = actorOf(req);
    const ip = req.ip ?? 'unknown';
    if (!startLimiter.allow(ip, actor.userId, 'google_oauth_start')) {
      res.setHeader('Retry-After', String(Math.ceil(startLimiter.lockRemainingMs(ip, actor.userId, 'google_oauth_start') / 1000) || 60));
      throw new AppError(429, 'validation_error', 'Demasiados intentos de conexión. Espera un minuto y vuelve a intentarlo.');
    }
    startLimiter.recordAttempt(ip, actor.userId, 'google_oauth_start');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(201).json(await deps.service.start(actor));
  }));

  router.get('/connections/google/locations', manage, ah(async (req, res) => {
    const actor = actorOf(req);
    res.setHeader('Cache-Control', 'no-store');
    return res.json(await deps.service.listLocations(actor));
  }));

  router.post('/connections/google/location', manage, ah(async (req, res) => {
    const actor = actorOf(req);
    return res.json({ connection: await deps.service.selectLocation(actor, req.body) });
  }));

  router.post('/connections/google/verify', manage, ah(async (req, res) => {
    const actor = actorOf(req);
    return res.json({ connection: await deps.service.verify(actor) });
  }));

  router.post('/connections/google/disconnect', manage, ah(async (req, res) => {
    const actor = actorOf(req);
    return res.json(await deps.service.disconnect(actor));
  }));

  return router;
}

/** Callback público de OAuth (montar en la raíz de la app, antes del backoffice). */
export function googleOAuthCallbackRouter(deps: Pick<GoogleConnectionRouteDeps, 'service' | 'publicBaseUrl'>): Router {
  const router = Router();
  router.get(GOOGLE_CALLBACK_PATH, ah(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const pick = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : undefined);
    const result = await deps.service.callback({ code: pick('code'), state: pick('state'), error: pick('error') });
    const target = new URL(`${deps.publicBaseUrl}/panel`);
    target.hash = `/google?conexion=${encodeURIComponent(result.outcome)}&motivo=${encodeURIComponent(result.code)}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.redirect(302, target.toString());
  }));
  return router;
}
