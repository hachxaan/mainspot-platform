/**
 * FB-3 (DEC-0078; SRC-007 «Adelante», RES-MSP-20261106-FB-AI-01) — presupuesto experimental del laboratorio separado
 * del comercial operativo, ambos bajo el techo global estricto `lab_total`, y gasto atribuido por canal.
 * Integración con PostgreSQL real, AI_ENVIRONMENT=lab y Anthropic SUSTITUIDO en memoria (fetch inyectado en el
 * despachador; cualquier otro destino falla y queda registrado). SIMULATED_REGRESSION: no acredita proveedor,
 * facturación ni calidad reales.
 *
 * Cubre: con grant o dentro de una evaluación de ruta, la reserva usa `lab_experiment` (más `lab_total`) y nunca `tenant_day`; sin fila `lab_experiment`
 * (no hay valor sembrado) o agotada, se deniega con ese ámbito; la operación se deniega sin `tenant_day` o con él
 * agotado aunque el laboratorio tenga margen; `lab_total` deniega a ambas; N reservas paralelas de los dos propósitos
 * nunca superan `lab_total`; el informe de plataforma cuadra con el libro por propósito, canal y caso de uso, y
 * `/health`, `/ai/costs` y el panel son coherentes con él; validaciones de PUT /ai/budgets/:scope.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { api, authHeaders, bootApi, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows, type TestTenant } from '../helpers/tenants.ts';
import { USE_CASE_SEEDS } from '../../src/ai/catalog.ts';
import { AiDispatcher, type InvokeContext, type InvokeResult } from '../../src/ai/dispatcher.ts';
import { runEvalSuite } from '../../src/ai/evals.ts';
import { SCOPE_SPENT_FILTER, SPENT_SQL, UTC_DAY_START_SQL } from '../../src/ai/governance.ts';
import { currentStep, totpAt } from '../../src/platform/auth.ts';

const INSIGHTS = 'business.insights.generate';
const FB_REPLY = 'engagement.facebook.comment.reply';
const FB_CLASSIFY = 'engagement.facebook.comment.classify';
const WEB_IMAGE = 'website.image.generate';
const HAIKU = 'an:claude-haiku-5-5';
const ACTOR = 'test:fb3-budgets';
const VALUES = { period: '2026-10-24 a 2026-10-30', metrics: { days_with_activity: 1 } };
const LIMITS = { conversations: 10, website: 1, social_posts: 5, reviews_managed: 5 };
const REASON = 'Prueba local: presupuestos segregados del laboratorio';
/** Canal declarado por el catálogo para cada caso de uso (el mismo mapa que rellena la migración 0039). */
const CHANNEL = new Map(USE_CASE_SEEDS.map((uc) => [uc.id, uc.channel]));

let t: TestApi;
let dispatcher: AiDispatcher;
let adminToken = '';
let adminId = '';
let engToken = '';
let supportToken = '';
let labRoute = '';
let opRoute = '';
let maxCost = 0;
const createdRoutes: string[] = [];
const leaked: string[] = [];
const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;

/** Llamadas que llegaron al proveedor y compuerta para retenerlas (concurrencia). */
const provider = { calls: 0, gate: Promise.resolve() };

/** Anthropic Messages en memoria: salida válida de insights/v1 con 1000/1000 tokens (Haiku 5.5 ⇒ USD 0.0006 estimado). */
const fakeAnthropic: typeof fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== 'https://api.anthropic.com' || url.pathname !== '/v1/messages') {
    leaked.push(url.host);
    throw new TypeError(`salida de red bloqueada en la prueba: ${url.host}`);
  }
  provider.calls += 1;
  await provider.gate;
  const text = JSON.stringify({ status: 'abstained', summary: 'Sin datos suficientes.', highlights: [], recommendations: [], abstain_reason: 'pocos días' });
  return new Response(JSON.stringify({ id: `msg_fb3_${provider.calls}`, model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 1000 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const FAKE_COST = 0.0006;

async function platformLogin(roles: Array<'platform_admin' | 'ai_engineer' | 'platform_support'>): Promise<{ token: string; id: string }> {
  const login = `fb3-${roles[0]}-${randomUUID().slice(0, 6)}`;
  const user = await t.handle.platformAuth.createUser({ login, displayName: `FB-3 ${roles[0]}`, password: 'Plataforma-Fb3-2026', roles, grantedBy: 'test' });
  const r = await api(t.baseUrl, '/api/platform/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password: 'Plataforma-Fb3-2026', code: totpAt(user.totp_secret, currentStep()) }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body.token as string, id: user.platform_user_id };
}

before(async () => {
  process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests-fb3';
  t = await bootApi({ aiEnvironment: 'lab', aiRealProviders: true, platformMfaKey: randomBytes(32).toString('base64') }, 10);
  ({ token: adminToken, id: adminId } = await platformLogin(['platform_admin']));
  engToken = (await platformLogin(['ai_engineer'])).token;
  supportToken = (await platformLogin(['platform_support'])).token;
  // Rutas propias (se retiran al final): una candidata DRAFT autorizable por grant y una operativa aprobada y fijada.
  const reg = t.handle.dispatcher.registry;
  const seeded = (await t.pool.query<{ prompt_revision_id: string; params: Record<string, unknown>; max_cost_usd: string }>(
    `SELECT prompt_revision_id, params, max_cost_usd FROM ai_route_revision WHERE use_case_id = $1 AND model_id = $2 AND status <> 'RETIRED' ORDER BY version LIMIT 1`, [INSIGHTS, HAIKU])).rows[0];
  assert.ok(seeded, 'candidata Anthropic sembrada (DEC-0074)');
  maxCost = Number(seeded.max_cost_usd);
  assert.ok(maxCost >= 0.01, 'la reserva (costo máximo de la ruta) supera con holgura el costo real simulado');
  for (const note of ['FB-3 prueba: candidata de laboratorio (DRAFT)', 'FB-3 prueba: ruta operativa fijada']) {
    const route = await reg.createRoute({ useCaseId: INSIGHTS, modelId: HAIKU, promptRevisionId: seeded.prompt_revision_id, params: seeded.params, maxCostUsd: maxCost, changeNote: note, actor: ACTOR });
    createdRoutes.push(route.route_id);
  }
  [labRoute, opRoute] = createdRoutes as [string, string];
  await t.pool.query(`UPDATE ai_route_revision SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE route_id = $1`, [opRoute, ACTOR]);
  dispatcher = new AiDispatcher({ pool: t.pool, config: { ...t.handle.config, aiRealProviders: true, aiEnvironment: 'lab' }, fetchImpl: fakeAnthropic, registry: reg, lab: t.handle.dispatcher.lab });
  // Estado documentado: el laboratorio no tiene presupuesto hasta que la plataforma lo fija.
  await t.pool.query(`DELETE FROM ai_budget WHERE scope = 'lab_experiment'`);
});

after(async () => {
  try {
    if (t) {
      await t.pool.query(`UPDATE ai_route_revision SET status = 'RETIRED' WHERE route_id = ANY($1)`, [createdRoutes]);
      await t.pool.query(`DELETE FROM ai_budget WHERE scope = 'lab_experiment'`);
    }
  } finally {
    if (t) {
      t.handle.aiJobs.stop();
      await t.close();
    }
    if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
  }
  assert.deepEqual(leaked, [], 'ninguna petición salió a la red');
});

// ------------------------------------------------------------------ utilidades

function platform(token: string, path: string, method = 'GET', body?: unknown) {
  return api(t.baseUrl, `/api/platform${path}`, { method, headers: authHeaders(token), body: body === undefined ? undefined : JSON.stringify(body) });
}

function panel(token: string, path: string, headers: Record<string, string> = {}) {
  return api(t.baseUrl, `/api/backoffice${path}`, { headers: authHeaders(token, headers) });
}

/** Step-up renovado por BD (determinista: no depende de que el reloj TOTP avance de paso). */
async function putBudget(scope: string, body: Record<string, unknown>, token = adminToken) {
  await t.pool.query('UPDATE platform_session SET step_up_at = now() WHERE platform_user_id = $1', [adminId]);
  return platform(token, `/ai/budgets/${scope}`, 'PUT', body);
}

async function putBudgetOk(scope: string, limitUsd: number): Promise<void> {
  const r = await putBudget(scope, { limit_usd: limitUsd, reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

/** NUMERIC(12,4): redondeos hacia arriba/abajo a 4 decimales (sin ruido de coma flotante). */
function ceil4(value: number): number {
  return Math.ceil(Math.round(value * 1e8) / 1e4) / 1e4;
}
function floor4(value: number): number {
  return Math.floor(Math.round(value * 1e8) / 1e4) / 1e4;
}

/** Gasto efectivo de pago con un predicado de `governance.ts` (estado de partida para fijar límites con margen exacto). */
async function spent(filter = 'true', params: unknown[] = []): Promise<number> {
  return Number((await t.pool.query<{ spent: string }>(`${SPENT_SQL} AND ${filter}`, params)).rows[0]?.spent ?? 0);
}

async function issueGrant(owner: TestTenant): Promise<string> {
  await t.pool.query('UPDATE platform_session SET step_up_at = now() WHERE platform_user_id = $1', [adminId]);
  const r = await platform(adminToken, '/ai/lab/grants', 'POST', { tenant_id: owner.tenant, user_id: owner.userId, route_ids: [labRoute], minutes: 30, reason: 'Prueba local de presupuestos del laboratorio' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.grant.grant_id as string;
}

/** Fila `tenant_day` propia del negocio (la que prefiere la reserva sobre la por defecto). */
async function setOwnTenantDay(tenant: string, limitUsd: number): Promise<void> {
  await t.pool.query(
    `INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by) VALUES ($1, 'tenant_day', $2, $3, 'test: FB-3', 'test')
     ON CONFLICT (scope, (COALESCE(tenant_id, '-'))) DO UPDATE SET limit_usd = EXCLUDED.limit_usd`, [`bud_${randomUUID()}`, tenant, limitUsd]);
}

interface BudgetRow { budget_id: string; scope: string; limit_usd: string; source: string; updated_by: string; updated_at: Date }

async function globalRow(scope: string): Promise<BudgetRow | undefined> {
  return (await t.pool.query<BudgetRow>('SELECT budget_id, scope, limit_usd, source, updated_by, updated_at FROM ai_budget WHERE scope = $1 AND tenant_id IS NULL', [scope])).rows[0];
}

/** Vuelve a dejar una fila global exactamente como estaba (o la quita si no existía). */
async function restoreGlobal(scope: string, original: BudgetRow | undefined): Promise<void> {
  await t.pool.query('DELETE FROM ai_budget WHERE scope = $1 AND tenant_id IS NULL', [scope]);
  if (original) {
    await t.pool.query('INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by, updated_at) VALUES ($1, $2, NULL, $3, $4, $5, $6)',
      [original.budget_id, original.scope, original.limit_usd, original.source, original.updated_by, original.updated_at]);
  }
}

/** Operación: ruta aprobada fijada, sin grant. Laboratorio: el grant resuelve su ruta DRAFT (`manual_lab`). */
function invoke(owner: TestTenant, opts: { grant?: string; key?: string } = {}): Promise<InvokeResult<unknown>> {
  const key = opts.key ?? `fb3-${randomUUID()}`;
  const ctx: InvokeContext = { requestId: key, idempotencyKey: key, tenantId: owner.tenant, actorId: owner.userId, actorKind: 'tenant_user', origin: 'test.fb3',
    ...(opts.grant ? { labGrantId: opts.grant } : { pinnedRouteId: opRoute }) };
  return dispatcher.invokeStructured(INSIGHTS, ctx, VALUES);
}

function denied(r: InvokeResult<unknown>): [boolean, string | false, string | false] {
  return [r.ok, !r.ok && r.code, !r.ok && r.reason];
}

interface LedgerRow { status: string; error_code: string | null; detail: string | null; assignment: string | null; lab_grant_id: string | null; reserved_usd: string; cost_usd: string | null; cost_source: string }

async function ledger(invocationId: string | null): Promise<LedgerRow | undefined> {
  return (await t.pool.query<LedgerRow>(
    `SELECT status, error_code, validation->>'detail' AS detail, assignment, lab_grant_id, reserved_usd, cost_usd, cost_source FROM ai_invocation WHERE invocation_id = $1`, [invocationId])).rows[0];
}

/** Promesa con su resolvedor (el `lib` del tsconfig no incluye `Promise.withResolvers`). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// ------------------------------------------------------------------ reserva por propósito

test('FB-3: con grant la reserva usa lab_experiment y nunca tenant_day; sin fila (sin valor sembrado) o agotada por su propio gasto se deniega con ese ámbito; el diario del negocio queda intacto', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_fb3a');
  const grant = await issueGrant(a);
  await setOwnTenantDay(a.tenant, 0); // el negocio no tiene ningún margen operativo
  const calls0 = provider.calls;

  const missing = await invoke(a, { grant });
  assert.deepEqual(denied(missing), [false, 'budget_exhausted', 'lab_experiment'], 'sin presupuesto experimental el laboratorio no gasta');
  const missingRow = await ledger(!missing.ok ? missing.invocationId : null);
  assert.deepEqual([missingRow?.status, missingRow?.error_code, missingRow?.detail, missingRow?.assignment, missingRow?.lab_grant_id, Number(missingRow?.reserved_usd)],
    ['blocked', 'budget_exhausted', 'lab_experiment', 'manual_lab', grant, 0], 'el bloqueo queda trazado con el ámbito que falta');
  assert.equal(provider.calls, calls0);

  // La plataforma deja margen para exactamente una reserva (redondeo de NUMERIC(12,4) hacia arriba).
  await putBudgetOk('lab_experiment', ceil4(await spent(SCOPE_SPENT_FILTER.lab_experiment) + maxCost));
  const ok = await invoke(a, { grant });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.route.assignment, 'manual_lab');
  assert.equal(provider.calls, calls0 + 1);
  const paid = await ledger(ok.invocationId);
  assert.deepEqual([paid?.status, paid?.lab_grant_id, Number(paid?.reserved_usd), Number(paid?.cost_usd), paid?.cost_source], ['succeeded', grant, maxCost, FAKE_COST, 'estimated']);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM ai_invocation WHERE tenant_id = $1 AND lab_grant_id IS NULL', [a.tenant]), 0,
    'con tenant_day en 0 la reserva solo pudo salir del presupuesto experimental');

  const exhausted = await invoke(a, { grant });
  assert.deepEqual(denied(exhausted), [false, 'budget_exhausted', 'lab_experiment'], 'el costo real gastado ya no deja margen para otra reserva');
  assert.equal((await ledger(!exhausted.ok ? exhausted.invocationId : null))?.detail, 'lab_experiment');
  assert.equal(provider.calls, calls0 + 1, 'agotado: sin llamada al proveedor');

  // El diario del negocio no perdió nada: con margen para una reserva operativa exacta, la operación gasta una vez.
  const labSpent = await spent(SCOPE_SPENT_FILTER.lab_experiment);
  await setOwnTenantDay(a.tenant, maxCost);
  const op = await invoke(a);
  assert.ok(op.ok, JSON.stringify(op));
  assert.equal(op.route.assignment, 'pinned');
  assert.equal(await spent(SCOPE_SPENT_FILTER.lab_experiment), labSpent, 'la operación no consume el presupuesto experimental');
  const opAgain = await invoke(a);
  assert.deepEqual(denied(opAgain), [false, 'budget_exhausted', 'tenant_day'], 'agotado por su propio gasto operativo');
  assert.equal(provider.calls, calls0 + 2);
});

test('FB-3: la operación se deniega sin tenant_day (propio ni por defecto) o con él agotado aunque el laboratorio tenga margen; el laboratorio sigue gastando', async () => {
  const b = await createTenantWithPlan(t, LIMITS, 'client_fb3b');
  const grant = await issueGrant(b);
  await putBudgetOk('lab_experiment', ceil4(await spent(SCOPE_SPENT_FILTER.lab_experiment)) + 1);
  const calls0 = provider.calls;

  await setOwnTenantDay(b.tenant, 0);
  const exhausted = await invoke(b);
  assert.deepEqual(denied(exhausted), [false, 'budget_exhausted', 'tenant_day']);
  assert.ok((await invoke(b, { grant })).ok, 'el laboratorio tiene su propio margen');

  await t.pool.query(`DELETE FROM ai_budget WHERE scope = 'tenant_day' AND tenant_id = $1`, [b.tenant]);
  const fallback = await globalRow('tenant_day');
  assert.ok(fallback, 'tenant_day por defecto sembrado (OPS-0001)');
  await t.pool.query('DELETE FROM ai_budget WHERE budget_id = $1', [fallback.budget_id]);
  try {
    const missing = await invoke(b);
    assert.deepEqual(denied(missing), [false, 'budget_exhausted', 'tenant_day'], 'sin ninguna fila diaria el negocio no gasta (fail-closed)');
    const lab = await invoke(b, { grant });
    assert.ok(lab.ok, 'el laboratorio no depende de tenant_day');
    const rows = (await t.pool.query<{ detail: string | null; lab_grant_id: string | null; status: string }>(
      `SELECT validation->>'detail' AS detail, lab_grant_id, status FROM ai_invocation WHERE tenant_id = $1 ORDER BY created_at, invocation_id`, [b.tenant])).rows;
    assert.deepEqual(rows.map((r) => [r.status, r.detail, r.lab_grant_id]), [
      ['blocked', 'tenant_day', null], ['succeeded', null, grant], ['blocked', 'tenant_day', null], ['succeeded', null, grant],
    ]);
  } finally {
    await restoreGlobal('tenant_day', fallback);
  }
  assert.equal(provider.calls, calls0 + 2, 'solo el laboratorio llegó al proveedor');
});

test('FB-3 evaluaciones (revisión 1, F-03): evaluar una ruta de pago es gasto experimental: sin lab_experiment se deniega con ese ámbito sin llamar al proveedor; con margen reserva de lab_experiment y el informe la atribuye a laboratorio', async () => {
  const reg = t.handle.dispatcher.registry;
  const seeded = (await t.pool.query<{ prompt_revision_id: string; params: Record<string, unknown> }>(
    'SELECT prompt_revision_id, params FROM ai_route_revision WHERE route_id = $1', [labRoute])).rows[0];
  assert.ok(seeded);
  const route = await reg.createRoute({ useCaseId: INSIGHTS, modelId: HAIKU, promptRevisionId: seeded.prompt_revision_id, params: seeded.params, maxCostUsd: maxCost,
    changeNote: 'FB-3 prueba: candidata evaluada (DRAFT)', actor: ACTOR });
  createdRoutes.push(route.route_id);
  const suite = (await t.pool.query<{ suite_id: string; n: number }>('SELECT suite_id, jsonb_array_length(cases) AS n FROM ai_eval_suite WHERE use_case_id = $1 ORDER BY suite_id LIMIT 1', [INSIGHTS])).rows[0];
  assert.ok(suite && suite.n > 0, 'suite de insights sembrada');
  const evalRows = (runId: string) => t.pool.query<{ status: string; error_code: string | null; detail: string | null; tenant_id: string | null; lab_grant_id: string | null; assignment: string }>(
    `SELECT status, error_code, validation->>'detail' AS detail, tenant_id, lab_grant_id, assignment FROM ai_invocation WHERE eval_run_id = $1 ORDER BY created_at, invocation_id`, [runId]);

  await t.pool.query(`DELETE FROM ai_budget WHERE scope = 'lab_experiment'`);
  const calls0 = provider.calls;
  const blocked = await runEvalSuite(t.pool, dispatcher, suite.suite_id, route.route_id, ACTOR);
  assert.equal(blocked.status, 'failed');
  const blockedRows = (await evalRows(blocked.run_id)).rows;
  assert.equal(blockedRows.length, suite.n);
  assert.ok(blockedRows.every((r) => r.status === 'blocked' && r.error_code === 'budget_exhausted' && r.detail === 'lab_experiment' && r.assignment === 'eval' && r.tenant_id === null && r.lab_grant_id === null),
    JSON.stringify(blockedRows));
  assert.equal(provider.calls, calls0, 'sin presupuesto experimental ninguna evaluación de pago llega al proveedor');

  const operationalToday = `i.lab_grant_id IS NULL AND i.eval_run_id IS NULL AND i.created_at >= ${UTC_DAY_START_SQL}`;
  const labBefore = await spent(SCOPE_SPENT_FILTER.lab_experiment);
  const opBefore = await spent(operationalToday);
  await putBudgetOk('lab_experiment', ceil4(labBefore + suite.n * maxCost));
  const paid = await runEvalSuite(t.pool, dispatcher, suite.suite_id, route.route_id, ACTOR);
  const paidRows = (await evalRows(paid.run_id)).rows;
  assert.ok(paidRows.length === suite.n && paidRows.every((r) => r.status === 'succeeded'), JSON.stringify(paidRows));
  assert.equal(provider.calls, calls0 + suite.n);
  assert.ok(Math.abs(await spent(SCOPE_SPENT_FILTER.lab_experiment) - (labBefore + suite.n * FAKE_COST)) < 1e-9, 'el gasto de la evaluación cuenta en lab_experiment');
  assert.ok(Math.abs(await spent(operationalToday) - opBefore) < 1e-9, 'y nada en la operación comercial');

  const spend = await platform(adminToken, '/ai/spend');
  assert.equal(spend.status, 200, JSON.stringify(spend.body));
  const lines = (spend.body.spend.by_use_case as Array<{ purpose: string; use_case_id: string; calls_total: number }>).filter((l) => l.use_case_id === INSIGHTS);
  const labLine = lines.find((l) => l.purpose === 'lab');
  assert.ok(labLine && labLine.calls_total >= suite.n, `el informe atribuye la evaluación a laboratorio: ${JSON.stringify(lines)}`);
});

test('FB-3: el techo global lab_total cuenta operación y laboratorio: rebajado al gasto acumulado deniega a ambos aunque tengan margen propio', async () => {
  const c = await createTenantWithPlan(t, LIMITS, 'client_fb3c');
  const grant = await issueGrant(c);
  await setOwnTenantDay(c.tenant, 1);
  // Primero el laboratorio (debe caber bajo el techo vigente); rebajar después el techo global nunca se bloquea.
  await putBudgetOk('lab_experiment', ceil4(await spent(SCOPE_SPENT_FILTER.lab_experiment)) + 1);
  const original = await globalRow('lab_total');
  assert.ok(original, 'techo acumulado sembrado (DEC-0068)');
  const calls0 = provider.calls;
  try {
    await putBudgetOk('lab_total', floor4(await spent()));
    const op = await invoke(c);
    const lab = await invoke(c, { grant });
    assert.deepEqual([denied(op), denied(lab)], [[false, 'budget_exhausted', 'lab_total'], [false, 'budget_exhausted', 'lab_total']]);
    const [opRow, labRow] = [await ledger(!op.ok ? op.invocationId : null), await ledger(!lab.ok ? lab.invocationId : null)];
    assert.deepEqual([opRow?.detail, opRow?.lab_grant_id, labRow?.detail, labRow?.lab_grant_id], ['lab_total', null, 'lab_total', grant]);
    assert.equal(provider.calls, calls0);
  } finally {
    await restoreGlobal('lab_total', original);
  }
});

test('FB-3 concurrencia: N invocaciones de pago en paralelo, de laboratorio y de operación, nunca superan lab_total (un solo candado para las dos)', { timeout: 60_000 }, async () => {
  const e = await createTenantWithPlan(t, LIMITS, 'client_fb3e');
  const grant = await issueGrant(e);
  await setOwnTenantDay(e.tenant, 1);
  await putBudgetOk('lab_experiment', ceil4(await spent(SCOPE_SPENT_FILTER.lab_experiment)) + 1);
  const original = await globalRow('lab_total');
  assert.ok(original);
  const K = 2;
  const N = 6;
  const gate = deferred();
  provider.gate = gate.promise;
  const calls0 = provider.calls;
  try {
    const before0 = await spent();
    // Margen para exactamente K reservas en curso: la siguiente pediría K + 1 costos máximos.
    const limit = ceil4(before0) + K * maxCost;
    await putBudgetOk('lab_total', limit);
    // Las que no caben terminan solas; las reservadas quedan retenidas en el proveedor hasta abrir la compuerta. Una
    // reserva de más dejaría una sin terminar y la prueba vencería su plazo.
    const early = deferred();
    let settled = 0;
    const keys = Array.from({ length: N }, (_, i) => `fb3-par-${i}-${randomUUID()}`);
    const pending = keys.map((key, i) => invoke(e, { key, grant: i % 2 === 0 ? grant : undefined }).then((r) => {
      settled += 1;
      if (settled === N - K) early.resolve();
      return r;
    }));
    await early.promise;
    const rows = (await t.pool.query<{ status: string; detail: string | null; reserved_usd: string }>(
      `SELECT status, validation->>'detail' AS detail, reserved_usd FROM ai_invocation WHERE tenant_id = $1 AND idempotency_key = ANY($2)`, [e.tenant, keys])).rows;
    const running = rows.filter((r) => r.status === 'running');
    const blocked = rows.filter((r) => r.status === 'blocked');
    assert.equal(running.length, K, 'con todas en vuelo, solo caben K reservas');
    assert.equal(blocked.length, N - K);
    assert.ok(blocked.every((r) => r.detail === 'lab_total'), 'el resto se bloquea por el techo global, sea de laboratorio o de operación');
    assert.ok(before0 + running.reduce((s, r) => s + Number(r.reserved_usd), 0) <= limit + 1e-9, 'lo reservado en curso nunca supera el techo');
    gate.resolve();
    const results = await Promise.all(pending);
    assert.equal(results.filter((r) => r.ok).length, K);
    assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === 'budget_exhausted' && r.reason === 'lab_total'));
    assert.equal(provider.calls, calls0 + K, 'solo las reservadas llegaron al proveedor');
    assert.ok(await spent() <= limit + 1e-9, 'el gasto acumulado tampoco supera el techo');
  } finally {
    gate.resolve();
    provider.gate = Promise.resolve();
    await restoreGlobal('lab_total', original);
  }
});

// ------------------------------------------------------------------ atribución e informe

interface Fixture { tenant: string | null; grant: string | null; useCase: string; provider: string; status: 'running' | 'succeeded' | 'failed' | 'blocked'; reserved: number; cost: number | null; ageDays: number }
interface Line { purpose: string | null; channel: string | null; use_case_id: string | null; calls_today: number; calls_month: number; calls_total: number; today_usd: number; month_usd: number; total_usd: number }
interface Report {
  budgets: Array<{ scope: string; spent_usd: number; limit_usd: number | null; missing: boolean; remaining_usd: number | null }>;
  tenant_day: Array<{ tenant_id: string; spent_usd: number; limit_usd: number | null; own_limit: boolean; missing: boolean }>;
  spend: { by_use_case: Line[]; by_channel: Line[]; by_purpose: Line[]; total: Line };
  typesafe: { decision: string; day: string; spent_usd: number };
}

const PAID: Record<string, true> = { anthropic: true, openai: true, openrouter: true };
const FIELDS = ['calls_today', 'calls_month', 'calls_total', 'today_usd', 'month_usd', 'total_usd'] as const;

async function report(): Promise<Report> {
  const r = await platform(adminToken, '/ai/spend');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as Report;
}

/** Diferencia entre dos informes por grupo (`purpose|channel|use_case`), para cada campo. */
function delta(before: Line[], after: Line[]): Map<string, Record<(typeof FIELDS)[number], number>> {
  const key = (l: Line) => `${l.purpose}|${l.channel}|${l.use_case_id}`;
  const out = new Map<string, Record<(typeof FIELDS)[number], number>>();
  for (const [lines, sign] of [[after, 1], [before, -1]] as const) {
    for (const l of lines) {
      const acc = out.get(key(l)) ?? { calls_today: 0, calls_month: 0, calls_total: 0, today_usd: 0, month_usd: 0, total_usd: 0 };
      for (const f of FIELDS) acc[f] += sign * l[f];
      out.set(key(l), acc);
    }
  }
  return out;
}

function assertDelta(actual: Map<string, Record<(typeof FIELDS)[number], number>>, expected: Map<string, Record<(typeof FIELDS)[number], number>>, what: string): void {
  for (const k of new Set([...actual.keys(), ...expected.keys()])) {
    for (const f of FIELDS) {
      const a = actual.get(k)?.[f] ?? 0;
      const e = expected.get(k)?.[f] ?? 0;
      assert.ok(Math.abs(a - e) < 1e-9, `${what} ${k} ${f}: informe ${a}, libro ${e}`);
    }
  }
}

test('FB-3 atribución: el informe de plataforma cuadra con el libro por propósito × canal × caso de uso (hoy, mes y acumulado) y por ámbito; /health, /ai/costs y el panel son coherentes y el panel no expone a otros negocios', async () => {
  assert.deepEqual((await t.pool.query<{ use_case_id: string; channel: string }>('SELECT use_case_id, channel FROM ai_use_case WHERE use_case_id = ANY($1) ORDER BY use_case_id', [[...CHANNEL.keys()]])).rows,
    [...CHANNEL.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([use_case_id, channel]) => ({ use_case_id, channel })), 'cada caso de uso sembrado tiene el canal que declara el catálogo');
  assert.equal((await platform(supportToken, '/ai/spend')).status, 403, 'soporte no lee costos');
  assert.equal((await platform(engToken, '/ai/spend')).status, 200, 'ingeniería sí');

  const c = await createTenantWithPlan(t, LIMITS, 'client_fb3r');
  const d = await createTenantWithPlan(t, LIMITS, 'client_fb3s');
  const grant = await issueGrant(c);
  await t.pool.query(`DELETE FROM ai_budget WHERE scope = 'lab_experiment'`);
  const model = `fx:${randomUUID().slice(0, 8)}`;
  // Libro sintético propio: cada estado, proveedor, propósito, canal y antigüedad que el informe debe tratar distinto.
  const fixtures: Fixture[] = [
    { tenant: c.tenant, grant: null, useCase: FB_REPLY, provider: 'anthropic', status: 'succeeded', reserved: 0.01, cost: 0.000123, ageDays: 0 },
    { tenant: c.tenant, grant: null, useCase: FB_REPLY, provider: 'anthropic', status: 'failed', reserved: 0.01, cost: null, ageDays: 0 },
    { tenant: c.tenant, grant: null, useCase: INSIGHTS, provider: 'anthropic', status: 'running', reserved: 0.02, cost: null, ageDays: 0 },
    { tenant: c.tenant, grant: null, useCase: INSIGHTS, provider: 'anthropic', status: 'blocked', reserved: 0, cost: null, ageDays: 0 },
    { tenant: c.tenant, grant, useCase: INSIGHTS, provider: 'anthropic', status: 'succeeded', reserved: 0.02, cost: 0.000456, ageDays: 0 },
    { tenant: c.tenant, grant, useCase: WEB_IMAGE, provider: 'openai', status: 'succeeded', reserved: 0.08, cost: 0.0411, ageDays: 0 },
    { tenant: d.tenant, grant: 'lbg_fixture_otro_negocio', useCase: INSIGHTS, provider: 'anthropic', status: 'succeeded', reserved: 0.02, cost: 0.000789, ageDays: 0 },
    { tenant: d.tenant, grant: null, useCase: FB_REPLY, provider: 'anthropic', status: 'succeeded', reserved: 0.01, cost: 0.000321, ageDays: 2 },
    { tenant: c.tenant, grant: null, useCase: FB_CLASSIFY, provider: 'typesafe', status: 'succeeded', reserved: 0, cost: 0.000042, ageDays: 0 },
    { tenant: c.tenant, grant: null, useCase: FB_REPLY, provider: 'simulated', status: 'succeeded', reserved: 0, cost: 0, ageDays: 0 },
    { tenant: null, grant: null, useCase: INSIGHTS, provider: 'anthropic', status: 'succeeded', reserved: 0.02, cost: 0.000222, ageDays: 0 },
  ];
  const ids = fixtures.map(() => `inv_fb3_${randomUUID()}`);
  const before0 = await report();
  try {
    for (const [i, f] of fixtures.entries()) {
      await t.pool.query(
        `INSERT INTO ai_invocation (invocation_id, request_id, idempotency_key, tenant_id, actor_id, actor_kind, origin, use_case_id, model_id, provider_id, policy_version,
           status, reserved_usd, cost_usd, cost_source, lab_grant_id, trace_id, created_at)
         VALUES ($1, 'fixture', $1, $2, 'system:test', 'system', 'test.fb3.report', $3, $4, $5, 'fixture', $6, $7, $8, $9, $10, 'fixture', now() - make_interval(days => $11))`,
        [ids[i], f.tenant, f.useCase, model, f.provider, f.status, f.reserved, f.cost, f.cost === null ? 'unknown' : 'estimated', f.grant, f.ageDays]);
    }
    const now = (await t.pool.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now;
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    // Cálculo independiente del libro: de pago, no bloqueada; reserva mientras sigue en curso, si no costo (o reserva si se desconoce).
    const counted = fixtures.filter((f) => PAID[f.provider] && f.status !== 'blocked').map((f) => {
      const at = now.getTime() - f.ageDays * 86_400_000;
      return { ...f, usd: f.status === 'running' ? f.reserved : f.cost ?? f.reserved, today: at >= dayStart, month: at >= monthStart, purpose: f.grant ? 'lab' : 'operational', channel: CHANNEL.get(f.useCase)! };
    });
    const expected = (keyOf: (x: (typeof counted)[number]) => string) => {
      const out = new Map<string, Record<(typeof FIELDS)[number], number>>();
      for (const x of counted) {
        const acc = out.get(keyOf(x)) ?? { calls_today: 0, calls_month: 0, calls_total: 0, today_usd: 0, month_usd: 0, total_usd: 0 };
        acc.calls_total += 1; acc.total_usd += x.usd;
        if (x.month) { acc.calls_month += 1; acc.month_usd += x.usd; }
        if (x.today) { acc.calls_today += 1; acc.today_usd += x.usd; }
        out.set(keyOf(x), acc);
      }
      return out;
    };
    const after0 = await report();
    assertDelta(delta(before0.spend.by_use_case, after0.spend.by_use_case), expected((x) => `${x.purpose}|${x.channel}|${x.useCase}`), 'caso de uso');
    assertDelta(delta(before0.spend.by_channel, after0.spend.by_channel), expected((x) => `${x.purpose}|${x.channel}|null`), 'canal');
    assertDelta(delta(before0.spend.by_purpose, after0.spend.by_purpose), expected((x) => `${x.purpose}|null|null`), 'propósito');
    assertDelta(delta([before0.spend.total], [after0.spend.total]), expected(() => 'null|null|null'), 'total');

    // Ámbitos: mismo cálculo que la reserva, sin contar dos veces.
    const scope = (r: Report, s: string) => r.budgets.find((b) => b.scope === s)!.spent_usd;
    const sum = (pick: (x: (typeof counted)[number]) => boolean) => counted.filter(pick).reduce((s, x) => s + x.usd, 0);
    for (const [s, expectedDelta] of [
      ['lab_total', sum(() => true)], ['platform_month', sum((x) => x.month)], ['lab_experiment', sum((x) => x.purpose === 'lab' && x.today)],
      ['tenant_day', sum((x) => x.purpose === 'operational' && x.today && x.tenant !== null)],
    ] as const) {
      assert.ok(Math.abs(scope(after0, s) - scope(before0, s) - expectedDelta) < 1e-9, `${s}: ${scope(after0, s) - scope(before0, s)} ≠ ${expectedDelta}`);
    }
    // Invariantes del informe completo.
    assert.ok(Math.abs(after0.spend.total.total_usd - scope(after0, 'lab_total')) < 1e-9, 'el total atribuido es el gasto del techo global');
    assert.ok(Math.abs(after0.spend.total.month_usd - scope(after0, 'platform_month')) < 1e-9);
    assert.ok(Math.abs((after0.spend.by_purpose.find((p) => p.purpose === 'lab')?.today_usd ?? 0) - scope(after0, 'lab_experiment')) < 1e-9, 'el laboratorio de hoy es el gasto de lab_experiment');
    assert.ok(Math.abs(after0.spend.by_use_case.reduce((s, l) => s + l.total_usd, 0) - after0.spend.total.total_usd) < 1e-9);
    const lab0 = after0.budgets.find((b) => b.scope === 'lab_experiment')!;
    assert.deepEqual([lab0.missing, lab0.limit_usd, lab0.remaining_usd], [true, null, null], 'sin fila: se informa como ausente');
    const cRow = after0.tenant_day.find((x) => x.tenant_id === c.tenant);
    assert.ok(cRow && Math.abs(cRow.spent_usd - sum((x) => x.tenant === c.tenant && x.purpose === 'operational' && x.today)) < 1e-9 && !cRow.own_limit && !cRow.missing,
      'el diario del negocio solo cuenta su operación de hoy, contra la fila por defecto');
    assert.equal(after0.tenant_day.find((x) => x.tenant_id === d.tenant), undefined, 'sin gasto operativo hoy ni fila propia no aparece');
    assert.equal(after0.typesafe.decision, 'DEC-0032');

    // /health y /ai/costs: mismas cifras y ámbitos; el costo registrado separa laboratorio y operación.
    const health = await platform(adminToken, '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body.budget_status, after0.budgets);
    assert.deepEqual([health.body.spend.today, health.body.spend.month, health.body.spend.lab_total], [after0.spend.total.today_usd, after0.spend.total.month_usd, after0.spend.total.total_usd]);
    assert.deepEqual(health.body.spend.by_purpose, after0.spend.by_purpose.map((p) => ({ purpose: p.purpose, today_usd: p.today_usd, month_usd: p.month_usd, total_usd: p.total_usd })));
    const costs = await platform(engToken, '/ai/costs');
    assert.equal(costs.status, 200);
    assert.deepEqual(costs.body.budget_status, after0.budgets);
    const byUseCase: Array<{ use_case_id: string; channel: string; model_id: string; purpose: string; calls: string; cost_usd: string }> = costs.body.by_use_case;
    const mine = byUseCase.filter((r) => r.model_id === model);
    // Costo registrado de cualquier proveedor y estado (incluidos TypeSafe, simulado y bloqueado), por propósito.
    const expectedCost = new Map<string, { channel: string; calls: number; cost: number }>();
    for (const f of fixtures) {
      const k = `${f.grant ? 'lab' : 'operational'}|${f.useCase}`;
      const acc = expectedCost.get(k) ?? { channel: CHANNEL.get(f.useCase)!, calls: 0, cost: 0 };
      acc.calls += 1;
      acc.cost += f.cost ?? 0;
      expectedCost.set(k, acc);
    }
    assert.deepEqual(mine.map((r) => `${r.purpose}|${r.use_case_id}`).sort(), [...expectedCost.keys()].sort(), 'una fila por propósito y caso de uso: nada se cuenta dos veces');
    for (const r of mine) {
      const e = expectedCost.get(`${r.purpose}|${r.use_case_id}`)!;
      assert.deepEqual([r.channel, Number(r.calls)], [e.channel, e.calls]);
      assert.ok(Math.abs(Number(r.cost_usd) - e.cost) < 1e-9);
    }

    // Panel: el diario del negocio es solo su operación; el laboratorio aparte y solo con un grant vigente, sin el gasto de otros.
    const own = sum((x) => x.tenant === c.tenant && x.purpose === 'operational' && x.today);
    const ownLab = sum((x) => x.tenant === c.tenant && x.purpose === 'lab' && x.today);
    const plain = await panel(c.token, '/ai/status');
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.ok(Math.abs(plain.body.budget_today_usd.spent - own) < 1e-9, `operativo ${plain.body.budget_today_usd.spent} ≠ ${own}`);
    assert.deepEqual([plain.body.budget_today_usd.limit, plain.body.budget_today_usd.missing, plain.body.lab], [Number((await globalRow('tenant_day'))!.limit_usd), false, null]);
    const withGrant = await panel(c.token, '/ai/status', { 'X-AI-Lab-Grant': grant });
    assert.equal(withGrant.status, 200, JSON.stringify(withGrant.body));
    assert.ok(Math.abs(withGrant.body.budget_today_usd.spent - own) < 1e-9, 'el grant no mezcla el gasto del laboratorio en el diario');
    const labMissing = withGrant.body.lab.budget;
    assert.deepEqual([labMissing.scope, labMissing.missing, labMissing.limit_usd], ['lab_experiment', true, null]);
    assert.ok(Math.abs(labMissing.spent_usd - ownLab) < 1e-9, `laboratorio del negocio ${labMissing.spent_usd} ≠ ${ownLab} (sin el de otros negocios)`);
    assert.ok(!('remaining_usd' in labMissing), 'sin margen global: revelaría el gasto de otros negocios');
    await putBudgetOk('lab_experiment', 0.5);
    const configured = (await panel(c.token, '/ai/status', { 'X-AI-Lab-Grant': grant })).body.lab.budget;
    assert.deepEqual([configured.missing, configured.limit_usd], [false, 0.5]);
    assert.equal((await panel(d.token, '/ai/status', { 'X-AI-Lab-Grant': grant })).status, 403, 'un grant ajeno no da acceso al estado del laboratorio');
  } finally {
    await t.pool.query('DELETE FROM ai_invocation WHERE invocation_id = ANY($1)', [ids]);
    await t.pool.query(`DELETE FROM ai_budget WHERE scope = 'lab_experiment'`);
  }
});

// ------------------------------------------------------------------ PUT /ai/budgets/:scope

test('FB-3 PUT /ai/budgets/:scope: platform_admin con step-up y motivo; lab_experiment y platform_month se crean si faltan (auditado antes → después); lab_experiment ≤ lab_total; lab_total y tenant_day solo se actualizan', async () => {
  await t.pool.query(`DELETE FROM ai_budget WHERE scope = 'lab_experiment'`);
  const month = await globalRow('platform_month');
  const cap = await globalRow('lab_total');
  assert.ok(cap, 'techo acumulado sembrado (DEC-0068)');
  const since = (await t.pool.query<{ now: Date }>('SELECT now() AS now')).rows[0]!.now;
  const labRows = () => countRows(t, `SELECT count(*) AS n FROM ai_budget WHERE scope = 'lab_experiment'`, []);
  try {
    for (const [scope, body, status, code] of [
      ['lab_exp', { limit_usd: 1, reason: REASON }, 400, 'validation_error'],
      ['lab_experiment', { limit_usd: null, reason: REASON }, 400, 'validation_error'],
      ['lab_experiment', { limit_usd: true, reason: REASON }, 400, 'validation_error'],
      ['lab_experiment', { limit_usd: '', reason: REASON }, 400, 'validation_error'],
      ['lab_experiment', { limit_usd: -0.01, reason: REASON }, 400, 'validation_error'],
      ['lab_experiment', { limit_usd: 1e8, reason: REASON }, 400, 'validation_error'],
      ['lab_experiment', { limit_usd: 0.5, reason: 'corto' }, 400, 'validation_error'],
      ['lab_total', { limit_usd: 25.01, reason: REASON }, 403, 'permission_denied'],
      ['lab_experiment', { limit_usd: Number(cap.limit_usd) + 0.0001, reason: REASON }, 409, 'validation_error'],
    ] as const) {
      const r = await putBudget(scope, body);
      assert.deepEqual([r.status, r.body.error?.code], [status, code], `${scope} ${JSON.stringify(body)}: ${JSON.stringify(r.body)}`);
    }
    assert.match((await putBudget('lab_experiment', { limit_usd: Number(cap.limit_usd) + 1, reason: REASON })).body.error.message, /no puede superar el techo global lab_total/);
    // Sin step-up vigente o sin el rol: nada cambia.
    await t.pool.query(`UPDATE platform_session SET step_up_at = now() - interval '11 minutes' WHERE platform_user_id = $1`, [adminId]);
    const stale = await platform(adminToken, '/ai/budgets/lab_experiment', 'PUT', { limit_usd: 0.5, reason: REASON });
    assert.deepEqual([stale.status, stale.body.error?.code], [403, 'step_up_required']);
    const engineer = await platform(engToken, '/ai/budgets/lab_experiment', 'PUT', { limit_usd: 0.5, reason: REASON });
    assert.deepEqual([engineer.status, engineer.body.error?.code], [403, 'permission_denied']);
    assert.equal(await labRows(), 0, 'ningún rechazo crea la fila');

    // Upsert de la fila global, con auditoría (motivo y antes → después) en la misma transacción.
    const created = await putBudget('lab_experiment', { limit_usd: Number(cap.limit_usd), reason: REASON });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.deepEqual([created.body.created, Number(created.body.budget.limit_usd)], [true, Number(cap.limit_usd)], 'el máximo admitido es el techo global');
    const updated = await putBudget('lab_experiment', { limit_usd: '0.5', reason: REASON });
    assert.deepEqual([updated.status, updated.body.created, updated.body.budget.limit_usd], [200, false, '0.5000']);
    const row = (await t.pool.query<{ tenant_id: string | null; source: string; updated_by: string }>(`SELECT tenant_id, source, updated_by FROM ai_budget WHERE scope = 'lab_experiment'`)).rows;
    assert.deepEqual(row, [{ tenant_id: null, source: `console:${REASON}`, updated_by: adminId }], 'una sola fila global');
    await assert.rejects(t.pool.query(`INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by) VALUES ('bud_lab_tenant', 'lab_experiment', 'client_a', 1, 'prueba', 'prueba')`),
      (err: unknown) => err instanceof Error && 'code' in err && err.code === '23514', 'lab_experiment nunca es de un negocio');
    const audits = (await t.pool.query<{ decision: string; resource: string; result: string; reason: string | null }>(
      `SELECT decision, resource, result, reason FROM platform_audit_event WHERE actor_id = $1 AND action = 'platform.budget.update' AND at >= $2 ORDER BY at, event_id`, [adminId, since])).rows;
    assert.deepEqual(audits.map((a) => [a.decision, a.resource, a.result, a.reason]), [
      ['deny', '/api/platform/ai/budgets/:scope', 'step_up_required', null],
      ['allow', 'ai_budget/lab_experiment', `sin configurar → ${cap.limit_usd}`, REASON],
      ['allow', 'ai_budget/lab_experiment', `${cap.limit_usd} → 0.5000`, REASON],
    ], 'cada cambio aplicado queda con su motivo y su antes → después; un rechazo de validación no deja ningún allow');

    // platform_month (opcional): también se crea y se actualiza.
    if (!month) {
      const m1 = await putBudget('platform_month', { limit_usd: 3, reason: REASON });
      const m2 = await putBudget('platform_month', { limit_usd: 4, reason: REASON });
      assert.deepEqual([m1.status, m1.body.created, m2.status, m2.body.created, m2.body.budget.limit_usd], [200, true, 200, false, '4.0000']);
    }

    // lab_total y tenant_day no se crean desde la consola; sin techo global tampoco se fija el del laboratorio.
    await t.pool.query('DELETE FROM ai_budget WHERE budget_id = $1', [cap.budget_id]);
    try {
      const total = await putBudget('lab_total', { limit_usd: 1, reason: REASON });
      assert.deepEqual([total.status, total.body.error?.code], [404, 'not_found']);
      const orphan = await putBudget('lab_experiment', { limit_usd: 0.1, reason: REASON });
      assert.deepEqual([orphan.status, orphan.body.error?.code], [409, 'validation_error']);
      assert.match(orphan.body.error.message, /Falta el techo global lab_total/);
    } finally {
      await restoreGlobal('lab_total', cap);
    }
    const dayDefault = await globalRow('tenant_day');
    assert.ok(dayDefault);
    await t.pool.query('DELETE FROM ai_budget WHERE budget_id = $1', [dayDefault.budget_id]);
    try {
      assert.equal((await putBudget('tenant_day', { limit_usd: 1, reason: REASON })).status, 404);
    } finally {
      await restoreGlobal('tenant_day', dayDefault);
    }
    assert.equal(Number((await globalRow('lab_experiment'))?.limit_usd), 0.5, 'los rechazos no tocaron el presupuesto del laboratorio');
  } finally {
    await restoreGlobal('platform_month', month);
    await t.pool.query(`DELETE FROM ai_budget WHERE scope = 'lab_experiment'`);
  }
});
