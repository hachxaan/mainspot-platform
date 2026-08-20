/**
 * E2E INC-002 + INC-003 — recorrido completo con canal simulado (DEC-026, DEC-016).
 *
 * "necesito cambiar el teléfono" → clasificación → confirmación → preview →
 * aprobación → publicación web → idempotencia (segunda aprobación NO duplica)
 * → auditoría con request_id → provisión de subdominio simulado (FLOW-006).
 *
 * Escribre evidencia reproducible en evidence/e2e-inc002-inc003.txt (AC-009):
 * transcript del recorrido + HEAD del commit. Se ejecuta con `npm run test:e2e`
 * (test-prep recrea mainspot_test desde cero ⇒ fixture determinista).
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
  // Evidencia reproducible (AC-009): transcript + HEAD.
  try {
    mkdirSync('evidence', { recursive: true });
    const head = execSync('git rev-parse HEAD').toString().trim();
    const run = new Date().toISOString();
    const body = `# E2E INC-002 + INC-003 — transcript (run ${run})\n# HEAD: ${head}\n# canal: simulated (DEC-026); Telegram real requiere TELEGRAM_BOT_TOKEN\n# DB: mainspot_test (recreada por scripts/test-prep.ts)\n\n${transcript.join('\n')}\n\n# Fin de transcript\n`;
    writeFileSync('evidence/e2e-inc002-inc003.txt', body);
    console.log(`EVIDENCE_SAVED evidence/e2e-inc002-inc003.txt (HEAD ${head})`);
  } catch (err) {
    console.error('WARN evidence write failed:', (err as Error).message);
  }
});

async function sendMsg(token: string, text: string) {
  return api(t.baseUrl, '/api/backoffice/conversation/messages', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ text, channel: 'simulated' }),
  });
}

async function auditForRequest(tenantId: string, requestId: string) {
  const res = await t.pool.query<{ action: string; decision: string; result: string }>(
    'SELECT action, decision, result FROM audit_event WHERE tenant_id = $1 AND request_id = $2 ORDER BY ts, event_id',
    [tenantId, requestId],
  );
  return res.rows;
}

test('E2E INC-002/INC-003: mensaje simulado → clasificación → confirmación → preview → aprobación → publicación idempotente → auditoría', async () => {
  const ops = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  say('=== INC-002/INC-003 E2E (canal simulado) ===');

  // 1) Clasificación (AC-005/AC-006)
  const r = await sendMsg(ops.token, 'necesito cambiar el teléfono a +51 999 000 111');
  resultLine(r.status === 201, '1. mensaje simulado recibido y clasificado');
  resultLine(r.body.request.action_class === 'preview_required', `2. clasificación = preview_required (intent ${r.body.request.intent})`);
  resultLine(r.body.request.status === 'awaiting_confirmation', '3. estado awaiting_confirmation');
  resultLine(/confirmes estos cambios/i.test(r.body.response), '4. confirmación detallada (AC-006)');
  const proposalId = r.body.proposal_id as string;
  const requestId = r.body.request.request_id as string;
  resultLine(Boolean(proposalId), '5. propuesta creada');

  // 2) Confirmación → preview (CAP-008)
  const conf = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/confirm`, {
    method: 'POST', headers: authHeaders(ops.token),
  });
  resultLine(conf.status === 200 && conf.body.status === 'preview_ready', '6. confirmación → preview_ready');
  const previewUrl = conf.body.preview.url as string;
  resultLine(previewUrl.startsWith('/preview/pv_'), '7. enlace seguro de preview generado');
  const page = await fetch(`${t.baseUrl}${previewUrl}`);
  resultLine(page.status === 200, '8. GET preview público responde');
  const html = await page.text();
  resultLine(html.includes('+51 999 000 111'), '9. preview muestra el nuevo teléfono');

  // 3) Aprobación → publicación web (RULE-003, AC-007)
  const before = await t.pool.query<{ v: number }>('SELECT published_version AS v FROM client_website WHERE tenant_id = $1', [SEED.a.tenant]);
  const approved = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  resultLine(approved.status === 200 && approved.body.status === 'published', '10. aprobación humana → publicado');
  resultLine(approved.body.already_published === false, '11. primera publicación (no replay)');
  const after = await t.pool.query<{ v: number; phone: string }>(
    'SELECT published_version AS v, data->>\'phone\' AS phone FROM client_website WHERE tenant_id = $1', [SEED.a.tenant],
  );
  resultLine(Number(after.rows[0]?.v) === Number(before.rows[0]?.v) + 1, '12. versión del sitio incrementada');
  resultLine(after.rows[0]?.phone === '+51 999 000 111', '13. teléfono publicado en la web del cliente');
  const wc = await t.pool.query('SELECT count(*) AS n FROM website_content WHERE tenant_id = $1 AND version = $2', [SEED.a.tenant, Number(after.rows[0]?.v)]);
  resultLine(Number(wc.rows[0]?.n ?? 0) === 1, '14. contenido publicado versionado (website_content)');

  // 4) Idempotencia (AC-007): segunda aprobación NO duplica.
  const again = await api(t.baseUrl, `/api/backoffice/conversation/proposals/${proposalId}/approve`, {
    method: 'POST', headers: authHeaders(admin.token),
  });
  resultLine(again.body.already_published === true, '15. segunda aprobación → already_published');
  const pubs = await t.pool.query('SELECT count(*) AS n FROM publication WHERE proposal_id = $1', [proposalId]);
  resultLine(Number(pubs.rows[0]?.n ?? 0) === 1, '16. UNA sola publicación (no duplica)');
  const contentByProposal = await t.pool.query('SELECT count(*) AS n FROM website_content WHERE proposal_id = $1', [proposalId]);
  resultLine(Number(contentByProposal.rows[0]?.n ?? 0) === 1, '17. contenido publicado UNA vez por propuesta (sin duplicado por replay)');

  // 5) Auditoría correlacionada (REQ-009, AC-003).
  //    - El request del MENSAJE correla la cadena de ingesta (received/classified/created).
  //    - Las transiciones posteriores (confirm/approve/publish) tienen su propio
  //      request_id HTTP pero quedan ligadas a la propuesta por resource +
  //      approval.request_id (traza reconstruible, NFR-006).
  const events = await auditForRequest(SEED.a.tenant, requestId);
  const actions = events.map((e) => e.action);
  for (const expected of ['conversation.received', 'conversation.classified', 'conversation.proposal.created']) {
    resultLine(actions.includes(expected), `18a. auditoría del mensaje contiene ${expected} (request_id=${requestId.slice(0, 8)}…)`);
  }
  const flowEvents = await t.pool.query<{ action: string; result: string }>(
    `SELECT action, result FROM audit_event
     WHERE tenant_id = $1 AND resource = $2 ORDER BY ts`,
    [SEED.a.tenant, `action_proposal/${proposalId}`],
  );
  const flowActions = flowEvents.rows.map((e) => e.action);
  for (const expected of ['conversation.confirmed', 'conversation.preview.created', 'conversation.approved', 'conversation.published']) {
    resultLine(flowActions.includes(expected), `18b. auditoría de la propuesta contiene ${expected}`);
  }
  const replayEv = await t.pool.query(
    `SELECT result FROM audit_event WHERE tenant_id = $1 AND action = 'conversation.publish_attempt' AND result = 'already_published' ORDER BY ts DESC LIMIT 1`,
    [SEED.a.tenant],
  );
  resultLine(replayEv.rowCount === 1, '18c. replay auditado como already_published');
  resultLine(events.every((e) => e.decision === 'allow'), '19. eventos del mensaje correlacionados por request_id');

  // 6) Subdominio simulado (FLOW-006) queda aprovisionado tras publicar.
  const domain = await t.pool.query('SELECT subdomain, status, provider FROM client_domain WHERE tenant_id = $1', [SEED.a.tenant]);
  resultLine(domain.rows[0]?.subdomain === 'el-sol.sim.mainspot.local', '20. subdominio simulado provisto al publicar');
  resultLine(domain.rows[0]?.status === 'active', '21. DNS + certificado simulados activos');

  // Transcript resumen final (para evidence).
  say(`\n=== Resumen E2E ===`);
  say(`solicitud: request_id=${requestId}`);
  say(`propuesta: ${proposalId}`);
  say(`preview: ${previewUrl}`);
  say(`publicación: ${approved.body.publication?.publish_key} (${approved.body.publication?.external_ref})`);
  say(`audit events correlacionados: ${events.length}`);
  say('=== Fin E2E ===');
  console.log('TEST_PASS E2E INC-002/INC-003 full journey with simulated channel');
});
