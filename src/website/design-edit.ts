/**
 * Aplica un parche tipado `site-edit/v1` (FR-0014) a la página: el modelo nunca reescribe HTML,
 * solo propone operaciones; aquí se validan una por una y el resultado completo se vuelve a
 * comprobar con las reglas del DSL (hero primero, contacto presente, hechos, contraste AA).
 *
 * - Una operación inválida rechaza TODO el parche (no hay aplicación parcial silenciosa).
 * - `set_fact` cambia datos de la página (horario, dirección, correo, lema, descripción); el
 *   teléfono nunca: sale de «Teléfonos de contacto».
 * - Sin diseño generativo, solo se aceptan `set_fact` (la plantilla clásica no tiene bloques).
 */

import { validate } from '../ai/schema.ts';
import { EDIT_FIELDS, FACT_FIELDS, THEME_FIELDS, type EditOperation } from '../ai/contracts.ts';
import {
  BLOCK_SCHEMA, BLOCK_VARIANTS, CTA_ACTIONS, FONT_STACKS, MOODS, accessiblePalette, validateDesign,
  type DesignBlock, type FactAllowance, type SiteDesign, type StoredDesign,
} from './design.ts';
import type { WebsiteData } from './template.ts';

const HEX = /^#[0-9a-fA-F]{6}$/;
const LIMITS: Record<string, number> = { heading: 120, subheading: 200, body: 700, cta_label: 40 };
const FACT_LIMITS: Record<(typeof FACT_FIELDS)[number], number> = { hours: 200, address: 200, email: 120, line: 160, about: 600 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EditResult {
  data: WebsiteData;
  /** Frases claras para la vista previa («Cambia el horario a …»). */
  sentences: string[];
  errors: string[];
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function sentenceFor(op: EditOperation, design: SiteDesign | null): string {
  const blockName = (i: number | null) => (i !== null && design?.blocks[i] ? `la sección «${design.blocks[i]?.heading ?? design.blocks[i]?.type}»` : 'una sección');
  switch (op.op) {
    case 'set_fact': return `Cambia ${({ hours: 'el horario', address: 'la dirección', email: 'el correo', line: 'el lema', about: 'la descripción' } as const)[op.fact_field ?? 'about']} a «${op.value ?? ''}».`;
    case 'set_theme': return `Cambia ${op.theme_field} a ${op.value ?? ''}.`;
    case 'set_block_field': return `En ${blockName(op.block_index)}: ${op.field} → «${(op.value ?? '').slice(0, 80)}».`;
    case 'add_block': return `Agrega una sección «${String((op.block as { heading?: unknown } | null)?.heading ?? (op.block as { type?: unknown } | null)?.type ?? '')}».`;
    case 'remove_block': return `Quita ${blockName(op.block_index)}.`;
    case 'move_block': return `Mueve ${blockName(op.block_index)} a la posición ${(op.to_index ?? 0) + 1}.`;
    case 'set_items': return `Actualiza la lista de ${blockName(op.block_index)} (${(op.items ?? []).length} elementos).`;
  }
}

export function applyEdit(current: WebsiteData, ops: EditOperation[], allowance: FactAllowance): EditResult {
  const data = clone(current);
  const errors: string[] = [];
  const sentences: string[] = [];
  const stored: StoredDesign | null = data.design ? clone(data.design) : null;
  const design = stored?.design ?? null;

  if (!ops.length) return { data, sentences, errors: ['el parche no tiene operaciones'] };
  ops.forEach((op, n) => {
    const at = `operations[${n}]`;
    const needBlock = (): DesignBlock | null => {
      if (!design) { errors.push(`${at}: la página usa la plantilla clásica; pide un rediseño para editar secciones`); return null; }
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
        if (!design) { errors.push(`${at}: la plantilla clásica no tiene tema editable`); return; }
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
          b.cta = { label: b.cta?.label ?? 'Contáctanos', action: v as DesignBlock['cta'] extends infer C ? C extends { action: infer A } ? A : never : never };
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
        const items = op.items ?? [];
        if (!items.length || items.length > 8) { errors.push(`${at}: la lista necesita de 1 a 8 elementos`); return; }
        b.items = items.map((i) => ({ title: i.title, text: i.text, icon: (i.icon ?? null) as DesignBlock['items'] extends Array<infer I> | null ? I extends { icon: infer C } ? C : never : never }));
        break;
      }
      case 'add_block': {
        if (!design) { errors.push(`${at}: la plantilla clásica no admite secciones nuevas; pide un rediseño`); return; }
        const errs = validate(BLOCK_SCHEMA, op.block);
        if (errs.length) { errors.push(...errs.map((e) => `${at}.block ${e}`)); return; }
        const block = clone(op.block) as unknown as DesignBlock;
        // Una sección nueva no trae imagen generada en una edición: se usa la de la biblioteca si ya existe.
        if (block.image_slot && !stored?.assets[block.image_slot]) block.image_slot = null;
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
      default:
        errors.push(`${at}: operación desconocida`);
        return;
    }
    sentences.push(sentenceFor(op, design));
  });

  if (stored && design) {
    // Solicitudes de imagen sin bloque que las use se conservan (la biblioteca las guarda), pero un
    // bloque no puede apuntar a un slot sin solicitud: se reutiliza la regla del DSL.
    for (const b of design.blocks) if (b.image_slot && !design.images.some((i) => i.slot === b.image_slot)) b.image_slot = null;
    const v = validateDesign(design, allowance);
    if (!v.design) errors.push(...v.errors);
    stored.adjustments = accessiblePalette(design.theme.palette).adjustments;
    data.design = stored;
  }
  return { data, sentences, errors };
}
