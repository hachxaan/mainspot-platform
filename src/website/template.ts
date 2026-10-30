/**
 * Plantilla de página web del cliente (INC-003, CAP-001/REQ-012).
 *
 * La web "reside en el contenedor del cliente" (DEC-017): en el piloto se
 * representa como sitio estático renderizado desde los datos de negocio del
 * tenant. HTML/CSS simple y personalizable; TENTATIVA e iterable (no es un CMS).
 *
 * SEGURIDAD: todo dato del negocio se escapa (XSS-safe). El render es
 * determinista: misma data ⇒ mismo HTML (ideal para pruebas/evidencia).
 *
 * AI Core (FR-0014): si `design` trae un `site-design/v1` válido, el sitio se renderiza con el DSL de
 * bloques (src/website/design.ts, sin JavaScript); si no, con esta plantilla clásica.
 */

import { normalizeStoredDesign, renderDesignedSite, type StoredDesign } from './design.ts';

export interface WebsiteSection {
  title: string;
  content: string;
}

export interface WebsiteData {
  name: string;
  line: string;
  about: string;
  phone: string;
  email: string;
  address: string;
  hours: string;
  services: string[];
  sections: WebsiteSection[];
  /** Diseño generativo validado; null/ausente = plantilla clásica. */
  design?: StoredDesign | null;
}

export const EMPTY_WEBSITE: WebsiteData = {
  name: '',
  line: '',
  about: '',
  phone: '',
  email: '',
  address: '',
  hours: '',
  services: [],
  sections: [],
  design: null,
};

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderOptions {
  previewBanner?: string | null;
  version?: number;
}

/** Renderiza el sitio estático del tenant (determinista). */
export function renderSite(data: WebsiteData, opts: RenderOptions = {}): string {
  if (data.design) {
    return renderDesignedSite(data.design, {
      name: data.name || 'Mi negocio', phone: data.phone, email: data.email, address: data.address, hours: data.hours, services: data.services,
    }, opts);
  }
  const sections = (data.sections ?? []).map(
    (s) => `<section class="ms-section"><h2>${esc(s.title)}</h2><p>${esc(s.content)}</p></section>`,
  ).join('\n');

  const services = (data.services ?? []).map((s) => `<li>${esc(s)}</li>`).join('\n');

  const banner = opts.previewBanner
    ? `<div class="ms-banner">${esc(opts.previewBanner)}</div>`
    : '';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>${esc(data.name || 'Mi negocio')}</title>
<style>
  :root { color-scheme: light; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  body { margin: 0; background: #fdf7ef; color: #2b2118; }
  header.ms-hero { background: #7a3e12; color: #fff; padding: 2.5rem 1rem; text-align: center; }
  header.ms-hero h1 { margin: 0 0 .25rem; font-size: 2rem; }
  .ms-hero p { margin: 0; opacity: .92; }
  main { max-width: 52rem; margin: 0 auto; padding: 1.5rem 1rem; }
  .ms-card { background: #fff; border: 1px solid #eadfd2; border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .ms-section h2 { color: #7a3e12; }
  ul.ms-services { list-style: square; padding-left: 1.25rem; }
  .ms-contact { white-space: pre-line; }
  .ms-banner { background: #1d5c2e; color: #fff; text-align: center; padding: .6rem; font-weight: 600; }
  footer { text-align: center; color: #6c5b4b; font-size: .85rem; padding: 1rem; }
</style>
</head>
<body>
${banner}
<header class="ms-hero">
  <h1>${esc(data.name || 'Mi negocio')}</h1>
  <p>${esc(data.line || '')}</p>
</header>
<main>
  <div class="ms-card"><p>${esc(data.about || '')}</p></div>
  ${sections}
  ${services.length ? `<div class="ms-card"><h2>Nuestros servicios</h2><ul class="ms-services">\n${services}\n  </ul></div>` : ''}
  <div class="ms-card"><h2>Horario</h2><p>${esc(data.hours || '')}</p></div>
  <div class="ms-card ms-contact"><h2>Contacto</h2>
    <p>${data.phone ? `Teléfono: ${esc(data.phone)}<br>` : ''}${data.email ? `Correo: ${esc(data.email)}<br>` : ''}${data.address ? `Dirección: ${esc(data.address)}` : ''}</p>
  </div>
</main>
<footer>${esc(data.name || 'Mi negocio')} — ${opts.version != null ? `versión ${opts.version}` : ''}</footer>
</body>
</html>`;
}

/** Normaliza WebsiteData desconocida (de JSONB) con defaults seguros. */
export function normalizeWebsiteData(raw: unknown): WebsiteData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<string, unknown>>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const sectionsRaw = Array.isArray(r.sections)
    ? r.sections.filter((s): s is WebsiteSection => typeof s === 'object' && s !== null && 'title' in s && 'content' in s)
    : [];
  return {
    name: str(r.name) || 'Mi negocio',
    line: str(r.line),
    about: str(r.about),
    phone: str(r.phone),
    email: str(r.email),
    address: str(r.address),
    hours: str(r.hours),
    services: arr(r.services),
    sections: sectionsRaw.map((s) => ({ title: String(s.title), content: String(s.content) })),
    design: normalizeStoredDesign(r.design),
  };
}
