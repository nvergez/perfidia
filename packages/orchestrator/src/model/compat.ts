import { EFFORTS, type Effort, type TimeSource } from "@perfidia/protocol";
import {
  ModelError,
  adapterLabel,
  brokenStreamOutput,
  completionUpper,
  promptTokens,
  type ChatRequest,
  type ChatResult,
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
  type TokenUsage,
  type UsageEntry,
} from "./adapter.ts";
import { capabilitiesFor, modelInfo, type ReasoningKind } from "./catalog.ts";
import { HARNESS_PREFIX } from "./fake.ts";
import {
  classifyHttpError,
  fetchWithTimeout,
  guardedFetch,
  httpModelError,
  oneLine,
  readSse,
  redact,
  retryAfterMs,
  transportError,
  type Classified,
  type ErrorPhase,
  type HttpFetch,
} from "./http.ts";
import { cardsFrom, costOf, effectivePrices } from "./prices.ts";
import { FIRST_READ } from "./prices/card.ts";
import {
  CompatAssistantSchema,
  EndpointsResponseSchema,
  ErrorBodySchema,
  RouterMetadataSchema,
  StreamChunkSchema,
  UsageSchema,
  type CompatAssistant,
  type CompatMessage,
  type CompatRequest,
  type CompatTool,
  type CompatToolCall,
  type ProviderPin,
  type ReasoningDetail,
  type StreamChunk,
  type WireError,
  type WireUsage,
} from "./wire/compat.ts";

// The OpenAI-compatible Chat Completions adapter (phase-4 design §2.5, §2.7, Pass 2): one adapter
// for two modes on the shared transport (`http.ts`, raw `fetch`, no SDK):
//
// - `openrouter` (https://openrouter.ai/api/v1): the seat's model pinned to one endpoint by its full
//   slug (`provider: {only: [slug], allow_fallbacks: false, require_parameters: true,
//   data_collection: "deny", zdr: true}`), only the parameters that endpoint lists
//   (`parallel_tool_calls` only when listed: `z-ai/fp8` does not), the unified `reasoning.effort`
//   in the model's own vocabulary (`effortSent`), `X-OpenRouter-Metadata: enabled` and a check of
//   the served endpoint on every response (a mismatch is charged and refused: routing never
//   changes the model silently), `reasoning_details` echoed back unmodified, `usage.cost` logged
//   next to the card's cost (and any excess over the card charged: the ledger never bills less
//   than the provider);
// - `compat` (any compatible base URL: a local vLLM, a hosted endpoint): the same request without
//   OpenRouter's extensions, `stream_options.include_usage` for the final usage, no reasoning echo.
//
// Every request streams. The prompt is `system` (shared), `system` (seat), then the conversation:
// tool results are `tool` messages, harness text a `user` message starting with `[harness] ` (the
// envelope channel), the assistant replies their own message echoed back verbatim. Usage maps to
// the ledger's kinds so a charge is never below the bill: cached tokens are reads, written ones
// writes (billed as input on implicit-cache cards), the rest input; reasoning tokens are part of
// the completion and billed as output. A broken, cut or aborted stream is charged its prompt (the
// agent's own upper estimate, from the last measured request of the turn) and the full
// `max_tokens`; an error event before any output is not (OpenRouter's zero completion insurance:
// an error finish is not billed); an unknown usage shape is charged the seat's attempt bound (a
// usage the ledger cannot price), never 0.

/** The request's `max_tokens` of the preflight's shape check (the arena's `PREFLIGHT_OUTPUT_TOKENS`). */
export const PREFLIGHT_MAX_TOKENS = 16;
/** What a part of an entry may add to a prompt besides its bytes (the agent's `ENTRY_OVERHEAD_TOKENS`). */
export const PART_OVERHEAD_TOKENS = 32;
/** The attempt backstop until the response headers arrive; the agent's signal is the real deadline. */
export const DEFAULT_COMPAT_TIMEOUT_MS = 15 * 60_000;
/** OpenRouter's router-metadata opt-in (router-metadata.md). */
export const METADATA_HEADER = "x-openrouter-metadata";

/** Header names the guarded fetch lets through from the adapter (the auth header is always ours). */
const ALLOWED_HEADER = /^(?:accept|content-type)$/;

export type CompatMode = "openrouter" | "compat";

/** What the adapter knows of an OpenRouter seat's pinned endpoint (the plan checked it). */
export interface PinnedEndpoint {
  /** The full slug, e.g. `z-ai/fp8`. */
  readonly tag: string;
  /** The serving provider's name as the routing metadata shows it (`Z.AI`); null: not checked. */
  readonly providerName: string | null;
  /** The endpoint's `supported_parameters`. */
  readonly supportedParams: readonly string[];
  /** Listed in OpenRouter's zero-data-retention endpoints: the request also asks `zdr: true`. */
  readonly zdr: boolean;
}

export interface CompatAdapterOptions {
  readonly mode: CompatMode;
  /** The API base, e.g. `https://openrouter.ai/api/v1` (`PERFIDIA_<PROVIDER>_BASE_URL`). */
  readonly baseURL: string;
  /** `PERFIDIA_<PROVIDER>_API_KEY`; null for a keyless compat endpoint on loopback. */
  readonly apiKey: string | null;
  /** The run's time source: latency, time to first token, the backstop timer. */
  readonly time: TimeSource;
  readonly timeoutMs?: number;
  /** OpenRouter: the pinned endpoint (default: the catalog's snapshot, no provider-name check). */
  readonly endpoint?: PinnedEndpoint;
  /** Tests: a stub; default the global `fetch` (through the guarded transport either way). */
  readonly fetch?: HttpFetch;
}

// Efforts --------------------------------------------------------------------------------------

/**
 * The effort a request carries for a seat of `effort` (phase-4 review C9). OpenRouter maps an
 * effort a model does not list "to the nearest supported level" (reasoning-tokens.md), without a
 * rule for a tie: GLM-5.3 lists max, high and low, and medium is one step from both. The adapter
 * sends a listed level itself, the nearest on the gateway's ladder, a tie going to the lower level
 * (our rule, not OpenRouter's: the cheaper level keeps the prediction, made at the seat's effort,
 * an upper bound), never `none` unless asked. Unverified until a smoke records the reasoning
 * tokens. Elsewhere (and for a model whose list is unknown) the effort goes as is.
 */
export function effortSent(provider: string, model: string, effort: Effort): Effort {
  if (provider !== "openrouter") return effort;
  const listed = modelInfo("openrouter", model)?.advertisedEfforts ?? null;
  if (listed === null || listed.length === 0 || listed.includes(effort)) return effort;
  const at = EFFORTS.indexOf(effort);
  let best: Effort | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [i, e] of EFFORTS.entries()) {
    if (!listed.includes(e) || e === "none") continue;
    const d = Math.abs(i - at);
    if (d < bestDistance) {
      best = e;
      bestDistance = d;
    }
  }
  return best ?? effort;
}

/** The parameters of the gateway's request besides `model`, `messages`, `stream` and `provider`. */
export function sentParams(mode: CompatMode, supported: readonly string[] | null): string[] {
  if (mode === "compat") return ["tools", "tool_choice", "max_tokens"];
  const out = ["tools", "tool_choice", "max_tokens", "reasoning"];
  if (supported?.includes("parallel_tool_calls") === true) out.push("parallel_tool_calls");
  return out;
}

// Requests -------------------------------------------------------------------------------------

const utf8 = new TextEncoder();
const bytesOf = (text: string): number => utf8.encode(text).length;

/** An upper bound of an entry's prompt tokens (the agent's `entryTokensUpper`, same rule). */
function entryTokensUpper(entry: Entry): number {
  if (entry.role === "operator") return bytesOf(entry.text) + PART_OVERHEAD_TOKENS;
  if (entry.role === "assistant") {
    return bytesOf(JSON.stringify(entry.reply.native) ?? "") + PART_OVERHEAD_TOKENS;
  }
  let n = 0;
  for (const p of entry.parts) {
    n +=
      (p.kind === "text" ? bytesOf(p.text) : bytesOf(p.content) + bytesOf(p.callId)) +
      PART_OVERHEAD_TOKENS;
  }
  return n;
}

/**
 * An upper bound of a request's prompt from its bytes (the agent's default prefix and the arena's
 * `sampleTokensUpper`): one token per UTF-8 byte of both system blocks, the tools and every entry,
 * plus the per-part overheads.
 */
export function promptBytesUpper(req: ChatRequest): number {
  let n =
    bytesOf(req.prompt.shared) +
    bytesOf(req.prompt.seat) +
    bytesOf(JSON.stringify(req.tools)) +
    3 * PART_OVERHEAD_TOKENS;
  for (const e of req.entries) n += entryTokensUpper(e);
  return n;
}

function isAssistant(v: unknown): v is CompatAssistant {
  return CompatAssistantSchema.safeParse(v).success;
}

function checkEntries(entries: readonly Entry[]): void {
  if (entries[0]?.role !== "user") throw new Error("a conversation starts with a user entry");
  if (entries.at(-1)?.role === "assistant") {
    throw new Error("a conversation ends with a user or operator entry (no prefill)");
  }
}

/** The conversation as Chat Completions messages (after the two system blocks). */
export function messagesOf(entries: readonly Entry[]): CompatMessage[] {
  const out: CompatMessage[] = [];
  for (const [i, e] of entries.entries()) {
    if (e.role === "user") {
      const texts: string[] = [];
      let results = 0;
      for (const p of e.parts) {
        if (p.kind === "result") {
          // The gateway's result JSON says `ok:false` with a code and a hint: no error flag here.
          out.push({ role: "tool", tool_call_id: p.callId, content: p.content });
          results += 1;
        } else {
          texts.push(p.text);
        }
      }
      if (results + texts.length === 0) throw new Error(`entry ${i}: an empty user entry`);
      if (texts.length === 1) out.push({ role: "user", content: texts[0] ?? "" });
      else if (texts.length > 1) {
        out.push({ role: "user", content: texts.map((text) => ({ type: "text", text })) });
      }
    } else if (e.role === "operator") {
      if (i === 0) throw new Error(`entry ${i}: an operator entry must follow a user entry`);
      out.push({ role: "user", content: `${HARNESS_PREFIX}${e.text}` });
    } else {
      const native = e.reply.native;
      if (!isAssistant(native)) {
        throw new Error(`entry ${i}: the reply is not a Chat Completions assistant message`);
      }
      // Verbatim: the object the stream built, echoed with its reasoning details as they came.
      out.push(native);
    }
  }
  return out;
}

// Responses ------------------------------------------------------------------------------------

/** One tool call as the stream assembles it, by `index`. */
interface CallAcc {
  id: string | null;
  name: string;
  args: string;
}

/** What a stream delivered, folded chunk by chunk. */
interface StreamState {
  /** When content, reasoning or a tool call first arrived (time to first token); null: none yet. */
  firstAt: number | null;
  id: string | null;
  model: string | null;
  provider: string | null;
  content: string;
  refusal: string;
  /** Plain reasoning text (`reasoning`, or `reasoning_content` on compat endpoints). */
  reasoning: string;
  details: ReasoningDetail[];
  calls: Map<number, CallAcc>;
  finish: string | null;
  nativeFinish: string | null;
  /** The raw `usage` object of the final chunk (parsed apart). */
  usage: unknown;
  metadata: unknown;
  error: WireError | null;
  /** The `[DONE]` sentinel arrived. */
  done: boolean;
}

function newState(): StreamState {
  return {
    firstAt: null,
    id: null,
    model: null,
    provider: null,
    content: "",
    refusal: "",
    reasoning: "",
    details: [],
    calls: new Map(),
    finish: null,
    nativeFinish: null,
    usage: undefined,
    metadata: undefined,
    error: null,
    done: false,
  };
}

const STRING_FIELDS = ["text", "summary", "data"] as const;

/**
 * Merges a streamed reasoning detail into the list: fragments of one detail share its `index`
 * (their text, summary or data concatenated, the other fields kept from the first fragment that
 * has them, a signature from the last); a detail without an index is appended as is.
 */
function mergeDetail(into: ReasoningDetail[], d: ReasoningDetail): void {
  const at = d.index === undefined ? -1 : into.findIndex((x) => x.index === d.index);
  const prev = at < 0 ? undefined : into[at];
  if (prev === undefined || prev.type !== d.type) {
    into.push({ ...d });
    return;
  }
  const next: ReasoningDetail = { ...prev };
  for (const k of STRING_FIELDS) {
    const add = d[k];
    if (typeof add === "string") next[k] = `${prev[k] ?? ""}${add}`;
  }
  for (const [k, v] of Object.entries(d)) {
    if (STRING_FIELDS.some((s) => s === k) || k === "signature") continue;
    if (Reflect.get(next, k) === undefined || Reflect.get(next, k) === null)
      Reflect.set(next, k, v);
  }
  if (typeof d.signature === "string" && d.signature !== "") next.signature = d.signature;
  into[at] = next;
}

function fold(s: StreamState, c: StreamChunk, now: number): void {
  s.id = c.id ?? s.id;
  s.model = c.model ?? s.model;
  s.provider = c.provider ?? s.provider;
  if (c.usage !== undefined && c.usage !== null) s.usage = c.usage;
  if (c.openrouter_metadata !== undefined && c.openrouter_metadata !== null) {
    s.metadata = c.openrouter_metadata;
  }
  if (c.error !== undefined && c.error !== null) s.error = c.error;
  for (const choice of c.choices ?? []) {
    if (choice.error !== undefined && choice.error !== null) s.error ??= choice.error;
    if (typeof choice.finish_reason === "string") s.finish = choice.finish_reason;
    if (typeof choice.native_finish_reason === "string")
      s.nativeFinish = choice.native_finish_reason;
    const d = choice.delta;
    if (d === undefined || d === null) continue;
    let produced = false;
    if (typeof d.content === "string" && d.content !== "") {
      s.content += d.content;
      produced = true;
    }
    if (typeof d.refusal === "string" && d.refusal !== "") {
      s.refusal += d.refusal;
      produced = true;
    }
    const plain = d.reasoning ?? d.reasoning_content;
    if (typeof plain === "string" && plain !== "") {
      s.reasoning += plain;
      produced = true;
    }
    for (const r of d.reasoning_details ?? []) {
      mergeDetail(s.details, r);
      produced = true;
    }
    for (const t of d.tool_calls ?? []) {
      const acc = s.calls.get(t.index) ?? { id: null, name: "", args: "" };
      if (typeof t.id === "string" && t.id !== "") acc.id ??= t.id;
      const name = t.function?.name;
      if (typeof name === "string") acc.name += name;
      const args = t.function?.arguments;
      if (typeof args === "string") acc.args += args;
      s.calls.set(t.index, acc);
      produced = true;
    }
    if (produced) s.firstAt ??= now;
  }
}

/** The assembled tool calls, in index order; an id the stream never gave is made stable. */
function callsOf(s: StreamState): CompatToolCall[] {
  return [...s.calls.entries()]
    .toSorted((a, b) => a[0] - b[0])
    .map(([index, c]) => ({
      id: c.id ?? `call_${s.id ?? "x"}_${index}`,
      type: "function",
      function: { name: c.name, arguments: c.args },
    }));
}

/** Arguments that are not valid JSON go through raw: the gateway answers `INVALID_ARGS`. */
function argsOf(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    const v: unknown = JSON.parse(text);
    return v;
  } catch {
    return text;
  }
}

/** The readable reasoning of a reply and what it is: a provider's summary, raw text, or none. */
function reasoningOf(s: StreamState): { readonly texts: string[]; readonly kind: ReasoningKind } {
  const summaries = s.details.flatMap((d) =>
    d.type === "reasoning.summary" && typeof d.summary === "string" && d.summary !== ""
      ? [d.summary]
      : [],
  );
  const texts = s.details.flatMap((d) =>
    d.type === "reasoning.text" && typeof d.text === "string" && d.text !== "" ? [d.text] : [],
  );
  if (summaries.length > 0) return { texts: summaries, kind: "summary" };
  if (texts.length > 0) return { texts, kind: "raw" };
  if (s.reasoning !== "") return { texts: [s.reasoning], kind: "raw" };
  return { texts: [], kind: "none" };
}

/**
 * Usage as the ledger's kinds, never under the bill: cached tokens are reads and written ones
 * writes (the card bills both; an implicit-cache card writes at the input price), the rest of the
 * prompt input; the completion (reasoning included) is output. A prompt breakdown larger than the
 * prompt is charged whole at the input price; reasoning larger than the completion (a provider that
 * counts it apart) is added to it.
 */
export function tokensOf(u: WireUsage): TokenUsage {
  const prompt = u.prompt_tokens;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const written = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? undefined;
  const consistent = cached + written <= prompt;
  const output =
    reasoning !== undefined && reasoning > u.completion_tokens
      ? u.completion_tokens + reasoning
      : u.completion_tokens;
  return {
    input: consistent ? prompt - cached - written : Math.max(prompt, cached + written),
    cacheWrite5m: consistent ? written : 0,
    cacheWrite1h: 0,
    cacheRead: consistent ? cached : 0,
    output,
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

/** USD credits (`usage.cost`) as nano-dollars, rounded up (a pico-dollar rounding first). */
export function creditsToNano(cost: number): number {
  return Math.ceil(Math.round(cost * 1e12) / 1000);
}

/** A usage entry the ledger cannot price: it charges the seat's attempt bound (never 0). */
function boundEntry(model: string): UsageEntry {
  return {
    model,
    kind: "message",
    tokens: {
      input: Number.NaN,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: Number.NaN,
    },
    estimated: true,
  };
}

// Errors ---------------------------------------------------------------------------------------

/** What an OpenRouter `error_type` means for the harness (errors-and-debugging.md, typed codes). */
type TypedKind =
  | { readonly kind: ModelErrorKind }
  | { readonly kind: "refusal"; readonly category: string }
  | { readonly kind: "length" };

const ERROR_TYPES: Readonly<Record<string, TypedKind>> = Object.freeze({
  context_length_exceeded: { kind: "too_large" },
  max_tokens_exceeded: { kind: "length" },
  token_limit_exceeded: { kind: "billing" },
  string_too_long: { kind: "too_large" },
  authentication: { kind: "auth" },
  permission_denied: { kind: "auth" },
  payment_required: { kind: "billing" },
  rate_limit_exceeded: { kind: "rate_limit" },
  provider_overloaded: { kind: "overloaded" },
  provider_unavailable: { kind: "server" },
  invalid_request: { kind: "bad_request" },
  invalid_prompt: { kind: "bad_request" },
  not_found: { kind: "not_found" },
  precondition_failed: { kind: "bad_request" },
  payload_too_large: { kind: "too_large" },
  unprocessable: { kind: "bad_request" },
  content_policy_violation: { kind: "refusal", category: "content_policy_violation" },
  refusal: { kind: "refusal", category: "refusal" },
  invalid_image: { kind: "bad_request" },
  image_too_large: { kind: "bad_request" },
  image_too_small: { kind: "bad_request" },
  unsupported_image_format: { kind: "bad_request" },
  image_not_found: { kind: "bad_request" },
  image_download_failed: { kind: "bad_request" },
  server: { kind: "server" },
  timeout: { kind: "timeout" },
  unmapped: { kind: "server" },
});

const typedKind = (t: string | null | undefined): TypedKind | null =>
  t === null || t === undefined || !Object.hasOwn(ERROR_TYPES, t) ? null : (ERROR_TYPES[t] ?? null);

function errorOf(body: unknown): WireError | null {
  const parsed = ErrorBodySchema.safeParse(body);
  return parsed.success ? parsed.data.error : null;
}

/**
 * An HTTP error response of the gateway, classified by its code before its status (design §2.2):
 * OpenRouter's credit, key, budget and moderation signals (`http.ts`), then its typed
 * `error_type` (a pre-stream `max_tokens_exceeded` is the request's fault: `bad_request`), then
 * the status. A compat endpoint has only the status.
 */
export function classifyCompatError(
  mode: CompatMode,
  status: number,
  headers: Headers | null,
  body: unknown,
  phase: ErrorPhase = "match",
): Classified {
  // OpenRouter's `error.code` repeats the status: dropped, so a message reads "HTTP 401" once.
  const shared = (provider: string): Classified => {
    const c = classifyHttpError(provider, status, headers, body, phase);
    return c.code === `${status}` ? { ...c, code: null } : c;
  };
  if (mode === "compat") return shared("compat");
  const err = errorOf(body);
  const meta = err?.metadata ?? null;
  const moderated =
    meta !== null &&
    (Reflect.get(meta, "reasons") !== undefined ||
      Reflect.get(meta, "flagged_input") !== undefined);
  if (meta?.limit_source !== undefined || status === 402 || status === 503 || moderated) {
    return shared("openrouter");
  }
  const typed = typedKind(meta?.error_type);
  if (typed !== null) {
    const code = meta?.error_type ?? null;
    if (typed.kind === "refusal") {
      return { kind: "refusal", refusal: typed.category, retryAfterMs: null, code };
    }
    const kind: ModelErrorKind = typed.kind === "length" ? "bad_request" : typed.kind;
    return { kind, refusal: null, retryAfterMs: retryAfterMs(headers), code };
  }
  return shared("openrouter");
}

/** An error event inside a 200 stream (or a 200 body holding only `error`): by `error_type` first. */
function classifyStreamError(mode: CompatMode, err: WireError): TypedKind & { code: string } {
  const typed = mode === "openrouter" ? typedKind(err.metadata?.error_type) : null;
  const code =
    err.metadata?.error_type ?? (err.code === null || err.code === undefined ? "" : `${err.code}`);
  if (typed !== null) return { ...typed, code };
  if (typeof err.code === "number" && err.code >= 400) {
    const c = classifyHttpError(mode, err.code, null, { error: err }, "match");
    return c.kind === "refusal"
      ? { kind: "refusal", category: c.refusal ?? "refusal", code }
      : { kind: c.kind, code };
  }
  const text = `${err.code ?? ""} ${err.type ?? ""}`;
  if (/rate.?limit/i.test(text)) return { kind: "rate_limit", code };
  if (/overload|capacity|unavailable/i.test(text)) return { kind: "overloaded", code };
  if (/server|internal|upstream/i.test(text)) return { kind: "server", code };
  return { kind: "unknown", code };
}

// The adapter ----------------------------------------------------------------------------------

/** The last measured requests (a turn's rounds): the agent's prompt estimate of a broken stream. */
interface Known {
  readonly items: readonly Entry[];
  readonly prompt: number;
  readonly output: number;
}

const KNOWN_KEPT = 4;

const EMPTY_REPLY_NATIVE: CompatAssistant = Object.freeze({ role: "assistant", content: null });

export class CompatAdapter implements ModelAdapter {
  readonly spec: ModelSpec;
  readonly label: string;
  readonly capabilities: ModelCapabilities;
  readonly mode: CompatMode;
  /** What the request's `reasoning.effort` says (`effortSent`); the label keeps the seat's. */
  readonly effort: Effort;
  readonly endpoint: PinnedEndpoint | null;
  private readonly time: TimeSource;
  private readonly timeoutMs: number;
  private readonly base: string;
  private readonly fetch: HttpFetch;
  /** The key as an error body could echo it (raw, URL-encoded, as a bearer value). */
  private readonly secrets: readonly string[];
  private readonly toolCache = new WeakMap<readonly ModelTool[], readonly CompatTool[]>();
  private readonly known: Known[] = [];
  private readonly params: readonly string[];

  constructor(spec: ModelSpec, o: CompatAdapterOptions) {
    if (spec.provider !== o.mode) throw new Error(`not a ${o.mode} spec: ${spec.provider}`);
    this.spec = spec;
    this.mode = o.mode;
    this.label = adapterLabel(spec);
    const endpoint = spec.endpoint ?? null;
    if (o.mode === "openrouter" && endpoint === null) {
      throw new Error("an openrouter seat pins a full endpoint slug");
    }
    this.capabilities = capabilitiesFor(o.mode, spec.model, endpoint);
    this.endpoint =
      o.mode === "compat"
        ? null
        : (o.endpoint ?? {
            tag: endpoint ?? "",
            providerName: null,
            supportedParams: this.capabilities.supportedParams ?? [],
            zdr:
              modelInfo("openrouter", spec.model)?.endpoints.find((e) => e.tag === endpoint)?.zdr ??
              false,
          });
    if (this.endpoint !== null && this.endpoint.tag !== endpoint) {
      throw new Error(
        `the pinned endpoint ${this.endpoint.tag} is not the spec's ${endpoint ?? ""}`,
      );
    }
    this.params = sentParams(o.mode, this.endpoint?.supportedParams ?? null);
    this.effort = effortSent(o.mode, spec.model, spec.effort);
    this.time = o.time;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_COMPAT_TIMEOUT_MS;
    this.base = o.baseURL.replace(/\/+$/, "");
    const key = o.apiKey;
    if (key !== null && key.trim() === "") throw new Error(`the ${o.mode} API key is empty`);
    this.secrets =
      key === null ? [] : [...new Set([key, encodeURIComponent(key), `Bearer ${key}`])];
    this.fetch = guardedFetch({
      baseURL: this.base,
      auth: key === null ? null : { header: "authorization", value: `Bearer ${key}` },
      allowHeaders: ALLOWED_HEADER,
      ...(o.mode === "openrouter" ? { fixedHeaders: { [METADATA_HEADER]: "enabled" } } : {}),
      ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    });
  }

  /** The provider name used in messages and logs. */
  private get who(): string {
    return this.mode;
  }

  /** The tools as Chat Completions functions, computed once per tool list (stable bytes). */
  private toolsOf(tools: readonly ModelTool[]): CompatTool[] {
    let out = this.toolCache.get(tools);
    if (out === undefined) {
      out = Object.freeze(
        tools.map((t) =>
          Object.freeze({
            type: "function" as const,
            function: Object.freeze({
              name: t.name,
              description: t.description,
              parameters: { ...t.inputSchema },
            }),
          }),
        ),
      );
      this.toolCache.set(tools, out);
    }
    return [...out];
  }

  /** The routing pin of an OpenRouter request. */
  private pin(): ProviderPin | undefined {
    if (this.endpoint === null) return undefined;
    return {
      only: [this.endpoint.tag],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
      ...(this.endpoint.zdr ? { zdr: true as const } : {}),
    };
  }

  build(req: ChatRequest): CompatRequest {
    checkEntries(req.entries);
    const open = this.mode === "openrouter";
    const pin = this.pin();
    return {
      model: this.spec.model,
      messages: [
        { role: "system", content: req.prompt.shared },
        { role: "system", content: req.prompt.seat },
        ...messagesOf(req.entries),
      ],
      tools: this.toolsOf(req.tools),
      tool_choice: "auto",
      max_tokens: req.maxOutputTokens ?? this.spec.maxOutputTokens,
      ...(open ? { reasoning: { effort: this.effort } } : {}),
      ...(this.params.includes("parallel_tool_calls")
        ? { parallel_tool_calls: true as const }
        : {}),
      stream: true,
      ...(open ? {} : { stream_options: { include_usage: true as const } }),
      ...(pin === undefined ? {} : { provider: pin }),
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const res = await this.send(req, this.build(req), () => this.knownEstimate(req.entries));
    // What the agent's prompt cap keeps of this answer (`servedTokens`), kept the same way here.
    const last = res.usage.at(-1);
    if (last !== undefined && Number.isFinite(promptTokens(last.tokens))) {
      this.known.unshift({
        items: req.entries,
        prompt: promptTokens(last.tokens),
        output: last.tokens.output,
      });
      this.known.splice(KNOWN_KEPT);
    }
    return res;
  }

  /**
   * The agent's own prompt estimate of `entries` (`promptEstimate`), from the longest measured
   * request whose entries are a prefix of them: its prompt, its reply's output and the appended
   * entries at one token per byte (the prompt cap checked exactly this before the attempt, so the
   * charge stays within the attempt bound). Null without one (round 0): the attempt bound.
   */
  private knownEstimate(entries: readonly Entry[]): number | null {
    let best: Known | null = null;
    for (const k of this.known) {
      if (k.items.length > entries.length) continue;
      if (!k.items.every((e, i) => entries[i] === e)) continue;
      if (best === null || k.items.length > best.items.length) best = k;
    }
    if (best === null) return null;
    if (best.items.length === entries.length) return best.prompt;
    let n = best.prompt + best.output;
    for (const e of entries.slice(best.items.length)) {
      if (e.role !== "assistant") n += entryTokensUpper(e);
    }
    return n;
  }

  /** Sends one streamed request; `estimate`: the prompt to charge when its usage never arrives. */
  private async send(
    req: ChatRequest,
    body: CompatRequest,
    estimate: () => number | null,
  ): Promise<ChatResult> {
    const t0 = this.time.nowMs();
    const state = newState();
    const spent = (errorEvent = false): UsageEntry[] =>
      this.spentOf(state, body.max_tokens, estimate, errorEvent);
    let res: Response;
    try {
      res = await fetchWithTimeout(
        this.fetch,
        `${this.base}/chat/completions`,
        {
          method: "POST",
          headers: { accept: "text/event-stream", "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        {
          time: this.time,
          timeoutMs: this.timeoutMs,
          ...(req.signal === undefined ? {} : { signal: req.signal }),
        },
      );
    } catch (e) {
      const err = transportError(e, req.signal, this.secrets);
      // Cut before the headers by our own deadline: the request may be running (and billed) on a
      // provider that does not stop when the client disconnects. A connection that failed is not.
      if (err.kind === "timeout" || err.kind === "aborted") {
        throw new ModelError(err.kind, oneLine(redact(err.message, this.secrets)), {
          spent: spent(),
        });
      }
      throw this.redacted(err);
    }
    const requestId = res.headers.get("x-generation-id");
    if (!res.ok) return this.httpFailure(res, requestId, t0);
    const type = res.headers.get("content-type") ?? "";
    if (res.body === null || !type.includes("text/event-stream")) {
      return this.jsonFailure(res, requestId, () => spent());
    }
    try {
      for await (const ev of readSse(res.body, {
        terminal: (e) => e.data.trim() === "[DONE]",
        spent: () => spent(),
      })) {
        if (ev.data.trim() === "[DONE]") {
          state.done = true;
          break;
        }
        let json: unknown;
        try {
          json = JSON.parse(ev.data);
        } catch {
          throw new ModelError("unknown", `${this.who}: a stream event is not JSON`, {
            spent: spent(),
            requestId,
          });
        }
        const chunk = StreamChunkSchema.safeParse(json);
        if (!chunk.success) {
          throw new ModelError("unknown", `${this.who}: a stream chunk does not match its schema`, {
            spent: spent(),
            requestId,
          });
        }
        fold(state, chunk.data, this.time.nowMs());
        // "The stream is terminated after this unified error event" (streaming.md).
        if (state.error !== null) break;
      }
    } catch (e) {
      if (req.signal?.aborted === true) {
        throw new ModelError("aborted", "request aborted", { spent: spent(), requestId });
      }
      if (state.error === null) {
        throw this.redacted(
          e instanceof ModelError ? e : transportError(e, req.signal, this.secrets),
          requestId,
        );
      }
    }
    const latencyMs = this.time.nowMs() - t0;
    const ttftMs = state.firstAt === null ? null : state.firstAt - t0;
    if (state.error !== null) {
      const c = classifyStreamError(this.mode, state.error);
      if (c.kind === "length") {
        // A generation stopped at `max_tokens` (OpenRouter turns it into a `length` finish on its
        // other APIs, a successful completion, which is billed): the harness's `max_tokens` stop and
        // its retry. Without the final usage, the spend is the broken-stream estimate (the prompt
        // and the full `max_tokens`, even when nothing streamed: zero completion insurance covers
        // an error finish only); a reply whose estimate is the attempt bound cannot carry it, so it
        // fails instead (charged the bound).
        state.finish = "length";
        state.nativeFinish ??= c.code;
        if (state.usage === undefined) {
          const estimated = spent();
          if (estimated.some((u) => !Number.isFinite(u.tokens.input))) {
            throw new ModelError("unknown", `${this.who}: max_tokens reached without a usage`, {
              spent: estimated,
              requestId,
            });
          }
          return this.lengthResult(state, estimated, requestId, latencyMs, ttftMs);
        }
      } else if (c.kind === "refusal") {
        return this.refusalResult(
          state,
          spent(true),
          requestId,
          latencyMs,
          ttftMs,
          c.category,
          null,
        );
      } else {
        throw new ModelError(
          c.kind,
          oneLine(redact(`${this.who} stream error ${c.code}`.trim(), this.secrets)),
          { spent: spent(true), requestId },
        );
      }
    }
    return this.resultOf(state, () => spent(), requestId, latencyMs, ttftMs);
  }

  /** A non-2xx response: a refusal closes the turn; anything else is a `ModelError`. */
  private async httpFailure(
    res: Response,
    requestId: string | null,
    t0: number,
  ): Promise<ChatResult> {
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const c = classifyCompatError(this.mode, res.status, res.headers, body);
    if (c.kind === "refusal") {
      // Blocked before any inference (a moderation or guardrail block): nothing billed.
      return this.refusalResult(
        newState(),
        [],
        requestId,
        this.time.nowMs() - t0,
        null,
        c.refusal ?? "refusal",
        null,
      );
    }
    throw httpModelError(this.who, res.status, c, { requestId, secrets: this.secrets });
  }

  /** A 200 that is not a stream: OpenRouter's body holding only `error`, or something unknown. */
  private async jsonFailure(
    res: Response,
    requestId: string | null,
    spent: () => UsageEntry[],
  ): Promise<never> {
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const err = errorOf(body);
    if (err !== null) {
      const c = classifyStreamError(this.mode, err);
      const kind: ModelErrorKind =
        c.kind === "length" || c.kind === "refusal" ? "bad_request" : c.kind;
      // An error finish is not billed by OpenRouter (zero completion insurance); nothing streamed.
      // A length-type error is a generation that ran to `max_tokens` (billed): the estimate.
      throw new ModelError(kind, oneLine(redact(`${this.who} error ${c.code}`, this.secrets)), {
        spent: this.mode === "openrouter" && c.kind !== "length" ? [] : spent(),
        requestId,
      });
    }
    throw new ModelError("unknown", `${this.who}: a 200 response that is not an event stream`, {
      spent: [boundEntry(this.spec.model)],
      requestId,
    });
  }

  /**
   * What an attempt that did not complete cost. The final usage when it arrived (estimated: the
   * stream broke after it). An error event before any output (`errorEvent`) on OpenRouter is not
   * billed: its zero completion insurance covers an error finish, and nothing was generated (a
   * compat endpoint has no such insurance: the estimate).
   * Otherwise (a stream that broke, was cut or aborted once the request was accepted, started or
   * not: Z.AI is not among the providers whose generation stops when the client disconnects) the
   * prompt estimate and the full `max_tokens` of output (`brokenStreamOutput`), or the seat's attempt
   * bound when there is no estimate (round 0).
   */
  private spentOf(
    s: StreamState,
    maxTokens: number,
    estimate: () => number | null,
    errorEvent = false,
  ): UsageEntry[] {
    if (s.usage !== undefined) {
      const u = UsageSchema.safeParse(s.usage);
      if (!u.success) return [boundEntry(this.spec.model)];
      return [{ ...this.entryOf(s, u.data), estimated: true }];
    }
    // Only OpenRouter insures an error finish; a compat endpoint may bill the prompt it read.
    if (errorEvent && this.mode === "openrouter" && s.firstAt === null) return [];
    const prompt = estimate();
    if (prompt === null) return [boundEntry(this.spec.model)];
    return [
      {
        model: this.spec.model,
        kind: "message",
        tokens: {
          input: prompt,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheRead: 0,
          output: completionUpper(this.mode, brokenStreamOutput(maxTokens)),
        },
        estimated: true,
      },
    ];
  }

  /** The model a usage entry is priced at: the seat's for its own id or a dated snapshot of it. */
  private billedModel(served: string | null): string {
    if (served === null || served === this.spec.model) return this.spec.model;
    const dated = new RegExp(
      `^${this.spec.model.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{8}$`,
    );
    return dated.test(served) ? this.spec.model : served;
  }

  /**
   * One usage entry from a valid usage, with any excess of the reported cost over the card added;
   * the attempt-bound marker when the cards cannot price it (counts too large for an exact cost):
   * a usage the adapter cannot price is charged the attempt bound, never 0.
   */
  private entryOf(s: StreamState, u: WireUsage): UsageEntry {
    const model = this.billedModel(s.model);
    const tokens = tokensOf(u);
    let topUp: number;
    try {
      topUp = this.topUpTokens(model, tokens, u.cost ?? null);
    } catch {
      return boundEntry(this.spec.model);
    }
    return topUp === 0
      ? { model, kind: "message", tokens, estimated: false }
      : {
          model,
          kind: "message",
          tokens: { ...tokens, output: tokens.output + topUp },
          estimated: true,
        };
  }

  /**
   * Output tokens to add so that the card's charge covers what OpenRouter reports it billed
   * (`usage.cost`, credits; the platform fee is charged apart): 0 when the cheapest card valid
   * for the endpoint already covers it (or the model has no card: it is charged the highest price
   * of every card).
   */
  private topUpTokens(model: string, tokens: TokenUsage, cost: number | null): number {
    if (cost === null || this.mode !== "openrouter") return 0;
    const reported = creditsToNano(cost);
    const cards = cardsFrom("openrouter", model, this.endpoint?.tag ?? null, FIRST_READ);
    if (cards.length === 0) return 0;
    let need = 0;
    const entry: UsageEntry = { model, kind: "message", tokens, estimated: false };
    for (const card of cards) {
      const c = costOf([entry], {
        provider: "openrouter",
        endpoint: card.endpoint,
        at: card.validFrom,
      });
      const deficit = reported - (c.nanoUsd - c.feeNanoUsd);
      // A rounding of the credits (a few pico-dollars) is not an excess.
      if (deficit <= 1) continue;
      const out = effectivePrices(card).output;
      if (out > 0) need = Math.max(need, Math.ceil((deficit * 1000) / out));
    }
    return need;
  }

  /** A `max_tokens` stop reported as an error event without usage: retried, its reply unused. */
  private lengthResult(
    s: StreamState,
    usage: readonly UsageEntry[],
    requestId: string | null,
    latencyMs: number,
    ttftMs: number | null,
  ): ChatResult {
    return {
      reply: {
        native: EMPTY_REPLY_NATIVE,
        text: [],
        calls: [],
        reasoning: [],
        reasoningKind: "none",
      },
      stop: "max_tokens",
      rawStop: s.nativeFinish ?? "length",
      refusal: null,
      servedBy: s.model ?? this.spec.model,
      fallback: false,
      usage,
      requestId: requestId ?? s.id,
      latencyMs,
      ttftMs,
      raw: { id: s.id, model: s.model, error: s.error?.metadata?.error_type ?? null },
      endpoint: null,
      reportedCostNanoUsd: null,
    };
  }

  private refusalResult(
    s: StreamState,
    usage: readonly UsageEntry[],
    requestId: string | null,
    latencyMs: number,
    ttftMs: number | null,
    category: string,
    explanation: string | null,
  ): ChatResult {
    const refusal: Refusal = { category, explanation, recommendedModel: null };
    return {
      reply: {
        native: EMPTY_REPLY_NATIVE,
        text: [],
        calls: [],
        reasoning: [],
        reasoningKind: "none",
      },
      stop: "refusal",
      rawStop: s.nativeFinish ?? s.finish ?? category,
      refusal,
      servedBy: s.model ?? this.spec.model,
      fallback: false,
      usage,
      requestId: requestId ?? s.id,
      latencyMs,
      ttftMs,
      raw: { id: s.id, model: s.model, refusal: category },
      endpoint: null,
      reportedCostNanoUsd: null,
    };
  }

  /** Checks the served endpoint against the pin (OpenRouter's routing metadata); null when it holds. */
  private servedProblem(s: StreamState): string | null {
    if (this.endpoint === null) return null;
    if (s.metadata === undefined) {
      return "no openrouter_metadata on the final chunk (the served endpoint cannot be checked)";
    }
    const m = RouterMetadataSchema.safeParse(s.metadata);
    if (!m.success) return "an openrouter_metadata that does not match its schema";
    const selected = m.data.endpoints.available.filter((e) => e.selected);
    if (selected.length !== 1)
      return `${selected.length} selected endpoints in the routing metadata`;
    const e = selected[0];
    if (e === undefined) return "no selected endpoint";
    const name = this.endpoint.providerName;
    if (this.billedModel(e.model) !== this.spec.model) return `the model ${e.model}`;
    if (name !== null && e.provider.toLowerCase() !== name.toLowerCase()) {
      return `the provider ${e.provider}`;
    }
    return null;
  }

  private resultOf(
    s: StreamState,
    spent: () => UsageEntry[],
    requestId: string | null,
    latencyMs: number,
    ttftMs: number | null,
  ): ChatResult {
    const id = requestId ?? s.id;
    if (s.usage === undefined) {
      throw new ModelError("unknown", `${this.who}: the stream ended without its usage`, {
        spent: spent(),
        requestId: id,
      });
    }
    const parsed = UsageSchema.safeParse(s.usage);
    if (!parsed.success) {
      throw new ModelError("unknown", `${this.who}: a usage that does not match its schema`, {
        spent: [boundEntry(this.spec.model)],
        requestId: id,
      });
    }
    const entry = this.entryOf(s, parsed.data);
    if (!Number.isFinite(entry.tokens.input)) {
      throw new ModelError("unknown", `${this.who}: a usage the cards cannot price`, {
        spent: [entry],
        requestId: id,
      });
    }
    const usage = [entry];
    const problem = this.servedProblem(s);
    if (problem !== null) {
      // Charged, and refused: routing never changes the model or its endpoint silently.
      throw new ModelError(
        "bad_request",
        oneLine(
          `openrouter served ${problem} instead of the pin ${this.spec.model}@${this.endpoint?.tag ?? ""}${this.endpoint?.providerName === null || this.endpoint === null ? "" : ` (${this.endpoint.providerName})`}: the reply is refused`,
        ),
        { spent: usage, requestId: id },
      );
    }
    const reportedCostNanoUsd =
      parsed.data.cost === null || parsed.data.cost === undefined
        ? null
        : creditsToNano(parsed.data.cost);
    const calls = callsOf(s);
    const finish = s.finish;
    const raw = {
      id: s.id,
      model: s.model,
      provider: s.provider,
      finish_reason: finish,
      native_finish_reason: s.nativeFinish,
      usage: s.usage,
      openrouter_metadata: s.metadata ?? null,
    };
    const common = {
      rawStop: s.nativeFinish ?? finish ?? "null",
      servedBy: s.model ?? this.spec.model,
      fallback: false,
      usage,
      requestId: id,
      latencyMs,
      ttftMs,
      endpoint: this.endpoint?.tag ?? null,
      reportedCostNanoUsd,
    };
    if (finish === "content_filter" || s.refusal !== "") {
      // A model's own refusal, billed as generated (its usage is the final chunk's).
      const refused = this.refusalResult(
        s,
        usage,
        id,
        latencyMs,
        ttftMs,
        finish === "content_filter" ? "content_filter" : "refusal",
        s.refusal === "" ? null : oneLine(s.refusal),
      );
      return { ...refused, endpoint: common.endpoint, reportedCostNanoUsd, raw };
    }
    const native: CompatAssistant = {
      role: "assistant",
      content: s.content === "" && calls.length > 0 ? null : s.content,
      ...(calls.length === 0 ? {} : { tool_calls: calls }),
      // OpenRouter wants the reasoning back as it came (reasoning-tokens.md, preserving reasoning);
      // a compat endpoint gets none (DeepSeek-style APIs refuse their reasoning in the input).
      ...(this.mode === "openrouter" && s.details.length > 0
        ? { reasoning_details: s.details }
        : {}),
      ...(this.mode === "openrouter" && s.details.length === 0 && s.reasoning !== ""
        ? { reasoning: s.reasoning }
        : {}),
    };
    const { texts, kind } = reasoningOf(s);
    const modelCalls: ModelCall[] = calls.map((c) => ({
      callId: c.id,
      name: c.function.name,
      args: argsOf(c.function.arguments),
    }));
    const reply: ModelReply = {
      native,
      text: s.content === "" ? [] : [s.content],
      calls: modelCalls,
      reasoning: texts,
      reasoningKind: kind,
    };
    return { ...common, reply, stop: stopOf(finish, calls.length), refusal: null, raw };
  }

  /** The endpoint is listed for the model (`/models/{id}/endpoints`, public, free). */
  private async checkListed(): Promise<void> {
    const tag = this.endpoint?.tag;
    if (tag === undefined) return;
    const path = this.spec.model.split("/").map(encodeURIComponent).join("/");
    let res: Response;
    try {
      res = await fetchWithTimeout(
        this.fetch,
        `${this.base}/models/${path}/endpoints`,
        { method: "GET", headers: { accept: "application/json" } },
        { time: this.time, timeoutMs: this.timeoutMs },
      );
    } catch (e) {
      throw this.redacted(transportError(e, undefined, this.secrets));
    }
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!res.ok) {
      const c = classifyCompatError(this.mode, res.status, res.headers, body, "plan");
      throw httpModelError(this.who, res.status, c, { secrets: this.secrets });
    }
    const parsed = EndpointsResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ModelError(
        "unknown",
        `${this.who}: the endpoints of ${this.spec.model} do not match their schema`,
      );
    }
    if (!parsed.data.data.endpoints.some((e) => e.tag === tag)) {
      throw new ModelError(
        "not_found",
        `openrouter lists no endpoint ${tag} for ${this.spec.model} (its /endpoints)`,
      );
    }
  }

  /**
   * The key, the model and the exact request shape (design §2.5): on OpenRouter the pinned endpoint
   * is listed (free), then the production request at `max_tokens` 16, charged, which also checks
   * the served endpoint. An unknown usage is charged at most the shape check's own bound.
   */
  async preflight(sample: ChatRequest): Promise<PreflightReport> {
    await this.checkListed();
    const req: ChatRequest = { ...sample, maxOutputTokens: PREFLIGHT_MAX_TOKENS };
    const upper = promptBytesUpper(req);
    const res = await this.send(req, this.build(req), () => upper).catch((e: unknown) => {
      // The shape check's spend is priced by the arena (never NaN: its bound is finite).
      if (e instanceof ModelError && e.spent.some((u) => !Number.isFinite(u.tokens.input))) {
        throw new ModelError(e.kind, e.message, {
          status: e.status,
          requestId: e.requestId,
          retryAfterMs: e.retryAfterMs,
          retryable: e.retryable,
          spent: [
            {
              model: this.spec.model,
              kind: "message",
              tokens: {
                input: upper,
                cacheWrite5m: 0,
                cacheWrite1h: 0,
                cacheRead: 0,
                output: completionUpper(this.mode, PREFLIGHT_MAX_TOKENS),
              },
              estimated: true,
            },
          ],
        });
      }
      throw e;
    });
    return { model: this.spec.model, allowedFallbackModels: [], usage: res.usage };
  }

  /** A `ModelError` with the key redacted from its message (and a request id when it had none). */
  private redacted(e: ModelError, requestId: string | null = null): ModelError {
    const message = oneLine(redact(e.message, this.secrets));
    if (message === e.message && (requestId === null || e.requestId !== null)) return e;
    return new ModelError(e.kind, message, {
      status: e.status,
      requestId: e.requestId ?? requestId,
      retryAfterMs: e.retryAfterMs,
      spent: e.spent,
      retryable: e.retryable,
    });
  }
}

/** A finish reason as the harness's stop (overview.md: tool_calls, stop, length, content_filter, error). */
export function stopOf(finish: string | null, calls: number): StopReason {
  if (finish === "tool_calls") return calls > 0 ? "tool_use" : "other";
  if (finish === "stop") return calls > 0 ? "tool_use" : "end_turn";
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  // A missing, `error` or unknown finish reason: the turn closes.
  return "other";
}
