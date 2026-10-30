/**
 * WebsitePublisher (INC-003) — efecto de publicación: renderiza el sitio del
 * tenant desde el payload aprobado y lo persiste versionado (website_content)
 * + actualiza client_website.published_version. Solo se invoca tras aprobación
 * humana (RULE-003) desde el state machine (FLOW-002).
 *
 * FLOW-006: al publicar también garantiza el subdominio simulado del tenant
 * (provisión idempotente).
 *
 * DEV-E2E-04 (P3): cada versión guarda también sus datos (`data`) para poder restaurarla. Una
 * propuesta `website.restore` trae `restore: { source_version, current_version }`: la publicación
 * crea una versión NUEVA (el historial no se toca) y falla de forma controlada si la versión en
 * vivo ya no es la que se comparó en la vista previa (guard optimista; sin éxito ficticio).
 */

import type { Pool } from 'pg';
import type { DbExecutor, PublishResult, Publisher, PublisherContext } from '../publishing/publisher.ts';
import type { DomainService } from '../domain/service.ts';
import { normalizeWebsiteData, renderSite, type WebsiteData } from '../website/template.ts';
import { withEffectivePhone, type ContactPhoneService } from '../contact/phones.ts';
import { AppError } from '../shared/errors.ts';

/** Payload esperado: { after: WebsiteData, diff_sentences: string[], restore?: {...} } */
export function extractWebsitePayload(payload: Record<string, unknown>): { data: WebsiteData; sentences: string[]; restore: RestoreRef | null } {
  const raw = payload['after'];
  const sectionsRaw = (payload['diff_sentences'] ?? []);
  return {
    data: normalizeWebsiteData(raw),
    sentences: Array.isArray(sectionsRaw) ? sectionsRaw.filter((s): s is string => typeof s === 'string') : [],
    restore: restoreRefOf(payload['restore']),
  };
}

/** Referencia a la versión origen de una restauración (propuesta `website.restore`). */
export interface RestoreRef {
  source_version: number;
  source_content_id: string | null;
  current_version: number;
}

/** Lee `detail.restore` de una propuesta; null si falta o no es una referencia válida. */
export function restoreRefOf(raw: unknown): RestoreRef | null {
  if (!raw || typeof raw !== 'object' || !('source_version' in raw) || !('current_version' in raw)) return null;
  const source = raw.source_version;
  const current = raw.current_version;
  if (typeof source !== 'number' || !Number.isInteger(source) || typeof current !== 'number' || !Number.isInteger(current)) return null;
  const contentId = 'source_content_id' in raw ? raw.source_content_id : null;
  return { source_version: source, source_content_id: typeof contentId === 'string' ? contentId : null, current_version: current };
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
      'SELECT website_id, slug, published_version FROM client_website WHERE tenant_id = $1 FOR UPDATE',
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

    // P3: guard optimista de la restauración. La vista previa comparó «actual (current_version) vs
    // solicitada»; si otra publicación se adelantó, no se sobrescribe a ciegas: fallo controlado.
    if (extracted.restore && extracted.restore.current_version !== Number(site.published_version)) {
      throw new AppError(409, 'stale_version', 'Tu página cambió después de preparar la restauración. Vuelve a elegir la versión.');
    }

    const nextVersion = Number(site.published_version) + 1;
    const html = renderSite(data, { version: nextVersion });
    const contentId = `wc_${crypto.randomUUID()}`;
    await conn.query(
      `INSERT INTO website_content (content_id, website_id, tenant_id, version, html, diff_summary, published_by, proposal_id, data, restored_from_version, restored_from_content_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [contentId, site.website_id, ctx.tenantId, nextVersion, html,
        sentences.join(' ') || 'Publicación de la página web.', ctx.proposalId, ctx.proposalId,
        JSON.stringify(data), extracted.restore?.source_version ?? null, extracted.restore?.source_content_id ?? null],
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
