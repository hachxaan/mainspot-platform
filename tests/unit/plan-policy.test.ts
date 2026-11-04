/**
 * Unit — política efectiva de planes (DEC-0075, SRC-0013): ciclo mensual UTC anclado al inicio de la
 * suscripción y sin deriva, valor efectivo acotado SOLO por el techo de sistema (nunca una concesión que
 * no esté publicada), validación tipada de valores, comprobación pura de límites y huella canónica de
 * una revisión. Sin BD ni red.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisionChecksum } from '../../src/plans/catalog.ts';
import { effectiveValue, fitsLimit, monthlyCycle } from '../../src/plans/policy.ts';
import { PLAN_PARAMETERS, validateValue, type ParameterValue, type PlanParameterDefinition } from '../../src/plans/registry.ts';

/** Ciclo que contiene `now` para el ancla dada, como par de instantes ISO. */
function cycle(anchor: string, now: string): [string, string] {
  const c = monthlyCycle(new Date(anchor), new Date(now));
  return [c.start.toISOString(), c.end.toISOString()];
}

function registryDefinition(key: string): PlanParameterDefinition {
  const def = PLAN_PARAMETERS.find((d) => d.key === key);
  assert.ok(def, key);
  return def;
}

const website = registryDefinition('quota.website.max');
const posts = registryDefinition('quota.social_posts.max');
const flag: PlanParameterDefinition = {
  key: 'test.feature.enabled', capability: null, category: 'Pruebas', label: 'Función de prueba', description: 'Elegibilidad de prueba.',
  unit: 'función', valueType: 'bool', semantics: 'eligibility', period: { kind: 'none' }, min: 0, max: 1, ceilingReason: 'Prueba.',
  suggested: false, suggestedReason: 'Prueba.', enforcement: { state: 'enforced', points: [], note: 'Prueba.' }, usageSql: null, sortOrder: 1,
};

const withValues = (entries: Array<[string, ParameterValue]>) => ({ values: new Map(entries) });

// ------------------------------------------------------------------ monthlyCycle

test('monthlyCycle: ancla 31-ene → 28-feb → 31-mar, siempre desde el ancla original (sin deriva)', () => {
  const anchor = '2026-01-31T10:00:00.000Z';
  assert.deepEqual(cycle(anchor, '2026-02-10T00:00:00.000Z'), ['2026-01-31T10:00:00.000Z', '2026-02-28T10:00:00.000Z']);
  assert.deepEqual(cycle(anchor, '2026-03-05T00:00:00.000Z'), ['2026-02-28T10:00:00.000Z', '2026-03-31T10:00:00.000Z']);
  assert.deepEqual(cycle(anchor, '2026-04-15T00:00:00.000Z'), ['2026-03-31T10:00:00.000Z', '2026-04-30T10:00:00.000Z']);

  // Recorrer un año encadenando ciclos: el 28 de febrero no arrastra el día 28 a los meses siguientes.
  const starts: string[] = [];
  let now = new Date(anchor);
  for (let i = 0; i < 13; i += 1) {
    const c = monthlyCycle(new Date(anchor), now);
    starts.push(c.start.toISOString());
    now = c.end;
  }
  assert.deepEqual(starts.map((s) => s.slice(0, 10)), [
    '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31',
    '2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31',
  ]);
  assert.ok(starts.every((s) => s.endsWith('T10:00:00.000Z')), 'la hora del ancla se conserva');
});

test('monthlyCycle: años bisiestos (29-feb) y ancla en 29-feb sin deriva', () => {
  assert.deepEqual(cycle('2028-01-31T00:00:00.000Z', '2028-03-01T00:00:00.000Z'), ['2028-02-29T00:00:00.000Z', '2028-03-31T00:00:00.000Z']);
  assert.deepEqual(cycle('2027-01-31T00:00:00.000Z', '2027-03-01T00:00:00.000Z'), ['2027-02-28T00:00:00.000Z', '2027-03-31T00:00:00.000Z']);
  // Ancla 29-feb: 28-feb en años comunes, de vuelta al 29 en marzo y en el siguiente bisiesto.
  assert.deepEqual(cycle('2028-02-29T12:00:00.000Z', '2029-02-28T12:00:00.000Z'), ['2029-02-28T12:00:00.000Z', '2029-03-29T12:00:00.000Z']);
  assert.deepEqual(cycle('2028-02-29T12:00:00.000Z', '2032-03-01T00:00:00.000Z'), ['2032-02-29T12:00:00.000Z', '2032-03-29T12:00:00.000Z']);
});

test('monthlyCycle: el instante exacto de la frontera pertenece al ciclo nuevo', () => {
  const anchor = '2026-01-31T10:00:00.000Z';
  assert.deepEqual(cycle(anchor, anchor), [anchor, '2026-02-28T10:00:00.000Z'], 'el ancla abre el primer ciclo');
  assert.deepEqual(cycle(anchor, '2026-02-28T09:59:59.999Z'), [anchor, '2026-02-28T10:00:00.000Z']);
  assert.deepEqual(cycle(anchor, '2026-02-28T10:00:00.000Z'), ['2026-02-28T10:00:00.000Z', '2026-03-31T10:00:00.000Z']);
  assert.deepEqual(cycle(anchor, '2026-03-31T09:59:59.999Z'), ['2026-02-28T10:00:00.000Z', '2026-03-31T10:00:00.000Z']);
  assert.deepEqual(cycle(anchor, '2026-03-31T10:00:00.000Z'), ['2026-03-31T10:00:00.000Z', '2026-04-30T10:00:00.000Z']);
});

test('monthlyCycle: un now anterior al ancla devuelve el primer ciclo', () => {
  const first: [string, string] = ['2026-05-20T08:00:00.000Z', '2026-06-20T08:00:00.000Z'];
  assert.deepEqual(cycle(first[0], '2026-05-20T07:59:59.999Z'), first, 'mismo día, antes de la hora del ancla');
  assert.deepEqual(cycle(first[0], '2026-05-01T00:00:00.000Z'), first, 'mismo mes');
  assert.deepEqual(cycle(first[0], '2025-12-31T23:59:59.999Z'), first, 'año anterior');
});

test('monthlyCycle: ciclos contiguos que contienen a now, con día del ancla acotado al mes y su misma hora', () => {
  const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  let checked = 0;
  for (let m = 0; m < 24; m += 1) {
    for (const day of [1, 15, 28, 29, 30, 31]) {
      const year = 2027 + Math.floor(m / 12);
      const month = m % 12;
      if (day > daysIn(year, month)) continue;
      const anchor = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
      for (let step = 0; step < 260; step += 1) {
        const now = new Date(anchor.getTime() + step * (3 * 86_400_000 + 7 * 3_600_000 + 13_000));
        const c = monthlyCycle(anchor, now);
        assert.ok(c.start.getTime() <= now.getTime() && now.getTime() < c.end.getTime(), `${anchor.toISOString()} @ ${now.toISOString()}`);
        const expectedDay = Math.min(day, daysIn(c.start.getUTCFullYear(), c.start.getUTCMonth()));
        assert.equal(c.start.getUTCDate(), expectedDay, `día acotado ${anchor.toISOString()} @ ${now.toISOString()}`);
        assert.equal(c.start.toISOString().slice(10), anchor.toISOString().slice(10), 'misma hora UTC que el ancla');
        const monthsApart = (c.end.getUTCFullYear() - c.start.getUTCFullYear()) * 12 + c.end.getUTCMonth() - c.start.getUTCMonth();
        assert.equal(monthsApart, 1, 'cada ciclo dura un mes de calendario');
        assert.equal(monthlyCycle(anchor, c.end).start.getTime(), c.end.getTime(), 'el fin de un ciclo es el inicio del siguiente');
        checked += 1;
      }
    }
  }
  assert.ok(checked > 30_000, `casos comprobados: ${checked}`);
});

test('monthlyCycle: no depende de la zona horaria del proceso (sin efectos de DST)', () => {
  const cases: Array<[string, string]> = [
    ['2026-03-29T01:30:00.000Z', '2026-10-25T01:30:00.000Z'], // cambios de hora en Europa
    ['2026-01-31T23:30:00.000Z', '2026-02-28T23:29:59.999Z'],
    ['2026-04-05T02:30:00.000Z', '2026-09-27T14:00:00.000Z'], // cambios de hora en el hemisferio sur
    ['2028-02-29T00:15:00.000Z', '2029-02-28T00:15:00.000Z'],
  ];
  const zones = ['UTC', 'Europe/Madrid', 'America/Mexico_City', 'America/Santiago', 'Pacific/Auckland'];
  const original = process.env.TZ;
  const results: string[][][] = [];
  const offsets = new Set<number>();
  try {
    for (const tz of zones) {
      process.env.TZ = tz;
      offsets.add(new Date('2026-07-01T00:00:00.000Z').getTimezoneOffset());
      results.push(cases.map(([anchor, now]) => cycle(anchor, now)));
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
  assert.ok(offsets.size > 1, 'la zona horaria del proceso cambió de verdad durante la prueba');
  for (const r of results) assert.deepEqual(r, results[0]);
});

// ------------------------------------------------------------------ effectiveValue

test('effectiveValue: aplica el valor publicado y solo lo acota al techo de sistema', () => {
  assert.deepEqual(effectiveValue(withValues([[posts.key, 10]]), posts), { value: 10, cappedBySystem: false });
  assert.deepEqual(effectiveValue(withValues([[posts.key, 0]]), posts), { value: 0, cappedBySystem: false }, '0 = sin cupo, nunca «ilimitado»');
  assert.deepEqual(effectiveValue(withValues([[posts.key, posts.max]]), posts), { value: posts.max, cappedBySystem: false });
  assert.deepEqual(effectiveValue(withValues([[posts.key, posts.max + 1]]), posts), { value: posts.max, cappedBySystem: true });
  assert.deepEqual(effectiveValue(withValues([[website.key, 3]]), website), { value: 1, cappedBySystem: true }, 'techo técnico de una página');
});

test('effectiveValue: nunca eleva un valor publicado (un mínimo vigente mayor no concede unidades)', () => {
  // El registro sube el mínimo después de publicar: la revisión publicada con 0 sigue sin conceder nada.
  const raisedFloor: PlanParameterDefinition = { ...posts, min: 1 };
  assert.deepEqual(effectiveValue(withValues([[posts.key, 0]]), raisedFloor), { value: 0, cappedBySystem: false });
  assert.deepEqual(effectiveValue(withValues([[posts.key, 5]]), raisedFloor), { value: 5, cappedBySystem: false });
});

test('effectiveValue: ausente o de tipo incorrecto ⇒ null (el llamador deniega)', () => {
  assert.equal(effectiveValue(withValues([]), posts), null);
  assert.equal(effectiveValue(withValues([[website.key, 1]]), posts), null, 'el valor de otra clave no sirve');
  assert.equal(effectiveValue(withValues([[posts.key, true]]), posts), null);
  assert.equal(effectiveValue(withValues([[posts.key, 1.5]]), posts), null);
  assert.equal(effectiveValue(withValues([[posts.key, Number.NaN]]), posts), null);
  assert.equal(effectiveValue(withValues([[posts.key, Number.POSITIVE_INFINITY]]), posts), null);
  assert.equal(effectiveValue(withValues([]), flag), null);
  assert.equal(effectiveValue(withValues([[flag.key, 1]]), flag), null);
  assert.equal(effectiveValue(withValues([[flag.key, 0]]), flag), null);
  assert.deepEqual(effectiveValue(withValues([[flag.key, true]]), flag), { value: true, cappedBySystem: false });
  assert.deepEqual(effectiveValue(withValues([[flag.key, false]]), flag), { value: false, cappedBySystem: false });
});

// ------------------------------------------------------------------ validateValue

test('validateValue: enteros dentro del rango del registro, sin conversiones de tipo', () => {
  for (const ok of [0, 1, 500, posts.max]) assert.equal(validateValue(posts, ok), null, String(ok));
  const invalid: unknown[] = [-1, posts.max + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10', true, null, undefined, [], {}];
  for (const bad of invalid) assert.equal(typeof validateValue(posts, bad), 'string', `rechaza ${String(bad)}`);
  assert.equal(validateValue(website, 1), null);
  assert.equal(typeof validateValue(website, 2), 'string', 'website no supera su techo técnico');
});

test('validateValue: booleanos solo true/false', () => {
  assert.equal(validateValue(flag, true), null);
  assert.equal(validateValue(flag, false), null);
  for (const bad of [0, 1, 'true', 'false', null, undefined]) assert.equal(typeof validateValue(flag, bad), 'string', `rechaza ${String(bad)}`);
});

test('validateValue: cada parámetro del registro admite su sugerencia y sus extremos, y nada fuera de ellos', () => {
  for (const def of PLAN_PARAMETERS) {
    assert.equal(validateValue(def, def.suggested), null, `${def.key} sugerido`);
    assert.equal(validateValue(def, def.min), null, `${def.key} mínimo`);
    assert.equal(validateValue(def, def.max), null, `${def.key} techo`);
    assert.equal(typeof validateValue(def, def.min - 1), 'string', `${def.key} bajo el mínimo`);
    assert.equal(typeof validateValue(def, def.max + 1), 'string', `${def.key} sobre el techo`);
  }
});

// ------------------------------------------------------------------ fitsLimit

test('fitsLimit: con límite K caben exactamente K unidades, una a una o en un lote completo', () => {
  for (const limit of [0, 1, 3, 10]) {
    let usage = 0;
    while (fitsLimit(limit, usage)) usage += 1;
    assert.equal(usage, limit, `límite ${limit}`);
    assert.equal(fitsLimit(limit, 0, limit + 1), false, 'un lote que se pasa se rechaza entero');
    if (limit > 0) assert.equal(fitsLimit(limit, 0, limit), true, 'un lote que llega justo al límite cabe');
  }
  assert.equal(fitsLimit(3, 5), false, 'uso ya por encima del límite (downgrade) no admite más');
  for (const usage of [0, 1, 1000]) assert.equal(fitsLimit(null, usage), false, 'sin límite nunca cabe nada (fail-closed)');
});

// ------------------------------------------------------------------ revisionChecksum

test('revisionChecksum: determinista, independiente del orden y sensible a cada clave y valor', () => {
  const entries: Array<[string, ParameterValue]> = PLAN_PARAMETERS.map((d, i) => [d.key, i * 7]);
  entries.push([flag.key, true], ['test.a_b.max', 1], ['test.ab.max', 2], ['test.a.max', 3]);
  const base = revisionChecksum(new Map(entries));
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(revisionChecksum(new Map(entries)), base, 'determinista');
  for (let r = 1; r < entries.length; r += 1) {
    assert.equal(revisionChecksum(new Map([...entries.slice(r), ...entries.slice(0, r)])), base, `rotación ${r}`);
  }
  assert.equal(revisionChecksum(new Map([...entries].reverse())), base, 'orden inverso');

  const seen = new Set([base]);
  for (const [key, value] of entries) {
    const changed = new Map(entries);
    changed.set(key, typeof value === 'boolean' ? !value : value + 1);
    seen.add(revisionChecksum(changed));
    const removed = new Map(entries);
    removed.delete(key);
    seen.add(revisionChecksum(removed));
  }
  assert.equal(seen.size, 1 + 2 * entries.length, 'cada cambio de valor o ausencia cambia la huella');
  assert.notEqual(revisionChecksum(new Map([[flag.key, true]])), revisionChecksum(new Map([[flag.key, 1]])), 'true ≠ 1');
});
