import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, extractBearerToken, JwtError, signSessionToken, verifySessionToken } from '../../src/shared/jwt.ts';

const SECRET = 'test-secret';

test('unit: JWT roundtrip sign/verify', () => {
  const token = signSessionToken({ sid: 'sess_1', uid: 'user_a_admin', tid: 'client_a', rol: 'administration' }, SECRET, 60);
  const claims = verifySessionToken(token, SECRET);
  assert.equal(claims.sid, 'sess_1');
  assert.equal(claims.uid, 'user_a_admin');
  assert.equal(claims.tid, 'client_a');
  assert.equal(claims.rol, 'administration');
  assert.ok(claims.exp > claims.iat);
});

test('unit: JWT tampered payload is rejected', () => {
  const token = signSessionToken({ sid: 'sess_1', uid: 'u1', tid: 'client_a', rol: 'administration' }, SECRET, 60);
  const parts = token.split('.');
  const payload = Buffer.from(JSON.stringify({ sid: 'sess_2', uid: 'u1', tid: 'client_a', rol: 'administration' })).toString('base64url');
  const tampered = `${parts[0]}.${payload}.${parts[2]}`;
  assert.throws(() => verifySessionToken(tampered, SECRET), JwtError);
});

test('unit: JWT wrong secret is rejected', () => {
  const token = signSessionToken({ sid: 'sess_1', uid: 'u1', tid: 'client_a', rol: 'administration' }, SECRET, 60);
  assert.throws(() => verifySessionToken(token, 'other-secret'), JwtError);
});

test('unit: JWT expired token is rejected', () => {
  const claims = { sid: 'sess_1', uid: 'u1', tid: 'client_a', rol: 'administration', iat: 1, exp: 1 };
  const token = encode(claims, SECRET);
  assert.throws(() => verifySessionToken(token, SECRET), JwtError);
});

test('unit: extractBearerToken parses Authorization header', () => {
  assert.equal(extractBearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(extractBearerToken('bearer abc'), 'abc');
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken('Basic abc'), null);
});

test('IR-13 unit: algorithm is pinned to HS256 (none/others rejected)', () => {
  const clear = (c: { alg: string; typ: string }) => Buffer.from(JSON.stringify(c)).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sid: 's', uid: 'u', tid: 't', rol: 'administration', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  const noneToken = `${clear({ alg: 'none', typ: 'JWT' })}.${p}.`;
  assert.throws(() => verifySessionToken(noneToken, SECRET), JwtError);
  const hs512Token = `${clear({ alg: 'HS512', typ: 'JWT' })}.${p}.${'x'}`;
  assert.throws(() => verifySessionToken(hs512Token, SECRET), /unsupported algorithm/);
});
