/**
 * Diseño y edición de la página con el AI Core (FR-0014): jobs durables que terminan en una
 * propuesta con vista previa; publicar SIEMPRE requiere la aprobación humana existente.
 *
 * - `website.design`: hechos confirmados (mínimos) -> diseño DSL validado -> imágenes de la
 *   biblioteca (generadas si la ruta de imagen está activa; si no, fotos subidas por el dueño) ->
 *   propuesta `website.ai_design`.
 * - `website.edit`: Jev clasifica el alcance (simple/complejo/rediseño); la ruta del alcance
 *   devuelve un parche tipado que se aplica y revalida -> propuesta `website.ai_edit`.
 * Cada paso usa una clave de idempotencia `job:<id>:<paso>`: un reintento tras caída no paga dos veces.
 */

import type { Pool } from 'pg';
import type { AiDispatcher, InvokeContext, InvokeResult } from '../ai/dispatcher.ts';
import { AiJobError, type AiJobs, type JobContext } from '../ai/jobs.ts';
import type { EditOutput } from '../ai/contracts.ts';
import type { Answer, ChoiceAnswer } from '../jev/types.ts';
import type { BrandService, FactKey } from '../brand/service.ts';
import type { MediaService, MediaAssetRow } from '../media/service.ts';
import { AppError } from '../shared/errors.ts';
import { accessiblePalette, DESIGN_SCHEMA_VERSION, validateDesign, type DesignImageAsset, type ImageSlot, type SiteDesign, type StoredDesign } from './design.ts';
import { applyEdit } from './design-edit.ts';
import { normalizeWebsiteData, type WebsiteData } from './template.ts';
import { AI_DESIGN_PROPOSAL_TYPE, AI_EDIT_PROPOSAL_TYPE, prepareAiSiteChange, type SiteProposalDeps } from './site-proposals.ts';

export const DESIGN_FACT_KEYS: readonly FactKey[] = ['name', 'category', 'description', 'value_proposition', 'voice', 'audience', 'avoid_tones', 'palette', 'fonts', 'services', 'address', 'hours', 'cta', 'prices', 'promotions', 'restrictions'];
export const EDIT_SCOPE_USE_CASE: Record<string, string> = {
  content_simple: 'website.edit.simple', style_simple: 'website.edit.simple', layout_complex: 'website.edit.complex',
};

export interface Requester { tenantId: string; userId: string; role: string | null; requestId: string }

export interface AiSiteDeps {
  pool: Pool;
  dispatcher: AiDispatcher;
  jobs: AiJobs;
  brand: BrandService;
  media: MediaService;
  site: SiteProposalDeps;
}

function failure(res: Extract<InvokeResult<unknown>, { ok: false }>): AiJobError {
  return new AiJobError(res.code, res.retryable, res.reason);
}

function choice(a: Answer | undefined): string | null {
  return a && a.type === 'choice' ? (a as ChoiceAnswer).choice : null;
}

function assetOf(row: MediaAssetRow): DesignImageAsset {
  return { asset_id: row.asset_id, alt: row.alt_text, width: row.width, height: row.height, is_illustration: row.is_illustration, variants: row.variants ?? [] };
}

/** Vista compacta del diseño para el prompt de edición (bloques numerados, sin assets). */
export function designForPrompt(d: SiteDesign | null): unknown {
  if (!d) return { template: 'clasica', note: 'La página usa la plantilla clásica: solo se pueden cambiar datos (set_fact).' };
  return {
    theme: d.theme,
    blocks: d.blocks.map((b, index) => ({ index, type: b.type, variant: b.variant, tone: b.tone, heading: b.heading, subheading: b.subheading, body: b.body, items: b.items, cta: b.cta, image_slot: b.image_slot })),
  };
}

export class AiSiteService {
  private readonly deps: AiSiteDeps;

  constructor(deps: AiSiteDeps) {
    this.deps = deps;
    deps.jobs.register('website.design', (ctx) => this.runDesign(ctx));
    deps.jobs.register('website.edit', (ctx) => this.runEdit(ctx));
  }

  private ctx(job: JobContext['job'], useCase: string, step: string, brandVersion: number | null): InvokeContext {
    return {
      requestId: `job:${job.job_id}`, idempotencyKey: `job:${job.job_id}:${step}:a${job.attempts}`, tenantId: job.tenant_id, actorId: job.created_by,
      actorKind: 'tenant_user', origin: job.kind, brandVersion, jobId: job.job_id, pinnedRouteId: job.pinned[useCase] ?? null,
    };
  }

  async requestDesign(r: Requester, brief: unknown, idempotencyKey: string) {
    const text = typeof brief === 'string' ? brief.trim() : '';
    if (text.length > 1500) throw new AppError(400, 'validation_error', 'Cuéntanos tu idea en hasta 1500 caracteres.');
    const site = await this.deps.site.websiteRepo.websiteForTenant(r.tenantId);
    if (!site) throw new AppError(409, 'website_missing', 'Todavía no tienes página. Primero créala con los datos de tu negocio.');
    return this.deps.jobs.enqueue({
      tenantId: r.tenantId, kind: 'website.design', idempotencyKey, createdBy: r.userId,
      input: { brief: text || 'Una página clara y atractiva que invite a visitarnos.', actor_role: r.role },
      useCases: ['website.initial.design', 'website.image.generate'],
    });
  }

  async requestEdit(r: Requester, instruction: unknown, idempotencyKey: string) {
    const text = typeof instruction === 'string' ? instruction.trim() : '';
    if (!text || text.length > 1000) throw new AppError(400, 'validation_error', 'Escribe el cambio que quieres en hasta 1000 caracteres.');
    const site = await this.deps.site.websiteRepo.websiteForTenant(r.tenantId);
    if (!site || Number(site.published_version) === 0) throw new AppError(409, 'validation_error', 'Primero publica tu página; después puedes pedir cambios.');
    return this.deps.jobs.enqueue({
      tenantId: r.tenantId, kind: 'website.edit', idempotencyKey, createdBy: r.userId,
      input: { instruction: text, actor_role: r.role },
      useCases: ['conversation.intent.classify', 'website.edit.simple', 'website.edit.complex', 'website.initial.design', 'website.image.generate'],
    });
  }

  // ------------------------------------------------------------------ diseño

  private async runDesign(jc: JobContext, briefOverride?: string): Promise<Record<string, unknown>> {
    const { job } = jc;
    const site = await this.deps.site.websiteRepo.websiteForTenant(job.tenant_id);
    if (!site) throw new AiJobError('website_missing', false);
    const current = this.deps.site.websiteRepo.dataOf(site);
    const actor = { tenantId: job.tenant_id, userId: job.created_by, role: (job.input['actor_role'] as string | null) ?? null, requestId: `job:${job.job_id}` };
    // Lo que el dueño escribió al crear su página es dato propio: entra confirmado si la marca está vacía.
    await this.deps.brand.importFromWebsite(actor, { name: current.name || site.site_name, line: current.line, about: current.about, address: current.address, hours: current.hours, services: current.services });
    const facts = await this.deps.brand.confirmed(job.tenant_id, DESIGN_FACT_KEYS);
    const unconfirmed = await this.deps.brand.unconfirmed(job.tenant_id);
    const allowance = { confirmedPriceStrings: await this.deps.brand.allowedPriceStrings(job.tenant_id) };
    await jc.progress({ step: 'design', brand_version: facts.version });

    const res = await this.deps.dispatcher.invokeStructured<SiteDesign>('website.initial.design', this.ctx(job, 'website.initial.design', 'design', facts.version),
      { brand_facts: facts.facts, unconfirmed_facts: unconfirmed, brief: briefOverride ?? String(job.input['brief'] ?? '') },
      { domainCheck: (out) => validateDesign(out, allowance).errors });
    if (!res.ok) throw failure(res);
    const design = res.output;

    const assets: Partial<Record<ImageSlot, DesignImageAsset>> = {};
    const blocked: string[] = [];
    const invocationIds = [res.invocationId];
    for (const req of design.images) {
      await jc.progress({ step: `image:${req.slot}` });
      const img = await this.deps.dispatcher.invokeImage('website.image.generate', this.ctx(job, 'website.image.generate', `img:${req.slot}`, facts.version),
        { subject: req.subject, style: req.style, palette: Object.values(design.theme.palette).slice(0, 3).join(', ') }, req.aspect);
      if (img.ok) {
        const row = await this.deps.media.store({
          tenantId: job.tenant_id, bytes: img.output.bytes, source: 'ai_generated', purpose: `website.${req.slot}`, alt: req.alt,
          license: `Ilustración generada por IA (${img.route.model_id}) para el negocio`, isIllustration: true,
          generatorModel: img.route.model_id, invocationId: img.invocationId, promptSummary: req.subject, createdBy: job.created_by, requestId: `job:${job.job_id}`,
        });
        assets[req.slot] = assetOf(row);
        invocationIds.push(img.invocationId);
      } else if (img.code === 'in_progress' && img.invocationId) {
        // Reintento tras caída: la imagen ya se generó y guardó con esta clave.
        const prev = await this.deps.pool.query<{ asset_id: string }>('SELECT asset_id FROM media_asset WHERE tenant_id = $1 AND invocation_id = $2', [job.tenant_id, img.invocationId]);
        const row = prev.rows[0] ? await this.deps.media.get(job.tenant_id, prev.rows[0].asset_id) : null;
        if (row) assets[req.slot] = assetOf(row); else blocked.push(`${req.slot}:in_progress`);
      } else {
        blocked.push(`${req.slot}:${img.code}`);
      }
    }
    // Sin imagen generada: fotos que el propio dueño subió a su biblioteca (nunca imágenes ajenas).
    const missing = design.images.filter((r) => !assets[r.slot]);
    if (missing.length) {
      const own = (await this.deps.media.list(job.tenant_id, { limit: 50 })).filter((a) => a.source === 'uploaded' && a.status !== 'archived');
      missing.forEach((r, i) => { const a = own[i]; if (a) assets[r.slot] = assetOf(a); });
    }

    const stored: StoredDesign = {
      schema: DESIGN_SCHEMA_VERSION, design, assets, adjustments: accessiblePalette(design.theme.palette).adjustments,
      generated_by: { invocation_id: res.invocationId, route_id: res.route.route_id, model_id: res.route.model_id, brand_version: facts.version },
    };
    const after: WebsiteData = normalizeWebsiteData({ ...current, design: stored });
    const summary = Number(site.published_version) > 0 ? 'Nuevo diseño de tu página, hecho a la medida de tu negocio.' : 'Primera versión de tu página con un diseño hecho a la medida de tu negocio.';
    const sentences = [summary, `Estilo ${design.theme.mood} con ${design.blocks.length} secciones.`,
      ...(Object.keys(assets).length ? [`Usa ${Object.keys(assets).length} imagen(es) de tu biblioteca.`] : ['Sin imágenes por ahora (puedes subir fotos a tu biblioteca).'])];
    await jc.progress({ step: 'proposal' });
    const out = await prepareAiSiteChange(this.deps.site, { tenantId: job.tenant_id, actorId: job.created_by, actorRole: actor.role, requestId: `job:${job.job_id}` }, {
      type: AI_DESIGN_PROPOSAL_TYPE, after, summary, sentences,
      ai: { job_id: job.job_id, invocation_ids: invocationIds, brand_version: facts.version, route_ids: [res.route.route_id] },
    });
    return { proposal_id: out.proposal.proposal_id, proposal_status: out.proposal.status, images: Object.keys(assets).length, images_blocked: blocked, model: res.route.model_id, simulated: res.simulated };
  }

  // ------------------------------------------------------------------ edición

  private async runEdit(jc: JobContext): Promise<Record<string, unknown>> {
    const { job } = jc;
    const instruction = String(job.input['instruction'] ?? '');
    const site = await this.deps.site.websiteRepo.websiteForTenant(job.tenant_id);
    if (!site) throw new AiJobError('website_missing', false);
    const brandVersion = await this.deps.brand.version(job.tenant_id);

    await jc.progress({ step: 'classify' });
    const cls = await this.deps.dispatcher.invokeClassification('conversation.intent.classify', this.ctx(job, 'conversation.intent.classify', 'scope', brandVersion), { message: instruction });
    // Sin lectura semántica se elige la ruta más capaz (decisión conservadora, registrada).
    const scope = cls.ok ? choice(cls.output.answers['edit_scope']) ?? 'layout_complex' : 'layout_complex';
    const semantic = cls.ok ? 'jev' : cls.code === 'blocked_external' ? 'blocked_external' : 'unavailable';
    await jc.progress({ step: 'edit', scope, semantic_source: semantic });
    if (scope === 'not_web_edit') return { status: 'not_web_edit', scope, semantic_source: semantic, message: 'Ese mensaje no pide un cambio en tu página.' };
    if (scope === 'redesign') return { ...(await this.runDesign(jc, instruction)), scope, semantic_source: semantic };

    const useCase = EDIT_SCOPE_USE_CASE[scope] ?? 'website.edit.complex';
    const current = this.deps.site.websiteRepo.dataOf(site);
    const allowance = { confirmedPriceStrings: await this.deps.brand.allowedPriceStrings(job.tenant_id) };
    const res = await this.deps.dispatcher.invokeStructured<EditOutput>(useCase, this.ctx(job, useCase, 'patch', brandVersion), {
      current_design: designForPrompt(current.design?.design ?? null),
      page_facts: { name: current.name, line: current.line, about: current.about, address: current.address, hours: current.hours, email: current.email },
      instruction,
    }, { domainCheck: (out) => (out.operations.length ? applyEdit(current, out.operations, allowance).errors : []) });
    if (!res.ok) throw failure(res);
    if (!res.output.operations.length) {
      return { status: 'needs_clarification', scope, semantic_source: semantic, question: res.output.needs_clarification ?? '¿Puedes describir el cambio con más detalle?' };
    }
    const applied = applyEdit(current, res.output.operations, allowance);
    if (applied.errors.length) throw new AiJobError('invalid_output', false, applied.errors.join('; ').slice(0, 300));
    const out = await prepareAiSiteChange(this.deps.site, { tenantId: job.tenant_id, actorId: job.created_by, actorRole: (job.input['actor_role'] as string | null) ?? null, requestId: `job:${job.job_id}` }, {
      type: AI_EDIT_PROPOSAL_TYPE, after: applied.data, summary: res.output.summary, sentences: [res.output.summary, ...applied.sentences],
      ai: { job_id: job.job_id, invocation_ids: [...(cls.ok ? [cls.invocationId] : []), res.invocationId], brand_version: brandVersion, route_ids: [res.route.route_id] },
    });
    return { status: 'proposed', scope, semantic_source: semantic, use_case: useCase, model: res.route.model_id, proposal_id: out.proposal.proposal_id, proposal_status: out.proposal.status, operations: res.output.operations.length };
  }
}
