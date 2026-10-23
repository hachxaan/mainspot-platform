/**
 * Fixtures de integración: tenants aislados creados por SQL y fallo de auditoría
 * inyectado (para probar NFR-0001). Cada llamada crea identificadores nuevos, así que
 * los tests no comparten estado con el seed ni entre sí.
 */

import { randomUUID } from 'node:crypto';
import { login, type TestApi } from './testdb.ts';

const PASSWORD = 'Fixture-Admin-2026!';

/** Tenant activo con un usuario de administración y un plan con los límites dados. */
export async function createTenantWithPlan(
  t: TestApi, limits: Record<string, number>, prefix = 'client_t',
): Promise<{ tenant: string; token: string; userId: string; login: string; plan: string }> {
  const tenant = `${prefix}_${randomUUID().slice(0, 8)}`;
  // El plan es catálogo de plataforma (sobrevive al tenant): su id no deriva del tenant.
  const plan = `plan_${randomUUID().slice(0, 8)}`;
  const userId = `user_${tenant}`;
  const loginName = `admin@${tenant}.example.com`;
  await t.pool.query(`INSERT INTO client (client_id, business_name, status, contact_email, metadata) VALUES ($1, $2, 'active', $3, '{}')`,
    [tenant, `Negocio ${tenant}`, `${tenant}@example.com`]);
  await t.pool.query(
    `INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash)
     VALUES ($1, $2, $3, 'active', $4, crypt($5, gen_salt('bf', 4)))`,
    [userId, `Persona ${tenant}`, loginName, tenant, PASSWORD]);
  await t.pool.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1, 'administration', $2)`, [userId, tenant]);
  await t.pool.query(`INSERT INTO plan (plan_id, name, description, price_cents, currency, is_pilot, active) VALUES ($1, $1, 'test', NULL, NULL, false, true)`, [plan]);
  for (const [capability, max] of Object.entries(limits)) {
    await t.pool.query('INSERT INTO plan_limit (limit_id, plan_id, capability, max_value) VALUES ($1, $2, $3, $4)',
      [`${plan}_${capability}`, plan, capability, max]);
  }
  await t.pool.query(`INSERT INTO subscription (subscription_id, tenant_id, plan_id, status) VALUES ($1, $2, $3, 'active')`,
    [`sub_${tenant}`, tenant, plan]);
  const { token } = await login(t.baseUrl, loginName, PASSWORD, tenant);
  return { tenant, token, userId, login: loginName, plan };
}

export async function countRows(t: TestApi, sql: string, params: unknown[]): Promise<number> {
  const res = await t.pool.query<{ n: string }>(sql, params);
  return Number(res.rows[0]?.n ?? 0);
}

/** Hace fallar la escritura de auditoría de `action` solo para `tenant`; devuelve la función que lo deshace. */
export async function failAuditFor(t: TestApi, tenant: string, action: string): Promise<() => Promise<void>> {
  const fn = `fail_audit_${randomUUID().replaceAll('-', '')}`;
  await t.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger AS $$
    BEGIN
      IF NEW.tenant_id = '${tenant}' AND NEW.action = '${action}' THEN RAISE EXCEPTION 'injected audit failure'; END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await t.pool.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  return async () => {
    await t.pool.query(`DROP TRIGGER ${fn} ON audit_event`);
    await t.pool.query(`DROP FUNCTION ${fn}()`);
  };
}
