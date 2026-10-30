/**
 * Alta asistida del dueño del negocio (DEV-E2E-02, FLOW-01).
 *
 * 1. Operación de MainSpot (CLI `scripts/invite-owner.ts`) crea el negocio, su plan piloto y una
 *    invitación de UN SOLO USO (token aleatorio de 256 bits; se guarda solo su SHA-256).
 * 2. El dueño abre el enlace, elige su contraseña y queda con perfil Administración en SU
 *    negocio; la invitación se consume en la misma transacción (dos usos concurrentes: uno gana).
 * 3. Después entra con correo + contraseña, sin identificador interno de cliente.
 *
 * Invitación inexistente, usada, caducada o anulada → la MISMA respuesta neutra (no revela si el
 * negocio existe). Correo y contraseña nunca van a auditoría ni registros.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { assertPasswordPolicy } from './password-policy.ts';

export const INVITATION_TTL_HOURS = 72;
export { MIN_PASSWORD_LENGTH } from './password-policy.ts';
const NEUTRAL = 'Este enlace de invitación no es válido o ya no está disponible. Pide uno nuevo a MainSpot.';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function slugify(name: string): string {
  return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'negocio';
}

export interface CreatedInvitation {
  tenant_id: string;
  invitation_id: string;
  token: string;
  path: string;
  expires_at: string;
}

export class OnboardingService {
  private readonly pool: Pool;
  private readonly sink: AuditSink;

  constructor(deps: { pool: Pool; sink: AuditSink }) {
    this.pool = deps.pool;
    this.sink = deps.sink;
  }

  /** Crea negocio + plan piloto + invitación (alta asistida por operación de MainSpot). */
  async createBusinessWithInvitation(input: { businessName: string; ownerEmail: string; planId?: string; createdBy: string }): Promise<CreatedInvitation> {
    const name = input.businessName.trim();
    const email = input.ownerEmail.trim().toLowerCase();
    if (!name || name.length > 120) throw new AppError(400, 'validation_error', 'Escribe el nombre del negocio (máximo 120 caracteres).');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new AppError(400, 'validation_error', 'Escribe un correo válido para la dueña o el dueño.');
    const tenantId = `client_${slugify(name)}_${randomUUID().slice(0, 6)}`;
    const token = randomBytes(32).toString('base64url');
    const invitationId = `inv_${randomUUID()}`;
    const expires = new Date(Date.now() + INVITATION_TTL_HOURS * 3600_000);
    await runAtomic(this.pool, async (client) => {
      await client.query(`INSERT INTO client (client_id, business_name, status, contact_email, metadata) VALUES ($1,$2,'active',$3,'{}')`, [tenantId, name, email]);
      await client.query(`INSERT INTO tenant_context (tenant_context_id, client_id, config, status) VALUES ($1,$2,'{}','active')`, [`tc_${tenantId}`, tenantId]);
      await client.query(`INSERT INTO subscription (subscription_id, tenant_id, plan_id, status) VALUES ($1,$2,$3,'active')`,
        [`sub_${tenantId}`, tenantId, input.planId ?? 'plan_piloto_1']);
      await client.query(
        `INSERT INTO owner_invitation (invitation_id, tenant_id, email, token_hash, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [invitationId, tenantId, email, hashToken(token), expires, input.createdBy]);
      await this.sink.write({
        tenant_id: tenantId, actor_id: input.createdBy, actor_role: null, action: 'onboarding.invitation.created',
        resource: `owner_invitation/${invitationId}`, request_id: `onb_${invitationId}`, decision: 'allow', result: 'created',
      }, client, true);
    });
    return { tenant_id: tenantId, invitation_id: invitationId, token, path: `/invitacion#${token}`, expires_at: expires.toISOString() };
  }

  /** Vista pública mínima de una invitación válida (solo el nombre del negocio). */
  async describe(token: string): Promise<{ business_name: string; expires_at: string }> {
    const res = await this.pool.query<{ business_name: string; expires_at: Date }>(
      `SELECT c.business_name, i.expires_at FROM owner_invitation i JOIN client c ON c.client_id = i.tenant_id
        WHERE i.token_hash = $1 AND i.status = 'pending' AND i.expires_at > now() AND c.status = 'active'`, [hashToken(String(token ?? ''))]);
    const row = res.rows[0];
    if (!row) throw new AppError(404, DENY_CODES.NOT_FOUND, NEUTRAL);
    return { business_name: row.business_name, expires_at: new Date(row.expires_at).toISOString() };
  }

  /** Consume la invitación y crea la cuenta del dueño (perfil Administración) en una transacción. */
  async accept(input: { token: unknown; displayName: unknown; password: unknown }): Promise<{ tenant_id: string; user_id: string; login: string }> {
    const token = typeof input.token === 'string' ? input.token : '';
    const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (!displayName || displayName.length > 80) throw new AppError(400, 'validation_error', 'Escribe tu nombre (máximo 80 caracteres).');
    const password = assertPasswordPolicy(input.password);
    return runAtomic(this.pool, async (client) => {
      const res = await client.query<{ invitation_id: string; tenant_id: string; email: string }>(
        `UPDATE owner_invitation SET status = 'used', used_at = now()
          WHERE token_hash = $1 AND status = 'pending' AND expires_at > now()
          RETURNING invitation_id, tenant_id, email`, [hashToken(token)]);
      const inv = res.rows[0];
      if (!inv) throw new AppError(404, DENY_CODES.NOT_FOUND, NEUTRAL);
      const exists = await client.query('SELECT 1 FROM internal_user WHERE login = $1 AND tenant_id = $2', [inv.email, inv.tenant_id]);
      if (exists.rowCount) throw new AppError(404, DENY_CODES.NOT_FOUND, NEUTRAL);
      const userId = `user_${randomUUID()}`;
      await client.query(
        `INSERT INTO internal_user (user_id, display_name, login, status, tenant_id, password_hash)
         VALUES ($1,$2,$3,'active',$4, crypt($5, gen_salt('bf', 10)))`, [userId, displayName, inv.email, inv.tenant_id, password]);
      await client.query(`INSERT INTO user_role (user_id, role_id, tenant_id) VALUES ($1,'administration',$2)`, [userId, inv.tenant_id]);
      await client.query(`UPDATE owner_invitation SET used_by = $2 WHERE invitation_id = $1`, [inv.invitation_id, userId]);
      await this.sink.write({
        tenant_id: inv.tenant_id, actor_id: userId, actor_role: 'administration', action: 'onboarding.invitation.accepted',
        resource: `owner_invitation/${inv.invitation_id}`, request_id: `onb_${inv.invitation_id}`, decision: 'allow', result: 'account_created',
      }, client, true);
      return { tenant_id: inv.tenant_id, user_id: userId, login: inv.email };
    });
  }
}
