/**
 * Minimal migration runner. Applies migrations/*.sql in order inside an
 * advisory lock (PostgreSQL) so concurrent runs cannot race. Records applied
 * files in schema_migrations. Idempotent and replayable.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { loadConfigTool } from '../src/shared/config.ts';
import { log } from '../src/shared/logger.ts';
import { withRequestContext } from '../src/shared/context.ts';

const { Pool } = pg;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function applyMigrations(connectionString: string, dir = path.resolve('migrations')): Promise<MigrationResult> {
  const pool = new Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      file TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`SELECT pg_advisory_lock(hashtext('mainspot_migrations'))`);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const applied = await client.query<{ file: string }>('SELECT file FROM schema_migrations WHERE file = $1', [file]);
      if (applied.rowCount && applied.rowCount > 0) {
        result.skipped.push(file);
        continue;
      }
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (file) VALUES ($1)', [file]);
      result.applied.push(file);
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('mainspot_migrations'))`).catch(() => undefined);
    client.release();
    await pool.end();
  }
  return result;
}

async function main(): Promise<void> {
  await withRequestContext(async () => {
    const cfg = loadConfigTool();
    const result = await applyMigrations(cfg.databaseUrl);
    log.info('migrate.done', `applied=${result.applied.join(',') || 'none'} skipped=${result.skipped.join(',') || 'none'}`, {});
    if (result.applied.length === 0) {
      log.info('migrate.up_to_date', 'schema already up to date');
    }
  });
}

// Allow `node scripts/migrate.ts` and import from scripts.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
