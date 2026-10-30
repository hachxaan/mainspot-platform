/**
 * AI Core (issue #9) — integración con PostgreSQL real y proveedores SIMULADOS o falsos inyectados.
 * SIMULATED_REGRESSION: no acredita calidad de modelos reales; eso está en evidence/ai-core/.
 *
 * Cubre: diseño IA → vista previa → aprobación → HTML publicado sin scripts + imágenes de la
 * biblioteca (también en el host del sitio, acotadas al negocio); edición por ruta fijada aunque
 * cambie el rollout (E18) y guard de versión; política de datos y techo duro con reservas
 * concurrentes (E15); identidad de plataforma con MFA, step-up y roles separados (E03/E17);
 * Jev en atención + ledger único (FR-0016); asistente acotado al negocio (E11); campañas sin gasto.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { bootApi, authHeaders, api, login, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows } from '../helpers/tenants.ts';
import { AiDispatcher } from '../../src/ai/dispatcher.ts';
import { currentStep, totpAt } from '../../src/platform/auth.ts';

const DOMAIN = 'mainspot.test';
const ENV = 'test';
let t: TestApi;

before(async () => {
  t = await bootApi({ localSiteDomain: DOMAIN, publicBaseUrl: `https://app.${DOMAIN}`, aiEnvironment: ENV, platformMfaKey: randomBytes(32).toString('base64') });
});

after(async () => {
  t.handle.aiJobs.stop();
  await t.close();
});

function call(token: string, path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
  return api(t.baseUrl, `/api/backoffice${path}`, { method, headers: authHeaders(token, extra), body: body === undefined ? undefined : JSON.stringify(body) });
}
function platform(token: string | null, path: string, method = 'GET', body?: unknown) {
  return api(t.baseUrl, `/api/platform${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
function rawGet(path: string, host: string): Promise<{ status: number; body: Buffer; type: string }> {
  const u = new URL(t.baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path, headers: { Host: host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), type: String(res.headers['content-type'] ?? '') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const LIMITS = { conversations: 50, website: 1, social_posts: 20, reviews_managed: 100 };

async function siteWithDesign(prefix: string) {
  const a = await createTenantWithPlan(t, LIMITS, prefix);
  const slug = `ai-${randomUUID().slice(0, 6)}`;
  const created = await call(a.token, '/website', 'POST', { slug, site_name: `Café ${slug}`, data: { line: 'Café de altura', hours: 'Lunes a sábado: 7 a 20', services: ['Café de olla', 'Pan dulce'] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const brand = await call(a.token, '/ai/brand', 'PUT', { changes: [{ key: 'category', value: 'Cafetería' }, { key: 'voice', value: 'Cercana y cálida' }, { key: 'prices', value: [{ item: 'Café de olla', price: '$35' }] }] });
  assert.equal(brand.status, 200, JSON.stringify(brand.body));
  const job = await call(a.token, '/ai/website/design', 'POST', { brief: 'Cálida y artesanal' }, { 'Idempotency-Key': `design-${slug}` });
  assert.equal(job.status, 202, JSON.stringify(job.body));
  const replay = await call(a.token, '/ai/website/design', 'POST', { brief: 'Cálida y artesanal' }, { 'Idempotency-Key': `design-${slug}` });
  assert.deepEqual([replay.status, replay.body.job.job_id], [200, job.body.job.job_id], 'misma clave = mismo job');
  await t.handle.aiJobs.drain(a.tenant);
  const done = await call(a.token, `/ai/jobs/${job.body.job.job_id}`);
  assert.equal(done.body.job.status, 'succeeded', JSON.stringify(done.body.job));
  return { ...a, slug, result: done.body.job.result as { proposal_id: string; images: number; simulated: boolean } };
}

test('E05/E07/E13: diseño IA → vista previa → aprobación → HTML sin scripts con imágenes de la biblioteca, acotadas al negocio', async () => {
  const a = await siteWithDesign('client_aid');
  assert.equal(a.result.simulated, true, 'en pruebas el proveedor es el simulador (etiquetado)');
  assert.ok(a.result.images >= 1, 'el diseño trae imágenes guardadas en la biblioteca');
  const proposal = await call(a.token, `/conversation/proposals/${a.result.proposal_id}`);
  assert.equal(proposal.body.proposal.status, 'preview_ready');
  assert.equal(proposal.body.proposal.proposal_type, 'website.ai_design');
  assert.ok(Number.isInteger(proposal.body.proposal.detail.base_version));
  const preview = await call(a.token, `/ai/website/proposals/${a.result.proposal_id}/render`);
  assert.equal(preview.status, 200);
  assert.match(preview.body.html, /class="blk blk-hero/);
  assert.doesNotMatch(preview.body.html, /<script/i);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM website_content WHERE tenant_id = $1', [a.tenant]), 0, 'nada en vivo antes de aprobar');

  const pub = await call(a.token, `/conversation/proposals/${a.result.proposal_id}/approve`, 'POST');
  assert.equal(pub.body.status, 'published', JSON.stringify(pub.body));
  const html = (await t.pool.query<{ html: string }>('SELECT html FROM website_content WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1', [a.tenant])).rows[0]?.html ?? '';
  assert.doesNotMatch(html, /<script/i);
  const assetId = /\/media\/(ast_[A-Za-z0-9_-]+)\//.exec(html)?.[1];
  assert.ok(assetId, 'el HTML publicado usa imágenes de la biblioteca');
  const st = await t.pool.query<{ status: string; is_illustration: boolean; license: string }>('SELECT status, is_illustration, license FROM media_asset WHERE asset_id = $1', [assetId]);
  assert.deepEqual([st.rows[0]?.status, st.rows[0]?.is_illustration], ['approved', true], 'publicar aprueba la imagen; se declara ilustración');
  assert.match(st.rows[0]?.license ?? '', /IA/);
  const img = await fetch(`${t.baseUrl}/media/${assetId}/w640.webp`);
  assert.equal(img.status, 200);
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP');

  // Host del sitio: sirve la imagen del propio negocio y nunca la de otro.
  const onSite = await rawGet(`/media/${assetId}/w640.webp`, `${a.slug}.${DOMAIN}`);
  assert.deepEqual([onSite.status, onSite.type], [200, 'image/webp']);
  const b = await siteWithDesign('client_aie');
  const otherAsset = (await t.pool.query<{ asset_id: string }>('SELECT asset_id FROM media_asset WHERE tenant_id = $1 LIMIT 1', [b.tenant])).rows[0]?.asset_id;
  assert.ok(otherAsset);
  assert.equal((await rawGet(`/media/${otherAsset}/w640.webp`, `${a.slug}.${DOMAIN}`)).status, 404, 'otro negocio = 404 en este sitio');
  // La biblioteca y los jobs de un negocio no se ven desde otro (mismo 404 que inexistente).
  assert.equal((await call(b.token, `/ai/jobs/${(await call(a.token, '/ai/jobs')).body.jobs[0].job_id}`)).status, 404);
  assert.equal((await call(b.token, `/ai/website/proposals/${a.result.proposal_id}/render`)).status, 404);
  const archive = await call(a.token, `/ai/media/${assetId}`, 'PATCH', { status: 'archived' });
  assert.equal(archive.status, 409, 'una imagen usada por la página publicada no se archiva');
});

test('E06/E18: la edición usa la ruta fijada al crear el job aunque cambie el rollout; base_version protege publicaciones', async () => {
  const a = await siteWithDesign('client_aif');
  assert.equal((await call(a.token, `/conversation/proposals/${a.result.proposal_id}/approve`, 'POST')).body.status, 'published');
  const reg = t.handle.dispatcher.registry;
  const before = new Map<string, string>();
  for (const uc of ['website.edit.simple', 'website.edit.complex']) before.set(uc, (await reg.rollout(uc, ENV))?.active_route_id as string);

  const job = await call(a.token, '/ai/website/edit', 'POST', { instruction: 'Cambia el horario: ahora abrimos de 8:00 a 14:00' });
  assert.equal(job.status, 202, JSON.stringify(job.body));
  const pinned = (await t.handle.aiJobs.get(a.tenant, job.body.job.job_id))?.pinned ?? {};
  // Mientras el job espera, ingeniería activa rutas nuevas: el job en curso no debe cambiar.
  const swapped: string[] = [];
  for (const uc of ['website.edit.simple', 'website.edit.complex']) {
    const cur = await reg.bundle(before.get(uc) as string);
    assert.ok(cur);
    const r = await reg.createRoute({ useCaseId: uc, modelId: cur.model.model_id, promptRevisionId: cur.prompt.revision_id, params: { timeout_ms: 20_000, max_tokens: 1500 }, maxCostUsd: 0.01, changeNote: 'E18 ruta nueva durante un job', actor: 'test:e18' });
    await reg.activate(uc, ENV, r.route_id, 'test:e18', 'E18: cambio de rollout concurrente', 'seed');
    swapped.push(r.route_id);
  }
  try {
    await t.handle.aiJobs.drain(a.tenant);
    const done = (await call(a.token, `/ai/jobs/${job.body.job.job_id}`)).body.job;
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
    assert.equal(done.result.status, 'proposed');
    assert.equal(done.result.use_case, 'website.edit.simple', 'un cambio de dato usa la ruta de ediciones simples');
    const inv = await t.pool.query<{ route_id: string }>(`SELECT route_id FROM ai_invocation WHERE job_id = $1 AND use_case_id = $2`, [done.job_id, done.result.use_case]);
    assert.equal(inv.rows[0]?.route_id, pinned[done.result.use_case], 'la invocación usó la ruta fijada');
    assert.ok(!swapped.includes(inv.rows[0]?.route_id as string));

    // Otra versión se publica encima (teléfono) => la edición preparada sobre la anterior responde 409.
    const p = await call(a.token, `/conversation/proposals/${done.result.proposal_id}`);
    assert.equal(p.body.proposal.detail.after.hours.includes('8'), true);
    await t.pool.query(`UPDATE client_website SET published_version = published_version + 1 WHERE tenant_id = $1`, [a.tenant]);
    const stale = await call(a.token, `/conversation/proposals/${done.result.proposal_id}/approve`, 'POST');
    assert.ok([409].includes(stale.status) || stale.body.status === 'failed', JSON.stringify(stale.body));
    await t.pool.query(`UPDATE client_website SET published_version = published_version - 1 WHERE tenant_id = $1`, [a.tenant]);
  } finally {
    for (const uc of ['website.edit.simple', 'website.edit.complex']) await reg.activate(uc, ENV, before.get(uc) as string, 'test:e18', 'E18: restaurar rollout', 'seed');
  }
});

test('E14: un job que cae a mitad se reintenta con su lease y reutiliza el paso ya pagado (sin doble invocación)', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_aim');
  const slug = `ai-${randomUUID().slice(0, 6)}`;
  assert.equal((await call(a.token, '/website', 'POST', { slug, site_name: `Taller ${slug}`, data: { line: 'Mecánica honesta' } })).status, 201);
  const job = (await call(a.token, '/ai/website/design', 'POST', { brief: 'Confiable' })).body.job;
  const media = t.handle.media;
  const original = media.store.bind(media);
  let crash = true;
  media.store = async (input) => {
    if (crash) { crash = false; throw new Error('caída simulada del worker después del diseño'); }
    return original(input);
  };
  try {
    await t.handle.aiJobs.tick(1);
    const mid = await t.handle.aiJobs.get(a.tenant, job.job_id);
    assert.deepEqual([mid?.status, mid?.attempts], ['queued', 1], 'reintento acotado, no fallo terminal');
    await t.pool.query(`UPDATE ai_job SET next_attempt_at = now() WHERE job_id = $1`, [job.job_id]);
    await t.handle.aiJobs.drain(a.tenant);
  } finally {
    media.store = original;
  }
  const done = await t.handle.aiJobs.get(a.tenant, job.job_id);
  assert.equal(done?.status, 'succeeded', JSON.stringify(done));
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM ai_invocation WHERE job_id = $1 AND use_case_id = 'website.initial.design' AND status = 'succeeded'`, [job.job_id]), 1, 'el diseño se generó una sola vez');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM action_proposal WHERE tenant_id = $1 AND proposal_type = 'website.ai_design'`, [a.tenant]), 1, 'una sola propuesta');
});

test('E15/BR-0007: proveedor real solo con negocio sintético; techo duro con reservas concurrentes', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_aig');
  const route = (await t.pool.query<{ route_id: string; max_cost_usd: string }>(
    `SELECT r.route_id, r.max_cost_usd FROM ai_route_revision r JOIN ai_model m ON m.model_id = r.model_id JOIN ai_provider p ON p.provider_id = m.provider_id
      WHERE r.use_case_id = 'business.insights.generate' AND p.kind = 'openrouter' AND r.status <> 'RETIRED' ORDER BY r.version LIMIT 1`)).rows[0];
  assert.ok(route, 'hay una ruta OpenRouter candidata');
  let calls = 0;
  const fake: typeof fetch = async (_url, init) => {
    calls++;
    await new Promise((r) => setTimeout(r, 150));
    const body = JSON.parse(String(init?.body ?? '{}')) as { provider?: { data_collection?: string } };
    assert.equal(body.provider?.data_collection, 'deny', 'nunca se permite retención de datos');
    return new Response(JSON.stringify({ id: 'gen-test', model: 'fake', choices: [{ message: { content: JSON.stringify({ status: 'abstained', summary: 'Sin datos suficientes.', highlights: [], recommendations: [], abstain_reason: 'pocos días' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.0004 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const prevKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fake-key-for-tests';
  const dispatcher = new AiDispatcher({ pool: t.pool, config: { ...t.handle.config, aiRealProviders: true, aiEnvironment: ENV }, fetchImpl: fake });
  const ctx = (key: string) => ({ requestId: key, idempotencyKey: key, tenantId: a.tenant, actorId: a.userId, actorKind: 'tenant_user' as const, origin: 'test', pinnedRouteId: route.route_id });
  const values = { period: '2026-10-24 a 2026-10-30', metrics: { days_with_activity: 1 } };
  try {
    const real = await dispatcher.invokeStructured('business.insights.generate', ctx(`k-${randomUUID()}`), values);
    assert.deepEqual([real.ok, !real.ok && real.code], [false, 'blocked_external'], 'negocio con datos reales: bloqueado sin llamar');
    assert.equal(calls, 0);

    await t.pool.query(`UPDATE client SET data_classification = 'synthetic' WHERE client_id = $1`, [a.tenant]);
    await t.pool.query(`INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by) VALUES ($1,'tenant_day',$2,$3,'test','test')`,
      [`bud_${randomUUID()}`, a.tenant, Number(route.max_cost_usd) * 1.5]);
    const [x, y] = await Promise.all([
      dispatcher.invokeStructured('business.insights.generate', ctx(`k-${randomUUID()}`), values),
      dispatcher.invokeStructured('business.insights.generate', ctx(`k-${randomUUID()}`), values),
    ]);
    const codes = [x, y].map((r) => (r.ok ? 'ok' : r.code)).sort();
    assert.deepEqual(codes, ['budget_exhausted', 'ok'], 'dos reservas concurrentes no superan el techo');
    assert.equal(calls, 1);
    const okOne = [x, y].find((r) => r.ok);
    assert.ok(okOne && okOne.ok && okOne.costUsd === 0.0004 && okOne.costSource === 'reported', 'el costo reportado por el proveedor queda registrado');
    // Con el costo real (menor que la reserva) cabe una llamada más.
    const third = await dispatcher.invokeStructured('business.insights.generate', ctx(`k-${randomUUID()}`), values);
    assert.equal(third.ok, true);
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey;
  }
});

test('E03/E17: consola de plataforma con MFA, anti-replay, step-up y roles separados; sesiones no intercambiables', async () => {
  const auth = t.handle.platformAuth;
  const sfx = randomUUID().slice(0, 6);
  const admin = await auth.createUser({ login: `admin-${sfx}`, displayName: 'Admin', password: 'Plataforma-Admin-2026', roles: ['platform_admin'], grantedBy: 'test' });
  const eng = await auth.createUser({ login: `eng-${sfx}`, displayName: 'Ingeniería', password: 'Plataforma-Ingenia-2026', roles: ['ai_engineer'], grantedBy: 'test' });
  const step = currentStep();
  assert.equal((await platform(null, '/auth/login', 'POST', { login: `admin-${sfx}`, password: 'Plataforma-Admin-2026', code: '000000' })).status, 401);
  const code = totpAt(admin.totp_secret, step);
  const adminLogin = await platform(null, '/auth/login', 'POST', { login: `admin-${sfx}`, password: 'Plataforma-Admin-2026', code });
  assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
  assert.equal((await platform(null, '/auth/login', 'POST', { login: `admin-${sfx}`, password: 'Plataforma-Admin-2026', code })).status, 401, 'el mismo código no sirve dos veces');
  const adminToken = adminLogin.body.token as string;
  const engToken = (await platform(null, '/auth/login', 'POST', { login: `eng-${sfx}`, password: 'Plataforma-Ingenia-2026', code: totpAt(eng.totp_secret, step) })).body.token as string;

  // Separación de sesiones: el token de negocio no abre la plataforma y viceversa.
  const owner = await createTenantWithPlan(t, LIMITS, 'client_aih');
  assert.equal((await platform(owner.token, '/me')).status, 401);
  assert.equal((await call(adminToken, '/ai/status')).status, 401);

  // Roles: ingeniería no administra negocios; administración no cambia rutas.
  assert.equal((await platform(engToken, '/tenants')).status, 403);
  const tenants = await platform(adminToken, '/tenants');
  assert.equal(tenants.status, 200);
  assert.doesNotMatch(JSON.stringify(tenants.body), /password|token_box|totp|secret/i);
  assert.equal((await platform(adminToken, '/ai/use-cases/website.edit.simple/rollout', 'POST', { action: 'rollback', reason: 'no debería poder' })).status, 403);

  // Step-up: sin confirmación reciente, una acción con efecto se niega y queda auditada.
  await t.pool.query(`UPDATE platform_session SET step_up_at = now() - interval '20 minutes' WHERE platform_user_id = $1`, [eng.platform_user_id]);
  const uc = 'editorial.calendar.suggest';
  const reg = t.handle.dispatcher.registry;
  const original = (await reg.rollout(uc, ENV))?.active_route_id as string;
  const bundle = await reg.bundle(original);
  assert.ok(bundle);
  const candidate = await reg.createRoute({ useCaseId: uc, modelId: bundle.model.model_id, promptRevisionId: bundle.prompt.revision_id, params: { timeout_ms: 20_000 }, maxCostUsd: 0.01, changeNote: 'E04 candidata', actor: 'test' });
  const needs = await platform(engToken, `/ai/use-cases/${uc}/rollout`, 'POST', { action: 'activate', route_id: candidate.route_id, reason: 'activar candidata evaluada' });
  assert.deepEqual([needs.status, needs.body.error.code], [403, 'step_up_required']);
  assert.equal((await platform(engToken, '/auth/step-up', 'POST', { code: totpAt(eng.totp_secret, step + 1) })).status, 200);
  // Ruta en borrador no se despliega: primero evaluación (TESTED) y aprobación.
  assert.equal((await platform(engToken, `/ai/use-cases/${uc}/rollout`, 'POST', { action: 'activate', route_id: candidate.route_id, reason: 'activar sin evaluar' })).status, 409);
  const evalRun = await platform(engToken, `/ai/routes/${candidate.route_id}/evaluate`, 'POST', {});
  assert.equal(evalRun.status, 202);
  for (let i = 0; i < 50; i++) {
    const runs = await platform(engToken, `/ai/routes/${candidate.route_id}/evals`);
    if (runs.body.runs[0]?.status && runs.body.runs[0].status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await platform(engToken, `/ai/routes/${candidate.route_id}/approve`, 'POST', {})).status, 200);
  const canary = await platform(engToken, `/ai/use-cases/${uc}/rollout`, 'POST', { action: 'canary', route_id: candidate.route_id, percent: 25, reason: 'canary del 25 % para comparar' });
  assert.equal(canary.status, 200, JSON.stringify(canary.body));
  const promote = await platform(engToken, `/ai/use-cases/${uc}/rollout`, 'POST', { action: 'promote', reason: 'métricas iguales o mejores' });
  assert.equal(promote.body.rollout.active_route_id, candidate.route_id);
  const rollback = await platform(engToken, `/ai/use-cases/${uc}/rollout`, 'POST', { action: 'rollback', reason: 'volver a la ruta anterior' });
  assert.equal(rollback.body.rollout.active_route_id, original, 'rollback sin redeploy');
  assert.ok(await countRows(t, `SELECT count(*) AS n FROM platform_audit_event WHERE actor_id = $1 AND decision = 'deny' AND result = 'step_up_required'`, [eng.platform_user_id]) >= 1);
  assert.ok(await countRows(t, `SELECT count(*) AS n FROM ai_rollout_event WHERE use_case_id = $1 AND action IN ('canary','promote','rollback') AND actor_id = $2`, [uc, `platform:${eng.platform_user_id}`]) >= 3);

  // Soporte: acceso temporal con motivo, visible para el negocio; sin acceso no hay vista.
  assert.equal((await platform(adminToken, `/tenants/${owner.tenant}/support-view`)).status, 403);
  assert.equal((await platform(adminToken, `/tenants/${owner.tenant}/support-access`, 'POST', { reason: 'Revisar por qué falla su diseño', minutes: 15 })).status, 201);
  const view = await platform(adminToken, `/tenants/${owner.tenant}/support-view`);
  assert.equal(view.status, 200);
  assert.doesNotMatch(JSON.stringify(view.body), /body|message|raw_message/);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'platform.support.access_granted'`, [owner.tenant]), 1);
});

test('FR-0016: Jev lee comentarios (sin guardar el texto en la lectura) y el ledger impide una segunda respuesta pública', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_aij');
  const post = `post_${randomUUID().slice(0, 8)}`;
  await t.pool.query(`INSERT INTO social_post (post_id, tenant_id, network, content_type, text, status, published_at, external_ref, created_by) VALUES ($1,$2,'facebook','post','Pan de muerto','published',now(),$3,'fixture')`, [post, a.tenant, `sim:fb:post:${post}`]);
  const ref = `c-${randomUUID().slice(0, 6)}`;
  const inj = await call(a.token, '/dev/simulator/facebook-comments', 'POST', { post_id: post, body: '¡Gracias! Estuvo delicioso el pan.', author_label: 'Luis R.', external_ref: ref });
  assert.equal(inj.status, 201, JSON.stringify(inj.body));
  // Otro camino ya respondió ese comentario: el agente no publica una segunda respuesta.
  await t.pool.query(`INSERT INTO response_ledger (tenant_id, origin, target_ref, path, owner_ref, state) VALUES ($1,'facebook_comment',$2,'reputation','proposal:otro','sent')`, [a.tenant, ref]);
  const run = await call(a.token, '/engagement/run', 'POST');
  assert.equal(run.status, 200);
  const c = (await t.pool.query<{ semantic_source: string; sentiment: string; semantic: Record<string, unknown>; state: string; drafts: string[] }>(
    'SELECT semantic_source, sentiment, semantic, state, drafts FROM engagement_case WHERE tenant_id = $1 AND external_ref = $2', [a.tenant, ref])).rows[0];
  assert.ok(c);
  assert.equal(c.semantic_source, 'jev', 'con ruta activa, la lectura semántica es de Jev');
  assert.ok(['positive', 'neutral', 'negative', 'mixed'].includes(c.sentiment));
  assert.doesNotMatch(JSON.stringify(c.semantic), /delicioso/, 'la lectura guardada no contiene el texto del cliente');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM sim_provider_reply WHERE tenant_id = $1`, [a.tenant]), 0, 'sin segunda respuesta pública');
  assert.ok(['needs_human', 'closed_elsewhere'].includes(c.state), c.state);

  // Sin lectura semántica (proveedor caído) => revisión humana, nunca respuesta automática.
  const ref2 = `c-${randomUUID().slice(0, 6)}`;
  await call(a.token, '/engagement/policies', 'PUT', { origin: 'facebook_comment', category: 'gratitude', mode: 'safe_auto_reply', consent: true });
  await call(a.token, '/dev/simulator/facebook-comments', 'POST', { post_id: post, body: '¡Gracias, excelente servicio!', author_label: 'Ana', external_ref: ref2 });
  await t.pool.query(`UPDATE ai_provider SET status = 'disabled' WHERE kind = 'simulated'`);
  try {
    await call(a.token, '/engagement/run', 'POST');
  } finally {
    await t.pool.query(`UPDATE ai_provider SET status = 'active' WHERE kind = 'simulated'`);
  }
  const c2 = (await t.pool.query<{ decision: string; reason: string; semantic_source: string }>('SELECT decision, reason, semantic_source FROM engagement_case WHERE tenant_id = $1 AND external_ref = $2', [a.tenant, ref2])).rows[0];
  assert.deepEqual([c2?.decision, c2?.semantic_source], ['human_review', 'blocked_external']);
});

test('E11/E12: asistente con datos SOLO del propio negocio; campaña aprobada sin gasto; read_only no genera', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_aik');
  const b = await createTenantWithPlan(t, LIMITS, 'client_ail');
  for (let i = 0; i < 3; i++) {
    await t.pool.query(`INSERT INTO engagement_case (case_id, tenant_id, origin, external_ref, author_label, body, state, drafts) VALUES ($1,$2,'facebook_comment',$3,'X','Queja de prueba','needs_human','[]')`, [`case_${randomUUID()}`, b.tenant, `b-${randomUUID()}`]);
  }
  await t.pool.query(`INSERT INTO engagement_case (case_id, tenant_id, origin, external_ref, author_label, body, state, drafts) VALUES ($1,$2,'facebook_comment',$3,'Y','Pregunta','needs_human','[]')`, [`case_${randomUUID()}`, a.tenant, `a-${randomUUID()}`]);
  const ans = await call(a.token, '/ai/assistant', 'POST', { question: '¿Qué comentarios necesitan mi respuesta?' });
  assert.equal(ans.status, 200, JSON.stringify(ans.body));
  assert.match(ans.body.answer, /: 1\b/, 'cuenta solo los casos del propio negocio');
  assert.doesNotMatch(ans.body.answer, /: 3\b/);
  assert.deepEqual(ans.body.tools_used, ['attention_cases']);

  const cmp = await call(a.token, '/ai/campaigns', 'POST', { objective: 'Más clientes en noviembre', budget_hint_mxn: 500 });
  assert.equal(cmp.status, 201, JSON.stringify(cmp.body));
  const id = cmp.body.campaign.campaign_id;
  const ok = await call(a.token, `/ai/campaigns/${id}/decision`, 'POST', { decision: 'approve' });
  assert.deepEqual([ok.status, ok.body.campaign.spend, ok.body.campaign.spend_authorized], [200, 'BLOCKED_EXTERNAL', false]);
  await assert.rejects(t.pool.query('UPDATE marketing_campaign SET spend_authorized = true WHERE campaign_id = $1', [id]), /check/i, 'la BD impide autorizar gasto');
  assert.equal((await call(b.token, `/ai/campaigns/${id}/decision`, 'POST', { decision: 'reject' })).status, 404, 'otro negocio = 404');

  const userId = `user_ro_${a.tenant}`;
  await t.pool.query(`INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash) VALUES ($1,'Lectura',$2,'active',$3,crypt('Fixture-Read-2026!', gen_salt('bf', 4)))`, [userId, `ro@${a.tenant}.example.com`, a.tenant]);
  await t.pool.query('INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1,$2,$3)', [userId, 'read_only', a.tenant]);
  const ro = (await login(t.baseUrl, `ro@${a.tenant}.example.com`, 'Fixture-Read-2026!', a.tenant)).token;
  assert.equal((await call(ro, '/ai/website/design', 'POST', { brief: 'x' })).status, 403);
  assert.equal((await call(ro, '/ai/brand', 'PUT', { changes: [{ key: 'voice', value: 'x' }] })).status, 403);
  assert.equal((await call(ro, '/ai/brand')).status, 200);
});
