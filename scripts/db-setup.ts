/**
 * db-setup: ensure the dev database exists and apply migrations + seed.
 * (docker compose up -d postgres creates the database itself; this script is
 * the fallback/local path and is also used by the app container.)
 */

import pg from 'pg';
import { loadConfig } from '../src/shared/config.ts';
import { log } from '../src/shared/logger.ts';
import { withRequestContext } from '../src/shared/context.ts';
import { applyMigrations } from './migrate.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const { Pool } = pg;

async function ensureDatabase(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const url = new URL(cfg.databaseUrl);
  const dbName = url.pathname.replace(/^\//, '') || 'mainspot';
  url.pathname = '/postgres';
  const admin = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      // identifier from configuration (safer than string interpolation).
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`);
      log.info('db.created', `created database ${dbName}`, {});
    }
  } finally {
    await admin.end();
  }
}

async function main(): Promise<void> {
  await withRequestContext(async () => {
    const cfg = loadConfig();
    await ensureDatabase(cfg);
    const migrated = await applyMigrations(cfg.databaseUrl);
    const pool = new Pool({ connectionString: cfg.databaseUrl, max: 2 });
    try {
      const sql = await readFile(path.resolve('migrations/0002_seed.sql'), 'utf8');
      await pool.query(sql);
    } finally {
      await pool.end();
    }
    log.info('db.setup.done', 'database ready (migrate + seed)', {
      applied: migrated.applied.join(',') || 'none',
      skipped: migrated.skipped.join(',') || 'none',
    });
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
