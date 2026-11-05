/**
 * DEC-0027 / G-SEC — ensayo de anonimización SIN CAMBIOS. Para cada negocio no anonimizado ejecuta la
 * anonimización real (RetentionService.anonymizeTenant con dryRun), incluida su verificación de que no queda
 * ningún identificador en ninguna columna de texto, y SIEMPRE revierte. Es la comprobación definitiva de que
 * ninguna auditoría ni otra tabla impide anonimizar; los preflights SQL solo la aproximan.
 *
 *   DATABASE_URL=<copia restaurada> node scripts/anonymization-dry-run.ts --database=<nombre exacto de esa BD>
 *
 * Para una copia restaurada del respaldo (Fase B de docs/architecture/plan-catalog-gates-hardening.md), con
 * escritores detenidos: cada ensayo bloquea las filas del negocio mientras dura. Solo imprime recuentos y la
 * ubicación tabla.columna del primer rastro de cada negocio bloqueado; nunca identificadores. Código de salida:
 * 0 si todos se pueden anonimizar, 1 si alguno quedaría bloqueado, 2 ante un uso incorrecto.
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { AuditSink } from '../src/audit/sink.ts';
import { RetentionService } from '../src/retention/service.ts';
import { loadConfigTool } from '../src/shared/config.ts';
import { withRequestContext } from '../src/shared/context.ts';

const { Pool } = pg;

export interface DryRunSummary {
  tenants: number;
  anonymizable: number;
  blocked: number;
  /** `tabla.columna` (o `error:<nombre>`) → negocios bloqueados por ese primer rastro. */
  byLocation: Record<string, number>;
}

export async function anonymizationDryRun(pool: pg.Pool): Promise<DryRunSummary> {
  const retention = new RetentionService({ pool, sink: new AuditSink(pool) });
  const tenants = (await pool.query<{ client_id: string }>(
    `SELECT client_id FROM client WHERE status <> 'anonymized' ORDER BY client_id`)).rows.map((r) => r.client_id);
  const summary: DryRunSummary = { tenants: tenants.length, anonymizable: 0, blocked: 0, byLocation: {} };
  const runId = `ret_dryrun_${randomUUID()}`;
  for (const tenantId of tenants) {
    try {
      await retention.anonymizeTenant(tenantId, runId, { dryRun: true });
      summary.anonymizable += 1;
    } catch (err) {
      summary.blocked += 1;
      const message = err instanceof Error ? err.message : '';
      const location = /(?:identifier|name) left in ([a-z0-9_]+\.[a-z0-9_]+)/.exec(message)?.[1]
        ?? `error:${err instanceof Error ? err.name : 'unknown'}`;
      summary.byLocation[location] = (summary.byLocation[location] ?? 0) + 1;
    }
  }
  return summary;
}

async function main(): Promise<number> {
  const expected = process.argv.find((a) => a.startsWith('--database='))?.slice('--database='.length).trim();
  if (!expected) {
    console.error('Uso: DATABASE_URL=<copia restaurada> node scripts/anonymization-dry-run.ts --database=<nombre exacto de la BD>');
    return 2;
  }
  return withRequestContext(async () => {
    const pool = new Pool({ connectionString: loadConfigTool().databaseUrl, max: 2 });
    try {
      const current = (await pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]?.db;
      if (current !== expected) {
        console.error(`BLOCKED: DATABASE_URL apunta a otra BD que --database=${expected}. Nada se ejecutó.`);
        return 2;
      }
      const summary = await anonymizationDryRun(pool);
      console.log(`anonymization-dry-run: ${JSON.stringify(summary)}`);
      return summary.blocked === 0 ? 0 : 1;
    } finally {
      await pool.end();
    }
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
