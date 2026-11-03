/**
 * Minimización razonable antes de enviar texto de terceros (comentarios, reseñas) a un proveedor de IA
 * (DEC-0067, DEC-0071; condiciones de docs/architecture/ai-providers-data-terms.md §4): los datos de
 * contacto que un cliente escribe en su mensaje no hacen falta para clasificarlo ni para responderle, y
 * TypeSafe no publica plazo de retención. Se sustituyen por marcadores neutros; el resto del texto queda igual.
 */

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
/** Tarjetas (13-19 dígitos con separadores opcionales) antes que teléfonos para no partirlas. */
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
/** Secuencia con forma de teléfono; cuenta como tal si suma 10 o más dígitos (México usa 10; fechas y horas no llegan). */
const PHONE_LIKE = /\+?\(?\d[\d\s().-]{7,}\d/g;

export function redactContactData(text: string): string {
  return text
    .replace(EMAIL, '[correo]')
    .replace(CARD, '[número]')
    .replace(PHONE_LIKE, (m) => (m.replace(/\D/g, '').length >= 10 ? '[teléfono]' : m));
}
