/**
 * APR-0002 — Jev como clasificador (integración): disabled, shadow y primary
 * sobre la MISMA BD de test. TypeSafe simulado: `fetch` hacia api.typesafe.ai se
 * intercepta y responde según el mensaje; nunca hay red.
 *  - shadow: outcome idéntico a disabled; una fila de evidencia por solicitud.
 *  - primary con el gate D4 cerrado: igual que shadow (`primary_gated`).
 *  - primary con el gate abierto: Jev decide; D1 escala, D3 pide aclaración,
 *    D2 vuelve a las reglas; tenants fuera de JEV_SYNTHETIC_TENANTS no salen.
 * La credencial jamás aparece en filas, auditoría ni logs.
 */

import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { bootApi, login, authHeaders, api, SEED, type TestApi } from '../helpers/testdb.ts';
import {
  CAPABILITY_TARGETS, JEV_INTENTS, JEV_POLICY_VERSION, decisionCodeSha256, gateEvalSetSha256, type JevIntentOption,
} from '../../src/conversation/jev-classifier.ts';
import { JevRepository, type JevClassificationRow } from '../../src/conversation/jev-repository.ts';

const FAKE_KEY = 'ts-fake-integration-key-0123456789';
const RESOLVED = 'jev-9.9.9-fake';
const INTENT_OPTIONS: JevIntentOption[] = [...JEV_INTENTS, 'other'];
const realFetch = globalThis.fetch;

let plain: TestApi;
let shadow: TestApi;
let gated: TestApi;
let primary: TestApi;
let jevDown = false;
let jevCalls = 0;
let stdout = '';

/** Lectura simulada de Jev por mensaje; por defecto `query.read_only` con 0.9. */
const JEV_ANSWERS: Record<string, { intent: JevIntentOption; p: number }> = {
  'mi número nuevo es 555-0100': { intent: 'website.edit', p: 0.93 },
  'inventa un precio para el menú del día': { intent: 'content.suggestion', p: 0.9 },
  '¿cuál es el horario de atención?': { intent: 'query.read_only', p: 0.55 },
  'cambia el teléfono de mi página a 999 888 777': { intent: 'website.edit', p: 0.96 },
};

function fakeJevResponse(text: string): Response {
  if (jevDown) return new Response('unavailable', { status: 503 });
  const { intent, p } = JEV_ANSWERS[text] ?? { intent: 'query.read_only', p: 0.9 };
  const dist = <T extends string>(options: readonly T[], top: T, q: number) =>
    Object.fromEntries(options.map((o) => [o, o === top ? q : (1 - q) / (options.length - 1)]));
  return new Response(JSON.stringify({
    model: RESOLVED,
    answers: {
      intent: { type: 'choice', choice: intent, probabilities: dist(INTENT_OPTIONS, intent, p), confidence: 0.8 },
      capability_target: { type: 'choice', choice: 'website', probabilities: dist(CAPABILITY_TARGETS, 'website', 0.9), confidence: 0.8 },
    },
    usage: { input_tokens: 600, output_tokens: 4 },
  }), { status: 200 });
}

const jevConfig = (mode: 'shadow' | 'primary', model = 'jev-latest') => ({
  mode, provider: 'typesafe' as const, apiKey: FAKE_KEY, model, dataScope: 'synthetic' as const,
  syntheticTenants: [SEED.b.tenant], dailyBudgetUsd: 1,
});

before(async () => {
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const href = url instanceof Request ? url.url : String(url);
    if (href.startsWith('https://api.typesafe.ai/')) {
      jevCalls++;
      return fakeJevResponse((JSON.parse(String(init?.body)) as { state: { message: string } }).state.message);
    }
    if (href.startsWith('http://127.0.0.1:')) return realFetch(url, init);
    throw new Error(`Unexpected network call in test: ${href}`);
  });
  const originalWrite = process.stdout.write.bind(process.stdout);
  mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...rest: unknown[]) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  });
  plain = await bootApi();
  shadow = await bootApi({ jev: jevConfig('shadow') });
  // Gate D4: la última evaluación de (política, jev-latest, conjunto, código) supera los umbrales.
  await new JevRepository(plain.pool).createEvaluationRun({
    policyVersion: JEV_POLICY_VERSION, provider: 'typesafe', requestedModel: 'jev-latest', resolvedModels: [RESOLVED],
    datasetVersion: 'v3', datasetSha256: gateEvalSetSha256(), riskDefinition: 'final_outcome',
    decisionCodeSha256: decisionCodeSha256(), casesTotal: 240, casesEvaluated: 240, intentCorrect: 228,
    riskyCases: 90, riskyMisses: 0, jevRiskyMisses: 5, capabilityCorrect: 200, minProbability: 0.7, passed: true,
    costUsd: 0.01, budgetDay: new Date().toISOString().slice(0, 10), report: {}, startedAt: new Date(),
  });
  primary = await bootApi({ jev: jevConfig('primary') });
  gated = await bootApi({ jev: jevConfig('primary', 'jev-never-evaluated') });
});

after(async () => {
  for (const app of [primary, gated, shadow, plain]) await app.close();
  mock.restoreAll();
});

async function send(app: TestApi, text: string, tenant: 'a' | 'b' = 'b') {
  const seed = SEED[tenant];
  const { token } = await login(app.baseUrl, seed.ops.login, seed.ops.password, seed.tenant);
  return api(app.baseUrl, '/api/backoffice/conversation/messages', {
    method: 'POST', headers: authHeaders(token), body: JSON.stringify({ text, channel: 'simulated' }),
  });
}

/** Outcome sin identificadores aleatorios (request_id/proposal_id). */
function normalized(body: { request: { request_id: string }; proposal_id: string | null }): string {
  return JSON.stringify({ ...body, request: { ...body.request, request_id: '<request_id>' }, proposal_id: body.proposal_id === null ? null : '<proposal_id>' });
}

async function classifiedAudit(app: TestApi, requestId: string): Promise<string> {
  const res = await app.pool.query<{ result: string }>(
    `SELECT result FROM audit_event WHERE request_id = $1 AND action = 'conversation.classified'`, [requestId]);
  return res.rows[0]?.result ?? '';
}

async function row(app: TestApi, requestId: string): Promise<JevClassificationRow | undefined> {
  await app.jev?.drain();
  const res = await app.pool.query<JevClassificationRow>('SELECT * FROM jev_classification WHERE request_id = $1', [requestId]);
  assert.ok((res.rowCount ?? 0) <= 1);
  return res.rows[0];
}

const MESSAGES = [
  '¿cuál es el teléfono de mi negocio?',                 // read_only
  'cambia el teléfono de mi página a 999 888 777',        // preview_required
  'quiero ofrecer un descuento a un cliente molesto',     // human_approval_required
  'inventa un precio para el menú del día',               // prohibited
  'sugiere un eslogan para mi negocio',                   // draft
  'hola',                                                 // needs_clarification (draft)
];

test('APR-0002: shadow keeps outcomes identical to disabled and records one shadow row per request', async () => {
  for (const text of MESSAGES) {
    const a = await send(plain, text);
    const b = await send(shadow, text);
    assert.equal(a.status, 201);
    assert.equal(b.status, a.status, `same status for "${text}"`);
    assert.equal(normalized(b.body), normalized(a.body), `identical outcome for "${text}"`);
    const cls = a.body.request.action_class as string;
    assert.equal(await classifiedAudit(plain, a.body.request.request_id), `${a.body.request.intent}:${cls};source=deterministic`);
    assert.equal(await classifiedAudit(shadow, b.body.request.request_id), `${b.body.request.intent}:${cls};source=deterministic;jev=shadow`);
    assert.equal(await row(plain, a.body.request.request_id), undefined, 'no row when Jev is disabled');
    const r = await row(shadow, b.body.request.request_id);
    assert.deepEqual([r?.tenant_id, r?.mode, r?.decision_source, r?.decision_reason, r?.status, r?.deterministic_action_class, r?.final_action_class],
      [SEED.b.tenant, 'shadow', 'deterministic', 'shadow', 'evaluated', cls, cls], text);
    assert.deepEqual(JSON.parse(r?.raw_request ?? '{}').state, { message: text });
    assert.equal(r?.resolved_model, RESOLVED);
    assert.equal(r?.cost_source, 'estimated', 'priced with JEV_PRICING when the provider reports no cost');
  }
});

test('DEC-0031: primary with a model that never passed the evaluation behaves as shadow', async () => {
  const text = 'mi número nuevo es 555-0100';
  const a = await send(plain, text);
  const b = await send(gated, text);
  assert.equal(normalized(b.body), normalized(a.body));
  const r = await row(gated, b.body.request.request_id);
  assert.deepEqual([r?.mode, r?.decision_reason, r?.jev_intent], ['shadow', 'primary_gated', 'website.edit']);
  assert.match(await classifiedAudit(gated, b.body.request.request_id), /;source=deterministic;jev=primary_gated$/);
});

test('DEC-0033: a passing run only counts for the exact decision code it evaluated', async () => {
  const repo = new JevRepository(plain.pool);
  const current = { datasetSha256: gateEvalSetSha256(), decisionCodeSha256: decisionCodeSha256() };
  assert.equal((await repo.latestEvaluation(JEV_POLICY_VERSION, 'jev-latest', current))?.risk_definition, 'final_outcome');
  assert.equal(await repo.latestEvaluation(JEV_POLICY_VERSION, 'jev-latest', { ...current, decisionCodeSha256: '0'.repeat(64) }),
    null, 'changing the rules or the policy needs a new evaluation');
});

test('DEC-0031: pinning JEV_MODEL to the version that answered the evaluation reuses it; other versions do not', async () => {
  const repo = new JevRepository(plain.pool);
  const current = { datasetSha256: gateEvalSetSha256(), decisionCodeSha256: decisionCodeSha256() };
  assert.deepEqual((await repo.latestEvaluation(JEV_POLICY_VERSION, RESOLVED, current))?.resolved_models, [RESOLVED],
    'run requested as jev-latest and answered entirely by RESOLVED');
  assert.equal(await repo.latestEvaluation(JEV_POLICY_VERSION, 'jev-0.0.1-never-evaluated', current), null);
});

test('DEC-0031: primary with the gate open lets Jev determine the classification', async () => {
  const text = 'mi número nuevo es 555-0100';
  const rules = await send(plain, text);
  assert.equal(rules.body.request.action_class, 'draft', 'the rules alone ask for clarification');
  const b = await send(primary, text);
  assert.equal(b.status, 201);
  assert.deepEqual([b.body.request.action_class, b.body.request.intent, b.body.request.status], ['preview_required', 'website.edit', 'awaiting_confirmation']);
  assert.ok(b.body.proposal_id, 'website proposal awaiting confirmation (backend gates unchanged)');
  const r = await row(primary, b.body.request.request_id);
  assert.deepEqual([r?.mode, r?.decision_source, r?.decision_reason, r?.deterministic_action_class, r?.final_action_class],
    ['primary', 'jev', 'jev_confident', 'draft', 'preview_required']);
  assert.equal(await classifiedAudit(primary, b.body.request.request_id), 'website.edit:preview_required;source=jev;jev=jev_confident');
});

test('DEC-0028: a discrepancy over a prohibited request goes to human approval', async () => {
  const b = await send(primary, 'inventa un precio para el menú del día');
  assert.deepEqual([b.body.request.action_class, b.body.request.status], ['human_approval_required', 'needs_approval']);
  const r = await row(primary, b.body.request.request_id);
  assert.deepEqual([r?.decision_source, r?.decision_reason, r?.deterministic_action_class, r?.jev_action_class],
    ['human_escalation', 'safety_discrepancy', 'prohibited', 'draft']);
});

test('DEC-0030: a low-probability reading asks the owner to clarify', async () => {
  const text = '¿cuál es el horario de atención?';
  assert.equal((await send(plain, text)).body.request.action_class, 'read_only');
  const b = await send(primary, text);
  assert.deepEqual([b.body.request.status, b.body.request.intent], ['needs_clarification', 'request.needs_clarification']);
  const r = await row(primary, b.body.request.request_id);
  assert.deepEqual([r?.decision_source, r?.decision_reason, r?.jev_intent_probability], ['jev', 'low_confidence', 0.55]);
});

test('DEC-0029: a Jev outage falls back to the rules, marked', async () => {
  jevDown = true;
  try {
    const text = 'cambia el teléfono de mi página a 999 888 777';
    const a = await send(plain, text);
    const b = await send(primary, text);
    assert.equal(normalized(b.body), normalized(a.body));
    const r = await row(primary, b.body.request.request_id);
    assert.deepEqual([r?.decision_source, r?.decision_reason, r?.status, r?.error_code], ['deterministic_fallback', 'jev_unavailable', 'unavailable', 'http_503']);
    assert.match(await classifiedAudit(primary, b.body.request.request_id), /;source=deterministic_fallback;jev=jev_unavailable$/);
  } finally {
    jevDown = false;
  }
});

test('DEC-0019: messages of tenants outside JEV_SYNTHETIC_TENANTS never reach TypeSafe', async () => {
  const before = jevCalls;
  const text = 'mi número nuevo es 555-0100';
  const b = await send(primary, text, 'a');
  assert.equal(b.body.request.action_class, 'draft', 'rules decide');
  assert.equal(jevCalls, before, 'no TypeSafe call');
  assert.equal(await row(primary, b.body.request.request_id), undefined);
  assert.match(await classifiedAudit(primary, b.body.request.request_id), /;source=deterministic;jev_skipped=data_scope$/);
});

test('APR-0002: the TypeSafe key never reaches stored rows, audit events or logs', async () => {
  await primary.jev?.drain();
  const rows = await primary.pool.query<{ j: string }>('SELECT row_to_json(c)::text AS j FROM jev_classification c');
  assert.ok((rows.rowCount ?? 0) > 0);
  assert.ok(rows.rows.every((r) => !r.j.includes(FAKE_KEY)), 'key absent from classification rows');
  const audits = await primary.pool.query<{ j: string }>('SELECT row_to_json(a)::text AS j FROM audit_event a');
  assert.ok(audits.rows.every((r) => !r.j.includes(FAKE_KEY)), 'key absent from audit events');
  assert.ok(stdout.includes('jev.recorded'), 'Jev logs were captured');
  assert.ok(!stdout.includes(FAKE_KEY), 'key absent from logs');
});
