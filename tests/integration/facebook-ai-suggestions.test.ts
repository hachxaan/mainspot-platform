/**
 * DEC-0078 (SRC-0018 = SRC-007 del propietario) — IA de comentarios de Facebook, de punta a punta con la BD real:
 *  - FB-1: modo de SUGERENCIAS por negocio (off · on_demand predeterminado · auto_suggest con opt-in informado), que nunca
 *    autoriza publicar; la publicación automática sigue siendo la política `safe_auto_reply` con su consentimiento;
 *  - FB-2: no se redacta para publicar si la respuesta automática ya no puede publicarse (máximo por hora, elegibilidad);
 *    la sugerencia automática para revisión sí puede prepararse dentro de su medidor y nunca publica;
 *  - medidor propio `ai_facebook_suggestions` (fail-closed sin valor en el plan), 1 unidad por comentario entre todos los
 *    caminos, sin doble cobro por replays, carreras, ambos flujos o cambios de modo; aislamiento por negocio.
 * La lectura y la redacción son un `EngagementSemantics` controlado (cuenta invocaciones); libro de cuotas, políticas,
 * consentimientos y BD son los reales. AC del handoff: AC-FB01…AC-FB06 (FR-0016 AC-16012…AC-16016, BR-0007, FR-0010).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApi, authHeaders, api, login, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows, type TestTenant as Tenant } from '../helpers/tenants.ts';
import { setTenantPlan } from '../helpers/plans.ts';
import { AI_REPLY_DISCLOSURE, EngagementService, type Actor, type CaseRow } from '../../src/engagement/service.ts';
import type { EngagementSemantics, ReplyOutcome } from '../../src/engagement/ai-semantics.ts';
import type { Classification } from '../../src/engagement/classifier.ts';
import { AUTO_REPLY_CONSENT, AUTO_SUGGEST_CONSENT, consentSha256 } from '../../src/engagement/consent.ts';
import { AppError } from '../../src/shared/errors.ts';

let t: TestApi;

before(async () => {
  t = await bootApi({ aiEnvironment: 'test' });
});

after(async () => {
  await t.close();
});

const FB_TERMS = AUTO_REPLY_CONSENT.facebook_comment;
const SUGGEST_TERMS = AUTO_SUGGEST_CONSENT.facebook_comment;

const call = (token: string, path: string, method = 'GET', body?: unknown) =>
  api(t.baseUrl, `/api/backoffice${path}`, { method, headers: authHeaders(token), body: body === undefined ? undefined : JSON.stringify(body) });

/** Negocio con plan publicado; `credits` = valor de `quota.ai_facebook_suggestions.max` (0 = definido sin unidades). */
async function newTenant(prefix: string, credits: number): Promise<Tenant> {
  return createTenantWithPlan(t, { reviews_managed: 0, ai_review_replies: 5, ai_facebook_suggestions: credits }, prefix);
}

const actorOf = (a: Tenant): Actor => ({ tenantId: a.tenant, userId: a.userId, role: 'administration', requestId: `req_${randomUUID()}` });

const GRATITUDE: Classification = { category: 'gratitude', risk_flags: [], confidence: 0.95, sentiment: 'positive', info_topic: null };

/** Lectura fija y redacción determinista contada; `during` corre mientras «redacta». */
function stubSemantics(opts: { during?: () => Promise<void>; needsHuman?: boolean; classification?: Classification } = {}): EngagementSemantics & { replies: number } {
  const stub = {
    replies: 0,
    async read() {
      return { ok: true as const, invocationId: `inv_stub_${randomUUID()}`, reading: {}, classification: opts.classification ?? GRATITUDE };
    },
    async replyAvailable() { return true; },
    async reply(row: CaseRow): Promise<ReplyOutcome> {
      stub.replies += 1;
      if (opts.during) await opts.during();
      return { ok: true, text: `¡Gracias, ${row.author_label}! Te esperamos pronto en el café.`, needsHuman: opts.needsHuman ?? false, invocationId: `inv_stub_${randomUUID()}` };
    },
  };
  return stub;
}

const serviceWith = (semantics: EngagementSemantics) => new EngagementService({ ...t.handle.engagement.deps, semantics });

async function publishedPost(a: Tenant): Promise<string> {
  const post = `post_${randomUUID().slice(0, 8)}`;
  await t.pool.query(`INSERT INTO social_post (post_id, tenant_id, network, content_type, text, status, published_at, external_ref, created_by)
    VALUES ($1,$2,'facebook','post','Pan de muerto recién hecho','published',now(),$3,'fixture')`, [post, a.tenant, `sim:fb:post:${post}`]);
  return post;
}

/** Comentario recibido (antes de clasificar), como lo deja la ingesta del worker. */
async function receivedComment(service: EngagementService, a: Tenant, body = '¡Gracias, todo excelente!', postId: string | null = null, author = 'Ana'): Promise<CaseRow> {
  const id = `case_${randomUUID().replaceAll('-', '')}`;
  await t.pool.query(`INSERT INTO engagement_case (case_id, tenant_id, origin, external_ref, post_id, author_label, body, state)
    VALUES ($1, $2, 'facebook_comment', $3, $4, $5, $6, 'received')`, [id, a.tenant, `fbc-${randomUUID().slice(0, 8)}`, postId, author, body]);
  const row = await service.getCase(a.tenant, id);
  assert.ok(row);
  return row;
}

/** Unidades confirmadas, reservas vivas y filas del medidor de Facebook (y de la cuota de Google, que nunca se toca). */
async function credits(a: Tenant): Promise<{ committed: number; reserved: number; google: number }> {
  const r = await t.pool.query<{ committed: string; reserved: string; google: string }>(
    `SELECT COALESCE(SUM(units) FILTER (WHERE capability = 'ai_facebook_suggestions' AND state = 'committed'), 0) AS committed,
            count(*) FILTER (WHERE capability = 'ai_facebook_suggestions' AND state = 'reserved') AS reserved,
            count(*) FILTER (WHERE capability = 'ai_review_replies') AS google
       FROM quota_reservation WHERE tenant_id = $1`, [a.tenant]);
  return { committed: Number(r.rows[0]?.committed), reserved: Number(r.rows[0]?.reserved), google: Number(r.rows[0]?.google) };
}

const setMode = (a: Tenant, mode: string, consent = mode === 'auto_suggest') =>
  call(a.token, '/engagement/suggestions', 'PUT', consent ? { origin: 'facebook_comment', mode, consent: true, consent_version: SUGGEST_TERMS.version } : { origin: 'facebook_comment', mode });

async function facebookAutoPolicy(a: Tenant, max = 10): Promise<string> {
  const r = await call(a.token, '/engagement/policies', 'PUT',
    { origin: 'facebook_comment', category: 'gratitude', mode: 'safe_auto_reply', max_auto_replies_per_hour: max, consent: true, consent_version: FB_TERMS.version });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.policy.policy_id as string;
}

const simReplies = (a: Tenant) => countRows(t, 'SELECT count(*) AS n FROM sim_provider_reply WHERE tenant_id = $1', [a.tenant]);

const aiAudits = async (a: Tenant, caseId: string) => (await t.pool.query<{ decision: string; result: string }>(
  `SELECT decision, result FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.ai_reply' AND resource = $2 ORDER BY ts, event_id`,
  [a.tenant, `engagement_case/${caseId}`])).rows;

test('AC-FB02/AC-16013: sin configuración el modo es «bajo demanda»; llegar no redacta y la petición expresa genera una propuesta (1 unidad, sin la cuota de Google)', async () => {
  const a = await newTenant('client_fbs1', 3);
  const view = await call(a.token, '/engagement/suggestions');
  assert.equal(view.status, 200);
  const s = view.body.ai_suggestions;
  assert.deepEqual([s.setting.mode, s.setting.default, s.credits_defined, s.limit, s.usage], ['on_demand', true, true, 3, 0]);
  assert.deepEqual(view.body.terms.facebook_comment, { version: SUGGEST_TERMS.version, text: SUGGEST_TERMS.text }, 'el panel recibe el texto literal antes de activar');

  const stub = stubSemantics();
  const service = serviceWith(stub);
  const c = await service.classifyCase(await receivedComment(service, a));
  assert.deepEqual([c?.state, c?.decision, c?.reply_invocation_id, c?.ai_draft], ['needs_human', 'human_review', null, null]);
  assert.equal(stub.replies, 0, 'recibir no invoca IA generativa');
  assert.equal(c?.drafts.length, 3, 'propuestas sin IA para responder a mano');

  const first = await service.requestAiDraft(actorOf(a), c!.case_id);
  assert.equal(first.already, false);
  assert.ok(first.case.ai_draft && first.case.reply_invocation_id, 'la propuesta pedida queda aparte de las numeradas');
  assert.deepEqual(first.case.drafts, c?.drafts, 'pedir la propuesta no reordena las opciones del aviso');
  const again = await service.requestAiDraft(actorOf(a), c!.case_id);
  assert.equal(again.already, true);
  assert.equal(stub.replies, 1, 'repetir no vuelve a redactar');
  assert.deepEqual(await credits(a), { committed: 1, reserved: 0, google: 0 }, 'una unidad del medidor de Facebook; la cuota de Google intacta');
  const after = (await call(a.token, '/engagement/suggestions')).body.ai_suggestions;
  assert.deepEqual([after.usage, after.remaining], [1, 2]);
});

test('AC-FB01/AC-16012: modo «desactivada» ⇒ cero redacciones automáticas o a pedido; recibir y responder a mano funcionan sin consumo', async () => {
  const a = await newTenant('client_fbs2', 3);
  assert.equal((await setMode(a, 'off')).status, 200);
  const stub = stubSemantics();
  const service = serviceWith(stub);
  const c = await service.classifyCase(await receivedComment(service, a));
  assert.deepEqual([c?.state, c?.reply_invocation_id, stub.replies], ['needs_human', null, 0]);
  await assert.rejects(service.requestAiDraft(actorOf(a), c!.case_id), (err: unknown) => err instanceof AppError && err.status === 409 && /desactivadas/.test(err.userMessage));
  assert.equal(stub.replies, 0);
  const approved = await call(a.token, `/engagement/cases/${c!.case_id}/approve`, 'POST', { text: 'Gracias, Ana. ¡Te esperamos!' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.case.state, 'responded', 'la respuesta manual se publica');
  assert.deepEqual(await credits(a), { committed: 0, reserved: 0, google: 0 });
});

test('AC-FB03/AC-16014 + AC-FB04: las automáticas exigen términos vigentes y medidor definido; preparan la sugerencia para revisar y nunca publican', async () => {
  const a = await newTenant('client_fbs3', 2);
  const noConsent = await call(a.token, '/engagement/suggestions', 'PUT', { origin: 'facebook_comment', mode: 'auto_suggest' });
  assert.equal(noConsent.status, 400, 'sin aceptación expresa no se activa');
  const stale = await call(a.token, '/engagement/suggestions', 'PUT', { origin: 'facebook_comment', mode: 'auto_suggest', consent: true, consent_version: 'ai_suggestions.facebook_comment.v0' });
  assert.equal(stale.status, 409, 'una versión distinta de la mostrada no vale');
  const ok = await setMode(a, 'auto_suggest');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.ai_suggestions.setting.mode, ok.body.ai_suggestions.setting.consent_current], ['auto_suggest', true]);
  const row = (await t.pool.query('SELECT consent_text, consent_version, consent_sha256, decided_by FROM engagement_suggestion_setting WHERE tenant_id = $1', [a.tenant])).rows;
  assert.deepEqual(row, [{ consent_text: SUGGEST_TERMS.text, consent_version: SUGGEST_TERMS.version, consent_sha256: SUGGEST_TERMS.sha256, decided_by: a.userId }]);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.suggestions.changed'`, [a.tenant]), 1);
  assert.equal((await setMode(a, 'auto_suggest')).status, 200);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM engagement_suggestion_setting WHERE tenant_id = $1', [a.tenant]), 1, 'repetir el modo vigente no crea versión');

  const stub = stubSemantics();
  const service = serviceWith(stub);
  const c = await service.classifyCase(await receivedComment(service, a));
  assert.deepEqual([c?.state, c?.decision, stub.replies], ['needs_human', 'human_review', 1], 'sugerencia preparada sin pulsar nada');
  assert.equal(c?.drafts[0], c?.ai_draft, 'la sugerencia es la opción 1 del aviso y queda identificada');
  assert.ok(c?.reply_invocation_id);
  assert.equal(await simReplies(a), 0, 'preparar no publica');
  assert.deepEqual(await credits(a), { committed: 1, reserved: 0, google: 0 });

  // Sin unidades: la siguiente no se prepara (denegación auditada), el caso queda para revisión con propuestas sin IA.
  await service.classifyCase(await receivedComment(service, a, 'Muy buen pan, gracias'));
  const third = await service.classifyCase(await receivedComment(service, a, 'Me encantó la concha'));
  assert.deepEqual([third?.state, third?.reply_invocation_id, stub.replies], ['needs_human', null, 2]);
  assert.deepEqual((await aiAudits(a, third!.case_id)).map((r) => [r.decision, r.result]), [['deny', 'limit_exceeded']]);
  assert.deepEqual(await credits(a), { committed: 2, reserved: 0, google: 0 });

  // Apagar siempre se puede y deja de preparar.
  assert.equal((await setMode(a, 'off')).status, 200);
  const off = await service.classifyCase(await receivedComment(service, a, 'Gracias por todo'));
  assert.deepEqual([off?.reply_invocation_id, stub.replies], [null, 2]);
});

test('AC-FB04: sin valor del medidor en el plan (revisión anterior a 0038) no hay IA de pago ni automáticas, con explicación y sin consumo ilimitado', async () => {
  const a = await newTenant('client_fbs4', 0);
  const zero = await setMode(a, 'auto_suggest');
  assert.equal(zero.status, 409, 'medidor en 0: no hay costo que aceptar');
  assert.match(zero.body.error.message, /todavía no incluye sugerencias con IA/);
  await setTenantPlan(t.pool, a.tenant, 'plan_piloto_1');
  const view = (await call(a.token, '/engagement/suggestions')).body.ai_suggestions;
  assert.deepEqual([view.credits_defined, view.limit, view.remaining], [false, null, null], 'el plan no define el medidor');
  assert.equal((await setMode(a, 'auto_suggest')).status, 409);
  const stub = stubSemantics();
  const service = serviceWith(stub);
  const c = await service.classifyCase(await receivedComment(service, a));
  await assert.rejects(service.requestAiDraft(actorOf(a), c!.case_id), (err: unknown) => {
    assert.ok(err instanceof AppError);
    assert.equal(err.status, 403);
    assert.match(err.userMessage, /no define «Sugerencias con IA para comentarios de Facebook»/);
    assert.doesNotMatch(err.userMessage, /ilimitad/i);
    return true;
  });
  assert.equal(stub.replies, 0, 'fail-closed antes de invocar la IA');
  assert.deepEqual(await credits(a), { committed: 0, reserved: 0, google: 0 });
});

test('AC-FB06/AC-16016 (FB-2): con el máximo por hora alcanzado no se redacta para publicar; con automáticas vigentes hay sugerencia revisable que no se publica', async () => {
  const a = await newTenant('client_fbs5', 5);
  await facebookAutoPolicy(a, 1);
  const stub = stubSemantics();
  const service = serviceWith(stub);
  const first = await service.classifyCase(await receivedComment(service, a));
  assert.deepEqual([first?.decision, stub.replies], ['auto_reply', 1], 'con espacio en la hora se redacta para publicar');
  assert.ok(first?.response_text?.endsWith(AI_REPLY_DISCLOSURE));
  assert.equal((await service.respondCase(first!.case_id))?.state, 'responded');

  const limited = await service.classifyCase(await receivedComment(service, a, 'Gracias de nuevo'));
  assert.deepEqual([limited?.decision, limited?.reason, limited?.reply_invocation_id, stub.replies], ['human_review', 'rate_limited', null, 1],
    'sin espacio para publicar no se gasta en redactar');
  assert.deepEqual(await credits(a), { committed: 1, reserved: 0, google: 0 });

  assert.equal((await setMode(a, 'auto_suggest')).status, 200);
  const suggested = await service.classifyCase(await receivedComment(service, a, 'Qué rico todo'));
  assert.deepEqual([suggested?.state, suggested?.reason, stub.replies], ['needs_human', 'rate_limited', 2], 'la sugerencia para revisar sí se prepara');
  assert.ok(suggested?.ai_draft);
  assert.equal(await simReplies(a), 1, 'solo la primera se publicó; la sugerencia espera aprobación');
  assert.deepEqual(await credits(a), { committed: 2, reserved: 0, google: 0 });
});

test('AC-FB05/AC-16015: ambos flujos autorizados ⇒ una sola redacción y una unidad por comentario, también si la IA pide revisión', async () => {
  const a = await newTenant('client_fbs6', 5);
  await facebookAutoPolicy(a);
  assert.equal((await setMode(a, 'auto_suggest')).status, 200);
  const humanStub = stubSemantics({ needsHuman: true });
  const service = serviceWith(humanStub);
  const c = await service.classifyCase(await receivedComment(service, a));
  assert.deepEqual([c?.state, c?.reason, humanStub.replies], ['needs_human', 'reply_needs_human', 1]);
  assert.equal(c?.drafts[0], c?.ai_draft, 'el texto redactado para publicar queda como sugerencia, sin redactar otra');
  assert.equal(await simReplies(a), 0);
  assert.deepEqual(await credits(a), { committed: 1, reserved: 0, google: 0 });
  // Pedirla después no redacta ni cobra otra vez.
  const again = await service.requestAiDraft(actorOf(a), c!.case_id);
  assert.deepEqual([again.already, humanStub.replies], [true, 1]);

  // Sin sugerencias automáticas, la redacción que pide revisión se descarta y su unidad se libera (DEC-0077 R2).
  const b = await newTenant('client_fbs6b', 5);
  await facebookAutoPolicy(b);
  const svcB = serviceWith(stubSemantics({ needsHuman: true }));
  const cb = await svcB.classifyCase(await receivedComment(svcB, b));
  assert.deepEqual([cb?.reason, cb?.reply_invocation_id, cb?.ai_draft], ['reply_needs_human', null, null]);
  assert.deepEqual(await credits(b), { committed: 0, reserved: 0, google: 0 });
});

test('AC-FB05: replay del proveedor, peticiones simultáneas y cambio de modo durante la redacción no duplican ni cobran dos veces', async () => {
  const a = await newTenant('client_fbs7', 5);
  // Replay de la ingesta: el mismo comentario (misma referencia externa) no crea otro caso.
  const post = await publishedPost(a);
  for (let i = 0; i < 2; i += 1) {
    const r = await call(a.token, '/dev/simulator/facebook-comments', 'POST', { post_id: post, body: '¿Abren el domingo?', author_label: 'Luis', external_ref: 'fbc-replay-1' });
    assert.equal(r.status, 201);
  }
  await call(a.token, '/engagement/run', 'POST');
  await call(a.token, '/engagement/run', 'POST');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM engagement_case WHERE tenant_id = $1 AND external_ref = 'fbc-replay-1'`, [a.tenant]), 1);

  // Dos «Sugerir con IA» simultáneos sobre el mismo comentario: una redacción, una unidad.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = stubSemantics({ during: () => gate });
  const service = serviceWith(slow);
  const c = await serviceWith(stubSemantics()).classifyCase(await receivedComment(service, a));
  const both = Promise.allSettled([service.requestAiDraft(actorOf(a), c!.case_id), service.requestAiDraft(actorOf(a), c!.case_id)]);
  await new Promise((r) => setTimeout(r, 150));
  release();
  const settled = await both;
  assert.equal(slow.replies, 1, 'la segunda petición no redacta');
  assert.ok(settled.some((s) => s.status === 'fulfilled' && !s.value.already));
  assert.ok(settled.every((s) => s.status === 'fulfilled' || (s.reason instanceof AppError && s.reason.status === 409)));
  assert.deepEqual(await credits(a), { committed: 1, reserved: 0, google: 0 });

  // Apagar mientras se prepara la sugerencia automática: no queda sugerencia ni unidad y el caso se reclasifica.
  assert.equal((await setMode(a, 'auto_suggest')).status, 200);
  const switching = stubSemantics({ during: async () => { assert.equal((await setMode(a, 'off')).status, 200); } });
  const svc2 = serviceWith(switching);
  const pending = await receivedComment(svc2, a, 'Excelente atención');
  assert.equal(await svc2.classifyCase(pending), null, 'el cambio de modo invalida la clasificación en curso');
  assert.deepEqual([(await svc2.getCase(a.tenant, pending.case_id))?.state, switching.replies], ['received', 1]);
  assert.deepEqual(await credits(a), { committed: 1, reserved: 0, google: 0 }, 'la reserva se liberó');
  const retried = await svc2.classifyCase((await svc2.getCase(a.tenant, pending.case_id))!);
  assert.deepEqual([retried?.state, retried?.reply_invocation_id, switching.replies], ['needs_human', null, 1], 'con el modo nuevo no se prepara');
});

test('AC-FB05: si la redacción automática falla con una excepción, la unidad se libera al momento y el reintento del caso prepara la sugerencia', async () => {
  const a = await newTenant('client_fbs12', 3);
  assert.equal((await setMode(a, 'auto_suggest')).status, 200);
  const failing: EngagementSemantics = { ...stubSemantics(), async reply(): Promise<ReplyOutcome> { throw new Error('fallo inesperado de la redacción'); } };
  const broken = serviceWith(failing);
  const row = await receivedComment(broken, a);
  await assert.rejects(broken.classifyCase(row), /fallo inesperado de la redacción/);
  assert.deepEqual(await credits(a), { committed: 0, reserved: 0, google: 0 }, 'ninguna unidad queda reservada hasta su vencimiento');
  const still = await broken.getCase(a.tenant, row.case_id);
  assert.equal(still?.state, 'received', 'el caso sigue pendiente de clasificar');
  const stub = stubSemantics();
  const retried = await serviceWith(stub).classifyCase(still!);
  assert.deepEqual([retried?.state, stub.replies, retried?.drafts[0] === retried?.ai_draft], ['needs_human', 1, true], 'el reintento prepara la sugerencia');
  assert.deepEqual(await credits(a), { committed: 1, reserved: 0, google: 0 });
});

test('FB-2: sin texto, solo menciones, con enlaces o repetido no se gasta IA automática; pedirla a mano sigue disponible', async () => {
  const a = await newTenant('client_fbs8', 10);
  assert.equal((await setMode(a, 'auto_suggest')).status, 200);
  const stub = stubSemantics();
  const service = serviceWith(stub);
  const post = await publishedPost(a);
  const cases: Record<string, CaseRow | null> = {};
  for (const [key, body] of [['emoji', '😍🔥🙌'], ['mentions', '@ana_lopez @luis.p'], ['link', 'Gana dinero aquí https://spam.example/x'],
    ['first', 'Excelente   servicio'], ['dup', 'excelente servicio']] as const) {
    cases[key] = await service.classifyCase(await receivedComment(service, a, body, post, key === 'dup' ? 'Otra persona' : 'Ana'));
  }
  assert.equal(stub.replies, 1, 'solo el primer comentario con texto propio se redacta');
  assert.ok(cases['first']?.ai_draft);
  for (const [key, reason] of [['emoji', 'no_text'], ['mentions', 'mention_only'], ['link', 'link'], ['dup', 'duplicate']] as const) {
    assert.deepEqual((await aiAudits(a, cases[key]!.case_id)).map((r) => [r.decision, r.result]), [['deny', `not_relevant:${reason}`]], key);
    assert.equal(cases[key]?.state, 'needs_human', `${key}: queda para revisión con propuestas sin IA`);
  }
  assert.deepEqual(await credits(a), { committed: 1, reserved: 0, google: 0 });
  const manual = await service.requestAiDraft(actorOf(a), cases['dup']!.case_id);
  assert.equal(manual.already, false, 'una persona puede pedirla aunque sea repetido');
  assert.deepEqual(await credits(a), { committed: 2, reserved: 0, google: 0 });
});

test('SEC-CONSENT-01 (DEC-0078 R6): respuestas automáticas de Facebook con consentimiento anterior al medidor salen sin IA hasta reconsentir', async () => {
  const a = await newTenant('client_fbs9', 5);
  const v2 = 'Autorizo a MainSpot a responder públicamente en mi nombre los comentarios de Facebook de esta categoría (texto v2).';
  const policy = `pol_${randomUUID()}`;
  await t.pool.query(
    `INSERT INTO engagement_policy (policy_id, tenant_id, origin, category, mode, version, max_auto_replies_per_hour, consent_text, consent_version, consent_sha256, decided_by)
     VALUES ($1,$2,'facebook_comment','gratitude','safe_auto_reply',1,10,$3,'auto_reply.facebook_comment.v2',$4,$5)`, [policy, a.tenant, v2, consentSha256(v2), a.userId]);
  const view = await call(a.token, '/engagement/policies');
  assert.equal(view.body.reconsent_required, true, 'el panel pide aceptar las condiciones nuevas');
  const stub = stubSemantics();
  const service = serviceWith(stub);
  const c = await service.classifyCase(await receivedComment(service, a));
  assert.deepEqual([c?.decision, c?.reply_invocation_id, stub.replies], ['auto_reply', null, 0], 'texto seguro sin IA: la política no se cambió sola');
  assert.doesNotMatch(c?.response_text ?? '', /generada con IA/);
  assert.deepEqual((await aiAudits(a, c!.case_id)).map((r) => [r.decision, r.result]), [['deny', 'consent_outdated']]);
  assert.deepEqual(await credits(a), { committed: 0, reserved: 0, google: 0 });

  const accepted = await call(a.token, '/engagement/policies/consent', 'POST', { consent: true, consent_version: FB_TERMS.version });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.updated, 1);
  assert.equal(accepted.body.reconsent_required, false);
  const next = await service.classifyCase(await receivedComment(service, a, 'Gracias, muy rico'));
  assert.deepEqual([next?.decision, Boolean(next?.reply_invocation_id), stub.replies], ['auto_reply', true, 1]);
  assert.deepEqual(await credits(a), { committed: 1, reserved: 0, google: 0 });
});

test('Aislamiento: el modo, el medidor y los casos de un negocio no se ven ni se usan desde otro', async () => {
  const a = await newTenant('client_fbs10a', 2);
  const b = await newTenant('client_fbs10b', 2);
  assert.equal((await setMode(a, 'off')).status, 200);
  assert.equal((await call(b.token, '/engagement/suggestions')).body.ai_suggestions.setting.mode, 'on_demand', 'el modo de A no afecta a B');
  const service = serviceWith(stubSemantics());
  const c = await service.classifyCase(await receivedComment(service, a));
  const foreign = await call(b.token, `/engagement/cases/${c!.case_id}/ai-draft`, 'POST');
  assert.equal(foreign.status, 404, 'un caso ajeno es indistinguible de uno inexistente');
  await assert.rejects(service.requestAiDraft(actorOf(b), c!.case_id), (err: unknown) => err instanceof AppError && err.status === 404);
  assert.deepEqual(await credits(a), { committed: 0, reserved: 0, google: 0 });
  assert.deepEqual(await credits(b), { committed: 0, reserved: 0, google: 0 });
  // RBAC: una persona de solo lectura ve el modo pero no lo cambia.
  const viewer = `user_view_${randomUUID().slice(0, 8)}`;
  const viewerLogin = `${viewer}@example.com`;
  await t.pool.query(`INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash)
    VALUES ($1, 'Vista', $2, 'active', $3, crypt('Fixture-Admin-2026!', gen_salt('bf', 4)))`, [viewer, viewerLogin, a.tenant]);
  await t.pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, 'read_only', $2)`, [viewer, a.tenant]);
  const { token } = await login(t.baseUrl, viewerLogin, 'Fixture-Admin-2026!', a.tenant);
  assert.equal((await call(token, '/engagement/suggestions')).status, 200);
  assert.equal((await call(token, '/engagement/suggestions', 'PUT', { origin: 'facebook_comment', mode: 'on_demand' })).status, 403);
  assert.equal((await call(a.token, '/engagement/suggestions')).body.ai_suggestions.setting.mode, 'off', 'nada cambió');
});

test('BD: la configuración es append-only, guarda la huella de su texto y solo las automáticas llevan consentimiento', async () => {
  const a = await newTenant('client_fbs11', 1);
  assert.equal((await setMode(a, 'auto_suggest')).status, 200);
  const id = (await t.pool.query<{ setting_id: string }>('SELECT setting_id FROM engagement_suggestion_setting WHERE tenant_id = $1', [a.tenant])).rows[0]!.setting_id;
  await assert.rejects(t.pool.query(`UPDATE engagement_suggestion_setting SET mode = 'off' WHERE setting_id = $1`, [id]), /append-only/);
  await assert.rejects(t.pool.query(
    `INSERT INTO engagement_suggestion_setting (setting_id, tenant_id, origin, version, mode, consent_text, consent_version, consent_sha256, decided_by)
     VALUES ($1,$2,'facebook_comment',9,'auto_suggest','Otro texto',$3,$4,'x')`, [`sgs_${randomUUID()}`, a.tenant, SUGGEST_TERMS.version, SUGGEST_TERMS.sha256]), /does not match/);
  await assert.rejects(t.pool.query(
    `INSERT INTO engagement_suggestion_setting (setting_id, tenant_id, origin, version, mode, decided_by)
     VALUES ($1,$2,'facebook_comment',9,'auto_suggest','x')`, [`sgs_${randomUUID()}`, a.tenant]), /engagement_suggestion_setting_consent/);
  await assert.rejects(t.pool.query(
    `INSERT INTO engagement_suggestion_setting (setting_id, tenant_id, origin, version, mode, consent_text, consent_version, consent_sha256, decided_by)
     VALUES ($1,$2,'facebook_comment',9,'off',$3,$4,$5,'x')`, [`sgs_${randomUUID()}`, a.tenant, SUGGEST_TERMS.text, SUGGEST_TERMS.version, SUGGEST_TERMS.sha256]), /engagement_suggestion_setting_consent/);
});
