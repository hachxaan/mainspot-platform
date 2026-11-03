/**
 * Regresión técnica offline del laboratorio en superficies de negocio.
 * PostgreSQL/HTTP reales locales; proveedor de imágenes HTTP sustituido en memoria.
 * No acredita generación ni calidad real y nunca ejecuta suites generativas.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { api, authHeaders, bootApi, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan } from '../helpers/tenants.ts';
import { currentStep, totpAt } from '../../src/platform/auth.ts';

let t: TestApi;
let engineer: string;
const limits = { conversations: 20, website: 1, social_posts: 10, reviews_managed: 20 };

before(async () => {
  t = await bootApi({ aiEnvironment: 'lab', aiRealProviders: true, platformMfaKey: randomBytes(32).toString('base64') });
  const login = `lab-native-${randomUUID()}`;
  const user = await t.handle.platformAuth.createUser({ login, displayName: 'Laboratorio técnico offline', password: 'Local-Lab-Only-2026!', roles: ['ai_engineer'], grantedBy: 'test' });
  const logged = await api(t.baseUrl, '/api/platform/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password: 'Local-Lab-Only-2026!', code: totpAt(user.totp_secret, currentStep()) }) });
  assert.equal(logged.status, 200);
  engineer = logged.body.token;
});
after(async () => { t.handle.aiJobs.stop(); await t.close(); });

function back(token: string, path: string, body?: unknown, grant?: string, key?: string) {
  return api(t.baseUrl, `/api/backoffice${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: authHeaders(token, { ...(grant ? { 'X-AI-Lab-Grant': grant } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function platform(path: string, body: unknown) {
  return api(t.baseUrl, `/api/platform${path}`, { method: 'POST', headers: authHeaders(engineer), body: JSON.stringify(body) });
}
async function candidate(useCaseId: string, modelId: string) {
  const row = (await t.pool.query<{ prompt_revision_id: string; max_cost_usd: string }>(
    `SELECT prompt_revision_id,max_cost_usd FROM ai_route_revision WHERE use_case_id=$1 AND model_id=$2 AND status <> 'RETIRED' ORDER BY version DESC LIMIT 1`, [useCaseId, modelId])).rows[0]!;
  return t.handle.dispatcher.registry.createRoute({ useCaseId, modelId, promptRevisionId: row.prompt_revision_id, params: { max_tokens: 1000, timeout_ms: 20000, repair_attempts: 0 }, maxCostUsd: Number(row.max_cost_usd), changeNote: 'Fixture de autorización técnica offline, no calidad', actor: 'test:lab-native' });
}
async function grantFor(owner: { tenant: string; userId: string }, routeIds: string[]) {
  const result = await platform('/ai/lab/grants', { tenant_id: owner.tenant, user_id: owner.userId, route_ids: routeIds, minutes: 5, reason: 'Comprobar autorización técnica sin proveedores reales' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.grant.grant_id as string;
}

test('una autorización DRAFT no es tráfico normal; el job nativo fija el grant y una revocación impide ejecutarlo o reutilizarlo', async () => {
  const owner = await createTenantWithPlan(t, limits, 'client_lab_native_job');
  const route = await candidate('social.facebook.post.compose', 'an:claude-haiku-5-5');
  const grant = await grantFor(owner, [route.route_id]);
  const normal = await back(owner.token, '/ai/status');
  const normalActive = normal.body.capabilities.find((c: { use_case: string }) => c.use_case === route.use_case_id).active;
  const selected = await back(owner.token, '/ai/status', undefined, grant);
  assert.equal(selected.body.capabilities.find((c: { use_case: string }) => c.use_case === route.use_case_id).active, normalActive, 'el grant no falsea el rollout normal');
  assert.equal(selected.body.lab.capabilities.find((c: { use_case: string }) => c.use_case === route.use_case_id).route_id, route.route_id);
  const key = randomUUID();
  const queued = await back(owner.token, '/ai/social/compose', { request: 'Cuenta que servimos café recién preparado.', with_image: false }, grant, key);
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const job = await t.handle.aiJobs.get(owner.tenant, queued.body.job.job_id);
  assert.equal(job?.lab_grant_id, grant);
  assert.equal(job?.pinned[route.use_case_id], route.route_id);
  const replay = await back(owner.token, '/ai/social/compose', { request: 'Cuenta que servimos café recién preparado.', with_image: false }, grant, key);
  assert.deepEqual([replay.status, replay.body.job.job_id], [200, queued.body.job.job_id]);
  assert.equal((await back(owner.token, '/ai/social/compose', { request: 'Cuenta que servimos café recién preparado.', with_image: false }, undefined, key)).status, 403, 'un replay normal no recibe el job DRAFT de laboratorio');
  assert.equal((await platform(`/ai/lab/grants/${grant}/revoke`, { reason: 'Revocación antes de ejecutar el trabajo pendiente' })).status, 200);
  await t.handle.aiJobs.drain(owner.tenant);
  const done = await t.handle.aiJobs.get(owner.tenant, queued.body.job.job_id);
  assert.deepEqual([done?.status, done?.error_code], ['failed', 'lab_grant_invalid']);
  assert.equal((await back(owner.token, '/ai/social/compose', { request: 'Cuenta que servimos café recién preparado.', with_image: false }, grant, key)).status, 403);
  assert.equal((await t.pool.query(`SELECT count(*)::int AS n FROM ai_invocation WHERE tenant_id=$1`, [owner.tenant])).rows[0].n, 0, 'revocar antes de worker no clasifica ni genera');
});

test('imagen y respuesta manual rechazan grant ajeno o caso no incluido antes de clasificar/generar', async () => {
  const owner = await createTenantWithPlan(t, limits, 'client_lab_native_scope');
  const other = await createTenantWithPlan(t, limits, 'client_lab_native_other');
  const route = await candidate('social.facebook.post.compose', 'an:claude-haiku-5-5');
  const grant = await grantFor(owner, [route.route_id]);
  const image = { purpose: 'website', subject: 'Una taza de café sobre madera', style: 'Editorial contemporáneo', aspect_ratio: '16:9' };
  assert.equal((await back(other.token, '/ai/lab/images', image, grant, randomUUID())).status, 403);
  assert.equal((await back(owner.token, '/ai/lab/images', image, grant, randomUUID())).status, 403);
  assert.equal((await back(owner.token, '/ai/lab/replies', { origin: 'facebook_comment', message: 'Gracias por el servicio.' }, grant, randomUUID())).status, 403);
  assert.equal((await back(owner.token, '/ai/lab/replies', { origin: 'facebook_comment', message: 'Gracias por el servicio.' }, undefined, randomUUID())).status, 403);
  const rows = await t.pool.query(`SELECT count(*)::int AS n FROM ai_invocation WHERE tenant_id=ANY($1::text[])`, [[owner.tenant, other.tenant]]);
  assert.equal(rows.rows[0].n, 0, 'ninguna denegación alcanza a Jev ni un proveedor generativo');
  const denials = (await t.pool.query(`SELECT tenant_id,decision FROM audit_event WHERE tenant_id=ANY($1::text[]) AND action='ai.lab.invoke'`, [[owner.tenant, other.tenant]])).rows;
  assert.equal(denials.filter((d) => d.tenant_id === owner.tenant && d.decision === 'deny').length, 3);
  assert.equal(denials.filter((d) => d.tenant_id === other.tenant && d.decision === 'deny').length, 1, 'el intento ajeno se audita en el negocio de quien lo hizo');
});

test('imagen manual conserva biblioteca y costo al repetir la misma acción; revocar no devuelve el resultado ni cambia el rollout', async () => {
  const owner = await createTenantWithPlan(t, limits, 'client_lab_native_image');
  const route = await candidate('website.image.generate', 'oa:gpt-image-2');
  const grant = await grantFor(owner, [route.route_id]);
  const rolloutBefore = await t.handle.dispatcher.registry.rollout(route.use_case_id, 'lab');
  // El adaptador rechaza respuestas < 1000 bytes; ruido aleatorio (incomprimible) mantiene el PNG por encima del umbral.
  const png = await sharp(randomBytes(64 * 48 * 3), { raw: { width: 64, height: 48, channels: 3 } }).png().toBuffer();
  assert.ok(png.length > 1000);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let providerRequests = 0;
  process.env.OPENAI_API_KEY = 'offline-image-fixture-not-an-api-key';
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'api.openai.com') {
      providerRequests++;
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 10, output_tokens: 100 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch(input, init);
  };
  try {
    const body = { purpose: 'website', subject: 'Una taza de café sobre madera', style: 'Editorial contemporáneo', aspect_ratio: '4:3' };
    const key = randomUUID();
    const first = await back(owner.token, '/ai/lab/images', body, grant, key);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await back(owner.token, '/ai/lab/images', body, grant, key);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.asset.asset_id, first.body.asset.asset_id);
    assert.equal(second.body.invocation_id, first.body.invocation_id);
    assert.equal(providerRequests, 1, 'repetir la acción no vuelve a invocar el transporte sustituido');
    const stored = (await t.pool.query(`SELECT status,mime,invocation_id FROM media_asset WHERE asset_id=$1 AND tenant_id=$2`, [first.body.asset.asset_id, owner.tenant])).rows[0];
    assert.deepEqual(stored, { status: 'draft', mime: 'image/webp', invocation_id: first.body.invocation_id });
    const inv = (await t.pool.query(`SELECT assignment,lab_grant_id,cost_source,output_sha256 FROM ai_invocation WHERE invocation_id=$1`, [first.body.invocation_id])).rows[0];
    assert.equal(inv.assignment, 'manual_lab');
    assert.equal(inv.lab_grant_id, grant);
    assert.equal(inv.cost_source, 'estimated');
    assert.match(inv.output_sha256, /^[a-f0-9]{64}$/);
    assert.equal((await platform(`/ai/lab/grants/${grant}/revoke`, { reason: 'Cerrar la fixture técnica offline de imagen' })).status, 200);
    assert.equal((await back(owner.token, '/ai/lab/images', body, grant, key)).status, 403);
    assert.equal(providerRequests, 1);
    assert.equal((await t.handle.dispatcher.registry.route(route.route_id))?.status, 'DRAFT');
    assert.deepEqual(await t.handle.dispatcher.registry.rollout(route.use_case_id, 'lab'), rolloutBefore, 'el grant y la prueba no modifican el rollout normal');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  }
});
