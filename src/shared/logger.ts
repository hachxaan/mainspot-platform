/**
 * Structured JSON logger for observability (NFR-005, AC-009).
 * Reads request context from AsyncLocalStorage (request_id, tenant_id,
 * actor_id) and NEVER logs secrets: fields are explicit and a guard refuses
 * sensitive-looking keys.
 */

import { config } from './config.ts';
import { getRequestContext } from './context.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogExtras {
  [key: string]: unknown;
}

const SECRET_KEY_PATTERN = /\b(password(?:s)?|passwd|token(?:s)?|secret(?:s)?|credential(?:s)?|authorization|api[_-]?key|private[_-]?key)\b|[_-](?:token(?:s)?|secret(?:s)?|password(?:s)?|key|credential(?:s)?|authorization)\b/i;

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  msg: string;
  request_id?: string;
  tenant_id?: string;
  actor_id?: string;
  actor_role?: string;
  [key: string]: unknown;
}

function write(level: LogLevel, event: string, msg: string, extra: LogExtras = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[config.logLevel]) return;

  for (const key of Object.keys(extra)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`Refusing to log field with sensitive name: ${key}`);
    }
  }

  const ctx = getRequestContext();
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    event,
    msg,
    ...(ctx ? { request_id: ctx.request_id } : {}),
    ...(ctx?.session ? {
      tenant_id: ctx.session.tenant_id,
      actor_id: ctx.session.user_id,
      actor_role: ctx.session.role_name,
    } : {}),
    ...extra,
  };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export const log = {
  debug: (event: string, msg: string, extra: LogExtras = {}) => write('debug', event, msg, extra),
  info: (event: string, msg: string, extra: LogExtras = {}) => write('info', event, msg, extra),
  warn: (event: string, msg: string, extra: LogExtras = {}) => write('warn', event, msg, extra),
  error: (event: string, msg: string, extra: LogExtras = {}) => write('error', event, msg, extra),
};
