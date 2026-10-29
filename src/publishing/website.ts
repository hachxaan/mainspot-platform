/**
 * WebsitePublisher (INC-003) — efecto de publicación: renderiza el sitio del
 * tenant desde el payload aprobado y lo persiste versionado (website_content)
 * + actualiza client_website.published_version. Solo se invoca tras aprobación
 * humana (RULE-003) desde el state machine (FLOW-002).
 *
 * FLOW-006: al publicar también garantiza el subdominio simulado del tenant
 * (provisión idempotente).
 */

import type { Pool } from 'pg';
import type { DbExecutor, PublishResult, Publisher, PublisherContext } from '../publishing/publisher.ts';
import type { DomainService } from '../domain/service.ts';
import { normalizeWebsiteData, renderSite, type WebsiteData } from '../website/template.ts';
import { withEffectivePhone, type ContactPhoneService } from '../contact/phones.ts';

/** Payload esperado: { after: WebsiteData, diff_sentences: string[] } */
export function extractWebsitePayload(payload: Record<string, unknown>): { data: WebsiteData; sentences: string[] } {
  const raw = payload['after'];
  const sectionsRaw = (payload['diff_sentences'] ?? []);
  return {
    data: normalizeWebsiteData(raw),
    sentences: Array.isArray(sectionsRaw) ? sectionsRaw.filter((s): s is string => typeof s === 'string') : [],
  };
}

export class WebsitePublisher implements Publisher {
  readonly name = 'website' as const;
  private readonly pool: Pool;
  private readonly domainService: DomainService | null;
  private readonly phones: ContactPhoneService | null;

  constructor(pool: Pool, domainService?: DomainService, phones?: ContactPhoneService) {
    this.pool = pool;
    this.domainService = domainService ?? null;
    this.phones = phones ?? null;
  }

  async publish(ctx: PublisherContext, db?: DbExecutor): Promise<PublishResult> {
    const extracted = extractWebsitePayload(ctx.payload);
    const conn: DbExecutor = db ?? this.pool;
    // DEV-E2E-02: el teléfono publicado es el efectivo del canal website (principal u «Otro número» propio).
    const data = await withEffectivePhone(this.phones ?? undefined, ctx.tenantId, extracted.data, conn);
    const sentences = extracted.sentences;

    const siteRes = await conn.query<{ website_id: string; slug: string; published_version: number }>(
      'SELECT website_id, slug, published_version FROM client_website WHERE tenant_id = $1',
      [ctx.tenantId],
    );
    const site = siteRes.rows[0];
    if (!site) {
      return { ok: false, external_ref: `website_missing:${ctx.tenantId}`, error: 'client_website_not_found' };
    }

    // FLOW-006: garantizar subdominio simulado (idempotente) antes de publicar.
    let domainInfo = 'not_provisioned';
    if (this.domainService) {
      const { row } = await this.domainService.ensureProvisioned(ctx.tenantId, site.slug, db);
      domainInfo = row.subdomain;
    }

    const nextVersion = Number(site.published_version) + 1;
    const html = renderSite(data, { version: nextVersion });
    const contentId = `wc_${crypto.randomUUID()}`;
    await conn.query(
      `INSERT INTO website_content (content_id, website_id, tenant_id, version, html, diff_summary, published_by, proposal_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [contentId, site.website_id, ctx.tenantId, nextVersion, html,
        sentences.join(' ') || 'Publicación de la página web.', ctx.proposalId, ctx.proposalId],
    );
    await conn.query(
      `UPDATE client_website SET data = $1, published_version = $2, status = 'published', published_at = now(), updated_at = now()
       WHERE website_id = $3 AND tenant_id = $4`,
      [JSON.stringify(data), nextVersion, site.website_id, ctx.tenantId],
    );

    return {
      ok: true,
      version: nextVersion,
      external_ref: `${domainInfo}::website:v${nextVersion}`,
    };
  }
}
