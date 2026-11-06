/**
 * TS-1 × DEC-0027 — el libro de TypeSafe (`typesafe_reservation`, sin negocio) no guarda ningún identificador de un
 * negocio: un negocio que conversó con Jev activado (pipeline del chat, reserva por llamada) se puede anonimizar y la
 * verificación no encuentra rastros. Revisión independiente, pasada 1, F-01: la clave `pipeline:<request_id>` dejaba el
 * request id del negocio y la anonimización se revertía.
 * TypeSafe FALSO: `fetch` interceptado en todo el archivo (solo api.typesafe.ai responde, en memoria); ninguna salida real.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApi, authHeaders, api, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan } from '../helpers/tenants.ts';
import { MockJev } from '../../src/jev/mock.ts';
import type { SystemOneRequest } from '../../src/jev/types.ts';

const realFetch = globalThis.fetch;
const leaked: string[] = [];
let calls = 0;
let t: TestApi;

async function offlineFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  if (url.origin === 'https://api.typesafe.ai' && url.pathname === '/v1/systemone') {
    calls += 1;
    const request = JSON.parse(String(init?.body)) as SystemOneRequest;
    const mock = new MockJev().systemOne(request);
    return new Response(JSON.stringify({ ...mock, model: 'jev-1.14.0', usage: { ...mock.usage, cost: 0.00004 } }), { status: 200 });
  }
  leaked.push(url.host);
  throw new TypeError(`salida de red bloqueada en la prueba: ${url.host}`);
}

before(async () => {
  globalThis.fetch = offlineFetch;
  t = await bootApi({ jev: { mode: 'shadow', provider: 'typesafe', apiKey: 'ts-fake-key-anonymization', model: 'jev-1.14.0', dataScope: 'all', syntheticTenants: [], dailyBudgetUsd: 1 } });
});

after(async () => {
  await t.close();
  globalThis.fetch = realFetch;
  assert.deepEqual(leaked, [], 'ninguna salida a la red real');
});

test('TS-1 × DEC-0027: tras conversar con Jev, el libro de TypeSafe no guarda identificadores del negocio y la anonimización verifica sin rastros', async () => {
  const a = await createTenantWithPlan(t, { conversations: 10, website: 1, social_posts: 5, reviews_managed: 5 }, 'client_tsanon');
  const calls0 = calls;
  const sent = await api(t.baseUrl, '/api/backoffice/conversation/messages', { method: 'POST', headers: authHeaders(a.token),
    body: JSON.stringify({ text: '¿cuál es el horario de atención?', channel: 'simulated' }) });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  await t.handle.jev?.drain();
  assert.equal(calls, calls0 + 1, 'una llamada (falsa) a TypeSafe, reservada en el libro');

  const requests = (await t.pool.query<{ request_id: string }>('SELECT request_id FROM conversation_request WHERE tenant_id = $1', [a.tenant])).rows.map((r) => r.request_id);
  assert.equal(requests.length, 1);
  const row = (await t.pool.query<{ idempotency_key: string; status: string; cost_source: string }>(
    `SELECT idempotency_key, status, cost_source FROM typesafe_reservation WHERE source = 'pipeline' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  assert.ok(row);
  assert.deepEqual([row.status, row.cost_source], ['committed', 'reported']);
  assert.match(row.idempotency_key, /^pipeline:[0-9a-f-]{36}$/, 'clave opaca de un solo uso');
  assert.ok(!requests.some((r) => row.idempotency_key.includes(r)), 'la clave no contiene el request id del negocio');

  const out = await t.handle.retention.anonymizeTenant(a.tenant, `ret_${randomUUID()}`, { dryRun: true });
  assert.match(out.anonymousId, /^anon_/, 'la verificación de anonimización no encuentra rastros (ensayo revertido)');
});
