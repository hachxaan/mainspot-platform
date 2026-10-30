/**
 * DEV-E2E-04 §2A — cliente HTTP autenticado de las APIs de Google Business Profile, por negocio.
 *
 * Toma los tokens cifrados de la conexión del tenant (ProviderConnectionRepository), renueva el
 * access token antes de que caduque y, ante un 401, lo renueva UNA vez y reintenta; si sigue
 * fallando la conexión pasa a `needs_authorization`. Mapa de errores (sin cuerpos crudos):
 *   401                      → needs_authorization (reautorizar)
 *   403 PERMISSION_DENIED,
 *   API no habilitada, cuota 0 → permission_missing (BLOCKED_EXTERNAL: lo resuelve el titular/GCP)
 *   404                      → not_found (recurso ya no accesible)
 *   429 RESOURCE_EXHAUSTED   → rate_limited (espera Retry-After; reintento acotado, luego backoff)
 *   5xx / red / timeout      → provider_unavailable (transitorio)
 * Hosts por API (verificados en la referencia oficial): accounts.list en Account Management,
 * locations en Business Information, reviews/reply en My Business v4.
 */

import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderConnection, ProviderConnectionRepository, ConnectionStatus } from '../connectors/repository.ts';
import { log } from '../shared/logger.ts';
import type { GoogleConnectorConfig } from './config.ts';
import { GoogleOAuthClient, GoogleOAuthError, tokenExpired, type FetchLike, type GoogleTokenSet } from './oauth.ts';

export const GOOGLE_PROVIDER = 'google_business_profile' as const;

export type GoogleErrorKind =
  | 'not_connected' | 'needs_authorization' | 'permission_missing' | 'not_found'
  | 'invalid_request' | 'rate_limited' | 'provider_unavailable';

export class GoogleApiError extends Error {
  readonly kind: GoogleErrorKind;
  readonly status: number;
  /** Código estable para auditoría/estado (p. ej. PERMISSION_DENIED, accessNotConfigured). */
  readonly reason: string;
  readonly retryAfterMs: number | null;

  constructor(kind: GoogleErrorKind, status: number, reason: string, retryAfterMs: number | null = null) {
    super(`google api: ${kind} (${reason})`);
    this.name = 'GoogleApiError';
    this.kind = kind;
    this.status = status;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }

  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'provider_unavailable';
  }

  /** Estado de conexión que refleja este fallo; null si no cambia el estado. */
  get connectionStatus(): ConnectionStatus | null {
    switch (this.kind) {
      case 'needs_authorization': return 'needs_authorization';
      case 'permission_missing': return 'permission_missing';
      case 'provider_unavailable': return 'provider_unavailable';
      default: return null;
    }
  }
}

export interface GoogleAccount {
  name: string;
  accountName?: string;
  type?: string;
  verificationState?: string;
  role?: string;
}

export interface GoogleTimeOfDay { hours?: number; minutes?: number }
export interface GoogleTimePeriod { openDay: string; openTime: GoogleTimeOfDay; closeDay: string; closeTime: GoogleTimeOfDay }

export interface GoogleLocation {
  name: string;
  title?: string;
  storeCode?: string;
  websiteUri?: string;
  phoneNumbers?: { primaryPhone?: string; additionalPhones?: string[] };
  regularHours?: { periods?: GoogleTimePeriod[] };
  storefrontAddress?: { regionCode?: string; postalCode?: string; administrativeArea?: string; locality?: string; addressLines?: string[] };
  profile?: { description?: string };
  categories?: { primaryCategory?: { name?: string; displayName?: string } };
  latlng?: { latitude?: number; longitude?: number };
  metadata?: { hasVoiceOfMerchant?: boolean; placeId?: string; mapsUri?: string; canHaveBusinessCalls?: boolean };
}

export interface GoogleReviewReply { comment: string; updateTime?: string }
export interface GoogleReview {
  name: string;
  reviewId: string;
  reviewer?: { displayName?: string; isAnonymous?: boolean };
  starRating?: 'STAR_RATING_UNSPECIFIED' | 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: GoogleReviewReply;
}

export interface ListReviewsPage { reviews: GoogleReview[]; nextPageToken: string | null; totalReviewCount: number | null }

/** readMask de la ficha: solo los campos que MainSpot muestra o edita. */
export const LOCATION_READ_MASK = 'name,title,storeCode,websiteUri,phoneNumbers,regularHours,storefrontAddress,profile,categories,latlng,metadata';
const LOCATION_LIST_READ_MASK = 'name,title,storeCode,storefrontAddress,metadata';
const REVIEWS_PAGE_SIZE = 50;

interface GoogleErrorBody {
  error?: { code?: number; status?: string; message?: string; errors?: Array<{ reason?: string }> };
}

export interface GoogleBusinessClientDeps {
  cfg: GoogleConnectorConfig;
  connections: ProviderConnectionRepository;
  oauth: GoogleOAuthClient;
  fetchImpl?: FetchLike;
  /** Espera máxima en línea ante 429 antes de dejar el backoff al llamador. */
  maxInlineRetryWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface RequestInput {
  method: 'GET' | 'PATCH' | 'PUT';
  url: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export class GoogleBusinessClient {
  private readonly deps: Required<Pick<GoogleBusinessClientDeps, 'cfg' | 'connections' | 'oauth'>> & { fetchImpl: FetchLike; maxInlineRetryWaitMs: number; sleep: (ms: number) => Promise<void> };

  constructor(deps: GoogleBusinessClientDeps) {
    this.deps = {
      cfg: deps.cfg, connections: deps.connections, oauth: deps.oauth,
      fetchImpl: deps.fetchImpl ?? fetch,
      maxInlineRetryWaitMs: deps.maxInlineRetryWaitMs ?? 5000,
      sleep: deps.sleep ?? ((ms) => delay(ms)),
    };
  }

  // ---- Account Management API
  async listAccounts(tenantId: string): Promise<GoogleAccount[]> {
    const out: GoogleAccount[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.request<{ accounts?: GoogleAccount[]; nextPageToken?: string }>(tenantId, {
        method: 'GET', url: `${this.deps.cfg.accountManagementBaseUrl}/v1/accounts`, query: { pageSize: '20', pageToken },
      });
      out.push(...(page.accounts ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && out.length < 200);
    return out;
  }

  // ---- Business Information API
  async listLocations(tenantId: string, accountName: string): Promise<GoogleLocation[]> {
    const out: GoogleLocation[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.request<{ locations?: GoogleLocation[]; nextPageToken?: string }>(tenantId, {
        method: 'GET', url: `${this.deps.cfg.businessInformationBaseUrl}/v1/${accountName}/locations`,
        query: { pageSize: '100', readMask: LOCATION_LIST_READ_MASK, pageToken },
      });
      out.push(...(page.locations ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && out.length < 1000);
    return out;
  }

  getLocation(tenantId: string, locationName: string, readMask = LOCATION_READ_MASK): Promise<GoogleLocation> {
    return this.request<GoogleLocation>(tenantId, {
      method: 'GET', url: `${this.deps.cfg.businessInformationBaseUrl}/v1/${locationName}`, query: { readMask },
    });
  }

  patchLocation(tenantId: string, locationName: string, updateMask: string, body: Partial<GoogleLocation>): Promise<GoogleLocation> {
    return this.request<GoogleLocation>(tenantId, {
      method: 'PATCH', url: `${this.deps.cfg.businessInformationBaseUrl}/v1/${locationName}`, query: { updateMask }, body,
    });
  }

  // ---- My Business API v4 (reviews)
  async listReviews(tenantId: string, parent: string, pageToken: string | null): Promise<ListReviewsPage> {
    const page = await this.request<{ reviews?: GoogleReview[]; nextPageToken?: string; totalReviewCount?: number }>(tenantId, {
      method: 'GET', url: `${this.deps.cfg.myBusinessV4BaseUrl}/v4/${parent}/reviews`,
      query: { pageSize: String(REVIEWS_PAGE_SIZE), orderBy: 'updateTime desc', pageToken: pageToken ?? undefined },
    });
    return { reviews: page.reviews ?? [], nextPageToken: page.nextPageToken ?? null, totalReviewCount: page.totalReviewCount ?? null };
  }

  getReview(tenantId: string, reviewName: string): Promise<GoogleReview> {
    return this.request<GoogleReview>(tenantId, { method: 'GET', url: `${this.deps.cfg.myBusinessV4BaseUrl}/v4/${reviewName}` });
  }

  updateReply(tenantId: string, reviewName: string, comment: string): Promise<GoogleReviewReply> {
    return this.request<GoogleReviewReply>(tenantId, {
      method: 'PUT', url: `${this.deps.cfg.myBusinessV4BaseUrl}/v4/${reviewName}/reply`, body: { comment },
    });
  }

  // ---- tokens

  /** Tokens vigentes del negocio (renovados si hace falta). Lanza not_connected/needs_authorization. */
  async currentTokens(tenantId: string): Promise<GoogleTokenSet> {
    const conn = await this.deps.connections.get(tenantId, GOOGLE_PROVIDER);
    const tokens = await this.deps.connections.readTokens<GoogleTokenSet>(tenantId, GOOGLE_PROVIDER);
    if (!conn || !tokens || conn.status === 'disconnected') throw new GoogleApiError('not_connected', 0, 'not_connected');
    return tokenExpired(tokens) ? this.refreshTokens(tenantId, conn, tokens) : tokens;
  }

  private async refreshTokens(tenantId: string, conn: ProviderConnection, tokens: GoogleTokenSet): Promise<GoogleTokenSet> {
    try {
      const fresh = await this.deps.oauth.refresh(tokens);
      const changed = await this.deps.connections.replaceTokens(tenantId, GOOGLE_PROVIDER, tokens, fresh, new Date(fresh.expires_at));
      if (!changed) {
        const current = await this.deps.connections.readTokens<GoogleTokenSet>(tenantId, GOOGLE_PROVIDER);
        if (!current) throw new GoogleApiError('not_connected', 0, 'revoked_during_refresh');
        return current;
      }
      return fresh;
    } catch (err) {
      if (err instanceof GoogleApiError) throw err;
      if (err instanceof GoogleOAuthError && err.needsAuthorization) {
        await this.deps.connections.markStatus(tenantId, GOOGLE_PROVIDER, 'needs_authorization', `oauth_${err.code}`);
        throw new GoogleApiError('needs_authorization', err.status, `oauth_${err.code}`);
      }
      const code = err instanceof GoogleOAuthError ? `oauth_${err.code}` : 'oauth_refresh_failed';
      throw new GoogleApiError('provider_unavailable', err instanceof GoogleOAuthError ? err.status : 0, code);
    }
  }

  /** Llamada autenticada con renovación ante 401 (una vez) y reintento acotado ante 429. */
  async request<T>(tenantId: string, input: RequestInput): Promise<T> {
    const conn = await this.deps.connections.get(tenantId, GOOGLE_PROVIDER);
    let tokens = await this.currentTokens(tenantId);
    let refreshed = false;
    let waited = false;
    for (;;) {
      const res = await this.send(input, tokens.access_token);
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        tokens = await this.refreshTokens(tenantId, conn!, tokens);
        continue;
      }
      const err = res.status === 401 ? new GoogleApiError('needs_authorization', 401, 'UNAUTHENTICATED') : await this.mapError(res);
      if (!err) {
        if (conn && conn.status !== 'connected' && conn.external_resource_id && conn.status !== 'disconnected') {
          await this.deps.connections.markStatus(tenantId, GOOGLE_PROVIDER, 'connected', null, true);
        }
        return (await res.json().catch(() => ({}))) as T;
      }
      if (err.kind === 'rate_limited' && !waited && err.retryAfterMs !== null && err.retryAfterMs <= this.deps.maxInlineRetryWaitMs) {
        waited = true;
        await this.deps.sleep(err.retryAfterMs);
        continue;
      }
      const status = err.connectionStatus;
      if (status && conn && conn.status !== 'disconnected') {
        await this.deps.connections.markStatus(tenantId, GOOGLE_PROVIDER, status, err.reason);
      }
      log.warn('google.api.failed', 'google business profile call failed', { tenant_id: tenantId, kind: err.kind, status: err.status, reason: err.reason });
      throw err;
    }
  }

  private async send(input: RequestInput, accessToken: string): Promise<Response> {
    const url = new URL(input.url);
    for (const [k, v] of Object.entries(input.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
    if (input.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.deps.fetchImpl(url.toString(), {
        method: input.method, headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(this.deps.cfg.requestTimeoutMs),
      });
    } catch (err) {
      const timeout = err instanceof Error && err.name === 'TimeoutError';
      throw new GoogleApiError('provider_unavailable', 0, timeout ? 'timeout' : 'network_error');
    }
  }

  /** null si la respuesta es correcta; si no, el error mapeado (consume el cuerpo). */
  private async mapError(res: Response): Promise<GoogleApiError | null> {
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as GoogleErrorBody;
    const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) ? value : '';
    const gStatus = safeCode(body.error?.status);
    const reason = safeCode(body.error?.errors?.[0]?.reason);
    const message = body.error?.message ?? '';
    const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
    switch (res.status) {
      case 403:
        return new GoogleApiError('permission_missing', 403, reason === 'accessNotConfigured' ? 'API_NOT_ENABLED' : (gStatus || reason || 'PERMISSION_DENIED'));
      case 404:
        return new GoogleApiError('not_found', 404, gStatus || 'NOT_FOUND');
      case 429:
        // Un proyecto sin acceso aprobado a GBP tiene cuota 0: no es un pico transitorio.
        if (/\blimit:\s*0\b/i.test(message)) return new GoogleApiError('permission_missing', 429, 'QUOTA_ZERO');
        return new GoogleApiError('rate_limited', 429, gStatus || 'RESOURCE_EXHAUSTED', retryAfter ?? 1000);
      default:
        if (res.status >= 500) return new GoogleApiError('provider_unavailable', res.status, gStatus || `http_${res.status}`, retryAfter);
        return new GoogleApiError('invalid_request', res.status, gStatus || reason || `http_${res.status}`);
    }
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Calificación v4 (enum) → entero 1..5; 0 si no viene. */
export function starRatingToNumber(rating: GoogleReview['starRating']): number {
  switch (rating) {
    case 'ONE': return 1;
    case 'TWO': return 2;
    case 'THREE': return 3;
    case 'FOUR': return 4;
    case 'FIVE': return 5;
    default: return 0;
  }
}
