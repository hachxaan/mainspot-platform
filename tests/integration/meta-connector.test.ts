/**
 * Conexión de una Page de Facebook (no es inicio de sesión en MainSpot) contra una Graph API FALSA inyectada: state de
 * un solo uso, redirect URI fija, permisos, elección de Page, tokens cifrados y publicación de texto+foto con acuse.
 * No acredita Meta real (REAL_VERIFIED exige la app y la Page del propietario).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { bootApi, api, authHeaders, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan } from '../helpers/tenants.ts';
import { MetaGraphClient, MetaPagesAdapter, REQUIRED_PAGE_SCOPES, classifyGraphError } from '../../src/social/meta-graph.ts';
import { META_CALLBACK_PATH, metaRedirectUri } from '../../src/api/meta-connection-routes.ts';

const BASE = 'https://app.mainspot.test';
const REDIRECT = `${BASE}/api/connections/meta/callback`;
let t: TestApi;
const calls: Array<{ method: string; resource: string; params: URLSearchParams; body: unknown }> = [];
const photos: Array<{ caption: string; mime: string; size: number; token: string }> = [];
const published = new Map<string, string>();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

const fake: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
  const resource = url.pathname.replace(/^\/v26\.0\//, '');
  const method = init?.method ?? 'GET';
  calls.push({ method, resource, params: url.searchParams, body: init?.body });
  if (resource === 'oauth/access_token' && url.searchParams.get('code')) {
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT, 'el intercambio usa la redirect URI registrada');
    return json({ access_token: 'short-user-token', expires_in: 3600 });
  }
  if (resource === 'oauth/access_token' && url.searchParams.get('grant_type') === 'fb_exchange_token') return json({ access_token: 'long-user-token', expires_in: 5_184_000 });
  if (resource === 'me') return json({ id: 'fb-user-1', name: 'Dueña' });
  if (resource === 'me/permissions' && method === 'GET') return json({ data: REQUIRED_PAGE_SCOPES.map((permission) => ({ permission, status: 'granted' })) });
  if (resource === 'me/accounts') return json({ data: [{ id: '555', name: 'Panadería Real', tasks: ['CREATE_CONTENT', 'MANAGE'] }, { id: '556', name: 'Otra Page', tasks: ['ANALYZE'] }] });
  // Como Graph real (observado en v26.0): el nodo Page no tiene `tasks`; solo `me/accounts` las devuelve.
  if (/^\d+$/.test(resource) && (url.searchParams.get('fields') ?? '').split(',').includes('tasks')) {
    return json({ error: { message: '(#100) Tried accessing nonexisting field (tasks)', type: 'OAuthException', code: 100 } }, 400);
  }
  if (resource === '555' && url.searchParams.get('fields') === 'id,name,access_token') return json({ id: '555', name: 'Panadería Real', access_token: 'page-token-555' });
  if (resource === '555') return json({ id: '555', name: 'Panadería Real' });
  if (resource === 'debug_token') return json({ data: { is_valid: true, scopes: [...REQUIRED_PAGE_SCOPES], type: 'PAGE' } });
  if (resource === '555/photos' && method === 'POST') {
    const body = init?.body;
    assert.ok(body instanceof FormData, 'la foto viaja como multipart');
    const file = body.get('source');
    assert.ok(file instanceof Blob);
    photos.push({ caption: String(body.get('caption')), mime: file.type, size: file.size, token: String(body.get('access_token')) });
    published.set('555_777', String(body.get('caption')));
    return json({ id: 'photo-1', post_id: '555_777' });
  }
  if (resource === '555/feed' && method === 'POST') {
    const form = new URLSearchParams(String(init?.body ?? ''));
    published.set('555_778', form.get('message') ?? '');
    return json({ id: '555_778' });
  }
  if (published.has(resource)) return json({ id: resource, message: published.get(resource) });
  throw new Error(`Graph falsa: llamada inesperada ${method} ${resource}`);
};

before(async () => {
  t = await bootApi({ socialProvider: 'meta', connectorTokenKey: randomBytes(32).toString('base64'), metaAppId: 'app-123', metaAppSecret: 'app-secret-xyz', publicBaseUrl: BASE }, 5, { metaFetch: fake });
});
after(async () => { await t.close(); });

function call(token: string, path: string, method = 'GET', body?: unknown) {
  return api(t.baseUrl, `/api/backoffice${path}`, { method, headers: authHeaders(token, { 'Idempotency-Key': randomUUID() }), body: body === undefined ? undefined : JSON.stringify(body) });
}
async function callback(query: string): Promise<{ status: number; location: string }> {
  const res = await fetch(`${t.baseUrl}/api/connections/meta/callback?${query}`, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') ?? '' };
}

test('Page de Facebook: autorizar (state de un solo uso) → elegir Page → conectada con tokens cifrados → foto publicada con acuse', async () => {
  const a = await createTenantWithPlan(t, { social_posts: 10, conversations: 10 }, 'client_meta');
  const status = await call(a.token, '/connections/meta');
  assert.deepEqual([status.body.enabled, status.body.oauth_configured, status.body.connection], [true, true, null]);

  const start = await call(a.token, '/connections/meta/start', 'POST');
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const dialog = new URL(start.body.url);
  assert.equal(dialog.origin + dialog.pathname, 'https://www.facebook.com/v26.0/dialog/oauth');
  assert.equal(dialog.searchParams.get('client_id'), 'app-123');
  assert.equal(dialog.searchParams.get('redirect_uri'), REDIRECT);
  assert.deepEqual(dialog.searchParams.get('scope')?.split(','), [...REQUIRED_PAGE_SCOPES]);
  const state = dialog.searchParams.get('state') ?? '';
  assert.ok(state.length >= 20);

  assert.match((await callback(`state=otro-${state}&code=c`)).location, /conexion=estado_invalido$/, 'un state desconocido no conecta nada');
  const ok = await callback(`state=${encodeURIComponent(state)}&code=code-1`);
  assert.equal(ok.status, 303);
  assert.equal(ok.location, `${BASE}/panel#/facebook/conectar?conexion=elegir_pagina`);
  assert.match((await callback(`state=${encodeURIComponent(state)}&code=code-1`)).location, /conexion=estado_invalido$/, 'el state es de un solo uso');

  const pages = await call(a.token, '/connections/meta/pages');
  assert.deepEqual(pages.body.pages.map((p: { page_id: string }) => p.page_id), ['555', '556']);
  assert.equal((await call(a.token, '/connections/meta/select', 'POST', { page_id: '556' })).status, 403, 'una Page sin tarea de publicación no se conecta');
  const selected = await call(a.token, '/connections/meta/select', 'POST', { page_id: '555' });
  assert.equal(selected.body.status, 'connected', JSON.stringify(selected.body));
  assert.deepEqual(selected.body.tasks, ['CREATE_CONTENT', 'MANAGE'], 'las tareas salen de me/accounts');
  const serialized = JSON.stringify([start.body, pages.body, selected.body]);
  assert.doesNotMatch(serialized, /page-token-555|long-user-token|short-user-token|app-secret-xyz/, 'ningún token sale al panel');
  const stored = await t.pool.query<{ status: string; box: string }>(`SELECT status, encode(token_box, 'escape') AS box FROM provider_connection WHERE tenant_id = $1 AND provider = 'meta_pages'`, [a.tenant]);
  assert.equal(stored.rows[0]?.status, 'connected');
  assert.doesNotMatch(stored.rows[0]?.box ?? '', /page-token-555|long-user-token/, 'los tokens se guardan cifrados');

  // Publicación con foto de la biblioteca del negocio: multipart a /photos, acuse por read-back y ref real.
  const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c0803a' } }).png().toBuffer();
  const up = await fetch(`${t.baseUrl}/api/backoffice/ai/media`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'image/png', 'X-Rights-Confirmed': 'yes', 'X-Alt-Text': encodeURIComponent('Pan recién horneado') }, body: png });
  assert.equal(up.status, 201);
  const assetId = ((await up.json()) as { asset: { asset_id: string } }).asset.asset_id;
  const created = await call(a.token, '/social/posts', 'POST', { text: 'Pan recién horneado todas las mañanas', media_asset_id: assetId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const postId = created.body.post.post_id as string;
  const proposal = (await call(a.token, `/social/posts/${postId}/approve`, 'POST')).body.proposal_id as string;
  assert.equal((await call(a.token, `/conversation/proposals/${proposal}/confirm`, 'POST')).status, 200);
  assert.equal((await call(a.token, `/conversation/proposals/${proposal}/approve`, 'POST')).status, 200);
  await t.handle.socialScheduler.tick({ tenantId: a.tenant });
  const post = await t.pool.query<{ status: string; external_ref: string }>('SELECT status, external_ref FROM social_post WHERE post_id = $1', [postId]);
  assert.deepEqual(post.rows[0], { status: 'published', external_ref: '555_777' });
  assert.equal(photos.length, 1);
  assert.deepEqual([photos[0]?.caption, photos[0]?.token, photos[0]?.mime.startsWith('image/')], ['Pan recién horneado todas las mañanas', 'page-token-555', true]);
  assert.ok((photos[0]?.size ?? 0) > 0);

  // Una imagen de otro negocio no se puede adjuntar.
  const b = await createTenantWithPlan(t, { social_posts: 10 }, 'client_meta_b');
  assert.equal((await call(b.token, '/social/posts', 'POST', { text: 'Ajena', media_asset_id: assetId })).status, 404);
});

test('con una configuración de Facebook Login for Business el diálogo pide los permisos por config_id, no por scope', () => {
  const meta = new MetaPagesAdapter({ client: new MetaGraphClient({ baseUrl: 'https://graph.fake.test', version: 'v26.0', fetchImpl: fake }), connections: t.handle.connections, appId: 'app-123', appSecret: 'app-secret-xyz' });
  const withConfig = new URL(meta.authorizationUrl({ state: 'st', redirectUri: REDIRECT, adsRead: false, configId: 'cfg-987' }));
  assert.deepEqual([withConfig.searchParams.get('config_id'), withConfig.searchParams.get('scope'), withConfig.searchParams.get('response_type')], ['cfg-987', null, 'code']);
  const withoutConfig = new URL(meta.authorizationUrl({ state: 'st', redirectUri: REDIRECT, adsRead: false }));
  assert.equal(withoutConfig.searchParams.get('config_id'), null);
  assert.deepEqual(withoutConfig.searchParams.get('scope')?.split(','), [...REQUIRED_PAGE_SCOPES]);
});

test('la URI pública de retorno (META_OAUTH_REDIRECT_URI) solo vale si es HTTPS y apunta a este callback', () => {
  const base = { publicBaseUrl: 'https://app.mainspot.test' };
  assert.equal(metaRedirectUri({ ...base, metaOAuthRedirectUri: '' }), `https://app.mainspot.test${META_CALLBACK_PATH}`);
  assert.equal(metaRedirectUri({ ...base, metaOAuthRedirectUri: `https://meta.mainspot.io${META_CALLBACK_PATH}` }), `https://meta.mainspot.io${META_CALLBACK_PATH}`);
  for (const bad of [`http://meta.mainspot.io${META_CALLBACK_PATH}`, 'https://meta.mainspot.io/otra/ruta', `https://meta.mainspot.io${META_CALLBACK_PATH}?x=1`, 'no es url']) {
    assert.throws(() => metaRedirectUri({ ...base, metaOAuthRedirectUri: bad }), /META_OAUTH_REDIRECT_URI/, bad);
  }
});

test('un error 100 de Graph (parámetro inválido) no se toma por autorización revocada; el 190 sí', () => {
  const invalidField = classifyGraphError(400, { error: { message: '(#100) Tried accessing nonexisting field (tasks)', type: 'OAuthException', code: 100 } }, null);
  assert.deepEqual([invalidField.kind, invalidField.shortCode], ['provider_error', 'meta_provider_error_100']);
  assert.equal(classifyGraphError(400, { error: { type: 'OAuthException', code: 100, error_subcode: 33 } }, null).kind, 'not_found');
  assert.equal(classifyGraphError(400, { error: { type: 'OAuthException', code: 190 } }, null).kind, 'invalid_token');
});
