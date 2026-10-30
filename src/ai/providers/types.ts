/** Contrato común de los adaptadores de proveedores de IA (ARC-0001 §4). */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  responseSchema?: { name: string; schema: Record<string, unknown> } | null;
  tools?: ToolSpec[];
  temperature?: number | null;
  maxTokens: number;
  /** Solo se envía temperature si el modelo la admite (los modelos de razonamiento la rechazan). */
  supportsTemperature?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high' | null;
  timeoutMs: number;
  /** Contexto para el simulador (nunca se envía a proveedores reales). */
  simulation?: { useCaseId: string; values: Record<string, unknown> };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  images: number;
  /** Costo informado por el proveedor (USD); null si no lo informa. */
  costUsd: number | null;
}

export interface ChatResult {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  providerModel: string;
  generationId: string | null;
  usage: Usage;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  aspectRatio: '16:9' | '4:3' | '1:1' | '3:4' | '4:5';
  resolution?: string | null;
  timeoutMs: number;
}

export interface ImageResult {
  bytes: Buffer;
  mediaType: string;
  providerModel: string;
  usage: Usage;
}

export interface ProviderAdapter {
  readonly kind: 'openrouter' | 'simulated';
  chat(req: ChatRequest): Promise<ChatResult>;
  image(req: ImageRequest): Promise<ImageResult>;
  ping(timeoutMs?: number): Promise<{ ok: boolean; detail: string }>;
}

export class ProviderError extends Error {
  readonly kind: 'auth' | 'insufficient_credit' | 'timeout' | 'rate_limited' | 'unavailable' | 'bad_request' | 'bad_response' | 'network' | 'policy_blocked';
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(kind: ProviderError['kind'], status: number, code: string, retryAfterMs: number | null = null) {
    super(code);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  get retryable(): boolean {
    return ['timeout', 'rate_limited', 'unavailable', 'network'].includes(this.kind);
  }
}
