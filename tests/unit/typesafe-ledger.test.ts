/**
 * DEC-0032 (TS-1) — contrato de medición y entradas del libro de TypeSafe, sin BD: lo que se confirma tras una
 * respuesta válida y lo que se rechaza antes de reservar. La reserva atómica se prueba con PostgreSQL real en
 * tests/integration/typesafe-ledger.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { measuredCost, TypeSafeLedger, typesafeDailyLimitUsd } from '../../src/ai/typesafe-ledger.ts';
import { JEV_MAX_DAILY_BUDGET_USD } from '../../src/shared/config.ts';

test('DEC-0032/TS-1 unit: reported or estimated cost is committed as measured; without one (or from the simulator) it is unknown, never free', () => {
  assert.deepEqual(measuredCost({ cost: { amount: 0.00003, source: 'reported' }, attempts: 1 }), { costUsd: 0.00003, costSource: 'reported', attempts: 1 });
  assert.deepEqual(measuredCost({ cost: { amount: 0.0000252, source: 'estimated' }, attempts: 2 }), { costUsd: 0.0000252, costSource: 'estimated', attempts: 2 });
  assert.deepEqual(measuredCost({ cost: { amount: null, source: 'unknown' }, attempts: 1 }), { costUsd: null, costSource: 'unknown', attempts: 1 });
  assert.deepEqual(measuredCost({ cost: { amount: 0, source: 'mock' }, attempts: 1 }), { costUsd: null, costSource: 'unknown', attempts: 1 },
    'a mock cost of 0 never settles a TypeSafe reservation as free');
});

test('DEC-0032 unit: the daily limit keeps the approved rule (USD 1 with Jev disabled, otherwise JEV_DAILY_BUDGET_USD)', () => {
  assert.equal(typesafeDailyLimitUsd({ mode: 'disabled' }), JEV_MAX_DAILY_BUDGET_USD);
  assert.equal(JEV_MAX_DAILY_BUDGET_USD, 1);
  assert.equal(typesafeDailyLimitUsd({
    mode: 'shadow', provider: 'typesafe', apiKey: 'ts-fake', model: null, dataScope: 'synthetic', syntheticTenants: [], dailyBudgetUsd: 0.4,
  }), 0.4);
});

test('DEC-0032/TS-1 unit: malformed reservations and an unusable limit are refused before touching the database', async () => {
  let connections = 0;
  const pool = { connect: async () => { connections += 1; throw new Error('no database in unit tests'); } } as unknown as Pool;
  const ledger = (limit: number) => new TypeSafeLedger({ pool, dailyLimitUsd: () => limit });
  const ok = { key: 'pipeline:req_1', source: 'pipeline' as const, useCaseId: null, reserveUsd: 0.01 };
  for (const [label, input, limit] of [
    ['key of another source', { ...ok, key: 'evaluation:run:1' }, 1],
    ['key outside the pattern', { ...ok, key: 'pipeline:req 1' }, 1],
    ['use case outside the AI Core', { ...ok, useCaseId: 'conversation.intent.classify' }, 1],
    ['AI Core without use case', { ...ok, key: 'ai_invocation:inv_1', source: 'ai_core' as const }, 1],
    ['zero amount', { ...ok, reserveUsd: 0 }, 1],
    ['NaN amount', { ...ok, reserveUsd: Number.NaN }, 1],
    ['NaN limit (would allow everything)', ok, Number.NaN],
    ['negative limit', ok, -1],
  ] as const) {
    await assert.rejects(ledger(limit).reserve(input), /FAIL-CLOSED/, label);
  }
  assert.equal(connections, 0, 'no reservation was attempted');
});
