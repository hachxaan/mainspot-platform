/**
 * PostgreSQL pool and helpers.
 * The pool is the only DB entry point; repositories never create their own
 * connections so tenant-scoping and transactions stay centralized.
 *
 * Connection loss (PostgreSQL restart, failover, pg_terminate_backend) must never take the process down:
 * pg emits 'error' on a client whose connection dies, and an EventEmitter 'error' without a listener throws.
 * Idle clients forward it to the pool (listener below); a checked-out client is covered by runTransaction.
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
  // An idle client whose connection died: pg-pool already discards it; the next checkout reconnects.
  pool.on('error', (err) => {
    log.warn('db.pool.idle_client_error', 'idle PostgreSQL client lost its connection', { error_name: err.name, error: err.message });
  });
  return pool;
}

export function resetPool(): void {
  if (pool) {
    void pool.end();
    pool = null;
  }
}

/**
 * BEGIN … COMMIT on one pooled client; ROLLBACK and rethrow on any error. While the client is checked out
 * an 'error' listener is attached (the failing query rejects with that same error), and a client whose
 * connection failed is destroyed on release instead of returning to the pool.
 */
export async function runTransaction<T>(db: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let connectionError: Error | undefined;
  const onError = (err: Error) => { connectionError = err; };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.off('error', onError);
    client.release(connectionError);
  }
}
