/**
 * Registro en BD del estado del sitio local de un negocio (DEV-E2E-04 P3). Lo invoca SOLO
 * scripts/client-site-provision.sh (comando de operación con privilegios); el proceso web nunca
 * escribe estas columnas, solo las muestra en «Mi página».
 *
 *   node scripts/client-site-register.ts lookup --slug <slug> --domain mainspot.local.io
 *   node scripts/client-site-register.ts set --slug <slug> --domain mainspot.local.io \
 *        --status provisioned|removed [--cert-not-after 2027-01-30T00:00:00Z]
 *
 * Imprime JSON (tenant_id, slug, hostname, estado). Sin secretos; DATABASE_URL por entorno.
 */

import pg from 'pg';
import { AuditSink } from '../src/audit/sink.ts';
import { loadConfigTool } from '../src/shared/config.ts';
import { withRequestContext } from '../src/shared/context.ts';
import { LOCAL_SITE_SLUG_RE, localSiteHostname } from '../src/website/local-site.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface SiteRow {
  website_id: string; tenant_id: string; slug: string; published_version: number;
  local_site_status: string | null; local_site_hostname: string | null; local_site_provisioned_at: string | null; local_site_cert_not_after: string | null;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const slug = arg('slug') ?? '';
  const status = arg('status');
  const certNotAfter = arg('cert-not-after') ?? null;
  const usage = 'uso: node scripts/client-site-register.ts lookup|set --slug <slug> [--domain <dominio>] [--status provisioned|removed] [--cert-not-after <ISO>]';
  if ((cmd !== 'lookup' && cmd !== 'set') || !LOCAL_SITE_SLUG_RE.test(slug)) {
    console.error(usage);
    process.exit(2);
  }
  if (cmd === 'set' && status !== 'provisioned' && status !== 'removed') {
    console.error(usage);
    process.exit(2);
  }
  await withRequestContext(async () => {
    const cfg = loadConfigTool();
    const domain = (arg('domain') ?? cfg.localSiteDomain).toLowerCase();
    const hostname = localSiteHostname(slug, domain);
    const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 2 });
    try {
      const found = await pool.query<SiteRow>(
        `SELECT website_id, tenant_id, slug, published_version, local_site_status, local_site_hostname, local_site_provisioned_at, local_site_cert_not_after
           FROM client_website WHERE slug = $1`, [slug]);
      const site = found.rows[0];
      if (!site) {
        console.error(`No existe un negocio con slug «${slug}» en esta base de datos.`);
        process.exit(3);
      }
      if (cmd === 'lookup') {
        console.log(JSON.stringify({ tenant_id: site.tenant_id, slug: site.slug, hostname, published_version: Number(site.published_version), local_site_status: site.local_site_status, local_site_provisioned_at: site.local_site_provisioned_at }));
        return;
      }
      const provisioned = status === 'provisioned';
      await pool.query(
        `UPDATE client_website
            SET local_site_status = $2, local_site_hostname = $3,
                local_site_provisioned_at = CASE WHEN $2 = 'provisioned' THEN now() ELSE local_site_provisioned_at END,
                local_site_cert_not_after = CASE WHEN $2 = 'provisioned' THEN $4::timestamptz ELSE NULL END,
                updated_at = now()
          WHERE website_id = $1`, [site.website_id, status, hostname, provisioned ? certNotAfter : null]);
      await new AuditSink(pool).write({
        tenant_id: site.tenant_id, actor_id: 'operator:cli', actor_role: null,
        action: provisioned ? 'website.local_site.provisioned' : 'website.local_site.removed',
        resource: `client_website/${site.website_id}`, request_id: `cli_${crypto.randomUUID()}`,
        decision: 'allow', result: hostname,
      });
      console.log(JSON.stringify({ tenant_id: site.tenant_id, slug: site.slug, hostname, local_site_status: status, cert_not_after: provisioned ? certNotAfter : null }));
    } finally {
      await pool.end();
    }
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
