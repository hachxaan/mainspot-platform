/**
 * Integration — DEV-E2E-02 teléfonos de contacto (SHARED-CONTRACT §A, TEL-01..TEL-04).
 *
 * Cada integración (website, google_business_profile, facebook) tiene su PROPIO «Otro número».
 * Tenants nuevos por test (sin compartir estado con el seed ni con otros archivos).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApi, authHeaders, api, login, type TestApi } from '../helpers/testdb.ts';
import { createTenantWithPlan } from '../helpers/tenants.ts';

let t: TestApi;

before(async () => {
  t = await bootApi();
});

after(async () => {
  await t.close();
});

const MX = (n: string) => ({ country_iso2: 'MX', national_number: n });

async function phones(token: string) {
  return api(t.baseUrl, '/api/backoffice/contact/phones', { headers: authHeaders(token) });
}
async function setPrimary(token: string, phone: unknown) {
  return api(t.baseUrl, '/api/backoffice/contact/phones/primary', { method: 'PUT', headers: authHeaders(token), body: JSON.stringify({ primary_phone: phone }) });
}
async function setChannel(token: string, channel: string, body: unknown) {
  return api(t.baseUrl, `/api/backoffice/contact/phones/integrations/${channel}`, { method: 'PUT', headers: authHeaders(token), body: JSON.stringify(body) });
}

test('TEL-01: tres canales con «Otro número» y tres valores DISTINTOS, sin cruces', async () => {
  const { token } = await createTenantWithPlan(t, {}, 'client_tel1');
  assert.equal((await setPrimary(token, MX('9830000000'))).status, 200);
  assert.equal((await setChannel(token, 'website', { mode: 'other', other_phone: MX('9831111111') })).status, 200);
  assert.equal((await setChannel(token, 'google_business_profile', { mode: 'other', other_phone: MX('9832222222') })).status, 200);
  const fb = await setChannel(token, 'facebook', { mode: 'other', other_phone: MX('9833333333') });
  assert.equal(fb.status, 200);

  const view = (await phones(token)).body;
  assert.equal(view.primary_phone.e164, '+529830000000');
  assert.equal(view.integration_phones.website.effective_phone, '+529831111111');
  assert.equal(view.integration_phones.google_business_profile.effective_phone, '+529832222222');
  assert.equal(view.integration_phones.facebook.effective_phone, '+529833333333');
  const effective = new Set(['website', 'google_business_profile', 'facebook'].map((c) => view.integration_phones[c].effective_phone));
  assert.equal(effective.size, 3, 'tres números efectivos distintos a la vez');
  assert.equal(view.integration_phones.facebook.other_phone.calling_code, '+52');
  assert.equal(view.integration_phones.facebook.sync.mode, 'simulated', 'Meta sin credenciales = simulado, nunca real');
  assert.equal(view.integration_phones.website.sync.status, 'applies_on_publish');
  console.log('TEST_PASS TEL-01 (simulated providers)');
});

test('TEL-02: cambiar solo Facebook no altera Página Web, Google ni el principal', async () => {
  const { token } = await createTenantWithPlan(t, {}, 'client_tel2');
  await setPrimary(token, MX('9830000000'));
  await setChannel(token, 'website', { mode: 'other', other_phone: MX('9831111111') });
  await setChannel(token, 'google_business_profile', { mode: 'other', other_phone: MX('9832222222') });
  await setChannel(token, 'facebook', { mode: 'other', other_phone: MX('9833333333') });

  const res = await setChannel(token, 'facebook', { mode: 'other', other_phone: MX('9834444444') });
  assert.equal(res.status, 200);
  const v = res.body;
  assert.equal(v.integration_phones.facebook.effective_phone, '+529834444444');
  assert.equal(v.integration_phones.website.effective_phone, '+529831111111', 'web intacta');
  assert.equal(v.integration_phones.google_business_profile.effective_phone, '+529832222222', 'Google intacto');
  assert.equal(v.primary_phone.e164, '+529830000000', 'principal intacto');
  console.log('TEST_PASS TEL-02');
});

test('TEL-03: web=own, google=other, facebook=other → cambiar el principal solo mueve la web', async () => {
  const { token } = await createTenantWithPlan(t, {}, 'client_tel3');
  await setPrimary(token, MX('9830000000'));
  await setChannel(token, 'website', { mode: 'own' });
  await setChannel(token, 'google_business_profile', { mode: 'other', other_phone: MX('9832222222') });
  await setChannel(token, 'facebook', { mode: 'other', other_phone: MX('9833333333') });

  const before = (await phones(token)).body;
  assert.equal(before.integration_phones.website.effective_phone, '+529830000000');
  assert.equal(before.integration_phones.website.effective_source, 'primary');

  const after = (await setPrimary(token, MX('9835555555'))).body;
  assert.equal(after.integration_phones.website.effective_phone, '+529835555555', 'own sigue al principal (dinámico, sin copia)');
  assert.equal(after.integration_phones.google_business_profile.effective_phone, '+529832222222');
  assert.equal(after.integration_phones.facebook.effective_phone, '+529833333333');
  assert.equal(after.integration_phones.google_business_profile.other_phone.e164, '+529832222222', 'override de Google intacto');
  console.log('TEST_PASS TEL-03');
});

test('TEL-04: other→own→other recupera el valor propio; borrar es explícito; varios países', async () => {
  const { token } = await createTenantWithPlan(t, {}, 'client_tel4');
  await setPrimary(token, MX('9830000000'));
  await setChannel(token, 'google_business_profile', { mode: 'other', other_phone: { country_iso2: 'US', national_number: '2015550123' } });
  await setChannel(token, 'facebook', { mode: 'other', other_phone: { country_iso2: 'ES', national_number: '612345678' } });

  const own = (await setChannel(token, 'google_business_profile', { mode: 'own' })).body;
  assert.equal(own.integration_phones.google_business_profile.effective_phone, '+529830000000', 'own = principal');
  assert.equal(own.integration_phones.google_business_profile.other_phone.e164, '+12015550123', 'override conservado (no activo)');
  const back = (await setChannel(token, 'google_business_profile', { mode: 'other' })).body;
  assert.equal(back.integration_phones.google_business_profile.effective_phone, '+12015550123', 'retoma su propio override');
  assert.equal(back.integration_phones.facebook.effective_phone, '+34612345678', 'España intacta');

  // Borrado explícito del override; después «Otro número» exige capturarlo de nuevo.
  const cleared = await setChannel(token, 'google_business_profile', { mode: 'own', other_phone: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.integration_phones.google_business_profile.other_phone, null);
  const missing = await setChannel(token, 'google_business_profile', { mode: 'other' });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.fields[0].field, 'other_phone');

  // Argentina (móvil con 9) y prefijo explícito coherente.
  const ar = await setChannel(token, 'website', { mode: 'other', other_phone: { country_iso2: 'AR', calling_code: '+54', national_number: '91123456789' } });
  assert.equal(ar.status, 200);
  assert.equal(ar.body.integration_phones.website.effective_phone, '+5491123456789');
  console.log('TEST_PASS TEL-04 other→own→other + multi-país');
});

test('TEL-04: datos inválidos fallan con error de campo y sin tocar canales hermanos', async () => {
  const { token } = await createTenantWithPlan(t, {}, 'client_tel5');
  await setPrimary(token, MX('9830000000'));
  await setChannel(token, 'website', { mode: 'other', other_phone: MX('9831111111') });

  const cases: Array<[unknown, string]> = [
    [{ mode: 'other', other_phone: MX('123') }, 'other_phone.national_number'],
    [{ mode: 'other', other_phone: { country_iso2: 'MX', calling_code: '+1', national_number: '9831111111' } }, 'other_phone.calling_code'],
    [{ mode: 'other', other_phone: { country_iso2: 'ZZ', national_number: '9831111111' } }, 'other_phone.country_iso2'],
    [{ mode: 'other', other_phone: { country_iso2: 'MX', national_number: '98a3111111' } }, 'other_phone.national_number'],
    [{ mode: 'otro' }, 'mode'],
    [{ mode: 'other', other_phone: null }, 'other_phone'],
  ];
  for (const [body, field] of cases) {
    const res = await setChannel(token, 'facebook', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, 'validation_error');
    assert.equal(res.body.error.fields[0].field, field);
  }
  const unknown = await setChannel(token, 'whatsapp', { mode: 'own' });
  assert.equal(unknown.status, 404, 'no existe un canal fuera de los tres contratados');

  const v = (await phones(token)).body;
  assert.equal(v.integration_phones.website.effective_phone, '+529831111111', 'web intacta tras errores');
  assert.equal(v.integration_phones.facebook.mode, 'own');
  assert.equal(v.integration_phones.facebook.effective_phone, '+529830000000');
});

test('TEL-04: aislamiento tenant, RBAC y auditoría sin PII', async () => {
  const a = await createTenantWithPlan(t, {}, 'client_tel6a');
  const b = await createTenantWithPlan(t, {}, 'client_tel6b');
  await setPrimary(a.token, MX('9830000000'));
  await setChannel(a.token, 'facebook', { mode: 'other', other_phone: MX('9833333333') });

  const bView = (await phones(b.token)).body;
  assert.equal(bView.tenant_id, b.tenant);
  assert.equal(bView.primary_phone, null, 'B no ve datos de A');
  assert.equal(bView.integration_phones.facebook.effective_phone, null);
  assert.equal(bView.integration_phones.website.needs_primary, true, 'sin principal → pedirlo, nunca inventarlo');

  const forced = await api(t.baseUrl, '/api/backoffice/contact/phones/integrations/facebook', {
    method: 'PUT', headers: authHeaders(b.token), body: JSON.stringify({ tenant_id: a.tenant, mode: 'other', other_phone: MX('9839999999') }),
  });
  assert.equal(forced.status, 403, 'tenant ajeno en el cuerpo → deny');
  assert.equal((await phones(a.token)).body.integration_phones.facebook.effective_phone, '+529833333333', 'A intacto');

  // Perfil Operación: lee, pero no cambia teléfonos.
  const opsId = `user_ops_${a.tenant}`;
  await t.pool.query(`INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash)
    VALUES ($1, 'Ops', $2, 'active', $3, crypt('Fixture-Ops-2026!', gen_salt('bf', 4)))`, [opsId, `ops@${a.tenant}.example.com`, a.tenant]);
  await t.pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, 'operation', $2)`, [opsId, a.tenant]);
  const ops = await login(t.baseUrl, `ops@${a.tenant}.example.com`, 'Fixture-Ops-2026!', a.tenant);
  assert.equal((await phones(ops.token)).status, 200);
  assert.equal((await setChannel(ops.token, 'website', { mode: 'own' })).status, 403);

  const audit = await t.pool.query<{ resource: string; result: string }>(
    `SELECT resource, result FROM audit_event WHERE tenant_id = $1 AND action = 'contact.phone.updated' ORDER BY ts`, [a.tenant]);
  assert.ok(audit.rows.length >= 2);
  const blob = JSON.stringify(audit.rows);
  assert.ok(!/983\d{7}|\+52/.test(blob), 'la auditoría no contiene dígitos del teléfono');
  console.log('TEST_PASS TEL-04 aislamiento/RBAC/auditoría sin PII');
});
