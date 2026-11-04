/**
 * Catálogo de planes versionado (DEC-0075 / SRC-0013) por la API REAL de plataforma — `/api/platform/plan-catalog/*` y
 * `/api/platform/tenants/:id/plan` — con sesiones de plataforma reales (contraseña + TOTP; step-up TOTP) contra
 * PostgreSQL. Sin proveedores externos ni de IA (DEC-0074).
 *
 * Cubre: autorización por permiso explícito (plans.read · plans.edit · plans.publish · subscriptions.assign ·
 * tenants.read), step-up (con límite de intentos) y denegaciones auditadas sin efectos; mínimo privilegio (sin
 * tenants.read solo recuentos, sin identidades de negocios; las lecturas con identidades se auditan); creación
 * (deshabilitado, borrador v1 sugerido SIN confirmar, confirmación uno a uno, cambiar un valor le quita la confirmación
 * también en BD, checksum = plan_revision_checksum(), asignable solo habilitado, clon sin confirmar); edición (un
 * borrador por plan, lock_version ⇒ 409 stale_version, diff + motivo; un borrador sin la fila de un parámetro la
 * recibe al guardarlo); suscripciones fijadas a su revisión, vista previa con uso por encima del nuevo límite,
 * migración explícita con expected_count, downgrade sin borrados, historial y auditoría del negocio; rollback y
 * descarte; inmutabilidad en BD; espejo del registro (503 en escrituras; lecturas y enforcement siguen); concurrencia
 * (una publicación o edición gana, nunca dos publicadas; asignar o clonar durante una publicación usa la revisión que
 * quedó publicada; asignar durante una baja se rechaza); asignación con historial (el mismo plan en una revisión
 * anterior se migra, no se reasigna); validación de textos; retención (DEC-0027: denegaciones y migraciones no dejan
 * ids de negocios donde la anonimización no llega); reconciliación; panel del negocio de solo lectura.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { bootApi, api, authHeaders, type TestApi } from '../helpers/testdb.ts';
import { createPublishedPlan, setTenantPlan } from '../helpers/plans.ts';
import { countRows, createTenantWithPlan } from '../helpers/tenants.ts';
import { currentStep, totpAt, type PlatformRole } from '../../src/platform/auth.ts';
import { PLAN_PARAMETERS } from '../../src/plans/registry.ts';

interface Operator { id: string; token: string; secret: string; lastStep: number }
interface Write { method: string; path: string; body: Record<string, unknown>; permission: string }
interface ValueState { value: number | boolean | null; source: string; confirmed: boolean }
type Limits = Partial<Record<string, number>>;

// Vistas de las respuestas JSON de la API que leen estas pruebas.
interface Change { key: string; from: number | boolean | null; to: number | boolean | null; confirmed_from?: boolean; confirmed_to?: boolean }
interface RevisionView { revision_id: string; version: number; status: string; origin: string; lock_version: number; based_on_revision_id: string | null }
interface PlanDetailView { plan: { active: boolean; price_cents: number | null }; revisions: RevisionView[] }
interface CatalogEntry { plan_id: string; state: string; draft_revision_id: string | null; published_revision_id: string | null; subscriptions: number; subscriptions_on_older: number }
interface ReviewView {
  ready: boolean; items: Array<{ key: string; confirmed: boolean }>; diff: Change[]; checksum_preview: string | null;
  impact: { subscriptions_by_revision: Array<{ revision_id: string; version: number; n: number }> };
}
interface PreviewRow { tenant_id: string; from_revision_id: string; from_version: number; over_limit: Array<{ capability: string; usage: number; new_limit: number }> }
interface AssignablePlan { plan_id: string; revision_id: string; version: number; values: Array<{ key: string; value: string }> }
interface EntitlementsView {
  plan: { plan_id: string }; revision: { revision_id: string; version: number; status: string };
  limits: Record<string, number>; usage: Record<string, number>;
  parameters: Array<{ key: string; value: number | boolean | null; usage: number | null; enforced: boolean }>;
}
interface TenantView { tenant: { plan_revision_id: string; plan_revision_version: number }; plan_usage: Array<{ key: string; limit: number | null; usage: number | null }> }
interface CatalogEvent<D> { action: string; actor_id: string; revision_id: string | null; reason: string | null; diff: D }
interface PublishDiff { superseded: string | null; changes: Change[]; checksum: string }

const REASON = 'Prueba de integración del catálogo de planes';
const sfx = () => randomUUID().slice(0, 8);

function keyOf(capability: string): string {
  const def = PLAN_PARAMETERS.find((d) => d.capability === capability);
  assert.ok(def, `parámetro de ${capability}`);
  return def.key;
}
const POSTS = keyOf('social_posts');
const REVIEWS = keyOf('reviews_managed');

/** [clave, antes, después] de cada cambio (diff de API, de revisión y de eventos). */
const triples = (changes: Change[]) => changes.map((c) => [c.key, c.from, c.to]);

let t: TestApi;
let admin: Operator;
let eng: Operator;
let support: Operator;
let staleAdmin: Operator;
let staleEng: Operator;

function platform(token: string | null, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return api(t.baseUrl, `/api/platform${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function business(token: string, path: string, method = 'GET', body?: unknown) {
  return api(t.baseUrl, `/api/backoffice${path}`, { method, headers: authHeaders(token), body: body === undefined ? undefined : JSON.stringify(body) });
}

/** Operador de plataforma real: alta por CLI, login con contraseña + TOTP del paso actual. */
async function operator(role: PlatformRole, label: string): Promise<Operator> {
  const loginName = `pc-${label}-${sfx()}`;
  const password = `Catalogo-Planes-${label}-2026`;
  const user = await t.handle.platformAuth.createUser({ login: loginName, displayName: `Planes ${label}`, password, roles: [role], grantedBy: 'test' });
  const step = currentStep();
  const res = await platform(null, '/auth/login', 'POST', { login: loginName, password, code: totpAt(user.totp_secret, step) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { id: user.platform_user_id, token: res.body.token as string, secret: user.totp_secret, lastStep: step };
}

/** Step-up TOTP real con el siguiente paso no usado (anti-replay: el paso aceptado solo avanza). */
async function stepUp(op: Operator): Promise<void> {
  const step = Math.max(op.lastStep + 1, currentStep());
  const res = await platform(op.token, '/auth/step-up', 'POST', { code: totpAt(op.secret, step) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  op.lastStep = step;
}

before(async () => {
  t = await bootApi({ platformMfaKey: randomBytes(32).toString('base64') }, 10);
  admin = await operator('platform_admin', 'admin');
  eng = await operator('ai_engineer', 'eng');
  support = await operator('platform_support', 'support');
  staleAdmin = await operator('platform_admin', 'stale-admin');
  staleEng = await operator('ai_engineer', 'stale-eng');
  for (const op of [admin, eng, support]) await stepUp(op);
});

after(async () => {
  await t.close();
});

// ------------------------------------------------------------------ API del catálogo

const send = (op: Operator, w: Write) => platform(op.token, w.path, w.method, w.body);

/** Todos los parámetros confirmados; los de `limits` además con ese valor (el resto conserva el suyo). */
function confirmAll(limits: Limits = {}) {
  return PLAN_PARAMETERS.map((d) => (limits[d.capability] === undefined ? { key: d.key, confirmed: true } : { key: d.key, value: limits[d.capability], confirmed: true }));
}

/** Valores esperados: sugeridos del registro salvo `limits`. */
function valuesWith(limits: Limits): Record<string, number | boolean> {
  return Object.fromEntries(PLAN_PARAMETERS.map((d) => [d.key, limits[d.capability] ?? d.suggested]));
}

function withState(values: Record<string, number | boolean>, source: string, confirmed: boolean): Record<string, ValueState> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v, source, confirmed }]));
}

async function createPlan(op: Operator, extra: Record<string, unknown> = {}): Promise<{ planId: string; revisionId: string; name: string }> {
  const name = `Plan prueba ${sfx()}`;
  const res = await platform(op.token, '/plan-catalog/plans', 'POST', { name, reason: REASON, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { planId: res.body.plan_id as string, revisionId: res.body.revision_id as string, name };
}

function patchDraft(op: Operator, revisionId: string, lockVersion: number, values: unknown[], reason = REASON) {
  return platform(op.token, `/plan-catalog/revisions/${revisionId}`, 'PATCH', { lock_version: lockVersion, values, reason });
}

function publish(op: Operator, revisionId: string, lockVersion: number) {
  return platform(op.token, `/plan-catalog/revisions/${revisionId}/publish`, 'POST', { lock_version: lockVersion, reason: REASON });
}

function setEnabled(op: Operator, planId: string, enabled: boolean) {
  return platform(op.token, `/plan-catalog/plans/${planId}/status`, 'POST', { enabled, reason: REASON });
}

function assignPlan(op: Operator, tenantId: string, planId: string) {
  return platform(op.token, `/tenants/${tenantId}/plan`, 'POST', { plan_id: planId, reason: 'Asignación de Administration en la prueba' });
}

function migrate(op: Operator, planId: string, body: Record<string, unknown>) {
  return platform(op.token, `/plan-catalog/plans/${planId}/migrate-subscriptions`, 'POST', body);
}

/** Plan creado por la API con v1 publicada (todo confirmado de una vez) y, por omisión, habilitado. */
async function publishedPlan(op: Operator, limits: Limits, opts: { enabled?: boolean } = {}) {
  const plan = await createPlan(op);
  const patched = await patchDraft(op, plan.revisionId, 1, confirmAll(limits));
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const pub = await publish(op, plan.revisionId, patched.body.lock_version as number);
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  if (opts.enabled !== false) assert.equal((await setEnabled(op, plan.planId, true)).status, 200);
  return { ...plan, checksum: pub.body.checksum as string };
}

/** Borrador nuevo (copia sin confirmar de la publicada) con `limits` aplicados y todo confirmado. */
async function confirmedDraft(op: Operator, planId: string, limits: Limits) {
  const opened = await platform(op.token, `/plan-catalog/plans/${planId}/revisions`, 'POST', { reason: REASON });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const patched = await patchDraft(op, opened.body.revision_id as string, 1, confirmAll(limits));
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  return { revisionId: opened.body.revision_id as string, version: opened.body.version as number, lock: patched.body.lock_version as number };
}

function catalogWrites(planId: string, publishedId: string, draftId: string): Write[] {
  return [
    { method: 'POST', path: '/plan-catalog/plans', body: { name: `Plan nuevo ${sfx()}`, reason: REASON }, permission: 'plans.edit' },
    { method: 'POST', path: '/plan-catalog/plans', body: { name: `Plan clon ${sfx()}`, clone_from_plan_id: planId, reason: REASON }, permission: 'plans.edit' },
    { method: 'PATCH', path: `/plan-catalog/plans/${planId}`, body: { description: 'Descripción cambiada', reason: REASON }, permission: 'plans.publish' },
    { method: 'POST', path: `/plan-catalog/plans/${planId}/revisions`, body: { reason: REASON }, permission: 'plans.edit' },
    { method: 'PATCH', path: `/plan-catalog/revisions/${draftId}`, body: { lock_version: 1, values: [{ key: POSTS, value: 9, confirmed: true }], reason: REASON }, permission: 'plans.edit' },
    { method: 'POST', path: `/plan-catalog/revisions/${draftId}/discard`, body: { lock_version: 1, reason: REASON }, permission: 'plans.edit' },
    { method: 'POST', path: `/plan-catalog/revisions/${draftId}/publish`, body: { lock_version: 1, reason: REASON }, permission: 'plans.publish' },
    { method: 'POST', path: `/plan-catalog/plans/${planId}/rollback`, body: { to_revision_id: publishedId, reason: REASON }, permission: 'plans.publish' },
    { method: 'POST', path: `/plan-catalog/plans/${planId}/status`, body: { enabled: false, reason: REASON }, permission: 'plans.publish' },
  ];
}

function assignmentWrites(planId: string, publishedId: string, tenantId: string): Write[] {
  return [
    { method: 'POST', path: `/plan-catalog/plans/${planId}/migrate-subscriptions`, body: { to_revision_id: publishedId, tenant_ids: 'all', expected_count: 1, reason: REASON }, permission: 'subscriptions.assign' },
    { method: 'POST', path: `/tenants/${tenantId}/plan`, body: { plan_id: planId, reason: REASON }, permission: 'subscriptions.assign' },
  ];
}

const byPermission = (writes: Write[]) => writes.reduce<Record<string, number>>((acc, w) => ({ ...acc, [w.permission]: (acc[w.permission] ?? 0) + 1 }), {});

// ------------------------------------------------------------------ panel del negocio

async function entitlements(token: string): Promise<EntitlementsView> {
  const res = await business(token, '/subscriptions/entitlements');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.entitlements;
}

const post = (token: string, n: number) => business(token, '/social/posts', 'POST', { text: `Publicación de prueba ${n}` });

/** Ids de los planes ofrecidos como asignables: al negocio (/subscriptions/plans) y a Administration (/plans). */
async function assignableLists(bizToken: string): Promise<string[][]> {
  const toBusiness = await business(bizToken, '/subscriptions/plans');
  const toPlatform = await platform(support.token, '/plans');
  assert.deepEqual([toBusiness.status, toPlatform.status], [200, 200]);
  const fromBusiness: Array<{ plan_id: string }> = toBusiness.body.plans;
  const fromPlatform: AssignablePlan[] = toPlatform.body.plans;
  return [fromBusiness.map((p) => p.plan_id), fromPlatform.map((p) => p.plan_id)];
}

// ------------------------------------------------------------------ BD

async function valuesOf(revisionId: string): Promise<Record<string, ValueState>> {
  const r = await t.pool.query<{ parameter_key: string; value_int: number | null; value_bool: boolean | null; source: string; confirmed_at: Date | null }>(
    'SELECT parameter_key, value_int, value_bool, source, confirmed_at FROM plan_parameter_value WHERE revision_id = $1', [revisionId]);
  return Object.fromEntries(r.rows.map((row) => [row.parameter_key, { value: row.value_int ?? row.value_bool ?? null, source: row.source, confirmed: row.confirmed_at !== null }]));
}

const plainValues = (values: Record<string, ValueState>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.value]));

async function revisionOf(revisionId: string) {
  const r = await t.pool.query<{ status: string; version: number; origin: string; based_on_revision_id: string | null; lock_version: number; checksum: string | null; computed: string; published_by: string | null }>(
    `SELECT status, version, origin, based_on_revision_id, lock_version, checksum, published_by, plan_revision_checksum(revision_id) AS computed
       FROM plan_revision WHERE revision_id = $1`, [revisionId]);
  const row = r.rows[0];
  assert.ok(row, `revisión ${revisionId}`);
  return row;
}

async function statusesOf(planId: string): Promise<Array<[number, string]>> {
  const r = await t.pool.query<{ version: number; status: string }>('SELECT version, status FROM plan_revision WHERE plan_id = $1 ORDER BY version', [planId]);
  return r.rows.map((x) => [x.version, x.status]);
}

const publishedCount = (planId: string) => countRows(t, `SELECT count(*) AS n FROM plan_revision WHERE plan_id = $1 AND status = 'PUBLISHED'`, [planId]);

async function subscriptionOf(tenantId: string): Promise<{ plan_id: string; plan_revision_id: string; status: string } | null> {
  const r = await t.pool.query<{ plan_id: string; plan_revision_id: string; status: string }>('SELECT plan_id, plan_revision_id, status FROM subscription WHERE tenant_id = $1', [tenantId]);
  return r.rows[0] ?? null;
}

async function historyOf(tenantId: string): Promise<Array<{ change_kind: string; plan_id: string; plan_revision_id: string; previous_plan_id: string | null; previous_revision_id: string | null; actor: string; reason: string | null }>> {
  return (await t.pool.query(
    `SELECT change_kind, plan_id, plan_revision_id, previous_plan_id, previous_revision_id, actor, reason
       FROM subscription_history WHERE tenant_id = $1 ORDER BY changed_at, history_id`, [tenantId])).rows;
}

/**
 * Espera a que `n` sesiones de esta BD estén bloqueadas en un candado (fija el orden de una carrera). Sondea
 * pg_stat_activity: PostgreSQL no emite ningún evento al que esperar cuando otra sesión entra en espera.
 */
async function lockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 250; i += 1) {
    if (await countRows(t, `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`, []) >= n) return;
    await delay(20);
  }
  assert.fail(`no llegaron ${n} sesiones a esperar el candado`);
}

/** Eventos del catálogo; `D` es la forma del diff que escribe la acción consultada. */
async function catalogEvents<D = unknown>(where: string, params: unknown[]): Promise<Array<CatalogEvent<D>>> {
  return (await t.pool.query<CatalogEvent<D>>(`SELECT action, actor_id, revision_id, reason, diff FROM plan_catalog_event WHERE ${where} ORDER BY at, event_id`, params)).rows;
}

/** SQLSTATE con que la BD rechaza la sentencia ('ok' si la acepta). */
async function sqlState(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await t.pool.query(sql, params);
    return 'ok';
  } catch (err) {
    return err instanceof Error && 'code' in err ? String(err.code) : 'unknown';
  }
}

/** Reloj de la BD: marca desde la que se leen las filas de auditoría de una prueba. */
async function dbNow(): Promise<Date> {
  return (await t.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now ?? new Date(0);
}

/** Anonimiza el negocio como la retención diaria (DEC-0027): falla si queda cualquier identificador suyo en la BD. */
function anonymize(tenantId: string) {
  return t.handle.retention.anonymizeTenant(tenantId, `ret_${randomUUID()}`);
}

async function denials(op: Operator, since: Date, result: string): Promise<Record<string, number>> {
  const r = await t.pool.query<{ action: string; n: number }>(
    `SELECT action, count(*)::int AS n FROM platform_audit_event
      WHERE actor_id = $1 AND decision = 'deny' AND result = $2 AND at >= $3 GROUP BY action`, [op.id, result, since]);
  return Object.fromEntries(r.rows.map((x) => [x.action, x.n]));
}

/** Estado observable del plan y de la suscripción del negocio (para probar que un intento no cambió nada). */
async function fingerprint(planId: string, tenantId: string): Promise<Record<string, unknown>> {
  return (await t.pool.query(
    `SELECT (SELECT count(*)::int FROM plan) AS plans,
            (SELECT row_to_json(p) FROM (SELECT name, description, active, updated_at FROM plan WHERE plan_id = $1) p) AS plan,
            (SELECT json_agg(json_build_object('id', revision_id, 'status', status, 'lock', lock_version) ORDER BY version) FROM plan_revision WHERE plan_id = $1) AS revisions,
            (SELECT json_agg(json_build_object('rev', v.revision_id, 'key', v.parameter_key, 'value', v.value_int, 'confirmed', v.confirmed_at IS NOT NULL) ORDER BY v.revision_id, v.parameter_key)
               FROM plan_parameter_value v JOIN plan_revision r ON r.revision_id = v.revision_id WHERE r.plan_id = $1) AS values,
            (SELECT count(*)::int FROM plan_catalog_event WHERE plan_id = $1) AS events,
            (SELECT row_to_json(s) FROM (SELECT plan_id, plan_revision_id, status FROM subscription WHERE tenant_id = $2) s) AS subscription,
            (SELECT count(*)::int FROM subscription_history WHERE tenant_id = $2) AS history`, [planId, tenantId])).rows[0];
}

// ------------------------------------------------------------------ 1. autorización

test('autorización: plans.read para admin, ingeniería y soporte; escribir exige plans.edit/plans.publish y step-up; asignar y migrar solo platform_admin; token de negocio 401; denegaciones auditadas y sin efectos', async () => {
  const plan = await publishedPlan(admin, { social_posts: 4 });
  const draft = await platform(admin.token, `/plan-catalog/plans/${plan.planId}/revisions`, 'POST', { reason: REASON });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const draftId = draft.body.revision_id as string;
  const biz = await createTenantWithPlan(t, { social_posts: 1 }, 'client_pcauth');

  // La sesión expone los permisos explícitos de cada función.
  const permissions = async (op: Operator) => {
    const granted: string[] = (await platform(op.token, '/me')).body.session.permissions;
    return granted.slice().sort();
  };
  assert.deepEqual(await permissions(admin), ['plans.edit', 'plans.publish', 'plans.read', 'subscriptions.assign', 'tenants.read']);
  assert.deepEqual(await permissions(eng), ['plans.edit', 'plans.publish', 'plans.read']);
  assert.deepEqual(await permissions(support), ['plans.read', 'tenants.read']);

  // Lectura del catálogo: las tres funciones de plataforma (identidades de negocios: prueba de mínimo privilegio).
  const reads = ['/plan-catalog/parameters', '/plan-catalog/plans', `/plan-catalog/plans/${plan.planId}`, `/plan-catalog/revisions/${draftId}/review`, '/plans'];
  for (const op of [admin, eng, support]) {
    for (const path of reads) assert.equal((await platform(op.token, path)).status, 200, path);
  }
  const preview = `/plan-catalog/plans/${plan.planId}/migration-preview?to=${plan.revisionId}`;

  const catalog = catalogWrites(plan.planId, plan.revisionId, draftId);
  const assignment = assignmentWrites(plan.planId, plan.revisionId, biz.tenant);
  const initial = await fingerprint(plan.planId, biz.tenant);
  const since: Date = (await t.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now ?? new Date(0);

  // Soporte, aun con step-up vigente: 403 en TODA escritura.
  for (const w of [...catalog, ...assignment]) {
    const res = await send(support, w);
    assert.deepEqual([res.status, res.body?.error?.code], [403, 'permission_denied'], `soporte ${w.method} ${w.path}`);
  }
  // Ingeniería mantiene el catálogo pero no asigna ni migra suscripciones (Administration).
  for (const w of assignment) {
    const res = await send(eng, w);
    assert.deepEqual([res.status, res.body?.error?.code], [403, 'permission_denied'], `ingeniería ${w.method} ${w.path}`);
  }
  // Un token del panel del negocio no abre /api/platform/*.
  for (const w of [...catalog, ...assignment]) {
    const res = await platform(biz.token, w.path, w.method, w.body);
    assert.deepEqual([res.status, res.body?.error?.code], [401, 'missing_actor'], `negocio ${w.method} ${w.path}`);
  }
  for (const path of [...reads, preview, '/me']) assert.equal((await platform(biz.token, path)).status, 401, `negocio GET ${path}`);

  // Sin step-up reciente (> 10 min): 403 step_up_required en toda escritura, también para platform_admin; leer sigue.
  await t.pool.query(`UPDATE platform_session SET step_up_at = now() - interval '11 minutes' WHERE platform_user_id = ANY($1::text[])`, [[staleAdmin.id, staleEng.id]]);
  for (const w of [...catalog, ...assignment]) {
    const res = await send(staleAdmin, w);
    assert.deepEqual([res.status, res.body?.error?.code], [403, 'step_up_required'], `admin sin step-up ${w.method} ${w.path}`);
  }
  for (const w of catalog) {
    const res = await send(staleEng, w);
    assert.deepEqual([res.status, res.body?.error?.code], [403, 'step_up_required'], `ingeniería sin step-up ${w.method} ${w.path}`);
  }
  assert.equal((await platform(staleEng.token, `/plan-catalog/plans/${plan.planId}`)).status, 200, 'leer no exige step-up');
  assert.deepEqual(await fingerprint(plan.planId, biz.tenant), initial, 'ninguna escritura denegada cambió nada');

  // Cada denegación queda en platform_audit_event con el permiso pedido como acción.
  assert.deepEqual(await denials(support, since, 'role_denied'), byPermission([...catalog, ...assignment]));
  assert.deepEqual(await denials(eng, since, 'role_denied'), byPermission(assignment));
  assert.deepEqual(await denials(staleAdmin, since, 'step_up_required'), byPermission([...catalog, ...assignment]));
  assert.deepEqual(await denials(staleEng, since, 'step_up_required'), byPermission(catalog));

  // Con step-up TOTP real la misma sesión vuelve a escribir; platform_admin asigna.
  await stepUp(staleEng);
  const [createWrite] = catalog;
  assert.ok(createWrite);
  assert.equal((await send(staleEng, createWrite)).status, 201, 'tras el step-up la sesión escribe');
  const assigned = await assignPlan(admin, biz.tenant, plan.planId);
  assert.deepEqual([assigned.status, assigned.body.changed, assigned.body.subscription?.plan_revision_id], [200, true, plan.revisionId]);
});

test('mínimo privilegio (BR-0007): sin tenants.read (ai_engineer) el catálogo solo muestra recuentos por revisión, sin ids ni nombres de negocios, y la vista previa de migración y los negocios se deniegan (403 auditado); admin y soporte sí los ven y cada lectura con identidades queda auditada sin ids', async () => {
  const plan = await publishedPlan(eng, { social_posts: 5 });
  const biz = await createTenantWithPlan(t, { social_posts: 1 }, 'client_pcpriv');
  assert.equal((await assignPlan(admin, biz.tenant, plan.planId)).status, 200);
  const d2 = await confirmedDraft(eng, plan.planId, { social_posts: 3 });
  assert.equal((await publish(eng, d2.revisionId, d2.lock)).status, 200);
  const businessName = (await t.pool.query<{ business_name: string }>('SELECT business_name FROM client WHERE client_id = $1', [biz.tenant])).rows[0]?.business_name;
  assert.ok(businessName);
  const byRevision = [{ revision_id: plan.revisionId, version: 1, n: 1 }];
  const preview = `/plan-catalog/plans/${plan.planId}/migration-preview?to=${d2.revisionId}`;

  // Ingeniería: detalle con recuentos por revisión y la lista de negocios vacía; nada de lo que lee identifica al negocio.
  const sinceReads = await dbNow();
  const engDetail = await platform(eng.token, `/plan-catalog/plans/${plan.planId}`);
  assert.equal(engDetail.status, 200);
  assert.deepEqual([engDetail.body.subscriptions, engDetail.body.subscriptions_by_revision], [[], byRevision]);
  for (const path of [`/plan-catalog/plans/${plan.planId}`, '/plan-catalog/plans', `/plan-catalog/revisions/${d2.revisionId}/review`, '/plans']) {
    const seen = JSON.stringify((await platform(eng.token, path)).body);
    assert.ok(!seen.includes(biz.tenant) && !seen.includes(businessName), `${path} no expone al negocio`);
  }
  const since: Date = (await t.pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]?.now ?? new Date(0);
  for (const path of [preview, '/tenants', `/tenants/${biz.tenant}`]) {
    const res = await platform(eng.token, path);
    assert.deepEqual([res.status, res.body?.error?.code], [403, 'permission_denied'], path);
  }
  assert.deepEqual(await denials(eng, since, 'role_denied'), { 'tenants.read': 3 }, 'cada denegación auditada con el permiso');

  // Administration y soporte: la lista con identidades (y los mismos recuentos) y la vista previa por negocio.
  for (const op of [admin, support]) {
    const detail = await platform(op.token, `/plan-catalog/plans/${plan.planId}`);
    const subscriptions: Array<{ tenant_id: string; business_name: string; plan_revision_id: string; revision_version: number }> = detail.body.subscriptions;
    assert.deepEqual([detail.status, subscriptions.map((s) => [s.tenant_id, s.business_name, s.plan_revision_id, s.revision_version]), detail.body.subscriptions_by_revision],
      [200, [[biz.tenant, businessName, plan.revisionId, 1]], byRevision]);
    const previewed = await platform(op.token, preview);
    const rows: PreviewRow[] = previewed.body.subscriptions;
    assert.deepEqual([previewed.status, rows.map((r) => [r.tenant_id, r.from_revision_id])], [200, [[biz.tenant, plan.revisionId]]]);
    for (const path of ['/tenants', `/tenants/${biz.tenant}`]) assert.equal((await platform(op.token, path)).status, 200, path);
  }
  // Cada lectura con identidades de negocios (detalle con tenants.read y vista previa) queda en la auditoría de plataforma:
  // permiso, plan y recuento, sin negocio ni ids. Las lecturas de ingeniería no llevan identidades ni esta fila.
  const audited = (await t.pool.query<{ actor_id: string; resource: string; result: string; tenant_id: string | null }>(
    `SELECT actor_id, resource, result, tenant_id FROM platform_audit_event
      WHERE action = 'tenants.read' AND decision = 'allow' AND at >= $1 ORDER BY at, event_id`, [sinceReads])).rows;
  const planRead = (op: Operator) => [op.id, `plan/${plan.planId}`, 'rows:1', null];
  assert.deepEqual(audited.map((r) => [r.actor_id, r.resource, r.result, r.tenant_id]), [planRead(admin), planRead(admin), planRead(support), planRead(support)]);
});

// ------------------------------------------------------------------ 2. crear y clonar

test('crear plan: nace deshabilitado con borrador v1 sugerido SIN confirmar; publicar exige confirmar uno a uno; cambiar un valor le quita la confirmación (también en BD); checksum = plan_revision_checksum(); solo habilitado se asigna; clonar copia sin confirmar', async () => {
  const created = await createPlan(eng, { description: 'Plan de prueba sin aprobación comercial' });
  const rev = created.revisionId;
  const detail: PlanDetailView = (await platform(eng.token, `/plan-catalog/plans/${created.planId}`)).body;
  assert.deepEqual([detail.plan.active, detail.plan.price_cents], [false, null], 'nace deshabilitado y sin precio');
  assert.deepEqual(detail.revisions.map((r) => [r.revision_id, r.version, r.status, r.origin, r.lock_version]), [[rev, 1, 'DRAFT', 'create', 1]]);
  assert.deepEqual(await valuesOf(rev), withState(valuesWith({}), 'suggested', false), 'los 6 valores son los sugeridos del registro, ninguno confirmado');
  const catalogList: CatalogEntry[] = (await platform(support.token, '/plan-catalog/plans')).body.plans;
  const listed = catalogList.find((p) => p.plan_id === created.planId);
  assert.deepEqual([listed?.state, listed?.draft_revision_id, listed?.published_revision_id], ['draft_only', rev, null]);
  const pending: ReviewView = (await platform(eng.token, `/plan-catalog/revisions/${rev}/review`)).body;
  assert.deepEqual([pending.ready, pending.items.length, pending.items.filter((i) => i.confirmed).length], [false, PLAN_PARAMETERS.length, 0]);

  let lock = 1;
  const rejected = await publish(eng, rev, lock);
  assert.deepEqual([rejected.status, rejected.body.error.code], [409, 'validation_error'], 'sugeridos sin confirmar no se publican');
  assert.equal((await setEnabled(eng, created.planId, true)).status, 409, 'sin revisión publicada no se habilita');

  // Confirmar uno a uno; con uno solo pendiente, publicar sigue fallando.
  for (const [i, def] of PLAN_PARAMETERS.entries()) {
    if (i === PLAN_PARAMETERS.length - 1) {
      assert.equal((await publish(eng, rev, lock)).status, 409, 'falta confirmar uno solo');
      assert.equal((await revisionOf(rev)).status, 'DRAFT');
    }
    const res = await patchDraft(eng, rev, lock, [{ key: def.key, confirmed: true }]);
    assert.deepEqual([res.status, res.body.lock_version], [200, lock + 1], JSON.stringify(res.body));
    lock = res.body.lock_version as number;
    assert.equal(Object.values(await valuesOf(rev)).filter((v) => v.confirmed).length, i + 1);
  }
  assert.equal((await platform(eng.token, `/plan-catalog/revisions/${rev}/review`)).body.ready, true);

  // Cambiar un valor confirmado le quita la confirmación (API)…
  const changed = await patchDraft(eng, rev, lock, [{ key: POSTS, value: 7 }]);
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  lock = changed.body.lock_version as number;
  const changes: Change[] = changed.body.diff;
  assert.deepEqual(changes.map((c) => [c.key, c.from, c.to, c.confirmed_from, c.confirmed_to]), [[POSTS, 10, 7, true, false]]);
  assert.deepEqual((await valuesOf(rev))[POSTS], { value: 7, source: 'explicit', confirmed: false });
  assert.equal((await publish(eng, rev, lock)).status, 409);

  // …y también por SQL directo (trigger de la BD).
  lock = (await patchDraft(eng, rev, lock, [{ key: POSTS, confirmed: true }])).body.lock_version as number;
  assert.equal((await valuesOf(rev))[POSTS]?.confirmed, true);
  await t.pool.query('UPDATE plan_parameter_value SET value_int = 8 WHERE revision_id = $1 AND parameter_key = $2', [rev, POSTS]);
  assert.deepEqual((await valuesOf(rev))[POSTS], { value: 8, source: 'explicit', confirmed: false });
  assert.equal((await publish(eng, rev, lock)).status, 409);
  lock = (await patchDraft(eng, rev, lock, [{ key: POSTS, confirmed: true }])).body.lock_version as number;

  // Publicar: checksum devuelto = checksum guardado = plan_revision_checksum() = vista previa de la revisión.
  const ready: ReviewView = (await platform(eng.token, `/plan-catalog/revisions/${rev}/review`)).body;
  assert.equal(ready.ready, true);
  const published = await publish(eng, rev, lock);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const row = await revisionOf(rev);
  assert.deepEqual([row.status, row.checksum, row.computed, ready.checksum_preview, row.published_by],
    ['PUBLISHED', published.body.checksum, published.body.checksum, published.body.checksum, `platform:${eng.id}`]);
  const expected = { ...valuesWith({}), [POSTS]: 8 };
  assert.deepEqual(plainValues(await valuesOf(rev)), expected);

  // Publicado pero deshabilitado: ni asignable ni ofrecido como asignable.
  const biz = await createTenantWithPlan(t, { social_posts: 1 }, 'client_pcnew');
  const original = await subscriptionOf(biz.tenant);
  const refused = await assignPlan(admin, biz.tenant, created.planId);
  assert.deepEqual([refused.status, refused.body.error.code], [409, 'validation_error'], 'un plan deshabilitado no se asigna');
  assert.deepEqual(await subscriptionOf(biz.tenant), original);
  for (const ids of await assignableLists(biz.token)) assert.ok(!ids.includes(created.planId));

  // Habilitar ⇒ asignable; la suscripción queda fijada a v1 y el panel muestra sus valores.
  const enabled = await setEnabled(eng, created.planId, true);
  assert.deepEqual([enabled.status, enabled.body.active], [200, true]);
  for (const ids of await assignableLists(biz.token)) assert.ok(ids.includes(created.planId));
  const assigned = await assignPlan(admin, biz.tenant, created.planId);
  assert.deepEqual([assigned.status, assigned.body.subscription.plan_id, assigned.body.subscription.plan_revision_id], [200, created.planId, rev]);
  const view = await entitlements(biz.token);
  assert.deepEqual([view.revision.revision_id, view.limits['social_posts'], view.limits['conversations']], [rev, 8, 500]);

  // Clonar: plan nuevo deshabilitado con borrador v1 COPIADO de la publicada y sin confirmar.
  const clone = await createPlan(admin, { clone_from_plan_id: created.planId });
  const cloned: PlanDetailView = (await platform(admin.token, `/plan-catalog/plans/${clone.planId}`)).body;
  assert.equal(cloned.plan.active, false);
  assert.deepEqual(cloned.revisions.map((r) => [r.version, r.status, r.origin, r.based_on_revision_id]), [[1, 'DRAFT', 'clone', rev]]);
  assert.deepEqual(await valuesOf(clone.revisionId), withState(expected, 'copied', false));
  assert.equal((await publish(admin, clone.revisionId, 1)).status, 409, 'lo copiado también se confirma uno a uno');
});

// ------------------------------------------------------------------ 3. edición, suscripciones fijadas y migración

test('edición: un borrador por plan; lock_version desfasado ⇒ 409 stale_version sin cambios; diff y motivo en plan_catalog_event; v2 reemplaza a v1 sin mover a los clientes; vista previa con uso sobre el nuevo límite; migración explícita con expected_count; downgrade sin borrados', async () => {
  const plan = await publishedPlan(eng, { social_posts: 5 });
  const v1 = plan.revisionId;
  const biz = await createTenantWithPlan(t, { social_posts: 1 }, 'client_pcedit');
  const postsOfTenant = `SELECT count(*) AS n FROM social_post WHERE tenant_id = $1 AND content_type = 'post'`;
  assert.equal((await assignPlan(admin, biz.tenant, plan.planId)).status, 200);
  for (let i = 1; i <= 3; i += 1) assert.equal((await post(biz.token, i)).status, 201);

  // Nombre y descripción: no versionados, auditados con diff y motivo.
  const meta = await platform(eng.token, `/plan-catalog/plans/${plan.planId}`, 'PATCH', { description: 'Descripción revisada', reason: 'Aclarar la descripción del plan' });
  assert.equal(meta.status, 200, JSON.stringify(meta.body));
  const metaEvents = await catalogEvents<Record<string, unknown>>(`plan_id = $1 AND action = 'plans.plan.update'`, [plan.planId]);
  assert.deepEqual(metaEvents.map((e) => [e.actor_id, e.reason, e.diff]),
    [[`platform:${eng.id}`, 'Aclarar la descripción del plan', { name: { from: plan.name, to: plan.name }, description: { from: null, to: 'Descripción revisada' } }]]);

  // Un solo borrador por plan; copia la publicada SIN confirmar.
  const opened = await platform(eng.token, `/plan-catalog/plans/${plan.planId}/revisions`, 'POST', { reason: REASON });
  assert.deepEqual([opened.status, opened.body.version], [201, 2]);
  const v2 = opened.body.revision_id as string;
  const second = await platform(admin.token, `/plan-catalog/plans/${plan.planId}/revisions`, 'POST', { reason: REASON });
  assert.deepEqual([second.status, second.body.error.code], [409, 'validation_error']);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM plan_revision WHERE plan_id = $1 AND status = 'DRAFT'`, [plan.planId]), 1);
  assert.deepEqual(await valuesOf(v2), withState(valuesWith({ social_posts: 5 }), 'copied', false));

  // lock_version: quien llega con una versión vieja recibe 409 stale_version y no cambia nada.
  const why = 'Bajar las publicaciones del plan de prueba';
  const edited = await patchDraft(eng, v2, 1, [{ key: POSTS, value: 2 }], why);
  assert.deepEqual([edited.status, edited.body.lock_version], [200, 2]);
  const stale = await patchDraft(admin, v2, 1, [{ key: POSTS, value: 4, confirmed: true }]);
  assert.deepEqual([stale.status, stale.body.error.code], [409, 'stale_version']);
  assert.deepEqual([(await valuesOf(v2))[POSTS], (await revisionOf(v2)).lock_version], [{ value: 2, source: 'explicit', confirmed: false }, 2]);
  const updates = await catalogEvents<Change[]>(`revision_id = $1 AND action = 'plans.revision.update'`, [v2]);
  assert.deepEqual(updates.map((e) => [e.actor_id, e.reason, triples(e.diff)]), [[`platform:${eng.id}`, why, [[POSTS, 5, 2]]]]);
  const review: ReviewView = (await platform(support.token, `/plan-catalog/revisions/${v2}/review`)).body;
  assert.deepEqual(triples(review.diff), [[POSTS, 5, 2]], 'la revisión compara contra la publicada');
  assert.deepEqual(review.impact.subscriptions_by_revision, [{ revision_id: v1, version: 1, n: 1 }]);

  // Publicar v2: v1 queda SUPERSEDED.
  const confirmed = await patchDraft(eng, v2, 2, confirmAll());
  const pub = await publish(eng, v2, confirmed.body.lock_version as number);
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.deepEqual([pub.body.version, triples(pub.body.diff)], [2, [[POSTS, 5, 2]]]);
  assert.deepEqual(await statusesOf(plan.planId), [[1, 'SUPERSEDED'], [2, 'PUBLISHED']]);
  // El catálogo avisa de cuántos clientes siguen en revisiones anteriores (candidatos a migrar).
  const catalogState = async () => {
    const list: CatalogEntry[] = (await platform(support.token, '/plan-catalog/plans')).body.plans;
    const entry = list.find((p) => p.plan_id === plan.planId);
    return [entry?.published_revision_id, entry?.subscriptions, entry?.subscriptions_on_older];
  };
  assert.deepEqual(await catalogState(), [v2, 1, 1]);
  const publishedEvents = await catalogEvents<PublishDiff>(`revision_id = $1 AND action = 'plans.revision.publish'`, [v2]);
  assert.deepEqual(publishedEvents.map((e) => [e.reason, e.diff.superseded, triples(e.diff.changes), e.diff.checksum]), [[REASON, v1, [[POSTS, 5, 2]], pub.body.checksum]]);

  // La suscripción sigue fijada a v1: su límite (5) no cambia al publicar.
  assert.deepEqual(await subscriptionOf(biz.tenant), { plan_id: plan.planId, plan_revision_id: v1, status: 'active' });
  let view = await entitlements(biz.token);
  assert.deepEqual([view.revision.revision_id, view.limits['social_posts'], view.usage['social_posts']], [v1, 5, 3]);
  assert.equal((await post(biz.token, 4)).status, 201, 'sigue con el límite de v1');

  // Vista previa: afectados y uso por encima del nuevo límite (downgrade).
  const preview = await platform(support.token, `/plan-catalog/plans/${plan.planId}/migration-preview?to=${v2}`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const affected: PreviewRow[] = preview.body.subscriptions;
  assert.deepEqual(affected.map((s) => [s.tenant_id, s.from_revision_id, s.from_version, s.over_limit]),
    [[biz.tenant, v1, 1, [{ capability: 'social_posts', usage: 4, new_limit: 2 }]]]);

  // expected_count distinto de la vista previa, un negocio que no está o una revisión no vigente ⇒ 409 y nada cambia.
  const reason = 'Migrar el negocio de prueba a la revisión 2';
  const historyBefore = await countRows(t, 'SELECT count(*) AS n FROM subscription_history WHERE tenant_id = $1', [biz.tenant]);
  for (const body of [
    { to_revision_id: v2, tenant_ids: [biz.tenant], expected_count: 2, reason },
    { to_revision_id: v2, tenant_ids: 'all', expected_count: 2, reason },
    { to_revision_id: v2, tenant_ids: [biz.tenant, `client_ausente_${sfx()}`], expected_count: 2, reason },
    { to_revision_id: v1, tenant_ids: 'all', expected_count: 1, reason },
  ]) {
    assert.equal((await migrate(admin, plan.planId, body)).status, 409, JSON.stringify(body));
  }
  assert.deepEqual(await subscriptionOf(biz.tenant), { plan_id: plan.planId, plan_revision_id: v1, status: 'active' });
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM subscription_history WHERE tenant_id = $1', [biz.tenant]), historyBefore);
  assert.deepEqual(await catalogEvents(`plan_id = $1 AND action = 'plans.subscriptions.migrate'`, [plan.planId]), []);

  // Migrar: límites nuevos; los datos existentes quedan; nuevas creaciones bloqueadas por el límite menor.
  const migrated = await migrate(admin, plan.planId, { to_revision_id: v2, tenant_ids: [biz.tenant], expected_count: 1, reason });
  assert.deepEqual([migrated.status, migrated.body.migrated], [200, [biz.tenant]], JSON.stringify(migrated.body));
  assert.deepEqual(await subscriptionOf(biz.tenant), { plan_id: plan.planId, plan_revision_id: v2, status: 'active' });
  view = await entitlements(biz.token);
  assert.deepEqual([view.revision.revision_id, view.revision.version, view.limits['social_posts'], view.usage['social_posts']], [v2, 2, 2, 4]);
  assert.equal(await countRows(t, postsOfTenant, [biz.tenant]), 4, 'downgrade sin borrados');
  const blocked = await post(biz.token, 5);
  assert.deepEqual([blocked.status, blocked.body.error.code], [403, 'limit_exceeded']);
  assert.equal(await countRows(t, postsOfTenant, [biz.tenant]), 4);

  // Historial con actor y motivo; evento visible en la auditoría del negocio; evento del catálogo con recuentos y sin
  // motivo (el motivo es de cada negocio: queda en su historial y en su fila de plataforma, no en el catálogo).
  const history = (await t.pool.query(
    `SELECT change_kind, plan_revision_id, previous_revision_id, actor, reason FROM subscription_history WHERE tenant_id = $1 ORDER BY changed_at DESC LIMIT 1`, [biz.tenant])).rows[0];
  assert.deepEqual(history, { change_kind: 'revision_migration', plan_revision_id: v2, previous_revision_id: v1, actor: `platform:${admin.id}`, reason });
  const audit = await business(biz.token, '/audit');
  assert.equal(audit.status, 200);
  const auditEvents: Array<{ action: string; decision: string }> = audit.body.events;
  assert.ok(auditEvents.some((e) => e.action === 'subscription.revision_migrated' && e.decision === 'allow'), 'el negocio ve la migración en su auditoría');
  const migrations = await catalogEvents(`plan_id = $1 AND action = 'plans.subscriptions.migrate'`, [plan.planId]);
  assert.deepEqual(migrations.map((e) => [e.actor_id, e.revision_id, e.reason, e.diff]), [[`platform:${admin.id}`, v2, null, { migrated: 1, over_limit: 1 }]]);
  assert.equal((await migrate(admin, plan.planId, { to_revision_id: v2, tenant_ids: 'all', expected_count: 1, reason })).status, 409, 'ya no queda nadie por migrar');
  assert.deepEqual(await catalogState(), [v2, 1, 0]);

  // Administration ve el mismo uso y límite efectivos.
  const tenantView: TenantView = (await platform(admin.token, `/tenants/${biz.tenant}`)).body;
  const usage = tenantView.plan_usage.find((u) => u.key === POSTS);
  assert.deepEqual([tenantView.tenant.plan_revision_id, usage?.limit, usage?.usage], [v2, 2, 4]);
});

// ------------------------------------------------------------------ 4. rollback y descarte

test('rollback: revisión nueva PUBLICADA con los valores de la elegida (origen rollback) y el historial completo; con borrador abierto ⇒ 409; solo hacia revisiones reemplazadas; descartar libera el borrador', async () => {
  const v1Values = { social_posts: 5, reviews_managed: 30 };
  const v2Values = { social_posts: 2, reviews_managed: 10 };
  const plan = await publishedPlan(eng, v1Values);
  const v1 = plan.revisionId;
  const d2 = await confirmedDraft(eng, plan.planId, v2Values);
  assert.equal((await publish(eng, d2.revisionId, d2.lock)).status, 200);
  const v2 = d2.revisionId;
  const biz = await createTenantWithPlan(t, { social_posts: 1 }, 'client_pcroll');
  assert.equal((await assignPlan(admin, biz.tenant, plan.planId)).status, 200);
  assert.equal((await subscriptionOf(biz.tenant))?.plan_revision_id, v2);

  const rollback = (to: string) => platform(eng.token, `/plan-catalog/plans/${plan.planId}/rollback`, 'POST', { to_revision_id: to, reason: 'Volver a los valores anteriores del plan' });
  assert.equal((await rollback(v2)).status, 409, 'la publicada vigente no es destino de rollback');

  const back = await rollback(v1);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const v3 = back.body.revision_id as string;
  assert.deepEqual([back.body.version, triples(back.body.diff)], [3, [[POSTS, 2, 5], [REVIEWS, 10, 30]]]);
  const r3 = await revisionOf(v3);
  assert.deepEqual([r3.status, r3.origin, r3.based_on_revision_id, r3.checksum], ['PUBLISHED', 'rollback', v1, r3.computed]);
  assert.equal(r3.checksum, (await revisionOf(v1)).checksum, 'mismos valores ⇒ misma huella');
  assert.deepEqual(await valuesOf(v3), withState(valuesWith(v1Values), 'rollback', true));
  assert.deepEqual(await statusesOf(plan.planId), [[1, 'SUPERSEDED'], [2, 'SUPERSEDED'], [3, 'PUBLISHED']]);
  assert.deepEqual(plainValues(await valuesOf(v1)), valuesWith(v1Values), 'v1 intacta');
  assert.deepEqual(plainValues(await valuesOf(v2)), valuesWith(v2Values), 'v2 intacta');
  assert.equal((await subscriptionOf(biz.tenant))?.plan_revision_id, v2, 'el rollback no mueve a los clientes fijados');
  const restored = await catalogEvents<{ restored_from: string; superseded: string }>(`revision_id = $1`, [v3]);
  assert.deepEqual(restored.map((e) => [e.action, e.diff.restored_from, e.diff.superseded]), [['plans.revision.rollback', v1, v2]]);

  // Con un borrador abierto no se revierte.
  const open = await platform(eng.token, `/plan-catalog/plans/${plan.planId}/revisions`, 'POST', { reason: REASON });
  assert.deepEqual([open.status, open.body.version], [201, 4]);
  const v4 = open.body.revision_id as string;
  const blocked = await rollback(v2);
  assert.deepEqual([blocked.status, blocked.body.error.code], [409, 'validation_error']);
  assert.deepEqual(await statusesOf(plan.planId), [[1, 'SUPERSEDED'], [2, 'SUPERSEDED'], [3, 'PUBLISHED'], [4, 'DRAFT']]);

  // Descartar exige el lock_version vigente; el descartado ya no se edita, no se publica ni es destino de rollback.
  const staleDiscard = await platform(eng.token, `/plan-catalog/revisions/${v4}/discard`, 'POST', { lock_version: 2, reason: REASON });
  assert.deepEqual([staleDiscard.status, staleDiscard.body.error?.code], [409, 'stale_version']);
  assert.equal((await platform(eng.token, `/plan-catalog/revisions/${v4}/discard`, 'POST', { lock_version: 1, reason: REASON })).status, 200);
  assert.equal((await patchDraft(eng, v4, 1, [{ key: POSTS, value: 3 }])).status, 409);
  assert.equal((await publish(eng, v4, 1)).status, 409);
  assert.equal((await rollback(v4)).status, 409);
  assert.equal((await catalogEvents(`revision_id = $1 AND action = 'plans.revision.discard'`, [v4])).length, 1);

  const again = await rollback(v2);
  assert.deepEqual([again.status, again.body.version], [200, 5]);
  assert.deepEqual(plainValues(await valuesOf(again.body.revision_id as string)), valuesWith(v2Values));
  assert.deepEqual(await statusesOf(plan.planId), [[1, 'SUPERSEDED'], [2, 'SUPERSEDED'], [3, 'SUPERSEDED'], [4, 'DISCARDED'], [5, 'PUBLISHED']]);
});

test('descartar el único borrador de un plan nunca publicado ⇒ 409: el plan no queda sin borrador ni revisión publicada', async () => {
  const fresh = await createPlan(eng);
  const refused = await platform(eng.token, `/plan-catalog/revisions/${fresh.revisionId}/discard`, 'POST', { lock_version: 1, reason: REASON });
  assert.deepEqual([refused.status, refused.body.error?.code], [409, 'validation_error'], JSON.stringify(refused.body));
  assert.deepEqual(await statusesOf(fresh.planId), [[1, 'DRAFT']]);
  assert.deepEqual(await catalogEvents(`plan_id = $1 AND action = 'plans.revision.discard'`, [fresh.planId]), []);
  // El borrador sigue siendo publicable.
  const ready = await patchDraft(eng, fresh.revisionId, 1, confirmAll());
  assert.equal((await publish(eng, fresh.revisionId, ready.body.lock_version as number)).status, 200);
});

// ------------------------------------------------------------------ 5. inmutabilidad en BD

test('BD: publicadas y reemplazadas inmutables (valores y revisión); ninguna revisión ni valor se borra; publicar por SQL exige todo confirmado y huella correcta; nunca dos publicadas; plan_catalog_event y subscription_history append-only', async () => {
  const forbidden = '42501'; // insufficient_privilege (triggers de inmutabilidad)
  const plan = await publishedPlan(eng, { social_posts: 6 });
  const v1 = plan.revisionId;
  const d2 = await confirmedDraft(eng, plan.planId, { social_posts: 3 });
  assert.equal((await publish(eng, d2.revisionId, d2.lock)).status, 200);
  const v2 = d2.revisionId;
  const d3 = await confirmedDraft(eng, plan.planId, {});
  const biz = await createTenantWithPlan(t, { social_posts: 1 }, 'client_pcimm');
  assert.equal((await assignPlan(admin, biz.tenant, plan.planId)).status, 200);
  // Antes y después deben leerse exactamente igual.
  const snapshot = async () => ({ v1: await valuesOf(v1), v2: await valuesOf(v2), r1: await revisionOf(v1), r2: await revisionOf(v2), statuses: await statusesOf(plan.planId) });
  const before = await snapshot();

  for (const rev of [v1, v2]) {
    assert.equal(await sqlState('UPDATE plan_parameter_value SET value_int = 0 WHERE revision_id = $1 AND parameter_key = $2', [rev, POSTS]), forbidden);
    assert.equal(await sqlState('UPDATE plan_parameter_value SET confirmed_at = NULL, confirmed_by = NULL WHERE revision_id = $1', [rev]), forbidden);
    assert.equal(await sqlState('DELETE FROM plan_parameter_value WHERE revision_id = $1', [rev]), forbidden);
  }
  assert.equal(await sqlState(`UPDATE plan_revision SET publish_reason = 'Motivo reescrito por SQL' WHERE revision_id = $1`, [v2]), forbidden);
  assert.equal(await sqlState(`UPDATE plan_revision SET checksum = repeat('0', 64) WHERE revision_id = $1`, [v2]), forbidden);
  assert.equal(await sqlState(`UPDATE plan_revision SET status = 'DRAFT', published_at = NULL, published_by = NULL, publish_reason = NULL, checksum = NULL WHERE revision_id = $1`, [v2]), forbidden);
  assert.equal(await sqlState(`UPDATE plan_revision SET status = 'PUBLISHED', superseded_at = NULL WHERE revision_id = $1`, [v1]), forbidden);
  for (const rev of [v1, v2, d3.revisionId]) assert.equal(await sqlState('DELETE FROM plan_revision WHERE revision_id = $1', [rev]), forbidden, `DELETE ${rev}`);
  assert.equal(await sqlState('DELETE FROM plan_parameter_value WHERE revision_id = $1', [d3.revisionId]), forbidden, 'ni los valores de un borrador');

  // Nunca dos publicadas: un borrador completo y con huella correcta no se publica junto a v2.
  assert.equal(await sqlState(
    `UPDATE plan_revision SET status = 'PUBLISHED', published_by = 'sql', published_at = now(), publish_reason = 'Publicación paralela por SQL',
            checksum = plan_revision_checksum(revision_id) WHERE revision_id = $1`, [d3.revisionId]), '23505');
  // Una revisión no nace publicada.
  assert.equal(await sqlState(
    `INSERT INTO plan_revision (revision_id, plan_id, version, status, origin, registry_version, reason, created_by, published_by, published_at, publish_reason, checksum)
     VALUES ($1, $2, 99, 'PUBLISHED', 'create', 1, 'Revisión creada ya publicada', 'sql', 'sql', now(), 'Revisión creada ya publicada', repeat('a', 64))`,
    [`prv_sql_${sfx()}`, plan.planId]), '23514');

  // Publicar por SQL exige todos los valores confirmados y la huella de sus valores.
  const fresh = await createPlan(eng);
  const partial = await patchDraft(eng, fresh.revisionId, 1, confirmAll().slice(1));
  assert.equal(await sqlState(
    `UPDATE plan_revision SET status = 'PUBLISHED', published_by = 'sql', published_at = now(), publish_reason = 'Publicación directa por SQL',
            checksum = plan_revision_checksum(revision_id) WHERE revision_id = $1`, [fresh.revisionId]), '23514', 'un valor sin confirmar');
  assert.equal((await patchDraft(eng, fresh.revisionId, partial.body.lock_version as number, confirmAll())).status, 200);
  assert.equal(await sqlState(
    `UPDATE plan_revision SET status = 'PUBLISHED', published_by = 'sql', published_at = now(), publish_reason = 'Publicación directa por SQL',
            checksum = repeat('0', 64) WHERE revision_id = $1`, [fresh.revisionId]), '23514', 'huella que no corresponde a los valores');
  assert.equal((await revisionOf(fresh.revisionId)).status, 'DRAFT');

  // Append-only.
  assert.equal(await sqlState(`UPDATE plan_catalog_event SET reason = 'Motivo reescrito por SQL' WHERE plan_id = $1`, [plan.planId]), forbidden);
  assert.equal(await sqlState('DELETE FROM plan_catalog_event WHERE plan_id = $1', [plan.planId]), forbidden);
  assert.ok(await countRows(t, 'SELECT count(*) AS n FROM subscription_history WHERE tenant_id = $1', [biz.tenant]) >= 2);
  assert.equal(await sqlState(`UPDATE subscription_history SET reason = 'Motivo reescrito por SQL' WHERE tenant_id = $1`, [biz.tenant]), forbidden);
  assert.equal(await sqlState('DELETE FROM subscription_history WHERE tenant_id = $1', [biz.tenant]), forbidden);

  assert.deepEqual(await snapshot(), before, 'nada cambió');
  assert.equal(await publishedCount(plan.planId), 1);
});

// ------------------------------------------------------------------ 6. espejo del registro

test('espejo del registro: si plan_parameter_definition difiere del registro, toda escritura del catálogo da 503 sin efectos; lecturas y enforcement siguen; /plan-catalog/parameters informa la diferencia', async () => {
  const plan = await publishedPlan(eng, { social_posts: 2 });
  const draft = await platform(eng.token, `/plan-catalog/plans/${plan.planId}/revisions`, 'POST', { reason: REASON });
  assert.equal(draft.status, 201);
  const draftId = draft.body.revision_id as string;
  const biz = await createTenantWithPlan(t, { social_posts: 1 }, 'client_pcmirror');
  assert.equal((await assignPlan(admin, biz.tenant, plan.planId)).status, 200);

  const registry = async () => {
    const res = await platform(support.token, '/plan-catalog/parameters');
    assert.equal(res.status, 200);
    const parameters: Array<{ key: string }> = res.body.parameters;
    assert.deepEqual(parameters.map((p) => p.key), PLAN_PARAMETERS.map((d) => d.key), 'los parámetros salen del registro de código');
    const state: { consistent: boolean; differences: string[] } = res.body.registry;
    return state;
  };
  assert.deepEqual(await registry(), { consistent: true, differences: [] });

  const agents = keyOf('agents');
  const extraKey = `quota.zz${sfx()}.max`;
  const original = (await t.pool.query<{ max_value: number }>('SELECT max_value FROM plan_parameter_definition WHERE parameter_key = $1', [agents])).rows[0]?.max_value;
  assert.equal(typeof original, 'number');
  const writes = catalogWrites(plan.planId, plan.revisionId, draftId);
  const initial = await fingerprint(plan.planId, biz.tenant);
  const reads = ['/plan-catalog/plans', `/plan-catalog/plans/${plan.planId}`, `/plan-catalog/revisions/${draftId}/review`,
    `/plan-catalog/plans/${plan.planId}/migration-preview?to=${plan.revisionId}`, '/plans', `/tenants/${biz.tenant}`];
  const assertWritesBlocked = async () => {
    for (const w of writes) {
      const res = await send(admin, w);
      assert.deepEqual([res.status, res.body?.error?.code], [503, 'internal_error'], `${w.method} ${w.path}`);
    }
  };
  try {
    // Una columna distinta en la BD.
    await t.pool.query('UPDATE plan_parameter_definition SET max_value = max_value - 1 WHERE parameter_key = $1', [agents]);
    const changed = await registry();
    assert.equal(changed.consistent, false);
    assert.equal(changed.differences.length, 1);
    assert.ok(changed.differences[0]?.startsWith(`${agents}.`), 'identifica el parámetro que difiere');
    await assertWritesBlocked();
    for (const path of reads) assert.equal((await platform(admin.token, path)).status, 200, `lectura ${path}`);
    // Enforcement con lo publicado: el límite de 2 publicaciones sigue aplicándose.
    assert.deepEqual([(await post(biz.token, 1)).status, (await post(biz.token, 2)).status, (await post(biz.token, 3)).status], [201, 201, 403]);
    const view = await entitlements(biz.token);
    assert.deepEqual([view.revision.revision_id, view.limits['social_posts'], view.usage['social_posts']], [plan.revisionId, 2, 2]);

    // Una definición que existe en la BD pero no en el registro.
    await t.pool.query('UPDATE plan_parameter_definition SET max_value = $2 WHERE parameter_key = $1', [agents, original]);
    await t.pool.query(
      `INSERT INTO plan_parameter_definition (parameter_key, capability, category, label, description, unit, value_type, semantics, period_kind,
                                              window_seconds, min_value, max_value, ceiling_reason, suggested_int, suggested_bool, enforcement_state, registry_version, sort_order)
       VALUES ($1, NULL, 'Prueba', 'Parámetro ajeno', 'Solo existe en la BD', 'unidades', 'bool', 'eligibility', 'none', NULL, 0, 1, 'prueba', NULL, true, 'not_enforced', 1, 999)`,
      [extraKey]);
    const extra = await registry();
    assert.equal(extra.consistent, false);
    assert.equal(extra.differences.length, 1);
    assert.ok(extra.differences[0]?.startsWith(`${extraKey}:`), 'identifica la definición ajena al registro');
    await assertWritesBlocked();
  } finally {
    await t.pool.query('UPDATE plan_parameter_definition SET max_value = $2 WHERE parameter_key = $1', [agents, original]);
    await t.pool.query('DELETE FROM plan_parameter_definition WHERE parameter_key = $1', [extraKey]);
  }
  assert.deepEqual(await fingerprint(plan.planId, biz.tenant), initial, 'ninguna escritura bloqueada cambió nada');
  assert.deepEqual(await registry(), { consistent: true, differences: [] });
  const resumed = await patchDraft(eng, draftId, 1, [{ key: POSTS, value: 3 }]);
  assert.deepEqual([resumed.status, resumed.body.lock_version], [200, 2], 'restaurado el espejo, se vuelve a escribir');
});

// ------------------------------------------------------------------ 7. concurrencia

test('concurrencia: publicaciones simultáneas del mismo borrador ⇒ gana una; PATCH simultáneos con el mismo lock_version ⇒ gana uno; borradores simultáneos ⇒ uno; nunca dos PUBLISHED del mismo plan', async () => {
  const plan = await createPlan(eng);
  const ready = await patchDraft(eng, plan.revisionId, 1, confirmAll({ social_posts: 4 }));
  const lock = ready.body.lock_version as number;
  const publishes = await Promise.all([eng, admin, eng, admin].map((op) => publish(op, plan.revisionId, lock)));
  assert.deepEqual(publishes.map((r) => r.status).sort(), [200, 409, 409, 409]);
  assert.equal(await publishedCount(plan.planId), 1);
  assert.equal((await catalogEvents(`revision_id = $1 AND action = 'plans.revision.publish'`, [plan.revisionId])).length, 1);

  const drafts = await Promise.all([eng, admin, eng].map((op) => platform(op.token, `/plan-catalog/plans/${plan.planId}/revisions`, 'POST', { reason: REASON })));
  assert.deepEqual(drafts.map((r) => r.status).sort(), [201, 409, 409]);
  const draft = drafts.find((r) => r.status === 201)?.body.revision_id as string;
  assert.deepEqual(await statusesOf(plan.planId), [[1, 'PUBLISHED'], [2, 'DRAFT']]);

  let current = 1;
  for (let round = 0; round < 5; round += 1) {
    const offers = [10 + round, 20 + round];
    const results = await Promise.all([
      patchDraft(eng, draft, current, [{ key: POSTS, value: offers[0] }]),
      patchDraft(admin, draft, current, [{ key: POSTS, value: offers[1] }]),
    ]);
    const winner = results.findIndex((r) => r.status === 200);
    assert.equal(results.filter((r) => r.status === 200).length, 1, `ronda ${round}: ${results.map((r) => r.status).join(',')}`);
    const loser = results[1 - winner];
    assert.deepEqual([loser?.status, loser?.body.error?.code], [409, 'stale_version']);
    assert.deepEqual([(await revisionOf(draft)).lock_version, (await valuesOf(draft))[POSTS]?.value], [current + 1, offers[winner]]);
    current += 1;
  }
  assert.equal((await catalogEvents(`revision_id = $1 AND action = 'plans.revision.update'`, [draft])).length, 5);

  // Publicar el borrador mientras otro operador revierte: sea cual sea el orden, una sola publicada.
  const confirmed = await patchDraft(eng, draft, current, confirmAll());
  const [published, reverted] = await Promise.all([
    publish(eng, draft, confirmed.body.lock_version as number),
    platform(admin.token, `/plan-catalog/plans/${plan.planId}/rollback`, 'POST', { to_revision_id: plan.revisionId, reason: REASON }),
  ]);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.ok([200, 409].includes(reverted.status), JSON.stringify(reverted.body));
  assert.equal(await publishedCount(plan.planId), 1);
});

test('concurrencia: clonar mientras se publica el plan de origen copia la revisión que quedó publicada', async () => {
  const source = await publishedPlan(eng, { social_posts: 5 });
  const d2 = await confirmedDraft(eng, source.planId, { social_posts: 2 });
  // Una sesión retiene el registro de eventos: la publicación queda detenida a mitad (v1 ya reemplazada, sin
  // confirmar, plan retenido) y el clon llega mientras tanto.
  const holder = await t.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE plan_catalog_event IN SHARE MODE');
    const publishing = publish(eng, d2.revisionId, d2.lock);
    await lockWaiters(1);
    const cloning = platform(admin.token, '/plan-catalog/plans', 'POST', { name: `Clon concurrente ${sfx()}`, clone_from_plan_id: source.planId, reason: REASON });
    await lockWaiters(2);
    await holder.query('ROLLBACK');
    const [published, cloned] = await Promise.all([publishing, cloning]);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(cloned.status, 201, JSON.stringify(cloned.body));
    const copy: PlanDetailView = (await platform(admin.token, `/plan-catalog/plans/${cloned.body.plan_id}`)).body;
    assert.deepEqual(copy.revisions.map((r) => [r.version, r.status, r.origin, r.based_on_revision_id]), [[1, 'DRAFT', 'clone', d2.revisionId]]);
    assert.deepEqual(await valuesOf(cloned.body.revision_id as string), withState(valuesWith({ social_posts: 2 }), 'copied', false));
  } finally {
    await holder.query('ROLLBACK'); // sin efecto si ya terminó; libera la tabla si algo falló antes
    holder.release();
  }
});

test('concurrencia de suscripciones: asignar mientras se publica fija la revisión publicada al confirmar (sin error); migraciones simultáneas del mismo negocio ⇒ una gana, con un solo historial y un solo evento', async () => {
  const plan = await publishedPlan(eng, { social_posts: 5 });
  const d2 = await confirmedDraft(eng, plan.planId, { social_posts: 3 });
  const biz = await createTenantWithPlan(t, { social_posts: 1 }, 'client_pcrace');

  // Orden fijado: una sesión retiene el plan; la publicación espera primero y la asignación, detrás de ella.
  const holder = await t.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM plan WHERE plan_id = $1 FOR UPDATE', [plan.planId]);
    const publishing = publish(eng, d2.revisionId, d2.lock);
    await lockWaiters(1);
    const assigning = assignPlan(admin, biz.tenant, plan.planId);
    await lockWaiters(2);
    await holder.query('ROLLBACK');
    const [published, assigned] = await Promise.all([publishing, assigning]);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.deepEqual([assigned.body.subscription?.plan_revision_id, (await subscriptionOf(biz.tenant))?.plan_revision_id], [d2.revisionId, d2.revisionId],
      'la asignación esperó a la publicación y fijó la revisión publicada al confirmar');
  } finally {
    await holder.query('ROLLBACK'); // sin efecto si ya terminó; libera el plan si algo falló antes
    holder.release();
  }

  // Migraciones simultáneas del mismo negocio: gana una; un solo historial y un solo evento del negocio y del catálogo.
  const d3 = await confirmedDraft(eng, plan.planId, { social_posts: 4 });
  assert.equal((await publish(eng, d3.revisionId, d3.lock)).status, 200);
  const historyBefore = (await historyOf(biz.tenant)).length;
  const body = { to_revision_id: d3.revisionId, tenant_ids: 'all', expected_count: 1, reason: 'Migración simultánea de prueba' };
  const results = await Promise.all([1, 2, 3].map(() => migrate(admin, plan.planId, body)));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal((await subscriptionOf(biz.tenant))?.plan_revision_id, d3.revisionId);
  const history = await historyOf(biz.tenant);
  assert.equal(history.length, historyBefore + 1);
  assert.deepEqual([history.at(-1)?.change_kind, history.at(-1)?.previous_revision_id], ['revision_migration', d2.revisionId]);
  assert.equal(await countRows(t, `SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1 AND action = 'subscription.revision_migrated'`, [biz.tenant]), 1);
  assert.equal((await catalogEvents(`plan_id = $1 AND action = 'plans.subscriptions.migrate'`, [plan.planId])).length, 1);
});

test('concurrencia: asignar mientras se confirma la baja del negocio espera a la baja y se rechaza (409); la suscripción queda cancelada', async () => {
  const plan = await publishedPlan(eng, { social_posts: 2 });
  const biz = await createTenantWithPlan(t, { social_posts: 1 }, 'client_pcexit');
  const holder = await t.pool.connect();
  try {
    // Lo que hace confirmExit en su transacción (negocio en baja, suscripción cancelada), retenido sin confirmar.
    await holder.query('BEGIN');
    await holder.query(`UPDATE client SET status = 'exiting' WHERE client_id = $1`, [biz.tenant]);
    const assigning = assignPlan(admin, biz.tenant, plan.planId);
    await lockWaiters(1);
    await holder.query(`UPDATE subscription SET status = 'cancelled' WHERE tenant_id = $1`, [biz.tenant]);
    await holder.query('COMMIT');
    const assigned = await assigning;
    assert.deepEqual([assigned.status, assigned.body.error?.code], [409, 'validation_error'], JSON.stringify(assigned.body));
  } finally {
    await holder.query('ROLLBACK'); // sin efecto si ya terminó; libera el negocio si algo falló antes
    holder.release();
  }
  const subscription = await subscriptionOf(biz.tenant);
  assert.deepEqual([subscription?.plan_id, subscription?.status], [biz.plan, 'cancelled'], 'la baja no queda con una suscripción activa');
});

// ------------------------------------------------------------------ asignación y validación

test('asignación de Administration: alta, repetición sin cambios (auditada como noop), reactivación que conserva la revisión, migración de revisión y cambio de plan quedan en el historial con su tipo, actor y motivo, y en ambas auditorías; el mismo plan en una revisión anterior ⇒ 409 (se migra con vista previa); negocio inexistente ⇒ 404; plan inexistente ⇒ 409', async () => {
  const plan = await publishedPlan(eng, { social_posts: 2 });
  const other = await publishedPlan(eng, { social_posts: 1 });
  const tenant = `client_pcnosub_${sfx()}`;
  await t.pool.query(`INSERT INTO client (client_id, business_name, status, contact_email, metadata) VALUES ($1, $2, 'active', $3, '{}')`, [tenant, `Negocio ${tenant}`, `${tenant}@example.com`]);
  const actor = `platform:${admin.id}`;
  const reason = 'Asignación de Administration en la prueba';
  const migration = 'Migrar el negocio de la prueba a la revisión 2';

  const first = await assignPlan(admin, tenant, plan.planId);
  assert.deepEqual([first.status, first.body.changed, first.body.subscription?.plan_revision_id], [200, true, plan.revisionId]);
  const same = await assignPlan(admin, tenant, plan.planId);
  assert.deepEqual([same.status, same.body.changed], [200, false]);

  // Publicar v2 no mueve al negocio y «asignar» el mismo plan tampoco: 409, nada cambia; se migra con vista previa.
  const d2 = await confirmedDraft(eng, plan.planId, { social_posts: 6 });
  assert.equal((await publish(eng, d2.revisionId, d2.lock)).status, 200);
  const pinned = await fingerprint(plan.planId, tenant);
  const refused = await assignPlan(admin, tenant, plan.planId);
  assert.deepEqual([refused.status, refused.body.error?.code], [409, 'validation_error']);
  assert.deepEqual(await fingerprint(plan.planId, tenant), pinned, 'ni la suscripción ni su historial cambian');

  // Reactivar una suscripción suspendida (por SQL) con el mismo plan conserva su revisión v1: no es una migración.
  await t.pool.query(`UPDATE subscription SET status = 'suspended' WHERE tenant_id = $1`, [tenant]);
  const reactivated = await assignPlan(admin, tenant, plan.planId);
  assert.deepEqual([reactivated.status, reactivated.body.changed, reactivated.body.subscription?.plan_revision_id, reactivated.body.subscription?.status],
    [200, true, plan.revisionId, 'active']);
  assert.equal((await migrate(admin, plan.planId, { to_revision_id: d2.revisionId, tenant_ids: [tenant], expected_count: 1, reason: migration })).status, 200);
  assert.equal((await assignPlan(admin, tenant, other.planId)).status, 200);
  // El historial también registra la suspensión por SQL (actor `sql:…`); aquí, solo lo que hizo Administration.
  const byAdministration = (await historyOf(tenant)).filter((h) => h.actor === actor);
  assert.deepEqual(byAdministration.map((h) => [h.change_kind, h.plan_id, h.plan_revision_id, h.previous_plan_id, h.previous_revision_id, h.reason]), [
    ['assign', plan.planId, plan.revisionId, null, null, reason],
    ['status_change', plan.planId, plan.revisionId, plan.planId, plan.revisionId, reason],
    ['revision_migration', plan.planId, d2.revisionId, plan.planId, plan.revisionId, migration],
    ['plan_change', other.planId, other.revisionId, plan.planId, d2.revisionId, reason],
  ]);
  const businessAudit = (await t.pool.query<{ action: string; n: number }>(
    `SELECT action, count(*)::int AS n FROM audit_event WHERE tenant_id = $1 AND decision = 'allow' AND action LIKE 'subscription.%' GROUP BY action`, [tenant])).rows;
  assert.deepEqual(Object.fromEntries(businessAudit.map((r) => [r.action, r.n])), { 'subscription.plan_assigned': 3, 'subscription.revision_migrated': 1 },
    'cada cambio queda en la auditoría del negocio; la repetición y el 409 no');
  // Plataforma: cada asignación permitida con actor y motivo, también la repetición sin cambios (noop); el 409 no.
  const platformResults = (await t.pool.query<{ result: string }>(
    `SELECT result FROM platform_audit_event WHERE tenant_id = $1 AND action = 'platform.tenant.plan' AND actor_id = $2 AND reason = $3 ORDER BY at, event_id`,
    [tenant, admin.id, reason])).rows.map((r) => r.result);
  assert.deepEqual([platformResults.length, platformResults.filter((r) => r === 'noop').length], [4, 1]);

  const historyCount = (await historyOf(tenant)).length;
  assert.equal((await assignPlan(admin, `client_ausente_${sfx()}`, plan.planId)).status, 404);
  assert.equal((await assignPlan(admin, tenant, `plan_ausente_${sfx()}`)).status, 409);
  assert.equal((await platform(admin.token, `/tenants/${tenant}/plan`, 'POST', { plan_id: plan.planId, reason: 'corto' })).status, 400);
  assert.equal((await historyOf(tenant)).length, historyCount, 'los intentos fallidos no dejan historial');
  assert.equal((await subscriptionOf(tenant))?.plan_id, other.planId);
});

test('validación: valores fuera de tipo, rango o registro ⇒ 400 sin tocar el borrador; motivo de 10 a 500 caracteres; nombre repetido ⇒ 409; revisiones de otro plan no son destino de rollback ni de migración', async () => {
  const plan = await createPlan(eng);
  const outsider = `client_ausente_${sfx()}`;
  const initial = await fingerprint(plan.planId, outsider);
  const website = keyOf('website');
  for (const values of [
    [],
    [...confirmAll(), { key: POSTS, confirmed: true }],
    [{ key: website, value: 2 }],
    [{ key: POSTS, value: -1 }],
    [{ key: POSTS, value: 1.5 }],
    [{ key: POSTS, value: '3' }],
    [{ key: POSTS, value: true }],
    [{ key: POSTS, value: 1_000_001 }],
    [{ key: 'quota.inexistente.max', value: 1 }],
    [{ key: POSTS, value: 3 }, { key: POSTS, confirmed: true }],
    [{ key: POSTS, value: null, confirmed: true }],
    [{ key: POSTS, confirmed: 'sí' }],
  ]) {
    const res = await patchDraft(eng, plan.revisionId, 1, values);
    assert.deepEqual([res.status, res.body?.error?.code], [400, 'validation_error'], JSON.stringify(values));
  }
  for (const reason of [undefined, 'corto', ' '.repeat(20), 'x'.repeat(501)]) {
    const attempts = [
      await platform(eng.token, '/plan-catalog/plans', 'POST', { name: `Plan sin motivo ${sfx()}`, reason }),
      await platform(eng.token, `/plan-catalog/plans/${plan.planId}`, 'PATCH', { description: 'Sin motivo', reason }),
      await platform(eng.token, `/plan-catalog/revisions/${plan.revisionId}`, 'PATCH', { lock_version: 1, values: [{ key: POSTS, value: 3 }], reason }),
      await platform(eng.token, `/plan-catalog/revisions/${plan.revisionId}/publish`, 'POST', { lock_version: 1, reason }),
      await platform(eng.token, `/plan-catalog/plans/${plan.planId}/status`, 'POST', { enabled: false, reason }),
    ];
    for (const res of attempts) assert.deepEqual([res.status, res.body?.error?.code], [400, 'validation_error'], `motivo ${JSON.stringify(reason)}`);
  }
  for (const name of ['ab', 'x'.repeat(61)]) {
    assert.equal((await platform(eng.token, '/plan-catalog/plans', 'POST', { name, reason: REASON })).status, 400, `nombre ${name}`);
  }
  assert.deepEqual(await fingerprint(plan.planId, outsider), initial, 'ningún intento inválido cambió nada');
  const duplicate = await platform(eng.token, '/plan-catalog/plans', 'POST', { name: plan.name.toUpperCase(), reason: REASON });
  assert.deepEqual([duplicate.status, duplicate.body.error?.code], [409, 'validation_error'], 'el nombre se compara sin distinguir mayúsculas');
  for (const source of [plan.planId, `plan_ausente_${sfx()}`]) {
    const clone = await platform(eng.token, '/plan-catalog/plans', 'POST', { name: `Clon ${sfx()}`, clone_from_plan_id: source, reason: REASON });
    assert.equal(clone.status, 409, 'solo se clona una revisión publicada');
  }

  // Revisiones de otro plan no sirven de destino.
  const a = await publishedPlan(eng, { social_posts: 5 });
  const a2 = await confirmedDraft(eng, a.planId, { social_posts: 3 });
  assert.equal((await publish(eng, a2.revisionId, a2.lock)).status, 200);
  const b = await publishedPlan(eng, { social_posts: 6 });
  const b2 = await confirmedDraft(eng, b.planId, { social_posts: 2 });
  assert.equal((await publish(eng, b2.revisionId, b2.lock)).status, 200);
  const crossRollback = await platform(eng.token, `/plan-catalog/plans/${b.planId}/rollback`, 'POST', { to_revision_id: a.revisionId, reason: REASON });
  assert.deepEqual([crossRollback.status, crossRollback.body.error?.code], [409, 'validation_error'], 'una revisión reemplazada de otro plan no es destino');
  assert.equal((await platform(support.token, `/plan-catalog/plans/${b.planId}/migration-preview?to=${a2.revisionId}`)).status, 409);
  assert.equal((await migrate(admin, b.planId, { to_revision_id: a2.revisionId, tenant_ids: 'all', expected_count: 1, reason: REASON })).status, 409);
  assert.deepEqual(await statusesOf(b.planId), [[1, 'SUPERSEDED'], [2, 'PUBLISHED']]);
  assert.equal((await platform(support.token, `/plan-catalog/plans/plan_ausente_${sfx()}`)).status, 404);
  assert.equal((await platform(support.token, `/plan-catalog/revisions/prv_ausente_${sfx()}/review`)).status, 404);
  assert.equal((await patchDraft(eng, `prv_ausente_${sfx()}`, 1, [{ key: POSTS, value: 3 }])).status, 404);
});

test('textos: motivo, nombre y descripción se miden en caracteres reales y no admiten caracteres de control ni de formato; los del catálogo y de la asignación tampoco correos ni ids de negocio (400, nada cambia); al límite se guardan íntegros, también en la auditoría de plataforma', async () => {
  const plan = await publishedPlan(eng, { social_posts: 2 });
  const biz = await createTenantWithPlan(t, { social_posts: 1 }, 'client_pctext');
  const initial = await fingerprint(plan.planId, biz.tenant);
  const emoji = '😀'; // 1 carácter real, 2 unidades UTF-16
  const unsafe = ['con un nulo \u0000 en medio', 'con un espacio de ancho\u200Bcero', 'con una marca bidi \u202E al revés'];
  const tenantData = ['pedido por dueno@negocio-prueba.example', 'pedido por client_abc123 en soporte'];
  const rejected = (res: { status: number; body: { error?: { code?: string } } }, what: string) =>
    assert.deepEqual([res.status, res.body?.error?.code], [400, 'validation_error'], what);

  for (const reason of [emoji.repeat(5), emoji.repeat(501), ...[...unsafe, ...tenantData].map((s) => `Motivo ${s}`)]) {
    for (const res of [
      await platform(eng.token, '/plan-catalog/plans', 'POST', { name: `Plan textos ${sfx()}`, reason }),
      await platform(eng.token, `/plan-catalog/plans/${plan.planId}`, 'PATCH', { description: 'Descripción válida del plan', reason }),
      await platform(eng.token, `/plan-catalog/plans/${plan.planId}/status`, 'POST', { enabled: true, reason }),
      await migrate(admin, plan.planId, { to_revision_id: plan.revisionId, tenant_ids: 'all', expected_count: 1, reason }),
    ]) rejected(res, `motivo del catálogo ${JSON.stringify(reason)}`);
  }
  // El motivo de Administration (asignar) sigue las mismas reglas: queda en subscription_history y en la auditoría de
  // plataforma, y un correo o el id de otro negocio bloquearía la anonimización de ese otro negocio.
  for (const reason of [emoji.repeat(5), emoji.repeat(501), ...[...unsafe, ...tenantData].map((s) => `Motivo ${s}`)]) {
    rejected(await platform(admin.token, `/tenants/${biz.tenant}/plan`, 'POST', { plan_id: plan.planId, reason }), `motivo de plataforma ${JSON.stringify(reason)}`);
  }
  for (const name of [emoji.repeat(2), emoji.repeat(61), `Plan \u0007 ${sfx()}`, `Plan\u200B oculto ${sfx()}`, 'Plan de ventas@negocio-prueba.example', 'Plan client_abc123']) {
    for (const res of [
      await platform(eng.token, '/plan-catalog/plans', 'POST', { name, reason: REASON }),
      await platform(eng.token, `/plan-catalog/plans/${plan.planId}`, 'PATCH', { name, reason: REASON }),
    ]) rejected(res, `nombre ${JSON.stringify(name)}`);
  }
  for (const description of [emoji.repeat(301), 'Descripción con una marca bidi \u202E', 'Escribe a dueno@negocio-prueba.example', 'Solo para client_abc123']) {
    for (const res of [
      await platform(eng.token, '/plan-catalog/plans', 'POST', { name: `Plan textos ${sfx()}`, description, reason: REASON }),
      await platform(eng.token, `/plan-catalog/plans/${plan.planId}`, 'PATCH', { description, reason: REASON }),
    ]) rejected(res, `descripción ${JSON.stringify(description)}`);
  }
  assert.deepEqual(await fingerprint(plan.planId, biz.tenant), initial, 'ningún texto rechazado cambió nada');

  // Al límite en caracteres reales (el doble en unidades UTF-16): se acepta y se guarda sin recortar.
  const reason = emoji.repeat(500);
  const name = `${emoji.repeat(51)} ${sfx()}`; // 60 caracteres
  const description = emoji.repeat(300);
  const created = await platform(eng.token, '/plan-catalog/plans', 'POST', { name, description, reason });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const stored = (await t.pool.query<{ name: string; description: string; reason: string }>(
    'SELECT p.name, p.description, r.reason FROM plan p JOIN plan_revision r ON r.plan_id = p.plan_id WHERE r.revision_id = $1', [created.body.revision_id])).rows[0];
  assert.deepEqual(stored, { name, description, reason });
  const catalogReasons = (await catalogEvents(`plan_id = $1 AND action = 'plans.plan.create'`, [created.body.plan_id])).map((e) => e.reason);
  const platformReasons = (await t.pool.query<{ reason: string }>(`SELECT reason FROM platform_audit_event WHERE action = 'plans.plan.create' AND resource = $1`,
    [`plan_revision/${created.body.revision_id}`])).rows.map((r) => r.reason);
  assert.deepEqual([catalogReasons, platformReasons], [[reason], [reason]]);
  const assigned = await platform(admin.token, `/tenants/${biz.tenant}/plan`, 'POST', { plan_id: plan.planId, reason });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const assignReasons = (await t.pool.query<{ reason: string }>(`SELECT reason FROM platform_audit_event WHERE tenant_id = $1 AND action = 'platform.tenant.plan'`,
    [biz.tenant])).rows.map((r) => r.reason);
  assert.deepEqual(assignReasons, [reason]);
});

test('borrador sin la fila de un parámetro (creado por SQL): guardar ese valor inserta la fila, el diff solo lista lo guardado y el borrador se puede publicar', async () => {
  const planId = `plan_sql_${sfx()}`;
  const revisionId = `prv_sql_${sfx()}`;
  await t.pool.query(`INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active, created_by) VALUES ($1, $2, NULL, NULL, NULL, false, false, 'sql')`,
    [planId, `Plan por SQL ${sfx()}`]);
  await t.pool.query(`INSERT INTO plan_revision (revision_id, plan_id, version, status, origin, registry_version, reason, created_by)
                      VALUES ($1, $2, 1, 'DRAFT', 'create', 1, 'Borrador creado por SQL en la prueba', 'sql')`, [revisionId, planId]);
  for (const def of PLAN_PARAMETERS.filter((d) => d.key !== POSTS)) {
    await t.pool.query(`INSERT INTO plan_parameter_value (revision_id, parameter_key, value_int, source, updated_by) VALUES ($1, $2, $3, 'suggested', 'sql')`,
      [revisionId, def.key, def.suggested]);
  }
  assert.equal((await valuesOf(revisionId))[POSTS], undefined, 'al borrador le falta la fila');

  const saved = await patchDraft(eng, revisionId, 1, [{ key: POSTS, value: 4, confirmed: true }]);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(triples(saved.body.diff), [[POSTS, null, 4]]);
  assert.deepEqual((await valuesOf(revisionId))[POSTS], { value: 4, source: 'explicit', confirmed: true }, 'lo que lista el diff quedó guardado');
  const updates = await catalogEvents<Change[]>(`revision_id = $1 AND action = 'plans.revision.update'`, [revisionId]);
  assert.deepEqual(updates.map((e) => triples(e.diff)), [[[POSTS, null, 4]]]);
  const ready = await patchDraft(eng, revisionId, saved.body.lock_version as number, confirmAll());
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal((await publish(eng, revisionId, ready.body.lock_version as number)).status, 200);
  assert.equal((await revisionOf(revisionId)).status, 'PUBLISHED');
});

test('escritura permitida sin cambio: habilitar un plan ya habilitado responde 200, no toca el plan ni su historial y queda en la auditoría de plataforma como noop', async () => {
  const plan = await publishedPlan(eng, { social_posts: 2 });
  const outsider = `client_ausente_${sfx()}`;
  const initial = await fingerprint(plan.planId, outsider);
  const since = await dbNow();
  const again = await setEnabled(eng, plan.planId, true);
  assert.deepEqual([again.status, again.body.active], [200, true]);
  assert.deepEqual(await fingerprint(plan.planId, outsider), initial, 'ni el plan ni su historial cambian');
  const audited = (await t.pool.query(`SELECT action, resource, decision, result, reason FROM platform_audit_event WHERE actor_id = $1 AND at >= $2`, [eng.id, since])).rows;
  assert.deepEqual(audited, [{ action: 'plans.plan.enable', resource: `plan/${plan.planId}`, decision: 'allow', result: 'noop', reason: REASON }]);
});

// ------------------------------------------------------------------ 8. panel del negocio

test('panel del negocio: entitlements refleja la revisión fijada y su uso (un borrador o una publicación nueva no lo cambian); /subscriptions/plans y /plans solo listan planes habilitados con revisión publicada', async () => {
  const draftOnly = await createPlan(eng);
  const disabled = await publishedPlan(eng, { social_posts: 3 }, { enabled: false });
  const retired = await publishedPlan(eng, { social_posts: 4 });
  const offered = await publishedPlan(eng, { social_posts: 3, reviews_managed: 7 });
  const biz = await createTenantWithPlan(t, { social_posts: 1 }, 'client_pcpanel');

  // Deshabilitar no cambia a quien ya lo tiene, pero deja de ofrecerse.
  assert.equal((await assignPlan(admin, biz.tenant, retired.planId)).status, 200);
  assert.equal((await setEnabled(eng, retired.planId, false)).body.active, false);
  assert.deepEqual([(await entitlements(biz.token)).plan.plan_id, (await subscriptionOf(biz.tenant))?.plan_revision_id], [retired.planId, retired.revisionId]);
  assert.equal((await assignPlan(admin, biz.tenant, offered.planId)).status, 200);

  const assertListed = async () => {
    for (const ids of await assignableLists(biz.token)) {
      assert.equal(ids.filter((id) => id === offered.planId).length, 1, 'el plan habilitado aparece una vez');
      for (const hidden of [draftOnly.planId, disabled.planId, retired.planId]) assert.ok(!ids.includes(hidden), `${hidden} no es asignable`);
    }
  };
  const offeredEntry = async () => {
    const plans: AssignablePlan[] = (await platform(support.token, '/plans')).body.plans;
    const entry = plans.find((p) => p.plan_id === offered.planId);
    return [entry?.revision_id, entry?.version, Number(entry?.values.find((v) => v.key === POSTS)?.value)];
  };
  await assertListed();
  assert.deepEqual(await offeredEntry(), [offered.revisionId, 1, 3]);

  let view = await entitlements(biz.token);
  assert.deepEqual([view.plan.plan_id, view.revision.revision_id, view.revision.version, view.revision.status, view.limits['social_posts'], view.limits['reviews_managed'], view.usage['social_posts']],
    [offered.planId, offered.revisionId, 1, 'PUBLISHED', 3, 7, 0]);
  assert.equal((await post(biz.token, 1)).status, 201);
  view = await entitlements(biz.token);
  const param = view.parameters.find((p) => p.key === POSTS);
  assert.deepEqual([view.usage['social_posts'], param?.value, param?.usage, param?.enforced], [1, 3, 1, true]);

  // Un borrador abierto no cambia nada para el negocio ni para lo asignable.
  const d2 = await confirmedDraft(eng, offered.planId, { social_posts: 9 });
  view = await entitlements(biz.token);
  assert.deepEqual([view.revision.revision_id, view.limits['social_posts'], view.usage['social_posts']], [offered.revisionId, 3, 1]);
  await assertListed();
  assert.deepEqual(await offeredEntry(), [offered.revisionId, 1, 3]);

  // Publicar v2: lo asignable pasa a v2; el negocio sigue fijado a v1 (ahora reemplazada).
  assert.equal((await publish(eng, d2.revisionId, d2.lock)).status, 200);
  assert.deepEqual(await offeredEntry(), [d2.revisionId, 2, 9]);
  view = await entitlements(biz.token);
  assert.deepEqual([view.revision.revision_id, view.revision.version, view.revision.status, view.limits['social_posts']], [offered.revisionId, 1, 'SUPERSEDED', 3]);
  const tenantView: TenantView = (await platform(admin.token, `/tenants/${biz.tenant}`)).body;
  const usage = tenantView.plan_usage.find((u) => u.key === POSTS);
  assert.deepEqual([tenantView.tenant.plan_revision_id, tenantView.tenant.plan_revision_version, usage?.limit, usage?.usage], [offered.revisionId, 1, 3, 1]);

  // Solo la migración explícita lo mueve a v2.
  const migrated = await migrate(admin, offered.planId, { to_revision_id: d2.revisionId, tenant_ids: [biz.tenant], expected_count: 1, reason: 'Pasar el negocio de prueba a la revisión 2' });
  assert.equal(migrated.status, 200, JSON.stringify(migrated.body));
  view = await entitlements(biz.token);
  assert.deepEqual([view.revision.revision_id, view.revision.version, view.revision.status, view.limits['social_posts'], view.usage['social_posts']], [d2.revisionId, 2, 'PUBLISHED', 9, 1]);
});

// ------------------------------------------------------------------ 9. límites de step-up, retención y reconciliación

test('step-up: 5 códigos incorrectos en 15 min ⇒ 429 auditado; mientras dura, tampoco se acepta un código válido; el límite es por operador', async () => {
  const op = await operator('platform_admin', 'stepup-limit');
  const stateSql = `SELECT s.step_up_at, u.totp_last_step FROM platform_session s JOIN platform_user u ON u.platform_user_id = s.platform_user_id
                     WHERE s.platform_user_id = $1`;
  const before = (await t.pool.query(stateSql, [op.id])).rows;
  const step = currentStep();
  const valid = new Set([-2, -1, 0, 1, 2].map((d) => totpAt(op.secret, step + d)));
  const wrong = Array.from({ length: 10 }, (_, i) => String(i).padStart(6, '0')).find((code) => !valid.has(code));
  assert.ok(wrong);
  for (let i = 1; i <= 5; i += 1) {
    const res = await platform(op.token, '/auth/step-up', 'POST', { code: wrong });
    assert.deepEqual([res.status, res.body.error?.code], [401, 'invalid_credentials'], `intento ${i}`);
  }
  const limited = await platform(op.token, '/auth/step-up', 'POST', { code: totpAt(op.secret, Math.max(op.lastStep + 1, currentStep())) });
  assert.equal(limited.status, 429, JSON.stringify(limited.body));
  assert.deepEqual((await t.pool.query(stateSql, [op.id])).rows, before, 'la sesión no ganó step-up ni se consumió el paso TOTP');
  const denied = (await t.pool.query<{ result: string; n: number }>(
    `SELECT result, count(*)::int AS n FROM platform_audit_event WHERE actor_id = $1 AND action = 'platform.step_up' AND decision = 'deny' GROUP BY result`, [op.id])).rows;
  assert.deepEqual(Object.fromEntries(denied.map((r) => [r.result, r.n])), { bad_totp: 5, too_many_attempts: 1 });
  await stepUp(await operator('platform_admin', 'stepup-other')); // otro operador no comparte el límite
});

test('retención (DEC-0027): una denegación de plataforma guarda el patrón de la ruta (con el request_id del servidor), nunca el id del negocio; después, ese negocio se anonimiza sin error', async () => {
  const plan = await publishedPlan(eng, { social_posts: 3 });
  const biz = await createTenantWithPlan(t, { social_posts: 1 }, 'client_pcdeny');
  const stale = await operator('platform_admin', 'deny-stale');
  await t.pool.query(`UPDATE platform_session SET step_up_at = now() - interval '11 minutes' WHERE platform_user_id = $1`, [stale.id]);
  const since = await dbNow();
  const denied = [await assignPlan(stale, biz.tenant, plan.planId), await assignPlan(eng, biz.tenant, plan.planId), await platform(eng.token, `/tenants/${biz.tenant}`)];
  assert.deepEqual(denied.map((r) => [r.status, r.body.error?.code]), [[403, 'step_up_required'], [403, 'permission_denied'], [403, 'permission_denied']]);
  const rows = (await t.pool.query<{ action: string; resource: string | null; result: string; tenant_id: string | null; request_id: string | null }>(
    `SELECT action, resource, result, tenant_id, request_id FROM platform_audit_event WHERE actor_id = ANY($1) AND decision = 'deny' AND at >= $2 ORDER BY at, event_id`,
    [[stale.id, eng.id], since])).rows;
  assert.deepEqual(rows.map((r) => [r.action, r.resource, r.result, r.tenant_id, typeof r.request_id]), [
    ['subscriptions.assign', '/api/platform/tenants/:id/plan', 'step_up_required', null, 'string'],
    ['subscriptions.assign', '/api/platform/tenants/:id/plan', 'role_denied', null, 'string'],
    ['tenants.read', '/api/platform/tenants/:id', 'role_denied', null, 'string'],
  ]);
  await anonymize(biz.tenant);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM client WHERE client_id = $1', [biz.tenant]), 0, 'el negocio quedó anonimizado');
});

test('retención (DEC-0027): migrar con la cabecera X-Request-Id no la guarda en ninguna auditoría; cada negocio deja su fila de plataforma con tenant y motivo y el lote un resumen sin motivo ni ids; después, cada negocio migrado se anonimiza sin error', async () => {
  const plan = await publishedPlan(eng, { social_posts: 5 });
  const tenants = [(await createTenantWithPlan(t, { social_posts: 1 }, 'client_pcmig')).tenant, (await createTenantWithPlan(t, { social_posts: 1 }, 'client_pcmig')).tenant].sort();
  for (const tenant of tenants) assert.equal((await assignPlan(admin, tenant, plan.planId)).status, 200);
  const d2 = await confirmedDraft(eng, plan.planId, { social_posts: 3 });
  assert.equal((await publish(eng, d2.revisionId, d2.lock)).status, 200);
  const header = `cliente-${randomUUID()}`;
  const reason = 'Migración por lote con cabecera de correlación del cliente';
  const since = await dbNow();
  const migrated = await platform(admin.token, `/plan-catalog/plans/${plan.planId}/migrate-subscriptions`, 'POST',
    { to_revision_id: d2.revisionId, tenant_ids: 'all', expected_count: 2, reason }, { 'X-Request-Id': header });
  assert.equal(migrated.status, 200, JSON.stringify(migrated.body));
  assert.deepEqual((migrated.body.migrated as string[]).slice().sort(), tenants);

  assert.equal(await countRows(t,
    `SELECT (SELECT count(*) FROM platform_audit_event WHERE request_id = $1) + (SELECT count(*) FROM plan_catalog_event WHERE request_id = $1)
          + (SELECT count(*) FROM audit_event WHERE request_id = $1) + (SELECT count(*) FROM subscription_history WHERE request_id = $1) AS n`, [header]), 0,
    'la cabecera del cliente no entra en ninguna auditoría ni historial');
  // Plataforma: una fila por negocio (tenant y motivo: su anonimización la re-etiqueta) y un resumen sin motivo ni ids,
  // todas con el request_id que generó el servidor.
  const platformRows = (await t.pool.query<{ tenant_id: string | null; resource: string; reason: string | null; request_id: string | null }>(
    `SELECT tenant_id, resource, reason, request_id FROM platform_audit_event
      WHERE actor_id = $1 AND action = 'plans.subscriptions.migrate' AND at >= $2 ORDER BY tenant_id COLLATE "C" NULLS LAST`, [admin.id, since])).rows;
  assert.deepEqual(platformRows.map((r) => [r.tenant_id, r.resource, r.reason]),
    [...tenants.map((tenant) => [tenant, `client/${tenant}`, reason]), [null, `plan/${plan.planId}`, null]]);
  const serverIds = [...new Set(platformRows.map((r) => r.request_id))];
  assert.ok(serverIds.length === 1 && typeof serverIds[0] === 'string', 'un solo request_id, generado por el servidor');
  // Catálogo: sin motivo, solo recuentos y el mismo request_id del servidor.
  const catalogRows = (await t.pool.query(
    `SELECT reason, diff, request_id FROM plan_catalog_event WHERE plan_id = $1 AND action = 'plans.subscriptions.migrate'`, [plan.planId])).rows;
  assert.deepEqual(catalogRows, [{ reason: null, diff: { migrated: 2, over_limit: 0 }, request_id: serverIds[0] }]);
  // Negocio: un request_id propio por evento (nunca el de plataforma) y sin el motivo.
  const businessRows = (await t.pool.query<{ request_id: string; evidence_ref: string | null }>(
    `SELECT request_id, evidence_ref FROM audit_event WHERE tenant_id = ANY($1) AND action = 'subscription.revision_migrated'`, [tenants])).rows;
  assert.equal(new Set(businessRows.map((e) => e.request_id)).size, 2, 'un request_id distinto por negocio');
  assert.ok(businessRows.every((e) => e.request_id.startsWith('plat_') && e.request_id !== serverIds[0] && e.evidence_ref === null));

  for (const tenant of tenants) await anonymize(tenant);
  assert.equal(await countRows(t, 'SELECT count(*) AS n FROM client WHERE client_id = ANY($1)', [tenants]), 0, 'ambos negocios quedaron anonimizados');
});

test('reconciliación de cuotas: informa el uso por encima del límite fijado en los parámetros que se aplican, nunca en `agents` (no se aplica)', async () => {
  // agents = 0 con 1 usuario del panel: «exceso» de un parámetro sin enforcement (DEC-0006/DEC-0017).
  const biz = await createTenantWithPlan(t, { social_posts: 3, conversations: 100 }, 'client_pcrecon');
  for (let i = 1; i <= 2; i += 1) assert.equal((await post(biz.token, i)).status, 201);
  // Downgrade por SQL a 1 publicación: las 2 existentes se conservan y la reconciliación lo informa.
  const smaller = `plan_${sfx()}`;
  await createPublishedPlan(t.pool, smaller, { social_posts: 1, conversations: 100 });
  await setTenantPlan(t.pool, biz.tenant, smaller);
  const report = await t.handle.quota.reconcile();
  assert.deepEqual(report.overLimit.filter((o) => o.tenant_id === biz.tenant), [{ tenant_id: biz.tenant, capability: 'social_posts', usage: 2, max: 1 }]);
});
