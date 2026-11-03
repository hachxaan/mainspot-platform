/**
 * Adaptador OpenAI directo (DEC-0069): cuerpo de las peticiones a `/responses` y `/images/generations`,
 * decodificación y guardas de imagen, uso, reenvío de ítems de razonamiento entre rondas con herramientas,
 * mapeo de errores sin leer el cuerpo y clave solo en `Authorization`. Sin red: `fetchImpl` falso.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_SIZE_BY_ASPECT, OpenAIAdapter } from '../../src/ai/providers/openai.ts';
import { ProviderError, type ChatRequest, type ImageRequest } from '../../src/ai/providers/types.ts';

const KEY = 'sk-fake-key-for-tests';

interface Captured { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }

function fakeFetch(responder: (c: Captured) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Captured = {
      url: String(input), method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(c);
    return responder(c);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const imageReq = (over: Partial<ImageRequest> = {}): ImageRequest => ({ model: 'gpt-image-2', prompt: 'Taller de bicis en Chetumal', aspectRatio: '16:9', timeoutMs: 5000, ...over });
const chatReq = (over: Partial<ChatRequest> = {}): ChatRequest => ({ model: 'gpt-6-luna', messages: [{ role: 'system', content: 'Sistema' }, { role: 'user', content: 'Hola' }], maxTokens: 800, timeoutMs: 5000, ...over });

const bigPng = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(4000, 7)]);

test('imagen: cuerpo con modelo, tamaño por aspecto, quality, n:1 y png; decodifica, guarda uso y clave solo en Authorization', async () => {
  const { fetchImpl, calls } = fakeFetch(() => json(200, { created: 1, output_format: 'png', data: [{ b64_json: bigPng.toString('base64') }], usage: { input_tokens: 12, output_tokens: 1056, total_tokens: 1068 } }));
  const adapter = new OpenAIAdapter({ apiKey: KEY, fetchImpl });
  const res = await adapter.image(imageReq({ quality: 'medium' }));
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.equal(c.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(c.body, { model: 'gpt-image-2', prompt: 'Taller de bicis en Chetumal', n: 1, size: '1536x864', output_format: 'png', quality: 'medium' });
  assert.ok(!c.url.includes(KEY));
  assert.ok(!JSON.stringify(c.body).includes(KEY));
  assert.ok(res.bytes.equals(bigPng));
  assert.equal(res.mediaType, 'image/png');
  assert.equal(res.providerModel, 'gpt-image-2');
  assert.deepEqual(res.usage, { inputTokens: 12, outputTokens: 1056, reasoningTokens: 0, images: 1, costUsd: null });
});

test('imagen: mapeo de aspectos a tamaños válidos (múltiplos de 16, ≥655.360 px, ratio exacto) y sin quality cuando no se pide', async () => {
  for (const [aspect, size] of Object.entries(IMAGE_SIZE_BY_ASPECT)) {
    const [w, h] = size.split('x').map(Number) as [number, number];
    assert.equal(w % 16, 0, `${aspect}: ancho múltiplo de 16`);
    assert.equal(h % 16, 0, `${aspect}: alto múltiplo de 16`);
    assert.ok(w * h >= 655_360, `${aspect}: píxeles mínimos`);
    const [a, b] = aspect.split(':').map(Number) as [number, number];
    assert.equal(w * b, h * a, `${aspect}: relación exacta`);
  }
  const { fetchImpl, calls } = fakeFetch(() => json(200, { data: [{ b64_json: bigPng.toString('base64') }] }));
  const adapter = new OpenAIAdapter({ apiKey: KEY, fetchImpl });
  await adapter.image(imageReq({ aspectRatio: '4:5' }));
  await adapter.image(imageReq({ aspectRatio: '1:1', resolution: '2048x2048' }));
  await adapter.image(imageReq({ aspectRatio: '3:4', resolution: 'grande' }));
  assert.equal(calls[0]!.body!['size'], '1024x1280');
  assert.ok(!('quality' in calls[0]!.body!), 'sin quality explícita el proveedor usa auto');
  assert.equal(calls[1]!.body!['size'], '2048x2048', 'una resolución WIDTHxHEIGHT explícita se respeta');
  assert.equal(calls[2]!.body!['size'], '1152x1536', 'una resolución inválida cae al mapeo por aspecto');
});

test('imagen: respuesta sin datos o demasiado pequeña es bad_response; el formato del proveedor fija mediaType', async () => {
  let body: unknown = { data: [] };
  const { fetchImpl } = fakeFetch(() => json(200, body));
  const adapter = new OpenAIAdapter({ apiKey: KEY, fetchImpl });
  await assert.rejects(adapter.image(imageReq()), (e: unknown) => e instanceof ProviderError && e.kind === 'bad_response' && e.message === 'no_image');
  body = { data: [{ b64_json: Buffer.alloc(200, 1).toString('base64') }] };
  await assert.rejects(adapter.image(imageReq()), (e: unknown) => e instanceof ProviderError && e.kind === 'bad_response' && e.message === 'image_too_small');
  body = { output_format: 'webp', data: [{ b64_json: bigPng.toString('base64') }] };
  assert.equal((await adapter.image(imageReq())).mediaType, 'image/webp');
});

test('chat: Responses API con store:false, json_schema estricto, herramientas, reasoning y temperature solo si se admite', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const tools = [{ name: 'buscar', description: 'Busca', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false } }];
  const { fetchImpl, calls } = fakeFetch(() => json(200, {
    id: 'resp_1', model: 'gpt-6-luna-2026', status: 'completed', incomplete_details: null,
    output: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'xxx' }, { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
    usage: { input_tokens: 30, output_tokens: 20, output_tokens_details: { reasoning_tokens: 8 }, total_tokens: 50 },
  }));
  const adapter = new OpenAIAdapter({ apiKey: KEY, fetchImpl });
  const res = await adapter.chat(chatReq({ responseSchema: { name: 'website.initial design/v1', schema }, tools, reasoningEffort: 'low', temperature: 0.3, supportsTemperature: false }));
  const c = calls[0]!;
  assert.equal(c.url, 'https://api.openai.com/v1/responses');
  assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(c.headers['Content-Type'], 'application/json');
  assert.deepEqual(c.body, {
    model: 'gpt-6-luna',
    input: [{ role: 'system', content: 'Sistema' }, { role: 'user', content: 'Hola' }],
    max_output_tokens: 800,
    store: false,
    reasoning: { effort: 'low' },
    text: { format: { type: 'json_schema', name: 'website_initial_design_v1', strict: true, schema } },
    tools: [{ type: 'function', name: 'buscar', description: 'Busca', parameters: tools[0]!.parameters }],
    tool_choice: 'auto',
  });
  assert.ok(!('simulation' in c.body!) && !('provider' in c.body!) && !('temperature' in c.body!));
  assert.equal(res.content, '{"ok":true}');
  assert.deepEqual(res.toolCalls, []);
  assert.equal(res.finishReason, 'stop');
  assert.equal(res.providerModel, 'gpt-6-luna-2026');
  assert.equal(res.generationId, 'resp_1');
  assert.deepEqual(res.usage, { inputTokens: 30, outputTokens: 20, reasoningTokens: 8, images: 0, costUsd: null });

  await adapter.chat(chatReq({ temperature: 0.3, supportsTemperature: true }));
  assert.equal(calls[1]!.body!['temperature'], 0.3);
  assert.ok(!('text' in calls[1]!.body!) && !('tools' in calls[1]!.body!) && !('reasoning' in calls[1]!.body!));
});

test('chat: llamadas a herramientas se devuelven y, en la ronda siguiente, se reenvían los ítems originales (razonamiento cifrado incluido) con sus salidas', async () => {
  const firstOutput = [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'cifrado' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'buscar', arguments: '{"q":"horario"}', status: 'completed' },
  ];
  let round = 0;
  const { fetchImpl, calls } = fakeFetch(() => (round++ === 0
    ? json(200, { id: 'resp_1', status: 'completed', output: firstOutput, usage: { input_tokens: 5, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 } } })
    : json(200, { id: 'resp_2', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }], usage: { input_tokens: 7, output_tokens: 3 } })));
  const adapter = new OpenAIAdapter({ apiKey: KEY, fetchImpl });
  const first = await adapter.chat(chatReq({ tools: [{ name: 'buscar', description: 'Busca', parameters: { type: 'object' } }] }));
  assert.deepEqual(first.toolCalls, [{ id: 'call_1', name: 'buscar', arguments: '{"q":"horario"}' }]);
  assert.equal(first.content, null);
  assert.equal(first.finishReason, 'tool_calls');

  const messages: ChatRequest['messages'] = [
    ...chatReq().messages,
    { role: 'assistant', content: first.content, tool_calls: first.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) },
    { role: 'tool', tool_call_id: 'call_1', content: '{"hours":"9-18"}' },
  ];
  const second = await adapter.chat(chatReq({ messages }));
  assert.equal(second.content, '{"ok":true}');
  assert.deepEqual(calls[1]!.body!['input'], [
    { role: 'system', content: 'Sistema' }, { role: 'user', content: 'Hola' },
    ...firstOutput,
    { type: 'function_call_output', call_id: 'call_1', output: '{"hours":"9-18"}' },
  ]);

  // Un adaptador nuevo (sin memoria de la respuesta) sintetiza los ítems a partir de los mensajes.
  const fresh = new OpenAIAdapter({ apiKey: KEY, fetchImpl });
  await fresh.chat(chatReq({ messages: [...messages.slice(0, 2), { role: 'assistant', content: 'Consulto', tool_calls: messages[2]!.tool_calls }, messages[3]!] }));
  assert.deepEqual(calls[2]!.body!['input'], [
    { role: 'system', content: 'Sistema' }, { role: 'user', content: 'Hola' },
    { role: 'assistant', content: 'Consulto' },
    { type: 'function_call', call_id: 'call_1', name: 'buscar', arguments: '{"q":"horario"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '{"hours":"9-18"}' },
  ]);
});

test('chat: rechazo y respuesta incompleta se reflejan en finishReason; sin output o fallida es bad_response', async () => {
  let body: unknown = { id: 'r', status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] };
  const { fetchImpl } = fakeFetch(() => json(200, body));
  const adapter = new OpenAIAdapter({ apiKey: KEY, fetchImpl });
  let res = await adapter.chat(chatReq());
  assert.equal(res.content, null);
  assert.equal(res.finishReason, 'refusal');
  body = { id: 'r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok' }] }] };
  res = await adapter.chat(chatReq());
  assert.equal(res.content, '{"ok');
  assert.equal(res.finishReason, 'max_output_tokens');
  body = { id: 'r', status: 'completed' };
  await assert.rejects(adapter.chat(chatReq()), (e: unknown) => e instanceof ProviderError && e.kind === 'bad_response' && e.message === 'no_output');
  body = { id: 'r', status: 'failed', error: { code: 'server_error', message: 'x' }, output: [] };
  await assert.rejects(adapter.chat(chatReq()), (e: unknown) => e instanceof ProviderError && e.kind === 'bad_response' && e.message === 'response_failed');
});

test('errores: mapeo por estado, cuota en 429, moderación en 400, Retry-After; el cuerpo nunca llega al error', async () => {
  const secret = 'PROMPT-SECRETO-NO-DEBE-SALIR';
  const cases: Array<{ status: number; body: unknown; headers?: Record<string, string>; kind: ProviderError['kind']; code: string; retryAfterMs?: number | null }> = [
    { status: 401, body: { error: { message: secret, type: 'invalid_request_error', code: 'invalid_api_key' } }, kind: 'auth', code: 'http_401' },
    { status: 403, body: { error: { message: secret } }, kind: 'auth', code: 'http_403' },
    { status: 429, body: { error: { message: secret, type: 'requests', code: 'rate_limit_exceeded' } }, headers: { 'Retry-After': '7' }, kind: 'rate_limited', code: 'http_429', retryAfterMs: 7000 },
    { status: 429, body: { error: { message: secret, type: 'insufficient_quota', code: 'insufficient_quota' } }, kind: 'insufficient_credit', code: 'http_429_quota' },
    { status: 429, body: { error: { message: secret, type: 'insufficient_quota', code: 'credit_balance_exhausted' } }, kind: 'insufficient_credit', code: 'http_429_quota' },
    { status: 429, body: { error: { message: secret, type: 'rate_limit_error', code: 'slow_down' } }, kind: 'rate_limited', code: 'http_429', retryAfterMs: null },
    { status: 400, body: { error: { message: secret, type: 'image_generation_user_error', code: 'moderation_blocked', moderation_details: { moderation_stage: 'input', categories: ['violence'] } } }, kind: 'policy_blocked', code: 'http_400_moderation' },
    { status: 400, body: { error: { message: secret, type: 'invalid_request_error', code: 'content_policy_violation' } }, kind: 'policy_blocked', code: 'http_400_moderation' },
    { status: 400, body: { error: { message: secret, type: 'invalid_request_error', param: 'size', code: null } }, kind: 'bad_request', code: 'http_400' },
    { status: 400, body: 'no json ' + secret, kind: 'bad_request', code: 'http_400' },
    { status: 404, body: { error: { message: secret, code: 'model_not_found' } }, kind: 'bad_request', code: 'http_404' },
    { status: 408, body: { error: { message: secret } }, kind: 'timeout', code: 'http_408' },
    { status: 504, body: '', kind: 'timeout', code: 'http_504' },
    { status: 500, body: { error: { message: secret } }, kind: 'unavailable', code: 'http_500' },
    { status: 503, body: { error: { message: secret, type: 'service_unavailable_error', code: 'server_is_overloaded' } }, headers: { 'Retry-After': '3' }, kind: 'unavailable', code: 'http_503', retryAfterMs: 3000 },
  ];
  for (const c of cases) {
    const { fetchImpl } = fakeFetch(() => (typeof c.body === 'string'
      ? new Response(c.body, { status: c.status, headers: c.headers })
      : json(c.status, c.body, c.headers)));
    const adapter = new OpenAIAdapter({ apiKey: KEY, fetchImpl });
    for (const call of [() => adapter.chat(chatReq()), () => adapter.image(imageReq())]) {
      await assert.rejects(call(), (e: unknown) => {
        assert.ok(e instanceof ProviderError, `${c.status}: ProviderError`);
        assert.equal(e.kind, c.kind, `${c.status} ${c.code}: kind`);
        assert.equal(e.message, c.code, `${c.status}: code`);
        assert.equal(e.status, c.status);
        if (c.retryAfterMs !== undefined) assert.equal(e.retryAfterMs, c.retryAfterMs, `${c.status}: Retry-After`);
        assert.ok(!JSON.stringify({ m: e.message, s: e.stack, k: Object.keys(e), v: Object.values(e) }).includes(secret), 'el cuerpo del proveedor no se propaga');
        return true;
      });
    }
  }
});

test('errores: tiempo de espera agotado es timeout y fallo de red es network; JSON inválido con 200 es bad_response', async () => {
  // Forma con ejecutor: la lib de tsconfig no expone Promise.withResolvers.
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  })) as typeof fetch;
  const slow = new OpenAIAdapter({ apiKey: KEY, fetchImpl: hanging });
  await assert.rejects(slow.chat(chatReq({ timeoutMs: 20 })), (e: unknown) => e instanceof ProviderError && e.kind === 'timeout' && e.message === 'AbortError');
  await assert.rejects(slow.image(imageReq({ timeoutMs: 20 })), (e: unknown) => e instanceof ProviderError && e.kind === 'timeout');

  const down = new OpenAIAdapter({ apiKey: KEY, fetchImpl: (async () => { throw Object.assign(new TypeError('fetch failed'), { name: 'TypeError' }); }) as typeof fetch });
  await assert.rejects(down.chat(chatReq()), (e: unknown) => e instanceof ProviderError && e.kind === 'network' && e.retryable);

  const garbage = new OpenAIAdapter({ apiKey: KEY, fetchImpl: (async () => new Response('<html>', { status: 200 })) as typeof fetch });
  await assert.rejects(garbage.chat(chatReq()), (e: unknown) => e instanceof ProviderError && e.kind === 'bad_response' && e.message === 'invalid_json');
});

test('ping: GET /models autenticado sin gasto; refleja aceptación, rechazo y falta de conexión', async () => {
  const { fetchImpl, calls } = fakeFetch(() => json(200, { object: 'list', data: [] }));
  const adapter = new OpenAIAdapter({ apiKey: KEY, fetchImpl, baseUrl: 'https://fake.openai.test/v1/' });
  const ok = await adapter.ping(1000);
  assert.equal(ok.ok, true);
  assert.equal(calls[0]!.url, 'https://fake.openai.test/v1/models');
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(calls[0]!.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0]!.body, null);

  const bad = new OpenAIAdapter({ apiKey: KEY, fetchImpl: (async () => json(401, { error: { message: 'x' } })) as typeof fetch });
  const rejected = await bad.ping(1000);
  assert.equal(rejected.ok, false);
  assert.match(rejected.detail, /401/);

  const down = new OpenAIAdapter({ apiKey: KEY, fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  assert.equal((await down.ping(1000)).ok, false);

  assert.throws(() => new OpenAIAdapter({ apiKey: '' }), /API key/);
});

test('openai: el deadline incluye el cuerpo de una generación de imagen', async () => {
  const fetchImpl: typeof fetch = async (_url, init) => {
    return new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    }), { status: 200 });
  };
  await assert.rejects(new OpenAIAdapter({ apiKey: KEY, fetchImpl }).image(imageReq({ timeoutMs: 20 })),
    (e: unknown) => e instanceof ProviderError && e.kind === 'timeout' && e.message === 'AbortError');
});
