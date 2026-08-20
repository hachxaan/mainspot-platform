/**
 * HostingerAdapter — implementación REAL opcional (DEC-019/026).
 *
 * SOLO se usa con DOMAIN_PROVIDER=hostinger y HOSTINGER_API_TOKEN. En ausencia
 * de credenciales el servicio cae a SimulatedHostinger (fail-safe: nunca se
 * llama a la API real sin token). El mapeo exacto a la API REST de Hostinger
 * queda TENTATIVA (contrato externo sin validar en esta tanda, sin credenciales).
 */

import { buildSubdomain, type DomainProvider, type ProvisionInput, type ProvisionResult } from './provider.ts';

export class HostingerAdapter implements DomainProvider {
  readonly provider = 'hostinger' as const;
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl = 'https://api.hostinger.com') {
    if (!token) {
      throw new Error('HostingerAdapter requires HOSTINGER_API_TOKEN (DEC-026)');
    }
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * TENTATIVA: esqueleto del flujo real (FLOW-006) — seleccionar subdominio,
   * validar disponibilidad, crear DNS, emitir certificado, asociar entorno.
   * Sin credenciales no se ejecuta; el adaptador real no se prueba en esta
   * tanda (limitación documentada).
   */
  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const subdomain = buildSubdomain(input.slug, input.suffix);

    // 1. Validar disponibilidad (GET /dns/records o equivalente).
    const check = await fetch(`${this.baseUrl}/v1/dns`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!check.ok) return { subdomain, provider: 'hostinger', status: 'failed', dns_record: {}, cert_info: {}, already_provisioned: false };

    // 2. Crear registro DNS (CNAME puntero).
    const dns = await fetch(`${this.baseUrl}/v1/dns/records`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'CNAME', name: subdomain, value: input.suffix, ttl: 3600 }),
    });
    const dnsRecord = { type: 'CNAME', name: subdomain, value: input.suffix, ttl: 3600, simulated: false };
    // 3. Emitir certificado (endpoint canónico TENTATIVA).
    const cert = await fetch(`${this.baseUrl}/v1/certificates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: subdomain, renewable: true }),
    });
    const certInfo = {
      requested: true,
      issuer: 'hostinger',
      simulated: false,
      raw_status: cert.ok ? 'ok' : `${cert.status}`,
    };

    return {
      subdomain,
      provider: 'hostinger',
      status: dns.ok && cert.ok ? 'active' : 'failed',
      dns_record: dnsRecord,
      cert_info: certInfo,
      already_provisioned: false,
    };
  }
}
