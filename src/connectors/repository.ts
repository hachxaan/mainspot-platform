/**
 * DEV-E2E-04 — conexión de un negocio con un proveedor externo REAL (Google Business Profile,
 * Meta Pages). Contrato compartido por los adaptadores de Google y Meta:
 *  - Una fila por (tenant, proveedor). El recurso externo (ubicación GBP, Page) es el ID que
 *    devolvió el proveedor, nunca el tenant_id.
 *  - Los tokens solo se guardan cifrados (SecretBox, AAD tenant/proveedor/uso). La vista pública
 *    (`ProviderConnection`) jamás incluye el sobre cifrado ni los tokens.
 *  - `connected` solo tras una llamada autenticada al proveedor que lo confirme (lo decide el
 *    adaptador, no este repositorio); los fallos se registran con un código, sin mensajes crudos
 *    del proveedor que puedan llevar datos.
 *  - OAuth `state` de un solo uso: se guarda su hash; el consumo es atómico y caduca.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { SecretBox, sha256Hex } from './secret-box.ts';

export const PROVIDERS = ['google_business_profile', 'meta_pages'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const CONNECTION_STATUSES = [
  'needs_authorization', 'connected', 'permission_missing', 'disconnected', 'failed', 'provider_unavailable',
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface ProviderConnection {
  connection_id: string;
  tenant_id: string;
  provider: ProviderName;
  status: ConnectionStatus;
  external_account_id: string | null;
  external_resource_id: string | null;
  external_resource_name: string | null;
  scopes: string[];
  has_token: boolean;
  token_expires_at: string | null;
  last_verified_at: string | null;
  last_error_code: string | null;
  connected_by: string | null;
  updated_at: string;
}

interface ConnectionRow extends Omit<ProviderConnection, 'has_token'> {
  token_box: Buffer | null;
}

const PUBLIC_COLUMNS = `connection_id, tenant_id, provider, status, external_account_id, external_resource_id,
  external_resource_name, scopes, token_box, token_expires_at, last_verified_at, last_error_code, connected_by, updated_at`;

function toPublic(row: ConnectionRow): ProviderConnection {
  const { token_box, ...rest } = row;
  return { ...rest, has_token: token_box !== null };
}

export interface SaveConnectionInput<T> {
  tenantId: string;
  provider: ProviderName;
  status: ConnectionStatus;
  /** Credenciales a cifrar (access/refresh/page token…). `null` borra las guardadas. */
  tokens: T | null;
  scopes?: string[];
  tokenExpiresAt?: Date | null;
  externalAccountId?: string | null;
  externalResourceId?: string | null;
  externalResourceName?: string | null;
  connectedBy?: string | null;
  verified?: boolean;
  errorCode?: string | null;
}

export interface ConsumedOAuthState {
  tenantId: string;
  userId: string;
  redirectUri: string;
  verifier: string | null;
}

export const OAUTH_STATE_TTL_MINUTES = 10;

export class ProviderConnectionRepository {
  private readonly pool: pg.Pool;
  /** null ⇒ CONNECTOR_TOKEN_KEY ausente: no se puede guardar ni leer ningún token. */
  private readonly box: SecretBox | null;

  constructor(pool: pg.Pool, box: SecretBox | null) {
    this.pool = pool;
    this.box = box;
  }

  get canStoreTokens(): boolean {
    return this.box !== null;
  }

  private requireBox(): SecretBox {
    if (!this.box) throw Object.assign(new Error('provider tokens cannot be stored: CONNECTOR_TOKEN_KEY missing'), { code: 'connector_key_missing' });
    return this.box;
  }

  async get(tenantId: string, provider: ProviderName): Promise<ProviderConnection | null> {
    const r = await this.pool.query<ConnectionRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM provider_connection WHERE tenant_id = $1 AND provider = $2`, [tenantId, provider]);
    return r.rows[0] ? toPublic(r.rows[0]) : null;
  }

  async list(tenantId: string): Promise<ProviderConnection[]> {
    const r = await this.pool.query<ConnectionRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM provider_connection WHERE tenant_id = $1 ORDER BY provider`, [tenantId]);
    return r.rows.map(toPublic);
  }

  /** Negocios con conexión utilizable de un proveedor (para workers de ingesta/publicación). */
  async connectedTenants(provider: ProviderName): Promise<string[]> {
    const r = await this.pool.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM provider_connection WHERE provider = $1 AND status = 'connected' ORDER BY tenant_id`, [provider]);
    return r.rows.map((x) => x.tenant_id);
  }

  async save<T>(input: SaveConnectionInput<T>): Promise<ProviderConnection> {
    const box = input.tokens === null ? null : this.requireBox().sealJson(input.tokens, { tenantId: input.tenantId, provider: input.provider, purpose: 'tokens' });
    const r = await this.pool.query<ConnectionRow>(
      `INSERT INTO provider_connection (connection_id, tenant_id, provider, status, external_account_id, external_resource_id,
         external_resource_name, scopes, token_box, token_key_id, token_expires_at, last_verified_at, last_error_code, connected_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $12 THEN now() END, $13, $14)
       ON CONFLICT (tenant_id, provider) DO UPDATE SET
         status = EXCLUDED.status,
         external_account_id = COALESCE(EXCLUDED.external_account_id, provider_connection.external_account_id),
         external_resource_id = COALESCE(EXCLUDED.external_resource_id, provider_connection.external_resource_id),
         external_resource_name = COALESCE(EXCLUDED.external_resource_name, provider_connection.external_resource_name),
         scopes = CASE WHEN cardinality(EXCLUDED.scopes) > 0 THEN EXCLUDED.scopes ELSE provider_connection.scopes END,
         token_box = EXCLUDED.token_box,
         token_key_id = EXCLUDED.token_key_id,
         token_expires_at = EXCLUDED.token_expires_at,
         last_verified_at = COALESCE(EXCLUDED.last_verified_at, provider_connection.last_verified_at),
         last_error_code = EXCLUDED.last_error_code,
         connected_by = COALESCE(EXCLUDED.connected_by, provider_connection.connected_by),
         updated_at = now()
       RETURNING ${PUBLIC_COLUMNS}`,
      [`conn_${randomUUID()}`, input.tenantId, input.provider, input.status, input.externalAccountId ?? null,
        input.externalResourceId ?? null, input.externalResourceName ?? null, input.scopes ?? [], box,
        box ? this.box!.keyId : null, input.tokenExpiresAt ?? null, input.verified === true, input.errorCode ?? null,
        input.connectedBy ?? null]);
    return toPublic(r.rows[0]!);
  }

  /** Tokens descifrados para llamar al proveedor; null si no hay conexión o no hay token. */
  async readTokens<T>(tenantId: string, provider: ProviderName): Promise<T | null> {
    const r = await this.pool.query<{ token_box: Buffer | null }>(
      'SELECT token_box FROM provider_connection WHERE tenant_id = $1 AND provider = $2', [tenantId, provider]);
    const box = r.rows[0]?.token_box;
    if (!box) return null;
    return this.requireBox().openJson<T>(box, { tenantId, provider, purpose: 'tokens' });
  }

  /** Estado tras una comprobación/llamada (sin tocar tokens). */
  async markStatus(tenantId: string, provider: ProviderName, status: ConnectionStatus, errorCode: string | null, verified = false): Promise<void> {
    await this.pool.query(
      `UPDATE provider_connection SET status = $3, last_error_code = $4,
         last_verified_at = CASE WHEN $5 THEN now() ELSE last_verified_at END, updated_at = now()
       WHERE tenant_id = $1 AND provider = $2`, [tenantId, provider, status, errorCode, verified]);
  }

  /** Desconexión local: borra el sobre cifrado (la revocación ante el proveedor la hace el adaptador). */
  async disconnect(tenantId: string, provider: ProviderName): Promise<void> {
    await this.pool.query(
      `UPDATE provider_connection SET status = 'disconnected', token_box = NULL, token_key_id = NULL, token_expires_at = NULL,
         last_error_code = NULL, updated_at = now() WHERE tenant_id = $1 AND provider = $2`, [tenantId, provider]);
  }

  /** Crea un `state` OAuth de un solo uso (devuelve el valor en claro solo a quien redirige). */
  async createOAuthState(input: { tenantId: string; userId: string; provider: ProviderName; redirectUri: string; verifier?: string | null; ttlMinutes?: number }): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const verifierBox = input.verifier ? this.requireBox().seal(input.verifier, { tenantId: input.tenantId, provider: input.provider, purpose: 'pkce_verifier' }) : null;
    await this.pool.query(
      `INSERT INTO provider_oauth_state (state_hash, tenant_id, user_id, provider, verifier_box, redirect_uri, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7))`,
      [sha256Hex(state), input.tenantId, input.userId, input.provider, verifierBox, input.redirectUri, input.ttlMinutes ?? OAUTH_STATE_TTL_MINUTES]);
    return state;
  }

  /** Consume el `state` (una sola vez, sin caducar, mismo proveedor). null si no vale. */
  async consumeOAuthState(state: string, provider: ProviderName): Promise<ConsumedOAuthState | null> {
    const r = await this.pool.query<{ tenant_id: string; user_id: string; redirect_uri: string; verifier_box: Buffer | null }>(
      `UPDATE provider_oauth_state SET used_at = now()
       WHERE state_hash = $1 AND provider = $2 AND used_at IS NULL AND expires_at > now()
       RETURNING tenant_id, user_id, redirect_uri, verifier_box`, [sha256Hex(state), provider]);
    const row = r.rows[0];
    if (!row) return null;
    const verifier = row.verifier_box ? this.requireBox().open(row.verifier_box, { tenantId: row.tenant_id, provider, purpose: 'pkce_verifier' }) : null;
    return { tenantId: row.tenant_id, userId: row.user_id, redirectUri: row.redirect_uri, verifier };
  }
}
