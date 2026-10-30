/**
 * Sitio local REAL por negocio (DEV-E2E-04, P3): https://<slug>.<LOCAL_SITE_DOMAIN>.
 *
 * El proxy HTTPS del LXC `webserver` (un vhost por sitio, certificado de la CA local mkcert,
 * instalado por scripts/client-site-provision.sh) reenvía a este proceso con `Host` = hostname del
 * sitio. Este middleware, colocado ANTES de las rutas del panel/API, atiende solo esas peticiones:
 *
 * - Sirve el HTML de la versión PUBLICADA (snapshot website_content.version = published_version),
 *   nunca un render en vivo ni un borrador: nada llega al sitio antes de la aprobación humana.
 * - Aislamiento: el slug es UNIQUE en client_website y el contenido se une por website_id +
 *   tenant_id; otro negocio no puede aparecer bajo este hostname.
 * - Slug desconocido, sitio sin publicar o ruta distinta de «/» ⇒ 404 (misma página, sin oráculo).
 * - Nunca actúa para el panel (`app.<dominio>` ni el host de PUBLIC_BASE_URL) ni para hosts ajenos.
 *
 * Solo DNS/hosts locales: este módulo no publica nada en Internet ni toca infraestructura.
 */

import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { errorPageHtml } from '../api/ui.ts';

/** Etiqueta DNS válida para el subdominio del negocio (minúsculas, dígitos y guiones internos). */
export const LOCAL_SITE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Etiquetas reservadas que nunca son un sitio de cliente. */
const RESERVED_LABELS: Record<string, true> = { app: true, www: true, api: true, panel: true, admin: true };

export interface LocalSiteOptions {
  pool: Pool;
  /** Dominio base de los sitios locales (p. ej. `mainspot.local.io`). */
  domain: string;
  /** Hostnames que jamás se tratan como sitio de cliente (el del panel). */
  excludeHosts?: readonly string[];
  /** AI Core (FR-0013): imágenes de la biblioteca, acotadas al negocio dueño del sitio. */
  media?: { variant(assetId: string, variant: string, tenantScope?: string): Promise<{ mime: string; bytes: Buffer } | null> };
}

const MEDIA_PATH = /^\/media\/([A-Za-z0-9_-]{1,80})\/([a-z0-9]{1,16})\.webp$/;

export interface LocalSiteInfo {
  hostname: string;
  url: string;
  provisioned: boolean;
  provisioned_at: string | null;
  cert_not_after: string | null;
}

export function localSiteHostname(slug: string, domain: string): string {
  return `${slug}.${domain}`;
}

/** Estado del sitio local tal como lo registró el comando de provisión (el proceso web solo lee). */
export function localSiteInfo(site: {
  slug: string; local_site_status?: string | null; local_site_provisioned_at?: string | null; local_site_cert_not_after?: string | null;
}, domain: string): LocalSiteInfo {
  const hostname = localSiteHostname(site.slug, domain);
  return {
    hostname,
    url: `https://${hostname}/`,
    provisioned: site.local_site_status === 'provisioned',
    provisioned_at: site.local_site_status === 'provisioned' ? (site.local_site_provisioned_at ?? null) : null,
    cert_not_after: site.local_site_status === 'provisioned' ? (site.local_site_cert_not_after ?? null) : null,
  };
}

/** Slug del negocio si `host` es un hostname de sitio local válido; null en cualquier otro caso. */
export function slugFromHost(host: string | undefined, domain: string, excludeHosts: readonly string[] = []): string | null {
  if (!host) return null;
  const name = host.toLowerCase().replace(/:\d+$/, '');
  if (excludeHosts.includes(name)) return null;
  const suffix = `.${domain.toLowerCase()}`;
  if (!name.endsWith(suffix)) return null;
  const slug = name.slice(0, -suffix.length);
  if (!LOCAL_SITE_SLUG_RE.test(slug) || Object.hasOwn(RESERVED_LABELS, slug)) return null;
  return slug;
}

const NOT_FOUND = 'Esta página no está publicada o no existe.';

export function localSiteMiddleware(opts: LocalSiteOptions): (req: Request, res: Response, next: NextFunction) => void {
  const exclude = (opts.excludeHosts ?? []).map((h) => h.toLowerCase());
  return (req, res, next) => {
    const slug = slugFromHost(req.headers.host, opts.domain, exclude);
    if (!slug) {
      next();
      return;
    }
    const media = MEDIA_PATH.exec(req.path);
    if (media && opts.media && (req.method === 'GET' || req.method === 'HEAD')) {
      const media_ = opts.media;
      opts.pool.query<{ tenant_id: string }>(
        `SELECT w.tenant_id FROM client_website w JOIN client c ON c.client_id = w.tenant_id AND c.status = 'active'
          WHERE w.slug = $1 AND w.status = 'published'`, [slug],
      ).then(async (r) => {
        const tenant = r.rows[0]?.tenant_id;
        const found = tenant ? await media_.variant(media[1] as string, media[2] as string, tenant) : null;
        if (!found) {
          res.setHeader('Cache-Control', 'no-store');
          res.status(404).type('html').send(errorPageHtml(NOT_FOUND, 404));
          return;
        }
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        res.status(200).type(found.mime).send(found.bytes);
      }).catch(next);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path !== '/') {
      res.status(404).type('html').send(errorPageHtml(NOT_FOUND, 404));
      return;
    }
    opts.pool.query<{ html: string }>(
      `SELECT wc.html FROM client_website w
         JOIN website_content wc ON wc.website_id = w.website_id AND wc.tenant_id = w.tenant_id AND wc.version = w.published_version
         JOIN client c ON c.client_id = w.tenant_id AND c.status = 'active'
        WHERE w.slug = $1 AND w.status = 'published' AND w.published_version > 0`, [slug],
    ).then((r) => {
      const row = r.rows[0];
      if (!row) {
        res.status(404).type('html').send(errorPageHtml(NOT_FOUND, 404));
        return;
      }
      res.status(200).type('html').send(row.html);
    }).catch(next);
  };
}
