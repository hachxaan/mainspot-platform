/**
 * Per-request context (correlation) backed by AsyncLocalStorage so concurrent
 * requests never contaminate each other's logs/audit correlation.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface SessionSummary {
  session_id: string;
  user_id: string;
  tenant_id: string;
  role_id: string;
  role_name: string;
  permissions: readonly string[];
  source: string;
  issued_at: string;
  expires_at: string;
}

export interface RequestContext {
  request_id: string;
  session: SessionSummary | null;
  started_at: number;
}

const store = new AsyncLocalStorage<RequestContext>();

export function newRequestContext(session: SessionSummary | null = null): RequestContext {
  return { request_id: randomUUID(), session, started_at: Date.now() };
}

/** Run fn with ctx active for the current async scope. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/** Run fn with a fresh context (CLI scripts). */
export function withRequestContext<T>(fn: () => Promise<T>, ctx?: RequestContext): Promise<T> {
  return store.run(ctx ?? newRequestContext(), () => Promise.resolve().then(fn));
}

export function getRequestContext(): RequestContext | null {
  return store.getStore() ?? null;
}

export function ensureRequestContext(): RequestContext {
  const existing = store.getStore();
  if (existing) return existing;
  const fresh = newRequestContext();
  store.enterWith(fresh);
  return fresh;
}
