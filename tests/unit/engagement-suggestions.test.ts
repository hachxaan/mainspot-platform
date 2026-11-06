/**
 * Unit — DEC-0078 R2 (FB-2): filtros deterministas antes de gastar IA sin que nadie la pida. Un comentario sin letras ni
 * números, hecho solo de menciones o etiquetas, o con un enlace (con esquema, `www.` o un dominio habitual sin esquema)
 * no se redacta solo; cualquier comentario con texto propio (también preguntas cortas, calificaciones con números o un
 * punto sin espacio entre frases) sí. Revisión independiente, pasada 1, F-04: los dos sentidos.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textRelevance } from '../../src/engagement/suggestions.ts';

test('sin texto propio, solo menciones/etiquetas o con enlaces ⇒ no amerita gasto automático', () => {
  for (const [body, reason] of [
    ['😍🔥🙌', 'no_text'], ['!!! ...', 'no_text'], ['   ', 'no_text'],
    ['@ana_lopez @luis.p', 'mention_only'], ['#promo #pan', 'mention_only'], ['@ana 😍', 'mention_only'],
    ['Gana dinero aquí https://spam.example/x', 'link'], ['HTTP://SPAM.EXAMPLE', 'link'], ['visita www.ofertas.example', 'link'],
    ['Promo!!!www.spam.example', 'link'], ['mira bit.ly/abc123', 'link'], ['Gana dinero en …ganafacil.com', 'link'],
    ['Info en wa.me', 'link'], ['Únete: t.me/canal', 'link'], ['compra en tienda.com.mx hoy', 'link'], ['😍ganafacil.com', 'link'],
  ] as const) {
    assert.equal(textRelevance(body), reason, body);
  }
});

test('con texto propio sí amerita, aunque sea corto, lleve una mención, números o un punto sin espacio entre frases', () => {
  for (const body of ['¿Abren el domingo?', 'Gracias', '10/10', 'Hola @ana, ¿vienes mañana?', 'Muy rico.Gracias', 'Excelente   servicio',
    'Excelente servicio.Calidad/precio insuperable', 'Excelente atención.Me encantó', 'Lo mejor.Es muy rico', 'Precio 3.50 por pieza',
    'Escríbeme a ana@correo.com']) {
    assert.equal(textRelevance(body), null, body);
  }
});
