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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bootApi, authHeaders, api, login, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows } from '../helpers/tenants.ts';
import { AiDispatcher } from '../../src/ai/dispatcher.ts';
import type { SimulatedChannel } from '../../src/channels/simulated.ts';
import { AuditSink } from '../../src/audit/sink.ts';
import { currentStep, totpAt } from '../../src/platform/auth.ts';
import { AUTO_REPLY_CONSENT } from '../../src/engagement/consent.ts';
import { RetentionService } from '../../src/retention/service.ts';
import { AppError } from '../../src/shared/errors.ts';

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

test('DEC-0024/0027: un negocio que usó la IA se exporta y se anonimiza sin rastros; el costo de IA queda re-etiquetado', async () => {
  const a = await siteWithDesign('client_aix');
  const site = (await t.pool.query<{ slug: string }>('SELECT slug FROM client_website WHERE tenant_id = $1', [a.tenant])).rows[0]!;
  // Rastro de plataforma sobre el negocio: acceso de soporte y su evento de auditoría.
  const staff = await t.handle.platformAuth.createUser({ login: `sop-${randomUUID().slice(0, 6)}`, displayName: 'Soporte', password: 'Plataforma-Soporte-2026', roles: ['platform_support'], grantedBy: 'test' });
  await t.pool.query(`INSERT INTO platform_support_access (access_id, tenant_id, platform_user_id, reason, expires_at) VALUES ($1,$2,$3,'Revisión del diseño pedida por el dueño', now() + interval '1 hour')`,
    [`psa_${randomUUID()}`, a.tenant, staff.platform_user_id]);
  await t.pool.query(`INSERT INTO platform_audit_event (event_id, actor_id, actor_roles, action, resource, tenant_id, decision, result, reason, request_id)
    VALUES ($1,$2,'{platform_support}','platform.support.grant',$3,$4,'allow','minutes:60',$5,$6)`,
    [`pae_${randomUUID()}`, `platform:${staff.platform_user_id}`, `client/${a.tenant}`, a.tenant, `Pedido del negocio ${site.slug}`, `req_${randomUUID()}`]);
  await assert.rejects(t.pool.query(`UPDATE platform_audit_event SET reason = NULL WHERE tenant_id = $1`, [a.tenant]), 'fuera de la anonimización sigue siendo append-only');
  const spentBefore = (await t.pool.query<{ n: string; usd: string }>(`SELECT count(*) AS n, COALESCE(sum(COALESCE(cost_usd, reserved_usd)), 0) AS usd FROM ai_invocation WHERE tenant_id = $1`, [a.tenant])).rows[0]!;
  assert.ok(Number(spentBefore.n) > 0);

  const retention = new RetentionService({ pool: t.pool, sink: new AuditSink(t.pool) });
  const exportDir = await mkdtemp(path.join(os.tmpdir(), 'mainspot-ai-exit-'));
  try {
    const exit = await retention.confirmExit({ tenantId: a.tenant, confirmedBy: 'operador@mainspot', exportDir });
    const exported = JSON.parse(await readFile(exit.exportPath, 'utf8')) as Record<string, Array<Record<string, unknown>>>;
    assert.ok(exported['brand_fact']!.length > 0 && exported['ai_job']!.length > 0 && exported['media_asset']!.length > 0, 'la exportación incluye marca, jobs y biblioteca');
    assert.ok([...exported['media_asset']!, ...exported['media_variant']!].every((m) => !('bytes' in m)), 'sin bytes de imágenes en el JSON');
    await t.pool.query(`UPDATE tenant_exit SET confirmed_at = now() - interval '31 days', anonymize_after = now() - interval '1 day' WHERE tenant_id = $1`, [a.tenant]);
    const report = await retention.run({ trigger: 'manual', dryRun: false });
    assert.deepEqual([report.status, report.totals.tenantsAnonymized], ['completed', 1], JSON.stringify(report));
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }
  const anonId = (await t.pool.query<{ tenant_id: string }>(`SELECT tenant_id FROM audit_event WHERE action = 'tenant.anonymized' ORDER BY ts DESC LIMIT 1`)).rows[0]!.tenant_id;
  const spentAfter = (await t.pool.query<{ n: string; usd: string }>(`SELECT count(*) AS n, COALESCE(sum(COALESCE(cost_usd, reserved_usd)), 0) AS usd FROM ai_invocation WHERE tenant_id = $1 AND output IS NULL AND actor_id = 'anon_actor'`, [anonId])).rows[0]!;
  assert.deepEqual(spentAfter, spentBefore, 'el gasto de IA sigue contando para los presupuestos, sin contenido ni actores');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM platform_audit_event WHERE tenant_id = $1 AND resource = 'client' AND reason IS NULL AND request_id IS NULL AND action = 'platform.support.grant'`, [anonId]), 1,
    'la auditoría de plataforma conserva quién/qué/cuándo bajo el id anónimo');
  for (const table of ['brand_fact', 'media_asset', 'ai_job', 'platform_support_access', 'response_ledger']) {
    assert.equal(await countRows(t, `SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`, [a.tenant]), 0, `${table} borrada`);
  }
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

async function publishedClassicSite(prefix: string) {
  const a = await createTenantWithPlan(t, LIMITS, prefix);
  const slug = `chat-${randomUUID().slice(0, 6)}`;
  const created = await call(a.token, '/website', 'POST', { slug, site_name: `Panadería ${slug}`, data: { line: 'Pan recién hecho', hours: 'Lunes a sábado: 7:00 a 20:00', services: ['Baguette'] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const first = await call(a.token, '/website/first-publication', 'POST');
  assert.equal((await call(a.token, `/conversation/proposals/${first.body.proposal.proposal_id}/approve`, 'POST')).body.status, 'published');
  return { ...a, slug };
}

async function chatRequest(token: string, requestId: string) {
  const reqs = (await call(token, '/conversation/requests')).body.requests as Array<{ request_id: string; proposal_id: string | null; ai_job: { status: string; error_code: string | null; routes: Array<{ use_case_id: string }> } | null }>;
  return { all: reqs, row: reqs.find((x) => x.request_id === requestId) };
}

test('chat → IA: pedir una imagen en la portada prepara un cambio real (bloques + imagen) en la misma solicitud, con vista previa y publicación', async () => {
  const a = await publishedClassicSite('client_aic');
  const msg = await call(a.token, '/conversation/messages', 'POST', { text: 'Agrega una imagen de una panadería francesa en la portada de mi página', channel: 'simulated' });
  assert.equal(msg.status, 201, JSON.stringify(msg.body));
  assert.equal(msg.body.proposal_id, null, 'el editor determinista no inventa un cambio vacío');
  assert.ok(msg.body.ai_job?.job_id, 'el chat delega en la edición con IA');
  assert.equal(msg.body.request.status, 'classified');
  await t.handle.aiJobs.drain(a.tenant);

  const { all, row } = await chatRequest(a.token, msg.body.request.request_id);
  assert.equal(row?.ai_job?.status, 'succeeded', JSON.stringify(row?.ai_job));
  assert.ok(row?.proposal_id, 'la propuesta queda en la solicitud del chat');
  assert.equal(all.filter((x) => x.proposal_id === row?.proposal_id).length, 1, 'sin una segunda solicitud para la misma propuesta');
  const p = (await call(a.token, `/conversation/proposals/${row?.proposal_id}`)).body.proposal;
  assert.deepEqual([p.proposal_type, p.status], ['website.ai_edit', 'preview_ready']);
  const stored = p.detail.after.design;
  assert.equal(stored.design.blocks[0].type, 'hero');
  assert.equal(stored.design.blocks[0].image_slot, 'hero', 'la portada usa la imagen nueva');
  assert.match(stored.assets.hero.asset_id, /^ast_/);
  assert.ok(stored.design.blocks.some((b: { items: Array<{ title: string }> | null }) => (b.items ?? []).some((i) => i.title === 'Baguette')), 'la conversión conserva el contenido clásico');
  assert.ok(p.detail.ai.routes.some((x: { use_case_id: string }) => x.use_case_id === 'website.image.generate'), 'la ruta de imagen queda registrada');

  const pub = await call(a.token, `/conversation/proposals/${row?.proposal_id}/approve`, 'POST');
  assert.equal(pub.body.status, 'published', JSON.stringify(pub.body));
  const site = await rawGet('/', `${a.slug}.${DOMAIN}`);
  assert.equal(site.status, 200);
  assert.match(site.body.toString(), new RegExp(`/media/${stored.assets.hero.asset_id}/`), 'el sitio publicado muestra la imagen');
});

test('chat con una autorización de laboratorio inválida: preguntas y cambios exactos siguen; lo que necesita IA se rechaza sin job ni fallback', async () => {
  const a = await publishedClassicSite('client_aiq');
  const send = (text: string) => api(t.baseUrl, '/api/backoffice/conversation/messages', {
    method: 'POST', headers: authHeaders(a.token, { 'X-AI-Lab-Grant': 'lab_vencida_o_inexistente', 'Idempotency-Key': randomUUID() }), body: JSON.stringify({ text, channel: 'simulated' }),
  });
  const question = await send('¿Cuál es mi horario?');
  assert.equal(question.status, 201, JSON.stringify(question.body));
  assert.equal(question.body.request.status, 'answered');
  const precise = await send('El horario es de lunes a viernes de 9:00 a 18:00');
  assert.equal(precise.status, 201, JSON.stringify(precise.body));
  assert.ok(precise.body.proposal_id, 'un atajo exacto no depende de la autorización');
  const image = await send('Agrega una imagen de una panadería francesa en la portada de mi página');
  assert.equal(image.status, 403, JSON.stringify(image.body));
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM ai_job WHERE tenant_id = $1', [a.tenant]), 0, 'sin job ni ruta de sustitución');
});

test('Telegram → IA: el cambio pedido en el chat se prepara con IA, avisa con la vista previa y el botón «Publicar» lo publica', async () => {
  const a = await publishedClassicSite('client_ait');
  const chat = `sim-ai-${randomUUID().slice(0, 8)}`;
  const last = () => (t.handle.channel as SimulatedChannel).transcript().filter((m) => m.to === chat).at(-1)!;
  const code = await call(a.token, '/telegram/link-code', 'POST');
  assert.equal((await t.handle.telegram.handleUpdate({ message: { chat: { id: chat }, text: `/start ${code.body.code}` } })).handled, 'linked');
  const ask = await t.handle.telegram.handleUpdate({ message: { chat: { id: chat }, text: 'Agrega una imagen de una panadería francesa en la portada de mi página' } });
  assert.equal(ask.handled, 'ai_edit_started');
  assert.match(last().text, /preparando tu cambio con IA/);
  await t.handle.aiJobs.drain(a.tenant);
  const p = await t.pool.query<{ proposal_id: string }>(`SELECT proposal_id FROM action_proposal WHERE tenant_id = $1 AND proposal_type = 'website.ai_edit'`, [a.tenant]);
  const card = last();
  assert.match(card.text, /Así quedará tu página/, 'al terminar el job avisa en el mismo chat con la vista previa');
  const publish = card.buttons.flat().find((b) => b.label === '🚀 Publicar');
  assert.equal(publish?.action, `pp:${p.rows[0]?.proposal_id}`);
  const pressed = await t.handle.telegram.handleUpdate({ callback_query: { id: 'cbq-ai', data: publish!.action, message: { message_id: card.message_id, chat: { id: chat } } } });
  assert.equal(pressed.handled, 'published');
  const done = await t.pool.query<{ status: string }>(`SELECT status FROM action_proposal WHERE tenant_id = $1 AND proposal_id = $2`, [a.tenant, p.rows[0]?.proposal_id]);
  assert.equal(done.rows[0]?.status, 'published');
});

test('Telegram → Facebook: pedir una publicación ofrece prepararla; con botones se elige la propuesta y se publica o programa, con aviso al publicar', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_tgfb');
  const chat = `sim-fb-${randomUUID().slice(0, 8)}`;
  const ch = t.handle.channel as SimulatedChannel;
  const inChat = () => ch.transcript().filter((m) => m.to === chat);
  const last = () => inChat().at(-1)!;
  const byId = (id: string) => inChat().find((m) => m.message_id === id)!;
  let seq = 0;
  const press = (messageId: string, label: RegExp) => {
    const b = byId(messageId).buttons.flat().find((x) => label.test(x.label));
    assert.ok(b, `botón ${label} en el mensaje`);
    return t.handle.telegram.handleUpdate({ callback_query: { id: `cbq-fb-${seq += 1}`, data: b.action, message: { message_id: messageId, chat: { id: chat } } } });
  };
  const say = (text: string) => t.handle.telegram.handleUpdate({ message: { chat: { id: chat }, text } });
  const code = await call(a.token, '/telegram/link-code', 'POST');
  assert.equal((await say(`/start ${code.body.code}`)).handled, 'linked');
  assert.ok((await say('ayuda')) && last().buttons.flat().some((b) => b.label === '📣 Publicar en Facebook'), 'la ayuda ofrece publicar en Facebook');

  // Pedirlo con palabras: no se bloquea en seco ni actúa solo; se ofrece prepararlo con un botón.
  assert.equal((await say('Publica en Facebook que hoy tenemos pan de muerto recién horneado')).handled, 'conversation:blocked');
  const offer = last();
  assert.match(offer.text, /¿Preparo esta publicación para Facebook\?/);
  assert.deepEqual(offer.buttons.map((r) => r.map((b) => b.label)), [['📣 Prepararla'], ['🖼 Prepararla con imagen'], ['No, gracias']]);
  assert.equal((await press(offer.message_id, /^📣 Prepararla$/)).handled, 'social_compose_started');
  assert.match(byId(offer.message_id).text, /Estoy redactando tus propuestas/);
  assert.deepEqual(byId(offer.message_id).buttons, [], 'la oferta usada pierde sus botones');
  await t.handle.aiJobs.drain(a.tenant);
  const variants = last();
  assert.match(variants.text, /Propuestas para Facebook[\s\S]*1\. [\s\S]*2\. /);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM social_post WHERE tenant_id = $1', [a.tenant]), 0, 'redactar no crea publicaciones');

  // Elegir una variante crea el borrador (con su cuota); publicar sigue la aprobación del panel con origen telegram.
  assert.equal((await press(variants.message_id, /Usar la 1/)).handled, 'social_draft_created');
  const draft = byId(variants.message_id);
  assert.match(draft.text, /Así se publicará en Facebook[\s\S]*pan de muerto/);
  const labels = draft.buttons.map((r) => r[0]!.label);
  assert.deepEqual([labels.length, labels[0], labels[2]], [3, '🚀 Publicar ahora', '🗑 Descartar']);
  assert.match(labels[1] ?? '', /^🕘 Programar: vie \d{1,2} [a-z]{3}, 18:00$/, 'franja sugerida en la zona del negocio');
  assert.equal((await press(variants.message_id, /Publicar ahora/)).handled, 'social_published');
  const posted = await t.pool.query<{ status: string; external_ref: string; proposal_id: string }>('SELECT status, external_ref, proposal_id FROM social_post WHERE tenant_id = $1', [a.tenant]);
  assert.equal(posted.rows[0]?.status, 'published');
  const pub = await t.pool.query<{ source: string }>('SELECT source FROM publication WHERE tenant_id = $1 AND proposal_id = $2', [a.tenant, posted.rows[0]?.proposal_id]);
  assert.equal(pub.rows[0]?.source, 'telegram');
  assert.match(byId(variants.message_id).text, /Publicado en Facebook/);
  assert.deepEqual(byId(variants.message_id).buttons, []);

  // Programar en la franja sugerida: queda en cola; al publicarse, el programador avisa en el chat.
  assert.equal((await say('Publica en Facebook que mañana abrimos más temprano')).handled, 'conversation:blocked');
  assert.equal((await press(last().message_id, /^📣 Prepararla$/)).handled, 'social_compose_started');
  await t.handle.aiJobs.drain(a.tenant);
  const second = last();
  assert.equal((await press(second.message_id, /Usar la 2/)).handled, 'social_draft_created');
  assert.equal((await press(second.message_id, /Programar/)).handled, 'social_scheduled');
  assert.match(byId(second.message_id).text, /Programada para vie \d{1,2} [a-z]{3}, 18:00/);
  const scheduled = (await t.pool.query<{ post_id: string; status: string }>(`SELECT post_id, status FROM social_post WHERE tenant_id = $1 AND status <> 'published'`, [a.tenant])).rows[0]!;
  assert.equal(scheduled.status, 'scheduled');
  const before = inChat().length;
  await t.pool.query(`UPDATE scheduled_post SET publish_at = now() - interval '1 minute' WHERE tenant_id = $1 AND post_id = $2`, [a.tenant, scheduled.post_id]);
  await t.handle.socialScheduler.tick({ tenantId: a.tenant });
  assert.equal(inChat().length, before + 1, 'un aviso al publicarse');
  assert.match(last().text, /Publicado en Facebook/);

  // Descartar y un rol sin permiso de publicar.
  assert.equal((await say('Publica en Facebook que el domingo cerramos')).handled, 'conversation:blocked');
  assert.equal((await press(last().message_id, /^📣 Prepararla$/)).handled, 'social_compose_started');
  await t.handle.aiJobs.drain(a.tenant);
  const third = last();
  assert.equal((await press(third.message_id, /Usar la 1/)).handled, 'social_draft_created');
  await t.pool.query(`UPDATE user_role SET role_id = 'operation' WHERE user_id = $1 AND tenant_id = $2`, [a.userId, a.tenant]);
  try {
    assert.equal((await press(third.message_id, /Publicar ahora/)).handled, 'permission_denied');
  } finally {
    await t.pool.query(`UPDATE user_role SET role_id = 'administration' WHERE user_id = $1 AND tenant_id = $2`, [a.userId, a.tenant]);
  }
  assert.equal((await press(third.message_id, /Descartar/)).handled, 'social_discarded');
  assert.match(byId(third.message_id).text, /Publicación descartada/);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM social_post WHERE tenant_id = $1 AND status = 'rejected'`, [a.tenant]), 1);
});

test('chat → IA: si la imagen no se puede generar, el job falla con el motivo y no se propone nada (sin sustituto)', async () => {
  const a = await publishedClassicSite('client_aig');
  const reg = t.handle.dispatcher.registry;
  const current = (await reg.rollout('website.image.generate', ENV))?.active_route_id as string;
  const prompt = (await reg.bundle(current))?.prompt.revision_id as string;
  // Ruta real de imágenes: en pruebas los proveedores reales están apagados ⇒ BLOCKED_EXTERNAL, sin red.
  const real = await reg.createRoute({ useCaseId: 'website.image.generate', modelId: 'oa:gpt-image-2', promptRevisionId: prompt, params: { timeout_ms: 20_000, aspect_ratio: '16:9' }, maxCostUsd: 0.08, changeNote: 'prueba: imagen sin proveedor disponible', actor: 'test:chat-ai' });
  await reg.activate('website.image.generate', ENV, real.route_id, 'test:chat-ai', 'prueba: imagen bloqueada', 'seed');
  try {
    const msg = await call(a.token, '/conversation/messages', 'POST', { text: 'Agrega una imagen de una panadería francesa en la portada de mi página', channel: 'simulated' });
    assert.ok(msg.body.ai_job?.job_id, JSON.stringify(msg.body));
    await t.handle.aiJobs.drain(a.tenant);
    const { row } = await chatRequest(a.token, msg.body.request.request_id);
    assert.equal(row?.ai_job?.status, 'failed');
    assert.match(row?.ai_job?.error_code ?? '', /^image_/);
    assert.equal(row?.proposal_id, null, 'sin imagen no hay propuesta');
    assert.equal(await countRows(t, `SELECT count(*) AS n FROM action_proposal WHERE tenant_id = $1 AND proposal_type = 'website.ai_edit'`, [a.tenant]), 0);
  } finally {
    await reg.activate('website.image.generate', ENV, current, 'test:chat-ai', 'prueba: restaurar rollout', 'seed');
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

  // Proceso caído A MITAD de la llamada al proveedor: la invocación queda `running` (resultado incierto).
  // La reconciliación la cierra como fallida sin costo informado (cuenta la reserva completa).
  const paid = (await t.pool.query<{ invocation_id: string }>(`SELECT invocation_id FROM ai_invocation WHERE job_id = $1 AND status = 'succeeded' LIMIT 1`, [job.job_id])).rows[0]!;
  const orphan = `inv_${randomUUID()}`;
  await t.pool.query(
    `INSERT INTO ai_invocation SELECT (jsonb_populate_record(NULL::ai_invocation, to_jsonb(i) || jsonb_build_object('invocation_id', $2::text, 'idempotency_key', $2::text,
       'status', 'running', 'created_at', now() - interval '20 minutes', 'finished_at', NULL, 'cost_usd', NULL, 'reserved_usd', 0.02))).* FROM ai_invocation i WHERE i.invocation_id = $1`, [paid.invocation_id, orphan]);
  const fresh = `inv_${randomUUID()}`;
  await t.pool.query(
    `INSERT INTO ai_invocation SELECT (jsonb_populate_record(NULL::ai_invocation, to_jsonb(i) || jsonb_build_object('invocation_id', $2::text, 'idempotency_key', $2::text,
       'status', 'running', 'created_at', now(), 'finished_at', NULL, 'cost_usd', NULL))).* FROM ai_invocation i WHERE i.invocation_id = $1`, [paid.invocation_id, fresh]);
  assert.ok(await t.handle.aiJobs.reconcileAbandoned() >= 1);
  const rows = (await t.pool.query<{ invocation_id: string; status: string; error_code: string | null; cost_usd: string | null }>(
    'SELECT invocation_id, status, error_code, cost_usd FROM ai_invocation WHERE invocation_id = ANY($1)', [[orphan, fresh]])).rows;
  assert.deepEqual(rows.find((r) => r.invocation_id === orphan), { invocation_id: orphan, status: 'failed', error_code: 'uncertain_abandoned', cost_usd: null });
  assert.equal(rows.find((r) => r.invocation_id === fresh)?.status, 'running', 'una llamada en curso dentro de su deadline no se toca');
  await t.pool.query(`UPDATE ai_invocation SET status = 'failed', error_code = 'test_cleanup', finished_at = now() WHERE invocation_id = $1`, [fresh]);
});

test('E15/BR-0007: datos reales solo con proveedor verificado; techo duro con reservas concurrentes; proveedor retirado no vuelve', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_aig');
  const route = (await t.pool.query<{ route_id: string; max_cost_usd: string }>(
    `SELECT r.route_id, r.max_cost_usd FROM ai_route_revision r WHERE r.use_case_id = 'business.insights.generate' AND r.model_id = 'an:claude-haiku-5-5' AND r.status = 'DRAFT' ORDER BY r.version DESC LIMIT 1`)).rows[0];
  assert.ok(route, 'hay una ruta candidata de Anthropic directo (DEC-0074)');
  let calls = 0;
  const bodies: string[] = [];
  // Compuerta: la llamada al proveedor queda abierta hasta que la prueba la suelta (sin esperas por reloj).
  // Forma ejecutora: el tsconfig no incluye es2024 (Promise.withResolvers).
  let release: () => void = () => undefined;
  let gate: Promise<void> = Promise.resolve();
  const fake: typeof fetch = async (url, init) => {
    calls++;
    bodies.push(String(init?.body ?? ''));
    assert.match(String(url), /^https:\/\/api\.anthropic\.com\/v1\/messages$/);
    await gate;
    const text = JSON.stringify({ status: 'abstained', summary: 'Sin datos suficientes.', highlights: [], recommendations: [], abstain_reason: 'pocos días' });
    return new Response(JSON.stringify({ id: 'msg_test', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fake-key-for-tests';
  const dispatcher = new AiDispatcher({ pool: t.pool, config: { ...t.handle.config, aiRealProviders: true, aiEnvironment: ENV }, fetchImpl: fake });
  const ctx = (key: string) => ({ requestId: key, idempotencyKey: key, tenantId: a.tenant, actorId: a.userId, actorKind: 'tenant_user' as const, origin: 'test', pinnedRouteId: route.route_id });
  const values = { period: '2026-10-24 a 2026-10-30', metrics: { days_with_activity: 1 } };
  const verified = (await t.pool.query<{ real_data_basis: string; terms_verified_at: Date }>(`SELECT real_data_basis, terms_verified_at FROM ai_provider WHERE provider_id = 'anthropic'`)).rows[0]!;
  // DEC-0074: un pin NO ejecuta borradores (eso exige evaluación real o grant del laboratorio); esta prueba
  // cubre política y presupuesto, así que la candidata se trata como aprobada y se restaura al final.
  const draftPinned = await dispatcher.invokeStructured('business.insights.generate', ctx(`k-${randomUUID()}`), values);
  assert.deepEqual([draftPinned.ok, !draftPinned.ok && draftPinned.code, !draftPinned.ok && draftPinned.reason], [false, 'no_active_route', 'pinned_route_not_deployable']);
  assert.equal(calls, 0, 'un borrador fijado sin grant ni evaluación no llega al proveedor');
  await t.pool.query(`UPDATE ai_route_revision SET status = 'APPROVED' WHERE route_id = $1`, [route.route_id]);
  try {
    // Negocio real + proveedor sin cobertura verificada: bloqueado sin llamar (solo ese tratamiento).
    await t.pool.query(`UPDATE ai_provider SET real_data = 'blocked' WHERE provider_id = 'anthropic'`);
    const blocked = await dispatcher.invokeStructured('business.insights.generate', ctx(`k-${randomUUID()}`), values);
    assert.deepEqual([blocked.ok, !blocked.ok && blocked.code, !blocked.ok && blocked.reason], [false, 'blocked_external', 'provider_terms_unverified']);
    assert.equal(calls, 0);

    // Con la cobertura verificada (DEC-0071) el negocio real usa el proveedor; nada interno viaja.
    await t.pool.query(`UPDATE ai_provider SET real_data = 'allowed', real_data_basis = $1, terms_verified_at = $2 WHERE provider_id = 'anthropic'`, [verified.real_data_basis, verified.terms_verified_at]);
    await t.pool.query(`INSERT INTO ai_budget (budget_id, scope, tenant_id, limit_usd, source, updated_by) VALUES ($1,'tenant_day',$2,$3,'test','test')`,
      [`bud_${randomUUID()}`, a.tenant, Number(route.max_cost_usd) * 1.5]);
    gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = [
      dispatcher.invokeStructured('business.insights.generate', ctx(`k-${randomUUID()}`), values),
      dispatcher.invokeStructured('business.insights.generate', ctx(`k-${randomUUID()}`), values),
    ] as const;
    // La que no reserva termina sin llamar mientras la otra sigue retenida por la compuerta.
    const firstDone = await Promise.race(pending);
    assert.deepEqual([firstDone.ok, !firstDone.ok && firstDone.code], [false, 'budget_exhausted']);
    release();
    const [x, y] = await Promise.all(pending);
    const codes = [x, y].map((r) => (r.ok ? 'ok' : r.code)).sort();
    assert.deepEqual(codes, ['budget_exhausted', 'ok'], 'dos reservas concurrentes no superan el techo');
    assert.equal(calls, 1);
    assert.ok(!bodies[0]!.includes(a.tenant) && !bodies[0]!.includes(a.userId), 'ni el negocio ni el actor viajan al proveedor');
    const okOne = [x, y].find((r) => r.ok);
    assert.ok(okOne && okOne.ok && okOne.costSource === 'estimated' && Math.abs((okOne.costUsd ?? 0) - 0.000035) < 1e-9, 'sin cargo informado: uso × precio publicado, marcado como estimado');
    const policy = (await t.pool.query<{ policy_version: string }>('SELECT policy_version FROM ai_invocation WHERE invocation_id = $1', [okOne!.ok ? okOne!.invocationId : ''])).rows[0];
    assert.equal(policy?.policy_version, 'ai-data-policy-v2:verified-providers');
    // Con el costo real (menor que la reserva) cabe una llamada más.
    const third = await dispatcher.invokeStructured('business.insights.generate', ctx(`k-${randomUUID()}`), values);
    assert.equal(third.ok, true);

    // Una caída de red no prueba costo cero: retiene la reserva y evita gastar otra vez sobre ella.
    let uncertainCalls = 0;
    const uncertain = new AiDispatcher({ pool: t.pool, config: { ...t.handle.config, aiRealProviders: true, aiEnvironment: ENV },
      fetchImpl: async () => { uncertainCalls++; throw new TypeError('network disconnected after dispatch'); } });
    const lost = await uncertain.invokeStructured('business.insights.generate', ctx(`k-${randomUUID()}`), values);
    assert.ok(!lost.ok && lost.code === 'provider_unavailable');
    const cost = (await t.pool.query<{ cost_usd: string | null; cost_source: string }>(
      'SELECT cost_usd, cost_source FROM ai_invocation WHERE invocation_id = $1', [lost.invocationId])).rows[0];
    assert.deepEqual(cost, { cost_usd: null, cost_source: 'unknown' });
    const held = await uncertain.invokeStructured('business.insights.generate', ctx(`k-${randomUUID()}`), values);
    assert.ok(!held.ok && held.code === 'budget_exhausted', 'la reserva incierta sigue contando para el techo');
    assert.equal(uncertainCalls, 1);

    // Un proveedor deshabilitado (como OpenRouter tras DEC-0069) no vuelve a ningún rollout.
    await t.pool.query(`UPDATE ai_provider SET status = 'disabled' WHERE provider_id = 'anthropic'`);
    await assert.rejects(t.handle.dispatcher.registry.activate('business.insights.generate', 'lab', route.route_id, 'test', 'proveedor retirado'), /deshabilitado/);
  } finally {
    await t.pool.query(`UPDATE ai_provider SET status = 'active' WHERE provider_id = 'anthropic'`);
    await t.pool.query(`UPDATE ai_route_revision SET status = 'DRAFT' WHERE route_id = $1 AND status = 'APPROVED'`, [route.route_id]);
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
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
  // Prompt Studio: una versión nueva no reescribe la anterior (inmutable en BD) y queda auditada.
  const np = await platform(engToken, `/ai/use-cases/${uc}/prompts`, 'POST', { content: { system_text: `${bundle.prompt.system_text}\n- Sé breve.`, task_template: bundle.prompt.task_template, variables: bundle.prompt.variables }, change_note: 'E04: variante más breve' });
  assert.equal(np.status, 201, JSON.stringify(np.body));
  assert.ok(np.body.prompt.version > bundle.prompt.version && np.body.prompt.sha256 !== bundle.prompt.sha256);
  await assert.rejects(t.pool.query('UPDATE ai_prompt_revision SET system_text = $1 WHERE revision_id = $2', ['reescrito', bundle.prompt.revision_id]), 'las versiones de prompt no se reescriben');
  assert.equal((await platform(adminToken, `/ai/use-cases/${uc}/prompts`, 'POST', { content: { system_text: 'x', task_template: 'y', variables: [] }, change_note: 'sin rol' })).status, 403, 'platform_admin no versiona prompts');
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
  const fbPolicy = await call(a.token, '/engagement/policies', 'PUT', { origin: 'facebook_comment', category: 'gratitude', mode: 'safe_auto_reply', consent: true, consent_version: AUTO_REPLY_CONSENT.facebook_comment.version });
  assert.equal(fbPolicy.status, 200, JSON.stringify(fbPolicy.body));
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

  // Resumen: con poca actividad se abstiene sin gastar IA; las cifras salen de métricas calculadas.
  const ins = await call(a.token, '/ai/insights', 'POST', { period_days: 7 });
  assert.equal(ins.status, 200, JSON.stringify(ins.body));
  assert.equal(ins.body.status, 'abstained');
  assert.equal(ins.body.metrics.cases_pending, 1, 'métrica sin periodo calculada sobre el propio negocio');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM ai_invocation WHERE tenant_id = $1 AND use_case_id = 'business.insights.generate'`, [a.tenant]), 0);
  assert.equal((await call(a.token, '/ai/insights', 'POST', { period_days: 3 })).status, 400);
  const ideas = await call(a.token, '/ai/editorial', 'POST', { start_date: '2026-11-02', frequency: '3 por semana' });
  assert.equal(ideas.status, 201, JSON.stringify(ideas.body));
  assert.ok(ideas.body.ideas.length >= 3 && ideas.body.ideas.every((i: { suggested_for: string }) => i.suggested_for >= '2026-11-02'));
  assert.equal((await call(b.token, `/ai/editorial/${ideas.body.ideas[0].suggestion_id}/decision`, 'POST', { decision: 'accept' })).status, 404, 'otro negocio = 404');
  assert.equal((await call(a.token, `/ai/editorial/${ideas.body.ideas[0].suggestion_id}/decision`, 'POST', { decision: 'accept' })).status, 200);
  // Facebook: variantes por job → borrador normal (cuota + aprobación); el texto editado sigue las reglas de hechos.
  const comp = await call(a.token, '/ai/social/compose', 'POST', { request: 'Anuncia que ya tenemos pan de muerto' });
  assert.equal(comp.status, 202, JSON.stringify(comp.body));
  await t.handle.aiJobs.drain(a.tenant);
  const ready = (await call(a.token, `/ai/jobs/${comp.body.job.job_id}`)).body.job;
  assert.equal(ready.status, 'succeeded', JSON.stringify(ready));
  assert.ok(ready.result.variants.length >= 2);
  const badEdit = await call(a.token, `/ai/social/compose/${ready.job_id}/draft`, 'POST', { variant: 0, text: 'Pan de muerto a solo $99 hoy' });
  assert.equal(badEdit.status, 400, 'un precio no confirmado no entra ni editado a mano');
  const draft = await call(a.token, `/ai/social/compose/${ready.job_id}/draft`, 'POST', { variant: 0 });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const row = (await t.pool.query<{ status: string; generation: { job_id: string } }>('SELECT status, generation FROM social_post WHERE post_id = $1', [draft.body.post.post_id])).rows[0];
  assert.deepEqual([row?.status, row?.generation.job_id], ['draft', ready.job_id], 'borrador trazado a su generación; nada publicado');
  assert.equal((await call(b.token, `/ai/social/compose/${ready.job_id}/draft`, 'POST', { variant: 0 })).status, 404);
  const userId = `user_ro_${a.tenant}`;
  await t.pool.query(`INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash) VALUES ($1,'Lectura',$2,'active',$3,crypt('Fixture-Read-2026!', gen_salt('bf', 4)))`, [userId, `ro@${a.tenant}.example.com`, a.tenant]);
  await t.pool.query('INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1,$2,$3)', [userId, 'read_only', a.tenant]);
  const ro = (await login(t.baseUrl, `ro@${a.tenant}.example.com`, 'Fixture-Read-2026!', a.tenant)).token;
  assert.equal((await call(ro, '/ai/website/design', 'POST', { brief: 'x' })).status, 403);
  assert.equal((await call(ro, '/ai/brand', 'PUT', { changes: [{ key: 'voice', value: 'x' }] })).status, 403);
  assert.equal((await call(ro, '/ai/brand')).status, 200);
});

test('APR-0003: trazas de más de 90 días pierden contenido, no costos ni aislamiento ni idempotencia', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_airt');
  const b = await createTenantWithPlan(t, LIMITS, 'client_airt');
  const dispatcher = new AiDispatcher({ pool: t.pool, config: t.handle.config });
  const ctx = (tenant: string, key: string) => ({ tenantId: tenant, requestId: key, idempotencyKey: key,
    actorId: 'system:retention-test', actorKind: 'system' as const, origin: 'retention-test' });
  const values = { period: '2026-10', metrics: { days_with_activity: 1 } };
  const oldCtx = ctx(a.tenant, `old-${randomUUID()}`);
  const old = await dispatcher.invokeStructured('business.insights.generate', oldCtx, values);
  const fresh = await dispatcher.invokeStructured('business.insights.generate', ctx(a.tenant, `fresh-${randomUUID()}`), values);
  const other = await dispatcher.invokeStructured('business.insights.generate', ctx(b.tenant, `other-${randomUUID()}`), values);
  assert.ok(old.ok && fresh.ok && other.ok);
  await t.pool.query(`UPDATE ai_invocation SET created_at = now() - interval '91 days', cost_usd = 0.02,
    validation = '{"private_detail":"contenido de tercero"}' WHERE invocation_id = $1`, [old.invocationId]);
  await t.pool.query(`UPDATE ai_invocation SET created_at = now() - interval '89 days' WHERE invocation_id = $1`, [fresh.invocationId]);
  const retention = new RetentionService({ pool: t.pool, sink: new AuditSink(t.pool) });
  await retention.run({ trigger: 'manual', dryRun: true });
  assert.ok((await t.pool.query('SELECT output FROM ai_invocation WHERE invocation_id = $1', [old.invocationId])).rows[0]?.output);
  await retention.run({ trigger: 'manual', dryRun: false });
  const rows = (await t.pool.query('SELECT invocation_id, output, validation, cost_usd, status FROM ai_invocation WHERE invocation_id = ANY($1)',
    [[old.invocationId, fresh.invocationId, other.invocationId]])).rows;
  const purged = rows.find((r) => r.invocation_id === old.invocationId)!;
  assert.equal(purged.output, null);
  assert.deepEqual(purged.validation, { content_purged: true });
  assert.equal(purged.cost_usd, '0.020000');
  assert.equal(purged.status, 'succeeded');
  assert.ok(rows.find((r) => r.invocation_id === fresh.invocationId)?.output, '89 días conserva contenido');
  assert.ok(rows.find((r) => r.invocation_id === other.invocationId)?.output, 'otro tenant no se altera');
  const replay = await dispatcher.invokeStructured('business.insights.generate', oldCtx, values);
  assert.ok(!replay.ok && replay.code === 'invalid_output', 'contenido purgado no se devuelve como éxito vacío ni se regenera con la misma clave');
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM ai_invocation WHERE tenant_id = $1', [a.tenant]), 2);
});

test('DEC-0073: el corte retira Anthropic activo/canary sin promover OpenAI ni alterar costo histórico', async () => {
  const client = await t.pool.connect();
  await client.query('BEGIN');
  try {
    // Plantilla: la candidata DEC-0074 de diseño inicial (Sonnet 5.5, DRAFT); los clones toman modelo y estado propios.
    const template = (await client.query<{ route_id: string }>(
      `SELECT route_id FROM ai_route_revision WHERE use_case_id = 'website.initial.design' AND model_id = 'an:claude-sonnet-5-5' ORDER BY version DESC LIMIT 1`)).rows[0]!;
    let version = Number((await client.query(`SELECT max(version) AS v FROM ai_route_revision WHERE use_case_id = 'website.initial.design'`)).rows[0].v);
    const clone = async (model: string, status: string) => {
      const id = `rte_${randomUUID()}`;
      await client.query(`INSERT INTO ai_route_revision
        SELECT (jsonb_populate_record(NULL::ai_route_revision, to_jsonb(r) ||
          jsonb_build_object('route_id',$2::text,'version',$3::int,'model_id',$4::text,'status',$5::text))).*
        FROM ai_route_revision r WHERE route_id = $1`, [template.route_id, id, ++version, model, status]);
      return id;
    };
    const anActive = await clone('an:claude-haiku-5-5', 'ACTIVE');
    const oaCanary = await clone('oa:gpt-6.1-sol', 'CANARY');
    const oaActive = await clone('oa:gpt-6.1-sol', 'ACTIVE');
    const anCanary = await clone('an:claude-haiku-5-5', 'CANARY');
    const envA = `migration-${randomUUID()}`;
    const envB = `migration-${randomUUID()}`;
    for (const [env, active, canary] of [[envA, anActive, oaCanary], [envB, oaActive, anCanary]]) {
      await client.query(`INSERT INTO ai_rollout(use_case_id,environment,active_route_id,canary_route_id,canary_percent,version,updated_by)
        VALUES ('website.initial.design',$1,$2,$3,20,10,'test')`, [env, active, canary]);
    }
    const costsBefore = (await client.query('SELECT sum(cost_usd)::text AS total FROM ai_invocation')).rows[0].total;
    await client.query(await readFile(new URL('../../migrations/0029_ai_openai_development.sql', import.meta.url), 'utf8'));
    const rows = (await client.query('SELECT environment,active_route_id,canary_route_id,canary_percent,version FROM ai_rollout WHERE environment = ANY($1)',
      [[envA, envB]])).rows;
    const a = rows.find((r) => r.environment === envA)!;
    const b = rows.find((r) => r.environment === envB)!;
    assert.deepEqual([a.active_route_id, a.canary_route_id, a.canary_percent, Number(a.version)], [null, oaCanary, 20, 11]);
    assert.deepEqual([b.active_route_id, b.canary_route_id, b.canary_percent, Number(b.version)], [oaActive, null, 0, 11]);
    assert.deepEqual((await client.query('SELECT status FROM ai_route_revision WHERE route_id = ANY($1)', [[anActive, anCanary]])).rows,
      [{ status: 'RETIRED' }, { status: 'RETIRED' }]);
    assert.equal((await client.query('SELECT sum(cost_usd)::text AS total FROM ai_invocation')).rows[0].total, costsBefore);
    const events = (await client.query('SELECT action,from_route_id,to_route_id FROM ai_rollout_event WHERE environment = ANY($1)', [[envA, envB]])).rows;
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.action === 'retire' && e.to_route_id === null && [anActive, anCanary].includes(e.from_route_id)));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('DEC-0074: fuera de AI_ENVIRONMENT=lab el laboratorio manual está cerrado: ningún id de grant abre un borrador ni degrada a la ruta normal', async () => {
  const a = await createTenantWithPlan(t, LIMITS, 'client_ailab');
  const lab = t.handle.dispatcher.lab;
  assert.equal(lab.enabled, false, 'el entorno de regresión no es el laboratorio');
  assert.deepEqual(await lab.check({ grantId: 'lbg_cualquiera', tenantId: a.tenant, userId: a.userId }), { ok: false, reason: 'lab_disabled' });
  await assert.rejects(lab.authorize({ grantId: 'lbg_cualquiera', tenantId: a.tenant, userId: a.userId }), (e: unknown) => e instanceof AppError && e.status === 403 && e.code === 'permission_denied');
  assert.equal(await lab.authorize({ grantId: null, tenantId: a.tenant, userId: a.userId }), null, 'sin cabecera, ruta normal');
  assert.deepEqual(await lab.grantsForUser(a.tenant, a.userId), []);
  assert.equal(await lab.statusFor({ grantId: 'lbg_cualquiera', tenantId: a.tenant, userId: a.userId }), null);

  // Dispatcher: con grant en un entorno sin laboratorio no hay fallback a la ruta activa (bloqueo trazado, sin proveedor).
  const priorCalls = await countRows(t, `SELECT count(*) AS n FROM ai_invocation WHERE tenant_id = $1 AND status <> 'blocked'`, [a.tenant]);
  const res = await t.handle.dispatcher.invokeStructured('business.insights.generate',
    { requestId: 'lab-closed', idempotencyKey: `lab-closed-${randomUUID()}`, tenantId: a.tenant, actorId: a.userId, actorKind: 'tenant_user', origin: 'test', labGrantId: 'lbg_cualquiera' },
    { period: '2026-10', metrics: { days_with_activity: 1 } });
  assert.deepEqual([res.ok, !res.ok && res.code, !res.ok && res.reason], [false, 'lab_grant_invalid', 'lab_disabled']);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM ai_invocation WHERE tenant_id = $1 AND status <> 'blocked'`, [a.tenant]), priorCalls);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM ai_invocation WHERE invocation_id = $1 AND status = 'blocked' AND error_code = 'lab_grant_invalid' AND lab_grant_id = 'lbg_cualquiera'`, [res.invocationId]), 1, 'rastro durable del rechazo');
  // Jobs: un grant con el laboratorio cerrado no crea el job.
  await assert.rejects(t.handle.aiJobs.enqueue({ tenantId: a.tenant, kind: 'social.compose', idempotencyKey: `lab-closed-${randomUUID()}`, input: { request: 'x' }, useCases: ['social.facebook.post.compose'], createdBy: a.userId, labGrantId: 'lbg_cualquiera' }),
    (e: unknown) => e instanceof AppError && e.status === 403);

  // Consola: lectura posible (enabled=false, sin rutas autorizables), emisión denegada aun con step-up.
  const auth = t.handle.platformAuth;
  const sfx = randomUUID().slice(0, 6);
  const admin = await auth.createUser({ login: `lab-closed-${sfx}`, displayName: 'Admin', password: 'Plataforma-Admin-2026', roles: ['platform_admin'], grantedBy: 'test' });
  const step = currentStep();
  const token = (await platform(null, '/auth/login', 'POST', { login: `lab-closed-${sfx}`, password: 'Plataforma-Admin-2026', code: totpAt(admin.totp_secret, step) })).body.token as string;
  assert.equal((await platform(token, '/auth/step-up', 'POST', { code: totpAt(admin.totp_secret, step + 1) })).status, 200);
  const overview = await platform(token, '/ai/lab');
  assert.deepEqual([overview.status, overview.body.enabled, overview.body.environment, overview.body.routes], [200, false, ENV, []]);
  const issued = await platform(token, '/ai/lab/grants', 'POST', { tenant_id: a.tenant, user_id: a.userId, route_ids: ['rte_cualquiera'], minutes: 30, reason: 'No debería emitirse fuera del laboratorio' });
  assert.deepEqual([issued.status, issued.body.error.code], [403, 'permission_denied']);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM ai_lab_grant WHERE tenant_id = $1', [a.tenant]), 0, 'ningún grant para el negocio en el entorno de regresión');
});
