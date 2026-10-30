/**
 * Registro del AI Core en PostgreSQL (DAT-0001, FR-0019): casos de uso, proveedores, modelos,
 * revisiones inmutables de prompt y ruta, rollout atómico con canary y rollback, historial.
 *
 * Ciclo de vida de una revisión de ruta: DRAFT → TESTED (eval aprobada) → APPROVED (step-up)
 * → CANARY | ACTIVE → RETIRED. Una ruta deja de estar ACTIVE al ser reemplazada (vuelve a
 * APPROVED: puede ser destino de rollback). Toda transición del rollout es atómica y deja un evento.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { runAtomic } from '../conversation/state-machine.ts';
import { AppError } from '../shared/errors.ts';
import { promptSha256, validatePromptRevision, type PromptRevisionContent, type PromptVariable } from './prompt.ts';

export type RouteStatus = 'DRAFT' | 'TESTED' | 'APPROVED' | 'CANARY' | 'ACTIVE' | 'RETIRED';

export interface UseCaseRow {
  use_case_id: string; title: string; description: string; modality: 'text' | 'image' | 'classification';
  risk_level: string; owner: string; output_schema: string; tools: string[]; status: string;
}
export interface ProviderRow { provider_id: string; display_name: string; kind: 'openrouter' | 'typesafe' | 'simulated'; base_url: string | null; secret_ref: string | null; data_policy: string; terms_url: string | null; status: string }
export interface ModelRow { model_id: string; provider_id: string; provider_model: string; display_name: string; modality: string; capabilities: Record<string, unknown>; pricing: Record<string, number>; price_source: string; price_observed_at: string; status: string }
export interface PromptRevisionRow { revision_id: string; use_case_id: string; version: number; system_text: string; task_template: string; variables: PromptVariable[]; sha256: string; change_note: string; created_by: string; created_at: string; retired_at: string | null }
export interface RouteParams { temperature?: number | null; max_tokens?: number; timeout_ms?: number; reasoning_effort?: 'low' | 'medium' | 'high' | null; repair_attempts?: number; aspect_ratio?: string; resolution?: string | null; fallback_route_id?: string | null }
export interface RouteRow { route_id: string; use_case_id: string; version: number; model_id: string; prompt_revision_id: string; params: RouteParams; max_cost_usd: string; sha256: string; status: RouteStatus; change_note: string; created_by: string; created_at: string; tested_eval_run_id: string | null; approved_by: string | null; approved_at: string | null }
export interface RolloutRow { use_case_id: string; environment: string; active_route_id: string | null; canary_route_id: string | null; canary_percent: number; version: string; updated_by: string; updated_at: string }
export interface RouteBundle { route: RouteRow; prompt: PromptRevisionRow; model: ModelRow; provider: ProviderRow }

type Db = Pool | PoolClient;

export function routeSha256(input: { model_id: string; prompt_sha256: string; params: RouteParams; max_cost_usd: number }): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** Asignación estable a canary: hash(use_case, clave) mod 100 < porcentaje. */
export function canaryBucket(useCaseId: string, assignmentKey: string): number {
  return parseInt(createHash('sha256').update(`${useCaseId}:${assignmentKey}`).digest('hex').slice(0, 8), 16) % 100;
}

const PARAM_LIMITS = { max_tokens: [64, 32_000], timeout_ms: [2_000, 300_000] } as const;

export function validateRouteParams(p: RouteParams, modality: string): string[] {
  const errors: string[] = [];
  if (p.temperature !== undefined && p.temperature !== null && (typeof p.temperature !== 'number' || p.temperature < 0 || p.temperature > 2)) errors.push('temperature entre 0 y 2');
  for (const [k, [min, max]] of Object.entries(PARAM_LIMITS) as Array<[keyof typeof PARAM_LIMITS, readonly [number, number]]>) {
    const v = p[k];
    if (v !== undefined && (!Number.isInteger(v) || v < min || v > max)) errors.push(`${k} entre ${min} y ${max}`);
  }
  if (p.reasoning_effort !== undefined && p.reasoning_effort !== null && !['low', 'medium', 'high'].includes(p.reasoning_effort)) errors.push('reasoning_effort inválido');
  if (p.repair_attempts !== undefined && (!Number.isInteger(p.repair_attempts) || p.repair_attempts < 0 || p.repair_attempts > 1)) errors.push('repair_attempts 0 o 1');
  if (modality === 'image' && p.aspect_ratio !== undefined && !['16:9', '4:3', '1:1', '3:4', '4:5'].includes(p.aspect_ratio)) errors.push('aspect_ratio inválido');
  const known = new Set(['temperature', 'max_tokens', 'timeout_ms', 'reasoning_effort', 'repair_attempts', 'aspect_ratio', 'resolution', 'fallback_route_id']);
  for (const k of Object.keys(p)) if (!known.has(k)) errors.push(`parámetro desconocido: ${k}`);
  return errors;
}

export class AiRegistry {
  readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  // ---------------------------------------------------------------- lectura

  async useCase(id: string, db: Db = this.pool): Promise<UseCaseRow | null> {
    return (await db.query<UseCaseRow>('SELECT * FROM ai_use_case WHERE use_case_id = $1', [id])).rows[0] ?? null;
  }

  async rollout(useCaseId: string, environment: string, db: Db = this.pool): Promise<RolloutRow | null> {
    return (await db.query<RolloutRow>('SELECT * FROM ai_rollout WHERE use_case_id = $1 AND environment = $2', [useCaseId, environment])).rows[0] ?? null;
  }

  async bundle(routeId: string, db: Db = this.pool): Promise<RouteBundle | null> {
    const r = await db.query<{ route: RouteRow; prompt: PromptRevisionRow; model: ModelRow; provider: ProviderRow }>(
      `SELECT to_jsonb(r.*) AS route, to_jsonb(p.*) AS prompt, to_jsonb(m.*) AS model, to_jsonb(pv.*) AS provider
         FROM ai_route_revision r
         JOIN ai_prompt_revision p ON p.revision_id = r.prompt_revision_id
         JOIN ai_model m ON m.model_id = r.model_id
         JOIN ai_provider pv ON pv.provider_id = m.provider_id
        WHERE r.route_id = $1`, [routeId]);
    return r.rows[0] ?? null;
  }

  async prompt(revisionId: string): Promise<PromptRevisionRow | null> {
    return (await this.pool.query<PromptRevisionRow>('SELECT * FROM ai_prompt_revision WHERE revision_id = $1', [revisionId])).rows[0] ?? null;
  }

  async route(routeId: string, db: Db = this.pool): Promise<RouteRow | null> {
    return (await db.query<RouteRow>('SELECT * FROM ai_route_revision WHERE route_id = $1', [routeId])).rows[0] ?? null;
  }

  async listUseCases(environment: string): Promise<Array<UseCaseRow & { rollout: RolloutRow | null; active: RouteBundle | null; canary: RouteBundle | null; stats: Record<string, unknown> }>> {
    const cases = (await this.pool.query<UseCaseRow>('SELECT * FROM ai_use_case ORDER BY use_case_id')).rows;
    const stats = await this.pool.query<{ use_case_id: string; n: string; failed: string; cost: string | null; p50: number | null; p95: number | null; last_at: string | null }>(
      `SELECT use_case_id, count(*) AS n, count(*) FILTER (WHERE status IN ('failed','blocked')) AS failed,
              sum(cost_usd) AS cost,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 'succeeded') AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 'succeeded') AS p95,
              max(created_at) AS last_at
         FROM ai_invocation WHERE created_at > now() - interval '7 days' GROUP BY use_case_id`);
    const byUc = new Map(stats.rows.map((s) => [s.use_case_id, s]));
    const out = [];
    for (const uc of cases) {
      const rollout = await this.rollout(uc.use_case_id, environment);
      out.push({
        ...uc,
        rollout,
        active: rollout?.active_route_id ? await this.bundle(rollout.active_route_id) : null,
        canary: rollout?.canary_route_id ? await this.bundle(rollout.canary_route_id) : null,
        stats: byUc.get(uc.use_case_id) ?? { n: '0', failed: '0', cost: null, p50: null, p95: null, last_at: null },
      });
    }
    return out;
  }

  async prompts(useCaseId: string): Promise<PromptRevisionRow[]> {
    return (await this.pool.query<PromptRevisionRow>('SELECT * FROM ai_prompt_revision WHERE use_case_id = $1 ORDER BY version DESC', [useCaseId])).rows;
  }

  async routes(useCaseId: string): Promise<Array<RouteRow & { model: ModelRow; prompt_version: number; last_eval: Record<string, unknown> | null }>> {
    const r = await this.pool.query<RouteRow & { model: ModelRow; prompt_version: number; last_eval: Record<string, unknown> | null }>(
      `SELECT r.*, to_jsonb(m.*) AS model, p.version AS prompt_version,
              (SELECT jsonb_build_object('run_id', e.run_id, 'status', e.status, 'metrics', e.metrics, 'real_provider', e.real_provider, 'finished_at', e.finished_at)
                 FROM ai_eval_run e WHERE e.route_id = r.route_id ORDER BY e.started_at DESC LIMIT 1) AS last_eval
         FROM ai_route_revision r JOIN ai_model m ON m.model_id = r.model_id JOIN ai_prompt_revision p ON p.revision_id = r.prompt_revision_id
        WHERE r.use_case_id = $1 ORDER BY r.version DESC`, [useCaseId]);
    return r.rows;
  }

  async history(useCaseId: string, environment: string): Promise<Array<Record<string, unknown>>> {
    return (await this.pool.query('SELECT * FROM ai_rollout_event WHERE use_case_id = $1 AND environment = $2 ORDER BY at DESC, event_id DESC LIMIT 100', [useCaseId, environment])).rows;
  }

  async models(): Promise<Array<ModelRow & { provider: ProviderRow }>> {
    return (await this.pool.query<ModelRow & { provider: ProviderRow }>(
      'SELECT m.*, to_jsonb(p.*) AS provider FROM ai_model m JOIN ai_provider p ON p.provider_id = m.provider_id ORDER BY m.modality, m.model_id')).rows;
  }

  async providers(): Promise<ProviderRow[]> {
    return (await this.pool.query<ProviderRow>('SELECT * FROM ai_provider ORDER BY provider_id')).rows;
  }

  // ---------------------------------------------------------------- escritura de revisiones

  async createPromptRevision(useCaseId: string, content: PromptRevisionContent, changeNote: string, actor: string, db: Db = this.pool): Promise<PromptRevisionRow> {
    const errors = validatePromptRevision(content);
    if (!changeNote.trim() || changeNote.length > 500) errors.push('nota de cambio obligatoria (≤ 500)');
    if (errors.length) throw new AppError(400, 'validation_error', `La versión no es válida: ${errors.join('; ')}.`);
    if (!(await this.useCase(useCaseId, db))) throw new AppError(404, 'not_found', 'No existe ese caso de uso.');
    const sha = promptSha256(content);
    const exec = async (client: PoolClient) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ai_prompt:${useCaseId}`]);
      const same = await client.query<PromptRevisionRow>('SELECT * FROM ai_prompt_revision WHERE use_case_id = $1 AND sha256 = $2', [useCaseId, sha]);
      if (same.rows[0]) throw new AppError(409, 'validation_error', `Ese contenido ya existe como versión ${same.rows[0].version}.`);
      const v = await client.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM ai_prompt_revision WHERE use_case_id = $1', [useCaseId]);
      const res = await client.query<PromptRevisionRow>(
        `INSERT INTO ai_prompt_revision (revision_id, use_case_id, version, system_text, task_template, variables, sha256, change_note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [`prm_${randomUUID()}`, useCaseId, v.rows[0]?.v ?? 1, content.system_text, content.task_template, JSON.stringify(content.variables), sha, changeNote.trim(), actor]);
      return res.rows[0] as PromptRevisionRow;
    };
    return 'release' in db ? exec(db) : runAtomic(this.pool, exec);
  }

  async createRoute(input: { useCaseId: string; modelId: string; promptRevisionId: string; params: RouteParams; maxCostUsd: number; changeNote: string; actor: string }, db: Db = this.pool): Promise<RouteRow> {
    const uc = await this.useCase(input.useCaseId, db);
    if (!uc) throw new AppError(404, 'not_found', 'No existe ese caso de uso.');
    const model = (await db.query<ModelRow>('SELECT * FROM ai_model WHERE model_id = $1', [input.modelId])).rows[0];
    if (!model || model.status !== 'active') throw new AppError(400, 'validation_error', 'Elige un modelo activo del registro.');
    const expected = uc.modality === 'image' ? 'image' : uc.modality === 'classification' ? 'classification' : 'text';
    if (model.modality !== expected) throw new AppError(400, 'validation_error', `Este caso de uso necesita un modelo de tipo ${expected}.`);
    const prompt = (await db.query<PromptRevisionRow>('SELECT * FROM ai_prompt_revision WHERE revision_id = $1', [input.promptRevisionId])).rows[0];
    if (!prompt || prompt.use_case_id !== input.useCaseId) throw new AppError(400, 'validation_error', 'La versión de prompt no pertenece a este caso de uso.');
    if (prompt.retired_at) throw new AppError(400, 'validation_error', 'La versión de prompt está retirada.');
    const errors = validateRouteParams(input.params, uc.modality);
    if (!Number.isFinite(input.maxCostUsd) || input.maxCostUsd <= 0 || input.maxCostUsd > 2) errors.push('costo máximo por llamada entre 0 y 2 USD');
    if (!input.changeNote.trim() || input.changeNote.length > 500) errors.push('nota de cambio obligatoria (≤ 500)');
    if (input.params.fallback_route_id) {
      const fb = await this.route(input.params.fallback_route_id, db);
      if (!fb || fb.use_case_id !== input.useCaseId || !['APPROVED', 'ACTIVE', 'CANARY'].includes(fb.status)) errors.push('la ruta de respaldo debe ser una ruta aprobada del mismo caso de uso');
    }
    if (errors.length) throw new AppError(400, 'validation_error', `La ruta no es válida: ${errors.join('; ')}.`);
    const sha = routeSha256({ model_id: input.modelId, prompt_sha256: prompt.sha256, params: input.params, max_cost_usd: input.maxCostUsd });
    const exec = async (client: PoolClient) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ai_route:${input.useCaseId}`]);
      const v = await client.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM ai_route_revision WHERE use_case_id = $1', [input.useCaseId]);
      return (await client.query<RouteRow>(
        `INSERT INTO ai_route_revision (route_id, use_case_id, version, model_id, prompt_revision_id, params, max_cost_usd, sha256, change_note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [`rte_${randomUUID()}`, input.useCaseId, v.rows[0]?.v ?? 1, input.modelId, input.promptRevisionId, JSON.stringify(input.params), input.maxCostUsd, sha, input.changeNote.trim(), input.actor])).rows[0] as RouteRow;
    };
    return 'release' in db ? exec(db) : runAtomic(this.pool, exec);
  }

  async markTested(routeId: string, runId: string, db: Db = this.pool): Promise<void> {
    await db.query(`UPDATE ai_route_revision SET status = CASE WHEN status = 'DRAFT' THEN 'TESTED' ELSE status END, tested_eval_run_id = $2 WHERE route_id = $1`, [routeId, runId]);
  }

  async approve(routeId: string, actor: string): Promise<RouteRow> {
    const res = await this.pool.query<RouteRow>(
      `UPDATE ai_route_revision SET status = 'APPROVED', approved_by = $2, approved_at = now()
        WHERE route_id = $1 AND status = 'TESTED' RETURNING *`, [routeId, actor]);
    if (!res.rows[0]) throw new AppError(409, 'validation_error', 'Solo una ruta con evaluación aprobada (TESTED) puede aprobarse.');
    return res.rows[0];
  }

  async retire(routeId: string): Promise<RouteRow> {
    const res = await this.pool.query<RouteRow>(
      `UPDATE ai_route_revision SET status = 'RETIRED' WHERE route_id = $1 AND status IN ('DRAFT','TESTED','APPROVED') RETURNING *`, [routeId]);
    if (!res.rows[0]) throw new AppError(409, 'validation_error', 'Una ruta activa o en canary no se retira; primero reemplázala.');
    return res.rows[0];
  }

  // ---------------------------------------------------------------- rollout

  private async lockRollout(client: PoolClient, useCaseId: string, environment: string): Promise<RolloutRow | null> {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ai_rollout:${useCaseId}:${environment}`]);
    return (await client.query<RolloutRow>('SELECT * FROM ai_rollout WHERE use_case_id = $1 AND environment = $2 FOR UPDATE', [useCaseId, environment])).rows[0] ?? null;
  }

  private async event(client: PoolClient, e: { useCaseId: string; environment: string; action: string; from: string | null; to: string | null; percent: number | null; version: number; actor: string; reason: string }): Promise<void> {
    await client.query(
      `INSERT INTO ai_rollout_event (event_id, use_case_id, environment, action, from_route_id, to_route_id, canary_percent, rollout_version, actor_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [`rev_${randomUUID()}`, e.useCaseId, e.environment, e.action, e.from, e.to, e.percent, e.version, e.actor, e.reason]);
  }

  private async requireDeployable(client: PoolClient, routeId: string, useCaseId: string): Promise<RouteRow> {
    const r = await this.route(routeId, client);
    if (!r || r.use_case_id !== useCaseId) throw new AppError(404, 'not_found', 'No existe esa ruta para el caso de uso.');
    if (!['APPROVED', 'CANARY', 'ACTIVE'].includes(r.status)) {
      throw new AppError(409, 'validation_error', 'Solo una ruta evaluada y aprobada puede desplegarse.');
    }
    return r;
  }

  /** Activa una ruta al 100 %. La activa anterior vuelve a APPROVED (destino de rollback). */
  async activate(useCaseId: string, environment: string, routeId: string, actor: string, reason: string, action: 'activate' | 'promote' | 'rollback' | 'seed' = 'activate'): Promise<RolloutRow> {
    return runAtomic(this.pool, async (client) => {
      const current = await this.lockRollout(client, useCaseId, environment);
      if (action !== 'seed') await this.requireDeployable(client, routeId, useCaseId);
      if (current?.active_route_id === routeId && !current.canary_route_id) throw new AppError(409, 'validation_error', 'Esa ruta ya está activa.');
      const version = Number(current?.version ?? 0) + 1;
      if (current?.active_route_id && current.active_route_id !== routeId) {
        await client.query(`UPDATE ai_route_revision SET status = 'APPROVED' WHERE route_id = $1 AND status = 'ACTIVE'`, [current.active_route_id]);
      }
      if (current?.canary_route_id && current.canary_route_id !== routeId) {
        await client.query(`UPDATE ai_route_revision SET status = 'APPROVED' WHERE route_id = $1 AND status = 'CANARY'`, [current.canary_route_id]);
      }
      await client.query(`UPDATE ai_route_revision SET status = 'ACTIVE' WHERE route_id = $1`, [routeId]);
      const row = (await client.query<RolloutRow>(
        `INSERT INTO ai_rollout (use_case_id, environment, active_route_id, canary_route_id, canary_percent, version, updated_by, updated_at)
         VALUES ($1,$2,$3,NULL,0,$4,$5,now())
         ON CONFLICT (use_case_id, environment) DO UPDATE SET active_route_id = EXCLUDED.active_route_id, canary_route_id = NULL,
           canary_percent = 0, version = EXCLUDED.version, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`, [useCaseId, environment, routeId, version, actor])).rows[0] as RolloutRow;
      await this.event(client, { useCaseId, environment, action, from: current?.active_route_id ?? null, to: routeId, percent: 100, version, actor, reason });
      return row;
    });
  }

  async setCanary(useCaseId: string, environment: string, routeId: string, percent: number, actor: string, reason: string): Promise<RolloutRow> {
    if (!Number.isInteger(percent) || percent < 1 || percent > 99) throw new AppError(400, 'validation_error', 'El canary va de 1 % a 99 %.');
    return runAtomic(this.pool, async (client) => {
      const current = await this.lockRollout(client, useCaseId, environment);
      if (!current?.active_route_id) throw new AppError(409, 'validation_error', 'Primero activa una ruta; el canary se compara con ella.');
      if (current.active_route_id === routeId) throw new AppError(409, 'validation_error', 'La ruta activa no puede ser su propio canary.');
      await this.requireDeployable(client, routeId, useCaseId);
      if (current.canary_route_id && current.canary_route_id !== routeId) {
        await client.query(`UPDATE ai_route_revision SET status = 'APPROVED' WHERE route_id = $1 AND status = 'CANARY'`, [current.canary_route_id]);
      }
      await client.query(`UPDATE ai_route_revision SET status = 'CANARY' WHERE route_id = $1`, [routeId]);
      const version = Number(current.version) + 1;
      const row = (await client.query<RolloutRow>(
        `UPDATE ai_rollout SET canary_route_id = $3, canary_percent = $4, version = $5, updated_by = $6, updated_at = now()
          WHERE use_case_id = $1 AND environment = $2 RETURNING *`, [useCaseId, environment, routeId, percent, version, actor])).rows[0] as RolloutRow;
      await this.event(client, { useCaseId, environment, action: 'canary', from: current.active_route_id, to: routeId, percent, version, actor, reason });
      return row;
    });
  }

  async promoteCanary(useCaseId: string, environment: string, actor: string, reason: string): Promise<RolloutRow> {
    const current = await this.rollout(useCaseId, environment);
    if (!current?.canary_route_id) throw new AppError(409, 'validation_error', 'No hay canary que promover.');
    return this.activate(useCaseId, environment, current.canary_route_id, actor, reason, 'promote');
  }

  async clearCanary(useCaseId: string, environment: string, actor: string, reason: string): Promise<RolloutRow> {
    return runAtomic(this.pool, async (client) => {
      const current = await this.lockRollout(client, useCaseId, environment);
      if (!current?.canary_route_id) throw new AppError(409, 'validation_error', 'No hay canary activo.');
      await client.query(`UPDATE ai_route_revision SET status = 'APPROVED' WHERE route_id = $1 AND status = 'CANARY'`, [current.canary_route_id]);
      const version = Number(current.version) + 1;
      const row = (await client.query<RolloutRow>(
        `UPDATE ai_rollout SET canary_route_id = NULL, canary_percent = 0, version = $3, updated_by = $4, updated_at = now()
          WHERE use_case_id = $1 AND environment = $2 RETURNING *`, [useCaseId, environment, version, actor])).rows[0] as RolloutRow;
      await this.event(client, { useCaseId, environment, action: 'clear_canary', from: current.canary_route_id, to: null, percent: 0, version, actor, reason });
      return row;
    });
  }

  /** Vuelve a la ruta activa anterior del historial (si sigue desplegable). Sin redeploy. */
  async rollback(useCaseId: string, environment: string, actor: string, reason: string): Promise<RolloutRow> {
    const current = await this.rollout(useCaseId, environment);
    if (!current?.active_route_id) throw new AppError(409, 'validation_error', 'No hay ruta activa.');
    const prev = await this.pool.query<{ route_id: string }>(
      `SELECT to_route_id AS route_id FROM ai_rollout_event
        WHERE use_case_id = $1 AND environment = $2 AND action IN ('activate','promote','rollback','seed') AND to_route_id IS NOT NULL AND to_route_id <> $3
        ORDER BY rollout_version DESC LIMIT 1`, [useCaseId, environment, current.active_route_id]);
    const target = prev.rows[0]?.route_id;
    if (!target) throw new AppError(409, 'validation_error', 'No hay una ruta anterior a la que volver.');
    return this.activate(useCaseId, environment, target, actor, reason, 'rollback');
  }

  /** Ruta que atiende una nueva ejecución (activa o canary por hash estable). */
  async resolve(useCaseId: string, environment: string, assignmentKey: string): Promise<{ routeId: string; assignment: 'active' | 'canary'; rolloutVersion: number } | null> {
    const r = await this.rollout(useCaseId, environment);
    if (!r?.active_route_id) return null;
    if (r.canary_route_id && r.canary_percent > 0 && canaryBucket(useCaseId, assignmentKey) < r.canary_percent) {
      return { routeId: r.canary_route_id, assignment: 'canary', rolloutVersion: Number(r.version) };
    }
    return { routeId: r.active_route_id, assignment: 'active', rolloutVersion: Number(r.version) };
  }
}
