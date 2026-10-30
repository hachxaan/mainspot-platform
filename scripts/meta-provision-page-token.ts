/**
 * Aprovisionamiento de LABORATORIO de un page token de Facebook para un negocio
 * (DEV-E2E-04 §2B). NO equivale al onboarding OAuth del SaaS: aquí el operador ya posee un
 * page token de una Page que administra (p. ej. generado en Graph API Explorer para una app en
 * modo desarrollo) y lo guarda cifrado para pruebas controladas.
 *
 *   node scripts/meta-provision-page-token.ts --tenant client_a --page 1234567890 --token-file ~/.config/mainspot/meta-page.token
 *   cat token.txt | node scripts/meta-provision-page-token.ts --tenant client_a --page 1234567890 --stdin
 *
 * El token NUNCA se pasa por argv (quedaría en el historial y en `ps`), no se imprime y no se
 * registra. El archivo debe tener permisos 0600. Antes de guardar se verifica contra Meta
 * (lectura de la Page con ese token y, si hay META_APP_ID/META_APP_SECRET, debug_token con los
 * permisos efectivos); el estado resultante se persiste tal cual (connected, permission_missing,
 * needs_authorization, provider_unavailable o failed). Requiere CONNECTOR_TOKEN_KEY.
 */

import { readFile, stat } from 'node:fs/promises';
import { ProviderConnectionRepository } from '../src/connectors/repository.ts';
import { SecretBox } from '../src/connectors/secret-box.ts';
import { getPool } from '../src/db/pool.ts';
import { loadConfigTool } from '../src/shared/config.ts';
import { createMetaGraphClient } from '../src/social/meta.ts';
import { META_PROVIDER, MetaPagesAdapter, type MetaTokens } from '../src/social/meta-graph.ts';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : null;
}

async function readToken(): Promise<string> {
  const file = arg('token-file');
  if (file) {
    const info = await stat(file);
    if ((info.mode & 0o077) !== 0) throw new Error(`token file must be private (chmod 0600): ${file}`);
    return (await readFile(file, 'utf8')).trim();
  }
  if (process.argv.includes('--stdin')) {
    if (process.stdin.isTTY) throw new Error('--stdin expects the token piped, not typed on a terminal');
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  throw new Error('provide the token with --token-file <0600 file> or --stdin (never as an argument)');
}

async function main(): Promise<void> {
  const tenantId = arg('tenant');
  const pageId = arg('page');
  if (!tenantId || !pageId || !/^\d{1,32}$/.test(pageId)) {
    throw new Error('usage: --tenant <client_id> --page <facebook page id> (--token-file <path> | --stdin)');
  }
  const cfg = loadConfigTool();
  if (!cfg.connectorTokenKey) throw new Error('CONNECTOR_TOKEN_KEY is required to store the page token (fail closed)');
  const token = await readToken();
  if (!token) throw new Error('empty token');

  const pool = getPool({ connectionString: cfg.databaseUrl });
  try {
    const client = await pool.query('SELECT client_id FROM client WHERE client_id = $1', [tenantId]);
    if (!client.rowCount) throw new Error(`unknown tenant: ${tenantId}`);
    const connections = new ProviderConnectionRepository(pool, SecretBox.fromBase64(cfg.connectorTokenKey));
    const meta = new MetaPagesAdapter({ client: createMetaGraphClient(cfg), connections, appId: cfg.metaAppId, appSecret: cfg.metaAppSecret });
    const v = await meta.verifyPageToken(token, pageId);
    const saved = await connections.save<MetaTokens>({
      tenantId, provider: META_PROVIDER, status: v.status, tokens: { page_token: token },
      scopes: v.granted_scopes, externalResourceId: pageId, externalResourceName: v.page_name,
      connectedBy: 'operator:lab-provision', verified: v.status === 'connected', errorCode: v.error_code,
    });
    console.log(JSON.stringify({
      tenant_id: tenantId, provider: META_PROVIDER, status: saved.status, page_id: saved.external_resource_id, page_name: saved.external_resource_name,
      granted_scopes: v.granted_scopes, missing_scopes: v.missing_scopes, error_code: v.error_code, scopes_verified: meta.oauthConfigured,
      note: 'Aprovisionamiento de laboratorio: no sustituye el onboarding OAuth del SaaS ni la revisión de la app en Meta.',
    }, null, 2));
    if (saved.status !== 'connected') process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
