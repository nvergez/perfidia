import { afterEach, describe, expect, test } from "bun:test";
import {
  ModelError,
  type ChatRequest,
  type Entry,
  type ModelErrorKind,
  type ModelReply,
  type ModelSpec,
} from "./adapter.ts";
import {
  ABORTED_OUTPUT_FLOOR,
  AnthropicAdapter,
  AnthropicClient,
  FALLBACK_BETA,
  MODELS_FALLBACK_BETA,
  echoContent,
  modelErrorOf,
  type HttpFetch,
} from "./anthropic.ts";
import { anthropicTools } from "./tools.ts";

// The Anthropic adapter through the real SDK (0.131.0) and a `fetch` stub that answers with recorded
// JSON and SSE bodies (phase-2 design §7, item 1). Nothing here touches the network.

const BASE = "https://api.test.invalid";
const KEY = "sk-test-perfidia";

const OPUS: ModelSpec = {
  provider: "anthropic",
  model: "claude-opus-5-5",
  effort: "medium",
  maxOutputTokens: 16_000,
  cacheTtl: "5m",
};
const HAIKU: ModelSpec = { ...OPUS, model: "claude-haiku-5-5", effort: "low" };

const TOOLS = anthropicTools([
  {
    name: "view_map",
    description: "The map.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "end_turn",
    description: "Ends the turn.",
    inputSchema: {
      type: "object",
      properties: { nextWakeIn: { type: "integer", exclusiveMinimum: 0 } },
      additionalProperties: false,
    },
  },
]);
const PROMPT = { shared: "SHARED BLOCK", seat: "SEAT BLOCK p1" };

const reply = (native: unknown[], calls: ModelReply["calls"] = []): ModelReply => ({
  native,
  text: [],
  calls,
  reasoning: [],
});

const BRIEFING: Entry = { role: "user", parts: [{ kind: "text", text: '{"t":0}' }] };
const HEADER: Entry = { role: "operator", text: "Turn 1 · round trip 1 of 8." };

function request(entries: readonly Entry[], extra: Partial<ChatRequest> = {}): ChatRequest {
  return {
    prompt: PROMPT,
    tools: TOOLS,
    entries,
    meta: { seat: "p1", turn: 1, round: 0, maxRounds: 8, maxCalls: 10, kind: "round" },
    ...extra,
  };
}

// Recorded responses -------------------------------------------------------------------------------

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
  iterations?: unknown[] | null;
}

interface Final {
  model?: string;
  content: Record<string, unknown>[];
  stop_reason: string;
  stop_details?: unknown;
  usage: Usage;
}

type Ev = { readonly type: string } & Record<string, unknown>;

const sseOf = (events: readonly Ev[]): string =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** A JSON value as a plain record (the stub's request bodies). */
function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("not a JSON object");
  }
  return Object.fromEntries(Object.entries(value));
}

/** The `type` of each block of a native content array. */
const typesOf = (native: unknown): unknown[] =>
  Array.isArray(native)
    ? native.map((b: unknown): unknown => {
        if (b === null || typeof b !== "object") return null;
        const type: unknown = Reflect.get(b, "type");
        return type;
      })
    : [];

/** The SSE events of a whole message, block by block with deltas, as the API streams it. */
function eventsOf(f: Final): Ev[] {
  const model = f.model ?? "claude-opus-5-5";
  const u = f.usage;
  const out: Ev[] = [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: u.input_tokens,
          output_tokens: 1,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          cache_creation: u.cache_creation ?? null,
        },
      },
    },
  ];
  for (const [index, b] of f.content.entries()) {
    if (b["type"] === "text") {
      out.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      out.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: b["text"] },
      });
    } else if (b["type"] === "thinking") {
      out.push({
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      out.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: b["thinking"] },
      });
      out.push({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: b["signature"] },
      });
    } else if (b["type"] === "tool_use") {
      out.push({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: b["id"], name: b["name"], input: {} },
      });
      out.push({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(b["input"]) },
      });
    } else {
      out.push({ type: "content_block_start", index, content_block: b });
    }
    out.push({ type: "content_block_stop", index });
  }
  out.push({
    type: "message_delta",
    delta: {
      stop_reason: f.stop_reason,
      stop_sequence: null,
      stop_details: f.stop_details ?? null,
    },
    usage: {
      output_tokens: u.output_tokens,
      ...(u.iterations ? { iterations: u.iterations } : {}),
    },
  });
  out.push({ type: "message_stop" });
  return out;
}

const streamResponse = (f: Final): Response =>
  new Response(sseOf(eventsOf(f)), {
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_stream_1" },
  });

const errorResponse = (status: number, type: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: "error", error: { type, message: `${type} happened` } }), {
    status,
    headers: { "content-type": "application/json", "request-id": `req_${status}`, ...headers },
  });

const USAGE: Usage = {
  input_tokens: 120,
  output_tokens: 300,
  cache_creation_input_tokens: 2000,
  cache_read_input_tokens: 9000,
  cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 },
};

// The stub -----------------------------------------------------------------------------------------

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | null;
}

type Answer = Response | Error | ((init: RequestInit | undefined) => Promise<Response>);

function stub(answers: Answer[]): { fetch: HttpFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: HttpFetch = (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const raw = typeof init?.body === "string" ? init.body : null;
    seen.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      headers,
      body: raw === null ? null : recordOf(JSON.parse(raw)),
    });
    const a = answers.shift();
    if (a === undefined) return Promise.reject(new Error("stub: no answer left"));
    if (a instanceof Error) return Promise.reject(a);
    if (typeof a === "function") return a(init);
    return Promise.resolve(a);
  };
  return { fetch, seen };
}

function adapter(answers: Answer[], spec: ModelSpec = OPUS, timeoutMs?: number) {
  const s = stub(answers);
  const client = new AnthropicClient({
    apiKey: KEY,
    baseURL: BASE,
    fetch: s.fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  let now = 1000;
  return { a: new AnthropicAdapter(spec, client, { nowMs: () => (now += 7) }), seen: s.seen };
}

async function errorOf(p: Promise<unknown>): Promise<ModelError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ModelError) return e;
    throw e;
  }
  throw new Error("expected a ModelError");
}

const textReply: Final = {
  content: [{ type: "text", text: "Holding the line." }],
  stop_reason: "end_turn",
  usage: USAGE,
};

/** A fetch that never answers until its signal aborts (the SDK's own attempt timeout). */
const hang = (init: RequestInit | undefined): Promise<Response> =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(new DOMException("aborted", "AbortError")),
    );
  });

// Tests --------------------------------------------------------------------------------------------

describe("AnthropicAdapter requests", () => {
  test("Opus 5.5: the exact body, streamed, with the fallback beta and fallbacks: default", async () => {
    const { a, seen } = adapter([streamResponse(textReply)]);
    await a.chat(request([BRIEFING, HEADER]));
    expect(seen).toHaveLength(1);
    const s = seen[0];
    expect(s?.url).toBe(`${BASE}/v1/messages?beta=true`);
    expect(s?.method).toBe("POST");
    expect(s?.headers["anthropic-beta"]).toBe(FALLBACK_BETA);
    expect(s?.headers["x-api-key"]).toBe(KEY);
    expect(s?.headers["authorization"]).toBeUndefined();
    expect(s?.body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 16_000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
      system: [
        { type: "text", text: "SHARED BLOCK", cache_control: { type: "ephemeral" } },
        { type: "text", text: "SEAT BLOCK p1", cache_control: { type: "ephemeral" } },
      ],
      cache_control: { type: "ephemeral" },
      messages: [
        { role: "user", content: [{ type: "text", text: '{"t":0}' }] },
        { role: "system", content: "Turn 1 · round trip 1 of 8." },
      ],
      fallbacks: "default",
      stream: true,
    });
    const body = JSON.stringify(s?.body);
    for (const absent of [
      "tool_choice",
      "strict",
      "temperature",
      "top_p",
      "top_k",
      "budget_tokens",
    ]) {
      expect(body).not.toContain(absent);
    }
  });

  test("Haiku 5.5 gets neither the beta nor fallbacks; the effort and max_tokens follow the spec and request", async () => {
    const { a, seen } = adapter(
      [streamResponse({ ...textReply, model: "claude-haiku-5-5" })],
      HAIKU,
    );
    await a.chat(request([BRIEFING, HEADER], { maxOutputTokens: 32_000 }));
    const body = seen[0]?.body ?? {};
    expect(body["fallbacks"]).toBeUndefined();
    expect(seen[0]?.headers["anthropic-beta"]).toBeUndefined();
    expect(body["output_config"]).toEqual({ effort: "low" });
    expect(body["max_tokens"]).toBe(32_000);
  });

  test("1-hour TTL on the two system blocks; at most 4 breakpoints, TTLs non-increasing in prefix order", () => {
    const { a } = adapter([], { ...OPUS, cacheTtl: "1h" });
    const body = a.build(request([BRIEFING, HEADER]));
    const markers: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (k === "cache_control") {
            const ttl: unknown = x !== null && typeof x === "object" ? Reflect.get(x, "ttl") : null;
            markers.push(typeof ttl === "string" ? ttl : "5m");
          } else walk(x);
        }
      }
    };
    walk([body.tools, body.system, body.messages]);
    markers.push(body.cache_control?.ttl ?? "5m");
    expect(markers).toEqual(["1h", "1h", "5m"]);
    expect(markers.length).toBeLessThanOrEqual(4);
  });

  test("tool results first, in call order, with is_error; operator entries are system messages; replies echoed verbatim", () => {
    const { a } = adapter([]);
    const native = [
      { type: "thinking", thinking: "plan", signature: "sig-1" },
      { type: "text", text: "Scouting." },
      { type: "tool_use", id: "toolu_1", name: "view_map", input: {} },
      { type: "tool_use", id: "toolu_2", name: "end_turn", input: { nextWakeIn: 0 } },
    ];
    const entries: Entry[] = [
      BRIEFING,
      HEADER,
      { role: "assistant", reply: reply(native) },
      {
        role: "user",
        parts: [
          { kind: "result", callId: "toolu_1", content: '{"ok":true}', isError: false },
          { kind: "result", callId: "toolu_2", content: '{"ok":false}', isError: true },
        ],
      },
      { role: "operator", text: "Round trip 2 of 8, up to 10 calls." },
    ];
    const body = a.build(request(entries));
    const messages: unknown = body.messages;
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: '{"t":0}' }] },
      { role: "system", content: "Turn 1 · round trip 1 of 8." },
      { role: "assistant", content: native },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":true}' },
          { type: "tool_result", tool_use_id: "toolu_2", content: '{"ok":false}', is_error: true },
        ],
      },
      { role: "system", content: "Round trip 2 of 8, up to 10 calls." },
    ]);
    // The echo is the very object array, untouched.
    const echoed: unknown = body.messages[2]?.content;
    expect(echoed).toBe(native);
  });

  test("placement rules: operator after a user entry, never a prefill, never first", () => {
    const { a } = adapter([]);
    const op: Entry = { role: "operator", text: "x" };
    const asst: Entry = { role: "assistant", reply: reply([{ type: "text", text: "a" }]) };
    expect(() => a.build(request([op]))).toThrow("starts with a user entry");
    expect(() => a.build(request([BRIEFING, asst]))).toThrow("no prefill");
    expect(() => a.build(request([BRIEFING, asst, op]))).toThrow("must follow a user entry");
    expect(() => a.build(request([BRIEFING, op, op]))).toThrow();
    expect(() => a.build(request([BRIEFING, op, BRIEFING]))).toThrow("must be last or followed");
  });

  test("the tools array is the same bytes on every request", () => {
    const { a } = adapter([]);
    const one = JSON.stringify(a.build(request([BRIEFING, HEADER])).tools);
    const two = JSON.stringify(a.build(request([BRIEFING])).tools);
    expect(two).toBe(one);
  });
});

describe("AnthropicAdapter responses", () => {
  test("text, tool calls and reasoning are parsed; usage split by TTL; request id and timings", async () => {
    const { a } = adapter([
      streamResponse({
        content: [
          { type: "thinking", thinking: "They are weak.", signature: "sig" },
          { type: "text", text: "Attack at dawn." },
          { type: "tool_use", id: "toolu_a", name: "view_map", input: {} },
          { type: "tool_use", id: "toolu_b", name: "end_turn", input: { nextWakeIn: 3600 } },
        ],
        stop_reason: "tool_use",
        usage: USAGE,
      }),
    ]);
    const r = await a.chat(request([BRIEFING, HEADER]));
    expect(r.stop).toBe("tool_use");
    expect(r.reply.text).toEqual(["Attack at dawn."]);
    expect(r.reply.reasoning).toEqual(["They are weak."]);
    expect(r.reply.calls).toEqual([
      { callId: "toolu_a", name: "view_map", args: {} },
      { callId: "toolu_b", name: "end_turn", args: { nextWakeIn: 3600 } },
    ]);
    // The native content is plain JSON, echoable as is.
    expect(JSON.parse(JSON.stringify(r.reply.native))).toEqual(r.reply.native);
    expect(typesOf(r.reply.native)).toEqual(["thinking", "text", "tool_use", "tool_use"]);
    expect(r.usage).toEqual([
      {
        model: "claude-opus-5-5",
        kind: "message",
        tokens: { input: 120, cacheWrite5m: 2000, cacheWrite1h: 0, cacheRead: 9000, output: 300 },
        estimated: false,
      },
    ]);
    expect(r.requestId).toBe("req_stream_1");
    expect(r.servedBy).toBe("claude-opus-5-5");
    expect(r.fallback).toBe(false);
    expect(r.latencyMs).toBeGreaterThan(0);
    expect(r.ttftMs).not.toBeNull();
  });

  test("a refusal is checked before the content: no calls, stop_details kept (null category allowed)", async () => {
    const { a } = adapter([
      streamResponse({
        content: [{ type: "tool_use", id: "toolu_x", name: "view_map", input: {} }],
        stop_reason: "refusal",
        stop_details: {
          type: "refusal",
          category: null,
          explanation: null,
          recommended_model: "claude-opus-5",
        },
        usage: USAGE,
      }),
    ]);
    const r = await a.chat(request([BRIEFING, HEADER]));
    expect(r.stop).toBe("refusal");
    expect(r.reply.calls).toEqual([]);
    expect(r.reply.native).toEqual([]);
    expect(r.refusal).toEqual({
      category: null,
      explanation: null,
      recommendedModel: "claude-opus-5",
    });
  });

  test("a fallback block in a streamed response: the echo rule, served-by, fallback pricing by iteration", async () => {
    const { a } = adapter([
      streamResponse({
        content: [
          { type: "thinking", thinking: "declined plan", signature: "s1" },
          { type: "text", text: "Partial " },
          { type: "tool_use", id: "toolu_old", name: "view_map", input: {} },
          {
            type: "fallback",
            from: { model: "claude-opus-5-5" },
            to: { model: "claude-opus-5" },
            trigger: { type: "refusal", category: "cyber" },
          },
          { type: "thinking", thinking: "new plan", signature: "s2" },
          { type: "tool_use", id: "toolu_new", name: "end_turn", input: {} },
        ],
        stop_reason: "tool_use",
        usage: {
          ...USAGE,
          iterations: [
            {
              type: "message",
              model: null,
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation: null,
            },
            {
              type: "fallback_message",
              model: "claude-opus-5",
              input_tokens: 100,
              output_tokens: 80,
              cache_creation_input_tokens: 10,
              cache_read_input_tokens: 0,
              cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 },
            },
          ],
        },
      }),
    ]);
    const r = await a.chat(request([BRIEFING, HEADER]));
    expect(r.fallback).toBe(true);
    expect(r.servedBy).toBe("claude-opus-5");
    expect(typesOf(r.reply.native)).toEqual(["text", "fallback", "thinking", "tool_use"]);
    expect(r.reply.calls.map((c) => c.callId)).toEqual(["toolu_new"]);
    expect(r.usage.map((u) => [u.model, u.kind, u.tokens.output])).toEqual([
      ["claude-opus-5-5", "message", 50],
      ["claude-opus-5", "fallback", 80],
    ]);
  });

  test("a sticky turn has no fallback block but a fallback_message iteration", async () => {
    const { a } = adapter([
      streamResponse({
        model: "claude-opus-5",
        content: [{ type: "text", text: "Still here." }],
        stop_reason: "end_turn",
        usage: {
          ...USAGE,
          iterations: [
            {
              type: "fallback_message",
              model: "claude-opus-5",
              input_tokens: 5,
              output_tokens: 6,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation: null,
            },
          ],
        },
      }),
    ]);
    const r = await a.chat(request([BRIEFING, HEADER]));
    expect(r.fallback).toBe(true);
    expect(r.usage).toEqual([
      {
        model: "claude-opus-5",
        kind: "fallback",
        tokens: { input: 5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 6 },
        estimated: false,
      },
    ]);
  });

  test("stop mapping: pause_turn, max_tokens, stop_sequence and unknown stops", async () => {
    const stops: [string, string][] = [
      ["pause_turn", "pause"],
      ["max_tokens", "max_tokens"],
      ["stop_sequence", "end_turn"],
      ["model_context_window_exceeded", "other"],
    ];
    const { a } = adapter(stops.map(([s]) => streamResponse({ ...textReply, stop_reason: s })));
    for (const [raw, mapped] of stops) {
      // oxlint-disable-next-line no-await-in-loop -- one stub answer per request, in order
      const r = await a.chat(request([BRIEFING, HEADER]));
      expect([r.rawStop, r.stop]).toEqual([raw, mapped]);
    }
  });

  test("echoContent keeps everything when there is no fallback block", () => {
    const content = [{ type: "thinking" }, { type: "tool_use" }];
    expect(echoContent(content)).toEqual(content);
  });
});

describe("AnthropicAdapter errors", () => {
  const cases: [number, string, ModelErrorKind, boolean][] = [
    [400, "invalid_request_error", "bad_request", false],
    [401, "authentication_error", "auth", false],
    [402, "billing_error", "billing", false],
    [403, "permission_error", "auth", false],
    [404, "not_found_error", "not_found", false],
    [413, "request_too_large", "too_large", false],
    [422, "invalid_request_error", "bad_request", false],
    [429, "rate_limit_error", "rate_limit", true],
    [500, "api_error", "server", true],
    [529, "overloaded_error", "overloaded", true],
  ];
  for (const [status, type, kind, retryable] of cases) {
    test(`${status} ${type} → ${kind}`, async () => {
      const { a, seen } = adapter([errorResponse(status, type, { "retry-after": "7" })]);
      const e = await errorOf(a.chat(request([BRIEFING, HEADER])));
      expect([e.kind, e.retryable, e.status]).toEqual([kind, retryable, status]);
      expect(e.requestId).toBe(`req_${status}`);
      expect(e.retryAfterMs).toBe(7000);
      expect(e.spent).toEqual([]);
      expect(e.message).not.toContain(KEY);
      expect(e.message).not.toContain("\n");
      // maxRetries: 0 — the harness owns every retry: exactly one request.
      expect(seen).toHaveLength(1);
    });
  }

  test("a connection failure is retryable", async () => {
    const { a } = adapter([new TypeError("socket hang up")]);
    const e = await errorOf(a.chat(request([BRIEFING, HEADER])));
    expect([e.kind, e.retryable]).toEqual(["connection", true]);
  });

  test("the SDK's attempt timeout is a retryable timeout", async () => {
    const { a } = adapter([hang], OPUS, 20);
    const e = await errorOf(a.chat(request([BRIEFING, HEADER])));
    expect([e.kind, e.retryable]).toEqual(["timeout", true]);
  });

  test("our abort mid-stream: aborted, charged message_start usage plus an output estimate", async () => {
    const ctl = new AbortController();
    const start = eventsOf({
      content: [{ type: "text", text: "x".repeat(40) }],
      stop_reason: "end_turn",
      usage: USAGE,
    }).slice(0, 3);
    const partial = (init: RequestInit | undefined): Promise<Response> => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(sseOf(start)));
          init?.signal?.addEventListener("abort", () =>
            c.error(new DOMException("aborted", "AbortError")),
          );
          setTimeout(() => ctl.abort(new Error("round deadline")), 5);
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    };
    const { a } = adapter([partial]);
    const e = await errorOf(a.chat(request([BRIEFING, HEADER], { signal: ctl.signal })));
    expect([e.kind, e.retryable]).toEqual(["aborted", false]);
    expect(e.spent).toEqual([
      {
        model: "claude-opus-5-5",
        kind: "message",
        tokens: {
          input: 120,
          cacheWrite5m: 2000,
          cacheWrite1h: 0,
          cacheRead: 9000,
          output: ABORTED_OUTPUT_FLOOR,
        },
        estimated: true,
      },
    ]);
  });

  test("an SSE error event mid-stream (overloaded) is retryable and charged as estimated", async () => {
    const start = eventsOf(textReply).slice(0, 3);
    const body =
      sseOf(start) +
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`;
    const { a } = adapter([
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ]);
    const e = await errorOf(a.chat(request([BRIEFING, HEADER])));
    expect([e.kind, e.retryable, e.status]).toEqual(["overloaded", true, null]);
    expect(e.spent[0]?.estimated).toBe(true);
    expect(e.spent[0]?.tokens.output).toBe(ABORTED_OUTPUT_FLOOR);
  });
});

describe("AnthropicClient isolation", () => {
  const JUNK: Record<string, string> = {
    ANTHROPIC_API_KEY: "sk-junk-env",
    ANTHROPIC_AUTH_TOKEN: "junk-token",
    ANTHROPIC_BASE_URL: "https://junk.example.invalid",
    ANTHROPIC_PROFILE: "junk-profile",
    ANTHROPIC_CONFIG_DIR: "/nonexistent/junk",
    ANTHROPIC_FEDERATION_RULE_ID: "junk-rule",
    ANTHROPIC_ORGANIZATION_ID: "junk-org",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "junk-sa",
    ANTHROPIC_IDENTITY_TOKEN: "junk-identity",
    ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer junk\nX-Junk: 1\nX-Api-Key: sk-junk-header",
    ANTHROPIC_LOG: "debug",
  };
  const saved = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
    saved.clear();
  });

  test("junk ANTHROPIC_* variables never reach a request: our host, our key, no authorization", async () => {
    for (const [k, v] of Object.entries(JUNK)) {
      saved.set(k, process.env[k]);
      process.env[k] = v;
    }
    const { a, seen } = adapter([streamResponse(textReply)]);
    await a.chat(request([BRIEFING, HEADER]));
    const s = seen[0];
    expect(s?.url.startsWith(`${BASE}/`)).toBe(true);
    expect(s?.headers["x-api-key"]).toBe(KEY);
    expect(s?.headers["authorization"]).toBeUndefined();
    expect(s?.headers["x-junk"]).toBeUndefined();
    for (const name of Object.keys(s?.headers ?? {})) {
      expect(name).toMatch(
        /^(accept|content-type|user-agent|anthropic-version|anthropic-beta|x-api-key|x-stainless-[a-z0-9-]+)$/,
      );
    }
  });

  test("a request to another origin is refused; an empty key is refused", async () => {
    const { fetch, seen } = stub([streamResponse(textReply)]);
    const client = new AnthropicClient({ apiKey: KEY, baseURL: BASE, fetch });
    const raw = await client.sdk.models
      .retrieve("x", {}, { path: "https://elsewhere.invalid/v1/models/x" })
      .then(
        () => null,
        (x: unknown) => x,
      );
    const e = modelErrorOf(raw, []);
    expect(e.kind).toBe("connection");
    expect(e.message).toContain("refusing a request to https://elsewhere.invalid");
    expect(seen).toHaveLength(0);
    expect(() => new AnthropicClient({ apiKey: " ", baseURL: BASE })).toThrow("API key is empty");
  });
});

describe("AnthropicAdapter preflight", () => {
  test("models.retrieve with the fallback-visibility beta, then the exact shape at max_tokens 0, not streamed", async () => {
    const info = new Response(
      JSON.stringify({
        id: "claude-opus-5-5",
        type: "model",
        display_name: "Claude Opus 5.5",
        created_at: "2026-01-01T00:00:00Z",
        allowed_fallback_models: ["claude-opus-5", "claude-opus-4-8"],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const warm = new Response(
      JSON.stringify({
        id: "msg_w",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: "max_tokens",
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 3, output_tokens: 0, cache_creation_input_tokens: 9000 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const { a, seen } = adapter([info, warm]);
    const report = await a.preflight(
      request([{ role: "user", parts: [{ kind: "text", text: "warmup" }] }]),
    );
    expect(report.allowedFallbackModels).toEqual(["claude-opus-5", "claude-opus-4-8"]);
    expect(report.usage[0]?.tokens.cacheWrite5m).toBe(9000);
    expect(seen[0]?.url).toBe(`${BASE}/v1/models/claude-opus-5-5?beta=true`);
    expect(seen[0]?.headers["anthropic-beta"]).toBe(MODELS_FALLBACK_BETA);
    const body = seen[1]?.body ?? {};
    expect(body["max_tokens"]).toBe(0);
    expect(body["stream"]).toBe(false);
    expect(body["cache_control"]).toBeUndefined();
    expect(body["fallbacks"]).toBe("default");
    expect(body["thinking"]).toEqual({ type: "adaptive", display: "summarized" });
    expect(seen[1]?.headers["anthropic-beta"]).toBe(FALLBACK_BETA);
    expect(JSON.stringify(body["system"])).toContain("cache_control");
  });

  test("a preflight failure is a ModelError (401)", async () => {
    const { a } = adapter([errorResponse(401, "authentication_error")]);
    const e = await errorOf(a.preflight(request([BRIEFING])));
    expect(e.kind).toBe("auth");
  });
});
