/**
 * Unit — INC-007 base analytics: CSV determinista, paginación y cutoff de
 * retención (DEC-025, default 90 días, DRY-RUN seguro).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvEscape, rowsToCsv, normalizePagination, EXPORT_COLUMNS } from '../../src/analytics/export.ts';
import { retentionCutoff } from '../../src/analytics/retention.ts';

test('analytics: CSV escape RFC4180 básico (comas, comillas, saltos)', () => {
  assert.equal(csvEscape('simple'), 'simple');
  assert.equal(csvEscape('con, coma'), '"con, coma"');
  assert.equal(csvEscape('con "comilla"'), '"con ""comilla"""');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
});

test('analytics: rowsToCsv con header estable y sin valores descartados', () => {
  const rows = [{ event_id: 'e1', ts: '2026-08-20T00:00:00Z', action: 'data.read', result: 'success' }];
  const csv = rowsToCsv(rows);
  assert.ok(csv.startsWith(EXPORT_COLUMNS.join(',')));
  assert.ok(csv.includes('e1'));
  assert.ok(csv.includes('data.read'));
  const lines = csv.split('\n');
  assert.equal(lines.length, 2, 'header + 1 fila');
});

test('analytics: paginación normalizada (page>=1, pageSize 1..100)', () => {
  const p1 = normalizePagination({ page: 1, pageSize: 50 });
  assert.deepEqual(p1, { page: 1, pageSize: 50, offset: 0 });
  const p2 = normalizePagination({ page: 3, pageSize: 10 });
  assert.deepEqual(p2, { page: 3, pageSize: 10, offset: 20 });
  // Valores fuera de rango se acotan (fail-safe).
  assert.equal(normalizePagination({ page: 0, pageSize: 0 }).page, 1);
  assert.equal(normalizePagination({ pageSize: 0 }).pageSize, 1);
  assert.equal(normalizePagination({ pageSize: 5000 }).pageSize, 100);
});

test('analytics: cutoff de retención configurable (default 90 días)', () => {
  const now = new Date('2026-08-20T12:00:00Z');
  const cutoff = retentionCutoff(90, now);
  const expected = new Date('2026-05-22T12:00:00Z');
  assert.equal(cutoff.getTime(), expected.getTime());
  const c30 = retentionCutoff(30, now);
  const expected30 = new Date('2026-07-21T12:00:00Z');
  assert.equal(c30.getTime(), expected30.getTime());
});
