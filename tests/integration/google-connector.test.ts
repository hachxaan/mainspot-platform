/** DEV-E2E-04: proveedor HTTP inyectado FALSO. No acredita acceso a Google real. */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { TEST_URL, TEST_CONFIG, SEED } from '../helpers/testdb.ts';
import { AuditSink } from '../../src/audit/sink.ts';
import { SecretBox } from '../../src/connectors/secret-box.ts';
import { ProviderConnectionRepository } from '../../src/connectors/repository.ts';
import { createGoogleIntegration, type GoogleIntegration } from '../../src/google/integration.ts';
import { GOOGLE_BUSINESS_SCOPE } from '../../src/google/config.ts';
import { GoogleApiError } from '../../src/google/client.ts';
import { GOOGLE_PURGED_TEXT } from '../../src/google/retention.ts';

const tenant = SEED.a.tenant;
const actor = { tenantId: tenant, userId: 'user_a_admin', role: 'administration', requestId: 'google-test' };
const pool = new pg.Pool({ connectionString: TEST_URL });
const box = SecretBox.fromBase64(randomBytes(32).toString('base64'));
const connections = new ProviderConnectionRepository(pool, box);
let integration: GoogleIntegration;
let refreshes = 0;
let writes = 0;
let revoked = false;
let failStatus = 0;
let tokenForm: URLSearchParams;
let location = { name: 'locations/gl', title: 'Faro', phoneNumbers: { primaryPhone: '+529831234567' }, websiteUri: 'https://faro.example.test' };
let reply: { comment: string; updateTime?: string } | undefined;
const calls: string[] = [];
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const fake: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
  const method = init?.method ?? 'GET';
  calls.push(`${method} ${url.pathname}`);
  if (url.pathname === '/token') {
    tokenForm = new URLSearchParams(String(init?.body));
    if (tokenForm.get('grant_type') === 'refresh_token') refreshes += 1;
    return json({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600, scope: GOOGLE_BUSINESS_SCOPE });
  }
  if (url.pathname === '/revoke') { revoked = true; return json({}); }
  if (failStatus) return json({ error: { status: failStatus === 403 ? 'PERMISSION_DENIED' : 'UNAUTHENTICATED' } }, failStatus, failStatus === 429 ? { 'Retry-After': '30' } : {});
  if (url.pathname === '/v1/accounts') return json({ accounts: [{ name: 'accounts/ga', accountName: 'Cuenta de prueba' }] });
  if (url.pathname === '/v1/accounts/ga/locations') return json({ locations: [{ ...location, metadata: { hasVoiceOfMerchant: true } }] });
  if (url.pathname === '/v1/locations/gl') {
    if (method === 'PATCH') { location = { ...location, ...JSON.parse(String(init?.body)) }; writes += 1; }
    return json(location);
  }
  const parent = '/v4/accounts/ga/locations/gl/reviews';
  if (url.pathname === parent) {
    const second = url.searchParams.get('pageToken') === 'page-2';
    return json({ reviews: [{ name: `accounts/ga/locations/gl/reviews/${second ? 'r2' : 'r1'}`, reviewId: second ? 'r2' : 'r1', starRating: 'FIVE', comment: second ? 'Gracias dos' : 'Gracias uno', updateTime: second ? '2026-10-29T11:00:00Z' : '2026-10-29T12:00:00Z', ...(!second && reply ? { reviewReply: reply } : {}) }], ...(second ? {} : { nextPageToken: 'page-2' }) });
  }
  if (url.pathname === `${parent}/r1/reply`) { reply = JSON.parse(String(init?.body)); writes += 1; return json(reply); }
  if (url.pathname === `${parent}/r1`) return json({ name: 'accounts/ga/locations/gl/reviews/r1', reviewId: 'r1', starRating: 'FIVE', reviewReply: reply });
  throw new Error(`Ruta falsa no implementada: ${method} ${url.pathname}`);
};

before(() => {
  integration = createGoogleIntegration({ pool, sink: new AuditSink(pool), connections, fetchImpl: fake,
    config: { ...TEST_CONFIG, reputationProvider: 'google_business_profile', connectorTokenKey: randomBytes(32).toString('base64'), publicBaseUrl: 'https://app.mainspot.local.io',
      google: { ...TEST_CONFIG.google, oauthClientId: 'fake-client', oauthClientSecret: 'fake-secret', oauthTokenUrl: 'https://fake.google.test/token', oauthRevokeUrl: 'https://fake.google.test/revoke',
        accountManagementBaseUrl: 'https://fake.google.test', businessInformationBaseUrl: 'https://fake.google.test', myBusinessV4BaseUrl: 'https://fake.google.test' } } });
});
beforeEach(async () => {
  refreshes = 0; writes = 0; failStatus = 0; revoked = false; reply = undefined; calls.length = 0;
  location = { name: 'locations/gl', title: 'Faro', phoneNumbers: { primaryPhone: '+529831234567' }, websiteUri: 'https://faro.example.test' };
  await pool.query('DELETE FROM provider_oauth_state WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM provider_connection WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM google_review_cursor WHERE tenant_id = $1', [tenant]);
});
after(async () => {
  await pool.query('DELETE FROM provider_oauth_state WHERE tenant_id = $1', [tenant]);
  await pool.query('DELETE FROM provider_connection WHERE tenant_id = $1', [tenant]);
  await pool.end();
});
async function connect() {
  const start = await integration.connection.start(actor);
  const url = new URL(start.authorization_url);
  const state = url.searchParams.get('state')!;
  const result = await integration.connection.callback({ state, code: 'fake-code' });
  assert.equal(result.outcome, 'connected');
  return { state, url };
}

test('OAuth liga state/PKCE al tenant, cifra tokens y consume el state una sola vez', async () => {
  const { state, url } = await connect();
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(tokenForm.get('code_verifier')!).digest('base64url'));
  const conn = await connections.get(tenant, 'google_business_profile');
  assert.equal(conn?.external_account_id, 'accounts/ga');
  assert.equal(conn?.external_resource_id, 'locations/gl');
  assert.ok(!JSON.stringify(conn).includes('fake-access'));
  const raw = await pool.query('SELECT token_box FROM provider_connection WHERE tenant_id = $1', [tenant]);
  assert.ok(!raw.rows[0].token_box.toString().includes('fake-refresh'));
  assert.equal((await integration.connection.callback({ state, code: 'replay' })).code, 'invalid_state');
  assert.equal(await connections.readTokens(SEED.b.tenant, 'google_business_profile'), null);
  const expired = await connections.createOAuthState({ ...actor, provider: 'google_business_profile', redirectUri: 'https://app.mainspot.local.io', verifier: 'fake', ttlMinutes: -1 });
  assert.equal(await connections.consumeOAuthState(expired, 'google_business_profile'), null);
  const wrong = await connections.createOAuthState({ ...actor, provider: 'meta_pages', redirectUri: 'https://app.mainspot.local.io' });
  assert.equal((await integration.connection.callback({ state: wrong, code: 'fake' })).code, 'invalid_state');
});

test('desconectar invalida OAuth pendiente y una renovación tardía no resucita credenciales', async () => {
  await connect();
  const tokens = (await connections.readTokens<Record<string, unknown>>(tenant, 'google_business_profile'))!;
  const pending = await integration.connection.start(actor);
  const state = new URL(pending.authorization_url).searchParams.get('state')!;
  await connections.disconnect(tenant, 'google_business_profile');
  assert.equal((await integration.connection.callback({ state, code: 'late-code' })).code, 'invalid_state');
  assert.equal(await connections.replaceTokens(tenant, 'google_business_profile', tokens, { ...tokens, access_token: 'late-refresh' }, new Date(Date.now() + 3600000)), false);
  await connections.markStatus(tenant, 'google_business_profile', 'connected', null, true);
  assert.equal((await connections.get(tenant, 'google_business_profile'))?.status, 'disconnected');
  assert.equal(await connections.readTokens(tenant, 'google_business_profile'), null);
});

test('un callback pendiente no autoriza al usuario suspendido después de iniciar OAuth', async () => {
  const start = await integration.connection.start(actor);
  const state = new URL(start.authorization_url).searchParams.get('state')!;
  await pool.query("UPDATE internal_user SET status='suspended' WHERE user_id=$1", [actor.userId]);
  try {
    assert.equal((await integration.connection.callback({ state, code: 'late-code' })).code, 'invalid_state');
    assert.equal(await connections.readTokens(tenant, 'google_business_profile'), null);
  } finally {
    await pool.query("UPDATE internal_user SET status='active' WHERE user_id=$1", [actor.userId]);
  }
});

test('renueva token caducado y revoca credenciales al desconectar', async () => {
  await connect();
  const tokens = await connections.readTokens<Record<string, unknown>>(tenant, 'google_business_profile');
  await connections.save({ tenantId: tenant, provider: 'google_business_profile', status: 'connected', tokens: { ...tokens, expires_at: '2000-01-01T00:00:00Z' } });
  await integration.client.getLocation(tenant, 'locations/gl');
  assert.equal(refreshes, 1);
  await integration.connection.disconnect(actor);
  assert.equal(revoked, true);
  assert.equal(await connections.readTokens(tenant, 'google_business_profile'), null);
  assert.equal((await connections.get(tenant, 'google_business_profile'))?.status, 'disconnected');
});

test('ficha PATCH se confirma por lectura; campos restringidos quedan pendientes', async () => {
  await connect();
  const applied = await integration.location.apply(tenant, 'locations/gl', {
    business_name: 'Faro nuevo', primary_category: 'Categoría diferente', description: null, address_line: null, locality: null,
    region: null, postal_code: null, country_iso2: null, latitude: null, longitude: null, hours: [], website_url: 'https://nuevo.example.test', primary_phone: '+529839999999',
  });
  assert.equal(applied.status, 'partial');
  assert.ok(applied.confirmed.includes('title') && applied.confirmed.includes('phoneNumbers.primaryPhone'));
  assert.ok(applied.unsupported.some((x) => x.field === 'primary_category'));
  assert.equal(writes, 1);
});

test('reseñas paginadas y reply con read-back, replay sin reescritura y aislamiento por ubicación', async () => {
  await connect();
  const reviews = await integration.reputationProvider.listReviews(tenant);
  assert.deepEqual(reviews.map((r) => r.source_review_id), ['accounts/ga/locations/gl/reviews/r1', 'accounts/ga/locations/gl/reviews/r2']);
  const input = { tenantId: tenant, origin: 'google_review' as const, targetRef: 'accounts/ga/locations/gl/reviews/r1', text: 'Gracias por venir', idempotencyKey: 'g-reply' };
  assert.equal((await integration.replier.reply(input)).ok, true);
  assert.equal((await integration.replier.reply(input)).ok, true);
  assert.equal(writes, 1);
  assert.equal((await integration.replier.reply({ ...input, targetRef: 'accounts/otro/locations/otra/reviews/r1' })).ok, false);
  reply = { comment: 'Respuesta fuera de MainSpot' };
  assert.equal((await integration.replier.reply(input)).ok, false);
  assert.equal(writes, 1);
});

test('401 renueva una vez; 403 registra permisos y 429 respeta Retry-After sin simulación', async () => {
  await connect();
  failStatus = 401;
  await assert.rejects(integration.client.getLocation(tenant, 'locations/gl'), (err: unknown) => err instanceof GoogleApiError && err.kind === 'needs_authorization');
  assert.equal(refreshes, 1);
  assert.equal((await connections.get(tenant, 'google_business_profile'))?.status, 'needs_authorization');
  failStatus = 403;
  await assert.rejects(integration.client.getLocation(tenant, 'locations/gl'), (err: unknown) => err instanceof GoogleApiError && err.kind === 'permission_missing');
  failStatus = 429;
  await assert.rejects(integration.client.getLocation(tenant, 'locations/gl'), (err: unknown) => err instanceof GoogleApiError && err.retryAfterMs === 30_000);
});

test('retención elimina texto/reviewer de Google antiguo sin borrar hechos ni contenido reciente', async () => {
  await connect();
  const ids = ['g-ret-old', 'g-ret-new'];
  try {
    for (const [index, id] of ids.entries()) await pool.query(
      `INSERT INTO review (review_id, tenant_id, source_review_id, author_name, star_rating, review_text, source, classification, state, created_at)
       VALUES ($1,$2,$3,'Nombre externo',5,'Texto externo','google','positive','detected', now() - make_interval(days => $4))`,
      [id, tenant, `accounts/ga/locations/gl/reviews/${index === 0 ? 'r1' : id}`, index === 0 ? 31 : 1]);
    const report = await integration.retention.purge({ tenantId: tenant });
    assert.equal(report.failures, 0);
    const rows = await pool.query('SELECT review_id, review_text, content_purged_at FROM review WHERE review_id = ANY($1) ORDER BY review_id', [ids]);
    assert.equal(rows.rows.find((r) => r.review_id === ids[0]).review_text, GOOGLE_PURGED_TEXT);
    assert.equal(rows.rows.find((r) => r.review_id === ids[1]).review_text, 'Texto externo');
    reply = { comment: 'Respuesta externa antigua que Google vuelve a entregar' };
    await integration.reputationProvider.listReviews(tenant);
    const replay = (await pool.query('SELECT review_text, published_text FROM review WHERE review_id=$1', [ids[0]])).rows[0];
    assert.equal(replay.review_text, GOOGLE_PURGED_TEXT);
    assert.equal(replay.published_text, null, 'un re-sync no vuelve a almacenar contenido externo después de purgarlo');
  } finally { await pool.query('DELETE FROM review WHERE review_id = ANY($1)', [ids]); }
});
