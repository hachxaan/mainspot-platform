/**
 * E2E INC-004 + INC-005 + INC-006 — recorridos completos con proveedores
 * simulados (DEC-026).
 *
 * 1. Reseña negativa → escalamiento humano → respuesta aprobada publica UNA vez.
 * 2. Creación de post → preview → aprobación → publicado idempotente.
 * 3. Asignación de plan → límite excedido deny (+audit).
 *
 * Escribe evidencia reproducible en evidence/e2e-inc004-006.txt (AC-009):
 * transcript + HEAD. Se ejecuta con `npm run test:e2e`.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { bootApi, login, authHeaders, api, SEED, type TestApi } from '../helpers/testdb.ts';

let t: TestApi;
const transcript: string[] = [];
function say(line: string): void {
  transcript.push(line);
  console.log(line);
}
function resultLine(ok: boolean, label: string): void {
  say(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  assert.equal(ok, true, label);
}

before(async () => {
  t = await bootApi();
});

after(async () => {
  await t.close();
  try {
    mkdirSync('evidence', { recursive: true });
    const head = execSync('git rev-parse HEAD').toString().trim();
    const run = new Date().toISOString();
    const body = `# E2E INC-004 + INC-005 + INC-006 — transcript (run ${run})\n# HEAD: ${head}\n# proveedores: simulated (DEC-026) — sin credenciales reales Meta/Google\n# DB: mainspot_test (recreada por scripts/test-prep.ts)\n\n${transcript.join('\n')}\n\n# Fin de transcript\n`;
    writeFileSync('evidence/e2e-inc004-006.txt', body);
    console.log(`EVIDENCE_SAVED evidence/e2e-inc004-006.txt (HEAD ${head})`);
  } catch (err) {
    console.error('WARN evidence write failed:', (err as Error).message);
  }
});

test('E2E INC-004/005/006: reseña → humanos → publica una vez; post → preview → publicado; plan → límite deny', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  say('=== E2E INC-004 + INC-005 + INC-006 (proveedores simulados) ===');

  // ---------- 1) INC-004: reseña negativa → escalamiento → publicación única ----------
  say('\n-- INC-004: reputación --');
  const sync = await api(t.baseUrl, '/api/backoffice/reputation/reviews/sync', {
    method: 'POST', headers: authHeaders(ops.token),
  });
  resultLine(sync.status === 201 && sync.body.synced === 4, '1. sync de reseñas simulado (4 por tenant)');

  const list = await api(t.baseUrl, '/api/backoffice/reputation/reviews', { headers: authHeaders(ops.token) });
  const negative = list.body.reviews.find((r: { star_rating: number; state: string }) => r.star_rating === 2 && r.state === 'suggested') as { review_id: string };
  resultLine(Boolean(negative), '2. reseña negativa (<4) detectada y sugerida sin publicar');

  const escalated = await api(t.baseUrl, `/api/backoffice/reputation/reviews/${negative.review_id}/escalate`, {
    method: 'POST', headers: authHeaders(ops.token),
  });
  resultLine(escalated.status === 200 && escalated.body.status === 'awaiting_human', '3. escalamiento humano (awaiting_human)');

  const edited = await api(t.baseUrl, `/api/backoffice/reputation/reviews/${negative.review_id}/response`, {
    method: 'POST', headers: authHeaders(ops.token),
    body: JSON.stringify({ text: 'Gracias por tu comentario. Lamento la espera: ya estamos revisando la atención telefónica y te contactaremos.' }),
  });
  resultLine(edited.status === 200 && edited.body.status === 'edited', '4. edición de borrador antes de aprobar');

  const approved = await api(t.baseUrl, `/api/backoffice/reputation/reviews/${negative.review_id}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  resultLine(approved.status === 200 && Boolean(approved.body.proposal_id), '5. aprobación humana de la respuesta → propuesta');
  const proposalId = approved.body.proposal_id as string;

  const conf = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/confirm`, {
    method: 'POST', headers: authHeaders(ops.token),
  });
  resultLine(conf.status === 200 && conf.body.status === 'preview_ready', '6. preview preparado (cambio visible, DEC-011)');

  const published = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  resultLine(published.status === 200 && published.body.status === 'published', '7. respuesta pública aprobada → publicada');

  const againP = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  resultLine(againP.body.already_published === true, '8. repetir aprobación NO vuelve a publicar (UNA vez)');
  const pubsRep = await t.pool.query('SELECT count(*) AS n FROM publication WHERE proposal_id = $1', [proposalId]);
  resultLine(Number(pubsRep.rows[0]?.n ?? 0) === 1, `9. publicaciones totales = 1`);

  // ---------- 2) INC-005: post → preview → aprobación → publicado idempotente ----------
  say('\n-- INC-005: publicaciones Facebook (simulado) --');
  const post = await api(t.baseUrl, '/api/backoffice/social/posts', {
    method: 'POST', headers: authHeaders(ops.token),
    body: JSON.stringify({ text: 'Café de especialidad y tortas caseras esta semana.', image_url: 'https://sim.mainspot.local/fb/post.png' }),
  });
  resultLine(post.status === 201 && post.body.post.status === 'draft', '10. borrador de publicación creado');
  const postId = post.body.post.post_id as string;

  const sApprove = await api(t.baseUrl, `/api/backoffice/social/posts/${postId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  resultLine(sApprove.status === 200 && Boolean(sApprove.body.proposal_id), '11. aprobación del contenido → propuesta de preview');
  const spId = sApprove.body.proposal_id as string;

  const sConf = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${spId}/confirm`, {
    method: 'POST', headers: authHeaders(ops.token),
  });
  const previewUrl = sConf.body.preview?.url as string;
  resultLine(sConf.status === 200 && previewUrl?.startsWith('/preview/pv_'), '12. enlace de vista previa seguro');

  const sPub = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${spId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  resultLine(sPub.status === 200 && sPub.body.status === 'published', '13. publicación aprobada → published');

  const sAgain = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${spId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  resultLine(sAgain.body.already_published === true, '14. segundo intento → already_published (idempotente)');
  const pubsSocial = await t.pool.query('SELECT count(*) AS n FROM publication WHERE proposal_id = $1', [spId]);
  resultLine(Number(pubsSocial.rows[0]?.n ?? 0) === 1, '15. UNA sola publicación social');

  // ---------- 3) INC-006: plan → límite excedido deny + audit ----------
  say('\n-- INC-006: suscripciones y límites (catálogo configurable, DEC-024) --');
  const assign = await api(t.baseUrl, '/api/backoffice/subscriptions/assign', {
    method: 'POST', headers: authHeaders(admin.token), body: JSON.stringify({ plan_id: 'plan_basico' }),
  });
  resultLine(assign.status === 200 && assign.body.entitlements.plan.plan_id === 'plan_basico', '16. plan Básico asignado (sin precio)');

  const entitlements = await api(t.baseUrl, '/api/backoffice/subscriptions/entitlements', { headers: authHeaders(ops.token) });
  resultLine(entitlements.body.entitlements.limits.social_posts === 3, '17. límite social_posts = 3 visibile para operación');

  const attempts: number[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const r = await api(t.baseUrl, '/api/backoffice/social/posts', {
      method: 'POST', headers: authHeaders(ops.token),
      body: JSON.stringify({ text: `Post E2E límite ${i}` }),
    });
    attempts.push(r.status);
  }
  resultLine(
    attempts[0] === 201 && attempts[1] === 201 && attempts[2] === 403 && attempts[3] === 403,
    `18. base=1 post E2E previo + límite 3 ⇒ 2 creaciones OK y la 3ra excede el límite (${attempts.join(',')})`,
  );
  const denyAudit = await t.pool.query(
    `SELECT result FROM audit_event WHERE tenant_id = $1 AND action = 'access.deny' AND result = 'limit_exceeded' ORDER BY ts DESC LIMIT 1`,
    [SEED.a.tenant],
  );
  resultLine(denyAudit.rowCount === 1, '19. exceso auditado como deny/limit_exceeded');

  // Restaurar el plan piloto (no afectar otros flujos del run E2E).
  await api(t.baseUrl, '/api/backoffice/subscriptions/assign', {
    method: 'POST', headers: authHeaders(admin.token), body: JSON.stringify({ plan_id: 'plan_piloto_1' }),
  });

  say('\n=== Resumen E2E INC-004/005/006 ===');
  say(`review escalada y publicada: ${negative.review_id} (proposal ${proposalId})`);
  say(`post publicado: ${postId} (proposal ${spId})`);
  say(`plan asignado y límite verificado: plan_basico (social_posts=3)`);
  say('=== Fin E2E INC-004/005/006 ===');
  console.log('TEST_PASS E2E INC-004/005/006 full journeys with simulated providers');
});
