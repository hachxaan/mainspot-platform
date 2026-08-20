/**
 * SimulatedHostinger — MODO SIMULADO funcional (DEC-026) de FLOW-006.
 *
 * Genera el subdominio <slug>.sim.mainspot.local determinista, marca DNS y
 * certificado provistos (simulados) y es idempotente: una misma provisión
 * devuelve el mismo resultado. Sin fuente de aleatoriedad (pinned).
 */

import { buildSubdomain, type DomainProvider, type ProvisionInput, type ProvisionResult } from './provider.ts';

const PROVISIONED = new Set<string>();

export class SimulatedHostinger implements DomainProvider {
  readonly provider = 'simulated' as const;

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const subdomain = buildSubdomain(input.slug, input.suffix);
    const key = `${input.tenantId}:${subdomain}`;
    const already = PROVISIONED.has(key);
    PROVISIONED.add(key);
    return {
      subdomain,
      provider: 'simulated',
      status: 'active',
      dns_record: {
        type: 'CNAME',
        name: subdomain,
        target: input.suffix,
        ttl: 3600,
        simulated: true,
      },
      cert_info: {
        issuer: 'simulated-lets-encrypt',
        expires_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        simulated: true,
      },
      already_provisioned: already,
    };
  }

  /** Para tests: limpia el estado en memoria. */
  static reset(): void {
    PROVISIONED.clear();
  }
}
