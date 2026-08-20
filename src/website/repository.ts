/**
 * WebsiteRepository (INC-003, CAP-001/REQ-012) — tenant-scoped.
 * Mismas invariantes INC-001: FAIL-CLOSED sin tenant, scope forzado por
 * tenant_id, ANTI-ORACLE (found/in_tenant).
 */

import type { Pool, PoolClient } from 'pg';
import type { SessionSummary } from '../shared/context.ts';
import { normalizeWebsiteData, type WebsiteData } from './template.ts';
import type { TenantBoundaryResult } from '../conversation/repositories.ts';

export interface ClientWebsiteRow {
  website_id: string;
  tenant_id: string;
  slug: string;
  site_name: string;
  status: 'draft' | 'published' | 'suspended';
  data: Record<string, unknown>;
  published_version: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

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

export interface WebsiteContentRow {
  content_id: string;
  website_id: string;
  tenant_id: string;
  version: number;
  html: string;
  diff_summary: string;
  published_by: string;
  proposal_id: string | null;
  created_at: string;
}

export class WebsiteRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private assertTenant(session: SessionSummary): string {
    if (!session?.tenant_id) {
      throw new Error('FAIL-CLOSED: website repository requires a tenant context');
    }
    return session.tenant_id;
  }

  async websiteForTenant(tenantId: string): Promise<ClientWebsiteRow | null> {
    const res = await this.pool.query<ClientWebsiteRow>(
      'SELECT * FROM client_website WHERE tenant_id = $1',
      [tenantId],
    );
    return res.rows[0] ?? null;
  }

  async websiteBySlugScoped(tenantId: string, slug: string): Promise<TenantBoundaryResult<ClientWebsiteRow>> {
    const res = await this.pool.query<ClientWebsiteRow>('SELECT * FROM client_website WHERE slug = $1', [slug]);
    const row = res.rows[0] ?? null;
    if (!row) return { found: false, in_tenant: false, row: null };
    return { found: true, in_tenant: row.tenant_id === tenantId, row };
  }

  /** Convierte la fila de BD a WebsiteData normalizada (segura). */
  dataOf(row: ClientWebsiteRow): WebsiteData {
    return normalizeWebsiteData(row.data);
  }

  /** Guarda la data de negocio actualizada (sin publicar). Usado por la confirmación preview. */
  async updateData(tenantId: string, websiteId: string, data: WebsiteData, db: Pool | PoolClient = this.pool): Promise<void> {
    await db.query(
      'UPDATE client_website SET data = $1, updated_at = now() WHERE website_id = $2 AND tenant_id = $3',
      [JSON.stringify(data), websiteId, tenantId],
    );
  }
}

export { normalizeWebsiteData };
export type { WebsiteData };
