/**
 * End-to-end smoke (AC-009 + AC-008 UX signals). Runs against a fresh test DB
 * (scripts/test-prep.ts), exercises the canonical happy paths and captures
 * evidence markers that scripts/capture-evidence.sh stores under evidence/.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApi, login, authHeaders, api, SEED, type TestApi } from '../helpers/testdb.ts';

let t: TestApi;

before(async () => {
  t = await bootApi();
});

after(async () => {
  await t.close();
});

test('AC-009 smoke: health + all three roles can log in and see their context', async () => {
  const healthRes = await fetch(`${t.baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  const health = (await healthRes.json()) as { increments?: string[] };
  // INC-001 base + INC-002..INC-007 habilitados en esta tanda.
  assert.ok(Array.isArray(health.increments));
  for (const inc of ['INC-001', 'INC-002', 'INC-003', 'INC-004', 'INC-005', 'INC-006', 'INC-007']) {
    assert.ok(health.increments.includes(inc), `health reports ${inc}`);
  }
  // IR-13: security headers present even on public endpoints.
  assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(healthRes.headers.get('x-frame-options'), 'DENY');
  assert.ok((healthRes.headers.get('content-security-policy') ?? '').includes("default-src 'self'"));
  assert.ok(healthRes.headers.get('strict-transport-security')?.startsWith('max-age='));

  for (const profile of [
    { who: 'admin', creds: SEED.a.admin, role: 'administration' },
    { who: 'ops', creds: SEED.a.ops, role: 'operation' },
    { who: 'reader', creds: SEED.a.reader, role: 'read_only' },
  ]) {
    const loginRes = await login(t.baseUrl, profile.creds.login, profile.creds.password, SEED.a.tenant);
    assert.equal(loginRes.session.role_id, profile.role, `${profile.who} role`);
    const me = await api(t.baseUrl, '/api/backoffice/me', { headers: authHeaders(loginRes.token) });
    assert.equal(me.status, 200);
    // /me contract: permissions is an ARRAY (never a count) + enriched context.
    assert.ok(Array.isArray(me.body.session.permissions), `${profile.who} permissions is an array`);
    assert.ok(me.body.session.permissions.length >= 1);
    assert.equal(typeof me.body.session.display_name, 'string', `${profile.who} display_name`);
    assert.ok(me.body.session.tenant && me.body.session.tenant.id === SEED.a.tenant, `${profile.who} tenant summary`);
    assert.equal(typeof me.body.session.tenant.business_name, 'string');
    assert.equal(typeof me.body.session.tenant.status, 'string');
    assert.equal(typeof me.body.session.role_label, 'string', `${profile.who} role_label`);
    assert.equal(typeof me.body.session.role_description, 'string', `${profile.who} role_description`);
    console.log(`TEST_PASS AC-009 smoke login+me for ${profile.who} (${profile.role})`);
  }
});

test('AC-008 smoke: UI pages are plain-language and minimally accessible', async () => {
  const loginPage = await fetch(`${t.baseUrl}/`);
  assert.equal(loginPage.status, 200);
  const html = await loginPage.text();
  const checks: Array<[string, boolean]> = [
    ['lang="es"', html.includes('lang="es"')],
    ['title MainSpot', html.includes('<title>MainSpot — Ingreso</title>')],
    ['plain welcome', html.includes('Bienvenido a MainSpot')],
    ['labeled login field', html.includes('<label for="login">')],
    ['labeled password field', html.includes('<label for="password">')],
    ['labeled tenant field', html.includes('<label for="tenant_id">')],
    ['clear submit button', html.includes('>Ingresar</button>')],
    ['alert region for errors', html.includes('role="alert"')],
    ['no tech jargon (password_hash absent)', !html.includes('password_hash')],
  ];
  for (const [name, ok] of checks) {
    assert.equal(ok, true, `login page check failed: ${name}`);
  }

  const panel = await fetch(`${t.baseUrl}/panel`);
  const panelHtml = await panel.text();
  assert.ok(panelHtml.includes('Panel de MainSpot'));
  assert.ok(panelHtml.includes('Salir del panel'));
  // AC-008: full panel sections (per-role profile, modules, data, audit).
  assert.ok(panelHtml.includes('id="roleCard"'), 'role card section present');
  assert.ok(panelHtml.includes('id="websiteCard"'), 'website module section present');
  assert.ok(panelHtml.includes('id="socialCard"'), 'social module section present');
  assert.ok(panelHtml.includes('id="reputationCard"'), 'reputation module section present');
  assert.ok(panelHtml.includes('id="subscriptionCard"'), 'subscription module section present');
  assert.ok(panelHtml.includes('id="dataCard"'), 'data card section present');
  assert.ok(panelHtml.includes('id="auditCard"'), 'audit card section present');
  assert.ok(panelHtml.includes('role="alert"'), 'visible alert region for errors');
  assert.ok(panelHtml.includes('role="status"'), 'status region for confirmations');
  assert.ok(!panelHtml.includes('password_hash'));
  console.log('TEST_PASS AC-008 UI plain language + label/role/alert accessibility basics');
});

test('AC-009 smoke: real evidence path works (API export mirrors DB audit rows)', async () => {
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  const before = await t.pool.query<{ n: string }>('SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1', [SEED.a.tenant]);
  await api(t.baseUrl, '/api/backoffice/data', { headers: authHeaders(admin.token) }); // audited read
  const after = await t.pool.query<{ n: string }>('SELECT count(*) AS n FROM audit_event WHERE tenant_id = $1', [SEED.a.tenant]);
  assert.ok(Number(after.rows[0]?.n ?? 0) > Number(before.rows[0]?.n ?? 0), 'audit rows grew after an audited action');

  // Panel-support GET: own tenant demo actions can be listed (tenant-scoped).
  const actionsList = await api(t.baseUrl, '/api/backoffice/actions', { headers: authHeaders(admin.token) });
  assert.equal(actionsList.status, 200);
  assert.ok(Array.isArray(actionsList.body.actions));
  console.log('TEST_PASS AC-009 smoke: GET /actions tenant-scoped listing works');

  const exportRes = await api(t.baseUrl, '/api/backoffice/audit/export', { headers: authHeaders(admin.token) });
  assert.equal(exportRes.status, 200);
  assert.equal(exportRes.body.tenant_id, SEED.a.tenant);
  assert.ok(exportRes.body.count >= 1);
  console.log('TEST_PASS AC-009 smoke: audited action -> audit row + API export consistent');
});

test('AC-009 smoke: logout revokes the session (rollback of access path enabled)', async () => {
  const admin = await login(t.baseUrl, SEED.a.admin.login, SEED.a.admin.password, SEED.a.tenant);
  await api(t.baseUrl, '/api/auth/logout', { method: 'POST', headers: authHeaders(admin.token) });
  const meAfterLogout = await api(t.baseUrl, '/api/backoffice/me', { headers: authHeaders(admin.token) });
  assert.equal(meAfterLogout.status, 401, 'revoked token must be rejected');
  console.log('TEST_PASS AC-009 smoke: revoked session rejected (fail-closed)');
});

test('IR-04 smoke: UI logout path (/api/auth/logout) revokes the session in DB', async () => {
  const { token } = await login(t.baseUrl, SEED.a.ops.login, SEED.a.ops.password, SEED.a.tenant);
  // Exact request the panel UI performs on "Salir" (see src/api/ui.ts).
  const logout = await fetch(`${t.baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  assert.equal(logout.status, 200);
  const revoked = await t.pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM session_context sc
     JOIN internal_user u ON u.user_id = sc.user_id
     WHERE u.login = $1 AND sc.tenant_id = $2 AND sc.revoked_at IS NOT NULL`,
    [SEED.a.ops.login, SEED.a.tenant],
  );
  assert.ok(Number(revoked.rows[0]?.n ?? 0) >= 1, 'session must be revoked in DB after UI logout');
  const meAfter = await api(t.baseUrl, '/api/backoffice/me', { headers: authHeaders(token) });
  assert.equal(meAfter.status, 401, 'token from a revoked session must be rejected');
  console.log('TEST_PASS IR-04 UI logout path revokes session in DB (token -> 401)');
});
