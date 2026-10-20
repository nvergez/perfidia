import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "@perfidia/engine/core";
import { BudgetLedger } from "../budget/ledger.ts";
import { arenaEnv } from "../arena/plan.ts";
import { seatAttemptBound } from "../arena/estimate.ts";
import { PREFLIGHT_OUTPUT_TOKENS } from "../arena/preflight.ts";
import { MemoryCallLog } from "../log/calls.ts";
import { LOCKSTEP_POLICY, LlmSeatAgent, promptEstimate } from "../seat/agent.ts";
import { NoPauseGate } from "../seat/pause.ts";
import { PROFILES } from "../seat/personalities.ts";
import { turnHeader } from "../seat/prompt.ts";
import { briefingOf, inputOf, rejection, virtualTime } from "../testkit.test.ts";
import {
  ModelError,
  type ChatRequest,
  type Entry,
  type ModelSpec,
  type ModelTool,
} from "./adapter.ts";
import { seededRandom } from "./clock.ts";
import type { HttpFetch } from "./http.ts";
import {
  OPENAI_PREFLIGHT_OUTPUT_TOKENS,
  OpenAIAdapter,
  OpenAIClient,
  boundUsage,
  estimatedUsage,
  promptBytesUpper,
  readUsage,
} from "./openai.ts";
import { costOf, pricerFor } from "./prices.ts";
import { RateGate } from "./rate.ts";
import { modelTools } from "./tools.ts";
import { ResponsesRequestSchema } from "./wire/openai.ts";

// The OpenAI adapter's contract (phase-4 design §8.1): the real adapter against a stub `fetch` that
// answers with the synthetic fixtures of `fixtures/openai/` (written from the docs, `synthetic:
// true`, sources and check date inside). Nothing here touches the network.

const FIXTURES = join(import.meta.dir, "fixtures", "openai");
const fixture = (name: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not a fixture");
  return Object.fromEntries(Object.entries(v));
};
const TOOL_CALLS = fixture("stream-tool-calls.json");
const TERMINALS = fixture("stream-terminals.json");
const HTTP_ERRORS = fixture("http-errors.json");

const terminal = (name: string): Record<string, unknown> => {
  const cases: unknown = TERMINALS["cases"];
  const c: unknown =
    cases !== null && typeof cases === "object" ? Reflect.get(cases, name) : undefined;
  if (c === null || typeof c !== "object") throw new Error(`no terminal case ${name}`);
  return Object.fromEntries(Object.entries(c));
};

const BASE = "https://api.openai.test/v1";
const KEY = "sk-proj-test-perfidia-openai-key";
const MAX = 32_768;

const SOL: ModelSpec = {
  provider: "openai",
  model: "gpt-6.1-sol",
  effort: "medium",
  maxOutputTokens: MAX,
  cacheTtl: "5m",
  fallbacks: "off",
  reasoningContext: "all_turns",
};
const LUNA: ModelSpec = {
  provider: "openai",
  model: "gpt-6-luna",
  effort: "low",
  maxOutputTokens: MAX,
  cacheTtl: "5m",
  fallbacks: "off",
};
const lunaSpec = (): ModelSpec => LUNA;

const TOOLS: readonly ModelTool[] = modelTools([
  {
    name: "view_city",
    description: "One of your cities.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string", pattern: "^c[0-9]+$" } },
      required: ["city"],
      additionalProperties: false,
    },
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
const PROMPT = { shared: "SHARED BLOCK (developer variant)", seat: "SEAT BLOCK p1" };
const BRIEFING: Entry = { role: "user", parts: [{ kind: "text", text: '{"t":0,"you":"p1"}' }] };
const HEADER: Entry = { role: "operator", text: "Turn 1 · D1 00:00 · round trip 1 of 8." };

function request(entries: readonly Entry[], extra: Partial<ChatRequest> = {}): ChatRequest {
  return {
    prompt: PROMPT,
    tools: TOOLS,
    entries,
    meta: { seat: "p1", turn: 1, round: 0, maxRounds: 8, maxCalls: 10, kind: "round" },
    ...extra,
  };
}

// The stub ------------------------------------------------------------------------------------------

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly redirect: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal: AbortSignal | null | undefined;
}

type Answer = (seen: Seen, n: number) => Response | Promise<Response>;

function stub(answer: Answer): { readonly fetch: HttpFetch; readonly seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: HttpFetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const text = typeof init?.body === "string" ? init.body : null;
    const s: Seen = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      headers,
      body: text === null ? null : (JSON.parse(text) as unknown),
      signal: init?.signal,
    };
    seen.push(s);
    return answer(s, seen.length);
  };
  return { fetch, seen };
}

const sse = (events: readonly unknown[]): string =>
  events
    .map((e) => {
      const type: unknown = e !== null && typeof e === "object" ? Reflect.get(e, "type") : "";
      return `event: ${String(type)}\ndata: ${JSON.stringify(e)}\n\n`;
    })
    .join("");

const CREATED = {
  type: "response.created",
  sequence_number: 0,
  response: { id: "resp_x", object: "response", status: "in_progress", model: "gpt-6-luna" },
};

const streamOf = (events: readonly unknown[], requestId = "req_test"): Response =>
  new Response(sse(events), {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-request-id": requestId },
  });

const eventsOf = (f: Record<string, unknown>): unknown[] => {
  const e = f["events"];
  return Array.isArray(e) ? e : [];
};

function adapterFor(
  spec: ModelSpec,
  answer: Answer,
  o: { readonly timeoutMs?: number } = {},
): { readonly adapter: OpenAIAdapter; readonly seen: Seen[] } {
  const s = stub(answer);
  const client = new OpenAIClient({
    apiKey: KEY,
    baseURL: BASE,
    time: virtualTime(),
    fetch: s.fetch,
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
  });
  return { adapter: new OpenAIAdapter(spec, client), seen: s.seen };
}

const recordOf = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {};

/** A usage of the Response schema's shape. */
const usageOf = (cached: number, written: number, reasoning: number, input = 100, output = 50) => ({
  input_tokens: input,
  input_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
  output_tokens: output,
  output_tokens_details: { reasoning_tokens: reasoning },
});

/** One call of GPT-6 Luna answered by a terminal case of the fixture (after `response.created`). */
const runCase = async (name: string) =>
  adapterFor(lunaSpec(), () => streamOf([CREATED, terminal(name)])).adapter.chat(
    request([BRIEFING, HEADER]),
  );

/** The stub of the preflight tests: the model, the token count, a check stopped at 16 tokens. */
const preflightAnswer: Answer = (s) => {
  if (s.url.endsWith("/models/gpt-6-luna")) {
    return Response.json({ id: "gpt-6-luna", object: "model", created: 0, owned_by: "openai" });
  }
  if (s.url.endsWith("/responses/input_tokens")) {
    return Response.json({ object: "response.input_tokens", input_tokens: 11_042 });
  }
  return streamOf([CREATED, terminal("incomplete_max_output_tokens")]);
};

// Requests --------------------------------------------------------------------------------------

describe("openai: the request", () => {
  test("the pinned body: store off, summaries, explicit strict false, developer blocks, the seat breakpoint", () => {
    const { adapter } = adapterFor(SOL, () => streamOf([]));
    const body = adapter.build(request([BRIEFING, HEADER]));
    expect(ResponsesRequestSchema.safeParse(body).success).toBe(true);
    expect(canonicalJson(body)).toBe(
      canonicalJson({
        model: "gpt-6.1-sol",
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
        service_tier: "default",
        truncation: "disabled",
        max_output_tokens: MAX,
        reasoning: { effort: "medium", summary: "auto", context: "all_turns" },
        tools: [
          {
            type: "function",
            name: "view_city",
            description: "One of your cities.",
            parameters: {
              type: "object",
              properties: { city: { type: "string", pattern: "^c[0-9]+$" } },
              required: ["city"],
              additionalProperties: false,
            },
            strict: false,
          },
          {
            type: "function",
            name: "end_turn",
            description: "Ends the turn.",
            parameters: {
              type: "object",
              properties: { nextWakeIn: { type: "integer", exclusiveMinimum: 0 } },
              additionalProperties: false,
            },
            strict: false,
          },
        ],
        tool_choice: "auto",
        parallel_tool_calls: true,
        prompt_cache_options: { mode: "implicit", ttl: "30m" },
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: PROMPT.shared }],
          },
          {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text: PROMPT.seat,
                prompt_cache_breakpoint: { mode: "explicit" },
              },
            ],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: '{"t":0,"you":"p1"}' }],
          },
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "Turn 1 · D1 00:00 · round trip 1 of 8." }],
          },
        ],
      }),
    );
    // Key order is part of the bytes: the top-level fields come in this order every request.
    expect(Object.keys(body)).toEqual([
      "model",
      "stream",
      "store",
      "include",
      "service_tier",
      "truncation",
      "max_output_tokens",
      "reasoning",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "prompt_cache_options",
      "input",
    ]);
  });

  test("reasoning.context is sent only where the catalog pins it (GPT-6.1 Sol)", () => {
    const luna = adapterFor(lunaSpec(), () => streamOf([])).adapter;
    expect(luna.build(request([BRIEFING])).reasoning).toEqual({ effort: "low", summary: "auto" });
    const sol = adapterFor(SOL, () => streamOf([])).adapter;
    expect(sol.build(request([BRIEFING])).reasoning.context).toBe("all_turns");
  });

  test("results become function_call_output items, replies are echoed verbatim, the retry raises the limit", () => {
    const { adapter } = adapterFor(SOL, () => streamOf([]));
    const native = [
      { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "enc" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "view_city", arguments: "{}" },
    ];
    const body = adapter.build(
      request(
        [
          BRIEFING,
          HEADER,
          {
            role: "assistant",
            reply: {
              native,
              text: [],
              calls: [{ callId: "call_1", name: "view_city", args: {} }],
              reasoning: [],
            },
          },
          {
            role: "user",
            parts: [{ kind: "result", callId: "call_1", content: '{"ok":true}', isError: false }],
          },
        ],
        { maxOutputTokens: 65_536 },
      ),
    );
    expect(body.max_output_tokens).toBe(65_536);
    expect(body.input.slice(4)).toEqual([
      ...native,
      { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
    ]);
    expect(ResponsesRequestSchema.safeParse(body).success).toBe(true);
  });

  test("a conversation must start with a user entry and must not end with a reply", () => {
    const { adapter } = adapterFor(SOL, () => streamOf([]));
    expect(() => adapter.build(request([HEADER]))).toThrow("starts with a user entry");
    const reply: Entry = {
      role: "assistant",
      reply: { native: [], text: [], calls: [], reasoning: [] },
    };
    expect(() => adapter.build(request([BRIEFING, reply]))).toThrow("no prefill");
    const anthropicNative: Entry = {
      role: "assistant",
      reply: { native: "not items", text: [], calls: [], reasoning: [] },
    };
    expect(() => adapter.build(request([BRIEFING, anthropicNative, BRIEFING]))).toThrow(
      "not OpenAI output items",
    );
  });

  test("an effort the model does not accept is refused with what it accepts", () => {
    expect(() => adapterFor({ ...SOL, effort: "none" }, () => streamOf([]))).toThrow(
      "gpt-6.1-sol accepts effort low, medium, high, xhigh, max; got none",
    );
    expect(() => adapterFor({ ...SOL, effort: "minimal" }, () => streamOf([]))).toThrow(
      "got minimal",
    );
    expect(() =>
      adapterFor({ ...lunaSpec(), model: "gpt-6-astra", effort: "none" }, () => streamOf([])),
    ).toThrow("gpt-6-astra accepts effort low, medium, high, xhigh, max; got none");
    // GPT-6 Luna takes none (its model page).
    expect(() => adapterFor({ ...lunaSpec(), effort: "none" }, () => streamOf([]))).not.toThrow();
  });
});

// Responses -------------------------------------------------------------------------------------

describe("openai: one call", () => {
  test("one fetch per attempt, to the origin only, key in the header, never in a URL, redirect error", async () => {
    const { adapter, seen } = adapterFor(SOL, () =>
      streamOf(eventsOf(TOOL_CALLS), "req_synthetic_tool_calls"),
    );
    const res = await adapter.chat(request([BRIEFING, HEADER]));
    expect(seen).toHaveLength(1);
    const s = seen[0];
    expect(s?.url).toBe(`${BASE}/responses`);
    expect(s?.method).toBe("POST");
    expect(s?.redirect).toBe("error");
    expect(s?.url.includes(KEY)).toBe(false);
    expect(s?.headers).toEqual({
      accept: "text/event-stream",
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    });
    expect(res.requestId).toBe("req_synthetic_tool_calls");
    expect(res.stop).toBe("tool_use");
    expect(res.rawStop).toBe("completed");
    expect(res.servedBy).toBe("gpt-6.1-sol");
    expect(res.ttftMs).not.toBeNull();
  });

  test("the reply: calls, text, reasoning summaries, and the output items as native (the echo)", async () => {
    const { adapter } = adapterFor(SOL, () => streamOf(eventsOf(TOOL_CALLS)));
    const res = await adapter.chat(request([BRIEFING, HEADER]));
    expect(res.reply.calls).toEqual([
      { callId: "call_synthetic_1", name: "view_city", args: { city: "c1" } },
      {
        callId: "call_synthetic_2",
        name: "write_note",
        args: { mode: "append", text: "c1 checked" },
      },
    ]);
    expect(res.reply.text).toEqual(["Looking at c1 first."]);
    expect(res.reply.reasoning).toEqual([
      "**Checking the home city**\n\nI look at c1 before deciding what to build.",
    ]);
    expect(res.reply.reasoningKind).toBe("summary");
    const completed = eventsOf(TOOL_CALLS).at(-1);
    const output = recordOf(recordOf(completed)["response"])["output"];
    // Verbatim: every field (encrypted content, phase, status) and the key order.
    expect(JSON.stringify(res.reply.native)).toBe(JSON.stringify(output));
  });

  test("usage: input = input_tokens − cached − written; writes in the short bucket; output with reasoning", async () => {
    const { adapter } = adapterFor(SOL, () => streamOf(eventsOf(TOOL_CALLS)));
    const res = await adapter.chat(request([BRIEFING, HEADER]));
    expect(res.usage).toEqual([
      {
        model: "gpt-6.1-sol",
        kind: "message",
        tokens: {
          input: 12_000 - 10_240 - 1_536,
          cacheWrite5m: 1_536,
          cacheWrite1h: 0,
          cacheRead: 10_240,
          output: 900,
          reasoning: 640,
        },
        estimated: false,
      },
    ]);
    // Priced at GPT-6.1 Sol's card: $2 input, $2.50 writes, $0.10 reads, $10 output per MTok.
    const cost = costOf(res.usage, {
      provider: "openai",
      endpoint: null,
      at: "2026-10-20T12:00:00Z",
    });
    const pico = 224 * 2_000_000 + 1_536 * 2_500_000 + 10_240 * 100_000 + 900 * 10_000_000;
    expect(cost.nanoUsd).toBe(Math.ceil(pico / 1000));
    expect(cost.cards).toEqual(["openai:gpt-6.1-sol@2026-10-20"]);
    expect(cost.unpriced).toEqual([]);
  });

  test("readUsage refuses a usage that contradicts itself or lacks the split", () => {
    expect(readUsage(null, "m").kind).toBe("absent");
    expect(readUsage({ input_tokens: 5, output_tokens: 1 }, "m").kind).toBe("invalid");
    expect(readUsage(usageOf(60, 40, 50), "m").kind).toBe("ok");
    expect(readUsage(usageOf(61, 40, 0), "m").kind).toBe("invalid");
    expect(readUsage(usageOf(0, 0, 51), "m").kind).toBe("invalid");
    expect(readUsage(usageOf(0, 0, 0, -1), "m").kind).toBe("invalid");
    expect(readUsage(usageOf(0, 0, 0, 1.5), "m").kind).toBe("invalid");
  });

  test("stops: end_turn, max_tokens, content filter, refusal part, malformed arguments", async () => {
    const text = await runCase("text");
    expect([text.stop, text.reply.text, text.reply.calls]).toEqual([
      "end_turn",
      ["I hold c1 and wait for p3's answer."],
      [],
    ]);
    expect(text.reply.reasoning).toEqual(["Nothing urgent: hold."]);

    const max = await runCase("incomplete_max_output_tokens");
    expect([max.stop, max.rawStop, max.reply.calls]).toEqual([
      "max_tokens",
      "incomplete:max_output_tokens",
      [],
    ]);
    expect(max.usage[0]?.tokens.output).toBe(32_768);
    expect(max.usage[0]?.estimated).toBe(false);

    const filtered = await runCase("incomplete_content_filter");
    expect([filtered.stop, filtered.refusal?.category]).toEqual(["refusal", "content_filter"]);
    expect(filtered.usage[0]?.tokens.output).toBe(40);

    const refused = await runCase("refusal");
    expect(refused.stop).toBe("refusal");
    expect(refused.refusal).toEqual({
      category: "refusal",
      explanation: "I can't help with that.",
      recommendedModel: null,
    });
    expect(refused.reply.native).toEqual([]);

    const malformed = await runCase("malformed_arguments");
    expect(malformed.stop).toBe("tool_use");
    // Not JSON: passed raw, so the gateway answers INVALID_ARGS.
    expect(malformed.reply.calls).toEqual([
      { callId: "call_malformed", name: "view_city", args: '{"city": "c1"' },
    ]);
  });

  test("failures: misalignment closes as a refusal; server errors retry; both charged when the stream started", async () => {
    const req = request([BRIEFING, HEADER], { promptTokensUpper: 20_000 });
    const charged = estimatedUsage("gpt-6-luna", 20_000, MAX);
    const blocked = await adapterFor(lunaSpec(), () =>
      streamOf([CREATED, terminal("failed_misalignment")]),
    ).adapter.chat(req);
    expect([blocked.stop, blocked.refusal?.category, blocked.rawStop]).toEqual([
      "refusal",
      "misalignment",
      "failed:misalignment_policy_violation",
    ]);
    expect(blocked.usage).toEqual([charged]);

    const server = await rejection(
      adapterFor(lunaSpec(), () =>
        streamOf([CREATED, terminal("failed_server_error")]),
      ).adapter.chat(req),
    );
    expect(server).toBeInstanceOf(ModelError);
    if (!(server instanceof ModelError)) return;
    expect([server.kind, server.retryable]).toEqual(["server", true]);
    expect(server.spent).toEqual([charged]);

    // A failed response that reports its usage is charged that usage.
    const limited = await rejection(
      adapterFor(lunaSpec(), () =>
        streamOf([CREATED, terminal("failed_rate_limit_with_usage")]),
      ).adapter.chat(req),
    );
    if (!(limited instanceof ModelError)) throw limited;
    expect(limited.kind).toBe("rate_limit");
    expect(limited.spent[0]?.estimated).toBe(false);
    expect(limited.spent[0]?.tokens.output).toBe(100);

    // An `error` event while streaming.
    const event = await rejection(
      adapterFor(lunaSpec(), () =>
        streamOf([CREATED, terminal("stream_error_event")]),
      ).adapter.chat(req),
    );
    if (!(event instanceof ModelError)) throw event;
    expect([event.kind, event.spent]).toEqual(["server", [charged]]);
    const eventBlock = await adapterFor(lunaSpec(), () =>
      streamOf([CREATED, terminal("stream_error_misalignment")]),
    ).adapter.chat(req);
    expect([eventBlock.stop, eventBlock.refusal?.category]).toEqual(["refusal", "misalignment"]);
  });
});

// Money safety ----------------------------------------------------------------------------------

describe("openai: what an attempt is charged", () => {
  const bound = seatAttemptBound("gpt-6-luna", "off", MAX, 160_000, {
    provider: "openai",
    endpoint: null,
    from: "2026-10-20T00:00:00Z",
  });

  /** A ledger that prices the seat at OpenAI's cards and knows its attempt bound. */
  const ledger = () =>
    new BudgetLedger({
      caps: new Map([["p1", 100_000_000_000]]),
      wakeCapNanoUsd: null,
      handoffTo: () => ({
        label: "bot:turtle@3",
        agent: { label: "x", round: async () => ({ calls: [] }) },
      }),
      pricers: new Map([
        [
          "p1",
          pricerFor({
            provider: "openai",
            endpoint: null,
            fixedAt: "2026-10-20T00:00:00Z",
            fallbackAt: "2026-10-20T00:00:00Z",
          }),
        ],
      ]),
      attemptBounds: new Map([["p1", bound]]),
    });

  for (const name of [
    "usage_without_details",
    "usage_contradictory",
    "usage_missing",
    "priority_tier",
    "not_a_response",
  ]) {
    test(`an unknown usage shape (${name}) fails unknown and is charged the attempt bound, never 0`, async () => {
      const e = await rejection(
        adapterFor(lunaSpec(), () => streamOf([CREATED, terminal(name)])).adapter.chat(
          request([BRIEFING, HEADER]),
        ),
      );
      if (!(e instanceof ModelError)) throw e;
      expect(e.kind).toBe("unknown");
      expect(e.retryable).toBe(false);
      expect(e.spent).toEqual([boundUsage("gpt-6-luna")]);
      const charge = ledger().charge("p1", 1, 0, e.spent, "2026-10-20T00:00:00Z");
      expect(charge.invalidUsage).toBe(true);
      expect(charge.costNanoUsd).toBe(bound);
      expect(charge.costNanoUsd).toBeGreaterThan(0);
    });
  }

  test("a stream that breaks after it was accepted is charged its prompt bound at the write price and the full max_output_tokens", async () => {
    const req = request([BRIEFING, HEADER], { promptTokensUpper: 40_000 });
    const cut = await rejection(
      adapterFor(lunaSpec(), () => streamOf([CREATED])).adapter.chat(req),
    );
    if (!(cut instanceof ModelError)) throw cut;
    expect([cut.kind, cut.retryable]).toEqual(["connection", true]);
    expect(cut.spent).toEqual([
      {
        model: "gpt-6-luna",
        kind: "message",
        tokens: { input: 0, cacheWrite5m: 40_000, cacheWrite1h: 0, cacheRead: 0, output: MAX },
        estimated: true,
      },
    ]);
    // Within the attempt bound (the prompt estimate is at most the cap).
    const charge = ledger().charge("p1", 1, 0, cut.spent, "2026-10-20T00:00:00Z");
    expect(charge.invalidUsage).toBe(false);
    expect(charge.costNanoUsd).toBeLessThanOrEqual(bound);
    expect(charge.costNanoUsd).toBe(Math.ceil((40_000 * 125_000 + MAX * 500_000) / 1000));

    // A body cut inside its terminal event is a broken stream too.
    const text = sse([CREATED, terminal("text")]);
    const inside = await rejection(
      adapterFor(
        lunaSpec(),
        () => new Response(text.slice(0, -40), { status: 200, headers: { "x-request-id": "r" } }),
      ).adapter.chat(req),
    );
    if (!(inside instanceof ModelError)) throw inside;
    expect([inside.kind, inside.spent[0]?.estimated]).toEqual(["connection", true]);

    // Without the seat's estimate, the prompt is bounded from the bytes.
    const bare = request([BRIEFING, HEADER]);
    const noEstimate = await rejection(
      adapterFor(lunaSpec(), () => streamOf([CREATED])).adapter.chat(bare),
    );
    if (!(noEstimate instanceof ModelError)) throw noEstimate;
    expect(noEstimate.spent[0]?.tokens.cacheWrite5m).toBe(promptBytesUpper(bare));
    expect(promptBytesUpper(bare)).toBeGreaterThan(JSON.stringify(PROMPT).length);
  });

  test("an attempt aborted mid-stream is charged the estimate; one aborted before any answer, nothing", async () => {
    const enc = new TextEncoder();
    const ctl = new AbortController();
    const hanging = adapterFor(lunaSpec(), (s) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(sse([CREATED])));
          s.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
        },
      });
      queueMicrotask(() => ctl.abort());
      return new Response(body, { status: 200 });
    });
    const mid = await rejection(
      hanging.adapter.chat(
        request([BRIEFING, HEADER], { signal: ctl.signal, promptTokensUpper: 1_000 }),
      ),
    );
    if (!(mid instanceof ModelError)) throw mid;
    expect(mid.kind).toBe("aborted");
    expect(mid.spent).toEqual([estimatedUsage("gpt-6-luna", 1_000, MAX)]);

    const ctl2 = new AbortController();
    const never = adapterFor(lunaSpec(), (s) => {
      queueMicrotask(() => ctl2.abort());
      return new Promise<Response>((_resolve, reject) => {
        s.signal?.addEventListener("abort", () => reject(new Error("aborted before headers")));
      });
    });
    const before = await rejection(
      never.adapter.chat(request([BRIEFING, HEADER], { signal: ctl2.signal })),
    );
    if (!(before instanceof ModelError)) throw before;
    expect([before.kind, before.spent]).toEqual(["aborted", []]);
  });

  test("the preflight's output equals the arena's check bound", () => {
    expect(OPENAI_PREFLIGHT_OUTPUT_TOKENS).toBe(PREFLIGHT_OUTPUT_TOKENS);
  });
});

// HTTP errors -----------------------------------------------------------------------------------

describe("openai: HTTP errors, by code before status", () => {
  const cases: unknown = HTTP_ERRORS["cases"];
  const list: Record<string, unknown>[] = Array.isArray(cases) ? cases.map(recordOf) : [];

  test("the fixture is synthetic, dated and sourced", () => {
    expect(HTTP_ERRORS["synthetic"]).toBe(true);
    expect(HTTP_ERRORS["checked"]).toBe("2026-10-20");
    expect(TOOL_CALLS["synthetic"]).toBe(true);
    expect(TERMINALS["synthetic"]).toBe(true);
    for (const f of [HTTP_ERRORS, TOOL_CALLS, TERMINALS]) {
      const sources = f["sources"];
      expect(Array.isArray(sources) && sources.length > 0).toBe(true);
    }
    expect(list.length).toBeGreaterThanOrEqual(15);
  });

  for (const c of list) {
    test(`${String(c["name"])} → ${String(c["expect"])}`, async () => {
      const status = Number(c["status"]);
      const headers = recordOf(c["headers"]);
      const { adapter, seen } = adapterFor(lunaSpec(), () =>
        Response.json(c["body"], {
          status,
          headers: {
            ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])),
            "x-request-id": "req_err",
          },
        }),
      );
      const p = adapter.chat(request([BRIEFING, HEADER], { promptTokensUpper: 5_000 }));
      expect(seen).toHaveLength(1);
      if (c["expect"] === "refusal") {
        const res = await p;
        expect([res.stop, res.refusal?.category, res.usage]).toEqual([
          "refusal",
          "misalignment",
          [],
        ]);
        return;
      }
      const e = await rejection(p);
      if (!(e instanceof ModelError)) throw e;
      expect<string>(e.kind).toBe(String(c["expect"]));
      expect(e.status).toBe(status);
      expect(e.requestId).toBe("req_err");
      // Nothing was billed for an HTTP error: no charge.
      expect(e.spent).toEqual([]);
      if (c["retryAfterMs"] !== undefined) expect(e.retryAfterMs).toBe(Number(c["retryAfterMs"]));
      // One line, no body text.
      const err = recordOf(recordOf(c["body"])["error"]);
      expect(e.message.includes(String(err["message"]))).toBe(false);
    });
  }

  test("a key an upstream echoes in its error code is redacted", async () => {
    const { adapter } = adapterFor(lunaSpec(), () =>
      Response.json(
        { error: { message: `bad key ${KEY}`, type: null, code: KEY } },
        { status: 401 },
      ),
    );
    const e = await rejection(adapter.chat(request([BRIEFING])));
    expect(e.message.includes(KEY)).toBe(false);
    expect(e.message).toContain("[redacted]");
  });

  test("the organisation-verification refusal of summaries names the fix", async () => {
    const verification = list.find((c) => String(c["name"]).includes("verification"));
    const { adapter } = adapterFor(lunaSpec(), () =>
      Response.json(verification?.["body"], { status: 400 }),
    );
    const e = await rejection(adapter.chat(request([BRIEFING])));
    if (!(e instanceof ModelError)) throw e;
    expect(e.kind).toBe("auth");
    expect(e.message).toContain("organization verification");
    expect(e.message).toContain("https://help.openai.com/en/articles/10910291");
  });
});

// Preflight and counting -----------------------------------------------------------------------

describe("openai: preflight and token counts", () => {
  test("the model's access, then the exact shape at 16 output tokens, streamed and charged", async () => {
    const { adapter, seen } = adapterFor(lunaSpec(), preflightAnswer);
    const report = await adapter.preflight(request([BRIEFING, HEADER]));
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET ${BASE}/models/gpt-6-luna`,
      `POST ${BASE}/responses`,
    ]);
    expect(seen.every((s) => s.redirect === "error")).toBe(true);
    expect(recordOf(seen[1]?.body)["max_output_tokens"]).toBe(16);
    expect(report.model).toBe("gpt-6-luna");
    expect(report.allowedFallbackModels).toEqual([]);
    expect(report.usage[0]?.estimated).toBe(false);
  });

  test("a check whose usage cannot be priced is charged a finite estimate, never the bound marker", async () => {
    const { adapter } = adapterFor(lunaSpec(), (s) =>
      s.method === "GET"
        ? Response.json({ id: "gpt-6-luna", object: "model" })
        : streamOf([CREATED, terminal("usage_missing")]),
    );
    const e = await rejection(adapter.preflight(request([BRIEFING, HEADER])));
    if (!(e instanceof ModelError)) throw e;
    expect(e.kind).toBe("unknown");
    const req = request([BRIEFING, HEADER]);
    expect(e.spent).toEqual([estimatedUsage("gpt-6-luna", promptBytesUpper(req), 16)]);
    expect(Number.isFinite(e.spent[0]?.tokens.input)).toBe(true);
  });

  test("a refused check fails, with what it cost; a missing model is not_found", async () => {
    const refused = adapterFor(lunaSpec(), (s) =>
      s.method === "GET"
        ? Response.json({ id: "gpt-6-luna", object: "model" })
        : streamOf([CREATED, terminal("refusal")]),
    );
    const e = await rejection(refused.adapter.preflight(request([BRIEFING, HEADER])));
    if (!(e instanceof ModelError)) throw e;
    expect(e.kind).toBe("bad_request");
    expect(e.spent[0]?.tokens.output).toBe(12);
    const missing = adapterFor(lunaSpec(), () =>
      Response.json({ error: { message: "no", type: null, code: null } }, { status: 404 }),
    );
    const m = await rejection(missing.adapter.preflight(request([BRIEFING])));
    if (!(m instanceof ModelError)) throw m;
    expect([m.kind, missing.seen.length]).toEqual(["not_found", 1]);
  });

  test("countTokens posts the documented input_tokens body", async () => {
    const { adapter, seen } = adapterFor(SOL, preflightAnswer);
    expect(await adapter.countTokens(request([BRIEFING]))).toBe(11_042);
    expect(seen[0]?.url).toBe(`${BASE}/responses/input_tokens`);
    expect(Object.keys(recordOf(seen[0]?.body))).toEqual([
      "model",
      "input",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "reasoning",
      "truncation",
    ]);
  });
});

// The environment, the redirect, the seat ------------------------------------------------------

describe("openai: environment and transport", () => {
  const junk = {
    OPENAI_API_KEY: "sk-junk-from-the-environment",
    OPENAI_BASE_URL: "https://evil.example",
    OPENAI_ORG_ID: "org-junk",
    OPENAI_PROJECT_ID: "proj-junk",
  };

  test("a junk environment has no effect: only the client's key and base URL are used", async () => {
    const before = new Map(Object.keys(junk).map((k) => [k, process.env[k]]));
    Object.assign(process.env, junk);
    try {
      expect(arenaEnv(process.env).providers?.["openai"]).toEqual({ apiKey: null, baseURL: null });
      const { adapter, seen } = adapterFor(lunaSpec(), () => streamOf([CREATED, terminal("text")]));
      await adapter.chat(request([BRIEFING, HEADER]));
      expect(seen[0]?.url.startsWith(BASE)).toBe(true);
      expect(seen[0]?.headers["authorization"]).toBe(`Bearer ${KEY}`);
      const all = JSON.stringify(seen);
      for (const v of Object.values(junk)) expect(all.includes(v)).toBe(false);
    } finally {
      for (const [k, v] of before) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
  });

  const servers: { stop(force?: boolean): unknown }[] = [];
  afterAll(() => {
    for (const s of servers) void s.stop(true);
  });

  test("a redirecting base URL never hands the key to the second origin", async () => {
    const received: string[] = [];
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        received.push(req.headers.get("authorization") ?? "");
        return new Response("{}");
      },
    });
    servers.push(target);
    const redirector = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(null, {
          status: 307,
          headers: { location: `http://localhost:${target.port}/v1/responses` },
        }),
    });
    servers.push(redirector);
    const client = new OpenAIClient({
      apiKey: KEY,
      baseURL: `http://127.0.0.1:${redirector.port}/v1`,
      time: virtualTime(),
    });
    const e = await rejection(new OpenAIAdapter(lunaSpec(), client).chat(request([BRIEFING])));
    if (!(e instanceof ModelError)) throw e;
    expect(e.kind).toBe("connection");
    expect(e.spent).toEqual([]);
    expect(received).toEqual([]);
    expect(e.message.includes(KEY)).toBe(false);
  });

  test("a URL that would carry the key is refused before sending; so are cleartext and empty keys", () => {
    const s = stub(() => streamOf([]));
    const client = new OpenAIClient({
      apiKey: KEY,
      baseURL: BASE,
      time: virtualTime(),
      fetch: s.fetch,
    });
    expect(() => client.url(`/models/${KEY}`)).toThrow("carries the key");
    expect(() => client.url(`/models/${encodeURIComponent(KEY)}`)).toThrow("carries the key");
    // Every path is appended to the configured base: the origin cannot change.
    expect(new URL(client.url("@evil.example/v1/responses")).origin).toBe(new URL(BASE).origin);
    expect(s.seen).toEqual([]);
    expect(
      () =>
        new OpenAIClient({ apiKey: KEY, baseURL: "http://evil.example/v1", time: virtualTime() }),
    ).toThrow("not https");
    expect(() => new OpenAIClient({ apiKey: " ", baseURL: BASE, time: virtualTime() })).toThrow(
      "PERFIDIA_OPENAI_API_KEY",
    );
  });
});

describe("openai: through a seat", () => {
  test("max_output_tokens stops once, the seat retries at twice the limit, both attempts charged; the line says summary", async () => {
    const time = virtualTime();
    const clock = { time, random: seededRandom(1) };
    const s = stub((seen, n) =>
      n === 1
        ? streamOf([CREATED, terminal("incomplete_max_output_tokens")])
        : streamOf([CREATED, terminal("text")]),
    );
    const adapter = new OpenAIAdapter(
      lunaSpec(),
      new OpenAIClient({ apiKey: KEY, baseURL: BASE, time, fetch: s.fetch }),
    );
    const log = new MemoryCallLog();
    const ledger = new BudgetLedger({
      caps: new Map([["p1", 100_000_000_000]]),
      wakeCapNanoUsd: null,
      handoffTo: () => ({
        label: "bot:turtle@3",
        agent: { label: "x", round: async () => ({ calls: [] }) },
      }),
      pricers: new Map([
        [
          "p1",
          pricerFor({
            provider: "openai",
            endpoint: null,
            fixedAt: null,
            fallbackAt: "2026-10-20T00:00:00Z",
          }),
        ],
      ]),
    });
    const profile = PROFILES[0];
    if (profile === undefined) throw new Error("no profile");
    const agent = new LlmSeatAgent({
      seat: "p1",
      adapter,
      prompt: PROMPT,
      tools: TOOLS,
      profile,
      ledger,
      log,
      clock,
      gate: new NoPauseGate(),
      rate: new RateGate({ clock, maxInflight: 1 }),
      policy: { ...LOCKSTEP_POLICY, promptCapTokens: 160_000 },
      promptVariant: "developer",
      reminders: "last-round",
    });
    const out = await agent.round(inputOf(1, 0, [], { briefing: briefingOf() }));
    expect(out.calls).toEqual([]);
    expect(s.seen.map((x) => recordOf(x.body)["max_output_tokens"])).toEqual([MAX, 65_536]);
    // The second request is the first one again (the truncated reply is not appended).
    const inputs = s.seen.map((x) => JSON.stringify(recordOf(x.body)["input"]));
    expect(inputs[1]).toBe(inputs[0]);
    const lines = log.lines.flatMap((l) => (l.k === "llm_call" ? [l] : []));
    expect(lines.map((l) => l.stop)).toEqual(["max_tokens", "end_turn"]);
    expect(lines.every((l) => l.reasoningKind === "summary")).toBe(true);
    expect(lines.every((l) => l.priceCard === "openai:gpt-6-luna@2026-10-20")).toBe(true);
    expect(ledger.spent("p1")).toBe(lines.reduce((n, l) => n + l.costNanoUsd, 0));
    expect(lines[0]?.usage[0]?.reasoning).toBe(32_768);
  });

  test("a broken stream is charged the seat's own prompt estimate (at most the cap) and the full limit", async () => {
    const time = virtualTime();
    const clock = { time, random: seededRandom(1) };
    const s = stub(() => streamOf([CREATED]));
    const adapter = new OpenAIAdapter(
      lunaSpec(),
      new OpenAIClient({ apiKey: KEY, baseURL: BASE, time, fetch: s.fetch }),
    );
    const log = new MemoryCallLog();
    const ledger = new BudgetLedger({
      caps: new Map([["p1", 100_000_000_000]]),
      wakeCapNanoUsd: null,
      handoffTo: () => ({
        label: "bot:turtle@3",
        agent: { label: "x", round: async () => ({ calls: [] }) },
      }),
      pricers: new Map([
        [
          "p1",
          pricerFor({
            provider: "openai",
            endpoint: null,
            fixedAt: null,
            fallbackAt: "2026-10-20T00:00:00Z",
          }),
        ],
      ]),
    });
    const profile = PROFILES[0];
    if (profile === undefined) throw new Error("no profile");
    const agent = new LlmSeatAgent({
      seat: "p1",
      adapter,
      prompt: PROMPT,
      tools: TOOLS,
      profile,
      ledger,
      log,
      clock,
      gate: new NoPauseGate(),
      rate: new RateGate({ clock, maxInflight: 1 }),
      // No retry budget: the broken attempt is the turn's only one.
      policy: { ...LOCKSTEP_POLICY, retryBudgetMs: 0, promptCapTokens: 160_000 },
      prefixTokens: 1_234,
      promptVariant: "developer",
      reminders: "last-round",
    });
    const e = await rejection(agent.round(inputOf(1, 0, [], { briefing: briefingOf() })));
    expect(e.message).toContain("connection, retries exhausted");
    expect(s.seen).toHaveLength(1);
    const line = log.lines.flatMap((l) => (l.k === "llm_call" ? [l] : []))[0];
    expect(line?.error?.kind).toBe("connection");
    // The seat's estimate: its measured prefix (1,234 here) and every entry at one token per byte.
    const entries: Entry[] = [
      { role: "user", parts: [{ kind: "text", text: canonicalJson(briefingOf()) }] },
      {
        role: "operator",
        text: turnHeader(inputOf(1, 0, [], { briefing: briefingOf() }), "developer"),
      },
    ];
    const expected = promptEstimate(entries, null, 1_234);
    expect(line?.usage).toEqual([
      {
        model: "gpt-6-luna",
        kind: "message",
        input: 0,
        cacheWrite5m: expected,
        cacheWrite1h: 0,
        cacheRead: 0,
        output: MAX,
        estimated: true,
      },
    ]);
    expect(expected).toBeLessThan(160_000);
    expect(line?.costNanoUsd).toBe(Math.ceil((expected * 125_000 + MAX * 500_000) / 1000));
  });
});

// Prefix stability is checked over a whole match, request by request, in
// `arena/providers/openai.test.ts` (the wire-stub match).
