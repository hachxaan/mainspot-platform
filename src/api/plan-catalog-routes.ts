/**
 * Engineering Console · Planes (FR-0019 «Planes», FR-0010, DEC-0075/SRC-0013): API de plataforma del
 * catálogo de planes, montada bajo /api/platform. Autorización por permiso explícito
 * (src/platform/permissions.ts); TODA escritura exige step-up TOTP reciente y motivo, y deja evento con
 * diff + auditoría de plataforma en la misma transacción. Publicar es configuración operativa: no
 * aprueba precios ni paquetes comerciales y no cambia a los clientes vigentes (suscripciones fijadas).
 * Nombre y descripción de un plan se ven de inmediato en el panel del negocio: cambiarlos es `plans.publish`.
 * La migración de suscripciones a la revisión publicada es de Administration (`subscriptions.assign`).
 * Identidades de negocios (ids, nombres) solo con `tenants.read`: sin él, el detalle del plan da recuentos
 * por revisión y la vista previa de migración se deniega (BR-0007, mínimo privilegio de ai_engineer). Cada
 * lectura con identidades se audita (`tenants.read`, recuento, sin ids de negocios).
 */

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { SubscriptionAssignment, type PlatformActor } from '../plans/assignment.ts';
import { PlanCatalog, assertReason } from '../plans/catalog.ts';
import { serverRequestId, writePlatformAudit, type PlatformAuth, type PlatformRequest } from '../platform/auth.ts';
import { permissionsOf, requirePlatformPermission, type PlatformPermission } from '../platform/permissions.ts';
import { AppError } from '../shared/errors.ts';

export interface PlanCatalogRouteDeps {
  pool: Pool;
  sink: AuditSink;
  auth: PlatformAuth;
}

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

function actorOf(req: Request): PlatformActor {
  const s = (req as PlatformRequest).platform;
  if (!s) throw new AppError(401, 'missing_actor', 'Inicia sesión en la consola de plataforma.');
  return { platformUserId: s.platform_user_id, login: s.login, roles: s.roles, requestId: serverRequestId(req) };
}

const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {});
const param = (req: Request, name: string) => String(req.params[name] ?? '');

export function planCatalogRouter(deps: PlanCatalogRouteDeps): Router {
  const router = Router();
  const catalog = new PlanCatalog({ pool: deps.pool });
  const assignment = new SubscriptionAssignment({ pool: deps.pool, sink: deps.sink });
  const can = (p: PlatformPermission, stepUp = false) => requirePlatformPermission(deps.auth, deps.pool, p, { stepUp });

  // ------------------------------------------------------------------ lectura (plans.read)
  router.get('/plan-catalog/parameters', can('plans.read'), ah(async (_req, res) => {
    const differences = await catalog.registryDifferences();
    res.json({ parameters: catalog.parameters(), registry: { consistent: differences.length === 0, differences } });
  }));

  router.get('/plan-catalog/plans', can('plans.read'), ah(async (req, res) => {
    const plans = await catalog.listPlans();
    const a = actorOf(req);
    await writePlatformAudit(deps.pool, { actorId: a.platformUserId, actorRoles: a.roles, action: 'plans.read', resource: 'plan/*', decision: 'allow', result: `rows:${plans.length}`, requestId: a.requestId });
    res.json({ plans, commercial_approval: 'not_approved' });
  }));

  router.get('/plan-catalog/plans/:planId', can('plans.read'), ah(async (req, res) => {
    const a = actorOf(req);
    const planId = param(req, 'planId');
    const tenantIdentities = permissionsOf(a.roles).includes('tenants.read');
    const detail = await catalog.planDetail(planId, { tenantIdentities });
    if (tenantIdentities) {
      await writePlatformAudit(deps.pool, { actorId: a.platformUserId, actorRoles: a.roles, action: 'tenants.read', resource: `plan/${planId}`, decision: 'allow', result: `rows:${detail.subscriptions.length}`, requestId: a.requestId });
    }
    res.json(detail);
  }));

  router.get('/plan-catalog/revisions/:revisionId/review', can('plans.read'), ah(async (req, res) => {
    res.json(await catalog.review(param(req, 'revisionId')));
  }));

  router.get('/plan-catalog/plans/:planId/migration-preview', can('plans.read'), can('tenants.read'), ah(async (req, res) => {
    const a = actorOf(req);
    const planId = param(req, 'planId');
    const to = typeof req.query['to'] === 'string' ? req.query['to'] : '';
    const subscriptions = await assignment.previewMigration(planId, to);
    await writePlatformAudit(deps.pool, { actorId: a.platformUserId, actorRoles: a.roles, action: 'tenants.read', resource: `plan/${planId}`, decision: 'allow', result: `rows:${subscriptions.length}`, requestId: a.requestId });
    res.json({ to_revision_id: to, subscriptions });
  }));

  // ------------------------------------------------------------------ escritura (step-up + motivo)
  router.post('/plan-catalog/plans', can('plans.edit', true), ah(async (req, res) => {
    const b = body(req);
    const out = await catalog.createPlan({ name: b['name'], description: b['description'], cloneFromPlanId: b['clone_from_plan_id'], reason: b['reason'], actor: actorOf(req) });
    res.status(201).json(out);
  }));

  router.patch('/plan-catalog/plans/:planId', can('plans.publish', true), ah(async (req, res) => {
    const b = body(req);
    await catalog.updatePlanMeta({ planId: param(req, 'planId'), name: b['name'], description: b['description'], reason: b['reason'], actor: actorOf(req) });
    res.json({ ok: true });
  }));

  router.post('/plan-catalog/plans/:planId/revisions', can('plans.edit', true), ah(async (req, res) => {
    res.status(201).json(await catalog.createDraft({ planId: param(req, 'planId'), reason: body(req)['reason'], actor: actorOf(req) }));
  }));

  router.patch('/plan-catalog/revisions/:revisionId', can('plans.edit', true), ah(async (req, res) => {
    const b = body(req);
    res.json(await catalog.updateDraft({ revisionId: param(req, 'revisionId'), lockVersion: b['lock_version'], values: b['values'], reason: b['reason'], actor: actorOf(req) }));
  }));

  router.post('/plan-catalog/revisions/:revisionId/discard', can('plans.edit', true), ah(async (req, res) => {
    const b = body(req);
    await catalog.discard({ revisionId: param(req, 'revisionId'), lockVersion: b['lock_version'], reason: b['reason'], actor: actorOf(req) });
    res.json({ ok: true });
  }));

  router.post('/plan-catalog/revisions/:revisionId/publish', can('plans.publish', true), ah(async (req, res) => {
    const b = body(req);
    res.json(await catalog.publish({ revisionId: param(req, 'revisionId'), lockVersion: b['lock_version'], reason: b['reason'], actor: actorOf(req) }));
  }));

  router.post('/plan-catalog/plans/:planId/rollback', can('plans.publish', true), ah(async (req, res) => {
    const b = body(req);
    res.json(await catalog.rollback({ planId: param(req, 'planId'), toRevisionId: b['to_revision_id'], reason: b['reason'], actor: actorOf(req) }));
  }));

  router.post('/plan-catalog/plans/:planId/status', can('plans.publish', true), ah(async (req, res) => {
    const b = body(req);
    res.json(await catalog.setEnabled({ planId: param(req, 'planId'), enabled: b['enabled'], reason: b['reason'], actor: actorOf(req) }));
  }));

  router.post('/plan-catalog/plans/:planId/migrate-subscriptions', can('subscriptions.assign', true), ah(async (req, res) => {
    const b = body(req);
    const tenantIds = b['tenant_ids'] === 'all' ? 'all' : Array.isArray(b['tenant_ids']) && b['tenant_ids'].every((t) => typeof t === 'string') ? b['tenant_ids'] as string[] : null;
    if (!tenantIds) throw new AppError(400, 'validation_error', 'Indica los negocios a migrar (lista de ids o "all").');
    const expected = b['expected_count'];
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) throw new AppError(400, 'validation_error', 'Indica cuántos negocios viste en la vista previa (expected_count).');
    res.json(await assignment.migrateToPublished({
      planId: param(req, 'planId'), toRevisionId: String(b['to_revision_id'] ?? ''), tenantIds, expectedCount: expected,
      reason: assertReason(b['reason']), actor: actorOf(req),
    }));
  }));

  return router;
}
