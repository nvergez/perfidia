import {
  EFFORTS,
  type Effort,
  type JsonObject,
  type PlayerId,
  type Provider,
  type PromptVariant,
} from "@perfidia/protocol";
import type { ModelCapabilities, ReasoningKind } from "./catalog.ts";

// The provider-agnostic model contract (phase-2 design §2.1; phase-4 design §2.1, Pass 1b). The
// seat layer talks to a model only through `ModelAdapter`; the Anthropic adapter (`anthropic.ts`)
// is the only module that knows the SDK, `http.ts` the only one that calls `fetch` (the guarded
// transport of every provider), and `FakeAdapter` (`fake.ts`) plays scripted or bot-backed replies
// with no network, mirroring an intended provider's operator channel. Provider-specific types never
// leave their adapter's file; everything here is additive to phase 2's contract.

/** The reasoning efforts (defined with the run-directory formats in `@perfidia/protocol`). */
export { EFFORTS, type Effort };
export type { ModelCapabilities, Provider, PromptVariant, ReasoningKind };

export type CacheTtl = "5m" | "1h";

/** Output tokens per call; a `max_tokens` stop is retried once with a larger limit. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
/** The smallest limit of the `max_tokens` retry. */
export const RETRY_MAX_OUTPUT_TOKENS = 32_000;
/** The output limit of the Claude and GPT-6 models (128K); others report theirs in `capabilities`. */
export const MODEL_MAX_OUTPUT_TOKENS = 128_000;

/**
 * The limit of the retry after a `max_tokens` stop at `limit`: twice it, at least
 * `RETRY_MAX_OUTPUT_TOKENS`, at most the model's own limit (`modelMax`, 128K by default; Gemini's
 * 65,536); `null` when that is no larger (no retry).
 */
export function retryOutputTokens(
  limit: number,
  modelMax: number = MODEL_MAX_OUTPUT_TOKENS,
): number | null {
  const next = Math.min(modelMax, Math.max(RETRY_MAX_OUTPUT_TOKENS, 2 * limit));
  return next > limit ? next : null;
}

/**
 * The output charged for a stream that broke before its final usage arrived (aborted, cut, or an
 * error event): the request's full `max_tokens` (phase-4 design §2.2). The API may bill whatever
 * was generated before the break, and nothing seen on the stream bounds it (summarized thinking is
 * shorter than the thinking billed), so only the request's limit is an upper bound: the ledger
 * never undercounts, and `arena reconcile` measures how pessimistic this is.
 */
export function brokenStreamOutput(maxTokens: number): number {
  return maxTokens;
}

/**
 * The prompt cap (phase-4 design §5.2): an attempt whose estimated prompt exceeds it is not sent,
 * and its turn closes (`prompt_cap`), so every attempt's prompt, and with it the attempt bound, is
 * bounded. 160,000 tokens keeps every attempt under the long-context tiers of the planned cards.
 */
export const DEFAULT_PROMPT_CAP_TOKENS = 160_000;

/**
 * The per-token prices `attemptBoundNano` reads, in integer pico-dollars (structurally the cards of
 * `prices/card.ts`, their long-context tiers and overrides folded in by the caller).
 */
export interface TokenPrices {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly write5m: number;
  readonly write1h: number;
}

/** The highest price any prompt token can be billed at on these cards (input, writes, reads). */
export function maxInputSide(cards: readonly TokenPrices[]): number {
  let m = 0;
  for (const c of cards) m = Math.max(m, c.input, c.cacheRead, c.write5m, c.write1h);
  return m;
}

/** The highest output price of these cards. */
export function maxOutputPrice(cards: readonly TokenPrices[]): number {
  let m = 0;
  for (const c of cards) m = Math.max(m, c.output);
  return m;
}

/** The most output one attempt of `spec` can request: the `max_tokens` retry's limit. */
export function maxAttemptOutput(
  spec: Pick<ModelSpec, "maxOutputTokens">,
  modelMax: number = MODEL_MAX_OUTPUT_TOKENS,
): number {
  return retryOutputTokens(spec.maxOutputTokens, modelMax) ?? spec.maxOutputTokens;
}

/**
 * The most one attempt of `spec` can cost, in nano-dollars (phase-4 design §5.2): a prompt of at
 * most `promptCap` tokens at the highest input-side price of the cards the served model can bill
 * (its long-context card included), plus the retry limit of output at the highest output price,
 * rounded up to nano-dollars, plus the platform fee (`feePermille`, rounded up); plus, when the
 * spec's server-side fallbacks are on, one such iteration per fallback target (the refused attempt
 * bills, then a cold-cache attempt on the target), each priced at `fallback`'s highest prices. A
 * charge of an attempt whose prompt and output stay within those limits never exceeds it, whatever
 * its split between input, cache writes and cache reads. Prices are pico-dollars per token.
 */
export function attemptBoundNano(
  spec: Pick<ModelSpec, "maxOutputTokens" | "fallbacks">,
  cards: {
    readonly served: readonly TokenPrices[];
    /** The cards of the fallback targets (one iteration per target). */
    readonly fallback: readonly (readonly TokenPrices[])[];
  },
  promptCap: number,
  o: {
    /** The served model's own output limit (the retry's ceiling); default 128K. */
    readonly modelMax?: number;
    /** The platform fee of the served model's cards, in permille. */
    readonly feePermille?: number;
  } = {},
): number {
  if (!Number.isSafeInteger(promptCap) || promptCap < 1) {
    throw new Error(`the prompt cap must be a positive integer, got ${promptCap}`);
  }
  if (cards.served.length === 0) throw new Error("attemptBoundNano needs the served model's cards");
  const out = maxAttemptOutput(spec, o.modelMax);
  const one = (c: readonly TokenPrices[], feePermille: number): number => {
    const nano = Math.ceil((promptCap * maxInputSide(c) + out * maxOutputPrice(c)) / 1000);
    return nano + (feePermille === 0 ? 0 : Math.ceil((nano * feePermille) / 1000));
  };
  let bound = one(cards.served, o.feePermille ?? 0);
  if (spec.fallbacks !== "off") for (const f of cards.fallback) bound += one(f, 0);
  if (!Number.isSafeInteger(bound))
    throw new Error(`attempt bound is not a safe integer: ${bound}`);
  return bound;
}

export interface ModelSpec {
  /** The provider that serves the model (a `Provider`; `fake` for the bot-backed model). */
  readonly provider: string;
  /** Exact model id, e.g. `claude-opus-5-5`, `gpt-6.1-sol`, `z-ai/glm-5.3` (no date suffix). */
  readonly model: string;
  /** OpenRouter: the pinned endpoint's full slug (`z-ai/fp8`); absent or null elsewhere. */
  readonly endpoint?: string | null;
  /** Always explicit: the API defaults differ by model. */
  readonly effort: Effort;
  readonly maxOutputTokens: number;
  /** TTL of the two stable system blocks. */
  readonly cacheTtl: CacheTtl;
  /**
   * Anthropic server-side refusal fallbacks (phase 4): `off` omits the parameter and its beta;
   * absent or `default` sends them on the models that have them (phase 2's behaviour). The arena
   * plan always sets it: `off` for Claude Sonnet 5.5 unless a lineup asks otherwise.
   */
  readonly fallbacks?: "default" | "off";
  /** OpenAI `reasoning.context` (`all_turns` on GPT-6.1 Sol); absent elsewhere. */
  readonly reasoningContext?: "auto" | "current_turn" | "all_turns";
  /** Recorded; Flex and priority tiers are out of scope. */
  readonly serviceTier?: "default";
}

// Controller labels (phase-4 design §2.1): `llm:<provider>/<model>[@<endpoint>]/<effort>:<profile>
// @<v>:p<PROMPT_VERSION>[-<variant>]`. In `<model>` and `<endpoint>`, `%` is written `%25`, `/`
// `%2F` and `@` `%40`; an id holding `:` is refused (so are OpenRouter's `:free` variants).
// Anthropic labels are byte-identical to phase 2's (their ids hold none of these characters).

/** The label suffix of a prompt variant: none for `system` (phase 2's bytes), `-dev`, `-env`. */
export const VARIANT_SUFFIX: Readonly<Record<PromptVariant, string>> = Object.freeze({
  system: "",
  developer: "-dev",
  envelope: "-env",
});

/** A model or endpoint id as a label part; throws on an id holding `:` or whitespace. */
export function encodeLabelPart(id: string): string {
  if (id === "" || /[:\s]/.test(id)) {
    throw new Error(
      `a model or endpoint id may not be empty or hold ":" or spaces: ${JSON.stringify(id)}`,
    );
  }
  return id.replaceAll("%", "%25").replaceAll("/", "%2F").replaceAll("@", "%40");
}

/** The inverse of `encodeLabelPart`; null for a malformed escape. */
export function decodeLabelPart(part: string): string | null {
  if (/%(?!25|2F|40)/i.test(part)) return null;
  return part.replaceAll(/%2F/gi, "/").replaceAll("%40", "@").replaceAll("%25", "%");
}

/** The model part of a controller label, e.g. `anthropic/claude-opus-5-5/medium`. */
export function adapterLabel(spec: ModelSpec): string {
  const endpoint =
    spec.endpoint === undefined || spec.endpoint === null
      ? ""
      : `@${encodeLabelPart(spec.endpoint)}`;
  return `${spec.provider}/${encodeLabelPart(spec.model)}${endpoint}/${spec.effort}`;
}

/** A controller label, parsed: what the label grammar says of an LLM seat. */
export interface ParsedLabel {
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string | null;
  readonly effort: Effort;
  readonly profile: string;
  readonly profileVersion: number;
  readonly promptVersion: number;
  readonly variant: PromptVariant;
}

const LABEL =
  /^llm:([a-z][a-z0-9-]*)\/([^/:@\s]+)(?:@([^/:@\s]+))?\/([a-z]+):([a-z][a-z0-9-]*)@([1-9][0-9]*):p([1-9][0-9]*)(?:-(dev|env))?$/;

/** Parses a controller label of the phase-4 grammar; null when it is not one. */
export function parseControllerLabel(label: string): ParsedLabel | null {
  const m = LABEL.exec(label);
  if (m === null) return null;
  const [, provider, rawModel, rawEndpoint, effortText, profile, v, p, suffix] = m;
  const effort = EFFORTS.find((e) => e === effortText);
  const model = rawModel === undefined ? null : decodeLabelPart(rawModel);
  const endpoint = rawEndpoint === undefined ? null : decodeLabelPart(rawEndpoint);
  if (
    provider === undefined ||
    model === null ||
    (rawEndpoint !== undefined && endpoint === null) ||
    effort === undefined ||
    profile === undefined
  ) {
    return null;
  }
  return {
    provider,
    model,
    endpoint,
    effort,
    profile,
    profileVersion: Number(v),
    promptVersion: Number(p),
    variant: suffix === "dev" ? "developer" : suffix === "env" ? "envelope" : "system",
  };
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
  /** Phase 4: what `reasoning` is (a provider's summary, raw text); absent: the adapter's kind. */
  readonly reasoningKind?: ReasoningKind;
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
  /** Phase 4: reasoning tokens, a part of `output`, where the provider reports them. */
  readonly reasoning?: number | undefined;
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
  /** An aborted or broken stream: charged conservatively (the full `max_tokens`, `brokenStreamOutput`). */
  readonly estimated: boolean;
  /**
   * The inference geography the provider reported when it is not the global default (Anthropic's
   * `usage.inference_geo: "us"`, billed 1.1×); absent: global, or not reported.
   */
  readonly geo?: string;
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
  /** Phase 4: the endpoint that served (OpenRouter's routing metadata); absent elsewhere. */
  readonly endpoint?: string | null;
  /** Phase 4: the provider's own cost of the attempt (OpenRouter `usage.cost`), nano-dollars. */
  readonly reportedCostNanoUsd?: number | null;
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
  /** What the (served or, for a fake, intended) model accepts and how it behaves (phase 4). */
  readonly capabilities: ModelCapabilities;
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
