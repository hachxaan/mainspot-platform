/**
 * Proceso hijo de tests/integration/platform-auth-multiprocess.test.ts: una instancia de PlatformAuth sobre el
 * MISMO pool que usa la aplicación (src/db/pool.ts, sin oyentes añadidos aquí), como un proceso más detrás de un
 * balanceador. Recibe órdenes JSON por stdin y responde por stdout en líneas con el prefijo `@@` (el resto de la
 * salida, p. ej. logs, se ignora).
 *   {"id":1,"op":"login","at":<epoch ms>,"calls":[{"login":"…","password":"…","code":"123456","ip":"…"}]}
 *   {"id":2,"op":"stepUp","at":<epoch ms>,"session":{…},"codes":["…"]}
 * Las llamadas de una orden se lanzan a la vez, en el instante `at` (el mismo para todos los procesos); cada
 * resultado es el estado HTTP (200 si autenticó) y, en un error que no es AppError, su código (`55P03`,
 * `ECONNREFUSED`…).
 */

import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { getPool } from '../../src/db/pool.ts';
import { PlatformAuth, type PlatformSession } from '../../src/platform/auth.ts';
import { AppError } from '../../src/shared/errors.ts';

type Command =
  | { id: number; op: 'login'; at?: number; calls: Array<{ login: string; password: string; code: string; ip: string }> }
  | { id: number; op: 'stepUp'; at?: number; session: PlatformSession; codes: string[] }
  /** Cliente retenido con pool.connect() directo (sin runTransaction), como auditedOperation o los workers. */
  | { id: number; op: 'holdCheckout'; at?: number; seconds: number };

interface Outcome { status: number; code?: string }

const pool = getPool({ connectionString: process.env['WORKER_DATABASE_URL'] ?? '', max: Number(process.env['WORKER_POOL_MAX'] ?? 4) });
const auth = new PlatformAuth({
  pool, mfaKey: process.env['WORKER_MFA_KEY'] ?? '', jwtSecret: process.env['WORKER_JWT_SECRET'] ?? '', ttlMinutes: 30,
});

function outcome(err: unknown): Outcome {
  if (err instanceof AppError) return { status: err.status };
  const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : err instanceof Error ? err.name : 'unknown';
  return { status: 500, code };
}

async function run(cmd: Command): Promise<Outcome[]> {
  if (cmd.at) await delay(Math.max(0, cmd.at - Date.now()));
  if (cmd.op === 'holdCheckout') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_sleep($1)', [cmd.seconds]);
      await client.query('COMMIT');
      return [{ status: 200 }];
    } catch (err) {
      return [outcome(err)];
    } finally {
      client.release();
    }
  }
  if (cmd.op === 'login') {
    return Promise.all(cmd.calls.map((c) => auth.login(c.login, c.password, c.code, c.ip).then(() => ({ status: 200 }), outcome)));
  }
  return Promise.all(cmd.codes.map((code) => auth.stepUp(cmd.session, code).then(() => ({ status: 200 }), outcome)));
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const cmd = JSON.parse(line) as Command;
  void run(cmd).then((outcomes) => process.stdout.write(`@@${JSON.stringify({ id: cmd.id, outcomes })}\n`));
}).on('close', () => {
  void pool.end().finally(() => process.exit(0));
});

process.stdout.write(`@@${JSON.stringify({ ready: process.pid })}\n`);
