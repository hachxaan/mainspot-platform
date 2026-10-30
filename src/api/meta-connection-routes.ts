/**
 * Conexión REAL de un negocio con su Page de Facebook (DEV-E2E-04 §2B).
 *
 * Flujo (Facebook Login, code flow en servidor):
 *   1. POST /api/backoffice/connections/meta/start (Administración) → `state` de un solo uso
 *      ligado a tenant/usuario (provider_oauth_state, hash) y URL del diálogo de Meta.
 *   2. Meta redirige al navegador a GET /api/connections/meta/callback?code&state (PÚBLICA:
 *      el navegador no lleva el Bearer del panel). La ÚNICA autoridad es el state: se consume
 *      atómicamente, caduca y fija el tenant destino. El code se intercambia en servidor con
 *      META_APP_SECRET; el token de usuario (larga duración) se guarda CIFRADO con status
 *      needs_authorization (todavía sin Page). El navegador vuelve al panel sin tokens.
 *   3. GET /connections/meta/pages lista las Pages que administra la persona (sin tokens);
 *      POST /connections/meta/select {page_id} obtiene el page token, lo verifica contra Meta
 *      (lectura de la Page + debug_token) y lo guarda cifrado: `connected` solo con acuse.
 *   4. POST /connections/meta/verify re-comprueba; POST /connections/meta/disconnect revoca
 *      (DELETE /me/permissions, best effort) y borra el sobre cifrado.
 *
 * Seguridad: redirect_uri fijo desde PUBLIC_BASE_URL (nunca del request); tenant de la sesión;
 * sin tokens ni códigos en respuestas, logs ni auditoría; rate limit en start/select/verify.
 * Ads básicos: GET /connections/meta/ads-check SOLO lista cuentas publicitarias accesibles
 * (ads_read) y SOLO con META_ADS_CHECK=on; nunca crea campañas ni gasta.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { requirePermission } from '../boundary/middleware.ts';
import { ActionRateLimiter } from '../boundary/action-ratelimit.ts';
import type { ProviderConnectionRepository } from '../connectors/repository.ts';
import type { AppConfig } from '../shared/config.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import { ADS_READ_SCOPE, META_PROVIDER, MetaGraphError, REQUIRED_PAGE_SCOPES, type MetaPagesAdapter, type MetaTokens } from '../social/meta-graph.ts';
import { actorOf } from './contact-routes.ts';

export interface MetaConnectionRouteDeps {
  pool: Pool;
  config: AppConfig;
  sink: AuditSink;
  connections: ProviderConnectionRepository;
  /** null ⇒ proveedor simulado: la conexión real no está habilitada en este entorno. */
  meta: MetaPagesAdapter | null;
}

export const META_CALLBACK_PATH = '/api/connections/meta/callback';
/** A dónde vuelve el navegador tras el callback (sin datos sensibles; solo un resultado). */
const PANEL_RETURN = '/panel#/facebook/conectar';

/** Lo que las rutas necesitan del actor de la sesión (ver actorOf en contact-routes). */
interface RouteActor {
  tenantId: string;
  userId: string;
  role: string | null;
  requestId: string;
}

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

function notEnabled(): AppError {
  return new AppError(409, 'validation_error', 'La conexión real con Facebook no está habilitada en este entorno (SOCIAL_PROVIDER=meta y CONNECTOR_TOKEN_KEY).');
}

function oauthNotConfigured(): AppError {
  return new AppError(409, 'validation_error', 'Falta configurar la app de Meta (META_APP_ID y META_APP_SECRET) para conectar Facebook desde el panel.');
}

/** Mensaje para la persona según el error de Meta, sin detalles crudos del proveedor. */
function graphUserError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof MetaGraphError) {
    switch (err.kind) {
      case 'invalid_token': return new AppError(409, 'validation_error', 'Facebook ya no reconoce la autorización. Vuelve a conectar la página.');
      case 'permission_missing': return new AppError(409, 'validation_error', 'Facebook no concedió los permisos necesarios. Vuelve a conectar y acepta todos los permisos solicitados.');
      case 'rate_limited': return new AppError(429, 'validation_error', 'Facebook limitó temporalmente las solicitudes. Espera unos minutos e inténtalo de nuevo.');
      case 'transient':
      case 'timeout': return new AppError(503, 'validation_error', 'Facebook no respondió. Inténtalo de nuevo en un momento.');
      default: return new AppError(502, 'validation_error', 'Facebook devolvió un error inesperado. Inténtalo de nuevo más tarde.');
    }
  }
  return new AppError(502, 'validation_error', 'No se pudo completar la operación con Facebook.');
}

export function metaConnectionRouter(deps: MetaConnectionRouteDeps): Router {
  const router = Router();
  const limiter = new ActionRateLimiter(10, 60_000, 60_000);
  const redirectUri = `${deps.config.publicBaseUrl}${META_CALLBACK_PATH}`;

  const limited = (req: Request, res: Response, actor: string, resource: string): boolean => {
    const ip = req.ip ?? 'unknown';
    if (!limiter.allow(ip, actor, resource)) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(limiter.lockRemainingMs(ip, actor, resource) / 1000))));
      res.status(429).json({ error: { code: 'too_many_attempts', message: 'Hubo demasiados intentos. Espera un momento y vuelve a intentarlo.' } });
      return true;
    }
    limiter.recordAttempt(ip, actor, resource);
    return false;
  };

  const audit = async (a: RouteActor, action: string, result: string, decision: 'allow' | 'deny' = 'allow', evidence: string | null = null) => {
    await deps.sink.write({
      tenant_id: a.tenantId, actor_id: a.userId, actor_role: a.role, action, resource: 'provider_connection/meta_pages',
      request_id: a.requestId, decision, result, evidence_ref: evidence,
    }, deps.pool, false).catch(() => undefined);
  };

  // Estado de la conexión (sin tokens): lo que ve la pantalla de Facebook.
  router.get('/connections/meta', requirePermission('social.read', deps.sink, deps.pool), ah(async (req, res) => {
    const a = actorOf(req);
    const connection = deps.meta ? await deps.connections.get(a.tenantId, META_PROVIDER) : null;
    return res.json({
      enabled: deps.meta !== null,
      oauth_configured: Boolean(deps.meta?.oauthConfigured),
      graph_version: deps.config.metaGraphVersion,
      required_scopes: [...REQUIRED_PAGE_SCOPES],
      ads_check_enabled: deps.config.metaAdsCheckEnabled,
      scheduler_timezone: deps.config.socialSchedulerTimezone,
      connection: connection ? {
        status: connection.status, page_id: connection.external_resource_id, page_name: connection.external_resource_name,
        scopes: connection.scopes, last_verified_at: connection.last_verified_at, last_error_code: connection.last_error_code,
        token_expires_at: connection.token_expires_at, updated_at: connection.updated_at,
      } : null,
    });
  }));

  // Inicio de OAuth: state de un solo uso + URL del diálogo (el navegador navega a Meta).
  router.post('/connections/meta/start', requirePermission('client.config.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const a = actorOf(req);
    if (!deps.meta) throw notEnabled();
    if (!deps.meta.oauthConfigured) throw oauthNotConfigured();
    if (limited(req, res, a.userId, 'meta:start')) return undefined;
    const state = await deps.connections.createOAuthState({ tenantId: a.tenantId, userId: a.userId, provider: META_PROVIDER, redirectUri });
    const url = deps.meta.authorizationUrl({ state, redirectUri, adsRead: deps.config.metaAdsCheckEnabled });
    await audit(a, 'connection.meta.start', 'oauth_state_issued');
    return res.json({ url, redirect_uri: redirectUri, scopes: [...REQUIRED_PAGE_SCOPES, ...(deps.config.metaAdsCheckEnabled ? [ADS_READ_SCOPE] : [])] });
  }));

  // Pages que administra la persona autorizada (nunca se devuelven tokens).
  router.get('/connections/meta/pages', requirePermission('client.config.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const a = actorOf(req);
    if (!deps.meta) throw notEnabled();
    const tokens = await deps.connections.readTokens<MetaTokens>(a.tenantId, META_PROVIDER);
    if (!tokens?.user_token) {
      return res.status(409).json({ error: { code: 'validation_error', message: 'Primero autoriza a MainSpot en Facebook (Conectar Facebook).' } });
    }
    try {
      const pages = await deps.meta.listPages(tokens.user_token);
      return res.json({ pages: pages.map((p) => ({ page_id: p.id, name: p.name, tasks: p.tasks })) });
    } catch (err) {
      await deps.meta.noteAuthFailure(a.tenantId, err);
      throw graphUserError(err);
    }
  }));

  // Elegir la Page: page token verificado contra Meta y guardado cifrado.
  router.post('/connections/meta/select', requirePermission('client.config.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const a = actorOf(req);
    if (!deps.meta) throw notEnabled();
    if (limited(req, res, a.userId, 'meta:select')) return undefined;
    const body: unknown = req.body;
    const pageId = body && typeof body === 'object' && 'page_id' in body && typeof body.page_id === 'string' ? body.page_id.trim() : '';
    if (!/^\d{1,32}$/.test(pageId)) {
      return res.status(400).json({ error: { code: 'validation_error', message: 'Elige una página válida de la lista.' } });
    }
    const tokens = await deps.connections.readTokens<MetaTokens>(a.tenantId, META_PROVIDER);
    if (!tokens?.user_token) {
      return res.status(409).json({ error: { code: 'validation_error', message: 'Primero autoriza a MainSpot en Facebook (Conectar Facebook).' } });
    }
    let page;
    try {
      const available = (await deps.meta.listPages(tokens.user_token)).find((p) => p.id === pageId);
      if (!available) throw new AppError(403, 'permission_denied', 'La página no pertenece a las páginas autorizadas de esta cuenta.');
      if (!available.tasks.some((task) => task === 'CREATE_CONTENT' || task === 'MANAGE')) {
        throw new AppError(403, 'permission_denied', 'La cuenta no tiene una tarea de publicación habilitada en esa página.');
      }
      page = await deps.meta.pageAccess(tokens.user_token, pageId);
    } catch (err) {
      await deps.meta.noteAuthFailure(a.tenantId, err);
      await audit(a, 'connection.meta.select', err instanceof MetaGraphError ? err.shortCode : 'failed', 'deny');
      throw graphUserError(err);
    }
    const verification = await deps.meta.verifyPageToken(page.page_token, page.id);
    const saved = await deps.connections.save<MetaTokens>({
      tenantId: a.tenantId, provider: META_PROVIDER, status: verification.status,
      tokens: { user_token: tokens.user_token, user_token_expires_at: tokens.user_token_expires_at ?? null, page_token: page.page_token },
      scopes: verification.granted_scopes, externalResourceId: page.id, externalResourceName: verification.page_name ?? page.name,
      connectedBy: a.userId, verified: verification.status === 'connected', errorCode: verification.error_code,
    });
    await audit(a, 'connection.meta.select', verification.status, verification.status === 'connected' ? 'allow' : 'deny', page.id);
    log.info('meta.connection.selected', 'facebook page linked to business', { tenant_id: a.tenantId, status: verification.status });
    return res.json({
      status: saved.status, page_id: saved.external_resource_id, page_name: saved.external_resource_name,
      missing_scopes: verification.missing_scopes, tasks: page.tasks,
      message: verification.status === 'connected'
        ? 'Página de Facebook conectada y verificada.'
        : verification.status === 'permission_missing'
          ? 'La página quedó vinculada, pero faltan permisos: vuelve a conectar y acepta todos los permisos.'
          : 'No se pudo verificar la página con Facebook. Revisa el estado e inténtalo de nuevo.',
    });
  }));

  // Re-verificación (token vigente, permisos efectivos, Page accesible).
  router.post('/connections/meta/verify', requirePermission('client.config.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const a = actorOf(req);
    if (!deps.meta) throw notEnabled();
    if (limited(req, res, a.userId, 'meta:verify')) return undefined;
    const connection = await deps.connections.get(a.tenantId, META_PROVIDER);
    const tokens = await deps.connections.readTokens<MetaTokens>(a.tenantId, META_PROVIDER);
    if (!connection?.external_resource_id || !tokens?.page_token) {
      return res.status(409).json({ error: { code: 'validation_error', message: 'Todavía no hay una página de Facebook conectada.' } });
    }
    const v = await deps.meta.verifyPageToken(tokens.page_token, connection.external_resource_id);
    await deps.connections.markStatus(a.tenantId, META_PROVIDER, v.status, v.error_code, v.status === 'connected');
    await audit(a, 'connection.meta.verify', v.status, v.status === 'connected' ? 'allow' : 'deny', connection.external_resource_id);
    return res.json({ status: v.status, page_id: v.page_id, page_name: v.page_name, granted_scopes: v.granted_scopes, missing_scopes: v.missing_scopes, error_code: v.error_code });
  }));

  // Desconexión: revoca ante Meta (best effort) y borra el sobre cifrado SIEMPRE.
  router.post('/connections/meta/disconnect', requirePermission('client.config.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const a = actorOf(req);
    if (!deps.meta) throw notEnabled();
    const tokens = await deps.connections.readTokens<MetaTokens>(a.tenantId, META_PROVIDER);
    const revoked = tokens?.user_token ? await deps.meta.revoke(tokens.user_token) : false;
    await deps.connections.disconnect(a.tenantId, META_PROVIDER);
    await audit(a, 'connection.meta.disconnect', revoked ? 'revoked' : 'local_only');
    return res.json({ status: 'disconnected', revoked_at_provider: revoked, message: 'Facebook desconectado. MainSpot ya no tiene acceso a la página.' });
  }));

  // Ads básicos: SOLO lectura de cuentas publicitarias (sin crear campañas ni gasto).
  router.get('/connections/meta/ads-check', requirePermission('client.config.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const a = actorOf(req);
    if (!deps.meta || !deps.config.metaAdsCheckEnabled) {
      return res.status(404).json({ error: { code: 'not_found', message: 'La comprobación de cuentas publicitarias no está habilitada.' } });
    }
    const tokens = await deps.connections.readTokens<MetaTokens>(a.tenantId, META_PROVIDER);
    if (!tokens?.user_token) {
      return res.status(409).json({ error: { code: 'validation_error', message: 'Primero autoriza a MainSpot en Facebook (Conectar Facebook).' } });
    }
    try {
      const accounts = await deps.meta.listAdAccounts(tokens.user_token);
      await audit(a, 'connection.meta.ads_check', `accounts:${accounts.length}`);
      return res.json({ read_only: true, accounts });
    } catch (err) {
      await audit(a, 'connection.meta.ads_check', err instanceof MetaGraphError ? err.shortCode : 'failed', 'deny');
      throw graphUserError(err);
    }
  }));

  return router;
}

/**
 * Callback PÚBLICO de Facebook Login. Nunca escribe nada sin un state válido; cualquier
 * anomalía vuelve al panel con un código de resultado (sin detalles) y queda en el log.
 */
export function metaOAuthCallbackRouter(deps: MetaConnectionRouteDeps): Router {
  const router = Router();
  const redirectUri = `${deps.config.publicBaseUrl}${META_CALLBACK_PATH}`;
  const back = (res: Response, outcome: string) => res.redirect(303, `${deps.config.publicBaseUrl}${PANEL_RETURN}?conexion=${encodeURIComponent(outcome)}`);

  router.get(META_CALLBACK_PATH, ah(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const q = req.query as Record<string, unknown>;
    const state = typeof q.state === 'string' ? q.state : '';
    const code = typeof q.code === 'string' ? q.code : '';
    if (!deps.meta || !deps.meta.oauthConfigured) return back(res, 'no_habilitado');
    if (!state) return back(res, 'estado_invalido');
    const consumed = await deps.connections.consumeOAuthState(state, META_PROVIDER);
    if (!consumed || consumed.redirectUri !== redirectUri) {
      log.warn('meta.oauth.state_rejected', 'oauth callback with unknown, used or expired state', {});
      return back(res, 'estado_invalido');
    }
    if (typeof q.error === 'string' || !code) {
      await deps.sink.write({
        tenant_id: consumed.tenantId, actor_id: consumed.userId, actor_role: null, action: 'connection.meta.callback',
        resource: 'provider_connection/meta_pages', request_id: `oauth_${Date.now()}`, decision: 'deny', result: typeof q.error === 'string' ? 'user_denied' : 'missing_code',
      }, deps.pool, false).catch(() => undefined);
      return back(res, 'cancelada');
    }
    try {
      const token = await deps.meta.exchangeCode({ code, redirectUri });
      const me = await deps.meta.me(token.user_token);
      const granted = await deps.meta.grantedPermissions(token.user_token);
      const missing = REQUIRED_PAGE_SCOPES.filter((s) => !granted.includes(s));
      await deps.connections.save<MetaTokens>({
        tenantId: consumed.tenantId, provider: META_PROVIDER, status: missing.length ? 'permission_missing' : 'needs_authorization',
        tokens: { user_token: token.user_token, user_token_expires_at: token.expires_at },
        scopes: granted, tokenExpiresAt: token.expires_at ? new Date(token.expires_at) : null,
        externalAccountId: me.id, connectedBy: consumed.userId, errorCode: missing.length ? `missing:${missing.join(',')}` : 'page_not_selected',
      });
      await deps.sink.write({
        tenant_id: consumed.tenantId, actor_id: consumed.userId, actor_role: null, action: 'connection.meta.callback',
        resource: 'provider_connection/meta_pages', request_id: `oauth_${Date.now()}`, decision: 'allow',
        result: missing.length ? `authorized:permission_missing` : 'authorized:select_page',
      }, deps.pool, false).catch(() => undefined);
      return back(res, missing.length ? 'faltan_permisos' : 'elegir_pagina');
    } catch (err) {
      log.warn('meta.oauth.exchange_failed', 'could not exchange oauth code', { tenant_id: consumed.tenantId, code: err instanceof MetaGraphError ? err.shortCode : 'exception' });
      await deps.sink.write({
        tenant_id: consumed.tenantId, actor_id: consumed.userId, actor_role: null, action: 'connection.meta.callback',
        resource: 'provider_connection/meta_pages', request_id: `oauth_${Date.now()}`, decision: 'deny',
        result: err instanceof MetaGraphError ? err.shortCode : 'exchange_failed',
      }, deps.pool, false).catch(() => undefined);
      return back(res, 'error_proveedor');
    }
  }));

  return router;
}
