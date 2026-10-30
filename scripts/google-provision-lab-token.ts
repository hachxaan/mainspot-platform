/**
 * DEV-E2E-04 §2A — aprovisionamiento SEGURO de un refresh token de Google para un laboratorio
 * controlado (cuando el OAuth interactivo del dominio local no es viable).
 *
 *   node scripts/google-provision-lab-token.ts --tenant <client_id> --operator <nombre> [--file /ruta/token]
 *
 * El token se lee de un archivo con permisos 0600 del mismo usuario (--file) o de stdin; NUNCA de
 * argv ni de variables de entorno, y nunca se imprime. Requiere GOOGLE_OAUTH_CLIENT_ID/SECRET (el
 * refresh token debe pertenecer a ese cliente) y CONNECTOR_TOKEN_KEY. Esto NO equivale al onboarding
 * OAuth del SaaS: no hay consentimiento en el panel ni state/PKCE; queda auditado como
 * `google.connection.lab_provisioned` y solo debe usarse con cuentas/ubicaciones del propio titular.
 */

import { readFileSync, statSync } from 'node:fs';
import pg from 'pg';
import { AuditSink } from '../src/audit/sink.ts';
import { ProviderConnectionRepository } from '../src/connectors/repository.ts';
import { SecretBox } from '../src/connectors/secret-box.ts';
import { createGoogleIntegration } from '../src/google/integration.ts';
import { loadConfigTool } from '../src/shared/config.ts';
import { withRequestContext } from '../src/shared/context.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readToken(file: string | undefined): string {
  if (file) {
    const st = statSync(file);
    if ((st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()) {
      throw new Error(`El archivo del token debe ser del usuario actual y tener permisos 0600 (${file}).`);
    }
    return readFileSync(file, 'utf8').trim();
  }
  if (process.stdin.isTTY) throw new Error('Pasa el refresh token por --file (0600) o por stdin (no por argumentos).');
  return readFileSync(0, 'utf8').trim();
}

async function main(): Promise<void> {
  const tenant = arg('tenant');
  const operator = arg('operator');
  if (!tenant || !operator || arg('token')) {
    throw new Error('Uso: --tenant <client_id> --operator <nombre> [--file /ruta/0600]. El token nunca va en argv.');
  }
  const token = readToken(arg('file'));
  if (!token || token.length > 2048) throw new Error('Refresh token vacío o no válido.');
  const config = loadConfigTool();
  if (!config.connectorTokenKey) throw new Error('Falta CONNECTOR_TOKEN_KEY: no se pueden guardar tokens cifrados.');
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
  try {
    const connections = new ProviderConnectionRepository(pool, SecretBox.fromBase64(config.connectorTokenKey));
    const google = createGoogleIntegration({ pool, sink: new AuditSink(pool), connections, config });
    const view = await google.connection.provisionLabRefreshToken({ tenantId: tenant, operatorId: operator, refreshToken: token });
    const c = view.connection;
    console.log(JSON.stringify({
      tenant_id: tenant, status: view.status, needs_location: view.needs_location,
      external_account_id: c?.external_account_id ?? null, external_resource_id: c?.external_resource_id ?? null,
      last_error_code: c?.last_error_code ?? null, note: 'LAB provisioning: not equivalent to SaaS OAuth onboarding',
    }, null, 2));
  } finally {
    await pool.end();
  }
}

withRequestContext(main).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
