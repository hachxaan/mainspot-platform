/**
 * DEC-0077 R4/R5 — cotas técnicas de los caminos de IA que quedan FUERA de la cuota comercial `ai_review_replies`:
 * comentarios de Facebook (agente de atención) y laboratorio manual (DEC-0074, `/ai/lab/replies`).
 * Integración con PostgreSQL real y proveedores SIMULADOS o FALSOS: TypeSafe/Jev es MockJev y Anthropic se sustituye
 * en memoria (fetch interceptado en todo el archivo; cualquier otra salida a la red falla y queda registrada).
 * SIMULATED_REGRESSION: nada de aquí acredita un proveedor real, su facturación ni su calidad.
 *
 * Cubre (AC previstos del delta 0.8.0: FR-0016 AC-16011, NFR-0006 AC-6004/AC-6005, FR-0019 AC-19005; DEC-0078):
 *  (a) la IA de un comentario de Facebook nunca reserva ni consume `ai_review_replies` aunque la cuota valga 0 o la
 *      revisión del plan no la defina: usa su propio medidor (DEC-0078 R5, fail-closed sin valor), mientras la cuota de
 *      reseñas sigue bloqueando «Redactar con IA» en Google;
 *  (b) con el presupuesto técnico agotado (`tenant_day` por gasto real del negocio; tope diario TypeSafe DEC-0032) la
 *      redacción con IA de un comentario (automática o a pedido) no llega al proveedor, queda trazada como bloqueada,
 *      no descuenta el medidor y el caso sigue sin IA;
 *  (c) FB-2 (DEC-0078 R2): las respuestas automáticas de Facebook respetan `max_auto_replies_per_hour` (ventana móvil de
 *      una hora) y sin espacio en la hora no se redacta con IA para publicar;
 *  (d) laboratorio: sin grant válido (ausente, inexistente, caducado, revocado, de otro negocio, usuario o entorno,
 *      capacidad fuera de su allowlist o fuera de AI_ENVIRONMENT=lab) se rechaza antes de clasificar o generar; con
 *      grant válido la invocación reserva el presupuesto experimental del laboratorio (`lab_experiment`, FB-3) y nunca el
 *      diario del negocio, bajo el techo global `lab_total` y el tope TypeSafe; al agotarse se bloquea; nunca toca el
 *      libro de cuotas comerciales.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { bootApi, authHeaders, api, login, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows, type TestTenant } from '../helpers/tenants.ts';
import { setTenantPlan } from '../helpers/plans.ts';
import { AiDispatcher } from '../../src/ai/dispatcher.ts';
import { SCOPE_SPENT_FILTER, SPENT_SQL, reserveBudget, type BudgetPurpose } from '../../src/ai/governance.ts';
import { AiLab } from '../../src/ai/lab.ts';
import { AiRegistry, type RouteParams } from '../../src/ai/registry.ts';
import { AiEngagementSemantics, type EngagementSemantics } from '../../src/engagement/ai-semantics.ts';
import { autoReplyText } from '../../src/engagement/classifier.ts';
import { AUTO_REPLY_CONSENT, AUTO_SUGGEST_CONSENT } from '../../src/engagement/consent.ts';
import { AI_REPLY_DISCLOSURE, EngagementService, type CaseRow } from '../../src/engagement/service.ts';
import { currentStep, totpAt } from '../../src/platform/auth.ts';
import type { AppConfig } from '../../src/shared/config.ts';

const FB_CLASSIFY = 'engagement.facebook.comment.classify';
const FB_REPLY = 'engagement.facebook.comment.reply';
const GOOGLE_CLASSIFY = 'engagement.google.review.classify';
const GOOGLE_REPLY = 'engagement.google.review.reply';
const HAIKU = 'an:claude-haiku-5-5';
const ACTOR = 'test:ai-cost-bounds';
/** Entorno de rollout propio de este archivo: la ruta de pago de Facebook no toca los rollouts compartidos lab/test. */
const CB_ENV = `cb_${randomUUID().slice(0, 8)}`;
/** Texto del Anthropic falso: distingue en los casos una redacción con IA de los textos seguros sin IA. */
const AI_TEXT = 'Te agradecemos el comentario y lo revisamos hoy mismo.';
const COMMENT = 'Me encantó, ¿tienen de chocolate?';
const REVIEW = { origin: 'google_review', message: 'Excelente atención, gracias por todo.', rating: 5 };
const GRANT_REASON = 'Prueba local de cotas técnicas del laboratorio';

let t: TestApi; // AI_ENVIRONMENT=test con proveedores reales apagados: cableado normal de la app.
let lab: TestApi; // AI_ENVIRONMENT=lab con AI_REAL_PROVIDERS=on: Anthropic falso por el fetch interceptado.
let adminToken = '';
let adminId = '';
let maxCostUsd = 0;
let cbReplyRoute = '';
let labReplyRoute = '';
let labClassifyRoute = '';
let labClassifyBefore: { active_route_id: string | null; canary_route_id: string | null; canary_percent: number } | null = null;
const createdRoutes: string[] = [];

const provider = { calls: 0 };
const leaked: string[] = [];
const realFetch = globalThis.fetch;
const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;

/** Red del archivo: el servidor local pasa; Anthropic Messages responde en memoria y cuenta; cualquier otro destino falla. */
async function offlineFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
  if (url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/messages') {
    provider.calls += 1;
    const text = JSON.stringify({ reply: AI_TEXT, facts_used: ['none'], needs_human: false, reason: null });
    return new Response(JSON.stringify({ id: `msg_cb_${provider.calls}`, model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  leaked.push(url.host);
  throw new TypeError(`salida de red bloqueada en la prueba: ${url.host}`);
}

/** Copia la candidata Anthropic sembrada (DEC-0074): misma revisión de prompt, parámetros y costo máximo por llamada. */
async function anthropicCandidate(useCase: string, note: string): Promise<{ route_id: string; max_cost_usd: string }> {
  const seeded = (await t.pool.query<{ prompt_revision_id: string; params: RouteParams; max_cost_usd: string }>(
    `SELECT prompt_revision_id, params, max_cost_usd FROM ai_route_revision WHERE use_case_id = $1 AND model_id = $2 AND status <> 'RETIRED'
      ORDER BY version LIMIT 1`, [useCase, HAIKU])).rows[0];
  assert.ok(seeded, `candidata Anthropic sembrada para ${useCase}`);
  const route = await t.handle.dispatcher.registry.createRoute({ useCaseId: useCase, modelId: HAIKU, promptRevisionId: seeded.prompt_revision_id, params: seeded.params,
    maxCostUsd: Number(seeded.max_cost_usd), changeNote: note, actor: ACTOR });
  createdRoutes.push(route.route_id);
  return route;
}

/** Clasificación simulada (MockJev) aprobada para activarla en un entorno de rollout. */
async function simulatedClassifier(useCase: string): Promise<string> {
  const prompt = (await t.pool.query<{ revision_id: string }>('SELECT revision_id FROM ai_prompt_revision WHERE use_case_id = $1 AND version = 1', [useCase])).rows[0];
  assert.ok(prompt, `prompt v1 de ${useCase}`);
  const route = await t.handle.dispatcher.registry.createRoute({ useCaseId: useCase, modelId: 'sim:jev-mock', promptRevisionId: prompt.revision_id, params: { timeout_ms: 10_000 },
    maxCostUsd: 0.01, changeNote: 'Prueba de cotas: clasificación simulada (MockJev)', actor: ACTOR });
  createdRoutes.push(route.route_id);
  await approve(route.route_id);
  return route.route_id;
}

async function approve(routeId: string): Promise<void> {
  await t.pool.query(`UPDATE ai_route_revision SET status = 'APPROVED', approved_by = $2, approved_at = now() WHERE route_id = $1`, [routeId, ACTOR]);
}

before(async () => {
  globalThis.fetch = offlineFetch;
  process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests-cost-bounds';
  t = await bootApi({ aiEnvironment: 'test' });
  lab = await bootApi({ aiEnvironment: 'lab', aiRealProviders: true, platformMfaKey: randomBytes(32).toString('base64') });

  const sfx = randomUUID().slice(0, 6);
  const admin = await lab.handle.platformAuth.createUser({ login: `cb-admin-${sfx}`, displayName: 'Admin cotas', password: 'Plataforma-Cotas-2026', roles: ['platform_admin'], grantedBy: 'test' });
  adminId = admin.platform_user_id;
  const logged = await api(lab.baseUrl, '/api/platform/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: `cb-admin-${sfx}`, password: 'Plataforma-Cotas-2026', code: totpAt(admin.totp_secret, currentStep()) }) });
  assert.equal(logged.status, 200, JSON.stringify(logged.body));
  adminToken = logged.body.token as string;

  const reg = t.handle.dispatcher.registry;
  // Facebook en el entorno propio: clasificación MockJev + redacción con Anthropic (proveedor de pago) aprobada y activa.
  await reg.activate(FB_CLASSIFY, CB_ENV, await simulatedClassifier(FB_CLASSIFY), ACTOR, 'Prueba de cotas: entorno propio', 'seed');
  const fbReply = await anthropicCandidate(FB_REPLY, 'Prueba de cotas: respuesta a comentarios con Anthropic falso');
  await approve(fbReply.route_id);
  await reg.activate(FB_REPLY, CB_ENV, fbReply.route_id, ACTOR, 'Prueba de cotas: entorno propio', 'seed');
  cbReplyRoute = fbReply.route_id;
  maxCostUsd = Number(fbReply.max_cost_usd);

  // Laboratorio: candidata DRAFT autorizable por grant y clasificación normal (simulada) activa en `lab`, que se restaura.
  labReplyRoute = (await anthropicCandidate(GOOGLE_REPLY, 'Prueba de cotas: candidata de laboratorio')).route_id;
  const prev = await reg.rollout(GOOGLE_CLASSIFY, 'lab');
  labClassifyBefore = prev ? { active_route_id: prev.active_route_id, canary_route_id: prev.canary_route_id, canary_percent: prev.canary_percent } : null;
  labClassifyRoute = await simulatedClassifier(GOOGLE_CLASSIFY);
  await reg.activate(GOOGLE_CLASSIFY, 'lab', labClassifyRoute, ACTOR, 'Prueba de cotas: clasificación simulada en lab', 'seed');
});

after(async () => {
  try {
    if (t) {
      await t.pool.query('DELETE FROM ai_rollout WHERE environment = $1', [CB_ENV]);
      if (labClassifyRoute) {
        if (labClassifyBefore) {
          await t.pool.query(`UPDATE ai_rollout SET active_route_id = $3, canary_route_id = $4, canary_percent = $5, version = version + 1, updated_by = 'test:restore', updated_at = now()
                               WHERE use_case_id = $1 AND environment = $2`, [GOOGLE_CLASSIFY, 'lab', labClassifyBefore.active_route_id, labClassifyBefore.canary_route_id, labClassifyBefore.canary_percent]);
          if (labClassifyBefore.active_route_id) await t.pool.query(`UPDATE ai_route_revision SET status = 'ACTIVE' WHERE route_id = $1`, [labClassifyBefore.active_route_id]);
          if (labClassifyBefore.canary_route_id) await t.pool.query(`UPDATE ai_route_revision SET status = 'CANARY' WHERE route_id = $1`, [labClassifyBefore.canary_route_id]);
        } else {
          await t.pool.query('DELETE FROM ai_rollout WHERE use_case_id = $1 AND environment = $2', [GOOGLE_CLASSIFY, 'lab']);
        }
      }
      await t.pool.query(`UPDATE ai_route_revision SET status = 'RETIRED' WHERE route_id = ANY($1)`, [createdRoutes]);
    }
  } finally {
    for (const app of [t, lab]) {
      if (!app) continue;
      app.handle.aiJobs.stop();
      await app.close();
    }
    globalThis.fetch = realFetch;
    if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
  }
  assert.deepEqual(leaked, [], 'ninguna petición salió a la red');
});

// ------------------------------------------------------------------ utilidades

function call(app: TestApi, token: string, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return api(app.baseUrl, `/api/backoffice${path}`, { method, headers: authHeaders(token, headers), body: body === undefined ? undefined : JSON.stringify(body) });
}

function platform(token: string, path: string, method = 'POST', body?: unknown) {
  return api(lab.baseUrl, `/api/platform${path}`, { method, headers: authHeaders(token), body: body === undefined ? undefined : JSON.stringify(body) });
}

/** Libro de cuotas comerciales del negocio: filas de cualquier capacidad y estado, y eventos `quota.*` de auditoría. */
async function commercialLedger(tenant: string): Promise<{ rows: number; events: number }> {
  return {
    rows: await countRows(t, 'SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1', [tenant]),
    events: await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action LIKE 'quota.%'`, [tenant]),
  };
}

/** Gasto operativo del negocio hoy con el mismo predicado que aplica el presupuesto `tenant_day` (src/ai/governance.ts). */
async function tenantSpentToday(tenant: string): Promise<number> {
  const r = await t.pool.query<{ spent: string }>(`${SPENT_SQL} AND ${SCOPE_SPENT_FILTER.tenant_day}`, [tenant]);
  return Number(r.rows[0]?.spent ?? 0);
}

/** Presupuesto técnico diario propio del negocio (fila `tenant_day` con tenant_id: la que prefiere la reserva). */
async function setTenantDayBudget(tenant: string, limitUsd: number): Promise<void> {
  await t.pool.query(`INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by) VALUES ($1, 'tenant_day', $2, $3, 'test: prueba de cotas', 'test')`,
    [`bud_${randomUUID()}`, tenant, limitUsd]);
}

/** Gasto de laboratorio de hoy de todos los negocios: lo que cuenta para `lab_experiment` (una fila global). */
async function labSpentToday(): Promise<number> {
  return Number((await t.pool.query<{ spent: string }>(`${SPENT_SQL} AND ${SCOPE_SPENT_FILTER.lab_experiment}`)).rows[0]?.spent ?? 0);
}

/** Redondeo a 4 decimales hacia arriba / abajo, como guarda `ai_budget.limit_usd` (NUMERIC(12,4)), sin ruido de coma flotante. */
function ceil4(value: number): number {
  return Math.ceil(Math.round(value * 1e8) / 1e4) / 1e4;
}
function floor4(value: number): number {
  return Math.floor(Math.round(value * 1e8) / 1e4) / 1e4;
}

/**
 * Presupuesto experimental del laboratorio (FB-3) fijado por la plataforma (platform_admin con step-up): no hay valor
 * sembrado. `limitUsd` se guarda con 4 decimales (NUMERIC(12,4)); quien llama lo retira con `clearLabExperimentBudget`.
 */
async function setLabExperimentBudget(limitUsd: number): Promise<void> {
  await t.pool.query('UPDATE platform_session SET step_up_at = now() WHERE platform_user_id = $1', [adminId]);
  const put = await platform(adminToken, '/ai/budgets/lab_experiment', 'PUT', { limit_usd: limitUsd, reason: 'Prueba local: presupuesto experimental del laboratorio' });
  assert.equal(put.status, 200, JSON.stringify(put.body));
}

/** Vuelve al estado sin configurar (sin fila), el de cualquier base recién migrada. */
async function clearLabExperimentBudget(): Promise<void> {
  await t.pool.query(`DELETE FROM ai_budget WHERE scope = 'lab_experiment'`);
}

/**
 * Ejecuta `run` con el gasto TypeSafe del día ya en el tope DEC-0032 (en pruebas `config.jev.mode = 'disabled'` ⇒ límite
 * USD 1): una llamada confirmada de USD 1 en el libro de TypeSafe (TS-1: la única fuente del tope), retirada al terminar
 * porque el tope es global y otros archivos clasifican después.
 */
async function withTypesafeDayExhausted<T>(run: () => Promise<T>): Promise<T> {
  const key = `ai_invocation:inv_fixture_${randomUUID()}`;
  await t.pool.query(
    `INSERT INTO typesafe_reservation (reservation_id, idempotency_key, source, use_case_id, budget_day, reserved_usd, status, dispatched_at,
       attempts, cost_usd, cost_source, expires_at, settled_at)
     VALUES ($1, $2, 'ai_core', $3, (now() AT TIME ZONE 'UTC')::date, 0.01, 'committed', now(), 1, 1, 'reported', now(), now())`,
    [`tsr_fixture_${randomUUID()}`, key, FB_CLASSIFY]);
  try {
    return await run();
  } finally {
    await t.pool.query('DELETE FROM typesafe_reservation WHERE idempotency_key = $1', [key]);
  }
}

/**
 * Ejecuta `run` con la clasificación de `useCase` en `environment` servida por una copia de la candidata TypeSafe sembrada
 * (`ts:jev-1.14.0`, aprobada, clave ficticia) y restaura después la ruta activa anterior. La simulada (MockJev) no gasta
 * TypeSafe ni consulta su tope (TS-1): solo una ruta TypeSafe prueba el tope DEC-0032. Agotado, nada sale a la red.
 */
async function withTypesafeClassifier<T>(useCase: string, environment: string, run: () => Promise<T>): Promise<T> {
  const reg = t.handle.dispatcher.registry;
  const previous = (await reg.rollout(useCase, environment))?.active_route_id;
  assert.ok(previous, `${useCase} tiene ruta activa en ${environment}`);
  const seeded = (await t.pool.query<{ prompt_revision_id: string; params: RouteParams; max_cost_usd: string }>(
    `SELECT prompt_revision_id, params, max_cost_usd FROM ai_route_revision WHERE use_case_id = $1 AND model_id = 'ts:jev-1.14.0' AND status <> 'RETIRED'
      ORDER BY version LIMIT 1`, [useCase])).rows[0];
  assert.ok(seeded, `candidata TypeSafe sembrada para ${useCase}`);
  const route = await reg.createRoute({ useCaseId: useCase, modelId: 'ts:jev-1.14.0', promptRevisionId: seeded.prompt_revision_id, params: seeded.params,
    maxCostUsd: Number(seeded.max_cost_usd), changeNote: 'Prueba de cotas: clasificación con TypeSafe (tope DEC-0032)', actor: ACTOR });
  createdRoutes.push(route.route_id);
  await approve(route.route_id);
  await reg.activate(useCase, environment, route.route_id, ACTOR, 'Prueba de cotas: clasificación con TypeSafe', 'seed');
  const prevKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'ts-fake-key-cost-bounds';
  try {
    return await run();
  } finally {
    if (prevKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = prevKey;
    await reg.activate(useCase, environment, previous, ACTOR, 'Prueba de cotas: vuelve la clasificación simulada', 'seed');
  }
}

interface InvocationRow {
  invocation_id: string; idempotency_key: string; status: string; error_code: string | null; detail: string | null; assignment: string | null;
  provider_id: string | null; route_id: string | null; reserved_usd: string; cost_usd: string | null; cost_source: string; lab_grant_id: string | null;
}

async function invocations(tenant: string, useCase: string): Promise<InvocationRow[]> {
  return (await t.pool.query<InvocationRow>(
    `SELECT invocation_id, idempotency_key, status, error_code, validation->>'detail' AS detail, assignment, provider_id, route_id, reserved_usd, cost_usd, cost_source, lab_grant_id
       FROM ai_invocation WHERE tenant_id = $1 AND use_case_id = $2 ORDER BY created_at, invocation_id`, [tenant, useCase])).rows;
}

/**
 * Servicio de atención real (libro de cuotas, BD, auditoría y canal de la app) con el AI Core real en el entorno propio:
 * dispatcher con proveedores de pago habilitados y el Anthropic falso.
 */
function cbService(reader: 'mockjev' | 'gratitude' = 'mockjev'): EngagementService {
  const dispatcher = new AiDispatcher({ pool: t.pool, config: { ...t.handle.config, aiRealProviders: true, aiEnvironment: CB_ENV as AppConfig['aiEnvironment'] }, fetchImpl: offlineFetch });
  const semantics = new AiEngagementSemantics({ dispatcher, environment: CB_ENV });
  return new EngagementService({ ...t.handle.engagement.deps, semantics: reader === 'gratitude' ? gratitudeReader(semantics) : semantics });
}

/**
 * Lectura fija (agradecimiento sin riesgos): MockJev marca riesgo en todo texto, así que la respuesta automática solo se
 * alcanza con un lector controlado. La REDACCIÓN sigue siendo la del AI Core real (ruta, dispatcher y presupuesto).
 */
function gratitudeReader(real: EngagementSemantics): EngagementSemantics {
  return {
    async read() {
      return { ok: true as const, invocationId: `inv_reader_${randomUUID()}`, reading: {},
        classification: { category: 'gratitude' as const, risk_flags: [], confidence: 0.95, sentiment: 'positive' as const, info_topic: null } };
    },
    replyAvailable: (origin) => real.replyAvailable(origin),
    reply: (row, c, facts, request) => real.reply(row, c, facts, request),
  };
}

async function receivedComment(service: EngagementService, tenant: string, body: string): Promise<CaseRow> {
  const id = `case_${randomUUID().replaceAll('-', '')}`;
  await t.pool.query(`INSERT INTO engagement_case (case_id, tenant_id, origin, external_ref, author_label, body, state)
    VALUES ($1, $2, 'facebook_comment', $3, 'Luis R.', $4, 'received')`, [id, tenant, `c-${randomUUID().slice(0, 8)}`, body]);
  const row = await service.getCase(tenant, id);
  assert.ok(row);
  return row;
}

async function caseByRef(tenant: string, ref: string): Promise<CaseRow> {
  const row = (await t.pool.query<CaseRow>('SELECT * FROM engagement_case WHERE tenant_id = $1 AND external_ref = $2', [tenant, ref])).rows[0];
  assert.ok(row, `caso ${ref}`);
  return row;
}

/** Comentario en una publicación publicada, por el simulador y el «Procesar ahora» de la app (worker + servicio reales). */
async function commentViaApp(a: TestTenant, body: string): Promise<CaseRow> {
  const post = `post_${randomUUID().slice(0, 8)}`;
  await t.pool.query(`INSERT INTO social_post (post_id, tenant_id, network, content_type, text, status, published_at, external_ref, created_by)
    VALUES ($1, $2, 'facebook', 'post', 'Pan de muerto', 'published', now(), $3, 'fixture')`, [post, a.tenant, `sim:fb:post:${post}`]);
  const ref = `c-${randomUUID().slice(0, 8)}`;
  const injected = await call(t, a.token, '/dev/simulator/facebook-comments', 'POST', { post_id: post, body, author_label: 'Luis R.', external_ref: ref });
  assert.equal(injected.status, 201, JSON.stringify(injected.body));
  const run = await call(t, a.token, '/engagement/run', 'POST');
  assert.equal(run.status, 200, JSON.stringify(run.body));
  return caseByRef(a.tenant, ref);
}

async function reviewViaApp(a: TestTenant, body: string, rating: number): Promise<CaseRow> {
  const ref = `g-${randomUUID().slice(0, 8)}`;
  const injected = await call(t, a.token, '/dev/simulator/google-reviews', 'POST', { body, rating, author_label: 'Ana P.', external_ref: ref });
  assert.equal(injected.status, 201, JSON.stringify(injected.body));
  const run = await call(t, a.token, '/engagement/run', 'POST');
  assert.equal(run.status, 200, JSON.stringify(run.body));
  return caseByRef(a.tenant, ref);
}

/** Política de respuesta automática segura para agradecimientos de Facebook, aceptando los términos vigentes (SEC-CONSENT-01). */
function facebookAutoPolicy(a: TestTenant, maxPerHour?: number) {
  return call(t, a.token, '/engagement/policies', 'PUT', { origin: 'facebook_comment', category: 'gratitude', mode: 'safe_auto_reply', consent: true,
    consent_version: AUTO_REPLY_CONSENT.facebook_comment.version, ...(maxPerHour === undefined ? {} : { max_auto_replies_per_hour: maxPerHour }) });
}

async function issueGrant(owner: TestTenant): Promise<string> {
  const r = await platform(adminToken, '/ai/lab/grants', 'POST', { tenant_id: owner.tenant, user_id: owner.userId, route_ids: [labReplyRoute], minutes: 30, reason: GRANT_REASON });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.grant.grant_id as string;
}

/** Grant insertado tal cual (lo que la API no emite): caducado en `lab`, o vigente pero de otro entorno. */
async function insertGrant(owner: TestTenant, kind: 'expired' | 'other_environment'): Promise<string> {
  const id = `lbg_${randomUUID()}`;
  await t.pool.query(
    `INSERT INTO ai_lab_grant (grant_id, environment, tenant_id, user_id, issued_by, issued_roles, reason, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, '{platform_admin}', $6, now() - interval '2 hours', now() + CASE WHEN $7 THEN interval '-1 hour' ELSE interval '30 minutes' END)`,
    [id, kind === 'expired' ? 'lab' : 'staging', owner.tenant, owner.userId, adminId, 'Grant insertado por la prueba de cotas', kind === 'expired']);
  await t.pool.query('INSERT INTO ai_lab_grant_route (grant_id, tenant_id, use_case_id, route_id) VALUES ($1, $2, $3, $4)', [id, owner.tenant, GOOGLE_REPLY, labReplyRoute]);
  return id;
}

/** Segunda persona activa (administración) del mismo negocio. */
async function secondUser(owner: TestTenant): Promise<{ userId: string; token: string }> {
  const userId = `user2_${owner.tenant}`;
  const loginName = `segunda@${owner.tenant}.example.com`;
  const password = 'Fixture-Segunda-2026!';
  await t.pool.query(`INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash)
    VALUES ($1, 'Segunda persona', $2, 'active', $3, crypt($4, gen_salt('bf', 4)))`, [userId, loginName, owner.tenant, password]);
  await t.pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, 'administration', $2)`, [userId, owner.tenant]);
  return { userId, token: (await login(lab.baseUrl, loginName, password, owner.tenant)).token };
}

function labReply(app: TestApi, token: string, body: Record<string, unknown>, grant?: string) {
  return call(app, token, '/ai/lab/replies', 'POST', body, { 'Idempotency-Key': randomUUID(), ...(grant ? { 'X-AI-Lab-Grant': grant } : {}) });
}

// ------------------------------------------------------------------ (a) Facebook fuera de la cuota de reseñas

/** Unidades confirmadas del medidor propio de Facebook (DEC-0078 R5) y filas de la cuota de reseñas (nunca se tocan). */
async function meters(tenant: string): Promise<{ facebook: number; google: number }> {
  const r = await t.pool.query<{ facebook: string; google: string }>(
    `SELECT COALESCE(SUM(units) FILTER (WHERE capability = 'ai_facebook_suggestions' AND state = 'committed'), 0) AS facebook,
            count(*) FILTER (WHERE capability = 'ai_review_replies') AS google
       FROM quota_reservation WHERE tenant_id = $1`, [tenant]);
  return { facebook: Number(r.rows[0]?.facebook), google: Number(r.rows[0]?.google) };
}

/** Sugerencias automáticas de comentarios de Facebook aceptando los términos vigentes (DEC-0078 R1). */
async function autoSuggest(a: TestTenant): Promise<void> {
  const r = await call(t, a.token, '/engagement/suggestions', 'PUT',
    { origin: 'facebook_comment', mode: 'auto_suggest', consent: true, consent_version: AUTO_SUGGEST_CONSENT.facebook_comment.version });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

test('(a) AC-16011 / DEC-0078 R5: la IA de un comentario de Facebook nunca reserva ni consume ai_review_replies aunque valga 0 o falte; usa su propio medidor y la cuota de reseñas sigue bloqueando «Redactar con IA» en Google', async () => {
  const zero = await createTenantWithPlan(t, { ai_review_replies: 0, reviews_managed: 0, ai_facebook_suggestions: 1 }, 'client_cbz');
  const legacy = await createTenantWithPlan(t, { reviews_managed: 0 }, 'client_cbl');
  // plan_piloto_1 sigue en su revisión previa a 0036 y 0038: no define ni la cuota de reseñas ni el medidor de Facebook.
  await setTenantPlan(t.pool, legacy.tenant, 'plan_piloto_1');
  await autoSuggest(zero);
  for (const [a, limit] of [[zero, 0], [legacy, null]] as const) {
    const status0 = (await call(t, a.token, '/engagement/ai-replies')).body.ai_replies;
    assert.deepEqual([status0.limit, status0.usage], [limit, 0]);

    const comment = await commentViaApp(a, COMMENT);
    if (a === zero) {
      assert.ok(comment.reply_invocation_id, 'con sugerencias automáticas y medidor propio, el comentario trae su sugerencia');
      const drafted = (await t.pool.query('SELECT use_case_id, status, provider_id FROM ai_invocation WHERE invocation_id = $1', [comment.reply_invocation_id])).rows[0];
      assert.deepEqual(drafted, { use_case_id: FB_REPLY, status: 'succeeded', provider_id: 'simulated' });
    } else {
      // Sin medidor definido: a pedido tampoco hay IA de pago (fail-closed), con explicación.
      assert.equal(comment.reply_invocation_id, null);
      const denied = await call(t, a.token, `/engagement/cases/${comment.case_id}/ai-draft`, 'POST');
      assert.deepEqual([denied.status, denied.body.error?.code], [403, 'limit_exceeded'], JSON.stringify(denied.body));
      assert.match(denied.body.error.message, /Sugerencias con IA para comentarios de Facebook/);
    }

    // Contraste: en el mismo negocio la cuota de reseñas sigue mandando sobre la IA de Google.
    const review = await reviewViaApp(a, 'Buen lugar, aunque la espera fue larga.', 3);
    assert.equal(review.state, 'needs_human');
    const denied = await call(t, a.token, `/engagement/cases/${review.case_id}/ai-draft`, 'POST');
    assert.deepEqual([denied.status, denied.body.error?.code], [403, 'limit_exceeded'], JSON.stringify(denied.body));

    assert.deepEqual(await meters(a.tenant), { facebook: a === zero ? 1 : 0, google: 0 }, 'la cuota de reseñas no tiene ni una fila; Facebook gasta el suyo');
    const reviewDecisions = (await t.pool.query<{ result: string }>(
      `SELECT result FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.ai_reply' AND resource = $2`, [a.tenant, `engagement_case/${review.case_id}`])).rows;
    assert.deepEqual(reviewDecisions, [{ result: 'limit_exceeded' }]);
    assert.equal((await call(t, a.token, '/engagement/ai-replies')).body.ai_replies.usage, 0);
  }
});

// ------------------------------------------------------------------ (b) presupuesto técnico agotado

test('(b) AC-16011/AC-6004: con el presupuesto diario del negocio agotado por su propio gasto, la redacción con IA del comentario no llega al proveedor, queda bloqueada, no descuenta el medidor y el caso sigue sin IA', async () => {
  const a = await createTenantWithPlan(t, { ai_review_replies: 0, reviews_managed: 0, ai_facebook_suggestions: 10 }, 'client_cbb');
  // Cabe exactamente una reserva (el costo máximo de la ruta); tras la primera, su costo real ya no deja margen.
  await setTenantDayBudget(a.tenant, maxCostUsd);
  await autoSuggest(a);
  const service = cbService();
  const calls0 = provider.calls;

  const first = await service.classifyCase(await receivedComment(service, a.tenant, COMMENT));
  assert.ok(first?.reply_invocation_id, 'con margen, el comentario se redacta con IA');
  assert.deepEqual([first.state, first.drafts[0]], ['needs_human', AI_TEXT]);
  assert.equal(provider.calls, calls0 + 1);
  const [paid] = await invocations(a.tenant, FB_REPLY);
  assert.ok(paid);
  assert.deepEqual([paid.status, paid.provider_id, paid.route_id, Number(paid.reserved_usd), paid.cost_source], ['succeeded', 'anthropic', cbReplyRoute, maxCostUsd, 'estimated'],
    'la redacción reservó el costo máximo de la ruta contra el presupuesto técnico');
  const spent = await tenantSpentToday(a.tenant);
  assert.ok(spent > 0 && spent === Number(paid.cost_usd), 'el gasto del día es el costo real de esa redacción');

  // Revisión humana: sin margen, ninguna llamada; quedan los borradores seguros sin IA.
  const second = await service.classifyCase(await receivedComment(service, a.tenant, COMMENT));
  assert.deepEqual([second?.state, second?.decision, second?.reply_invocation_id], ['needs_human', 'human_review', null]);
  assert.ok(second && second.drafts.length === 3 && !second.drafts.includes(AI_TEXT), 'solo borradores sin IA');
  // Tampoco por la vía a pedido (DEC-0078 R1): el presupuesto la bloquea antes del proveedor y no descuenta nada; la
  // denegación dice que es el presupuesto (AC-FB04; revisión 1, F-05), no un fallo pasajero.
  const onDemand = await service.requestAiDraft({ tenantId: a.tenant, userId: a.userId, role: 'administration', requestId: `req_${randomUUID()}` }, second!.case_id)
    .then(() => null, (err: unknown) => err as { status?: number; code?: string; userMessage?: string });
  assert.deepEqual([onDemand?.status, onDemand?.code], [429, 'limit_exceeded'], 'sin margen no hay propuesta a pedido');
  assert.match(onDemand?.userMessage ?? '', /presupuesto diario de IA.*No se descontó de tu plan/);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'quota.released' AND result = 'ai_facebook_suggestions:1:ai_budget_exhausted'`, [a.tenant]), 1,
    'la unidad liberada queda auditada con su motivo real');
  // Respuesta automática autorizada: sin margen, sale el texto seguro sin IA (sin el aviso de IA) y se publica.
  assert.equal((await facebookAutoPolicy(a)).status, 200);
  const auto = cbService('gratitude');
  const third = await auto.classifyCase(await receivedComment(auto, a.tenant, '¡Gracias, todo excelente!'));
  assert.deepEqual([third?.state, third?.decision, third?.reply_invocation_id], ['classified', 'auto_reply', null]);
  const business = (await t.pool.query<{ business_name: string }>('SELECT business_name FROM client WHERE client_id = $1', [a.tenant])).rows[0]!.business_name;
  assert.equal(third?.response_text, autoReplyText({ category: 'gratitude', author: 'Luis R.', business, verifiedAnswer: null }));
  assert.equal((await auto.respondCase(third!.case_id))?.state, 'responded');
  const published = (await t.pool.query<{ text: string }>('SELECT text FROM sim_provider_reply WHERE tenant_id = $1', [a.tenant])).rows;
  assert.deepEqual(published.map((p) => p.text), [third?.response_text]);
  assert.doesNotMatch(published[0]!.text, /generada con IA/);

  assert.equal(provider.calls, calls0 + 1, 'agotado el presupuesto, el proveedor no recibe ninguna llamada más');
  const blocked = (await invocations(a.tenant, FB_REPLY)).filter((r) => r.status === 'blocked');
  assert.deepEqual(blocked.map((r) => [r.idempotency_key.replace(/:reply:req_.*$/, ':reply:<petición>'), r.error_code, r.detail, r.route_id, Number(r.reserved_usd), r.cost_usd]), [
    [`case:${second!.case_id}:reply`, 'budget_exhausted', 'tenant_day', cbReplyRoute, 0, null],
    [`case:${second!.case_id}:reply:<petición>`, 'budget_exhausted', 'tenant_day', cbReplyRoute, 0, null],
    [`case:${third!.case_id}:reply`, 'budget_exhausted', 'tenant_day', cbReplyRoute, 0, null],
  ], 'cada bloqueo queda trazado con su caso, su ruta y el ámbito agotado');
  assert.equal(await tenantSpentToday(a.tenant), spent, 'los bloqueos no suman gasto ni reservas');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM ai_invocation WHERE tenant_id = $1 AND status = 'running'`, [a.tenant]), 0);
  assert.deepEqual(await meters(a.tenant), { facebook: 1, google: 0 }, 'solo la redacción que se guardó descuenta del medidor');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1 AND state = 'reserved'`, [a.tenant]), 0, 'ninguna reserva queda colgada');
});

test('(b) AC-6004: con el tope diario de TypeSafe (DEC-0032) alcanzado, la lectura del comentario se bloquea y no se redacta con IA; el caso queda para revisión humana', async () => {
  const a = await createTenantWithPlan(t, { reviews_managed: 0 }, 'client_cbj');
  const service = cbService();
  const calls0 = provider.calls;
  const c = await withTypesafeClassifier(FB_CLASSIFY, CB_ENV, () =>
    withTypesafeDayExhausted(async () => service.classifyCase(await receivedComment(service, a.tenant, COMMENT))));
  assert.deepEqual([c?.state, c?.decision, c?.reason, c?.semantic_source, c?.reply_invocation_id], ['needs_human', 'human_review', 'semantic_unavailable', 'unavailable', null]);
  const read = (await invocations(a.tenant, FB_CLASSIFY)).filter((r) => r.idempotency_key === `case:${c!.case_id}:read`);
  assert.deepEqual(read.map((r) => [r.provider_id, r.status, r.error_code, r.detail, Number(r.cost_usd)]), [['typesafe', 'failed', 'budget_exhausted', 'DEC-0032', 0]]);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM typesafe_reservation WHERE idempotency_key = $1', [`ai_invocation:${read[0]!.invocation_id}`]), 0,
    'la lectura denegada no reservó nada en el libro de TypeSafe');
  assert.deepEqual(await invocations(a.tenant, FB_REPLY), [], 'sin lectura semántica no hay redacción con IA');
  assert.equal(provider.calls, calls0);
  assert.deepEqual(await commercialLedger(a.tenant), { rows: 0, events: 0 });
});

// ------------------------------------------------------------------ (c) límite por hora (FB-2)

test('(c) AC-16011 / DEC-0078 R2 (FB-2): el máximo por hora acota la publicación Y el gasto: sin espacio en la hora no se redacta con IA para publicar', async () => {
  const a = await createTenantWithPlan(t, { reviews_managed: 0, ai_facebook_suggestions: 10 }, 'client_cbh');
  for (const outOfRange of [0, 61]) {
    const r = await facebookAutoPolicy(a, outOfRange);
    assert.deepEqual([r.status, r.body.error?.code], [400, 'validation_error'], `límite ${outOfRange}: el máximo por hora va de 1 a 60`);
  }
  assert.equal((await facebookAutoPolicy(a, 2)).status, 200);
  const service = cbService('gratitude');
  const calls0 = provider.calls;
  const cases: CaseRow[] = [];
  for (let i = 0; i < 4; i += 1) {
    const c = await service.classifyCase(await receivedComment(service, a.tenant, `¡Gracias, todo excelente! (${i})`));
    assert.ok(c);
    cases.push(c);
  }
  assert.deepEqual(cases.map((c) => [c.decision, c.reason?.startsWith('policy:') ? 'policy' : c.reason, c.state]), [
    ['auto_reply', 'policy', 'classified'], ['auto_reply', 'policy', 'classified'],
    ['human_review', 'rate_limited', 'needs_human'], ['human_review', 'rate_limited', 'needs_human'],
  ]);
  for (const c of cases.slice(0, 2)) assert.equal((await service.respondCase(c.case_id))?.state, 'responded');
  for (const c of cases.slice(2)) assert.equal(await service.respondCase(c.case_id), null, 'un caso limitado no se publica solo');
  const published = (await t.pool.query<{ text: string }>(`SELECT text FROM sim_provider_reply WHERE tenant_id = $1 AND origin = 'facebook_comment'`, [a.tenant])).rows;
  assert.deepEqual(published.map((p) => p.text), [`${AI_TEXT}\n\n${AI_REPLY_DISCLOSURE}`, `${AI_TEXT}\n\n${AI_REPLY_DISCLOSURE}`], 'solo salen solas las dos de la hora, con el aviso de IA');

  // FB-2: los casos limitados NO se redactan con IA (sin sugerencias automáticas no hay otro fin que lo justifique):
  // solo las dos publicables llegaron al proveedor, reservaron y descontaron del medidor.
  assert.equal(provider.calls, calls0 + 2);
  assert.ok(cases.slice(2).every((c) => c.reply_invocation_id === null && !c.drafts.includes(AI_TEXT)));
  const replies = await invocations(a.tenant, FB_REPLY);
  assert.equal(replies.length, 2);
  assert.ok(replies.every((r) => r.status === 'succeeded' && r.provider_id === 'anthropic' && Number(r.reserved_usd) === maxCostUsd));
  const cost = replies.reduce((s, r) => s + Number(r.cost_usd), 0);
  assert.ok(Math.abs((await tenantSpentToday(a.tenant)) - cost) < 1e-9, 'el gasto del día es solo el de las publicables');
  assert.deepEqual(await meters(a.tenant), { facebook: 2, google: 0 });

  // Ventana móvil: pasada la hora de las dos automáticas, la siguiente vuelve a salir sola.
  await t.pool.query(`UPDATE engagement_case SET classified_at = now() - interval '61 minutes' WHERE tenant_id = $1 AND decision = 'auto_reply'`, [a.tenant]);
  const next = await service.classifyCase(await receivedComment(service, a.tenant, '¡Gracias, todo excelente! (4)'));
  assert.deepEqual([next?.decision, next?.state], ['auto_reply', 'classified']);
});

// ------------------------------------------------------------------ (d) laboratorio manual

test('(d) AC-19005: sin grant válido el laboratorio rechaza antes de clasificar o generar (ausente, inexistente, caducado, revocado, de otro negocio, usuario o entorno, capacidad fuera de la allowlist, fuera de AI_ENVIRONMENT=lab)', async () => {
  const a = await createTenantWithPlan(lab, { ai_review_replies: 0, reviews_managed: 0 }, 'client_cbla');
  const b = await createTenantWithPlan(lab, { ai_review_replies: 5 }, 'client_cblb');
  const a2 = await secondUser(a);

  // Emisión: solo rutas de la allowlist (texto Anthropic); una ruta simulada no es autorizable.
  const simulatedRoute = (await t.handle.dispatcher.registry.rollout(GOOGLE_REPLY, 'test'))?.active_route_id;
  assert.ok(simulatedRoute);
  const refused = await platform(adminToken, '/ai/lab/grants', 'POST', { tenant_id: a.tenant, user_id: a.userId, route_ids: [simulatedRoute], minutes: 30, reason: GRANT_REASON });
  assert.deepEqual([refused.status, refused.body.error?.code], [400, 'validation_error']);
  // Emisión: sin step-up reciente (el del inicio de sesión ya venció) no se emite nada, aun con rol de ingeniería.
  const sfx = randomUUID().slice(0, 6);
  const eng = await lab.handle.platformAuth.createUser({ login: `cb-eng-${sfx}`, displayName: 'Ingeniería cotas', password: 'Plataforma-Ingenia-2026', roles: ['ai_engineer'], grantedBy: 'test' });
  const engLogin = await api(lab.baseUrl, '/api/platform/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: `cb-eng-${sfx}`, password: 'Plataforma-Ingenia-2026', code: totpAt(eng.totp_secret, currentStep()) }) });
  assert.equal(engLogin.status, 200, JSON.stringify(engLogin.body));
  await t.pool.query(`UPDATE platform_session SET step_up_at = now() - interval '11 minutes' WHERE platform_user_id = $1`, [eng.platform_user_id]);
  const noStepUp = await platform(engLogin.body.token as string, '/ai/lab/grants', 'POST', { tenant_id: a.tenant, user_id: a.userId, route_ids: [labReplyRoute], minutes: 30, reason: GRANT_REASON });
  assert.deepEqual([noStepUp.status, noStepUp.body.error?.code], [403, 'step_up_required']);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM ai_lab_grant WHERE tenant_id = $1', [a.tenant]), 0);

  const grant = await issueGrant(a);
  const revoked = await issueGrant(a);
  assert.equal((await platform(adminToken, `/ai/lab/grants/${revoked}/revoke`, 'POST', { reason: 'Revocación previa al uso en la prueba' })).status, 200);
  const expired = await insertGrant(a, 'expired');
  const otherEnvironment = await insertGrant(a, 'other_environment');
  const calls0 = provider.calls;
  const attempts: Array<[string, TestApi, string, string | undefined, Record<string, unknown>]> = [
    ['sin cabecera', lab, a.token, undefined, REVIEW],
    ['id inexistente', lab, a.token, `lbg_${randomUUID()}`, REVIEW],
    ['caducado', lab, a.token, expired, REVIEW],
    ['revocado', lab, a.token, revoked, REVIEW],
    ['de otro entorno', lab, a.token, otherEnvironment, REVIEW],
    ['de otro negocio', lab, b.token, grant, REVIEW],
    ['de otro usuario', lab, a2.token, grant, REVIEW],
    ['capacidad fuera de la allowlist', lab, a.token, grant, { origin: 'facebook_comment', message: 'Gracias por el servicio.' }],
    ['fuera de AI_ENVIRONMENT=lab', t, a.token, grant, REVIEW],
  ];
  for (const [label, app, token, g, body] of attempts) {
    const r = await labReply(app, token, body, g);
    assert.deepEqual([r.status, r.body.error?.code], [403, 'permission_denied'], `${label}: ${JSON.stringify(r.body)}`);
  }
  const denials = (await t.pool.query<{ tenant_id: string; result: string }>(
    `SELECT tenant_id, result FROM audit_event WHERE tenant_id = ANY($1) AND action = 'ai.lab.invoke' AND decision = 'deny'`, [[a.tenant, b.tenant]])).rows;
  assert.deepEqual(denials.filter((d) => d.tenant_id === a.tenant).map((d) => d.result).sort(),
    ['grant_environment', 'grant_expired', 'grant_not_found', 'grant_not_found', 'grant_revoked', 'lab_disabled', 'use_case_not_granted', 'user_mismatch'], 'cada rechazo se audita con su motivo');
  assert.deepEqual(denials.filter((d) => d.tenant_id === b.tenant).map((d) => d.result), ['tenant_mismatch'], 'el intento ajeno se audita en el negocio de quien lo hizo');
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM ai_invocation WHERE tenant_id = ANY($1)', [[a.tenant, b.tenant]]), 0, 'ningún rechazo clasifica ni genera');
  assert.equal(provider.calls, calls0);
  for (const x of [a, b]) assert.deepEqual(await commercialLedger(x.tenant), { rows: 0, events: 0 });
});

test('(d) AC-6005/AC-19005 · FB-3: con grant válido la respuesta de laboratorio reserva el presupuesto experimental del laboratorio y nunca el diario del negocio; agotado se bloquea sin proveedor, revocar corta en seco y nunca toca el libro de cuotas', async () => {
  const a = await createTenantWithPlan(lab, { ai_review_replies: 0, reviews_managed: 0 }, 'client_cblc');
  const grant = await issueGrant(a);
  // Sin margen operativo: si el laboratorio reservara del diario del negocio, la primera respuesta ya se bloquearía.
  await setTenantDayBudget(a.tenant, 0);
  // Margen para una reserva sobre el gasto de laboratorio de hoy (la fila es global: otros archivos también prueban).
  await setLabExperimentBudget(ceil4(await labSpentToday() + maxCostUsd));
  const calls0 = provider.calls;
  try {
    const ok = await labReply(lab, a.token, REVIEW, grant);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.review_required, ok.body.published, ok.body.simulated, ok.body.provider, ok.body.route_id, ok.body.reply.text],
      [true, false, false, 'anthropic', labReplyRoute, AI_TEXT], 'propuesta para revisar; nada se publica');
    assert.equal(provider.calls, calls0 + 1);
    const [generated] = (await invocations(a.tenant, GOOGLE_REPLY)).filter((r) => r.invocation_id === ok.body.invocation_id);
    assert.ok(generated);
    assert.deepEqual([generated.status, generated.assignment, generated.lab_grant_id, Number(generated.reserved_usd), generated.cost_source],
      ['succeeded', 'manual_lab', grant, maxCostUsd, 'estimated'], 'la invocación DRAFT reservó el costo máximo y queda trazada con su grant');
    const [classified] = (await invocations(a.tenant, GOOGLE_CLASSIFY)).filter((r) => r.invocation_id === ok.body.classification_invocation_id);
    assert.deepEqual([classified?.assignment, classified?.route_id, classified?.lab_grant_id], ['active', labClassifyRoute, grant], 'la clasificación sigue su ruta normal, revalidada con el grant');
    assert.equal(await tenantSpentToday(a.tenant), 0, 'el laboratorio no cuenta en el presupuesto diario del negocio');
    const ownLab = Number((await t.pool.query<{ spent: string }>(`${SPENT_SQL} AND i.tenant_id = $1 AND ${SCOPE_SPENT_FILTER.lab_experiment}`, [a.tenant])).rows[0]?.spent ?? 0);
    assert.equal(ownLab, Number(generated.cost_usd), 'cuenta en el presupuesto experimental del laboratorio');

    // Agotado: la plataforma rebaja el presupuesto experimental a lo ya gastado hoy; no queda margen para otra reserva.
    await setLabExperimentBudget(floor4(await labSpentToday()));
    const exhausted = await labReply(lab, a.token, REVIEW, grant);
    assert.deepEqual([exhausted.status, exhausted.body.error?.code], [429, 'limit_exceeded'], JSON.stringify(exhausted.body));
    assert.match(exhausted.body.error.message, /presupuesto experimental del laboratorio/);
    assert.equal(provider.calls, calls0 + 1, 'agotado: sin llamada al proveedor');
    const blocked = (await invocations(a.tenant, GOOGLE_REPLY)).filter((r) => r.status === 'blocked');
    assert.deepEqual(blocked.map((r) => [r.error_code, r.detail, r.assignment, r.lab_grant_id, r.route_id]), [['budget_exhausted', 'lab_experiment', 'manual_lab', grant, labReplyRoute]]);

    // Revocar: la siguiente petición se rechaza antes de clasificar (revalidación en servidor en cada uso).
    const before = await countRows(t, 'SELECT count(*) AS n FROM ai_invocation WHERE tenant_id = $1', [a.tenant]);
    assert.equal((await platform(adminToken, `/ai/lab/grants/${grant}/revoke`, 'POST', { reason: 'Fin de la sesión de laboratorio de la prueba' })).status, 200);
    const afterRevoke = await labReply(lab, a.token, REVIEW, grant);
    assert.deepEqual([afterRevoke.status, afterRevoke.body.error?.code], [403, 'permission_denied']);
    assert.equal(await countRows(t, 'SELECT count(*) AS n FROM ai_invocation WHERE tenant_id = $1', [a.tenant]), before);
    assert.equal(provider.calls, calls0 + 1);
  } finally {
    await clearLabExperimentBudget();
  }

  // Con la cuota de reseñas en 0, el laboratorio generó una respuesta a reseña sin tocar el libro de cuotas.
  assert.deepEqual(await commercialLedger(a.tenant), { rows: 0, events: 0 });
  const quota = (await call(lab, a.token, '/engagement/ai-replies')).body.ai_replies;
  assert.deepEqual([quota.limit, quota.usage], [0, 0]);
  const trail = (await t.pool.query<{ action: string }>(`SELECT action FROM audit_event WHERE tenant_id = $1 AND resource = $2 ORDER BY ts`, [a.tenant, `ai_lab_grant/${grant}`])).rows;
  assert.deepEqual(trail.map((e) => e.action), ['ai.lab.grant_issued', 'ai.lab.grant_revoked'], 'emisión y revocación visibles en la auditoría del negocio');
});

test('(d) AC-6005 · FB-3: los techos globales también bloquean un grant válido con margen propio: lab_total rebajado por la plataforma (step-up) y tope diario de TypeSafe', async () => {
  const a = await createTenantWithPlan(lab, { reviews_managed: 0 }, 'client_cbld');
  const grant = await issueGrant(a);
  const calls0 = provider.calls;
  const original = (await t.pool.query<{ limit_usd: string; source: string; updated_by: string; updated_at: Date }>(
    `SELECT limit_usd, source, updated_by, updated_at FROM ai_budget WHERE budget_id = 'bud_lab_total'`)).rows[0];
  assert.ok(original, 'techo acumulado sembrado (DEC-0068)');
  try {
    // El laboratorio tiene margen propio (fijado antes: no puede superar el techo vigente); el techo global manda igual.
    await setLabExperimentBudget(ceil4(await labSpentToday() + maxCostUsd));
    // platform_admin con step-up fija el techo en lo ya gastado: no queda margen para otra reserva.
    const spent = Number((await t.pool.query<{ spent: string }>(SPENT_SQL)).rows[0]?.spent ?? 0);
    const put = await platform(adminToken, '/ai/budgets/lab_total', 'PUT', { limit_usd: Math.floor(spent * 1e4) / 1e4, reason: 'Prueba local: techo de laboratorio sin margen' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(await tenantSpentToday(a.tenant), 0, 'el presupuesto diario del negocio sigue con margen');
    const r = await labReply(lab, a.token, REVIEW, grant);
    assert.deepEqual([r.status, r.body.error?.code], [429, 'limit_exceeded'], JSON.stringify(r.body));
    const blocked = (await invocations(a.tenant, GOOGLE_REPLY)).filter((x) => x.status === 'blocked');
    assert.deepEqual(blocked.map((x) => [x.error_code, x.detail, x.assignment, x.lab_grant_id]), [['budget_exhausted', 'lab_total', 'manual_lab', grant]]);
  } finally {
    await t.pool.query(`UPDATE ai_budget SET limit_usd = $2, source = $3, updated_by = $4, updated_at = $5 WHERE budget_id = $1`,
      ['bud_lab_total', original.limit_usd, original.source, original.updated_by, original.updated_at]);
    await clearLabExperimentBudget();
  }

  // Tope TypeSafe alcanzado: la clasificación (ruta normal bajo el grant, aquí con TypeSafe) se bloquea y no se llega a generar.
  const r = await withTypesafeClassifier(GOOGLE_CLASSIFY, 'lab', () => withTypesafeDayExhausted(() => labReply(lab, a.token, REVIEW, grant)));
  assert.deepEqual([r.status, r.body.error?.code], [429, 'limit_exceeded'], JSON.stringify(r.body));
  const reads = (await invocations(a.tenant, GOOGLE_CLASSIFY)).map((x) => [x.provider_id, x.status, x.error_code, x.lab_grant_id]);
  assert.deepEqual(reads, [['simulated', 'succeeded', null, grant], ['typesafe', 'failed', 'budget_exhausted', grant]]);
  assert.equal((await invocations(a.tenant, GOOGLE_REPLY)).length, 1, 'sin clasificación no hay generación');
  assert.equal(provider.calls, calls0, 'ningún techo agotado llegó al proveedor');
  assert.deepEqual(await commercialLedger(a.tenant), { rows: 0, events: 0 });
});

test('(e) NFR-0006 · AC-6004/AC-6005 · FB-3: sin techo no hay gasto — si falta el techo acumulado (lab_total), el diario del negocio (tenant_day) en operación o el presupuesto experimental (lab_experiment) en laboratorio, la reserva de pago se deniega con ese ámbito', async () => {
  const a = await createTenantWithPlan(t, { reviews_managed: 0 }, 'client_cbe');
  const labRoom = ceil4(await labSpentToday()) + 1;
  const client = await t.pool.connect();
  const decision = async (tenant: string | null, purpose: BudgetPurpose = 'operational') => {
    const d = await reserveBudget(client, { tenantId: tenant, purpose, reserveUsd: 0.001 });
    return d.allowed ? { allowed: true } : { allowed: false, exceeded: d.exceeded };
  };
  try {
    await client.query('BEGIN');
    assert.deepEqual(await decision(a.tenant), { allowed: true }, 'con los techos sembrados hay margen');
    assert.deepEqual(await decision(a.tenant, 'lab'), { allowed: false, exceeded: 'lab_experiment' }, 'sin valor sembrado para el laboratorio, el laboratorio no gasta');
    await client.query(`INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by) VALUES ('bud_lab_experiment_e', 'lab_experiment', NULL, $1, 'prueba', 'prueba')`, [labRoom]);
    assert.deepEqual(await decision(a.tenant, 'lab'), { allowed: true }, 'con su fila global, el laboratorio gasta');
    await client.query(`DELETE FROM ai_budget WHERE scope = 'tenant_day'`);
    assert.deepEqual(await decision(a.tenant), { allowed: false, exceeded: 'tenant_day' }, 'sin techo diario (propio ni por defecto) el negocio no gasta');
    assert.deepEqual(await decision(a.tenant, 'lab'), { allowed: true }, 'el laboratorio nunca depende de tenant_day');
    assert.deepEqual(await decision(null), { allowed: true }, 'sin negocio solo aplica el techo acumulado');
    await client.query(`DELETE FROM ai_budget WHERE scope = 'lab_total'`);
    assert.deepEqual(await decision(null), { allowed: false, exceeded: 'lab_total' }, 'sin techo acumulado no hay gasto de pago');
    assert.deepEqual(await decision(a.tenant), { allowed: false, exceeded: 'lab_total' });
    assert.deepEqual(await decision(a.tenant, 'lab'), { allowed: false, exceeded: 'lab_total' }, 'tampoco en el laboratorio');
    // Una fila de techo global asociada a un negocio (solo posible por SQL directo) nunca hace de techo de la plataforma.
    await client.query(`INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by) VALUES ('bud_lab_total_tenant', 'lab_total', $1, 1000, 'prueba', 'prueba')`, [a.tenant]);
    assert.deepEqual(await decision(a.tenant), { allowed: false, exceeded: 'lab_total' }, 'una fila de negocio no sustituye al techo global');
    assert.deepEqual(await decision(null), { allowed: false, exceeded: 'lab_total' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM ai_budget WHERE budget_id IN ('bud_lab_total','bud_tenant_day_default')`, []), 2, 'la prueba no deja huella');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM ai_budget WHERE scope = 'lab_experiment'`, []), 0);
});

test('(f) DEC-0077 R5: con APP_ENV=production el laboratorio no se habilita aunque AI_ENVIRONMENT sea lab — un grant válido se rechaza (lab_disabled)', async () => {
  const a = await createTenantWithPlan(lab, { reviews_managed: 0 }, 'client_cbf');
  const grant = await issueGrant(a);
  const check = { grantId: grant, tenantId: a.tenant, userId: a.userId };
  const development = new AiLab({ pool: t.pool, registry: new AiRegistry(t.pool), environment: 'lab', appEnv: 'development' });
  assert.equal((await development.check(check)).ok, true, 'el mismo grant vale en desarrollo');
  const production = new AiLab({ pool: t.pool, registry: new AiRegistry(t.pool), environment: 'lab', appEnv: 'production' });
  assert.equal(production.enabled, false);
  assert.deepEqual(await production.check(check), { ok: false, reason: 'lab_disabled' });
  const dispatcher = new AiDispatcher({ pool: t.pool, config: { ...lab.handle.config, appEnv: 'production' } });
  assert.equal(dispatcher.lab.enabled, false, 'el despachador construido con la configuración de producción tampoco lo habilita');
});
