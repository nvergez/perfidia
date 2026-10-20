import type { TimeSource } from "@perfidia/protocol";
import {
  adapterLabel,
  brokenStreamOutput,
  ModelError,
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
  type Refusal,
  type StopReason,
  type UsageEntry,
} from "./adapter.ts";
import { capabilitiesFor } from "./catalog.ts";
import { timeoutSignal } from "./clock.ts";
import {
  classifyHttpError,
  guardedFetch,
  httpModelError,
  oneLine,
  readSse,
  redact,
  transportError,
  type HttpFetch,
  type SseEvent,
} from "./http.ts";
import {
  ErrorBodySchema,
  FunctionCallItemSchema,
  InputTokensSchema,
  MessageItemSchema,
  ModelObjectSchema,
  ReasoningItemSchema,
  StreamErrorEventSchema,
  TERMINAL_EVENTS,
  TerminalResponseEventSchema,
  UsageSchema,
  type FunctionTool,
  type InputItem,
  type InputMessage,
  type InputTokensRequest,
  type OpenAIEffort,
  type ResponseObject,
  type ResponsesRequest,
} from "./wire/openai.ts";

// The OpenAI adapter (phase-4 design §2.3, Pass 2): the Responses API (`POST /responses`, streamed)
// on the shared guarded transport (`http.ts`: origin-pinned, allowlisted headers, `redirect:
// "error"`, the key in the `authorization` header only), with Zod on every payload it reads
// (`wire/openai.ts`). Facts are the API reference's and the guides', read on 2026-10-20 (the wire
// file lists the pages).
//
// - Requests: `store: false` (stateless; reasoning items come back encrypted and are echoed),
//   `reasoning: { effort, summary: "auto" }` plus `context: "all_turns"` where the catalog pins it
//   (GPT-6.1 Sol), tools with an explicit `strict: false` (else Responses normalises the schema to
//   strict mode), `tool_choice: "auto"`, `parallel_tool_calls: true`, `truncation: "disabled"`,
//   `service_tier: "default"`, no sampling parameter. `input`: a developer message with the shared
//   block, a developer message with the seat block (an explicit cache breakpoint at its end), then
//   the turn: the briefing as a user message, results as `function_call_output` items, operator
//   entries as developer messages (the `developer` channel), and replies echoed as their output
//   items, verbatim (reasoning items with their encrypted content, `phase` kept).
// - Caching: implicit mode with the 30-minute TTL (`prompt_cache_options`). Implicit mode writes at
//   the end of the latest eligible message (a user message, a group of tool results) and looks up
//   up to 20 earlier message endings, so each round reads the previous round's prefix with no
//   marker moving between requests (an explicit-only tail breakpoint would only be looked up while
//   it stays in the request); the explicit breakpoint after the seat block keeps the stable prefix
//   for the next wake. A request's input is the previous request's input plus what was appended.
// - Usage: `input_tokens` counts the whole prompt (the prompt-caching guide prices
//   `input_tokens − cached_tokens − cache_write_tokens` at the uncached rate), so input = that
//   difference, cache reads = `cached_tokens`, the 30-minute writes go in the short write bucket,
//   output = `output_tokens` (reasoning included; `reasoning` = `reasoning_tokens`). Money safety:
//   a usage that is missing, does not parse, contradicts itself (cache tokens above the input,
//   reasoning above the output) or comes from another service tier is not priced from what it
//   says: the attempt fails `unknown` and is charged the seat's attempt bound (a usage entry the
//   ledger cannot price); a stream that broke, failed or was aborted after the request was
//   accepted, before its final usage, is charged the prompt's upper bound at the dearest
//   prompt-side price (the cache write) and the request's full `max_output_tokens`.
// - Stops: `completed` with calls is `tool_use`, else `end_turn`, or `refusal` with a refusal
//   part; `incomplete` with `max_output_tokens` is `max_tokens` (the seat retries once with a larger
//   limit), `content_filter` a refusal, any other reason `other`; `failed` by `error.code`
//   (`misalignment_policy_violation`, `bio_policy` and `invalid_prompt` close the turn as refusals,
//   never retried). HTTP errors are classified by the provider's code before the status
//   (`http.ts`): spend and credit limits pause for the operator, other 429s retry with
//   `Retry-After`, a 403 `misalignment_policy_violation` is a refusal; a refused reasoning summary
//   (organisation verification) is an operator error.
// - Arguments that are not JSON reach the gateway raw, which answers `INVALID_ARGS`.

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
/** The output of the preflight's shape check (the arena's `PREFLIGHT_OUTPUT_TOKENS`). */
export const OPENAI_PREFLIGHT_OUTPUT_TOKENS = 16;
/** The backstop of one attempt when the caller gives no deadline: the comparison timeout. */
export const OPENAI_DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** Header names let through from the adapter's own requests (the key travels as `authorization`). */
const ALLOWED_HEADER = /^(?:accept|content-type)$/;
/** At most this much of an error body is read (it is classified, never echoed). */
const ERROR_BODY_MAX_BYTES = 64 * 1024;
/** What one part of an entry may add to a prompt besides its bytes (the agent's overhead). */
const PART_OVERHEAD_TOKENS = 32;
/** The organisation-verification help page, named by the error a refused summary gets. */
export const OPENAI_VERIFICATION_URL =
  "https://help.openai.com/en/articles/10910291-api-organization-verification";

export interface OpenAIClientOptions {
  /** `PERFIDIA_OPENAI_API_KEY`, read once by the arena plan. */
  readonly apiKey: string;
  /** `PERFIDIA_OPENAI_BASE_URL` or `OPENAI_DEFAULT_BASE_URL` (its path is kept: `…/v1`). */
  readonly baseURL: string;
  /** The harness clock: latency, time to first token, the attempt backstop. */
  readonly time: TimeSource;
  /** Backstop of one attempt in ms (the caller's signal is the real deadline). */
  readonly timeoutMs?: number;
  /** Tests: a stub. Default: the global `fetch` (through the guarded transport). */
  readonly fetch?: HttpFetch;
}

/** One client per process and key: the guarded transport, the base URL and the secrets to redact. */
export class OpenAIClient {
  readonly baseURL: string;
  readonly time: TimeSource;
  readonly timeoutMs: number;
  /** The key as it could appear in an error body (raw and URL-encoded): redacted everywhere. */
  readonly secrets: readonly string[];
  private readonly http: HttpFetch;

  constructor(o: OpenAIClientOptions) {
    if (o.apiKey.trim() === "") {
      throw new Error("the OpenAI API key is empty: set PERFIDIA_OPENAI_API_KEY");
    }
    this.baseURL = o.baseURL.replace(/\/+$/, "");
    this.time = o.time;
    this.timeoutMs = o.timeoutMs ?? OPENAI_DEFAULT_TIMEOUT_MS;
    this.secrets = [...new Set([o.apiKey, encodeURIComponent(o.apiKey)])];
    this.http = guardedFetch({
      baseURL: this.baseURL,
      auth: { header: "authorization", value: `Bearer ${o.apiKey}` },
      allowHeaders: ALLOWED_HEADER,
      ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    });
  }

  /** The URL of an API path (`/responses`), refused if it would carry the key. */
  url(path: string): string {
    const url = `${this.baseURL}${path}`;
    if (this.secrets.some((s) => s.length >= 4 && url.includes(s))) {
      throw new Error("refusing a request whose URL carries the key");
    }
    return url;
  }

  /** One request through the guarded transport. */
  send(path: string, init: RequestInit): Promise<Response> {
    return this.http(this.url(path), init);
  }
}

// Requests -------------------------------------------------------------------------------------

const developer = (text: string, breakpoint = false): InputMessage => ({
  type: "message",
  role: "developer",
  content: [
    breakpoint
      ? { type: "input_text", text, prompt_cache_breakpoint: { mode: "explicit" } }
      : { type: "input_text", text },
  ],
});

const isItemArray = (v: unknown): v is readonly Readonly<Record<string, unknown>>[] =>
  Array.isArray(v) &&
  v.every(
    (x: unknown) =>
      x !== null &&
      typeof x === "object" &&
      !Array.isArray(x) &&
      typeof Reflect.get(x, "type") === "string",
  );

function itemsOf(e: Entry, i: number): InputItem[] {
  if (e.role === "operator") return [developer(e.text)];
  if (e.role === "assistant") {
    const native = e.reply.native;
    if (!isItemArray(native)) throw new Error(`entry ${i}: the reply is not OpenAI output items`);
    return [...native];
  }
  const out: InputItem[] = [];
  const texts: string[] = [];
  for (const p of e.parts) {
    if (p.kind === "result") {
      out.push({ type: "function_call_output", call_id: p.callId, output: p.content });
    } else texts.push(p.text);
  }
  if (out.length + texts.length === 0) throw new Error(`entry ${i}: an empty user entry`);
  // Tool results first, in call order; then text (the round-0 briefing).
  if (texts.length > 0) {
    out.push({
      type: "message",
      role: "user",
      content: texts.map((text) => ({ type: "input_text", text })),
    });
  }
  return out;
}

function checkEntries(entries: readonly Entry[]): void {
  if (entries[0]?.role !== "user") throw new Error("a conversation starts with a user entry");
  if (entries.at(-1)?.role === "assistant") {
    throw new Error("a conversation ends with a user or operator entry (no prefill)");
  }
}

/** `effort` in OpenAI's terms; one the model does not accept is refused (the plan says so first). */
export function openaiEffort(model: string, effort: Effort, accepted: readonly Effort[]) {
  if (!accepted.includes(effort)) {
    throw new Error(`${model} accepts effort ${accepted.join(", ")}; got ${effort}`);
  }
  const e: OpenAIEffort = effort;
  return e;
}

const utf8 = new TextEncoder();
const bytesOf = (text: string): number => utf8.encode(text).length;

/**
 * An upper bound of a request's prompt in tokens when the caller gives none: one token per UTF-8
 * byte of the stable blocks, the tools' JSON and every entry (a reply by its items' JSON), plus 32
 * per block and part (the seat layer's estimate, `seat/agent.ts`, with its byte-counted prefix).
 */
export function promptBytesUpper(req: ChatRequest): number {
  let n =
    bytesOf(req.prompt.shared) +
    bytesOf(req.prompt.seat) +
    bytesOf(JSON.stringify(req.tools)) +
    3 * PART_OVERHEAD_TOKENS;
  for (const e of req.entries) {
    if (e.role === "operator") n += bytesOf(e.text) + PART_OVERHEAD_TOKENS;
    else if (e.role === "assistant") {
      n += bytesOf(JSON.stringify(e.reply.native) ?? "") + PART_OVERHEAD_TOKENS;
    } else {
      for (const p of e.parts) {
        n +=
          (p.kind === "text" ? bytesOf(p.text) : bytesOf(p.content) + bytesOf(p.callId)) +
          PART_OVERHEAD_TOKENS;
      }
    }
  }
  return n;
}

// Usage ----------------------------------------------------------------------------------------

/** How a terminal response's usage reads: priced, absent, or unusable (not priced from below). */
export type UsageRead =
  | { readonly kind: "ok"; readonly entry: UsageEntry }
  | { readonly kind: "absent" }
  | { readonly kind: "invalid"; readonly why: string };

/**
 * The usage of a Response as a usage entry of `model` (design §2.3): input = `input_tokens −
 * cached_tokens − cache_write_tokens`, cache reads = `cached_tokens`, writes = `cache_write_tokens`
 * (the 30-minute writes, in the short bucket), output = `output_tokens` (reasoning included).
 */
export function readUsage(raw: unknown, model: string): UsageRead {
  if (raw === undefined || raw === null) return { kind: "absent" };
  const parsed = UsageSchema.safeParse(raw);
  if (!parsed.success) return { kind: "invalid", why: "the usage does not match the schema" };
  const u = parsed.data;
  const cached = u.input_tokens_details.cached_tokens;
  const written = u.input_tokens_details.cache_write_tokens;
  const reasoning = u.output_tokens_details.reasoning_tokens;
  if (cached + written > u.input_tokens) {
    return { kind: "invalid", why: "cached and written tokens exceed the input tokens" };
  }
  if (reasoning > u.output_tokens) {
    return { kind: "invalid", why: "reasoning tokens exceed the output tokens" };
  }
  return {
    kind: "ok",
    entry: {
      model,
      kind: "message",
      tokens: {
        input: u.input_tokens - cached - written,
        cacheWrite5m: written,
        cacheWrite1h: 0,
        cacheRead: cached,
        output: u.output_tokens,
        reasoning,
      },
      estimated: false,
    },
  };
}

/**
 * A usage the ledger cannot price (a non-finite count, flagged `estimated`): the ledger charges
 * the seat's attempt bound for it, the most one attempt can cost (design §5.2), and logs it as 0.
 */
export function boundUsage(model: string): UsageEntry {
  return {
    model,
    kind: "message",
    tokens: { input: Number.NaN, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
    estimated: true,
  };
}

/**
 * What an attempt accepted but never reported costs, at most (design §2.2): the prompt's upper
 * bound as cache writes (the dearest prompt-side price of the cards) and the request's full
 * `max_output_tokens` (`brokenStreamOutput`), flagged `estimated`.
 */
export function estimatedUsage(model: string, promptTokens: number, maxTokens: number): UsageEntry {
  return {
    model,
    kind: "message",
    tokens: {
      input: 0,
      cacheWrite5m: promptTokens,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: brokenStreamOutput(maxTokens),
    },
    estimated: true,
  };
}

// Replies --------------------------------------------------------------------------------------

const EMPTY_REPLY: ModelReply = Object.freeze({
  native: Object.freeze([]),
  text: Object.freeze([]),
  calls: Object.freeze([]),
  reasoning: Object.freeze([]),
  reasoningKind: "summary",
});

/** A function call's arguments: the parsed JSON, or the raw string when it does not parse. */
function argsOf(text: string): unknown {
  try {
    const v: unknown = JSON.parse(text);
    return v;
  } catch {
    return text;
  }
}

/** The reply of a response's output items (`native`: the items as received, for the echo). */
export function replyOf(output: readonly unknown[]): {
  readonly reply: ModelReply;
  readonly refusal: string | null;
} {
  const text: string[] = [];
  const calls: ModelCall[] = [];
  const reasoning: string[] = [];
  let refusal: string | null = null;
  for (const item of output) {
    const r = ReasoningItemSchema.safeParse(item);
    if (r.success) {
      for (const s of r.data.summary) if (s.text !== "") reasoning.push(s.text);
      continue;
    }
    const m = MessageItemSchema.safeParse(item);
    if (m.success) {
      for (const part of m.data.content) {
        const type: unknown = Reflect.get(part, "type");
        const value: unknown =
          type === "output_text"
            ? Reflect.get(part, "text")
            : type === "refusal"
              ? Reflect.get(part, "refusal")
              : undefined;
        if (typeof value !== "string") continue;
        if (type === "refusal") refusal = refusal === null ? value : `${refusal} ${value}`;
        else text.push(value);
      }
      continue;
    }
    const f = FunctionCallItemSchema.safeParse(item);
    if (f.success) {
      calls.push({ callId: f.data.call_id, name: f.data.name, args: argsOf(f.data.arguments) });
    }
  }
  return {
    reply: { native: output, text, calls, reasoning, reasoningKind: "summary" },
    refusal,
  };
}

// Errors ---------------------------------------------------------------------------------------

/** Error codes of a failed Response or a stream `error` event that close the turn as refusals. */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  "misalignment_policy_violation",
  "bio_policy",
  "invalid_prompt",
]);

/** The kind of a failed Response's (or a stream error event's) code; null: a refusal. */
export function failedKind(code: string | null): ModelErrorKind | null {
  if (code !== null && REFUSAL_CODES.has(code)) return null;
  switch (code) {
    case "rate_limit_exceeded":
    case "slow_down":
      return "rate_limit";
    case "server_error":
    case "vector_store_timeout":
      return "server";
    case "server_is_overloaded":
      return "overloaded";
    case "insufficient_quota":
    case "credit_balance_exhausted":
    case "project_spend_limit_exceeded":
    case "organization_spend_limit_exceeded":
    case "organization_usage_limit_exceeded":
      return "billing";
    case "data_residency_mismatch":
      return "auth";
    case null:
      return "unknown";
    default:
      return code.startsWith("image") || code.includes("_image") ? "bad_request" : "unknown";
  }
}

/**
 * A refused reasoning summary (design §2.3: summaries may need organisation verification). The
 * error's shape is not documented: an error naming the `reasoning.summary` parameter, or a 400/403
 * whose code or message speaks of verification, is taken for it (unverified until a smoke).
 */
function isVerificationError(status: number, body: unknown): boolean {
  const parsed = ErrorBodySchema.safeParse(body);
  if (!parsed.success) return false;
  const e = parsed.data.error;
  if (e.param === "reasoning.summary") return true;
  if (status !== 400 && status !== 403) return false;
  return /verif/i.test(e.code ?? "") || /organi[sz]ation\b[^.]*\bverif/i.test(e.message ?? "");
}

const refusalOf = (category: string, explanation: string | null): Refusal => ({
  category,
  explanation: explanation === null ? null : oneLine(explanation),
  recommendedModel: null,
});

// The adapter ----------------------------------------------------------------------------------

export interface OpenAIAdapterOptions {
  /** Wall ms for latency and time to first token; default the client's clock. */
  readonly nowMs?: () => number;
}

/** How the stream path charges an unpriceable usage: the bound (a match) or the estimate (checks). */
type Mode = "chat" | "check";

/** A field of a JSON object, or undefined. */
const field = (v: unknown, key: string): unknown =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? Reflect.get(v, key) : undefined;

/** The JSON of an SSE event's data, or undefined. */
function dataOf(e: SseEvent): unknown {
  try {
    const v: unknown = JSON.parse(e.data);
    return v;
  } catch {
    return undefined;
  }
}

const typeOf = (e: SseEvent, data: unknown): string => {
  const t = field(data, "type");
  return typeof t === "string" ? t : e.event;
};

export class OpenAIAdapter implements ModelAdapter {
  readonly spec: ModelSpec;
  readonly label: string;
  readonly capabilities: ModelCapabilities;
  private readonly client: OpenAIClient;
  private readonly effort: OpenAIEffort;
  private readonly nowMs: () => number;
  private readonly toolCache = new WeakMap<readonly ModelTool[], readonly FunctionTool[]>();

  constructor(spec: ModelSpec, client: OpenAIClient, o: OpenAIAdapterOptions = {}) {
    if (spec.provider !== "openai") throw new Error(`not an OpenAI spec: ${spec.provider}`);
    this.spec = spec;
    this.label = adapterLabel(spec);
    this.capabilities = capabilitiesFor("openai", spec.model);
    this.effort = openaiEffort(spec.model, spec.effort, this.capabilities.efforts);
    this.client = client;
    this.nowMs = o.nowMs ?? (() => client.time.nowMs());
  }

  /** The tools array, computed once per tool list (frozen for the match: stable bytes). */
  private toolsOf(tools: readonly ModelTool[]): readonly FunctionTool[] {
    let out = this.toolCache.get(tools);
    if (out === undefined) {
      out = Object.freeze(
        tools.map((t): FunctionTool =>
          Object.freeze({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
            strict: false,
          }),
        ),
      );
      this.toolCache.set(tools, out);
    }
    return out;
  }

  private reasoning(): ResponsesRequest["reasoning"] {
    const context = this.spec.reasoningContext;
    return context === undefined
      ? { effort: this.effort, summary: "auto" }
      : { effort: this.effort, summary: "auto", context };
  }

  private input(req: ChatRequest): InputItem[] {
    checkEntries(req.entries);
    return [
      developer(req.prompt.shared),
      developer(req.prompt.seat, true),
      ...req.entries.flatMap((e, i) => itemsOf(e, i)),
    ];
  }

  build(req: ChatRequest): ResponsesRequest {
    return {
      model: this.spec.model,
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      service_tier: "default",
      truncation: "disabled",
      max_output_tokens: req.maxOutputTokens ?? this.spec.maxOutputTokens,
      reasoning: this.reasoning(),
      tools: this.toolsOf(req.tools),
      tool_choice: "auto",
      parallel_tool_calls: true,
      prompt_cache_options: { mode: "implicit", ttl: "30m" },
      input: this.input(req),
    };
  }

  chat(req: ChatRequest): Promise<ChatResult> {
    return this.stream(req, this.build(req), "chat");
  }

  /** The attempt's signal: the caller's and the client's backstop. */
  private deadline(signal: AbortSignal | undefined) {
    const timer = timeoutSignal(
      this.client.time,
      this.client.timeoutMs,
      `request timed out after ${this.client.timeoutMs} ms`,
    );
    return {
      signal: signal === undefined ? timer.signal : AbortSignal.any([signal, timer.signal]),
      timedOut: () => timer.signal.aborted && signal?.aborted !== true,
      cancel: () => timer.cancel(),
    };
  }

  /** A failure with the attempt's deadline taken into account (an abort or the backstop). */
  private failure(
    e: unknown,
    d: { readonly timedOut: () => boolean; readonly signal: AbortSignal },
    spent: readonly UsageEntry[],
  ): ModelError {
    if (d.timedOut()) {
      return new ModelError("timeout", `request timed out after ${this.client.timeoutMs} ms`, {
        spent,
      });
    }
    if (d.signal.aborted) return new ModelError("aborted", "request aborted", { spent });
    const err = transportError(e, undefined, this.client.secrets);
    return this.redacted(
      err.spent.length > 0 || spent.length === 0
        ? err
        : new ModelError(err.kind, err.message, {
            status: err.status,
            requestId: err.requestId,
            retryAfterMs: err.retryAfterMs,
            spent,
          }),
    );
  }

  private async stream(req: ChatRequest, body: ResponsesRequest, mode: Mode): Promise<ChatResult> {
    const maxTokens = body.max_output_tokens;
    const model = this.spec.model;
    const prompt = req.promptTokensUpper ?? promptBytesUpper(req);
    const estimate = (): UsageEntry[] => [estimatedUsage(model, prompt, maxTokens)];
    // A usage that cannot be priced: the attempt bound in a match, the estimate for a check (the
    // preflight prices its usage itself and needs a number).
    const unpriceable = (): UsageEntry[] => (mode === "chat" ? [boundUsage(model)] : estimate());
    const t0 = this.nowMs();
    const d = this.deadline(req.signal);
    let res: Response;
    try {
      res = await this.client.send("/responses", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: d.signal,
      });
    } catch (e) {
      d.cancel();
      // No response: the request never reached inference that we know of (phase 2's rule).
      throw this.failure(e, d, []);
    }
    const requestId = res.headers.get("x-request-id");
    try {
      if (!res.ok) return await this.httpFailure(res, requestId, t0, mode);
      if (res.body === null) {
        throw new ModelError("connection", "openai: an empty response body", {
          spent: estimate(),
          requestId,
        });
      }
      let ttftMs: number | null = null;
      let final: unknown = undefined;
      const parsed = new WeakMap<SseEvent, unknown>();
      const typeOfEvent = (e: SseEvent): string => {
        if (!parsed.has(e)) parsed.set(e, dataOf(e));
        return typeOf(e, parsed.get(e));
      };
      for await (const ev of readSse(res.body, {
        terminal: (e) => TERMINAL_EVENTS.has(typeOfEvent(e)),
        spent: estimate,
      })) {
        const type = typeOfEvent(ev);
        if (ttftMs === null && type.endsWith(".delta")) ttftMs = this.nowMs() - t0;
        if (TERMINAL_EVENTS.has(type)) final = parsed.get(ev);
      }
      return this.resultOf(final, {
        requestId,
        latencyMs: this.nowMs() - t0,
        ttftMs,
        estimate,
        unpriceable,
      });
    } catch (e) {
      if (e instanceof ModelError && !d.signal.aborted) throw this.redacted(e);
      // Once the request was accepted (2xx), an attempt that ends without its usage is charged.
      const spent = e instanceof ModelError ? e.spent : res.ok ? estimate() : [];
      throw this.failure(e, d, spent);
    } finally {
      d.cancel();
    }
  }

  /** A `ModelError` with the key redacted from its message. */
  private redacted(e: ModelError): ModelError {
    const message = redact(e.message, this.client.secrets);
    if (message === e.message) return e;
    return new ModelError(e.kind, message, {
      status: e.status,
      requestId: e.requestId,
      retryAfterMs: e.retryAfterMs,
      spent: e.spent,
      retryable: e.retryable,
    });
  }

  /** A non-2xx answer: classified by its code before its status; a refusal closes the turn. */
  private async httpFailure(
    res: Response,
    requestId: string | null,
    t0: number,
    mode: Mode,
  ): Promise<ChatResult> {
    const status = res.status;
    const body = await readErrorBody(res);
    if (isVerificationError(status, body)) {
      throw new ModelError(
        "auth",
        `openai HTTP ${status}: reasoning summaries (reasoning.summary) need organization verification: verify the organization (platform settings, Organization, General; ${OPENAI_VERIFICATION_URL}), then run again`,
        { status, requestId },
      );
    }
    const c = classifyHttpError("openai", status, res.headers, body);
    if (c.kind === "refusal" && mode === "chat") {
      // A 403 misalignment block: the turn closes as a refusal, never retried (no inference ran
      // that we know of: nothing is charged, as for every HTTP error).
      return {
        reply: EMPTY_REPLY,
        stop: "refusal",
        rawStop: c.code ?? `http_${status}`,
        refusal: refusalOf(c.refusal ?? "refusal", null),
        servedBy: this.spec.model,
        fallback: false,
        usage: [],
        requestId,
        latencyMs: this.nowMs() - t0,
        ttftMs: null,
        raw: { status, error: { code: c.code } },
      };
    }
    throw httpModelError("openai", status, c, { requestId, secrets: this.client.secrets });
  }

  /** The result of a terminal event (design §2.3's stop table). */
  private resultOf(
    final: unknown,
    o: {
      readonly requestId: string | null;
      readonly latencyMs: number;
      readonly ttftMs: number | null;
      readonly estimate: () => UsageEntry[];
      readonly unpriceable: () => UsageEntry[];
    },
  ): ChatResult {
    const common = {
      fallback: false,
      requestId: o.requestId,
      latencyMs: o.latencyMs,
      ttftMs: o.ttftMs,
    };
    const streamError = StreamErrorEventSchema.safeParse(final);
    if (streamError.success) {
      // An error while consuming the stream, after the request was accepted: charged the estimate.
      const code = streamError.data.code ?? null;
      const kind = failedKind(code);
      if (kind === null) {
        return {
          ...common,
          reply: EMPTY_REPLY,
          stop: "refusal",
          rawStop: code ?? "error",
          refusal: refusalOf(refusalCategory(code), null),
          servedBy: this.spec.model,
          usage: o.estimate(),
          raw: final,
        };
      }
      throw new ModelError(kind, oneLine(`openai stream error ${code ?? "(no code)"}`), {
        requestId: o.requestId,
        spent: o.estimate(),
      });
    }
    const event = TerminalResponseEventSchema.safeParse(final);
    if (!event.success) {
      // A response we cannot read: never echoed, counts toward the breaker, charged the bound.
      throw new ModelError("unknown", "openai: a terminal event that does not match the schema", {
        requestId: o.requestId,
        spent: o.unpriceable(),
      });
    }
    const r: ResponseObject = event.data.response;
    // The items as received (key order and every field), not as parsed: they are echoed verbatim.
    const rawResponse = field(final, "response");
    const rawOutput = field(rawResponse, "output");
    const output: readonly unknown[] = Array.isArray(rawOutput) ? rawOutput : [];
    const tier = r.service_tier ?? "default";
    const read: UsageRead =
      tier === "default"
        ? readUsage(r.usage, r.model)
        : { kind: "invalid", why: `served on the ${tier} tier, not default` };
    const usage =
      read.kind === "ok"
        ? [read.entry]
        : read.kind === "absent" && r.status === "failed"
          ? o.estimate()
          : o.unpriceable();
    const base = { ...common, servedBy: r.model, usage, raw: rawResponse };
    if (r.status === "failed") {
      const code = r.error?.code ?? null;
      const kind = failedKind(code);
      if (kind === null) {
        return {
          ...base,
          reply: EMPTY_REPLY,
          stop: "refusal",
          rawStop: `failed:${code ?? ""}`,
          refusal: refusalOf(refusalCategory(code), null),
        };
      }
      throw new ModelError(kind, oneLine(`openai response failed: ${code ?? "(no code)"}`), {
        requestId: o.requestId,
        spent: usage,
      });
    }
    if (read.kind !== "ok") {
      throw new ModelError(
        "unknown",
        `openai: the usage of a ${r.status} response cannot be priced (${read.kind === "absent" ? "no usage" : read.why}): charged the attempt bound`,
        { requestId: o.requestId, spent: usage },
      );
    }
    if (r.status === "incomplete") {
      const reason = r.incomplete_details?.reason ?? null;
      const rawStop = `incomplete:${reason ?? ""}`;
      if (reason === "content_filter") {
        return {
          ...base,
          reply: EMPTY_REPLY,
          stop: "refusal",
          rawStop,
          refusal: refusalOf("content_filter", null),
        };
      }
      const stop: StopReason = reason === "max_output_tokens" ? "max_tokens" : "other";
      return { ...base, reply: EMPTY_REPLY, stop, rawStop, refusal: null };
    }
    if (r.status !== "completed") {
      throw new ModelError("unknown", `openai: a terminal response with status ${r.status}`, {
        requestId: o.requestId,
        spent: usage,
      });
    }
    const { reply, refusal } = replyOf(output);
    if (refusal !== null) {
      return {
        ...base,
        reply: EMPTY_REPLY,
        stop: "refusal",
        rawStop: "completed:refusal",
        refusal: refusalOf("refusal", refusal),
      };
    }
    const stop: StopReason = reply.calls.length > 0 ? "tool_use" : "end_turn";
    return { ...base, reply, stop, rawStop: "completed", refusal: null };
  }

  /**
   * The input tokens of `req` (`POST /responses/input_tokens`, free, no inference): the same
   * input, tools and reasoning as the request. `arena smoke` checks the prefix size with it.
   */
  async countTokens(req: ChatRequest): Promise<number> {
    const b = this.build(req);
    const body: InputTokensRequest = {
      model: b.model,
      input: b.input,
      tools: b.tools,
      tool_choice: b.tool_choice,
      parallel_tool_calls: b.parallel_tool_calls,
      reasoning: b.reasoning,
      truncation: b.truncation,
    };
    const json = await this.getJson("/responses/input_tokens", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = InputTokensSchema.safeParse(json);
    if (!parsed.success) {
      throw new ModelError("unknown", "openai: an input_tokens answer that does not match");
    }
    return parsed.data.input_tokens;
  }

  /** One JSON request (no inference): its parsed body, or the classified `ModelError`. */
  private async getJson(path: string, init: RequestInit): Promise<unknown> {
    const d = this.deadline(undefined);
    try {
      let res: Response;
      try {
        res = await this.client.send(path, { ...init, signal: d.signal });
      } catch (e) {
        throw this.failure(e, d, []);
      }
      const requestId = res.headers.get("x-request-id");
      if (!res.ok) {
        const body = await readErrorBody(res);
        const c = classifyHttpError("openai", res.status, res.headers, body, "plan");
        throw httpModelError("openai", res.status, c, { requestId, secrets: this.client.secrets });
      }
      try {
        const v: unknown = await res.json();
        return v;
      } catch (e) {
        throw this.failure(e, d, []);
      }
    } finally {
      d.cancel();
    }
  }

  /**
   * The model's access (`GET /models/{model}`), then the exact production shape with
   * `max_output_tokens: 16`, streamed and charged: it validates the tools, the reasoning
   * parameters (summaries included: organisation verification), the developer messages and the
   * cache options, and writes the stable prefix. A refused check is a failure.
   */
  async preflight(sample: ChatRequest): Promise<PreflightReport> {
    const model = this.spec.model;
    const info = ModelObjectSchema.safeParse(
      await this.getJson(`/models/${encodeURIComponent(model)}`, {
        method: "GET",
        headers: { accept: "application/json" },
      }),
    );
    if (!info.success) {
      throw new ModelError("unknown", `openai: /models/${model} answered something else`);
    }
    const req: ChatRequest = { ...sample, maxOutputTokens: OPENAI_PREFLIGHT_OUTPUT_TOKENS };
    const res = await this.stream(req, this.build(req), "check");
    if (res.stop === "refusal") {
      throw new ModelError(
        "bad_request",
        `openai: the shape check was refused (${res.refusal?.category ?? "uncategorised"})`,
        { spent: res.usage },
      );
    }
    return { model, allowedFallbackModels: [], usage: res.usage };
  }
}

/** The category a refusal code closes the turn with (`misalignment` for the monitoring block). */
function refusalCategory(code: string | null): string {
  if (code === "misalignment_policy_violation") return "misalignment";
  return code ?? "refusal";
}

/** An error body as JSON (at most `ERROR_BODY_MAX_BYTES`), or null; never echoed. */
async function readErrorBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (text.length > ERROR_BODY_MAX_BYTES) return null;
    const v: unknown = JSON.parse(text);
    return v;
  } catch {
    return null;
  }
}
