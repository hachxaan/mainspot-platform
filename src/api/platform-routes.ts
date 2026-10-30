/**
 * MainSpot Administration (FR-0018) y Engineering Console (FR-0019): API de plataforma, separada
 * del panel del negocio (otra sesión, otra clave, otra auditoría).
 *
 * - platform_admin: negocios, planes, clasificación de datos, salud, presupuestos.
 * - ai_engineer: catálogo, prompts, rutas, evaluaciones, rollout/rollback, trazas y jobs.
 * - platform_support: lectura de salud y acceso de soporte con motivo y caducidad (visible al negocio).
 * Acciones con efecto (activar ruta, rollback, cambiar plan, suspender, presupuestos) exigen
 * step-up TOTP reciente. Nunca se exponen contraseñas, secretos, tokens ni contenido de
 * conversaciones; las trazas muestran ids, hashes, estado, latencia y costo.
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { AuditSink } from '../audit/sink.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import { PlatformAuth, requirePlatform, writePlatformAudit, type PlatformRequest, type PlatformRole, type PlatformSession } from '../platform/auth.ts';
import type { AiDispatcher } from '../ai/dispatcher.ts';
import { runEvalSuite } from '../ai/evals.ts';
import type { RouteParams } from '../ai/registry.ts';
import type { SubscriptionRepository } from '../subscriptions/entitlements.ts';

export interface PlatformRouteDeps {
  pool: Pool;
  sink: AuditSink;
  auth: PlatformAuth;
  dispatcher: AiDispatcher;
  subscriptions: SubscriptionRepository;
  environment: string;
  realProviders: boolean;
}

/** Techo del laboratorio fijado por el propietario (2026-10-30): no se sube desde la consola. */
export const LAB_TOTAL_CAP_USD = 25;

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

function sessionOf(req: Request): PlatformSession {
  const s = (req as PlatformRequest).platform;
  if (!s) throw new AppError(401, 'missing_actor', 'Inicia sesión en la consola de plataforma.');
  return s;
}

function sessionView(s: PlatformSession): Record<string, unknown> {
  return { login: s.login, display_name: s.display_name, roles: s.roles, expires_at: s.expires_at, step_up_at: s.step_up_at };
}

function reasonOf(body: unknown): string {
  const r = typeof (body as { reason?: unknown } | null)?.reason === 'string' ? ((body as { reason: string }).reason).trim() : '';
  if (r.length < 10 || r.length > 500) throw new AppError(400, 'validation_error', 'Escribe el motivo (10 a 500 caracteres).');
  return r;
}

export function platformRouter(deps: PlatformRouteDeps): Router {
  const router = Router();
  const { pool } = deps;
  const guard = (roles: PlatformRole[], action: string, stepUp = false) => requirePlatform(deps.auth, pool, roles, { action, stepUp });
  const audit = (s: PlatformSession, req: Request, action: string, resource: string | null, result: string, extra: { tenantId?: string | null; reason?: string | null } = {}) =>
    writePlatformAudit(pool, { actorId: s.platform_user_id, actorRoles: s.roles, action, resource, tenantId: extra.tenantId ?? null, decision: 'allow', result, reason: extra.reason ?? null, requestId: (req.get('x-request-id') ?? null) });

  // ------------------------------------------------------------------ sesión
  router.post('/auth/login', ah(async (req, res) => {
    const b = (req.body ?? {}) as { login?: unknown; password?: unknown; code?: unknown };
    const out = await deps.auth.login(String(b.login ?? ''), String(b.password ?? ''), String(b.code ?? ''), req.ip ?? 'unknown');
    res.json({ token: out.token, session: sessionView(out.session) });
  }));

  router.post('/auth/step-up', guard(['platform_admin', 'ai_engineer', 'platform_support'], 'platform.step_up'), ah(async (req, res) => {
    await deps.auth.stepUp(sessionOf(req), String((req.body ?? {})['code'] ?? ''));
    res.json({ ok: true, valid_minutes: 10 });
  }));

  router.post('/auth/logout', guard(['platform_admin', 'ai_engineer', 'platform_support'], 'platform.logout'), ah(async (req, res) => {
    await deps.auth.logout(sessionOf(req));
    res.json({ ok: true });
  }));

  router.get('/me', guard(['platform_admin', 'ai_engineer', 'platform_support'], 'platform.me'), ah(async (req, res) => {
    res.json({ session: sessionView(sessionOf(req)), environment: deps.environment, real_providers: deps.realProviders });
  }));

  // ------------------------------------------------------------------ Administration
  const anyRole: PlatformRole[] = ['platform_admin', 'ai_engineer', 'platform_support'];

  router.get('/tenants', guard(['platform_admin', 'platform_support'], 'platform.tenants.read'), ah(async (req, res) => {
    const r = await pool.query(
      `SELECT c.client_id, c.business_name, c.status, c.data_classification, c.created_at,
              p.name AS plan, s.status AS subscription_status, w.published_version, w.status AS website_status,
              (SELECT max(ts) FROM audit_event a WHERE a.tenant_id = c.client_id AND a.actor_id NOT LIKE 'system:%') AS last_activity,
              (SELECT count(*) FROM ai_invocation i WHERE i.tenant_id = c.client_id AND i.created_at > now() - interval '30 days') AS ai_calls_30d,
              (SELECT COALESCE(SUM(COALESCE(i.cost_usd, 0)), 0) FROM ai_invocation i WHERE i.tenant_id = c.client_id AND i.created_at > now() - interval '30 days') AS ai_cost_30d,
              (SELECT count(*) FROM ai_invocation i WHERE i.tenant_id = c.client_id AND i.status IN ('failed','blocked') AND i.created_at > now() - interval '7 days') AS ai_failures_7d,
              (SELECT count(*) FROM engagement_case e WHERE e.tenant_id = c.client_id AND e.state IN ('needs_human','failed')) AS cases_pending,
              (SELECT count(*) FROM ai_job j WHERE j.tenant_id = c.client_id AND j.status = 'failed' AND j.created_at > now() - interval '7 days') AS jobs_failed_7d
         FROM client c LEFT JOIN subscription s ON s.tenant_id = c.client_id LEFT JOIN plan p ON p.plan_id = s.plan_id
         LEFT JOIN client_website w ON w.tenant_id = c.client_id
        ORDER BY c.created_at DESC LIMIT 200`);
    await audit(sessionOf(req), req, 'platform.tenants.read', 'client/*', `rows:${r.rowCount}`);
    res.json({ tenants: r.rows });
  }));

  router.get('/tenants/:id', guard(['platform_admin', 'platform_support'], 'platform.tenant.read'), ah(async (req, res) => {
    const id = req.params['id'] as string;
    const c = await pool.query(`SELECT c.client_id, c.business_name, c.status, c.data_classification, c.created_at, p.plan_id, p.name AS plan, s.status AS subscription_status
                                  FROM client c LEFT JOIN subscription s ON s.tenant_id = c.client_id LEFT JOIN plan p ON p.plan_id = s.plan_id WHERE c.client_id = $1`, [id]);
    if (!c.rows[0]) return res.status(404).json({ error: { code: 'not_found', message: 'No existe ese negocio.' } });
    const usage = await pool.query(`SELECT capability, sum(units) AS units FROM quota_reservation WHERE tenant_id = $1 AND state = 'committed' AND created_at > date_trunc('month', now()) GROUP BY capability`, [id]);
    const ai = await pool.query(`SELECT use_case_id, count(*) AS calls, count(*) FILTER (WHERE status IN ('failed','blocked')) AS failed, COALESCE(sum(cost_usd), 0) AS cost_usd
                                   FROM ai_invocation WHERE tenant_id = $1 AND created_at > now() - interval '30 days' GROUP BY use_case_id ORDER BY 2 DESC`, [id]);
    const conns = await pool.query(`SELECT provider, status, last_error_code, last_verified_at FROM provider_connection WHERE tenant_id = $1`, [id]);
    const support = await pool.query(`SELECT a.access_id, u.login, a.reason, a.granted_at, a.expires_at, a.revoked_at FROM platform_support_access a JOIN platform_user u ON u.platform_user_id = a.platform_user_id WHERE a.tenant_id = $1 ORDER BY a.granted_at DESC LIMIT 20`, [id]);
    const jobs = await pool.query(`SELECT kind, status, error_code, count(*) AS n FROM ai_job WHERE tenant_id = $1 AND created_at > now() - interval '30 days' GROUP BY 1,2,3 ORDER BY 4 DESC`, [id]);
    await audit(sessionOf(req), req, 'platform.tenant.read', `client/${id}`, 'ok', { tenantId: id });
    return res.json({ tenant: c.rows[0], usage_month: usage.rows, ai_30d: ai.rows, connections: conns.rows, support_access: support.rows, jobs_30d: jobs.rows });
  }));

  router.post('/tenants/:id/status', guard(['platform_admin'], 'platform.tenant.status', true), ah(async (req, res) => {
    const s = sessionOf(req);
    const id = req.params['id'] as string;
    const status = (req.body ?? {})['status'];
    if (status !== 'active' && status !== 'suspended') throw new AppError(400, 'validation_error', 'Estado inválido.');
    const reason = reasonOf(req.body);
    const r = await pool.query(`UPDATE client SET status = $2 WHERE client_id = $1 AND status IN ('active','suspended') RETURNING client_id`, [id, status]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'No existe ese negocio o ya fue dado de baja.');
    await deps.sink.write({ tenant_id: id, actor_id: `platform:${s.platform_user_id}`, actor_role: 'platform_admin', action: `platform.tenant.${status}`, resource: `client/${id}`, request_id: `plat_${randomUUID()}`, decision: 'allow', result: status });
    await audit(s, req, 'platform.tenant.status', `client/${id}`, status, { tenantId: id, reason });
    res.json({ ok: true, status });
  }));

  router.post('/tenants/:id/plan', guard(['platform_admin'], 'platform.tenant.plan', true), ah(async (req, res) => {
    const s = sessionOf(req);
    const id = req.params['id'] as string;
    const planId = String((req.body ?? {})['plan_id'] ?? '');
    const reason = reasonOf(req.body);
    const plan = await pool.query('SELECT plan_id FROM plan WHERE plan_id = $1 AND active', [planId]);
    if (!plan.rowCount) throw new AppError(400, 'validation_error', 'Ese plan no existe o no está activo.');
    const sub = await deps.subscriptions.assign(id, planId);
    await deps.sink.write({ tenant_id: id, actor_id: `platform:${s.platform_user_id}`, actor_role: 'platform_admin', action: 'platform.tenant.plan', resource: `subscription/${sub.subscription_id}`, request_id: `plat_${randomUUID()}`, decision: 'allow', result: planId });
    await audit(s, req, 'platform.tenant.plan', `client/${id}`, planId, { tenantId: id, reason });
    res.json({ subscription: sub });
  }));

  /** Solo negocios de laboratorio pueden marcarse `synthetic` (habilita proveedores reales de IA). */
  router.post('/tenants/:id/data-classification', guard(['platform_admin'], 'platform.tenant.data_classification', true), ah(async (req, res) => {
    const s = sessionOf(req);
    const id = req.params['id'] as string;
    const value = (req.body ?? {})['classification'];
    if (value !== 'synthetic' && value !== 'real') throw new AppError(400, 'validation_error', 'Clasificación inválida.');
    const reason = reasonOf(req.body);
    const r = await pool.query('UPDATE client SET data_classification = $2 WHERE client_id = $1 RETURNING client_id', [id, value]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'No existe ese negocio.');
    await deps.sink.write({ tenant_id: id, actor_id: `platform:${s.platform_user_id}`, actor_role: 'platform_admin', action: 'platform.tenant.data_classification', resource: `client/${id}`, request_id: `plat_${randomUUID()}`, decision: 'allow', result: value });
    await audit(s, req, 'platform.tenant.data_classification', `client/${id}`, value, { tenantId: id, reason });
    res.json({ ok: true, data_classification: value });
  }));

  router.post('/tenants/:id/support-access', guard(['platform_admin', 'platform_support'], 'platform.support.grant', true), ah(async (req, res) => {
    const s = sessionOf(req);
    const id = req.params['id'] as string;
    const reason = reasonOf(req.body);
    const minutes = Number((req.body ?? {})['minutes'] ?? 30);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120) throw new AppError(400, 'validation_error', 'El acceso dura de 5 a 120 minutos.');
    const exists = await pool.query('SELECT 1 FROM client WHERE client_id = $1', [id]);
    if (!exists.rowCount) throw new AppError(404, 'not_found', 'No existe ese negocio.');
    const accessId = `psa_${randomUUID()}`;
    await pool.query(`INSERT INTO platform_support_access (access_id, tenant_id, platform_user_id, reason, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5))`, [accessId, id, s.platform_user_id, reason, minutes]);
    // Visible para el negocio en su propia auditoría (sin datos del operador más allá del login).
    await deps.sink.write({ tenant_id: id, actor_id: `platform:${s.login}`, actor_role: 'platform_support', action: 'platform.support.access_granted', resource: `platform_support_access/${accessId}`, request_id: `plat_${randomUUID()}`, decision: 'allow', result: `minutes:${minutes}`, evidence_ref: reason.slice(0, 120) });
    await audit(s, req, 'platform.support.grant', `client/${id}`, `minutes:${minutes}`, { tenantId: id, reason });
    res.status(201).json({ access_id: accessId, minutes });
  }));

  /** Vista de soporte: solo con acceso vigente; resumen operativo SIN contenido de conversaciones. */
  router.get('/tenants/:id/support-view', guard(['platform_admin', 'platform_support'], 'platform.support.view'), ah(async (req, res) => {
    const s = sessionOf(req);
    const id = req.params['id'] as string;
    const ok = await pool.query(`SELECT 1 FROM platform_support_access WHERE tenant_id = $1 AND platform_user_id = $2 AND revoked_at IS NULL AND expires_at > now()`, [id, s.platform_user_id]);
    if (!ok.rowCount) {
      await writePlatformAudit(pool, { actorId: s.platform_user_id, actorRoles: s.roles, action: 'platform.support.view', resource: `client/${id}`, tenantId: id, decision: 'deny', result: 'no_active_access' });
      return res.status(403).json({ error: { code: 'permission_denied', message: 'Necesitas un acceso de soporte vigente con motivo.' } });
    }
    const website = await pool.query(`SELECT status, published_version, published_at, local_site_status FROM client_website WHERE tenant_id = $1`, [id]);
    const posts = await pool.query(`SELECT status, count(*) AS n FROM social_post WHERE tenant_id = $1 GROUP BY status`, [id]);
    const cases = await pool.query(`SELECT state, count(*) AS n FROM engagement_case WHERE tenant_id = $1 GROUP BY state`, [id]);
    const jobs = await pool.query(`SELECT job_id, kind, status, error_code, attempts, created_at FROM ai_job WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]);
    await deps.sink.write({ tenant_id: id, actor_id: `platform:${s.login}`, actor_role: 'platform_support', action: 'platform.support.viewed', resource: `client/${id}`, request_id: `plat_${randomUUID()}`, decision: 'allow', result: 'summary_only' });
    await audit(s, req, 'platform.support.view', `client/${id}`, 'summary_only', { tenantId: id });
    return res.json({ website: website.rows[0] ?? null, posts: posts.rows, cases: cases.rows, jobs: jobs.rows });
  }));

  router.get('/plans', guard(['platform_admin', 'platform_support'], 'platform.plans.read'), ah(async (_req, res) => {
    const r = await pool.query(`SELECT p.plan_id, p.name, p.description, p.active, COALESCE(json_agg(json_build_object('capability', l.capability, 'max', l.max_value)) FILTER (WHERE l.limit_id IS NOT NULL), '[]') AS limits
                                  FROM plan p LEFT JOIN plan_limit l ON l.plan_id = p.plan_id GROUP BY p.plan_id ORDER BY p.plan_id`);
    res.json({ plans: r.rows });
  }));

  router.get('/health', guard(anyRole, 'platform.health.read'), ah(async (_req, res) => {
    const q = async (sql: string) => (await pool.query(sql)).rows;
    res.json({
      db: (await q('SELECT now() AS now'))[0],
      jobs: await q(`SELECT status, count(*) AS n FROM ai_job WHERE created_at > now() - interval '24 hours' GROUP BY status`),
      jobs_stuck: (await q(`SELECT count(*) AS n FROM ai_job WHERE status = 'running' AND lease_until < now()`))[0],
      invocations_24h: await q(`SELECT provider_id, status, count(*) AS n, round(avg(latency_ms)) AS avg_ms FROM ai_invocation WHERE created_at > now() - interval '24 hours' GROUP BY 1,2 ORDER BY 1,2`),
      engagement_backlog: (await q(`SELECT count(*) FILTER (WHERE state = 'received') AS received, count(*) FILTER (WHERE state = 'retry_pending') AS retry, count(*) FILTER (WHERE state = 'needs_human') AS human FROM engagement_case`))[0],
      scheduler_backlog: (await q(`SELECT count(*) FILTER (WHERE status = 'scheduled' AND publish_at < now()) AS overdue, count(*) FILTER (WHERE status = 'uncertain') AS uncertain FROM scheduled_post`))[0],
      budgets: await q(`SELECT scope, tenant_id, limit_usd, source, updated_at FROM ai_budget ORDER BY scope`),
      spend: (await q(`SELECT COALESCE(sum(COALESCE(cost_usd, reserved_usd)) FILTER (WHERE created_at >= date_trunc('day', now())), 0) AS today,
                              COALESCE(sum(COALESCE(cost_usd, reserved_usd)) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS month,
                              COALESCE(sum(COALESCE(cost_usd, reserved_usd)), 0) AS lab_total
                         FROM ai_invocation i JOIN ai_provider p ON p.provider_id = i.provider_id WHERE p.kind = 'openrouter'`))[0],
    });
  }));

  router.get('/audit', guard(['platform_admin'], 'platform.audit.read'), ah(async (_req, res) => {
    res.json({ events: (await pool.query(`SELECT at, actor_id, actor_roles, action, resource, tenant_id, decision, result, reason FROM platform_audit_event ORDER BY at DESC LIMIT 200`)).rows });
  }));

  router.put('/ai/budgets/:scope', guard(['platform_admin'], 'platform.budget.update', true), ah(async (req, res) => {
    const s = sessionOf(req);
    const scope = req.params['scope'];
    const limit = Number((req.body ?? {})['limit_usd']);
    const reason = reasonOf(req.body);
    if (scope !== 'lab_total' && scope !== 'platform_month' && scope !== 'tenant_day') throw new AppError(400, 'validation_error', 'Alcance inválido.');
    if (!Number.isFinite(limit) || limit < 0) throw new AppError(400, 'validation_error', 'Límite inválido.');
    if (scope === 'lab_total' && limit > LAB_TOTAL_CAP_USD) throw new AppError(403, 'permission_denied', `El techo del laboratorio es USD ${LAB_TOTAL_CAP_USD} por decisión del propietario.`);
    const r = await pool.query(`UPDATE ai_budget SET limit_usd = $2, source = $3, updated_by = $4, updated_at = now() WHERE scope = $1 AND tenant_id IS NULL RETURNING scope, limit_usd`, [scope, limit, `console:${reason.slice(0, 80)}`, s.platform_user_id]);
    if (!r.rowCount) throw new AppError(404, 'not_found', 'No hay presupuesto de ese alcance.');
    await audit(s, req, 'platform.budget.update', `ai_budget/${scope}`, String(limit), { reason });
    res.json({ budget: r.rows[0] });
  }));

  // ------------------------------------------------------------------ Engineering Console
  const eng: PlatformRole[] = ['ai_engineer'];
  const engRead: PlatformRole[] = ['ai_engineer', 'platform_admin'];
  const reg = deps.dispatcher.registry;

  router.get('/ai/use-cases', guard(engRead, 'ai.catalog.read'), ah(async (_req, res) => {
    res.json({ environment: deps.environment, use_cases: await reg.listUseCases(deps.environment) });
  }));

  router.get('/ai/use-cases/:uc', guard(engRead, 'ai.catalog.read'), ah(async (req, res) => {
    const uc = req.params['uc'] as string;
    const useCase = await reg.useCase(uc);
    if (!useCase) return res.status(404).json({ error: { code: 'not_found', message: 'No existe ese caso de uso.' } });
    const suites = await pool.query(`SELECT suite_id, name, version, thresholds, jsonb_array_length(cases) AS cases FROM ai_eval_suite WHERE use_case_id = $1 ORDER BY version DESC`, [uc]);
    const runs = await pool.query(`SELECT e.run_id, e.route_id, e.status, e.metrics, e.real_provider, e.cost_usd, e.started_at, e.finished_at, s.name AS suite
                                     FROM ai_eval_run e JOIN ai_eval_suite s ON s.suite_id = e.suite_id WHERE s.use_case_id = $1 ORDER BY e.started_at DESC LIMIT 30`, [uc]);
    return res.json({
      use_case: useCase, rollout: await reg.rollout(uc, deps.environment), routes: await reg.routes(uc), prompts: await reg.prompts(uc),
      history: await reg.history(uc, deps.environment), suites: suites.rows, eval_runs: runs.rows,
    });
  }));

  router.get('/ai/models', guard(engRead, 'ai.catalog.read'), ah(async (_req, res) => {
    res.json({ models: await reg.models(), providers: (await reg.providers()).map((p) => ({ ...p, secret_configured: Boolean(p.secret_ref && process.env[p.secret_ref]) })) });
  }));

  router.post('/ai/use-cases/:uc/prompts', guard(eng, 'ai.prompt.create'), ah(async (req, res) => {
    const s = sessionOf(req);
    const b = (req.body ?? {}) as { content?: unknown; change_note?: unknown };
    const rev = await reg.createPromptRevision(req.params['uc'] as string, b.content as Parameters<typeof reg.createPromptRevision>[1], String(b.change_note ?? ''), `platform:${s.platform_user_id}`);
    await audit(s, req, 'ai.prompt.create', `ai_prompt_revision/${rev.revision_id}`, `v${rev.version}`);
    res.status(201).json({ prompt: rev });
  }));

  router.post('/ai/use-cases/:uc/routes', guard(eng, 'ai.route.create'), ah(async (req, res) => {
    const s = sessionOf(req);
    const b = (req.body ?? {}) as { model_id?: unknown; prompt_revision_id?: unknown; params?: unknown; max_cost_usd?: unknown; change_note?: unknown };
    const route = await reg.createRoute({
      useCaseId: req.params['uc'] as string, modelId: String(b.model_id ?? ''), promptRevisionId: String(b.prompt_revision_id ?? ''),
      params: (b.params ?? {}) as RouteParams, maxCostUsd: Number(b.max_cost_usd), changeNote: String(b.change_note ?? ''), actor: `platform:${s.platform_user_id}`,
    });
    await audit(s, req, 'ai.route.create', `ai_route_revision/${route.route_id}`, `v${route.version}:${route.model_id}`);
    res.status(201).json({ route });
  }));

  /** Ejecuta la suite en segundo plano (puede tardar minutos); el resultado queda en ai_eval_run. */
  router.post('/ai/routes/:id/evaluate', guard(eng, 'ai.eval.run'), ah(async (req, res) => {
    const s = sessionOf(req);
    const route = await reg.route(req.params['id'] as string);
    if (!route) return res.status(404).json({ error: { code: 'not_found', message: 'No existe esa ruta.' } });
    const requested = (req.body ?? {})['suite_id'];
    const suite = await pool.query<{ suite_id: string }>(`SELECT suite_id FROM ai_eval_suite WHERE use_case_id = $1 AND ($2::text IS NULL OR suite_id = $2) ORDER BY version DESC LIMIT 1`, [route.use_case_id, typeof requested === 'string' ? requested : null]);
    const suiteId = suite.rows[0]?.suite_id;
    if (!suiteId) return res.status(409).json({ error: { code: 'validation_error', message: 'Ese caso de uso no tiene suite de evaluación.' } });
    const running = await pool.query(`SELECT 1 FROM ai_eval_run WHERE route_id = $1 AND status = 'running' AND started_at > now() - interval '30 minutes'`, [route.route_id]);
    if (running.rowCount) return res.status(409).json({ error: { code: 'validation_error', message: 'Ya hay una evaluación en curso para esta ruta.' } });
    await audit(s, req, 'ai.eval.run', `ai_route_revision/${route.route_id}`, `suite:${suiteId}`);
    void runEvalSuite(pool, deps.dispatcher, suiteId, route.route_id, `platform:${s.platform_user_id}`)
      .catch((err: unknown) => log.error('ai.eval.failed', 'evaluation run failed', { route_id: route.route_id, error_name: err instanceof Error ? err.name : 'unknown' }));
    return res.status(202).json({ started: true, suite_id: suiteId, route_id: route.route_id });
  }));

  router.get('/ai/routes/:id/evals', guard(engRead, 'ai.eval.read'), ah(async (req, res) => {
    const r = await pool.query(`SELECT run_id, status, metrics, results, real_provider, cost_usd, started_at, finished_at FROM ai_eval_run WHERE route_id = $1 ORDER BY started_at DESC LIMIT 10`, [req.params['id']]);
    res.json({ runs: r.rows });
  }));

  router.post('/ai/routes/:id/approve', guard(eng, 'ai.route.approve', true), ah(async (req, res) => {
    const s = sessionOf(req);
    const route = await reg.approve(req.params['id'] as string, `platform:${s.platform_user_id}`);
    await audit(s, req, 'ai.route.approve', `ai_route_revision/${route.route_id}`, 'APPROVED');
    res.json({ route });
  }));

  router.post('/ai/routes/:id/retire', guard(eng, 'ai.route.retire'), ah(async (req, res) => {
    const s = sessionOf(req);
    const route = await reg.retire(req.params['id'] as string);
    await audit(s, req, 'ai.route.retire', `ai_route_revision/${route.route_id}`, 'RETIRED');
    res.json({ route });
  }));

  router.post('/ai/use-cases/:uc/rollout', guard(eng, 'ai.rollout.change', true), ah(async (req, res) => {
    const s = sessionOf(req);
    const uc = req.params['uc'] as string;
    const b = (req.body ?? {}) as { action?: unknown; route_id?: unknown; percent?: unknown };
    const reason = reasonOf(req.body);
    const actor = `platform:${s.platform_user_id}`;
    let rollout;
    switch (b.action) {
      case 'activate': rollout = await reg.activate(uc, deps.environment, String(b.route_id ?? ''), actor, reason); break;
      case 'canary': rollout = await reg.setCanary(uc, deps.environment, String(b.route_id ?? ''), Number(b.percent), actor, reason); break;
      case 'promote': rollout = await reg.promoteCanary(uc, deps.environment, actor, reason); break;
      case 'clear_canary': rollout = await reg.clearCanary(uc, deps.environment, actor, reason); break;
      case 'rollback': rollout = await reg.rollback(uc, deps.environment, actor, reason); break;
      default: throw new AppError(400, 'validation_error', 'Acción de rollout inválida.');
    }
    await audit(s, req, `ai.rollout.${String(b.action)}`, `ai_rollout/${uc}/${deps.environment}`, `active:${rollout.active_route_id ?? '-'} canary:${rollout.canary_route_id ?? '-'}@${rollout.canary_percent}`, { reason });
    res.json({ rollout });
  }));

  router.get('/ai/invocations', guard(engRead, 'ai.trace.read'), ah(async (req, res) => {
    const uc = typeof req.query['use_case'] === 'string' ? req.query['use_case'] : null;
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
    // Trazas saneadas: sin entrada ni salida (contenido de clientes); hashes, ids y métricas.
    const r = await pool.query(
      `SELECT invocation_id, created_at, tenant_id, origin, use_case_id, route_id, route_version, prompt_sha256, model_id, provider_id, assignment,
              status, error_code, latency_ms, reserved_usd, cost_usd, cost_source, usage, input_sha256, job_id, eval_run_id, policy_version, brand_version
         FROM ai_invocation WHERE ($1::text IS NULL OR use_case_id = $1) AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT 100`, [uc, status]);
    res.json({ invocations: r.rows });
  }));

  router.get('/ai/costs', guard(engRead, 'ai.cost.read'), ah(async (_req, res) => {
    const byDay = await pool.query(`SELECT (created_at AT TIME ZONE 'UTC')::date AS day, provider_id, count(*) AS calls, COALESCE(sum(cost_usd), 0) AS cost_usd
                                      FROM ai_invocation WHERE created_at > now() - interval '30 days' GROUP BY 1,2 ORDER BY 1 DESC, 2`);
    const byUc = await pool.query(`SELECT use_case_id, model_id, count(*) AS calls, COALESCE(sum(cost_usd), 0) AS cost_usd, round(avg(latency_ms)) AS avg_ms,
                                          percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
                                     FROM ai_invocation WHERE created_at > now() - interval '30 days' GROUP BY 1,2 ORDER BY 4 DESC`);
    res.json({ by_day: byDay.rows, by_use_case: byUc.rows, budgets: (await pool.query('SELECT scope, tenant_id, limit_usd, source FROM ai_budget ORDER BY scope')).rows });
  }));

  router.get('/ai/jobs', guard(engRead, 'ai.jobs.read'), ah(async (req, res) => {
    const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
    const r = await pool.query(`SELECT job_id, tenant_id, kind, status, error_code, attempts, pinned, progress, created_at, finished_at FROM ai_job WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 100`, [status]);
    res.json({ jobs: r.rows });
  }));

  router.post('/ai/jobs/:id/cancel', guard(eng, 'ai.jobs.cancel'), ah(async (req, res) => {
    const s = sessionOf(req);
    const r = await pool.query(`UPDATE ai_job SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE job_id = $1 AND status = 'queued' RETURNING job_id, tenant_id`, [req.params['id']]);
    if (!r.rowCount) throw new AppError(409, 'validation_error', 'Solo se cancelan trabajos en cola (uno en curso termina o vence su lease).');
    await audit(s, req, 'ai.jobs.cancel', `ai_job/${String(req.params['id'])}`, 'cancelled', { tenantId: r.rows[0].tenant_id });
    res.json({ ok: true });
  }));

  return router;
}
