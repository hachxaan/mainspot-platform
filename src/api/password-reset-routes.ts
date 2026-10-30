/**
 * Rutas públicas de recuperación de contraseña (DEV-E2E-04 §3), montadas en /api/auth/password.
 *
 *  POST /forgot {login}            → 200 SIEMPRE con el mismo mensaje y duración mínima común
 *                                    (exista o no la cuenta); 429 por IP o por correo sin revelar nada.
 *  POST /reset  {token, password}  → 200 contraseña cambiada y sesiones revocadas;
 *                                    400 contraseña débil (no consume el enlace); 404 enlace no válido.
 * El token nunca va en la URL del servidor: viaja en el cuerpo (y en el fragmento del enlace).
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { Router, type Request, type Response } from 'express';
import type { ActionRateLimiter } from '../boundary/action-ratelimit.ts';
import { getRequestContext } from '../shared/context.ts';
import { FORGOT_NEUTRAL_MESSAGE, RESET_DONE_MESSAGE, normalizeLogin, type PasswordResetService } from '../identity/password-reset.ts';

export interface PasswordResetRouteDeps {
  service: PasswordResetService;
}

function requestId(req: Request): string {
  return getRequestContext()?.request_id ?? ((req as Request & { request_id?: string }).request_id ?? 'no-ctx');
}

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

function tooMany(res: Response, limiter: ActionRateLimiter, ip: string, actor: string, resource: string): boolean {
  if (limiter.allow(ip, actor, resource)) return false;
  res.set('Retry-After', String(Math.max(1, Math.ceil(limiter.lockRemainingMs(ip, actor, resource) / 1000))));
  res.status(429).json({ error: { code: 'too_many_attempts', message: 'Hubo demasiados intentos. Espera un momento y vuelve a intentarlo.' } });
  return true;
}

export function passwordResetRouter(deps: PasswordResetRouteDeps): Router {
  const router = Router();
  const { service } = deps;

  router.post('/forgot', ah(async (req, res) => {
    const started = Date.now();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const login = normalizeLogin(body['login'] ?? body['email']);
    if (!login) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'Escribe el correo con el que entras a MainSpot.' } });
    }
    const ip = req.ip ?? 'unknown';
    // Límite por IP y por correo: se aplica igual exista o no la cuenta (no es un oráculo).
    if (tooMany(res, service.limits.forgotPerIp, ip, 'password.forgot', '-')) return;
    if (tooMany(res, service.limits.forgotPerAccount, '-', 'password.forgot', login)) return;
    service.limits.forgotPerIp.recordAttempt(ip, 'password.forgot', '-');
    service.limits.forgotPerAccount.recordAttempt('-', 'password.forgot', login);

    await service.request({ login, requestId: requestId(req) });
    // Misma duración mínima para todas las solicitudes: el trabajo extra de emitir el enlace
    // (el correo se envía fuera de esta respuesta) no distingue cuentas existentes.
    const remaining = service.minResponseMs - (Date.now() - started);
    if (remaining > 0) await sleep(remaining);
    return res.json({ ok: true, message: FORGOT_NEUTRAL_MESSAGE });
  }));

  router.post('/reset', ah(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ip = req.ip ?? 'unknown';
    if (tooMany(res, service.limits.resetPerIp, ip, 'password.reset', '-')) return;
    service.limits.resetPerIp.recordAttempt(ip, 'password.reset', '-');
    await service.reset({ token: body['token'], password: body['password'], requestId: requestId(req) });
    return res.json({ ok: true, message: RESET_DONE_MESSAGE });
  }));

  return router;
}
