/**
 * Respuestas a consultas de solo lectura (INC-002, AC-005, RULE-002).
 * Sin efectos externos y sin approval gate. Legible para no técnicos (AC-008).
 */

import { normalize } from './classifier.ts';
import type { ClassificationResult } from './intents.ts';
import type { WebsiteRepository } from '../website/repository.ts';

export async function buildReadOnlyAnswer(
  repo: WebsiteRepository | null,
  tenantId: string,
  classification: ClassificationResult,
  rawText: string,
): Promise<string> {
  const n = normalize(rawText);

  // Consultas de precios: no hay precios aprobados; responder sin inventar (RULE-005/006).
  if (/(precio|costo|tarifa|cuota|plan|mensualidad)/.test(n)) {
    return 'No tengo información de precios aprobados para tu negocio. Si necesitas actualizar precios, coordina con el equipo de MainSpot (es una decisión que requiere revisión humana).';
  }

  const site = repo ? await repo.websiteForTenant(tenantId) : null;
  if (site) {
    const data = repo?.dataOf(site);
    if (data) {
      if (/(telefono|teléfono|whatsapp|celular|contacto)/.test(n) && data.phone) {
        return `El teléfono de contacto de ${data.name} es ${data.phone}.`;
      }
      if (/(horario|horarios|abre|cierra|atiende)/.test(n) && data.hours) {
        return `El horario de atención de ${data.name} es ${data.hours}.`;
      }
      if (/(direccion|dirección|ubicacion|ubicación|donde est|dónde est)/.test(n) && data.address) {
        return `Estamos en ${data.address}.`;
      }
      if (/(que venden|qué venden|servicios|menu|menú|que ofrecen|qué ofrecen)/.test(n)) {
        const items = data.services.length ? data.services.join(', ') : '—';
        return `En ${data.name} ofrecemos: ${items}.`;
      }
      // Respuesta genérica con datos del sitio (sin inventar).
      return `${data.name} — ${data.line}. ${data.about}`;
    }
  }

  // Capacidad conocida o genérica, sin datos en BD.
  if (classification.capabilityTarget === 'website') {
    return 'Esta es la información que tengo disponible de tu página web. Puedo ayudarte a ver o actualizar el teléfono, el horario, la dirección, los servicios o el nombre del negocio.';
  }
  return 'Puedo ayudarte con tu página web: consultar información, pedir cambios (teléfono, horario, dirección, servicios, secciones) y preparar vistas previas para tu aprobación. Las redes sociales aún no están disponibles.';
}
