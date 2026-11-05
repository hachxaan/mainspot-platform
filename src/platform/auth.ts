/**
 * Identidad de plataforma (FR-0018, BR-0007, SEC-0001): tablas, clave HMAC y audiencia propias.
 * Un token de negocio nunca es válido aquí (firma con otra clave derivada) y viceversa.
 *
 * - Contraseña (pgcrypto bcrypt) + TOTP (RFC 6238, SHA-1, 30 s, 6 dígitos, ventana ±1) con
 *   anti-replay del paso usado. El secreto TOTP se guarda cifrado (SecretBox, AAD propia).
 * - Sesión corta (PLATFORM_SESSION_TTL_MINUTES) revocable; step-up = TOTP reciente (10 min) para
 *   acciones de alto impacto. Login (por IP + login) y step-up (por platform_user_id): 5 fallos en
 *   15 min ⇒ 429 y no se acepta ningún código hasta que venzan. Contador compartido en PostgreSQL.
 * - Toda decisión (allow/deny) queda en platform_audit_event (append-only) con el request_id del
 *   servidor (nunca una cabecera del cliente) y, en las denegaciones, el PATRÓN de la ruta: una fila
 *   sin tenant no puede llevar ids de negocios (la anonimización no la re-etiqueta, DEC-0027).
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { SecretBox } from '../connectors/secret-box.ts';
import { getRequestContext } from '../shared/context.ts';
import { runTransaction } from '../db/pool.ts';
import { AppError } from '../shared/errors.ts';
import { log } from '../shared/logger.ts';

export const PLATFORM_ROLES = ['platform_admin', 'ai_engineer', 'platform_support'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export const STEP_UP_WINDOW_MS = 10 * 60_000;
/** Login (por IP + login) y step-up (por usuario): intentos por ventana móvil; 0035 impone el mismo tope (CHECK). */
const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_MS = 15 * 60_000;
/**
 * bcrypt (coste 10, el de createUser) de un valor aleatorio que nadie conoce: un login inexistente paga la misma
 * comparación que uno existente, así el tiempo de respuesta no revela qué logins existen.
 */
const NO_SUCH_USER_HASH = '$2a$10$YPQsHGm5P5HD3/h/P9eLbukBi2sYSoKrx587p72Jft1YZHLjkrUh.';

/**
 * Huella de una clave de platform_auth_attempt_gate: HMAC-SHA256 con una clave DERIVADA de JWT_SECRET solo para
 * este uso (como platformKey para las sesiones). Todos los procesos deben compartir JWT_SECRET; rotarlo reinicia
 * los contadores.
 */
export function attemptKeyHash(jwtSecret: string, key: string): string {
  const attemptsKey = createHmac('sha256', jwtSecret).update('mainspot-platform-auth-attempts-v1').digest();
  return createHmac('sha256', attemptsKey).update(key).digest('hex');
}

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

export interface PlatformAuditInput {
  actorId: string; actorRoles: string[]; action: string; resource?: string | null; tenantId?: string | null;
  decision: 'allow' | 'deny'; result?: string | null; reason?: string | null;
  /** Por omisión, el request_id del servidor de la petición en curso (`serverRequestId`). */
  requestId?: string | null;
}

/** request_id que generó el servidor para la petición en curso (middleware `requestContext`); nunca una cabecera del cliente. */
export function serverRequestId(req?: Request): string | null {
  return getRequestContext()?.request_id ?? (req as (Request & { request_id?: string }) | undefined)?.request_id ?? null;
}

/** Longitud en caracteres reales (puntos de código), la misma que cuenta `length()` en PostgreSQL. */
export function charLength(text: string): number {
  return [...text].length;
}

/** Recorta a `max` caracteres reales: nunca parte un carácter en dos mitades. */
function clip(text: string | null | undefined, max: number): string | null {
  return text === null || text === undefined ? null : [...text].slice(0, max).join('');
}

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/** Caracteres de control o de formato (U+0000, saltos, espacios de ancho cero, marcas bidi…): invisibles o engañosos. */
export function hasControlOrFormat(text: string): boolean {
  return CONTROL_OR_FORMAT.test(text);
}

/**
 * Datos de un negocio (correos, ids `client_…`) que no pueden quedar en textos de plataforma: muchos quedan en
 * filas sin negocio o inmutables (auditoría de plataforma, catálogo, presupuestos, revisiones manuales) que la
 * anonimización no puede re-etiquetar (DEC-0027). Slugs, subdominios y nombres no se detectan por patrón (R4).
 */
const TENANT_DATA = /[^\s@]+@[^\s@]+\.[^\s@]+|\bclient_[a-z0-9_]+/iu;

export function assertNoTenantData(text: string, field: string): void {
  if (TENANT_DATA.test(text)) {
    throw new AppError(400, 'validation_error',
      `No incluyas datos de negocios (correos ni identificadores client_…) en ${field}: queda en un historial permanente.`);
  }
}

/** Motivo de una acción de plataforma: de 10 a 500 caracteres reales, sin caracteres de control ni de formato ni datos de negocios. */
export function assertPlatformReason(reason: unknown): string {
  const r = typeof reason === 'string' ? reason.trim() : '';
  const length = charLength(r);
  if (length < 10 || length > 500) throw new AppError(400, 'validation_error', 'Escribe el motivo (10 a 500 caracteres).');
  if (hasControlOrFormat(r)) {
    throw new AppError(400, 'validation_error', 'El motivo tiene caracteres invisibles o de control. Escríbelo de nuevo sin pegarlo de otro documento.');
  }
  assertNoTenantData(r, 'el motivo');
  return r;
}

export async function writePlatformAudit(db: Pool | PoolClient, e: PlatformAuditInput): Promise<void> {
  await db.query(
    `INSERT INTO platform_audit_event (event_id, actor_id, actor_roles, action, resource, tenant_id, decision, result, reason, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [`pae_${randomUUID()}`, e.actorId, e.actorRoles, e.action, e.resource ?? null, e.tenantId ?? null, e.decision,
      clip(e.result, 200), clip(e.reason, 500), e.requestId ?? serverRequestId()]);
}

export class PlatformAuth {
  private readonly pool: Pool;
  private readonly box: SecretBox | null;
  private readonly jwtSecret: string;
  private readonly ttlMinutes: number;
  // Failed login and TOTP attempts are shared by every process of the app through PostgreSQL (0035).
  // A transactional row lock serializes the check AND the reservation. Any database error fails closed.
  private attemptHash(key: string): string {
    return attemptKeyHash(this.jwtSecret, key);
  }

  /**
   * Transaction over platform_auth_attempt_gate with bounded waits: a process that stalls while holding a key's
   * row lock makes the others fail closed after 5 s (55P03) instead of waiting forever, no statement runs longer
   * than 10 s, and PostgreSQL ends a session left idle inside the transaction after 15 s, releasing the lock.
   * A lost connection fails the attempt, never the process (runTransaction).
   */
  private gateTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runTransaction(this.pool, async (client) => {
      await client.query(`SELECT set_config('lock_timeout', '5s', true), set_config('statement_timeout', '10s', true),
                                 set_config('idle_in_transaction_session_timeout', '15s', true)`);
      return fn(client);
    });
  }

  private async reserveAttempt(key: string): Promise<boolean> {
    const keyHash = this.attemptHash(key);
    // Fast path: a key that is already full is denied with one read and no write. A deny is never unsafe; an
    // allow is only ever decided below, under the row lock.
    const peek = await this.pool.query<{ live: number }>(
      `SELECT count(*)::int AS live FROM platform_auth_attempt_gate g, unnest(g.attempt_times) t
        WHERE g.key_hash = $1 AND t > clock_timestamp() - make_interval(secs => $2)`, [keyHash, ATTEMPT_WINDOW_MS / 1000]);
    if ((peek.rows[0]?.live ?? 0) >= ATTEMPT_LIMIT) return false;
    const allowed = await this.gateTransaction(async (client) => {
      // The upsert ALWAYS locks the key's row, also when a concurrent prune has just deleted it (ON CONFLICT
      // retries the insert), so there is no window between "row exists" and "row locked".
      const r = await client.query<{ attempt_times: Date[]; db_now: Date }>(
        `INSERT INTO platform_auth_attempt_gate AS g (key_hash) VALUES ($1)
         ON CONFLICT (key_hash) DO UPDATE SET updated_at = g.updated_at
         RETURNING g.attempt_times, clock_timestamp() AS db_now`, [keyHash]);
      const row = r.rows[0];
      if (!row) throw new Error('platform authentication attempt gate: upsert returned no row');
      const now = new Date(row.db_now).getTime();
      const live = row.attempt_times.map((v) => new Date(v)).filter((v) => v.getTime() > now - ATTEMPT_WINDOW_MS);
      if (live.length >= ATTEMPT_LIMIT) return false;
      await client.query(
        `UPDATE platform_auth_attempt_gate SET attempt_times = $2::timestamptz[], updated_at = clock_timestamp() WHERE key_hash = $1`,
        [keyHash, [...live, new Date(now)].map((v) => v.toISOString())]);
      return true;
    });
    if (allowed) {
      // Best-effort expiration (after the transaction: pool.max may be 1); it can never grant access. SKIP LOCKED:
      // it never waits for, nor deletes, a key that a reservation is holding. updated_at is the last reserved
      // attempt, so a row older than the window has no live attempt.
      await this.pool.query(
        `DELETE FROM platform_auth_attempt_gate WHERE key_hash IN
           (SELECT key_hash FROM platform_auth_attempt_gate
             WHERE updated_at < clock_timestamp() - make_interval(secs => $1)
             ORDER BY updated_at LIMIT 25 FOR UPDATE SKIP LOCKED)`, [ATTEMPT_WINDOW_MS / 1000],
      ).catch(() => undefined);
    }
    return allowed;
  }

  private async clearAttempts(key: string): Promise<void> {
    const keyHash = this.attemptHash(key);
    await this.gateTransaction((client) => client.query('DELETE FROM platform_auth_attempt_gate WHERE key_hash = $1', [keyHash]));
  }

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

  /**
   * Contraseña + TOTP. Respuesta idéntica ante cualquier fallo (anti-oráculo), también en el tiempo: un login
   * inexistente compara contra NO_SUCH_USER_HASH. Un fallo se audita con el operador al que corresponde el login
   * (`platform_user_id`) o con `login:unknown`: el texto tecleado nunca se guarda (podría ser el correo o el id de
   * un negocio y bloquear su anonimización).
   */
  async login(loginName: string, password: string, code: string, ip: string): Promise<{ token: string; session: PlatformSession }> {
    const box = this.requireBox();
    const key = `${ip}|${loginName.toLowerCase()}`;
    if (!(await this.reserveAttempt(`login:${key}`))) throw new AppError(429, 'validation_error', 'Demasiados intentos. Espera unos minutos.');
    const denied = async (reason: string, platformUserId: string | null) => {
      await writePlatformAudit(this.pool, { actorId: platformUserId ?? 'login:unknown', actorRoles: [], action: 'platform.login', decision: 'deny', result: reason });
      return new AppError(401, 'invalid_credentials', 'Usuario, contraseña o código incorrectos.');
    };
    const r = await this.pool.query<{ platform_user_id: string | null; totp_box: Buffer; totp_last_step: string; status: string; display_name: string; ok: boolean }>(
      `SELECT u.platform_user_id, u.totp_box, u.totp_last_step, u.status, u.display_name,
              (COALESCE(u.password_hash, $3) = crypt($2, COALESCE(u.password_hash, $3)) AND u.platform_user_id IS NOT NULL) AS ok
         FROM (SELECT 1) AS probe LEFT JOIN platform_user u ON u.login = $1`, [loginName.toLowerCase(), password, NO_SUCH_USER_HASH]);
    const user = r.rows[0];
    if (!user?.platform_user_id) throw await denied('bad_password_or_user', null);
    if (!user.ok || user.status !== 'active') throw await denied('bad_password_or_user', user.platform_user_id);
    const secret = box.open(user.totp_box, this.ctx(user.platform_user_id));
    const step = verifyTotp(secret, code, Number(user.totp_last_step));
    if (step === null) throw await denied('bad_totp', user.platform_user_id);
    // Anti-replay: el paso solo avanza (UPDATE condicional); un mismo código no sirve dos veces.
    const upd = await this.pool.query('UPDATE platform_user SET totp_last_step = $2 WHERE platform_user_id = $1 AND totp_last_step < $2', [user.platform_user_id, step]);
    if (!upd.rowCount) throw await denied('totp_replay', user.platform_user_id);
    const roles = (await this.pool.query<{ role: PlatformRole }>('SELECT role FROM platform_user_role WHERE platform_user_id = $1 ORDER BY role', [user.platform_user_id])).rows.map((x) => x.role);
    const sid = `ps_${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO platform_session (session_id, platform_user_id, roles, expires_at, mfa_at, step_up_at)
       VALUES ($1,$2,$3, now() + make_interval(mins => $4), now(), now())`, [sid, user.platform_user_id, roles, this.ttlMinutes]);
    await this.clearAttempts(`login:${key}`);
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

  /** TOTP reciente para acciones de alto impacto. 5 fallos en 15 min ⇒ 429 (auditado) y no se acepta ningún código. */
  async stepUp(session: PlatformSession, code: string): Promise<void> {
    const box = this.requireBox();
    const key = `step_up:${session.platform_user_id}`;
    const audit = (decision: 'allow' | 'deny', result: string) =>
      writePlatformAudit(this.pool, { actorId: session.platform_user_id, actorRoles: session.roles, action: 'platform.step_up', decision, result });
    if (!(await this.reserveAttempt(key))) {
      await audit('deny', 'too_many_attempts');
      throw new AppError(429, 'validation_error', 'Demasiados intentos. Espera unos minutos.');
    }
    // Reserva atómica en PostgreSQL ANTES de verificar: varios procesos comparten el mismo límite.
    const r = await this.pool.query<{ totp_box: Buffer; totp_last_step: string }>('SELECT totp_box, totp_last_step FROM platform_user WHERE platform_user_id = $1', [session.platform_user_id]);
    const row = r.rows[0];
    const step = row ? verifyTotp(box.open(row.totp_box, this.ctx(session.platform_user_id)), code, Number(row.totp_last_step)) : null;
    const upd = step === null ? null : await this.pool.query('UPDATE platform_user SET totp_last_step = $2 WHERE platform_user_id = $1 AND totp_last_step < $2', [session.platform_user_id, step]);
    if (!upd?.rowCount) {
      await audit('deny', 'bad_totp');
      throw new AppError(401, 'invalid_credentials', 'Código incorrecto.');
    }
    await this.clearAttempts(key);
    await this.pool.query('UPDATE platform_session SET step_up_at = now() WHERE session_id = $1', [session.session_id]);
    await audit('allow', 'ok');
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

/** Patrón de la ruta (`/api/platform/tenants/:id/plan`): una denegación nunca guarda ids de negocios sin tenant (DEC-0027). */
function routePattern(req: Request): string | null {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? `${req.baseUrl}${path}` : null;
}

/** Middleware: sesión de plataforma válida + rol + (opcional) step-up reciente. Deny auditado con el patrón de la ruta. */
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
        await writePlatformAudit(pool, { actorId: session.platform_user_id, actorRoles: session.roles, action: opts.action, decision: 'deny', result: 'role_denied', resource: routePattern(req) });
        res.status(403).json({ error: { code: 'permission_denied', message: 'Tu rol de plataforma no permite esta acción.' } });
        return;
      }
      if (opts.stepUp && (!session.step_up_at || Date.now() - new Date(session.step_up_at).getTime() > STEP_UP_WINDOW_MS)) {
        await writePlatformAudit(pool, { actorId: session.platform_user_id, actorRoles: session.roles, action: opts.action, decision: 'deny', result: 'step_up_required', resource: routePattern(req) });
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
