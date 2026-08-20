/**
 * Seed (re)runner: applies migrations/0002_seed.sql manually (idempotent).
 * Use to restore the 2-tenant demo data after tests have mutated it.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { loadConfig } from '../src/shared/config.ts';
import { log } from '../src/shared/logger.ts';
import { withRequestContext } from '../src/shared/context.ts';

const { Pool } = pg;

async function main(): Promise<void> {
  await withRequestContext(async () => {
    const cfg = loadConfig();
    const sql = await readFile(path.resolve('migrations/0002_seed.sql'), 'utf8');
    const pool = new Pool({ connectionString: cfg.databaseUrl, max: 2 });
    try {
      await pool.query(sql);
      log.info('seed.done', 'seed data (2 tenants, roles, users) applied/refreshed', {});
    } finally {
      await pool.end();
    }
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
