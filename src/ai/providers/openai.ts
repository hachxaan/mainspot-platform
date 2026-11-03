/**
 * Adaptador OpenAI directo (ARC-0001 §4, DEC-0069). Texto con salida estructurada y herramientas
 * por la Responses API (`/responses`) e imágenes `gpt-image-2` por `/images/generations`.
 * Documentación consultada el 2026-11-03:
 * https://developers.openai.com/api/reference/resources/responses/methods/create (store, text.format json_schema, tools, reasoning.effort, usage)
 * https://developers.openai.com/api/docs/models/gpt-6-luna (Chat Completions solo admite herramientas con reasoning_effort=none → se usa Responses)
 * https://developers.openai.com/api/docs/guides/reasoning (modo sin almacenar: los ítems de razonamiento vuelven cifrados y deben reenviarse junto con las salidas de herramientas)
 * https://developers.openai.com/api/reference/resources/images/methods/generate (size WIDTHxHEIGHT múltiplos de 16, quality low|medium|high, output_format, usage por tokens)
 * https://developers.openai.com/api/docs/guides/error-codes (429 con error.code de cuota; 400 moderation_blocked)
 * https://developers.openai.com/api/docs/guides/your-data (`store:false` evita retener la respuesta 30 días; imágenes sin estado de aplicación)
 *
 * Nunca registra ni devuelve el cuerpo de error del proveedor (puede citar el prompt): de él solo se
 * leen los identificadores `error.code` y `error.type`, y hacia fuera salen códigos fijos `http_<status>`.
 * Las claves solo viajan en `Authorization: Bearer`.
 */

import type { ChatMessage, ChatRequest, ChatResult, ImageRequest, ImageResult, ProviderAdapter } from './types.ts';
import { ProviderError } from './types.ts';

export interface OpenAIOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ResponsesOutputItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string }>;
}

interface ResponsesResponse {
  id?: string;
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: ResponsesOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
}

interface ImageResponse {
  data?: Array<{ b64_json?: string }>;
  output_format?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Tamaño por relación de aspecto para gpt-image-2: lados múltiplos de 16, ≥655.360 px y ratio ≤3:1.
 * 1:1 y 3:4 usan los tamaños estándar; 16:9 es el ejemplo de la documentación; 4:3 y 4:5 son exactos.
 */
export const IMAGE_SIZE_BY_ASPECT: Record<ImageRequest['aspectRatio'], string> = {
  '1:1': '1024x1024',
  '16:9': '1536x864',
  '4:3': '1536x1152',
  '3:4': '1152x1536',
  '4:5': '1024x1280',
};

const IMAGE_OUTPUT_FORMAT = 'png';

/** Códigos 429 que no son límite de tasa sino falta de saldo o de límite de gasto (guía de errores). */
const QUOTA_CODES: Record<string, true> = { insufficient_quota: true, credit_balance_exhausted: true, organization_spend_limit_exceeded: true, project_spend_limit_exceeded: true, organization_usage_limit_exceeded: true };
/** Códigos 400 de bloqueo por política de contenido (guía de generación de imágenes y moderación). */
const POLICY_CODES: Record<string, true> = { moderation_blocked: true, content_policy_violation: true, content_filter: true };
/** Límite de respuestas con herramientas recordadas por adaptador (una invocación tiene pocas rondas). */
const REPLAY_LIMIT = 64;

/** Lee solo `error.code` y `error.type` del cuerpo; el resto (mensaje, prompt) se descarta sin registrar. */
async function errorIdentifiers(res: Response): Promise<{ code: string | null; type: string | null }> {
  try {
    const json = (await res.json()) as { error?: { code?: unknown; type?: unknown } } | null;
    const err = json?.error;
    return { code: typeof err?.code === 'string' ? err.code : null, type: typeof err?.type === 'string' ? err.type : null };
  } catch {
    return { code: null, type: null };
  }
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly kind = 'openai' as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  /** Salida completa (razonamiento cifrado + llamadas) por id de primera llamada a herramienta, para reenviarla en la ronda siguiente. */
  private readonly replay = new Map<string, ResponsesOutputItem[]>();

  constructor(opts: OpenAIOptions) {
    if (!opts.apiKey) throw new Error('OpenAIAdapter requires an API key reference');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal });
      if (!res.ok) {
        const error = await this.classify(res);
        if (controller.signal.aborted) throw new ProviderError('timeout', 0, 'AbortError');
        throw error;
      }
      try {
        return (await res.json()) as T;
      } catch {
        throw new ProviderError(controller.signal.aborted ? 'timeout' : 'bad_response', res.status, controller.signal.aborted ? 'AbortError' : 'invalid_json');
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(controller.signal.aborted ? 'timeout' : 'network', 0, err instanceof Error ? err.name : 'fetch_failed');
    } finally {
      // Incluye el cuerpo (base64 de imágenes / salida de Responses) en el deadline.
      clearTimeout(timer);
    }
  }

  private async classify(res: Response): Promise<ProviderError> {
    const status = res.status;
    const code = `http_${status}`;
    if (status === 400 || status === 429) {
      const ids = await errorIdentifiers(res);
      if (status === 429) {
        if ((ids.code && QUOTA_CODES[ids.code]) || ids.type === 'insufficient_quota') return new ProviderError('insufficient_credit', status, `${code}_quota`);
        const retryAfter = Number(res.headers.get('Retry-After'));
        return new ProviderError('rate_limited', status, code, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
      }
      if (ids.code && POLICY_CODES[ids.code]) return new ProviderError('policy_blocked', status, `${code}_moderation`);
      return new ProviderError('bad_request', status, code);
    }
    await res.body?.cancel().catch(() => undefined);
    if (status === 401 || status === 403) return new ProviderError('auth', status, code);
    if (status === 408 || status === 504) return new ProviderError('timeout', status, code);
    if (status >= 500) {
      const retryAfter = Number(res.headers.get('Retry-After'));
      return new ProviderError('unavailable', status, code, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
    }
    return new ProviderError('bad_request', status, code);
  }

  /** Mensajes estilo Chat Completions → ítems de entrada de la Responses API. */
  private toInput(messages: ChatMessage[]): unknown[] {
    const items: unknown[] = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        items.push({ type: 'function_call_output', call_id: m.tool_call_id ?? '', output: m.content ?? '' });
        continue;
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const stored = this.replay.get(m.tool_calls[0]!.id);
        if (stored) {
          items.push(...stored);
          continue;
        }
        if (m.content) items.push({ role: 'assistant', content: m.content });
        for (const c of m.tool_calls) items.push({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments });
        continue;
      }
      items.push({ role: m.role, content: m.content ?? '' });
    }
    return items;
  }

  private remember(firstCallId: string, output: ResponsesOutputItem[]): void {
    if (this.replay.size >= REPLAY_LIMIT) this.replay.delete(this.replay.keys().next().value as string);
    this.replay.set(firstCallId, output);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      input: this.toInput(req.messages),
      max_output_tokens: req.maxTokens,
      store: false,
    };
    if (req.temperature !== null && req.temperature !== undefined && req.supportsTemperature) body.temperature = req.temperature;
    if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };
    if (req.responseSchema) {
      body.text = { format: { type: 'json_schema', name: req.responseSchema.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64), strict: true, schema: req.responseSchema.schema } };
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
      body.tool_choice = 'auto';
    }
    const json = await this.post<ResponsesResponse>('/responses', body, req.timeoutMs);
    if (!Array.isArray(json.output)) throw new ProviderError('bad_response', 200, 'no_output');
    if (json.status === 'failed' || json.status === 'cancelled') throw new ProviderError('bad_response', 200, `response_${json.status}`);
    const texts: string[] = [];
    let refused = false;
    const toolCalls: ChatResult['toolCalls'] = [];
    for (const item of json.output) {
      if (item.type === 'function_call') {
        toolCalls.push({ id: item.call_id ?? '', name: item.name ?? '', arguments: item.arguments ?? '{}' });
      } else if (item.type === 'message') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
          else if (part.type === 'refusal') refused = true;
        }
      }
    }
    if (toolCalls.length) this.remember(toolCalls[0]!.id, json.output);
    const incomplete = json.incomplete_details?.reason ?? null;
    const finishReason = incomplete ?? (toolCalls.length ? 'tool_calls' : refused ? 'refusal' : json.status === 'completed' ? 'stop' : json.status ?? null);
    const usage = json.usage ?? {};
    return {
      content: texts.length ? texts.join('') : null,
      toolCalls,
      finishReason,
      providerModel: json.model ?? req.model,
      generationId: json.id ?? null,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
        images: 0,
        costUsd: null,
      },
    };
  }

  async image(req: ImageRequest): Promise<ImageResult> {
    const size = req.resolution && /^\d{3,4}x\d{3,4}$/.test(req.resolution) ? req.resolution : IMAGE_SIZE_BY_ASPECT[req.aspectRatio];
    const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, n: 1, size, output_format: IMAGE_OUTPUT_FORMAT };
    if (req.quality) body.quality = req.quality;
    const json = await this.post<ImageResponse>('/images/generations', body, req.timeoutMs);
    const first = json.data?.[0];
    if (!first?.b64_json) throw new ProviderError('bad_response', 200, 'no_image');
    const bytes = Buffer.from(first.b64_json, 'base64');
    if (bytes.length < 1000) throw new ProviderError('bad_response', 200, 'image_too_small');
    const format = json.output_format === 'jpeg' || json.output_format === 'webp' ? json.output_format : IMAGE_OUTPUT_FORMAT;
    return {
      bytes,
      mediaType: `image/${format}`,
      providerModel: req.model,
      usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0, reasoningTokens: 0, images: 1, costUsd: null },
    };
  }

  /** Comprobación sin costo: catálogo de modelos autenticado (no genera tokens). */
  async ping(timeoutMs = 10_000): Promise<{ ok: boolean; detail: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: controller.signal });
      await res.body?.cancel().catch(() => undefined);
      return { ok: res.ok, detail: res.ok ? 'credencial aceptada por el proveedor' : `el proveedor respondió ${res.status}` };
    } catch {
      return { ok: false, detail: 'sin conexión con el proveedor' };
    } finally {
      clearTimeout(timer);
    }
  }
}
