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

const APP_ENVS = ['development', 'production', 'test'] as const;
const AUDIT_MODES = ['fail_closed', 'fail_open'] as const;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const CHANNEL_PRIMARYS = ['telegram', 'simulated'] as const;
const DOMAIN_PROVIDERS = ['simulated', 'hostinger'] as const;

export type AppEnv = (typeof APP_ENVS)[number];
export type AuditMode = (typeof AUDIT_MODES)[number];
export type LogLevelValue = (typeof LOG_LEVELS)[number];
export type ChannelPrimary = (typeof CHANNEL_PRIMARYS)[number];
export type DomainProviderName = (typeof DOMAIN_PROVIDERS)[number];

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
