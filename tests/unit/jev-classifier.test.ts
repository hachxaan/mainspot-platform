/**
 * APR-0002 — Jev como clasificador (MSP-JEV-CLASSIFIER-MODES v1): política D1–D3,
 * presupuesto D5, gate D4, alcance de datos y persistencia.
 * 100 % offline: `fetch` está simulado en cada test (cualquier llamada no
 * simulada falla); nunca se contacta api.typesafe.ai.
 */

import { beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent } from '../../src/conversation/classifier.ts';
import {
  CAPABILITY_TARGETS,
  INTENT_ACTION_CLASS,
  JEV_INTENTS,
  JEV_MAX_MESSAGE_BYTES,
  JEV_POLICY_VERSION,
  JEV_QUESTIONS,
  JevBudget,
  JevClassifier,
  JevPrimaryGate,
  createJevClassifier,
  createJevClient,
  decidePrimary,
  evaluationPasses,
  readJevAnswers,
  type JevIntentOption,
  type JevReading,
} from '../../src/conversation/jev-classifier.ts';
import type { CapabilityTarget } from '../../src/conversation/intents.ts';
import type {
  JevClassificationInsert,
  JevClassificationRow,
  JevClassificationStore,
  JevEvaluationRunRow,
} from '../../src/conversation/jev-repository.ts';
import { ContractError, JevClient } from '../../src/jev/client.ts';
import type { ChoiceAnswer } from '../../src/jev/types.ts';

const FAKE_KEY = 'ts-fake-key-never-leaves-0123456789';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const RESOLVED = 'jev-1.2.3-resolved';
const ENABLED = {
  provider: 'typesafe', apiKey: FAKE_KEY, model: 'jev-latest', dataScope: 'synthetic',
  syntheticTenants: ['client_a'], dailyBudgetUsd: 1,
} as const;
const INTENT_OPTIONS: JevIntentOption[] = [...JEV_INTENTS, 'other'];

beforeEach((t) => {
  assert.ok('mock' in t, 'beforeEach requires a test context');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unstubbed fetch forbidden'); });
});

function choiceAnswer<T extends string>(options: readonly T[], top: T, p: number, confidence = 0.7): ChoiceAnswer {
  const rest = (1 - p) / (options.length - 1);
  return { type: 'choice', choice: top, probabilities: Object.fromEntries(options.map((o) => [o, o === top ? p : rest])), confidence };
}

function answers(intent: JevIntentOption, p = 0.9, target: CapabilityTarget = 'website') {
  return {
    intent: choiceAnswer(INTENT_OPTIONS, intent, p),
    capability_target: choiceAnswer(CAPABILITY_TARGETS, target, 0.8),
  };
}

function jevBody(intent: JevIntentOption = 'website.edit', p = 0.9, model = RESOLVED): string {
  return JSON.stringify({ model, answers: answers(intent, p), usage: { input_tokens: 600, output_tokens: 4, cost: 0.00003 } });
}

function stubFetch(t: TestContext, impl: (init: RequestInit | undefined) => Promise<Response>) {
  return t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), ENDPOINT);
    return impl(init);
  });
}

function passingRun(overrides: Partial<JevEvaluationRunRow> = {}): JevEvaluationRunRow {
  return {
    run_id: 'jer_test', policy_version: JEV_POLICY_VERSION, provider: 'typesafe', requested_model: 'jev-latest',
    resolved_models: [RESOLVED], dataset_version: 'v3', dataset_sha256: 'x', risk_definition: 'final_outcome',
    decision_code_sha256: 'c'.repeat(64), cases_total: 240, cases_evaluated: 240, intent_correct: 230, risky_cases: 90,
    risky_misses: 0, jev_risky_misses: 4, capability_correct: 200, min_probability: 0.7, passed: true,
    cost_usd: '0.01', budget_day: '2026-10-22', report: {}, started_at: '', finished_at: '', ...overrides,
  };
}

const GATE_BINDING = { datasetSha256: 'gate-set-sha', decisionCodeSha256: 'code-sha' };

function fakeStore(opts: { spent?: number; run?: JevEvaluationRunRow | null; failInsert?: boolean } = {}) {
  const rows: JevClassificationInsert[] = [];
  const calls = { spentOn: 0, latestEvaluation: 0 };
  const store: JevClassificationStore = {
    async createClassification(r) {
      if (opts.failInsert) throw Object.assign(new Error('insert failed'), { code: '23503' });
      rows.push(r);
      return {} as JevClassificationRow;
    },
    async spentOn() { calls.spentOn++; return opts.spent ?? 0; },
    async latestEvaluation() { calls.latestEvaluation++; return opts.run === undefined ? passingRun() : opts.run; },
  };
  return { rows, calls, store };
}

function classifier(
  mode: 'shadow' | 'primary',
  store: JevClassificationStore,
  client = createJevClient({ mode, ...ENABLED }),
): JevClassifier {
  return new JevClassifier({
    client, store, mode, syntheticTenants: ['client_a'],
    budget: new JevBudget(store, 1), gate: new JevPrimaryGate(store, client.defaultModel, GATE_BINDING),
  });
}

function input(text: string, tenantId = 'client_a') {
  return { tenantId, requestId: 'req_unit_1', text, deterministic: classifyIntent(text) };
}

function captureStdout(t: TestContext): () => string {
  let out = '';
  const original = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, 'write', (chunk: string | Uint8Array, ...rest: unknown[]) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
  });
  return () => out;
}

function reading(intent: JevIntentOption, p = 0.9, target: CapabilityTarget = 'website'): JevReading {
  return readJevAnswers(answers(intent, p, target));
}

// --- contrato de preguntas y lectura -------------------------------------------

test('APR-0002 unit: one call asks intent (8 intents + other) and capability_target (5 areas)', () => {
  assert.deepEqual(Object.keys(JEV_QUESTIONS).sort(), ['capability_target', 'intent']);
  assert.deepEqual(Object.keys(JEV_QUESTIONS.intent.criteria).sort(), [...INTENT_OPTIONS].sort());
  assert.deepEqual(Object.keys(JEV_QUESTIONS.capability_target.criteria).sort(), [...CAPABILITY_TARGETS].sort());
});

test('APR-0002 unit: the intent → ActionClass table matches the deterministic classifier for every intent', () => {
  const samples = [
    '¿cuál es el horario de mi negocio?', 'sugiere un eslogan para mi negocio', 'hola',
    'cambia el teléfono de mi página a 999 888 777', 'cámbialo ya', 'quiero ofrecer un descuento a un cliente molesto',
    'inventa un precio para el menú del día', 'publica en facebook la promo',
  ];
  const seen = new Set<string>();
  for (const text of samples) {
    const c = classifyIntent(text);
    seen.add(c.intent);
    assert.equal(INTENT_ACTION_CLASS[c.intent as keyof typeof INTENT_ACTION_CLASS], c.actionClass, text);
  }
  assert.deepEqual([...seen].sort(), [...JEV_INTENTS].sort(), 'samples cover every intent');
});

test('APR-0002 unit: reading keeps selected probability and confidence distinct; other has no class', () => {
  const r = readJevAnswers({ intent: choiceAnswer(INTENT_OPTIONS, 'website.edit', 0.55, 0.2), capability_target: choiceAnswer(CAPABILITY_TARGETS, 'domain', 0.8) });
  assert.equal(r.intent, 'website.edit');
  assert.equal(r.intentProbability, 0.55);
  assert.equal(r.intentConfidence, 0.2);
  assert.equal(r.actionClass, 'preview_required');
  assert.equal(r.capabilityTarget, 'domain');
  assert.equal(reading('other').actionClass, null);
});

test('APR-0002 unit: answers outside the contract are rejected, never mapped', () => {
  assert.throws(() => readJevAnswers({ capability_target: answers('website.edit').capability_target }), ContractError);
  assert.throws(() => readJevAnswers({ ...answers('website.edit'), intent: { ...answers('website.edit').intent, choice: 'publish_now' } }), ContractError);
  assert.throws(() => readJevAnswers({ ...answers('website.edit'), intent: { ...answers('website.edit').intent, confidence: 1.5 } }), ContractError);
  const missing = answers('website.edit');
  delete (missing.intent.probabilities as Record<string, number>).other;
  assert.throws(() => readJevAnswers(missing), ContractError);
});

// --- política pura D1–D3 ---------------------------------------------------------

test('DEC-0030 unit: D3 — probability 0.70 is accepted, just below it or `other` asks for clarification', () => {
  const det = classifyIntent('¿cuál es el horario de mi negocio?');
  const at = decidePrimary(reading('website.edit', 0.7), det);
  assert.equal(at.source, 'jev');
  assert.equal(at.reason, 'jev_confident');
  assert.equal(at.classification.intent, 'website.edit');
  assert.equal(at.classification.actionClass, 'preview_required');
  assert.equal(at.classification.proposalType, 'website.edit');

  const below = decidePrimary(reading('website.edit', 0.6999), det);
  assert.deepEqual([below.source, below.reason, below.classification.intent, below.classification.actionClass],
    ['jev', 'low_confidence', 'request.needs_clarification', 'draft']);

  const other = decidePrimary(reading('other', 0.95), det);
  assert.deepEqual([other.reason, other.classification.intent], ['other_intent', 'request.needs_clarification']);
});

test('DEC-0028 unit: D1 — a discrepancy involving prohibited or human approval escalates to a person', () => {
  const rulesProhibited = classifyIntent('inventa un precio para el menú del día');
  assert.equal(rulesProhibited.actionClass, 'prohibited');
  const escalated = decidePrimary(reading('content.suggestion', 0.95), rulesProhibited);
  assert.deepEqual([escalated.source, escalated.reason], ['human_escalation', 'safety_discrepancy']);
  assert.equal(escalated.classification.actionClass, 'human_approval_required');
  assert.equal(escalated.classification.proposalType, 'sensitive.business_decision');

  const rulesRead = classifyIntent('¿cuál es el horario de mi negocio?');
  assert.equal(decidePrimary(reading('sensitive.business_decision', 0.95), rulesRead).source, 'human_escalation');
  assert.equal(decidePrimary(reading('capability.unsupported', 0.95), rulesRead).source, 'human_escalation');

  const agreed = decidePrimary(reading('rule.prohibited_commercial', 0.95), rulesProhibited);
  assert.deepEqual([agreed.source, agreed.classification.actionClass], ['jev', 'prohibited']);

  // D1 antes que D3: con riesgo en juego, la duda va a una persona y no a una aclaración.
  assert.equal(decidePrimary(reading('other', 0.3), rulesProhibited).source, 'human_escalation');
  assert.equal(decidePrimary(reading('content.suggestion', 0.3), rulesProhibited).source, 'human_escalation');
});

test('DEC-0029 unit: D2 — no reading falls back to the deterministic classification, marked', () => {
  const det = classifyIntent('cambia el teléfono de mi página a 999 888 777');
  const down = decidePrimary(null, det);
  assert.deepEqual([down.source, down.reason], ['deterministic_fallback', 'jev_unavailable']);
  assert.equal(down.classification, det);
  assert.equal(decidePrimary(null, det, 'model_not_evaluated').reason, 'model_not_evaluated');
});

// --- presupuesto D5 y gate D4 ------------------------------------------------------

test('DEC-0032 unit: the budget ledger seeds from the store once per UTC day and stops at the limit', async () => {
  let now = new Date('2026-10-22T23:59:00Z');
  const calls: string[] = [];
  const budget = new JevBudget({ async spentOn(day) { calls.push(day); return day === '2026-10-22' ? 0.9 : 0; } }, 1, () => now);
  assert.equal(await budget.allows(), true);
  budget.record(0.05);
  assert.equal(await budget.allows(), true);
  budget.record(0.05);
  assert.equal(await budget.allows(), false, 'spent 1.00 of 1.00');
  budget.record(null);
  now = new Date('2026-10-23T00:00:01Z');
  assert.equal(await budget.allows(), true, 'a new UTC day starts a new ledger');
  assert.deepEqual(calls, ['2026-10-22', '2026-10-23']);
});

test('DEC-0031/DEC-0033 unit: the gate thresholds are recomputed from stored metrics', () => {
  assert.equal(evaluationPasses(passingRun({ cases_total: 200, intent_correct: 180, risky_misses: 0 })), true, 'exactly 90 %');
  assert.equal(evaluationPasses(passingRun({ cases_total: 200, intent_correct: 179 })), false);
  assert.equal(evaluationPasses(passingRun({ cases_total: 199, intent_correct: 199 })), false, 'fewer than 200 cases');
  assert.equal(evaluationPasses(passingRun({ risky_misses: 1 })), false);
  assert.equal(evaluationPasses({ ...passingRun(), provider: 'mock' }), false, 'mock runs never open primary');
  assert.equal(evaluationPasses(passingRun({ passed: false, intent_correct: 230 })), true, 'the stored flag is not trusted');
  assert.equal(evaluationPasses(passingRun({ risk_definition: 'jev_only', decision_code_sha256: null })), false,
    'runs scored on Jev alone (before DEC-0033) never open primary');
});

test('DEC-0031 unit: the gate follows the latest run, caches it and fails closed when unreadable', async () => {
  let at = 0;
  let run: JevEvaluationRunRow | null = passingRun();
  let fail = false;
  let reads = 0;
  const gate = new JevPrimaryGate({
    async latestEvaluation(policy, model, binding) {
      reads++;
      assert.deepEqual([policy, model, binding], [JEV_POLICY_VERSION, 'jev-latest', GATE_BINDING]);
      if (fail) throw new Error('db down');
      return run;
    },
  }, 'jev-latest', GATE_BINDING, 1000, () => at);
  assert.equal((await gate.state()).open, true);
  run = passingRun({ intent_correct: 100 });
  assert.equal((await gate.state()).open, true, 'cached within the TTL');
  at = 1000;
  assert.equal((await gate.state()).open, false, 'latest run fails ⇒ closed');
  at = 2000;
  fail = true;
  assert.equal((await gate.state()).open, false);
  assert.equal(reads, 3);
});

// --- clasificador: alcance, modos y persistencia --------------------------------------

test('DEC-0019 unit: tenants outside JEV_SYNTHETIC_TENANTS never reach TypeSafe', async (t) => {
  const fetch = stubFetch(t, async () => new Response(jevBody(), { status: 200 }));
  const { rows, store } = fakeStore();
  const jev = classifier('primary', store);
  const d = await jev.decide(input('¿cuál es el horario de mi negocio?', 'client_b'));
  d.commit();
  await jev.drain();
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual([d.source, d.audit, d.classification.actionClass], ['deterministic', ';jev_skipped=data_scope', 'read_only']);
  assert.equal(rows.length, 0);
});

test('APR-0002 unit: shadow keeps the deterministic decision and records Jev with raw bodies, never the key', async (t) => {
  const logs = captureStdout(t);
  const fetch = stubFetch(t, async () => new Response(jevBody('website.edit', 0.9), { status: 200 }));
  const { rows, store } = fakeStore();
  const jev = classifier('shadow', store);
  const msg = input('¿cuál es el horario de mi negocio?');
  const d = await jev.decide(msg);
  assert.deepEqual([d.source, d.audit], ['deterministic', ';jev=shadow']);
  assert.equal(d.classification, msg.deterministic);
  d.commit();
  await jev.drain();

  assert.equal(fetch.mock.callCount(), 1);
  const init = fetch.mock.calls[0]!.arguments[1] as RequestInit;
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${FAKE_KEY}`);
  assert.deepEqual(JSON.parse(String(init.body)).state, { message: msg.text }, 'only the message text is sent');
  assert.ok(!String(init.body).includes('client_a') && !String(init.body).includes('req_unit_1'));

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.deepEqual([row.mode, row.decisionSource, row.decisionReason, row.status], ['shadow', 'deterministic', 'shadow', 'evaluated']);
  assert.deepEqual([row.deterministicActionClass, row.finalActionClass, row.jevIntent, row.jevActionClass, row.agreement],
    ['read_only', 'read_only', 'website.edit', 'preview_required', false]);
  assert.equal(row.jevCapabilityTarget, 'website');
  assert.equal(row.resolvedModel, RESOLVED);
  assert.deepEqual([row.costUsd, row.costSource], [0.00003, 'reported']);
  assert.equal(row.rawRequest, String(init.body));
  assert.equal(row.rawResponse, jevBody('website.edit', 0.9));
  assert.match(row.budgetDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!JSON.stringify(row).includes(FAKE_KEY), 'key never stored');
  assert.ok(!logs().includes(FAKE_KEY), 'key never logged');
});

test('DEC-0031 unit: primary with the gate closed behaves as shadow (primary_gated)', async (t) => {
  stubFetch(t, async () => new Response(jevBody('website.edit', 0.95), { status: 200 }));
  const { rows, store } = fakeStore({ run: passingRun({ risky_misses: 2 }) });
  const jev = classifier('primary', store);
  const d = await jev.decide(input('¿cuál es el horario de mi negocio?'));
  assert.deepEqual([d.source, d.audit, d.classification.actionClass], ['deterministic', ';jev=primary_gated', 'read_only']);
  d.commit();
  await jev.drain();
  assert.deepEqual([rows[0]?.mode, rows[0]?.decisionReason], ['shadow', 'primary_gated']);
});

test('DEC-0031 unit: primary with the gate open lets Jev determine the classification', async (t) => {
  stubFetch(t, async () => new Response(jevBody('website.edit', 0.95), { status: 200 }));
  const { rows, store } = fakeStore();
  const jev = classifier('primary', store);
  const d = await jev.decide(input('¿cuál es el horario de mi negocio?'));
  assert.deepEqual([d.source, d.audit, d.classification.intent, d.classification.actionClass],
    ['jev', ';jev=jev_confident', 'website.edit', 'preview_required']);
  d.commit();
  await jev.drain();
  const row = rows[0]!;
  assert.deepEqual([row.mode, row.decisionSource, row.decisionReason, row.finalActionClass, row.deterministicActionClass],
    ['primary', 'jev', 'jev_confident', 'preview_required', 'read_only']);
});

test('DEC-0031 unit: a resolved model the evaluation did not cover falls back to the rules', async (t) => {
  stubFetch(t, async () => new Response(jevBody('website.edit', 0.95, 'jev-2.0.0-new'), { status: 200 }));
  const { rows, store } = fakeStore();
  const jev = classifier('primary', store);
  const d = await jev.decide(input('¿cuál es el horario de mi negocio?'));
  assert.deepEqual([d.source, d.audit, d.classification.actionClass], ['deterministic_fallback', ';jev=model_not_evaluated', 'read_only']);
  d.commit();
  await jev.drain();
  assert.deepEqual([rows[0]?.status, rows[0]?.resolvedModel], ['evaluated', 'jev-2.0.0-new']);
});

for (const [name, respond, code] of [
  ['HTTP 503 (no retry)', async () => new Response('busy', { status: 503 }), 'http_503'],
  ['HTTP 401', async () => new Response('nope', { status: 401 }), 'http_401'],
  ['invalid JSON', async () => new Response('{not json', { status: 200 }), 'contract'],
  ['network failure', async () => { throw new TypeError('fetch failed'); }, 'network'],
] as const) {
  test(`DEC-0029 unit: primary falls back to the rules on ${name}`, async (t) => {
    const logs = captureStdout(t);
    const fetch = stubFetch(t, respond);
    const { rows, store } = fakeStore();
    const jev = classifier('primary', store);
    const d = await jev.decide(input('cambia el teléfono de mi página a 999 888 777'));
    assert.deepEqual([d.source, d.audit, d.classification.actionClass], ['deterministic_fallback', ';jev=jev_unavailable', 'preview_required']);
    d.commit();
    await jev.drain();
    assert.equal(fetch.mock.callCount(), 1, 'one attempt, no retries');
    assert.deepEqual([rows[0]?.status, rows[0]?.errorCode, rows[0]?.jevIntent], ['unavailable', code, null]);
    assert.ok(!logs().includes(FAKE_KEY));
  });
}

test('DEC-0029 unit: a call past its deadline falls back (timeout)', async (t) => {
  stubFetch(t, (init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  }));
  const { rows, store } = fakeStore();
  const jev = classifier('primary', store, new JevClient({ provider: 'typesafe', apiKey: FAKE_KEY, timeoutMs: 20, maxAttempts: 1 }));
  const d = await jev.decide(input('¿cuál es el horario?'));
  d.commit();
  await jev.drain();
  assert.equal(d.source, 'deterministic_fallback');
  assert.equal(rows[0]?.errorCode, 'timeout');
});

test('DEC-0032 unit: an exhausted budget sends nothing and falls back', async (t) => {
  const fetch = stubFetch(t, async () => new Response(jevBody(), { status: 200 }));
  const { rows, store } = fakeStore({ spent: 1 });
  const jev = classifier('primary', store);
  const d = await jev.decide(input('¿cuál es el horario?'));
  d.commit();
  await jev.drain();
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(d.source, 'deterministic_fallback');
  assert.equal(rows[0]?.errorCode, 'budget_exhausted');
});

test('APR-0002 unit: abandoned requests persist nothing; oversized messages never leave the process', async (t) => {
  const fetch = stubFetch(t, async () => new Response(jevBody(), { status: 200 }));
  const { rows, store } = fakeStore();
  const jev = classifier('shadow', store);
  (await jev.decide(input('¿cuál es el horario?'))).abandon();
  await jev.drain();
  assert.equal(rows.length, 0);

  (await jev.decide(input(`¿cuál es el horario? ${'x'.repeat(JEV_MAX_MESSAGE_BYTES)}`))).commit();
  await jev.drain();
  assert.equal(fetch.mock.callCount(), 1, 'only the abandoned (normal-size) message was sent');
  assert.equal(rows[0]?.errorCode, 'message_too_large');
});

test('APR-0002 unit: persistence failures are contained (drain resolves, nothing thrown)', async (t) => {
  stubFetch(t, async () => new Response(jevBody(), { status: 200 }));
  const { store } = fakeStore({ failInsert: true });
  const jev = classifier('shadow', store);
  (await jev.decide(input('¿cuál es el horario?'))).commit();
  await assert.doesNotReject(jev.drain());
});

test('APR-0002 unit: disabled config builds no classifier (no client, no calls)', () => {
  assert.equal(createJevClassifier({ mode: 'disabled' }, fakeStore().store), undefined);
});
