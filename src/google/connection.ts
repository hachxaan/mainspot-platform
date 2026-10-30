/**
 * DEV-E2E-04 §2A — conexión OAuth de un negocio con Google Business Profile.
 *
 * Flujo: Administración pulsa «Conectar Google» → `start` crea un `state` de un solo uso con
 * verificador PKCE cifrado y devuelve la URL de autorización → Google vuelve al callback público
 * (`/api/connections/google/callback`, autenticado SOLO por el state) → `callback` consume el state
 * de forma atómica, intercambia el code en el servidor y guarda los tokens cifrados (AAD tenant/
 * proveedor) → descubrimiento de cuentas/ubicaciones realmente accesibles → Administración elige
 * la ubicación → `connected` solo después de leer esa ubicación con una llamada autenticada.
 *
 * Invariantes:
 *  - El recurso externo es el nombre que devolvió Google (accounts/{a}, locations/{l}); nunca el
 *    tenant_id. Ningún token sale por la API, logs ni auditoría.
 *  - Desconectar revoca el refresh token en Google y borra el sobre cifrado (el negocio recupera
 *    el control exclusivo: política de «Termination of end-client relationship»).
 *  - Sin GOOGLE_OAUTH_CLIENT_ID/SECRET o sin CONNECTOR_TOKEN_KEY no se inicia nada: el estado es
 *    BLOCKED_EXTERNAL con los NOMBRES de lo que falta.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import type { ProviderConnection, ProviderConnectionRepository } from '../connectors/repository.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import { GOOGLE_PROVIDER, GoogleApiError, GoogleBusinessClient, type GoogleLocation } from './client.ts';
import { GOOGLE_BUSINESS_SCOPE, GOOGLE_CALLBACK_PATH, googleBlockedPrerequisites, googleOAuthConfigured, type GoogleConnectorConfig } from './config.ts';
import { createPkce, GoogleOAuthClient, GoogleOAuthError, type GoogleTokenSet } from './oauth.ts';

export interface Actor { tenantId: string; userId: string; role: string | null; requestId: string }

export interface GoogleConnectionView {
  provider: typeof GOOGLE_PROVIDER;
  /** Estado persistido; `disconnected` si el negocio nunca se conectó. */
  status: ProviderConnection['status'];
  connection: ProviderConnection | null;
  /** Hay token pero falta elegir la ubicación (descubrimiento pendiente). */
  needs_location: boolean;
  oauth_configured: boolean;
  /** Prerrequisitos externos ausentes (nombres de variables; nunca valores). */
  blocked_prerequisites: string[];
  redirect_uri: string;
}

export interface DiscoveredAccount {
  name: string;
  account_name: string | null;
  type: string | null;
  verification_state: string | null;
  locations: Array<{ name: string; title: string | null; store_code: string | null; address: string | null; verified: boolean }>;
}

export type CallbackOutcome = 'connected' | 'needs_location' | 'error';

export interface GoogleConnectionServiceDeps {
  pool: Pool;
  sink: AuditSink;
  connections: ProviderConnectionRepository;
  oauth: GoogleOAuthClient;
  client: GoogleBusinessClient;
  cfg: GoogleConnectorConfig;
  publicBaseUrl: string;
}

const ACCOUNT_RE = /^accounts\/[A-Za-z0-9_-]{1,64}$/;
const LOCATION_RE = /^locations\/[A-Za-z0-9_-]{1,64}$/;
const ERROR_LOCATION_PENDING = 'location_not_selected';

function addressOf(loc: GoogleLocation): string | null {
  const a = loc.storefrontAddress;
  if (!a) return null;
  const parts = [...(a.addressLines ?? []), a.locality, a.administrativeArea, a.postalCode].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export class GoogleConnectionService {
  private readonly deps: GoogleConnectionServiceDeps;

  constructor(deps: GoogleConnectionServiceDeps) {
    this.deps = deps;
  }

  /** URI de retorno registrada en el cliente OAuth (lista blanca: una sola, derivada de PUBLIC_BASE_URL). */
  redirectUri(): string {
    return this.deps.cfg.oauthRedirectUri || `${this.deps.publicBaseUrl}${GOOGLE_CALLBACK_PATH}`;
  }

  async view(tenantId: string): Promise<GoogleConnectionView> {
    const connection = await this.deps.connections.get(tenantId, GOOGLE_PROVIDER);
    return {
      provider: GOOGLE_PROVIDER,
      status: connection?.status ?? 'disconnected',
      connection,
      needs_location: Boolean(connection && connection.has_token && !connection.external_resource_id && connection.status !== 'disconnected'),
      oauth_configured: googleOAuthConfigured(this.deps.cfg),
      blocked_prerequisites: googleBlockedPrerequisites(this.deps.cfg, this.deps.connections.canStoreTokens),
      redirect_uri: this.redirectUri(),
    };
  }

  /** Crea el state + PKCE y devuelve la URL de Google a la que debe ir la persona administradora. */
  async start(actor: Actor): Promise<{ authorization_url: string; expires_in_minutes: number }> {
    const blocked = googleBlockedPrerequisites(this.deps.cfg, this.deps.connections.canStoreTokens);
    if (blocked.length) {
      throw new AppError(409, 'validation_error', `La conexión con Google todavía no está habilitada en este entorno (falta: ${blocked.join(', ')}).`);
    }
    const pkce = createPkce();
    const redirectUri = this.redirectUri();
    const state = await this.deps.connections.createOAuthState({
      tenantId: actor.tenantId, userId: actor.userId, provider: GOOGLE_PROVIDER, redirectUri, verifier: pkce.verifier,
    });
    await this.deps.sink.write({
      tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
      action: 'google.connection.started', resource: 'provider_connection/google_business_profile',
      request_id: actor.requestId, decision: 'allow', result: 'authorization_url_issued',
    });
    return { authorization_url: this.deps.oauth.authorizationUrl({ state, codeChallenge: pkce.challenge, redirectUri }), expires_in_minutes: 10 };
  }

  /**
   * Retorno de Google. Nunca lanza: devuelve el resultado para redirigir al panel con un código
   * (sin tokens ni mensajes crudos del proveedor en la URL).
   */
  async callback(input: { code?: string; state?: string; error?: string }): Promise<{ outcome: CallbackOutcome; code: string; tenantId: string | null }> {
    const state = typeof input.state === 'string' ? input.state : '';
    if (!state || state.length > 200) return { outcome: 'error', code: 'invalid_state', tenantId: null };
    const consumed = await this.deps.connections.consumeOAuthState(state, GOOGLE_PROVIDER);
    if (!consumed) return { outcome: 'error', code: 'invalid_state', tenantId: null };
    if (consumed.redirectUri !== this.redirectUri()) return { outcome: 'error', code: 'invalid_redirect', tenantId: consumed.tenantId };
    const { tenantId, userId } = consumed;
    const audit = (result: string) => this.deps.sink.write({
      tenant_id: tenantId, actor_id: userId, actor_role: null,
      action: 'google.connection.authorized', resource: 'provider_connection/google_business_profile',
      request_id: `oauth_${randomUUID()}`, decision: result.startsWith('error') ? 'deny' : 'allow', result,
    });
    if (typeof input.error === 'string' && input.error) {
      const code = /^[a-z_]{1,40}$/.test(input.error) ? input.error : 'provider_error';
      await this.rememberFailure(tenantId, `oauth_${code}`);
      await audit(`error:${code}`);
      return { outcome: 'error', code, tenantId };
    }
    if (typeof input.code !== 'string' || !input.code || !consumed.verifier) {
      await audit('error:missing_code');
      return { outcome: 'error', code: 'missing_code', tenantId };
    }
    let tokens: GoogleTokenSet;
    try {
      tokens = await this.deps.oauth.exchangeCode({ code: input.code, verifier: consumed.verifier, redirectUri: consumed.redirectUri });
    } catch (err) {
      const code = err instanceof GoogleOAuthError ? err.code : 'token_exchange_failed';
      await this.rememberFailure(tenantId, `oauth_${code}`);
      await audit(`error:${code}`);
      return { outcome: 'error', code, tenantId };
    }
    if (!tokens.scope.split(/\s+/).includes(GOOGLE_BUSINESS_SCOPE)) {
      await this.rememberFailure(tenantId, 'scope_missing');
      await audit('error:scope_missing');
      return { outcome: 'error', code: 'scope_missing', tenantId };
    }
    if (!tokens.refresh_token) {
      // Sin refresh token la conexión caducaría en una hora: Google lo omite si ya había
      // consentimiento previo sin prompt=consent; se pide reautorizar.
      await this.rememberFailure(tenantId, 'refresh_token_missing');
      await audit('error:refresh_token_missing');
      return { outcome: 'error', code: 'refresh_token_missing', tenantId };
    }
    await this.deps.connections.save<GoogleTokenSet>({
      tenantId, provider: GOOGLE_PROVIDER, status: 'needs_authorization', tokens, scopes: tokens.scope.split(/\s+/),
      tokenExpiresAt: new Date(tokens.expires_at), connectedBy: userId, errorCode: ERROR_LOCATION_PENDING,
    });
    const auto = await this.autoSelectSingleLocation(tenantId);
    await audit(auto.outcome === 'error' ? `error:${auto.code}` : auto.outcome);
    return { ...auto, tenantId };
  }
  /**
   * Tras autorizar: si el negocio ya tenía una ubicación elegida y sigue accesible se conserva; si
   * la cuenta autorizada solo tiene una ubicación accesible queda elegida sin más pasos.
   */
  private async autoSelectSingleLocation(tenantId: string): Promise<{ outcome: CallbackOutcome; code: string }> {
    try {
      const existing = await this.deps.connections.get(tenantId, GOOGLE_PROVIDER);
      const accounts = await this.discover(tenantId);
      const all = accounts.flatMap((a) => a.locations.map((l) => ({ account: a.name, location: l.name })));
      const previous = existing?.external_account_id && existing.external_resource_id
        ? all.find((x) => x.account === existing.external_account_id && x.location === existing.external_resource_id) : undefined;
      const pick = previous ?? (all.length === 1 ? all[0] : undefined);
      if (pick) {
        await this.bind(tenantId, pick.account, pick.location, null);
        return { outcome: 'connected', code: 'connected' };
      }
      return { outcome: 'needs_location', code: all.length === 0 ? 'no_locations' : 'choose_location' };
    } catch (err) {
      if (err instanceof GoogleApiError) return { outcome: 'error', code: err.reason };
      throw err;
    }
  }

  private async rememberFailure(tenantId: string, code: string): Promise<void> {
    const existing = await this.deps.connections.get(tenantId, GOOGLE_PROVIDER);
    if (existing) {
      await this.deps.connections.markStatus(tenantId, GOOGLE_PROVIDER, existing.has_token ? existing.status : 'needs_authorization', code);
      return;
    }
    await this.deps.connections.save({ tenantId, provider: GOOGLE_PROVIDER, status: 'needs_authorization', tokens: null, errorCode: code });
  }

  /** Cuentas y ubicaciones realmente accesibles con la cuenta Google autorizada (llamadas en vivo). */
  async discover(tenantId: string): Promise<DiscoveredAccount[]> {
    const accounts = await this.deps.client.listAccounts(tenantId);
    const out: DiscoveredAccount[] = [];
    for (const acc of accounts) {
      if (!ACCOUNT_RE.test(acc.name)) continue;
      const locations = await this.deps.client.listLocations(tenantId, acc.name);
      out.push({
        name: acc.name, account_name: acc.accountName ?? null, type: acc.type ?? null, verification_state: acc.verificationState ?? null,
        locations: locations.filter((l) => LOCATION_RE.test(l.name)).map((l) => ({
          name: l.name, title: l.title ?? null, store_code: l.storeCode ?? null, address: addressOf(l), verified: l.metadata?.hasVoiceOfMerchant === true,
        })),
      });
    }
    return out;
  }

  async listLocations(actor: Actor): Promise<{ accounts: DiscoveredAccount[] }> {
    const accounts = await this.wrap(() => this.discover(actor.tenantId));
    return { accounts };
  }

  /** Administración elige la ubicación; se confirma leyéndola en Google antes de marcar `connected`. */
  async selectLocation(actor: Actor, body: unknown): Promise<ProviderConnection> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const account = typeof b['account'] === 'string' ? b['account'] : '';
    const location = typeof b['location'] === 'string' ? b['location'] : '';
    if (!ACCOUNT_RE.test(account) || !LOCATION_RE.test(location)) {
      throw new AppError(400, 'validation_error', 'Elige una cuenta y una ubicación de la lista de Google.');
    }
    return this.wrap(async () => {
      const listed = await this.deps.client.listLocations(actor.tenantId, account);
      if (!listed.some((l) => l.name === location)) {
        throw new AppError(404, 'not_found', 'Esa ubicación no está disponible en la cuenta de Google autorizada.');
      }
      return this.bind(actor.tenantId, account, location, actor);
    });
  }

  private async bind(tenantId: string, account: string, location: string, actor: Actor | null): Promise<ProviderConnection> {
    const read = await this.deps.client.getLocation(tenantId, location, 'name,title,metadata');
    const tokens = await this.deps.connections.readTokens<GoogleTokenSet>(tenantId, GOOGLE_PROVIDER);
    if (!tokens) throw new GoogleApiError('not_connected', 0, 'not_connected');
    const parent = `${account}/${location}`;
    await this.deps.pool.query('DELETE FROM google_review_cursor WHERE tenant_id = $1 AND location_parent <> $2', [tenantId, parent]);
    const saved = await this.deps.connections.save<GoogleTokenSet>({
      tenantId, provider: GOOGLE_PROVIDER, status: 'connected', tokens, tokenExpiresAt: new Date(tokens.expires_at),
      externalAccountId: account, externalResourceId: location, externalResourceName: read.title ?? location,
      verified: true, errorCode: null, connectedBy: actor?.userId ?? null,
    });
    await this.deps.sink.write({
      tenant_id: tenantId, actor_id: actor?.userId ?? 'system:google-oauth', actor_role: actor?.role ?? null,
      action: 'google.connection.location_selected', resource: `provider_connection/${saved.connection_id}`,
      request_id: actor?.requestId ?? `bind_${saved.connection_id}`, decision: 'allow',
      result: read.metadata?.hasVoiceOfMerchant === false ? 'connected:location_unverified' : 'connected',
    });
    log.info('google.connection.connected', 'google business profile location bound', { tenant_id: tenantId, connection_id: saved.connection_id });
    return saved;
  }

  /** Comprobación bajo demanda: una lectura autenticada de la ubicación elegida actualiza el estado. */
  async verify(actor: Actor): Promise<ProviderConnection> {
    const conn = await this.deps.connections.get(actor.tenantId, GOOGLE_PROVIDER);
    if (!conn || !conn.has_token) throw new AppError(409, 'validation_error', 'Este negocio no tiene una conexión con Google que comprobar.');
    if (!conn.external_resource_id) throw new AppError(409, 'validation_error', 'Falta elegir la ubicación de Google.');
    await this.wrap(() => this.deps.client.getLocation(actor.tenantId, conn.external_resource_id!, 'name,title,metadata'));
    const after = await this.deps.connections.get(actor.tenantId, GOOGLE_PROVIDER);
    await this.deps.sink.write({
      tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
      action: 'google.connection.verified', resource: `provider_connection/${conn.connection_id}`,
      request_id: actor.requestId, decision: 'allow', result: after?.status ?? 'unknown',
    });
    return after!;
  }

  /** Revoca en Google (mejor esfuerzo) y borra el sobre cifrado; el negocio queda desconectado siempre. */
  async disconnect(actor: Actor): Promise<{ status: 'disconnected'; revocation: 'revoked' | 'already_invalid' | 'failed' | 'no_token' }> {
    const tokens = await this.deps.connections.readTokens<GoogleTokenSet>(actor.tenantId, GOOGLE_PROVIDER).catch(() => null);
    const revocation = tokens ? await this.deps.oauth.revoke(tokens) : 'no_token';
    const existing = await this.deps.connections.get(actor.tenantId, GOOGLE_PROVIDER);
    if (existing) await this.deps.connections.disconnect(actor.tenantId, GOOGLE_PROVIDER);
    await this.deps.pool.query('DELETE FROM google_review_cursor WHERE tenant_id = $1', [actor.tenantId]);
    await this.deps.sink.write({
      tenant_id: actor.tenantId, actor_id: actor.userId, actor_role: actor.role,
      action: 'google.connection.disconnected', resource: 'provider_connection/google_business_profile',
      request_id: actor.requestId, decision: 'allow', result: `disconnected:${revocation}`,
    });
    return { status: 'disconnected', revocation };
  }

  /**
   * Aprovisionamiento de LABORATORIO: un refresh token obtenido por el titular fuera del panel
   * (p. ej. OAuth Playground con su propio cliente) se guarda cifrado para pruebas controladas.
   * NO equivale al onboarding OAuth del SaaS: no hay state/PKCE ni consentimiento en el panel; el
   * token se recibe por stdin/archivo 0600 (scripts/google-provision-lab-token.ts), nunca por argv.
   */
  async provisionLabRefreshToken(input: { tenantId: string; operatorId: string; refreshToken: string }): Promise<GoogleConnectionView> {
    if (!googleOAuthConfigured(this.deps.cfg)) throw new AppError(409, 'validation_error', 'Faltan GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET.');
    let tokens: GoogleTokenSet;
    try {
      tokens = await this.deps.oauth.refresh({ access_token: '', refresh_token: input.refreshToken.trim(), expires_at: new Date(0).toISOString(), scope: GOOGLE_BUSINESS_SCOPE });
    } catch (err) {
      const code = err instanceof GoogleOAuthError ? err.code : 'refresh_failed';
      throw new AppError(409, 'validation_error', `Google no aceptó el refresh token (${code}).`);
    }
    await this.deps.connections.save<GoogleTokenSet>({
      tenantId: input.tenantId, provider: GOOGLE_PROVIDER, status: 'needs_authorization', tokens, scopes: tokens.scope.split(/\s+/),
      tokenExpiresAt: new Date(tokens.expires_at), connectedBy: `operator:${input.operatorId}`, errorCode: ERROR_LOCATION_PENDING,
    });
    const auto = await this.autoSelectSingleLocation(input.tenantId);
    await this.deps.sink.write({
      tenant_id: input.tenantId, actor_id: `operator:${input.operatorId}`, actor_role: null,
      action: 'google.connection.lab_provisioned', resource: 'provider_connection/google_business_profile',
      request_id: `lab_${Date.now()}`, decision: 'allow', result: `${auto.outcome}:${auto.code}`,
    });
    return this.view(input.tenantId);
  }

  /** Errores de Google → respuestas HTTP honestas (el estado de la conexión ya lo actualizó el cliente). */
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof GoogleApiError)) throw err;
      switch (err.kind) {
        case 'not_connected': throw new AppError(409, 'validation_error', 'Este negocio no está conectado con Google.');
        case 'needs_authorization': throw new AppError(409, 'validation_error', 'Google ya no acepta la autorización guardada. Vuelve a conectar Google.');
        case 'permission_missing': throw new AppError(409, 'validation_error', `Google no permite esta operación al proyecto o a la cuenta autorizada (${err.reason}).`);
        case 'not_found': throw new AppError(404, 'not_found', 'Google ya no devuelve ese recurso.');
        case 'rate_limited': throw new AppError(429, 'validation_error', 'Google pidió esperar antes de volver a intentarlo.');
        case 'provider_unavailable': throw new AppError(503, 'validation_error', 'Google no respondió. Inténtalo de nuevo en un momento.');
        default: throw new AppError(400, 'validation_error', `Google rechazó la solicitud (${err.reason}).`);
      }
    }
  }
}
