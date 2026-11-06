/**
 * SEC-CONSENT-01 (DEC-0077 R3/R8; BR-0007; FR-0016 AC-16007/AC-16008) — consentimiento informado y versionado antes
 * de que las respuestas automáticas gasten la cuota mensual compartida de respuestas con IA:
 *  - una política autorizada con un consentimiento anterior (sin versión, o de otra versión) no invoca a la IA ni
 *    reserva ni consume unidades: responde con el texto seguro sin IA que ese consentimiento ya autorizaba, auditado;
 *  - aceptar los términos vigentes exige la versión mostrada, guarda texto, versión, huella y actor, se audita en la
 *    misma transacción, es idempotente, respeta RBAC y aislamiento, y solo entonces la IA gasta;
 *  - una revocación o un cambio de términos durante la redacción no confirma ni la respuesta ni la unidad;
 *  - la BD impide políticas automáticas nuevas sin versión, huellas falsas y reescrituras.
 * AI Core del entorno `test` con un lector controlado (el Jev simulado marca riesgos en todo texto); el libro de cuotas
 * y la BD son los reales. Nada de aquí prueba un proveedor real.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApi, authHeaders, api, login, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan, countRows, type TestTenant as Tenant } from '../helpers/tenants.ts';
import { EngagementService, type CaseRow, type PolicyRow } from '../../src/engagement/service.ts';
import type { EngagementSemantics } from '../../src/engagement/ai-semantics.ts';
import { AUTO_REPLY_CONSENT, REVIEW_REQUIRED_CONSENT, consentSha256 } from '../../src/engagement/consent.ts';

let t: TestApi;

before(async () => {
  t = await bootApi({ aiEnvironment: 'test' });
});

after(async () => {
  await t.close();
});

/** Textos de consentimiento que el código guardó antes de 0037 (historia de git de `CONSENT_TEXT`). */
const LEGACY_TEXT = 'Autorizo a MainSpot a responder públicamente en mi nombre solo los casos de esta categoría que pasen todas las comprobaciones de seguridad (sin riesgos, sin quejas, con datos verificados). Las demás interacciones quedan para mi revisión. Puedo revocarlo en cualquier momento.';
const PR16_TEXT = 'Autorizo a MainSpot a responder públicamente en mi nombre solo los casos de esta categoría que pasen todas las comprobaciones de seguridad (sin riesgos, sin quejas, con datos verificados). Cuando la respuesta la redacta la IA de MainSpot, se publica indicando que es una respuesta automática generada con IA. En reseñas de Google, cada respuesta redactada con IA usa 1 de las respuestas con IA de mi plan en el ciclo; si no quedan, MainSpot responde con un texto seguro sin IA. Las demás interacciones quedan para mi revisión. Puedo revocarlo en cualquier momento.';
const GOOGLE = AUTO_REPLY_CONSENT.google_review;

const call = (token: string, path: string, method = 'GET', body?: unknown) =>
  api(t.baseUrl, `/api/backoffice${path}`, { method, headers: authHeaders(token), body: body === undefined ? undefined : JSON.stringify(body) });

async function newTenant(prefix: string, aiReplies = 5): Promise<Tenant> {
  return createTenantWithPlan(t, { reviews_managed: 0, ai_review_replies: aiReplies }, prefix);
}

/**
 * Política automática tal como existía ANTES de 0037: sin versión de consentimiento. La restricción NOT VALID de 0037
 * impide crearla hoy, así que se recrea dentro de la misma transacción (como estaban las filas previas a la migración).
 */
async function legacyPolicy(tenant: string, origin: 'google_review' | 'facebook_comment', category: 'gratitude' | 'basic_info', max = 10): Promise<string> {
  const client = await t.pool.connect();
  const id = `pol_${randomUUID()}`;
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE engagement_policy DROP CONSTRAINT engagement_policy_auto_reply_consent');
    const v = await client.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM engagement_policy WHERE tenant_id = $1 AND origin = $2 AND category = $3', [tenant, origin, category]);
    await client.query(
      `INSERT INTO engagement_policy (policy_id, tenant_id, origin, category, mode, version, max_auto_replies_per_hour, consent_text, decided_by)
       VALUES ($1,$2,$3,$4,'safe_auto_reply',$5,$6,$7,'legacy_admin')`, [id, tenant, origin, category, v.rows[0]!.v, max, LEGACY_TEXT]);
    await client.query(`ALTER TABLE engagement_policy ADD CONSTRAINT engagement_policy_auto_reply_consent
      CHECK (mode <> 'safe_auto_reply' OR consent_version IS NOT NULL) NOT VALID`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return id;
}

async function ledger(a: Tenant): Promise<{ committed: number; reserved: number; rows: number }> {
  const r = await t.pool.query<{ committed: string; reserved: string; rows: string }>(
    `SELECT COALESCE(SUM(units) FILTER (WHERE state = 'committed'), 0) AS committed,
            count(*) FILTER (WHERE state = 'reserved') AS reserved, count(*) AS rows
       FROM quota_reservation WHERE tenant_id = $1 AND capability = 'ai_review_replies'`, [a.tenant]);
  return { committed: Number(r.rows[0]?.committed), reserved: Number(r.rows[0]?.reserved), rows: Number(r.rows[0]?.rows) };
}

/** Lectura fija (gratitud sin riesgos) y redacción determinista contada; `during` corre mientras «redacta». */
function stubSemantics(during?: () => Promise<void>, needsHuman = false): EngagementSemantics & { replies: number } {
  const stub = {
    replies: 0,
    async read() {
      return { ok: true as const, invocationId: `inv_stub_${randomUUID()}`, reading: {},
        classification: { category: 'gratitude' as const, risk_flags: [], confidence: 0.95, sentiment: 'positive' as const, info_topic: null } };
    },
    async replyAvailable() { return true; },
    async reply(row: CaseRow) {
      stub.replies += 1;
      if (during) await during();
      return { text: `¡Gracias, ${row.author_label}! Te esperamos pronto.`, needsHuman, invocationId: `inv_stub_${randomUUID()}` };
    },
  };
  return stub;
}

async function receivedCase(service: EngagementService, tenant: string, origin: 'google_review' | 'facebook_comment' = 'google_review'): Promise<CaseRow> {
  const id = `case_${randomUUID().replaceAll('-', '')}`;
  await t.pool.query(`INSERT INTO engagement_case (case_id, tenant_id, origin, external_ref, author_label, body, rating, state)
    VALUES ($1, $2, $3, $4, 'Ana', '¡Gracias, todo excelente!', $5, 'received')`, [id, tenant, origin, `x-${randomUUID().slice(0, 8)}`, origin === 'google_review' ? 5 : null]);
  const row = await service.getCase(tenant, id);
  assert.ok(row);
  return row;
}

const policyRows = (tenant: string) => t.pool.query<PolicyRow>('SELECT * FROM engagement_policy WHERE tenant_id = $1 ORDER BY origin, category, version', [tenant]);

test('AC-16007: consentimiento anterior a la cuota (sin versión) ⇒ texto seguro sin IA: ni invocación ni unidad; auditado y visible para reconsentir', async () => {
  const a = await newTenant('client_cs1');
  const legacy = await legacyPolicy(a.tenant, 'google_review', 'gratitude');
  const view = await call(a.token, '/engagement/policies');
  assert.equal(view.status, 200);
  const row = (view.body.policies as Array<PolicyRow & { reconsent_required: boolean; consent_current: boolean }>).find((p) => p.origin === 'google_review' && p.category === 'gratitude');
  assert.deepEqual([row?.policy_id, row?.consent_version, row?.consent_current, row?.reconsent_required], [legacy, null, false, true]);
  assert.equal(view.body.reconsent_required, true);
  assert.deepEqual(view.body.consent_terms.google_review, { version: GOOGLE.version, text: GOOGLE.text }, 'el panel recibe el texto literal y la versión a aceptar');

  const stub = stubSemantics();
  const service = new EngagementService({ ...t.handle.engagement.deps, semantics: stub });
  const c = await service.classifyCase(await receivedCase(service, a.tenant));
  assert.deepEqual([c?.state, c?.decision, c?.reply_invocation_id, c?.policy_id], ['classified', 'auto_reply', null, legacy]);
  assert.doesNotMatch(c?.response_text ?? '', /generada con IA/, 'texto seguro sin IA');
  assert.equal(stub.replies, 0, 'no se invoca a la IA');
  assert.deepEqual(await ledger(a), { committed: 0, reserved: 0, rows: 0 }, 'ni reserva ni consumo');
  const audit = await t.pool.query<{ result: string; evidence_ref: string }>(
    `SELECT result, evidence_ref FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.ai_reply' AND decision = 'deny'`, [a.tenant]);
  assert.deepEqual(audit.rows, [{ result: 'consent_outdated', evidence_ref: legacy }]);
  assert.equal((await service.respondCase(c!.case_id))?.state, 'responded', 'el consentimiento previo sí autorizaba responder con el texto seguro');
});

test('AC-16007: un consentimiento de otra versión (texto de PR #16, sin el aviso de agotamiento) tampoco gasta', async () => {
  const a = await newTenant('client_cs2');
  const id = `pol_${randomUUID()}`;
  await t.pool.query(
    `INSERT INTO engagement_policy (policy_id, tenant_id, origin, category, mode, version, max_auto_replies_per_hour, consent_text, consent_version, consent_sha256, decided_by)
     VALUES ($1,$2,'google_review','gratitude','safe_auto_reply',1,10,$3,'auto_reply.google_review.v1',$4,$5)`, [id, a.tenant, PR16_TEXT, consentSha256(PR16_TEXT), a.userId]);
  const stub = stubSemantics();
  const service = new EngagementService({ ...t.handle.engagement.deps, semantics: stub });
  const c = await service.classifyCase(await receivedCase(service, a.tenant));
  assert.deepEqual([c?.decision, c?.reply_invocation_id, stub.replies], ['auto_reply', null, 0]);
  assert.deepEqual(await ledger(a), { committed: 0, reserved: 0, rows: 0 });
  assert.equal((await call(a.token, '/engagement/policies')).body.reconsent_required, true);
});

test('AC-16008: aceptar los términos vigentes exige la versión mostrada, guarda texto+versión+huella+actor, se audita, es idempotente y habilita el gasto', async () => {
  const a = await newTenant('client_cs3');
  await legacyPolicy(a.tenant, 'google_review', 'gratitude', 7);
  await legacyPolicy(a.tenant, 'google_review', 'basic_info', 4);
  const fb = await legacyPolicy(a.tenant, 'facebook_comment', 'gratitude');
  const before = (await policyRows(a.tenant)).rows.length;

  for (const [body, status] of [
    [{ consent: true }, 400],
    [{ consent: false, consent_version: GOOGLE.version }, 400],
    [{ consent: true, consent_version: 'auto_reply.google_review.v1' }, 409],
    [{ consent: true, consent_version: AUTO_REPLY_CONSENT.facebook_comment.version }, 409],
  ] as const) {
    const r = await call(a.token, '/engagement/policies/consent', 'POST', body);
    assert.equal(r.status, status, JSON.stringify(r.body));
  }
  assert.equal((await policyRows(a.tenant)).rows.length, before, 'sin aceptación válida no cambia nada');

  const ok = await call(a.token, '/engagement/policies/consent', 'POST', { consent: true, consent_version: GOOGLE.version });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.updated, ok.body.reconsent_required], [2, false]);
  const rows = (await policyRows(a.tenant)).rows;
  const fresh = rows.filter((r) => r.origin === 'google_review' && r.version === 2);
  assert.equal(fresh.length, 2);
  for (const r of fresh) {
    assert.deepEqual([r.mode, r.consent_version, r.consent_text, r.consent_sha256, r.decided_by], ['safe_auto_reply', GOOGLE.version, GOOGLE.text, consentSha256(GOOGLE.text), a.userId]);
  }
  assert.deepEqual(fresh.map((r) => [r.category, r.max_auto_replies_per_hour]).sort(), [['basic_info', 4], ['gratitude', 7]], 'conserva el límite por hora de cada regla');
  const dbHash = await t.pool.query<{ ok: boolean }>(`SELECT bool_and(consent_sha256 = encode(sha256(convert_to(consent_text, 'UTF8')), 'hex')) AS ok FROM engagement_policy WHERE tenant_id = $1 AND consent_version IS NOT NULL`, [a.tenant]);
  assert.equal(dbHash.rows[0]?.ok, true, 'la huella guardada es la del texto guardado');
  assert.equal(rows.find((r) => r.policy_id === fb)?.consent_version, null, 'Facebook no necesita reconsentir (no gasta esta cuota)');
  const audits = await t.pool.query<{ result: string; evidence_ref: string }>(
    `SELECT result, evidence_ref FROM audit_event WHERE tenant_id = $1 AND action = 'engagement.policy.changed' ORDER BY evidence_ref`, [a.tenant]);
  assert.deepEqual(audits.rows.map((r) => r.result), [`safe_auto_reply:v2:reconsent:${GOOGLE.version}`, `safe_auto_reply:v2:reconsent:${GOOGLE.version}`]);
  assert.deepEqual(audits.rows.map((r) => r.evidence_ref).sort(), fresh.map((r) => r.policy_id).sort());

  const again = await call(a.token, '/engagement/policies/consent', 'POST', { consent: true, consent_version: GOOGLE.version });
  assert.deepEqual([again.status, again.body.updated], [200, 0]);
  assert.equal((await policyRows(a.tenant)).rows.length, before + 2, 'repetir no crea versiones');

  const stub = stubSemantics();
  const service = new EngagementService({ ...t.handle.engagement.deps, semantics: stub });
  const c = await service.classifyCase(await receivedCase(service, a.tenant));
  assert.ok(c?.reply_invocation_id, 'con los términos vigentes, la respuesta automática se redacta con IA');
  assert.match(c?.response_text ?? '', /Respuesta automática generada con IA\.$/);
  assert.deepEqual(await ledger(a), { committed: 1, reserved: 0, rows: 1 });
});

test('AC-16008: solo quien administra acepta; un negocio no acepta por otro; aceptaciones simultáneas crean una versión por regla', async () => {
  const a = await newTenant('client_cs4a');
  const b = await newTenant('client_cs4b');
  await legacyPolicy(a.tenant, 'google_review', 'gratitude');
  await legacyPolicy(a.tenant, 'google_review', 'basic_info');
  await legacyPolicy(b.tenant, 'google_review', 'gratitude');
  const opsLogin = `ops@${a.tenant}.example.com`;
  await t.pool.query(`INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash)
    VALUES ($1, 'Ops', $2, 'active', $3, crypt('Fixture-User-2026!', gen_salt('bf', 4)))`, [`user_ops_${a.tenant}`, opsLogin, a.tenant]);
  await t.pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, 'operation', $2)`, [`user_ops_${a.tenant}`, a.tenant]);
  const ops = (await login(t.baseUrl, opsLogin, 'Fixture-User-2026!', a.tenant)).token;
  assert.equal((await call(ops, '/engagement/policies/consent', 'POST', { consent: true, consent_version: GOOGLE.version })).status, 403);
  assert.equal((await call(ops, '/engagement/policies')).body.reconsent_required, true, 'operación ve que falta aceptar');

  const burst = await Promise.all(Array.from({ length: 5 }, () => call(a.token, '/engagement/policies/consent', 'POST', { consent: true, consent_version: GOOGLE.version })));
  assert.ok(burst.every((r) => r.status === 200), JSON.stringify(burst.map((r) => r.status)));
  assert.equal(burst.reduce((n, r) => n + Number(r.body.updated), 0), 2, 'una versión nueva por regla, no por petición');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM engagement_policy WHERE tenant_id = $1 AND consent_version = $2`, [a.tenant, GOOGLE.version]), 2);
  assert.equal((await call(b.token, '/engagement/policies')).body.reconsent_required, true, 'el otro negocio sigue sin aceptar');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM engagement_policy WHERE tenant_id = $1 AND consent_version IS NOT NULL`, [b.tenant]), 0);
});

test('AC-16008: activar respuestas automáticas exige aceptar la versión vigente de su origen; revisar antes no autoriza nada público', async () => {
  const a = await newTenant('client_cs5');
  const put = (body: Record<string, unknown>) => call(a.token, '/engagement/policies', 'PUT', body);
  const base = { origin: 'google_review', category: 'gratitude', mode: 'safe_auto_reply' };
  assert.equal((await put({ ...base, consent: true })).status, 400, 'sin la versión mostrada');
  assert.equal((await put({ ...base, consent: true, consent_version: 'auto_reply.google_review.v1' })).status, 409, 'versión que ya no es la vigente');
  assert.equal((await put({ ...base, consent: true, consent_version: AUTO_REPLY_CONSENT.facebook_comment.version })).status, 409, 'términos de otro origen');
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM engagement_policy WHERE tenant_id = $1', [a.tenant]), 0);
  const ok = await put({ ...base, consent: true, consent_version: GOOGLE.version });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.policy.consent_version, ok.body.policy.consent_text, ok.body.policy.consent_sha256], [GOOGLE.version, GOOGLE.text, GOOGLE.sha256]);
  const fb = await put({ origin: 'facebook_comment', category: 'gratitude', mode: 'safe_auto_reply', consent: true, consent_version: AUTO_REPLY_CONSENT.facebook_comment.version });
  assert.equal(fb.body.policy.consent_text, AUTO_REPLY_CONSENT.facebook_comment.text);
  const review = await put({ origin: 'google_review', category: 'gratitude', mode: 'review_required' });
  assert.deepEqual([review.status, review.body.policy.consent_version, review.body.policy.consent_text], [200, REVIEW_REQUIRED_CONSENT.version, REVIEW_REQUIRED_CONSENT.text]);
});

test('Revocación durante la redacción: ni la respuesta automática ni la unidad se confirman; el caso se reclasifica con la política vigente', async () => {
  const a = await newTenant('client_cs6');
  assert.equal((await call(a.token, '/engagement/policies', 'PUT', { origin: 'google_review', category: 'gratitude', mode: 'safe_auto_reply', consent: true, consent_version: GOOGLE.version })).status, 200);
  const revoke = async () => {
    const r = await call(a.token, '/engagement/policies', 'PUT', { origin: 'google_review', category: 'gratitude', mode: 'review_required' });
    assert.equal(r.status, 200);
  };
  const racing = new EngagementService({ ...t.handle.engagement.deps, semantics: stubSemantics(revoke) });
  const row = await receivedCase(racing, a.tenant);
  assert.equal(await racing.classifyCase(row), null, 'la política cambió: no se confirma nada');
  const still = await racing.getCase(a.tenant, row.case_id);
  assert.deepEqual([still?.state, still?.response_text, still?.reply_invocation_id], ['received', null, null]);
  assert.deepEqual(await ledger(a), { committed: 0, reserved: 0, rows: 1 }, 'la reserva quedó liberada');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1 AND state = 'released'`, [a.tenant]), 1);

  const normal = new EngagementService({ ...t.handle.engagement.deps, semantics: stubSemantics() });
  const again = await normal.classifyCase(still!);
  assert.deepEqual([again?.state, again?.decision, again?.reason], ['needs_human', 'human_review', 'policy_review_required']);
  assert.deepEqual((await ledger(a)).committed, 0);
});

test('R2: si la redacción para la respuesta automática pide revisión humana, el caso espera decisión sin propuesta de IA entre las numeradas y sin gastar la unidad', async () => {
  const a = await newTenant('client_cs9');
  assert.equal((await call(a.token, '/engagement/policies', 'PUT', { origin: 'google_review', category: 'gratitude', mode: 'safe_auto_reply', consent: true, consent_version: GOOGLE.version })).status, 200);
  const stub = stubSemantics(undefined, true);
  const service = new EngagementService({ ...t.handle.engagement.deps, semantics: stub });
  const c = await service.classifyCase(await receivedCase(service, a.tenant));
  assert.deepEqual([c?.state, c?.decision, c?.reason, c?.reply_invocation_id, c?.ai_draft ?? null], ['needs_human', 'human_review', 'reply_needs_human', null, null]);
  assert.equal(stub.replies, 1);
  assert.ok(c!.drafts.length >= 1 && !c!.drafts.includes('¡Gracias, Ana! Te esperamos pronto.'), `el texto de IA no entra en las opciones numeradas: ${JSON.stringify(c!.drafts)}`);
  assert.deepEqual(await ledger(a), { committed: 0, reserved: 0, rows: 1 }, 'la unidad reservada se liberó');
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM quota_reservation WHERE tenant_id = $1 AND state = 'released'`, [a.tenant]), 1);
});

test('R2: revocar la regla mientras la IA redacta y la redacción pide revisión humana tampoco gasta la unidad', async () => {
  const a = await newTenant('client_cs10');
  assert.equal((await call(a.token, '/engagement/policies', 'PUT', { origin: 'google_review', category: 'gratitude', mode: 'safe_auto_reply', consent: true, consent_version: GOOGLE.version })).status, 200);
  const revoke = async () => {
    assert.equal((await call(a.token, '/engagement/policies', 'PUT', { origin: 'google_review', category: 'gratitude', mode: 'review_required' })).status, 200);
  };
  const service = new EngagementService({ ...t.handle.engagement.deps, semantics: stubSemantics(revoke, true) });
  const c = await service.classifyCase(await receivedCase(service, a.tenant));
  assert.deepEqual([c?.state, c?.reply_invocation_id], ['needs_human', null]);
  assert.deepEqual(await ledger(a), { committed: 0, reserved: 0, rows: 1 });
});

test('SEC-CONSENT-01: una política con la versión vigente pero OTRO texto (y su huella) no cubre el gasto: ni IA ni unidad', async () => {
  const a = await newTenant('client_cs11');
  const text = 'Autorizo respuestas automáticas.';
  await t.pool.query(
    `INSERT INTO engagement_policy (policy_id, tenant_id, origin, category, mode, version, max_auto_replies_per_hour, consent_text, consent_version, consent_sha256, decided_by)
     VALUES ($1,$2,'google_review','gratitude','safe_auto_reply',1,10,$3,$4,$5,$6)`, [`pol_${randomUUID()}`, a.tenant, text, GOOGLE.version, consentSha256(text), a.userId]);
  const stub = stubSemantics();
  const service = new EngagementService({ ...t.handle.engagement.deps, semantics: stub });
  const c = await service.classifyCase(await receivedCase(service, a.tenant));
  assert.deepEqual([c?.decision, c?.reply_invocation_id, stub.replies], ['auto_reply', null, 0], 'texto seguro sin IA');
  assert.deepEqual(await ledger(a), { committed: 0, reserved: 0, rows: 0 });
  const view = await call(a.token, '/engagement/policies');
  assert.equal(view.body.reconsent_required, true);
});

test('Facebook: el consentimiento previo sigue cubriendo sus respuestas automáticas, fuera de la cuota de reseñas', async () => {
  const a = await newTenant('client_cs7', 0);
  await legacyPolicy(a.tenant, 'facebook_comment', 'gratitude');
  const stub = stubSemantics();
  const service = new EngagementService({ ...t.handle.engagement.deps, semantics: stub });
  const c = await service.classifyCase(await receivedCase(service, a.tenant, 'facebook_comment'));
  assert.deepEqual([c?.decision, Boolean(c?.reply_invocation_id), stub.replies], ['auto_reply', true, 1]);
  assert.deepEqual(await ledger(a), { committed: 0, reserved: 0, rows: 0 });
  assert.equal((await call(a.token, '/engagement/policies')).body.reconsent_required, false);
});

test('BD: la política es append-only; una automática nueva sin versión o con huella que no es la de su texto se rechaza', async () => {
  const a = await newTenant('client_cs8');
  await assert.rejects(t.pool.query(
    `INSERT INTO engagement_policy (policy_id, tenant_id, origin, category, mode, version, max_auto_replies_per_hour, consent_text, decided_by)
     VALUES ($1,$2,'google_review','gratitude','safe_auto_reply',1,10,'Autorizo', $3)`, [`pol_${randomUUID()}`, a.tenant, a.userId]), /engagement_policy_auto_reply_consent/);
  await assert.rejects(t.pool.query(
    `INSERT INTO engagement_policy (policy_id, tenant_id, origin, category, mode, version, max_auto_replies_per_hour, consent_text, consent_version, consent_sha256, decided_by)
     VALUES ($1,$2,'google_review','gratitude','safe_auto_reply',1,10,$3,$4,$5,$6)`, [`pol_${randomUUID()}`, a.tenant, 'Otro texto', GOOGLE.version, GOOGLE.sha256, a.userId]), /does not match/);
  const ok = await call(a.token, '/engagement/policies', 'PUT', { origin: 'google_review', category: 'gratitude', mode: 'safe_auto_reply', consent: true, consent_version: GOOGLE.version });
  await assert.rejects(t.pool.query(`UPDATE engagement_policy SET consent_text = 'otro' WHERE policy_id = $1`, [ok.body.policy.policy_id]), /append-only/);
});
