/**
 * Aplica un parche tipado `site-edit/v2` (FR-0014) a la página: el modelo nunca reescribe HTML,
 * solo propone operaciones; aquí se validan una por una y el resultado completo se vuelve a
 * comprobar con las reglas del DSL (hero primero, contacto presente, hechos, contraste AA).
 *
 * - Una operación inválida rechaza TODO el parche (no hay aplicación parcial silenciosa).
 * - `set_fact` cambia datos de la página (horario, dirección, correo, lema, descripción); el
 *   teléfono nunca: sale de «Teléfonos de contacto».
 * - Página clásica: si el parche solo trae `set_fact` se queda clásica; cualquier otra operación la
 *   convierte antes a bloques con el mismo contenido (`designFromClassic`).
 * - `set_image` reserva un slot de imagen en un bloque y devuelve lo que hay que resolver (foto de la
 *   biblioteca o imagen generada): el job la obtiene y, si no puede, no crea ninguna propuesta.
 */

import { validate } from '../ai/schema.ts';
import { EDIT_FIELDS, FACT_FIELDS, THEME_FIELDS, type EditImage, type EditOperation } from '../ai/contracts.ts';
import {
  BLOCK_SCHEMA, BLOCK_VARIANTS, CTA_ACTIONS, FONT_STACKS, IMAGE_SLOTS, MOODS, accessiblePalette, designFromClassic, designTexts, validateDesign,
  type DesignBlock, type FactAllowance, type ImageSlot, type SiteDesign, type StoredDesign,
} from './design.ts';
import type { WebsiteData } from './template.ts';

const HEX = /^#[0-9a-fA-F]{6}$/;
const LIMITS: Record<string, number> = { heading: 120, subheading: 200, body: 700, cta_label: 40 };
const FACT_LIMITS: Record<(typeof FACT_FIELDS)[number], number> = { hours: 200, address: 200, email: 120, line: 160, about: 600 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ASSET_ID = /^ast_[A-Za-z0-9_-]{16,64}$/;
const MAX_IMAGES = 4;

/** Imagen que el job debe obtener antes de crear la propuesta. */
export interface ImageNeed { slot: ImageSlot; image: EditImage }

export interface EditResult {
  data: WebsiteData;
  /** Frases claras para la vista previa («Cambia el horario a …»). */
  sentences: string[];
  errors: string[];
  images: ImageNeed[];
  /** La página clásica pasó a bloques en este parche. */
  converted: boolean;
}

export const CONVERSION_SENTENCE = 'Tu página pasa al formato de secciones editables, con el mismo contenido y colores.';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function sentenceFor(op: EditOperation, design: SiteDesign | null): string {
  const blockName = (i: number | null) => (i !== null && design?.blocks[i] ? `la sección «${design.blocks[i]?.heading ?? design.blocks[i]?.type}»` : 'una sección');
  switch (op.op) {
    case 'set_fact': return `Cambia ${({ hours: 'el horario', address: 'la dirección', email: 'el correo', line: 'el lema', about: 'la descripción' } as const)[op.fact_field ?? 'about']} a «${op.value ?? ''}».`;
    case 'set_theme': return `Cambia ${op.theme_field} a ${op.value ?? ''}.`;
    case 'set_block_field': return `En ${blockName(op.block_index)}: ${op.field} → «${(op.value ?? '').slice(0, 80)}».`;
    case 'add_block': return `Agrega una sección «${op.new_block?.heading || op.new_block?.type || ''}».`;
    case 'remove_block': return `Quita ${blockName(op.block_index)}.`;
    case 'move_block': return `Mueve ${blockName(op.block_index)} a la posición ${(op.to_index ?? 0) + 1}.`;
    case 'set_items': return `Actualiza la lista de ${blockName(op.block_index)} (${op.items.length} elementos).`;
    case 'set_image': return `${op.image?.source === 'library' ? 'Usa una foto de tu biblioteca' : 'Agrega una imagen generada con IA'} en ${blockName(op.block_index)}: ${op.image?.alt ?? ''}.`;
  }
}

/** Slot para la imagen de un bloque: el suyo, el natural de su tipo o el primero libre. */
function slotFor(design: SiteDesign, b: DesignBlock): ImageSlot | null {
  if (b.image_slot) return b.image_slot;
  const used = new Set<ImageSlot>([...design.images.map((i) => i.slot), ...design.blocks.map((x) => x.image_slot).filter((s): s is ImageSlot => !!s)]);
  const preferred: ImageSlot[] = b.type === 'hero' ? ['hero'] : b.type === 'about' ? ['about', 'feature'] : b.type === 'gallery' ? ['gallery_1', 'gallery_2', 'gallery_3'] : ['feature', 'about'];
  return [...preferred, ...IMAGE_SLOTS].find((s) => !used.has(s) && (b.type === 'hero' || s !== 'hero')) ?? null;
}

/** El parche requiere bloques (todo salvo `set_fact`). */
export function needsBlocks(ops: EditOperation[]): boolean {
  return ops.some((op) => op.op !== 'set_fact');
}

/**
 * Aplica el parche. Página clásica + operaciones de bloques ⇒ se convierte primero (mismo contenido). Los textos que
 * ya estaban publicados no se consideran invención del modelo (solo se revisa lo que el parche escribe).
 */
export function applyEdit(current: WebsiteData, ops: EditOperation[], allowance: FactAllowance): EditResult {
  const data = clone(current);
  const errors: string[] = [];
  const sentences: string[] = [];
  const images: ImageNeed[] = [];
  let converted = false;
  if (!ops.length) return { data, sentences, errors: ['el parche no tiene operaciones'], images, converted };

  let stored: StoredDesign | null = data.design ? clone(data.design) : null;
  const owner = new Set<string>(allowance.ownerTexts ?? []);
  if (!stored && needsBlocks(ops)) {
    const conv = designFromClassic(data);
    if (!conv.stored) return { data, sentences, errors: conv.errors.map((e) => `conversión de la plantilla clásica: ${e}`), images, converted };
    stored = conv.stored;
    converted = true;
    conv.ownerTexts.forEach((t) => owner.add(t));
  }
  const design = stored?.design ?? null;
  if (design) designTexts(design).forEach((t) => owner.add(t.text));

  ops.forEach((op, n) => {
    const at = `operations[${n}]`;
    const needBlock = (): DesignBlock | null => {
      if (!design) { errors.push(`${at}: la página no tiene secciones editables`); return null; }
      const b = op.block_index === null ? undefined : design.blocks[op.block_index];
      if (!b) { errors.push(`${at}: no existe la sección ${String(op.block_index)}`); return null; }
      return b;
    };
    switch (op.op) {
      case 'set_fact': {
        const f = op.fact_field;
        const v = (op.value ?? '').trim();
        if (!f || !FACT_FIELDS.includes(f)) { errors.push(`${at}: dato desconocido`); return; }
        if (!v || v.length > FACT_LIMITS[f]) { errors.push(`${at}: ${f} necesita de 1 a ${FACT_LIMITS[f]} caracteres`); return; }
        if (f === 'email' && !EMAIL.test(v)) { errors.push(`${at}: correo inválido`); return; }
        (data as unknown as Record<string, unknown>)[f] = v;
        break;
      }
      case 'set_theme': {
        if (!design) { errors.push(`${at}: la página no tiene tema editable`); return; }
        const f = op.theme_field;
        const v = (op.value ?? '').trim();
        if (!f || !THEME_FIELDS.includes(f)) { errors.push(`${at}: token de tema desconocido`); return; }
        if (f.startsWith('palette.')) {
          if (!HEX.test(v)) { errors.push(`${at}: color en formato #RRGGBB`); return; }
          (design.theme.palette as unknown as Record<string, string>)[f.slice('palette.'.length)] = v.toLowerCase();
        } else if (f === 'heading_font' || f === 'body_font') {
          if (!(v in FONT_STACKS)) { errors.push(`${at}: tipografía no disponible`); return; }
          design.theme[f] = v as keyof typeof FONT_STACKS;
        } else if (f === 'radius') {
          if (!['none', 'soft', 'round'].includes(v)) { errors.push(`${at}: radio inválido`); return; }
          design.theme.radius = v as SiteDesign['theme']['radius'];
        } else if (f === 'density') {
          if (!['airy', 'balanced', 'compact'].includes(v)) { errors.push(`${at}: densidad inválida`); return; }
          design.theme.density = v as SiteDesign['theme']['density'];
        } else if (f === 'mood') {
          if (!(MOODS as readonly string[]).includes(v)) { errors.push(`${at}: estilo inválido`); return; }
          design.theme.mood = v as SiteDesign['theme']['mood'];
        }
        break;
      }
      case 'set_block_field': {
        const b = needBlock();
        if (!b) return;
        const f = op.field;
        const v = (op.value ?? '').trim();
        if (!f || !EDIT_FIELDS.includes(f)) { errors.push(`${at}: campo desconocido`); return; }
        if (f === 'heading' || f === 'subheading' || f === 'body') {
          if (v.length > (LIMITS[f] ?? 200)) { errors.push(`${at}: ${f} demasiado largo`); return; }
          b[f] = v || null;
        } else if (f === 'cta_label') {
          if (!v || v.length > 40) { errors.push(`${at}: texto del botón de 1 a 40 caracteres`); return; }
          b.cta = { label: v, action: b.cta?.action ?? 'contact_section' };
        } else if (f === 'cta_action') {
          if (!(CTA_ACTIONS as readonly string[]).includes(v)) { errors.push(`${at}: acción de botón inválida`); return; }
          b.cta = { label: b.cta?.label ?? 'Contáctanos', action: v as (typeof CTA_ACTIONS)[number] };
        } else if (f === 'tone') {
          if (!['default', 'inverted', 'accent'].includes(v)) { errors.push(`${at}: tono inválido`); return; }
          b.tone = v as DesignBlock['tone'];
        } else if (f === 'variant') {
          if (!(BLOCK_VARIANTS as readonly string[]).includes(v)) { errors.push(`${at}: variante inválida`); return; }
          b.variant = v as DesignBlock['variant'];
        }
        break;
      }
      case 'set_items': {
        const b = needBlock();
        if (!b) return;
        if (!op.items.length || op.items.length > 8) { errors.push(`${at}: la lista necesita de 1 a 8 elementos`); return; }
        b.items = op.items.map((i) => ({ title: i.title, text: i.text, icon: (i.icon === 'none' ? null : i.icon) as NonNullable<DesignBlock['items']>[number]['icon'] }));
        break;
      }
      case 'add_block': {
        if (!design) { errors.push(`${at}: la página no tiene secciones editables`); return; }
        const nb = op.new_block;
        if (!nb) { errors.push(`${at}: falta la sección nueva (new_block)`); return; }
        const block: DesignBlock = {
          type: nb.type, variant: nb.variant, heading: nb.heading.trim() || null, subheading: nb.subheading.trim() || null, body: nb.body.trim() || null,
          items: op.items.length ? op.items.map((i) => ({ title: i.title, text: i.text, icon: (i.icon === 'none' ? null : i.icon) as NonNullable<DesignBlock['items']>[number]['icon'] })) : null,
          image_slot: null,
          cta: nb.cta_label.trim() && nb.cta_action !== 'none' ? { label: nb.cta_label.trim(), action: nb.cta_action } : null,
          tone: nb.tone,
        };
        const errs = validate(BLOCK_SCHEMA, block);
        if (errs.length) { errors.push(...errs.map((e) => `${at}.new_block ${e}`)); return; }
        if (block.type === 'hero') { errors.push(`${at}: solo puede haber una portada`); return; }
        const contactAt = design.blocks.findIndex((x) => x.type === 'contact');
        const to = op.to_index ?? (contactAt >= 0 ? contactAt : design.blocks.length);
        if (to < 1 || to > design.blocks.length || design.blocks.length >= 10) { errors.push(`${at}: posición inválida o demasiadas secciones`); return; }
        design.blocks.splice(to, 0, block);
        break;
      }
      case 'remove_block': {
        const b = needBlock();
        if (!b || !design) return;
        if (b.type === 'hero' || b.type === 'contact') { errors.push(`${at}: la portada y el contacto no se quitan`); return; }
        design.blocks.splice(op.block_index as number, 1);
        break;
      }
      case 'move_block': {
        const b = needBlock();
        if (!b || !design) return;
        const to = op.to_index;
        if (to === null || to < 1 || to >= design.blocks.length || b.type === 'hero') { errors.push(`${at}: movimiento inválido (la portada va primero)`); return; }
        design.blocks.splice(op.block_index as number, 1);
        design.blocks.splice(to, 0, b);
        break;
      }
      case 'set_image': {
        const b = needBlock();
        if (!b || !design || !stored) return;
        const img = op.image;
        if (!img) { errors.push(`${at}: falta la imagen (image)`); return; }
        if (img.source === 'library' && !ASSET_ID.test(img.asset_id)) { errors.push(`${at}: elige una foto existente de la biblioteca (asset_id)`); return; }
        if (img.source === 'generate' && (img.subject.trim().length < 10 || img.style.trim().length < 3)) { errors.push(`${at}: describe la escena (10+ caracteres) y el estilo de la imagen`); return; }
        const slot = slotFor(design, b);
        if (!slot) { errors.push(`${at}: no quedan espacios para imágenes en la página`); return; }
        const request = {
          slot, aspect: img.aspect, alt: img.alt.trim(),
          subject: img.source === 'library' ? `Foto de la biblioteca del negocio: ${img.alt.trim()}`.slice(0, 400) : img.subject.trim(),
          style: img.source === 'library' ? 'foto propia del negocio' : img.style.trim(),
        };
        design.images = [...design.images.filter((i) => i.slot !== slot), request];
        if (design.images.length > MAX_IMAGES) { errors.push(`${at}: la página admite hasta ${MAX_IMAGES} imágenes`); return; }
        if (b.type !== 'gallery') b.image_slot = slot;
        delete stored.assets[slot];
        images.push({ slot, image: { ...img, alt: request.alt, subject: request.subject, style: request.style } });
        break;
      }
      default:
        errors.push(`${at}: operación desconocida`);
        return;
    }
    sentences.push(sentenceFor(op, design));
  });

  if (stored && design) {
    // Un bloque no puede apuntar a un slot sin solicitud de imagen: se reutiliza la regla del DSL.
    for (const b of design.blocks) if (b.image_slot && !design.images.some((i) => i.slot === b.image_slot)) b.image_slot = null;
    const v = validateDesign(design, { ...allowance, ownerTexts: owner });
    if (!v.design) errors.push(...v.errors);
    stored.adjustments = accessiblePalette(design.theme.palette).adjustments;
    data.design = stored;
  }
  if (converted) sentences.unshift(CONVERSION_SENTENCE);
  return { data, sentences, errors, images, converted };
}
