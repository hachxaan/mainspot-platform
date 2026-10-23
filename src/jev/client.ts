/**
 * JevClient — a provider and credential snapshot, with no runtime fallback.
 *
 * Vendored from the hyper-jev skill core (templates/starter/src/core/client.ts)
 * and adapted to MainSpot conventions:
 *  - `src/shared/config.ts` is the ONLY environment reader. The client never
 *    reads process.env: the caller names the provider and passes the key
 *    (no key-based auto-selection, no JEV_BACKEND/OPENROUTER_API_KEY lookup).
 *  - `maxAttempts` bounds retries (MainSpot shadow mode uses 1 = no retries).
 *  - `defaultModel` exposes the model ID sent when no per-call override exists.
 *  - Non-2xx responses throw `JevHttpError` carrying the status code.
 * Transport, contract validation, raw-body retention and cost accounting are
 * otherwise unchanged. The mock provider is for tests only.
 */
import { MockJev } from "./mock.ts";
import {
  QuestionValidationError,
  validateRequest,
  type Questions,
  type State,
  type SystemOneRequest,
  type SystemOneResponse,
} from "./types.ts";

export type JevProvider = "mock" | "openrouter" | "typesafe";

const ENDPOINTS = {
  openrouter: "https://openrouter.ai/api/alpha/decisions",
  typesafe: "https://api.typesafe.ai/v1/systemone",
} as const;

const DEFAULT_MODELS = {
  openrouter: "~typesafe/jev-latest",
  typesafe: "jev-latest",
} as const;

const KEY_NAMES = {
  openrouter: "OPENROUTER_API_KEY",
  typesafe: "TYPESAFE_API_KEY",
} as const;

const RETRY_STATUSES = new Set([429, 502, 503, 529]);
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

/** Caller-supplied USD prices; no assumed provider/model rates. */
export interface JevPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export type JevCost =
  | { amount: number; source: "reported" | "estimated" | "mock" }
  | { amount: null; source: "unknown" };

export interface JevClientOptions {
  /** Selected once per instance; never switched because a request failed. */
  provider: JevProvider;
  /** Required (nonblank) for live providers; never read from the environment here. */
  apiKey?: string;
  /** Full endpoint URL (not an origin). Redirects are refused. */
  baseUrl?: string;
  /** Pin a versioned model ID instead of the moving alias. */
  model?: string;
  /** Total budget including retries and response bodies. Default: 30,000 ms. */
  timeoutMs?: number;
  /** Exponential backoff base, plus up to 20% jitter. Default: 500 ms; 0 is allowed. */
  retryDelayMs?: number;
  /** Total HTTP attempts per call (1 = no retries). Default: 3. */
  maxAttempts?: number;
  /** Used only when usage.cost is not a valid reported cost. Snapshotted at construction. */
  pricing?: JevPricing;
}

export interface JevRawExchange {
  /** Snapshot of the JSON sent; no credentials or headers. */
  request: SystemOneRequest;
  requestText: string;
  /** Unenriched provider payload, including unknown fields. */
  response: SystemOneResponse;
  /** Exact response body text; mock responses use synthetic JSON. */
  responseText: string;
}

export interface SystemOneResult extends SystemOneResponse {
  raw: JevRawExchange;
  meta: {
    provider: JevProvider;
    requestedModel: string;
    resolvedModel: string;
    elapsedMs: number;
    attempts: number;
    /** USD, or null when no trustworthy cost is available. */
    cost: JevCost;
  };
}

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/** Non-success HTTP status from the provider. The body is discarded, never attached. */
export class JevHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "JevHttpError";
    this.status = status;
  }
}

/** Live observation of every call — the web layer streams these to the UI. */
export type JevEvent =
  | { kind: "request"; provider: JevProvider; model: string; state: State; questions: Questions }
  | { kind: "response"; result: SystemOneResult };

export class JevClient {
  readonly provider: JevProvider;
  private readonly apiKey?: string;
  private readonly endpoint?: string;
  private readonly mock = new MockJev();
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly pricing?: JevPricing;
  private listeners: ((event: JevEvent) => void)[] = [];
  /** Count of validated systemOne calls, for the demo's cost story. */
  calls = 0;

  constructor(opts: JevClientOptions) {
    if (opts.provider !== "mock" && opts.provider !== "typesafe" && opts.provider !== "openrouter") {
      throw new Error(`Unknown Jev provider "${String(opts.provider)}"; use mock, openrouter, or typesafe.`);
    }
    if (opts.apiKey !== undefined && opts.provider === "mock") {
      throw new Error("apiKey requires an explicit live provider (typesafe or openrouter).");
    }
    this.provider = opts.provider;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
    this.maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new Error("timeoutMs must be a positive integer no greater than 2147483647.");
    }
    if (!isNonnegative(this.retryDelayMs)) throw new Error("retryDelayMs must be finite and nonnegative.");
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error("maxAttempts must be a positive integer.");
    }
    if (opts.pricing !== undefined) {
      if (!opts.pricing || !isNonnegative(opts.pricing.inputPerMillion) || !isNonnegative(opts.pricing.outputPerMillion)) {
        throw new Error("pricing requires finite, nonnegative inputPerMillion and outputPerMillion USD rates.");
      }
      this.pricing = { ...opts.pricing };
    }
    if (this.provider === "mock") return;
    this.apiKey = opts.apiKey?.trim();
    this.endpoint = opts.baseUrl ?? ENDPOINTS[this.provider];
    if (!this.apiKey) {
      throw new Error(`Provider "${this.provider}" needs a nonblank apiKey (${KEY_NAMES[this.provider]}).`);
    }
  }

  /** Model ID sent when a call does not override it: configured model or the provider alias. */
  get defaultModel(): string {
    if (this.model !== undefined) return this.model;
    return this.provider === "mock" ? this.mock.model : DEFAULT_MODELS[this.provider];
  }

  get isLive(): boolean {
    return this.provider !== "mock";
  }

  /** Observe every request and response this client makes. */
  on(listener: (event: JevEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: JevEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async systemOne(
    state: State,
    questions: Questions,
    opts: { model?: string; signal?: AbortSignal } = {}
  ): Promise<SystemOneResult> {
    opts.signal?.throwIfAborted();
    const requestedModel = opts.model ?? this.defaultModel;
    const body: SystemOneRequest = { model: requestedModel, state, questions };
    validateRequest(body);
    let requestText: string;
    try {
      requestText = JSON.stringify(body);
    } catch {
      throw new QuestionValidationError("Request must be JSON-serializable (no cycles or BigInt).");
    }
    const request: SystemOneRequest = JSON.parse(requestText);
    // Validate the actual wire snapshot too (e.g. user-defined toJSON methods).
    validateRequest(request);
    this.calls++;
    const started = performance.now();
    this.emit({ kind: "request", provider: this.provider, model: requestedModel, state, questions });

    if (this.provider === "mock") {
      opts.signal?.throwIfAborted();
      const response = this.mock.systemOne(request);
      const raw = { request, requestText, response, responseText: JSON.stringify(response) };
      const out = withMeta(raw, this.provider, requestedModel, started, 1, this.pricing);
      this.emit({ kind: "response", result: out });
      return out;
    }

    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(new DOMException("Jev request timed out.", "TimeoutError"));
    }, this.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([deadline.signal, opts.signal]) : deadline.signal;
    try {
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        signal.throwIfAborted();
        const res = await fetch(this.endpoint!, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: requestText,
          signal,
          redirect: "error",
        });
        signal.throwIfAborted();
        if (RETRY_STATUSES.has(res.status) && attempt < this.maxAttempts) {
          const backoff = this.retryDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.2);
          const delay = Math.min(8000, Math.max(backoff, retryAfterMs(res.headers.get("retry-after"))));
          await res.body?.cancel();
          await sleep(delay, signal);
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel();
          const hint = res.status === 401 ? ` Check the ${KEY_NAMES[this.provider]} key.`
            : res.status === 402 ? " Check account credits." : "";
          throw new JevHttpError(`${this.provider} HTTP ${res.status}.${hint}`, res.status);
        }
        const responseText = await res.text();
        signal.throwIfAborted();
        let response: unknown;
        try {
          response = JSON.parse(responseText);
        } catch {
          throw new ContractError("Invalid response JSON.");
        }
        validateResponse(response, request.questions);
        const raw = { request, requestText, response, responseText };
        const out = withMeta(raw, this.provider, requestedModel, started, attempt, this.pricing);
        this.emit({ kind: "response", result: out });
        return out;
      }
      throw new Error(`${this.provider} retries exhausted`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function resultCost(response: SystemOneResponse, provider: JevProvider, pricing?: JevPricing): JevCost {
  if (provider === "mock") return { amount: 0, source: "mock" };
  if (isNonnegative(response.usage.cost)) return { amount: response.usage.cost, source: "reported" };
  if (pricing) {
    const amount = response.usage.input_tokens / 1_000_000 * pricing.inputPerMillion +
      response.usage.output_tokens / 1_000_000 * pricing.outputPerMillion;
    if (isNonnegative(amount)) return { amount, source: "estimated" };
  }
  return { amount: null, source: "unknown" };
}

function withMeta(
  raw: JevRawExchange,
  provider: JevProvider,
  requestedModel: string,
  started: number,
  attempts: number,
  pricing?: JevPricing
): SystemOneResult {
  return {
    // Separate nested answers/usage from raw; enrichment never edits provider data.
    ...structuredClone(raw.response),
    raw,
    meta: {
      provider,
      requestedModel,
      resolvedModel: raw.response.model,
      elapsedMs: Math.round(performance.now() - started),
      attempts,
      cost: resultCost(raw.response, provider, pricing),
    },
  };
}

/** Ignore malformed/negative values instead of letting NaN erase the backoff. */
function retryAfterMs(header: string | null): number {
  if (!header?.trim()) return 0;
  const value = header.trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isFinite(ms) ? ms : 0;
  }
  // HTTP-date forms begin with a weekday; Date.parse alone also accepts "-1".
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(value)) return 0;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const isNonnegative = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0;
const isUnit = (x: unknown): x is number => isNonnegative(x) && x <= 1;
const isTokenCount = (x: unknown): x is number => isNonnegative(x) && Number.isSafeInteger(x);

/** Strict live contract; unknown payload fields are deliberately retained. */
export function validateResponse(response: unknown, questions: Questions): asserts response is SystemOneResponse {
  if (!isObject(response) || !isObject(response.answers) || typeof response.model !== "string" || !response.model.trim()) {
    throw new ContractError("Invalid response envelope: expected model and answers.");
  }
  if (!isObject(response.usage) || !isTokenCount(response.usage.input_tokens) || !isTokenCount(response.usage.output_tokens)) {
    throw new ContractError("Invalid response usage: expected nonnegative integer input_tokens and output_tokens.");
  }
  for (const [id, q] of Object.entries(questions)) {
    const answer = response.answers[id];
    if (!Object.hasOwn(response.answers, id) || !isObject(answer) || answer.type !== q.type) {
      throw new ContractError(`Missing or mismatched answer: ${id}`);
    }
    if (q.type === "noul") {
      if (!isUnit(answer.noul)) throw new ContractError(`Invalid noul: ${id}`);
      continue;
    }
    if (!isUnit(answer.confidence) || !isObject(answer.probabilities)) {
      throw new ContractError(`Invalid distribution: ${id}`);
    }
    const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
    const probs = answer.probabilities;
    if (Object.keys(probs).length !== keys.length || !keys.every((k) => Object.hasOwn(probs, k) && isUnit(probs[k]))) {
      throw new ContractError(`Distribution keys must match the declared criteria: ${id}`);
    }
    const sum = keys.reduce((acc, k) => acc + (probs[k] as number), 0);
    if (Math.abs(sum - 1) > 0.025) throw new ContractError(`Distribution does not sum to one: ${id} (${sum})`);
    if (q.type === "choice" && (typeof answer.choice !== "string" || !keys.includes(answer.choice))) {
      throw new ContractError(`Undeclared choice returned: ${id}`);
    }
    if (q.type === "score") {
      if (!isNonnegative(answer.score) || answer.score > keys.length - 1) {
        throw new ContractError(`Score out of range: ${id}`);
      }
      const legend = answer.legend;
      if (!isObject(legend) || Object.keys(legend).length !== keys.length ||
        !keys.every((k, i) => Object.hasOwn(legend, k) && legend[k] === q.criteria[i])) {
        throw new ContractError(`Score legend must match the declared criteria: ${id}`);
      }
    }
  }
}
