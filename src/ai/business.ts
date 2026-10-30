/**
 * Capacidades del negocio sobre el AI Core (FR-0015, FR-0017): composición social, asistente con
 * estado real, campañas propuestas sin gasto, resumen/insights y calendario editorial.
 *
 * Reglas comunes:
 * - Solo hechos confirmados de la marca (recuperación mínima por caso de uso).
 * - Ninguna salida publica nada: la composición crea BORRADORES que siguen la aprobación social;
 *   una campaña aprobada es un plan, nunca gasto (spend_authorized = false por constraint).
 * - Las herramientas del asistente leen SOLO el negocio de la sesión y respetan el permiso de lectura.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import type { BrandService, FactKey, Promotion } from '../brand/service.ts';
import type { MediaService } from '../media/service.ts';
import type { SocialService, SocialPostRow } from '../social/service.ts';
import type { AiDispatcher, InvokeContext, ToolDef } from './dispatcher.ts';
import { AiJobError, type AiJobs, type JobContext } from './jobs.ts';
import {
  composeViolations, INSIGHTS_MIN_ACTIVE_DAYS, untracedNumbers,
  type AssistantOutput, type CampaignOutput, type ComposeOutput, type EditorialOutput, type InsightsOutput,
} from './contracts.ts';

export interface BizActor { tenantId: string; userId: string; role: string | null; requestId: string; permissions: readonly string[] }

export const SOCIAL_FACT_KEYS: readonly FactKey[] = ['name', 'category', 'description', 'value_proposition', 'voice', 'audience', 'avoid_tones', 'services', 'address', 'hours', 'cta', 'prices', 'restrictions'];
const DUPLICATE_SIMILARITY = 0.7;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9ñ]+/u).filter((w) => w.length > 3));
}

/** Similitud de Jaccard sobre palabras con contenido (detecta casi-duplicados de publicaciones). */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

function ctxFor(a: BizActor, useCase: string, idempotencyKey: string, origin: string, extra: Partial<InvokeContext> = {}): InvokeContext {
  return { requestId: a.requestId, idempotencyKey: `${useCase}:${idempotencyKey}`, tenantId: a.tenantId, actorId: a.userId, actorKind: 'tenant_user', origin, ...extra };
}

function fail(res: { code: string; reason: string }): AppError {
  const status = res.code === 'budget_exhausted' ? 429 : res.code === 'blocked_external' || res.code === 'no_active_route' || res.code === 'disabled' ? 503 : res.code === 'in_progress' ? 409 : 502;
  const message = res.code === 'budget_exhausted' ? 'Se alcanzó el presupuesto de IA de hoy. Inténtalo mañana o pide a soporte que lo revise.'
    : res.code === 'no_active_route' || res.code === 'disabled' ? 'Esta función de IA todavía no está activa en tu cuenta.'
      : res.code === 'blocked_external' ? 'Esta función de IA está pausada por una autorización externa pendiente.'
        : res.code === 'in_progress' ? 'Tu solicitud anterior sigue en proceso.'
          : 'No pudimos completar la solicitud con la IA. Inténtalo de nuevo en unos minutos.';
  return new AppError(status, status === 429 ? DENY_CODES.LIMIT_EXCEEDED : 'validation_error', message);
}

export interface AiBusinessDeps {
  pool: Pool;
  sink: AuditSink;
  dispatcher: AiDispatcher;
  jobs: AiJobs;
  brand: BrandService;
  media: MediaService;
  social: SocialService;
}

export class AiBusinessService {
  private readonly deps: AiBusinessDeps;

  constructor(deps: AiBusinessDeps) {
    this.deps = deps;
    deps.jobs.register('social.compose', (ctx) => this.runCompose(ctx));
  }

  // ------------------------------------------------------------------ social (FR-0015)

  async requestCompose(a: BizActor, input: { request?: unknown; with_image?: unknown; editorial_id?: unknown }, idempotencyKey: string) {
    const request = typeof input.request === 'string' ? input.request.trim() : '';
    if (!request || request.length > 1000) throw new AppError(400, 'validation_error', 'Cuéntanos qué quieres publicar (hasta 1000 caracteres).');
    return this.deps.jobs.enqueue({
      tenantId: a.tenantId, kind: 'social.compose', idempotencyKey, createdBy: a.userId,
      input: { request, with_image: input.with_image === true, editorial_id: typeof input.editorial_id === 'string' ? input.editorial_id : null, actor_role: a.role },
      useCases: ['social.facebook.post.compose', 'social.facebook.image.generate'],
    });
  }

  private async recentPosts(tenantId: string): Promise<Array<{ post_id: string; text: string; status: string }>> {
    const r = await this.deps.pool.query<{ post_id: string; text: string; status: string }>(
      `SELECT post_id, text, status FROM social_post WHERE tenant_id = $1 AND status <> 'rejected' AND created_at > now() - interval '45 days' ORDER BY created_at DESC LIMIT 20`, [tenantId]);
    return r.rows;
  }

  private async runCompose(jc: JobContext): Promise<Record<string, unknown>> {
    const { job } = jc;
    const facts = await this.deps.brand.confirmed(job.tenant_id, [...SOCIAL_FACT_KEYS, 'promotions']);
    const promotions = (facts.facts.promotions as Promotion[] | undefined) ?? [];
    const recent = await this.recentPosts(job.tenant_id);
    const base: InvokeContext = { requestId: `job:${job.job_id}`, idempotencyKey: `job:${job.job_id}:compose:a${job.attempts}`, tenantId: job.tenant_id, actorId: job.created_by, actorKind: 'tenant_user', origin: 'social.compose', brandVersion: facts.version, jobId: job.job_id, pinnedRouteId: job.pinned['social.facebook.post.compose'] ?? null };
    const allowance = { confirmedPriceStrings: await this.deps.brand.allowedPriceStrings(job.tenant_id) };
    const { promotions: _p, ...brandFacts } = facts.facts;
    await jc.progress({ step: 'compose' });
    const res = await this.deps.dispatcher.invokeStructured<ComposeOutput>('social.facebook.post.compose', base,
      { brand_facts: brandFacts, promotions: promotions.map((p) => ({ text: p.text, valid_until: p.valid_until })), recent_posts: recent.slice(0, 10).map((p) => p.text.slice(0, 280)), request: String(job.input['request'] ?? '') },
      { domainCheck: (out) => composeViolations(out, allowance) });
    if (!res.ok) throw new AiJobError(res.code, res.retryable, res.reason);
    const variants = res.output.variants.map((v) => {
      const dup = recent.find((p) => similarity(p.text, v.text) >= DUPLICATE_SIMILARITY);
      return { ...v, duplicate_of: dup?.post_id ?? null };
    });
    let image: Record<string, unknown> | null = null;
    if (job.input['with_image'] === true && res.output.image) {
      await jc.progress({ step: 'image' });
      const img = await this.deps.dispatcher.invokeImage('social.facebook.image.generate', { ...base, idempotencyKey: `job:${job.job_id}:image:a${job.attempts}`, pinnedRouteId: job.pinned['social.facebook.image.generate'] ?? null },
        { subject: res.output.image.subject, style: res.output.image.style, palette: String((facts.facts.palette as string[] | undefined)?.slice(0, 3).join(', ') ?? 'cálidos') }, '1:1');
      if (img.ok) {
        const row = await this.deps.media.store({
          tenantId: job.tenant_id, bytes: img.output.bytes, source: 'ai_generated', purpose: 'social.post', alt: res.output.image.alt,
          license: `Ilustración generada por IA (${img.route.model_id}) para el negocio`, isIllustration: true, generatorModel: img.route.model_id,
          invocationId: img.invocationId, promptSummary: res.output.image.subject, createdBy: job.created_by, requestId: `job:${job.job_id}`,
        });
        image = { asset_id: row.asset_id, alt: row.alt_text, status: 'generated' };
      } else {
        image = { status: img.code, alt: res.output.image.alt };
      }
    }
    return {
      status: 'ready', variants, image, suggested_slot: res.output.suggested_slot, warnings: res.output.warnings,
      invocation_id: res.invocationId, model: res.route.model_id, brand_version: facts.version, simulated: res.simulated,
      editorial_id: job.input['editorial_id'] ?? null,
    };
  }

  /** El dueño elige una variante: se crea un BORRADOR normal (cuota + aprobación social existentes). */
  async draftFromCompose(a: BizActor, jobId: string, variantIndex: unknown, editedText: unknown, useImage: unknown): Promise<{ post: SocialPostRow; replayed: boolean }> {
    const job = await this.deps.jobs.get(a.tenantId, jobId);
    if (!job || job.kind !== 'social.compose') throw new AppError(404, DENY_CODES.NOT_FOUND, 'No encontramos esa propuesta de publicación.');
    if (job.status !== 'succeeded' || !job.result) throw new AppError(409, 'validation_error', 'La propuesta todavía no está lista.');
    const variants = (job.result['variants'] as ComposeOutput['variants'] | undefined) ?? [];
    const i = Number(variantIndex);
    const v = Number.isInteger(i) ? variants[i] : undefined;
    if (!v) throw new AppError(400, 'validation_error', 'Elige una de las variantes.');
    const text = typeof editedText === 'string' && editedText.trim() ? editedText.trim() : `${v.text}${v.hashtags.length ? `\n\n${v.hashtags.map((h) => `#${h.replace(/^#/, '')}`).join(' ')}` : ''}`;
    if (text.length > 2000) throw new AppError(400, 'validation_error', 'La publicación admite hasta 2000 caracteres.');
    // Una edición del dueño pasa las mismas reglas de hechos (precios/promos no confirmados, enlaces, marcado).
    const allowance = { confirmedPriceStrings: await this.deps.brand.allowedPriceStrings(a.tenantId) };
    const violations = composeViolations({ variants: [{ angle: v.angle, text: text.replace(/(^|\s)#\S+/gu, ' '), cta: v.cta, hashtags: [] }], image: null, suggested_slot: null, warnings: [] }, allowance);
    if (violations.length) throw new AppError(400, 'validation_error', `Revisa el texto: ${violations.join('; ')}.`);
    const image = job.result['image'] as { asset_id?: string } | null;
    const assetId = useImage === true && image?.asset_id ? image.asset_id : null;
    const out = await this.deps.social.createDraft(a.tenantId, a.userId, a.requestId, { text, idempotencyKey: `compose:${jobId}:${i}`, actorRole: a.role });
    if (!out.replayed) {
      await this.deps.pool.query(
        'UPDATE social_post SET media_asset_id = $3, generation = $4, brand_version = $5, updated_at = now() WHERE post_id = $1 AND tenant_id = $2',
        [out.post.post_id, a.tenantId, assetId, JSON.stringify({ job_id: jobId, variant: i, invocation_id: job.result['invocation_id'], model: job.result['model'], edited: typeof editedText === 'string' && editedText.trim() !== '' }), job.result['brand_version'] ?? null]);
      const editorial = job.result['editorial_id'];
      if (typeof editorial === 'string') {
        await this.deps.pool.query(`UPDATE editorial_suggestion SET status = 'used', post_id = $3 WHERE suggestion_id = $1 AND tenant_id = $2 AND status IN ('suggested','accepted')`, [editorial, a.tenantId, out.post.post_id]);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ asistente (FR-0017)

  private tools(a: BizActor): ToolDef[] {
    const can = (p: string) => a.permissions.includes(p);
    const pool = this.deps.pool;
    const t = a.tenantId;
    const days = (args: Record<string, unknown>) => Math.min(90, Math.max(1, Number.isInteger(args['period_days']) ? Number(args['period_days']) : 7));
    const spec = (name: string, description: string, withPeriod = false) => ({
      name, description, parameters: withPeriod
        ? { type: 'object', properties: { period_days: { type: 'integer', minimum: 1, maximum: 90 } }, required: [], additionalProperties: false }
        : { type: 'object', properties: {}, required: [], additionalProperties: false },
    });
    const tools: ToolDef[] = [
      {
        spec: spec('account_status', 'Negocio, plan y estado de la suscripción.'),
        run: async () => {
          const r = await pool.query(`SELECT c.business_name, c.status, p.name AS plan, s.status AS subscription_status FROM client c
             LEFT JOIN subscription s ON s.tenant_id = c.client_id LEFT JOIN plan p ON p.plan_id = s.plan_id WHERE c.client_id = $1 LIMIT 1`, [t]);
          return { tool: 'account_status', ...(r.rows[0] ?? {}) };
        },
      },
      {
        spec: spec('website_status', 'Estado de la página: versión publicada, fecha y cambios pendientes de aprobar.'),
        run: async () => {
          const r = await pool.query(`SELECT status, published_version, published_at FROM client_website WHERE tenant_id = $1`, [t]);
          const pend = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM action_proposal WHERE tenant_id = $1 AND capability_target = 'website' AND status IN ('preview_ready','awaiting_confirmation','confirmed')`, [t]);
          return { tool: 'website_status', page: r.rows[0] ?? null, pending_changes: Number(pend.rows[0]?.n ?? 0) };
        },
      },
    ];
    if (can('social.read')) {
      tools.push({
        spec: spec('social_posts', 'Publicaciones de Facebook del periodo por estado y las más recientes.', true),
        run: async (args) => {
          const d = days(args);
          const by = await pool.query<{ status: string; n: string }>(`SELECT status, count(*) AS n FROM social_post WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2) GROUP BY status`, [t, d]);
          const last = await pool.query<{ status: string; text: string; published_at: string | null; scheduled_at: string | null }>(
            `SELECT status, left(text, 80) AS text, published_at, scheduled_at FROM social_post WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2) ORDER BY created_at DESC LIMIT 5`, [t, d]);
          return { tool: 'social_posts', label: `Publicaciones de los últimos ${d} días`, period_days: d, by_status: Object.fromEntries(by.rows.map((x) => [x.status, Number(x.n)])), latest: last.rows };
        },
      });
    }
    if (can('engagement.read')) {
      tools.push({
        spec: spec('attention_cases', 'Comentarios y reseñas que esperan decisión, con resumen.'),
        run: async () => {
          const r = await pool.query<{ origin: string; category: string | null; rating: number | null; sentiment: string | null; body: string }>(
            `SELECT origin, category, rating, sentiment, left(body, 120) AS body FROM engagement_case WHERE tenant_id = $1 AND state IN ('needs_human','failed') ORDER BY created_at DESC LIMIT 5`, [t]);
          const n = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM engagement_case WHERE tenant_id = $1 AND state IN ('needs_human','failed')`, [t]);
          // El texto del cliente es contenido NO confiable: se entrega marcado, nunca como instrucción.
          return { tool: 'attention_cases', label: 'Casos que esperan tu decisión', count: Number(n.rows[0]?.n ?? 0), items: r.rows.map((x) => ({ origin: x.origin, category: x.category, rating: x.rating, sentiment: x.sentiment, customer_text_untrusted: x.body })) };
        },
      });
    }
    tools.push({
      spec: spec('activity_metrics', 'Métricas de actividad del periodo (publicaciones, casos, respuestas automáticas, calificación).', true),
      run: async (args) => ({ tool: 'activity_metrics', ...(await this.metrics(t, days(args))) }),
    });
    tools.push({
      spec: spec('connections_status', 'Estado de las conexiones con Google y Facebook (sin datos secretos).'),
      run: async () => {
        const r = await pool.query<{ provider: string; status: string; external_resource_name: string | null }>(`SELECT provider, status, external_resource_name FROM provider_connection WHERE tenant_id = $1`, [t]);
        return { tool: 'connections_status', connections: r.rows };
      },
    });
    if (can('brand.read')) {
      tools.push({
        spec: spec('brand_facts', 'Hechos confirmados de la marca (nombre, giro, horario, servicios, promociones vigentes).'),
        run: async () => ({ tool: 'brand_facts', ...(await this.deps.brand.confirmed(t, ['name', 'category', 'hours', 'address', 'services', 'promotions', 'prices'])) }),
      });
    }
    return tools;
  }

  async ask(a: BizActor, question: unknown, idempotencyKey: string): Promise<{ answer: string; evidence: AssistantOutput['evidence']; suggested_action: string; tools_used: string[]; model: string; simulated: boolean }> {
    const q = typeof question === 'string' ? question.trim() : '';
    if (!q || q.length > 1500) throw new AppError(400, 'validation_error', 'Escribe tu pregunta (hasta 1500 caracteres).');
    const business = (await this.deps.pool.query<{ business_name: string }>('SELECT business_name FROM client WHERE client_id = $1', [a.tenantId])).rows[0]?.business_name ?? 'tu negocio';
    const res = await this.deps.dispatcher.invokeWithTools<AssistantOutput>('conversation.owner.assistant', ctxFor(a, 'assistant', idempotencyKey, 'owner.assistant'),
      { today: new Date().toISOString().slice(0, 10), business, question: q }, this.tools(a),
      { domainCheck: (out, outs) => untracedNumbers(out.answer, outs).map((n) => `cifra sin fuente: ${n}`) });
    if (!res.ok) throw fail(res);
    await this.deps.sink.write({ tenant_id: a.tenantId, actor_id: a.userId, actor_role: a.role, action: 'ai.assistant.answered', resource: `ai_invocation/${res.invocationId}`, request_id: a.requestId, decision: 'allow', result: `tools:${res.output.evidence.map((e) => e.tool).join(',')}`.slice(0, 200) });
    return { answer: res.output.answer, evidence: res.output.evidence, suggested_action: res.output.suggested_action, tools_used: (res.toolOutputs ?? []).map((o) => String((o as { tool?: unknown }).tool ?? '')), model: res.route.model_id, simulated: res.simulated };
  }

  // ------------------------------------------------------------------ métricas e insights

  async metrics(tenantId: string, periodDays: number): Promise<Record<string, number | null>> {
    const p = this.deps.pool;
    const one = async (sql: string): Promise<number | null> => {
      const r = await p.query<{ v: string | null }>(sql, [tenantId, periodDays]);
      const v = r.rows[0]?.v;
      return v === null || v === undefined ? null : Number(v);
    };
    return {
      period_days: periodDays,
      days_with_activity: await one(`SELECT count(DISTINCT (ts AT TIME ZONE 'UTC')::date) AS v FROM audit_event WHERE tenant_id = $1 AND ts > now() - make_interval(days => $2) AND actor_id NOT LIKE 'system:%'`),
      posts_published: await one(`SELECT count(*) AS v FROM social_post WHERE tenant_id = $1 AND status = 'published' AND published_at > now() - make_interval(days => $2)`),
      posts_scheduled: await one(`SELECT count(*) AS v FROM social_post WHERE tenant_id = $1 AND status IN ('scheduled','awaiting_approval') AND created_at > now() - make_interval(days => $2)`),
      cases_total: await one(`SELECT count(*) AS v FROM engagement_case WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2)`),
      cases_pending: await one(`SELECT count(*) AS v FROM engagement_case WHERE tenant_id = $1 AND state IN ('needs_human','failed')`),
      auto_replies: await one(`SELECT count(*) AS v FROM engagement_case WHERE tenant_id = $1 AND decision = 'auto_reply' AND created_at > now() - make_interval(days => $2)`),
      negative_cases: await one(`SELECT count(*) AS v FROM engagement_case WHERE tenant_id = $1 AND sentiment IN ('negative','mixed') AND created_at > now() - make_interval(days => $2)`),
      avg_rating: await one(`SELECT round(avg(star_rating)::numeric, 1) AS v FROM review WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2)`),
      website_versions: await one(`SELECT count(*) AS v FROM website_content WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2)`),
    };
  }

  async insights(a: BizActor, periodDays: unknown, idempotencyKey: string): Promise<Record<string, unknown>> {
    const d = Number(periodDays);
    if (![7, 30].includes(d)) throw new AppError(400, 'validation_error', 'Elige 7 o 30 días.');
    const metrics = await this.metrics(a.tenantId, d);
    const end = new Date();
    const start = new Date(end.getTime() - d * 86_400_000);
    const period = `${start.toISOString().slice(0, 10)} a ${end.toISOString().slice(0, 10)}`;
    let out: InsightsOutput;
    let invocationId: string | null = null;
    let model: string | null = null;
    if ((metrics['days_with_activity'] ?? 0) < INSIGHTS_MIN_ACTIVE_DAYS) {
      // Sin datos suficientes no se gasta IA: la abstención es una regla de datos, no una lectura semántica.
      out = { status: 'abstained', summary: 'Todavía no hay suficiente actividad para sacar conclusiones confiables.', highlights: [], recommendations: [], abstain_reason: `Se necesitan al menos ${INSIGHTS_MIN_ACTIVE_DAYS} días con actividad; este periodo tiene ${metrics['days_with_activity'] ?? 0}.` };
    } else {
      const res = await this.deps.dispatcher.invokeStructured<InsightsOutput>('business.insights.generate', ctxFor(a, 'business.insights.generate', idempotencyKey, 'insights'),
        { period, metrics }, { domainCheck: (o) => untracedNumbers(`${o.summary} ${o.highlights.map((h) => h.value).join(' ')}`, [metrics, period, { min_days_with_activity: INSIGHTS_MIN_ACTIVE_DAYS }]).map((n) => `cifra sin fuente: ${n}`) });
      if (!res.ok) throw fail(res);
      out = res.output;
      invocationId = res.invocationId;
      model = res.route.model_id;
    }
    const id = `ins_${randomUUID()}`;
    await this.deps.pool.query(
      `INSERT INTO ai_insight (insight_id, tenant_id, period_start, period_end, status, summary, recommendations, evidence, invocation_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, a.tenantId, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), out.status, out.summary, JSON.stringify(out.recommendations), JSON.stringify({ metrics, highlights: out.highlights, abstain_reason: out.abstain_reason }), invocationId, a.userId]);
    return { insight_id: id, period, metrics, ...out, model };
  }

  // ------------------------------------------------------------------ campañas (sin gasto)

  async proposeCampaign(a: BizActor, input: { objective?: unknown; budget_hint_mxn?: unknown }, idempotencyKey: string): Promise<Record<string, unknown>> {
    const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
    if (!objective || objective.length > 1000) throw new AppError(400, 'validation_error', 'Describe qué quieres lograr (hasta 1000 caracteres).');
    const hint = input.budget_hint_mxn === null || input.budget_hint_mxn === undefined || input.budget_hint_mxn === '' ? null : Number(input.budget_hint_mxn);
    if (hint !== null && (!Number.isFinite(hint) || hint < 0 || hint > 1_000_000)) throw new AppError(400, 'validation_error', 'El monto debe ser un número en pesos.');
    const facts = await this.deps.brand.confirmed(a.tenantId, [...SOCIAL_FACT_KEYS, 'promotions']);
    const { promotions, ...brandFacts } = facts.facts;
    const plan = await this.deps.dispatcher.invokeStructured<CampaignOutput>('marketing.campaign.plan', ctxFor(a, 'marketing.campaign.plan', idempotencyKey, 'campaign', { brandVersion: facts.version }),
      { brand_facts: brandFacts, budget_hint_mxn: hint, request: objective },
      { domainCheck: (o) => (hint === null && o.budget.proposed_total_mxn !== null ? ['budget.proposed_total_mxn: no inventes un monto que el dueño no dio'] : []) });
    if (!plan.ok) throw fail(plan);
    const allowance = { confirmedPriceStrings: await this.deps.brand.allowedPriceStrings(a.tenantId) };
    const creatives = await this.deps.dispatcher.invokeStructured<ComposeOutput>('marketing.campaign.creatives', ctxFor(a, 'marketing.campaign.creatives', idempotencyKey, 'campaign', { brandVersion: facts.version }),
      { brand_facts: brandFacts, promotions: ((promotions as Promotion[] | undefined) ?? []).map((p) => ({ text: p.text, valid_until: p.valid_until })), recent_posts: [], request: `${plan.output.objective}. Público: ${plan.output.audience.description}` },
      { domainCheck: (o) => composeViolations(o, allowance) });
    const id = `cmp_${randomUUID()}`;
    await this.deps.pool.query(
      `INSERT INTO marketing_campaign (campaign_id, tenant_id, objective, brief, plan, budget_proposed_usd, invocation_id, brand_version, created_by)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8)`,
      [id, a.tenantId, objective.slice(0, 1000), JSON.stringify({ budget_hint_mxn: hint }),
        JSON.stringify({ ...plan.output, creatives: creatives.ok ? creatives.output.variants : [], creatives_status: creatives.ok ? 'ready' : creatives.code }), plan.invocationId, facts.version, a.userId]);
    await this.deps.sink.write({ tenant_id: a.tenantId, actor_id: a.userId, actor_role: a.role, action: 'campaign.proposed', resource: `marketing_campaign/${id}`, request_id: a.requestId, decision: 'allow', result: 'proposed_no_spend' });
    return this.campaign(a.tenantId, id) as Promise<Record<string, unknown>>;
  }

  async campaign(tenantId: string, id: string): Promise<Record<string, unknown> | null> {
    const r = await this.deps.pool.query('SELECT campaign_id, status, objective, plan, spend_authorized, created_at, decided_at FROM marketing_campaign WHERE campaign_id = $1 AND tenant_id = $2', [id, tenantId]);
    return r.rows[0] ?? null;
  }

  async campaigns(tenantId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.deps.pool.query('SELECT campaign_id, status, objective, plan, spend_authorized, created_at, decided_at FROM marketing_campaign WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20', [tenantId])).rows;
  }

  /** Aprobar el PLAN no autoriza gasto: sin cuenta publicitaria autorizada el gasto queda bloqueado. */
  async decideCampaign(a: BizActor, id: string, decision: unknown): Promise<Record<string, unknown>> {
    if (decision !== 'approve' && decision !== 'reject') throw new AppError(400, 'validation_error', 'Decide aprobar o descartar.');
    const status = decision === 'approve' ? 'plan_approved' : 'rejected';
    const r = await this.deps.pool.query(`UPDATE marketing_campaign SET status = $3, decided_by = $4, decided_at = now(), updated_at = now() WHERE campaign_id = $1 AND tenant_id = $2 AND status = 'proposed' RETURNING campaign_id`, [id, a.tenantId, status, a.userId]);
    if (!r.rowCount) {
      if (!(await this.campaign(a.tenantId, id))) throw new AppError(404, DENY_CODES.NOT_FOUND, 'No encontramos esa campaña.');
      throw new AppError(409, 'validation_error', 'Esa campaña ya tiene una decisión.');
    }
    await this.deps.sink.write({ tenant_id: a.tenantId, actor_id: a.userId, actor_role: a.role, action: `campaign.${status}`, resource: `marketing_campaign/${id}`, request_id: a.requestId, decision: 'allow', result: `${status}:spend_blocked_external` });
    return { ...(await this.campaign(a.tenantId, id)), spend: 'BLOCKED_EXTERNAL', spend_reason: 'No hay cuenta publicitaria autorizada ni autorización de gasto del titular; MainSpot no activa anuncios.' };
  }

  // ------------------------------------------------------------------ calendario editorial

  async suggestCalendar(a: BizActor, input: { start_date?: unknown; frequency?: unknown }, idempotencyKey: string): Promise<Array<Record<string, unknown>>> {
    const start = typeof input.start_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.start_date) ? input.start_date : new Date().toISOString().slice(0, 10);
    const frequency = ['2 por semana', '3 por semana', '5 por semana'].includes(String(input.frequency)) ? String(input.frequency) : '3 por semana';
    const facts = await this.deps.brand.confirmed(a.tenantId, [...SOCIAL_FACT_KEYS, 'promotions']);
    const recent = await this.recentPosts(a.tenantId);
    const res = await this.deps.dispatcher.invokeStructured<EditorialOutput>('editorial.calendar.suggest', ctxFor(a, 'editorial.calendar.suggest', idempotencyKey, 'editorial', { brandVersion: facts.version }),
      { brand_facts: facts.facts, start_date: start, frequency, recent_posts: recent.slice(0, 10).map((p) => p.text.slice(0, 160)) },
      { domainCheck: (o) => o.ideas.filter((i) => i.date < start).map((i) => `idea con fecha ${i.date} anterior al inicio`) });
    if (!res.ok) throw fail(res);
    const out: Array<Record<string, unknown>> = [];
    for (const idea of res.output.ideas.slice(0, 12)) {
      const id = `eds_${randomUUID()}`;
      await this.deps.pool.query(
        `INSERT INTO editorial_suggestion (suggestion_id, tenant_id, suggested_for, idea, rationale, brand_version, invocation_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, a.tenantId, idea.date, idea.idea.slice(0, 300), idea.rationale.slice(0, 300), facts.version, res.invocationId]);
      out.push({ suggestion_id: id, suggested_for: idea.date, idea: idea.idea, rationale: idea.rationale, status: 'suggested' });
    }
    return out;
  }

  async calendar(tenantId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.deps.pool.query(
      `SELECT suggestion_id, suggested_for, idea, rationale, status, post_id FROM editorial_suggestion WHERE tenant_id = $1 AND suggested_for >= (now() - interval '7 days')::date ORDER BY suggested_for, created_at LIMIT 60`, [tenantId])).rows;
  }

  async decideSuggestion(a: BizActor, id: string, decision: unknown, feedback: unknown): Promise<void> {
    if (decision !== 'accept' && decision !== 'reject') throw new AppError(400, 'validation_error', 'Decide aceptar o descartar.');
    const fb = typeof feedback === 'string' ? feedback.trim().slice(0, 300) : null;
    const r = await this.deps.pool.query(`UPDATE editorial_suggestion SET status = $3, feedback = $4, decided_by = $5, decided_at = now() WHERE suggestion_id = $1 AND tenant_id = $2 AND status = 'suggested'`,
      [id, a.tenantId, decision === 'accept' ? 'accepted' : 'rejected', fb, a.userId]);
    if (!r.rowCount) throw new AppError(404, DENY_CODES.NOT_FOUND, 'No encontramos esa idea pendiente.');
  }
}
