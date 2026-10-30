/**
 * Identidad de plataforma (FR-0018, BR-0007, SEC-0001): tablas, clave HMAC y audiencia propias.
 * Un token de negocio nunca es válido aquí (firma con otra clave derivada) y viceversa.
 *
 * - Contraseña (pgcrypto bcrypt) + TOTP (RFC 6238, SHA-1, 30 s, 6 dígitos, ventana ±1) con
 *   anti-replay del paso usado. El secreto TOTP se guarda cifrado (SecretBox, AAD propia).
 * - Sesión corta (PLATFORM_SESSION_TTL_MINUTES) revocable; step-up = TOTP reciente (10 min) para
 *   acciones de alto impacto.
 * - Toda decisión (allow/deny) queda en platform_audit_event (append-only).
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { SecretBox } from '../connectors/secret-box.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';

export const PLATFORM_ROLES = ['platform_admin', 'ai_engineer', 'platform_support'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export const STEP_UP_WINDOW_MS = 10 * 60_000;

// ------------------------------------------------------------------ TOTP (RFC 6238 / RFC 4648)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpAt(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const code = ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 30_000);
}

/** Devuelve el paso aceptado (para anti-replay) o null. */
export function verifyTotp(secretB32: string, code: string, lastStep: number, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = currentStep(now);
  for (const s of [step - 1, step, step + 1]) {
    if (s <= lastStep) continue;
    const expected = Buffer.from(totpAt(secretB32, s));
    if (timingSafeEqual(expected, Buffer.from(code))) return s;
  }
  return null;
}

// ------------------------------------------------------------------ token de plataforma

interface PlatformClaims { sid: string; uid: string; aud: 'platform'; iat: number; exp: number }

function platformKey(jwtSecret: string): Buffer {
  return createHmac('sha256', jwtSecret).update('mainspot-platform-session-v1').digest();
}
const b64 = (v: Buffer | string) => Buffer.from(v).toString('base64url');

export function signPlatformToken(claims: Omit<PlatformClaims, 'iat' | 'exp' | 'aud'>, jwtSecret: string, ttlMinutes: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64(JSON.stringify({ ...claims, aud: 'platform', iat: now, exp: now + ttlMinutes * 60 }));
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'platform-v1' }));
  const sig = createHmac('sha256', platformKey(jwtSecret)).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyPlatformToken(token: string, jwtSecret: string): PlatformClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', platformKey(jwtSecret)).update(`${header}.${payload}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PlatformClaims;
    if (claims.aud !== 'platform' || typeof claims.sid !== 'string' || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ servicio

export interface PlatformSession {
  session_id: string; platform_user_id: string; login: string; display_name: string; roles: PlatformRole[];
  issued_at: string; expires_at: string; mfa_at: string; step_up_at: string | null;
}

export interface PlatformAuditInput { actorId: string; actorRoles: string[]; action: string; resource?: string | null; tenantId?: string | null; decision: 'allow' | 'deny'; result?: string | null; reason?: string | null; requestId?: string | null }

export async function writePlatformAudit(db: Pool | PoolClient, e: PlatformAuditInput): Promise<void> {
  await db.query(
    `INSERT INTO platform_audit_event (event_id, actor_id, actor_roles, action, resource, tenant_id, decision, result, reason, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [`pae_${randomUUID()}`, e.actorId, e.actorRoles, e.action, e.resource ?? null, e.tenantId ?? null, e.decision, e.result?.slice(0, 200) ?? null, e.reason?.slice(0, 500) ?? null, e.requestId ?? null]);
}

export class PlatformAuth {
  private readonly pool: Pool;
  private readonly box: SecretBox | null;
  private readonly jwtSecret: string;
  private readonly ttlMinutes: number;
  private readonly attempts = new Map<string, number[]>();

  constructor(deps: { pool: Pool; mfaKey: string; jwtSecret: string; ttlMinutes: number }) {
    this.pool = deps.pool;
    this.box = deps.mfaKey ? SecretBox.fromBase64(deps.mfaKey) : null;
    this.jwtSecret = deps.jwtSecret;
    this.ttlMinutes = deps.ttlMinutes;
  }

  get enabled(): boolean {
    return this.box !== null;
  }

  private requireBox(): SecretBox {
    if (!this.box) throw new AppError(503, 'internal_error', 'La consola de plataforma no está configurada (falta PLATFORM_MFA_KEY).');
    return this.box;
  }

  private ctx(userId: string) {
    return { tenantId: 'platform', provider: 'platform_mfa', purpose: `totp:${userId}` };
  }

  /** Alta por CLI de operación: devuelve el secreto TOTP UNA sola vez. */
  async createUser(input: { login: string; displayName: string; password: string; roles: PlatformRole[]; grantedBy: string }): Promise<{ platform_user_id: string; totp_secret: string; otpauth_uri: string }> {
    const box = this.requireBox();
    if (!/^[a-z0-9._@-]{3,80}$/i.test(input.login)) throw new AppError(400, 'validation_error', 'Login inválido.');
    if (input.password.length < 14) throw new AppError(400, 'validation_error', 'La contraseña de plataforma necesita al menos 14 caracteres.');
    if (!input.roles.length || input.roles.some((r) => !PLATFORM_ROLES.includes(r))) throw new AppError(400, 'validation_error', 'Roles de plataforma inválidos.');
    const id = `pu_${randomUUID()}`;
    const secret = base32Encode(randomBytes(20));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO platform_user (platform_user_id, login, display_name, password_hash, totp_box)
         VALUES ($1,$2,$3,crypt($4, gen_salt('bf', 10)),$5)`,
        [id, input.login.toLowerCase(), input.displayName, input.password, box.seal(secret, this.ctx(id))]);
      for (const role of input.roles) {
        await client.query('INSERT INTO platform_user_role (platform_user_id, role, granted_by) VALUES ($1,$2,$3)', [id, role, input.grantedBy]);
      }
      await writePlatformAudit(client, { actorId: input.grantedBy, actorRoles: [], action: 'platform.user.created', resource: `platform_user/${id}`, decision: 'allow', result: input.roles.join(',') });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    const uri = `otpauth://totp/MainSpot%20Plataforma:${encodeURIComponent(input.login)}?secret=${secret}&issuer=MainSpot%20Plataforma&digits=6&period=30`;
    return { platform_user_id: id, totp_secret: secret, otpauth_uri: uri };
  }

  private limited(key: string): boolean {
    const now = Date.now();
    const list = (this.attempts.get(key) ?? []).filter((t) => now - t < 15 * 60_000);
    this.attempts.set(key, list);
    return list.length >= 5;
  }
  private fail(key: string): void {
    const list = this.attempts.get(key) ?? [];
    list.push(Date.now());
    this.attempts.set(key, list);
  }

  /** Contraseña + TOTP. Respuesta idéntica ante cualquier fallo (anti-oráculo). */
  async login(loginName: string, password: string, code: string, ip: string): Promise<{ token: string; session: PlatformSession }> {
    const box = this.requireBox();
    const key = `${ip}|${loginName.toLowerCase()}`;
    if (this.limited(key)) throw new AppError(429, 'validation_error', 'Demasiados intentos. Espera unos minutos.');
    const denied = async (reason: string) => {
      this.fail(key);
      await writePlatformAudit(this.pool, { actorId: `login:${loginName.toLowerCase().slice(0, 80)}`, actorRoles: [], action: 'platform.login', decision: 'deny', result: reason });
      return new AppError(401, 'invalid_credentials', 'Usuario, contraseña o código incorrectos.');
    };
    const r = await this.pool.query<{ platform_user_id: string; totp_box: Buffer; totp_last_step: string; status: string; display_name: string; ok: boolean }>(
      `SELECT platform_user_id, totp_box, totp_last_step, status, display_name, (password_hash = crypt($2, password_hash)) AS ok
         FROM platform_user WHERE login = $1`, [loginName.toLowerCase(), password]);
    const user = r.rows[0];
    if (!user || !user.ok || user.status !== 'active') throw await denied('bad_password_or_user');
    const secret = box.open(user.totp_box, this.ctx(user.platform_user_id));
    const step = verifyTotp(secret, code, Number(user.totp_last_step));
    if (step === null) throw await denied('bad_totp');
    // Anti-replay: el paso solo avanza (UPDATE condicional); un mismo código no sirve dos veces.
    const upd = await this.pool.query('UPDATE platform_user SET totp_last_step = $2 WHERE platform_user_id = $1 AND totp_last_step < $2', [user.platform_user_id, step]);
    if (!upd.rowCount) throw await denied('totp_replay');
    const roles = (await this.pool.query<{ role: PlatformRole }>('SELECT role FROM platform_user_role WHERE platform_user_id = $1 ORDER BY role', [user.platform_user_id])).rows.map((x) => x.role);
    const sid = `ps_${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO platform_session (session_id, platform_user_id, roles, expires_at, mfa_at, step_up_at)
       VALUES ($1,$2,$3, now() + make_interval(mins => $4), now(), now())`, [sid, user.platform_user_id, roles, this.ttlMinutes]);
    this.attempts.delete(key);
    await writePlatformAudit(this.pool, { actorId: user.platform_user_id, actorRoles: roles, action: 'platform.login', decision: 'allow', result: 'mfa_ok' });
    const token = signPlatformToken({ sid, uid: user.platform_user_id }, this.jwtSecret, this.ttlMinutes);
    const session = await this.sessionById(sid);
    return { token, session: session as PlatformSession };
  }

  async sessionById(sid: string): Promise<PlatformSession | null> {
    const r = await this.pool.query<PlatformSession>(
      `SELECT s.session_id, s.platform_user_id, u.login, u.display_name, s.roles, s.issued_at, s.expires_at, s.mfa_at, s.step_up_at
         FROM platform_session s JOIN platform_user u ON u.platform_user_id = s.platform_user_id
        WHERE s.session_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`, [sid]);
    return r.rows[0] ?? null;
  }

  async resolve(header: string | undefined): Promise<PlatformSession | null> {
    const m = /^Bearer\s+(.+)$/i.exec((header ?? '').trim());
    if (!m?.[1]) return null;
    const claims = verifyPlatformToken(m[1], this.jwtSecret);
    if (!claims) return null;
    const s = await this.sessionById(claims.sid);
    return s && s.platform_user_id === claims.uid ? s : null;
  }

  async stepUp(session: PlatformSession, code: string): Promise<void> {
    const box = this.requireBox();
    const r = await this.pool.query<{ totp_box: Buffer; totp_last_step: string }>('SELECT totp_box, totp_last_step FROM platform_user WHERE platform_user_id = $1', [session.platform_user_id]);
    const row = r.rows[0];
    const step = row ? verifyTotp(box.open(row.totp_box, this.ctx(session.platform_user_id)), code, Number(row.totp_last_step)) : null;
    const upd = step === null ? null : await this.pool.query('UPDATE platform_user SET totp_last_step = $2 WHERE platform_user_id = $1 AND totp_last_step < $2', [session.platform_user_id, step]);
    if (!upd?.rowCount) {
      await writePlatformAudit(this.pool, { actorId: session.platform_user_id, actorRoles: session.roles, action: 'platform.step_up', decision: 'deny', result: 'bad_totp' });
      throw new AppError(401, 'invalid_credentials', 'Código incorrecto.');
    }
    await this.pool.query('UPDATE platform_session SET step_up_at = now() WHERE session_id = $1', [session.session_id]);
    await writePlatformAudit(this.pool, { actorId: session.platform_user_id, actorRoles: session.roles, action: 'platform.step_up', decision: 'allow', result: 'ok' });
  }

  async logout(session: PlatformSession): Promise<void> {
    await this.pool.query('UPDATE platform_session SET revoked_at = now() WHERE session_id = $1', [session.session_id]);
    await writePlatformAudit(this.pool, { actorId: session.platform_user_id, actorRoles: session.roles, action: 'platform.logout', decision: 'allow' });
  }
}

export interface PlatformRequest extends Request {
  platform?: PlatformSession;
  requestId?: string;
}

/** Middleware: sesión de plataforma válida + rol + (opcional) step-up reciente. Deny auditado. */
export function requirePlatform(auth: PlatformAuth, pool: Pool, roles: PlatformRole[], opts: { stepUp?: boolean; action: string }) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const preq = req as PlatformRequest;
      const session = preq.platform ?? await auth.resolve(req.headers.authorization);
      if (!session) {
        res.status(401).json({ error: { code: 'missing_actor', message: 'Inicia sesión en la consola de plataforma.' } });
        return;
      }
      preq.platform = session;
      if (!session.roles.some((r) => roles.includes(r))) {
        await writePlatformAudit(pool, { actorId: session.platform_user_id, actorRoles: session.roles, action: opts.action, decision: 'deny', result: 'role_denied', resource: req.path });
        res.status(403).json({ error: { code: 'permission_denied', message: 'Tu rol de plataforma no permite esta acción.' } });
        return;
      }
      if (opts.stepUp && (!session.step_up_at || Date.now() - new Date(session.step_up_at).getTime() > STEP_UP_WINDOW_MS)) {
        await writePlatformAudit(pool, { actorId: session.platform_user_id, actorRoles: session.roles, action: opts.action, decision: 'deny', result: 'step_up_required', resource: req.path });
        res.status(403).json({ error: { code: 'step_up_required', message: 'Confirma con tu código de verificación para continuar.' } });
        return;
      }
      next();
    } catch (err) {
      log.warn('platform.auth.error', 'platform authorization failed', { error_name: err instanceof Error ? err.name : 'unknown' });
      next(err);
    }
  };
}
