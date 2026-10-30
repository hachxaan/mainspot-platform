/**
 * DEV-E2E-04 §2A — OAuth 2.0 «web server flow» de Google para la conexión por negocio
 * (https://developers.google.com/my-business/content/implement-oauth,
 *  https://developers.google.com/identity/protocols/oauth2/web-server).
 *
 *  - Autorización con `state` de un solo uso (lo guarda ProviderConnectionRepository) y PKCE S256.
 *  - `access_type=offline` + `prompt=consent` para recibir refresh token; scope business.manage.
 *  - El intercambio del code y la renovación ocurren SOLO en el servidor con el client secret.
 *  - Revocación en https://oauth2.googleapis.com/revoke al desconectar.
 *
 * Ningún token ni secreto aparece en mensajes de error ni en logs: los errores llevan solo el
 * código `error` del cuerpo OAuth (p. ej. invalid_grant) o el status HTTP.
 */

import { createHash, randomBytes } from 'node:crypto';
import { GOOGLE_BUSINESS_SCOPE, type GoogleConnectorConfig } from './config.ts';

export type FetchLike = typeof fetch;

/** Lo que se cifra en provider_connection.token_box para Google. */
export interface GoogleTokenSet {
  access_token: string;
  refresh_token: string | null;
  /** Caducidad del access token (ISO 8601). */
  expires_at: string;
  scope: string;
}

export class GoogleOAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(`google oauth: ${code}`);
    this.name = 'GoogleOAuthError';
    this.code = code;
    this.status = status;
  }
  /** invalid_grant/invalid_client ⇒ hay que volver a autorizar; lo demás es transitorio. */
  get needsAuthorization(): boolean {
    return this.code === 'invalid_grant' || this.code === 'invalid_client' || this.code === 'unauthorized_client';
  }
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge };
}

/** Margen antes de la caducidad a partir del cual el access token se renueva. */
export const TOKEN_REFRESH_SKEW_MS = 60_000;

export function tokenExpired(tokens: Pick<GoogleTokenSet, 'expires_at'>, now = Date.now()): boolean {
  const at = Date.parse(tokens.expires_at);
  return !Number.isFinite(at) || at - now <= TOKEN_REFRESH_SKEW_MS;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

export class GoogleOAuthClient {
  private readonly cfg: GoogleConnectorConfig;
  private readonly fetchImpl: FetchLike;

  constructor(cfg: GoogleConnectorConfig, fetchImpl: FetchLike = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  authorizationUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL(this.cfg.oauthAuthUrl);
    url.searchParams.set('client_id', this.cfg.oauthClientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_BUSINESS_SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'false');
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async exchangeCode(input: { code: string; verifier: string; redirectUri: string }): Promise<GoogleTokenSet> {
    const body = await this.tokenRequest({
      grant_type: 'authorization_code', code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri,
    });
    if (!body.access_token) throw new GoogleOAuthError('missing_access_token', 200);
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? null,
      expires_at: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
      scope: body.scope ?? GOOGLE_BUSINESS_SCOPE,
    };
  }

  /** Renueva el access token; Google no devuelve refresh token nuevo salvo rotación explícita. */
  async refresh(previous: GoogleTokenSet): Promise<GoogleTokenSet> {
    if (!previous.refresh_token) throw new GoogleOAuthError('invalid_grant', 400);
    const body = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: previous.refresh_token });
    if (!body.access_token) throw new GoogleOAuthError('missing_access_token', 200);
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? previous.refresh_token,
      expires_at: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
      scope: body.scope ?? previous.scope,
    };
  }

  /**
   * Revoca el refresh token (y con él los access tokens emitidos). Google responde 200 si lo
   * revocó y 400 si ya no era válido: ambos dejan al negocio desconectado del lado de Google.
   */
  async revoke(tokens: GoogleTokenSet): Promise<'revoked' | 'already_invalid' | 'failed'> {
    const token = tokens.refresh_token ?? tokens.access_token;
    try {
      const res = await this.fetchImpl(this.cfg.oauthRevokeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
      });
      if (res.ok) return 'revoked';
      return res.status === 400 ? 'already_invalid' : 'failed';
    } catch {
      return 'failed';
    }
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.cfg.oauthTokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...params, client_id: this.cfg.oauthClientId, client_secret: this.cfg.oauthClientSecret }).toString(),
        signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
      });
    } catch {
      throw new GoogleOAuthError('token_endpoint_unreachable', 0);
    }
    const body = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok) {
      const code = typeof body.error === 'string' && /^[a-z_]{1,40}$/.test(body.error) ? body.error : `oauth_http_${res.status}`;
      throw new GoogleOAuthError(code, res.status);
    }
    return body;
  }
}
