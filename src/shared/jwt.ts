/**
 * Minimal own HS256 JWT implementation (DEC-022: "sesión/JWT propio mínimo").
 *
 * TENTATIVA — validated for the pilot; deliberately small, no external
 * dependency. The token is a signed reference to a server-side session row
 * (session_context), which keeps revocation possible. Standard HMAC-SHA256 via
 * node:crypto; no novel crypto invented here.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtClaims {
  /** session_context.session_id */
  sid: string;
  /** internal_user.user_id */
  uid: string;
  /** client.client_id (tenant) */
  tid: string;
  /** role.role_id */
  rol: string;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Sign a session-reference token. */
export function signSessionToken(claims: Omit<JwtClaims, 'iat' | 'exp'>, secret: string, ttlMinutes: number): string {
  const now = Math.floor(Date.now() / 1000);
  const full: JwtClaims = { ...claims, iat: now, exp: now + ttlMinutes * 60 };
  return encode(full, secret);
}

export function encode(claims: JwtClaims, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const sig = signPayload(`${header}.${payload}`, secret);
  return `${header}.${payload}.${sig}`;
}

export class JwtError extends Error {}

/** Verify signature + expiry; returns parsed claims. Throws JwtError on any failure. */
export function verifySessionToken(token: string, secret: string): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  const [header, payload, sig] = parts as [string, string, string];

  const expectedSig = signPayload(`${header}.${payload}`, secret);

  let actual: Buffer;
  let expected: Buffer;
  try {
    actual = Buffer.from(sig ?? '', 'base64url');
    expected = Buffer.from(expectedSig, 'base64url');
  } catch {
    throw new JwtError('invalid token encoding');
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new JwtError('invalid signature');
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(b64urlDecode(payload).toString('utf8')) as JwtClaims;
  } catch {
    throw new JwtError('invalid payload');
  }

  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new JwtError('token expired');
  }
  if (!claims.sid || !claims.uid || !claims.tid || !claims.rol) {
    throw new JwtError('token missing required claims');
  }
  return claims;
}

/** Extract the token from an Authorization header ("Bearer <token>"). */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
