/**
 * Ejecuta suites de evaluación del AI Core contra rutas exactas (FR-0019, G1).
 *
 *   node scripts/ai-eval.ts [--use-case <id>|all] [--status DRAFT|TESTED|APPROVED|ACTIVE|all] [--route <route_id>] [--out evidence/ai-core/evals.json]
 *
 * Proveedores reales solo con AI_REAL_PROVIDERS=on y su secreto en el entorno; corpus 100 % sintético
 * (BR-0007). El costo se reserva y descuenta del techo de laboratorio (USD 25). Nunca activa rutas:
 * una evaluación aprobada solo deja la ruta en TESTED.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { loadConfigTool } from '../src/shared/config.ts';
import { AiDispatcher } from '../src/ai/dispatcher.ts';
import { runEvalSuite } from '../src/ai/evals.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const config = loadConfigTool();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4 });
  const dispatcher = new AiDispatcher({ pool, config });
  const useCase = arg('use-case') ?? 'all';
  const status = arg('status') ?? 'DRAFT';
  const only = arg('route');
  const out = arg('out');
  try {
    const routes = await pool.query<{ route_id: string; use_case_id: string; model_id: string; version: number; status: string; provider_kind: string }>(
      `SELECT r.route_id, r.use_case_id, r.model_id, r.version, r.status, p.kind AS provider_kind
         FROM ai_route_revision r JOIN ai_model m ON m.model_id = r.model_id JOIN ai_provider p ON p.provider_id = m.provider_id
        WHERE p.kind <> 'simulated' AND ($1 = 'all' OR r.use_case_id = $1) AND ($2 = 'all' OR r.status = $2) AND ($3::text IS NULL OR r.route_id = $3)
        ORDER BY r.use_case_id, r.version`, [useCase, status, only ?? null]);
    const report: Array<Record<string, unknown>> = [];
    for (const r of routes.rows) {
      const suites = await pool.query<{ suite_id: string; name: string; version: number }>('SELECT suite_id, name, version FROM ai_eval_suite WHERE use_case_id = $1 ORDER BY version DESC', [r.use_case_id]);
      for (const s of suites.rows) {
        const started = Date.now();
        const res = await runEvalSuite(pool, dispatcher, s.suite_id, r.route_id, 'operator:sol-main-lab');
        const row = { use_case: r.use_case_id, model: r.model_id, route_id: r.route_id, route_version: r.version, suite: `${s.name}@v${s.version}`, run_id: res.run_id, status: res.status, ...res.metrics, wall_ms: Date.now() - started, failures: res.results.filter((x) => !x.pass).map((x) => ({ case: x.case_id, notes: x.notes })) };
        report.push(row);
        const m = res.metrics;
        console.log(JSON.stringify({ use_case: row.use_case, model: row.model, status: row.status, pass_rate: m['pass_rate'], p50: m['latency_p50_ms'], p95: m['latency_p95_ms'], cost_usd: m['cost_usd'], ...(m['sentiment_accuracy'] !== undefined ? { sentiment: m['sentiment_accuracy'], risk_misses: m['risk_misses'] } : {}), failures: row.failures }));
      }
    }
    const spent = await pool.query<{ spent: string }>(`SELECT COALESCE(SUM(COALESCE(i.cost_usd, i.reserved_usd)),0) AS spent FROM ai_invocation i JOIN ai_provider p ON p.provider_id = i.provider_id WHERE p.kind = 'openrouter'`);
    console.log(JSON.stringify({ openrouter_spent_total_usd: Number(spent.rows[0]?.spent ?? 0) }));
    if (out) {
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify({ generated_at: new Date().toISOString(), environment: config.aiEnvironment, real_providers: config.aiRealProviders, report }, null, 2)}\n`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
