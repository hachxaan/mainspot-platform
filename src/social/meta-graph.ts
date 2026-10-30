/**
 * Meta Graph API REAL para Facebook Pages (DEV-E2E-04 §2B, DEC-017/026).
 *
 * - Un cliente HTTP fino sobre `fetch` con versión de Graph fijada por configuración
 *   (META_GRAPH_VERSION; la vigente se consulta en el changelog oficial
 *   https://developers.facebook.com/docs/graph-api/changelog — v26.0 al escribir esto) y
 *   `appsecret_proof` cuando hay app secret (peticiones seguras).
 * - Clasificación de errores según la guía oficial (docs/graph-api/guides/error-handling):
 *   190/102/OAuthException ⇒ token inválido (reconectar); 10 y 200–299 ⇒ permiso faltante;
 *   4/17/32/341/613 y HTTP 429 ⇒ cuota (backoff/Retry-After); 1/2 y 5xx ⇒ transitorio;
 *   506 ⇒ publicación duplicada (reconciliar, no reenviar); 100/subcode 33 ⇒ no existe.
 * - `MetaPagesAdapter` usa la CONEXIÓN DEL NEGOCIO (provider_connection: Page ID real y page
 *   token cifrado), nunca un token global ni el tenant_id como identificador de Page.
 *   Publicar = POST /{page-id}/feed + read-back GET /{post-id}; sin acuse no hay `published`.
 *   Un timeout o un fallo de read-back devuelve `uncertain` (el scheduler reconcilia con
 *   `findPublishedPost`, que relee el identificador conocido). Sin id exige revisión humana.
 * - Secretos: los tokens solo viven en memoria durante la llamada; nunca en logs, auditoría,
 *   errores HTTP ni mensajes de excepción (los mensajes de Meta se recortan a su código).
 */

import { createHash, createHmac } from 'node:crypto';
import type { ProviderConnection, ProviderConnectionRepository } from '../connectors/repository.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import type { SocialPage, SocialPostInput, SocialPostLookup, SocialPublishResult, SocialProvider } from './provider.ts';

export const META_PROVIDER = 'meta_pages' as const;

/** Permisos de Facebook Login que MainSpot necesita (nombres de la referencia oficial
 *  https://developers.facebook.com/docs/permissions): listar Pages, leer contenido propio,
 *  publicar, leer comentarios de usuarios y responderlos. */
export const REQUIRED_PAGE_SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content', 'pages_manage_engagement',
] as const;
/** Solo lectura de cuentas publicitarias (Ads básicos, META_ADS_CHECK=on): nunca gasto. */
export const ADS_READ_SCOPE = 'ads_read';

export type MetaErrorKind = 'invalid_token' | 'permission_missing' | 'rate_limited' | 'transient' | 'not_found' | 'duplicate' | 'timeout' | 'provider_error';

export class MetaGraphError extends Error {
  readonly kind: MetaErrorKind;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;

  constructor(kind: MetaErrorKind, detail: { code?: number | null; subcode?: number | null; httpStatus?: number | null; retryAfterMs?: number | null }) {
    super(`meta_graph_${kind}${detail.code != null ? `_${detail.code}` : ''}`);
    this.name = 'MetaGraphError';
    this.kind = kind;
    this.code = detail.code ?? null;
    this.subcode = detail.subcode ?? null;
    this.httpStatus = detail.httpStatus ?? null;
    this.retryAfterMs = detail.retryAfterMs ?? null;
  }

  /** Código estable para last_error / auditoría (sin texto del proveedor). */
  get shortCode(): string {
    return `meta_${this.kind}${this.code != null ? `_${this.code}` : ''}`;
  }
}

interface GraphErrorBody { error?: { type?: string; code?: number; error_subcode?: number; message?: string } }

export function classifyGraphError(httpStatus: number, body: unknown, retryAfterHeader: string | null): MetaGraphError {
  const err = (body as GraphErrorBody | null)?.error;
  const code = typeof err?.code === 'number' ? err.code : null;
  const subcode = typeof err?.error_subcode === 'number' ? err.error_subcode : null;
  const retryAfterMs = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) * 1000 : null;
  const detail = { code, subcode, httpStatus, retryAfterMs };
  if (code === 190 || code === 102) {
    return new MetaGraphError('invalid_token', detail);
  }
  if (code === 10 || code === 3 || (code !== null && code >= 200 && code <= 299)) return new MetaGraphError('permission_missing', detail);
  if (code === 4 || code === 17 || code === 32 || code === 341 || code === 613 || (code !== null && code >= 80000 && code <= 80999) || httpStatus === 429) {
    return new MetaGraphError('rate_limited', detail);
  }
  if (code === 506) return new MetaGraphError('duplicate', detail);
  if (code === 100 && subcode === 33) return new MetaGraphError('not_found', detail);
  if (code === 1 || code === 2 || code === 368 || httpStatus >= 500) return new MetaGraphError('transient', detail);
  if (httpStatus === 404) return new MetaGraphError('not_found', detail);
  if (err?.type === 'OAuthException') return new MetaGraphError('invalid_token', detail);
  return new MetaGraphError('provider_error', detail);
}

export interface MetaGraphClientOptions {
  baseUrl: string;
  version: string;
  appSecret?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GraphCall {
  token: string;
  params?: Record<string, string | number | undefined>;
}

/** Cliente mínimo: GET/POST/DELETE versionados, timeout y errores clasificados. */
export class MetaGraphClient {
  readonly baseUrl: string;
  readonly version: string;
  private readonly appSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MetaGraphClientOptions) {
    if (!/^v\d+\.\d+$/.test(opts.version)) throw new Error(`META_GRAPH_VERSION must look like v26.0 (got: ${opts.version})`);
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.version = opts.version;
    this.appSecret = opts.appSecret ?? '';
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private url(path: string, token: string | null, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(`${this.baseUrl}/${this.version}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    if (token) {
      u.searchParams.set('access_token', token);
      if (this.appSecret) u.searchParams.set('appsecret_proof', createHmac('sha256', this.appSecret).update(token).digest('hex'));
    }
    return u.toString();
  }

  get<T>(path: string, call: GraphCall): Promise<T> {
    return this.request<T>('GET', this.url(path, call.token, call.params), undefined, false);
  }

  /** Lecturas sin token de usuario (intercambio de code / debug_token con app token). */
  getPublic<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('GET', this.url(path, null, params), undefined, false);
  }

  post<T>(path: string, call: GraphCall & { form: Record<string, string | undefined> }): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(call.form)) {
      if (v !== undefined) body.set(k, v);
    }
    body.set('access_token', call.token);
    if (this.appSecret) body.set('appsecret_proof', createHmac('sha256', this.appSecret).update(call.token).digest('hex'));
    return this.request<T>('POST', this.url(path, null, call.params), body, true);
  }

  delete<T>(path: string, call: GraphCall): Promise<T> {
    return this.request<T>('DELETE', this.url(path, call.token, call.params), undefined, true);
  }

  private async request<T>(method: string, url: string, body: URLSearchParams | undefined, write: boolean): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method, body, signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json' },
      });
    } catch (err) {
      // Escritura sin respuesta: pudo llegar al proveedor ⇒ incierto. Lectura: transitorio.
      const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new MetaGraphError(write || aborted ? 'timeout' : 'transient', {});
    }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok || (json && typeof json === 'object' && 'error' in (json as object))) {
      throw classifyGraphError(res.status, json, res.headers.get('retry-after'));
    }
    return json as T;
  }
}

/** Sobre cifrado por negocio (provider_connection.token_box): nunca sale de este módulo. */
export interface MetaTokens {
  user_token?: string;
  user_token_expires_at?: string | null;
  page_token?: string;
}

export interface MetaPageContext {
  connection: ProviderConnection;
  pageId: string;
  pageToken: string;
}

export interface MetaVerification {
  status: 'connected' | 'needs_authorization' | 'permission_missing' | 'provider_unavailable' | 'failed';
  page_id: string | null;
  page_name: string | null;
  granted_scopes: string[];
  missing_scopes: string[];
  error_code: string | null;
}

export interface MetaPagesAdapterDeps {
  client: MetaGraphClient;
  connections: ProviderConnectionRepository;
  appId: string;
  appSecret: string;
}

function toResult(err: unknown, ref: string): SocialPublishResult {
  if (err instanceof MetaGraphError) {
    switch (err.kind) {
      case 'rate_limited':
      case 'transient':
        return { ok: false, external_ref: ref, error: err.shortCode, retryable: true, retryAfterMs: err.retryAfterMs ?? undefined };
      case 'timeout':
      case 'duplicate':
        return { ok: false, external_ref: ref, error: err.shortCode, uncertain: true };
      default:
        return { ok: false, external_ref: ref, error: err.shortCode, retryable: false };
    }
  }
  return { ok: false, external_ref: ref, error: 'meta_adapter_exception', retryable: true };
}

export class MetaPagesAdapter implements SocialProvider {
  readonly provider = 'meta' as const;
  /** Graph no ofrece idempotencia nativa en POST /feed: reconciliar antes de reintentar. */
  readonly idempotentPublish = false;
  private readonly deps: MetaPagesAdapterDeps;

  constructor(deps: MetaPagesAdapterDeps) {
    if (!deps.connections.canStoreTokens) {
      throw new Error('MetaPagesAdapter requires CONNECTOR_TOKEN_KEY to read page tokens (fail closed)');
    }
    this.deps = deps;
  }

  get client(): MetaGraphClient {
    return this.deps.client;
  }

  /** Conexión utilizable del negocio o null (sin inventar páginas ni tokens). */
  async pageContext(tenantId: string): Promise<MetaPageContext | null> {
    if (!tenantId) throw new Error('FAIL-CLOSED: meta adapter requires a tenant context');
    const connection = await this.deps.connections.get(tenantId, META_PROVIDER);
    if (!connection || !['connected', 'provider_unavailable'].includes(connection.status) || !connection.external_resource_id || !connection.has_token) return null;
    const tokens = await this.deps.connections.readTokens<MetaTokens>(tenantId, META_PROVIDER);
    if (!tokens?.page_token) return null;
    return { connection, pageId: connection.external_resource_id, pageToken: tokens.page_token };
  }

  async getPage(tenantId: string): Promise<SocialPage> {
    const ctx = await this.pageContext(tenantId);
    if (!ctx) {
      throw new AppError(409, 'validation_error', 'Conecta la página de Facebook del negocio antes de publicar (Canales → Facebook → Conectar Facebook).');
    }
    return { page_id: ctx.pageId, page_name: ctx.connection.external_resource_name ?? ctx.pageId, profile_picture_url: '' };
  }

  /** Un fallo de credenciales deja la conexión en el estado que corresponde (sin tokens en logs). */
  async noteAuthFailure(tenantId: string, err: unknown): Promise<void> {
    if (!(err instanceof MetaGraphError)) return;
    if (err.kind === 'invalid_token') {
      await this.deps.connections.markStatus(tenantId, META_PROVIDER, 'needs_authorization', err.shortCode);
      log.warn('meta.connection.needs_authorization', 'page token rejected by Meta; business must reconnect', { tenant_id: tenantId, code: err.shortCode });
    } else if (err.kind === 'permission_missing') {
      await this.deps.connections.markStatus(tenantId, META_PROVIDER, 'permission_missing', err.shortCode);
      log.warn('meta.connection.permission_missing', 'Meta denied the operation for missing permission', { tenant_id: tenantId, code: err.shortCode });
    } else if (err.kind === 'transient' && err.httpStatus != null && err.httpStatus >= 500) {
      await this.deps.connections.markStatus(tenantId, META_PROVIDER, 'provider_unavailable', err.shortCode);
    }
  }

  async publishPost(input: SocialPostInput): Promise<SocialPublishResult> {
    const ref = `meta:${input.tenantId}:${input.idempotencyKey ?? 'post'}`;
    if (input.contentType === 'ad') {
      return { ok: false, external_ref: ref, error: 'meta_ads_not_supported', retryable: false };
    }
    const ctx = await this.pageContext(input.tenantId);
    if (!ctx) return { ok: false, external_ref: ref, error: 'meta_not_connected', retryable: false };
    const message = input.text.trim();
    const link = input.imageUrl && /^https?:\/\//i.test(input.imageUrl) ? input.imageUrl : undefined;
    let postId: string;
    try {
      const created = await this.deps.client.post<{ id?: string }>(`${ctx.pageId}/feed`, { token: ctx.pageToken, form: { message, link } });
      if (!created.id) return { ok: false, external_ref: ref, error: 'meta_publish_no_id', uncertain: true };
      postId = created.id;
    } catch (err) {
      await this.noteAuthFailure(input.tenantId, err);
      return toResult(err, ref);
    }
    // Read-back obligatorio: `published` solo con acuse del proveedor.
    try {
      const back = await this.deps.client.get<{ id?: string; message?: string }>(postId, { token: ctx.pageToken, params: { fields: 'id,message' } });
      if (back.id !== postId || back.message?.trim() !== message) {
        return { ok: false, external_ref: postId, error: 'meta_readback_mismatch', uncertain: true };
      }
    } catch (err) {
      await this.noteAuthFailure(input.tenantId, err);
      // La publicación existe (tenemos id) pero no pudimos confirmarla: incierto, reconciliar.
      return { ok: false, external_ref: postId, error: err instanceof MetaGraphError ? `${err.shortCode}:readback` : 'meta_readback_failed', uncertain: true };
    }
    await this.deps.connections.markStatus(input.tenantId, META_PROVIDER, 'connected', null, true);
    return { ok: true, external_ref: postId };
  }

  /** Un texto repetido NO identifica el efecto de nuestra escritura. Sin id, revisión humana. */
  async findPublishedPost(input: { tenantId: string; text: string; since: Date; externalRef: string | null }): Promise<SocialPostLookup> {
    const ctx = await this.pageContext(input.tenantId);
    if (!ctx) throw new MetaGraphError('invalid_token', {});
    if (!input.externalRef || !input.externalRef.startsWith(`${ctx.pageId}_`) || !/^[0-9]+_[0-9]+$/.test(input.externalRef)) return { found: false };
    try {
      const item = await this.deps.client.get<{ id?: string; message?: string }>(input.externalRef, {
        token: ctx.pageToken, params: { fields: 'id,message' },
      });
      return item.id === input.externalRef && item.message?.trim() === input.text.trim()
        ? { found: true, external_ref: input.externalRef } : { found: false };
    } catch (err) {
      if (err instanceof MetaGraphError && err.kind === 'not_found') return { found: false };
      await this.noteAuthFailure(input.tenantId, err);
      throw err;
    }
  }

  // ------------------------------------------------------------------ conexión / OAuth

  /** URL del diálogo de Facebook Login (code flow, state de un solo uso). */
  authorizationUrl(input: { state: string; redirectUri: string; adsRead: boolean }): string {
    const scopes = [...REQUIRED_PAGE_SCOPES, ...(input.adsRead ? [ADS_READ_SCOPE] : [])];
    const u = new URL(`https://www.facebook.com/${this.deps.client.version}/dialog/oauth`);
    u.searchParams.set('client_id', this.deps.appId);
    u.searchParams.set('redirect_uri', input.redirectUri);
    u.searchParams.set('state', input.state);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', scopes.join(','));
    return u.toString();
  }

  get oauthConfigured(): boolean {
    return Boolean(this.deps.appId && this.deps.appSecret);
  }

  /** code → token de usuario de larga duración (intercambio en servidor, secret nunca al navegador). */
  async exchangeCode(input: { code: string; redirectUri: string }): Promise<{ user_token: string; expires_at: string | null }> {
    const short = await this.deps.client.getPublic<{ access_token?: string; expires_in?: number }>('oauth/access_token', {
      client_id: this.deps.appId, client_secret: this.deps.appSecret, redirect_uri: input.redirectUri, code: input.code,
    });
    if (!short.access_token) throw new MetaGraphError('provider_error', {});
    const long = await this.deps.client.getPublic<{ access_token?: string; expires_in?: number }>('oauth/access_token', {
      grant_type: 'fb_exchange_token', client_id: this.deps.appId, client_secret: this.deps.appSecret, fb_exchange_token: short.access_token,
    });
    const token = long.access_token ?? short.access_token;
    const ttl = long.access_token ? long.expires_in : short.expires_in;
    return { user_token: token, expires_at: typeof ttl === 'number' && ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null };
  }

  async me(userToken: string): Promise<{ id: string; name: string }> {
    const r = await this.deps.client.get<{ id?: string; name?: string }>('me', { token: userToken, params: { fields: 'id,name' } });
    if (!r.id) throw new MetaGraphError('provider_error', {});
    return { id: r.id, name: r.name ?? '' };
  }

  async grantedPermissions(userToken: string): Promise<string[]> {
    const r = await this.deps.client.get<{ data?: Array<{ permission?: string; status?: string }> }>('me/permissions', { token: userToken });
    return (r.data ?? []).filter((p) => p.status === 'granted' && p.permission).map((p) => p.permission as string);
  }

  /** Pages que administra la persona autenticada (sin devolver tokens). */
  async listPages(userToken: string): Promise<Array<{ id: string; name: string; tasks: string[] }>> {
    const out: Array<{ id: string; name: string; tasks: string[] }> = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const r = await this.deps.client.get<{ data?: Array<{ id?: string; name?: string; tasks?: string[] }>; paging?: { cursors?: { after?: string }; next?: string } }>(
        'me/accounts', { token: userToken, params: { fields: 'id,name,tasks', limit: 100, after } });
      for (const p of r.data ?? []) {
        if (p.id) out.push({ id: p.id, name: p.name ?? p.id, tasks: Array.isArray(p.tasks) ? p.tasks : [] });
      }
      after = r.paging?.next ? r.paging.cursors?.after : undefined;
      if (!after) break;
    }
    return out;
  }

  /** Page token de una Page que la persona administra (derivado de un token de usuario de larga duración). */
  async pageAccess(userToken: string, pageId: string): Promise<{ id: string; name: string; page_token: string; tasks: string[] }> {
    const r = await this.deps.client.get<{ id?: string; name?: string; access_token?: string; tasks?: string[] }>(pageId, {
      token: userToken, params: { fields: 'id,name,access_token,tasks' },
    });
    if (!r.id || !r.access_token) throw new MetaGraphError('permission_missing', {});
    return { id: r.id, name: r.name ?? r.id, page_token: r.access_token, tasks: Array.isArray(r.tasks) ? r.tasks : [] };
  }

  /**
   * Comprueba un page token contra Meta: lectura de la Page con ese token y, con app secret,
   * `debug_token` para conocer los permisos efectivos. Devuelve el estado a persistir.
   */
  async verifyPageToken(pageToken: string, expectedPageId: string): Promise<MetaVerification> {
    let pageName: string | null = null;
    try {
      const p = await this.deps.client.get<{ id?: string; name?: string }>(expectedPageId, { token: pageToken, params: { fields: 'id,name' } });
      if (p.id !== expectedPageId) return { status: 'failed', page_id: null, page_name: null, granted_scopes: [], missing_scopes: [], error_code: 'meta_page_mismatch' };
      pageName = p.name ?? null;
    } catch (err) {
      return this.verificationFromError(err);
    }
    if (!this.oauthConfigured) {
      return { status: 'permission_missing', page_id: expectedPageId, page_name: pageName,
        granted_scopes: [], missing_scopes: [...REQUIRED_PAGE_SCOPES], error_code: 'scopes_not_verified' };
    }
    try {
      const d = await this.deps.client.getPublic<{ data?: { is_valid?: boolean; scopes?: string[]; type?: string; granular_scopes?: Array<{ scope?: string; target_ids?: string[] }> } }>(
        'debug_token', { input_token: pageToken, access_token: `${this.deps.appId}|${this.deps.appSecret}` });
      if (!d.data?.is_valid) return { status: 'needs_authorization', page_id: expectedPageId, page_name: pageName, granted_scopes: [], missing_scopes: [...REQUIRED_PAGE_SCOPES], error_code: 'meta_token_invalid' };
      const granted = d.data.scopes ?? [];
      const missing = REQUIRED_PAGE_SCOPES.filter((s) => !granted.includes(s));
      return {
        status: missing.length ? 'permission_missing' : 'connected', page_id: expectedPageId, page_name: pageName,
        granted_scopes: granted, missing_scopes: missing, error_code: missing.length ? `missing:${missing.join(',')}` : null,
      };
    } catch (err) {
      return this.verificationFromError(err);
    }
  }

  private verificationFromError(err: unknown): MetaVerification {
    const base = { page_id: null, page_name: null, granted_scopes: [], missing_scopes: [] as string[] };
    if (err instanceof MetaGraphError) {
      if (err.kind === 'invalid_token') return { ...base, status: 'needs_authorization', error_code: err.shortCode };
      if (err.kind === 'permission_missing') return { ...base, status: 'permission_missing', error_code: err.shortCode };
      if (err.kind === 'rate_limited' || err.kind === 'transient' || err.kind === 'timeout') return { ...base, status: 'provider_unavailable', error_code: err.shortCode };
      return { ...base, status: 'failed', error_code: err.shortCode };
    }
    return { ...base, status: 'failed', error_code: 'meta_verify_exception' };
  }

  /** Revoca la autorización de la app para esa persona (best effort) — DELETE /me/permissions. */
  async revoke(userToken: string): Promise<boolean> {
    try {
      const r = await this.deps.client.delete<{ success?: boolean }>('me/permissions', { token: userToken });
      return r.success === true;
    } catch (err) {
      return err instanceof MetaGraphError && err.kind === 'invalid_token'; // ya no vale ⇒ revocado de hecho
    }
  }

  /** Ads básicos — SOLO lectura de cuentas publicitarias accesibles (sin crear ni gastar). */
  async listAdAccounts(userToken: string): Promise<Array<{ id: string; name: string; account_status: number | null }>> {
    const r = await this.deps.client.get<{ data?: Array<{ id?: string; name?: string; account_status?: number }> }>('me/adaccounts', {
      token: userToken, params: { fields: 'id,name,account_status', limit: 25 },
    });
    return (r.data ?? []).filter((a) => a.id).map((a) => ({ id: a.id as string, name: a.name ?? '', account_status: typeof a.account_status === 'number' ? a.account_status : null }));
  }
}

/** Hash corto y NO reversible de un texto (para libros de idempotencia; nunca el texto). */
export function textHash(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex').slice(0, 32);
}
