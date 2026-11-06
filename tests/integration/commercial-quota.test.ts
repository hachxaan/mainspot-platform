/**
 * DEC-0076 (SRC-0014 C01, C04–C06) — semántica comercial de cuotas de reseñas, de punta a punta por la API:
 *  - recibir reseñas (sync del backoffice y worker) NO consume cuota ni se limita por plan, también con la IA agotada;
 *  - responder manualmente (panel o Telegram) no consume; cada respuesta redactada con IA consume exactamente 1 unidad
 *    de `ai_review_replies` del ciclo mensual anclado al inicio de la suscripción, sin acumulación;
 *  - replay y concurrencia: como máximo 1 unidad por caso y nunca por encima del límite;
 *  - agotar o no tener la cuota solo bloquea la redacción con IA (sin cargo); fallo de la IA ⇒ sin consumo;
 *  - aislamiento entre negocios y respuesta automática autorizada medida con el mismo libro.
 * Todo con el AI Core SIMULADO del entorno `test` (rutas simuladas activas): nada de aquí prueba un proveedor real.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApi, authHeaders, api, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows, failAuditFor, type TestTenant as Tenant } from '../helpers/tenants.ts';
import { createPublishedPlan, setTenantPlan } from '../helpers/plans.ts';
import { EngagementService, aiReplyQuotaKey, type CaseRow } from '../../src/engagement/service.ts';
import type { EngagementSemantics, ReplyOutcome } from '../../src/engagement/ai-semantics.ts';
import { AUTO_REPLY_CONSENT } from '../../src/engagement/consent.ts';
import type { SimulatedChannel } from '../../src/channels/simulated.ts';

const WEBHOOK_SECRET = 'test-telegram-webhook-secret-commercial-quota';
const WEBHOOK_HEADERS = { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET };
// Rango propio y distinto en cada ejecución: el libro durable de updates rechaza ids repetidos (re-ejecutable sin
// test-prep) y engagement-agent usa 9_0…, 9_100_000_001 y 9_2….
let nextUpdateId = 9_500_000_000 + (Date.now() % 50_000_000);
let t: TestApi;

before(async () => {
  t = await bootApi({ aiEnvironment: 'test', telegramWebhookSecret: WEBHOOK_SECRET });
});

after(async () => {
  await t.close();
});

/** Respuesta HTTP de los helpers de prueba (`api`). */
type HttpReply = { status: number; body: any };

/** Vincula un chat de Telegram (simulado) a la persona del negocio y devuelve cómo escribir por ese chat. */
async function linkTelegram(a: { token: string }): Promise<((text: string) => Promise<HttpReply>) & { chat: number }> {
  const chat = 710000000 + Math.floor(Math.random() * 1e6);
  const code = await call(a.token, '/telegram/link-code', 'POST');
  assert.equal(code.status, 201);
  const hook = (text: string) => api(t.baseUrl, '/api/telegram/webhook', { method: 'POST', headers: WEBHOOK_HEADERS, body: JSON.stringify({ update_id: nextUpdateId++, message: { chat: { id: chat }, text } }) });
  assert.equal((await hook(`/start ${code.body.code}`)).body.handled, 'linked');
  return Object.assign(hook, { chat });
}

/** Último aviso de Telegram que recibió ese chat para el caso, tal como lo vio la persona, y su código. */
function lastNotice(chat: number, caseId: string): { text: string; code: string } {
  const sent = (t.handle.channel as SimulatedChannel).transcript().filter((m) => m.to === String(chat) && m.text.includes(`Caso: ${caseId}`));
  const text = sent.at(-1)?.text ?? '';
  const code = /\/rechazar ([A-HJ-NP-Z2-9]{6})/.exec(text)?.[1];
  assert.ok(code, `el chat recibió un aviso con código para ${caseId}`);
  return { text, code };
}

const call = (token: string, path: string, method = 'GET', body?: unknown) =>
  api(t.baseUrl, `/api/backoffice${path}`, { method, headers: authHeaders(token), body: body === undefined ? undefined : JSON.stringify(body) });

async function newTenant(aiReplies: number | null, prefix: string, extra: Record<string, number> = {}): Promise<Tenant> {
  const limits: Record<string, number> = { reviews_managed: 0, ...extra };
  if (aiReplies !== null) limits['ai_review_replies'] = aiReplies;
  return createTenantWithPlan(t, limits, prefix);
}

async function injectReview(a: Tenant, body: string, rating: number): Promise<string> {
  const ref = `g-${randomUUID().slice(0, 8)}`;
  const r = await call(a.token, '/dev/simulator/google-reviews', 'POST', { body, rating, author_label: 'Ana P.', external_ref: ref });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return ref;
}

async function run(a: Tenant) {
  const r = await call(a.token, '/engagement/run', 'POST');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.report as { ingested: Record<string, number>; responded: number };
}

async function caseOf(a: Tenant, ref: string): Promise<CaseRow> {
  const list = (await call(a.token, '/engagement/cases')).body.cases as CaseRow[];
  const found = list.find((c) => c.external_ref === ref);
  assert.ok(found, `caso ${ref}`);
  return found;
}

/** N reseñas que esperan decisión (sin política: todas a revisión humana). */
async function humanCases(a: Tenant, n: number): Promise<CaseRow[]> {
  const refs: string[] = [];
  for (let i = 0; i < n; i += 1) refs.push(await injectReview(a, `Buen lugar, aunque la espera fue larga (${i}).`, 3));
  await run(a);
  const out: CaseRow[] = [];
  for (const ref of refs) {
    const c = await caseOf(a, ref);
    assert.equal(c.state, 'needs_human');
    out.push(c);
  }
  return out;
}

const aiDraft = (a: Tenant, caseId: string) => call(a.token, `/engagement/cases/${caseId}/ai-draft`, 'POST');
const status = async (a: Tenant) => (await call(a.token, '/engagement/ai-replies')).body.ai_replies as {
  available: boolean; subscription_active: boolean; limit: number | null; usage: number; remaining: number | null; window: { start: string; end: string } | null;
};

/** Unidades confirmadas y reservas vivas de `ai_review_replies` del negocio. */
async function ledger(a: Tenant): Promise<{ committed: number; reserved: number; rows: number }> {
  const r = await t.pool.query<{ committed: string; reserved: string; rows: string }>(
    `SELECT COALESCE(SUM(units) FILTER (WHERE state = 'committed'), 0) AS committed,
            count(*) FILTER (WHERE state = 'reserved') AS reserved, count(*) AS rows
       FROM quota_reservation WHERE tenant_id = $1 AND capability = 'ai_review_replies'`, [a.tenant]);
  return { committed: Number(r.rows[0]?.committed), reserved: Number(r.rows[0]?.reserved), rows: Number(r.rows[0]?.rows) };
}

const replyInvocations = (a: Tenant) => countRows(t,
  `SELECT count(*) AS n FROM ai_invocation WHERE tenant_id = $1 AND use_case_id = 'engagement.google.review.reply'`, [a.tenant]);

test('AC01: recibir reseñas (sync y worker) no consume cuota ni se limita por plan, aunque reviews_managed y la IA valgan 0', async () => {
  const a = await newTenant(0, 'client_cq1');
  const cases = await humanCases(a, 3);
  for (const c of cases) assert.equal(c.reply_invocation_id, null, 'recibir no redacta con IA');
  // Sync del backoffice (otra reseña nueva) con reviews_managed = 0: antes era 403 limit_exceeded.
  await injectReview(a, 'Excelente servicio, gracias', 5);
  const sync = await call(a.token, '/reputation/reviews/sync', 'POST');
  assert.equal(sync.status, 201, JSON.stringify(sync.body));
  assert.equal(sync.body.synced, 1);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM review WHERE tenant_id = $1', [a.tenant]), 4);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1', [a.tenant]), 0, 'ningún consumo de cuota');
  assert.equal(await replyInvocations(a), 0, 'ninguna invocación de IA de respuesta');

  const ent = (await call(a.token, '/subscriptions/entitlements')).body.entitlements as { parameters: Array<{ key: string; enforced: boolean; note: string | null; value: number; window: unknown }> };
  const reviews = ent.parameters.find((p) => p.key === 'quota.reviews_managed.max');
  assert.deepEqual([reviews?.enforced, typeof reviews?.note], [false, 'string'], 'reseñas: informativo, sin límite');
  const ai = ent.parameters.find((p) => p.key === 'quota.ai_review_replies.max');
  assert.equal(ai?.value, 0);
  assert.ok(ai?.window, 'la cuota de IA es periódica (ventana del ciclo)');
});

test('AC01: la recepción conserva su acceso — sin suscripción activa no se ingieren reseñas (403 subscription_required, nada insertado)', async () => {
  const a = await newTenant(5, 'client_cq2');
  await injectReview(a, 'Muy rico todo', 5);
  await t.pool.query(`UPDATE subscription SET status = 'suspended' WHERE tenant_id = $1`, [a.tenant]);
  const sync = await call(a.token, '/reputation/reviews/sync', 'POST');
  assert.deepEqual([sync.status, sync.body.error?.code], [403, 'subscription_required']);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM review WHERE tenant_id = $1', [a.tenant]), 0);
  assert.equal((await status(a)).subscription_active, false);
});

test('NFR-0001: un lote de reseñas cuya auditoría falla se revierte entero (sin estado parcial)', async () => {
  const a = await newTenant(0, 'client_cq3');
  await injectReview(a, 'Bien', 4);
  await injectReview(a, 'Muy bien', 5);
  const restore = await failAuditFor(t, a.tenant, 'reputation.review.ingested');
  try {
    const sync = await call(a.token, '/reputation/reviews/sync', 'POST');
    assert.ok(sync.status >= 500, `falla la sincronización (${sync.status})`);
  } finally {
    await restore();
  }
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM review WHERE tenant_id = $1', [a.tenant]), 0);
});

test('AC02/AC03/AC05: «Redactar con IA» consume exactamente 1 por caso; repetir no consume; agotada solo bloquea la IA (sin cargo) y lo manual sigue, también por Telegram', async () => {
  const a = await newTenant(2, 'client_cq4');
  const [c1, c2, c3, c4] = await humanCases(a, 4) as [CaseRow, CaseRow, CaseRow, CaseRow];
  const s0 = await status(a);
  assert.deepEqual([s0.available, s0.subscription_active, s0.limit, s0.usage, s0.remaining], [true, true, 2, 0, 2]);
  const anchor = (await t.pool.query<{ started_at: Date }>('SELECT started_at FROM subscription WHERE tenant_id = $1', [a.tenant])).rows[0]!.started_at;
  assert.equal(s0.window?.start, anchor.toISOString(), 'el ciclo empieza en la activación de la suscripción');

  const first = await aiDraft(a, c1.case_id);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const drafted = first.body.case as CaseRow;
  assert.ok(drafted.reply_invocation_id);
  assert.ok(drafted.ai_draft, 'la propuesta de IA queda aparte');
  assert.deepEqual(drafted.drafts, c1.drafts, 'las opciones numeradas (las del aviso de Telegram) no cambian');
  assert.equal(first.body.ai_replies.usage, 1);
  assert.deepEqual(await ledger(a), { committed: 1, reserved: 0, rows: 1 });
  const key = (await t.pool.query<{ idempotency_key: string; resource_ref: string }>(
    `SELECT idempotency_key, resource_ref FROM quota_reservation WHERE tenant_id = $1 AND capability = 'ai_review_replies'`, [a.tenant])).rows[0];
  assert.deepEqual([key?.idempotency_key, key?.resource_ref], [aiReplyQuotaKey(c1.case_id), `engagement_case/${c1.case_id}`]);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.ai_draft.generated' AND result = 'consumed:1'`, [a.tenant]), 1);

  // Replay: misma propuesta, sin consumo ni invocación nuevos.
  const again = await aiDraft(a, c1.case_id);
  assert.deepEqual([again.status, again.body.already_drafted], [200, true]);
  assert.equal(await replyInvocations(a), 1);
  assert.deepEqual(await ledger(a), { committed: 1, reserved: 0, rows: 1 });

  assert.equal((await aiDraft(a, c2.case_id)).status, 201);
  const denied = await aiDraft(a, c3.case_id);
  assert.deepEqual([denied.status, denied.body.error?.code], [403, 'limit_exceeded']);
  assert.match(denied.body.error.message, /Responder tú mismo no consume tu plan/);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.ai_reply' AND decision = 'deny' AND result = 'limit_exceeded'`, [a.tenant]), 1);
  assert.equal((await caseOf(a, c3.external_ref)).reply_invocation_id, null);
  assert.equal(await replyInvocations(a), 2, 'agotada: no se invoca a la IA');
  const s1 = await status(a);
  assert.deepEqual([s1.usage, s1.remaining], [2, 0]);

  // Lo manual sigue sin consumir: aprobar la propuesta de IA ya generada, escribir otra o decidir por Telegram.
  const approveAi = await call(a.token, `/engagement/cases/${c1.case_id}/approve`, 'POST', { text: drafted.ai_draft });
  assert.equal(approveAi.body.case.state, 'responded');
  const manual = await call(a.token, `/engagement/cases/${c3.case_id}/approve`, 'POST', { text: 'Gracias por tu visita, Ana. Tomamos nota para mejorar la espera.' });
  assert.equal(manual.body.case.state, 'responded');
  const hook = await linkTelegram(a);
  await run(a); // el chat recién vinculado recibe el aviso pendiente de c4
  assert.equal((await hook(`/aprobar ${lastNotice(hook.chat, c4.case_id).code} 1`)).body.handled, 'approved');
  assert.equal((await caseOf(a, c4.external_ref)).state, 'responded');
  assert.deepEqual(await ledger(a), { committed: 2, reserved: 0, rows: 2 }, 'ni aprobar ni responder a mano consumen');

  // Agotada la IA, las reseñas siguen entrando y esperan decisión.
  const ref = await injectReview(a, 'La comida bien, el servicio regular', 3);
  await run(a);
  assert.equal((await caseOf(a, ref)).state, 'needs_human');
  assert.deepEqual(await ledger(a), { committed: 2, reserved: 0, rows: 2 });
  // Sin cargo implícito: el plan sin precio sigue sin poder facturarse.
  assert.equal((await call(a.token, '/subscriptions/invoice', 'POST', {})).status, 403);
});

test('AC03: concurrencia — 8 peticiones simultáneas sobre 8 casos con límite 3 ⇒ exactamente 3 unidades; 6 sobre el mismo caso ⇒ 1', async () => {
  const a = await newTenant(3, 'client_cq5');
  const cases = await humanCases(a, 8);
  const results = await Promise.all(cases.map((c) => aiDraft(a, c.case_id)));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 201, 201, 403, 403, 403, 403, 403], JSON.stringify(results.map((r) => r.body.error?.code ?? r.status)));
  assert.ok(results.filter((r) => r.status === 403).every((r) => r.body.error.code === 'limit_exceeded'));
  assert.deepEqual(await ledger(a), { committed: 3, reserved: 0, rows: 3 });
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM engagement_case WHERE tenant_id = $1 AND reply_invocation_id IS NOT NULL', [a.tenant]), 3);

  const b = await newTenant(5, 'client_cq6');
  const [one] = await humanCases(b, 1) as [CaseRow];
  const same = await Promise.all(Array.from({ length: 6 }, () => aiDraft(b, one.case_id)));
  assert.equal(same.filter((r) => r.status === 201).length, 1, JSON.stringify(same.map((r) => [r.status, r.body.error?.code])));
  assert.ok(same.every((r) => r.status === 201 || (r.status === 200 && r.body.already_drafted) || (r.status === 409 && r.body.error.code === 'request_in_progress')));
  assert.deepEqual(await ledger(b), { committed: 1, reserved: 0, rows: 1 });
});

test('La propuesta con IA va aparte: el aviso numera solo las 3 opciones; editar una invalida el aviso anterior y /aprobar <código nuevo> 1 publica la opción 1 mostrada, nunca la propuesta de IA', async () => {
  const a = await newTenant(2, 'client_cqg');
  const hook = await linkTelegram(a);
  const [c] = await humanCases(a, 1) as [CaseRow];
  const notified = await countRows(t, `SELECT count(*) AS n FROM engagement_notification WHERE case_id = $1 AND status = 'sent'`, [c.case_id]);
  assert.equal(notified, 1, 'el aviso con las tres opciones numeradas ya salió');
  const shown = lastNotice(hook.chat, c.case_id);
  const drafted = await aiDraft(a, c.case_id);
  assert.equal(drafted.status, 201);
  const aiText = (drafted.body.case as CaseRow).ai_draft;
  assert.ok(aiText);
  assert.equal((drafted.body.case as CaseRow).drafts_revision, c.drafts_revision, 'la propuesta de IA no cambia las opciones numeradas del aviso');
  // Una edición de la opción 2 posterior a la redacción no toca la propuesta de IA (ni la cobrada vuelve a cobrarse).
  const edited = await call(a.token, `/engagement/cases/${c.case_id}/drafts/2`, 'POST', { text: 'Gracias por escribirnos; hoy mismo lo revisamos.' });
  assert.equal(edited.status, 200);
  assert.deepEqual([(edited.body.case as CaseRow).ai_draft, (edited.body.case as CaseRow).drafts[0]], [aiText, c.drafts[0]]);
  // SEC-TG-APPROVAL-01: el aviso anterior a la edición ya no publica nada; llega el aviso vigente con otro código.
  assert.equal((await hook(`/aprobar ${shown.code} 1`)).body.handled, 'approval_stale');
  assert.equal((await caseOf(a, c.external_ref)).state, 'needs_human');
  const fresh = lastNotice(hook.chat, c.case_id);
  assert.notEqual(fresh.code, shown.code);
  assert.ok(!fresh.text.includes(aiText), 'la propuesta de IA no aparece en el aviso numerado');
  // /aprobar <nuevo> 1 publica la opción 1 que mostró el aviso vigente, no la propuesta de IA.
  assert.equal((await hook(`/aprobar ${fresh.code} 1`)).body.handled, 'approved');
  const after = await caseOf(a, c.external_ref);
  assert.deepEqual([after.state, after.response_text], ['responded', c.drafts[0]]);
  assert.deepEqual(await ledger(a), { committed: 1, reserved: 0, rows: 1 });
});

test('AC04: ciclo mensual propio sin acumulación; el ancla y el uso sobreviven al cambio de plan; bajar el límite bloquea solo la IA', async () => {
  const a = await newTenant(2, 'client_cq7');
  const cases = await humanCases(a, 5);
  assert.equal((await aiDraft(a, cases[0]!.case_id)).status, 201);
  // El ciclo anterior: ancla 40 días atrás y la unidad consumida hace 35 días (fuera del ciclo vigente).
  await t.pool.query(`UPDATE subscription SET started_at = now() - interval '40 days' WHERE tenant_id = $1`, [a.tenant]);
  await t.pool.query(`UPDATE quota_reservation SET settled_at = now() - interval '35 days' WHERE tenant_id = $1 AND capability = 'ai_review_replies'`, [a.tenant]);
  const anchor = (await t.pool.query<{ started_at: Date }>('SELECT started_at FROM subscription WHERE tenant_id = $1', [a.tenant])).rows[0]!.started_at;
  const s = await status(a);
  const expectedStart = new Date(anchor);
  expectedStart.setUTCMonth(expectedStart.getUTCMonth() + 1);
  assert.equal(s.window?.start, expectedStart.toISOString(), 'ciclo vigente = ancla + 1 mes');
  assert.deepEqual([s.usage, s.remaining], [0, 2], 'lo no usado del ciclo anterior (1) no se acumula: quedan 2, no 3');
  // El caso que ya consumió no vuelve a consumir en el ciclo nuevo.
  assert.equal((await aiDraft(a, cases[0]!.case_id)).status, 200);
  assert.equal((await aiDraft(a, cases[1]!.case_id)).status, 201);

  // Cambio de plan (subir): mismo ancla, el uso del ciclo se conserva y el límite nuevo aplica de inmediato.
  const bigger = `plan_${randomUUID().slice(0, 8)}`;
  await createPublishedPlan(t.pool, bigger, { ai_review_replies: 3 });
  await setTenantPlan(t.pool, a.tenant, bigger);
  const after = (await t.pool.query<{ started_at: Date }>('SELECT started_at FROM subscription WHERE tenant_id = $1', [a.tenant])).rows[0]!.started_at;
  assert.equal(after.toISOString(), anchor.toISOString(), 'cambiar de plan no mueve el ancla');
  const up = await status(a);
  assert.deepEqual([up.limit, up.usage, up.remaining], [3, 1, 2], 'no se entrega la cuota completa como si no hubiera consumo');
  // Bajar a un límite por debajo del uso: solo se bloquea la IA.
  const smaller = `plan_${randomUUID().slice(0, 8)}`;
  await createPublishedPlan(t.pool, smaller, { ai_review_replies: 1 });
  await setTenantPlan(t.pool, a.tenant, smaller);
  assert.deepEqual([(await status(a)).remaining], [0]);
  assert.equal((await aiDraft(a, cases[2]!.case_id)).status, 403);
  const manual = await call(a.token, `/engagement/cases/${cases[2]!.case_id}/approve`, 'POST', { text: 'Gracias por tu reseña, la tomamos en cuenta.' });
  assert.equal(manual.body.case.state, 'responded');
});

test('Fail-closed: una revisión sin el parámetro (planes previos a 0036) no redacta con IA; sin suscripción activa tampoco', async () => {
  const a = await newTenant(5, 'client_cq8');
  const [c] = await humanCases(a, 1) as [CaseRow];
  // plan_piloto_1 sigue en su revisión 1 (backfill de 0034), anterior al registro 2: no define la cuota de IA.
  await setTenantPlan(t.pool, a.tenant, 'plan_piloto_1');
  const legacy = await status(a);
  assert.deepEqual([legacy.limit, legacy.remaining], [null, null]);
  const denied = await aiDraft(a, c.case_id);
  assert.deepEqual([denied.status, denied.body.error?.code], [403, 'limit_exceeded']);
  assert.match(denied.body.error.message, /no define/);

  const b = await newTenant(5, 'client_cq9');
  const [cb] = await humanCases(b, 1) as [CaseRow];
  await t.pool.query(`UPDATE subscription SET status = 'suspended' WHERE tenant_id = $1`, [b.tenant]);
  const inactive = await aiDraft(b, cb.case_id);
  assert.deepEqual([inactive.status, inactive.body.error?.code], [403, 'subscription_required']);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = ANY($1)`, [[a.tenant, b.tenant]]), 0);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM ai_invocation WHERE tenant_id = ANY($1) AND use_case_id = 'engagement.google.review.reply'`, [[a.tenant, b.tenant]]), 0);
});

test('Multi-tenant: el caso de otro negocio responde 404 idéntico y nada se consume; el uso de uno no cambia el del otro', async () => {
  const a = await newTenant(1, 'client_cqa');
  const b = await newTenant(1, 'client_cqb');
  const [ca] = await humanCases(a, 1) as [CaseRow];
  const foreign = await aiDraft(b, ca.case_id);
  const missing = await aiDraft(b, `case_${randomUUID().replaceAll('-', '')}`);
  assert.deepEqual([foreign.status, foreign.body], [missing.status, missing.body], 'anti-oracle');
  assert.equal(foreign.status, 404);
  assert.equal((await aiDraft(a, ca.case_id)).status, 201);
  assert.deepEqual([(await status(a)).remaining, (await status(b)).remaining], [0, 1]);
  assert.deepEqual(await ledger(b), { committed: 0, reserved: 0, rows: 0 });
});

test('Fallo de la IA: 502 sin consumo (reserva liberada); el siguiente intento usa otra clave y consume 1', async () => {
  const a = await newTenant(1, 'client_cqc');
  const [c] = await humanCases(a, 1) as [CaseRow];
  await t.pool.query(`UPDATE ai_provider SET status = 'disabled' WHERE kind = 'simulated'`);
  let failed;
  try {
    failed = await aiDraft(a, c.case_id);
  } finally {
    await t.pool.query(`UPDATE ai_provider SET status = 'active' WHERE kind = 'simulated'`);
  }
  assert.equal(failed.status, 502, JSON.stringify(failed.body));
  assert.match(failed.body.error.message, /No se descontó/);
  assert.deepEqual(await ledger(a), { committed: 0, reserved: 0, rows: 1 });
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1 AND state = 'released'`, [a.tenant]), 1);
  assert.equal((await status(a)).remaining, 1);
  const retry = await aiDraft(a, c.case_id);
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
  assert.deepEqual(await ledger(a), { committed: 1, reserved: 0, rows: 1 });
});

/**
 * Lectura fija (gratitud, sin riesgos) y redacción determinista contadas: el Jev simulado del entorno `test` marca
 * riesgos en todo texto, así que la respuesta automática solo se alcanza con un lector controlado. El libro de
 * cuotas, la BD y el resto del servicio son los reales.
 */
function stubSemantics(fail = false): EngagementSemantics & { replies: number } {
  const stub = {
    replies: 0,
    async read() {
      return { ok: true as const, invocationId: `inv_stub_${randomUUID()}`, reading: {},
        classification: { category: 'gratitude' as const, risk_flags: [], confidence: 0.95, sentiment: 'positive' as const, info_topic: null } };
    },
    async replyAvailable() { return true; },
    async reply(row: CaseRow): Promise<ReplyOutcome> {
      stub.replies += 1;
      return fail ? { ok: false, code: 'provider_unavailable', reason: null }
        : { ok: true, text: `¡Gracias, ${row.author_label}! Te esperamos pronto.`, needsHuman: false, invocationId: `inv_stub_${randomUUID()}` };
    },
  };
  return stub;
}

async function receivedCase(service: EngagementService, tenant: string): Promise<CaseRow> {
  const id = `case_${randomUUID().replaceAll('-', '')}`;
  await t.pool.query(`INSERT INTO engagement_case (case_id, tenant_id, origin, external_ref, author_label, body, rating, state)
    VALUES ($1, $2, 'google_review', $3, 'Ana', '¡Gracias, todo excelente!', 5, 'received')`, [id, tenant, `g-${randomUUID().slice(0, 8)}`]);
  const row = await service.getCase(tenant, id);
  assert.ok(row);
  return row;
}

test('Respuesta automática autorizada: la redactada con IA consume 1 con el caso; agotada, sale el texto seguro sin IA, sin invocar ni cobrar', async () => {
  const a = await newTenant(1, 'client_cqd');
  assert.equal((await call(a.token, '/engagement/policies', 'PUT', { origin: 'google_review', category: 'gratitude', mode: 'safe_auto_reply', consent: true, consent_version: AUTO_REPLY_CONSENT.google_review.version })).status, 200);
  const stub = stubSemantics();
  const service = new EngagementService({ ...t.handle.engagement.deps, semantics: stub });

  const c1 = await service.classifyCase(await receivedCase(service, a.tenant));
  assert.deepEqual([c1?.state, c1?.decision], ['classified', 'auto_reply'], `${c1?.decision}:${c1?.reason}`);
  assert.ok(c1?.reply_invocation_id, 'redactada con IA');
  assert.match(c1?.response_text ?? '', /Respuesta automática generada con IA\.$/);
  assert.deepEqual(await ledger(a), { committed: 1, reserved: 0, rows: 1 });
  assert.equal((await service.respondCase(c1!.case_id))?.state, 'responded');

  const c2 = await service.classifyCase(await receivedCase(service, a.tenant));
  assert.deepEqual([c2?.state, c2?.decision, c2?.reply_invocation_id], ['classified', 'auto_reply', null], 'sin cuota: respuesta segura sin IA');
  assert.doesNotMatch(c2?.response_text ?? '', /generada con IA/);
  assert.equal(stub.replies, 1, 'agotada: no se invoca a la IA');
  assert.deepEqual(await ledger(a), { committed: 1, reserved: 0, rows: 1 });
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.ai_reply' AND decision = 'deny'`, [a.tenant]), 1);
});

test('Respuesta automática: dos clasificaciones simultáneas del mismo caso consumen como máximo 1; si la IA falla, se libera y sale el texto seguro', async () => {
  const a = await newTenant(5, 'client_cqf');
  assert.equal((await call(a.token, '/engagement/policies', 'PUT', { origin: 'google_review', category: 'gratitude', mode: 'safe_auto_reply', consent: true, consent_version: AUTO_REPLY_CONSENT.google_review.version })).status, 200);
  const service = new EngagementService({ ...t.handle.engagement.deps, semantics: stubSemantics() });
  const row = await receivedCase(service, a.tenant);
  const outcomes = await Promise.all([service.classifyCase(row), service.classifyCase(row), service.classifyCase(row)]);
  assert.equal(outcomes.filter((o) => o !== null).length, 1, 'un solo ganador');
  // Gane la redacción con IA o el texto seguro, nunca más de 1 unidad y solo si el caso guardó la respuesta de IA.
  const winner = await service.getCase(a.tenant, row.case_id);
  const used = winner?.reply_invocation_id ? 1 : 0;
  const l0 = await ledger(a);
  assert.deepEqual([l0.committed, l0.reserved], [used, 0]);
  assert.ok(l0.rows <= 1, 'una sola fila del libro para el caso');

  const failing = new EngagementService({ ...t.handle.engagement.deps, semantics: stubSemantics(true) });
  const c = await failing.classifyCase(await receivedCase(failing, a.tenant));
  assert.deepEqual([c?.decision, c?.reply_invocation_id], ['auto_reply', null]);
  const l = await ledger(a);
  assert.deepEqual([l.committed, l.reserved], [used, 0], 'el fallo de la IA no consume');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1 AND capability = 'ai_review_replies' AND state = 'released'`, [a.tenant]),
    l0.rows - used + 1, 'la reserva del intento fallido queda liberada');
});

test('Fuera de la cuota de reseñas (DEC-0077 R4, DEC-0078 R5): la IA de un comentario de Facebook usa su propio medidor y nunca ai_review_replies', async () => {
  // Cuota de reseñas en 0 y medidor de Facebook con 1: pedir la sugerencia gasta solo el medidor de Facebook.
  const a = await newTenant(0, 'client_cqe', { ai_facebook_suggestions: 1 });
  const post = `post_${randomUUID().slice(0, 8)}`;
  await t.pool.query(`INSERT INTO social_post (post_id, tenant_id, network, content_type, text, status, published_at, external_ref, created_by)
    VALUES ($1,$2,'facebook','post','Pan de muerto','published',now(),$3,'fixture')`, [post, a.tenant, `sim:fb:post:${post}`]);
  const ref = `c-${randomUUID().slice(0, 6)}`;
  assert.equal((await call(a.token, '/dev/simulator/facebook-comments', 'POST', { post_id: post, body: 'Me encantó, ¿tienen de chocolate?', author_label: 'Luis R.', external_ref: ref })).status, 201);
  await run(a);
  const c = await caseOf(a, ref);
  assert.equal(c.reply_invocation_id, null, 'DEC-0078 R1: sin configuración (bajo demanda) llegar no redacta con IA');
  const drafted = await aiDraft(a, c.case_id);
  assert.equal(drafted.status, 201, JSON.stringify(drafted.body));
  assert.ok(drafted.body.case.ai_draft);
  assert.deepEqual([drafted.body.ai_suggestions.usage, drafted.body.ai_suggestions.limit], [1, 1]);
  assert.deepEqual(await ledger(a), { committed: 0, reserved: 0, rows: 0 }, 'la cuota de reseñas no se toca');
});
