/**
 * Adaptador OpenRouter (ARC-0001 §4, OPS-0001). Texto con salida estructurada y herramientas
 * (`/chat/completions`) e imágenes (`/images`). Documentación consultada el 2026-10-30:
 * https://openrouter.ai/docs/guides/overview/multimodal/image-generation
 * https://openrouter.ai/docs/cookbook/administration/usage-accounting (usage.cost siempre presente)
 * https://openrouter.ai/docs/guides/routing/provider-selection (provider.data_collection = deny)
 *
 * Nunca registra ni devuelve el cuerpo de error del proveedor (puede citar el prompt); solo códigos.
 */

import type { ChatRequest, ChatResult, ImageRequest, ImageResult, ProviderAdapter } from './types.ts';
import { ProviderError } from './types.ts';

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  appUrl: string;
}

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number; completion_tokens_details?: { reasoning_tokens?: number } };
}

interface ImageResponse {
  data?: Array<{ b64_json?: string; media_type?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

function classify(status: number): ProviderError['kind'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'insufficient_credit';
  // OpenRouter responde 404 cuando la política de la cuenta (guardrails, ZDR) no deja ningún endpoint.
  if (status === 404) return 'policy_blocked';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'bad_request';
}

export class OpenRouterAdapter implements ProviderAdapter {
  readonly kind = 'openrouter' as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly appUrl: string;

  constructor(opts: OpenRouterOptions) {
    if (!opts.apiKey) throw new Error('OpenRouterAdapter requires an API key reference');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.appUrl = opts.appUrl;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.appUrl,
      'X-Title': 'MainSpot AI Core',
    };
  }

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal });
    } catch (err) {
      throw new ProviderError(controller.signal.aborted ? 'timeout' : 'network', 0, err instanceof Error ? err.name : 'fetch_failed');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const retryAfter = Number(res.headers.get('Retry-After'));
      throw new ProviderError(classify(res.status), res.status, `http_${res.status}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new ProviderError('bad_response', res.status, 'invalid_json');
    }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      provider: { data_collection: 'deny', require_parameters: true },
    };
    if (req.temperature !== null && req.temperature !== undefined && req.supportsTemperature) body.temperature = req.temperature;
    if (req.reasoningEffort) body.reasoning = { effort: req.reasoningEffort };
    if (req.responseSchema) {
      body.response_format = { type: 'json_schema', json_schema: { name: req.responseSchema.name.replace(/[^a-zA-Z0-9_-]/g, '_'), strict: true, schema: req.responseSchema.schema } };
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    const json = await this.post<ChatResponse>('/chat/completions', body, req.timeoutMs);
    const choice = json.choices?.[0];
    if (!choice?.message) throw new ProviderError('bad_response', 200, 'no_choice');
    const usage = json.usage ?? {};
    return {
      content: typeof choice.message.content === 'string' ? choice.message.content : null,
      toolCalls: (choice.message.tool_calls ?? []).map((c) => ({ id: c.id ?? '', name: c.function?.name ?? '', arguments: c.function?.arguments ?? '{}' })),
      finishReason: choice.finish_reason ?? null,
      providerModel: json.model ?? req.model,
      generationId: json.id ?? null,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
        images: 0,
        costUsd: typeof usage.cost === 'number' ? usage.cost : null,
      },
    };
  }

  async image(req: ImageRequest): Promise<ImageResult> {
    const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, n: 1, aspect_ratio: req.aspectRatio };
    if (req.resolution) body.resolution = req.resolution;
    const json = await this.post<ImageResponse>('/images', body, req.timeoutMs);
    const first = json.data?.[0];
    if (!first?.b64_json) throw new ProviderError('bad_response', 200, 'no_image');
    const bytes = Buffer.from(first.b64_json, 'base64');
    if (bytes.length < 1000) throw new ProviderError('bad_response', 200, 'image_too_small');
    return {
      bytes,
      mediaType: first.media_type ?? 'image/png',
      providerModel: req.model,
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0, reasoningTokens: 0, images: 1, costUsd: typeof json.usage?.cost === 'number' ? json.usage.cost : null },
    };
  }

  /** Comprobación sin costo: catálogo público autenticado (no expone la clave). */
  async ping(timeoutMs = 10_000): Promise<{ ok: boolean; detail: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/key`, { headers: { Authorization: `Bearer ${this.apiKey}` }, signal: controller.signal });
      await res.body?.cancel().catch(() => undefined);
      return { ok: res.ok, detail: res.ok ? 'credencial aceptada por el proveedor' : `el proveedor respondió ${res.status}` };
    } catch {
      return { ok: false, detail: 'sin conexión con el proveedor' };
    } finally {
      clearTimeout(timer);
    }
  }
}
