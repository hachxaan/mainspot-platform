/**
 * Audit export (AC-003 evidence). Usage:
 *   node scripts/export-audit.ts --tenant client_a [--request-id req_xxx] [--out evidence/audit-export.json]
 * Writes the tenant-scoped audit events (optionally correlated by request_id)
 * as JSON. Contains no secrets by construction (audit_event schema).
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { loadConfigTool } from '../src/shared/config.ts';
import { log } from '../src/shared/logger.ts';
import { withRequestContext } from '../src/shared/context.ts';
import { AuditQuery } from '../src/audit/query.ts';

const { Pool } = pg;

function parseArgs(argv: string[]): { tenant: string; requestId?: string; out?: string; url?: string } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const cur = argv[i] as string;
    if (cur?.startsWith('--')) {
      args[cur.slice(2)] = argv[i + 1] as string;
      i += 1;
    }
  }
  if (!args.tenant) throw new Error('missing --tenant (e.g. --tenant client_a)');
  return { tenant: args.tenant, requestId: args['request-id'], out: args.out, url: args.url };
}

async function main(): Promise<void> {
  await withRequestContext(async () => {
    const cfg = loadConfigTool();
    const { tenant, requestId, out, url } = parseArgs(process.argv.slice(2));
    const connectionString = url ?? cfg.databaseUrl;
    const pool = new Pool({ connectionString, max: 2 });
    try {
      const query = new AuditQuery(pool);
      const events = await query.listByTenant(tenant, requestId ? { request_id: requestId } : { limit: 500 });
      const output = {
        exported_at: new Date().toISOString(),
        tenant_id: tenant,
        source_database: connectionString.includes('mainspot_test') ? 'mainspot_test' : 'mainspot',
        correlation: requestId ? { request_id: requestId } : null,
        count: events.length,
        events,
      };
      const target = out ?? path.join(cfg.evidenceDir, 'audit-export.json');
      await writeFile(target, JSON.stringify(output, null, 2) + '\n', 'utf8');
      process.stdout.write(`${JSON.stringify({ count: events.length, target }, null, 2)}\n`);
      log.info('audit.exported', `exported ${events.length} events to ${target}`, { tenant_id: tenant, count: events.length });
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
