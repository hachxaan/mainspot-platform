/**
 * Unit — plantilla de sitio y editor asistido (INC-003, REQ-012).
 * Render determinista + XSS-safe + diff conceptual legible (AC-006).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_WEBSITE, normalizeWebsiteData, renderSite, esc } from '../../src/website/template.ts';
import { editWebsiteByInstruction } from '../../src/website/edit-mapper.ts';

const BASE = {
  ...EMPTY_WEBSITE,
  name: 'Restaurante El Sol',
  line: 'Restaurante de comida peruana',
  about: 'Cocina familiar.',
  phone: '+51 999 111 222',
  email: 'a@example.com',
  address: 'Av. Central 123',
  hours: 'Lun a Sáb 9:00-18:00',
  services: ['Lomo saltado'],
};

test('website: render es determinista y contiene los datos del negocio', () => {
  const html = renderSite(BASE, { version: 2 });
  assert.ok(html.includes('Restaurante El Sol'));
  assert.ok(html.includes('+51 999 111 222'));
  assert.ok(html.includes('Lun a Sáb 9:00-18:00'));
  assert.ok(html.includes('Lomo saltado'));
  assert.ok(html.includes('versión 2'));
  const again = renderSite(BASE, { version: 2 });
  assert.equal(html, again, 'misma data ⇒ mismo HTML (determinista)');
});

test('website: render escapa contenido del negocio (XSS-safe, NFR-003)', () => {
  const evil = normalizeWebsiteData({
    name: '<script>alert(1)</script>',
    line: '"onmouseover"',
    about: "'; DROP TABLE--",
    services: ['<img src=x onerror=alert(2)>'],
  });
  const html = renderSite(evil);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'no raw script tag');
  assert.ok(html.includes('&lt;script&gt;'), 'escaped script');
  assert.equal(esc('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
});

test('website: normalizeWebsiteData con valores raros no rompe (defaults seguros)', () => {
  const d = normalizeWebsiteData(null);
  assert.equal(d.name, 'Mi negocio');
  assert.deepEqual(d.services, []);
  const d2 = normalizeWebsiteData({ name: 42, services: ['a', 2, 'b'], sections: [{ title: 's', content: 'c' }] });
  assert.equal(d2.name, 'Mi negocio');
  assert.deepEqual(d2.services, ['a', 'b']);
});

test('edit-mapper: "cambia el teléfono a +51 987 654 321" produce parche de contacto', () => {
  const r = editWebsiteByInstruction(BASE, 'necesito cambiar el teléfono a +51 987 654 321');
  assert.equal(r.patches.length, 1);
  assert.equal(r.patches[0]?.field, 'contact.phone');
  assert.equal(r.patches[0]?.kind, 'change');
  assert.equal(r.after.phone, '+51 987 654 321');
  assert.ok(r.sentences[0]?.includes('+51 987 654 321'), 'diff conceptual incluye el nuevo valor (AC-006)');
});

test('edit-mapper: "agrega la sección servicios" agrega sección sin duplicar', () => {
  const r = editWebsiteByInstruction(BASE, 'agrega la sección servicios');
  assert.equal(r.patches[0]?.field, 'section.add');
  assert.equal(r.after.sections.length, 1);
  const r2 = editWebsiteByInstruction({ ...BASE, sections: r.after.sections }, 'agrega la sección servicios');
  assert.equal(r2.after.sections.length, 1, 'idempotente: no duplica la sección');
});

test('edit-mapper: "agrega un servicio llamado Café de especialidad" agrega ítem', () => {
  const r = editWebsiteByInstruction(BASE, 'agrega un servicio llamado Café de especialidad');
  assert.equal(r.after.services.includes('Café de especialidad'), true);
});

test('edit-mapper: cambio genérico produce diff claro (default determinista)', () => {
  const r = editWebsiteByInstruction(BASE, 'actualiza mi página web');
  assert.equal(r.patches[0]?.field, 'site.generic');
});
