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
  type ModelReply,
  type ModelSpec,
  type ModelTool,
  type PreflightReport,
  type StopReason,
  type UsageEntry,
} from "./adapter.ts";
import { capabilitiesFor } from "./catalog.ts";
import { timeoutSignal } from "./clock.ts";
import { HARNESS_PREFIX } from "./fake.ts";
import { geminiTools } from "./gemini-tools.ts";
import {
  checkedOrigin,
  classifyHttpError,
  guardedFetch,
  httpModelError,
  oneLine,
  readSse,
  redact,
  type Classified,
  type HttpFetch,
} from "./http.ts";
import {
  GeminiCountTokensSchema,
  GeminiErrorBodySchema,
  GeminiErrorInfoSchema,
  GeminiModelInfoSchema,
  GeminiPartSchema,
  GeminiResponseSchema,
  GeminiRetryInfoSchema,
  GeminiUsageSchema,
  type GeminiPart,
  type GeminiRequest,
  type GeminiThinkingLevel,
  type GeminiUserPart,
} from "./wire/gemini.ts";

// The Gemini adapter (phase-4 design §2.4, Pass 2): `generateContent` on `v1beta`, raw `fetch`
// through the shared guarded transport (`http.ts`), Zod on every payload read (`wire/gemini.ts`).
// API facts read on 2026-10-20 from https://ai.google.dev/api/generate-content.md.txt and the
// guides under https://ai.google.dev/gemini-api/docs/generate-content/ (thinking, function calling,
// thought signatures, API errors, caching) and https://ai.google.dev/gemini-api/docs/billing.md.txt.
//
// - Transport: `POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse`, one fetch per
//   attempt, the key in `x-goog-api-key` (never in a URL), the configured origin only, no redirect
//   followed, the key redacted from every message. The harness owns every retry.
// - Request: `systemInstruction` holds the shared then the seat block; `tools` the neutral list in
//   Gemini's schema subset (`gemini@1`, `gemini-tools.ts`; the arena passes it already transformed,
//   and re-applying it is a no-op) as `parametersJsonSchema`; `toolConfig` AUTO;
//   `generationConfig` the output limit (thinking included: a hard cut-off) and
//   `thinkingConfig: {thinkingLevel, includeThoughts: true}` (the seat's effort in Gemini's terms;
//   an effort the model does not take is refused at construction); `store: false` (no request
//   logging, whatever the project's setting). No sampling parameter, no `cachedContent` (Gemini 4
//   Argon caches implicitly only).
// - Entries: tool results become `functionResponse` parts (with the call's `id` when it had one,
//   and its `name`), in call order, followed by any text; operator entries become a text part
//   `[harness] …` appended to the user turn (the `envelope` channel: Gemini has no mid-conversation
//   system message); the model's reply is echoed back as the parts it arrived as, verbatim, never
//   merged, thought summaries and thought signatures included (mandatory on function calls).
// - Response: the stream's parts accumulate in order; the finish reason maps to a stop
//   (`stopOf`); usage maps to one entry (`geminiUsage`): input = prompt − cached + tool-use prompt,
//   cache read = cached, output = candidates + thoughts (thoughts are billed as output), plus any
//   count `totalTokenCount` has beyond those. A usage whose shape is unknown, a stream that broke,
//   an aborted or timed-out request that may have run, and a 504 are charged conservatively,
//   flagged `estimated`: the whole prompt as input (the provider's own count when one arrived, else
//   one token per byte of the request) and the request's full output limit. A request that never
//   left the machine (refused connection, unknown host) and an HTTP error (the billing page: "If
//   your request fails with a 400 or 500 error, you won't be charged") cost nothing.

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
export const GEMINI_API_VERSION = "v1beta";
/** The shape check's output limit (the arena's `PREFLIGHT_OUTPUT_TOKENS`, which the probe bound uses). */
export const GEMINI_PREFLIGHT_OUTPUT_TOKENS = 16;
/** The backstop of one request; the attempt's own signal (15 minutes for Argon) is the deadline. */
export const GEMINI_DEFAULT_TIMEOUT_MS = 20 * 60_000;

/** Header names a request may carry besides the key (the guarded fetch drops anything else). */
const ALLOWED_HEADER = /^(?:accept|content-type)$/;

/** Transport failures before the request reached a server: nothing ran, nothing is billed. */
const NOT_SENT = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);

export interface GeminiClientOptions {
  /** `PERFIDIA_GOOGLE_API_KEY`, read once by the arena plan. */
  readonly apiKey: string;
  /** `PERFIDIA_GOOGLE_BASE_URL` or `GEMINI_DEFAULT_BASE_URL`: the API root, without the version. */
  readonly baseURL: string;
  /** The run's time source: the backstop timer and latencies. */
  readonly time: TimeSource;
  /** Tests: a stub. Default: the global `fetch` (through the guard). */
  readonly fetch?: HttpFetch;
  readonly timeoutMs?: number;
}

/** One key and base URL: the guarded transport every Gemini adapter of a run shares. */
export class GeminiClient {
  readonly baseURL: string;
  readonly origin: string;
  readonly time: TimeSource;
  readonly timeoutMs: number;
  /** The key as an error body could echo it (raw and URL-encoded): redacted from every message. */
  readonly secrets: readonly string[];
  readonly fetch: HttpFetch;

  constructor(o: GeminiClientOptions) {
    if (o.apiKey.trim() === "") {
      throw new Error("the Gemini API key is empty: set PERFIDIA_GOOGLE_API_KEY");
    }
    this.origin = checkedOrigin(o.baseURL);
    this.baseURL = o.baseURL.replace(/\/+$/, "");
    this.time = o.time;
    this.timeoutMs = o.timeoutMs ?? GEMINI_DEFAULT_TIMEOUT_MS;
    this.secrets = [...new Set([o.apiKey, encodeURIComponent(o.apiKey)])];
    this.fetch = guardedFetch({
      baseURL: o.baseURL,
      auth: { header: "x-goog-api-key", value: o.apiKey },
      allowHeaders: ALLOWED_HEADER,
      ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    });
  }

  /** The URL of `models/{model}{suffix}` (`:streamGenerateContent?alt=sse`, …). */
  modelUrl(model: string, suffix = ""): string {
    return `${this.baseURL}/${GEMINI_API_VERSION}/models/${encodeURIComponent(model)}${suffix}`;
  }
}

// Requests -------------------------------------------------------------------------------------

const THINKING_LEVELS: Readonly<Partial<Record<Effort, GeminiThinkingLevel>>> = Object.freeze({
  minimal: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
});

/**
 * The seat's effort as Gemini's `thinkingLevel`; an effort Gemini has no level for, or one the
 * model does not take (Gemini 4 Argon and 3.8 Flash refuse `minimal`), is refused.
 */
export function thinkingLevelOf(
  model: string,
  effort: Effort,
  caps: Pick<ModelCapabilities, "efforts">,
): GeminiThinkingLevel {
  const level = THINKING_LEVELS[effort];
  if (level === undefined || !caps.efforts.includes(effort)) {
    throw new Error(
      `${model} takes the efforts ${caps.efforts.join(", ")} (Gemini's thinkingLevel), not ${effort}`,
    );
  }
  return level;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A model reply's parts: an array of Gemini parts (checked, kept as they are). */
function isPartArray(v: unknown): v is GeminiPart[] {
  return Array.isArray(v) && v.every((p: unknown) => GeminiPartSchema.safeParse(p).success);
}

/**
 * A tool result as `functionResponse.response` (a JSON object): the gateway's result object as is;
 * any other content under `result`.
 */
export function responseOf(content: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { result: content };
  }
  return isRecord(value) ? value : { result: value };
}

/** A call's `name` and its `id` as the model gave it (null: none, so none is sent back). */
interface CallRef {
  readonly name: string;
  readonly id: string | null;
}

/** The calls of a reply by `callId`: the i-th call is the reply's i-th `functionCall` part. */
function callsOf(
  reply: ModelReply,
  native: readonly GeminiPart[],
  at: number,
): Map<string, CallRef> {
  const parts = native.flatMap((p) => (p.functionCall === undefined ? [] : [p.functionCall]));
  const out = new Map<string, CallRef>();
  for (const [k, c] of reply.calls.entries()) {
    const fc = parts[k];
    if (fc === undefined) throw new Error(`entry ${at}: call ${c.callId} has no functionCall part`);
    out.set(c.callId, { name: fc.name, id: fc.id ?? null });
  }
  return out;
}

/** The conversation as Gemini contents (append-only: a request's contents prefix the next one's). */
export function contentsOf(entries: readonly Entry[]): GeminiRequest["contents"] {
  if (entries[0]?.role !== "user") throw new Error("a conversation starts with a user entry");
  if (entries.at(-1)?.role === "assistant") {
    throw new Error("a conversation ends with a user or operator entry (no prefill)");
  }
  const contents: GeminiRequest["contents"] = [];
  /** The parts of the last content when it is a user turn (harness text joins it). */
  let user: GeminiUserPart[] | null = null;
  let calls = new Map<string, CallRef>();
  for (const [i, e] of entries.entries()) {
    if (e.role === "assistant") {
      const native = e.reply.native;
      if (!isPartArray(native)) throw new Error(`entry ${i}: the reply is not Gemini content`);
      calls = callsOf(e.reply, native, i);
      // An empty reply has nothing to echo (a content needs at least one part).
      if (native.length > 0) contents.push({ role: "model", parts: native });
      user = null;
      continue;
    }
    if (e.role === "operator") {
      const part = { text: `${HARNESS_PREFIX}${e.text}` };
      if (user === null) {
        user = [part];
        contents.push({ role: "user", parts: user });
      } else {
        user.push(part);
      }
      continue;
    }
    const results: GeminiUserPart[] = [];
    const texts: GeminiUserPart[] = [];
    for (const p of e.parts) {
      if (p.kind === "result") {
        const c = calls.get(p.callId);
        if (c === undefined)
          throw new Error(`entry ${i}: no call ${p.callId} in the reply before it`);
        results.push({
          functionResponse: {
            ...(c.id === null ? {} : { id: c.id }),
            name: c.name,
            response: responseOf(p.content),
          },
        });
      } else {
        texts.push({ text: p.text });
      }
    }
    if (results.length + texts.length === 0) throw new Error(`entry ${i}: an empty user entry`);
    // Function responses first, in call order; then text (the round-0 briefing).
    user = [...results, ...texts];
    contents.push({ role: "user", parts: user });
  }
  return contents;
}

// Responses ------------------------------------------------------------------------------------

/** The call id of a `functionCall` the model gave no `id` (never sent back). */
export const syntheticCallId = (turn: number, round: number, i: number): string =>
  `gemini-${turn}-${round}-${i}`;

/**
 * A reply from its parts: consecutive text deltas joined into one block, thought summaries (parts
 * with `thought: true`) into the reasoning spectators see, `functionCall` parts into calls.
 */
export function replyOf(
  native: readonly GeminiPart[],
  meta: { readonly turn: number; readonly round: number },
): ModelReply {
  const text: string[] = [];
  const reasoning: string[] = [];
  const calls: ModelCall[] = [];
  let run: "text" | "thought" | null = null;
  for (const p of native) {
    const fc = p.functionCall;
    if (fc !== undefined) {
      calls.push({
        callId: fc.id ?? syntheticCallId(meta.turn, meta.round, calls.length),
        name: fc.name,
        args: fc.args ?? {},
      });
      run = null;
      continue;
    }
    if (typeof p.text !== "string") {
      run = null;
      continue;
    }
    // An empty text part may carry the thought signature: echoed, never shown.
    if (p.text === "") continue;
    const kind = p.thought === true ? "thought" : "text";
    const list = kind === "thought" ? reasoning : text;
    if (run === kind && list.length > 0) list[list.length - 1] = `${list.at(-1) ?? ""}${p.text}`;
    else list.push(p.text);
    run = kind;
  }
  return { native, text, calls, reasoning, reasoningKind: "summary" };
}

/** Finish reasons that close the turn as a refusal (the category is the reason in lower case). */
const REFUSALS: ReadonlySet<string> = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
  "LANGUAGE",
  "ESCALATION",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);

/**
 * A finish reason as a stop (design §2.4): `STOP` ends the turn or asks for its tools; `MAX_TOKENS`
 * and `CONTINUATION` (continuation tokens unused) are a truncation, retried once; the safety
 * reasons a refusal; `MALFORMED_FUNCTION_CALL`, `TOO_MANY_TOOL_CALLS`, `UNEXPECTED_TOOL_CALL`,
 * `MALFORMED_RESPONSE`, `OTHER` and anything unknown `other` (the turn closes). The two that are
 * not about the reply (`MISSING_THOUGHT_SIGNATURE`, `PUP_LIMITED_DISABLED`) are errors, raised by
 * the adapter.
 */
export function stopOf(finish: string, calls: number): StopReason {
  if (finish === "STOP") return calls > 0 ? "tool_use" : "end_turn";
  if (finish === "MAX_TOKENS" || finish === "CONTINUATION") return "max_tokens";
  if (REFUSALS.has(finish)) return "refusal";
  return "other";
}

/** Service tiers billed at (or under) the standard cards. */
const STANDARD_TIERS: ReadonlySet<string> = new Set([
  "standard",
  "unspecified",
  "service_tier_unspecified",
  "flex",
]);

/**
 * The model id an attempt is billed under: the requested model, unless the response names another
 * version (`modelVersion`), or a service tier dearer than standard served it (priority): those are
 * ids no card prices, so the attempt is charged at the highest price of any card, and the preflight
 * refuses to start a run served that way.
 */
export function billedModel(requested: string, served: string | null, tier?: string): string {
  const model = served === null || served === "" || served === requested ? requested : served;
  const t = tier?.toLowerCase() ?? "";
  return t === "" || STANDARD_TIERS.has(t) ? model : `${model} (${tier ?? ""} tier)`;
}

/** `models/gemini-4-argon` → `gemini-4-argon`. */
const modelIdOf = (v: string | null): string | null =>
  v === null ? null : v.startsWith("models/") ? v.slice("models/".length) : v;

/** The conservative charge of an attempt whose usage is not known (design §2.2). */
export function estimatedUsage(model: string, promptTokens: number, maxTokens: number): UsageEntry {
  return {
    model,
    kind: "message",
    tokens: {
      input: promptTokens,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: brokenStreamOutput(maxTokens),
    },
    estimated: true,
  };
}

/**
 * `usageMetadata` as a usage entry billed under `model`, or `fallback()` when its shape is not one
 * the adapter knows (no prompt count, a count that is not a non-negative safe integer). Never under
 * what the API bills: cached tokens beyond the prompt count are charged as both, and a total beyond
 * the known counts is charged as output.
 */
export function geminiUsage(
  raw: unknown,
  model: string,
  fallback: () => UsageEntry,
  served: string | null = null,
): UsageEntry {
  const r = GeminiUsageSchema.safeParse(raw);
  if (!r.success) return fallback();
  const u = r.data;
  const prompt = u.promptTokenCount ?? 0;
  if (prompt <= 0) return fallback();
  const cached = u.cachedContentTokenCount ?? 0;
  const tool = u.toolUsePromptTokenCount ?? 0;
  const thoughts = u.thoughtsTokenCount ?? 0;
  const candidates = u.candidatesTokenCount ?? 0;
  const known = prompt + tool + thoughts + candidates;
  const extra =
    u.totalTokenCount !== undefined && u.totalTokenCount > known ? u.totalTokenCount - known : 0;
  return {
    model: billedModel(model, served, u.serviceTier),
    kind: "message",
    tokens: {
      input: (cached <= prompt ? prompt - cached : prompt) + tool,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: cached,
      output: candidates + thoughts + extra,
      reasoning: thoughts,
    },
    estimated: false,
  };
}

// Errors ---------------------------------------------------------------------------------------

/** A protobuf Duration in JSON (`"41s"`, `"0.5s"`) in ms, rounded up; null when not one. */
export function durationMs(text: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d{1,9}))?s$/.exec(text);
  if (m === null) return null;
  return Number(m[1]) * 1000 + Math.ceil(Number(`0.${m[2] ?? "0"}`) * 1000);
}

/**
 * An error response classified by its own fields before its status (design §2.2): 402 is the
 * Prepay balance at $0 (`billing`); an `ErrorInfo` reason `API_KEY_*` is the key (`auth`, though
 * the status is 400); `FAILED_PRECONDITION` is billing not enabled (`billing`); 429
 * `RESOURCE_EXHAUSTED` is a rate limit unless its details name a billing, monthly or tier cap (the
 * shared table in `http.ts`); the delay of a `RetryInfo` detail applies when no `Retry-After`
 * header does.
 */
export function classifyGeminiError(
  status: number,
  headers: Headers | null,
  body: unknown,
): Classified {
  const base = classifyHttpError("google", status, headers, body);
  const parsed = GeminiErrorBodySchema.safeParse(body);
  const err = parsed.success ? parsed.data.error : null;
  const details = err?.details ?? [];
  const reasons: string[] = [];
  let delay: number | null = null;
  for (const d of details) {
    const info = GeminiErrorInfoSchema.safeParse(d);
    if (info.success && info.data.reason !== undefined) reasons.push(info.data.reason);
    const retry = GeminiRetryInfoSchema.safeParse(d);
    if (retry.success) delay ??= durationMs(retry.data.retryDelay);
  }
  let kind = base.kind;
  if (status !== 402 && reasons.some((r) => r.startsWith("API_KEY_"))) kind = "auth";
  else if (status !== 402 && err?.status === "FAILED_PRECONDITION") kind = "billing";
  const code =
    err?.status === undefined
      ? base.code
      : reasons.length === 0
        ? err.status
        : `${err.status}/${reasons.join(",")}`;
  return { kind, refusal: base.refusal, retryAfterMs: base.retryAfterMs ?? delay, code };
}

/** What a failed exchange cost: nothing before the request left; else `spent()`. */
function transportFailure(
  e: unknown,
  signal: AbortSignal,
  timer: AbortSignal,
  caller: AbortSignal | undefined,
  spent: () => readonly UsageEntry[],
  secrets: readonly string[],
): ModelError {
  if (e instanceof ModelError && !signal.aborted) return e;
  if (signal.aborted) {
    const spentNow = e instanceof ModelError && e.spent.length > 0 ? e.spent : spent();
    if (timer.aborted && caller?.aborted !== true) {
      return new ModelError("timeout", "google: the request timed out", { spent: spentNow });
    }
    return new ModelError("aborted", "request aborted", { spent: spentNow });
  }
  const code: unknown = e !== null && typeof e === "object" ? Reflect.get(e, "code") : undefined;
  const what = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const unsent =
    (typeof code === "string" && NOT_SENT.has(code)) ||
    (e instanceof Error && e.message.startsWith("refusing a request"));
  return new ModelError(
    "connection",
    oneLine(redact(`google: connection failed: ${what}`, secrets)),
    {
      spent: unsent ? [] : spent(),
    },
  );
}

// The adapter ----------------------------------------------------------------------------------

/** What a stream showed before it ended (or broke). */
interface Seen {
  /** The raw parts, as parsed from the events (echoed verbatim). */
  readonly parts: unknown[];
  finish: string | null;
  finishMessage: string | null;
  block: string | null;
  /** The latest `usageMetadata` (cumulative). */
  usage: unknown;
  /** A usage arrived with or after the finish: the final count (earlier ones are partial). */
  final: boolean;
  /** The prompt count of a usage that arrived (the broken-stream estimate's prompt). */
  prompt: number | null;
  modelVersion: string | null;
  responseId: string | null;
  firstPartMs: number | null;
}

const newSeen = (): Seen => ({
  parts: [],
  finish: null,
  finishMessage: null,
  block: null,
  usage: undefined,
  final: false,
  prompt: null,
  modelVersion: null,
  responseId: null,
  firstPartMs: null,
});

const utf8 = new TextEncoder();

/** A response body as JSON; a body that is not JSON is an `unknown` error (never echoed). */
async function jsonOf(res: Response, what: string, spent: readonly UsageEntry[]): Promise<unknown> {
  const text = await res.text();
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new ModelError("unknown", `google: ${what} is not JSON`, { spent });
  }
}

/** The raw parts of the first candidate of a raw response. */
function rawPartsOf(json: unknown): unknown[] {
  const candidates: unknown = isRecord(json) ? json["candidates"] : undefined;
  const first: unknown = Array.isArray(candidates) ? candidates[0] : undefined;
  const content: unknown = isRecord(first) ? first["content"] : undefined;
  const parts: unknown = isRecord(content) ? content["parts"] : undefined;
  if (!Array.isArray(parts)) return [];
  const list: readonly unknown[] = parts;
  return [...list];
}

export class GeminiAdapter implements ModelAdapter {
  readonly spec: ModelSpec;
  readonly label: string;
  readonly capabilities: ModelCapabilities;
  private readonly client: GeminiClient;
  private readonly level: GeminiThinkingLevel;
  private readonly toolCache = new WeakMap<
    readonly ModelTool[],
    GeminiRequest["tools"][number]["functionDeclarations"]
  >();

  constructor(spec: ModelSpec, client: GeminiClient) {
    if (spec.provider !== "google") throw new Error(`not a Google spec: ${spec.provider}`);
    this.spec = spec;
    this.label = adapterLabel(spec);
    this.capabilities = capabilitiesFor("google", spec.model);
    this.level = thinkingLevelOf(spec.model, spec.effort, this.capabilities);
    this.client = client;
    this.maxTokensOf(spec.maxOutputTokens);
  }

  private maxTokensOf(n: number): number {
    const max = this.capabilities.maxOutputTokens;
    if (!Number.isSafeInteger(n) || n < 1 || n > max) {
      throw new Error(
        `${this.spec.model} takes at most ${max} output tokens per request, got ${n}`,
      );
    }
    return n;
  }

  /** The function declarations of a tool list in Gemini's schema subset, once per list. */
  private declarationsOf(tools: readonly ModelTool[]) {
    let out = this.toolCache.get(tools);
    if (out === undefined) {
      out = geminiTools(tools).map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.inputSchema,
      }));
      this.toolCache.set(tools, out);
    }
    return out;
  }

  build(req: ChatRequest): GeminiRequest {
    return {
      systemInstruction: { parts: [{ text: req.prompt.shared }, { text: req.prompt.seat }] },
      contents: contentsOf(req.entries),
      tools: [{ functionDeclarations: this.declarationsOf(req.tools) }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: {
        maxOutputTokens: this.maxTokensOf(req.maxOutputTokens ?? this.spec.maxOutputTokens),
        thinkingConfig: { thinkingLevel: this.level, includeThoughts: true },
      },
      store: false,
    };
  }

  /**
   * One exchange: the request with the backstop timer and the caller's signal, `use` reading its
   * response; failures as `ModelError`s with what they cost (`spent`).
   */
  private async exchange<T>(
    url: string,
    init: { readonly method: "GET" | "POST"; readonly body?: string; readonly accept: string },
    caller: AbortSignal | undefined,
    spent: () => readonly UsageEntry[],
    use: (res: Response) => Promise<T>,
  ): Promise<T> {
    const c = this.client;
    const timer = timeoutSignal(c.time, c.timeoutMs, `request timed out after ${c.timeoutMs} ms`);
    const signal = caller === undefined ? timer.signal : AbortSignal.any([caller, timer.signal]);
    try {
      let res: Response;
      try {
        res = await c.fetch(url, {
          method: init.method,
          headers: {
            accept: init.accept,
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(init.body === undefined ? {} : { body: init.body }),
          signal,
        });
      } catch (e) {
        throw transportFailure(e, signal, timer.signal, caller, spent, c.secrets);
      }
      try {
        return await use(res);
      } catch (e) {
        if (e instanceof ModelError && !signal.aborted) throw e;
        // The response was there: whatever broke, the request ran.
        const failure = transportFailure(e, signal, timer.signal, caller, spent, c.secrets);
        throw failure.kind === "connection" && failure.spent.length === 0
          ? new ModelError(failure.kind, failure.message, { spent: spent() })
          : failure;
      }
    } finally {
      timer.cancel();
    }
  }

  /** An HTTP error response as a `ModelError` (its body is read, classified, never echoed). */
  private async httpError(res: Response, spent: readonly UsageEntry[]): Promise<ModelError> {
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const c = classifyGeminiError(res.status, res.headers, body);
    return httpModelError("google", res.status, c, { spent, secrets: this.client.secrets });
  }

  /** What an HTTP error status costs: nothing (the billing page), but a 504, which may have run. */
  private spentOnStatus(status: number, estimate: () => UsageEntry[]): UsageEntry[] {
    return status === 504 ? estimate() : [];
  }

  /** A stream's `error` object as a `ModelError` (classified like an HTTP error of its code). */
  private streamError(error: unknown, spent: readonly UsageEntry[]): ModelError {
    const code: unknown = isRecord(error) ? error["code"] : undefined;
    const status = typeof code === "number" && Number.isSafeInteger(code) ? code : 500;
    const c = classifyGeminiError(status, null, { error });
    return httpModelError("google", status, c, { spent, secrets: this.client.secrets });
  }

  /** Folds one stream event into `seen`; an error event or an invalid one throws. */
  private absorb(data: string, seen: Seen, t0: number, estimate: () => UsageEntry[]): void {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      throw new ModelError("unknown", "google: a stream event is not JSON", { spent: estimate() });
    }
    const r = GeminiResponseSchema.safeParse(json);
    if (!r.success) {
      throw new ModelError("unknown", "google: a stream event failed validation", {
        spent: estimate(),
      });
    }
    const ev = r.data;
    if (ev.error !== undefined) throw this.streamError(ev.error, estimate());
    seen.modelVersion ??= modelIdOf(ev.modelVersion ?? null);
    seen.responseId ??= ev.responseId ?? null;
    const block = ev.promptFeedback?.blockReason;
    if (block !== undefined && block !== "" && block !== "BLOCK_REASON_UNSPECIFIED") {
      seen.block = block;
    }
    const candidate = ev.candidates?.[0];
    if (candidate !== undefined) {
      const parts = rawPartsOf(json);
      if (parts.length > 0) seen.firstPartMs ??= this.client.time.nowMs() - t0;
      seen.parts.push(...parts);
      const finish = candidate.finishReason;
      if (finish !== undefined && finish !== "") {
        seen.finish = finish;
        seen.finishMessage = candidate.finishMessage ?? null;
      }
    }
    if (ev.usageMetadata !== undefined) {
      seen.usage = ev.usageMetadata;
      // Only a usage that comes with or after the finish counts the whole response.
      seen.final = seen.finish !== null || seen.block !== null;
      const u = GeminiUsageSchema.safeParse(ev.usageMetadata);
      const prompt = u.success ? u.data.promptTokenCount : undefined;
      if (prompt !== undefined && prompt > 0) seen.prompt = prompt;
    }
  }

  /** The result of a finished stream (its usage, or the estimate when it has none). */
  private resultOf(
    req: ChatRequest,
    seen: Seen,
    t0: number,
    estimate: () => UsageEntry[],
  ): ChatResult {
    const served = seen.modelVersion;
    const usage = seen.final
      ? [geminiUsage(seen.usage, this.spec.model, () => estimate()[0] ?? missing(), served)]
      : estimate();
    const raw = structuredClone({
      modelVersion: seen.modelVersion,
      responseId: seen.responseId,
      ...(seen.block === null ? {} : { promptFeedback: { blockReason: seen.block } }),
      candidates: [
        {
          content: { role: "model", parts: seen.parts },
          finishReason: seen.finish,
          ...(seen.finishMessage === null ? {} : { finishMessage: seen.finishMessage }),
        },
      ],
      usageMetadata: seen.final ? seen.usage : null,
    });
    const finish = seen.finish ?? seen.block ?? "null";
    if (finish === "MISSING_THOUGHT_SIGNATURE") {
      throw new ModelError(
        "bad_request",
        "google: MISSING_THOUGHT_SIGNATURE: a thought signature was not sent back (an adapter bug)",
        { spent: usage },
      );
    }
    if (finish === "PUP_LIMITED_DISABLED") {
      throw new ModelError(
        "auth",
        "google: PUP_LIMITED_DISABLED: the account is limited or disabled under the Prohibited Use Policy",
        { spent: usage },
      );
    }
    if (!isPartArray(seen.parts)) {
      throw new ModelError("unknown", "google: the reply's parts failed validation", {
        spent: usage,
      });
    }
    const reply = replyOf(seen.parts, req.meta);
    const stop: StopReason = seen.block !== null ? "refusal" : stopOf(finish, reply.calls.length);
    const common = {
      rawStop: finish,
      servedBy: served ?? this.spec.model,
      fallback: false,
      usage,
      requestId: seen.responseId,
      latencyMs: this.client.time.nowMs() - t0,
      ttftMs: seen.firstPartMs,
      raw,
    };
    if (stop === "refusal") {
      return {
        ...common,
        reply: {
          native: [],
          text: [],
          calls: [],
          reasoning: [],
          reasoningKind: "summary" as const,
        },
        stop,
        refusal: {
          category: finish.toLowerCase(),
          explanation: seen.finishMessage,
          recommendedModel: null,
        },
      };
    }
    return { ...common, reply, stop, refusal: null };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body = this.build(req);
    const text = JSON.stringify(body);
    const maxTokens = body.generationConfig.maxOutputTokens;
    const seen = newSeen();
    const estimate = (): UsageEntry[] => [
      estimatedUsage(this.spec.model, seen.prompt ?? utf8.encode(text).length, maxTokens),
    ];
    const t0 = this.client.time.nowMs();
    return this.exchange(
      this.client.modelUrl(this.spec.model, ":streamGenerateContent?alt=sse"),
      { method: "POST", body: text, accept: "text/event-stream" },
      req.signal,
      estimate,
      async (res) => {
        if (!res.ok) throw await this.httpError(res, this.spentOnStatus(res.status, estimate));
        if (res.body === null) {
          throw new ModelError("connection", "google: the response has no body", {
            spent: estimate(),
          });
        }
        try {
          for await (const ev of readSse(res.body, {
            terminal: () => seen.final,
            spent: estimate,
          })) {
            this.absorb(ev.data, seen, t0, estimate);
          }
        } catch (e) {
          // Finished, but the final usage never came: the reply stands, its usage is estimated.
          const finished = seen.finish !== null || seen.block !== null;
          if (!(e instanceof ModelError && e.kind === "connection" && finished)) throw e;
        }
        return this.resultOf(req, seen, t0, estimate);
      },
    );
  }

  /**
   * The input tokens of `req` (`models.countTokens`, not billed): the system blocks, the tools and
   * the contents, as `chat` would send them.
   */
  async countTokens(req: ChatRequest): Promise<number> {
    const b = this.build(req);
    const body = JSON.stringify({
      generateContentRequest: {
        model: `models/${this.spec.model}`,
        systemInstruction: b.systemInstruction,
        contents: b.contents,
        tools: b.tools,
        toolConfig: b.toolConfig,
      },
    });
    return this.exchange(
      this.client.modelUrl(this.spec.model, ":countTokens"),
      { method: "POST", body, accept: "application/json" },
      req.signal,
      () => [],
      async (res) => {
        if (!res.ok) throw await this.httpError(res, []);
        const r = GeminiCountTokensSchema.safeParse(await jsonOf(res, "countTokens", []));
        if (!r.success) throw new ModelError("unknown", "google: countTokens failed validation");
        return r.data.totalTokens;
      },
    );
  }

  /**
   * The key, the model (`models.get`: generation supported, an output limit at least the
   * catalog's, which bounds the `max_tokens` retry) and the exact request shape: one
   * non-streamed `generateContent` of the production body at `GEMINI_PREFLIGHT_OUTPUT_TOKENS`
   * (tools in the transform's subset, thinking config, harness parts), charged.
   */
  async preflight(sample: ChatRequest): Promise<PreflightReport> {
    const model = this.spec.model;
    await this.exchange(
      this.client.modelUrl(model),
      { method: "GET", accept: "application/json" },
      sample.signal,
      () => [],
      async (res) => {
        if (!res.ok) throw await this.httpError(res, []);
        const r = GeminiModelInfoSchema.safeParse(await jsonOf(res, "models.get", []));
        if (!r.success) throw new ModelError("unknown", "google: models.get failed validation");
        const info = r.data;
        const methods = info.supportedGenerationMethods;
        if (methods !== undefined && !methods.includes("generateContent")) {
          throw new ModelError("not_found", `google: ${model} does not support generateContent`);
        }
        const limit = info.outputTokenLimit;
        if (limit !== undefined && limit < this.capabilities.maxOutputTokens) {
          throw new ModelError(
            "bad_request",
            `google: ${model} returns at most ${limit} output tokens, under the catalog's ${this.capabilities.maxOutputTokens} (the max_tokens retry's limit): fix the catalog`,
          );
        }
        return info;
      },
    );
    const b = this.build(sample);
    const shape: GeminiRequest = {
      ...b,
      generationConfig: { ...b.generationConfig, maxOutputTokens: GEMINI_PREFLIGHT_OUTPUT_TOKENS },
    };
    const text = JSON.stringify(shape);
    const estimate = (): UsageEntry[] => [
      estimatedUsage(model, utf8.encode(text).length, GEMINI_PREFLIGHT_OUTPUT_TOKENS),
    ];
    const usage = await this.exchange(
      this.client.modelUrl(model, ":generateContent"),
      { method: "POST", body: text, accept: "application/json" },
      sample.signal,
      estimate,
      async (res) => {
        if (!res.ok) throw await this.httpError(res, this.spentOnStatus(res.status, estimate));
        const json = await jsonOf(res, "the shape check's response", estimate());
        const r = GeminiResponseSchema.safeParse(json);
        if (!r.success) {
          throw new ModelError("unknown", "google: the shape check's response failed validation", {
            spent: estimate(),
          });
        }
        const served = modelIdOf(r.data.modelVersion ?? null);
        const spent =
          r.data.usageMetadata === undefined
            ? estimate()
            : [geminiUsage(r.data.usageMetadata, model, () => estimate()[0] ?? missing(), served)];
        const finish = r.data.candidates?.[0]?.finishReason ?? "";
        if (finish === "MISSING_THOUGHT_SIGNATURE" || finish === "PUP_LIMITED_DISABLED") {
          throw new ModelError(
            finish === "PUP_LIMITED_DISABLED" ? "auth" : "bad_request",
            `google: ${finish}`,
            {
              spent,
            },
          );
        }
        return spent;
      },
    );
    return { model, allowedFallbackModels: [], usage };
  }
}

/** Unreachable: an estimate always has one entry. */
function missing(): never {
  throw new Error("no usage entry");
}
