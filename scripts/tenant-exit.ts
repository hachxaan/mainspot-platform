/**
 * DEC-0024 / DEC-0027: baja confirmada de un negocio (la decide una persona; nunca se
 * dispara sola: el vencimiento de una prueba no es una baja).
 *   npm run tenant:exit -- confirm --tenant=<client_id> --by=<operador> [--export-dir=<dir>]
 *       exporta los datos del negocio (JSON 0600, sin credenciales) y, en una transacción,
 *       registra la baja con la huella del export, retira el acceso (estado `exiting`),
 *       cancela la suscripción y audita `tenant.exit_confirmed`. La anonimización la hace la
 *       retención diaria a los 30 días.
 *   npm run tenant:exit -- status --tenant=<client_id>
 * Exportaciones por defecto en MAINSPOT_EXPORT_DIR o /var/lib/mainspot/exports (fuera del
 * directorio de la aplicación, que el despliegue reemplaza). Usa DATABASE_URL.
 */

import pg from 'pg';
import { AuditSink } from '../src/audit/sink.ts';
import { RetentionService } from '../src/retention/service.ts';
import { loadConfigTool } from '../src/shared/config.ts';
import { withRequestContext } from '../src/shared/context.ts';

const { Pool } = pg;

function argValue(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function required(name: string): string {
  const value = argValue(name)?.trim();
  if (!value) throw new Error(`--${name}=<valor> es obligatorio`);
  return value;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'confirm' && command !== 'status') {
    throw new Error('Uso: tenant-exit confirm --tenant=<id> --by=<operador> [--export-dir=<dir>] | status --tenant=<id>');
  }
  await withRequestContext(async () => {
    const cfg = loadConfigTool();
    const pool = new Pool({ connectionString: cfg.databaseUrl, max: 2 });
    try {
      const tenantId = required('tenant');
      if (command === 'status') {
        const res = await pool.query(
          `SELECT c.status, e.confirmed_at, e.confirmed_by, e.export_sha256, e.anonymize_after
             FROM client c LEFT JOIN tenant_exit e ON e.tenant_id = c.client_id WHERE c.client_id = $1`, [tenantId]);
        process.stdout.write(`${JSON.stringify(res.rows[0] ?? { status: 'not_found_or_anonymized' }, null, 2)}\n`);
        return;
      }
      const retention = new RetentionService({ pool, sink: new AuditSink(pool) });
      const result = await retention.confirmExit({
        tenantId,
        confirmedBy: required('by'),
        exportDir: argValue('export-dir') ?? process.env.MAINSPOT_EXPORT_DIR ?? '/var/lib/mainspot/exports',
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
