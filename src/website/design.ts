/**
 * DSL de diseño web generativo (FR-0014, SEC-0001).
 *
 * El modelo NO escribe HTML/CSS/JS: devuelve un documento `site-design/v1` (bloques con variantes,
 * tokens de tema y solicitudes de imagen). Este módulo:
 *  - define el esquema (estricto) y lo valida;
 *  - rechaza hechos inventados (precios, teléfonos, correos, URLs) en cualquier texto del modelo;
 *  - corrige la paleta hasta contraste AA y registra cada ajuste;
 *  - renderiza HTML semántico, responsivo y SIN JavaScript; todo texto se escapa y el CSS sale solo
 *    de tokens validados (hex y listas cerradas). Teléfono, dirección, horario y correo vienen de los
 *    datos del negocio, nunca del modelo.
 */

import { validate, type JsonSchema } from '../ai/schema.ts';
import { esc } from './template.ts';

export const DESIGN_SCHEMA_VERSION = 'site-design/v1';

export const FONT_STACKS = {
  humanist: "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', source-sans-pro, sans-serif",
  geometric: "Avenir, Montserrat, Corbel, 'URW Gothic', source-sans-pro, sans-serif",
  neo_grotesque: "Inter, Roboto, 'Helvetica Neue', 'Arial Nova', 'Nimbus Sans', Arial, sans-serif",
  rounded: "ui-rounded, 'Hiragino Maru Gothic ProN', Quicksand, Comfortaa, Manjari, 'Arial Rounded MT', Calibri, sans-serif",
  old_style: "'Iowan Old Style', 'Palatino Linotype', 'URW Palladio L', P052, serif",
  transitional: "Charter, 'Bitstream Charter', 'Sitka Text', Cambria, serif",
  didone: "Didot, 'Bodoni MT', 'Noto Serif Display', 'URW Palladio L', P052, Sylfaen, serif",
  slab: "Rockwell, 'Rockwell Nova', 'Roboto Slab', 'DejaVu Serif', 'Sitka Small', serif",
} as const;
export type FontKey = keyof typeof FONT_STACKS;
const FONT_KEYS = Object.keys(FONT_STACKS) as FontKey[];

export const BLOCK_TYPES = ['hero', 'intro', 'services', 'features', 'gallery', 'about', 'hours', 'contact', 'cta', 'faq'] as const;
export const BLOCK_VARIANTS = ['split', 'centered', 'overlay', 'cards', 'list', 'grid', 'banner', 'stacked'] as const;
export const IMAGE_SLOTS = ['hero', 'about', 'gallery_1', 'gallery_2', 'gallery_3', 'feature'] as const;
export const CTA_ACTIONS = ['call', 'whatsapp', 'directions', 'contact_section', 'services_section'] as const;
export const ICONS = ['coffee', 'utensils', 'clock', 'map', 'phone', 'star', 'heart', 'leaf', 'sparkles', 'scissors', 'gift', 'truck', 'calendar', 'shield', 'users', 'check'] as const;
export const MOODS = ['calido', 'moderno', 'elegante', 'fresco', 'artesanal', 'vibrante', 'minimalista'] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];
export type ImageSlot = (typeof IMAGE_SLOTS)[number];

export interface DesignItem { title: string; text: string; icon: (typeof ICONS)[number] | null }
export interface DesignBlock {
  type: BlockType;
  variant: (typeof BLOCK_VARIANTS)[number];
  heading: string | null;
  subheading: string | null;
  body: string | null;
  items: DesignItem[] | null;
  image_slot: ImageSlot | null;
  cta: { label: string; action: (typeof CTA_ACTIONS)[number] } | null;
  tone: 'default' | 'inverted' | 'accent';
}
export interface DesignPalette { primary: string; secondary: string; accent: string; background: string; surface: string; text: string }
export interface DesignImageRequest { slot: ImageSlot; subject: string; style: string; aspect: '16:9' | '4:3' | '1:1' | '3:4'; alt: string }
export interface SiteDesign {
  theme: { mood: (typeof MOODS)[number]; palette: DesignPalette; heading_font: FontKey; body_font: FontKey; radius: 'none' | 'soft' | 'round'; density: 'airy' | 'balanced' | 'compact' };
  seo: { title: string; description: string };
  blocks: DesignBlock[];
  images: DesignImageRequest[];
}

/** Imagen ya generada y guardada en la biblioteca, ligada a un slot. */
export interface DesignImageAsset { asset_id: string; alt: string; width: number; height: number; is_illustration: boolean; variants: string[] }

/** Documento persistido en WebsiteData.design. */
export interface StoredDesign {
  schema: typeof DESIGN_SCHEMA_VERSION;
  design: SiteDesign;
  assets: Partial<Record<ImageSlot, DesignImageAsset>>;
  adjustments: string[];
  generated_by: { invocation_id: string | null; route_id: string | null; model_id: string | null; brand_version: number | null };
}

const HEX = '^#[0-9a-fA-F]{6}$';
const nullable = (s: JsonSchema): JsonSchema => ({ ...s, type: [s.type as 'string', 'null'] });
const str = (max: number, min = 1): JsonSchema => ({ type: 'string', minLength: min, maxLength: max });

const ITEM_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'text', 'icon'],
  properties: { title: str(80), text: str(280, 0), icon: { type: ['string', 'null'], enum: [...ICONS, null] } },
};

export const BLOCK_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['type', 'variant', 'heading', 'subheading', 'body', 'items', 'image_slot', 'cta', 'tone'],
  properties: {
    type: { type: 'string', enum: [...BLOCK_TYPES] },
    variant: { type: 'string', enum: [...BLOCK_VARIANTS] },
    heading: nullable(str(90)),
    subheading: nullable(str(180)),
    body: nullable(str(700)),
    items: { type: ['array', 'null'], items: ITEM_SCHEMA, maxItems: 8 },
    image_slot: { type: ['string', 'null'], enum: [...IMAGE_SLOTS, null] },
    cta: {
      type: ['object', 'null'], additionalProperties: false, required: ['label', 'action'],
      properties: { label: str(40), action: { type: 'string', enum: [...CTA_ACTIONS] } },
    },
    tone: { type: 'string', enum: ['default', 'inverted', 'accent'] },
  },
};

export const DESIGN_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['theme', 'seo', 'blocks', 'images'],
  properties: {
    theme: {
      type: 'object', additionalProperties: false,
      required: ['mood', 'palette', 'heading_font', 'body_font', 'radius', 'density'],
      properties: {
        mood: { type: 'string', enum: [...MOODS] },
        palette: {
          type: 'object', additionalProperties: false,
          required: ['primary', 'secondary', 'accent', 'background', 'surface', 'text'],
          properties: Object.fromEntries(['primary', 'secondary', 'accent', 'background', 'surface', 'text'].map((k) => [k, { type: 'string', pattern: HEX }])),
        },
        heading_font: { type: 'string', enum: FONT_KEYS },
        body_font: { type: 'string', enum: FONT_KEYS },
        radius: { type: 'string', enum: ['none', 'soft', 'round'] },
        density: { type: 'string', enum: ['airy', 'balanced', 'compact'] },
      },
    },
    seo: {
      type: 'object', additionalProperties: false, required: ['title', 'description'],
      properties: { title: str(65, 5), description: str(160, 20) },
    },
    blocks: { type: 'array', items: BLOCK_SCHEMA, minItems: 3, maxItems: 10 },
    images: {
      type: 'array', maxItems: 4,
      items: {
        type: 'object', additionalProperties: false, required: ['slot', 'subject', 'style', 'aspect', 'alt'],
        properties: {
          slot: { type: 'string', enum: [...IMAGE_SLOTS] },
          subject: str(400, 10), style: str(200, 3),
          aspect: { type: 'string', enum: ['16:9', '4:3', '1:1', '3:4'] },
          alt: str(140, 5),
        },
      },
    },
  },
};

// ------------------------------------------------------------------ hechos inventados

const PRICE_RE = /(\$\s?\d|\d\s?(?:mxn|pesos|usd|dólares|dolares)\b|\d+\s?%)/iu;
const PHONE_RE = /(?:\+?\d[\s().-]?){7,}/u;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
const URL_RE = /(https?:\/\/|www\.)/iu;
const MARKUP_RE = /<\s*\/?\s*[a-z!]|javascript:|on[a-z]+\s*=/iu;

export interface FactAllowance {
  /** Cadenas de precio/promoción confirmadas que sí pueden aparecer literalmente. */
  confirmedPriceStrings: string[];
}

/** Textos libres del modelo dentro del diseño (para comprobar hechos y marcado). */
export function designTexts(design: SiteDesign): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [
    { path: 'seo.title', text: design.seo.title }, { path: 'seo.description', text: design.seo.description },
  ];
  design.blocks.forEach((b, i) => {
    for (const key of ['heading', 'subheading', 'body'] as const) if (b[key]) out.push({ path: `blocks[${i}].${key}`, text: b[key] as string });
    if (b.cta) out.push({ path: `blocks[${i}].cta.label`, text: b.cta.label });
    (b.items ?? []).forEach((it, j) => {
      out.push({ path: `blocks[${i}].items[${j}].title`, text: it.title });
      out.push({ path: `blocks[${i}].items[${j}].text`, text: it.text });
    });
  });
  design.images.forEach((im, i) => {
    out.push({ path: `images[${i}].alt`, text: im.alt });
    out.push({ path: `images[${i}].subject`, text: im.subject });
  });
  return out;
}

/** Errores de fidelidad: precios/promos no confirmados, teléfonos, correos, URLs o marcado. */
export function factViolations(texts: Array<{ path: string; text: string }>, allowance: FactAllowance): string[] {
  const errors: string[] = [];
  const allowed = allowance.confirmedPriceStrings.map((s) => s.toLowerCase()).filter(Boolean);
  for (const { path, text } of texts) {
    const lower = text.toLowerCase();
    if (MARKUP_RE.test(text)) errors.push(`${path}: contiene marcado o código`);
    if (URL_RE.test(text)) errors.push(`${path}: contiene un enlace`);
    if (EMAIL_RE.test(text)) errors.push(`${path}: contiene un correo (sale de los datos del negocio)`);
    if (PHONE_RE.test(text)) errors.push(`${path}: contiene un teléfono (sale de los datos del negocio)`);
    if (PRICE_RE.test(text) && !allowed.some((a) => lower.includes(a))) errors.push(`${path}: menciona un precio o descuento no confirmado`);
  }
  return errors;
}

/** Validación completa de un diseño: esquema + reglas del DSL + hechos. */
export function validateDesign(raw: unknown, allowance: FactAllowance): { design: SiteDesign | null; errors: string[] } {
  const errors = validate(DESIGN_SCHEMA, raw);
  if (errors.length) return { design: null, errors };
  const design = raw as SiteDesign;
  const types = design.blocks.map((b) => b.type);
  if (types[0] !== 'hero') errors.push('blocks[0]: el primer bloque debe ser hero');
  if (!types.includes('contact')) errors.push('blocks: falta el bloque contact');
  if (types.filter((t) => t === 'hero').length > 1) errors.push('blocks: solo un hero');
  const slots = design.images.map((i) => i.slot);
  if (new Set(slots).size !== slots.length) errors.push('images: slot repetido');
  design.blocks.forEach((b, i) => {
    if (b.image_slot && !slots.includes(b.image_slot)) errors.push(`blocks[${i}].image_slot: no hay solicitud de imagen para ${b.image_slot}`);
  });
  errors.push(...factViolations(designTexts(design), allowance));
  return { design: errors.length ? null : design, errors };
}

// ------------------------------------------------------------------ contraste WCAG

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}
function shade(hex: string, factor: number): string {
  const rgb = hexToRgb(hex);
  return rgbToHex(rgb.map((v) => (factor < 0 ? v * (1 + factor) : v + (255 - v) * factor)) as [number, number, number]);
}
/** Oscurece (o aclara) `fg` hasta alcanzar `min` sobre `bg`. */
function ensureContrast(fg: string, bg: string, min: number): string {
  if (contrast(fg, bg) >= min) return fg;
  const darker = luminance(bg) > 0.4;
  let out = fg;
  for (let i = 1; i <= 20 && contrast(out, bg) < min; i++) out = shade(fg, darker ? -i * 0.05 : i * 0.05);
  return contrast(out, bg) >= min ? out : (darker ? '#111111' : '#ffffff');
}
function readableOn(bg: string): string {
  return contrast('#ffffff', bg) >= contrast('#161616', bg) ? '#ffffff' : '#161616';
}

/** Paleta final con AA garantizado (texto ≥ 4.5:1) y lista de ajustes aplicados. */
export function accessiblePalette(p: DesignPalette): { palette: DesignPalette & { on_primary: string; on_accent: string; muted: string }; adjustments: string[] } {
  const adjustments: string[] = [];
  const out = { ...p };
  const fix = (key: keyof DesignPalette, bg: string, min: number) => {
    const fixed = ensureContrast(out[key], bg, min);
    if (fixed.toLowerCase() !== out[key].toLowerCase()) adjustments.push(`${key} ${out[key]}→${fixed} (contraste ${min}:1 sobre ${bg})`);
    out[key] = fixed;
  };
  fix('text', out.background, 7);
  if (contrast(out.text, out.surface) < 4.5) {
    const s = ensureContrast(out.surface, out.text, 4.5);
    adjustments.push(`surface ${out.surface}→${s}`);
    out.surface = s;
  }
  // Primario como color de texto (enlaces y títulos) sobre el fondo: AA.
  fix('primary', out.background, 4.5);
  let onPrimary = readableOn(out.primary);
  if (contrast(onPrimary, out.primary) < 4.5) {
    out.primary = ensureContrast(out.primary, onPrimary, 4.5);
    adjustments.push('primary ajustado para texto sobre botón');
    onPrimary = readableOn(out.primary);
  }
  let onAccent = readableOn(out.accent);
  if (contrast(onAccent, out.accent) < 4.5) {
    out.accent = ensureContrast(out.accent, onAccent, 4.5);
    adjustments.push('accent ajustado para texto sobre franja');
    onAccent = readableOn(out.accent);
  }
  const muted = ensureContrast(shade(out.text, luminance(out.background) > 0.4 ? 0.35 : -0.35), out.background, 4.5);
  return { palette: { ...out, on_primary: onPrimary, on_accent: onAccent, muted }, adjustments };
}

// ------------------------------------------------------------------ render

const ICON_PATHS: Record<(typeof ICONS)[number], string> = {
  coffee: 'M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Zm13 1h1.5a2.5 2.5 0 0 1 0 5H17M8 3v2m4-2v2',
  utensils: 'M6 3v7a2 2 0 0 0 4 0V3M8 10v11M16 3c-1.7 1.5-2 4-2 6s1 3 2 3v9',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z',
  map: 'M12 21s-7-6.3-7-11a7 7 0 1 1 14 0c0 4.7-7 11-7 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3Z',
  heart: 'M12 20s-7-4.4-9-9a4.8 4.8 0 0 1 9-3 4.8 4.8 0 0 1 9 3c-2 4.6-9 9-9 9Z',
  leaf: 'M5 19c0-8 5-14 15-14 0 10-6 15-14 15M5 19l7-7',
  sparkles: 'M12 3l1.8 4.7L18 9.5l-4.2 1.8L12 16l-1.8-4.7L6 9.5l4.2-1.8L12 3ZM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.1 8.1 20 20M8.1 15.9 20 4',
  gift: 'M4 11h16v10H4zM3 7h18v4H3zM12 7v14M12 7c-2-4-6-4-6-1.5S10 7 12 7Zm0 0c2-4 6-4 6-1.5S14 7 12 7Z',
  truck: 'M3 6h11v10H3zM14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v4m8-4v4',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 10c0-3.3 2.7-6 6-6s6 2.7 6 6M16 3.1a4 4 0 0 1 0 7.8M21 21c0-2.9-1.7-5.3-4-6',
  check: 'm5 12 4 4L19 6',
};
function icon(name: (typeof ICONS)[number] | null): string {
  if (!name) return '';
  return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${ICON_PATHS[name]}"/></svg>`;
}

export interface SiteFacts {
  name: string;
  phone: string;
  email: string;
  address: string;
  hours: string;
  services: string[];
}

function digitsOnly(s: string): string {
  return s.replace(/[^\d+]/g, '');
}

function ctaHref(action: (typeof CTA_ACTIONS)[number], facts: SiteFacts): string | null {
  switch (action) {
    case 'call': return facts.phone ? `tel:${digitsOnly(facts.phone)}` : null;
    case 'whatsapp': return facts.phone ? `https://wa.me/${digitsOnly(facts.phone).replace(/^\+/, '')}` : null;
    case 'directions': return facts.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(facts.address)}` : null;
    case 'contact_section': return '#contacto';
    case 'services_section': return '#servicios';
  }
}

function imageTag(asset: DesignImageAsset | undefined, sizes: string, eager: boolean): string {
  if (!asset) return '';
  const base = `/media/${encodeURIComponent(asset.asset_id)}`;
  const widths = asset.variants.filter((v) => /^w\d+$/.test(v)).map((v) => Number(v.slice(1))).sort((a, b) => a - b);
  const srcset = widths.map((w) => `${base}/w${w}.webp ${w}w`).join(', ');
  const fallback = widths.length ? `${base}/w${widths[Math.min(1, widths.length - 1)]}.webp` : `${base}/original.webp`;
  const ratioH = Math.round((asset.height / asset.width) * 1000);
  return `<img src="${fallback}"${srcset ? ` srcset="${srcset}" sizes="${sizes}"` : ''} width="1000" height="${ratioH}" alt="${esc(asset.alt)}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
}

const SECTION_ID: Partial<Record<BlockType, string>> = { services: 'servicios', contact: 'contacto', hours: 'horario', about: 'nosotros', gallery: 'galeria', faq: 'preguntas' };

function renderBlock(b: DesignBlock, i: number, stored: StoredDesign, facts: SiteFacts): string {
  const cls = `blk blk-${b.type} v-${b.variant} t-${b.tone}`;
  const id = SECTION_ID[b.type] ? ` id="${SECTION_ID[b.type]}"` : '';
  const asset = b.image_slot ? stored.assets[b.image_slot] : undefined;
  const heading = b.heading ? (i === 0 ? `<h1>${esc(b.heading)}</h1>` : `<h2>${esc(b.heading)}</h2>`) : (i === 0 ? `<h1>${esc(facts.name)}</h1>` : '');
  const sub = b.subheading ? `<p class="lead">${esc(b.subheading)}</p>` : '';
  const body = b.body ? b.body.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('') : '';
  const href = b.cta ? ctaHref(b.cta.action, facts) : null;
  const cta = b.cta && href ? `<p class="cta-row"><a class="btn" href="${esc(href)}"${href.startsWith('https://') ? ' rel="noopener" target="_blank"' : ''}>${esc(b.cta.label)}</a></p>` : '';
  const items = (b.items ?? []).length
    ? `<ul class="items">${(b.items ?? []).map((it) => `<li class="item">${icon(it.icon)}<h3>${esc(it.title)}</h3>${it.text ? `<p>${esc(it.text)}</p>` : ''}</li>`).join('')}</ul>`
    : '';
  switch (b.type) {
    case 'hero':
      return `<section class="${cls}" aria-labelledby="b${i}h"><div class="wrap hero-grid">${asset ? `<figure class="hero-media">${imageTag(asset, '(min-width: 960px) 50vw, 100vw', true)}</figure>` : ''}<div class="hero-copy">${heading.replace('<h1>', `<h1 id="b${i}h">`)}${sub}${body}${cta}</div></div></section>`;
    case 'gallery': {
      const imgs = (['gallery_1', 'gallery_2', 'gallery_3'] as const).map((s) => stored.assets[s]).filter(Boolean) as DesignImageAsset[];
      return `<section class="${cls}"${id}><div class="wrap">${heading}${sub}<div class="gallery">${imgs.map((a) => `<figure>${imageTag(a, '(min-width: 960px) 33vw, 100vw', false)}</figure>`).join('')}</div>${body}</div></section>`;
    }
    case 'hours':
      return `<section class="${cls}"${id}><div class="wrap narrow">${icon('clock')}${heading || '<h2>Horario</h2>'}${sub}<p class="fact">${esc(facts.hours || 'Pregúntanos por nuestro horario.')}</p>${cta}</div></section>`;
    case 'contact': {
      const rows = [
        facts.phone ? `<li>${icon('phone')}<span>Teléfono</span><a href="tel:${esc(digitsOnly(facts.phone))}">${esc(facts.phone)}</a></li>` : '',
        facts.address ? `<li>${icon('map')}<span>Dirección</span><span>${esc(facts.address)}</span></li>` : '',
        facts.hours ? `<li>${icon('clock')}<span>Horario</span><span>${esc(facts.hours)}</span></li>` : '',
        facts.email ? `<li>${icon('check')}<span>Correo</span><a href="mailto:${esc(facts.email)}">${esc(facts.email)}</a></li>` : '',
      ].join('');
      return `<section class="${cls}"${id}><div class="wrap">${heading || '<h2>Contacto</h2>'}${sub}<ul class="contact-list">${rows}</ul>${cta}</div></section>`;
    }
    default:
      return `<section class="${cls}"${id}><div class="wrap${asset ? ' with-media' : ''}">${asset ? `<figure class="side-media">${imageTag(asset, '(min-width: 960px) 45vw, 100vw', false)}</figure>` : ''}<div class="copy">${heading}${sub}${body}${items}${cta}</div></div></section>`;
  }
}

function css(stored: StoredDesign, palette: ReturnType<typeof accessiblePalette>['palette']): string {
  const t = stored.design.theme;
  const radius = { none: '0', soft: '10px', round: '22px' }[t.radius];
  const gap = { airy: '5.5rem', balanced: '4rem', compact: '2.75rem' }[t.density];
  return `:root{--p:${palette.primary};--s:${palette.secondary};--a:${palette.accent};--bg:${palette.background};--sf:${palette.surface};--tx:${palette.text};--mu:${palette.muted};--op:${palette.on_primary};--oa:${palette.on_accent};--r:${radius};--gap:${gap};--hf:${FONT_STACKS[t.heading_font]};--bf:${FONT_STACKS[t.body_font]}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--tx);font-family:var(--bf);font-size:clamp(1rem,.95rem + .25vw,1.125rem);line-height:1.6}
img{max-width:100%;height:auto;display:block;border-radius:var(--r)}figure{margin:0}a{color:var(--p)}
.skip{position:absolute;left:-999px;top:0;background:var(--p);color:var(--op);padding:.6rem 1rem;z-index:10}.skip:focus{left:1rem}
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 92%,transparent);border-bottom:1px solid color-mix(in srgb,var(--tx) 10%,transparent)}
.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-block:.75rem}.brand{font-family:var(--hf);font-weight:700;font-size:1.15rem;color:var(--tx);text-decoration:none}
.top nav ul{display:flex;flex-wrap:wrap;gap:.25rem 1rem;list-style:none;margin:0;padding:0}.top nav a{text-decoration:none;color:var(--tx);font-size:.95rem;padding:.5rem .25rem;display:inline-block;min-height:44px;line-height:28px}
.wrap{width:min(1120px,100% - 2.5rem);margin-inline:auto}.narrow{max-width:46rem}
h1,h2,h3{font-family:var(--hf);line-height:1.15;color:var(--tx);margin:0 0 .6em}h1{font-size:clamp(2.1rem,1.4rem + 3.2vw,3.8rem);letter-spacing:-.02em}h2{font-size:clamp(1.6rem,1.2rem + 1.6vw,2.4rem)}h3{font-size:1.15rem}
p{margin:0 0 1em}.lead{font-size:1.2em;color:var(--mu)}
.blk{padding-block:var(--gap)}.t-inverted{background:var(--p);color:var(--op)}.t-inverted h1,.t-inverted h2,.t-inverted h3,.t-inverted .lead,.t-inverted a{color:var(--op)}
.t-accent{background:var(--a);color:var(--oa)}.t-accent h1,.t-accent h2,.t-accent h3,.t-accent .lead,.t-accent a{color:var(--oa)}
.btn{display:inline-flex;align-items:center;min-height:48px;padding:.75rem 1.4rem;border-radius:var(--r);background:var(--p);color:var(--op);font-weight:700;text-decoration:none}
.t-inverted .btn{background:var(--op);color:var(--p)}.t-accent .btn{background:var(--oa);color:var(--a)}
.hero-grid{display:grid;gap:2.5rem;align-items:center}.blk-hero.v-split .hero-grid{grid-template-columns:1fr}.blk-hero.v-centered .hero-copy{text-align:center;max-width:48rem;margin-inline:auto}
.blk-hero.v-overlay{position:relative;padding:0}.blk-hero.v-overlay .hero-grid{display:block;position:relative}.blk-hero.v-overlay .hero-media img{width:100%;max-height:78vh;object-fit:cover;border-radius:0;filter:brightness(.62)}
.blk-hero.v-overlay .hero-copy{position:absolute;inset:auto 0 0 0;padding:2rem 1.25rem 3rem;color:#fff}.blk-hero.v-overlay .hero-copy h1,.blk-hero.v-overlay .hero-copy .lead{color:#fff}
.items{list-style:none;padding:0;margin:1.5rem 0 0;display:grid;gap:1.25rem}.item{background:var(--sf);border-radius:var(--r);padding:1.4rem;color:var(--tx)}.item h3,.item p{color:var(--tx)}
.v-list .items{gap:.75rem}.v-list .item{display:grid;grid-template-columns:auto 1fr;column-gap:1rem}.v-list .item .ic{grid-row:span 2}
.ic{width:28px;height:28px;fill:none;stroke:var(--p);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;margin-bottom:.6rem}.t-inverted .ic{stroke:var(--op)}.t-accent .ic{stroke:var(--oa)}
.with-media{display:grid;gap:2.5rem;align-items:center}.gallery{display:grid;gap:1rem;grid-template-columns:1fr}
.contact-list{list-style:none;padding:0;margin:1rem 0;display:grid;gap:.85rem}.contact-list li{display:grid;grid-template-columns:28px 7rem 1fr;align-items:center;gap:.75rem;background:var(--sf);padding:1rem;border-radius:var(--r);color:var(--tx)}.contact-list li a{color:var(--p);word-break:break-word}.contact-list span{color:var(--tx)}
.t-inverted .contact-list li,.t-accent .contact-list li{color:var(--tx)}.fact{font-size:1.2rem;font-weight:600}
footer{padding:2.5rem 0 3rem;border-top:1px solid color-mix(in srgb,var(--tx) 12%,transparent);color:var(--mu);font-size:.9rem}footer p{margin:.25rem 0}
.preview-banner{background:#1d5c2e;color:#fff;text-align:center;padding:.6rem;font-weight:600}
@media (min-width:760px){.items{grid-template-columns:repeat(2,1fr)}.v-grid .items,.v-cards .items{grid-template-columns:repeat(3,1fr)}.gallery{grid-template-columns:repeat(3,1fr)}}
@media (min-width:960px){.blk-hero.v-split .hero-grid{grid-template-columns:1.05fr .95fr}.blk-hero.v-split .hero-media{order:2}.with-media{grid-template-columns:.9fr 1.1fr}.v-stacked .with-media{grid-template-columns:1fr}.blk-hero.v-overlay .hero-copy{padding:3rem 4rem 4rem;max-width:60rem}}
@media (max-width:520px){.contact-list li{grid-template-columns:28px 1fr}.contact-list li>span:first-of-type{display:none}.top nav{display:none}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}`;
}

export interface DesignRenderOptions { previewBanner?: string | null; version?: number }

/** HTML completo del sitio (sin JavaScript). */
export function renderDesignedSite(stored: StoredDesign, facts: SiteFacts, opts: DesignRenderOptions = {}): string {
  const { palette } = accessiblePalette(stored.design.theme.palette);
  const blocks = stored.design.blocks.map((b, i) => renderBlock(b, i, stored, facts)).join('\n');
  const nav = stored.design.blocks
    .filter((b) => SECTION_ID[b.type])
    .map((b) => `<li><a href="#${SECTION_ID[b.type]}">${esc(b.heading && b.heading.length <= 24 ? b.heading : ({ services: 'Servicios', contact: 'Contacto', hours: 'Horario', about: 'Nosotros', gallery: 'Galería', faq: 'Preguntas' } as Record<string, string>)[b.type] ?? '')}</a></li>`)
    .slice(0, 5).join('');
  const illustrated = Object.values(stored.assets).some((a) => a?.is_illustration);
  const banner = opts.previewBanner ? `<div class="preview-banner">${esc(opts.previewBanner)}</div>` : '';
  return `<!doctype html>
<html lang="es-MX">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(stored.design.seo.title)}</title>
<meta name="description" content="${esc(stored.design.seo.description)}">
<meta name="theme-color" content="${palette.primary}">
<style>${css(stored, palette)}</style>
</head>
<body>
${banner}<a class="skip" href="#main">Saltar al contenido</a>
<header class="top"><div class="wrap"><a class="brand" href="#main">${esc(facts.name)}</a><nav aria-label="Secciones"><ul>${nav}</ul></nav></div></header>
<main id="main">
${blocks}
</main>
<footer><div class="wrap"><p>${esc(facts.name)}${opts.version != null ? ` · versión ${opts.version}` : ''}</p>${illustrated ? '<p>Algunas imágenes son ilustraciones generadas con inteligencia artificial y no muestran instalaciones ni productos reales.</p>' : ''}</div></footer>
</body>
</html>`;
}

/** Normaliza un StoredDesign leído de JSONB (null si no es válido: se usa la plantilla clásica). */
export function normalizeStoredDesign(raw: unknown): StoredDesign | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<StoredDesign>;
  if (r.schema !== DESIGN_SCHEMA_VERSION || !r.design) return null;
  // Los hechos (precios confirmados) se comprobaron al generar; al leer de la BD se exige la forma.
  if (validate(DESIGN_SCHEMA, r.design).length > 0) return null;
  const assets: StoredDesign['assets'] = {};
  for (const slot of IMAGE_SLOTS) {
    const a = (r.assets as Record<string, DesignImageAsset> | undefined)?.[slot];
    if (a && typeof a.asset_id === 'string' && /^ast_[A-Za-z0-9_-]{16,64}$/.test(a.asset_id)) {
      assets[slot] = {
        asset_id: a.asset_id, alt: String(a.alt ?? ''), width: Number(a.width) || 1600, height: Number(a.height) || 900,
        is_illustration: a.is_illustration !== false, variants: Array.isArray(a.variants) ? a.variants.filter((v) => /^(w\d{3,4}|original)$/.test(v)) : [],
      };
    }
  }
  return {
    schema: DESIGN_SCHEMA_VERSION,
    design: r.design as SiteDesign,
    assets,
    adjustments: Array.isArray(r.adjustments) ? r.adjustments.map(String).slice(0, 20) : [],
    generated_by: {
      invocation_id: typeof r.generated_by?.invocation_id === 'string' ? r.generated_by.invocation_id : null,
      route_id: typeof r.generated_by?.route_id === 'string' ? r.generated_by.route_id : null,
      model_id: typeof r.generated_by?.model_id === 'string' ? r.generated_by.model_id : null,
      brand_version: typeof r.generated_by?.brand_version === 'number' ? r.generated_by.brand_version : null,
    },
  };
}
