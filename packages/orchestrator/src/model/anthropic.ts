import Anthropic, { type APIError } from "@anthropic-ai/sdk";
import type {
  BetaCacheControlEphemeral,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTool,
  BetaUsage,
  MessageCreateParamsBase,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  adapterLabel,
  brokenStreamOutput,
  ModelError,
  type CacheTtl,
  type ChatRequest,
  type ChatResult,
  type Effort,
  type Entry,
  type ModelAdapter,
  type ModelCall,
  type ModelCapabilities,
  type ModelErrorKind,
  type ModelReply,
  type ModelSpec,
  type ModelTool,
  type PreflightReport,
  type StopReason,
  type TokenUsage,
  type UsageEntry,
} from "./adapter.ts";
import { FALLBACK_TARGETS, capabilitiesFor } from "./catalog.ts";
import { guardedFetch, redact, type HttpFetch } from "./http.ts";

// The Anthropic adapter (phase-2 design §2.2–§2.6): the only module that imports the SDK.
//
// - The client gets an explicit API key and base URL and reads no `ANTHROPIC_*` variable that
//   matters: `authToken`, `webhookKey` and `logLevel` are explicit too, and the shared guarded
//   `fetch` (`http.ts`) sends only to the configured origin, with our `x-api-key`, no
//   `authorization` header and only the SDK's own headers, and never follows a redirect
//   (`redirect: "error"`, phase 4: Bun forwards `x-api-key` to another origin on a 307, so a
//   redirect would hand the key to its target). `ANTHROPIC_CUSTOM_HEADERS`, which the SDK reads
//   itself, is neutralised: the allowlist drops its other headers, our `defaultHeaders` override its
//   `anthropic-beta` (each request sends only its own betas) and the guarded fetch pins
//   `anthropic-version`.
// - `maxRetries: 0`: the harness owns every retry (seat/retry.ts), so each attempt is visible,
//   logged, priced and jittered.
// - Every call streams (`.stream().finalMessage()`): no idle connection while the model thinks, a
//   time-to-first-token, and a known partial usage when the stream breaks. `chat` keeps its own
//   reference to the latest snapshot (the SDK clears `currentMessage` when a body ends without
//   `message_stop`) and charges a broken stream conservatively: its prompt as `message_start`
//   reported it, and the request's full `max_tokens` of output (`brokenStreamOutput`).
// - Requests: adaptive thinking with `display: "summarized"` (never disabled, never a budget),
//   explicit `output_config.effort`, no `tool_choice` (forced use is a 400 on the 5.5 models), no
//   sampling parameters, no prefill; `tools` → `system[0]` (shared) → `system[1]` (seat), both
//   system blocks with `cache_control`, plus the automatic breakpoint on the growing tail; operator
//   entries are mid-conversation `role: "system"` messages; server-side `fallbacks: "default"` under
//   its beta for the models that have it, unless the spec says `fallbacks: "off"` (phase 4: the
//   default for Claude Sonnet 5.5, whose fallback model, Claude Sonnet 5, rejects the operator
//   entries).
// - Responses: `stop_reason` is checked before any content is read; refusals carry
//   `stop_details`; the assistant content is echoed back verbatim except for the fallback rule
//   (declined thinking and tool calls before the last `fallback` block are dropped).

/**
 * The models whose server-side refusal fallbacks this build plans (the catalog's targets): Claude
 * Opus 5.5 and Claude Sonnet 5.5. Claude Haiku 5.5 has none; Claude Fable 5.1's are not planned.
 */
export const FALLBACK_CAPABLE: ReadonlySet<string> = new Set(Object.keys(FALLBACK_TARGETS));
/** The beta of the `fallbacks: "default"` scalar form. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** The beta that makes `allowed_fallback_models` visible on `/v1/models`. */
export const MODELS_FALLBACK_BETA = "server-side-fallback-2026-06-01";

/** Whether a request of `spec` sends `fallbacks: "default"` (and its beta). */
export function fallbacksOn(spec: Pick<ModelSpec, "model" | "fallbacks">): boolean {
  return FALLBACK_CAPABLE.has(spec.model) && spec.fallbacks !== "off";
}

export const DEFAULT_BASE_URL = "https://api.anthropic.com";
/** The API version the SDK sends; pinned by the guarded fetch. */
export const ANTHROPIC_VERSION = "2023-06-01";

export type { HttpFetch };

export interface AnthropicClientOptions {
  /** `PERFIDIA_ANTHROPIC_API_KEY`, read once by the arena plan. */
  readonly apiKey: string;
  /** `PERFIDIA_ANTHROPIC_BASE_URL` or `DEFAULT_BASE_URL`; never the container's `ANTHROPIC_BASE_URL`. */
  readonly baseURL: string;
  /** Tests: a stub. Default: the global `fetch`. */
  readonly fetch?: HttpFetch;
  /** Per-attempt backstop in ms; the request's `AbortSignal` is the real deadline. Default 600 000. */
  readonly timeoutMs?: number;
}

/** Header names the SDK sends that the guarded fetch lets through; `x-api-key` is always ours. */
const ALLOWED_HEADER =
  /^(?:accept|content-type|user-agent|anthropic-version|anthropic-beta|x-stainless-[a-z0-9-]+)$/;

/** The efforts a Claude request takes (`output_config.effort`). */
type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** `effort` as a Claude effort; `none` and `minimal` are other vendors' (the plan refuses them). */
function claudeEffort(effort: Effort): ClaudeEffort {
  if (effort === "none" || effort === "minimal") {
    throw new Error(`Claude models take effort low, medium, high, xhigh or max, not ${effort}`);
  }
  return effort;
}

/** One SDK client per process, shared by every adapter (one connection pool). */
export class AnthropicClient {
  readonly baseURL: string;
  readonly sdk: Anthropic;
  /**
   * The key as it could appear in an error body (raw and URL-encoded): every error message is
   * redacted with these before it reaches a log, an alert or stderr (phase-4 review).
   */
  readonly secrets: readonly string[];

  constructor(o: AnthropicClientOptions) {
    if (o.apiKey.trim() === "") {
      throw new Error("the Anthropic API key is empty: set PERFIDIA_ANTHROPIC_API_KEY");
    }
    this.baseURL = o.baseURL;
    this.secrets = [...new Set([o.apiKey, encodeURIComponent(o.apiKey)])];
    this.sdk = new Anthropic({
      apiKey: o.apiKey,
      authToken: null,
      webhookKey: null,
      baseURL: o.baseURL,
      maxRetries: 0,
      timeout: o.timeoutMs ?? 600_000,
      logLevel: "warn",
      // Over `ANTHROPIC_CUSTOM_HEADERS`: no default beta (a request's own `betas` still apply).
      defaultHeaders: { "anthropic-beta": null, "anthropic-version": ANTHROPIC_VERSION },
      fetch: guardedFetch({
        baseURL: o.baseURL,
        auth: { header: "x-api-key", value: o.apiKey },
        allowHeaders: ALLOWED_HEADER,
        fixedHeaders: { "anthropic-version": ANTHROPIC_VERSION },
        ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
      }),
    });
  }
}

// Requests -------------------------------------------------------------------------------------

/** The streaming request body `chat` sends (`stream: true` is added by the SDK). */
export type AnthropicRequest = MessageCreateParamsBase;

function isBlockArray(value: unknown): value is BetaContentBlockParam[] {
  return (
    Array.isArray(value) &&
    value.every(
      (b: unknown) =>
        b !== null && typeof b === "object" && typeof Reflect.get(b, "type") === "string",
    )
  );
}

function toMessage(e: Entry, i: number, entries: readonly Entry[]): BetaMessageParam {
  if (e.role === "user") {
    const results: BetaContentBlockParam[] = [];
    const texts: BetaContentBlockParam[] = [];
    for (const p of e.parts) {
      if (p.kind === "result") {
        results.push({
          type: "tool_result",
          tool_use_id: p.callId,
          content: p.content,
          ...(p.isError ? { is_error: true } : {}),
        });
      } else {
        texts.push({ type: "text", text: p.text });
      }
    }
    if (results.length + texts.length === 0) throw new Error(`entry ${i}: an empty user entry`);
    // Tool results first, in call order; then text (only the round-0 briefing).
    return { role: "user", content: [...results, ...texts] };
  }
  if (e.role === "operator") {
    // A mid-conversation system message follows a user message and is last or followed by the
    // assistant reply; it is never the first message.
    const prev = entries[i - 1];
    const next = entries[i + 1];
    if (prev?.role !== "user") {
      throw new Error(`entry ${i}: an operator entry must follow a user entry`);
    }
    if (next !== undefined && next.role !== "assistant") {
      throw new Error(`entry ${i}: an operator entry must be last or followed by the reply`);
    }
    return { role: "system", content: e.text };
  }
  const native = e.reply.native;
  if (!isBlockArray(native)) throw new Error(`entry ${i}: the reply is not Anthropic content`);
  return { role: "assistant", content: native };
}

function checkEntries(entries: readonly Entry[]): void {
  if (entries[0]?.role !== "user") throw new Error("a conversation starts with a user entry");
  if (entries.at(-1)?.role === "assistant") {
    throw new Error("a conversation ends with a user or operator entry (no prefill)");
  }
}

// Responses ------------------------------------------------------------------------------------

/**
 * Token counts of a usage block. Without the TTL split (absent, not only null, on some responses)
 * every write is priced at `ttl`, the longest TTL the request marked: never under-charged.
 */
function tokensOf(
  u: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens: number | null;
    readonly cache_read_input_tokens: number | null;
    readonly cache_creation: {
      readonly ephemeral_5m_input_tokens: number;
      readonly ephemeral_1h_input_tokens: number;
    } | null;
  },
  ttl: CacheTtl,
): TokenUsage {
  const written = u.cache_creation_input_tokens ?? 0;
  const split = u.cache_creation ?? null;
  return {
    input: u.input_tokens,
    cacheWrite5m: split === null ? (ttl === "5m" ? written : 0) : split.ephemeral_5m_input_tokens,
    cacheWrite1h: split === null ? (ttl === "1h" ? written : 0) : split.ephemeral_1h_input_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens,
  };
}

/**
 * One entry per iteration when the API reports them, else one for the whole message. `ttl`: the
 * longest TTL of the request's markers, for writes reported without their TTL split.
 */
export function usageEntries(
  usage: BetaUsage,
  served: string,
  requested: string,
  ttl: CacheTtl = "5m",
  estimated = false,
): UsageEntry[] {
  const geo = geoOf(usage);
  const its = usage.iterations;
  if (its === null || its === undefined || its.length === 0) {
    return [usageEntry(served, "message", tokensOf(usage, ttl), estimated, geo)];
  }
  return its.map((it) => {
    const own: unknown = Reflect.get(it, "model");
    const model = typeof own === "string" && own !== "" ? own : undefined;
    if (it.type === "fallback_message") {
      return usageEntry(model ?? served, "fallback", tokensOf(it, ttl), estimated, geo);
    }
    const which = model ?? (it.type === "message" ? requested : served);
    return usageEntry(which, "message", tokensOf(it, ttl), estimated, geo);
  });
}

/** A usage entry, with its inference geography when one was reported. */
function usageEntry(
  model: string,
  kind: UsageEntry["kind"],
  tokens: TokenUsage,
  estimated: boolean,
  geo: string | undefined,
): UsageEntry {
  return geo === undefined
    ? { model, kind, tokens, estimated }
    : { model, kind, tokens, estimated, geo };
}

/**
 * Where the request's inference ran, when not the global default (phase-4 review): the
 * workspace's `default_inference_geo` applies when a request omits `inference_geo` (as ours do),
 * and US-only inference bills 1.1× on every token kind. Read from `usage.inference_geo`.
 */
export function geoOf(usage: { readonly inference_geo?: string | null }): string | undefined {
  const g: unknown = Reflect.get(usage, "inference_geo");
  return typeof g === "string" && g !== "" && g !== "global" ? g : undefined;
}

/**
 * The content to echo back (§2.3): verbatim, except that before the last `fallback` block only
 * text blocks and the `fallback` markers are kept (the declined model's thinking, tool calls and
 * other model-internal blocks are dropped, as the fallback echo rule requires).
 */
export function echoContent(content: readonly unknown[]): unknown[] {
  let last = -1;
  for (const [i, b] of content.entries()) if (blockType(b) === "fallback") last = i;
  if (last < 0) return [...content];
  return content.filter(
    (b, i) => i >= last || blockType(b) === "text" || blockType(b) === "fallback",
  );
}

function blockType(b: unknown): unknown {
  return b !== null && typeof b === "object" ? Reflect.get(b, "type") : undefined;
}

function replyOf(native: unknown[]): ModelReply {
  const text: string[] = [];
  const calls: ModelCall[] = [];
  const reasoning: string[] = [];
  for (const b of native) {
    if (b === null || typeof b !== "object") continue;
    const type: unknown = Reflect.get(b, "type");
    if (type === "text") {
      const t: unknown = Reflect.get(b, "text");
      if (typeof t === "string") text.push(t);
    } else if (type === "tool_use") {
      const id: unknown = Reflect.get(b, "id");
      const name: unknown = Reflect.get(b, "name");
      if (typeof id === "string" && typeof name === "string") {
        calls.push({ callId: id, name, args: Reflect.get(b, "input") });
      }
    } else if (type === "thinking") {
      const t: unknown = Reflect.get(b, "thinking");
      if (typeof t === "string" && t !== "") reasoning.push(t);
    }
  }
  return { native, text, calls, reasoning };
}

const EMPTY_REPLY: ModelReply = Object.freeze({
  native: Object.freeze([]),
  text: Object.freeze([]),
  calls: Object.freeze([]),
  reasoning: Object.freeze([]),
});

export function stopOf(raw: string | null): StopReason {
  if (raw === null) return "other";
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "pause_turn":
      return "pause";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

// Errors ---------------------------------------------------------------------------------------

function retryAfterMs(headers: Headers | undefined): number | null {
  if (headers === undefined) return null;
  const ms = Number(headers.get("retry-after-ms") ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);
  const s = Number(headers.get("retry-after") ?? Number.NaN);
  if (Number.isFinite(s) && s >= 0) return Math.ceil(s * 1000);
  return null;
}

function oneLine(s: string): string {
  const line = s.replaceAll(/\s+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/** The SSE `error` event of a broken stream carries no status: classify by the error type. */
function kindOfType(type: string | null): ModelErrorKind {
  if (type === null) return "unknown";
  switch (type) {
    case "overloaded_error":
      return "overloaded";
    case "api_error":
      return "server";
    case "rate_limit_error":
      return "rate_limit";
    case "billing_error":
      return "billing";
    case "authentication_error":
    case "permission_error":
      return "auth";
    case "not_found_error":
      return "not_found";
    case "invalid_request_error":
      return "bad_request";
    case "request_too_large":
      return "too_large";
    case "timeout_error":
      return "timeout";
    default:
      return "unknown";
  }
}

/**
 * SDK error → `ModelError`, most specific class first (§2.6). The SDK's message embeds the error
 * body; `secrets` (the client's key) are redacted from it, so a key an upstream echoes (a proxy, a
 * gateway, an auth error) never reaches a log (phase-4 review).
 */
export function modelErrorOf(
  e: unknown,
  spent: readonly UsageEntry[],
  secrets: readonly string[] = [],
): ModelError {
  if (e instanceof ModelError) return e;
  const line = (message: string): string => oneLine(redact(message, secrets));
  const make = (kind: ModelErrorKind, err: APIError | null, message: string) =>
    new ModelError(kind, line(message), {
      status: err?.status ?? null,
      requestId: err?.requestID ?? null,
      retryAfterMs: retryAfterMs(err?.headers),
      spent,
    });
  if (e instanceof Anthropic.APIUserAbortError) return make("aborted", e, "request aborted");
  if (e instanceof Anthropic.APIConnectionTimeoutError) return make("timeout", e, e.message);
  if (e instanceof Anthropic.APIConnectionError) {
    const cause: unknown = e.cause;
    const why = cause instanceof Error ? `${e.message} (${cause.message})` : e.message;
    return make("connection", e, why);
  }
  if (e instanceof Anthropic.RateLimitError) return make("rate_limit", e, e.message);
  if (e instanceof Anthropic.InternalServerError) {
    const overloaded = e.status === 529 || e.type === "overloaded_error";
    return make(overloaded ? "overloaded" : "server", e, e.message);
  }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return make("auth", e, e.message);
  }
  if (e instanceof Anthropic.NotFoundError) return make("not_found", e, e.message);
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.UnprocessableEntityError) {
    return make("bad_request", e, e.message);
  }
  if (e instanceof Anthropic.APIError) {
    // The typed `type` union lags the API (no `billing_error`): compare it as a plain string.
    const type: string | null = e.type;
    if (e.status === 402 || type === "billing_error") return make("billing", e, e.message);
    if (e.status === 413 || type === "request_too_large") return make("too_large", e, e.message);
    if (e.status === undefined) return make(kindOfType(type), e, e.message);
    return make("unknown", e, e.message);
  }
  if (e instanceof Anthropic.AnthropicError) {
    // Raised by the stream itself, not by an HTTP status: the body broke or ended early (a reset,
    // `TypeError: terminated`, no `message_stop`). A transport failure: retryable, out of the breaker.
    const cause: unknown = e.cause;
    const why = cause instanceof Error && cause.message !== e.message ? ` (${cause.message})` : "";
    return new ModelError("connection", line(`the stream broke: ${e.message}${why}`), { spent });
  }
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new ModelError("unknown", line(message), { spent });
}

/** What `chat` saw of a stream before it broke. */
export interface StreamSeen {
  /** The latest snapshot (`undefined`: the stream never started, nothing was billed). */
  readonly snapshot: BetaMessage | undefined;
  /** A `message_delta` arrived: the snapshot's usage is the API's final count. */
  readonly final: boolean;
  /** Wall ms from `message_start` to the break. */
  readonly streamedMs: number;
  /** The requested model and the request's `max_tokens`. */
  readonly model: string;
  readonly maxTokens: number;
  /** The longest TTL of the request's cache markers. */
  readonly ttl: CacheTtl;
  /**
   * The models of the `fallback` blocks seen (their `to.model`, phase-4 review): each switch runs
   * the turn again on the target, cold, inside the same stream; their usage arrives only with
   * `message_delta`.
   */
  readonly fallbacks?: readonly string[];
}

/**
 * What a broken stream cost before it broke (phase-4 design §2.2), flagged `estimated`: nothing
 * when it never started (no `message_start`: no inference ran); the final usage when
 * `message_delta` arrived; else the prompt as `message_start` reported it (its input and cache
 * split are final) and the request's full `max_tokens` of output (`brokenStreamOutput`).
 */
export function spentOf(seen: StreamSeen): UsageEntry[] {
  const snapshot = seen.snapshot;
  if (snapshot === undefined) return [];
  if (seen.final) return usageEntries(snapshot.usage, snapshot.model, seen.model, seen.ttl, true);
  const t = tokensOf(snapshot.usage, seen.ttl);
  const output = brokenStreamOutput(seen.maxTokens);
  const geo = geoOf(snapshot.usage);
  const hops = seen.fallbacks ?? [];
  // The SDK's snapshot takes a fallback block's target as its model: the refused iteration that
  // message_start reported ran on the requested model.
  const first = hops.length > 0 ? seen.model : snapshot.model;
  const out = [usageEntry(first, "message", { ...t, output }, true, geo)];
  // A switch to a fallback model before the break (phase-4 review): the target ran the whole
  // prompt cold (written at the request's TTL, the dearest prompt kind it can bill) and may have
  // produced the full `max_tokens`; message_start reported only the refused iteration.
  const prompt = t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
  const cold: TokenUsage = {
    input: 0,
    cacheWrite5m: seen.ttl === "5m" ? prompt : 0,
    cacheWrite1h: seen.ttl === "1h" ? prompt : 0,
    cacheRead: 0,
    output,
  };
  for (const model of hops) out.push(usageEntry(model, "fallback", cold, true, geo));
  return out;
}

/** The target model of a `content_block_start` event's `fallback` block; null for any other. */
function fallbackTarget(event: { readonly type: string }): string | null {
  if (event.type !== "content_block_start") return null;
  const block: unknown = Reflect.get(event, "content_block");
  if (block === null || typeof block !== "object" || Reflect.get(block, "type") !== "fallback") {
    return null;
  }
  const to: unknown = Reflect.get(block, "to");
  const model: unknown = to !== null && typeof to === "object" ? Reflect.get(to, "model") : null;
  return typeof model === "string" && model !== "" ? model : null;
}

// The adapter ----------------------------------------------------------------------------------

export interface AnthropicAdapterOptions {
  /** Wall ms for latency and time to first token; default `performance.now`. */
  readonly nowMs?: () => number;
}

export class AnthropicAdapter implements ModelAdapter {
  readonly spec: ModelSpec;
  readonly label: string;
  readonly capabilities: ModelCapabilities;
  private readonly client: AnthropicClient;
  private readonly nowMs: () => number;
  private readonly toolCache = new WeakMap<readonly ModelTool[], readonly BetaTool[]>();

  constructor(spec: ModelSpec, client: AnthropicClient, o: AnthropicAdapterOptions = {}) {
    if (spec.provider !== "anthropic") throw new Error(`not an Anthropic spec: ${spec.provider}`);
    this.spec = spec;
    this.label = adapterLabel(spec);
    this.capabilities = capabilitiesFor("anthropic", spec.model);
    this.client = client;
    this.nowMs = o.nowMs ?? (() => Math.floor(performance.now()));
  }

  /** The tools array, computed once per tool list (frozen for the match: stable bytes). */
  private toolsOf(tools: readonly ModelTool[]): BetaTool[] {
    let out = this.toolCache.get(tools);
    if (out === undefined) {
      out = Object.freeze(
        tools.map((t) =>
          Object.freeze({
            name: t.name,
            description: t.description,
            input_schema: { type: "object" as const, ...t.inputSchema },
          }),
        ),
      );
      this.toolCache.set(tools, out);
    }
    return [...out];
  }

  build(req: ChatRequest): AnthropicRequest {
    checkEntries(req.entries);
    const s = this.spec;
    const ttl: BetaCacheControlEphemeral =
      s.cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    return {
      model: s.model,
      max_tokens: req.maxOutputTokens ?? s.maxOutputTokens,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: claudeEffort(s.effort) },
      tools: this.toolsOf(req.tools),
      system: [
        { type: "text", text: req.prompt.shared, cache_control: ttl },
        { type: "text", text: req.prompt.seat, cache_control: ttl },
      ],
      cache_control: { type: "ephemeral" },
      messages: req.entries.map((e, i) => toMessage(e, i, req.entries)),
      ...(fallbacksOn(s) ? { betas: [FALLBACK_BETA], fallbacks: "default" } : {}),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body = this.build(req);
    const t0 = this.nowMs();
    let ttftMs: number | null = null;
    let snapshot: BetaMessage | undefined;
    let startedAt: number | null = null;
    let final = false;
    const fallbacks: string[] = [];
    const stream = this.client.sdk.beta.messages.stream(body, {
      maxRetries: 0,
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    });
    stream.on("streamEvent", (event, snap) => {
      snapshot = snap;
      if (event.type === "message_start") startedAt ??= this.nowMs();
      else if (event.type === "message_delta") final = true;
      else if (ttftMs === null && event.type === "content_block_delta") ttftMs = this.nowMs() - t0;
      const target = fallbackTarget(event);
      if (target !== null) fallbacks.push(target);
    });
    let msg: BetaMessage;
    try {
      msg = await stream.finalMessage();
    } catch (e) {
      const spent = spentOf({
        snapshot,
        final,
        streamedMs: startedAt === null ? 0 : this.nowMs() - startedAt,
        model: this.spec.model,
        maxTokens: body.max_tokens,
        ttl: this.spec.cacheTtl,
        fallbacks,
      });
      throw modelErrorOf(e, spent, this.client.secrets);
    }
    return this.resultOf(msg, stream.request_id ?? null, this.nowMs() - t0, ttftMs);
  }

  private resultOf(
    msg: BetaMessage,
    requestId: string | null,
    latencyMs: number,
    ttftMs: number | null,
  ): ChatResult {
    // The stop reason first: a refused reply's content is never read for actions.
    const rawStop = msg.stop_reason ?? "null";
    const stop = stopOf(msg.stop_reason);
    const raw = structuredClone(msg);
    const usage = usageEntries(msg.usage, msg.model, this.spec.model, this.spec.cacheTtl);
    const fallback =
      usage.some((u) => u.kind === "fallback") || msg.content.some((b) => b.type === "fallback");
    const common = { rawStop, servedBy: msg.model, fallback, usage, requestId, latencyMs, ttftMs };
    if (stop === "refusal") {
      const d = msg.stop_details;
      return {
        ...common,
        reply: EMPTY_REPLY,
        stop,
        refusal: {
          category: d?.category ?? null,
          explanation: d?.explanation ?? null,
          recommendedModel: d?.recommended_model ?? null,
        },
        raw,
      };
    }
    return { ...common, reply: replyOf(echoContent(raw.content)), stop, refusal: null, raw };
  }

  /**
   * The input tokens of `req` (`count_tokens`, free, no inference): tools, both system blocks and
   * the messages, with the same thinking and effort. `arena smoke` checks the prefix size with it.
   */
  async countTokens(req: ChatRequest): Promise<number> {
    const body = this.build(req);
    try {
      const out = await this.client.sdk.beta.messages.countTokens(
        {
          model: body.model,
          messages: body.messages,
          ...(body.system === undefined ? {} : { system: body.system }),
          ...(body.tools === undefined ? {} : { tools: body.tools }),
          ...(body.thinking === undefined ? {} : { thinking: body.thinking }),
          ...(body.output_config === undefined ? {} : { output_config: body.output_config }),
        },
        { maxRetries: 0 },
      );
      return out.input_tokens;
    } catch (e) {
      throw modelErrorOf(e, [], this.client.secrets);
    }
  }

  async preflight(sample: ChatRequest): Promise<PreflightReport> {
    const model = this.spec.model;
    let allowed: readonly string[];
    try {
      const info = await this.client.sdk.beta.models.retrieve(
        model,
        { betas: [MODELS_FALLBACK_BETA] },
        { maxRetries: 0 },
      );
      allowed = info.allowed_fallback_models ?? [];
    } catch (e) {
      throw modelErrorOf(e, [], this.client.secrets);
    }
    // The exact production shape, non-streamed with `max_tokens: 0` (a pre-warm cannot stream):
    // it validates betas, tool schemas and `display` before the run directory exists, and writes
    // the shared prefix once. The markers stay on the system blocks, no automatic breakpoint.
    const { cache_control: _auto, ...shape } = this.build(sample);
    try {
      const msg = await this.client.sdk.beta.messages.create(
        { ...shape, max_tokens: 0, stream: false },
        { maxRetries: 0 },
      );
      return {
        model,
        allowedFallbackModels: allowed,
        usage: usageEntries(msg.usage, msg.model, model, this.spec.cacheTtl),
      };
    } catch (e) {
      throw modelErrorOf(e, [], this.client.secrets);
    }
  }
}
