/**
 * Diseño y edición de la página con el AI Core (FR-0014): jobs durables que terminan en una
 * propuesta con vista previa; publicar SIEMPRE requiere la aprobación humana existente.
 *
 * - `website.design`: hechos confirmados (mínimos) -> diseño DSL validado -> imágenes de la
 *   biblioteca (generadas si la ruta de imagen está activa; si no, fotos subidas por el dueño) ->
 *   propuesta `website.ai_design`.
 * - `website.edit`: Jev clasifica el alcance (simple/complejo/rediseño); la ruta del alcance
 *   devuelve un parche tipado `site-edit/v2` que se aplica y revalida. Las imágenes pedidas se
 *   obtienen (biblioteca o generación) ANTES de crear la propuesta `website.ai_edit`: si una no se
 *   puede obtener, el job falla con el motivo y no se propone nada.
 * - Una edición pedida desde el chat (`conversation_request_id`) deja su propuesta en esa misma
 *   solicitud de la conversación.
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
import { accessiblePalette, DESIGN_SCHEMA_VERSION, designFromClassic, MOOD_LABEL, validateDesign, type DesignImageAsset, type ImageSlot, type SiteDesign, type StoredDesign } from './design.ts';
import { applyEdit, type ImageNeed } from './design-edit.ts';
import { normalizeWebsiteData, type WebsiteData } from './template.ts';
import { AI_DESIGN_PROPOSAL_TYPE, AI_EDIT_PROPOSAL_TYPE, prepareAiSiteChange, type AiRouteUse, type SiteProposalDeps } from './site-proposals.ts';

export const DESIGN_FACT_KEYS: readonly FactKey[] = ['name', 'category', 'description', 'value_proposition', 'voice', 'audience', 'avoid_tones', 'palette', 'fonts', 'services', 'address', 'hours', 'cta', 'prices', 'promotions', 'restrictions'];
export const EDIT_SCOPE_USE_CASE: Record<string, string> = {
  content_simple: 'website.edit.simple', style_simple: 'website.edit.simple', layout_complex: 'website.edit.complex',
};
/** Casos de uso generativos que puede ejecutar una edición (el alcance decide cuál). */
export const EDIT_USE_CASES = ['website.edit.simple', 'website.edit.complex'] as const;

/** Rutas con las que se ejecutaría una edición ahora mismo (rollout del entorno o grant del laboratorio). */
export interface EditAvailability {
  available: boolean;
  lab: boolean;
  routes: Array<{ use_case_id: string; route_id: string; model_id: string; status: string }>;
}

export interface Requester { tenantId: string; userId: string; role: string | null; requestId: string; labGrantId?: string | null }

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
export function designForPrompt(d: SiteDesign | null, convertedFromClassic = false): unknown {
  if (!d) return { template: 'clasica', note: 'La página no tiene secciones editables: solo se pueden cambiar datos (set_fact).' };
  return {
    ...(convertedFromClassic ? { note: 'La página usa hoy la plantilla clásica; estos bloques son su conversión con el mismo contenido. Si solo cambias datos usa set_fact y la página sigue igual; cualquier otra operación la publica en formato de secciones.' } : {}),
    theme: d.theme,
    images: d.images.map((i) => ({ slot: i.slot, alt: i.alt })),
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
      actorKind: 'tenant_user', origin: job.kind, brandVersion, jobId: job.job_id, pinnedRouteId: job.pinned[useCase] ?? null, labGrantId: job.lab_grant_id,
    };
  }

  async requestDesign(r: Requester, brief: unknown, idempotencyKey: string) {
    const text = typeof brief === 'string' ? brief.trim() : '';
    if (text.length > 1500) throw new AppError(400, 'validation_error', 'Cuéntanos tu idea en hasta 1500 caracteres.');
    const site = await this.deps.site.websiteRepo.websiteForTenant(r.tenantId);
    if (!site) throw new AppError(409, 'website_missing', 'Todavía no tienes página. Primero créala con los datos de tu negocio.');
    return this.deps.jobs.enqueue({
      tenantId: r.tenantId, kind: 'website.design', idempotencyKey, createdBy: r.userId, labGrantId: r.labGrantId ?? null,
      input: { brief: text || 'Una página clara y atractiva que invite a visitarnos.', actor_role: r.role },
      useCases: ['website.initial.design', 'website.image.generate'],
    });
  }

  /**
   * Con qué rutas se ejecutaría una edición ahora (sin crear el job ni gastar): grant del laboratorio si viene, si no
   * el rollout del entorno. Un grant inválido lanza 403 (nunca cae al rollout).
   */
  async editAvailability(r: Requester): Promise<EditAvailability> {
    const plan = await this.deps.jobs.plan({ tenantId: r.tenantId, createdBy: r.userId, labGrantId: r.labGrantId ?? null, useCases: [...EDIT_USE_CASES] });
    const ids = Object.values(plan.pinned);
    const rows = ids.length
      ? (await this.deps.pool.query<{ use_case_id: string; route_id: string; model_id: string; status: string }>(
        'SELECT use_case_id, route_id, model_id, status FROM ai_route_revision WHERE route_id = ANY($1::text[]) ORDER BY use_case_id', [ids])).rows
      : [];
    return { available: rows.length > 0, lab: !!plan.grant, routes: rows };
  }

  async requestEdit(r: Requester, instruction: unknown, idempotencyKey: string, opts: { conversationRequestId?: string } = {}) {
    const text = typeof instruction === 'string' ? instruction.trim() : '';
    if (!text || text.length > 1000) throw new AppError(400, 'validation_error', 'Escribe el cambio que quieres en hasta 1000 caracteres.');
    const site = await this.deps.site.websiteRepo.websiteForTenant(r.tenantId);
    if (!site || Number(site.published_version) === 0) throw new AppError(409, 'validation_error', 'Primero publica tu página; después puedes pedir cambios.');
    return this.deps.jobs.enqueue({
      tenantId: r.tenantId, kind: 'website.edit', idempotencyKey, createdBy: r.userId, labGrantId: r.labGrantId ?? null,
      input: { instruction: text, actor_role: r.role, ...(opts.conversationRequestId ? { conversation_request_id: opts.conversationRequestId } : {}) },
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
    const sentences = [summary, `Estilo ${MOOD_LABEL[design.theme.mood] ?? design.theme.mood} con ${design.blocks.length} secciones.`,
      ...(Object.keys(assets).length ? [`Usa ${Object.keys(assets).length === 1 ? '1 imagen' : `${Object.keys(assets).length} imágenes`} de tu biblioteca.`] : ['Sin imágenes por ahora (puedes subir fotos a tu biblioteca).'])];
    await jc.progress({ step: 'proposal' });
    const out = await prepareAiSiteChange(this.deps.site, { tenantId: job.tenant_id, actorId: job.created_by, actorRole: actor.role, requestId: `job:${job.job_id}` }, {
      type: AI_DESIGN_PROPOSAL_TYPE, after, summary, sentences,
      ai: { job_id: job.job_id, invocation_ids: invocationIds, brand_version: facts.version, route_ids: [res.route.route_id], routes: [routeUse('website.initial.design', res.route)] },
      conversationRequestId: linkedRequest(job),
    });
    return { proposal_id: out.proposal.proposal_id, proposal_status: out.proposal.status, images: Object.keys(assets).length, images_blocked: blocked, model: res.route.model_id, route_status: res.route.route_status, assignment: res.route.assignment, simulated: res.simulated };
  }

  // ------------------------------------------------------------------ imágenes de una edición

  /** Foto existente de la biblioteca del propio negocio (nunca de otro tenant ni archivada). */
  private async libraryAsset(tenantId: string, assetId: string): Promise<DesignImageAsset> {
    const row = await this.deps.media.get(tenantId, assetId);
    if (!row || row.status === 'archived') throw new AiJobError('image_not_in_library', false, 'La foto elegida no está disponible en tu biblioteca.');
    return assetOf(row);
  }

  /**
   * Imagen generada para un slot. Sin ruta, sin saldo o con error del proveedor el job falla con `image_<código>` y el
   * motivo queda en el progreso: no se sustituye por otra imagen ni por otro proveedor.
   */
  private async generatedAsset(jc: JobContext, need: ImageNeed, palette: string, brandVersion: number | null, used: AiRouteUse[], invocationIds: string[]): Promise<DesignImageAsset> {
    const { job } = jc;
    const img = await this.deps.dispatcher.invokeImage('website.image.generate', this.ctx(job, 'website.image.generate', `edit-img:${need.slot}`, brandVersion),
      { subject: need.image.subject, style: need.image.style, palette }, need.image.aspect);
    if (img.ok) {
      const row = await this.deps.media.store({
        tenantId: job.tenant_id, bytes: img.output.bytes, source: 'ai_generated', purpose: `website.${need.slot}`, alt: need.image.alt,
        license: `Ilustración generada por IA (${img.route.model_id}) para el negocio`, isIllustration: true,
        generatorModel: img.route.model_id, invocationId: img.invocationId, promptSummary: need.image.subject, createdBy: job.created_by, requestId: `job:${job.job_id}`,
      });
      invocationIds.push(img.invocationId);
      used.push(routeUse('website.image.generate', img.route));
      return assetOf(row);
    }
    if (img.code === 'in_progress' && img.invocationId) {
      const prev = await this.deps.pool.query<{ asset_id: string }>('SELECT asset_id FROM media_asset WHERE tenant_id = $1 AND invocation_id = $2', [job.tenant_id, img.invocationId]);
      const row = prev.rows[0] ? await this.deps.media.get(job.tenant_id, prev.rows[0].asset_id) : null;
      if (row) return assetOf(row);
    }
    await jc.progress({ step: 'image_failed', image_error: img.code, image_reason: img.reason.slice(0, 240), image_model: img.route?.model_id ?? null });
    throw new AiJobError(`image_${img.code}`, img.retryable, img.reason);
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
    // Página clásica: el modelo ve sus bloques equivalentes (mismo contenido); solo se convierte si el parche lo necesita.
    const conv = current.design ? null : designFromClassic(current);
    const allowance = { confirmedPriceStrings: await this.deps.brand.allowedPriceStrings(job.tenant_id), ownerTexts: conv?.ownerTexts };
    const library = (await this.deps.media.list(job.tenant_id, { limit: 40 }))
      .filter((a) => a.status !== 'archived').slice(0, 20)
      .map((a) => ({ asset_id: a.asset_id, alt: a.alt_text, source: a.source }));
    const res = await this.deps.dispatcher.invokeStructured<EditOutput>(useCase, this.ctx(job, useCase, 'patch', brandVersion), {
      current_design: designForPrompt(current.design?.design ?? conv?.stored?.design ?? null, !current.design),
      page_facts: { name: current.name, line: current.line, about: current.about, address: current.address, hours: current.hours, email: current.email },
      library,
      instruction,
    }, { domainCheck: (out) => (out.operations.length ? applyEdit(current, out.operations, allowance).errors : []) });
    if (!res.ok) throw failure(res);
    if (!res.output.operations.length) {
      return { status: 'needs_clarification', scope, semantic_source: semantic, question: res.output.needs_clarification ?? '¿Puedes describir el cambio con más detalle?', model: res.route.model_id, route_status: res.route.route_status, assignment: res.route.assignment };
    }
    const applied = applyEdit(current, res.output.operations, allowance);
    if (applied.errors.length) throw new AiJobError('invalid_output', false, applied.errors.join('; ').slice(0, 300));

    const used: AiRouteUse[] = [routeUse(useCase, res.route)];
    const invocationIds = [...(cls.ok ? [cls.invocationId] : []), res.invocationId];
    const design = applied.data.design;
    if (applied.images.length && design) {
      const palette = Object.values(design.design.theme.palette).slice(0, 3).join(', ');
      for (const need of applied.images) {
        await jc.progress({ step: `image:${need.slot}`, source: need.image.source });
        design.assets[need.slot] = need.image.source === 'library'
          ? await this.libraryAsset(job.tenant_id, need.image.asset_id)
          : await this.generatedAsset(jc, need, palette, brandVersion, used, invocationIds);
      }
    }

    await jc.progress({ step: 'proposal' });
    const out = await prepareAiSiteChange(this.deps.site, { tenantId: job.tenant_id, actorId: job.created_by, actorRole: (job.input['actor_role'] as string | null) ?? null, requestId: `job:${job.job_id}` }, {
      type: AI_EDIT_PROPOSAL_TYPE, after: applied.data, summary: res.output.summary, sentences: [res.output.summary, ...applied.sentences],
      ai: { job_id: job.job_id, invocation_ids: invocationIds, brand_version: brandVersion, route_ids: used.map((u) => u.route_id), routes: used },
      conversationRequestId: linkedRequest(job),
    });
    return {
      status: 'proposed', scope, semantic_source: semantic, use_case: useCase, model: res.route.model_id, route_status: res.route.route_status, assignment: res.route.assignment,
      proposal_id: out.proposal.proposal_id, proposal_status: out.proposal.status, operations: res.output.operations.length, images: applied.images.length, converted: applied.converted,
    };
  }
}

/** Solicitud de la conversación que originó el job (si vino del chat). */
function linkedRequest(job: JobContext['job']): string | undefined {
  const id = job.input['conversation_request_id'];
  return typeof id === 'string' && id ? id : undefined;
}

function routeUse(useCaseId: string, route: { route_id: string; model_id: string; assignment: string; route_status: string }): AiRouteUse {
  return { use_case_id: useCaseId, route_id: route.route_id, model_id: route.model_id, assignment: route.assignment, status: route.route_status };
}
