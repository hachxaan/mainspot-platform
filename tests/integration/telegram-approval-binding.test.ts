/**
 * SEC-TG-APPROVAL-01 (DEC-0077 R9; FR-0016 AC-16009/AC-16010) — `/aprobar` en Telegram solo publica lo que la
 * persona vio:
 *  - cada aviso guarda una instantánea inmutable (chat, persona, código, revisión y opciones) y su código es lo único
 *    que acepta `/aprobar <código> <N>`;
 *  - cualquier cambio de las propuestas después del aviso lo invalida: el mensaje antiguo no publica nada (tampoco
 *    el texto modificado) y llega un aviso nuevo con otro código;
 *  - carreras editor/aprobador, reentregas y repeticiones, y aislamiento entre negocios, chats y personas.
 * Telegram SIMULADO (canal del proceso de pruebas) y Google/IA simulados: nada de aquí prueba una entrega real.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { bootApi, authHeaders, api, login, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows, type TestTenant as Tenant } from '../helpers/tenants.ts';
import type { SimulatedChannel } from '../../src/channels/simulated.ts';
import type { CaseRow } from '../../src/engagement/service.ts';
import { optionsSha256, type ApprovalOfferRow } from '../../src/engagement/notice-offer.ts';
import { GOOGLE_PURGED_TEXT } from '../../src/google/retention.ts';

const WEBHOOK_SECRET = 'test-telegram-webhook-secret-approval-binding';
const WEBHOOK_HEADERS = { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET };
// Rango propio por ejecución: el libro durable de updates rechaza ids repetidos.
let nextUpdateId = 9_700_000_000 + (Date.now() % 50_000_000);
let t: TestApi;

before(async () => {
  t = await bootApi({ aiEnvironment: 'test', telegramWebhookSecret: WEBHOOK_SECRET });
});

after(async () => {
  await t.close();
});

type HttpReply = { status: number; body: any };
const call = (token: string, path: string, method = 'GET', body?: unknown) =>
  api(t.baseUrl, `/api/backoffice${path}`, { method, headers: authHeaders(token), body: body === undefined ? undefined : JSON.stringify(body) });

function transcript(): Array<{ to: string; text: string }> {
  return [...(t.handle.channel as SimulatedChannel).transcript()];
}

function newChat(): number {
  return 760_000_000 + Math.floor(Math.random() * 9e6);
}

function telegram(chat: number, text: string, updateId = nextUpdateId++): Promise<HttpReply> {
  return api(t.baseUrl, '/api/telegram/webhook', { method: 'POST', headers: WEBHOOK_HEADERS, body: JSON.stringify({ update_id: updateId, message: { chat: { id: chat }, text } }) });
}

async function link(token: string, chat: number): Promise<void> {
  const code = await call(token, '/telegram/link-code', 'POST');
  assert.equal(code.status, 201);
  assert.equal((await telegram(chat, `/start ${code.body.code}`)).body.handled, 'linked');
}

async function newTenant(prefix: string, aiReplies = 0): Promise<Tenant> {
  return createTenantWithPlan(t, { reviews_managed: 0, ai_review_replies: aiReplies }, prefix);
}

async function run(a: Tenant): Promise<void> {
  const r = await call(a.token, '/engagement/run', 'POST');
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

/** Reseña delicada → caso humano con tres propuestas y aviso a los chats vinculados del negocio. */
async function pendingCase(a: Tenant, externalRef = `g-${randomUUID().slice(0, 8)}`): Promise<CaseRow> {
  const r = await call(a.token, '/dev/simulator/google-reviews', 'POST', { body: 'Me intoxiqué después de comer, quiero un reembolso', rating: 1, author_label: 'Ana P.', external_ref: externalRef });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await run(a);
  const c = await caseOf(a, externalRef);
  assert.equal(c.state, 'needs_human');
  assert.equal(c.drafts.length, 3);
  return c;
}

async function caseOf(a: Tenant, ref: string): Promise<CaseRow> {
  const list = (await call(a.token, '/engagement/cases')).body.cases as CaseRow[];
  const found = list.find((c) => c.external_ref === ref || c.case_id === ref);
  assert.ok(found, `caso ${ref}`);
  return found;
}

/** Último aviso del caso que vio ese chat: texto, código y las opciones tal como se leen en el mensaje. */
function lastNotice(chat: number, caseId: string): { text: string; code: string; options: string[] } {
  const sent = transcript().filter((m) => m.to === String(chat) && m.text.includes(`Caso: ${caseId}`));
  const text = sent.at(-1)?.text ?? '';
  const code = /\/rechazar ([A-HJ-NP-Z2-9]{6})/.exec(text)?.[1];
  assert.ok(code, `el chat ${chat} recibió un aviso con código para ${caseId}`);
  const options = [...text.matchAll(/^([1-3])\) (.*)$/gm)].map((m) => m[2]!);
  return { text, code, options };
}

const notices = (chat: number, caseId: string) => transcript().filter((m) => m.to === String(chat) && m.text.includes(`Caso: ${caseId}`)).length;

async function offer(code: string, chat: number): Promise<ApprovalOfferRow> {
  const r = await t.pool.query<ApprovalOfferRow>('SELECT * FROM engagement_approval_offer WHERE code = $1 AND chat_id = $2', [code, String(chat)]);
  assert.ok(r.rows[0], `aviso ${code}`);
  return r.rows[0];
}

const published = (a: Tenant, ref: string) => countRows(t, 'SELECT count(*) AS n FROM sim_provider_reply WHERE tenant_id = $1 AND target_ref = $2', [a.tenant, ref]);
const publishedText = async (a: Tenant, ref: string) =>
  (await t.pool.query<{ text: string }>('SELECT text FROM sim_provider_reply WHERE tenant_id = $1 AND target_ref = $2', [a.tenant, ref])).rows.map((r) => r.text);

test('AC-16009: el aviso guarda una instantánea inmutable y /aprobar <código> N publica exactamente la opción N mostrada', async () => {
  const a = await newTenant('client_tgb1');
  const chat = newChat();
  await link(a.token, chat);
  const c = await pendingCase(a, 'tgb1');
  const shown = lastNotice(chat, c.case_id);
  assert.deepEqual(shown.options, c.drafts, 'el mensaje muestra las tres opciones del caso, numeradas');
  assert.match(shown.text, new RegExp(`/aprobar ${shown.code} 1 \\(o 2, 3\\)`));

  const o = await offer(shown.code, chat);
  assert.deepEqual([o.tenant_id, o.case_id, o.user_id, o.drafts_revision, o.status], [a.tenant, c.case_id, a.userId, c.drafts_revision, 'active']);
  assert.deepEqual(o.options, shown.options, 'la instantánea es lo que vio la persona');
  assert.equal(o.options_sha256, optionsSha256(shown.options));

  assert.equal((await telegram(chat, `/aprobar ${shown.code.toLowerCase()} 3`)).body.handled, 'approved', 'el código no distingue mayúsculas');
  const after = await caseOf(a, 'tgb1');
  assert.deepEqual([after.state, after.response_text, after.resolution_channel], ['responded', shown.options[2], 'telegram']);
  assert.deepEqual(await publishedText(a, 'tgb1'), [shown.options[2]]);
  const used = await offer(shown.code, chat);
  assert.deepEqual([used.status, used.used_option], ['used', 3]);
  const audit = await t.pool.query<{ result: string; evidence_ref: string }>(
    `SELECT result, evidence_ref FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.approved'`, [a.tenant]);
  assert.deepEqual(audit.rows, [{ result: `approved:telegram:option_3:r${c.drafts_revision}`, evidence_ref: o.offer_id }]);
});

test('AC-16009 (caso adversarial del handoff): editar la opción 1 desde el panel tras el aviso ⇒ el mensaje antiguo /aprobar 1 nunca publica el texto modificado; se reenvía el aviso y su código nuevo publica lo que muestra', async () => {
  const a = await newTenant('client_tgb2');
  const chat = newChat();
  await link(a.token, chat);
  const c = await pendingCase(a, 'tgb2');
  const old = lastNotice(chat, c.case_id);
  const modified = 'Hola Ana, sentimos lo ocurrido. Te llamamos hoy para resolverlo en privado.';
  const edited = await call(a.token, `/engagement/cases/${c.case_id}/drafts/1`, 'POST', { text: modified });
  assert.equal(edited.status, 200);
  assert.equal((edited.body.case as CaseRow).drafts_revision, c.drafts_revision + 1);
  assert.equal((await offer(old.code, chat)).status, 'superseded', 'la edición invalida el aviso que ya salió');

  const stale = await telegram(chat, `/aprobar ${old.code} 1`);
  assert.equal(stale.body.handled, 'approval_stale');
  assert.equal(await published(a, 'tgb2'), 0, 'nada publicado: ni el texto visto ni el modificado');
  assert.equal((await caseOf(a, 'tgb2')).state, 'needs_human');
  const reply = transcript().filter((m) => m.to === String(chat)).at(-2)!.text;
  assert.match(reply, /cambiaron después de enviártelo, así que no publicamos la opción 1/);
  // También la opción que no cambió: el aviso entero quedó obsoleto.
  assert.equal((await telegram(chat, `/aprobar ${old.code} 2`)).body.handled, 'approval_stale');
  assert.equal(await published(a, 'tgb2'), 0);

  const fresh = lastNotice(chat, c.case_id);
  assert.notEqual(fresh.code, old.code);
  assert.match(fresh.text, /^MainSpot · Propuestas actualizadas/);
  assert.equal(fresh.options[0], modified, 'el aviso nuevo muestra el texto modificado');
  const staleAudit = await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.approval.stale' AND decision = 'deny'`, [a.tenant]);
  assert.equal(staleAudit, 2);

  assert.equal((await telegram(chat, `/aprobar ${fresh.code} 1`)).body.handled, 'approved');
  assert.deepEqual(await publishedText(a, 'tgb2'), [modified], 'se publica lo que mostró el aviso vigente');
});

test('AC-16010: un mensaje antiguo con el formato anterior (/aprobar <case_id> N) nunca publica; el chat recibe el aviso vigente con código', async () => {
  const a = await newTenant('client_tgb3');
  const chat = newChat();
  await link(a.token, chat);
  const c = await pendingCase(a, 'tgb3');
  const before = notices(chat, c.case_id);
  const r = await telegram(chat, `/aprobar ${c.case_id} 1`);
  assert.equal(r.body.handled, 'approval_ref_invalid');
  assert.equal(await published(a, 'tgb3'), 0);
  assert.equal((await caseOf(a, 'tgb3')).state, 'needs_human');
  assert.equal(notices(chat, c.case_id), before + 1, 'aviso vigente reenviado a este chat');
  assert.equal((await telegram(chat, `/rechazar ${c.case_id}`)).body.handled, 'approval_ref_invalid', 'tampoco descarta con la referencia antigua');
  assert.equal((await caseOf(a, 'tgb3')).state, 'needs_human');
  // Sin número de opción: se pide, no se elige por defecto.
  assert.equal((await telegram(chat, `/aprobar ${lastNotice(chat, c.case_id).code}`)).body.handled, 'approval_option_missing');
  assert.equal((await telegram(chat, `/aprobar ${lastNotice(chat, c.case_id).code} 4`)).body.handled, 'approval_option_missing');
  assert.equal(await published(a, 'tgb3'), 0);
});

test('AC-16010: carrera editor/aprobador — orden forzado (la edición confirma primero) y carreras libres: jamás se publica un texto que el aviso no mostró', { timeout: 120_000 }, async () => {
  const a = await newTenant('client_tgb4');
  const chat = newChat();
  await link(a.token, chat);

  // Orden forzado: la edición tiene el candado del caso cuando llega /aprobar; al confirmarse, la aprobación ve la
  // revisión nueva y no publica.
  const forced = await pendingCase(a, 'tgb4-forced');
  const shown = lastNotice(chat, forced.case_id);
  const editor = await t.pool.connect();
  try {
    await editor.query('BEGIN');
    await editor.query(`UPDATE engagement_case SET drafts = jsonb_set(drafts, '{0}', to_jsonb($2::text)) WHERE case_id = $1`, [forced.case_id, 'Texto que el aviso nunca mostró']);
    const pending = telegram(chat, `/aprobar ${shown.code} 1`);
    await sleep(300);
    await editor.query('COMMIT');
    assert.equal((await pending).body.handled, 'approval_stale');
  } finally {
    editor.release();
  }
  assert.equal(await published(a, 'tgb4-forced'), 0);

  // Carreras libres por la API: panel edita la opción 1 mientras Telegram aprueba la opción 1 del aviso.
  const outcomes: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const ref = `tgb4-${i}`;
    const c = await pendingCase(a, ref);
    const n = lastNotice(chat, c.case_id);
    const changed = `Versión editada ${i} que no salió en el aviso.`;
    const [edit, approval] = await Promise.all([
      call(a.token, `/engagement/cases/${c.case_id}/drafts/1`, 'POST', { text: changed }),
      telegram(chat, `/aprobar ${n.code} 1`),
    ]);
    const texts = await publishedText(a, ref);
    if (approval.body.handled === 'approved') {
      assert.deepEqual(texts, [n.options[0]], 'aprobó: se publicó exactamente la opción mostrada');
      assert.equal(edit.status, 409, 'la edición llegó tarde: el caso ya estaba aprobado');
    } else {
      assert.equal(approval.body.handled, 'approval_stale', JSON.stringify(approval.body));
      assert.equal(edit.status, 200);
      assert.deepEqual(texts, [], 'obsoleto: nada publicado');
    }
    assert.ok(!texts.includes(changed), 'nunca el texto editado sin haberlo visto');
    outcomes.push(approval.body.handled);
  }
  console.log(`carreras libres: ${JSON.stringify(outcomes.reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {}))}`);
});

test('AC-16010: dos editores a la vez no se pisan: toda edición confirmada queda en las propuestas', async () => {
  const a = await newTenant('client_tgb5');
  for (let i = 0; i < 6; i += 1) {
    const c = await pendingCase(a, `tgb5-${i}`);
    const [e1, e3] = await Promise.all([
      call(a.token, `/engagement/cases/${c.case_id}/drafts/1`, 'POST', { text: `Editor uno ${i}` }),
      call(a.token, `/engagement/cases/${c.case_id}/drafts/3`, 'POST', { text: `Editor tres ${i}` }),
    ]);
    assert.ok([e1.status, e3.status].every((s) => s === 200 || s === 409), JSON.stringify([e1.status, e3.status]));
    assert.ok(e1.status === 200 || e3.status === 200, 'al menos una edición entra');
    const now = await caseOf(a, c.case_id);
    if (e1.status === 200) assert.equal(now.drafts[0], `Editor uno ${i}`);
    if (e3.status === 200) assert.equal(now.drafts[2], `Editor tres ${i}`);
    assert.equal(now.drafts_revision, c.drafts_revision + [e1, e3].filter((e) => e.status === 200).length);
  }
});

test('AC-16010: reentregas y repeticiones — mismo update ⇒ duplicate; mismo código en updates distintos y simultáneos ⇒ una sola publicación', async () => {
  const a = await newTenant('client_tgb6');
  const chat = newChat();
  await link(a.token, chat);
  const c = await pendingCase(a, 'tgb6');
  const n = lastNotice(chat, c.case_id);
  const updateId = nextUpdateId++;
  assert.equal((await telegram(chat, `/aprobar ${n.code} 2`, updateId)).body.handled, 'approved');
  assert.equal((await telegram(chat, `/aprobar ${n.code} 2`, updateId)).body.handled, 'duplicate');
  const burst = await Promise.all(Array.from({ length: 5 }, (_, i) => telegram(chat, `/aprobar ${n.code} ${1 + (i % 3)}`)));
  assert.ok(burst.every((r) => r.body.handled === 'approve_repeat'), JSON.stringify(burst.map((r) => r.body.handled)));
  assert.deepEqual(await publishedText(a, 'tgb6'), [n.options[1]]);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.approved'`, [a.tenant]), 1);

  // Aprobaciones simultáneas con el mismo código desde updates distintos: una gana, el resto ve el caso aprobado.
  const c2 = await pendingCase(a, 'tgb6b');
  const n2 = lastNotice(chat, c2.case_id);
  const race = await Promise.all(Array.from({ length: 6 }, () => telegram(chat, `/aprobar ${n2.code} 1`)));
  assert.equal(race.filter((r) => r.body.handled === 'approved').length, 1, JSON.stringify(race.map((r) => r.body.handled)));
  assert.ok(race.every((r) => r.body.handled === 'approved' || r.body.handled === 'approve_repeat'));
  assert.deepEqual(await publishedText(a, 'tgb6b'), [n2.options[0]]);
});

test('AC-16010: aislamiento — el código solo vale en el chat y para la persona y el negocio a quienes se envió', async () => {
  const a = await newTenant('client_tgb7a');
  const b = await newTenant('client_tgb7b');
  const chatA = newChat();
  const chatA2 = chatA + 1;
  const chatB = chatA + 2;
  await link(a.token, chatA);
  const opsLogin = `admin2@${a.tenant}.example.com`;
  await t.pool.query(`INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash)
    VALUES ($1, 'Admin 2', $2, 'active', $3, crypt('Fixture-User-2026!', gen_salt('bf', 4)))`, [`user_admin2_${a.tenant}`, opsLogin, a.tenant]);
  await t.pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, 'administration', $2)`, [`user_admin2_${a.tenant}`, a.tenant]);
  const admin2 = (await login(t.baseUrl, opsLogin, 'Fixture-User-2026!', a.tenant)).token;
  await link(admin2, chatA2);
  await link(b.token, chatB);
  const c = await pendingCase(a, 'tgb7');
  const codeA = lastNotice(chatA, c.case_id).code;
  const codeA2 = lastNotice(chatA2, c.case_id).code;
  assert.notEqual(codeA, codeA2, 'cada chat recibe su propio aviso');

  const toB = transcript().filter((m) => m.to === String(chatB)).length;
  assert.equal((await telegram(chatB, `/aprobar ${codeA} 1`)).body.handled, 'approval_ref_invalid', 'otro negocio');
  assert.equal((await telegram(chatB, `/aprobar ${c.case_id} 1`)).body.handled, 'approval_ref_invalid');
  assert.equal(transcript().filter((m) => m.to === String(chatB) && m.text.includes(c.case_id)).length, 0, 'nada del caso ajeno llega al otro negocio');
  assert.equal(transcript().filter((m) => m.to === String(chatB)).length, toB + 2);
  assert.equal((await telegram(chatA2, `/aprobar ${codeA} 1`)).body.handled, 'approval_ref_invalid', 'otra persona del mismo negocio, otro chat');
  assert.equal((await telegram(990_000_001, `/aprobar ${codeA} 1`)).body.handled, 'unlinked_chat');
  assert.equal(await published(a, 'tgb7'), 0);
  const invalid = await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE action = 'engagement.approval.ref_invalid' AND tenant_id = ANY($1)`, [[a.tenant, b.tenant]]);
  assert.equal(invalid, 3, 'cada intento ajeno queda auditado en el negocio de quien lo intentó');

  // El mismo chat vinculado después a otro negocio: los códigos que recibió antes ya no valen.
  const relink = await call(b.token, '/telegram/link-code', 'POST');
  assert.equal((await telegram(chatA, `/start ${relink.body.code}`)).body.handled, 'linked');
  assert.equal((await telegram(chatA, `/aprobar ${codeA} 1`)).body.handled, 'approval_ref_invalid');
  assert.equal(await published(a, 'tgb7'), 0);
  assert.equal((await caseOf(a, 'tgb7')).state, 'needs_human');
  // La otra persona del negocio sí puede aprobar con su propio aviso.
  assert.equal((await telegram(chatA2, `/aprobar ${codeA2} 1`)).body.handled, 'approved');
  assert.equal(await published(a, 'tgb7'), 1);
});

test('Integridad en BD: la instantánea no se puede reescribir y la revisión no se puede fijar a mano', async () => {
  const a = await newTenant('client_tgb8');
  const chat = newChat();
  await link(a.token, chat);
  const c = await pendingCase(a, 'tgb8');
  const n = lastNotice(chat, c.case_id);
  await assert.rejects(t.pool.query(`UPDATE engagement_approval_offer SET options = '["otra"]'::jsonb WHERE code = $1`, [n.code]), /cannot change|immutable/);
  await assert.rejects(t.pool.query(`UPDATE engagement_approval_offer SET drafts_revision = drafts_revision + 1 WHERE code = $1`, [n.code]), /immutable/);
  await t.pool.query(`UPDATE engagement_approval_offer SET status = 'used', used_option = 1, used_at = now() WHERE code = $1`, [n.code]);
  await assert.rejects(t.pool.query(`UPDATE engagement_approval_offer SET status = 'active', used_option = NULL, used_at = NULL WHERE code = $1`, [n.code]), /not allowed/);
  // La purga solo vacía las opciones: no reescribe qué opción se aprobó ni cuándo.
  await assert.rejects(t.pool.query(`UPDATE engagement_approval_offer SET status = 'purged', options = '[]'::jsonb, used_option = 2 WHERE code = $1`, [n.code]), /purging only empties/);
  await assert.rejects(t.pool.query(`UPDATE engagement_approval_offer SET status = 'purged', options = '[]'::jsonb, used_at = now() - interval '7 days' WHERE code = $1`, [n.code]), /purging only empties/);
  await t.pool.query(`UPDATE engagement_approval_offer SET status = 'purged', options = '[]'::jsonb WHERE code = $1`, [n.code]);
  assert.deepEqual([(await offer(n.code, chat)).status, (await offer(n.code, chat)).used_option], ['purged', 1]);
  await t.pool.query(`UPDATE engagement_case SET drafts_revision = 1 WHERE case_id = $1`, [c.case_id]);
  assert.equal((await caseOf(a, c.case_id)).drafts_revision, c.drafts_revision, 'la revisión solo la mueve el trigger');
  await t.pool.query(`UPDATE engagement_case SET drafts = drafts || '[]'::jsonb WHERE case_id = $1`, [c.case_id]);
  assert.equal((await caseOf(a, c.case_id)).drafts_revision, c.drafts_revision, 'sin cambio real de propuestas, misma revisión');
});

test('Purga de contenido de Google: vacía las instantáneas de los avisos y la propuesta de IA junto con el caso', async () => {
  const a = await newTenant('client_tgb9', 2);
  const chat = newChat();
  await link(a.token, chat);
  const ref = `accounts/ga/locations/gl/reviews/${randomUUID().slice(0, 8)}`;
  const c = await pendingCase(a, ref);
  const n = lastNotice(chat, c.case_id);
  const drafted = await call(a.token, `/engagement/cases/${c.case_id}/ai-draft`, 'POST');
  assert.equal(drafted.status, 201, JSON.stringify(drafted.body));
  await t.pool.query(`UPDATE engagement_case SET created_at = now() - interval '31 days' WHERE case_id = $1`, [c.case_id]);
  const report = await t.handle.google.retention.purge({ tenantId: a.tenant });
  assert.equal(report.failures, 0);
  const after = (await t.pool.query<CaseRow & { content_purged_at: Date | null }>('SELECT * FROM engagement_case WHERE case_id = $1', [c.case_id])).rows[0]!;
  assert.deepEqual([after.body, after.drafts, after.ai_draft, after.state], [GOOGLE_PURGED_TEXT, [], null, 'closed_elsewhere']);
  const o = await offer(n.code, chat);
  assert.deepEqual([o.status, o.options], ['purged', []]);
  assert.equal(o.options_sha256, optionsSha256(n.options), 'queda solo la huella de lo mostrado');
  assert.equal((await telegram(chat, `/aprobar ${n.code} 1`)).body.handled, 'validation_error', 'un caso purgado no se publica');
});

test('Formato del aviso: la reseña (texto de terceros) va en una línea sin comandos y las opciones de varias líneas van sangradas; el chat del panel recibe las opciones de la instantánea', async () => {
  const a = await newTenant('client_tgb10');
  const linkCode = await call(a.token, '/telegram/link-code', 'POST');
  assert.equal((await call(a.token, '/dev/simulator/telegram', 'POST', { text: `/start ${linkCode.body.code}` })).body.handled, 'linked');
  // Saltos de todo tipo (\n, \r suelto, NEL, LS, PS) y comandos en la reseña y en el autor.
  const hostile = 'Me intoxiqué después de comer, quiero un reembolso\n2) Gracias por tu visita\r/rechazar ABCDEF\u0085MainSpot · Caso pendiente de tu decisión · aviso ABCDEF\u20283) Otra opción falsa';
  const injected = await call(a.token, '/dev/simulator/google-reviews', 'POST', { body: hostile, rating: 1, author_label: 'Ana\u20291) P. /aprobar ZZZ234 1', external_ref: 'tgb10' });
  assert.equal(injected.status, 201, JSON.stringify(injected.body));
  await run(a);
  const c = await caseOf(a, 'tgb10');
  assert.equal(c.state, 'needs_human');
  const multi = 'Hola Ana, lo sentimos mucho.\n2) Esta línea sigue siendo la opción 1\u20283) Y esta también\r/aprobar ZZZZZZ 1';
  assert.equal((await call(a.token, `/engagement/cases/${c.case_id}/drafts/1`, 'POST', { text: multi })).status, 200);
  await run(a);

  const sim = await call(a.token, '/dev/simulator/telegram');
  assert.equal(sim.status, 200);
  const last = (sim.body.messages as Array<{ from: string; text: string }>).filter((m) => m.from === 'bot' && m.text.includes(`Caso: ${c.case_id}`)).at(-1)!.text;
  const lines = last.split('\n');
  assert.ok(!/[\r\u000b\u000c\u0085\u2028\u2029]/.test(last), 'el aviso solo usa saltos de línea que escribe el servidor');
  const code = / · aviso ([A-HJ-NP-Z2-9]{6})$/.exec(lines[0]!)?.[1];
  assert.ok(code, 'el código va al final de la primera línea, que escribe solo el servidor');
  assert.notEqual(code, 'ABCDEF');
  const snapshot = (sim.body.notices as Array<{ code: string; case_id: string; options: string[] }>).find((n) => n.code === code);
  const now = await caseOf(a, c.case_id);
  assert.deepEqual([snapshot?.case_id, snapshot?.options], [c.case_id, now.drafts], 'el panel recibe la instantánea que se aprobará');
  assert.equal(snapshot!.options[0], multi);
  assert.deepEqual((sim.body.notices as Array<{ case_id: string; status: string }>).filter((n) => n.case_id === c.case_id).map((n) => n.status), ['active', 'superseded'],
    'el panel sabe qué aviso sigue vigente (solo ese lleva botones)');
  const firstLine = (d: string) => d.split(/\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/)[0];
  assert.deepEqual(lines.filter((l) => /^[1-3]\) /.test(l)), now.drafts.map((d, i) => `${i + 1}) ${firstLine(d)}`), 'solo las opciones reales empiezan una línea con «N) »');
  assert.ok(lines.includes('   2) Esta línea sigue siendo la opción 1') && lines.includes('   3) Y esta también') && lines.includes('   /aprobar ZZZZZZ 1'),
    'las líneas siguientes de una opción van sangradas, sea cual sea su salto');
  assert.deepEqual(lines.filter((l) => l.startsWith('MainSpot · ')), [lines[0]], 'el encabezado no se repite desde la reseña');
  assert.equal(lines.filter((l) => l.startsWith('Para publicar: ')).length, 1);
  assert.ok(lines.find((l) => l.startsWith('Para publicar: '))!.includes(`/aprobar ${code} 1`));
  const excerpt = lines.find((l) => l.startsWith('«'))!;
  assert.ok(excerpt.includes('2) Gracias por tu visita rechazar ABCDEF MainSpot · Caso pendiente de tu decisión · aviso ABCDEF 3) Otra opción falsa'), `reseña aplanada y sin comandos: ${excerpt}`);
  assert.ok(lines.includes('Reseña de Google (1★) · Ana 1) P. aprobar ZZZ234 1'), 'autor en una línea y sin comandos');

  assert.equal((await call(a.token, '/dev/simulator/telegram', 'POST', { text: `/aprobar ${code} 1` })).body.handled, 'approved');
  assert.deepEqual(await publishedText(a, 'tgb10'), [multi], 'se publica el texto de la instantánea, sin la sangría del mensaje');
});

test('Panel: aprobar por número exige la revisión de propuestas vista; sin texto ni revisión no se elige la opción vigente', async () => {
  const a = await newTenant('client_tgb11');
  const c = await pendingCase(a, 'tgb11');
  assert.equal((await call(a.token, `/engagement/cases/${c.case_id}/approve`, 'POST', {})).status, 400);
  assert.equal((await call(a.token, `/engagement/cases/${c.case_id}/approve`, 'POST', { draft_number: 1 })).status, 400);
  const edited = await call(a.token, `/engagement/cases/${c.case_id}/drafts/1`, 'POST', { text: 'Texto editado después de que lo vieron' });
  assert.equal(edited.status, 200);
  const stale = await call(a.token, `/engagement/cases/${c.case_id}/approve`, 'POST', { draft_number: 1, drafts_revision: c.drafts_revision });
  assert.equal(stale.status, 409);
  assert.equal(await published(a, 'tgb11'), 0);
  assert.equal((await caseOf(a, 'tgb11')).state, 'needs_human');
  const seen = edited.body.case as CaseRow;
  const ok = await call(a.token, `/engagement/cases/${c.case_id}/approve`, 'POST', { draft_number: 2, drafts_revision: seen.drafts_revision });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(await publishedText(a, 'tgb11'), [seen.drafts[1]]);
});

test('Negocio suspendido o en baja: su chat vinculado no decide ni publica aunque el aviso siga vigente', async () => {
  const a = await newTenant('client_tgb12');
  const chat = newChat();
  await link(a.token, chat);
  const c = await pendingCase(a, 'tgb12');
  const n = lastNotice(chat, c.case_id);
  for (const status of ['suspended', 'exiting']) {
    await t.pool.query('UPDATE client SET status = $2 WHERE client_id = $1', [a.tenant, status]);
    assert.equal((await telegram(chat, `/aprobar ${n.code} 1`)).body.handled, 'tenant_inactive', status);
    assert.equal((await telegram(chat, `/rechazar ${n.code}`)).body.handled, 'tenant_inactive', status);
  }
  assert.equal(await published(a, 'tgb12'), 0);
  assert.equal((await t.pool.query<{ state: string }>('SELECT state FROM engagement_case WHERE case_id = $1', [c.case_id])).rows[0]?.state, 'needs_human');
  await t.pool.query(`UPDATE client SET status = 'active' WHERE client_id = $1`, [a.tenant]);
  assert.equal((await telegram(chat, `/aprobar ${n.code} 1`)).body.handled, 'approved');
  assert.deepEqual(await publishedText(a, 'tgb12'), [n.options[0]]);
});

test('Publicación aprobada que falla: los chats avisados reciben el aviso vigente y repetir el código ya usado lo explica sin publicar', { timeout: 60_000 }, async () => {
  const a = await newTenant('client_tgb13');
  const chat = newChat();
  await link(a.token, chat);
  const c = await pendingCase(a, 'tgb13');
  const n = lastNotice(chat, c.case_id);
  assert.equal((await call(a.token, '/dev/simulator/faults', 'POST', { origin: 'google_review', kind: 'error', count: 20 })).status, 200);
  assert.equal((await telegram(chat, `/aprobar ${n.code} 1`)).body.handled, 'approved');
  for (let i = 0; i < 6; i += 1) {
    await t.pool.query(`UPDATE engagement_case SET next_attempt_at = now() WHERE case_id = $1 AND state = 'retry_pending'`, [c.case_id]);
    await run(a);
  }
  await run(a);
  assert.equal((await caseOf(a, 'tgb13')).state, 'failed');
  const failed = lastNotice(chat, c.case_id);
  assert.notEqual(failed.code, n.code, 'aviso nuevo con su propio código');
  assert.match(failed.text, /^MainSpot · No pudimos publicar la respuesta aprobada · aviso /);

  assert.equal((await telegram(chat, `/aprobar ${n.code} 1`)).body.handled, 'approval_used');
  assert.match(transcript().filter((m) => m.to === String(chat)).at(-2)!.text, /^Ese aviso ya se usó para aprobar este caso/);
  assert.equal(await published(a, 'tgb13'), 0);

  assert.equal((await call(a.token, '/dev/simulator/faults', 'POST', { origin: 'google_review', kind: 'error', count: 0 })).status, 200);
  const current = lastNotice(chat, c.case_id);
  assert.equal((await telegram(chat, `/aprobar ${current.code} 1`)).body.handled, 'approved');
  assert.deepEqual(await publishedText(a, 'tgb13'), [current.options[0]]);
});

test('Reintento del canal con las mismas propuestas: el aviso no dice «Propuestas actualizadas» y su código aprueba', async () => {
  const a = await newTenant('client_tgb14');
  const chat = newChat();
  await link(a.token, chat);
  assert.equal((await call(a.token, '/dev/simulator/faults', 'POST', { origin: 'telegram', kind: 'error', count: 1 })).status, 200);
  const r = await call(a.token, '/dev/simulator/google-reviews', 'POST', { body: 'Me intoxiqué después de comer, quiero un reembolso', rating: 1, author_label: 'Ana P.', external_ref: 'tgb14' });
  assert.equal(r.status, 201);
  await run(a);
  const c = await caseOf(a, 'tgb14');
  assert.equal(notices(chat, c.case_id), 0, 'el primer envío falló');
  await t.pool.query('UPDATE engagement_notification SET next_attempt_at = now() WHERE case_id = $1', [c.case_id]);
  await run(a);
  const n = lastNotice(chat, c.case_id);
  assert.match(n.text, /^MainSpot · Caso pendiente de tu decisión · aviso /);
  assert.equal((await telegram(chat, `/aprobar ${n.code} 1`)).body.handled, 'approved');
});
