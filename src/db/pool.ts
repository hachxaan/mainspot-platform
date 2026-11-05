/**
 * PostgreSQL pool and helpers.
 * The pool is the only DB entry point; repositories never create their own
 * connections so tenant-scoping and transactions stay centralized.
 *
 * Connection loss (PostgreSQL restart, failover, pg_terminate_backend) must never take the process down:
 * pg emits 'error' on a client whose connection dies, and an EventEmitter 'error' without a listener throws.
 * Every client of the pool gets a listener when it connects, so this holds while it is idle AND while any code
 * has it checked out with pool.connect(); the failing query still rejects with the error, and pg-pool destroys a
 * client that is no longer queryable when it is released.
 */

import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { log } from '../shared/logger.ts';

const { Pool: PgPool } = pg;

export interface DbOptions {
  connectionString: string;
  max?: number;
}

let pool: pg.Pool | null = null;

export function getPool(options?: DbOptions): pg.Pool {
  if (pool) return pool;
  pool = new PgPool({
    connectionString: options?.connectionString,
    max: options?.max ?? 5,
  });
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      log.warn('db.client.connection_error', 'PostgreSQL client lost its connection', { error_name: err.name, error: err.message });
    });
  });
  // Re-emitted by pg-pool for idle clients (already logged by the client listener); without it the pool would throw.
  pool.on('error', () => undefined);
  return pool;
}

export function resetPool(): void {
  if (pool) {
    void pool.end();
    pool = null;
  }
}

/**
 * BEGIN … COMMIT on one pooled client; ROLLBACK and rethrow on any error. A client whose connection failed, or
 * whose ROLLBACK failed, is destroyed on release instead of returning to the pool inside an open transaction.
 * Pools not created by getPool (tests, scripts) are covered by the listener attached here while checked out.
 */
export async function runTransaction<T>(db: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken: Error | undefined;
  const onError = (err: Error) => { broken = err; };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
      broken ??= rollbackErr instanceof Error ? rollbackErr : new Error('ROLLBACK failed');
    });
    throw err;
  } finally {
    client.off('error', onError);
    client.release(broken);
  }
}
