/**
 * API del AI Core para el panel del negocio (FR-0013..FR-0017). Tenant y actor SIEMPRE de la
 * sesión; permisos por acción (RBAC espejo en BD); recursos ajenos = mismo 404 que inexistentes.
 * Nada de aquí publica: web y social terminan en la aprobación humana existente; campañas nunca
 * autorizan gasto.
 */

import express, { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { requirePermission, type LooseRequest } from '../boundary/middleware.ts';
import { getRequestContext, type SessionSummary } from '../shared/context.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { resolveIdempotencyKey } from '../subscriptions/quota.ts';
import type { ConversationRepository } from '../conversation/repositories.ts';
import type { ContactPhoneService } from '../contact/phones.ts';
import { withEffectivePhone } from '../contact/phones.ts';
import { FACT_KEYS, FACT_LABELS, type BrandService } from '../brand/service.ts';
import type { MediaService, MediaAssetRow } from '../media/service.ts';
import type { AiJobs, AiJobRow } from '../ai/jobs.ts';
import type { AiBusinessService, BizActor } from '../ai/business.ts';
import type { AiSiteService } from '../website/ai-site.ts';
import type { WebsiteRepository } from '../website/repository.ts';
import { normalizeWebsiteData, renderSite } from '../website/template.ts';
import type { AiRegistry } from '../ai/registry.ts';
import { USE_CASES } from '../ai/contracts.ts';

export interface AiRouteDeps {
  pool: Pool;
  sink: AuditSink;
  brand: BrandService;
  media: MediaService;
  jobs: AiJobs;
  business: AiBusinessService;
  site: AiSiteService;
  registry: AiRegistry;
  environment: string;
  repo: ConversationRepository;
  websiteRepo: WebsiteRepository;
  phones: ContactPhoneService;
}

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: (err?: unknown) => void) => {
    fn(req, res).catch(next);
  };
}

function actorOf(req: Request): BizActor & { session: SessionSummary } {
  const lreq = req as LooseRequest;
  const ctx = getRequestContext();
  const session = ctx?.session ?? lreq.session;
  if (!session) throw new AppError(401, DENY_CODES.MISSING_ACTOR, 'No se encontró una sesión activa.');
  return { tenantId: session.tenant_id, userId: session.user_id, role: session.role_name, requestId: ctx?.request_id ?? lreq.request_id ?? 'no-ctx', permissions: session.permissions, session };
}

function idem(req: Request, a: BizActor): string {
  return resolveIdempotencyKey(req.get('idempotency-key'), a.requestId);
}

/** Vista pública de un job: nunca entrega prompts, salidas crudas ni ids de ruta internos. */
export function jobView(j: AiJobRow): Record<string, unknown> {
  return { job_id: j.job_id, kind: j.kind, status: j.status, progress: j.progress, result: j.result, error_code: j.error_code, attempts: j.attempts, created_at: j.created_at, finished_at: j.finished_at };
}

function mediaView(m: MediaAssetRow): Record<string, unknown> {
  return {
    asset_id: m.asset_id, source: m.source, status: m.status, purpose: m.purpose, width: m.width, height: m.height, alt_text: m.alt_text,
    license: m.license, is_illustration: m.is_illustration, generator_model: m.generator_model, created_at: m.created_at,
    variants: m.variants ?? [], url: `/media/${m.asset_id}/w640.webp`,
  };
}

export function aiRouter(deps: AiRouteDeps): Router {
  const router = Router();
  const perm = (p: Parameters<typeof requirePermission>[0]) => requirePermission(p, deps.sink, deps.pool);

  // ------------------------------------------------------------------ estado
  router.get('/ai/status', perm('data.read'), ah(async (req, res) => {
    const a = actorOf(req);
    const rows = await deps.pool.query<{ use_case_id: string; active_route_id: string | null; model_id: string | null; kind: string | null }>(
      `SELECT ro.use_case_id, ro.active_route_id, r.model_id, p.kind FROM ai_rollout ro
         LEFT JOIN ai_route_revision r ON r.route_id = ro.active_route_id LEFT JOIN ai_model m ON m.model_id = r.model_id
         LEFT JOIN ai_provider p ON p.provider_id = m.provider_id WHERE ro.environment = $1`, [deps.environment]);
    const byUc = new Map(rows.rows.map((r) => [r.use_case_id, r]));
    const budget = await deps.pool.query<{ limit_usd: string | null; spent: string | null }>(
      `SELECT (SELECT limit_usd FROM ai_budget WHERE scope = 'tenant_day' AND (tenant_id = $1 OR tenant_id IS NULL) ORDER BY tenant_id NULLS LAST LIMIT 1) AS limit_usd,
              (SELECT COALESCE(SUM(COALESCE(cost_usd, reserved_usd)), 0) FROM ai_invocation WHERE tenant_id = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS spent`, [a.tenantId]);
    res.json({
      environment: deps.environment,
      capabilities: USE_CASES.map((uc) => {
        const r = byUc.get(uc);
        return { use_case: uc, active: Boolean(r?.active_route_id), simulated: r?.kind === 'simulated' };
      }),
      budget_today_usd: { limit: budget.rows[0]?.limit_usd === null || budget.rows[0]?.limit_usd === undefined ? null : Number(budget.rows[0].limit_usd), spent: Number(budget.rows[0]?.spent ?? 0) },
    });
  }));

  // ------------------------------------------------------------------ Brand Studio
  router.get('/ai/brand', perm('brand.read'), ah(async (req, res) => {
    const a = actorOf(req);
    const cur = await deps.brand.current(a.tenantId);
    res.json({
      version: cur.version,
      facts: FACT_KEYS.map((k) => {
        const f = cur.facts[k];
        return { key: k, label: FACT_LABELS[k], value: f?.value ?? null, status: f?.status ?? null, source: f?.source ?? null, version: f?.brand_version ?? null, valid_until: f?.valid_until ?? null, updated_at: f?.created_at ?? null };
      }),
    });
  }));

  router.put('/ai/brand', perm('brand.manage'), ah(async (req, res) => {
    const a = actorOf(req);
    const changes = (req.body ?? {})['changes'];
    const out = await deps.brand.update(a, Array.isArray(changes) ? changes : []);
    const stale = await deps.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM action_proposal WHERE tenant_id = $1 AND status IN ('preview_ready','awaiting_confirmation','confirmed')
         AND (detail->'ai'->>'brand_version')::int < $2`, [a.tenantId, out.version]);
    res.json({ ...out, stale_proposals: Number(stale.rows[0]?.n ?? 0) });
  }));

  // ------------------------------------------------------------------ biblioteca multimedia
  router.get('/ai/media', perm('media.read'), ah(async (req, res) => {
    const a = actorOf(req);
    const status = typeof req.query['status'] === 'string' && ['draft', 'approved', 'archived'].includes(req.query['status']) ? req.query['status'] : undefined;
    res.json({ assets: (await deps.media.list(a.tenantId, { status })).map(mediaView) });
  }));

  // Subida del dueño: bytes crudos (PNG/JPG/WebP ≤ 8 MB) + declaración de derechos obligatoria.
  router.post('/ai/media', perm('media.manage'), express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '8mb' }), ah(async (req, res) => {
    const a = actorOf(req);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new AppError(400, 'validation_error', 'Sube una imagen PNG, JPG o WebP.');
    if (req.get('x-rights-confirmed') !== 'yes') throw new AppError(400, 'validation_error', 'Confirma que la imagen es tuya o que tienes derecho a usarla.');
    const alt = decodeURIComponent(req.get('x-alt-text') ?? '');
    const purpose = /^[a-z._]{3,40}$/.test(req.get('x-purpose') ?? '') ? String(req.get('x-purpose')) : 'library';
    const row = await deps.media.store({ tenantId: a.tenantId, bytes: req.body, source: 'uploaded', purpose, alt, license: 'Propia del negocio (declarada por quien la subió)', isIllustration: false, createdBy: a.userId, requestId: a.requestId, actorRole: a.role });
    res.status(201).json({ asset: mediaView(row) });
  }));

  router.patch('/ai/media/:id', perm('media.manage'), ah(async (req, res) => {
    const a = actorOf(req);
    const body = (req.body ?? {}) as { status?: unknown; alt_text?: unknown };
    if (body.status !== 'approved' && body.status !== 'archived') throw new AppError(400, 'validation_error', 'Elige aprobar o archivar.');
    const row = await deps.media.setStatus(a, req.params['id'] as string, body.status, typeof body.alt_text === 'string' ? body.alt_text : undefined);
    res.json({ asset: mediaView(row) });
  }));

  // ------------------------------------------------------------------ jobs
  router.get('/ai/jobs/:id', perm('data.read'), ah(async (req, res) => {
    const a = actorOf(req);
    const job = await deps.jobs.get(a.tenantId, req.params['id'] as string);
    if (!job) return res.status(404).json({ error: { code: 'not_found', message: 'No encontramos ese trabajo.' } });
    return res.json({ job: jobView(job) });
  }));

  router.get('/ai/jobs', perm('data.read'), ah(async (req, res) => {
    const a = actorOf(req);
    const kind = typeof req.query['kind'] === 'string' ? req.query['kind'] : null;
    const r = await deps.pool.query<AiJobRow>(`SELECT * FROM ai_job WHERE tenant_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY created_at DESC LIMIT 20`, [a.tenantId, kind]);
    res.json({ jobs: r.rows.map(jobView) });
  }));

  // ------------------------------------------------------------------ web (FR-0014)
  router.post('/ai/website/design', perm('ai.generate'), ah(async (req, res) => {
    const a = actorOf(req);
    const { job, created } = await deps.site.requestDesign(a, (req.body ?? {})['brief'], idem(req, a));
    res.status(created ? 202 : 200).json({ job: jobView(job), replayed: !created });
  }));

  router.post('/ai/website/edit', perm('ai.generate'), ah(async (req, res) => {
    const a = actorOf(req);
    const { job, created } = await deps.site.requestEdit(a, (req.body ?? {})['instruction'], idem(req, a));
    res.status(created ? 202 : 200).json({ job: jobView(job), replayed: !created });
  }));

  router.get('/ai/website/render', perm('data.read'), ah(async (req, res) => {
    const a = actorOf(req);
    const site = await deps.websiteRepo.websiteForTenant(a.tenantId);
    if (!site || Number(site.published_version) === 0) return res.status(404).json({ error: { code: 'not_found', message: 'Todavía no hay una versión publicada.' } });
    const html = await deps.pool.query<{ html: string }>('SELECT html FROM website_content WHERE website_id = $1 AND tenant_id = $2 AND version = $3', [site.website_id, a.tenantId, site.published_version]);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ html: html.rows[0]?.html ?? '', designed: Boolean(deps.websiteRepo.dataOf(site).design) });
  }));

  /** HTML del servidor (el mismo que se publicaría) para la vista previa dentro del panel. */
  router.get('/ai/website/proposals/:id/render', perm('conversation.read'), ah(async (req, res) => {
    const a = actorOf(req);
    const found = await deps.repo.findProposalScoped(a.tenantId, req.params['id'] as string);
    if (!found.found || !found.in_tenant || found.row?.capability_target !== 'website') return res.status(404).json({ error: { code: 'not_found', message: 'No se encontró la propuesta solicitada.' } });
    const before = req.query['ver'] === 'antes';
    let data;
    if (before) {
      const site = await deps.websiteRepo.websiteForTenant(a.tenantId);
      data = site ? deps.websiteRepo.dataOf(site) : null;
    } else {
      data = normalizeWebsiteData(((found.row?.detail ?? {}) as Record<string, unknown>)['after']);
    }
    if (!data) return res.status(404).json({ error: { code: 'not_found', message: 'Todavía no hay una versión publicada.' } });
    const withPhone = await withEffectivePhone(deps.phones, a.tenantId, data);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ html: renderSite(withPhone, before ? {} : { previewBanner: 'Vista previa — aún no publicado' }), designed: Boolean(withPhone.design) });
  }));

  // ------------------------------------------------------------------ social (FR-0015)
  router.post('/ai/social/compose', perm('ai.generate'), requirePermission('social.create', deps.sink, deps.pool), ah(async (req, res) => {
    const a = actorOf(req);
    const { job, created } = await deps.business.requestCompose(a, req.body ?? {}, idem(req, a));
    res.status(created ? 202 : 200).json({ job: jobView(job), replayed: !created });
  }));

  router.post('/ai/social/compose/:job/draft', perm('social.create'), ah(async (req, res) => {
    const a = actorOf(req);
    const body = (req.body ?? {}) as { variant?: unknown; text?: unknown; use_image?: unknown };
    const out = await deps.business.draftFromCompose(a, req.params['job'] as string, body.variant, body.text, body.use_image);
    res.status(out.replayed ? 200 : 201).json(out);
  }));

  // ------------------------------------------------------------------ asistente (FR-0017)
  router.post('/ai/assistant', perm('assistant.ask'), ah(async (req, res) => {
    const a = actorOf(req);
    res.json(await deps.business.ask(a, (req.body ?? {})['question'], idem(req, a)));
  }));

  // ------------------------------------------------------------------ insights, campañas, calendario
  router.post('/ai/insights', perm('insights.read'), ah(async (req, res) => {
    const a = actorOf(req);
    res.json(await deps.business.insights(a, (req.body ?? {})['period_days'], idem(req, a)));
  }));

  router.get('/ai/insights', perm('insights.read'), ah(async (req, res) => {
    const a = actorOf(req);
    const r = await deps.pool.query(`SELECT insight_id, period_start, period_end, status, summary, recommendations, evidence, created_at FROM ai_insight WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`, [a.tenantId]);
    res.json({ insights: r.rows });
  }));

  router.post('/ai/campaigns', perm('campaign.plan'), ah(async (req, res) => {
    const a = actorOf(req);
    res.status(201).json({ campaign: await deps.business.proposeCampaign(a, req.body ?? {}, idem(req, a)) });
  }));

  router.get('/ai/campaigns', perm('insights.read'), ah(async (req, res) => {
    const a = actorOf(req);
    res.json({ campaigns: await deps.business.campaigns(a.tenantId) });
  }));

  router.post('/ai/campaigns/:id/decision', perm('campaign.approve'), ah(async (req, res) => {
    const a = actorOf(req);
    res.json({ campaign: await deps.business.decideCampaign(a, req.params['id'] as string, (req.body ?? {})['decision']) });
  }));

  router.post('/ai/editorial', perm('ai.generate'), ah(async (req, res) => {
    const a = actorOf(req);
    res.status(201).json({ ideas: await deps.business.suggestCalendar(a, req.body ?? {}, idem(req, a)) });
  }));

  router.get('/ai/editorial', perm('social.read'), ah(async (req, res) => {
    const a = actorOf(req);
    res.json({ ideas: await deps.business.calendar(a.tenantId) });
  }));

  router.post('/ai/editorial/:id/decision', perm('social.create'), ah(async (req, res) => {
    const a = actorOf(req);
    const body = (req.body ?? {}) as { decision?: unknown; feedback?: unknown };
    await deps.business.decideSuggestion(a, req.params['id'] as string, body.decision, body.feedback);
    res.json({ ok: true });
  }));

  return router;
}

/** Imágenes de la biblioteca en el host del panel (capability URL de 128 bits; archivadas = 404). */
export function mediaRouter(media: MediaService): Router {
  const router = Router();
  router.get('/media/:id/:variant.webp', ah(async (req, res) => {
    const found = await media.variant(req.params['id'] as string, req.params['variant'] as string);
    if (!found) return res.status(404).type('text/plain').send('not found');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.status(200).type(found.mime).send(found.bytes);
  }));
  return router;
}
