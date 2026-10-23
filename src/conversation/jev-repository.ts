/**
 * Persistencia de Jev (APR-0002): una fila de `jev_classification` por solicitud
 * clasificada con Jev (tenant-scoped), las ejecuciones de evaluación sintética
 * (`jev_evaluation_run`, gate D4) y el gasto diario (D5). Nunca guarda
 * cabeceras ni la credencial.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ActionClass, CapabilityTarget } from './intents.ts';

export type JevDecisionSource = 'deterministic' | 'jev' | 'deterministic_fallback' | 'human_escalation';
export type JevDecisionReason =
  | 'shadow'
  | 'primary_gated'
  | 'jev_confident'
  | 'low_confidence'
  | 'other_intent'
  | 'safety_discrepancy'
  | 'jev_unavailable'
  | 'model_not_evaluated';
export type JevCostSource = 'reported' | 'estimated' | 'unknown' | 'mock';

export interface JevClassificationInsert {
  tenantId: string;
  requestId: string;
  policyVersion: string;
  mode: 'shadow' | 'primary';
  decisionSource: JevDecisionSource;
  decisionReason: JevDecisionReason;
  deterministicIntent: string;
  deterministicActionClass: ActionClass;
  finalIntent: string;
  finalActionClass: ActionClass;
  status: 'evaluated' | 'unavailable';
  jevIntent: string | null;
  jevIntentProbability: number | null;
  jevIntentConfidence: number | null;
  jevIntentProbabilities: Record<string, number> | null;
  jevActionClass: ActionClass | null;
  jevCapabilityTarget: CapabilityTarget | null;
  jevCapabilityConfidence: number | null;
  jevCapabilityProbabilities: Record<string, number> | null;
  agreement: boolean | null;
  provider: 'typesafe';
  requestedModel: string;
  resolvedModel: string | null;
  usage: Record<string, unknown> | null;
  costUsd: number | null;
  costSource: JevCostSource | null;
  budgetDay: string;
  latencyMs: number;
  errorCode: string | null;
  rawRequest: string | null;
  rawResponse: string | null;
}

export interface JevClassificationRow {
  classification_id: string;
  tenant_id: string;
  request_id: string;
  policy_version: string;
  mode: 'shadow' | 'primary';
  decision_source: JevDecisionSource;
  decision_reason: JevDecisionReason;
  deterministic_intent: string;
  deterministic_action_class: ActionClass;
  final_intent: string;
  final_action_class: ActionClass;
  status: 'evaluated' | 'unavailable';
  jev_intent: string | null;
  jev_intent_probability: number | null;
  jev_intent_confidence: number | null;
  jev_intent_probabilities: Record<string, number> | null;
  jev_action_class: ActionClass | null;
  jev_capability_target: CapabilityTarget | null;
  jev_capability_confidence: number | null;
  jev_capability_probabilities: Record<string, number> | null;
  agreement: boolean | null;
  provider: 'typesafe';
  requested_model: string;
  resolved_model: string | null;
  usage: Record<string, unknown> | null;
  cost_usd: string | null;
  cost_source: JevCostSource | null;
  budget_day: string;
  latency_ms: number;
  error_code: string | null;
  raw_request: string | null;
  raw_response: string | null;
  created_at: string;
}

export interface JevEvaluationRunInsert {
  policyVersion: string;
  provider: 'typesafe';
  requestedModel: string;
  resolvedModels: string[];
  datasetVersion: string;
  datasetSha256: string;
  /** DEC-0033: definición de fallo de riesgo con la que se calculó `riskyMisses`. */
  riskDefinition: 'final_outcome';
  /** sha256 del código que decide (reglas + política) evaluado. */
  decisionCodeSha256: string;
  casesTotal: number;
  casesEvaluated: number;
  intentCorrect: number;
  riskyCases: number;
  /** Fallos de riesgo del resultado final (gate). */
  riskyMisses: number;
  /** Fallos de riesgo de Jev por sí solo (solo información). */
  jevRiskyMisses: number;
  capabilityCorrect: number;
  minProbability: number;
  passed: boolean;
  costUsd: number;
  budgetDay: string;
  report: Record<string, unknown>;
  startedAt: Date;
}

export interface JevEvaluationRunRow {
  run_id: string;
  policy_version: string;
  provider: 'typesafe';
  requested_model: string;
  resolved_models: string[];
  dataset_version: string;
  dataset_sha256: string;
  /** `jev_only`: ejecuciones anteriores a DEC-0033 (nunca abren primary). */
  risk_definition: 'jev_only' | 'final_outcome';
  decision_code_sha256: string | null;
  cases_total: number;
  cases_evaluated: number;
  intent_correct: number;
  risky_cases: number;
  risky_misses: number;
  jev_risky_misses: number | null;
  capability_correct: number;
  min_probability: number;
  passed: boolean;
  cost_usd: string;
  budget_day: string;
  report: Record<string, unknown>;
  started_at: string;
  finished_at: string;
}

/** Bytes exactos a los que se liga una evaluación que abre primary (D4, DEC-0033). */
export interface JevGateBinding {
  datasetSha256: string;
  decisionCodeSha256: string;
}

/** Consultas que necesitan el gate (D4) y el presupuesto (D5). */
export interface JevLedgerStore {
  /** USD gastados en el día UTC `day` (YYYY-MM-DD): clasificaciones + evaluaciones. */
  spentOn(day: string): Promise<number>;
  /**
   * Última evaluación para la política y los bytes ligados cuyo modelo es `model`: pedida
   * con ese mismo nombre, o pedida con un alias y respondida entera por esa versión fijada
   * (`resolved_models` = [model]). Así JEV_MODEL puede fijar la versión evaluada sin repetir
   * la evaluación; una respuesta de otra versión sigue cerrando primary (D2, model_not_evaluated).
   */
  latestEvaluation(policyVersion: string, model: string, binding: JevGateBinding): Promise<JevEvaluationRunRow | null>;
}

export interface JevClassificationStore extends JevLedgerStore {
  createClassification(input: JevClassificationInsert): Promise<JevClassificationRow>;
}

export class JevRepository implements JevClassificationStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** La FK (request_id, tenant_id) exige que la solicitud exista en el mismo tenant. */
  async createClassification(input: JevClassificationInsert): Promise<JevClassificationRow> {
    if (!input.tenantId) throw new Error('FAIL-CLOSED: jev_classification requires a tenant context');
    const json = (value: unknown) => (value === null ? null : JSON.stringify(value));
    const res = await this.pool.query<JevClassificationRow>(
      `INSERT INTO jev_classification
        (classification_id, tenant_id, request_id, policy_version, mode, decision_source, decision_reason,
         deterministic_intent, deterministic_action_class, final_intent, final_action_class, status,
         jev_intent, jev_intent_probability, jev_intent_confidence, jev_intent_probabilities, jev_action_class,
         jev_capability_target, jev_capability_confidence, jev_capability_probabilities, agreement,
         provider, requested_model, resolved_model, usage, cost_usd, cost_source, budget_day, latency_ms,
         error_code, raw_request, raw_response)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
       RETURNING *`,
      [`jcl_${randomUUID()}`, input.tenantId, input.requestId, input.policyVersion, input.mode, input.decisionSource,
        input.decisionReason, input.deterministicIntent, input.deterministicActionClass, input.finalIntent,
        input.finalActionClass, input.status, input.jevIntent, input.jevIntentProbability, input.jevIntentConfidence,
        json(input.jevIntentProbabilities), input.jevActionClass, input.jevCapabilityTarget, input.jevCapabilityConfidence,
        json(input.jevCapabilityProbabilities), input.agreement, input.provider, input.requestedModel, input.resolvedModel,
        json(input.usage), input.costUsd, input.costSource, input.budgetDay, input.latencyMs, input.errorCode,
        input.rawRequest, input.rawResponse],
    );
    return res.rows[0] as JevClassificationRow;
  }

  async createEvaluationRun(input: JevEvaluationRunInsert): Promise<JevEvaluationRunRow> {
    const res = await this.pool.query<JevEvaluationRunRow>(
      `INSERT INTO jev_evaluation_run
        (run_id, policy_version, provider, requested_model, resolved_models, dataset_version, dataset_sha256,
         risk_definition, decision_code_sha256, cases_total, cases_evaluated, intent_correct, risky_cases,
         risky_misses, jev_risky_misses, capability_correct, min_probability, passed, cost_usd, budget_day, report,
         started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [`jer_${randomUUID()}`, input.policyVersion, input.provider, input.requestedModel, JSON.stringify(input.resolvedModels),
        input.datasetVersion, input.datasetSha256, input.riskDefinition, input.decisionCodeSha256, input.casesTotal,
        input.casesEvaluated, input.intentCorrect, input.riskyCases, input.riskyMisses, input.jevRiskyMisses,
        input.capabilityCorrect, input.minProbability, input.passed, input.costUsd, input.budgetDay,
        JSON.stringify(input.report), input.startedAt],
    );
    return res.rows[0] as JevEvaluationRunRow;
  }

  async spentOn(day: string): Promise<number> {
    const res = await this.pool.query<{ spent: string }>(
      `SELECT (COALESCE((SELECT SUM(cost_usd) FROM jev_classification WHERE budget_day = $1), 0)
             + COALESCE((SELECT SUM(cost_usd) FROM jev_evaluation_run WHERE budget_day = $1), 0))::text AS spent`,
      [day],
    );
    return Number(res.rows[0]?.spent ?? 0);
  }

  async latestEvaluation(policyVersion: string, model: string, binding: JevGateBinding): Promise<JevEvaluationRunRow | null> {
    const res = await this.pool.query<JevEvaluationRunRow>(
      `SELECT * FROM jev_evaluation_run
       WHERE policy_version = $1 AND dataset_sha256 = $3 AND decision_code_sha256 = $4
         AND (requested_model = $2 OR resolved_models = jsonb_build_array($2::text))
       ORDER BY finished_at DESC, run_id DESC LIMIT 1`,
      [policyVersion, model, binding.datasetSha256, binding.decisionCodeSha256],
    );
    return res.rows[0] ?? null;
  }
}
