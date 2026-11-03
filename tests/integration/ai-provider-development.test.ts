/**
 * DEC-0074 — configuración de desarrollo de proveedores: Anthropic directo para texto/razonamiento (Haiku 5.5
 * eficiente, Sonnet 5.5 en tareas complejas), OpenAI directo solo imágenes, TypeSafe sin cambios.
 * SIMULATED_REGRESSION sobre la BD de pruebas (migraciones + semilla de scripts/test-prep.ts): no llama a ningún
 * proveedor ni acredita calidad. Cubre el retiro selectivo de texto OpenAI por la migración 0030
 * sin promoción sustituta y preservando historial, costos, imágenes y clasificación.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { TEST_URL } from '../helpers/testdb.ts';

const pool = new pg.Pool({ connectionString: TEST_URL, max: 2 });
after(async () => { await pool.end(); });

const HAIKU = 'an:claude-haiku-5-5';
const SONNET = 'an:claude-sonnet-5-5';
const OPENAI_TEXT = ['oa:gpt-6-luna', 'oa:gpt-6.1-sol'];


test('DEC-0074 migración 0030: retira solo texto OpenAI de rollouts y revisiones con eventos auditables; Anthropic, imágenes, Jev, historial y costos intactos; idempotente', async () => {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    // Estado previo (tras 0029): Anthropic deshabilitado y texto OpenAI habilitado.
    await client.query(`UPDATE ai_provider SET status = 'disabled' WHERE provider_id = 'anthropic'`);
    await client.query(`UPDATE ai_model SET status = 'active' WHERE model_id = ANY($1)`, [OPENAI_TEXT]);

    const textTemplate = (await client.query<{ route_id: string }>(
      `SELECT route_id FROM ai_route_revision WHERE use_case_id = 'website.initial.design' AND model_id = $1 ORDER BY version DESC LIMIT 1`, [SONNET])).rows[0]!;
    const imageTemplate = (await client.query<{ route_id: string }>(
      `SELECT route_id FROM ai_route_revision WHERE use_case_id = 'website.image.generate' AND model_id = 'oa:gpt-image-2' ORDER BY version DESC LIMIT 1`)).rows[0]!;
    const versions = new Map<string, number>();
    const clone = async (template: string, useCase: string, model: string, status: string) => {
      const version = (versions.get(useCase) ?? Number((await client.query(`SELECT max(version) AS v FROM ai_route_revision WHERE use_case_id = $1`, [useCase])).rows[0].v)) + 1;
      versions.set(useCase, version);
      const id = `rte_${randomUUID()}`;
      await client.query(`INSERT INTO ai_route_revision
        SELECT (jsonb_populate_record(NULL::ai_route_revision, to_jsonb(r) ||
          jsonb_build_object('route_id',$2::text,'version',$3::int,'model_id',$4::text,'status',$5::text,'created_by','test'))).*
        FROM ai_route_revision r WHERE route_id = $1`, [template, id, version, model, status]);
      return id;
    };
    const uc = 'website.initial.design';
    const oaActive = await clone(textTemplate.route_id, uc, 'oa:gpt-6.1-sol', 'ACTIVE');
    const anCanary = await clone(textTemplate.route_id, uc, SONNET, 'CANARY');
    const anActive = await clone(textTemplate.route_id, uc, HAIKU, 'ACTIVE');
    const oaCanary = await clone(textTemplate.route_id, uc, 'oa:gpt-6-luna', 'CANARY');
    const anHistoric = await clone(textTemplate.route_id, uc, HAIKU, 'RETIRED');
    const oaApproved = await clone(textTemplate.route_id, uc, 'oa:gpt-6-luna', 'APPROVED');
    const imgActive = await clone(imageTemplate.route_id, 'website.image.generate', 'oa:gpt-image-2', 'ACTIVE');
    const envA = `migration-${randomUUID()}`;
    const envB = `migration-${randomUUID()}`;
    const envC = `migration-${randomUUID()}`;
    for (const [env, useCase, active, canary, pct] of [[envA, uc, oaActive, anCanary, 20], [envB, uc, anActive, oaCanary, 20], [envC, 'website.image.generate', imgActive, null, 0]] as const) {
      await client.query(`INSERT INTO ai_rollout(use_case_id,environment,active_route_id,canary_route_id,canary_percent,version,updated_by)
        VALUES ($1,$2,$3,$4,$5,10,'test')`, [useCase, env, active, canary, pct]);
    }
    const costsBefore = (await client.query('SELECT sum(cost_usd)::text AS total, count(*)::int AS n FROM ai_invocation')).rows[0];
    const evalsBefore = (await client.query('SELECT count(*)::int AS n FROM ai_eval_run')).rows[0].n;

    const sql = await readFile(new URL('../../migrations/0030_ai_anthropic_development.sql', import.meta.url), 'utf8');
    await client.query(sql);

    const expectRollouts = async () => {
      const rows = (await client.query<{ environment: string; active_route_id: string | null; canary_route_id: string | null; canary_percent: number; version: string }>(
        'SELECT environment,active_route_id,canary_route_id,canary_percent,version FROM ai_rollout WHERE environment = ANY($1)', [[envA, envB, envC]])).rows;
      const a = rows.find((r) => r.environment === envA)!;
      const b = rows.find((r) => r.environment === envB)!;
      const c = rows.find((r) => r.environment === envC)!;
      assert.deepEqual([a.active_route_id, a.canary_route_id, a.canary_percent, Number(a.version)], [null, anCanary, 20, 11], 'texto OpenAI activo sale; canary Anthropic no se promueve');
      assert.deepEqual([b.active_route_id, b.canary_route_id, b.canary_percent, Number(b.version)], [anActive, null, 0, 11], 'canary texto OpenAI sale; Anthropic activo intacto');
      assert.deepEqual([c.active_route_id, c.canary_route_id, c.canary_percent, Number(c.version)], [imgActive, null, 0, 10], 'imagen OpenAI intacta');
      const events = (await client.query<{ action: string; from_route_id: string | null; to_route_id: string | null; actor_id: string; reason: string }>(
        'SELECT action,from_route_id,to_route_id,actor_id,reason FROM ai_rollout_event WHERE environment = ANY($1)', [[envA, envB, envC]])).rows;
      assert.equal(events.length, 2);
      assert.ok(events.every((e) => e.action === 'retire' && e.to_route_id === null && e.actor_id === 'system:migration-0030' && /DEC-0074/.test(e.reason)));
      assert.deepEqual(events.map((e) => e.from_route_id).sort(), [oaActive, oaCanary].sort());
    };
    await expectRollouts();

    const status = Object.fromEntries((await client.query<{ route_id: string; status: string }>('SELECT route_id, status FROM ai_route_revision WHERE route_id = ANY($1)',
      [[oaActive, oaCanary, oaApproved, anActive, anCanary, anHistoric, imgActive]])).rows.map((r) => [r.route_id, r.status]));
    assert.deepEqual([status[oaActive], status[oaCanary], status[oaApproved]], ['RETIRED', 'RETIRED', 'RETIRED'], 'toda ruta de texto OpenAI queda retirada');
    assert.deepEqual([status[anActive], status[anCanary], status[anHistoric], status[imgActive]], ['ACTIVE', 'CANARY', 'RETIRED', 'ACTIVE'], 'Anthropic e imagen intactas; la histórica retirada no se revive');

    const providers = Object.fromEntries((await client.query<{ provider_id: string; status: string }>('SELECT provider_id, status FROM ai_provider')).rows.map((p) => [p.provider_id, p.status]));
    assert.deepEqual([providers['anthropic'], providers['openai'], providers['typesafe']], ['active', 'active', 'active']);
    const models = Object.fromEntries((await client.query<{ model_id: string; status: string }>('SELECT model_id, status FROM ai_model')).rows.map((m) => [m.model_id, m.status]));
    assert.deepEqual([models['oa:gpt-6-luna'], models['oa:gpt-6.1-sol'], models['oa:gpt-image-2'], models[HAIKU], models[SONNET], models['ts:jev-1.14.0']],
      ['disabled', 'disabled', 'active', 'active', 'active', 'active']);

    assert.deepEqual((await client.query('SELECT sum(cost_usd)::text AS total, count(*)::int AS n FROM ai_invocation')).rows[0], costsBefore, 'costos e invocaciones intactos');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM ai_eval_run')).rows[0].n, evalsBefore, 'evaluaciones intactas');

    // Segunda aplicación: no hay nada más que retirar; versiones y eventos no cambian.
    await client.query(sql);
    await expectRollouts();
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

