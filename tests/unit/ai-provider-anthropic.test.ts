/**
 * Adaptador Anthropic directo (DEC-0069): conversión de mensajes, salida estructurada nativa y
 * de respaldo, uso, cabeceras y mapeo de errores. Sin red: `fetchImpl` falso y determinista.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter, ANTHROPIC_VERSION, countUnionParams, rejectsForcedToolChoice, toAnthropicMessages } from '../../src/ai/providers/anthropic.ts';
import { ProviderError, type ChatMessage, type ChatRequest } from '../../src/ai/providers/types.ts';

interface Captured { url: string; init: RequestInit; body: Record<string, unknown> }

function fakeFetch(respond: (c: Captured) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const c: Captured = { url: String(url), init: init ?? {}, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} };
    calls.push(c);
    return respond(c);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function ok(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const KEY = 'sk-ant-test-key-never-logged';
const BASE: ChatRequest = { model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'Hola' }], maxTokens: 500, timeoutMs: 5_000 };

const SIMPLE_SCHEMA = { type: 'object', additionalProperties: false, required: ['summary', 'tone'], properties: { summary: { type: 'string' }, tone: { anyOf: [{ type: 'string', enum: ['calm', 'bold'] }, { type: 'null' }] } } };

/** Esquema con 17 parámetros de unión (como site-edit/v1): supera el límite documentado de 16. */
function wideSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 17; i++) properties[`f${i}`] = { type: ['string', 'null'] };
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

test('anthropic: conversión de mensajes — system aparte, tool_calls → tool_use, tool → tool_result fusionados en un turno de usuario', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Eres el asistente.' },
    { role: 'system', content: 'Responde en español.' },
    { role: 'user', content: 'Dame el clima y la hora.' },
    { role: 'assistant', content: 'Consulto.', tool_calls: [
      { id: 'toolu_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Chetumal"}' } },
      { id: 'toolu_2', type: 'function', function: { name: 'clock', arguments: 'no-es-json' } },
    ] },
    { role: 'tool', tool_call_id: 'toolu_1', content: '{"temp":31}' },
    { role: 'tool', tool_call_id: 'toolu_2', content: '{"time":"10:00"}' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'Gracias.' },
  ];
  const out = toAnthropicMessages(messages);
  assert.equal(out.system, 'Eres el asistente.\n\nResponde en español.');
  assert.deepEqual(out.messages, [
    { role: 'user', content: [{ type: 'text', text: 'Dame el clima y la hora.' }] },
    { role: 'assistant', content: [
      { type: 'text', text: 'Consulto.' },
      { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'Chetumal' } },
      { type: 'tool_use', id: 'toolu_2', name: 'clock', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temp":31}' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: '{"time":"10:00"}' },
      { type: 'text', text: 'Gracias.' },
    ] },
  ], 'alternancia estricta: el asistente vacío se omite y los turnos de usuario consecutivos se fusionan');
  for (let i = 1; i < out.messages.length; i++) assert.notEqual(out.messages[i]!.role, out.messages[i - 1]!.role);
});

test('anthropic: salida estructurada nativa — output_config.format, cabeceras, esfuerzo, sin temperature ni simulation', async () => {
  const f = fakeFetch(() => ok({ id: 'msg_01', model: 'claude-haiku-5-5-20260601', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"summary":"ok","tone":null}' }], usage: { input_tokens: 10, output_tokens: 5 } }));
  const adapter = new AnthropicAdapter({ apiKey: KEY, fetchImpl: f.fetchImpl });
  const res = await adapter.chat({ ...BASE, messages: [{ role: 'system', content: 'Sistema' }, { role: 'user', content: 'Resume' }], responseSchema: { name: 'social-compose/v1', schema: SIMPLE_SCHEMA }, temperature: 0.3, supportsTemperature: false, reasoningEffort: 'low', simulation: { useCaseId: 'x', values: {} } });
  const c = f.calls[0]!;
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.init.method, 'POST');
  const headers = c.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], KEY);
  assert.equal(headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(headers['content-type'], 'application/json');
  assert.ok(!('Authorization' in headers) && !('authorization' in headers), 'la clave solo viaja en x-api-key');
  assert.ok(!String(c.init.body).includes(KEY), 'la clave nunca va en el cuerpo');
  assert.equal(c.body['system'], 'Sistema');
  assert.deepEqual(c.body['messages'], [{ role: 'user', content: [{ type: 'text', text: 'Resume' }] }]);
  assert.deepEqual(c.body['output_config'], { effort: 'low', format: { type: 'json_schema', schema: SIMPLE_SCHEMA } });
  assert.equal(c.body['max_tokens'], 500);
  assert.ok(!('temperature' in c.body), 'temperature solo si el modelo la admite');
  assert.ok(!('simulation' in c.body) && !('tools' in c.body) && !('tool_choice' in c.body) && !('thinking' in c.body));
  assert.equal(res.content, '{"summary":"ok","tone":null}');
  assert.deepEqual(res.toolCalls, []);
  assert.equal(res.finishReason, 'end_turn');
  assert.equal(res.providerModel, 'claude-haiku-5-5-20260601');
  assert.equal(res.generationId, 'msg_01');

  const g = fakeFetch(() => ok({ id: 'msg_02', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hola' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  await new AnthropicAdapter({ apiKey: KEY, fetchImpl: g.fetchImpl }).chat({ ...BASE, model: 'claude-sonnet-4-6', temperature: 0.2, supportsTemperature: true });
  assert.equal(g.calls[0]!.body['temperature'], 0.2);
  assert.ok(!('output_config' in g.calls[0]!.body), 'sin esquema ni esfuerzo no se envía output_config');
});

test('anthropic: esquema con 17 uniones → herramienta forzada no estricta y content = JSON del input', async () => {
  const schema = wideSchema();
  assert.equal(countUnionParams(schema), 17);
  const input = Object.fromEntries(Object.keys(schema['properties'] as object).map((k, i) => [k, i % 2 ? null : `v${i}`]));
  const f = fakeFetch(() => ok({ id: 'msg_03', model: 'claude-haiku-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_9', name: 'site-edit_v1', input }], usage: { input_tokens: 40, output_tokens: 30 } }));
  const adapter = new AnthropicAdapter({ apiKey: KEY, fetchImpl: f.fetchImpl });
  const res = await adapter.chat({ ...BASE, messages: [{ role: 'system', content: 'Edita.' }, { role: 'user', content: 'Cambia el horario.' }], responseSchema: { name: 'site-edit/v1', schema } });
  const body = f.calls[0]!.body;
  assert.ok(!('output_config' in body), 'no se usa la gramática nativa por encima del límite');
  assert.deepEqual(body['tool_choice'], { type: 'tool', name: 'site-edit_v1' });
  const tools = body['tools'] as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!['name'], 'site-edit_v1');
  assert.deepEqual(tools[0]!['input_schema'], schema);
  assert.ok(!('strict' in tools[0]!), 'la herramienta de respaldo no es estricta (sin límite de gramática)');
  assert.match(String(body['system']), /^Edita\.\n\n.*«site-edit_v1»/);
  assert.equal(res.content, JSON.stringify(input));
  assert.deepEqual(JSON.parse(res.content!), input);
  assert.deepEqual(res.toolCalls, [], 'la herramienta de salida no se expone como llamada');
  assert.equal(res.finishReason, 'tool_use');
});

test('anthropic: modelos que rechazan tool_choice forzado usan auto + instrucción; con herramientas el modelo decide', async () => {
  assert.ok(rejectsForcedToolChoice('claude-sonnet-5-5') && rejectsForcedToolChoice('claude-opus-5-5-20260401'));
  assert.ok(!rejectsForcedToolChoice('claude-haiku-5-5') && !rejectsForcedToolChoice('claude-sonnet-5'));
  const schema = wideSchema();
  const f = fakeFetch(() => ok({ id: 'msg_04', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'tool_use', id: 't', name: 'site-edit_v1', input: { f0: 'a' } }], usage: { input_tokens: 1, output_tokens: 1 } }));
  await new AnthropicAdapter({ apiKey: KEY, fetchImpl: f.fetchImpl }).chat({ ...BASE, model: 'claude-sonnet-5-5', responseSchema: { name: 'site-edit/v1', schema } });
  assert.deepEqual(f.calls[0]!.body['tool_choice'], { type: 'auto' });
  assert.match(String(f.calls[0]!.body['system']), /«site-edit_v1»/);

  // Asistente con herramientas y esquema amplio: la herramienta de salida se suma a las demás, sin forzar.
  const g = fakeFetch(() => ok({ id: 'msg_05', model: 'claude-haiku-5-5', stop_reason: 'tool_use', content: [
    { type: 'text', text: 'Consulto el horario.' },
    { type: 'tool_use', id: 'toolu_a', name: 'get_hours', input: { day: 'sat' } },
  ], usage: { input_tokens: 1, output_tokens: 1 } }));
  const res = await new AnthropicAdapter({ apiKey: KEY, fetchImpl: g.fetchImpl }).chat({ ...BASE, tools: [{ name: 'get_hours', description: 'Horario', parameters: { type: 'object', properties: {} } }], responseSchema: { name: 'site-edit/v1', schema } });
  const tools = g.calls[0]!.body['tools'] as Array<Record<string, unknown>>;
  assert.deepEqual(tools.map((t) => t['name']), ['get_hours', 'site-edit_v1']);
  assert.deepEqual(g.calls[0]!.body['tool_choice'], { type: 'auto' });
  assert.deepEqual(res.toolCalls, [{ id: 'toolu_a', name: 'get_hours', arguments: '{"day":"sat"}' }]);
  assert.equal(res.content, 'Consulto el horario.');
});

test('anthropic: herramientas + esquema dentro del límite — tools con input_schema, auto y gramática solo en la respuesta final', async () => {
  const f = fakeFetch(() => ok({ id: 'msg_06', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"summary":"listo","tone":"calm"}' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  const tools = [{ name: 'get_hours', description: 'Horario del negocio', parameters: { type: 'object', additionalProperties: false, properties: { day: { type: 'string' } }, required: ['day'] } }];
  const res = await new AnthropicAdapter({ apiKey: KEY, fetchImpl: f.fetchImpl }).chat({ ...BASE, tools, responseSchema: { name: 'owner-assistant/v1', schema: SIMPLE_SCHEMA } });
  const body = f.calls[0]!.body;
  assert.deepEqual(body['tools'], [{ name: 'get_hours', description: 'Horario del negocio', input_schema: tools[0]!.parameters }]);
  assert.deepEqual(body['tool_choice'], { type: 'auto' });
  assert.deepEqual(body['output_config'], { format: { type: 'json_schema', schema: SIMPLE_SCHEMA } });
  assert.equal(res.content, '{"summary":"listo","tone":"calm"}');
});

test('anthropic: uso — entrada incluye caché, salida total, pensamiento aparte, costo null', async () => {
  const f = fakeFetch(() => ok({ id: 'msg_07', model: 'claude-opus-5-5', stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'parcial' }],
    usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 80, output_tokens_details: { thinking_tokens: 50 } } }));
  const res = await new AnthropicAdapter({ apiKey: KEY, fetchImpl: f.fetchImpl }).chat({ ...BASE, model: 'claude-opus-5-5' });
  assert.deepEqual(res.usage, { inputTokens: 420, outputTokens: 80, reasoningTokens: 50, images: 0, costUsd: null });
  assert.equal(res.content, 'parcial');
  assert.equal(res.finishReason, 'max_tokens');

  const g = fakeFetch(() => ok({ id: 'msg_08', model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'x' }] }));
  const r2 = await new AnthropicAdapter({ apiKey: KEY, fetchImpl: g.fetchImpl }).chat(BASE);
  assert.deepEqual(r2.usage, { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, images: 0, costUsd: null }, 'sin usage informado todo queda en 0');
});

test('anthropic: mapeo de errores — 401/403 auth, 402 crédito, 404 bad_request, 429 con Retry-After, 529 unavailable, timeout, red, JSON inválido', async () => {
  const errAt = async (status: number, headers: Record<string, string> = {}) => {
    let cancelled = false;
    const f = fakeFetch(() => {
      const res = new Response('{"type":"error","error":{"type":"x","message":"NUNCA-SE-EXPONE"}}', { status, headers });
      const body = res.body!;
      body.cancel = async () => { cancelled = true; };
      return res;
    });
    const err = await new AnthropicAdapter({ apiKey: KEY, fetchImpl: f.fetchImpl }).chat(BASE).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof ProviderError);
    if (status !== 400) assert.ok(cancelled, 'el cuerpo de error se descarta sin leerlo salvo el rechazo 400 por falta de saldo');
    assert.doesNotMatch(err.message, /NUNCA-SE-EXPONE/);
    return err;
  };
  const e401 = await errAt(401);
  assert.equal(e401.kind, 'auth'); assert.equal(e401.status, 401); assert.equal(e401.message, 'http_401'); assert.equal(e401.retryable, false);
  assert.equal((await errAt(403)).kind, 'auth');
  assert.equal((await errAt(402)).kind, 'insufficient_credit');
  assert.equal((await errAt(404)).kind, 'bad_request');
  assert.equal((await errAt(400)).kind, 'bad_request');
  assert.equal((await errAt(413)).kind, 'bad_request');
  const noCredit = fakeFetch(() => ok({ error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. PRIVATE-INPUT' } }, 400));
  const creditError = await new AnthropicAdapter({ apiKey: KEY, fetchImpl: noCredit.fetchImpl }).chat(BASE).catch((e: unknown) => e);
  assert.ok(creditError instanceof ProviderError);
  assert.equal(creditError.kind, 'insufficient_credit');
  assert.equal(creditError.retryable, false);
  assert.equal(creditError.message, 'http_400');
  const e429 = await errAt(429, { 'retry-after': '7' });
  assert.equal(e429.kind, 'rate_limited'); assert.equal(e429.retryAfterMs, 7_000); assert.equal(e429.retryable, true);
  assert.equal((await errAt(429)).retryAfterMs, null, 'el 429 por tope de gasto no trae retry-after');
  const e529 = await errAt(529);
  assert.equal(e529.kind, 'unavailable'); assert.equal(e529.message, 'http_529'); assert.equal(e529.retryable, true);
  assert.equal((await errAt(500)).kind, 'unavailable');
  assert.equal((await errAt(504)).kind, 'timeout');

  // Timeout propio: el fetch respeta la señal de aborto.
  // Forma ejecutora: la `lib` del tsconfig no incluye Promise.withResolvers.
  const slow = fakeFetch((c) => new Promise<Response>((_resolve, reject) => { c.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); }));
  const t = await new AnthropicAdapter({ apiKey: KEY, fetchImpl: slow.fetchImpl }).chat({ ...BASE, timeoutMs: 20 }).then(() => null, (e: unknown) => e);
  assert.ok(t instanceof ProviderError); assert.equal(t.kind, 'timeout'); assert.equal(t.status, 0); assert.equal(t.message, 'AbortError');

  const down = fakeFetch(() => { throw new TypeError('fetch failed'); });
  const n = await new AnthropicAdapter({ apiKey: KEY, fetchImpl: down.fetchImpl }).chat(BASE).then(() => null, (e: unknown) => e);
  assert.ok(n instanceof ProviderError); assert.equal(n.kind, 'network'); assert.equal(n.message, 'TypeError');

  const garbage = fakeFetch(() => new Response('<html>', { status: 200 }));
  const b = await new AnthropicAdapter({ apiKey: KEY, fetchImpl: garbage.fetchImpl }).chat(BASE).then(() => null, (e: unknown) => e);
  assert.ok(b instanceof ProviderError); assert.equal(b.kind, 'bad_response'); assert.equal(b.message, 'invalid_json');
  const empty = fakeFetch(() => ok({ id: 'x' }));
  const nc = await new AnthropicAdapter({ apiKey: KEY, fetchImpl: empty.fetchImpl }).chat(BASE).then(() => null, (e: unknown) => e);
  assert.ok(nc instanceof ProviderError); assert.equal(nc.message, 'no_content');
});

test('anthropic: image() no está soportado y ping() es un GET autenticado sin prompt', async () => {
  const f = fakeFetch(() => ok({ data: [] }));
  const adapter = new AnthropicAdapter({ apiKey: KEY, fetchImpl: f.fetchImpl });
  const img = await adapter.image({ model: 'x', prompt: 'p', aspectRatio: '1:1', timeoutMs: 100 }).then(() => null, (e: unknown) => e);
  assert.ok(img instanceof ProviderError); assert.equal(img.kind, 'bad_request'); assert.equal(img.message, 'image_not_supported');
  assert.equal(f.calls.length, 0, 'image() no toca la red');

  assert.deepEqual(await adapter.ping(), { ok: true, detail: 'credencial aceptada por el proveedor' });
  const c = f.calls[0]!;
  assert.equal(c.url, 'https://api.anthropic.com/v1/models?limit=1');
  assert.ok(!c.init.method || c.init.method === 'GET');
  assert.equal(c.init.body, undefined);
  const headers = c.init.headers as Record<string, string>;
  assert.equal(headers['x-api-key'], KEY);
  assert.equal(headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.ok(!('Authorization' in headers));

  const bad = fakeFetch(() => new Response('{"type":"error"}', { status: 401 }));
  const r = await new AnthropicAdapter({ apiKey: KEY, fetchImpl: bad.fetchImpl, baseUrl: 'https://proxy.test/v1/' }).ping();
  assert.deepEqual(r, { ok: false, detail: 'el proveedor respondió 401' });
  assert.equal(bad.calls[0]!.url, 'https://proxy.test/v1/models?limit=1');
  assert.doesNotMatch(r.detail, new RegExp(KEY));
  const off = fakeFetch(() => { throw new TypeError('fetch failed'); });
  assert.deepEqual(await new AnthropicAdapter({ apiKey: KEY, fetchImpl: off.fetchImpl }).ping(), { ok: false, detail: 'sin conexión con el proveedor' });

  assert.throws(() => new AnthropicAdapter({ apiKey: '' }), /API key/);
});

test('anthropic: el deadline sigue vigente después de recibir las cabeceras', async () => {
  const fetchImpl: typeof fetch = async (_url, init) => {
    return new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    }), { status: 200 });
  };
  await assert.rejects(new AnthropicAdapter({ apiKey: KEY, fetchImpl }).chat({ ...BASE, timeoutMs: 20 }),
    (e: unknown) => e instanceof ProviderError && e.kind === 'timeout' && e.message === 'AbortError');
});
