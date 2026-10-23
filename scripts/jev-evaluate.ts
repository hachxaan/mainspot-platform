/**
 * D4 (DEC-0031, DEC-0033, DEC-0034): evaluación de Jev sobre un conjunto sintético etiquetado.
 *   npm run jev:evaluate                  → conjunto reservado (`gate`, v3) con TypeSafe real;
 *                                           guarda la ejecución en jev_evaluation_run, ligada a los
 *                                           bytes del conjunto y del código que decide. Si supera los
 *                                           umbrales, primary se abre solo (gate D4).
 *   npm run jev:evaluate -- --set=dev     → conjunto de desarrollo (v1) para iterar criterios;
 *                                           se guarda igual pero nunca abre el gate.
 *   npm run jev:evaluate -- --mock        → proveedor simulado, sin red y sin guardar nada:
 *                                           prueba el cableado, nunca la calidad del modelo.
 * Un fallo de riesgo es un caso prohibited/human_approval_required cuyo resultado final con
 * D1–D3 no lo contiene (DEC-0033); la cifra de Jev solo se guarda como información.
 * Requiere JEV_MODE=shadow|primary, JEV_PROVIDER=typesafe y TYPESAFE_API_KEY para la
 * ejecución real; respeta el presupuesto diario (DEC-0032). Solo envía los textos
 * sintéticos del conjunto (DEC-0019). Nunca imprime ni guarda la clave.
 */

import pg from 'pg';
import { JevClient } from '../src/jev/client.ts';
import {
  JevBudget, JEV_EVAL_SETS, JEV_POLICY_VERSION, createJevClient, decisionCodeSha256, utcDay,
} from '../src/conversation/jev-classifier.ts';
import { loadJevEvalSet, runJevEvaluation, summarizeJevEvaluation } from '../src/conversation/jev-evaluation.ts';
import { JevRepository } from '../src/conversation/jev-repository.ts';
import { loadConfigTool } from '../src/shared/config.ts';
import { withRequestContext } from '../src/shared/context.ts';
import { log } from '../src/shared/logger.ts';

const { Pool } = pg;

async function main(): Promise<void> {
  await withRequestContext(async () => {
    const cfg = loadConfigTool();
    const mock = process.argv.includes('--mock');
    const setArg = process.argv.find((arg) => arg.startsWith('--set='))?.slice('--set='.length) ?? 'gate';
    if (setArg !== 'gate' && setArg !== 'dev') throw new Error(`Unknown --set=${setArg}; use gate or dev.`);
    const set = await loadJevEvalSet(JEV_EVAL_SETS[setArg]);
    const startedAt = new Date();

    if (mock) {
      const client = new JevClient({ provider: 'mock' });
      const budget = new JevBudget({ spentOn: async () => 0 }, Number.POSITIVE_INFINITY);
      const summary = summarizeJevEvaluation(await runJevEvaluation({ client, cases: set.cases, budget }), 'mock');
      process.stdout.write(`${JSON.stringify({ provider: 'mock', persisted: false, dataset_sha256: set.sha256, ...summary }, null, 2)}\n`);
      return;
    }

    if (cfg.jev.mode === 'disabled') {
      throw new Error('JEV_MODE must be shadow or primary to evaluate with TypeSafe (JEV_MODE=disabled sends nothing).');
    }
    const client = createJevClient(cfg.jev);
    const pool = new Pool({ connectionString: cfg.databaseUrl, max: 2 });
    try {
      const repo = new JevRepository(pool);
      const budget = new JevBudget(repo, cfg.jev.dailyBudgetUsd);
      const results = await runJevEvaluation({ client, cases: set.cases, budget });
      const summary = summarizeJevEvaluation(results, 'typesafe');
      const code = decisionCodeSha256();
      const run = await repo.createEvaluationRun({
        policyVersion: JEV_POLICY_VERSION,
        provider: 'typesafe',
        requestedModel: client.defaultModel,
        resolvedModels: summary.resolvedModels,
        datasetVersion: set.version,
        datasetSha256: set.sha256,
        riskDefinition: summary.riskDefinition,
        decisionCodeSha256: code,
        casesTotal: summary.casesTotal,
        casesEvaluated: summary.casesEvaluated,
        intentCorrect: summary.intentCorrect,
        riskyCases: summary.riskyCases,
        riskyMisses: summary.riskyMisses,
        jevRiskyMisses: summary.jevRiskyMisses,
        capabilityCorrect: summary.capabilityCorrect,
        minProbability: summary.aboveThreshold.threshold,
        passed: summary.passed,
        costUsd: summary.costUsd,
        budgetDay: utcDay(startedAt),
        report: {
          per_intent: summary.perIntent,
          confusion: summary.confusion,
          decision_routes: summary.decisionRoutes,
          above_threshold: summary.aboveThreshold,
          cases: results,
        },
        startedAt,
      });
      log.info('jev.evaluation.recorded', 'Jev synthetic evaluation recorded', {
        run_id: run.run_id, passed: run.passed, requested_model: run.requested_model, policy_version: run.policy_version,
      });
      const { perIntent, confusion, ...headline } = summary;
      process.stdout.write(`${JSON.stringify({
        run_id: run.run_id,
        set: setArg,
        opens_gate: setArg === 'gate' && summary.passed,
        policy_version: JEV_POLICY_VERSION,
        requested_model: client.defaultModel,
        dataset_version: set.version,
        dataset_sha256: set.sha256,
        decision_code_sha256: code,
        ...headline,
        per_intent: perIntent,
        confusion,
        spent_today_usd: budget.spentUsd,
      }, null, 2)}\n`);
    } finally {
      await pool.end();
    }
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
