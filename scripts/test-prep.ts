/**
 * test-prep: recreate the TEST database from scratch and apply schema + seed.
 * Used by `npm run test:integration` and `npm run test:smoke` so tests always
 * run against a deterministic 2-tenant fixture (AC-002 precondition).
 */

import pg from 'pg';
import { loadConfigTool } from '../src/shared/config.ts';
import { log } from '../src/shared/logger.ts';
import { withRequestContext } from '../src/shared/context.ts';
import { applyMigrations } from './migrate.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const { Pool } = pg;

async function main(): Promise<void> {
  await withRequestContext(async () => {
    const cfg = loadConfigTool();

    // Connect to the maintenance DB ('postgres') of the same server.
    const adminUrl = new URL(cfg.databaseUrl);
    const testUrl = new URL(cfg.testDatabaseUrl);
    const testDb = testUrl.pathname.replace(/^\//, '');
    adminUrl.pathname = '/postgres';

    const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${testDb.replace(/"/g, '')}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${testDb.replace(/"/g, '')}"`);
      log.info('test.prep.created', `recreated test database ${testDb}`, {});
    } finally {
      await admin.end();
    }

    const migrated = await applyMigrations(cfg.testDatabaseUrl);
    const pool = new Pool({ connectionString: cfg.testDatabaseUrl, max: 2 });
    try {
      const sql = await readFile(path.resolve('migrations/0002_seed.sql'), 'utf8');
      await pool.query(sql);
    } finally {
      await pool.end();
    }
    log.info('test.prep.done', 'test database ready', {
      applied: migrated.applied.join(',') || 'none',
    });
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
