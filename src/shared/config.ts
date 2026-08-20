/**
 * Shared configuration.
 *
 * All values come from environment variables (see .env.example).
 * No real secret is ever stored in this repository.
 */

export interface AppConfig {
  port: number;
  appEnv: 'development' | 'production' | 'test';
  databaseUrl: string;
  testDatabaseUrl: string;
  jwtSecret: string;
  jwtTtlMinutes: number;
  sessionSource: string;
  auditMode: 'fail_closed' | 'fail_open';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  evidenceDir: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const appEnv = (process.env.APP_ENV ?? 'development') as AppConfig['appEnv'];
  const jwtSecret = process.env.JWT_SECRET || 'mainspot-dev-only-secret-change-me';

  if (appEnv === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'mainspot-dev-only-secret-change-me')) {
    throw new Error('Refusing to start in production without a real JWT_SECRET');
  }

  // Dev defaults (match docker-compose.yml) so the repo runs without a .env;
  // production deployments MUST provide real values (see .env.example).
  const config: AppConfig = {
    port: Number(process.env.PORT ?? 3000),
    appEnv,
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://mainspot:mainspot_dev_password@localhost:5432/mainspot',
    testDatabaseUrl: process.env.TEST_DATABASE_URL ?? 'postgres://mainspot:mainspot_dev_password@localhost:5432/mainspot_test',
    jwtSecret,
    jwtTtlMinutes: Number(process.env.JWT_TTL_MINUTES ?? 60),
    sessionSource: process.env.SESSION_SOURCE ?? 'backoffice',
    auditMode: (process.env.AUDIT_MODE ?? 'fail_closed') as AppConfig['auditMode'],
    logLevel: (process.env.LOG_LEVEL ?? 'info') as AppConfig['logLevel'],
    evidenceDir: process.env.EVIDENCE_DIR ?? 'evidence',
  };

  return { ...config, ...overrides };
}

export const config: AppConfig = loadConfig();
