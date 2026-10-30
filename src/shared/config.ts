/**
 * Shared configuration.
 *
 * All values come from environment variables (see .env.example).
 * No real secret is ever stored in this repository.
 *
 * JWT_SECRET: REQUIRED in every environment except `test`. There is NO default
 * secret in code or compose; leaving it unset fails fast on startup with a
 * clear message (IR-02). Test code passes an explicit test-only secret.
 */

import { loadGoogleConnectorConfig, type GoogleConnectorConfig } from '../google/config.ts';
import { loadMailConfig, type MailConfig } from '../mail/config.ts';
import { assertTimeZone, DEFAULT_SCHEDULER_TIMEZONE } from '../social/timezone.ts';

const APP_ENVS = ['development', 'production', 'test'] as const;
const AUDIT_MODES = ['fail_closed', 'fail_open'] as const;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const CHANNEL_PRIMARYS = ['telegram', 'simulated'] as const;
const DOMAIN_PROVIDERS = ['simulated', 'hostinger'] as const;
const REPUTATION_PROVIDERS = ['simulated', 'google_business_profile'] as const;
const SOCIAL_PROVIDERS = ['simulated', 'meta'] as const;
const PAYMENT_PROVIDERS = ['simulated', 'stripe'] as const;
const JEV_MODES = ['disabled', 'shadow', 'primary'] as const;
const JEV_PROVIDERS = ['typesafe'] as const;
const JEV_DATA_SCOPES = ['synthetic'] as const;

export type AppEnv = (typeof APP_ENVS)[number];
export type AuditMode = (typeof AUDIT_MODES)[number];
export type LogLevelValue = (typeof LOG_LEVELS)[number];
export type ChannelPrimary = (typeof CHANNEL_PRIMARYS)[number];
export type DomainProviderName = (typeof DOMAIN_PROVIDERS)[number];
export type ReputationProviderName = (typeof REPUTATION_PROVIDERS)[number];
export type SocialProviderName = (typeof SOCIAL_PROVIDERS)[number];
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];
export type JevProviderName = (typeof JEV_PROVIDERS)[number];
export type JevMode = (typeof JEV_MODES)[number];
export type JevDataScope = (typeof JEV_DATA_SCOPES)[number];

/**
 * Jev como clasificador semántico (MSP-JEV-CLASSIFIER-MODES v1, APR-0002).
 * `disabled`: sin cliente ni salida de datos. `shadow`: decide el determinista
 * y Jev queda como evidencia. `primary`: Jev decide la clasificación cuando la
 * evaluación sintética abrió el gate (DEC-0031). En ambos modos solo se envía
 * a TypeSafe el texto de tenants sintéticos (DEC-0019).
 */
export type JevConfig =
  | { mode: 'disabled' }
  | {
      mode: Exclude<JevMode, 'disabled'>;
      provider: JevProviderName;
      /** TYPESAFE_API_KEY — never logged, audited, persisted or echoed in errors. */
      apiKey: string;
      /** JEV_MODEL; null ⇒ the provider alias chosen by the client (jev-latest). */
      model: string | null;
      /** DEC-0019: only synthetic data may leave the system. */
      dataScope: JevDataScope;
      /** Tenants whose messages may be sent to TypeSafe (JEV_SYNTHETIC_TENANTS). */
      syntheticTenants: readonly string[];
      /** DEC-0032: daily TypeSafe budget (USD, UTC day, per process). */
      dailyBudgetUsd: number;
    };

/** DEC-0032: presupuesto diario aprobado para desarrollo y pruebas. */
export const JEV_MAX_DAILY_BUDGET_USD = 1;

export interface AppConfig {
  port: number;
  appEnv: AppEnv;
  databaseUrl: string;
  testDatabaseUrl: string;
  jwtSecret: string;
  jwtTtlMinutes: number;
  sessionSource: string;
  auditMode: AuditMode;
  logLevel: LogLevelValue;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  rateLimitLockMs: number;
  evidenceDir: string;
  // INC-002 channels (DEC-016, DEC-026)
  channelPrimary: ChannelPrimary;
  telegramBotToken: string;
  telegramBaseUrl: string;
  previewTokenTtlMinutes: number;
  // INC-002 approval rate limiting (sensitive approvals)
  approvalRateLimitMax: number;
  approvalRateLimitWindowMs: number;
  approvalRateLimitLockMs: number;
  // INC-003 domain provisioning (DEC-019, DEC-026)
  domainProvider: DomainProviderName;
  hostingerApiBaseUrl: string;
  hostingerApiToken: string;
  mainspotDomainSuffix: string;
  // INC-004 reputation/reviews (DEC-023 umbral configurable; DEC-026 simulado)
  reviewThreshold: number;
  reputationProvider: ReputationProviderName;
  // INC-005 social (Meta/Facebook, DEC-017/026)
  socialProvider: SocialProviderName;
  metaGraphBaseUrl: string;
  /**
   * DEV-E2E-04 §2B: Meta Pages REAL por conexión de cada negocio (OAuth Facebook Login,
   * page token cifrado). Versión de Graph API fijada por configuración (META_GRAPH_VERSION;
   * vigente según el changelog oficial, nunca implícita). App ID/secret solo para OAuth y
   * debug_token; vacíos ⇒ no hay «Conectar Facebook» (el aprovisionamiento de laboratorio
   * sigue disponible). META_ADS_CHECK=on habilita SOLO la lectura de cuentas publicitarias.
   */
  metaGraphVersion: string;
  metaAppId: string;
  metaAppSecret: string;
  metaAdsCheckEnabled: boolean;
  /** Scheduler de publicaciones aprobadas (SOCIAL_SCHEDULER=on|off, intervalo, zona del negocio). */
  socialSchedulerEnabled: boolean;
  socialSchedulerIntervalMs: number;
  socialSchedulerTimezone: string;
  // INC-006 subscriptions (DEC-024 catálogo configurable, sin cobro real)
  paymentProvider: PaymentProviderName;
  // APR-0002: Jev como clasificador semántico (disabled | shadow | primary).
  jev: JevConfig;
  // DEV-E2E-02: agente de atención (observador sin navegador) y webhook de Telegram.
  engagementWorkerEnabled: boolean;
  engagementWorkerIntervalMs: number;
  engagementPollIntervalMs: number;
  telegramWebhookSecret: string;
  /** DEV-E2E-02: URL pública del panel para enlaces en avisos e invitaciones. */
  publicBaseUrl: string;
  /**
   * DEV-E2E-04 (P3): dominio base de los sitios locales REALES de cada negocio
   * (https://<slug>.<LOCAL_SITE_DOMAIN>, resueltos por /etc/hosts y servidos por el LXC webserver).
   * Solo red de desarrollo; nunca DNS público.
   */
  localSiteDomain: string;
  /**
   * DEV-E2E-04: clave AES-256-GCM (32 bytes en base64, CONNECTOR_TOKEN_KEY, fuera de Git) para
   * cifrar tokens de proveedores por negocio. Vacía ⇒ no se guardan ni leen tokens (fail closed).
   */
  connectorTokenKey: string;
  /** DEV-E2E-04 §2A: conector REAL de Google Business Profile (OAuth por negocio, hosts por API). */
  google: GoogleConnectorConfig;
  /** DEV-E2E-04 §3: correo transaccional para recuperar contraseña (disabled | smtp | resend). */
  mail: MailConfig;
}

export interface LoadConfigOptions {
  /** false for CLI/tooling that never issues or verifies sessions. */
  requireJwtSecret?: boolean;
}

function enumValue<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === '') return fallback;
  const hit = allowed.find((a) => a === value);
  if (!hit) {
    throw new Error(
      `Invalid ${name}=${value}. Allowed values: ${allowed.join(', ')}.`,
    );
  }
  return hit;
}

/**
 * JEV_* (APR-0002, DEC-0019, DEC-0032). Fail-fast on any value outside the
 * approved envelope: explicit mode, provider `typesafe` (no fallback), key
 * required when not disabled, synthetic data scope only, at least one
 * synthetic tenant and a daily budget of at most USD 1. Messages never include
 * the key value.
 */
function loadJevConfig(): JevConfig {
  const replaced = ['JEV_ENABLED', 'JEV_SHADOW_MODE'].filter((name) => process.env[name] !== undefined);
  if (replaced.length > 0) {
    throw new Error(
      `${replaced.join(' and ')} no longer exist: use JEV_MODE=disabled|shadow|primary ` +
      '(MSP-JEV-CLASSIFIER-MODES v1, APR-0002) and remove the old variables.',
    );
  }
  const mode = enumValue<JevMode>('JEV_MODE', process.env.JEV_MODE, JEV_MODES, 'disabled');
  const providerRaw = process.env.JEV_PROVIDER;
  const provider = providerRaw ? enumValue<JevProviderName>('JEV_PROVIDER', providerRaw, JEV_PROVIDERS, 'typesafe') : null;
  if (mode === 'disabled') return { mode };
  if (!provider) {
    throw new Error(
      `JEV_PROVIDER is required when JEV_MODE=${mode}. Allowed values: typesafe ` +
      '(explicit selection; there is no provider fallback).',
    );
  }
  const apiKey = (process.env.TYPESAFE_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error(
      `TYPESAFE_API_KEY is required when JEV_MODE=${mode}. Set it in the environment ` +
      '(.env — see .env.example) or set JEV_MODE=disabled.',
    );
  }
  const dataScope = enumValue<JevDataScope>('JEV_DATA_SCOPE', process.env.JEV_DATA_SCOPE, JEV_DATA_SCOPES, 'synthetic');
  const syntheticTenants = [...new Set((process.env.JEV_SYNTHETIC_TENANTS ?? '').split(',').map((t) => t.trim()).filter(Boolean))];
  if (syntheticTenants.length === 0) {
    throw new Error(
      `JEV_SYNTHETIC_TENANTS is required when JEV_MODE=${mode}: a comma-separated list of tenants ` +
      'with synthetic data only. Real customer messages must not reach TypeSafe (DEC-0019).',
    );
  }
  const budgetRaw = (process.env.JEV_DAILY_BUDGET_USD ?? '').trim();
  const dailyBudgetUsd = budgetRaw === '' ? JEV_MAX_DAILY_BUDGET_USD : Number(budgetRaw);
  if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0 || dailyBudgetUsd > JEV_MAX_DAILY_BUDGET_USD) {
    throw new Error(
      `Invalid JEV_DAILY_BUDGET_USD=${budgetRaw}. It must be a number greater than 0 and at most ` +
      `${JEV_MAX_DAILY_BUDGET_USD} (DEC-0032).`,
    );
  }
  const model = (process.env.JEV_MODEL ?? '').trim();
  return { mode, provider, apiKey, model: model || null, dataScope, syntheticTenants, dailyBudgetUsd };
}

export function loadConfig(overrides: Partial<AppConfig> = {}, opts: LoadConfigOptions = {}): AppConfig {
  const appEnv = enumValue<AppEnv>('APP_ENV', process.env.APP_ENV, APP_ENVS, 'development');
  const requireSecret = opts.requireJwtSecret ?? appEnv !== 'test';
  const jwtSecret = process.env.JWT_SECRET ?? '';
  const INSECURE_SECRET_PLACEHOLDERS = new Set([
    '',
    'cambiar_antes_de_usar',
    'mainspot-dev-only-secret-change-me',
    'changeme',
    'change-me',
  ]);

  if (requireSecret && INSECURE_SECRET_PLACEHOLDERS.has(jwtSecret.trim())) {
    throw new Error(
      'JWT_SECRET is required and must not be a placeholder. ' +
      'Generate a real value (e.g. `openssl rand -hex 32`) and set it in the ' +
      'environment (.env — see .env.example). There is intentionally no default ' +
      'secret. (APP_ENV=test is the only environment allowed to run without one; ' +
      'test code passes an explicit test-only value.)',
    );
  }

  const config: AppConfig = {
    port: Number(process.env.PORT ?? 3000),
    appEnv,
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://mainspot:mainspot_dev_password@localhost:5432/mainspot',
    testDatabaseUrl: process.env.TEST_DATABASE_URL ?? 'postgres://mainspot:mainspot_dev_password@localhost:5432/mainspot_test',
    jwtSecret,
    jwtTtlMinutes: Number(process.env.JWT_TTL_MINUTES ?? 60),
    sessionSource: process.env.SESSION_SOURCE ?? 'backoffice',
    auditMode: enumValue<AuditMode>('AUDIT_MODE', process.env.AUDIT_MODE, AUDIT_MODES, 'fail_closed'),
    logLevel: enumValue<LogLevelValue>('LOG_LEVEL', process.env.LOG_LEVEL, LOG_LEVELS, 'info'),
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 5),
    rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    rateLimitLockMs: Number(process.env.RATE_LIMIT_LOCK_MS ?? 60_000),
    evidenceDir: process.env.EVIDENCE_DIR ?? 'evidence',
    // INC-002: canal primario (DEC-016/026) + preview token (TENTATIVA: expiración configurable).
    channelPrimary: enumValue<ChannelPrimary>('CHANNEL_PRIMARY', process.env.CHANNEL_PRIMARY, CHANNEL_PRIMARYS, 'simulated'),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    telegramBaseUrl: process.env.TELEGRAM_BASE_URL ?? 'https://api.telegram.org',
    previewTokenTtlMinutes: Number(process.env.PREVIEW_TOKEN_TTL_MINUTES ?? 1440),
    // INC-002: rate limiting de aprobaciones sensibles (operador + recurso).
    approvalRateLimitMax: Number(process.env.APPROVAL_RATE_LIMIT_MAX ?? 10),
    approvalRateLimitWindowMs: Number(process.env.APPROVAL_RATE_LIMIT_WINDOW_MS ?? 60_000),
    approvalRateLimitLockMs: Number(process.env.APPROVAL_RATE_LIMIT_LOCK_MS ?? 30_000),
    // INC-003: proveedor de dominios (DEC-019/026) — simulado por defecto.
    domainProvider: enumValue<DomainProviderName>('DOMAIN_PROVIDER', process.env.DOMAIN_PROVIDER, DOMAIN_PROVIDERS, 'simulated'),
    hostingerApiBaseUrl: process.env.HOSTINGER_API_BASE_URL ?? 'https://api.hostinger.com',
    hostingerApiToken: process.env.HOSTINGER_API_TOKEN ?? '',
    mainspotDomainSuffix: process.env.MAINSPOT_DOMAIN_SUFFIX ?? 'sim.mainspot.local',
    // INC-004: umbral de enrutamiento de reseñas configurable por entorno (DEC-023),
    // default <4 estrellas; valor definitivo pendiente de investigación con datos (Q-013).
    reviewThreshold: Number(process.env.REVIEW_THRESHOLD ?? 4),
    // INC-004: modo explícito; OAuth y tokens cifrados por negocio (sin fallback real→simulado).
    reputationProvider: enumValue<ReputationProviderName>('REPUTATION_PROVIDER', process.env.REPUTATION_PROVIDER, REPUTATION_PROVIDERS, 'simulated'),
    // INC-005: Meta/Facebook; las credenciales pertenecen a la conexión cifrada de cada tenant.
    socialProvider: enumValue<SocialProviderName>('SOCIAL_PROVIDER', process.env.SOCIAL_PROVIDER, SOCIAL_PROVIDERS, 'simulated'),
    metaGraphBaseUrl: process.env.META_GRAPH_BASE_URL ?? 'https://graph.facebook.com',
    // DEV-E2E-04 §2B: versión vigente de Graph API (changelog oficial) y app de Meta para OAuth.
    metaGraphVersion: (process.env.META_GRAPH_VERSION ?? 'v26.0').trim(),
    metaAppId: process.env.META_APP_ID ?? '',
    metaAppSecret: process.env.META_APP_SECRET ?? '',
    metaAdsCheckEnabled: (process.env.META_ADS_CHECK ?? 'off') === 'on',
    socialSchedulerEnabled: (process.env.SOCIAL_SCHEDULER ?? 'on') !== 'off',
    socialSchedulerIntervalMs: Math.max(1000, Number(process.env.SOCIAL_SCHEDULER_INTERVAL_MS ?? 15_000)),
    socialSchedulerTimezone: assertTimeZone((process.env.SOCIAL_SCHEDULER_TIMEZONE ?? DEFAULT_SCHEDULER_TIMEZONE).trim()),
    // INC-006: proveedor de pago — SOLO esqueleto simulado en piloto (DEC-024,
    // sin cobro ni procesador real). 'stripe' es TENTATIVA y requiere token.
    paymentProvider: enumValue<PaymentProviderName>('PAYMENT_PROVIDER', process.env.PAYMENT_PROVIDER, PAYMENT_PROVIDERS, 'simulated'),
    // APR-0002: Jev disabled|shadow|primary, solo tenants sintéticos (DEC-0019).
    jev: loadJevConfig(),
    // DEV-E2E-02: el observador corre en el proceso del servidor salvo ENGAGEMENT_WORKER=off
    // (p. ej. cuando corre como proceso propio con scripts/engagement-worker.ts).
    engagementWorkerEnabled: (process.env.ENGAGEMENT_WORKER ?? 'on') !== 'off',
    engagementWorkerIntervalMs: Math.max(1000, Number(process.env.ENGAGEMENT_WORKER_INTERVAL_MS ?? 15_000)),
    engagementPollIntervalMs: Math.max(0, Number(process.env.ENGAGEMENT_POLL_INTERVAL_MS ?? 60_000)),
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}`).replace(/\/$/, ''),
    localSiteDomain: (process.env.LOCAL_SITE_DOMAIN ?? 'mainspot.local.io').trim().toLowerCase(),
    connectorTokenKey: process.env.CONNECTOR_TOKEN_KEY ?? '',
    google: loadGoogleConnectorConfig(process.env),
    mail: loadMailConfig(process.env),
  };

  return { ...config, ...overrides };
}

/** Config for CLI/tooling scripts that do not issue or verify sessions.
 *  Allows running without JWT_SECRET (migrate/seed/export/rollback...). */
export function loadConfigTool(): AppConfig {
  return loadConfig({}, { requireJwtSecret: false });
}

/**
 * Module-level view used by non-session consumers (logger level, audit mode,
 * etc.). Deliberately loaded WITHOUT the JWT requirement so importing library
 * modules never fails at import time. The strict JWT_SECRET fail-fast lives in
 * the server entry (createApp()/main()) — see loadConfig() defaults.
 */
export const config: AppConfig = loadConfig({}, { requireJwtSecret: false });
