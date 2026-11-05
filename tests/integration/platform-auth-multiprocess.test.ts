/**
 * G-SEC (PR #14, migración 0035) — límites de login y step-up de plataforma con PROCESOS reales: cada
 * `tests/helpers/platform-auth-worker.ts` es un proceso Node con el pool de la aplicación (src/db/pool.ts), como
 * varias instancias detrás de un balanceador. Las órdenes se disparan en el mismo instante en todos.
 *  - 5 intentos por clave en 15 min, compartidos entre procesos (ni más 401 ni menos 429 bajo ráfagas); el
 *    login tecleado no queda en ninguna parte;
 *  - anti-replay TOTP: el mismo código válido en ráfaga desde varios procesos autentica exactamente una vez;
 *  - step-up: bloqueado, ni el código válido pasa; al vencer la ventana pasa y limpia el contador;
 *  - el contador sobrevive a que un proceso muera (SIGKILL) y a uno nuevo;
 *  - PostgreSQL inalcanzable (proxy TCP cortado), un bloqueo retenido sobre la fila o una conexión terminada
 *    (inactiva o dentro de la transacción del límite): falla cerrado (500), nunca autentica ni consume el
 *    código, el PROCESO sigue vivo y vuelve a funcionar al restablecerse.
 * El reinicio REAL del servidor PostgreSQL no se hace aquí (la BD de prueba puede ser compartida); su evidencia
 * está en evidence/plan-catalog/gates-pr14/.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PlatformAuth, attemptKeyHash, currentStep, totpAt, type PlatformSession } from '../../src/platform/auth.ts';
import { TEST_URL } from '../helpers/testdb.ts';

const WORKER = fileURLToPath(new URL('../helpers/platform-auth-worker.ts', import.meta.url));
const PASSWORD = 'Multi-Process-Gate-2026';
const mfaKey = randomBytes(32).toString('base64');
const jwtSecret = randomBytes(32).toString('hex');

interface Outcome { status: number; code?: string; ms?: number }
type Call = { login: string; password: string; code: string; ip: string };

class Worker {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (o: Outcome[]) => void>();
  private nextId = 1;
  readonly ready: Promise<void>;
  readonly exited: Promise<void>;

  constructor(databaseUrl: string) {
    this.proc = spawn(process.execPath, [WORKER], {
      env: { ...process.env, WORKER_DATABASE_URL: databaseUrl, WORKER_MFA_KEY: mfaKey, WORKER_JWT_SECRET: jwtSecret },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise((resolve) => this.proc.once('exit', () => resolve()));
    let markReady: () => void = () => undefined;
    this.ready = new Promise((resolve) => { markReady = resolve; });
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      if (!line.startsWith('@@')) return;
      const msg = JSON.parse(line.slice(2)) as { ready?: number; id?: number; outcomes?: Outcome[] };
      if (msg.ready) markReady();
      else if (msg.id !== undefined && msg.outcomes) this.pending.get(msg.id)?.(msg.outcomes);
    });
    this.proc.stderr.resume();
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  get alive(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  private send(cmd: Record<string, unknown>): Promise<Outcome[]> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
    });
  }

  login(calls: Call[], at?: number): Promise<Outcome[]> {
    return this.send({ op: 'login', calls, at });
  }

  /** Como login, con la duración de cada llamada (`ms`). */
  loginTimed(calls: Call[]): Promise<Outcome[]> {
    return this.send({ op: 'login', calls, timed: true });
  }

  stepUp(session: PlatformSession, codes: string[], at?: number): Promise<Outcome[]> {
    return this.send({ op: 'stepUp', session, codes, at });
  }

  holdCheckout(seconds: number): Promise<Outcome[]> {
    return this.send({ op: 'holdCheckout', seconds });
  }

  async kill(): Promise<void> {
    this.proc.kill('SIGKILL');
    await this.exited;
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    await this.exited;
  }
}

/** Proxy TCP hacia PostgreSQL que la prueba puede cortar (sockets destruidos y puerto cerrado) y restablecer. */
class CuttableProxy {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly target: { host: string; port: number };
  port = 0;

  constructor(target: { host: string; port: number }) {
    this.target = target;
  }

  async open(): Promise<void> {
    const server = net.createServer((client) => {
      const upstream = net.connect(this.target.port, this.target.host);
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on('close', () => this.sockets.delete(s));
        s.on('error', () => undefined);
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve));
    this.port = (server.address() as net.AddressInfo).port;
    this.server = server;
  }

  async cut(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

let pool: pg.Pool;
let auth: PlatformAuth;
const workers: Worker[] = [];
const proxies: CuttableProxy[] = [];

before(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL, max: 4 });
  auth = new PlatformAuth({ pool, mfaKey, jwtSecret, ttlMinutes: 30 });
});

after(async () => {
  await Promise.all(workers.map((w) => w.kill().catch(() => undefined)));
  for (const p of proxies) await p.cut().catch(() => undefined);
  await pool.end();
});

async function startWorkers(n: number, databaseUrl = TEST_URL): Promise<Worker[]> {
  const started = Array.from({ length: n }, () => new Worker(databaseUrl));
  workers.push(...started);
  await Promise.all(started.map((w) => w.ready));
  assert.equal(new Set(started.map((w) => w.pid)).size, n, 'procesos distintos');
  return started;
}

const tag = () => randomBytes(4).toString('hex');
const statuses = (outcomes: Outcome[]) => outcomes.map((o) => o.status);
const count = (list: number[], status: number) => list.filter((s) => s === status).length;
/** Instante común de disparo: deja tiempo a que la orden llegue a todos los procesos. */
const soon = () => Date.now() + 300;

function gateKey(key: string): string {
  return attemptKeyHash(jwtSecret, key);
}

/** URL de la BD de prueba con un application_name propio, para localizar las conexiones de un proceso. */
function taggedUrl(name: string): string {
  const url = new URL(TEST_URL);
  url.searchParams.set('application_name', name);
  return url.toString();
}

async function gateAttempts(key: string): Promise<number | null> {
  const r = await pool.query<{ n: number }>('SELECT cardinality(attempt_times) AS n FROM platform_auth_attempt_gate WHERE key_hash = $1', [gateKey(key)]);
  return r.rows[0]?.n ?? null;
}

async function newUser(): Promise<{ id: string; login: string; secret: string }> {
  const login = `mp-${tag()}`;
  const u = await auth.createUser({ login, displayName: 'Multi-process gate', password: PASSWORD, roles: ['platform_admin'], grantedBy: 'test:multiprocess' });
  return { id: u.platform_user_id, login, secret: u.totp_secret };
}

async function sessions(userId: string): Promise<number> {
  return (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM platform_session WHERE platform_user_id = $1', [userId])).rows[0]?.n ?? 0;
}

/** Un código de 6 dígitos que no es válido en ningún paso cercano del secreto. */
function invalidCode(secret: string): string {
  const valid = new Set([-2, -1, 0, 1, 2].map((o) => totpAt(secret, currentStep() + o)));
  const code = Array.from({ length: 100 }, (_, i) => String(i).padStart(6, '0')).find((c) => !valid.has(c));
  assert.ok(code);
  return code;
}

test('login: 3 procesos × 8 intentos simultáneos sobre la misma clave ⇒ exactamente 5 × 401 y 19 × 429, sin login en claro', async () => {
  const ws = await startWorkers(3);
  const login = `mp-absent-${tag()}`;
  const ip = '203.0.113.10';
  const since = (await pool.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]?.t;
  const at = soon();
  const results = (await Promise.all(ws.map((w) => w.login(Array.from({ length: 8 }, () => ({ login, password: 'wrong-password', code: '000000', ip })), at)))).flat();
  const st = statuses(results);
  assert.equal(count(st, 401), 5, JSON.stringify(results));
  assert.equal(count(st, 429), 19, JSON.stringify(results));
  assert.equal(await gateAttempts(`login:${ip}|${login}`), 5);

  const audit = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM platform_audit_event WHERE action = 'platform.login' AND actor_id = 'login:unknown' AND at >= $1`, [since]);
  assert.equal(audit.rows[0]?.n, 5, 'cada 401 se audita, con un actor que no deriva de lo tecleado');
  const clear = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM platform_audit_event WHERE strpos(concat_ws(' ', actor_id, resource, result, reason), $1) > 0`, [login]);
  assert.equal(clear.rows[0]?.n, 0, 'ni la auditoría ni el límite guardan el login tecleado');
  await Promise.all(ws.map((w) => w.close()));
});

test('anti-replay TOTP: el mismo código válido en 12 logins simultáneos desde 3 procesos autentica exactamente una vez', async () => {
  const user = await newUser();
  const ws = await startWorkers(3);
  const step = currentStep();
  const code = totpAt(user.secret, step);
  const at = soon();
  const results = (await Promise.all(ws.map((w, wi) =>
    w.login(Array.from({ length: 4 }, (_, i) => ({ login: user.login, password: PASSWORD, code, ip: `198.51.100.${wi * 10 + i + 1}` })), at)))).flat();
  const st = statuses(results);
  assert.equal(count(st, 200), 1, JSON.stringify(results));
  assert.equal(count(st, 401), 11, JSON.stringify(results));
  assert.equal(await sessions(user.id), 1, 'una sola sesión');
  const last = await pool.query<{ s: string }>('SELECT totp_last_step::text AS s FROM platform_user WHERE platform_user_id = $1', [user.id]);
  assert.ok(Number(last.rows[0]?.s) >= step - 1 && Number(last.rows[0]?.s) <= step + 1);
  await Promise.all(ws.map((w) => w.close()));
});

test('step-up entre procesos: 12 códigos incorrectos ⇒ 5 × 401 y 7 × 429; bloqueado, ni el código válido pasa; al vencer la ventana pasa y limpia', async () => {
  const user = await newUser();
  const signed = await auth.login(user.login, PASSWORD, totpAt(user.secret, currentStep()), '192.0.2.150');
  const usedStep = currentStep();
  const ws = await startWorkers(3);
  const bad = invalidCode(user.secret);
  const at = soon();
  const denied = statuses((await Promise.all(ws.map((w) => w.stepUp(signed.session, [bad, bad, bad, bad], at)))).flat());
  assert.equal(count(denied, 401), 5, JSON.stringify(denied));
  assert.equal(count(denied, 429), 7, JSON.stringify(denied));

  const valid = totpAt(user.secret, usedStep + 1);
  assert.deepEqual(statuses(await ws[0]!.stepUp(signed.session, [valid])), [429], 'bloqueado: el código válido tampoco pasa');
  const tooMany = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM platform_audit_event WHERE actor_id = $1 AND action = 'platform.step_up' AND result = 'too_many_attempts'`, [user.id]);
  assert.equal(tooMany.rows[0]?.n, 8);

  await pool.query(
    `UPDATE platform_auth_attempt_gate SET attempt_times = ARRAY(SELECT ts - interval '16 minutes' FROM unnest(attempt_times) ts)
      WHERE key_hash = $1`, [gateKey(`step_up:${user.id}`)]);
  assert.deepEqual(statuses(await ws[1]!.stepUp(signed.session, [valid])), [200], 'vencida la ventana, el código válido pasa');
  assert.equal(await gateAttempts(`step_up:${user.id}`), null, 'el acierto limpia el contador');
  assert.deepEqual(statuses(await ws[2]!.stepUp(signed.session, [valid])), [401], 'y ese código no sirve dos veces');
  await Promise.all(ws.map((w) => w.close()));
});

test('reinicio: el límite sobrevive a que un proceso muera (SIGKILL) y lo aplica un proceso nuevo', async () => {
  const login = `mp-restart-${tag()}`;
  const ip = '203.0.113.20';
  const [first] = await startWorkers(1);
  const fails = statuses(await first!.login(Array.from({ length: 5 }, () => ({ login, password: 'wrong-password', code: '000000', ip }))));
  assert.deepEqual(fails, [401, 401, 401, 401, 401]);
  await first!.kill();
  const [second] = await startWorkers(1);
  assert.deepEqual(statuses(await second!.login([{ login, password: 'wrong-password', code: '000000', ip }])), [429]);
  await second!.close();
});

test('PostgreSQL inalcanzable: falla cerrado (500) sin autenticar ni consumir el código, y se recupera al reconectar', async () => {
  const user = await newUser();
  const target = new URL(TEST_URL);
  const proxy = new CuttableProxy({ host: target.hostname, port: Number(target.port || 5432) });
  proxies.push(proxy);
  await proxy.open();
  const viaProxy = new URL(TEST_URL);
  viaProxy.hostname = '127.0.0.1';
  viaProxy.port = String(proxy.port);
  const [w] = await startWorkers(1, viaProxy.toString());
  const ip = '203.0.113.30';
  assert.deepEqual(statuses(await w!.login([{ login: user.login, password: 'wrong-password', code: '000000', ip }])), [401]);

  await proxy.cut();
  const code = totpAt(user.secret, currentStep());
  const down = await w!.login([{ login: user.login, password: PASSWORD, code, ip }, { login: user.login, password: PASSWORD, code, ip: '203.0.113.31' }]);
  assert.deepEqual(statuses(down), [500, 500], JSON.stringify(down));
  assert.equal(await sessions(user.id), 0, 'sin base de datos no hay sesión');
  const last = await pool.query<{ s: string }>('SELECT totp_last_step::text AS s FROM platform_user WHERE platform_user_id = $1', [user.id]);
  assert.equal(last.rows[0]?.s, '0', 'el código no se consumió');
  assert.equal(await gateAttempts(`login:${ip}|${user.login}`), 1, 'el contador tampoco cambió');

  await proxy.open();
  assert.deepEqual(statuses(await w!.login([{ login: user.login, password: PASSWORD, code, ip }])), [200]);
  assert.equal(await gateAttempts(`login:${ip}|${user.login}`), null, 'el acierto limpia el contador');
  await w!.close();
});

test('un bloqueo retenido sobre la fila del límite no deja la petición esperando: falla cerrado tras lock_timeout', { timeout: 60_000 }, async () => {
  const user = await newUser();
  const ip = '203.0.113.40';
  const [w] = await startWorkers(1);
  assert.deepEqual(statuses(await w!.login([{ login: user.login, password: 'wrong-password', code: '000000', ip }])), [401]);

  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM platform_auth_attempt_gate WHERE key_hash = $1 FOR UPDATE', [gateKey(`login:${ip}|${user.login}`)]);
    const started = Date.now();
    const code = totpAt(user.secret, currentStep());
    // Sin lock_timeout la petición esperaría al bloqueo indefinidamente: se corta a los 20 s para poder fallar.
    const held = await Promise.race([w!.login([{ login: user.login, password: PASSWORD, code, ip }]), delay(20_000).then(() => 'still waiting')]);
    const waited = Date.now() - started;
    assert.deepEqual(held, [{ status: 500, code: '55P03' }], 'lock_timeout: no espera indefinidamente ni autentica');
    assert.ok(waited >= 400 && waited < 5_000, `esperó ${waited} ms (lock_timeout de 500 ms)`);
    assert.equal(await sessions(user.id), 0);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  assert.deepEqual(statuses(await w!.login([{ login: user.login, password: PASSWORD, code: totpAt(user.secret, currentStep()), ip }])), [200]);
  await w!.close();
});

test('purga concurrente: si otra sesión borra la fila vencida mientras la reserva espera, el intento cuenta (sin 500)', { timeout: 60_000 }, async () => {
  const login = `mp-prune-${tag()}`;
  const ip = '203.0.113.50';
  const key = gateKey(`login:${ip}|${login}`);
  const [w] = await startWorkers(1);
  assert.deepEqual(statuses(await w!.login([{ login, password: 'wrong-password', code: '000000', ip }])), [401]);
  // La clave lleva más de 15 min inactiva: la purga de cualquier proceso puede borrarla.
  await pool.query(
    `UPDATE platform_auth_attempt_gate SET attempt_times = ARRAY(SELECT ts - interval '20 minutes' FROM unnest(attempt_times) ts),
            updated_at = updated_at - interval '20 minutes' WHERE key_hash = $1`, [key]);

  const pruner = await pool.connect();
  let pending: Promise<Outcome[]> | undefined;
  try {
    await pruner.query('BEGIN');
    await pruner.query('SELECT 1 FROM platform_auth_attempt_gate WHERE key_hash = $1 FOR UPDATE', [key]);
    pending = w!.login([{ login, password: 'wrong-password', code: '000000', ip }]);
    // La reserva espera por la fila (como mucho 500 ms, su lock_timeout): se borra en cuanto queda bloqueada.
    const pid = (await pruner.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    let waiting = false;
    for (let i = 0; i < 40 && !waiting; i++) {
      waiting = (await pool.query<{ b: boolean }>('SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))) AS b', [pid])).rows[0]?.b === true;
      if (!waiting) await delay(5);
    }
    assert.ok(waiting, 'la reserva quedó esperando por la fila');
    await pruner.query('DELETE FROM platform_auth_attempt_gate WHERE key_hash = $1', [key]);
    await pruner.query('COMMIT');
  } catch (err) {
    await pruner.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    pruner.release();
  }
  assert.deepEqual(await pending, [{ status: 401 }], 'la reserva se hace sobre la fila nueva, no responde 500');
  assert.equal(await gateAttempts(`login:${ip}|${login}`), 1);
  await w!.close();
});

/** Termina (pg_terminate_backend) las conexiones del proceso con ese application_name que cumplan `where`. */
async function terminate(appName: string, where = 'true'): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE application_name = $1 AND ${where}`, [appName]);
  return r.rows[0]?.n ?? 0;
}

test('conexión terminada mientras el cliente está inactivo en el pool: el proceso sigue vivo y el siguiente intento funciona', async () => {
  const appName = `mp-idle-${tag()}`;
  const [w] = await startWorkers(1, taggedUrl(appName));
  const ip = '203.0.113.60';
  const login = `mp-idle-${tag()}`;
  assert.deepEqual(statuses(await w!.login([{ login, password: 'wrong-password', code: '000000', ip }])), [401]);
  assert.ok((await terminate(appName)) > 0, 'había conexiones inactivas del proceso');
  await delay(300);
  assert.ok(w!.alive, 'un cliente inactivo que pierde la conexión no tumba el proceso');
  assert.deepEqual(statuses(await w!.login([{ login, password: 'wrong-password', code: '000000', ip }])), [401]);
  assert.equal(await gateAttempts(`login:${ip}|${login}`), 2);
  await w!.close();
});

test('conexión terminada DENTRO de la transacción del límite: 500 sin autenticar, el proceso sigue vivo y el siguiente intento funciona', { timeout: 60_000 }, async () => {
  const user = await newUser();
  const appName = `mp-active-${tag()}`;
  const [w] = await startWorkers(1, taggedUrl(appName));
  const ip = '203.0.113.70';
  assert.deepEqual(statuses(await w!.login([{ login: user.login, password: 'wrong-password', code: '000000', ip }])), [401]);

  const holder = await pool.connect();
  let pending: Promise<Outcome[]> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM platform_auth_attempt_gate WHERE key_hash = $1 FOR UPDATE', [gateKey(`login:${ip}|${user.login}`)]);
    pending = w!.login([{ login: user.login, password: PASSWORD, code: totpAt(user.secret, currentStep()), ip }]);
    // Espera a que la reserva del proceso quede bloqueada por la fila y termina ESA conexión.
    let killed = 0;
    for (let i = 0; i < 100 && killed === 0; i++) {
      killed = await terminate(appName, `wait_event_type = 'Lock'`);
      if (!killed) await delay(20);
    }
    assert.equal(killed, 1, 'la reserva esperaba por la fila');
    const outcome = await pending;
    assert.equal(outcome[0]?.status, 500, JSON.stringify(outcome));
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  await delay(300);
  assert.ok(w!.alive, 'perder la conexión en medio de la transacción no tumba el proceso');
  assert.equal(await sessions(user.id), 0, 'sin autenticar');
  assert.deepEqual(statuses(await w!.login([{ login: user.login, password: PASSWORD, code: totpAt(user.secret, currentStep()), ip }])), [200]);
  await w!.close();
});

test('conexión terminada con un cliente retenido por pool.connect() directo (sin runTransaction): el proceso sigue vivo y el pool se recupera', { timeout: 60_000 }, async () => {
  const appName = `mp-checkout-${tag()}`;
  const [w] = await startWorkers(1, taggedUrl(appName));
  const held = w!.holdCheckout(30);
  let killed = 0;
  for (let i = 0; i < 200 && killed === 0; i++) {
    killed = await terminate(appName, `wait_event = 'PgSleep'`);
    if (!killed) await delay(20);
  }
  assert.equal(killed, 1, 'el cliente retenido estaba dentro de su transacción');
  assert.deepEqual(await held, [{ status: 500, code: '57P01' }]);
  await delay(300);
  assert.ok(w!.alive, 'un cliente fuera del pool que pierde la conexión no tumba el proceso');
  const login = `mp-checkout-${tag()}`;
  assert.deepEqual(statuses(await w!.login([{ login, password: 'wrong-password', code: '000000', ip: '203.0.113.80' }])), [401]);
  await w!.close();
});

test('ráfaga de logins inventados: el 429 por saturación no gasta intentos del operador, que entra al terminar la ráfaga', { timeout: 60_000 }, async () => {
  const user = await newUser();
  const [w] = await startWorkers(1);
  const ip = '203.0.113.90';
  // 120 logins inventados y, detrás, 6 reintentos del operador en la misma ráfaga: el proceso solo comprueba 2
  // contraseñas a la vez con 32 en cola; los demás reciben 429 sin llegar a la BD.
  const flood = Array.from({ length: 120 }, () => ({ login: `mp-flood-${tag()}`, password: 'wrong-password', code: '000000', ip }));
  const retries = Array.from({ length: 6 }, () => ({ login: user.login, password: PASSWORD, code: totpAt(user.secret, currentStep()), ip }));
  const outcomes = statuses(await w!.login([...flood, ...retries]));
  assert.equal(count(outcomes, 401) + count(outcomes, 429) + count(outcomes, 200), 126);
  assert.ok(count(outcomes, 429) >= 120 - 34, `la cola se saturó: ${JSON.stringify(outcomes)}`);
  assert.deepEqual(outcomes.slice(120), [429, 429, 429, 429, 429, 429], 'los reintentos del operador llegaron con la cola llena');
  assert.equal(await gateAttempts(`login:${ip}|${user.login}`), null, 'un 429 por saturación no reserva intentos de su clave');
  assert.deepEqual(statuses(await w!.login([{ login: user.login, password: PASSWORD, code: totpAt(user.secret, currentStep()), ip }])), [200],
    'terminada la ráfaga, el operador entra');
  await w!.close();
});

test('una clave con su fila bloqueada no hace esperar a los logins de OTRAS claves del mismo proceso', { timeout: 60_000 }, async () => {
  const ip = '203.0.113.95';
  const stuck = `mp-stuck-${tag()}`;
  const [w] = await startWorkers(1);
  assert.deepEqual(statuses(await w!.login([{ login: stuck, password: 'wrong-password', code: '000000', ip }])), [401]);
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM platform_auth_attempt_gate WHERE key_hash = $1 FOR UPDATE', [gateKey(`login:${ip}|${stuck}`)]);
    // Dos intentos sobre la clave bloqueada (esperan hasta lock_timeout) y tres sobre otras claves.
    const outcomes = await w!.loginTimed([
      { login: stuck, password: 'wrong-password', code: '000000', ip },
      { login: stuck, password: 'wrong-password', code: '000000', ip },
      ...Array.from({ length: 3 }, () => ({ login: `mp-free-${tag()}`, password: 'wrong-password', code: '000000', ip })),
    ]);
    const [a, b, ...others] = outcomes;
    assert.deepEqual([a?.status, a?.code, b?.status, b?.code], [500, '55P03', 500, '55P03'], JSON.stringify(outcomes));
    assert.ok(others.every((o) => o.status === 401 && (o.ms ?? Infinity) < 2_000), `otras claves sin esperar: ${JSON.stringify(outcomes)}`);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  await w!.close();
});
