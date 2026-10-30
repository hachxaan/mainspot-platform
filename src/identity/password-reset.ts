/**
 * Recuperación de contraseña (DEV-E2E-04 §3, escenario AUTH-RESET).
 *
 * 1. «¿Olvidaste tu contraseña?» → POST /api/auth/password/forgot con el correo. La respuesta es
 *    SIEMPRE la misma (y con tiempo acotado) exista o no la cuenta. Si existe, se emite un token
 *    aleatorio de 256 bits del que solo se guarda el SHA-256, con vigencia de 30 minutos; toda
 *    solicitud nueva anula las anteriores pendientes del mismo correo. El correo se envía FUERA
 *    de la respuesta HTTP (el tiempo de SMTP no delata la existencia de la cuenta).
 * 2. El enlace lleva el token en el FRAGMENTO (`/restablecer#<token>`): nunca llega al servidor
 *    ni a sus registros; el panel lo lee en memoria y lo quita de la barra de direcciones.
 * 3. POST /api/auth/password/reset consume el token de forma atómica (UPDATE … WHERE pendiente y
 *    vigente RETURNING): dos usos concurrentes ⇒ uno gana. Cambia la contraseña con la misma
 *    convención del repo (pgcrypto bcrypt) y REVOCA todas las sesiones activas de esa persona.
 *
 * Identidad sin tenant_id: el correo es la identidad. Si el mismo correo tiene cuenta en varios
 * negocios (misma persona, distinta cuenta por negocio), un único enlace cambia la contraseña de
 * TODAS sus cuentas activas; el correo no menciona negocios ni nombres (no revela pertenencia) y
 * ninguna otra cuenta (otro correo) puede verse afectada.
 *
 * Auditoría y registros nunca incluyen correo, token ni contraseña.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditSink } from '../audit/sink.ts';
import { ActionRateLimiter } from '../boundary/action-ratelimit.ts';
import { UNKNOWN_ACTOR_ID, UNKNOWN_TENANT_ID } from '../boundary/session.ts';
import { runAtomic } from '../conversation/state-machine.ts';
import type { Mailer } from '../mail/mailer.ts';
import { AppError, DENY_CODES } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';
import { assertPasswordPolicy } from './password-policy.ts';

export const PASSWORD_RESET_TTL_MINUTES = 30;
/** Ruta pública del shell del panel que recibe el enlace (el token va detrás de `#`). */
export const PASSWORD_RESET_PATH = '/restablecer';
/** Respuesta neutra de la solicitud: idéntica exista o no la cuenta. */
export const FORGOT_NEUTRAL_MESSAGE = 'Si ese correo tiene una cuenta en MainSpot, recibirás un mensaje con un enlace para crear una contraseña nueva. Revisa también la carpeta de correo no deseado.';
export const RESET_INVALID_MESSAGE = 'Este enlace para crear una contraseña nueva no es válido o ya venció. Pide uno nuevo desde «¿Olvidaste tu contraseña?».';
export const RESET_DONE_MESSAGE = 'Tu contraseña cambió. Entra con tu correo y tu contraseña nueva.';
/** Las solicitudes responden como mínimo tras este tiempo (misma duración exista o no la cuenta). */
export const FORGOT_MIN_RESPONSE_MS = 250;
const PURGE_AFTER = '1 day';

export interface PasswordResetLimits {
  /** Solicitudes por IP (cualquier correo). */
  forgotPerIp: ActionRateLimiter;
  /** Solicitudes por correo (exista o no: no revela nada). */
  forgotPerAccount: ActionRateLimiter;
  /** Intentos de canje por IP. */
  resetPerIp: ActionRateLimiter;
}

export interface PasswordResetDeps {
  pool: Pool;
  sink: AuditSink;
  mailer: Mailer;
  /** Origen público del panel (PUBLIC_BASE_URL), p. ej. https://app.mainspot.local.io */
  publicBaseUrl: string;
  limits?: Partial<PasswordResetLimits>;
  minResponseMs?: number;
}

export type ResetOutcome =
  | { kind: 'invalid' }
  | { kind: 'ok'; accounts: number; sessions_revoked: number };

interface AccountRow { user_id: string; tenant_id: string }

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function normalizeLogin(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

const FIFTEEN_MIN = 15 * 60_000;

export class PasswordResetService {
  private readonly pool: Pool;
  private readonly sink: AuditSink;
  private readonly mailer: Mailer;
  private readonly publicBaseUrl: string;
  private readonly inflight = new Set<Promise<void>>();
  readonly limits: PasswordResetLimits;
  readonly minResponseMs: number;

  constructor(deps: PasswordResetDeps) {
    this.pool = deps.pool;
    this.sink = deps.sink;
    this.mailer = deps.mailer;
    this.publicBaseUrl = deps.publicBaseUrl.replace(/\/$/, '');
    this.minResponseMs = deps.minResponseMs ?? FORGOT_MIN_RESPONSE_MS;
    this.limits = {
      forgotPerIp: deps.limits?.forgotPerIp ?? new ActionRateLimiter(10, FIFTEEN_MIN, FIFTEEN_MIN),
      forgotPerAccount: deps.limits?.forgotPerAccount ?? new ActionRateLimiter(3, FIFTEEN_MIN, FIFTEEN_MIN),
      resetPerIp: deps.limits?.resetPerIp ?? new ActionRateLimiter(10, FIFTEEN_MIN, FIFTEEN_MIN),
    };
  }

  /** Pruebas: limpia los contadores de límite de intentos. */
  resetRateLimits(): void {
    this.limits.forgotPerIp.reset();
    this.limits.forgotPerAccount.reset();
    this.limits.resetPerIp.reset();
  }

  /** Espera los envíos de correo pendientes (apagado ordenado y pruebas). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  /** Enlace que viaja en el correo: el token va en el fragmento, nunca en la ruta ni en la query. */
  resetLink(token: string): string {
    return `${this.publicBaseUrl}${PASSWORD_RESET_PATH}#${token}`;
  }

  /** Cuentas activas (usuario, negocio y algún perfil activos) con ese correo. */
  private async activeAccounts(login: string, db: Pool | PoolClient): Promise<AccountRow[]> {
    const res = await db.query<AccountRow>(`
      SELECT u.user_id, u.tenant_id FROM internal_user u
      JOIN client c ON c.client_id = u.tenant_id
      WHERE u.login = $1 AND u.status = 'active' AND c.status = 'active'
        AND EXISTS (SELECT 1 FROM user_role ur WHERE ur.user_id = u.user_id AND ur.tenant_id = u.tenant_id)
      ORDER BY u.tenant_id`, [login]);
    return res.rows;
  }

  /**
   * Registra la solicitud. Nunca revela si la cuenta existe: el resultado solo sirve a la
   * auditoría interna y a las pruebas; la respuesta HTTP es la misma en todos los casos.
   */
  async request(input: { login: unknown; requestId: string }): Promise<{ issued: boolean }> {
    const login = normalizeLogin(input.login);
    if (!login || login.length > 200) return { issued: false };
    const accounts = await this.activeAccounts(login, this.pool);
    if (accounts.length === 0) {
      await this.sink.write({
        tenant_id: UNKNOWN_TENANT_ID, actor_id: UNKNOWN_ACTOR_ID, actor_role: null, action: 'auth.password.reset_requested',
        resource: '/api/auth/password/forgot', request_id: input.requestId, decision: 'allow', result: 'no_account',
      }, this.pool, false);
      return { issued: false };
    }
    const token = randomBytes(32).toString('base64url');
    const resetId = `prt_${randomUUID()}`;
    const expires = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000);
    await runAtomic(this.pool, async (client) => {
      // Serializa solicitudes del mismo correo: dos peticiones simultáneas no dejan dos enlaces vigentes.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`password-reset:${login}`]);
      // Una solicitud nueva anula las anteriores pendientes del mismo correo.
      await client.query(`UPDATE password_reset_token SET status = 'superseded' WHERE login = $1 AND status = 'pending'`, [login]);
      await client.query(
        `INSERT INTO password_reset_token (reset_id, login, token_hash, expires_at) VALUES ($1,$2,$3,$4)`,
        [resetId, login, hashResetToken(token), expires]);
      // Retención mínima: las filas (contienen el correo) no sobreviven más de un día.
      await client.query(`DELETE FROM password_reset_token WHERE created_at < now() - interval '${PURGE_AFTER}'`);
      for (const a of accounts) {
        await this.sink.write({
          tenant_id: a.tenant_id, actor_id: a.user_id, actor_role: null, action: 'auth.password.reset_requested',
          resource: `password_reset/${resetId}`, request_id: input.requestId, decision: 'allow', result: 'link_issued',
        }, client, true);
      }
    });
    const delivery = this.deliver(resetId, login, token, accounts, input.requestId).finally(() => this.inflight.delete(delivery));
    this.inflight.add(delivery);
    return { issued: true };
  }

  /** Envío fuera de la respuesta HTTP; el resultado queda en la fila y en auditoría (sin correo ni token). */
  private async deliver(resetId: string, to: string, token: string, accounts: AccountRow[], requestId: string): Promise<void> {
    let delivery: 'sent' | 'failed' | 'disabled' = 'failed';
    try {
      const result = await this.mailer.send(passwordResetMail(to, this.resetLink(token)));
      delivery = result.sent ? 'sent' : (result.reason === 'transport_disabled' ? 'disabled' : 'failed');
    } catch (err) {
      log.warn('auth.password.reset_mail_error', 'fallo inesperado del transporte de correo', { error_name: err instanceof Error ? err.name : 'unknown' });
    }
    try {
      await this.pool.query(`UPDATE password_reset_token SET delivery = $2 WHERE reset_id = $1`, [resetId, delivery]);
      for (const a of accounts) {
        await this.sink.write({
          tenant_id: a.tenant_id, actor_id: a.user_id, actor_role: null, action: 'auth.password.reset_mail',
          resource: `password_reset/${resetId}`, request_id: requestId, decision: delivery === 'sent' ? 'allow' : 'deny', result: delivery,
        }, this.pool, false);
      }
      log.info('auth.password.reset_mail', `correo de recuperación: ${delivery}`, { delivery, provider: this.mailer.provider });
    } catch (err) {
      log.warn('auth.password.reset_mail_error', 'no se pudo registrar el resultado del envío', { error_name: err instanceof Error ? err.name : 'unknown' });
    }
  }

  /**
   * Canjea el token y cambia la contraseña de todas las cuentas activas del correo asociado,
   * revocando sus sesiones. Contraseña débil ⇒ 400 sin consumir el token. Token inexistente,
   * usado, anulado o vencido ⇒ la MISMA respuesta neutra (404).
   */
  async reset(input: { token: unknown; password: unknown; requestId: string }): Promise<ResetOutcome> {
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    const password = assertPasswordPolicy(input.password);
    const outcome: ResetOutcome = token.length < 16 || token.length > 256 ? { kind: 'invalid' } : await runAtomic(this.pool, async (client): Promise<ResetOutcome> => {
      const owner = await client.query<{ login: string }>('SELECT login FROM password_reset_token WHERE token_hash = $1', [hashResetToken(token)]);
      if (!owner.rows[0]) return { kind: 'invalid' };
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`password-reset:${owner.rows[0].login}`]);
      const consumed = await client.query<{ reset_id: string; login: string }>(
        `UPDATE password_reset_token SET status = 'used', used_at = now()
          WHERE token_hash = $1 AND status = 'pending' AND used_at IS NULL AND expires_at > now()
          RETURNING reset_id, login`, [hashResetToken(token)]);
      const row = consumed.rows[0];
      if (!row) return { kind: 'invalid' };
      const changed = await client.query<AccountRow>(`
        UPDATE internal_user u SET password_hash = crypt($2, gen_salt('bf', 10)), password_changed_at = clock_timestamp(), updated_at = now()
          FROM client c
          WHERE c.client_id = u.tenant_id AND u.login = $1 AND u.status = 'active' AND c.status = 'active'
            AND EXISTS (SELECT 1 FROM user_role ur WHERE ur.user_id = u.user_id AND ur.tenant_id = u.tenant_id)
          RETURNING u.user_id, u.tenant_id`, [row.login, password]);
      // Cuenta suspendida después de pedir el enlace: el token queda consumido y la respuesta es neutra.
      if (changed.rows.length === 0) return { kind: 'invalid' };
      const revoked = await client.query(
        `UPDATE session_context SET revoked_at = now() WHERE user_id = ANY($1::text[]) AND revoked_at IS NULL`,
        [changed.rows.map((a) => a.user_id)]);
      for (const a of changed.rows) {
        await this.sink.write({
          tenant_id: a.tenant_id, actor_id: a.user_id, actor_role: null, action: 'auth.password.reset',
          resource: `password_reset/${row.reset_id}`, request_id: input.requestId, decision: 'allow', result: 'password_changed',
        }, client, true);
      }
      return { kind: 'ok', accounts: changed.rows.length, sessions_revoked: revoked.rowCount ?? 0 };
    });
    if (outcome.kind === 'invalid') {
      await this.sink.write({
        tenant_id: UNKNOWN_TENANT_ID, actor_id: UNKNOWN_ACTOR_ID, actor_role: null, action: 'auth.password.reset',
        resource: '/api/auth/password/reset', request_id: input.requestId, decision: 'deny', result: 'invalid_link',
      }, this.pool, false);
      throw new AppError(404, DENY_CODES.NOT_FOUND, RESET_INVALID_MESSAGE);
    }
    log.info('auth.password.reset.ok', 'contraseña restablecida y sesiones revocadas', { accounts: outcome.accounts, sessions_revoked: outcome.sessions_revoked });
    return outcome;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Cuerpo del correo (español, sin contraseña ni datos del negocio). */
export function passwordResetMail(to: string, link: string): { to: string; subject: string; text: string; html: string } {
  const subject = 'Crea una contraseña nueva para MainSpot';
  const text = [
    'Hola:',
    '',
    'Recibimos una solicitud para crear una contraseña nueva en MainSpot.',
    '',
    `Abre este enlace para elegirla (sirve una sola vez y vence en ${PASSWORD_RESET_TTL_MINUTES} minutos):`,
    link,
    '',
    'Si no pediste este cambio, ignora este mensaje: tu contraseña sigue igual.',
    '',
    'MainSpot',
  ].join('\n');
  const safeLink = escapeHtml(link);
  const html = `<p>Hola:</p><p>Recibimos una solicitud para crear una contraseña nueva en MainSpot.</p>` +
    `<p>Abre este enlace para elegirla (sirve una sola vez y vence en ${PASSWORD_RESET_TTL_MINUTES} minutos):<br><a href="${safeLink}">${safeLink}</a></p>` +
    `<p>Si no pediste este cambio, ignora este mensaje: tu contraseña sigue igual.</p><p>MainSpot</p>`;
  return { to, subject, text, html };
}
