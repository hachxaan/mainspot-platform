/**
 * Laboratorio manual del AI Core (DEC-0074, SRC-0012) — integración con PostgreSQL real, AI_ENVIRONMENT=lab y
 * proveedores FALSOS inyectados (fetch simulado: ninguna llamada externa ni pagada).
 * SIMULATED_REGRESSION: no acredita calidad de modelos reales ni créditos; prueba invariantes de seguridad.
 *
 * Cubre: lectura de laboratorio sin llamadas pagadas y sin secretos; emisión/revocación de grants con step-up,
 * motivo, caducidad, membresía, allowlist (texto Anthropic / imagen OpenAI, no RETIRED, nunca clasificación ni
 * simulado) y auditoría durable; dispatcher: DRAFT solo bajo grant válido (`manual_lab`), bloqueo de capacidades
 * fuera del grant SIN fallback al rollout, clasificación por ruta normal con revalidación, replay aislado por
 * grant/usuario, revocación/caducidad/emisor/membresía; worker: job con grant revocado falla sin gastar;
 * evidencia saneada y revisión manual (accept ⇒ TESTED manual, reject ⇒ vuelve a DRAFT, approve y activate
 * separados; fuera de `lab` una ruta probada solo manualmente no se despliega).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { bootApi, api, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows } from '../helpers/tenants.ts';
import { AiDispatcher, type InvokeContext } from '../../src/ai/dispatcher.ts';
import { currentStep, totpAt } from '../../src/platform/auth.ts';
import { AppError } from '../../src/shared/errors.ts';

const ENV = 'lab';
const LIMITS = { conversations: 50, website: 1, social_posts: 20, reviews_managed: 100 };
let t: TestApi;
let adminToken = '';
let engToken = '';
let supportToken = '';
let adminId = '';
let engId = '';
let step = 0;

before(async () => {
  t = await bootApi({ localSiteDomain: 'mainspot.test', publicBaseUrl: 'https://app.mainspot.test', aiEnvironment: ENV, platformMfaKey: randomBytes(32).toString('base64') });
  const auth = t.handle.platformAuth;
  const sfx = randomUUID().slice(0, 6);
  const admin = await auth.createUser({ login: `lab-admin-${sfx}`, displayName: 'Admin Lab', password: 'Plataforma-Admin-2026', roles: ['platform_admin'], grantedBy: 'test' });
  const eng = await auth.createUser({ login: `lab-eng-${sfx}`, displayName: 'Ingeniería Lab', password: 'Plataforma-Ingenia-2026', roles: ['ai_engineer'], grantedBy: 'test' });
  const support = await auth.createUser({ login: `lab-sup-${sfx}`, displayName: 'Soporte Lab', password: 'Plataforma-Soporte-2026', roles: ['platform_support'], grantedBy: 'test' });
  step = currentStep();
  adminId = admin.platform_user_id;
  engId = eng.platform_user_id;
  adminToken = (await platform(null, '/auth/login', 'POST', { login: `lab-admin-${sfx}`, password: 'Plataforma-Admin-2026', code: totpAt(admin.totp_secret, step) })).body.token as string;
  engToken = (await platform(null, '/auth/login', 'POST', { login: `lab-eng-${sfx}`, password: 'Plataforma-Ingenia-2026', code: totpAt(eng.totp_secret, step) })).body.token as string;
  supportToken = (await platform(null, '/auth/login', 'POST', { login: `lab-sup-${sfx}`, password: 'Plataforma-Soporte-2026', code: totpAt(support.totp_secret, step) })).body.token as string;
  assert.ok(adminToken && engToken && supportToken, 'sesiones de plataforma');
  assert.equal((await platform(adminToken, '/auth/step-up', 'POST', { code: totpAt(admin.totp_secret, step + 1) })).status, 200);
  assert.equal((await platform(engToken, '/auth/step-up', 'POST', { code: totpAt(eng.totp_secret, step + 1) })).status, 200);
});

after(async () => {
  t.handle.aiJobs.stop();
  await t.close();
});

function platform(token: string | null, path: string, method = 'GET', body?: unknown) {
  return api(t.baseUrl, `/api/platform${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function draftRoute(useCase: string, modelId: string): Promise<{ route_id: string; max_cost_usd: string }> {
  const r = (await t.pool.query<{ route_id: string; max_cost_usd: string }>(
    `SELECT route_id, max_cost_usd FROM ai_route_revision WHERE use_case_id = $1 AND model_id = $2 AND status = 'DRAFT' ORDER BY version DESC LIMIT 1`, [useCase, modelId])).rows[0];
  assert.ok(r, `candidata DRAFT ${useCase} ${modelId}`);
  return r;
}

/** Segunda candidata Anthropic en DRAFT para el mismo caso de uso (otra ruta real pero no autorizada). */
async function anthropicDraft(useCase: string, modelId: string): Promise<{ route_id: string }> {
  const base = await t.handle.dispatcher.registry.bundle((await draftRoute(useCase, 'an:claude-haiku-5-5')).route_id);
  assert.ok(base);
  return t.handle.dispatcher.registry.createRoute({ useCaseId: useCase, modelId, promptRevisionId: base.prompt.revision_id, params: { timeout_ms: 20_000, max_tokens: 1500 }, maxCostUsd: 0.05, changeNote: `DEC-0074 prueba: candidata ${modelId}`, actor: 'test' });
}

/** Fetch falso de Anthropic: respuesta estructurada válida para business.insights.generate; cuenta llamadas. */
function fakeAnthropic() {
  const state = { calls: 0 };
  const fetchImpl: typeof fetch = async (url) => {
    state.calls++;
    assert.match(String(url), /^https:\/\/api\.anthropic\.com\/v1\/messages$/);
    const text = JSON.stringify({ status: 'abstained', summary: 'Sin datos suficientes.', highlights: [], recommendations: [], abstain_reason: 'pocos días' });
    return new Response(JSON.stringify({ id: 'msg_lab', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { state, fetchImpl };
}

const INSIGHTS = 'business.insights.generate';
const VALUES = { period: '2026-10-24 a 2026-10-30', metrics: { days_with_activity: 1 } };

test('DEC-0074 lectura: el laboratorio lista negocios, usuarios y rutas autorizables sin llamadas pagadas ni secretos; soporte no entra', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_lab');
  const priorCalls = await countRows(t, 'SELECT count(*) AS n FROM ai_invocation', []);
  assert.equal((await platform(supportToken, '/ai/lab')).status, 403, 'platform_support no ve el laboratorio');
  const res = await platform(adminToken, '/ai/lab');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual([res.body.environment, res.body.enabled], ['lab', true]);
  const tenant = (res.body.tenants as Array<{ tenant_id: string; users: Array<{ user_id: string; email: string; role: string }> }>).find((x) => x.tenant_id === a.tenant);
  assert.ok(tenant, 'el negocio aparece');
  assert.deepEqual(tenant.users.map((u) => [u.user_id, u.email, u.role]), [[a.userId, a.login, 'administration']]);
  const routes = res.body.routes as Array<{ status: string; modality: string; provider: { kind: string }; use_case_id: string }>;
  assert.ok(routes.length >= 2, 'hay candidatas DEC-0074');
  assert.ok(routes.every((r) => r.status !== 'RETIRED' && r.modality !== 'classification'
    && ((r.modality === 'text' && r.provider.kind === 'anthropic') || (r.modality === 'image' && r.provider.kind === 'openai'))), 'allowlist Anthropic texto / OpenAI imagen, sin clasificación ni simulados');
  assert.doesNotMatch(JSON.stringify(res.body), /password|totp|secret_ref|api_key|output_text/i);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM ai_invocation', []), priorCalls, 'leer el laboratorio no invoca nada');
  assert.equal((await platform(engToken, '/ai/lab')).status, 200, 'ingeniería también lee');
});

test('DEC-0074 grants: step-up, motivo, caducidad 5–120, allowlist, membresía y auditoría durable; revocación idempotente', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_labg');
  const b = await createTenantWithPlan(t, LIMITS, 'client_labh');
  const haiku = await draftRoute(INSIGHTS, 'an:claude-haiku-5-5');
  const image = await draftRoute('website.image.generate', 'oa:gpt-image-2');
  const classify = (await t.pool.query<{ route_id: string }>(`SELECT route_id FROM ai_route_revision WHERE use_case_id = 'engagement.facebook.comment.classify' AND status <> 'RETIRED' ORDER BY version DESC LIMIT 1`)).rows[0]!;
  const reg = t.handle.dispatcher.registry;
  const simBundle = await reg.bundle(haiku.route_id);
  assert.ok(simBundle);
  const simulated = await reg.createRoute({ useCaseId: INSIGHTS, modelId: 'sim:text', promptRevisionId: simBundle.prompt.revision_id, params: { timeout_ms: 20_000 }, maxCostUsd: 0.01, changeNote: 'DEC-0074 prueba: simulada no autorizable', actor: 'test' });

  // Sin step-up reciente: denegado y auditado.
  await t.pool.query(`UPDATE platform_session SET step_up_at = now() - interval '20 minutes' WHERE platform_user_id = $1`, [adminId]);
  const base = { tenant_id: a.tenant, user_id: a.userId, route_ids: [haiku.route_id], minutes: 30, reason: 'Probar Haiku 5.5 con el negocio sintético de laboratorio' };
  assert.deepEqual([(await platform(adminToken, '/ai/lab/grants', 'POST', base)).status, (await platform(adminToken, '/ai/lab/grants', 'POST', base)).body.error.code], [403, 'step_up_required']);
  // Step-up renovado por BD (determinista: no depende de que el reloj TOTP avance de paso).
  await t.pool.query(`UPDATE platform_session SET step_up_at = now() WHERE platform_user_id = $1`, [adminId]);

  assert.equal((await platform(supportToken, '/ai/lab/grants', 'POST', base)).status, 403, 'soporte no emite');
  assert.equal((await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, reason: 'corto' })).status, 400);
  assert.equal((await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, minutes: 3 })).status, 400);
  assert.equal((await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, minutes: 121 })).status, 400);
  assert.equal((await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, route_ids: [] })).status, 400);
  assert.equal((await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, route_ids: [classify.route_id] })).status, 400, 'clasificación nunca entra en un grant');
  assert.equal((await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, route_ids: [simulated.route_id] })).status, 400, 'una ruta simulada no es evidencia real');
  assert.equal((await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, route_ids: [haiku.route_id, simulated.route_id] })).status, 400, 'toda la lista debe ser autorizable');
  assert.equal((await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, user_id: b.userId })).status, 404, 'usuario de otro negocio');
  assert.equal((await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, tenant_id: 'client_inexistente' })).status, 404);
  const retired = await reg.createRoute({ useCaseId: INSIGHTS, modelId: 'an:claude-haiku-5-5', promptRevisionId: simBundle.prompt.revision_id, params: { timeout_ms: 20_000 }, maxCostUsd: 0.01, changeNote: 'DEC-0074 prueba: retirada', actor: 'test' });
  await reg.retire(retired.route_id);
  assert.equal((await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, route_ids: [retired.route_id] })).status, 400, 'RETIRED no es autorizable');

  const issued = await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, route_ids: [haiku.route_id, image.route_id], minutes: undefined });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const grant = issued.body.grant;
  assert.deepEqual([grant.status, grant.tenant_id, grant.user_id, grant.issued_by, grant.environment, grant.route_ids.length, grant.routes.length], ['active', a.tenant, a.userId, adminId, 'lab', 2, 2]);
  const minutes = (new Date(grant.expires_at).getTime() - new Date(grant.created_at).getTime()) / 60_000;
  assert.ok(Math.abs(minutes - 60) < 0.1, `caducidad por defecto 60 min (${minutes})`);
  assert.deepEqual(grant.routes.map((r: { use_case_id: string; provider_kind: string; route_status: string }) => [r.use_case_id, r.provider_kind, r.route_status]).sort(),
    [[INSIGHTS, 'anthropic', 'DRAFT'], ['website.image.generate', 'openai', 'DRAFT']]);
  assert.equal((await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, route_ids: [haiku.route_id, (await anthropicDraft(INSIGHTS, 'an:claude-sonnet-5-5')).route_id] })).status, 400, 'una ruta por caso de uso');

  // Auditoría durable: plataforma (inmutable) y negocio (visible al propietario), sin el motivo íntegro en el negocio.
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM platform_audit_event WHERE actor_id = $1 AND action = 'ai.lab.grant' AND resource = $2 AND decision = 'allow'`, [adminId, `ai_lab_grant/${grant.grant_id}`]), 1);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'ai.lab.grant_issued' AND resource = $2`, [a.tenant, `ai_lab_grant/${grant.grant_id}`]), 1);
  // Allowlist inmutable; el grant solo admite revocación.
  await assert.rejects(t.pool.query(`UPDATE ai_lab_grant_route SET route_id = $2 WHERE grant_id = $1 AND use_case_id = $3`, [grant.grant_id, simulated.route_id, INSIGHTS]), /immutable/);
  await assert.rejects(t.pool.query(`UPDATE ai_lab_grant SET expires_at = now() + interval '10 hours' WHERE grant_id = $1`, [grant.grant_id]), /immutable/);

  // Lectura del negocio: solo grants vigentes del propio usuario.
  const lab = t.handle.dispatcher.lab;
  assert.deepEqual((await lab.grantsForUser(a.tenant, a.userId)).map((g) => g.grant_id), [grant.grant_id]);
  assert.deepEqual(await lab.grantsForUser(b.tenant, b.userId), []);
  assert.deepEqual(await lab.grantsForUser(a.tenant, b.userId), []);
  const status = await lab.statusFor({ grantId: grant.grant_id, tenantId: a.tenant, userId: a.userId });
  assert.deepEqual(status?.capabilities.map((c) => [c.use_case, c.route_id, c.provider, c.status]).sort(), [[INSIGHTS, haiku.route_id, 'anthropic', 'DRAFT'], ['website.image.generate', image.route_id, 'openai', 'DRAFT']]);
  assert.equal(await lab.statusFor({ grantId: grant.grant_id, tenantId: b.tenant, userId: b.userId }), null, 'otro negocio no ve el grant');
  await assert.rejects(lab.authorize({ grantId: grant.grant_id, tenantId: a.tenant, userId: b.userId }), (e: unknown) => e instanceof AppError && e.status === 403 && e.code === 'permission_denied');
  assert.equal(await lab.authorize({ grantId: '', tenantId: a.tenant, userId: a.userId }), null, 'sin cabecera no hay grant (ruta normal)');

  // Revocación con step-up e idempotente; el grant deja de ser válido para el negocio.
  assert.equal((await platform(supportToken, `/ai/lab/grants/${grant.grant_id}/revoke`, 'POST', { reason: 'soporte no puede revocar' })).status, 403);
  assert.equal((await platform(engToken, `/ai/lab/grants/${grant.grant_id}/revoke`, 'POST', { reason: 'x' })).status, 400);
  const revoked = await platform(engToken, `/ai/lab/grants/${grant.grant_id}/revoke`, 'POST', { reason: 'Terminó la sesión de pruebas del propietario' });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.deepEqual([revoked.body.grant.status, Boolean(revoked.body.grant.revoked_at)], ['revoked', true]);
  const again = await platform(engToken, `/ai/lab/grants/${grant.grant_id}/revoke`, 'POST', { reason: 'Segunda revocación no cambia nada' });
  assert.deepEqual([again.status, again.body.grant.revoked_at], [200, revoked.body.grant.revoked_at]);
  assert.equal((await platform(engToken, `/ai/lab/grants/lbg_inexistente/revoke`, 'POST', { reason: 'No existe este grant' })).status, 404);
  assert.deepEqual(await lab.grantsForUser(a.tenant, a.userId), []);
  assert.deepEqual(await lab.check({ grantId: grant.grant_id, tenantId: a.tenant, userId: a.userId }), { ok: false, reason: 'grant_revoked' });
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'ai.lab.grant_revoked'`, [a.tenant]), 1);
  const listed = (await platform(adminToken, '/ai/lab')).body.grants as Array<{ grant_id: string; status: string }>;
  assert.equal(listed.find((g) => g.grant_id === grant.grant_id)?.status, 'revoked');

  // Permisos vigentes (RBAC): solo lectura solo puede recibir asistente/insights; nunca composición social.
  const reader = `user_ro_${randomUUID().slice(0, 8)}`;
  await t.pool.query(`INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash) VALUES ($1, 'Lectora', $2, 'active', $3, crypt('Fixture-Reader-2026!', gen_salt('bf', 4)))`, [reader, `${reader}@${a.tenant}.example.com`, a.tenant]);
  await t.pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, 'read_only', $2)`, [reader, a.tenant]);
  const compose = await draftRoute('social.facebook.post.compose', 'an:claude-haiku-5-5');
  const denied = await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, user_id: reader, route_ids: [compose.route_id] });
  assert.deepEqual([denied.status, denied.body.error.code], [400, 'validation_error'], 'solo lectura no compone publicaciones');
  assert.match(denied.body.error.message, /social\.facebook\.post\.compose/);
  assert.equal((await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, user_id: reader, route_ids: [haiku.route_id, compose.route_id] })).status, 400, 'una sola capacidad fuera de los permisos invalida la emisión completa');
  const readerGrant = await platform(adminToken, '/ai/lab/grants', 'POST', { ...base, user_id: reader, route_ids: [haiku.route_id] });
  assert.equal(readerGrant.status, 201, JSON.stringify(readerGrant.body));
  assert.equal((await lab.check({ grantId: readerGrant.body.grant.grant_id, tenantId: a.tenant, userId: reader, useCaseId: INSIGHTS })).ok, true, 'insights sí está permitido a solo lectura');
});

test('DEC-0074 dispatcher: DRAFT solo bajo grant válido (manual_lab), sin fallback al rollout, clasificación normal revalidada, replay aislado y revocación sin gasto', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_labd');
  const b = await createTenantWithPlan(t, LIMITS, 'client_labe');
  const haiku = await draftRoute(INSIGHTS, 'an:claude-haiku-5-5');
  const sonnet = await anthropicDraft(INSIGHTS, 'an:claude-sonnet-5-5');
  const reg = t.handle.dispatcher.registry;
  const lab = t.handle.dispatcher.lab;
  const issued = await platform(adminToken, '/ai/lab/grants', 'POST', { tenant_id: a.tenant, user_id: a.userId, route_ids: [haiku.route_id], minutes: 30, reason: 'Sesión de laboratorio del dispatcher (regresión)' });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  const grantId = issued.body.grant.grant_id as string;

  // El entorno `lab` es compartido por otros archivos de integración (es el entorno por defecto): se restaura al final.
  const simulatedUseCases = ['editorial.calendar.suggest', 'engagement.facebook.comment.classify'];
  const rolloutsBefore = (await t.pool.query<{ use_case_id: string; active_route_id: string | null; canary_route_id: string | null; canary_percent: number }>(
    'SELECT use_case_id, active_route_id, canary_route_id, canary_percent FROM ai_rollout WHERE environment = $1 AND use_case_id = ANY($2)', [ENV, simulatedUseCases])).rows;
  // Rollout simulado en lab para una capacidad NO incluida en el grant y para clasificación (ruta normal).
  const calendarBase = await reg.bundle((await t.pool.query<{ route_id: string }>(`SELECT route_id FROM ai_route_revision WHERE use_case_id = 'editorial.calendar.suggest' ORDER BY version LIMIT 1`)).rows[0]!.route_id);
  assert.ok(calendarBase);
  const calendarSim = await reg.createRoute({ useCaseId: 'editorial.calendar.suggest', modelId: 'sim:text', promptRevisionId: calendarBase.prompt.revision_id, params: { timeout_ms: 20_000 }, maxCostUsd: 0.01, changeNote: 'DEC-0074 prueba: rollout simulado en lab', actor: 'test' });
  await t.pool.query(`UPDATE ai_route_revision SET status = 'APPROVED' WHERE route_id = $1`, [calendarSim.route_id]);
  await reg.activate('editorial.calendar.suggest', ENV, calendarSim.route_id, 'test', 'DEC-0074 prueba: rollout simulado', 'seed');
  const classifyBase = await reg.bundle((await t.pool.query<{ route_id: string }>(`SELECT route_id FROM ai_route_revision WHERE use_case_id = 'engagement.facebook.comment.classify' ORDER BY version LIMIT 1`)).rows[0]!.route_id);
  assert.ok(classifyBase);
  const classifySim = await reg.createRoute({ useCaseId: 'engagement.facebook.comment.classify', modelId: 'sim:jev-mock', promptRevisionId: classifyBase.prompt.revision_id, params: { timeout_ms: 10_000 }, maxCostUsd: 0.01, changeNote: 'DEC-0074 prueba: clasificación simulada en lab', actor: 'test' });
  await t.pool.query(`UPDATE ai_route_revision SET status = 'APPROVED' WHERE route_id = $1`, [classifySim.route_id]);
  await reg.activate('engagement.facebook.comment.classify', ENV, classifySim.route_id, 'test', 'DEC-0074 prueba: clasificación simulada', 'seed');

  const fake = fakeAnthropic();
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests';
  const dispatcher = new AiDispatcher({ pool: t.pool, config: { ...t.handle.config, aiRealProviders: true, aiEnvironment: ENV }, fetchImpl: fake.fetchImpl, registry: reg, lab });
  const ctx = (key: string, extra: Partial<InvokeContext> = {}): InvokeContext => ({ requestId: key, idempotencyKey: key, tenantId: a.tenant, actorId: a.userId, actorKind: 'tenant_user', origin: 'lab-test', ...extra });
  try {
    // Pin del borrador sin grant ni evaluación: rechazado antes del proveedor.
    const bare = await dispatcher.invokeStructured(INSIGHTS, ctx(`bare-${randomUUID()}`, { pinnedRouteId: haiku.route_id }), VALUES);
    assert.deepEqual([bare.ok, !bare.ok && bare.code, !bare.ok && bare.reason, fake.state.calls], [false, 'no_active_route', 'pinned_route_not_deployable', 0]);
    // evalRunId inventado tampoco abre el borrador.
    const fakeEval = await dispatcher.invokeStructured(INSIGHTS, ctx(`eval-${randomUUID()}`, { pinnedRouteId: haiku.route_id, evalRunId: 'evr_inexistente' }), VALUES);
    assert.deepEqual([fakeEval.ok, !fakeEval.ok && fakeEval.reason, fake.state.calls], [false, 'eval_run_mismatch', 0]);

    // Con grant: la ruta DRAFT se ejecuta como manual_lab y queda trazada con el grant y el hash de salida.
    const key = `lab-${randomUUID()}`;
    const ok = await dispatcher.invokeStructured(INSIGHTS, ctx(key, { labGrantId: grantId, pinnedRouteId: haiku.route_id }), VALUES);
    if (!ok.ok) throw new Error(`la ruta autorizada debe ejecutarse: ${JSON.stringify(ok)}`);
    assert.deepEqual([ok.route.assignment, ok.route.route_id, ok.replayed, ok.simulated, ok.costSource, fake.state.calls], ['manual_lab', haiku.route_id, false, false, 'estimated', 1]);
    const row = (await t.pool.query<{ assignment: string; lab_grant_id: string; output_sha256: string | null; cost_usd: string | null; status: string }>(
      'SELECT assignment, lab_grant_id, output_sha256, cost_usd, status FROM ai_invocation WHERE invocation_id = $1', [ok.invocationId])).rows[0]!;
    assert.deepEqual([row.assignment, row.lab_grant_id, row.status, typeof row.output_sha256, Number(row.cost_usd) > 0], ['manual_lab', grantId, 'succeeded', 'string', true]);
    assert.match(row.output_sha256 as string, /^[0-9a-f]{64}$/);
    // Sin pin explícito el grant también resuelve su ruta (no exige que el llamador conozca el id).
    const unpinned = await dispatcher.invokeStructured(INSIGHTS, ctx(`lab2-${randomUUID()}`, { labGrantId: grantId }), VALUES);
    assert.ok(unpinned.ok && unpinned.route.route_id === haiku.route_id && unpinned.route.assignment === 'manual_lab');

    // Replay aislado: misma clave sin grant no devuelve la salida del borrador; con el grant, replay sin costo.
    const normal = await dispatcher.invokeStructured(INSIGHTS, ctx(key), VALUES);
    assert.deepEqual([normal.ok, !normal.ok && normal.code, !normal.ok && normal.reason], [false, 'lab_grant_invalid', 'replay_requires_same_grant']);
    const replay = await dispatcher.invokeStructured(INSIGHTS, ctx(key, { labGrantId: grantId, pinnedRouteId: haiku.route_id }), VALUES);
    assert.ok(replay.ok && replay.replayed && replay.costUsd === 0 && replay.invocationId === ok.invocationId);
    const other = await dispatcher.invokeStructured(INSIGHTS, ctx(key, { labGrantId: grantId, actorId: b.userId }), VALUES);
    assert.deepEqual([other.ok, !other.ok && other.code], [false, 'lab_grant_invalid'], 'otro usuario no replica ni ejecuta con el grant ajeno');
    assert.equal(fake.state.calls, 2);

    // Negocio o usuario distintos al del grant: bloqueo trazado, sin proveedor.
    const foreign = await dispatcher.invokeStructured(INSIGHTS, { ...ctx(`f-${randomUUID()}`, { labGrantId: grantId }), tenantId: b.tenant, actorId: b.userId }, VALUES);
    assert.deepEqual([foreign.ok, !foreign.ok && foreign.code, !foreign.ok && foreign.reason], [false, 'lab_grant_invalid', 'tenant_mismatch']);
    const blocked = (await t.pool.query<{ status: string; error_code: string; lab_grant_id: string; validation: { detail: string } }>('SELECT status, error_code, lab_grant_id, validation FROM ai_invocation WHERE invocation_id = $1', [foreign.invocationId])).rows[0]!;
    assert.deepEqual([blocked.status, blocked.error_code, blocked.lab_grant_id, blocked.validation.detail], ['blocked', 'lab_grant_invalid', grantId, 'tenant_mismatch']);
    const wrongUser = await dispatcher.invokeStructured(INSIGHTS, ctx(`u-${randomUUID()}`, { labGrantId: grantId, actorId: b.userId }), VALUES);
    assert.deepEqual([wrongUser.ok, !wrongUser.ok && wrongUser.reason], [false, 'user_mismatch']);
    const unknown = await dispatcher.invokeStructured(INSIGHTS, ctx(`g-${randomUUID()}`, { labGrantId: 'lbg_no_existe' }), VALUES);
    assert.deepEqual([unknown.ok, !unknown.ok && unknown.reason], [false, 'grant_not_found']);

    // Capacidad generativa fuera del grant: bloqueada aunque exista rollout activo (nunca fallback).
    const notGranted = await dispatcher.invokeStructured('editorial.calendar.suggest', ctx(`c-${randomUUID()}`, { labGrantId: grantId }), { brand_facts: {}, recent_posts: [], promotions: [], today: '2026-11-03', days: 7 });
    assert.deepEqual([notGranted.ok, !notGranted.ok && notGranted.code, !notGranted.ok && notGranted.reason], [false, 'lab_grant_invalid', 'use_case_not_granted']);
    assert.equal(await countRows(t, `SELECT count(*) AS n FROM ai_invocation WHERE invocation_id = $1 AND route_id IS NULL AND status = 'blocked'`, [notGranted.invocationId]), 1);
    // Ruta fijada distinta de la autorizada para esa capacidad: rechazada.
    const otherRoute = await dispatcher.invokeStructured(INSIGHTS, ctx(`r-${randomUUID()}`, { labGrantId: grantId, pinnedRouteId: sonnet.route_id }), VALUES);
    assert.deepEqual([otherRoute.ok, !otherRoute.ok && otherRoute.reason], [false, 'route_not_granted']);
    assert.equal(fake.state.calls, 2, 'ningún bloqueo llegó al proveedor');

    // Clasificación bajo grant: ruta normal (nunca DRAFT), trazada con el grant.
    const cls = await dispatcher.invokeClassification('engagement.facebook.comment.classify', ctx(`k-${randomUUID()}`, { labGrantId: grantId }), { message: 'Excelente servicio, gracias' });
    if (!cls.ok) throw new Error(`la clasificación normal debe funcionar bajo grant: ${JSON.stringify(cls)}`);
    assert.deepEqual([cls.route.assignment, cls.route.route_id, cls.simulated], ['active', classifySim.route_id, true]);
    assert.equal((await t.pool.query<{ lab_grant_id: string }>('SELECT lab_grant_id FROM ai_invocation WHERE invocation_id = $1', [cls.invocationId])).rows[0]?.lab_grant_id, grantId);

    // Revocación: ni generación ni clasificación bajo ese grant vuelven a gastar; sin fallback.
    assert.equal((await platform(adminToken, `/ai/lab/grants/${grantId}/revoke`, 'POST', { reason: 'Revocación durante la prueba del dispatcher' })).status, 200);
    const afterRevoke = await dispatcher.invokeStructured(INSIGHTS, ctx(`z-${randomUUID()}`, { labGrantId: grantId, pinnedRouteId: haiku.route_id }), VALUES);
    assert.deepEqual([afterRevoke.ok, !afterRevoke.ok && afterRevoke.code, !afterRevoke.ok && afterRevoke.reason], [false, 'lab_grant_invalid', 'grant_revoked']);
    const clsRevoked = await dispatcher.invokeClassification('engagement.facebook.comment.classify', ctx(`k2-${randomUUID()}`, { labGrantId: grantId }), { message: 'Hola' });
    assert.deepEqual([clsRevoked.ok, !clsRevoked.ok && clsRevoked.reason], [false, 'grant_revoked']);
    const replayRevoked = await dispatcher.invokeStructured(INSIGHTS, ctx(key, { labGrantId: grantId, pinnedRouteId: haiku.route_id }), VALUES);
    assert.deepEqual([replayRevoked.ok, !replayRevoked.ok && replayRevoked.reason], [false, 'grant_revoked'], 'la revalidación precede al replay');
    assert.equal(fake.state.calls, 2);
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    for (const uc of simulatedUseCases) {
      const prev = rolloutsBefore.find((r) => r.use_case_id === uc);
      await t.pool.query(`UPDATE ai_rollout SET active_route_id = $3, canary_route_id = $4, canary_percent = $5, version = version + 1, updated_by = 'test:restore', updated_at = now()
                           WHERE use_case_id = $1 AND environment = $2`, [uc, ENV, prev?.active_route_id ?? null, prev?.canary_route_id ?? null, prev?.canary_percent ?? 0]);
      if (prev?.active_route_id) await t.pool.query(`UPDATE ai_route_revision SET status = 'ACTIVE' WHERE route_id = $1`, [prev.active_route_id]);
      if (prev?.canary_route_id) await t.pool.query(`UPDATE ai_route_revision SET status = 'CANARY' WHERE route_id = $1`, [prev.canary_route_id]);
    }
    await t.pool.query(`UPDATE ai_route_revision SET status = 'RETIRED' WHERE route_id = ANY($1)`, [[calendarSim.route_id, classifySim.route_id]]);
  }

  // Caducidad, emisor, membresía y negocio: cada condición invalida el grant por sí sola (sin tocar expires_at: inmutable).
  const expiredId = `lbg_${randomUUID()}`;
  await t.pool.query(`INSERT INTO ai_lab_grant (grant_id, environment, tenant_id, user_id, issued_by, issued_roles, reason, created_at, expires_at)
                      VALUES ($1,'lab',$2,$3,$4,'{platform_admin}','Grant caducado insertado por la prueba', now() - interval '2 hours', now() - interval '1 hour')`, [expiredId, a.tenant, a.userId, adminId]);
  await t.pool.query(`INSERT INTO ai_lab_grant_route (grant_id, tenant_id, use_case_id, route_id) VALUES ($1,$2,$3,$4)`, [expiredId, a.tenant, INSIGHTS, haiku.route_id]);
  assert.deepEqual(await lab.check({ grantId: expiredId, tenantId: a.tenant, userId: a.userId }), { ok: false, reason: 'grant_expired' });
  const fresh = (await platform(adminToken, '/ai/lab/grants', 'POST', { tenant_id: a.tenant, user_id: a.userId, route_ids: [haiku.route_id], minutes: 5, reason: 'Grant para probar emisor, membresía y negocio' })).body.grant.grant_id as string;
  assert.equal((await lab.check({ grantId: fresh, tenantId: a.tenant, userId: a.userId })).ok, true);
  await t.pool.query(`UPDATE platform_user SET status = 'suspended' WHERE platform_user_id = $1`, [adminId]);
  assert.deepEqual(await lab.check({ grantId: fresh, tenantId: a.tenant, userId: a.userId }), { ok: false, reason: 'issuer_inactive' });
  await t.pool.query(`UPDATE platform_user SET status = 'active' WHERE platform_user_id = $1`, [adminId]);
  await t.pool.query(`DELETE FROM platform_user_role WHERE platform_user_id = $1`, [adminId]);
  assert.deepEqual(await lab.check({ grantId: fresh, tenantId: a.tenant, userId: a.userId }), { ok: false, reason: 'issuer_unauthorized' });
  await t.pool.query(`INSERT INTO platform_user_role (platform_user_id, role, granted_by) VALUES ($1, 'platform_admin', 'test')`, [adminId]);
  await t.pool.query(`DELETE FROM user_role WHERE user_id = $1 AND tenant_id = $2`, [a.userId, a.tenant]);
  assert.deepEqual(await lab.check({ grantId: fresh, tenantId: a.tenant, userId: a.userId }), { ok: false, reason: 'membership_missing' });
  await t.pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, 'administration', $2)`, [a.userId, a.tenant]);
  await t.pool.query(`UPDATE internal_user SET status = 'suspended' WHERE user_id = $1`, [a.userId]);
  assert.deepEqual(await lab.check({ grantId: fresh, tenantId: a.tenant, userId: a.userId }), { ok: false, reason: 'user_inactive' });
  await t.pool.query(`UPDATE internal_user SET status = 'active' WHERE user_id = $1`, [a.userId]);
  await t.pool.query(`UPDATE client SET status = 'suspended' WHERE client_id = $1`, [a.tenant]);
  assert.deepEqual(await lab.check({ grantId: fresh, tenantId: a.tenant, userId: a.userId }), { ok: false, reason: 'tenant_inactive' });
  await t.pool.query(`UPDATE client SET status = 'active' WHERE client_id = $1`, [a.tenant]);
  await t.pool.query(`UPDATE ai_provider SET status = 'disabled' WHERE provider_id = 'anthropic'`);
  assert.deepEqual(await lab.check({ grantId: fresh, tenantId: a.tenant, userId: a.userId, useCaseId: INSIGHTS }), { ok: false, reason: 'route_unavailable' });
  await t.pool.query(`UPDATE ai_provider SET status = 'active' WHERE provider_id = 'anthropic'`);
  assert.equal((await lab.check({ grantId: fresh, tenantId: a.tenant, userId: a.userId, useCaseId: INSIGHTS })).ok, true);
});

test('DEC-0074 jobs: enqueue fija solo generativas del grant (clasificación normal, nada más); grant inválido ⇒ 403; revocado ⇒ el worker falla el job sin gastar', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_labj');
  const compose = await draftRoute('social.facebook.post.compose', 'an:claude-haiku-5-5');
  const jobs = t.handle.aiJobs;
  const grantId = (await platform(adminToken, '/ai/lab/grants', 'POST', { tenant_id: a.tenant, user_id: a.userId, route_ids: [compose.route_id], minutes: 15, reason: 'Composición social con Haiku en laboratorio' })).body.grant.grant_id as string;
  await assert.rejects(jobs.enqueue({ tenantId: a.tenant, kind: 'social.compose', idempotencyKey: `bad-${randomUUID()}`, input: { request: 'x' }, useCases: ['social.facebook.post.compose', 'social.facebook.image.generate'], createdBy: a.userId, labGrantId: 'lbg_falso' }),
    (e: unknown) => e instanceof AppError && e.status === 403 && e.code === 'permission_denied');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM ai_job WHERE tenant_id = $1`, [a.tenant]), 0, 'un grant inválido no crea el job');
  const { job, created } = await jobs.enqueue({ tenantId: a.tenant, kind: 'social.compose', idempotencyKey: `ok-${randomUUID()}`, input: { request: 'Anuncia el pan de muerto', with_image: true }, useCases: ['social.facebook.post.compose', 'social.facebook.image.generate'], createdBy: a.userId, labGrantId: grantId });
  assert.equal(created, true);
  assert.deepEqual([job.lab_grant_id, job.pinned], [grantId, { 'social.facebook.post.compose': compose.route_id }], 'la imagen (no autorizada) queda sin ruta: ni rollout ni grant');
  await assert.rejects(jobs.enqueue({ tenantId: a.tenant, kind: 'social.compose', idempotencyKey: job.idempotency_key, input: { request: 'otro' }, useCases: ['social.facebook.post.compose'], createdBy: a.userId, labGrantId: null }),
    (e: unknown) => e instanceof AppError && e.status === 403 && e.code === 'permission_denied', 'misma clave sin grant: ni otro job ni la salida DRAFT del job de laboratorio');
  const replay = await jobs.enqueue({ tenantId: a.tenant, kind: 'social.compose', idempotencyKey: job.idempotency_key, input: { request: 'otro' }, useCases: ['social.facebook.post.compose'], createdBy: a.userId, labGrantId: grantId });
  assert.deepEqual([replay.created, replay.job.job_id], [false, job.job_id], 'misma clave y mismo grant = mismo job');
  assert.equal((await platform(adminToken, `/ai/lab/grants/${grantId}/revoke`, 'POST', { reason: 'Revocado antes de que el worker procese' })).status, 200);
  await jobs.drain(a.tenant);
  const done = await jobs.get(a.tenant, job.job_id);
  assert.deepEqual([done?.status, done?.error_code], ['failed', 'lab_grant_invalid']);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM ai_invocation WHERE job_id = $1`, [job.job_id]), 0, 'el worker no invocó nada con un grant revocado');
  const listed = (await platform(engToken, '/ai/jobs?status=failed')).body.jobs as Array<{ job_id: string; lab_grant_id: string | null }>;
  assert.equal(listed.find((j) => j.job_id === job.job_id)?.lab_grant_id, grantId);

  // Degradación de rol tras encolar: el worker revalida los permisos vigentes y no gasta (ni clasifica) con permisos viejos.
  const grant2 = (await platform(adminToken, '/ai/lab/grants', 'POST', { tenant_id: a.tenant, user_id: a.userId, route_ids: [compose.route_id], minutes: 15, reason: 'Composición social antes de degradar el rol' })).body.grant.grant_id as string;
  const queued = await jobs.enqueue({ tenantId: a.tenant, kind: 'social.compose', idempotencyKey: `down-${randomUUID()}`, input: { request: 'Anuncia el pan de muerto', with_image: false }, useCases: ['social.facebook.post.compose'], createdBy: a.userId, labGrantId: grant2 });
  assert.deepEqual([queued.created, queued.job.lab_grant_id], [true, grant2]);
  await t.pool.query(`DELETE FROM user_role WHERE user_id = $1 AND tenant_id = $2`, [a.userId, a.tenant]);
  await t.pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, 'read_only', $2)`, [a.userId, a.tenant]);
  assert.deepEqual(await t.handle.dispatcher.lab.check({ grantId: grant2, tenantId: a.tenant, userId: a.userId }), { ok: false, reason: 'permissions_revoked' });
  await jobs.drain(a.tenant);
  const downgraded = await jobs.get(a.tenant, queued.job.job_id);
  assert.deepEqual([downgraded?.status, downgraded?.error_code], ['failed', 'lab_grant_invalid']);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM ai_invocation WHERE job_id = $1`, [queued.job.job_id]), 0, 'sin invocaciones tras la degradación');
  await t.pool.query(`DELETE FROM user_role WHERE user_id = $1 AND tenant_id = $2`, [a.userId, a.tenant]);
  await t.pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, 'administration', $2)`, [a.userId, a.tenant]);
  assert.equal((await t.handle.dispatcher.lab.check({ grantId: grant2, tenantId: a.tenant, userId: a.userId })).ok, true, 'con el rol restaurado el grant vigente vuelve a ser válido');
});

test('DEC-0074 revisión manual: evidencia saneada; aceptar exige checklist y evidencia real ⇒ TESTED manual; rechazar la retira; approve/activate separados; fuera de lab no se despliega', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_labr');
  const haiku = await draftRoute(INSIGHTS, 'an:claude-haiku-5-5');
  const sonnet = await anthropicDraft(INSIGHTS, 'an:claude-sonnet-5-5');
  const reg = t.handle.dispatcher.registry;
  const insightsBefore = (await t.pool.query<{ active_route_id: string | null; canary_route_id: string | null; canary_percent: number }>(
    'SELECT active_route_id, canary_route_id, canary_percent FROM ai_rollout WHERE environment = $1 AND use_case_id = $2', [ENV, INSIGHTS])).rows[0];
  const grantId = (await platform(adminToken, '/ai/lab/grants', 'POST', { tenant_id: a.tenant, user_id: a.userId, route_ids: [haiku.route_id], minutes: 30, reason: 'Evidencia manual de Haiku para revisión' })).body.grant.grant_id as string;
  const fake = fakeAnthropic();
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests';
  const dispatcher = new AiDispatcher({ pool: t.pool, config: { ...t.handle.config, aiRealProviders: true, aiEnvironment: ENV }, fetchImpl: fake.fetchImpl, registry: reg, lab: t.handle.dispatcher.lab });
  const ctx = (key: string): InvokeContext => ({ requestId: key, idempotencyKey: key, tenantId: a.tenant, actorId: a.userId, actorKind: 'tenant_user', origin: 'lab-test', labGrantId: grantId, pinnedRouteId: haiku.route_id });
  const { good, failed } = await (async () => {
    try {
      const ok = await dispatcher.invokeStructured(INSIGHTS, ctx(`ev-${randomUUID()}`), VALUES);
      if (!ok.ok) throw new Error(`la evidencia buena debe ejecutarse: ${JSON.stringify(ok)}`);
      // Una ejecución fallida bajo el mismo grant: evidencia visible, nunca aceptable.
      const broken = new AiDispatcher({ pool: t.pool, config: { ...t.handle.config, aiRealProviders: true, aiEnvironment: ENV }, fetchImpl: async () => { throw new TypeError('network down'); }, registry: reg, lab: t.handle.dispatcher.lab });
      const bad = await broken.invokeStructured(INSIGHTS, ctx(`ev-${randomUUID()}`), VALUES);
      if (bad.ok || !bad.invocationId) throw new Error(`la evidencia fallida debe quedar trazada: ${JSON.stringify(bad)}`);
      return { good: ok.invocationId, failed: bad.invocationId };
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  })();

  // Evidencia: ids, hashes, costo, latencia; nunca salidas ni entradas.
  const evidence = await platform(engToken, `/ai/routes/${haiku.route_id}/manual-evidence`);
  assert.equal(evidence.status, 200, JSON.stringify(evidence.body));
  const inv = (evidence.body.invocations as Array<Record<string, unknown>>);
  const mine = inv.find((i) => i['invocation_id'] === good);
  assert.ok(mine);
  assert.deepEqual([mine['assignment'], mine['lab_grant_id'], mine['status'], mine['provider_kind'], mine['tenant_id']], ['manual_lab', grantId, 'succeeded', 'anthropic', a.tenant]);
  assert.match(String(mine['output_sha256']), /^[0-9a-f]{64}$/);
  assert.ok(!('output' in mine) && !('input' in mine) && !('usage' in mine));
  assert.doesNotMatch(JSON.stringify(evidence.body), /Sin datos suficientes|abstain_reason|pocos días/);
  assert.ok(inv.some((i) => i['invocation_id'] === failed && i['status'] === 'failed'));
  assert.deepEqual(evidence.body.reviews, []);
  assert.equal((await platform(supportToken, `/ai/routes/${haiku.route_id}/manual-evidence`)).status, 403);
  assert.equal((await platform(engToken, `/ai/routes/rte_inexistente/manual-evidence`)).status, 404);

  const full = { result_reviewed: true, task_fit: true, safety_privacy: true, cost_acceptable: true };
  const review = (body: Record<string, unknown>, token = engToken) => platform(token, `/ai/routes/${haiku.route_id}/manual-review`, 'POST', body);
  const accept = { invocation_ids: [good], decision: 'accept', notes: 'Resumen correcto, sin datos inventados; costo dentro de lo esperado.', checklist: full };
  assert.equal((await review(accept, supportToken)).status, 403, 'soporte no revisa');
  await t.pool.query(`UPDATE platform_session SET step_up_at = now() - interval '20 minutes' WHERE platform_user_id = $1`, [adminId]);
  assert.equal((await review(accept, adminToken)).body.error.code, 'step_up_required');
  await t.pool.query(`UPDATE platform_session SET step_up_at = now() WHERE platform_user_id = $1`, [adminId]);
  assert.equal((await review({ ...accept, checklist: { ...full, safety_privacy: false } })).status, 409, 'checklist incompleto no acepta');
  assert.equal((await review({ ...accept, checklist: { result_reviewed: true } })).status, 400, 'checklist con los cuatro puntos');
  assert.equal((await review({ ...accept, notes: 'corto' })).status, 400);
  // Las notas quedan sin negocio en ai_manual_review y en la auditoría de plataforma (DEC-0027): ni correos ni ids.
  const noted = await review({ ...accept, notes: `Revisado con ${a.login}: resumen correcto y sin datos inventados.` });
  assert.equal(noted.status, 400, JSON.stringify(noted.body));
  assert.match(noted.body.error.message, /datos de negocios/);
  assert.equal((await review({ ...accept, decision: 'maybe' })).status, 400);
  assert.equal((await review({ ...accept, invocation_ids: [] })).status, 400);
  assert.equal((await review({ ...accept, invocation_ids: [failed] })).status, 409, 'una ejecución fallida no es evidencia aceptable');
  assert.equal((await review({ ...accept, invocation_ids: [good, 'inv_inexistente'] })).status, 409);
  assert.equal((await platform(engToken, `/ai/routes/${sonnet.route_id}/manual-review`, 'POST', accept)).status, 409, 'la invocación debe ser de la misma ruta');
  const normalInv = (await t.pool.query<{ invocation_id: string }>(`SELECT invocation_id FROM ai_invocation WHERE assignment = 'active' AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1`)).rows[0];
  if (normalInv) assert.equal((await review({ ...accept, invocation_ids: [normalInv.invocation_id] })).status, 409, 'una invocación normal (no manual_lab) no es evidencia');
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM ai_manual_review WHERE route_id = $1', [haiku.route_id]), 0, 'ningún rechazo de validación deja registro');
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM ai_eval_run WHERE route_id = $1', [haiku.route_id]), 0, 'la revisión manual nunca crea evaluaciones');

  const accepted = await review(accept);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.deepEqual([accepted.body.route.status, accepted.body.route.tested_manual_review_id, accepted.body.route.tested_eval_run_id], ['TESTED', accepted.body.review.review_id, null]);
  assert.deepEqual([accepted.body.review.decision, accepted.body.review.invocation_ids, accepted.body.review.actor_id, accepted.body.review.environment], ['accept', [good], engId, 'lab']);
  assert.match(accepted.body.review.snapshot_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(accepted.body.review.snapshot.map((s: { invocation_id: string; output_sha256: string; lab_grant_id: string }) => [s.invocation_id, s.output_sha256, s.lab_grant_id]), [[good, mine['output_sha256'], grantId]]);
  assert.doesNotMatch(JSON.stringify(accepted.body), /Sin datos suficientes|abstain_reason/);
  await assert.rejects(t.pool.query(`UPDATE ai_manual_review SET decision = 'reject' WHERE review_id = $1`, [accepted.body.review.review_id]), /append-only/);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM ai_eval_run WHERE route_id = $1', [haiku.route_id]), 0, 'aceptar no inventa un ai_eval_run');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM platform_audit_event WHERE action = 'ai.manual_review' AND resource = $1 AND decision = 'allow'`, [`ai_route_revision/${haiku.route_id}`]), 1);
  const ucView = await platform(engToken, `/ai/use-cases/${INSIGHTS}`);
  const routeView = (ucView.body.routes as Array<{ route_id: string; tested_manual_review_id: string | null; last_manual_review: { decision: string } | null }>).find((r) => r.route_id === haiku.route_id);
  assert.deepEqual([routeView?.tested_manual_review_id, routeView?.last_manual_review?.decision], [accepted.body.review.review_id, 'accept']);
  const ev2 = await platform(engToken, `/ai/routes/${haiku.route_id}/manual-evidence`);
  assert.deepEqual((ev2.body.invocations as Array<{ invocation_id: string; review_ids: string[] }>).find((i) => i.invocation_id === good)?.review_ids, [accepted.body.review.review_id]);

  // Un rechazo posterior no deja un TESTED manual falso; otra aceptación vuelve a marcarla.
  const rejected = await review({ invocation_ids: [good], decision: 'reject', notes: 'Revisión posterior: el tono no corresponde a la marca.', checklist: { ...full, task_fit: false } });
  assert.equal(rejected.status, 201, JSON.stringify(rejected.body));
  assert.deepEqual([rejected.body.route.status, rejected.body.route.tested_manual_review_id], ['DRAFT', null]);
  const reaccepted = await review(accept);
  assert.deepEqual([reaccepted.status, reaccepted.body.route.status], [201, 'TESTED']);

  // Approve (step-up) y activate siguen siendo pasos separados; fuera de lab la ruta manual no se despliega.
  await t.pool.query(`UPDATE platform_session SET step_up_at = now() WHERE platform_user_id = $1`, [engId]);
  const approved = await platform(engToken, `/ai/routes/${haiku.route_id}/approve`, 'POST', {});
  assert.deepEqual([approved.status, approved.body.route.status], [200, 'APPROVED']);
  await assert.rejects(reg.activate(INSIGHTS, 'test', haiku.route_id, 'test', 'DEC-0074 prueba: fuera de lab'), /suite automática/);
  const activated = await platform(engToken, `/ai/use-cases/${INSIGHTS}/rollout`, 'POST', { action: 'activate', route_id: haiku.route_id, reason: 'Despliegue en laboratorio tras revisión manual aceptada' });
  assert.deepEqual([activated.status, activated.body.rollout.active_route_id], [200, haiku.route_id]);
  assert.equal((await review(accept)).status, 409, 'una ruta desplegada ya no se revisa manualmente');
  await assert.rejects(t.pool.query(`UPDATE ai_lab_grant_route SET route_id = $2 WHERE grant_id = $1`, [grantId, sonnet.route_id]), /immutable/);
  // Restaurar el rollout compartido de `lab` (entorno por defecto de otros archivos de integración).
  await t.pool.query(`UPDATE ai_rollout SET active_route_id = $3, canary_route_id = $4, canary_percent = $5, version = version + 1, updated_by = 'test:restore', updated_at = now()
                       WHERE use_case_id = $1 AND environment = $2`, [INSIGHTS, ENV, insightsBefore?.active_route_id ?? null, insightsBefore?.canary_route_id ?? null, insightsBefore?.canary_percent ?? 0]);
  await t.pool.query(`UPDATE ai_route_revision SET status = 'APPROVED' WHERE route_id = $1 AND status = 'ACTIVE'`, [haiku.route_id]);
  if (insightsBefore?.active_route_id) await t.pool.query(`UPDATE ai_route_revision SET status = 'ACTIVE' WHERE route_id = $1`, [insightsBefore.active_route_id]);
});
