/**
 * Botones de Telegram atados a lo que mostraron (SEC-TG-APPROVAL-01, DEC-0077; integración de los botones en línea):
 *  - los botones de un aviso de caso llevan el código de su instantánea y el número de opción, nunca el id del caso:
 *    un botón de un aviso obsoleto, repetido, de otro chat/persona/negocio o con el formato anterior nunca publica;
 *  - «Publicar ahora» / «Programar» de una publicación de Facebook solo actúan si la publicación (y la hora sugerida)
 *    siguen siendo las que mostró la tarjeta; elegir una variante crea un solo borrador y consume una sola unidad.
 * Telegram, Google, Meta e IA SIMULADOS (canal y proveedores del proceso de pruebas): nada de aquí prueba una entrega real.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApi, authHeaders, api, login, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows, type TestTenant as Tenant } from '../helpers/tenants.ts';
import type { OutboxEntry, SimulatedChannel } from '../../src/channels/simulated.ts';
import type { CaseRow } from '../../src/engagement/service.ts';

const WEBHOOK_SECRET = 'test-telegram-webhook-secret-button-binding';
const WEBHOOK_HEADERS = { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET };
// Rango propio por ejecución (el libro durable de updates rechaza ids repetidos; los demás archivos usan 9_0…–9_7…).
let nextUpdateId = 9_800_000_000 + (Date.now() % 50_000_000);
let t: TestApi;

before(async () => {
  t = await bootApi({ aiEnvironment: 'test', telegramWebhookSecret: WEBHOOK_SECRET });
});

after(async () => {
  t.handle.aiJobs.stop();
  await t.close();
});

interface Btn { message_id: string; action: string }

const call = (token: string, path: string, method = 'GET', body?: unknown) =>
  api(t.baseUrl, `/api/backoffice${path}`, { method, headers: authHeaders(token), body: body === undefined ? undefined : JSON.stringify(body) });

function webhook(update: unknown) {
  return api(t.baseUrl, '/api/telegram/webhook', { method: 'POST', headers: WEBHOOK_HEADERS, body: JSON.stringify(update) });
}

function telegram(chat: number, text: string, updateId = nextUpdateId++) {
  return webhook({ update_id: updateId, message: { chat: { id: chat }, text } });
}

/** Pulsación de un botón tal como la entrega Telegram (callback_query del mensaje `message_id` de ese chat). */
function press(chat: number, btn: Btn, updateId = nextUpdateId++) {
  return webhook({ update_id: updateId, callback_query: { id: `cbq_${updateId}`, data: btn.action, message: { message_id: Number(btn.message_id), chat: { id: chat } } } });
}

function newChat(): number {
  return 780_000_000 + Math.floor(Math.random() * 9e6);
}

const inChat = (chat: number): OutboxEntry[] => (t.handle.channel as SimulatedChannel).transcript().filter((m) => m.to === String(chat));
const message = (chat: number, id: string): OutboxEntry => {
  const m = inChat(chat).find((x) => x.message_id === id);
  assert.ok(m, `mensaje ${id}`);
  return m;
};

function buttonOf(m: OutboxEntry, label: RegExp): Btn {
  const b = m.buttons.flat().find((x) => label.test(x.label));
  assert.ok(b, `botón ${label} en el mensaje ${m.message_id}`);
  return { message_id: m.message_id, action: b.action };
}

/** Último aviso (tarjeta con botones) del caso en ese chat y su código, que va al final de la primera línea. */
function noticeCard(chat: number, caseId: string): OutboxEntry & { code: string } {
  const m = inChat(chat).filter((x) => x.text.includes(`Caso: ${caseId}`) && x.buttons.length).at(-1);
  assert.ok(m, `el chat ${chat} recibió un aviso con botones para ${caseId}`);
  const code = / · aviso ([A-HJ-NP-Z2-9]{6})$/.exec(m.text.split('\n')[0]!)?.[1];
  assert.ok(code, 'código del aviso en su primera línea');
  return { ...m, code };
}

async function link(token: string, chat: number): Promise<void> {
  const code = await call(token, '/telegram/link-code', 'POST');
  assert.equal(code.status, 201);
  assert.equal((await telegram(chat, `/start ${code.body.code}`)).body.handled, 'linked');
}

async function addUser(a: Tenant, role: 'administration' | 'operation'): Promise<string> {
  const id = `user_${role}2_${a.tenant}`;
  const loginName = `${role}2@${a.tenant}.example.com`;
  await t.pool.query(`INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash)
    VALUES ($1, $2, $3, 'active', $4, crypt('Fixture-User-2026!', gen_salt('bf', 4)))`, [id, role, loginName, a.tenant]);
  await t.pool.query('INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, $2, $3)', [id, role, a.tenant]);
  return (await login(t.baseUrl, loginName, 'Fixture-User-2026!', a.tenant)).token;
}

async function caseOf(a: Tenant, ref: string): Promise<CaseRow> {
  const list = (await call(a.token, '/engagement/cases')).body.cases as CaseRow[];
  const found = list.find((c) => c.external_ref === ref || c.case_id === ref);
  assert.ok(found, `caso ${ref}`);
  return found;
}

/** Reseña delicada → caso humano con tres propuestas, avisado a los chats vinculados del negocio. */
async function pendingCase(a: Tenant, ref: string): Promise<CaseRow> {
  const r = await call(a.token, '/dev/simulator/google-reviews', 'POST', { body: 'Me intoxiqué después de comer, quiero un reembolso', rating: 1, author_label: 'Ana P.', external_ref: ref });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await call(a.token, '/engagement/run', 'POST')).status, 200);
  const c = await caseOf(a, ref);
  assert.deepEqual([c.state, c.drafts.length], ['needs_human', 3]);
  return c;
}

const publishedTexts = async (a: Tenant, ref: string) =>
  (await t.pool.query<{ text: string }>('SELECT text FROM sim_provider_reply WHERE tenant_id = $1 AND target_ref = $2', [a.tenant, ref])).rows.map((r) => r.text);
const audits = (a: Tenant, action: string) => countRows(t, 'SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = $2', [a.tenant, action]);

test('(a) botón de un aviso anterior a una edición: no publica, audita el intento obsoleto, el mensaje pierde sus botones y llega un aviso nuevo con otro código', async () => {
  const a = await createTenantWithPlan(t, { reviews_managed: 0 }, 'client_tgbb_a');
  const chat = newChat();
  await link(a.token, chat);
  const c = await pendingCase(a, 'tgbb-a');
  const old = noticeCard(chat, c.case_id);
  assert.ok(old.buttons.flat().every((b) => b.action.includes(old.code) && !b.action.includes(c.case_id)), 'los botones llevan el código del aviso, no el id del caso');

  // Elegir la opción 1 muestra la de la instantánea de ESE aviso; todavía no publica nada.
  assert.equal((await press(chat, buttonOf(old, /Usar la respuesta 1/))).body.handled, 'draft_selected');
  const publishOld = buttonOf(message(chat, old.message_id), /Publicar esta respuesta/);
  assert.equal(publishOld.action, `na:${old.code}:1`);

  // Operación edita la opción 1 en el panel DESPUÉS del aviso.
  const modified = 'Hola Ana, sentimos lo ocurrido. Te llamamos hoy para resolverlo en privado.';
  const edited = await call(a.token, `/engagement/cases/${c.case_id}/drafts/1`, 'POST', { text: modified });
  assert.equal(edited.status, 200);

  assert.equal((await press(chat, publishOld)).body.handled, 'approval_stale');
  assert.deepEqual(await publishedTexts(a, 'tgbb-a'), [], 'nada publicado: ni lo que mostró el aviso ni lo editado');
  assert.equal((await caseOf(a, 'tgbb-a')).state, 'needs_human');
  assert.equal(await audits(a, 'engagement.approval.stale'), 1);
  assert.deepEqual(message(chat, old.message_id).buttons, [], 'el aviso obsoleto ya no ofrece botones');
  const fresh = noticeCard(chat, c.case_id);
  assert.notEqual(fresh.code, old.code, 'llega el aviso vigente con su propio código');
  assert.ok(Number(fresh.message_id) > Number(old.message_id));

  // Un botón fabricado con otra opción del aviso viejo, o con el formato anterior (id del caso + índice), tampoco publica.
  assert.equal((await press(chat, { message_id: old.message_id, action: `na:${old.code}:2` })).body.handled, 'approval_stale');
  assert.equal((await press(chat, { message_id: old.message_id, action: `ca:${c.case_id}:0` })).body.handled, 'approval_ref_invalid');
  assert.equal((await press(chat, { message_id: old.message_id, action: `np:${old.code}:3` })).body.handled, 'approval_stale', 'elegir en un aviso obsoleto tampoco muestra sus opciones');
  assert.deepEqual(await publishedTexts(a, 'tgbb-a'), []);

  // Con el aviso vigente se publica exactamente lo que muestra.
  const current = noticeCard(chat, c.case_id);
  assert.equal((await press(chat, buttonOf(current, /Usar la respuesta 1/))).body.handled, 'draft_selected');
  assert.equal((await press(chat, buttonOf(message(chat, current.message_id), /Publicar esta respuesta/))).body.handled, 'approved');
  assert.deepEqual(await publishedTexts(a, 'tgbb-a'), [modified]);
  const done = await caseOf(a, 'tgbb-a');
  assert.deepEqual([done.state, done.resolution_channel], ['responded', 'telegram']);
});

test('(b) reentrega del mismo update o doble pulsación de «Publicar esta respuesta»: una sola publicación y una sola decisión auditada', async () => {
  const a = await createTenantWithPlan(t, { reviews_managed: 0 }, 'client_tgbb_b');
  const chat = newChat();
  await link(a.token, chat);
  const c = await pendingCase(a, 'tgbb-b');
  const n = noticeCard(chat, c.case_id);
  assert.equal((await press(chat, buttonOf(n, /Usar la respuesta 2/))).body.handled, 'draft_selected');
  const publish = buttonOf(message(chat, n.message_id), /Publicar esta respuesta/);
  const updateId = nextUpdateId++;
  assert.equal((await press(chat, publish, updateId)).body.handled, 'approved');
  assert.equal((await press(chat, publish, updateId)).body.handled, 'duplicate', 'la misma entrega repetida no vuelve a decidir');
  const burst = await Promise.all(Array.from({ length: 5 }, () => press(chat, publish)));
  assert.ok(burst.every((r) => r.body.handled === 'approve_repeat'), JSON.stringify(burst.map((r) => r.body.handled)));
  assert.equal((await press(chat, { message_id: n.message_id, action: `na:${n.code}:1` })).body.handled, 'approve_repeat', 'otra opción del mismo aviso tampoco publica después');
  assert.deepEqual(await publishedTexts(a, 'tgbb-b'), [c.drafts[1]]);
  assert.equal(await audits(a, 'engagement.approved'), 1);

  // Pulsaciones simultáneas (updates distintos) del mismo botón: una gana; el resto ve el caso ya aprobado.
  const c2 = await pendingCase(a, 'tgbb-b2');
  const n2 = noticeCard(chat, c2.case_id);
  const race = await Promise.all(Array.from({ length: 6 }, () => press(chat, { message_id: n2.message_id, action: `na:${n2.code}:1` })));
  assert.equal(race.filter((r) => r.body.handled === 'approved').length, 1, JSON.stringify(race.map((r) => r.body.handled)));
  assert.ok(race.every((r) => r.body.handled === 'approved' || r.body.handled === 'approve_repeat'));
  assert.deepEqual(await publishedTexts(a, 'tgbb-b2'), [c2.drafts[0]]);
  assert.equal(await audits(a, 'engagement.approved'), 2);
});

test('(c) botón de un aviso de otro chat, otra persona u otro negocio: inválido y sin publicar; sin permiso o con el negocio inactivo tampoco decide', async () => {
  const a = await createTenantWithPlan(t, { reviews_managed: 0 }, 'client_tgbb_c');
  const b = await createTenantWithPlan(t, { reviews_managed: 0 }, 'client_tgbb_cb');
  const chatA = newChat();
  const chatA2 = chatA + 1;
  const chatOps = chatA + 2;
  const chatB = chatA + 3;
  await link(a.token, chatA);
  await link(await addUser(a, 'administration'), chatA2);
  await link(await addUser(a, 'operation'), chatOps);
  await link(b.token, chatB);
  const c = await pendingCase(a, 'tgbb-c');
  const nA = noticeCard(chatA, c.case_id);
  const approveA = { message_id: nA.message_id, action: `na:${nA.code}:1` };

  for (const action of [approveA.action, `np:${nA.code}:1`, `nr:${nA.code}`]) {
    assert.equal((await press(chatB, { ...approveA, action })).body.handled, 'approval_ref_invalid', `otro negocio: ${action}`);
    assert.equal((await press(chatA2, { ...approveA, action })).body.handled, 'approval_ref_invalid', `misma empresa, otra persona y chat: ${action}`);
  }
  assert.equal((await press(990_000_002, approveA)).body.handled, 'unlinked_chat');
  const ops = noticeCard(chatOps, c.case_id);
  assert.equal((await press(chatOps, { message_id: ops.message_id, action: `na:${ops.code}:1` })).body.handled, 'permission_denied', 'Operación recibe el aviso pero no decide');
  assert.deepEqual(await publishedTexts(a, 'tgbb-c'), []);
  assert.equal((await caseOf(a, 'tgbb-c')).state, 'needs_human');
  assert.equal(inChat(chatB).filter((m) => m.text.includes(c.case_id)).length, 0, 'nada del caso ajeno llega al otro negocio');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.approval.ref_invalid'`, [b.tenant]), 3);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.approval.ref_invalid'`, [a.tenant]), 3);

  // Negocio suspendido o en baja: su chat no decide aunque el aviso siga vigente.
  for (const status of ['suspended', 'exiting']) {
    await t.pool.query('UPDATE client SET status = $2 WHERE client_id = $1', [a.tenant, status]);
    assert.equal((await press(chatA, approveA)).body.handled, 'tenant_inactive', status);
    assert.equal((await press(chatA, { ...approveA, action: `nr:${nA.code}` })).body.handled, 'tenant_inactive', status);
  }
  await t.pool.query(`UPDATE client SET status = 'active' WHERE client_id = $1`, [a.tenant]);
  assert.deepEqual(await publishedTexts(a, 'tgbb-c'), []);
  assert.equal((await press(chatA, approveA)).body.handled, 'approved', 'el dueño del aviso, con su negocio activo, sí publica');
  assert.deepEqual(await publishedTexts(a, 'tgbb-c'), [c.drafts[0]]);
});

/** Pide una publicación por el chat y deja lista la tarjeta de variantes (redacción con IA simulada). */
async function variantsCard(a: Tenant, chat: number, text: string): Promise<OutboxEntry> {
  assert.equal((await telegram(chat, text)).body.handled, 'conversation:blocked');
  const offer = inChat(chat).at(-1)!;
  assert.equal((await press(chat, buttonOf(offer, /^📣 Prepararla$/))).body.handled, 'social_compose_started');
  await t.handle.aiJobs.drain(a.tenant);
  const variants = inChat(chat).at(-1)!;
  assert.match(variants.text, /Propuestas para Facebook/);
  return variants;
}

test('(d) «Publicar ahora» o «Programar» de una tarjeta cuya publicación u hora cambiaron: no publica ni programa; la tarjeta se actualiza y su botón nuevo publica lo que muestra', async () => {
  const a = await createTenantWithPlan(t, { conversations: 20, social_posts: 5 }, 'client_tgbb_d');
  const chat = newChat();
  await link(a.token, chat);
  const variants = await variantsCard(a, chat, 'Publica en Facebook que hoy hay 2x1 en tacos de 1 a 5 pm');
  assert.equal((await press(chat, buttonOf(variants, /Usar la 1/))).body.handled, 'social_draft_created');
  const card = message(chat, variants.message_id);
  const post = (await t.pool.query<{ post_id: string; text: string }>('SELECT post_id, text FROM social_post WHERE tenant_id = $1', [a.tenant])).rows[0]!;
  assert.ok(card.text.includes(post.text), 'la tarjeta muestra el texto completo de la publicación');
  const publishOld = buttonOf(card, /Publicar ahora/);
  const scheduleOld = buttonOf(card, /Programar/);

  // La publicación cambia después de mostrarla (cualquier cambio de contenido; no hay ruta de edición, se cambia en BD).
  const changed = `${post.text} Solo hoy.`;
  await t.pool.query('UPDATE social_post SET text = $2 WHERE post_id = $1', [post.post_id, changed]);
  for (const btn of [publishOld, scheduleOld, { message_id: card.message_id, action: `sp:${post.post_id}` }]) {
    assert.equal((await press(chat, btn)).body.handled, 'social_stale', btn.action);
  }
  const untouched = (await t.pool.query<{ status: string; proposal_id: string | null }>('SELECT status, proposal_id FROM social_post WHERE post_id = $1', [post.post_id])).rows[0];
  assert.deepEqual(untouched, { status: 'draft', proposal_id: null }, 'ni aprobada, ni programada, ni publicada');
  const refreshed = message(chat, card.message_id);
  assert.ok(refreshed.text.includes(changed), 'la misma tarjeta muestra la publicación vigente');

  // La hora sugerida cambia después de mostrarla: «Programar» no programa a otra hora que la mostrada.
  await t.pool.query(`UPDATE ai_job SET result = jsonb_set(result, '{suggested_slot}', '{"weekday":"mon","hour":9}'::jsonb)
    WHERE job_id = (SELECT generation->>'job_id' FROM social_post WHERE post_id = $1)`, [post.post_id]);
  assert.equal((await press(chat, buttonOf(refreshed, /Programar/))).body.handled, 'social_stale');
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM scheduled_post WHERE post_id = $1', [post.post_id]), 0);
  assert.match(buttonOf(message(chat, card.message_id), /Programar/).action, /^ss:/);
  assert.match(message(chat, card.message_id).buttons.flat().find((x) => /Programar/.test(x.label))!.label, /lun \d{1,2} [a-z]{3}, 09:00$/);

  // El botón de la tarjeta vigente publica exactamente lo que muestra.
  assert.equal((await press(chat, buttonOf(message(chat, card.message_id), /Publicar ahora/))).body.handled, 'social_published');
  const done = (await t.pool.query<{ status: string; text: string; proposal_id: string }>('SELECT status, text, proposal_id FROM social_post WHERE post_id = $1', [post.post_id])).rows[0]!;
  assert.deepEqual([done.status, done.text], ['published', changed]);
  assert.equal((await t.pool.query<{ source: string }>('SELECT source FROM publication WHERE tenant_id = $1 AND proposal_id = $2', [a.tenant, done.proposal_id])).rows[0]?.source, 'telegram');
});

test('(e) elegir variante: la reentrega, la doble pulsación u otra variante de la misma tarjeta crean UN borrador y consumen UNA unidad de social_posts', async () => {
  const a = await createTenantWithPlan(t, { conversations: 20, social_posts: 5 }, 'client_tgbb_e');
  const chat = newChat();
  await link(a.token, chat);
  const variants = await variantsCard(a, chat, 'Publica en Facebook que el domingo abrimos a las 8');
  const pick1 = buttonOf(variants, /Usar la 1/);
  const pick2 = buttonOf(variants, /Usar la 2/);
  const updateId = nextUpdateId++;
  assert.equal((await press(chat, pick1, updateId)).body.handled, 'social_draft_created');
  assert.equal((await press(chat, pick1, updateId)).body.handled, 'duplicate');
  const burst = await Promise.all([press(chat, pick1), press(chat, pick2), press(chat, pick1), press(chat, pick2)]);
  assert.ok(burst.every((r) => r.body.handled === 'social_draft_repeat'), JSON.stringify(burst.map((r) => r.body.handled)));
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM social_post WHERE tenant_id = $1', [a.tenant]), 1, 'un solo borrador');
  assert.equal(await countRows(t, `SELECT COALESCE(sum(units), 0) AS n FROM quota_reservation WHERE tenant_id = $1 AND capability = 'social_posts' AND state = 'committed'`, [a.tenant]), 1, 'una sola unidad de cuota');
  assert.equal(await audits(a, 'social.created'), 1);
  const draft = (await t.pool.query<{ generation: { variant: number } }>('SELECT generation FROM social_post WHERE tenant_id = $1', [a.tenant])).rows[0]!;
  assert.equal(draft.generation.variant, 0, 'el borrador es la variante de la primera pulsación');
});
