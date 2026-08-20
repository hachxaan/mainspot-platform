/**
 * DomainService — orquestador de FLOW-006 (aprovisionamiento de dominio/cert).
 *
 * FIJO determinista: subdominio <slug>.<suffix> a partir del slug del sitio
 * del tenant. Idempotente en BD: UNIQUE (tenant_id, subdomain) + ON CONFLICT
 * (repetir la provisión no duplica ni falla). Auditoría emitida con
 * action='website.provisioned' (sensitive fail-closed).
 */

import type { Pool, PoolClient } from 'pg';
import type { AppConfig } from '../shared/config.ts';
import type { DomainProvider, ProvisionResult } from './provider.ts';
import { SimulatedHostinger } from './simulated.ts';
import { HostingerAdapter } from './hostinger.ts';
import type { DbExecutor } from '../publishing/publisher.ts';

export interface ClientDomainRow {
  domain_id: string;
  tenant_id: string;
  subdomain: string;
  provider: 'simulated' | 'hostinger';
  status: 'pending' | 'dns_provisioned' | 'cert_issued' | 'active' | 'failed';
  dns_record: Record<string, unknown>;
  cert_info: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export class DomainRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async findByTenant(tenantId: string): Promise<ClientDomainRow | null> {
    const res = await this.pool.query<ClientDomainRow>('SELECT * FROM client_domain WHERE tenant_id = $1', [tenantId]);
    return res.rows[0] ?? null;
  }

  async findByTenantAndSubdomain(tenantId: string, subdomain: string): Promise<ClientDomainRow | null> {
    const res = await this.pool.query<ClientDomainRow>(
      'SELECT * FROM client_domain WHERE tenant_id = $1 AND subdomain = $2',
      [tenantId, subdomain],
    );
    return res.rows[0] ?? null;
  }

  /** Upsert idempotente: si el (tenant, subdomain) ya existe devuelve la fila previa. */
  async upsert(tenantId: string, r: ProvisionResult, db: Pool | PoolClient = this.pool, domainId?: string): Promise<ClientDomainRow> {
    const id = domainId ?? `dom_${crypto.randomUUID()}`;
    // RETURNING * (sin re-SELECT): visible dentro de la misma transacción.
    const res = await db.query<ClientDomainRow>(
      `INSERT INTO client_domain (domain_id, tenant_id, subdomain, provider, status, dns_record, cert_info)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, subdomain) DO UPDATE SET
         provider = EXCLUDED.provider,
         status = EXCLUDED.status,
         dns_record = EXCLUDED.dns_record,
         cert_info = EXCLUDED.cert_info,
         updated_at = now()
       RETURNING *`,
      [id, tenantId, r.subdomain, r.provider, r.status, JSON.stringify(r.dns_record), JSON.stringify(r.cert_info)],
    );
    return res.rows[0] as ClientDomainRow;
  }
}

export class DomainService {
  private readonly pool: Pool;
  private readonly config: AppConfig;
  private readonly provider: DomainProvider;

  constructor(pool: Pool, config: AppConfig, providerOverride?: DomainProvider) {
    this.pool = pool;
    this.config = config;
    this.provider = providerOverride ?? createDomainProvider(config);
  }

  /** Aprovisiona (simula) el subdominio del tenant. Devuelve la fila persistida. */
  async ensureProvisioned(tenantId: string, slug: string, db?: DbExecutor): Promise<{ row: ClientDomainRow; already: boolean }> {
    const result = await this.provider.provision({
      tenantId,
      slug,
      suffix: this.config.mainspotDomainSuffix,
    });
    const repo = new DomainRepository(this.pool);
    const conn: DbExecutor = db ?? this.pool;
    const existing = await repo.findByTenantAndSubdomain(tenantId, result.subdomain);
    const row = existing ? existing : await repo.upsert(tenantId, result, conn);
    return { row, already: Boolean(existing) || result.already_provisioned };
  }

  async findByTenant(tenantId: string): Promise<ClientDomainRow | null> {
    return new DomainRepository(this.pool).findByTenant(tenantId);
  }
}

export function createDomainProvider(config: Pick<AppConfig, 'domainProvider' | 'hostingerApiToken' | 'hostingerApiBaseUrl'>): DomainProvider {
  if (config.domainProvider === 'hostinger' && config.hostingerApiToken) {
    return new HostingerAdapter(config.hostingerApiToken, config.hostingerApiBaseUrl);
  }
  // DEC-026: sin credenciales => simulado funcional (E2E/piloto).
  return new SimulatedHostinger();
}
