/**
 * AC-TS01 (DEC-0032; DEC-0078, TS-1) — libro de TypeSafe con PostgreSQL real y TypeSafe FALSO: `fetch` interceptado en
 * todo el archivo; solo api.typesafe.ai responde (en memoria, con MockJev para las respuestas) y cualquier otra salida a
 * la red falla y queda registrada (el `after` exige cero). Nada de aquí acredita al proveedor real ni su facturación.
 *  - con un límite que deja sitio exactamente para 2 reservas, 4 reservas paralelas ⇒ 2 `reserved` y 2 denegadas; y 4
 *    clasificaciones paralelas del AI Core ⇒ 2 peticiones salen, 2 `budget_exhausted` sin petición;
 *  - confirmación con el costo informado; estimado sin `usage.cost`; con reintentos cuenta el mayor de costo y reserva;
 *  - fallo antes de enviar ⇒ liberada (no cuenta); HTTP 5xx o tiempo agotado tras enviar ⇒ cuenta la reserva;
 *  - caída: vencida sin enviar ⇒ liberada por el barrido (y nunca se envía); vencida enviada ⇒ `expired`, cuenta, y una
 *    confirmación tardía la sustituye por la medición;
 *  - misma clave: en curso, repetición sin nueva reserva, reutilización tras liberar (una reserva antigua no la cierra);
 *  - el simulado (MockJev) no reserva ni lo frena el tope agotado.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApi, type TestApi } from '../helpers/testdb.ts';
import { TYPESAFE_CALL_MAX_COST_USD as MAX } from '../../src/ai/catalog.ts';
import { AiDispatcher, type InvokeContext, type InvokeResult } from '../../src/ai/dispatcher.ts';
import { TypeSafeLedger, typesafeSpentOn, type TypeSafeHold, type TypeSafeReservation } from '../../src/ai/typesafe-ledger.ts';
import { MockJev } from '../../src/jev/mock.ts';
import type { Answer, SystemOneRequest } from '../../src/jev/types.ts';

type Classified = InvokeResult<{ answers: Record<string, Answer>; model: string }>;

const USE_CASE = 'engagement.facebook.comment.classify';
const STATE = { text: 'Me encantó el pastel, ¿hacen pedidos?' };
const ACTOR = 'test:typesafe-ledger';
const RUN = randomUUID().slice(0, 8);

let t: TestApi;
let typesafeRoute = '';
let simulatedRoute = '';
const createdRoutes: string[] = [];
const ledgerKeys: string[] = [];
const realFetch = globalThis.fetch;
const prevKey = process.env.TYPESAFE_API_KEY;
const leaked: string[] = [];

/** TypeSafe falso: cuenta las peticiones y responde con `respond` (por defecto 200 con costo informado). */
const typesafe = {
  calls: 0,
  respond: async (request: SystemOneRequest, _init?: RequestInit): Promise<Response> => answer(request, { cost: 0.00004 }),
};

function answer(request: SystemOneRequest, usage: { cost?: number; input_tokens?: number; output_tokens?: number }): Response {
  const mock = new MockJev().systemOne(request);
  return new Response(JSON.stringify({ ...mock, model: 'jev-1.14.0', usage: { ...mock.usage, ...usage } }), { status: 200 });
}

async function offlineFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  if (url.origin === 'https://api.typesafe.ai' && url.pathname === '/v1/systemone') {
    typesafe.calls += 1;
    return typesafe.respond(JSON.parse(String(init?.body)) as SystemOneRequest, init);
  }
  leaked.push(url.host);
  throw new TypeError(`salida de red bloqueada en la prueba: ${url.host}`);
}

async function route(modelId: string): Promise<string> {
  const prompt = (await t.pool.query<{ revision_id: string }>('SELECT revision_id FROM ai_prompt_revision WHERE use_case_id = $1 AND version = 1', [USE_CASE])).rows[0];
  assert.ok(prompt, `prompt v1 de ${USE_CASE}`);
  const r = await t.handle.dispatcher.registry.createRoute({ useCaseId: USE_CASE, modelId, promptRevisionId: prompt.revision_id, params: { timeout_ms: 15_000 },
    maxCostUsd: MAX, changeNote: 'Prueba AC-TS01: clasificación fijada', actor: ACTOR });
  createdRoutes.push(r.route_id);
  await t.pool.query(`UPDATE ai_route_revision SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE route_id = $1`, [r.route_id, ACTOR]);
  return r.route_id;
}

before(async () => {
  globalThis.fetch = offlineFetch;
  process.env.TYPESAFE_API_KEY = 'ts-fake-key-ac-ts01';
  t = await bootApi();
  typesafeRoute = await route('ts:jev-1.14.0');
  simulatedRoute = await route('sim:jev-mock');
});

after(async () => {
  try {
    if (t) {
      await t.pool.query('DELETE FROM typesafe_reservation WHERE idempotency_key = ANY($1)', [ledgerKeys]);
      await t.pool.query(`UPDATE ai_route_revision SET status = 'RETIRED' WHERE route_id = ANY($1)`, [createdRoutes]);
      t.handle.aiJobs.stop();
      await t.close();
    }
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = prevKey;
  }
  assert.deepEqual(leaked, [], 'ninguna petición salió a la red');
});

// ------------------------------------------------------------------ utilidades

const today = async () => (await t.pool.query<{ d: string }>(`SELECT (now() AT TIME ZONE 'UTC')::date::text AS d`)).rows[0]!.d;
const spentToday = async () => typesafeSpentOn(t.pool, await today());
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

/** Libro con un límite que deja sitio exactamente para `room` reservas del costo máximo sobre lo ya gastado hoy. */
async function ledgerWithRoom(room: number): Promise<{ ledger: TypeSafeLedger; base: number }> {
  const base = await spentToday();
  return { ledger: new TypeSafeLedger({ pool: t.pool, dailyLimitUsd: () => base + room * MAX }), base };
}

function key(label: string): string {
  const k = `pipeline:ts1-${RUN}-${label}`;
  ledgerKeys.push(k);
  return k;
}

function held(r: TypeSafeReservation): TypeSafeHold {
  assert.equal(r.status, 'reserved');
  if (r.status !== 'reserved') throw new Error('unreachable');
  return r.hold;
}

interface LedgerRow { status: string; reserved_usd: string; cost_usd: string | null; cost_source: string | null; attempts: number | null; reason: string | null; sent: boolean; use_case_id: string | null; source: string }
async function row(idempotencyKey: string): Promise<LedgerRow | undefined> {
  return (await t.pool.query<LedgerRow>(
    `SELECT status, reserved_usd::text, cost_usd::text, cost_source, attempts, reason, dispatched_at IS NOT NULL AS sent, use_case_id, source
       FROM typesafe_reservation WHERE idempotency_key = $1`, [idempotencyKey])).rows[0];
}

function dispatcherWith(ledger: TypeSafeLedger): AiDispatcher {
  return new AiDispatcher({ pool: t.pool, config: { ...t.handle.config, aiRealProviders: true }, typesafe: ledger });
}

function ctx(extra: Partial<InvokeContext> = {}): InvokeContext {
  const k = `k-${randomUUID()}`;
  return { requestId: k, idempotencyKey: k, tenantId: null, actorId: ACTOR, actorKind: 'system', origin: 'test.typesafe', pinnedRouteId: typesafeRoute, ...extra };
}

async function classify(dispatcher: AiDispatcher, extra: Partial<InvokeContext> = {}) {
  const r = await dispatcher.invokeClassification(USE_CASE, ctx(extra), STATE);
  if (r.invocationId) ledgerKeys.push(`ai_invocation:${r.invocationId}`);
  return r;
}

async function invocation(id: string | null) {
  return (await t.pool.query<{ status: string; error_code: string | null; detail: string | null; cost_usd: string | null; cost_source: string }>(
    `SELECT status, error_code, validation->>'detail' AS detail, cost_usd::text, cost_source FROM ai_invocation WHERE invocation_id = $1`, [id])).rows[0];
}

/** Resuelve cuando `n` de las promesas terminaron (sin importar cuáles). */
function firstSettled(promises: readonly Promise<unknown>[], n: number): Promise<void> {
  let done = 0;
  // Forma ejecutora: el tsconfig no incluye es2024 (Promise.withResolvers).
  return new Promise<void>((resolve) => {
    for (const p of promises) void p.finally(() => { if (++done === n) resolve(); });
  });
}

// ------------------------------------------------------------------ AC-TS01: concurrencia

test('AC-TS01: con sitio para exactamente 2 reservas, 4 reservas paralelas dejan 2 reservadas y 2 denegadas (tres rondas); nunca se pasa del límite', async () => {
  for (let round = 0; round < 3; round += 1) {
    const { ledger, base } = await ledgerWithRoom(2);
    const keys = [0, 1, 2, 3].map((i) => key(`par-${round}-${i}`));
    const claims = await Promise.all(keys.map((k) => ledger.reserve({ key: k, source: 'pipeline', useCaseId: null, reserveUsd: MAX })));
    assert.deepEqual(claims.map((c) => c.status).sort(), ['denied', 'denied', 'reserved', 'reserved'], `ronda ${round}`);
    for (const c of claims) if (c.status === 'denied') assert.ok(near(c.spentUsd, base + 2 * MAX) && near(c.limitUsd, base + 2 * MAX), 'la denegación ve las dos reservas en curso');
    assert.ok(near(await spentToday(), base + 2 * MAX), 'cuentan solo las dos reservas en curso');
    const rows = (await t.pool.query<{ status: string }>('SELECT status FROM typesafe_reservation WHERE idempotency_key = ANY($1)', [keys])).rows;
    assert.deepEqual(rows.map((r) => r.status), ['reserved', 'reserved'], 'una denegación no deja fila');
    for (const c of claims) if (c.status === 'reserved') assert.equal(await ledger.release(c.hold, 'test'), true);
    assert.ok(near(await spentToday(), base), 'liberadas: no cuentan');
  }
});

test('AC-TS01: 4 clasificaciones paralelas del AI Core con TypeSafe retenido ⇒ 2 peticiones, 2 budget_exhausted sin petición; al soltar, el costo informado reemplaza la reserva', async () => {
  const { ledger, base } = await ledgerWithRoom(2);
  const dispatcher = dispatcherWith(ledger);
  const calls0 = typesafe.calls;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let twoSent: () => void = () => undefined;
  const bothSent = new Promise<void>((resolve) => { twoSent = resolve; });
  // Retenida hasta soltar la compuerta o hasta el deadline del propio cliente (así una regresión falla en vez de colgarse).
  typesafe.respond = async (request, init) => {
    if (typesafe.calls - calls0 === 2) twoSent();
    await new Promise<void>((resolve, reject) => {
      void gate.then(resolve);
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    return answer(request, { cost: 0.00004 });
  };
  let pending: Promise<Classified>[] = [];
  try {
    pending = [0, 1, 2, 3].map(() => classify(dispatcher));
    // Las dos sin reserva terminan solas mientras las otras dos siguen retenidas en el proveedor.
    await Promise.all([bothSent, firstSettled(pending, 2)]);
    assert.equal(typesafe.calls - calls0, 2, 'solo salen las dos reservadas');
    assert.ok(near(await spentToday(), base + 2 * MAX), 'en vuelo cuentan su reserva completa');
    release();
    const results = await Promise.all(pending);
    assert.deepEqual(results.map((r) => (r.ok ? 'ok' : r.code)).sort(), ['budget_exhausted', 'budget_exhausted', 'ok', 'ok']);
    assert.equal(typesafe.calls - calls0, 2, '0 peticiones extra');
    for (const r of results) {
      const ledgerRow = await row(`ai_invocation:${r.invocationId}`);
      const inv = await invocation(r.invocationId);
      if (r.ok) {
        assert.deepEqual(ledgerRow, { status: 'committed', reserved_usd: String(MAX), cost_usd: '0.00004', cost_source: 'reported', attempts: 1, reason: null, sent: true, use_case_id: USE_CASE, source: 'ai_core' });
        assert.deepEqual([inv?.status, inv?.cost_usd, inv?.cost_source], ['succeeded', '0.000040', 'reported']);
      } else {
        assert.equal(ledgerRow, undefined, 'sin reserva no hay fila en el libro');
        assert.deepEqual(inv, { status: 'failed', error_code: 'budget_exhausted', detail: 'DEC-0032', cost_usd: '0.000000', cost_source: 'none' });
      }
    }
    assert.ok(near(await spentToday(), base + 2 * 0.00004), 'el costo informado reemplaza la reserva');
  } finally {
    release();
    await Promise.allSettled(pending);
    typesafe.respond = async (request) => answer(request, { cost: 0.00004 });
  }
});

// ------------------------------------------------------------------ medición

test('TS-1: sin usage.cost se confirma el costo estimado (tokens × precio del modelo); con reintentos cuenta el mayor de costo y reserva', async () => {
  const { ledger, base } = await ledgerWithRoom(5);
  const dispatcher = dispatcherWith(ledger);
  try {
    typesafe.respond = async (request) => answer(request, { input_tokens: 600, output_tokens: 4, cost: undefined });
    const estimated = await classify(dispatcher);
    assert.ok(estimated.ok && estimated.costSource === 'estimated');
    const est = await row(`ai_invocation:${estimated.invocationId}`);
    assert.deepEqual([est?.status, est?.cost_source, est?.attempts], ['committed', 'estimated', 1]);
    assert.ok(near(Number(est?.cost_usd), 600 * 0.042 / 1_000_000), `estimado ${est?.cost_usd}`);
    assert.ok(near(await spentToday(), base + 600 * 0.042 / 1_000_000));

    // 503 y después 200: el cliente reintenta (backoff acotado); el primer intento pudo cobrarse.
    let attempt = 0;
    typesafe.respond = async (request) => (++attempt === 1 ? new Response('busy', { status: 503 }) : answer(request, { cost: 0.00004 }));
    const calls0 = typesafe.calls;
    const retried = await classify(dispatcher);
    assert.ok(retried.ok);
    assert.equal(typesafe.calls - calls0, 2);
    const re = await row(`ai_invocation:${retried.invocationId}`);
    assert.deepEqual([re?.status, re?.cost_usd, re?.cost_source, re?.attempts], ['committed', '0.00004', 'reported', 2]);
    assert.ok(near(await spentToday(), base + 600 * 0.042 / 1_000_000 + MAX), 'con 2 intentos cuenta la reserva (mayor que el costo informado)');
  } finally {
    typesafe.respond = async (request) => answer(request, { cost: 0.00004 });
  }
});

test('TS-1: un fallo antes de enviar libera la reserva (no cuenta); HTTP 5xx o tiempo agotado tras enviar cuentan la reserva (no se suponen gratis)', async () => {
  const { ledger, base } = await ledgerWithRoom(5);
  const calls0 = typesafe.calls;
  // Deadline inválido del llamador: el cliente no se construye, nada sale.
  const notSent = await classify(dispatcherWith(ledger), { deadlineMs: 0.5 });
  assert.ok(!notSent.ok && notSent.code === 'provider_unavailable');
  assert.equal(typesafe.calls, calls0);
  const released = await row(`ai_invocation:${notSent.invocationId}`);
  assert.deepEqual([released?.status, released?.sent, released?.reason, released?.cost_usd], ['released', false, 'not_sent', null]);
  assert.ok(near(await spentToday(), base), 'lo que nunca salió no cuenta');

  try {
    typesafe.respond = async () => new Response('boom', { status: 500 });
    const http = await classify(dispatcherWith(ledger));
    assert.ok(!http.ok && http.code === 'provider_unavailable');
    const failed = await row(`ai_invocation:${http.invocationId}`);
    assert.deepEqual([failed?.status, failed?.sent, failed?.cost_usd, failed?.cost_source, failed?.reason], ['committed', true, null, 'unknown', 'unavailable']);
    assert.ok(near(await spentToday(), base + MAX), 'HTTP 500 tras enviar: cuenta la reserva');

    typesafe.respond = (_request, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    const slow = await classify(dispatcherWith(ledger), { deadlineMs: 50 });
    assert.ok(!slow.ok && slow.code === 'provider_unavailable');
    const timedOut = await row(`ai_invocation:${slow.invocationId}`);
    assert.deepEqual([timedOut?.status, timedOut?.sent, timedOut?.cost_source, timedOut?.reason], ['committed', true, 'unknown', 'TimeoutError']);
    assert.ok(near(await spentToday(), base + 2 * MAX), 'tiempo agotado tras enviar: cuenta la reserva');
    assert.equal(typesafe.calls - calls0, 2);
  } finally {
    typesafe.respond = async (request) => answer(request, { cost: 0.00004 });
  }
});

// ------------------------------------------------------------------ caída y reconciliación

test('TS-1: caída a mitad — vencida sin enviar se libera (barrido o reconciliación) y ya no se envía; vencida enviada queda expired y cuenta; una confirmación tardía la mide', async () => {
  const { ledger, base } = await ledgerWithRoom(5);
  const [a, b, c] = await Promise.all(['crash-a', 'crash-b', 'crash-c'].map(async (label) =>
    held(await ledger.reserve({ key: key(label), source: 'pipeline', useCaseId: null, reserveUsd: MAX }))));
  assert.equal(await ledger.dispatched(b!), true);
  assert.ok(near(await spentToday(), base + 3 * MAX));
  // El proceso cae: las tres siguen `reserved` y pasa su vigencia.
  await t.pool.query(`UPDATE typesafe_reservation SET expires_at = clock_timestamp() - interval '1 second' WHERE reservation_id = ANY($1)`,
    [[a!.reservationId, b!.reservationId, c!.reservationId]]);
  assert.ok(near(await spentToday(), base + MAX), 'antes de barrer ya solo cuenta la enviada');
  assert.equal(await ledger.dispatched(c!), false, 'una reserva vencida ya no se envía');
  assert.equal((await row(c!.key))?.status, 'released');

  const report = await ledger.reconcile();
  assert.ok(report.released >= 1 && report.expired >= 1, JSON.stringify(report));
  assert.deepEqual([(await row(a!.key))?.status, (await row(a!.key))?.reason], ['released', 'expired_before_dispatch']);
  const expired = await row(b!.key);
  assert.deepEqual([expired?.status, expired?.cost_usd, expired?.cost_source, expired?.reason], ['expired', null, 'unknown', 'expired_after_dispatch']);
  assert.ok(near(await spentToday(), base + MAX), 'la enviada sin confirmar cuenta la reserva');
  assert.equal(await ledger.failAfterDispatch(a!, 'late'), false, 'lo liberado no se reabre');

  // La respuesta llega tarde: la medición sustituye a la reserva.
  assert.equal(await ledger.commit(b!, { costUsd: 0.00004, costSource: 'reported', attempts: 1 }), true);
  const late = await row(b!.key);
  assert.deepEqual([late?.status, late?.cost_usd, late?.reason], ['committed', '0.00004', 'settled_after_expiry']);
  assert.ok(near(await spentToday(), base + 0.00004));

  // El barrido también corre antes de cada reserva (sin reconciliación periódica).
  const d = held(await ledger.reserve({ key: key('crash-d'), source: 'pipeline', useCaseId: null, reserveUsd: MAX }));
  await t.pool.query(`UPDATE typesafe_reservation SET expires_at = clock_timestamp() - interval '1 second' WHERE reservation_id = $1`, [d.reservationId]);
  const e = held(await ledger.reserve({ key: key('crash-e'), source: 'pipeline', useCaseId: null, reserveUsd: MAX }));
  assert.deepEqual([(await row(d.key))?.status, (await row(d.key))?.reason], ['released', 'expired_before_dispatch']);
  assert.equal(await ledger.release(e, 'test'), true);
});

// ------------------------------------------------------------------ idempotencia

test('TS-1: misma clave — en curso no reserva otra vez; cerrada se repite sin reservar ni llamar; liberada se reserva de nuevo y la reserva anterior ya no la cierra', async () => {
  const { ledger, base } = await ledgerWithRoom(5);
  const k = key('idem');
  const first = held(await ledger.reserve({ key: k, source: 'pipeline', useCaseId: null, reserveUsd: MAX }));
  assert.deepEqual(await ledger.reserve({ key: k, source: 'pipeline', useCaseId: null, reserveUsd: MAX }), { status: 'in_progress', key: k });
  assert.ok(near(await spentToday(), base + MAX), 'una sola reserva');
  assert.equal(await ledger.dispatched(first), true);
  assert.equal(await ledger.commit(first, { costUsd: 0.00003, costSource: 'reported', attempts: 1 }), true);
  assert.deepEqual(await ledger.reserve({ key: k, source: 'pipeline', useCaseId: null, reserveUsd: MAX }), { status: 'replay', key: k, previous: 'committed' });
  assert.equal(await ledger.failAfterDispatch(first, 'duplicate'), false, 'una llamada cerrada no se vuelve a cerrar');
  assert.ok(near(await spentToday(), base + 0.00003), 'la repetición no suma');

  const k2 = key('idem-released');
  const old = held(await ledger.reserve({ key: k2, source: 'pipeline', useCaseId: null, reserveUsd: MAX }));
  assert.equal(await ledger.release(old, 'not_sent'), true);
  const renewed = held(await ledger.reserve({ key: k2, source: 'pipeline', useCaseId: null, reserveUsd: MAX }));
  assert.notEqual(renewed.reservationId, old.reservationId);
  assert.equal(await ledger.dispatched(old), false, 'la reserva anterior no envía en nombre de la nueva');
  assert.equal(await ledger.commit(old, { costUsd: 0, costSource: 'reported', attempts: 1 }), false, 'ni la cierra como gratis');
  assert.deepEqual([(await row(k2))?.status, (await row(k2))?.sent], ['reserved', false]);
  assert.ok(near(await spentToday(), base + 0.00003 + MAX));
  assert.equal(await ledger.release(renewed, 'test'), true);
});

// ------------------------------------------------------------------ simulado

test('TS-1: la clasificación simulada (MockJev) no reserva ni la frena el tope agotado; la ruta TypeSafe sí se deniega sin petición', async () => {
  const exhausted = new TypeSafeLedger({ pool: t.pool, dailyLimitUsd: () => 0 });
  const dispatcher = dispatcherWith(exhausted);
  const calls0 = typesafe.calls;
  const simulated = await classify(dispatcher, { pinnedRouteId: simulatedRoute });
  assert.ok(simulated.ok && simulated.simulated, JSON.stringify(simulated));
  assert.equal(await row(`ai_invocation:${simulated.invocationId}`), undefined, 'sin fila en el libro');
  const denied = await classify(dispatcher);
  assert.deepEqual([denied.ok, !denied.ok && denied.code, !denied.ok && denied.reason], [false, 'budget_exhausted', 'DEC-0032']);
  assert.equal(typesafe.calls, calls0);
});
