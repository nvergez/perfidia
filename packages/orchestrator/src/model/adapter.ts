import type { JsonObject, PlayerId } from "@perfidia/protocol";

// The provider-agnostic model contract (phase-2 design §2.1). The seat layer talks to a model only
// through `ModelAdapter`; the Anthropic adapter (`anthropic.ts`) is the only module that knows the
// SDK, and `FakeAdapter` (`fake.ts`) plays scripted or bot-backed replies with no network.

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type CacheTtl = "5m" | "1h";

/** Output tokens per call; a `max_tokens` stop is retried once with a larger limit. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
/** The smallest limit of the `max_tokens` retry. */
export const RETRY_MAX_OUTPUT_TOKENS = 32_000;
/** The output limit of every model of the price table (128K). */
export const MODEL_MAX_OUTPUT_TOKENS = 128_000;

/**
 * The limit of the retry after a `max_tokens` stop at `limit`: twice it, at least
 * `RETRY_MAX_OUTPUT_TOKENS`, at most the model's limit; `null` when that is no larger (no retry).
 */
export function retryOutputTokens(limit: number): number | null {
  const next = Math.min(MODEL_MAX_OUTPUT_TOKENS, Math.max(RETRY_MAX_OUTPUT_TOKENS, 2 * limit));
  return next > limit ? next : null;
}

/** Floor of the output charged for a stream that broke after it started (§5.3). */
export const BROKEN_STREAM_OUTPUT_FLOOR = 4_000;
/**
 * An upper bound of any priced model's output speed, in tokens per second: a stream that broke
 * after `s` seconds may have produced `400 × s` tokens. An assumption, checked against the
 * measured `output / latencyMs` of `llm_calls.jsonl` in calibration.
 */
export const OUTPUT_TOKENS_PER_S_BOUND = 400;

/**
 * The output charged for a stream that broke before its final usage arrived (aborted, cut, or an
 * error event): conservative, because the API may bill what was generated before the break, and
 * the streamed text undercounts it (summarized thinking is shorter than the thinking billed). The
 * largest of what was seen, the floor and `OUTPUT_TOKENS_PER_S_BOUND × streamed seconds`, capped
 * at the request's `max_tokens` (the real upper bound).
 */
export function brokenStreamOutput(o: {
  readonly observed: number;
  readonly maxTokens: number;
  readonly streamedMs: number;
}): number {
  const byTime = Math.ceil((Math.max(0, o.streamedMs) * OUTPUT_TOKENS_PER_S_BOUND) / 1000);
  return Math.min(o.maxTokens, Math.max(o.observed, BROKEN_STREAM_OUTPUT_FLOOR, byTime));
}

export interface ModelSpec {
  /** `anthropic` or `fake`; later other providers. */
  readonly provider: string;
  /** Exact model id, e.g. `claude-opus-5-5` (no date suffix). */
  readonly model: string;
  /** Always explicit: the API defaults differ by model. */
  readonly effort: Effort;
  readonly maxOutputTokens: number;
  /** TTL of the two stable system blocks. */
  readonly cacheTtl: CacheTtl;
}

/** The model part of a controller label, e.g. `anthropic/claude-opus-5-5/medium`. */
export function adapterLabel(spec: ModelSpec): string {
  return `${spec.provider}/${spec.model}/${spec.effort}`;
}

export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

/** Frozen for the whole match: `shared` is identical for every seat, `seat` for every wake of one seat. */
export interface StablePrompt {
  readonly shared: string;
  readonly seat: string;
}

export type UserPart =
  /** Game data only: the round-0 briefing JSON. */
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "result";
      readonly callId: string;
      readonly content: string;
      readonly isError: boolean;
    };

export interface ModelCall {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
}

/** One reply. `native` is the provider's own content, echoed back verbatim by the same adapter. */
export interface ModelReply {
  readonly native: unknown;
  /** Text blocks, in order. */
  readonly text: readonly string[];
  /** Tool calls, in order. */
  readonly calls: readonly ModelCall[];
  /** Readable reasoning summaries (and progress notes), for spectators only. */
  readonly reasoning: readonly string[];
}

export type Entry =
  | { readonly role: "user"; readonly parts: readonly UserPart[] }
  /**
   * Harness text. Anthropic: a mid-conversation `role: "system"` message. Providers without one
   * render it as a user text part after the results.
   */
  | { readonly role: "operator"; readonly text: string }
  | { readonly role: "assistant"; readonly reply: ModelReply };

/** For logging and fakes; adapters never send it. */
export interface CallMeta {
  readonly seat: PlayerId;
  readonly turn: number;
  readonly round: number;
  readonly maxRounds: number;
  readonly maxCalls: number;
  /** `thought`: the out-of-band thought call (§3.5), not a gateway round. */
  readonly kind: "round" | "thought";
}

export interface ChatRequest {
  readonly prompt: StablePrompt;
  readonly tools: readonly ModelTool[];
  /** Append-only within a turn; ends with a user or operator entry. */
  readonly entries: readonly Entry[];
  /** Overrides the spec (the `max_tokens` retry). */
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
  readonly meta: CallMeta;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause" | "other";

export interface TokenUsage {
  readonly input: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
  /** Thinking included. */
  readonly output: number;
}

export const ZERO_TOKENS: TokenUsage = Object.freeze({
  input: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
});

/** One billed attempt: the requested model, or a fallback model that served or declined. */
export interface UsageEntry {
  readonly model: string;
  readonly kind: "message" | "fallback";
  readonly tokens: TokenUsage;
  /** An aborted or broken stream: charged from what was seen, conservatively (§5.3, `brokenStreamOutput`). */
  readonly estimated: boolean;
}

export interface Refusal {
  readonly category: string | null;
  readonly explanation: string | null;
  /** Set when the fallback model could not run (rate-limited): logged, never followed. */
  readonly recommendedModel: string | null;
}

export interface ChatResult {
  readonly reply: ModelReply;
  readonly stop: StopReason;
  readonly rawStop: string;
  readonly refusal: Refusal | null;
  /** The model that produced the reply. */
  readonly servedBy: string;
  /** A fallback model served. */
  readonly fallback: boolean;
  readonly usage: readonly UsageEntry[];
  readonly requestId: string | null;
  readonly latencyMs: number;
  readonly ttftMs: number | null;
  /** The provider's response as JSON, for transcripts. */
  readonly raw: unknown;
}

export type ModelErrorKind =
  | "rate_limit"
  | "overloaded"
  | "server"
  | "timeout"
  | "connection"
  | "auth"
  | "billing"
  | "not_found"
  | "bad_request"
  | "too_large"
  | "aborted"
  | "unknown";

const RETRYABLE: ReadonlySet<ModelErrorKind> = new Set([
  "rate_limit",
  "overloaded",
  "server",
  "timeout",
  "connection",
]);

/** Kinds only an operator can fix (key, credit, model access): the arena pauses (§2.6). */
const OPERATOR: ReadonlySet<ModelErrorKind> = new Set(["auth", "billing", "not_found"]);

/** Non-retryable kinds that count toward the circuit breaker (§2.6). */
const BREAKER: ReadonlySet<ModelErrorKind> = new Set(["bad_request", "too_large", "unknown"]);

export const isRetryableKind = (kind: ModelErrorKind): boolean => RETRYABLE.has(kind);
export const isOperatorKind = (kind: ModelErrorKind): boolean => OPERATOR.has(kind);
export const isBreakerKind = (kind: ModelErrorKind): boolean => BREAKER.has(kind);

export interface ModelErrorInit {
  readonly status?: number | null;
  readonly requestId?: string | null;
  readonly retryAfterMs?: number | null;
  /** Usage known or estimated before the failure (an aborted stream). */
  readonly spent?: readonly UsageEntry[];
  readonly retryable?: boolean;
}

/** The only error `ModelAdapter.chat` rejects with. Its message is one line: no secret, no body. */
export class ModelError extends Error {
  override readonly name = "ModelError";
  readonly kind: ModelErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly spent: readonly UsageEntry[];

  constructor(kind: ModelErrorKind, message: string, init: ModelErrorInit = {}) {
    super(message);
    this.kind = kind;
    this.retryable = init.retryable ?? isRetryableKind(kind);
    this.status = init.status ?? null;
    this.requestId = init.requestId ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.spent = init.spent ?? [];
  }
}

export interface PreflightReport {
  readonly model: string;
  /** `allowed_fallback_models` of the model; `[]` when the provider has none. */
  readonly allowedFallbackModels: readonly string[];
  /** What the shape check and pre-warm cost. */
  readonly usage: readonly UsageEntry[];
}

export interface ModelAdapter {
  readonly spec: ModelSpec;
  /** The model part of the controller label, e.g. `anthropic/claude-opus-5-5/medium`. */
  readonly label: string;
  /** The provider request `chat` would send, built purely: cache-prefix tests and transcripts. */
  build(req: ChatRequest): unknown;
  /** Sends one request. Resolves on every completed response, refusals included; rejects with `ModelError` only. */
  chat(req: ChatRequest): Promise<ChatResult>;
  /** Checks credentials, model access, fallback prices and the exact request shape (§2.2). */
  preflight(sample: ChatRequest): Promise<PreflightReport>;
  /** The provider's count of the request's input tokens, when it has one (`arena smoke`). */
  countTokens?(req: ChatRequest): Promise<number>;
}

/** Total prompt tokens of one attempt: uncached input, cache writes and cache reads. */
export function promptTokens(t: TokenUsage): number {
  return t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
}

/** The attempt that produced the reply: the last usage entry. */
export function servedTokens(usage: readonly UsageEntry[]): TokenUsage {
  return usage.at(-1)?.tokens ?? ZERO_TOKENS;
}
