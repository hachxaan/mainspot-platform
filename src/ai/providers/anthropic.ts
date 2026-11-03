/**
 * Adaptador Anthropic directo (DEC-0069): texto con salida estructurada y herramientas vía
 * Messages API (`POST /v1/messages`). No genera imágenes. Documentación consultada el 2026-11-03:
 * https://platform.claude.com/docs/en/api/messages (cabeceras, bloques, stop_reason, usage)
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs (`output_config.format`, límites)
 * https://platform.claude.com/docs/en/build-with-claude/thinking (pensamiento adaptativo, tool_choice forzado)
 * https://platform.claude.com/docs/en/build-with-claude/effort (`output_config.effort`)
 * https://platform.claude.com/docs/en/api/errors y https://platform.claude.com/docs/en/api/rate-limits
 *
 * Salida estructurada:
 * - Nativa (`output_config.format: {type:'json_schema'}`, GA sin cabecera beta) cuando el esquema
 *   respeta los límites publicados (≤16 parámetros con anyOf/tipo múltiple, ≤24 opcionales).
 * - Si los excede, el esquema viaja como herramienta NO estricta (sin gramática, sin límite) y su
 *   `input` se devuelve serializado en `content`. Se fuerza con `tool_choice: {type:'tool'}` salvo en
 *   los modelos que rechazan el forzado (Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1): ahí va
 *   `auto` más una instrucción de sistema. El despachador valida y repara después.
 * - Con herramientas y esquema a la vez, la gramática solo aplica al texto final: el modelo llama
 *   herramientas libremente y la respuesta final cumple el esquema.
 *
 * Pensamiento: los modelos Claude 5.x lo traen activado (adaptativo) y rechazan `temperature`; el
 * esfuerzo se controla con `output_config.effort`. El contrato `ChatMessage` no transporta bloques
 * `thinking`, así que el turno del asistente vuelve solo con `text` y `tool_use`; la API acepta esa
 * forma y descarta el razonamiento previo para esa continuación (documentado como degradación).
 *
 * Nunca registra ni devuelve el cuerpo de error del proveedor (puede citar el prompt); solo códigos.
 */

import type { ChatMessage, ChatRequest, ChatResult, ImageRequest, ImageResult, ProviderAdapter, Usage } from './types.ts';
import { ProviderError } from './types.ts';

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Versión estable; `2026-10-21` rechaza `temperature` en todo modelo (aquí solo se envía si el modelo la admite). */
export const ANTHROPIC_VERSION = '2023-06-01';
/** Límites publicados de salida estructurada (parámetros con unión / opcionales por petición). */
export const STRUCTURED_OUTPUT_LIMITS = { unionParams: 16, optionalParams: 24 } as const;

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface MessagesResponse {
  id?: string;
  model?: string;
  stop_reason?: string | null;
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    output_tokens_details?: { thinking_tokens?: number } | null;
  };
}

function classify(status: number): ProviderError['kind'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'insufficient_credit';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable'; // incluye 529 overloaded_error
  return 'bad_request'; // 400, 404 (modelo desconocido), 409, 413
}

/** Modelos que rechazan `tool_choice` forzado (`any`/`tool`) con 400 en toda petición. */
export function rejectsForcedToolChoice(model: string): boolean {
  return /^claude-(opus-5-5|sonnet-5-5|fable-5-1|mythos-5-1)(-|$)/.test(model);
}

/** Parámetros con `anyOf` o tipo múltiple, contados en todo el árbol (criterio conservador). */
export function countUnionParams(schema: unknown): number {
  if (!schema || typeof schema !== 'object') return 0;
  const s = schema as Record<string, unknown>;
  let n = Array.isArray(s.anyOf) || Array.isArray(s.type) ? 1 : 0;
  if (Array.isArray(s.anyOf)) for (const sub of s.anyOf) n += countUnionParams(sub);
  if (s.properties && typeof s.properties === 'object') for (const v of Object.values(s.properties)) n += countUnionParams(v);
  if (s.items) n += countUnionParams(s.items);
  return n;
}

/** Propiedades no listadas en `required`, en todo el árbol. */
export function countOptionalParams(schema: unknown): number {
  if (!schema || typeof schema !== 'object') return 0;
  const s = schema as Record<string, unknown>;
  let n = 0;
  if (s.properties && typeof s.properties === 'object') {
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    for (const [k, v] of Object.entries(s.properties)) {
      if (!required.has(k)) n++;
      n += countOptionalParams(v);
    }
  }
  if (Array.isArray(s.anyOf)) for (const sub of s.anyOf) n += countOptionalParams(sub);
  if (s.items) n += countOptionalParams(s.items);
  return n;
}

export function withinStructuredOutputLimits(schema: Record<string, unknown>): boolean {
  return countUnionParams(schema) <= STRUCTURED_OUTPUT_LIMITS.unionParams && countOptionalParams(schema) <= STRUCTURED_OUTPUT_LIMITS.optionalParams;
}

function toolName(raw: string, taken: Set<string>): string {
  let name = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'structured_output';
  while (taken.has(name)) name = `${name.slice(0, 57)}_output`;
  return name;
}

function parseArguments(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Convierte el historial al formato de Anthropic: `system` aparte, `tool_calls` → `tool_use`,
 * mensajes `tool` → `tool_result` dentro de un turno de usuario, y turnos consecutivos del mismo
 * rol fusionados (los resultados de varias herramientas deben ir juntos en el mismo turno).
 */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string | null; messages: Array<{ role: 'user' | 'assistant'; content: Block[] }> } {
  const system: string[] = [];
  const out: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) system.push(m.content);
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: m.content ?? '' }]);
    } else if (m.role === 'assistant') {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.tool_calls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) });
      push('assistant', blocks);
    } else if (m.content) {
      push('user', [{ type: 'text', text: m.content }]);
    }
  }
  return { system: system.length ? system.join('\n\n') : null, messages: out };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = 'anthropic' as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicOptions) {
    if (!opts.apiKey) throw new Error('AnthropicAdapter requires an API key reference');
    this.apiKey = opts.apiKey;
    // Misma convención que OpenAI y que `ai_provider.base_url`: la base incluye la versión de la API.
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' };
  }

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: controller.signal });
      if (!res.ok) {
        // Anthropic devuelve 400 (no 402) cuando no hay saldo. El cuerpo solo se usa
        // para clasificar ese rechazo conocido; no se propaga al consumidor.
        let kind = classify(res.status);
        if (res.status === 400) {
          try {
            const error = (await res.json()) as { error?: { message?: unknown } };
            if (typeof error.error?.message === 'string' && error.error.message.startsWith('Your credit balance is too low')) kind = 'insufficient_credit';
          } catch { /* Un cuerpo inválido sigue siendo bad_request, salvo timeout. */ }
        } else {
          await res.body?.cancel().catch(() => undefined);
        }
        if (controller.signal.aborted) throw new ProviderError('timeout', 0, 'AbortError');
        const retryAfter = Number(res.headers.get('retry-after'));
        throw new ProviderError(kind, res.status, `http_${res.status}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null);
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
      // El deadline cubre también la descarga/lectura del cuerpo, no solo las cabeceras.
      clearTimeout(timer);
    }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const converted = toAnthropicMessages(req.messages);
    const body: Record<string, unknown> = { model: req.model, max_tokens: req.maxTokens, messages: converted.messages };
    const outputConfig: Record<string, unknown> = {};
    const tools: Array<Record<string, unknown>> = (req.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    let outputTool: string | null = null;
    let system = converted.system;

    if (req.temperature !== null && req.temperature !== undefined && req.supportsTemperature) body.temperature = req.temperature;
    if (req.reasoningEffort) outputConfig.effort = req.reasoningEffort;

    if (req.responseSchema) {
      if (withinStructuredOutputLimits(req.responseSchema.schema)) {
        outputConfig.format = { type: 'json_schema', schema: req.responseSchema.schema };
      } else {
        outputTool = toolName(req.responseSchema.name, new Set(tools.map((t) => String(t.name))));
        tools.push({ name: outputTool, description: 'Entrega el resultado final con la estructura exigida.', input_schema: req.responseSchema.schema });
        const instruction = `Entrega el resultado final únicamente llamando a la herramienta «${outputTool}»; no escribas texto fuera de ella.`;
        system = system ? `${system}\n\n${instruction}` : instruction;
        // Forzar la herramienta solo cuando no hay otras (con herramientas el modelo decide) y el modelo lo admite.
        if (tools.length === 1 && !rejectsForcedToolChoice(req.model)) body.tool_choice = { type: 'tool', name: outputTool };
      }
    }
    if (tools.length) {
      body.tools = tools;
      if (!body.tool_choice) body.tool_choice = { type: 'auto' };
    }
    if (system) body.system = system;
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;

    const json = await this.post<MessagesResponse>('/messages', body, req.timeoutMs);
    if (!Array.isArray(json.content)) throw new ProviderError('bad_response', 200, 'no_content');

    const texts: string[] = [];
    const toolCalls: ChatResult['toolCalls'] = [];
    let structured: string | null = null;
    for (const block of json.content) {
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if (block.type === 'tool_use') {
        const args = JSON.stringify(block.input ?? {});
        if (outputTool && block.name === outputTool) structured = args;
        else toolCalls.push({ id: block.id ?? '', name: block.name ?? '', arguments: args });
      }
    }
    const u = json.usage ?? {};
    const usage: Usage = {
      // Entrada total = tokens no cacheados + escritura de caché + lectura de caché (estimación conservadora).
      inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0, // total facturable; incluye el pensamiento
      reasoningTokens: u.output_tokens_details?.thinking_tokens ?? 0,
      images: 0,
      costUsd: null,
    };
    return {
      content: structured ?? (texts.length ? texts.join('') : null),
      toolCalls,
      finishReason: json.stop_reason ?? null,
      providerModel: json.model ?? req.model,
      generationId: json.id ?? null,
      usage,
    };
  }

  async image(_req: ImageRequest): Promise<ImageResult> {
    throw new ProviderError('bad_request', 0, 'image_not_supported');
  }

  /** Comprobación sin costo: catálogo de modelos autenticado (no expone la clave). */
  async ping(timeoutMs = 10_000): Promise<{ ok: boolean; detail: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models?limit=1`, { headers: { 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION }, signal: controller.signal });
      await res.body?.cancel().catch(() => undefined);
      return { ok: res.ok, detail: res.ok ? 'credencial aceptada por el proveedor' : `el proveedor respondió ${res.status}` };
    } catch {
      return { ok: false, detail: 'sin conexión con el proveedor' };
    } finally {
      clearTimeout(timer);
    }
  }
}
