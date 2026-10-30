/**
 * DEV-E2E-04 §2A/§5 — retención del contenido de Google Business Profile.
 *
 * Política oficial (https://developers.google.com/my-business/content/policies, «Content storage»):
 * el contenido recibido por las APIs solo puede almacenarse de forma temporal «for no more than
 * 30 calendar days», de forma segura y sin manipularlo ni agregarlo. MainSpot guarda una copia
 * operativa de cada reseña (texto, nombre del reseñante) para clasificarla, proponer respuestas
 * y mostrar el caso; pasados 30 días desde que se guardó, ese contenido se sustituye por un
 * marcador y se conservan solo los hechos operativos propios de MainSpot: el nombre de recurso
 * (para no volver a ingerir y poder responder), la calificación como base de la decisión tomada,
 * la clasificación, el estado y la respuesta que publicó el negocio (contenido del negocio, no de
 * Google). Las exportaciones y la auditoría leen las filas vigentes, así que no retienen el
 * contenido más allá de la purga; la auditoría nunca guardó el texto.
 *
 * Solo afecta a reseñas REALES (source_review_id = nombre de recurso v4); las del simulador son
 * datos ficticios propios y siguen la retención general (DEC-0021).
 */

import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import { log } from '../shared/logger.ts';

export const GOOGLE_CONTENT_RETENTION = {
  interval: '29 days',
  source: 'https://developers.google.com/my-business/content/policies#content_storage',
  quote: 'It must be stored temporarily for no more than 30 calendar days.',
} as const;

export const GOOGLE_PURGED_TEXT = 'Contenido de Google eliminado por su política de almacenamiento (30 días).';
export const GOOGLE_PURGED_AUTHOR = 'Reseñante (dato eliminado)';
const RETENTION_ACTOR = 'system:retention';
/** Nombre de recurso de reseña v4: solo así se distingue contenido real de Google del simulador. */
const GOOGLE_REVIEW_NAME = 'accounts/%/locations/%/reviews/%';

export interface GooglePurgeCounts { reviews: number; cases: number }
export interface GooglePurgeReport { dryRun: boolean; tenants: number; tenantsWithChanges: number; totals: GooglePurgeCounts; failures: number }

export class GoogleContentRetention {
  private readonly pool: Pool;
  private readonly sink: AuditSink;

  constructor(deps: { pool: Pool; sink: AuditSink }) {
    this.pool = deps.pool;
    this.sink = deps.sink;
  }

  /** Lo que purgaría ahora para un tenant (sin efectos). */
  async preview(tenantId: string): Promise<GooglePurgeCounts> {
    const n = async (sql: string) => Number((await this.pool.query<{ n: string }>(sql, [tenantId, GOOGLE_CONTENT_RETENTION.interval, GOOGLE_REVIEW_NAME])).rows[0]?.n ?? 0);
    return {
      reviews: await n(`SELECT count(*) AS n FROM review WHERE tenant_id = $1 AND content_purged_at IS NULL AND source_review_id LIKE $3 AND created_at < now() - $2::interval`),
      cases: await n(`SELECT count(*) AS n FROM engagement_case WHERE tenant_id = $1 AND content_purged_at IS NULL AND origin = 'google_review' AND external_ref LIKE $3 AND created_at < now() - $2::interval`),
    };
  }

  /** Purga para toda la plataforma (o un tenant); una transacción y un evento de auditoría por tenant con cambios. */
  async purge(opts: { dryRun?: boolean; tenantId?: string } = {}): Promise<GooglePurgeReport> {
    const dryRun = opts.dryRun === true;
    const report: GooglePurgeReport = { dryRun, tenants: 0, tenantsWithChanges: 0, totals: { reviews: 0, cases: 0 }, failures: 0 };
    const tenants = opts.tenantId
      ? [opts.tenantId]
      : (await this.pool.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM review WHERE content_purged_at IS NULL AND source_review_id LIKE $2 AND created_at < now() - $1::interval
         UNION SELECT DISTINCT tenant_id FROM engagement_case WHERE content_purged_at IS NULL AND origin = 'google_review' AND external_ref LIKE $2 AND created_at < now() - $1::interval
         ORDER BY 1`, [GOOGLE_CONTENT_RETENTION.interval, GOOGLE_REVIEW_NAME])).rows.map((r) => r.tenant_id);
    for (const tenantId of tenants) {
      report.tenants += 1;
      try {
        const counts = dryRun ? await this.preview(tenantId) : await this.purgeTenant(tenantId);
        report.totals.reviews += counts.reviews;
        report.totals.cases += counts.cases;
        if (counts.reviews + counts.cases > 0) report.tenantsWithChanges += 1;
      } catch (err) {
        report.failures += 1;
        log.error('google.retention.tenant.failed', 'google content purge failed for a tenant', { tenant_id: tenantId, error_name: err instanceof Error ? err.name : 'unknown' });
      }
    }
    return report;
  }

  private async purgeTenant(tenantId: string): Promise<GooglePurgeCounts> {
    return runAtomic(this.pool, async (client) => {
      const params = [tenantId, GOOGLE_CONTENT_RETENTION.interval, GOOGLE_REVIEW_NAME, GOOGLE_PURGED_TEXT, GOOGLE_PURGED_AUTHOR];
      const reviews = await client.query(
        `UPDATE review SET review_text = $4, author_name = $5, suggested_options = '[]'::jsonb,
                response_text = CASE WHEN state = 'published' AND reply_origin = 'mainspot' THEN response_text ELSE NULL END,
                published_text = CASE WHEN reply_origin = 'mainspot' THEN published_text ELSE NULL END,
                content_purged_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND content_purged_at IS NULL AND source_review_id LIKE $3 AND created_at < now() - $2::interval`, params);
      const cases = await client.query(
        `UPDATE engagement_case SET body = $4, author_label = $5, drafts = '[]'::jsonb,
                response_text = CASE WHEN state = 'responded' THEN response_text ELSE NULL END,
                state = CASE WHEN state IN ('responded','rejected','closed_elsewhere') THEN state ELSE 'closed_elsewhere' END,
                content_purged_at = now(), updated_at = now()
          WHERE tenant_id = $1 AND content_purged_at IS NULL AND origin = 'google_review' AND external_ref LIKE $3 AND created_at < now() - $2::interval`, params);
      // Borrar también los nombres y borradores copiados a propuestas y conversaciones.
      const expired = `SELECT proposal_id FROM review WHERE tenant_id = $1 AND source_review_id LIKE $3 AND created_at < now() - $2::interval`;
      await client.query(
        `UPDATE conversation_request SET raw_message = $4, response_message = NULL, content_purged_at = now()
         WHERE tenant_id = $1 AND proposal_id IN (${expired})`, params.slice(0, 4));
      await client.query(
        `UPDATE action_proposal SET summary = $4, detail = jsonb_build_object('review_id', detail->>'review_id'),
                content_purged_at = now(), status = CASE WHEN status IN ('published','rejected','expired') THEN status ELSE 'expired' END
         WHERE tenant_id = $1 AND proposal_id IN (${expired})`, params.slice(0, 4));
      const counts = { reviews: reviews.rowCount ?? 0, cases: cases.rowCount ?? 0 };
      if (counts.reviews + counts.cases > 0) {
        await this.sink.write({
          tenant_id: tenantId, actor_id: RETENTION_ACTOR, actor_role: null, action: 'google.content.purged',
          resource: 'retention/google_content', request_id: `gret_${Date.now()}`, decision: 'allow',
          result: `reviews:${counts.reviews},cases:${counts.cases}`, evidence_ref: GOOGLE_CONTENT_RETENTION.source,
        }, client);
      }
      return counts;
    });
  }
}
