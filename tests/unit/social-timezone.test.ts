import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wallTimeToUtc, formatInZone, nextWeeklySlot } from '../../src/social/timezone.ts';

test('programación interpreta la hora en la zona elegida y preserva el día al cruzar UTC', () => {
  const at = wallTimeToUtc('2027-01-15T23:30', 'America/Cancun');
  assert.equal(at?.toISOString(), '2027-01-16T04:30:00.000Z');
  assert.equal(formatInZone(at!, 'America/Cancun'), '2027-01-15 23:30');
  assert.equal(wallTimeToUtc('2027-01-15T23:30', 'Asia/Kolkata')?.toISOString(), '2027-01-15T18:00:00.000Z');
});

test('fechas imposibles no se normalizan; distingue febrero bisiesto y límites de reloj', () => {
  for (const wall of ['2027-02-31T10:00', '2027-02-29T10:00', '2028-04-31T10:00', '2028-01-01T24:00', '2028-01-01T12:60']) {
    assert.equal(wallTimeToUtc(wall, 'America/Cancun'), null, wall);
  }
  assert.equal(wallTimeToUtc('2028-02-29T10:00', 'America/Cancun')?.toISOString(), '2028-02-29T15:00:00.000Z');
});

test('hora inexistente o repetida por DST requiere elegir otra, no una publicación desplazada', () => {
  assert.equal(wallTimeToUtc('2027-03-14T02:30', 'America/New_York'), null);
  assert.equal(wallTimeToUtc('2027-11-07T01:30', 'America/New_York'), null);
  assert.equal(wallTimeToUtc('2027-03-14T03:30', 'America/New_York')?.toISOString(), '2027-03-14T07:30:00.000Z');
  assert.equal(wallTimeToUtc('2027-11-07T02:30', 'America/New_York')?.toISOString(), '2027-11-07T07:30:00.000Z');
});

test('la franja sugerida es la próxima ocurrencia en la zona del negocio (hoy si aún llega, si no la semana siguiente)', () => {
  const tz = 'America/Cancun';
  // Viernes 15 ene 2027, 17:00 en Cancún: la franja «vie 18:00» es hoy.
  const today = nextWeeklySlot('fri', 18, tz, wallTimeToUtc('2027-01-15T17:00', tz)!);
  assert.deepEqual([today?.local, today?.at.toISOString(), today?.label], ['2027-01-15T18:00', '2027-01-15T23:00:00.000Z', 'vie 15 ene, 18:00']);
  // A menos del margen (15 min) o ya pasada: la del viernes siguiente.
  assert.equal(nextWeeklySlot('fri', 18, tz, wallTimeToUtc('2027-01-15T17:50', tz)!)?.local, '2027-01-22T18:00');
  assert.equal(nextWeeklySlot('fri', 18, tz, wallTimeToUtc('2027-01-15T19:00', tz)!)?.local, '2027-01-22T18:00');
  // El día en la zona del negocio manda aunque en UTC ya sea sábado.
  assert.equal(nextWeeklySlot('sat', 9, tz, wallTimeToUtc('2027-01-15T22:00', tz)!)?.local, '2027-01-16T09:00');
  assert.equal(nextWeeklySlot('funday', 9, tz), null);
  assert.equal(nextWeeklySlot('mon', 25, tz), null);
});
