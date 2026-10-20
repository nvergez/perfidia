// The cross-adapter conformance suite (phase-4 design §8.3–§8.4, the Pass 2 integration): one
// scripted conversation through every real adapter (Anthropic Messages, OpenAI Responses, Gemini
// `generateContent`, OpenRouter Chat Completions) and its wire stub on 127.0.0.1
// (`wire-stubs.test.ts`). The stubs encode the same provider-neutral replies in each protocol, so
// every adapter must give back the same calls (names and arguments), text, reasoning text, stop
// reasons and usage: per attempt and summed, the prompt (uncached + written + read), the cache
// reads, the output and, where the provider reports it, the reasoning. Gemini has no cache writes:
// what the others write it bills as plain prompt tokens, so its `input` holds them.
//
// The conversation is one turn as the seat agent drives it: round 0 (the briefing and the turn
// header; two calls), round 1 (their results) cut at `max_tokens`, its retry at 65,536 (an
// `end_turn` call and no text), then the out-of-band thought call (the queued result and the
// operator's ask; a text). Prefix stability per adapter: the tools and both stable blocks are
// byte-identical in every request, and each request's conversation extends the previous one item
// by item (the retry resends it unchanged). One request per attempt, nothing else sent, each key in
// its own header only.

import { afterAll, describe, expect, test } from "bun:test";
import { getRuleset } from "@perfidia/engine";
import { toolDefinitions } from "@perfidia/gateway/runtime";
import { harness } from "@perfidia/sim";
import { PROVIDERS, toolsFor } from "../arena/providers.ts";
import { THOUGHT_ASK, THOUGHT_QUEUED } from "../seat/prompt.ts";
import {
  ModelError,
  type CallMeta,
  type ChatRequest,
  type ChatResult,
  type Entry,
  type ModelAdapter,
  type ModelSpec,
  type StopReason,
  type TokenUsage,
} from "./adapter.ts";
import { AnthropicAdapter, AnthropicClient } from "./anthropic.ts";
import { costOf } from "./prices.ts";
import { modelTools } from "./tools.ts";
import {
  WIRE_KEYS,
  WIRE_PROVIDERS,
  startWireStub,
  type WireProvider,
  type WireReply,
  type WireStub,
} from "./wire-stubs.test.ts";

const SPECS: Readonly<Record<WireProvider, ModelSpec>> = {
  anthropic: {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    effort: "low",
    maxOutputTokens: 32_768,
    cacheTtl: "5m",
    fallbacks: "off",
  },
  openai: {
    provider: "openai",
    model: "gpt-6-luna",
    effort: "low",
    maxOutputTokens: 32_768,
    cacheTtl: "5m",
    fallbacks: "off",
  },
  google: {
    provider: "google",
    model: "gemini-3.8-flash",
    effort: "low",
    maxOutputTokens: 32_768,
    cacheTtl: "5m",
    fallbacks: "off",
  },
  openrouter: {
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    endpoint: "z-ai/fp8",
    effort: "medium",
    maxOutputTokens: 32_768,
    cacheTtl: "5m",
    fallbacks: "off",
  },
};

const PROMPT = {
  shared: "You are a player of Perfidia, a game of cities and betrayal. (conformance shared block)",
  seat: "You are Odysseus: patient, curious, never the first to strike. (conformance seat block)",
};
const NEUTRAL_TOOLS = modelTools(toolDefinitions(getRuleset("perfidia-1")));
const BRIEFING: Entry = {
  role: "user",
  parts: [{ kind: "text", text: '{"you":"p1","t":0,"note":"conformance briefing"}' }],
};
const HEADER: Entry = {
  role: "operator",
  text: "Turn 1 · game day 1, 00:00 · round trip 1 of 8, up to 10 calls.",
};
const RESULTS = [
  '{"ok":true,"city":{"id":"c1","wood":120}}',
  '{"ok":true,"sent":{"to":["p2"],"id":"m1"}}',
];
const END_ARGS = { nextWakeIn: 3600 };

/** The four replies, in order: what every stub encodes in its protocol. */
const SCRIPT: readonly WireReply[] = [
  {
    reasoning: ["I will look at my capital before I write to anyone."],
    text: ["Scouting first."],
    calls: [
      { name: "view_city", args: { city: "c1" } },
      { name: "send_message", args: { to: ["p2"], text: "Peace on the straits?" } },
    ],
    stop: "natural",
    usage: { uncached: 12, cacheRead: 0, cacheWrite: 5_400, output: 640, reasoning: 410 },
  },
  {
    reasoning: ["Weighing the reply of p2 against the walls of c1."],
    text: [],
    calls: [],
    stop: "max_tokens",
    usage: { uncached: 30, cacheRead: 5_412, cacheWrite: 380, output: 32_768, reasoning: 32_768 },
  },
  {
    reasoning: ["Nothing more to do in this wake."],
    text: [],
    calls: [{ name: "end_turn", args: END_ARGS }],
    stop: "natural",
    usage: { uncached: 30, cacheRead: 5_412, cacheWrite: 380, output: 2_100, reasoning: 1_900 },
  },
  {
    reasoning: [],
    text: ["Nobody has earned my trust yet."],
    calls: [],
    stop: "natural",
    usage: { uncached: 25, cacheRead: 5_822, cacheWrite: 60, output: 48, reasoning: 0 },
  },
];
const STOPS: StopReason[] = ["tool_use", "max_tokens", "tool_use", "end_turn"];

const meta = (round: number, kind: CallMeta["kind"] = "round"): CallMeta => ({
  seat: "p1",
  turn: 1,
  round,
  maxRounds: 8,
  maxCalls: 10,
  kind,
});

function adapterOf(provider: WireProvider, stub: WireStub): ModelAdapter {
  const spec = SPECS[provider];
  if (provider === "anthropic") {
    return new AnthropicAdapter(spec, new AnthropicClient({ apiKey: stub.key, baseURL: stub.url }));
  }
  const create = PROVIDERS[provider].create;
  if (create === undefined) throw new Error(`${provider}: no adapter factory`);
  return create(spec, {
    apiKey: stub.key,
    baseURL: stub.url,
    time: new harness.SystemTime(),
    timeoutMs: 60_000,
  });
}

interface Run {
  readonly stub: WireStub;
  readonly results: readonly ChatResult[];
}

/** The scripted turn through one adapter and its stub, as the seat agent sends it. */
async function converse(provider: WireProvider): Promise<Run> {
  let i = 0;
  const stub = startWireStub(provider, () => {
    const r = SCRIPT[i];
    i += 1;
    if (r === undefined) throw new Error("the script is over");
    return r;
  });
  stubs.push(stub);
  const a = adapterOf(provider, stub);
  const tools = toolsFor(provider, NEUTRAL_TOOLS);
  const ask = (entries: readonly Entry[], m: CallMeta, maxOutputTokens?: number): ChatRequest => ({
    prompt: PROMPT,
    tools,
    entries,
    meta: m,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  });
  const turn: Entry[] = [BRIEFING, HEADER];
  const r0 = await a.chat(ask([...turn], meta(0)));
  turn.push(
    { role: "assistant", reply: r0.reply },
    {
      role: "user",
      parts: r0.reply.calls.map((c, k) => ({
        kind: "result" as const,
        callId: c.callId,
        content: RESULTS[k] ?? "{}",
        isError: false,
      })),
    },
  );
  const r1 = await a.chat(ask([...turn], meta(1)));
  // The seat's `max_tokens` retry: the same entries at twice the limit.
  const r2 = await a.chat(ask([...turn], meta(1), 65_536));
  // The out-of-band thought call: the pending call answered "queued", then the operator's ask.
  const thought: Entry[] = [
    ...turn,
    { role: "assistant", reply: r2.reply },
    {
      role: "user",
      parts: r2.reply.calls.map((c) => ({
        kind: "result" as const,
        callId: c.callId,
        content: THOUGHT_QUEUED,
        isError: false,
      })),
    },
    { role: "operator", text: THOUGHT_ASK },
  ];
  const r3 = await a.chat(ask(thought, meta(1, "thought")));
  return { stub, results: [r0, r1, r2, r3] };
}

const stubs: WireStub[] = [];
afterAll(() => {
  for (const s of stubs) s.stop();
});

/** The usage of one attempt, summed over its entries. */
function usageOf(r: ChatResult): TokenUsage & { readonly prompt: number } {
  const sum = (f: (t: TokenUsage) => number): number =>
    r.usage.reduce((n, u) => n + f(u.tokens), 0);
  const reasoning = r.usage.some(
    (u) => u.tokens.reasoning !== undefined && u.tokens.reasoning !== null,
  )
    ? sum((t) => t.reasoning ?? 0)
    : undefined;
  return {
    input: sum((t) => t.input),
    cacheWrite5m: sum((t) => t.cacheWrite5m),
    cacheWrite1h: sum((t) => t.cacheWrite1h),
    cacheRead: sum((t) => t.cacheRead),
    output: sum((t) => t.output),
    reasoning,
    prompt: sum((t) => t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead),
  };
}

/** What every adapter must agree on, per attempt. */
const neutral = (r: ChatResult) => {
  const u = usageOf(r);
  return {
    stop: r.stop,
    calls: r.reply.calls.map((c) => ({ name: c.name, args: c.args })),
    text: r.reply.text.join(""),
    reasoning: r.reply.reasoning.join(""),
    prompt: u.prompt,
    cacheRead: u.cacheRead,
    output: u.output,
    estimated: r.usage.some((e) => e.estimated),
  };
};

const runs = new Map<WireProvider, Run>();

/** One adapter's results in the terms every adapter must agree on. */
const view = (p: WireProvider) => (runs.get(p)?.results ?? []).map(neutral);

/** The usage sums of one adapter's run. */
const sums = (p: WireProvider) =>
  (runs.get(p)?.results ?? []).reduce(
    (s, r) => {
      const u = usageOf(r);
      return {
        prompt: s.prompt + u.prompt,
        cacheRead: s.cacheRead + u.cacheRead,
        output: s.output + u.output,
      };
    },
    { prompt: 0, cacheRead: 0, output: 0 },
  );

/** `b` extends `a`: longer, and `a`'s items its first ones, byte for byte. */
const extending = (a: readonly string[], b: readonly string[]): boolean =>
  a.length < b.length && a.every((item, k) => b[k] === item);

describe("the conformance suite: one scripted turn through every adapter and its wire stub", () => {
  for (const provider of WIRE_PROVIDERS) {
    test(`${provider}: the script's calls, text, reasoning, stops and usage come back`, async () => {
      const run = await converse(provider);
      runs.set(provider, run);
      expect(run.stub.problems).toEqual([]);
      expect(run.results.map((r) => r.stop)).toEqual(STOPS);
      for (const [k, r] of run.results.entries()) {
        const s = SCRIPT[k];
        if (s === undefined) throw new Error("no script step");
        const u = usageOf(r);
        expect([provider, k, neutral(r)]).toEqual([
          provider,
          k,
          {
            stop: STOPS[k] ?? "other",
            calls: s.calls.map((c) => ({ name: c.name, args: c.args })),
            text: s.text.join(""),
            reasoning: s.reasoning.join(""),
            prompt: s.usage.uncached + s.usage.cacheRead + s.usage.cacheWrite,
            cacheRead: s.usage.cacheRead,
            output: s.usage.output,
            estimated: false,
          },
        ]);
        // The split of the prompt: Gemini reports no writes, the others write what they wrote.
        if (provider === "google") {
          expect([u.input, u.cacheWrite5m]).toEqual([s.usage.uncached + s.usage.cacheWrite, 0]);
        } else {
          expect([u.input, u.cacheWrite5m]).toEqual([s.usage.uncached, s.usage.cacheWrite]);
        }
        // Reasoning tokens where the provider splits them out; Anthropic does not.
        expect(u.reasoning ?? null).toEqual(provider === "anthropic" ? null : s.usage.reasoning);
        // Every attempt is priced at its provider's own card.
        const cost = costOf(r.usage, {
          provider,
          endpoint: SPECS[provider].endpoint ?? null,
          at: new Date().toISOString(),
        });
        expect([cost.unpriced, cost.nanoUsd > 0]).toEqual([[], true]);
      }
      // OpenRouter's served endpoint is the pin, its reported cost the card's (fee excluded).
      if (provider === "openrouter") {
        expect(run.results.map((r) => r.endpoint)).toEqual([
          "z-ai/fp8",
          "z-ai/fp8",
          "z-ai/fp8",
          "z-ai/fp8",
        ]);
        expect(run.results.every((r) => (r.reportedCostNanoUsd ?? 0) > 0)).toBe(true);
      }
    });
  }

  test("every adapter agrees: the same neutral results and the same usage sums", () => {
    expect(WIRE_PROVIDERS.filter((p) => !runs.has(p))).toEqual([]);
    const first = view("anthropic");
    for (const p of WIRE_PROVIDERS) expect([p, view(p)]).toEqual([p, first]);
    const want = SCRIPT.reduce(
      (s, r) => ({
        prompt: s.prompt + r.usage.uncached + r.usage.cacheRead + r.usage.cacheWrite,
        cacheRead: s.cacheRead + r.usage.cacheRead,
        output: s.output + r.usage.output,
      }),
      { prompt: 0, cacheRead: 0, output: 0 },
    );
    expect(want).toEqual({ prompt: 22_963, cacheRead: 16_646, output: 35_556 });
    for (const p of WIRE_PROVIDERS) expect([p, sums(p)]).toEqual([p, want]);
  });

  test("prefix stability per adapter: stable blocks byte-identical, each request extends the last", () => {
    for (const p of WIRE_PROVIDERS) {
      const chats = runs.get(p)?.stub.chats ?? [];
      expect([p, chats.length]).toEqual([p, 4]);
      const [c0, c1, c2, c3] = chats;
      if (c0 === undefined || c1 === undefined || c2 === undefined || c3 === undefined) continue;
      expect([p, new Set(chats.map((c) => c.stable)).size]).toEqual([p, 1]);
      expect([p, extending(c0.items, c1.items)]).toEqual([p, true]);
      expect([p, c2.items]).toEqual([p, c1.items]);
      expect([p, extending(c1.items, c3.items)]).toEqual([p, true]);
      // The retry asked for twice the limit; the rest at the spec's.
      expect([p, chats.map((c) => c.maxOutputTokens)]).toEqual([
        p,
        [32_768, 32_768, 65_536, 32_768],
      ]);
    }
  });

  test("one request per attempt, nothing else sent; each key in its own header, never in a URL", () => {
    const header = { anthropic: "x-api-key", google: "x-goog-api-key" } as const;
    for (const p of WIRE_PROVIDERS) {
      const hits = runs.get(p)?.stub.hits ?? [];
      expect([p, hits.length, hits.every((h) => h.method === "POST" && h.status === 200)]).toEqual([
        p,
        4,
        true,
      ]);
      for (const h of hits) {
        const name = p === "anthropic" || p === "google" ? header[p] : "authorization";
        const value = p === "anthropic" || p === "google" ? WIRE_KEYS[p] : `Bearer ${WIRE_KEYS[p]}`;
        expect([p, h.headers[name]]).toEqual([p, value]);
        const others = Object.entries(h.headers).filter(([k]) => k !== name);
        for (const key of Object.values(WIRE_KEYS)) {
          expect(h.path.includes(key)).toBe(false);
          expect(others.some(([, v]) => v.includes(key))).toBe(false);
        }
      }
    }
  });

  test("money safety, the same everywhere: a stream that breaks before its usage is charged (estimated: the full output limit, or the attempt bound)", async () => {
    for (const provider of WIRE_PROVIDERS) {
      const first = SCRIPT[0];
      if (first === undefined) throw new Error("no script");
      const stub = startWireStub(provider, (): WireReply => ({ ...first, cut: true }));
      stubs.push(stub);
      const a = adapterOf(provider, stub);
      let error: unknown = null;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one adapter at a time
        await a.chat({
          prompt: PROMPT,
          tools: toolsFor(provider, NEUTRAL_TOOLS),
          entries: [BRIEFING, HEADER],
          meta: meta(0),
        });
      } catch (e) {
        error = e;
      }
      expect([provider, error instanceof ModelError]).toEqual([provider, true]);
      if (!(error instanceof ModelError)) continue;
      const spent = error.spent;
      const output = spent.reduce((n, e) => n + e.tokens.output, 0);
      const prompt = spent.reduce(
        (n, e) =>
          n + e.tokens.input + e.tokens.cacheWrite5m + e.tokens.cacheWrite1h + e.tokens.cacheRead,
        0,
      );
      expect([provider, spent.length > 0, spent.every((e) => e.estimated)]).toEqual([
        provider,
        true,
        true,
      ]);
      // Either an estimate (the prompt and the full output limit), or, where nothing bounds the
      // prompt yet (OpenRouter's round 0), the attempt-bound marker: non-finite tokens no card can
      // price, which the ledger charges at the seat's attempt bound (`invalidUsage`).
      const marker = spent.some((e) => !Number.isFinite(e.tokens.input + e.tokens.output));
      if (marker) {
        // The pricer refuses it; the ledger catches that and charges the attempt bound.
        const at = new Date().toISOString();
        const endpoint = SPECS[provider].endpoint ?? null;
        expect(() => costOf(spent, { provider, endpoint, at })).toThrow("not a safe integer");
      } else {
        expect([provider, output >= 32_768, prompt > 0]).toEqual([provider, true, true]);
      }
      expect([provider, error.kind]).toEqual([provider, "connection"]);
      expect(stub.chats.length).toBe(1);
    }
  });
});
