/**
 * QS-0006 (DEC-0021..DEC-0027): retención global fuera del servidor.
 *   npm run retention:run -- --dry-run          → informe de lo que se purgaría y de las bajas que
 *                                                  vencen; no cambia nada.
 *   npm run retention:run                       → ejecución manual (la diaria automática corre en el
 *                                                  servidor); queda en retention_run y en la auditoría.
 *   npm run retention:run -- --export-registry  → huellas sha256 de los tenants anonimizados (JSON en
 *                                                  stdout), para guardar junto a una restauración.
 *   npm run retention:run -- --reapply-exits [--registry=<archivo.json>]
 *                                               → tras restaurar un respaldo: vuelve a anonimizar los
 *                                                  tenants anonimizados después de ese respaldo
 *                                                  (registro de la BD o el exportado de la fuente).
 * Usa DATABASE_URL. Nunca imprime identificadores de tenant.
 */

import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { AuditSink } from '../src/audit/sink.ts';
import { RetentionService } from '../src/retention/service.ts';
import { loadConfigTool } from '../src/shared/config.ts';
import { withRequestContext } from '../src/shared/context.ts';

const { Pool } = pg;

function argValue(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function readRegistry(file: string): Promise<string[]> {
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  const hashes = typeof parsed === 'object' && parsed !== null && 'tenant_sha256' in parsed ? parsed.tenant_sha256 : null;
  if (!Array.isArray(hashes) || !hashes.every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))) {
    throw new Error(`${file}: expected {"tenant_sha256": ["<sha256>", ...]} (output of --export-registry)`);
  }
  return hashes;
}

async function main(): Promise<void> {
  await withRequestContext(async () => {
    const cfg = loadConfigTool();
    const pool = new Pool({ connectionString: cfg.databaseUrl, max: 3 });
    try {
      const retention = new RetentionService({ pool, sink: new AuditSink(pool) });
      if (process.argv.includes('--export-registry')) {
        const hashes = await retention.exportRegistry();
        process.stdout.write(`${JSON.stringify({ format: 'mainspot-anonymized-registry/v1', exported_at: new Date().toISOString(), tenant_sha256: hashes }, null, 2)}\n`);
        return;
      }
      if (process.argv.includes('--reapply-exits')) {
        const file = argValue('registry');
        const result = await retention.reapplyExits(file ? await readRegistry(file) : undefined);
        process.stdout.write(`${JSON.stringify({ mode: 'reapply-exits', registry: file ? 'file' : 'database', ...result }, null, 2)}\n`);
        return;
      }
      const report = await retention.run({ trigger: 'manual', dryRun: process.argv.includes('--dry-run') });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.status !== 'completed') process.exitCode = 2;
    } finally {
      await pool.end();
    }
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
