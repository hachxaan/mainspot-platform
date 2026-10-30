/**
 * DEV-E2E-04 §2A — configuración del conector REAL de Google Business Profile.
 *
 * Solo NOMBRES de variables; los valores viven en el entorno (.env fuera de Git o secret store).
 * Sin GOOGLE_OAUTH_CLIENT_ID/SECRET el flujo OAuth no puede iniciarse: el estado se reporta como
 * BLOCKED_EXTERNAL (prerrequisito externo), nunca se simula una autorización.
 *
 * Los hosts por defecto son los oficiales de cada API (una API ≠ un host):
 *  - Account Management  https://mybusinessaccountmanagement.googleapis.com  (accounts.list)
 *  - Business Information https://mybusinessbusinessinformation.googleapis.com (locations)
 *  - My Business v4       https://mybusiness.googleapis.com                   (reviews, reply)
 * Las pruebas los apuntan a un servidor falso en 127.0.0.1 (SIMULATED_REGRESSION).
 */

export interface GoogleConnectorConfig {
  /** GOOGLE_OAUTH_CLIENT_ID — cliente OAuth 2.0 «aplicación web» del proyecto GCP con acceso GBP. */
  oauthClientId: string;
  /** GOOGLE_OAUTH_CLIENT_SECRET — nunca se registra ni se devuelve por la API. */
  oauthClientSecret: string;
  /** GOOGLE_OAUTH_REDIRECT_URI — vacío ⇒ `${PUBLIC_BASE_URL}/api/connections/google/callback`. */
  oauthRedirectUri: string;
  oauthAuthUrl: string;
  oauthTokenUrl: string;
  oauthRevokeUrl: string;
  accountManagementBaseUrl: string;
  businessInformationBaseUrl: string;
  myBusinessV4BaseUrl: string;
  /** Tiempo máximo por llamada HTTP a Google (ms). */
  requestTimeoutMs: number;
}

export const GOOGLE_BUSINESS_SCOPE = 'https://www.googleapis.com/auth/business.manage';
export const GOOGLE_CALLBACK_PATH = '/api/connections/google/callback';

const trimSlash = (v: string) => v.replace(/\/$/, '');

export function loadGoogleConnectorConfig(env: NodeJS.ProcessEnv = process.env): GoogleConnectorConfig {
  return {
    oauthClientId: (env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim(),
    oauthClientSecret: (env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim(),
    oauthRedirectUri: trimSlash((env.GOOGLE_OAUTH_REDIRECT_URI ?? '').trim()),
    oauthAuthUrl: env.GOOGLE_OAUTH_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    oauthTokenUrl: env.GOOGLE_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    oauthRevokeUrl: env.GOOGLE_OAUTH_REVOKE_URL ?? 'https://oauth2.googleapis.com/revoke',
    accountManagementBaseUrl: trimSlash(env.GOOGLE_ACCOUNT_MANAGEMENT_BASE_URL ?? 'https://mybusinessaccountmanagement.googleapis.com'),
    businessInformationBaseUrl: trimSlash(env.GOOGLE_BUSINESS_INFORMATION_BASE_URL ?? 'https://mybusinessbusinessinformation.googleapis.com'),
    myBusinessV4BaseUrl: trimSlash(env.GOOGLE_MYBUSINESS_V4_BASE_URL ?? 'https://mybusiness.googleapis.com'),
    requestTimeoutMs: Math.max(1000, Number(env.GOOGLE_REQUEST_TIMEOUT_MS ?? 15_000)),
  };
}

/** Cliente OAuth presente (prerrequisito externo para iniciar la autorización). */
export function googleOAuthConfigured(cfg: GoogleConnectorConfig): boolean {
  return cfg.oauthClientId !== '' && cfg.oauthClientSecret !== '';
}

/**
 * Prerrequisitos externos que faltan para operar contra Google REAL (nombres, nunca valores).
 * Vacío ⇒ el conector puede intentar llamadas autenticadas (lo que no garantiza acceso a la API).
 */
export function googleBlockedPrerequisites(cfg: GoogleConnectorConfig, connectorTokenKeyPresent: boolean): string[] {
  const out: string[] = [];
  if (!cfg.oauthClientId) out.push('GOOGLE_OAUTH_CLIENT_ID');
  if (!cfg.oauthClientSecret) out.push('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!connectorTokenKeyPresent) out.push('CONNECTOR_TOKEN_KEY');
  return out;
}
