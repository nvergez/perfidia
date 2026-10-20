import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z, type Sleep, type TimeSource } from "@perfidia/protocol";
import { arenaEnv } from "../arena/plan.ts";
import { PREFLIGHT_OUTPUT_TOKENS } from "../arena/preflight.ts";
import {
  ModelError,
  isBreakerKind,
  isOperatorKind,
  type ChatRequest,
  type Effort,
  type Entry,
  type ModelReply,
  type ModelSpec,
  type UsageEntry,
} from "./adapter.ts";
import {
  GEMINI_PREFLIGHT_OUTPUT_TOKENS,
  GeminiAdapter,
  GeminiClient,
  billedModel,
  classifyGeminiError,
  durationMs,
  geminiUsage,
  stopOf,
  thinkingLevelOf,
} from "./gemini.ts";
import type { HttpFetch } from "./http.ts";
import { costOf } from "./prices.ts";
import { modelTools } from "./tools.ts";
import {
  GeminiCountTokensRequestSchema,
  GeminiRequestSchema,
  type GeminiRequest,
} from "./wire/gemini.ts";

// The Gemini adapter's contract (phase-4 design §2.4, §8.1): the real adapter against a stub
// `fetch` answering with the synthetic fixtures of `fixtures/gemini/` (written from the docs,
// `synthetic: true`). Pinned request bodies; one fetch per attempt, the origin only, the key in its
// header and never in a URL, `redirect: "error"`; the echo of thought signatures; usage mapped never
// under the bill; every finish reason; every error by its code; broken streams charged at the full
// output limit. Nothing here touches the network (one test uses two loopback servers).

const BASE = "https://gemini.test.invalid";
const KEY = "gm-test-key-perfidia";
const OCT = "2026-10-20T12:00:00.000Z";
const FIXTURES = join(import.meta.dir, "fixtures", "gemini");

const fixture = (name: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
  if (v === null || typeof v !== "object" || Array.isArray(v))
    throw new Error(`${name}: not an object`);
  return Object.fromEntries(Object.entries(v));
};
const events = (name: string): unknown[] => {
  const e = fixture(name)["events"];
  if (!Array.isArray(e)) throw new Error(`${name}: no events`);
  return e;
};
const finishes = (key: string): unknown[] => {
  const all = fixture("stream-finishes.json")["streams"];
  const e: unknown = all !== null && typeof all === "object" ? Reflect.get(all, key) : undefined;
  if (!Array.isArray(e)) throw new Error(`no stream ${key}`);
  return e;
};

const ARGON: ModelSpec = {
  provider: "google",
  model: "gemini-4-argon",
  effort: "medium",
  maxOutputTokens: 32_768,
  cacheTtl: "5m",
  fallbacks: "off",
};

const TOOLS = modelTools([
  {
    name: "view_city",
    description: "One city.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string", pattern: "^c[1-9][0-9]*$" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
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

/** A time source whose timers fire when the test advances it. */
class ManualTime implements TimeSource {
  now = 1_000;
  private sleeps: { readonly ms: number; readonly resolve: () => void }[] = [];
  nowMs(): number {
    return this.now;
  }
  sleepUntil(ms: number): Sleep {
    const { promise, resolve } = Promise.withResolvers<void>();
    const s = { ms, resolve };
    this.sleeps.push(s);
    return { done: promise, cancel: () => void (this.sleeps = this.sleeps.filter((x) => x !== s)) };
  }
  advance(ms: number): void {
    this.now += ms;
    for (const s of this.sleeps.filter((x) => x.ms <= this.now)) {
      this.sleeps = this.sleeps.filter((x) => x !== s);
      s.resolve();
    }
  }
}

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  readonly redirect: string | undefined;
}

type Answer = Response | Error | ((signal: AbortSignal | null) => Response | Promise<Response>);

/** A `fetch` stub answering in order; it records every request the guard lets through. */
function stub(...answers: Answer[]): { readonly fetch: HttpFetch; readonly sent: Sent[] } {
  const sent: Sent[] = [];
  let i = 0;
  const fetch: HttpFetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init?.body === "string" ? init.body : null;
    sent.push({
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      headers,
      body,
      redirect: init?.redirect,
    });
    const a = answers[i] ?? new Error(`stub: no answer ${i + 1}`);
    i += 1;
    if (a instanceof Error) throw a;
    return typeof a === "function" ? a(init?.signal ?? null) : a;
  };
  return { fetch, sent };
}

/** An SSE body of these events, CRLF as the API sends them. */
const sseOf = (evs: readonly unknown[]): string =>
  evs.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("");
const sse = (evs: readonly unknown[]): Response =>
  new Response(sseOf(evs), { status: 200, headers: { "content-type": "text/event-stream" } });
const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function adapter(
  answers: Answer[],
  o: {
    readonly spec?: Partial<ModelSpec>;
    readonly time?: TimeSource;
    readonly base?: string;
  } = {},
) {
  const s = stub(...answers);
  const time = o.time ?? new ManualTime();
  const client = new GeminiClient({ apiKey: KEY, baseURL: o.base ?? BASE, time, fetch: s.fetch });
  return { a: new GeminiAdapter({ ...ARGON, ...o.spec }, client), sent: s.sent, time };
}

async function rejected(p: Promise<unknown>): Promise<ModelError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ModelError) return e;
    throw e;
  }
  throw new Error("expected a ModelError");
}

const bodyOf = (s: Sent | undefined): unknown => JSON.parse(s?.body ?? "null");

/** A JSON value checked to be an object. */
function asRecord(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
  return Object.fromEntries(Object.entries(v));
}

/** A JSON value checked to be an array. */
function asArray(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new Error("not an array");
  const list: readonly unknown[] = v;
  return [...list];
}

/** A deep copy of a JSON value through text (with `edit` applied to the text). */
const copy = (v: unknown, edit: (text: string) => string = (x) => x): unknown =>
  JSON.parse(edit(JSON.stringify(v)));

/** The parts of the first candidate of each event, in order. */
const partsOf = (evs: readonly unknown[]): unknown[] =>
  evs.flatMap((e) => {
    const c = asArray(asRecord(e)["candidates"])[0];
    return asArray(asRecord(asRecord(c)["content"])["parts"]);
  });
const utf8 = (s: string): number => new TextEncoder().encode(s).length;
const argonAt = (usage: readonly UsageEntry[]) =>
  costOf(usage, { provider: "google", endpoint: null, at: OCT });

/** An expectation on a value as `unknown` (a tuple of mixed types). */
const expectLoose = (v: unknown) => expect(v);

/** The bytes of a request that must not change across a turn's rounds. */
const stable = (b: GeminiRequest): string =>
  JSON.stringify([b.systemInstruction, b.tools, b.toolConfig, b.generationConfig, b.store]);

/** One call of the round-0 request against one of the finish streams. */
const runFinish = async (key: string) => {
  const { a } = adapter([sse(finishes(key))]);
  return a.chat(request([BRIEFING, HEADER]));
};

/** The fallback usage of the usage tests. */
const fallbackUsage = (): UsageEntry => ({
  model: "gemini-4-argon",
  kind: "message",
  tokens: { input: 7, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 7 },
  estimated: true,
});

/** A 200 whose body sends `first` and then hangs until the request's signal aborts. */
const hanging = (first: unknown) => (signal: AbortSignal | null) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sseOf([first])));
        signal?.addEventListener("abort", () => c.error(signal.reason));
      },
    }),
    { status: 200 },
  );

/** A request with no answer until its signal aborts (the model may be thinking). */
const silent = (signal: AbortSignal | null) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

/** A transport error with a Bun-style `code`. */
const coded = (code: string) => Object.assign(new TypeError(`${code}: failed`), { code });

/** A 429 body with a RetryInfo delay. */
const retryBody = (delay: string) => ({
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }],
  },
});

/** The requests one parallel-calls chat sends. */
const runParallel = async () => {
  const { a, sent } = adapter([sse(events("stream-parallel-calls.json"))]);
  await a.chat(request([BRIEFING, HEADER]));
  return sent;
};

/** The reply the parallel-calls fixture streams. */
async function parallelReply(): Promise<ModelReply> {
  const { a } = adapter([sse(events("stream-parallel-calls.json"))]);
  return (await a.chat(request([BRIEFING, HEADER]))).reply;
}

// Requests -----------------------------------------------------------------------------------------

describe("requests", () => {
  test("round 0: the pinned body, one fetch to the origin, the key in x-goog-api-key, redirect error", async () => {
    const { a, sent } = adapter([sse(events("stream-parallel-calls.json"))]);
    const req = request([BRIEFING, HEADER]);
    const body = a.build(req);
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: "SHARED BLOCK" }, { text: "SEAT BLOCK p1" }] },
      contents: [
        {
          role: "user",
          parts: [{ text: '{"t":0}' }, { text: "[harness] Turn 1 · round trip 1 of 8." }],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "view_city",
              description: "One city.",
              parametersJsonSchema: {
                type: "object",
                properties: {
                  city: {
                    type: "string",
                    description: "Must match the regular expression ^c[1-9][0-9]*$.",
                  },
                },
                required: ["city"],
                additionalProperties: false,
              },
            },
            {
              name: "view_map",
              description: "The map.",
              parametersJsonSchema: { type: "object", properties: {}, additionalProperties: false },
            },
            {
              name: "end_turn",
              description: "Ends the turn.",
              parametersJsonSchema: {
                type: "object",
                properties: { nextWakeIn: { type: "integer", minimum: 1 } },
                additionalProperties: false,
              },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: {
        maxOutputTokens: 32_768,
        thinkingConfig: { thinkingLevel: "MEDIUM", includeThoughts: true },
      },
      store: false,
    });
    expect(GeminiRequestSchema.parse(body)).toEqual(body);
    await a.chat(req);
    expect(sent.length).toBe(1);
    const s = sent[0];
    expect(s?.url).toBe(`${BASE}/v1beta/models/gemini-4-argon:streamGenerateContent?alt=sse`);
    expect(s?.method).toBe("POST");
    expect(s?.redirect).toBe("error");
    expect(s?.headers).toEqual({
      accept: "text/event-stream",
      "content-type": "application/json",
      "x-goog-api-key": KEY,
    });
    expect(s?.url.includes(KEY)).toBe(false);
    expect(bodyOf(s)).toEqual(body);
  });

  test("effort is Gemini's thinkingLevel; a level the model does not take is refused", () => {
    const level = (model: string, effort: Effort) =>
      new GeminiAdapter(
        { ...ARGON, model, effort },
        new GeminiClient({ apiKey: KEY, baseURL: BASE, time: new ManualTime() }),
      ).build(request([BRIEFING])).generationConfig.thinkingConfig.thinkingLevel;
    for (const model of ["gemini-4-argon", "gemini-3.8-flash"]) {
      expect([level(model, "low"), level(model, "medium"), level(model, "high")]).toEqual([
        "LOW",
        "MEDIUM",
        "HIGH",
      ]);
      for (const e of ["minimal", "none", "xhigh", "max"] as const) {
        expect(() => level(model, e)).toThrow(
          `${model} takes the efforts low, medium, high (Gemini's thinkingLevel), not ${e}`,
        );
      }
    }
    // A model that takes `minimal` maps it (the catalog lists none today).
    expect(thinkingLevelOf("x", "minimal", { efforts: ["minimal", "low"] })).toBe("MINIMAL");
    // The synchronous output limit (thinking included) bounds the retry: 65,536 at most.
    expect(() => adapter([], { spec: { maxOutputTokens: 65_537 } })).toThrow(
      "gemini-4-argon takes at most 65536 output tokens per request, got 65537",
    );
    const { a } = adapter([]);
    expect(
      a.build(request([BRIEFING], { maxOutputTokens: 65_536 })).generationConfig.maxOutputTokens,
    ).toBe(65_536);
    expect(() => a.build(request([BRIEFING], { maxOutputTokens: 70_000 }))).toThrow(
      "at most 65536",
    );
  });

  test("the reply goes back verbatim (signatures on their parts, never merged); results by id and name; harness text after them", async () => {
    const reply = await parallelReply();
    const { a } = adapter([]);
    const results: Entry = {
      role: "user",
      parts: [
        { kind: "result", callId: "fc-a", content: '{"ok":true,"city":"c1"}', isError: false },
        { kind: "result", callId: "fc-b", content: '{"ok":false,"code":"X"}', isError: true },
      ],
    };
    const body = a.build(
      request(
        [
          BRIEFING,
          HEADER,
          { role: "assistant", reply },
          results,
          { role: "operator", text: "Round trip 2 of 8." },
        ],
        { meta: { seat: "p1", turn: 1, round: 1, maxRounds: 8, maxCalls: 10, kind: "round" } },
      ),
    );
    const parts = partsOf(events("stream-parallel-calls.json"));
    expectLoose(body.contents[1]).toEqual({ role: "model", parts });
    expect(JSON.stringify(body.contents[1]?.parts)).toBe(JSON.stringify(parts));
    expect(body.contents[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { id: "fc-a", name: "view_city", response: { ok: true, city: "c1" } } },
        { functionResponse: { id: "fc-b", name: "view_map", response: { ok: false, code: "X" } } },
        { text: "[harness] Round trip 2 of 8." },
      ],
    });
    expect(GeminiRequestSchema.safeParse(body).success).toBe(true);
    // Calls without an id: the adapter's own ids, none sent back; results matched by order.
    const noIds = events("stream-parallel-calls.json").map((e) =>
      copy(e, (t) => t.replaceAll('"id":"fc-a",', "").replaceAll('"id":"fc-b",', "")),
    );
    const { a: b } = adapter([sse(noIds)]);
    const bare = (await b.chat(request([BRIEFING, HEADER]))).reply;
    expect(bare.calls.map((c) => c.callId)).toEqual(["gemini-1-0-0", "gemini-1-0-1"]);
    const back = b.build(
      request([
        BRIEFING,
        HEADER,
        { role: "assistant", reply: bare },
        {
          role: "user",
          parts: bare.calls.map((c) => ({
            kind: "result",
            callId: c.callId,
            content: "plain text",
            isError: false,
          })),
        },
      ]),
    );
    expect(back.contents[2]?.parts).toEqual([
      { functionResponse: { name: "view_city", response: { result: "plain text" } } },
      { functionResponse: { name: "view_map", response: { result: "plain text" } } },
    ]);
    // A result for a call the reply did not make is a harness bug, refused.
    expect(() =>
      a.build(
        request([
          BRIEFING,
          HEADER,
          { role: "assistant", reply },
          {
            role: "user",
            parts: [{ kind: "result", callId: "nope", content: "{}", isError: false }],
          },
        ]),
      ),
    ).toThrow("entry 3: no call nope in the reply before it");
  });

  test("prefix stability: every round's request starts with the previous one's bytes", async () => {
    const reply = await parallelReply();
    const { a } = adapter([]);
    const round = (r: number): ChatRequest => {
      const entries: Entry[] = [BRIEFING, HEADER];
      for (let k = 0; k < r; k += 1) {
        entries.push(
          { role: "assistant", reply },
          {
            role: "user",
            parts: [
              { kind: "result", callId: "fc-a", content: `{"ok":true,"k":${k}}`, isError: false },
              { kind: "result", callId: "fc-b", content: `{"ok":true,"k":${k}}`, isError: false },
            ],
          },
        );
        if (k === 2) entries.push({ role: "operator", text: "Round trip 4 of 4, the last." });
      }
      return request(entries, {
        meta: { seat: "p1", turn: 1, round: r, maxRounds: 4, maxCalls: 10, kind: "round" },
      });
    };
    const bodies = [0, 1, 2, 3].map((r) => a.build(round(r)));
    for (const [r, b] of bodies.entries()) {
      expect(stable(b)).toBe(stable(bodies[0] ?? b));
      const next = bodies[r + 1];
      if (next === undefined) continue;
      expect(next.contents.length).toBeGreaterThan(b.contents.length);
      for (const [k, c] of b.contents.entries()) {
        expect(JSON.stringify(next.contents[k])).toBe(JSON.stringify(c));
      }
    }
    // The tool declarations are built once per tool list: the same objects every round.
    expect(bodies[3]?.tools[0]?.functionDeclarations).toBe(
      bodies[0]?.tools[0]?.functionDeclarations,
    );
    // The max_tokens retry changes the output limit only.
    const retry = a.build({ ...round(2), maxOutputTokens: 65_536 });
    expectLoose({ ...retry, generationConfig: null }).toEqual({
      ...bodies[2],
      generationConfig: null,
    });
    expect(retry.generationConfig.maxOutputTokens).toBe(65_536);
  });
});

// Responses ----------------------------------------------------------------------------------------

describe("responses", () => {
  test("parallel calls with a thought summary: the reply, the usage (thoughts as output), the cost at Argon's card", async () => {
    const { a } = adapter([sse(events("stream-parallel-calls.json"))]);
    const res = await a.chat(request([BRIEFING, HEADER]));
    expect([res.stop, res.rawStop, res.servedBy, res.requestId, res.fallback]).toEqual([
      "tool_use",
      "STOP",
      "gemini-4-argon",
      "resp-parallel-1",
      false,
    ]);
    expect(res.reply.calls).toEqual([
      { callId: "fc-a", name: "view_city", args: { city: "c1" } },
      { callId: "fc-b", name: "view_map", args: {} },
    ]);
    expect([res.reply.text, res.reply.reasoning, res.reply.reasoningKind]).toEqual([
      [],
      ["Checking the island before building."],
      "summary",
    ]);
    expect(res.usage).toEqual([
      {
        model: "gemini-4-argon",
        kind: "message",
        tokens: {
          input: 4000,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheRead: 8000,
          output: 940,
          reasoning: 900,
        },
        estimated: false,
      },
    ]);
    // 4,000 × $2 + 8,000 × $0.10 + 940 × $10 per million tokens.
    const cost = argonAt(res.usage);
    expect([cost.nanoUsd, cost.cards, cost.unpriced]).toEqual([
      18_200_000,
      ["google:gemini-4-argon@2026-10-20"],
      [],
    ]);
  });

  test("text deltas join; the signature on an empty last part is echoed, never shown", async () => {
    const { a } = adapter([sse(events("stream-text-signature-last.json"))], {
      spec: { model: "gemini-3.8-flash", effort: "low" },
    });
    const res = await a.chat(request([BRIEFING, HEADER]));
    expect([res.stop, res.reply.text, res.reply.calls]).toEqual([
      "end_turn",
      ["I hold the strait and wait."],
      [],
    ]);
    expect(res.reply.native).toEqual([
      { text: "I hold the strait " },
      { text: "and wait." },
      { text: "", thoughtSignature: "U2lnbmF0dXJlX0M=" },
    ]);
    expect(res.usage[0]?.tokens).toEqual({
      input: 9000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 212,
      reasoning: 200,
    });
    expect(res.usage[0]?.model).toBe("gemini-3.8-flash");
  });

  test("every finish reason of the API maps to a stop", () => {
    const table: Record<string, string> = {
      STOP: "end_turn",
      MAX_TOKENS: "max_tokens",
      CONTINUATION: "max_tokens",
      SAFETY: "refusal",
      PROHIBITED_CONTENT: "refusal",
      BLOCKLIST: "refusal",
      SPII: "refusal",
      RECITATION: "refusal",
      LANGUAGE: "refusal",
      ESCALATION: "refusal",
      IMAGE_SAFETY: "refusal",
      IMAGE_PROHIBITED_CONTENT: "refusal",
      IMAGE_RECITATION: "refusal",
      MALFORMED_FUNCTION_CALL: "other",
      TOO_MANY_TOOL_CALLS: "other",
      UNEXPECTED_TOOL_CALL: "other",
      MALFORMED_RESPONSE: "other",
      OTHER: "other",
      IMAGE_OTHER: "other",
      NO_IMAGE: "other",
      FINISH_REASON_UNSPECIFIED: "other",
      SOMETHING_NEW: "other",
    };
    for (const [finish, stop] of Object.entries(table))
      expect([finish, stopOf(finish, 0)]).toEqual([finish, stop]);
    expect(stopOf("STOP", 2)).toBe("tool_use");
  });

  test("truncation, refusals, a malformed call and a blocked prompt close the turn, each charged", async () => {
    const max = await runFinish("max-tokens");
    expect([
      max.stop,
      max.rawStop,
      max.usage[0]?.tokens.output,
      max.usage[0]?.tokens.reasoning,
    ]).toEqual(["max_tokens", "MAX_TOKENS", 32_768, 32_768]);
    const safety = await runFinish("safety");
    expect([safety.stop, safety.refusal, safety.reply.native, safety.reply.text]).toEqual([
      "refusal",
      {
        category: "safety",
        explanation: "The response was blocked for safety.",
        recommendedModel: null,
      },
      [],
      [],
    ]);
    expect(safety.usage[0]?.tokens.output).toBe(123);
    const malformed = await runFinish("malformed-function-call");
    expect([malformed.stop, malformed.rawStop, malformed.usage[0]?.tokens.output]).toEqual([
      "other",
      "MALFORMED_FUNCTION_CALL",
      400,
    ]);
    const blocked = await runFinish("blocked-prompt");
    expect([blocked.stop, blocked.refusal?.category, blocked.usage[0]?.tokens.input]).toEqual([
      "refusal",
      "prohibited_content",
      10_000,
    ]);
  });

  test("MISSING_THOUGHT_SIGNATURE is an adapter bug (bad_request, the breaker), PUP_LIMITED_DISABLED the operator's (auth); both charged", async () => {
    const { a } = adapter([sse(finishes("missing-thought-signature"))]);
    const e = await rejected(a.chat(request([BRIEFING, HEADER])));
    expect([e.kind, e.retryable, isBreakerKind(e.kind), e.spent[0]?.tokens.input]).toEqual([
      "bad_request",
      false,
      true,
      10_000,
    ]);
    const pup = asArray(
      copy(finishes("missing-thought-signature"), (x) =>
        x.replace("MISSING_THOUGHT_SIGNATURE", "PUP_LIMITED_DISABLED"),
      ),
    );
    const { a: b } = adapter([sse(pup)]);
    const p = await rejected(b.chat(request([BRIEFING, HEADER])));
    expect([p.kind, isOperatorKind(p.kind), p.spent.length]).toEqual(["auth", true, 1]);
  });
});

// Usage --------------------------------------------------------------------------------------------

/** `usageMetadata` mapped for Argon, with the usage tests' fallback. */
const tokens = (raw: unknown, served: string | null = null) =>
  geminiUsage(raw, "gemini-4-argon", fallbackUsage, served);

describe("usage, never under the bill", () => {
  test("prompt includes the cached part; tool-use prompt is input; thoughts and any uncounted total are output", () => {
    expect(
      tokens({
        promptTokenCount: 1000,
        cachedContentTokenCount: 600,
        toolUsePromptTokenCount: 50,
        candidatesTokenCount: 30,
        thoughtsTokenCount: 70,
        totalTokenCount: 1150,
      }).tokens,
    ).toEqual({
      input: 450,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 600,
      output: 100,
      reasoning: 70,
    });
    // A total beyond prompt + tool use + thoughts + candidates: the rest is charged as output.
    expect(
      tokens({ promptTokenCount: 1000, candidatesTokenCount: 10, totalTokenCount: 1500 }).tokens
        .output,
    ).toBe(500);
    // Cached tokens beyond the prompt count (a count apart?): charged both as input and as reads.
    expect(tokens({ promptTokenCount: 100, cachedContentTokenCount: 400 }).tokens).toMatchObject({
      input: 100,
      cacheRead: 400,
    });
    // Proto3 omits zeros: a usage with the prompt alone is a valid one.
    expect(tokens({ promptTokenCount: 100 }).tokens).toMatchObject({
      input: 100,
      output: 0,
      reasoning: 0,
    });
  });

  test("a usage of unknown shape is charged conservatively, never 0", () => {
    for (const raw of [
      undefined,
      null,
      "12",
      {},
      { promptTokenCount: 0 },
      { promptTokenCount: -1 },
      { promptTokenCount: 1.5 },
      { promptTokenCount: "100" },
      { promptTokenCount: 100, candidatesTokenCount: 2 ** 60 },
    ]) {
      expect([raw, tokens(raw)]).toEqual([raw, fallbackUsage()]);
    }
  });

  test("a dearer service tier or another served model is billed at no card (the highest price)", () => {
    expect(billedModel("gemini-4-argon", null, "STANDARD")).toBe("gemini-4-argon");
    expect(billedModel("gemini-4-argon", null, "flex")).toBe("gemini-4-argon");
    expect(billedModel("gemini-4-argon", "gemini-4-argon", "unspecified")).toBe("gemini-4-argon");
    const priority = tokens({ promptTokenCount: 1000, serviceTier: "priority" });
    expect(priority.model).toBe("gemini-4-argon (priority tier)");
    const other = tokens({ promptTokenCount: 1000 }, "gemini-4-argon-preview-10-2026");
    for (const u of [priority, other]) {
      const c = argonAt([u]);
      expect([c.unpriced.length, c.cards]).toEqual([1, ["max"]]);
      expect(c.nanoUsd).toBeGreaterThan(argonAt([{ ...u, model: "gemini-4-argon" }]).nanoUsd);
    }
  });

  test("a stream that finishes without its final usage keeps its reply and is charged the estimate", async () => {
    const evs = events("stream-parallel-calls.json");
    const last = asRecord(copy(evs.at(-1)));
    delete last["usageMetadata"];
    const { a } = adapter([sse([...evs.slice(0, -1), last])]);
    const req = request([BRIEFING, HEADER]);
    const res = await a.chat(req);
    expect(res.reply.calls.length).toBe(2);
    expect(res.usage).toEqual([
      {
        model: "gemini-4-argon",
        kind: "message",
        tokens: {
          input: utf8(JSON.stringify(a.build(req))),
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          cacheRead: 0,
          output: 32_768,
        },
        estimated: true,
      },
    ]);
    // A partial usage before the finish gives the estimate its prompt count, not its output.
    const partial = [
      { ...asRecord(evs[0]), usageMetadata: { promptTokenCount: 5000, totalTokenCount: 5000 } },
      ...evs.slice(1, -1),
      last,
    ];
    const { a: b } = adapter([sse(partial)]);
    const r2 = await b.chat(req);
    expect([r2.usage[0]?.tokens.input, r2.usage[0]?.tokens.output, r2.usage[0]?.estimated]).toEqual(
      [5000, 32_768, true],
    );
  });
});

// Broken streams and transport ----------------------------------------------------------------------

describe("broken streams and transport", () => {
  const req = request([BRIEFING, HEADER]);
  const estimate = (a: GeminiAdapter, input?: number): UsageEntry[] => [
    {
      model: "gemini-4-argon",
      kind: "message",
      tokens: {
        input: input ?? utf8(JSON.stringify(a.build(req))),
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        output: 32_768,
      },
      estimated: true,
    },
  ];

  test("a stream cut before its finish (or inside its last event) is a retryable connection error charged at max_tokens", async () => {
    const evs = events("stream-parallel-calls.json");
    const cut = sseOf(evs.slice(0, 2));
    const { a } = adapter([new Response(cut, { status: 200 })]);
    const e = await rejected(a.chat(req));
    expectLoose([e.kind, e.retryable, e.spent]).toEqual(["connection", true, estimate(a)]);
    const inside = sseOf(evs).slice(0, -3);
    const { a: b } = adapter([new Response(inside, { status: 200 })]);
    const e2 = await rejected(b.chat(req));
    expectLoose([e2.kind, e2.spent]).toEqual(["connection", estimate(b)]);
  });

  test("an event that is not JSON, or not a response, is unknown (the breaker), charged, never echoed", async () => {
    for (const body of [`data: {"candidates":\r\n\r\n`, `data: {"candidates":"${KEY}"}\r\n\r\n`]) {
      const { a } = adapter([new Response(body, { status: 200 })]);
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const e = await rejected(a.chat(req));
      expectLoose([e.kind, isBreakerKind(e.kind), e.spent]).toEqual(["unknown", true, estimate(a)]);
      expect(e.message).not.toContain(KEY);
      expect(e.message).not.toContain("candidates");
    }
  });

  test("an error event inside the stream is classified by its status, charged", async () => {
    const evs = events("stream-parallel-calls.json");
    const err = { error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } };
    const { a } = adapter([sse([evs[0], err])]);
    const e = await rejected(a.chat(req));
    expectLoose([e.kind, e.retryable, e.status, e.spent]).toEqual([
      "overloaded",
      true,
      503,
      estimate(a),
    ]);
  });

  test("an abort or the backstop timer mid-stream: aborted or timeout, charged; before any byte: the same", async () => {
    const evs = events("stream-parallel-calls.json");
    const ctl = new AbortController();
    const { a } = adapter([hanging(evs[0])]);
    const p = a.chat({ ...req, signal: ctl.signal });
    await Bun.sleep(5);
    ctl.abort(new Error("round deadline"));
    const e = await rejected(p);
    expectLoose([e.kind, e.retryable, e.spent]).toEqual(["aborted", false, estimate(a)]);

    const time = new ManualTime();
    const { a: b } = adapter([hanging(evs[0])], { time });
    const q = b.chat(req);
    await Bun.sleep(5);
    time.advance(20 * 60_000);
    const t = await rejected(q);
    expectLoose([t.kind, t.retryable, t.spent]).toEqual(["timeout", true, estimate(b)]);

    // No byte yet (the model may be thinking): the same charge.
    const time2 = new ManualTime();
    const { a: c } = adapter([silent], { time: time2 });
    const r = c.chat(req);
    await Bun.sleep(5);
    time2.advance(20 * 60_000);
    const u = await rejected(r);
    expectLoose([u.kind, u.spent]).toEqual(["timeout", estimate(c)]);
  });

  test("a request that never left (refused, unknown host) costs nothing; a reset may have run, and is charged", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ConnectionRefused", "FailedToOpenSocket"]) {
      const { a } = adapter([coded(code)]);
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const e = await rejected(a.chat(req));
      expectLoose([code, e.kind, e.retryable, e.spent]).toEqual([code, "connection", true, []]);
    }
    const { a } = adapter([coded("ECONNRESET")]);
    const e = await rejected(a.chat(req));
    expectLoose([e.kind, e.spent]).toEqual(["connection", estimate(a)]);
  });

  test("the origin only: a base URL carrying the key is refused before anything is sent; http only on loopback", async () => {
    const { a, sent } = adapter([], { base: `${BASE}/?k=${KEY}` });
    const e = await rejected(a.chat(req));
    expectLoose([e.kind, e.spent, sent.length]).toEqual(["connection", [], 0]);
    expect(e.message).not.toContain(KEY);
    expect(
      () =>
        new GeminiClient({ apiKey: KEY, baseURL: "http://gemini.example", time: new ManualTime() }),
    ).toThrow("is not https");
    expect(() => new GeminiClient({ apiKey: " ", baseURL: BASE, time: new ManualTime() })).toThrow(
      "set PERFIDIA_GOOGLE_API_KEY",
    );
  });

  test("a redirect is never followed: the second server gets nothing (loopback, real fetch)", async () => {
    let reached = 0;
    const second = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        reached += 1;
        return new Response("{}");
      },
    });
    const first = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.redirect(`http://127.0.0.1:${second.port}/v1beta/x`, 307),
    });
    try {
      const a = new GeminiAdapter(
        ARGON,
        new GeminiClient({
          apiKey: KEY,
          baseURL: `http://127.0.0.1:${first.port}`,
          time: new ManualTime(),
        }),
      );
      const e = await rejected(a.chat(req));
      expect(e.kind).toBe("connection");
      expect(e.message).not.toContain(KEY);
      expect(reached).toBe(0);
    } finally {
      void first.stop(true);
      void second.stop(true);
    }
  });
});

// Errors -------------------------------------------------------------------------------------------

describe("errors, by their code before their status", () => {
  interface Case {
    readonly name: string;
    readonly status: number;
    readonly body: unknown;
    readonly expect: {
      readonly kind: string;
      readonly retryable: boolean;
      readonly retryAfterMs: number | null;
    };
  }
  const cases: readonly Case[] = z
    .array(
      z.object({
        name: z.string(),
        status: z.number(),
        body: z.unknown(),
        expect: z.object({
          kind: z.string(),
          retryable: z.boolean(),
          retryAfterMs: z.number().nullable(),
        }),
      }),
    )
    .parse(fixture("errors.json")["cases"]);

  test("each documented error: its kind, one fetch, nothing charged (but a 504), no body and no key in the message", async () => {
    expect(cases.length).toBe(12);
    for (const c of cases) {
      // The body echoes the key: it must not reach the message.
      const echoed = JSON.parse(
        JSON.stringify(c.body).replace('"message":"', `"message":"${KEY} `),
      ) as unknown;
      const { a, sent } = adapter([jsonRes(c.status, echoed)]);
      const req = request([BRIEFING, HEADER]);
      // oxlint-disable-next-line no-await-in-loop -- one case at a time
      const e = await rejected(a.chat(req));
      expect([c.name, e.kind, e.retryable, e.retryAfterMs, e.status]).toEqual([
        c.name,
        c.expect.kind,
        c.expect.retryable,
        c.expect.retryAfterMs,
        c.status,
      ]);
      expect([c.name, sent.length]).toEqual([c.name, 1]);
      expect([c.name, e.spent.length]).toEqual([c.name, c.status === 504 ? 1 : 0]);
      expect(e.message).not.toContain(KEY);
      expect(e.message).toMatch(/^google HTTP \d{3}/);
    }
  });

  test("Retry-After wins over RetryInfo; RetryInfo durations parse; the message names the status and reason", () => {
    expect(
      classifyGeminiError(429, new Headers({ "retry-after": "7" }), retryBody("41s")).retryAfterMs,
    ).toBe(7000);
    expect(classifyGeminiError(429, null, retryBody("0.25s")).retryAfterMs).toBe(250);
    expect([
      durationMs("41s"),
      durationMs("1.000000001s"),
      durationMs("4m"),
      durationMs("s"),
    ]).toEqual([41_000, 1001, null, null]);
    const key = cases.find((c) => c.name.startsWith("API key"));
    expect(classifyGeminiError(400, null, key?.body).code).toBe("INVALID_ARGUMENT/API_KEY_INVALID");
  });
});

// Preflight and countTokens ------------------------------------------------------------------------

describe("preflight and countTokens", () => {
  const ep = fixture("endpoints.json");
  const sample = request([
    { role: "user", parts: [{ kind: "text", text: '{"preflight":true}' }] },
    { role: "operator", text: "Turn {turn} · {time}" },
  ]);

  test("models.get, then the production shape at 16 output tokens: two fetches, the usage charged", async () => {
    expect(GEMINI_PREFLIGHT_OUTPUT_TOKENS).toBe(PREFLIGHT_OUTPUT_TOKENS);
    const { a, sent } = adapter([
      jsonRes(200, ep["modelsGet"]),
      jsonRes(200, ep["generateContent"]),
    ]);
    const report = await a.preflight(sample);
    expect(sent.map((s) => [s.method, s.url, s.body === null])).toEqual([
      ["GET", `${BASE}/v1beta/models/gemini-4-argon`, true],
      ["POST", `${BASE}/v1beta/models/gemini-4-argon:generateContent`, false],
    ]);
    const shape = GeminiRequestSchema.parse(bodyOf(sent[1]));
    expect(shape).toEqual({
      ...a.build(sample),
      generationConfig: {
        maxOutputTokens: 16,
        thinkingConfig: { thinkingLevel: "MEDIUM", includeThoughts: true },
      },
    });
    expect(shape.contents[0]?.parts.at(-1)).toEqual({ text: "[harness] Turn {turn} · {time}" });
    expect(report).toEqual({
      model: "gemini-4-argon",
      allowedFallbackModels: [],
      usage: [
        {
          model: "gemini-4-argon",
          kind: "message",
          tokens: {
            input: 11_234,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
            cacheRead: 0,
            output: 16,
            reasoning: 16,
          },
          estimated: false,
        },
      ],
    });
  });

  test("a model whose output limit is under the retry's, or that cannot generate, is refused; a 402 is billing", async () => {
    const low = { ...asRecord(ep["modelsGet"]), outputTokenLimit: 32_768 };
    const { a } = adapter([jsonRes(200, low)]);
    const e = await rejected(a.preflight(sample));
    expect([e.kind, e.message]).toEqual([
      "bad_request",
      "google: gemini-4-argon returns at most 32768 output tokens, under the catalog's 65536 (the max_tokens retry's limit): fix the catalog",
    ]);
    const embed = { ...asRecord(ep["modelsGet"]), supportedGenerationMethods: ["embedContent"] };
    const { a: b } = adapter([jsonRes(200, embed)]);
    expect((await rejected(b.preflight(sample))).kind).toBe("not_found");
    const { a: c } = adapter([
      jsonRes(200, ep["modelsGet"]),
      jsonRes(402, { error: { code: 402, status: "RESOURCE_EXHAUSTED", message: "Prepay" } }),
    ]);
    const p = await rejected(c.preflight(sample));
    expectLoose([p.kind, p.spent]).toEqual(["billing", []]);
  });

  test("countTokens: the request it counts, with its model, not billed", async () => {
    const { a, sent } = adapter([jsonRes(200, ep["countTokens"])]);
    const req = request([BRIEFING]);
    expect(await a.countTokens(req)).toBe(11_234);
    expect(sent[0]?.url).toBe(`${BASE}/v1beta/models/gemini-4-argon:countTokens`);
    const body = GeminiCountTokensRequestSchema.parse(bodyOf(sent[0]));
    const b = a.build(req);
    expect(body).toEqual({
      generateContentRequest: {
        model: "models/gemini-4-argon",
        systemInstruction: b.systemInstruction,
        contents: b.contents,
        tools: b.tools,
        toolConfig: b.toolConfig,
      },
    });
  });
});

// Environment and fixtures ---------------------------------------------------------------------------

describe("environment and fixtures", () => {
  const JUNK = {
    GEMINI_API_KEY: "junk-gemini",
    GOOGLE_API_KEY: "junk-google",
    GOOGLE_GENAI_USE_VERTEXAI: "true",
    GOOGLE_CLOUD_PROJECT: "junk",
    GOOGLE_GEMINI_BASE_URL: "https://junk.example",
  } as const;
  const saved = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
    saved.clear();
  });

  test("a junk environment has no effect: the same request, the PERFIDIA key only", async () => {
    const clean = await runParallel();
    for (const [k, v] of Object.entries(JUNK)) {
      saved.set(k, process.env[k]);
      process.env[k] = v;
    }
    expect(await runParallel()).toEqual(clean);
    expect(JSON.stringify(clean)).not.toContain("junk");
    // The plan reads the PERFIDIA_GOOGLE_* variables only.
    const env = arenaEnv({ ...JUNK, PERFIDIA_GOOGLE_BASE_URL: "https://perfidia.example" });
    expect(env.providers?.["google"]).toEqual({
      apiKey: null,
      baseURL: "https://perfidia.example",
    });
  });

  test("every fixture is synthetic, dated and cites its sources", () => {
    const names = readdirSync(FIXTURES).filter((n) => n.endsWith(".json"));
    expect(names.length).toBe(5);
    for (const n of names) {
      const f = fixture(n);
      expect([n, f["synthetic"], f["checked"]]).toEqual([n, true, "2026-10-20"]);
      const sources = f["sources"];
      expect(Array.isArray(sources) && sources.length > 0).toBe(true);
      for (const s of z.array(z.string()).parse(sources)) expect(s).toMatch(/^https:\/\//);
    }
  });
});
