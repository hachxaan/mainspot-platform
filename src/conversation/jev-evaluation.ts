/**
 * D4 (DEC-0031, DEC-0033): evaluación de Jev sobre conjuntos sintéticos etiquetados,
 * sin datos de clientes (`JEV_EVAL_SETS`: `dev` para iterar criterios, `gate` el
 * conjunto reservado que abre primary). Mide el intent elegido por Jev frente a la
 * etiqueta y, para cada caso, el resultado final del sistema en primary: reglas
 * deterministas + respuesta de Jev + política D1–D3 (`decidePrimary`). Un caso con
 * clase esperada prohibited o human_approval_required es un fallo de riesgo si ese
 * resultado final no lo contiene (`isContained`). La cifra de Jev solo (definición
 * anterior) se calcula como información. El gate se recalcula con `evaluationPasses`.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { JevClient } from '../jev/client.ts';
import { classifyIntent } from './classifier.ts';
import type { ActionClass, CapabilityTarget, ClassificationResult } from './intents.ts';
import {
  CAPABILITY_TARGETS,
  INTENT_ACTION_CLASS,
  JEV_INTENTS,
  JEV_MIN_PROBABILITY,
  JEV_QUESTIONS,
  JEV_RISK_DEFINITION,
  RISKY_CLASSES,
  decidePrimary,
  evaluationPasses,
  jevErrorCode,
  readJevAnswers,
  type JevBudget,
  type JevIntent,
  type JevIntentOption,
  type JevReading,
} from './jev-classifier.ts';
import type { JevDecisionReason, JevDecisionSource } from './jev-repository.ts';

/** Llamadas simultáneas durante la evaluación. */
export const JEV_EVAL_CONCURRENCY = 4;

export interface JevEvalCase {
  id: string;
  text: string;
  intent: JevIntent;
  capability_target: CapabilityTarget;
  tags: string[];
}

export interface JevEvalSet {
  version: string;
  sha256: string;
  cases: JevEvalCase[];
}

/** Carga y valida el conjunto; cualquier desviación del esquema aborta. */
export async function loadJevEvalSet(url: URL): Promise<JevEvalSet> {
  const bytes = await readFile(url);
  const doc = JSON.parse(bytes.toString('utf8')) as {
    schema?: unknown; version?: unknown; synthetic?: unknown; cases?: unknown;
  };
  if (doc.schema !== 'mainspot-jev-intent-eval/v1' || doc.synthetic !== true || !Array.isArray(doc.cases)) {
    throw new Error('Jev evaluation set must be mainspot-jev-intent-eval/v1, synthetic, with a cases array');
  }
  const ids = new Set<string>();
  const cases = doc.cases.map((raw: unknown, index: number): JevEvalCase => {
    const c = raw as Partial<JevEvalCase>;
    const valid = typeof c.id === 'string' && typeof c.text === 'string' && c.text.trim() !== ''
      && (JEV_INTENTS as string[]).includes(c.intent as string)
      && CAPABILITY_TARGETS.includes(c.capability_target as CapabilityTarget)
      && Array.isArray(c.tags) && !ids.has(c.id);
    if (!valid) throw new Error(`Invalid Jev evaluation case at index ${index}`);
    ids.add(c.id as string);
    return c as JevEvalCase;
  });
  return { version: `v${String(doc.version)}`, sha256: createHash('sha256').update(bytes).digest('hex'), cases };
}

export interface JevCaseResult {
  id: string;
  expectedIntent: JevIntent;
  expectedClass: ActionClass;
  expectedTarget: CapabilityTarget;
  status: 'evaluated' | 'unavailable';
  intent: JevIntentOption | null;
  intentProbability: number | null;
  actionClass: ActionClass | null;
  capabilityTarget: CapabilityTarget | null;
  correct: boolean;
  capabilityCorrect: boolean;
  /** Reglas deterministas sobre el mismo texto. */
  rulesIntent: string;
  rulesClass: ActionClass;
  /** Resultado final en primary (D1–D3) y su origen. */
  finalIntent: string;
  finalClass: ActionClass;
  decisionSource: JevDecisionSource;
  decisionReason: JevDecisionReason;
  /** Gate (DEC-0033): caso de riesgo que el resultado final no contiene. */
  riskyMiss: boolean;
  /** Información: caso de riesgo que Jev por sí solo no pone en su clase (o sin respuesta). */
  jevRiskyMiss: boolean;
  errorCode: string | null;
  resolvedModel: string | null;
  costUsd: number | null;
}

/**
 * DEC-0033: un resultado final contiene un caso de riesgo si lo bloquea, lo escala a una
 * persona o pide aclaración. Cualquier otro (respuesta automática, borrador o propuesta
 * con vista previa) es una acción automática.
 */
export function isContained(final: ClassificationResult): boolean {
  return final.actionClass === 'prohibited' || final.actionClass === 'human_approval_required'
    || final.intent === 'request.needs_clarification';
}

/** Evalúa cada caso con concurrencia acotada; el presupuesto D5 se respeta por llamada. */
export async function runJevEvaluation(opts: {
  client: JevClient;
  cases: readonly JevEvalCase[];
  budget: JevBudget;
  concurrency?: number;
}): Promise<JevCaseResult[]> {
  const results: JevCaseResult[] = new Array(opts.cases.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < opts.cases.length) {
      const index = next++;
      const c = opts.cases[index] as JevEvalCase;
      const expectedClass = INTENT_ACTION_CLASS[c.intent];
      const risky = Boolean(RISKY_CLASSES[expectedClass]);
      const rules = classifyIntent(c.text);
      const base = { id: c.id, expectedIntent: c.intent, expectedClass, expectedTarget: c.capability_target };
      // Lo que haría primary con esta lectura (null = Jev no disponible ⇒ D2).
      const decide = (reading: JevReading | null) => {
        const outcome = decidePrimary(reading, rules);
        return {
          rulesIntent: rules.intent, rulesClass: rules.actionClass,
          finalIntent: outcome.classification.intent, finalClass: outcome.classification.actionClass,
          decisionSource: outcome.source, decisionReason: outcome.reason,
          riskyMiss: risky && !isContained(outcome.classification),
        };
      };
      const unavailable = (errorCode: string): JevCaseResult => ({
        ...base, status: 'unavailable', intent: null, intentProbability: null, actionClass: null, capabilityTarget: null,
        correct: false, capabilityCorrect: false, ...decide(null), jevRiskyMiss: risky, errorCode,
        resolvedModel: null, costUsd: null,
      });
      try {
        if (!(await opts.budget.allows())) {
          results[index] = unavailable('budget_exhausted');
          continue;
        }
        const result = await opts.client.systemOne({ message: c.text }, JEV_QUESTIONS);
        opts.budget.record(result.meta.cost.amount);
        const reading = readJevAnswers(result.answers);
        results[index] = {
          ...base,
          status: 'evaluated',
          intent: reading.intent,
          intentProbability: reading.intentProbability,
          actionClass: reading.actionClass,
          capabilityTarget: reading.capabilityTarget,
          correct: reading.intent === c.intent,
          capabilityCorrect: reading.capabilityTarget === c.capability_target,
          ...decide(reading),
          jevRiskyMiss: risky && reading.actionClass !== expectedClass,
          errorCode: null,
          resolvedModel: result.meta.resolvedModel,
          costUsd: result.meta.cost.amount,
        };
      } catch (err) {
        results[index] = unavailable(jevErrorCode(err));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? JEV_EVAL_CONCURRENCY) }, worker));
  return results;
}

export interface JevEvaluationSummary {
  riskDefinition: typeof JEV_RISK_DEFINITION;
  casesTotal: number;
  casesEvaluated: number;
  intentCorrect: number;
  riskyCases: number;
  /** Fallos de riesgo del resultado final: el gate exige 0 (DEC-0033). */
  riskyMisses: number;
  /** Información: fallos de riesgo de Jev por sí solo (definición anterior). */
  jevRiskyMisses: number;
  capabilityCorrect: number;
  costUsd: number;
  resolvedModels: string[];
  /** Umbrales D4 recalculados como lo hará el gate. */
  passed: boolean;
  perIntent: Record<string, { total: number; correct: number }>;
  /** expected intent → Jev intent (o `unavailable`) → casos. */
  confusion: Record<string, Record<string, number>>;
  /** `origen/motivo` de la decisión final → casos (p. ej. la carga de escalados de D1). */
  decisionRoutes: Record<string, number>;
  /** Cobertura y acierto por encima del umbral D3, para recalibrarlo. */
  aboveThreshold: { threshold: number; cases: number; correct: number };
}

export function summarizeJevEvaluation(results: readonly JevCaseResult[], provider: 'typesafe' | 'mock'): JevEvaluationSummary {
  const perIntent: Record<string, { total: number; correct: number }> = {};
  const confusion: Record<string, Record<string, number>> = {};
  const decisionRoutes: Record<string, number> = {};
  const models = new Set<string>();
  let costUsd = 0;
  let above = 0;
  let aboveCorrect = 0;
  for (const r of results) {
    const bucket = (perIntent[r.expectedIntent] ??= { total: 0, correct: 0 });
    bucket.total += 1;
    if (r.correct) bucket.correct += 1;
    const row = (confusion[r.expectedIntent] ??= {});
    const got = r.intent ?? 'unavailable';
    row[got] = (row[got] ?? 0) + 1;
    const route = `${r.decisionSource}/${r.decisionReason}`;
    decisionRoutes[route] = (decisionRoutes[route] ?? 0) + 1;
    if (r.resolvedModel) models.add(r.resolvedModel);
    if (r.costUsd !== null) costUsd += r.costUsd;
    if (r.intent !== null && r.intent !== 'other' && (r.intentProbability ?? 0) >= JEV_MIN_PROBABILITY) {
      above += 1;
      if (r.correct) aboveCorrect += 1;
    }
  }
  const summary: Omit<JevEvaluationSummary, 'passed'> = {
    riskDefinition: JEV_RISK_DEFINITION,
    casesTotal: results.length,
    casesEvaluated: results.filter((r) => r.status === 'evaluated').length,
    intentCorrect: results.filter((r) => r.correct).length,
    riskyCases: results.filter((r) => RISKY_CLASSES[r.expectedClass]).length,
    riskyMisses: results.filter((r) => r.riskyMiss).length,
    jevRiskyMisses: results.filter((r) => r.jevRiskyMiss).length,
    capabilityCorrect: results.filter((r) => r.capabilityCorrect).length,
    costUsd,
    resolvedModels: [...models].sort(),
    perIntent,
    confusion,
    decisionRoutes,
    aboveThreshold: { threshold: JEV_MIN_PROBABILITY, cases: above, correct: aboveCorrect },
  };
  return {
    ...summary,
    passed: evaluationPasses({
      provider, risk_definition: summary.riskDefinition, cases_total: summary.casesTotal,
      intent_correct: summary.intentCorrect, risky_misses: summary.riskyMisses,
    }),
  };
}
