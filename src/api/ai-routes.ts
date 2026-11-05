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
import type { AiDispatcher, InvokeContext, InvokeResult } from '../ai/dispatcher.ts';
import type { AiLab } from '../ai/lab.ts';
import { redactContactData } from '../ai/minimize.ts';
import { toClassification } from '../engagement/ai-semantics.ts';
import { USE_CASES, replyViolations, type ReplyOutput } from '../ai/contracts.ts';

export interface AiRouteDeps {
  pool: Pool;
  sink: AuditSink;
  brand: BrandService;
  media: MediaService;
  jobs: AiJobs;
  business: AiBusinessService;
  site: AiSiteService;
  registry: AiRegistry;
  dispatcher: AiDispatcher;
  lab: AiLab;
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
  const labGrantId = req.get('x-ai-lab-grant');
  if (labGrantId !== undefined && (!labGrantId.trim() || labGrantId.length > 160)) throw new AppError(400, 'validation_error', 'Selecciona una autorización de laboratorio válida.');
  return { tenantId: session.tenant_id, userId: session.user_id, role: session.role_name, requestId: ctx?.request_id ?? lreq.request_id ?? 'no-ctx', permissions: session.permissions, session, labGrantId: labGrantId ?? null };
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
  const requireLab = async (a: BizActor, useCaseId: string) => {
    const access = await deps.lab.check({ grantId: a.labGrantId ?? null, tenantId: a.tenantId, userId: a.userId, useCaseId });
    if (!access.ok) {
      await deps.sink.write({ tenant_id: a.tenantId, actor_id: a.userId, actor_role: a.role, action: 'ai.lab.invoke', resource: `ai_use_case/${useCaseId}`, request_id: a.requestId, decision: 'deny', result: access.reason });
      throw new AppError(403, 'permission_denied', 'La autorización de laboratorio no está vigente o no permite esta acción. Vuelve a seleccionarla en Laboratorio.');
    }
    return access;
  };
  const labContext = (a: BizActor, key: string): InvokeContext => ({
    requestId: a.requestId, idempotencyKey: key, tenantId: a.tenantId, actorId: a.userId,
    actorKind: 'tenant_user', origin: 'lab.manual-preview', labGrantId: a.labGrantId ?? null,
  });
  const generationError = (r: Extract<InvokeResult<unknown>, { ok: false }>): AppError => {
    const status = r.code === 'lab_grant_invalid' ? 403 : r.code === 'budget_exhausted' ? 429 : r.code === 'in_progress' ? 409 : 502;
    const message = r.code === 'lab_grant_invalid' ? 'La autorización de laboratorio venció, fue revocada o no permite esta ruta.'
      : r.code === 'budget_exhausted' ? 'Se alcanzó un presupuesto interno de IA. Los créditos del proveedor no amplían ese límite.'
        : r.code === 'in_progress' ? 'Esta ejecución ya está en curso o terminó. Revisa su resultado antes de iniciar otra.'
          : `La ejecución no terminó (${r.code}). Revisa la traza en Engineering; no se cambió de proveedor ni se aprobó la ruta.`;
    return new AppError(status, status === 403 ? 'permission_denied' : status === 429 ? DENY_CODES.LIMIT_EXCEEDED : 'validation_error', message);
  };

  router.get('/ai/lab', perm('data.read'), ah(async (req, res) => {
    const a = actorOf(req);
    res.json({ environment: deps.environment, enabled: deps.lab.enabled, grants: await deps.lab.grantsForUser(a.tenantId, a.userId) });
  }));

  // ------------------------------------------------------------------ estado
  router.get('/ai/status', perm('data.read'), ah(async (req, res) => {
    const a = actorOf(req);
    if (a.labGrantId) await deps.lab.authorize({ grantId: a.labGrantId, tenantId: a.tenantId, userId: a.userId });
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
      // Falso fuera del entorno `lab` y siempre en producción (DEC-0077 R5): el panel no ofrece el laboratorio.
      lab_enabled: deps.lab.enabled,
      capabilities: USE_CASES.map((uc) => {
        const r = byUc.get(uc);
        return { use_case: uc, active: Boolean(r?.active_route_id), simulated: r?.kind === 'simulated' };
      }),
      budget_today_usd: { limit: budget.rows[0]?.limit_usd === null || budget.rows[0]?.limit_usd === undefined ? null : Number(budget.rows[0].limit_usd), spent: Number(budget.rows[0]?.spent ?? 0) },
      lab: a.labGrantId ? await deps.lab.statusFor({ grantId: a.labGrantId, tenantId: a.tenantId, userId: a.userId }) : null,
    });
  }));

  // Pruebas manuales explícitas: producen biblioteca/borradores, nunca respuestas públicas ni gasto Ads.
  router.post('/ai/lab/images', perm('ai.generate'), requirePermission('media.manage', deps.sink, deps.pool), ah(async (req, res) => {
    const a = actorOf(req);
    const b = (req.body ?? {}) as { purpose?: unknown; subject?: unknown; style?: unknown; aspect_ratio?: unknown };
    if (b.purpose !== 'website' && b.purpose !== 'social') throw new AppError(400, 'validation_error', 'Elige imagen para web o redes.');
    const subject = typeof b.subject === 'string' ? redactContactData(b.subject.trim()) : '';
    const style = typeof b.style === 'string' ? redactContactData(b.style.trim()) : '';
    if (subject.length < 10 || subject.length > 400 || style.length < 3 || style.length > 200) throw new AppError(400, 'validation_error', 'Describe el tema (10–400 caracteres) y el estilo (3–200). No incluyas datos personales.');
    if (!['16:9', '4:3', '1:1', '3:4', '4:5'].includes(String(b.aspect_ratio))) throw new AppError(400, 'validation_error', 'Elige un formato de imagen admitido.');
    const useCase = b.purpose === 'website' ? 'website.image.generate' : 'social.facebook.image.generate';
    await requireLab(a, useCase);
    const facts = await deps.brand.confirmed(a.tenantId, ['palette']);
    const palette = Array.isArray(facts.facts.palette) ? facts.facts.palette.slice(0, 3).join(', ') : 'cálidos';
    const result = await deps.dispatcher.invokeImage(useCase, labContext(a, `lab-image:${b.purpose}:${idem(req, a)}`),
      { subject, style, palette }, b.aspect_ratio as '16:9' | '4:3' | '1:1' | '3:4' | '4:5');
    if (!result.ok) {
      if (result.code === 'in_progress' && result.invocationId) {
        const found = await deps.pool.query<{ asset_id: string; route_id: string; model_id: string; provider_id: string; cost_usd: string | null }>(
          `SELECT a.asset_id, i.route_id, i.model_id, i.provider_id, i.cost_usd FROM media_asset a JOIN ai_invocation i ON i.invocation_id = a.invocation_id
            WHERE a.tenant_id = $1 AND a.invocation_id = $2 AND a.status <> 'archived'`, [a.tenantId, result.invocationId]);
        const previous = found.rows[0];
        const asset = previous ? await deps.media.get(a.tenantId, previous.asset_id) : null;
        if (previous && asset) return res.json({ invocation_id: result.invocationId, asset: { ...mediaView(asset), alt: asset.alt_text }, replayed: true, simulated: false, cost_usd: previous.cost_usd === null ? null : Number(previous.cost_usd), model: previous.model_id, provider: previous.provider_id, route_id: previous.route_id });
      }
      throw generationError(result);
    }
    const asset = await deps.media.store({
      tenantId: a.tenantId, bytes: result.output.bytes, source: 'ai_generated', purpose: `lab.${b.purpose}`,
      alt: subject.slice(0, 150), license: `Ilustración generada por IA (${result.route.model_id}) para el negocio`,
      isIllustration: true, generatorModel: result.route.model_id, invocationId: result.invocationId,
      promptSummary: subject, createdBy: a.userId, requestId: a.requestId, actorRole: a.role,
    });
    return res.status(201).json({ invocation_id: result.invocationId, asset: { ...mediaView(asset), alt: asset.alt_text }, simulated: result.simulated, cost_usd: result.costUsd, model: result.route.model_id, provider: result.route.provider_id, route_id: result.route.route_id });
  }));

  router.post('/ai/lab/replies', perm('ai.generate'), requirePermission('engagement.respond', deps.sink, deps.pool), ah(async (req, res) => {
    const a = actorOf(req);
    const b = (req.body ?? {}) as { origin?: unknown; message?: unknown; rating?: unknown };
    if (b.origin !== 'facebook_comment' && b.origin !== 'google_review') throw new AppError(400, 'validation_error', 'Elige comentario de Facebook o reseña de Google.');
    const message = typeof b.message === 'string' ? redactContactData(b.message.trim()) : '';
    if (!message || message.length > 2000) throw new AppError(400, 'validation_error', 'Escribe un mensaje de hasta 2000 caracteres sin datos personales.');
    const rating = b.rating === undefined || b.rating === null || b.rating === '' ? null : Number(b.rating);
    if (rating !== null && (b.origin !== 'google_review' || !Number.isInteger(rating) || rating < 1 || rating > 5)) throw new AppError(400, 'validation_error', 'La calificación de la reseña va de 1 a 5.');
    const prefix = b.origin === 'google_review' ? 'engagement.google.review' : 'engagement.facebook.comment';
    await requireLab(a, `${prefix}.reply`);
    const key = idem(req, a);
    const classified = await deps.dispatcher.invokeClassification(`${prefix}.classify`, labContext(a, `lab-reply:classify:${b.origin}:${key}`), { message, ...(rating === null ? {} : { rating_stars: rating }) });
    if (!classified.ok) throw generationError(classified);
    const semantic = toClassification(classified.output.answers);
    const facts = await deps.brand.confirmed(a.tenantId, ['name', 'address', 'hours', 'services']);
    const result = await deps.dispatcher.invokeStructured<ReplyOutput>(`${prefix}.reply`, { ...labContext(a, `lab-reply:generate:${b.origin}:${key}`), brandVersion: facts.version }, {
      facts: facts.facts, reading: { sentiment: semantic.classification.sentiment, category: semantic.classification.category, risks: semantic.classification.risk_flags },
      author: 'cliente', rating: rating === null ? 'n/a' : String(rating), message,
    }, { domainCheck: replyViolations });
    if (!result.ok) throw generationError(result);
    return res.json({
      invocation_id: result.invocationId, classification_invocation_id: classified.invocationId, classification: semantic.classification,
      reply: { text: result.output.reply, needs_human: result.output.needs_human || semantic.classification.risk_flags.length > 0, reason: result.output.reason, facts_used: result.output.facts_used },
      review_required: true, published: false, model: result.route.model_id, provider: result.route.provider_id, route_id: result.route.route_id, cost_usd: result.costUsd, simulated: result.simulated,
    });
  }));

  // ------------------------------------------------------------------ Brand Studio
  router.get('/ai/brand', perm('brand.read'), ah(async (req, res) => {
    const a = actorOf(req);
    let cur = await deps.brand.current(a.tenantId);
    if (cur.version === 0) {
      // Inicialización perezosa: lo que el dueño escribió al crear su página es dato propio (confirmado).
      const site = await deps.websiteRepo.websiteForTenant(a.tenantId);
      if (site) {
        const d = deps.websiteRepo.dataOf(site);
        const imported = await deps.brand.importFromWebsite({ tenantId: a.tenantId, userId: 'system:brand-import', role: null, requestId: a.requestId },
          { name: d.name || site.site_name, line: d.line, about: d.about, address: d.address, hours: d.hours, services: d.services });
        if (imported) cur = await deps.brand.current(a.tenantId);
      }
    }
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
    const b = (req.body ?? {}) as { request?: unknown; with_image?: unknown; editorial_id?: unknown };
    // La liga con una solicitud de chat solo la fija el servidor (Telegram), nunca el cliente del panel.
    const { job, created } = await deps.business.requestCompose(a, { request: b.request, with_image: b.with_image, editorial_id: b.editorial_id }, idem(req, a));
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
