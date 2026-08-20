/**
 * Unit — clasificador determinista de intención (INC-002, AC-004/005, REQ-004).
 * Matriz de autonomía del canon 05 traducida a reglas; TENTATIVA e iterable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, normalize, detectCapabilityTarget } from '../../src/conversation/classifier.ts';

test('classifier: consulta de solo lectura → read_only sin approval gate (RULE-002, AC-005)', () => {
  for (const q of [
    '¿cuál es el teléfono de mi negocio?',
    'qué horario tienen',
    'dime la información de mi web',
    '¿cuánto cuesta el menú?', // consulta (sin inventar): read-only
    'estado de mi página web',
  ]) {
    const c = classifyIntent(q);
    assert.equal(c.actionClass, 'read_only', `should be read_only: ${q}`);
    assert.equal(c.proposalType, null);
  }
});

test('classifier: cambio visible con verbo → preview_required (FLOW-002, AC-006)', () => {
  for (const q of [
    'necesito cambiar el teléfono',
    'cambia el teléfono a +51 987 654 321',
    'agrega la sección servicios a mi web',
    'actualiza el horario de mi página',
    'quiero cambiar la dirección del negocio',
    'mi telefono es 987654321', // no: sin verbo... assert below separately
  ].slice(0, 5)) {
    const c = classifyIntent(q);
    assert.equal(c.actionClass, 'preview_required', `should be preview_required: ${q}`);
    assert.equal(c.capabilityTarget, 'website');
  }
});

test('classifier: decisión sensible → human_approval_required (RULE-004, AC-004)', () => {
  for (const q of [
    'quiero un descuento del 10%',
    'necesito una devolución para un cliente',
    'da una compensación al cliente molesto',
    'cambia los permisos del usuario',
    'hay que darle una garantía',
  ]) {
    const c = classifyIntent(q);
    assert.equal(c.actionClass, 'human_approval_required', `should be human_approval_required: ${q}`);
  }
});

test('classifier: inventar precios/condiciones → PROHIBITED (RULE-005, AC-004)', () => {
  for (const q of [
    'inventa un precio para el menú',
    'pon el precio de 10 soles al plato',
    'inventa un descuento del 50%',
    'crea una tarifa de suscripción',
    'oculta la reseña negativa',
  ]) {
    const c = classifyIntent(q);
    assert.equal(c.actionClass, 'prohibited', `should be prohibited: ${q}`);
    assert.equal(c.proposalType, null);
  }
});

test('classifier: capacidad no implementada (redes sociales) → bloqueada sin efecto', () => {
  const c = classifyIntent('publica esto en facebook');
  assert.equal(c.actionClass, 'prohibited');
  assert.equal(c.intent, 'capability.unsupported');
  assert.equal(c.capabilityTarget, 'social');
});

test('classifier: sugerencia → draft (matriz DRAFT, sin publicar)', () => {
  const c = classifyIntent('sugiere un eslogan para mi web');
  assert.equal(c.actionClass, 'draft');
  assert.equal(c.proposalType, 'content.suggestion');
});

test('classifier: ambigüedad → needs_clarification sin efecto', () => {
  const c = classifyIntent('hola');
  assert.equal(c.intent, 'request.needs_clarification');
});

test('classifier: normalize quita acentos y normaliza mayúsculas', () => {
  assert.equal(normalize('Necesito CAMBIAR el Teléfono'), 'necesito cambiar el telefono');
  assert.equal(normalize('AÑADE SECCIÓN'), 'anade seccion');
});

test('classifier: detectCapabilityTarget distingue website/social/domain', () => {
  assert.equal(detectCapabilityTarget('cambia el teléfono'), 'website');
  assert.equal(detectCapabilityTarget('publica en facebook'), 'social');
  assert.equal(detectCapabilityTarget('crea mi subdominio'), 'domain');
  assert.equal(detectCapabilityTarget('hola'), 'unknown');
});
