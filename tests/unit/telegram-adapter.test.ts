/**
 * TelegramAdapter contra una Bot API falsa local: un aviso cuyo formato HTML rechaza Telegram igual llega (texto plano
 * con sus botones), y una pulsación repetida que no cambia el mensaje no cuenta como fallo.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { TelegramAdapter } from '../../src/channels/telegram.ts';

const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
let server: http.Server;
let adapter: TelegramAdapter;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const method = String(req.url).split('/').pop() ?? '';
      const body = JSON.parse(raw) as Record<string, unknown>;
      calls.push({ method, body });
      const reply = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (body['parse_mode'] === 'HTML' && String(body['text']).includes('<blockquote>')) return reply(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unsupported start tag" });
      if (method === 'editMessageText') return reply(400, { ok: false, error_code: 400, description: 'Bad Request: message is not modified' });
      return reply(200, { ok: true, result: { message_id: 42 } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  adapter = new TelegramAdapter('123456:fake-token-for-tests-only-000000000', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});
after(() => new Promise<void>((r) => server.close(() => r())));

test('si Telegram rechaza el HTML, el mismo aviso sale una vez como texto plano y conserva sus botones', async () => {
  calls.length = 0;
  const buttons = [[{ label: '✍️ Usar la respuesta 1', action: 'cs:case_x:0' }]];
  const sent = await adapter.send('777', { html: '<b>Reseña</b> &amp; <blockquote>Muy &lt;mal&gt;</blockquote>', buttons });
  assert.deepEqual(sent, { ok: true, messageId: '42' });
  assert.equal(calls.length, 2);
  const retry = calls[1]!.body;
  assert.equal(retry['parse_mode'], undefined);
  assert.equal(retry['text'], 'Reseña & Muy <mal>');
  assert.deepEqual(retry['reply_markup'], { inline_keyboard: [[{ text: '✍️ Usar la respuesta 1', callback_data: 'cs:case_x:0' }]] });
});

test('editar con el mismo contenido (doble toque) no es un fallo', async () => {
  assert.deepEqual(await adapter.edit('777', '42', { html: 'Publicado' }), { ok: true, messageId: '42' });
});
