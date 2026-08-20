/**
 * PostgreSQL pool and helpers.
 * The pool is the only DB entry point; repositories never create their own
 * connections so tenant-scoping and transactions stay centralized.
 */

import pg from 'pg';

const { Pool } = pg;

export interface DbOptions {
  connectionString: string;
  max?: number;
}

let pool: pg.Pool | null = null;

export function getPool(options?: DbOptions): pg.Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: options?.connectionString,
    max: options?.max ?? 5,
  });
  return pool;
}

export function resetPool(): void {
  if (pool) {
    void pool.end();
    pool = null;
  }
}
