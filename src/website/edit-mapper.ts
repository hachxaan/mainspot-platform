/**
 * Editor asistido por lenguaje natural (INC-003, REQ-012) — BÁSICO y DETERMINISTA.
 *
 * Atajo opcional, no el límite de lo que se puede pedir: reconoce patrones comunes en español
 * (horario, nombre, dirección, giro, servicio, sección) y los convierte en un parche estructurado de
 * WebsiteData. `isPreciseEdit` decide si el atajo basta; si no, el chat delega en la edición con IA
 * (Jev + parche `site-edit/v2`). El resultado SIEMPRE es una propuesta revisable que pasa por
 * confirmación → preview → aprobación humana (RULE-003) antes de publicar.
 *
 * La DETECCIÓN usa texto normalizado (sin acentos, minúsculas); los VALORES
 * de contenido del negocio se extraen del texto ORIGINAL para preservar
 * mayúsculas/acentos tal como el usuario los escribió.
 */

import type { PatchSentence } from '../conversation/intents.ts';
import { normalize } from '../conversation/classifier.ts';
import type { WebsiteData } from './template.ts';

export interface WebsitePatch {
  field: string;
  kind: 'change' | 'add' | 'remove';
  label: string;       // etiqueta legible del campo
  before?: string;
  after: string;
  sentence: string;
}

export interface WebsiteEditResult {
  patches: WebsitePatch[];
  after: WebsiteData;
  sentences: string[];          // diff conceptual legible (AC-006)
}

const PHONE_RE = /\+?\d[\d\s-]{7,}/;
const TIME_RE = /\b\d{1,2}:\d{2}\s*[-a]\s*\d{1,2}:\d{2}\b/i;

function extractValue(text: string, pattern: RegExp): string | null {
  const m = pattern.exec(text);
  return m ? m[0].trim().replace(/\s+/g, ' ') : null;
}

/** Extrae la parte tras una marca clave (p.ej. "llamado X" / "dirección: X"). */
function extractAfter(raw: string, pattern: RegExp): string | null {
  const m = pattern.exec(raw);
  const value = m && m[1] ? m[1].trim().replace(/[.,!?;]+$/g, '').replace(/\s+/g, ' ').trim() : null;
  return value && value.length >= 2 ? value : null;
}

/** Aplica una instrucción en lenguaje natural a los datos actuales del sitio. */
export function editWebsiteByInstruction(before: WebsiteData, rawInstruction: string): WebsiteEditResult {
  const n = normalize(rawInstruction);
  const raw = rawInstruction.trim().replace(/\s+/g, ' ');
  const patches: WebsitePatch[] = [];
  const after: WebsiteData = structuredClone(before);
  const sentences: string[] = [];

  const push = (p: WebsitePatch) => {
    patches.push(p);
    sentences.push(p.sentence);
  };

  // Teléfono / WhatsApp / contacto («mi número nuevo es …»).
  if (/(telefono|teléfono|whatsapp|whats ap|celular|movil|móvil|numero)/.test(n) && !TIME_RE.test(n)) {
    const newPhone = extractValue(raw, PHONE_RE);
    if (newPhone) {
      const beforeValue = after.phone || '(sin teléfono)';
      after.phone = newPhone;
      push({ field: 'contact.phone', kind: 'change', label: 'teléfono', before: beforeValue, after: newPhone, sentence: `Cambiar el teléfono de ${beforeValue} a ${newPhone}.` });
    } else {
      push({ field: 'contact.phone', kind: 'change', label: 'teléfono', after: after.phone, sentence: 'Actualizar el teléfono de contacto.' });
    }
    return { patches, after, sentences };
  }

  // Horario.
  if (/(horario|horarios|atiende|abre|cierra)/.test(n)) {
    const newHours = extractValue(raw, TIME_RE);
    if (newHours) {
      after.hours = newHours.replace(/\s+/g, ' ');
      push({ field: 'schedule.hours', kind: 'change', label: 'horario', before: before.hours, after: after.hours, sentence: `Cambiar el horario a ${after.hours}.` });
    } else {
      push({ field: 'schedule.hours', kind: 'change', label: 'horario', after: after.hours, sentence: 'Actualizar el horario de atención.' });
    }
    return { patches, after, sentences };
  }

  // Agregar servicio (con ítem explícito) — se evalúa ANTES de sección para
  // capturar "agrega un servicio llamado X".
  const addService = /agrega(?:r)?\s+(?:un\s+|el\s+|otro\s+)?(?:nuevo\s+)?servicio\s+(?:con\s+|llamado\s+|nuevo\s+)?\s*(:?\s*(.*))?/i.exec(raw);
  if (addService && addService[2]) {
    const item = addService[2].trim().replace(/[.,!?;]+$/g, '');
    if (item.length >= 2) {
      after.services = after.services ?? [];
      after.services.push(item);
      push({ field: 'service.add', kind: 'add', label: 'servicio', after: item, sentence: `Agregar el servicio "${item}".` });
      return { patches, after, sentences };
    }
  }

  // Agregar sección (genérica o conocida) — CAP-001 edición asistida.
  if (/(agrega|agregar|anade|añade|pon)\w*\s+(la\s+)?(una\s+|nueva\s+)?seccion/.test(n)) {
    // Título conocido sin palabras de relleno ("servicios a mi web" ⇒ "Servicios").
    const known = /seccion\s+(?:de\s+)?servicios?/.test(n) ? 'Servicios'
      : /seccion\s+(?:de\s+)?contacto/.test(n) ? 'Contacto'
      : /seccion\s+(?:de\s+)?(menu|galeria|ubicacion|direccion)/.test(n) ? 'Información'
      : null;
    // Para títulos genéricos, quitar coletillas comunes ("a mi web", "en mi página").
    const stripped = raw
      .replace(/\s+(a|en|de|para|con|por)\s+(mi\s+)?(web|pagina|página|sitio)$/i, '')
      .replace(/\s+en\s+mi\s+(web|pagina|página)$/i, '');
    const titleRaw = known ?? extractAfter(stripped, /secci[óo]n\s+(?:de\s+|llamada\s+|nombrada\s+)?(.*)/i);
    if (titleRaw && titleRaw.length > 0) {
      const fixedTitle = titleRaw.charAt(0).toUpperCase() + titleRaw.slice(1);
      after.sections = after.sections ?? [];
      if (!after.sections.some((s) => s.title.toLowerCase() === fixedTitle.toLowerCase())) {
        after.sections.push({ title: fixedTitle, content: `Información de ${fixedTitle.toLowerCase()}.` });
        push({ field: 'section.add', kind: 'add', label: 'sección', after: fixedTitle, sentence: `Agregar la sección "${fixedTitle}".` });
      } else {
        push({ field: 'section.add', kind: 'add', label: 'sección', after: fixedTitle, sentence: `La sección "${fixedTitle}" ya existe. Se mantiene sin cambios.` });
      }
      return { patches, after, sentences };
    }
  }

  // Nombre del negocio.
  if (/(cambia|pon|actualiza|ponle)\w*\s+(el\s+)?nombre/.test(n) || /se llama/.test(n)) {
    const newName = extractAfter(raw, /(?:cambia|pon|ponle|actualiza)\w*\s+(?:el\s+)?nombre\s+(?:a|de|es|:)?\s*(.*)|se llama\s+(.*)/i);
    if (newName) {
      const beforeValue = after.name;
      after.name = newName;
      push({ field: 'site.name', kind: 'change', label: 'nombre', before: beforeValue, after: newName, sentence: `Cambiar el nombre de la web a ${newName}.` });
      return { patches, after, sentences };
    }
  }

  // Dirección.
  if (/(direccion|dirección|ubicacion|ubicación)/.test(n)) {
    const newAddress = extractAfter(raw, /(?:direccion|dirección|ubicacion|ubicación)\s*(?:es|a|de|:)?\s*(.*)/i);
    if (newAddress) {
      after.address = newAddress;
      push({ field: 'contact.address', kind: 'change', label: 'dirección', before: before.address, after: newAddress, sentence: `Cambiar la dirección a ${newAddress}.` });
      return { patches, after, sentences };
    }
  }

  // Giro / propuesta.
  if (/(giro|rubro|actividad)/.test(n)) {
    const newLine = extractAfter(raw, /(?:giro|rubro|actividad)\s*(?:es|a|de|:)?\s*(.*)/i);
    if (newLine) {
      after.line = newLine;
      push({ field: 'site.line', kind: 'change', label: 'giro', before: before.line, after: after.line, sentence: `Cambiar la descripción del negocio a ${after.line}.` });
      return { patches, after, sentences };
    }
  }

  // Cambio genérico de la web.
  push({ field: 'site.generic', kind: 'change', label: 'información', after: raw, sentence: 'Actualizar la información de la página web.' });
  return { patches, after, sentences };
}

/** Campos que el atajo determinista resuelve con exactitud cuando la petición es una sola instrucción. */
const PRECISE_FIELDS = new Set(['schedule.hours', 'site.name', 'contact.address', 'site.line', 'service.add', 'section.add']);
/** Conectores que indican más de una petición o un matiz que el atajo no entiende («… y …», «… con …»). */
const COMPOUND = /\s(y|e|ademas|tambien|con|pero|luego|despues)\s|;/;

/**
 * El atajo determinista basta: un único cambio de un campo conocido, con valor extraído y sin otras
 * instrucciones en la misma frase. Lo demás lo interpreta la edición con IA cuando está disponible.
 */
export function isPreciseEdit(result: WebsiteEditResult, rawInstruction: string): boolean {
  if (result.patches.length !== 1) return false;
  const p = result.patches[0] as WebsitePatch;
  if (!PRECISE_FIELDS.has(p.field)) return false;
  if (p.field === 'schedule.hours' && p.before === undefined) return false;
  if (COMPOUND.test(` ${normalize(rawInstruction)} `)) return false;
  return p.after.length > 0 && p.after.length <= 80;
}

export function sentenceList(patches: WebsitePatch[]): PatchSentence[] {
  return patches.map((p) => ({ field: p.field, kind: p.kind, sentence: p.sentence }));
}
