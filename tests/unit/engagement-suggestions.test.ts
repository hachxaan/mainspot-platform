/**
 * Unit — DEC-0078 R2 (FB-2): filtros deterministas antes de gastar IA sin que nadie la pida. Un comentario sin letras ni
 * números, hecho solo de menciones o etiquetas, o con un enlace no se redacta solo; cualquier comentario con texto
 * propio (también preguntas cortas o calificaciones con números) sí.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textRelevance } from '../../src/engagement/suggestions.ts';

test('sin texto propio, solo menciones/etiquetas o con enlaces ⇒ no amerita gasto automático', () => {
  for (const [body, reason] of [
    ['😍🔥🙌', 'no_text'], ['!!! ...', 'no_text'], ['   ', 'no_text'],
    ['@ana_lopez @luis.p', 'mention_only'], ['#promo #pan', 'mention_only'], ['@ana 😍', 'mention_only'],
    ['Gana dinero aquí https://spam.example/x', 'link'], ['visita www.ofertas.example', 'link'], ['mira bit.ly/abc123', 'link'],
  ] as const) {
    assert.equal(textRelevance(body), reason, body);
  }
});

test('con texto propio sí amerita, aunque sea corto, lleve una mención o números', () => {
  for (const body of ['¿Abren el domingo?', 'Gracias', '10/10', 'Hola @ana, ¿vienes mañana?', 'Muy rico.Gracias', 'Excelente   servicio', 'café.com es mi favorito']) {
    assert.equal(textRelevance(body), null, body);
  }
});
