/**
 * scripts/telegram-webhook.ts contra un Bot API FALSO en proceso (SIMULATED_REGRESSION): prueba
 * las salvaguardas del registro, no la entrega real de Telegram.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTelegramWebhook, UsageError, WEBHOOK_URL } from '../../scripts/telegram-webhook.ts';

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmnop';
const SECRET = 'a'.repeat(64);

interface Call { method: string; body: Record<string, unknown> }
const state = { username: 'mainspot_dev_bot', webhookUrl: '', maxConnections: 40, allowed: undefined as string[] | undefined, calls: [] as Call[], failWith: '' };

let server: Server;
let baseUrl = '';
let dir = '';

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      res.setHeader('Content-Type', 'application/json');
      if (!m || m[1] !== TOKEN) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })); return; }
      const method = m[2]!;
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      state.calls.push({ method, body });
      if (state.failWith) { res.end(JSON.stringify({ ok: false, error_code: 400, description: state.failWith })); return; }
      if (method === 'getMe') { res.end(JSON.stringify({ ok: true, result: { id: 42, is_bot: true, username: state.username } })); return; }
      if (method === 'getWebhookInfo') {
        res.end(JSON.stringify({ ok: true, result: { url: state.webhookUrl, has_custom_certificate: false, pending_update_count: 0, max_connections: state.maxConnections, allowed_updates: state.allowed } }));
        return;
      }
      if (method === 'setWebhook') {
        state.webhookUrl = String(body.url);
        state.maxConnections = Number(body.max_connections);
        state.allowed = body.allowed_updates as string[];
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(path.join(os.tmpdir(), 'tg-webhook-test-'));
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

async function envFile(mode = 0o600, token = TOKEN): Promise<string> {
  const file = path.join(dir, `tg-${Math.random().toString(36).slice(2)}.env`);
  await writeFile(file, `MAINSPOT_DEV_TELEGRAM=simulated\nTELEGRAM_WEBHOOK_SECRET=${SECRET}\nTELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_BASE_URL=${baseUrl}\n`);
  await chmod(file, mode);
  return file;
}

async function run(argv: string[], file: string): Promise<string[]> {
  const lines: string[] = [];
  await runTelegramWebhook(argv, { fetch, envFile: file, out: (l) => lines.push(l) });
  return lines;
}

function reset(webhookUrl = ''): void {
  Object.assign(state, { webhookUrl, maxConnections: 40, allowed: undefined, calls: [], failWith: '', username: 'mainspot_dev_bot' });
}

const REGISTER = ['register', '--confirm-bot', 'mainspot_dev_bot', '--ready-for-webhook-registration'];

test('status is read-only and never prints the token or the secret', async () => {
  reset('');
  const out = await run(['status'], await envFile());
  assert.deepEqual(state.calls.map((c) => c.method), ['getMe', 'getWebhookInfo']);
  const text = out.join('\n');
  assert.ok(text.includes('@mainspot_dev_bot') && text.includes('(sin webhook)'));
  assert.ok(!text.includes(TOKEN) && !text.includes(SECRET));
});

test('register without explicit readiness or bot identity makes no Bot API call', async () => {
  reset('');
  const file = await envFile();
  await assert.rejects(run(['register', '--confirm-bot', 'mainspot_dev_bot'], file), UsageError);
  await assert.rejects(run(['register', '--ready-for-webhook-registration'], file), UsageError);
  assert.equal(state.calls.length, 0);
});

test('register refuses a token that belongs to another bot', async () => {
  reset('');
  state.username = 'backup_alerts_bot';
  await assert.rejects(run(REGISTER, await envFile()), /no a mainspot_dev_bot/);
  assert.ok(!state.calls.some((c) => c.method === 'setWebhook'));
});

test('an existing foreign webhook is never overwritten unless its exact URL is named', async () => {
  reset('https://other-env.example/hook');
  const file = await envFile();
  await assert.rejects(run(REGISTER, file), /otro webhook/);
  assert.ok(!state.calls.some((c) => c.method === 'setWebhook'));
  assert.equal(state.webhookUrl, 'https://other-env.example/hook');

  await assert.rejects(run([...REGISTER, '--replace-webhook-from', 'https://other-env.example/WRONG'], file), /otro webhook/);
  await run([...REGISTER, '--replace-webhook-from', 'https://other-env.example/hook'], file);
  assert.equal(state.webhookUrl, WEBHOOK_URL);
});

test('register sets exactly the agreed webhook parameters and confirms them with getWebhookInfo', async () => {
  reset('');
  const out = await run(REGISTER, await envFile());
  const set = state.calls.find((c) => c.method === 'setWebhook');
  assert.deepEqual(set?.body, { url: WEBHOOK_URL, secret_token: SECRET, allowed_updates: ['message'], drop_pending_updates: false, max_connections: 1 });
  assert.deepEqual(state.calls.map((c) => c.method), ['getMe', 'getWebhookInfo', 'setWebhook', 'getWebhookInfo']);
  assert.ok(!state.calls.some((c) => c.method === 'getUpdates' || c.method === 'deleteWebhook'));
  const text = out.join('\n');
  assert.ok(text.includes(`webhook.url: ${WEBHOOK_URL}`) && !text.includes(SECRET) && !text.includes(TOKEN));
});

test('a credentials file readable by group or others is refused before any call', async () => {
  reset('');
  await assert.rejects(run(['status'], await envFile(0o640)), /0600/);
  assert.equal(state.calls.length, 0);
});

test('missing bot token is reported as an external blocker without calling Telegram', async () => {
  reset('');
  await assert.rejects(run(['status'], await envFile(0o600, '')), /BLOCKED_EXTERNAL/);
  assert.equal(state.calls.length, 0);
});

test('Bot API errors never echo the token or the secret', async () => {
  reset('');
  state.failWith = `bad request for ${TOKEN} with ${SECRET}`;
  await assert.rejects(run(['status'], await envFile()), (err: Error) => !err.message.includes(TOKEN) && !err.message.includes(SECRET) && err.message.includes('<token>'));
});
