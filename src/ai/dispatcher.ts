/**
 * AiDispatcher (ARC-0001 §2): una única puerta para toda invocación de IA.
 *
 * Orden: grant de laboratorio (si lo hay, se revalida SIEMPRE antes de replay o gasto) → idempotencia →
 * resolución de ruta (grant `manual_lab`, fijada, eval o rollout activo/canary) → política de datos →
 * reserva de presupuesto (misma transacción que la fila `running`) → render estricto → proveedor con
 * deadline → validación (≤ 1 reparación) → registro de uso/costo → resultado.
 * Una ruta en borrador (DRAFT/TESTED) nunca se ejecuta por simple pin: solo bajo una evaluación real
 * existente (`evalRunId`) o un grant válido del laboratorio (DEC-0074). Sin grant válido no hay
 * fallback al rollout. Nunca lanza por fallos del proveedor: devuelve un resultado tipado con código seguro.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AppConfig } from '../shared/config.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import { log } from '../shared/logger.ts';
import { JevClient, JevHttpError, type SystemOneResult } from '../jev/client.ts';
import { validateRequest, type Questions, type Answer } from '../jev/types.ts';
import { measuredCost, TypeSafeLedger, typesafeDailyLimitUsd, type TypeSafeBudget, type TypeSafeHold } from './typesafe-ledger.ts';
import { OUTPUT_SCHEMAS } from './contracts.ts';
import { budgetPurpose, checkDataPolicy, DATA_POLICY_VERSION, estimateCost, PAID_PROVIDER_KINDS, reserveBudget } from './governance.ts';
import { PromptRenderError, renderPrompt } from './prompt.ts';
import { AiLab, type LabGrantRoute } from './lab.ts';
import { AiRegistry, type RouteBundle } from './registry.ts';
import { parseJsonOutput, toModelSchema, validate } from './schema.ts';
import { AnthropicAdapter } from './providers/anthropic.ts';
import { OpenAIAdapter } from './providers/openai.ts';
import { SimulatedAdapter } from './providers/simulated.ts';
import { ProviderError, type ChatMessage, type ProviderAdapter, type ToolSpec, type Usage } from './providers/types.ts';

export interface InvokeContext {
  requestId: string;
  idempotencyKey: string;
  tenantId: string | null;
  actorId: string;
  actorKind: 'tenant_user' | 'platform_user' | 'system';
  origin: string;
  consentRef?: string | null;
  brandVersion?: number | null;
  jobId?: string | null;
  /** Ruta fijada (job multi-paso o evaluación): ignora el rollout vigente. Sin grant/eval solo rutas aprobadas. */
  pinnedRouteId?: string | null;
  evalRunId?: string | null;
  /** Grant del laboratorio (DEC-0074): revalidado en cada invocación; una capacidad generativa fuera de él se bloquea. */
  labGrantId?: string | null;
  deadlineMs?: number;
}

export type FailureCode =
  | 'no_active_route' | 'blocked_external' | 'budget_exhausted' | 'provider_unavailable' | 'provider_auth'
  | 'invalid_output' | 'timeout' | 'render_error' | 'in_progress' | 'disabled' | 'circuit_open' | 'lab_grant_invalid';

export interface RouteRef {
  route_id: string; route_version: number; prompt_revision_id: string; prompt_version: number; prompt_sha256: string;
  model_id: string; provider_id: string; provider_kind: string; provider_model: string; assignment: string;
  /** Estado de la ruta al invocarla (DRAFT/TESTED solo llegan por grant del laboratorio o evaluación). */
  route_status: string;
}

export type InvokeResult<T> =
  | { ok: true; output: T; invocationId: string; route: RouteRef; usage: Usage; costUsd: number | null; costSource: string; latencyMs: number; replayed: boolean; simulated: boolean }
  | { ok: false; code: FailureCode; reason: string; invocationId: string | null; route: RouteRef | null; retryable: boolean };

export interface ImageOutput { bytes: Buffer; mediaType: string }
export interface ToolDef { spec: ToolSpec; run: (args: Record<string, unknown>) => Promise<unknown> }

interface Started { invocationId: string; bundle: RouteBundle; ref: RouteRef; started: number; adapter: ProviderAdapter | null }
interface PriorInvocation { invocation_id: string; status: string; output: unknown; route_id: string | null; error_code: string | null; actor_id: string; lab_grant_id: string | null }

/** Estados con los que una ruta fijada sin grant ni evaluación puede ejecutarse (nunca DRAFT/TESTED/RETIRED). */
const PINNED_DEPLOYED_STATUSES: readonly string[] = ['APPROVED', 'CANARY', 'ACTIVE'];

const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_FAILURES = 5;
const CIRCUIT_OPEN_MS = 30_000;

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function refOf(bundle: RouteBundle, assignment: string): RouteRef {
  return {
    route_id: bundle.route.route_id, route_version: bundle.route.version, prompt_revision_id: bundle.prompt.revision_id,
    prompt_version: bundle.prompt.version, prompt_sha256: bundle.prompt.sha256, model_id: bundle.model.model_id,
    provider_id: bundle.provider.provider_id, provider_kind: bundle.provider.kind, provider_model: bundle.model.provider_model, assignment,
    route_status: bundle.route.status,
  };
}

export class AiDispatcher {
  readonly registry: AiRegistry;
  readonly lab: AiLab;
  private readonly pool: Pool;
  private readonly config: AppConfig;
  private readonly simulated = new SimulatedAdapter();
  private readonly fetchImpl?: typeof fetch;
  private readonly failures = new Map<string, number[]>();
  private readonly openUntil = new Map<string, number>();
  /** DEC-0032 (TS-1): libro de TypeSafe; las clasificaciones con TypeSafe reservan en él antes de llamar. */
  private readonly typesafe: TypeSafeBudget;

  constructor(deps: { pool: Pool; config: AppConfig; fetchImpl?: typeof fetch; registry?: AiRegistry; lab?: AiLab; typesafe?: TypeSafeBudget }) {
    this.pool = deps.pool;
    this.config = deps.config;
    this.registry = deps.registry ?? new AiRegistry(deps.pool);
    this.lab = deps.lab ?? new AiLab({ pool: deps.pool, registry: this.registry, environment: deps.config.aiEnvironment, appEnv: deps.config.appEnv });
    this.fetchImpl = deps.fetchImpl;
    this.typesafe = deps.typesafe ?? new TypeSafeLedger({ pool: deps.pool, dailyLimitUsd: () => typesafeDailyLimitUsd(deps.config.jev) });
  }

  /**
   * Adaptador por proveedor directo (DEC-0069); la clave se lee del entorno por su referencia en cada
   * uso (rotación sin código). OpenRouter no tiene adaptador: sus rutas quedaron retiradas.
   */
  adapterFor(bundle: RouteBundle): ProviderAdapter | null {
    if (bundle.provider.kind === 'simulated') return this.simulated;
    const key = bundle.provider.secret_ref ? process.env[bundle.provider.secret_ref] : undefined;
    if (!key) return null;
    const opts = { apiKey: key, baseUrl: bundle.provider.base_url ?? undefined, fetchImpl: this.fetchImpl };
    if (bundle.provider.kind === 'anthropic') return new AnthropicAdapter(opts);
    if (bundle.provider.kind === 'openai') return new OpenAIAdapter(opts);
    return null;
  }

  private static paid(bundle: RouteBundle): boolean {
    return (PAID_PROVIDER_KINDS as readonly string[]).includes(bundle.provider.kind);
  }

  private circuitOpen(providerId: string): boolean {
    const until = this.openUntil.get(providerId) ?? 0;
    return until > Date.now();
  }
  private noteFailure(providerId: string): void {
    const now = Date.now();
    const list = (this.failures.get(providerId) ?? []).filter((t) => now - t < CIRCUIT_WINDOW_MS);
    list.push(now);
    this.failures.set(providerId, list);
    if (list.length >= CIRCUIT_FAILURES) {
      this.openUntil.set(providerId, now + CIRCUIT_OPEN_MS);
      log.warn('ai.circuit.open', 'provider circuit opened after repeated failures', { provider_id: providerId });
    }
  }
  private noteSuccess(providerId: string): void {
    this.failures.delete(providerId);
  }

  // ------------------------------------------------------------------ inicio común

  /**
   * Fila `blocked` sin ruta resuelta (grant inválido): rastro durable sin tocar proveedor ni presupuesto. Si la clave
   * ya tiene una invocación (replay rechazado), no se duplica: el rechazo queda en el log y en el resultado.
   */
  private async blockedWithoutRoute(useCaseId: string, ctx: InvokeContext, inputHash: string, code: FailureCode, detail: string): Promise<string | null> {
    const invocationId = `inv_${randomUUID()}`;
    const r = await this.pool.query(
      `INSERT INTO ai_invocation (invocation_id, request_id, idempotency_key, tenant_id, actor_id, actor_kind, origin, use_case_id, policy_version, consent_ref, brand_version,
         job_id, eval_run_id, lab_grant_id, status, input_sha256, error_code, validation, trace_id, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'blocked',$15,$16,$17,$18,now())
       ON CONFLICT ((COALESCE(tenant_id, '-')), use_case_id, idempotency_key) DO NOTHING`,
      [invocationId, ctx.requestId, ctx.idempotencyKey, ctx.tenantId, ctx.actorId, ctx.actorKind, ctx.origin, useCaseId, DATA_POLICY_VERSION, ctx.consentRef ?? null,
        ctx.brandVersion ?? null, ctx.jobId ?? null, ctx.evalRunId ?? null, ctx.labGrantId || null, inputHash, code, JSON.stringify({ detail }), ctx.requestId]);
    return r.rowCount ? invocationId : null;
  }

  /**
   * Una respuesta previa solo se reutiliza para la misma identidad de laboratorio: mismo grant (o ninguno) y, si
   * hubo grant, el mismo usuario. Una petición normal nunca recibe la salida de una ruta en borrador.
   */
  private replayIsolated(prev: PriorInvocation, ctx: InvokeContext): boolean {
    if ((prev.lab_grant_id ?? null) !== (ctx.labGrantId || null)) return false;
    return !prev.lab_grant_id || prev.actor_id === ctx.actorId;
  }

  private async begin(useCaseId: string, ctx: InvokeContext, inputHash: string): Promise<Started | InvokeResult<never> | { replay: Record<string, unknown> }> {
    const uc = await this.registry.useCase(useCaseId);
    if (!uc) return { ok: false, code: 'disabled', reason: 'Este caso de uso no existe.', invocationId: null, route: null, retryable: false };
    // Grant del laboratorio: se revalida ANTES de cualquier replay o gasto (también en clasificación y en el worker).
    // La clasificación sigue su ruta normal (TypeSafe) sin exigir que esté en la allowlist; una capacidad generativa
    // fuera de la allowlist se bloquea aquí: nunca cae al rollout.
    let labRoute: LabGrantRoute | null = null;
    if (ctx.labGrantId) {
      const generative = uc.modality !== 'classification';
      const check = await this.lab.check({ grantId: ctx.labGrantId, tenantId: ctx.tenantId, userId: ctx.actorId, useCaseId: generative ? useCaseId : null, routeId: generative ? ctx.pinnedRouteId ?? null : null });
      if (!check.ok) {
        const invocationId = await this.blockedWithoutRoute(useCaseId, ctx, inputHash, 'lab_grant_invalid', check.reason);
        log.warn('ai.lab.grant_rejected', 'lab grant rejected at invocation', { use_case_id: useCaseId, invocation_id: invocationId, reason: check.reason });
        return { ok: false, code: 'lab_grant_invalid', reason: check.reason, invocationId, route: null, retryable: false };
      }
      labRoute = check.route;
    }

    const existing = await this.pool.query<PriorInvocation>(
      `SELECT invocation_id, status, output, route_id, error_code, assignment, actor_id, lab_grant_id FROM ai_invocation
        WHERE COALESCE(tenant_id, '-') = COALESCE($1, '-') AND use_case_id = $2 AND idempotency_key = $3`,
      [ctx.tenantId, useCaseId, ctx.idempotencyKey]);
    const prev = existing.rows[0];
    if (prev) {
      if (!this.replayIsolated(prev, ctx)) return { ok: false, code: 'lab_grant_invalid', reason: 'replay_requires_same_grant', invocationId: prev.invocation_id, route: null, retryable: false };
      if (prev.status === 'succeeded') return { replay: prev as unknown as Record<string, unknown> };
      if (prev.status === 'running') return { ok: false, code: 'in_progress', reason: 'Esta solicitud ya se está procesando.', invocationId: prev.invocation_id, route: null, retryable: true };
      return { ok: false, code: (prev.error_code as FailureCode) ?? 'provider_unavailable', reason: 'La solicitud anterior con la misma clave no terminó; usa una clave nueva para reintentar.', invocationId: prev.invocation_id, route: null, retryable: false };
    }
    // Jobs: cada intento usa su propia clave (un fallo no bloquea el reintento), pero un paso que
    // YA terminó bien con la misma entrada en este job se reutiliza: nunca se paga dos veces.
    if (ctx.jobId) {
      const done = await this.pool.query<PriorInvocation>(
        `SELECT invocation_id, status, output, route_id, error_code, assignment, actor_id, lab_grant_id FROM ai_invocation
          WHERE job_id = $1 AND use_case_id = $2 AND input_sha256 = $3 AND status = 'succeeded' AND COALESCE(lab_grant_id, '-') = COALESCE($4, '-')
          ORDER BY created_at DESC LIMIT 1`,
        [ctx.jobId, useCaseId, inputHash, ctx.labGrantId || null]);
      if (done.rows[0] && this.replayIsolated(done.rows[0], ctx)) return { replay: done.rows[0] as unknown as Record<string, unknown> };
    }

    if (uc.status !== 'active') return { ok: false, code: 'disabled', reason: 'Este caso de uso no está activo.', invocationId: null, route: null, retryable: false };

    let routeId: string;
    let assignment: string;
    if (labRoute) {
      routeId = labRoute.route_id;
      assignment = 'manual_lab';
    } else if (ctx.pinnedRouteId) {
      routeId = ctx.pinnedRouteId;
      if (ctx.evalRunId) {
        // Solo una evaluación real existente (fila creada por runEvalSuite para ESTA ruta) ejecuta borradores.
        const run = await this.pool.query(`SELECT 1 FROM ai_eval_run WHERE run_id = $1 AND route_id = $2 AND status = 'running'`, [ctx.evalRunId, routeId]);
        if (!run.rowCount) return { ok: false, code: 'no_active_route', reason: 'eval_run_mismatch', invocationId: null, route: null, retryable: false };
        assignment = 'eval';
      } else {
        assignment = 'pinned';
      }
    } else {
      const resolved = await this.registry.resolve(useCaseId, this.config.aiEnvironment, ctx.tenantId ?? ctx.idempotencyKey);
      if (!resolved) return { ok: false, code: 'no_active_route', reason: 'No hay una ruta activa para este caso de uso.', invocationId: null, route: null, retryable: false };
      routeId = resolved.routeId;
      assignment = resolved.assignment;
    }
    const bundle = await this.registry.bundle(routeId);
    if (!bundle || bundle.route.use_case_id !== useCaseId) return { ok: false, code: 'no_active_route', reason: 'La ruta indicada no existe para este caso de uso.', invocationId: null, route: null, retryable: false };
    if (assignment === 'pinned' && !PINNED_DEPLOYED_STATUSES.includes(bundle.route.status)) {
      // Un pin no es permiso: una ruta en borrador o retirada no se ejecuta sin evaluación real ni grant del laboratorio.
      return { ok: false, code: 'no_active_route', reason: 'pinned_route_not_deployable', invocationId: null, route: null, retryable: false };
    }
    const ref = refOf(bundle, assignment);

    const invocationId = `inv_${randomUUID()}`;
    const policy = await checkDataPolicy(this.pool, this.config, bundle.provider, ctx.tenantId);
    const blockedRow = async (code: FailureCode, detail: string) => {
      await this.pool.query(
        `INSERT INTO ai_invocation (invocation_id, request_id, idempotency_key, tenant_id, actor_id, actor_kind, origin, use_case_id, route_id, route_version,
           prompt_revision_id, prompt_sha256, model_id, provider_id, provider_model, assignment, policy_version, consent_ref, brand_version, job_id, eval_run_id,
           status, input_sha256, error_code, validation, trace_id, lab_grant_id, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'blocked',$22,$23,$24,$25,$26,now())`,
        [invocationId, ctx.requestId, ctx.idempotencyKey, ctx.tenantId, ctx.actorId, ctx.actorKind, ctx.origin, useCaseId, ref.route_id, ref.route_version,
          ref.prompt_revision_id, ref.prompt_sha256, ref.model_id, ref.provider_id, ref.provider_model, assignment, DATA_POLICY_VERSION, ctx.consentRef ?? null,
          ctx.brandVersion ?? null, ctx.jobId ?? null, ctx.evalRunId ?? null, inputHash, code, JSON.stringify({ detail }), ctx.requestId, ctx.labGrantId || null]);
    };
    if (!policy.allowed) {
      await blockedRow('blocked_external', policy.reason);
      return { ok: false, code: 'blocked_external', reason: policy.reason, invocationId, route: ref, retryable: false };
    }
    if (this.circuitOpen(bundle.provider.provider_id)) {
      await blockedRow('circuit_open', 'provider circuit open');
      return { ok: false, code: 'circuit_open', reason: 'El proveedor falló varias veces seguidas; se reintenta en unos segundos.', invocationId, route: ref, retryable: true };
    }

    const reserve = AiDispatcher.paid(bundle) ? Number(bundle.route.max_cost_usd) : 0;
    const budgetOk = await runAtomic(this.pool, async (client) => {
      if (reserve > 0) {
        const b = await reserveBudget(client, { tenantId: ctx.tenantId, purpose: budgetPurpose(ctx), reserveUsd: reserve });
        if (!b.allowed) return b;
      }
      await client.query(
        `INSERT INTO ai_invocation (invocation_id, request_id, idempotency_key, tenant_id, actor_id, actor_kind, origin, use_case_id, route_id, route_version,
           prompt_revision_id, prompt_sha256, model_id, provider_id, provider_model, assignment, policy_version, consent_ref, brand_version, job_id, eval_run_id,
           status, reserved_usd, input_sha256, trace_id, lab_grant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'running',$22,$23,$24,$25)`,
        [invocationId, ctx.requestId, ctx.idempotencyKey, ctx.tenantId, ctx.actorId, ctx.actorKind, ctx.origin, useCaseId, ref.route_id, ref.route_version,
          ref.prompt_revision_id, ref.prompt_sha256, ref.model_id, ref.provider_id, ref.provider_model, assignment, DATA_POLICY_VERSION, ctx.consentRef ?? null,
          ctx.brandVersion ?? null, ctx.jobId ?? null, ctx.evalRunId ?? null, reserve, inputHash, ctx.requestId, ctx.labGrantId || null]);
      return { allowed: true as const };
    });
    if (!budgetOk.allowed) {
      await blockedRow('budget_exhausted', `${budgetOk.exceeded}`);
      return { ok: false, code: 'budget_exhausted', reason: budgetOk.exceeded, invocationId, route: ref, retryable: false };
    }
    return { invocationId, bundle, ref, started: performance.now(), adapter: this.adapterFor(bundle) };
  }

  /**
   * Cierra la invocación. `output_sha256` (hash del JSON de salida, o de los bytes si `outputBytes`) queda aunque
   * la retención purgue el contenido: la evidencia manual aceptada sigue siendo verificable.
   */
  private async finish(s: Started, status: 'succeeded' | 'failed', data: { usage: Usage; costSource?: string; output?: unknown; outputBytes?: Buffer; validation?: unknown; errorCode?: string | null }): Promise<{ costUsd: number | null; costSource: string; latencyMs: number }> {
    const latencyMs = Math.round(performance.now() - s.started);
    let costUsd: number | null = null;
    let costSource = 'none';
    if (s.bundle.provider.kind === 'simulated') {
      costUsd = 0; costSource = 'none';
    } else if (status === 'failed' && AiDispatcher.paid(s.bundle) && (data.errorCode === 'timeout' || data.errorCode === 'provider_unavailable')) {
      // Sin respuesta final no conocemos el cargo, aunque hubiese rondas previas con uso.
      // Mantener cost_usd NULL conserva la reserva en SPENT_SQL; nunca inventar un costo cero.
      costSource = 'unknown';
    } else if (data.usage.costUsd !== null && Number.isFinite(data.usage.costUsd)) {
      costUsd = data.usage.costUsd; costSource = data.costSource ?? 'reported';
    } else {
      const est = estimateCost(s.bundle.model.pricing, data.usage);
      costUsd = est; costSource = est === null ? 'unknown' : 'estimated';
    }
    const outputSha = status === 'succeeded' && (data.outputBytes || data.output !== undefined)
      ? (data.outputBytes ? createHash('sha256').update(data.outputBytes).digest('hex') : sha(data.output))
      : null;
    await this.pool.query(
      `UPDATE ai_invocation SET status = $2, cost_usd = $3, cost_source = $4, usage = $5, latency_ms = $6, output = $7, validation = $8,
         error_code = $9, output_sha256 = $10, finished_at = now() WHERE invocation_id = $1`,
      [s.invocationId, status, costUsd, costSource, JSON.stringify(data.usage), latencyMs, data.output === undefined ? null : JSON.stringify(data.output),
        JSON.stringify(data.validation ?? {}), data.errorCode ?? null, outputSha]);
    return { costUsd, costSource, latencyMs };
  }

  private providerFailure(s: Started, err: unknown): { code: FailureCode; retryable: boolean; reason: string } {
    if (err instanceof ProviderError) {
      // Solo los fallos transitorios del proveedor abren el circuito; un 4xx del cliente no.
      if (err.retryable) this.noteFailure(s.bundle.provider.provider_id);
      if (err.kind === 'auth' || err.kind === 'insufficient_credit') return { code: 'provider_auth', retryable: false, reason: err.kind };
      if (err.kind === 'policy_blocked') return { code: 'blocked_external', retryable: false, reason: 'provider_account_policy' };
      if (err.kind === 'timeout') return { code: 'timeout', retryable: true, reason: 'timeout' };
      return { code: 'provider_unavailable', retryable: err.retryable, reason: err.kind };
    }
    if (err instanceof PromptRenderError) return { code: 'render_error', retryable: false, reason: err.message };
    // Una excepción que no viene del proveedor es un defecto propio: se registra para corregirlo.
    log.error('ai.invoke.unexpected', 'unexpected exception during ai invocation', {
      use_case_id: s.ref.route_id ? s.bundle.route.use_case_id : null, error_name: err instanceof Error ? err.name : 'unknown',
      error_message: err instanceof Error ? err.message.slice(0, 200) : null, at: err instanceof Error ? (err.stack ?? '').split('\n').slice(1, 4).join(' | ').slice(0, 400) : null,
    });
    this.noteFailure(s.bundle.provider.provider_id);
    return { code: 'provider_unavailable', retryable: true, reason: err instanceof Error ? err.name : 'unknown' };
  }

  private addUsage(a: Usage, b: Usage): Usage {
    return {
      inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, reasoningTokens: a.reasoningTokens + b.reasoningTokens,
      images: a.images + b.images, costUsd: a.costUsd === null || b.costUsd === null ? (a.costUsd ?? b.costUsd) : a.costUsd + b.costUsd,
    };
  }

  private timeout(s: Started, ctx: InvokeContext): number {
    return Math.min(s.bundle.route.params.timeout_ms ?? 60_000, ctx.deadlineMs ?? 300_000);
  }

  // ------------------------------------------------------------------ texto estructurado

  async invokeStructured<T>(useCaseId: string, ctx: InvokeContext, values: Record<string, unknown>, opts: { domainCheck?: (out: T) => string[] } = {}): Promise<InvokeResult<T>> {
    const begun = await this.begin(useCaseId, ctx, sha(values));
    if ('replay' in begun) return this.replayResult<T>(begun.replay, useCaseId);
    if ('ok' in begun) return begun;
    const s = begun;
    const uc = await this.registry.useCase(useCaseId);
    const schema = uc ? OUTPUT_SCHEMAS[uc.output_schema] : undefined;
    let usage: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, images: 0, costUsd: AiDispatcher.paid(s.bundle) ? null : 0 };
    if (!schema || !s.adapter) {
      const fin = await this.finish(s, 'failed', { usage, errorCode: !schema ? 'render_error' : 'blocked_external' });
      void fin;
      return { ok: false, code: !schema ? 'render_error' : 'blocked_external', reason: !schema ? 'unknown_output_schema' : 'secret_missing', invocationId: s.invocationId, route: s.ref, retryable: false };
    }
    try {
      const rendered = renderPrompt(s.bundle.prompt, values);
      const messages: ChatMessage[] = [{ role: 'system', content: rendered.system }, { role: 'user', content: rendered.user }];
      const p = s.bundle.route.params;
      const repairs = p.repair_attempts ?? 1;
      let lastErrors: string[] = [];
      for (let attempt = 0; attempt <= repairs; attempt++) {
        const res = await s.adapter.chat({
          model: s.bundle.model.provider_model, messages, responseSchema: { name: uc!.output_schema, schema: toModelSchema(schema) },
          temperature: p.temperature ?? null, supportsTemperature: s.bundle.model.capabilities['temperature'] === true, maxTokens: p.max_tokens ?? 4000, reasoningEffort: p.reasoning_effort ?? null,
          timeoutMs: this.timeout(s, ctx), simulation: { useCaseId, values },
        });
        usage = this.addUsage(usage, res.usage);
        let parsed: unknown;
        try {
          parsed = parseJsonOutput(res.content ?? '');
          lastErrors = validate(schema, parsed);
        } catch {
          lastErrors = ['la salida no es JSON'];
        }
        if (!lastErrors.length && opts.domainCheck) lastErrors = opts.domainCheck(parsed as T);
        if (!lastErrors.length) {
          this.noteSuccess(s.bundle.provider.provider_id);
          const fin = await this.finish(s, 'succeeded', { usage, output: parsed, validation: { attempts: attempt + 1, errors: [] } });
          return { ok: true, output: parsed as T, invocationId: s.invocationId, route: s.ref, usage, ...fin, replayed: false, simulated: s.bundle.provider.kind === 'simulated' };
        }
        messages.push({ role: 'assistant', content: res.content ?? '' });
        messages.push({ role: 'user', content: `La salida anterior no cumple el contrato. Corrige SOLO estos problemas y devuelve el JSON completo:\n- ${lastErrors.slice(0, 12).join('\n- ')}` });
      }
      await this.finish(s, 'failed', { usage, validation: { errors: lastErrors.slice(0, 20) }, errorCode: 'invalid_output' });
      return { ok: false, code: 'invalid_output', reason: lastErrors.slice(0, 3).join('; '), invocationId: s.invocationId, route: s.ref, retryable: true };
    } catch (err) {
      const f = this.providerFailure(s, err);
      await this.finish(s, 'failed', { usage, errorCode: f.code, validation: { detail: f.reason } });
      log.warn('ai.invoke.failed', 'ai invocation failed', { use_case_id: useCaseId, invocation_id: s.invocationId, code: f.code });
      return { ok: false, code: f.code, reason: f.reason, invocationId: s.invocationId, route: s.ref, retryable: f.retryable };
    }
  }

  // ------------------------------------------------------------------ herramientas (asistente)

  async invokeWithTools<T>(useCaseId: string, ctx: InvokeContext, values: Record<string, unknown>, tools: ToolDef[], opts: { domainCheck?: (out: T, toolOutputs: unknown[]) => string[]; maxRounds?: number } = {}): Promise<InvokeResult<T> & { toolOutputs?: unknown[] }> {
    const begun = await this.begin(useCaseId, ctx, sha(values));
    if ('replay' in begun) return this.replayResult<T>(begun.replay, useCaseId);
    if ('ok' in begun) return begun;
    const s = begun;
    const uc = await this.registry.useCase(useCaseId);
    const schema = uc ? OUTPUT_SCHEMAS[uc.output_schema] : undefined;
    let usage: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, images: 0, costUsd: AiDispatcher.paid(s.bundle) ? null : 0 };
    if (!schema || !s.adapter) {
      await this.finish(s, 'failed', { usage, errorCode: 'blocked_external' });
      return { ok: false, code: 'blocked_external', reason: 'secret_missing', invocationId: s.invocationId, route: s.ref, retryable: false };
    }
    const toolOutputs: unknown[] = [];
    const calls: Array<{ tool: string; ok: boolean }> = [];
    try {
      const rendered = renderPrompt(s.bundle.prompt, values);
      const messages: ChatMessage[] = [{ role: 'system', content: rendered.system }, { role: 'user', content: rendered.user }];
      const p = s.bundle.route.params;
      const byName = new Map(tools.map((t) => [t.spec.name, t]));
      const maxRounds = opts.maxRounds ?? 4;
      for (let round = 0; round <= maxRounds; round++) {
        const finalRound = round === maxRounds;
        const res = await s.adapter.chat({
          model: s.bundle.model.provider_model, messages,
          tools: finalRound ? undefined : tools.map((t) => t.spec),
          responseSchema: { name: uc!.output_schema, schema: toModelSchema(schema) },
          temperature: p.temperature ?? null, supportsTemperature: s.bundle.model.capabilities['temperature'] === true, maxTokens: p.max_tokens ?? 2000, reasoningEffort: p.reasoning_effort ?? null,
          timeoutMs: this.timeout(s, ctx), simulation: { useCaseId, values },
        });
        usage = this.addUsage(usage, res.usage);
        if (res.toolCalls.length && !finalRound) {
          messages.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) });
          for (const call of res.toolCalls.slice(0, 6)) {
            const tool = byName.get(call.name);
            let out: unknown;
            if (!tool) {
              out = { error: 'herramienta no permitida' };
              calls.push({ tool: call.name.slice(0, 40), ok: false });
            } else {
              let args: Record<string, unknown> = {};
              try { args = JSON.parse(call.arguments || '{}') as Record<string, unknown>; } catch { args = {}; }
              out = await tool.run(args);
              toolOutputs.push(out);
              calls.push({ tool: call.name, ok: true });
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out).slice(0, 12_000) });
          }
          continue;
        }
        let parsed: unknown;
        let errors: string[];
        try {
          parsed = parseJsonOutput(res.content ?? '');
          errors = validate(schema, parsed);
        } catch {
          errors = ['la salida no es JSON'];
        }
        if (!errors.length && opts.domainCheck) errors = opts.domainCheck(parsed as T, toolOutputs);
        if (!errors.length) {
          this.noteSuccess(s.bundle.provider.provider_id);
          const fin = await this.finish(s, 'succeeded', { usage, output: parsed, validation: { rounds: round + 1, tools: calls } });
          return { ok: true, output: parsed as T, invocationId: s.invocationId, route: s.ref, usage, ...fin, replayed: false, simulated: s.bundle.provider.kind === 'simulated', toolOutputs };
        }
        if (finalRound) {
          await this.finish(s, 'failed', { usage, validation: { errors, tools: calls }, errorCode: 'invalid_output' });
          return { ok: false, code: 'invalid_output', reason: errors.slice(0, 3).join('; '), invocationId: s.invocationId, route: s.ref, retryable: false, toolOutputs };
        }
        messages.push({ role: 'assistant', content: res.content ?? '' });
        messages.push({ role: 'user', content: `La respuesta no cumple: ${errors.slice(0, 6).join('; ')}. Usa solo datos de las herramientas y devuelve el JSON.` });
      }
      await this.finish(s, 'failed', { usage, errorCode: 'invalid_output' });
      return { ok: false, code: 'invalid_output', reason: 'max_rounds', invocationId: s.invocationId, route: s.ref, retryable: false, toolOutputs };
    } catch (err) {
      const f = this.providerFailure(s, err);
      await this.finish(s, 'failed', { usage, errorCode: f.code, validation: { detail: f.reason, tools: calls } });
      return { ok: false, code: f.code, reason: f.reason, invocationId: s.invocationId, route: s.ref, retryable: f.retryable, toolOutputs };
    }
  }

  // ------------------------------------------------------------------ imágenes

  async invokeImage(useCaseId: string, ctx: InvokeContext, values: Record<string, unknown>, aspect?: '16:9' | '4:3' | '1:1' | '3:4' | '4:5'): Promise<InvokeResult<ImageOutput>> {
    const begun = await this.begin(useCaseId, ctx, sha(values));
    if ('replay' in begun) return { ok: false, code: 'in_progress', reason: 'La imagen ya se generó con esta clave; búscala en la biblioteca.', invocationId: String(begun.replay['invocation_id']), route: null, retryable: false };
    if ('ok' in begun) return begun;
    const s = begun;
    let usage: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, images: 0, costUsd: AiDispatcher.paid(s.bundle) ? null : 0 };
    if (!s.adapter) {
      await this.finish(s, 'failed', { usage, errorCode: 'blocked_external' });
      return { ok: false, code: 'blocked_external', reason: 'secret_missing', invocationId: s.invocationId, route: s.ref, retryable: false };
    }
    try {
      const rendered = renderPrompt(s.bundle.prompt, values);
      const prompt = `${s.bundle.prompt.system_text}\n\n${rendered.user}`;
      const p = s.bundle.route.params;
      const res = await s.adapter.image({
        model: s.bundle.model.provider_model, prompt, aspectRatio: aspect ?? ((p.aspect_ratio as '16:9') ?? '16:9'), resolution: p.resolution ?? null, quality: p.quality ?? null, timeoutMs: this.timeout(s, ctx),
      });
      usage = this.addUsage(usage, res.usage);
      this.noteSuccess(s.bundle.provider.provider_id);
      const fin = await this.finish(s, 'succeeded', { usage, output: { media_type: res.mediaType, bytes: res.bytes.length }, outputBytes: res.bytes });
      return { ok: true, output: { bytes: res.bytes, mediaType: res.mediaType }, invocationId: s.invocationId, route: s.ref, usage, ...fin, replayed: false, simulated: s.bundle.provider.kind === 'simulated' };
    } catch (err) {
      const f = this.providerFailure(s, err);
      await this.finish(s, 'failed', { usage, errorCode: f.code, validation: { detail: f.reason } });
      return { ok: false, code: f.code, reason: f.reason, invocationId: s.invocationId, route: s.ref, retryable: f.retryable };
    }
  }

  // ------------------------------------------------------------------ clasificación (Jev)

  /**
   * Clasificación semántica con Jev. La revisión de prompt guarda las preguntas tipadas en JSON
   * (versionables en Prompt Studio); el estado enviado es SOLO el texto minimizado.
   * DEC-0032 (TS-1): con TypeSafe se reserva el costo máximo de la ruta en el libro de TypeSafe ANTES de preparar la
   * llamada; sin reserva no sale nada (`budget_exhausted`). Un fallo antes de enviar libera la reserva; tras enviar, la
   * respuesta confirma su costo medido y cualquier fallo queda con costo desconocido (cuenta la reserva). El simulado
   * (MockJev) no gasta TypeSafe y no reserva.
   */
  async invokeClassification(useCaseId: string, ctx: InvokeContext, state: Record<string, unknown>): Promise<InvokeResult<{ answers: Record<string, Answer>; model: string }>> {
    const begun = await this.begin(useCaseId, ctx, sha(state));
    if ('replay' in begun) return this.replayResult(begun.replay, useCaseId);
    if ('ok' in begun) return begun;
    const s = begun;
    const usage: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, images: 0, costUsd: null };
    const isMock = s.bundle.provider.kind === 'simulated';
    // Cierre sin llamar al proveedor (sin reserva, o vencida antes de enviar): nada salió, costo cero.
    const notSent = async (code: FailureCode, reason: string, retryable: boolean): Promise<InvokeResult<never>> => {
      await this.finish(s, 'failed', { usage: { ...usage, costUsd: 0 }, costSource: 'none', errorCode: code, validation: { detail: reason } });
      return { ok: false, code, reason, invocationId: s.invocationId, route: s.ref, retryable };
    };
    // 429/5xx ya se reintentaron (backoff acotado del cliente); aquí solo se clasifica el fallo final.
    const failed = async (err: unknown, sent: TypeSafeHold | null): Promise<InvokeResult<never>> => {
      const f = err instanceof JevHttpError
        ? (err.status === 401 || err.status === 403
          ? { code: 'provider_auth' as FailureCode, retryable: false, reason: `typesafe_http_${err.status}` }
          : this.providerFailure(s, new ProviderError(err.status === 429 ? 'rate_limited' : err.status >= 500 ? 'unavailable' : 'bad_request', err.status, `typesafe_http_${err.status}`)))
        : this.providerFailure(s, err);
      if (sent) await this.typesafe.failAfterDispatch(sent, f.reason);
      await this.finish(s, 'failed', { usage, errorCode: f.code, validation: { detail: f.reason } });
      return { ok: false, code: f.code, reason: f.reason, invocationId: s.invocationId, route: s.ref, retryable: f.retryable };
    };
    let hold: TypeSafeHold | null = null;
    if (!isMock) {
      const reservation = await this.typesafe.reserve({ key: `ai_invocation:${s.invocationId}`, source: 'ai_core', useCaseId, reserveUsd: Number(s.bundle.route.max_cost_usd) });
      if (reservation.status === 'denied') return notSent('budget_exhausted', 'DEC-0032', false);
      if (reservation.status !== 'reserved') return notSent('in_progress', `typesafe_${reservation.status}`, false);
      hold = reservation.hold;
    }
    let send: () => Promise<SystemOneResult>;
    try {
      const questions = JSON.parse(s.bundle.prompt.task_template) as Questions;
      const key = s.bundle.provider.secret_ref ? process.env[s.bundle.provider.secret_ref] : undefined;
      const client = isMock
        ? new JevClient({ provider: 'mock' })
        : new JevClient({ provider: 'typesafe', apiKey: key, model: s.bundle.model.provider_model, timeoutMs: this.timeout(s, ctx), maxAttempts: 3, pricing: { inputPerMillion: Number(s.bundle.model.pricing['input_per_mtok'] ?? 0.042), outputPerMillion: 0 } });
      // La misma validación que el cliente hace antes de cualquier envío: una petición inválida nunca sale ni cuenta.
      validateRequest({ model: client.defaultModel, state, questions });
      send = () => client.systemOne(state, questions);
    } catch (err) {
      if (hold) await this.typesafe.release(hold, 'not_sent');
      return failed(err, null);
    }
    if (hold && !(await this.typesafe.dispatched(hold))) return notSent('timeout', 'typesafe_reservation_expired', true);
    let res: SystemOneResult;
    try {
      res = await send();
    } catch (err) {
      return failed(err, hold);
    }
    if (hold) await this.typesafe.commit(hold, measuredCost(res.meta));
    const cost = isMock ? 0 : res.meta.cost.amount;
    const u: Usage = { inputTokens: Number(res.usage.input_tokens ?? 0), outputTokens: Number(res.usage.output_tokens ?? 0), reasoningTokens: 0, images: 0, costUsd: cost };
    this.noteSuccess(s.bundle.provider.provider_id);
    const fin = await this.finish(s, 'succeeded', { usage: u, costSource: isMock ? 'none' : res.meta.cost.source, output: { answers: res.answers, model: res.model }, validation: { provider_meta: res.meta } });
    return { ok: true, output: { answers: res.answers, model: res.model }, invocationId: s.invocationId, route: s.ref, usage: u, ...fin, replayed: false, simulated: isMock };
  }

  /** Respuesta repetida (misma clave o paso de job ya terminado): misma salida y la ruta que la produjo, sin costo nuevo. */
  private async replayResult<T>(row: Record<string, unknown>, useCaseId: string): Promise<InvokeResult<T>> {
    if (row['output'] === null) {
      return { ok: false, code: 'invalid_output', reason: 'El contenido de esta solicitud ya fue eliminado por retención; crea una solicitud nueva.', invocationId: String(row['invocation_id']), route: null, retryable: false };
    }
    const bundle = row['route_id'] ? await this.registry.bundle(String(row['route_id'])) : null;
    if (!bundle || bundle.route.use_case_id !== useCaseId) {
      return { ok: false, code: 'no_active_route', reason: 'La ruta de la respuesta anterior ya no existe.', invocationId: String(row['invocation_id']), route: null, retryable: false };
    }
    return {
      ok: true, output: row['output'] as T, invocationId: String(row['invocation_id']), route: refOf(bundle, String(row['assignment'] ?? 'replay')),
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, images: 0, costUsd: 0 }, costUsd: 0, costSource: 'none', latencyMs: 0, replayed: true,
      simulated: bundle.provider.kind === 'simulated',
    };
  }
}
