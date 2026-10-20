// The OpenAI-compatible adapter's contract (phase-4 design §8.1–§8.4, Pass 2), against a stub
// `fetch` and loopback servers only (no test touches the network): the pinned request bodies (the
// provider pin, the metadata header, only the parameters the endpoint lists, the effort OpenRouter
// takes), one fetch per attempt to the origin with no key in any URL and `redirect: "error"`, every
// error of design §2.2 by its code, the usage mapping (cached reads, reasoning inside the output,
// the reported cost and any excess over the card), refusals, `max_tokens` then the retry, malformed
// calls, broken streams charged at `max_tokens`, unknown usage charged the attempt bound, the
// served-endpoint check, prefix stability across a turn's rounds, and a junk environment. The
// fixtures under `fixtures/openrouter/` are synthetic (written from the docs they cite) except the
// trimmed public metadata, recorded on 2026-10-20.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@perfidia/engine/core";
import type { SeatAgent } from "@perfidia/protocol";
import { harness } from "@perfidia/sim";
import { openrouterPin } from "../arena/providers/openrouter.ts";
import { PREFLIGHT_OUTPUT_TOKENS, sampleRequest, sampleTokensUpper } from "../arena/preflight.ts";
import { BudgetLedger } from "../budget/ledger.ts";
import { ENTRY_OVERHEAD_TOKENS, promptEstimate } from "../seat/agent.ts";
import {
  ModelError,
  promptTokens,
  retryOutputTokens,
  type ChatRequest,
  type Entry,
  type ModelSpec,
  type ModelTool,
  type UsageEntry,
} from "./adapter.ts";
import {
  CompatAdapter,
  PART_OVERHEAD_TOKENS,
  PREFLIGHT_MAX_TOKENS,
  classifyCompatError,
  creditsToNano,
  effortSent,
  promptBytesUpper,
  stopOf,
  tokensOf,
  type CompatMode,
  type PinnedEndpoint,
} from "./compat.ts";
import type { HttpFetch } from "./http.ts";
import { costOf, type PriceContext } from "./prices.ts";
import { CompatRequestSchema, UsageSchema } from "./wire/compat.ts";

const KEY = "sk-or-v1-test-0123456789abcdef0123456789abcdef";
const BASE = "https://openrouter.ai/api/v1";
const FIX = join(import.meta.dir, "fixtures");
const AT = "2026-10-20T12:00:00.000Z";
const OR_CTX: PriceContext = { provider: "openrouter", endpoint: "z-ai/fp8", at: AT };

interface StreamFixture {
  readonly synthetic: boolean;
  readonly sources: readonly { readonly url: string; readonly read: string }[];
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly events?: readonly unknown[];
  readonly body?: unknown;
}

function fixture(dir: string, name: string): StreamFixture {
  const v: unknown = JSON.parse(readFileSync(join(FIX, dir, name), "utf8"));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test data, checked below
  return v as StreamFixture;
}

/** A server-sent-event body of `events`: comments, `[DONE]`, or JSON chunks. */
function sse(events: readonly unknown[]): string {
  return events
    .map((e) =>
      typeof e === "string" && e.startsWith(":")
        ? `${e}\n\n`
        : `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`,
    )
    .join("");
}

function responseOf(f: StreamFixture): Response {
  const body = f.events === undefined ? JSON.stringify(f.body) : sse(f.events);
  return new Response(body, { status: f.status, headers: { ...f.headers } });
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly redirect: string | undefined;
}

/** `body`, errored when `signal` aborts (as the global `fetch` does to a body it is reading). */
function abortable(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    start(c) {
      signal.addEventListener(
        "abort",
        () => {
          c.error(signal.reason);
          reader.cancel().catch(() => undefined);
        },
        { once: true },
      );
    },
    async pull(c) {
      const r = await reader.read();
      if (signal.aborted) return;
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * A stub `fetch` answering with `respond` (the n-th call, from 0); every call recorded. Like the
 * global `fetch`, it rejects when the request's signal aborts and errors the body it returned.
 */
function stub(respond: (call: Call, n: number) => Response | Promise<Response>): {
  readonly fetch: HttpFetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: HttpFetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const text = typeof init?.body === "string" ? init.body : null;
    const call: Call = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      headers,
      body: text === null ? null : JSON.parse(text),
      redirect: init?.redirect,
    };
    calls.push(call);
    const signal = init?.signal ?? null;
    if (signal === null) return respond(call, calls.length - 1);
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = (): void => reject(new Error("The operation was aborted."));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
    aborted.catch(() => undefined);
    const res = await Promise.race([Promise.resolve(respond(call, calls.length - 1)), aborted]);
    if (res.body === null) return res;
    return new Response(abortable(res.body, signal), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
  return { fetch, calls };
}

const TOOLS: readonly ModelTool[] = Object.freeze([
  {
    name: "build",
    description: "Queue a building.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" }, building: { type: "string" } },
      required: ["city", "building"],
      additionalProperties: false,
    },
  },
  {
    name: "end_turn",
    description: "End the turn.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
]);

const BRIEFING: Entry = { role: "user", parts: [{ kind: "text", text: '{"you":"p1","t":60}' }] };
const HEADER: Entry = { role: "operator", text: "Turn 1 · D1 00:01 · round trip 1 of 8." };

function request(entries: readonly Entry[] = [BRIEFING, HEADER], maxOutputTokens?: number) {
  const req: ChatRequest = {
    prompt: { shared: "SHARED RULES", seat: "YOUR SEAT p1" },
    tools: TOOLS,
    entries,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    meta: { seat: "p1", turn: 1, round: 0, maxRounds: 8, maxCalls: 10, kind: "round" },
  };
  return req;
}

function specOf(
  o: {
    readonly model?: string;
    readonly endpoint?: string;
    readonly effort?: ModelSpec["effort"];
    readonly mode?: CompatMode;
  } = {},
): ModelSpec {
  const mode = o.mode ?? "openrouter";
  return {
    provider: mode,
    model: o.model ?? "z-ai/glm-5.3",
    ...(mode === "openrouter" ? { endpoint: o.endpoint ?? "z-ai/fp8" } : {}),
    effort: o.effort ?? "medium",
    maxOutputTokens: 32_768,
    cacheTtl: "5m",
    fallbacks: "off",
  };
}

function adapterWith(
  respond: (call: Call, n: number) => Response | Promise<Response>,
  o: {
    readonly spec?: ModelSpec;
    readonly endpoint?: PinnedEndpoint;
    readonly baseURL?: string;
    readonly apiKey?: string | null;
    readonly timeoutMs?: number;
    readonly time?:
      | ReturnType<typeof harness.createVirtualTime>
      | InstanceType<typeof harness.SystemTime>;
  } = {},
) {
  const s = stub(respond);
  const spec = o.spec ?? specOf();
  const mode = spec.provider === "compat" ? "compat" : "openrouter";
  const a = new CompatAdapter(spec, {
    mode,
    baseURL: o.baseURL ?? (mode === "compat" ? "http://127.0.0.1:8000/v1" : BASE),
    apiKey: o.apiKey === undefined ? KEY : o.apiKey,
    time: o.time ?? harness.createVirtualTime(),
    fetch: s.fetch,
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
    ...(mode === "openrouter"
      ? { endpoint: o.endpoint ?? openrouterPin(spec.model, spec.endpoint ?? "") }
      : {}),
  });
  return { a, calls: s.calls };
}

const fromFixture = (name: string, dir = "openrouter") => {
  const f = fixture(dir, name);
  return () => responseOf(f);
};

async function rejection(p: Promise<unknown>): Promise<ModelError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ModelError) return e;
    throw e;
  }
  throw new Error("resolved");
}

/** A ledger whose seat p1 is priced on z-ai/fp8 with an attempt bound of `bound`. */
function ledger(bound: number) {
  const agent: SeatAgent = { label: "bot:turtle@3", round: () => Promise.resolve({ calls: [] }) };
  return new BudgetLedger({
    caps: new Map([["p1", 100_000_000_000]]),
    wakeCapNanoUsd: null,
    handoffTo: () => ({ label: "bot:turtle@3", agent }),
    pricers: new Map([["p1", (usage, at) => costOf(usage, { ...OR_CTX, at: at ?? AT })]]),
    attemptBounds: new Map([["p1", bound]]),
  });
}

const isBound = (u: readonly UsageEntry[]): boolean =>
  u.length === 1 && u.every((e) => !Number.isFinite(e.tokens.input) && e.estimated);

describe("fixtures", () => {
  test("every synthetic fixture says so and cites dated sources; the recorded ones name theirs", () => {
    const names = [
      ...[
        "stream-tool-calls.json",
        "stream-summary.json",
        "stream-length.json",
        "stream-content-filter.json",
        "stream-error-first.json",
        "stream-error-mid.json",
        "stream-error-string-code.json",
        "stream-max-tokens-error.json",
        "stream-broken.json",
        "stream-broken-after-usage.json",
        "stream-wrong-endpoint.json",
        "stream-no-metadata.json",
        "stream-bad-usage.json",
        "stream-reported-over-card.json",
        "stream-dated-model.json",
        "errors.json",
        "json-200-error.json",
      ].map((n) => ["openrouter", n] as const),
      ["compat", "stream-openai-style.json"] as const,
    ];
    for (const [dir, n] of names) {
      const f = fixture(dir, n);
      expect(f.synthetic).toBe(true);
      expect(f.sources.length).toBeGreaterThan(0);
      for (const s of f.sources) {
        expect(s.url).toMatch(/^https:\/\/openrouter\.ai\//);
        expect(s.read).toBe("2026-10-20");
      }
    }
    for (const n of [
      "endpoints-z-ai_glm-5.3.json",
      "endpoints-z-ai_glm-5.3-flash.json",
      "zdr.json",
    ]) {
      const v: unknown = JSON.parse(readFileSync(join(FIX, "openrouter", n), "utf8"));
      expect(v).toMatchObject({ synthetic: false, recorded: "2026-10-20" });
      expect(String(Reflect.get(Object(v), "source"))).toMatch(
        /^https:\/\/openrouter\.ai\/api\/v1\//,
      );
    }
  });
});

describe("the request", () => {
  test("an OpenRouter seat: pinned to its full slug, no fallback, only listed parameters, the metadata opt-in", () => {
    const { a } = adapterWith(() => new Response(""));
    const body = a.build(request());
    expect(CompatRequestSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      model: "z-ai/glm-5.3",
      messages: [
        { role: "system", content: "SHARED RULES" },
        { role: "system", content: "YOUR SEAT p1" },
        { role: "user", content: '{"you":"p1","t":60}' },
        { role: "user", content: "[harness] Turn 1 · D1 00:01 · round trip 1 of 8." },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "build",
            description: "Queue a building.",
            parameters: {
              type: "object",
              properties: { city: { type: "string" }, building: { type: "string" } },
              required: ["city", "building"],
              additionalProperties: false,
            },
          },
        },
        {
          type: "function",
          function: {
            name: "end_turn",
            description: "End the turn.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        },
      ],
      tool_choice: "auto",
      max_tokens: 32_768,
      // GLM-5.3 lists max, high and low: medium goes as the nearest, low (C9).
      reasoning: { effort: "low" },
      stream: true,
      provider: {
        only: ["z-ai/fp8"],
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: "deny",
        zdr: true,
      },
    });
    // z-ai/fp8 does not list parallel_tool_calls: not sent (require_parameters would refuse it).
    expect(Object.keys(body)).not.toContain("parallel_tool_calls");
    // The bytes, pinned (key order included).
    expect(sha256Hex(JSON.stringify(body))).toBe(
      "8d808a05852506c35779714e98f8d2d1f8553e039fd6b3b2b4a300635123c5b0",
    );
  });

  test("parallel_tool_calls goes only to an endpoint that lists it; zdr only to a ZDR-listed one", () => {
    const pin: PinnedEndpoint = {
      tag: "z-ai/fp8",
      providerName: "Z.AI",
      supportedParams: ["tools", "tool_choice", "max_tokens", "reasoning", "parallel_tool_calls"],
      zdr: false,
    };
    const { a } = adapterWith(() => new Response(""), { endpoint: pin });
    const body = a.build(request());
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.provider).toEqual({
      only: ["z-ai/fp8"],
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: "deny",
    });
  });

  test("a compat endpoint: no OpenRouter extension, the usage asked for, the effort not sent", () => {
    const { a } = adapterWith(() => new Response(""), {
      spec: specOf({ mode: "compat", model: "local/glm" }),
    });
    const body = a.build(request());
    expect(CompatRequestSchema.parse(body)).toEqual(body);
    expect(Object.keys(body)).toEqual([
      "model",
      "messages",
      "tools",
      "tool_choice",
      "max_tokens",
      "stream",
      "stream_options",
    ]);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test("results are tool messages in call order, harness text a [harness] user message after them", () => {
    const { a } = adapterWith(() => new Response(""));
    const reply = {
      native: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "build", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "end_turn", arguments: "{}" } },
        ],
      },
      text: [],
      calls: [],
      reasoning: [],
    };
    const body = a.build(
      request([
        BRIEFING,
        HEADER,
        { role: "assistant", reply },
        {
          role: "user",
          parts: [
            { kind: "result", callId: "c1", content: '{"ok":false,"code":"X"}', isError: true },
            { kind: "result", callId: "c2", content: '{"ok":true}', isError: false },
          ],
        },
        { role: "operator", text: "Round trip 8 of 8, the last." },
      ]),
    );
    const rendered: unknown = body.messages.slice(4);
    expect(rendered).toEqual([
      reply.native,
      { role: "tool", tool_call_id: "c1", content: '{"ok":false,"code":"X"}' },
      { role: "tool", tool_call_id: "c2", content: '{"ok":true}' },
      { role: "user", content: "[harness] Round trip 8 of 8, the last." },
    ]);
    expect(() => a.build(request([HEADER]))).toThrow("starts with a user entry");
    expect(() => a.build(request([BRIEFING, { role: "assistant", reply }]))).toThrow("no prefill");
  });

  test("the effort OpenRouter takes (C9): the nearest listed level, a tie to the lower one, never none", () => {
    expect(effortSent("openrouter", "z-ai/glm-5.3", "medium")).toBe("low");
    expect(effortSent("openrouter", "z-ai/glm-5.3-flash", "medium")).toBe("low");
    expect(effortSent("openrouter", "z-ai/glm-5.3", "high")).toBe("high");
    // xhigh is one step from high and from max: the tie goes down, to high.
    expect(effortSent("openrouter", "z-ai/glm-5.3", "xhigh")).toBe("high");
    expect(effortSent("openrouter", "z-ai/glm-5.3", "max")).toBe("max");
    expect(effortSent("openrouter", "z-ai/glm-5.3", "minimal")).toBe("low");
    // Kimi K3 lists none: minimal is one step from none and from low, and goes to low.
    expect(effortSent("openrouter", "moonshotai/kimi-k3", "minimal")).toBe("low");
    expect(effortSent("openrouter", "moonshotai/kimi-k3", "none")).toBe("none");
    expect(effortSent("openai", "gpt-6-luna", "medium")).toBe("medium");
    expect(effortSent("openrouter", "unknown/model", "medium")).toBe("medium");
  });

  test("its prompt bound is the arena's sample bound and the agent's rule", () => {
    expect(PART_OVERHEAD_TOKENS).toBe(ENTRY_OVERHEAD_TOKENS);
    expect(PREFLIGHT_MAX_TOKENS).toBe(PREFLIGHT_OUTPUT_TOKENS);
    const g = {
      seat: "p1" as const,
      prompt: { shared: "Ünïcode SHARED", seat: "seat" },
      tools: TOOLS,
    };
    expect(promptBytesUpper(sampleRequest(g, "envelope"))).toBe(sampleTokensUpper(g, "envelope"));
  });
});

describe("the transport", () => {
  test("one fetch per attempt, to the origin, with our key in its header only and no redirect followed", async () => {
    const { a, calls } = adapterWith(fromFixture("stream-summary.json"));
    await a.chat(request());
    expect(calls.length).toBe(1);
    const c = calls[0];
    expect(c?.url).toBe(`${BASE}/chat/completions`);
    expect(c?.method).toBe("POST");
    expect(c?.redirect).toBe("error");
    expect(c?.url).not.toContain(KEY);
    expect(c?.headers).toEqual({
      accept: "text/event-stream",
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      "x-openrouter-metadata": "enabled",
    });
  });

  test("a keyless compat endpoint on loopback sends no authorization", async () => {
    const { a, calls } = adapterWith(fromFixture("stream-openai-style.json", "compat"), {
      spec: specOf({ mode: "compat", model: "local/glm" }),
      apiKey: null,
    });
    await a.chat(request());
    expect(Object.keys(calls[0]?.headers ?? {})).toEqual(["accept", "content-type"]);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8000/v1/chat/completions");
  });

  test("a junk environment has no effect: the adapter reads no variable", async () => {
    const junk: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-junk-1",
      OPENROUTER_BASE_URL: "https://evil.example",
      OPENAI_API_KEY: "sk-junk-2",
      OPENAI_BASE_URL: "https://evil.example/v1",
      PERFIDIA_OPENROUTER_API_KEY: "sk-or-junk-3",
      PERFIDIA_OPENROUTER_BASE_URL: "https://evil.example/api/v1",
    };
    const saved = new Map(Object.keys(junk).map((k) => [k, process.env[k]]));
    Object.assign(process.env, junk);
    try {
      const { a, calls } = adapterWith(fromFixture("stream-summary.json"));
      await a.chat(request());
      const sent = JSON.stringify(calls);
      for (const v of Object.values(junk)) expect(sent).not.toContain(v);
      expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
  });

  test("a URL off the origin, or carrying the key, is refused before anything is sent", () => {
    expect(
      () =>
        new CompatAdapter(specOf(), {
          mode: "openrouter",
          baseURL: "http://openrouter.ai/api/v1",
          apiKey: KEY,
          time: harness.createVirtualTime(),
        }),
    ).toThrow("is not https");
  });

  test("an error body echoing the key leaves the key out of the error", async () => {
    const { a } = adapterWith(
      () =>
        new Response(JSON.stringify({ error: { code: 401, message: `bad key ${KEY}` } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const e = await rejection(a.chat(request()));
    expect(e.kind).toBe("auth");
    expect(e.message).not.toContain(KEY);
    expect(e.message).toBe("openrouter HTTP 401");
  });
});

describe("a redirect on loopback", () => {
  const servers: { stop(force?: boolean): unknown }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
  });

  test("is never followed: the second server receives nothing and the key appears nowhere", async () => {
    const seen: string[] = [];
    const second = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push(JSON.stringify([...req.headers.entries()]));
        return new Response("{}");
      },
    });
    servers.push(second);
    const first = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(null, {
          status: 307,
          headers: { location: `http://127.0.0.1:${second.port}/steal` },
        }),
    });
    servers.push(first);
    const a = new CompatAdapter(specOf(), {
      mode: "openrouter",
      baseURL: `http://127.0.0.1:${first.port}/api/v1`,
      apiKey: KEY,
      time: harness.createVirtualTime(),
    });
    const e = await rejection(a.chat(request()));
    expect(e.kind).toBe("connection");
    expect(e.message).not.toContain(KEY);
    expect(e.spent).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("a reply", () => {
  test("tool calls, raw reasoning and text, assembled from fragments; usage priced at the card", async () => {
    const { a } = adapterWith(fromFixture("stream-tool-calls.json"));
    const res = await a.chat(request());
    expect(res.stop).toBe("tool_use");
    expect(res.rawStop).toBe("tool_calls");
    expect(res.reply.calls).toEqual([
      { callId: "call_a1", name: "build", args: { city: "c3", building: "farm" } },
      { callId: "call_a2", name: "end_turn", args: {} },
    ]);
    expect(res.reply.text).toEqual(["Building up before the strike."]);
    expect(res.reply.reasoning).toEqual(["p3 is weak at c12; build first, then scout."]);
    expect(res.reply.reasoningKind).toBe("raw");
    expect(res.reply.native).toEqual({
      role: "assistant",
      content: "Building up before the strike.",
      tool_calls: [
        {
          id: "call_a1",
          type: "function",
          function: { name: "build", arguments: '{"city":"c3","building":"farm"}' },
        },
        { id: "call_a2", type: "function", function: { name: "end_turn", arguments: "{}" } },
      ],
      reasoning_details: [
        {
          type: "reasoning.text",
          text: "p3 is weak at c12; build first, then scout.",
          format: "unknown",
          index: 0,
        },
      ],
    });
    expect(res.usage).toEqual([
      {
        model: "z-ai/glm-5.3",
        kind: "message",
        tokens: {
          input: 3000,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheRead: 9000,
          output: 900,
          reasoning: 600,
        },
        estimated: false,
      },
    ]);
    expect(res.servedBy).toBe("z-ai/glm-5.3");
    expect(res.endpoint).toBe("z-ai/fp8");
    expect(res.requestId).toBe("gen-1729000000-synthetic");
    expect(res.fallback).toBe(false);
    // $0.0105 of tokens at the card, as OpenRouter reports; the 5.5% fee on top, apart.
    expect(res.reportedCostNanoUsd).toBe(10_500_000);
    const c = costOf(res.usage, OR_CTX);
    expect([c.nanoUsd - c.feeNanoUsd, c.feeNanoUsd, c.cards]).toEqual([
      10_500_000,
      577_500,
      ["openrouter:z-ai/glm-5.3(z-ai/fp8)@2026-10-20"],
    ]);
  });

  test("a summary is a summary; text only ends the turn", async () => {
    const { a } = adapterWith(fromFixture("stream-summary.json"));
    const res = await a.chat(request());
    expect([res.stop, res.reply.reasoningKind, res.reply.reasoning, res.reply.text]).toEqual([
      "end_turn",
      "summary",
      ["Weighed the pact offer."],
      ["Holding course."],
    ]);
    expect(res.reply.native).toMatchObject({ content: "Holding course." });
  });

  test("max_tokens, then the retry at twice the limit the model allows", async () => {
    const { a, calls } = adapterWith((_c, n) =>
      responseOf(fixture("openrouter", n === 0 ? "stream-length.json" : "stream-summary.json")),
    );
    const first = await a.chat(request());
    expect(first.stop).toBe("max_tokens");
    expect(first.usage[0]?.tokens).toMatchObject({ output: 32_768, reasoning: 32_767 });
    const next = retryOutputTokens(32_768, a.capabilities.maxOutputTokens);
    expect([next, a.capabilities.maxOutputTokens]).toEqual([65_536, 131_072]);
    const second = await a.chat(request(undefined, next ?? 0));
    expect(second.stop).toBe("end_turn");
    expect(calls.map((c): unknown => Reflect.get(Object(c.body), "max_tokens"))).toEqual([
      32_768, 65_536,
    ]);
  });

  test("a max_tokens error event is the max_tokens stop too", async () => {
    const { a } = adapterWith(fromFixture("stream-max-tokens-error.json"));
    // Round 0 has no measured prompt to estimate it with: the attempt bound, as a failure.
    const e = await rejection(a.chat(request()));
    expect([e.kind, isBound(e.spent)]).toEqual(["unknown", true]);
    // Later in a turn it is a max_tokens stop charged the estimate.
    const { a: b } = adapterWith((_c, n) =>
      responseOf(
        fixture("openrouter", n === 0 ? "stream-summary.json" : "stream-max-tokens-error.json"),
      ),
    );
    const r0 = await b.chat(request());
    const res = await b.chat(
      request([BRIEFING, HEADER, { role: "assistant", reply: r0.reply }, BRIEFING]),
    );
    expect(res.stop).toBe("max_tokens");
    expect(res.usage[0]?.estimated).toBe(true);
    expect(res.usage[0]?.tokens.output).toBe(32_768);
  });

  test("a refusal produced as output closes the turn and is billed", async () => {
    const { a } = adapterWith(fromFixture("stream-content-filter.json"));
    const res = await a.chat(request());
    expect([res.stop, res.refusal]).toEqual([
      "refusal",
      {
        category: "content_filter",
        explanation: "I can't help with that.",
        recommendedModel: null,
      },
    ]);
    expect(res.reply.calls).toEqual([]);
    expect(res.usage[0]?.tokens).toMatchObject({ input: 4000, output: 12 });
  });

  test("malformed calls go through raw (the gateway answers INVALID_ARGS); a missing id is made stable", async () => {
    const events = [
      {
        id: "gen-x",
        model: "z-ai/glm-5.3",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { name: "build", arguments: "{not json" } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "gen-x",
        model: "z-ai/glm-5.3",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        openrouter_metadata: {
          endpoints: {
            total: 1,
            available: [{ provider: "Z.AI", model: "z-ai/glm-5.3", selected: true }],
          },
        },
      },
      "[DONE]",
    ];
    const { a } = adapterWith(
      () => new Response(sse(events), { headers: { "content-type": "text/event-stream" } }),
    );
    const res = await a.chat(request());
    expect(res.reply.calls).toEqual([{ callId: "call_gen-x_0", name: "build", args: "{not json" }]);
    expect(res.stop).toBe("tool_use");
  });

  test("a dated snapshot of the model is the model (and its card)", async () => {
    const { a } = adapterWith(fromFixture("stream-dated-model.json"));
    const res = await a.chat(request());
    expect(res.servedBy).toBe("z-ai/glm-5.3-20260816");
    expect(res.usage[0]?.model).toBe("z-ai/glm-5.3");
    expect(costOf(res.usage, OR_CTX).unpriced).toEqual([]);
  });

  test("a compat stream: reasoning_content as raw reasoning (not echoed), usage without a cost", async () => {
    const { a } = adapterWith(fromFixture("stream-openai-style.json", "compat"), {
      spec: specOf({ mode: "compat", model: "local/glm" }),
    });
    const res = await a.chat(request());
    expect(res.stop).toBe("tool_use");
    expect([res.reply.reasoning, res.reply.reasoningKind]).toEqual([
      ["Check the briefing."],
      "raw",
    ]);
    expect(res.reply.native).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_0", type: "function", function: { name: "end_turn", arguments: "{}" } },
      ],
    });
    expect(res.usage[0]?.tokens).toEqual({
      input: 904,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 4096,
      output: 40,
    });
    expect([res.reportedCostNanoUsd, res.endpoint]).toEqual([null, null]);
  });

  test("stop reasons", () => {
    expect([
      stopOf("stop", 0),
      stopOf("stop", 2),
      stopOf("tool_calls", 1),
      stopOf("tool_calls", 0),
      stopOf("length", 0),
      stopOf("content_filter", 0),
      stopOf("error", 0),
      stopOf(null, 0),
      stopOf("weird", 1),
    ]).toEqual([
      "end_turn",
      "tool_use",
      "tool_use",
      "other",
      "max_tokens",
      "refusal",
      "other",
      "other",
      "other",
    ]);
  });
});

const u = (v: unknown) => UsageSchema.parse(v);

describe("usage, never under the bill", () => {
  test("cached reads, writes and input split the prompt; reasoning stays inside the output", () => {
    expect(
      tokensOf(
        u({
          prompt_tokens: 10_000,
          completion_tokens: 700,
          prompt_tokens_details: { cached_tokens: 6000, cache_write_tokens: 1000 },
          completion_tokens_details: { reasoning_tokens: 500 },
        }),
      ),
    ).toEqual({
      input: 3000,
      cacheWrite5m: 1000,
      cacheWrite1h: 0,
      cacheRead: 6000,
      output: 700,
      reasoning: 500,
    });
  });

  test("an inconsistent breakdown is charged whole at the input price; reasoning counted apart is added", () => {
    expect(
      tokensOf(
        u({
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 150 },
        }),
      ),
    ).toEqual({ input: 150, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 10 });
    expect(
      tokensOf(
        u({
          prompt_tokens: 100,
          completion_tokens: 10,
          completion_tokens_details: { reasoning_tokens: 40 },
        }),
      ),
    ).toMatchObject({ output: 50, reasoning: 40 });
  });

  test("credits as nano-dollars, rounded up", () => {
    expect([
      creditsToNano(0.0105),
      creditsToNano(0.00014),
      creditsToNano(1e-12),
      creditsToNano(0),
    ]).toEqual([10_500_000, 140_000, 1, 0]);
  });

  test("a reported cost over the card's is charged: the output is topped up, flagged estimated", async () => {
    const { a } = adapterWith(fromFixture("stream-reported-over-card.json"));
    const res = await a.chat(request());
    const e = res.usage[0];
    expect(e?.estimated).toBe(true);
    expect(res.reportedCostNanoUsd).toBe(12_500_000);
    const c = costOf(res.usage, OR_CTX);
    expect(c.nanoUsd - c.feeNanoUsd).toBeGreaterThanOrEqual(12_500_000);
    // The least top-up that covers it: 2,000,000 nUSD at $4.40/M is 455 tokens.
    expect(e?.tokens.output).toBe(900 + 455);
  });

  test("an unknown usage shape is charged the attempt bound, never 0", async () => {
    const { a } = adapterWith(fromFixture("stream-bad-usage.json"));
    const e = await rejection(a.chat(request()));
    expect(e.kind).toBe("unknown");
    expect(isBound(e.spent)).toBe(true);
    const charge = ledger(540_000_000).charge("p1", 1, 0, e.spent, AT);
    expect([charge.costNanoUsd, charge.invalidUsage]).toEqual([540_000_000, true]);
  });

  test("a stream that ends without its usage is charged too", async () => {
    const events = fixture("openrouter", "stream-summary.json").events ?? [];
    const noUsage = events.map((e) =>
      typeof e === "object" && e !== null && "usage" in e
        ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== "usage"))
        : e,
    );
    const { a } = adapterWith(
      () => new Response(sse(noUsage), { headers: { "content-type": "text/event-stream" } }),
    );
    const e = await rejection(a.chat(request()));
    expect([e.kind, isBound(e.spent)]).toEqual(["unknown", true]);
  });
});

describe("errors, by code before status (design §2.2)", () => {
  interface Case {
    readonly name: string;
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
    readonly expect: {
      readonly kind: string;
      readonly refusal?: string;
      readonly retryAfterMs?: number;
      readonly planKind?: string;
    };
  }
  const raw: unknown = JSON.parse(readFileSync(join(FIX, "openrouter", "errors.json"), "utf8"));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test data
  const cases = (raw as { readonly cases: readonly Case[] }).cases;

  for (const c of cases) {
    test(`${c.status} ${c.name}: ${c.expect.kind}${c.expect.refusal === undefined ? "" : ` (${c.expect.refusal})`}`, async () => {
      const respond = () =>
        new Response(JSON.stringify(c.body), {
          status: c.status,
          headers: { "content-type": "application/json", ...c.headers },
        });
      const { a, calls } = adapterWith(respond);
      if (c.expect.kind === "refusal") {
        const res = await a.chat(request());
        expect([res.stop, res.refusal?.category, res.usage]).toEqual([
          "refusal",
          c.expect.refusal,
          [],
        ]);
      } else {
        const e = await rejection(a.chat(request()));
        expect<string>(e.kind).toBe(c.expect.kind);
        expect(e.status).toBe(c.status);
        expect(e.spent).toEqual([]);
        expect(e.retryAfterMs).toBe(c.expect.retryAfterMs ?? null);
        expect(e.message).toBe(
          `openrouter HTTP ${c.status}${e.message.slice(`openrouter HTTP ${c.status}`.length)}`,
        );
      }
      expect(calls.length).toBe(1);
      if (c.expect.planKind !== undefined) {
        expect<string>(
          classifyCompatError("openrouter", c.status, new Headers(c.headers), c.body, "plan").kind,
        ).toBe(c.expect.planKind);
      }
    });
  }

  test("a 200 whose body holds only an error: by its error_type, not billed", async () => {
    const { a } = adapterWith(fromFixture("json-200-error.json"));
    const e = await rejection(a.chat(request()));
    expect([e.kind, e.retryable, e.spent]).toEqual(["rate_limit", true, []]);
  });

  test("an error as the first and only event: by its error_type, nothing billed (nothing generated)", async () => {
    const { a } = adapterWith(fromFixture("stream-error-first.json"));
    const e = await rejection(a.chat(request()));
    expect([e.kind, e.retryable, e.spent, e.requestId]).toEqual([
      "rate_limit",
      true,
      [],
      "gen-1729000000-synthetic",
    ]);
  });

  test("a string code without error_type", async () => {
    const { a } = adapterWith(fromFixture("stream-error-string-code.json"));
    const e = await rejection(a.chat(request()));
    expect([e.kind, e.spent]).toEqual(["server", []]);
  });

  test("an error after some output: charged as a broken stream (the bound in round 0, else the estimate)", async () => {
    const { a } = adapterWith(fromFixture("stream-error-mid.json"));
    const e = await rejection(a.chat(request()));
    expect([e.kind, e.retryable, isBound(e.spent)]).toEqual(["server", true, true]);
  });
});

describe("broken streams, charged at max_tokens", () => {
  test("round 0 (no measured prompt): the attempt bound", async () => {
    const { a } = adapterWith(fromFixture("stream-broken.json"));
    const e = await rejection(a.chat(request()));
    expect([e.kind, e.retryable, isBound(e.spent)]).toEqual(["connection", true, true]);
  });

  test("later in a turn: the agent's own prompt estimate and the full max_tokens", async () => {
    const { a } = adapterWith((_c, n) =>
      responseOf(fixture("openrouter", n === 0 ? "stream-tool-calls.json" : "stream-broken.json")),
    );
    const e0 = [BRIEFING, HEADER];
    const r0 = await a.chat(request(e0));
    const results: Entry = {
      role: "user",
      parts: [
        { kind: "result", callId: "call_a1", content: '{"ok":true}', isError: false },
        { kind: "result", callId: "call_a2", content: '{"ok":true}', isError: false },
      ],
    };
    const e1 = [...e0, { role: "assistant" as const, reply: r0.reply }, results];
    const e = await rejection(a.chat(request(e1)));
    const served = r0.usage[0]?.tokens;
    if (served === undefined) throw new Error("no usage");
    const agent = promptEstimate(
      e1,
      { prompt: promptTokens(served), output: served.output, entries: e0.length },
      0,
    );
    expect(e.kind).toBe("connection");
    expect(e.spent).toEqual([
      {
        model: "z-ai/glm-5.3",
        kind: "message",
        tokens: { input: agent, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 32_768 },
        estimated: true,
      },
    ]);
  });

  test("cut after its usage: the usage, flagged estimated", async () => {
    const { a } = adapterWith(fromFixture("stream-broken-after-usage.json"));
    const e = await rejection(a.chat(request()));
    expect(e.kind).toBe("connection");
    expect(e.spent).toEqual([
      {
        model: "z-ai/glm-5.3",
        kind: "message",
        tokens: {
          input: 4000,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheRead: 0,
          output: 120,
          reasoning: 80,
        },
        estimated: true,
      },
    ]);
  });

  test("aborted mid-stream: aborted, and charged", async () => {
    const ctl = new AbortController();
    const first = `data: ${JSON.stringify({ id: "g", model: "z-ai/glm-5.3", choices: [{ index: 0, delta: { content: "x" } }] })}\n\n`;
    const { a } = adapterWith(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(first));
          setTimeout(() => ctl.abort(), 10);
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const e = await rejection(a.chat({ ...request(), signal: ctl.signal }));
    expect([e.kind, isBound(e.spent)]).toEqual(["aborted", true]);
  });

  test("cut by its own deadline before the headers: a timeout, charged (the provider may still bill)", async () => {
    const { a } = adapterWith(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          void call;
          setTimeout(() => reject(new Error("unreachable")), 5_000);
        }),
      { timeoutMs: 20, time: new harness.SystemTime() },
    );
    const e = await rejection(a.chat(request()));
    expect([e.kind, isBound(e.spent)]).toEqual(["timeout", true]);
  });
});

describe("the served endpoint (routing metadata)", () => {
  test("another provider than the pin's: charged, and refused", async () => {
    const { a } = adapterWith(fromFixture("stream-wrong-endpoint.json"));
    const e = await rejection(a.chat(request()));
    expect(e.kind).toBe("bad_request");
    expect(e.retryable).toBe(false);
    expect(e.message).toContain(
      "openrouter served the provider Together instead of the pin z-ai/glm-5.3@z-ai/fp8 (Z.AI)",
    );
    expect(e.spent[0]?.tokens).toMatchObject({ input: 4000, output: 120 });
    expect(costOf(e.spent, OR_CTX).nanoUsd).toBeGreaterThan(0);
  });

  test("no metadata: refused (the endpoint cannot be checked), charged", async () => {
    const { a } = adapterWith(fromFixture("stream-no-metadata.json"));
    const e = await rejection(a.chat(request()));
    expect(e.kind).toBe("bad_request");
    expect(e.message).toContain("no openrouter_metadata");
    expect(e.spent.length).toBe(1);
  });
});

describe("the preflight", () => {
  const endpoints = JSON.stringify(
    Reflect.get(
      Object(
        JSON.parse(readFileSync(join(FIX, "openrouter", "endpoints-z-ai_glm-5.3.json"), "utf8")),
      ),
      "response",
    ),
  );

  test("the endpoint listed (free), then the production shape at 16 tokens, charged", async () => {
    const { a, calls } = adapterWith((c) =>
      c.method === "GET"
        ? new Response(endpoints, { headers: { "content-type": "application/json" } })
        : responseOf(fixture("openrouter", "stream-summary.json")),
    );
    const sample = request();
    const report = await a.preflight(sample);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", `${BASE}/models/z-ai/glm-5.3/endpoints`],
      ["POST", `${BASE}/chat/completions`],
    ]);
    expect(Reflect.get(Object(calls[1]?.body), "max_tokens")).toBe(16);
    expect([report.model, report.allowedFallbackModels, report.usage[0]?.tokens.input]).toEqual([
      "z-ai/glm-5.3",
      [],
      4000,
    ]);
  });

  test("an endpoint the model does not list fails before any charge", async () => {
    const { a, calls } = adapterWith(
      () => new Response(endpoints, { headers: { "content-type": "application/json" } }),
      {
        spec: specOf({ endpoint: "nope/fp8" }),
        endpoint: { tag: "nope/fp8", providerName: null, supportedParams: [], zdr: false },
      },
    );
    const e = await rejection(a.preflight(request()));
    expect([e.kind, e.spent, calls.length]).toEqual(["not_found", [], 1]);
  });

  test("an unknown usage in the shape check is charged its own finite bound (the arena prices it)", async () => {
    const { a } = adapterWith((c) =>
      c.method === "GET"
        ? new Response(endpoints, { headers: { "content-type": "application/json" } })
        : responseOf(fixture("openrouter", "stream-bad-usage.json")),
    );
    const sample = request();
    const e = await rejection(a.preflight(sample));
    expect(e.spent).toEqual([
      {
        model: "z-ai/glm-5.3",
        kind: "message",
        tokens: {
          input: promptBytesUpper(sample),
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheRead: 0,
          output: 16,
        },
        estimated: true,
      },
    ]);
    expect(costOf(e.spent, OR_CTX).nanoUsd).toBeGreaterThan(0);
  });
});

describe("prefix stability", () => {
  test("a turn's rounds keep every byte of the previous request: tools, system blocks, messages", async () => {
    const { a, calls } = adapterWith((_c, n) =>
      responseOf(fixture("openrouter", n === 0 ? "stream-tool-calls.json" : "stream-summary.json")),
    );
    const e0 = [BRIEFING, HEADER];
    const r0 = await a.chat(request(e0));
    const e1: Entry[] = [
      ...e0,
      { role: "assistant", reply: r0.reply },
      {
        role: "user",
        parts: [
          { kind: "result", callId: "call_a1", content: '{"ok":true}', isError: false },
          { kind: "result", callId: "call_a2", content: '{"ok":true}', isError: false },
        ],
      },
      { role: "operator", text: "Round trip 2 of 8." },
    ];
    await a.chat(request(e1));
    const [b0, b1] = calls.map((c) => c.body);
    const m0: unknown = Reflect.get(Object(b0), "messages");
    const m1: unknown = Reflect.get(Object(b1), "messages");
    if (!Array.isArray(m0) || !Array.isArray(m1)) throw new Error("no messages");
    expect(JSON.stringify(m1.slice(0, m0.length))).toBe(JSON.stringify(m0));
    expect(JSON.stringify(Reflect.get(Object(b1), "tools"))).toBe(
      JSON.stringify(Reflect.get(Object(b0), "tools")),
    );
    // The reasoning details go back exactly as they came.
    expect(m1[m0.length]).toEqual(r0.reply.native);
    const raw = JSON.stringify(calls[1]?.body);
    expect(raw.indexOf(JSON.stringify(m0).slice(1, -1))).toBeGreaterThan(0);
  });
});
