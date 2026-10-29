/**
 * Alta asistida (DEV-E2E-02, FLOW-01): crea el negocio con plan piloto y una invitación de un
 * solo uso para su dueña o dueño. Herramienta de operación de MainSpot (no es una pantalla del
 * cliente). Imprime el enlace UNA vez; el token no se guarda en claro.
 *
 *   node scripts/invite-owner.ts --business "Panadería Lupita" --email lupita@example.com [--base http://localhost:3000]
 */

import pg from 'pg';
import { AuditSink } from '../src/audit/sink.ts';
import { OnboardingService } from '../src/identity/onboarding.ts';
import { loadConfigTool } from '../src/shared/config.ts';
import { withRequestContext } from '../src/shared/context.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const business = arg('business');
  const email = arg('email');
  if (!business || !email) {
    console.error('uso: node scripts/invite-owner.ts --business "<nombre>" --email <correo> [--plan plan_piloto_1] [--base <url pública; por defecto PUBLIC_BASE_URL>]');
    process.exit(2);
  }
  await withRequestContext(async () => {
    const cfg = loadConfigTool();
    const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 2 });
    try {
      const svc = new OnboardingService({ pool, sink: new AuditSink(pool) });
      const inv = await svc.createBusinessWithInvitation({ businessName: business, ownerEmail: email, planId: arg('plan'), createdBy: 'operator:cli' });
      const base = (arg('base') ?? cfg.publicBaseUrl).replace(/\/$/, '');
      console.log(JSON.stringify({ tenant_id: inv.tenant_id, expires_at: inv.expires_at, invitation_link: `${base}${inv.path}` }, null, 2));
    } finally {
      await pool.end();
    }
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
