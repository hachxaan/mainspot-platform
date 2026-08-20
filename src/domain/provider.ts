/**
 * DomainProvider — aprovisionamiento de subdominio MainSpot por cliente
 * (INC-003, CAP-010, FLOW-006, DEC-019).
 *
 * DEC-026: interfaz de adaptador + implementación real opcional + MODO
 * SIMULADO funcional para E2E/piloto sin credenciales externas.
 */

export type DomainStatus = 'pending' | 'dns_provisioned' | 'cert_issued' | 'active' | 'failed';

export interface ProvisionInput {
  tenantId: string;
  slug: string;
  suffix: string; // 'sim.mainspot.local' (simulado) / dominio real MainSpot
}

export interface ProvisionResult {
  subdomain: string;
  provider: 'simulated' | 'hostinger';
  status: DomainStatus;
  dns_record: Record<string, unknown>;
  cert_info: Record<string, unknown>;
  /** Idempotente: true si ya existía una provisión activa. */
  already_provisioned: boolean;
}

export interface DomainProvider {
  readonly provider: 'simulated' | 'hostinger';
  provision(input: ProvisionInput): Promise<ProvisionResult>;
}

export function buildSubdomain(slug: string, suffix: string): string {
  const clean = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  return `${clean}.${suffix}`;
}
