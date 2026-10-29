/**
 * Integration/smoke test harness. Boots the real app in-process against the
 * TEST database (recreated by scripts/test-prep.ts before the test run).
 */

import type { AddressInfo, Server } from 'node:net';
import pg from 'pg';
import { createApp, type AppHandle } from '../../src/api/server.ts';
import { loadConfig, type AppConfig } from '../../src/shared/config.ts';
import type { JevClassifier } from '../../src/conversation/jev-classifier.ts';

const { Pool } = pg;

export const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://mainspot:mainspot_dev_password@localhost:5432/mainspot_test';

export const TEST_CONFIG = {
  ...loadConfig({}, { requireJwtSecret: false }),
  databaseUrl: TEST_URL,
  testDatabaseUrl: TEST_URL,
  jwtSecret: 'test-secret-for-verification-only',
  appEnv: 'test' as const,
  logLevel: 'debug' as const,
  // Nunca Jev real en tests, aunque el shell exporte JEV_*; los tests que lo
  // necesitan lo habilitan explícitamente con fetch simulado (sin red).
  jev: { mode: 'disabled' as const },
};

export interface TestApi {
  baseUrl: string;
  pool: pg.Pool;
  /** Presente solo si la config habilita Jev (shadow o primary). */
  jev?: JevClassifier;
  /** Servicios internos del proceso (worker del agente, canal simulado…) para pruebas. */
  handle: AppHandle;
  close: () => Promise<void>;
}

export async function bootApi(configOverrides: Partial<AppConfig> = {}): Promise<TestApi> {
  const pool = new Pool({ connectionString: TEST_URL, max: 5 });
  const handle = createApp({ config: { ...TEST_CONFIG, engagementPollIntervalMs: 0, ...configOverrides }, pool });
  const { app, jev } = handle;
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    pool,
    jev,
    handle,
    close: async () => {
      handle.engagementWorker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await jev?.drain();
      await pool.end();
    },
  };
}

export interface LoginResult {
  token: string;
  session: { tenant_id: string; role_id: string; permissions: string[] };
  res: Response;
}

export async function login(baseUrl: string, loginName: string, password: string, tenantId: string): Promise<LoginResult> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password, tenant_id: tenantId }),
  });
  const data = (await res.json()) as { token?: string; session?: { tenant_id: string; role_id: string; permissions: string[] } };
  if (!res.ok || !data.token) {
    throw new Error(`login failed for ${loginName}@${tenantId}: ${res.status} ${JSON.stringify(data)}`);
  }
  return { token: data.token, session: data.session as LoginResult['session'], res };
}

export function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra };
}

export async function api(baseUrl: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

export const SEED = {
  a: {
    tenant: 'client_a',
    admin: { login: 'admin.a@example.com', password: 'Simula-A-Admin-2026!' },
    ops: { login: 'ops.a@example.com', password: 'Simula-A-Ops-2026!' },
    reader: { login: 'reader.a@example.com', password: 'Simula-A-Reader-2026!' },
  },
  b: {
    tenant: 'client_b',
    admin: { login: 'admin.b@example.com', password: 'Simula-B-Admin-2026!' },
    ops: { login: 'ops.b@example.com', password: 'Simula-B-Ops-2026!' },
    reader: { login: 'reader.b@example.com', password: 'Simula-B-Reader-2026!' },
  },
};
