import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@perfidia/engine/core";
import { ModelError, type ChatRequest, type Entry } from "../model/adapter.ts";
import { FakeAdapter, type FakeReply } from "../model/fake.ts";
import { briefingOf, ok, virtualTime } from "../testkit.test.ts";
import { botBrain, roundInputOf } from "./brain.ts";

// The bot-backed brain (phase-2 design §2.7): the bot's round input rebuilt from the request, one
// bot instance for the whole match, the thought on a terminal reply, a cache-shaped usage, and an
// aborted "think" charged an estimate.

const SPEC = {
  provider: "fake",
  model: "claude-opus-5-5",
  effort: "medium",
  maxOutputTokens: 16_000,
  cacheTtl: "5m",
} as const;

const briefing: Entry = {
  role: "user",
  parts: [{ kind: "text", text: canonicalJson(briefingOf(0)) }],
};

function req(
  entries: readonly Entry[],
  turn: number,
  round: number,
  signal?: AbortSignal,
): ChatRequest {
  return {
    prompt: { shared: "S", seat: "P" },
    tools: [],
    entries,
    ...(signal === undefined ? {} : { signal }),
    meta: { seat: "p1", turn, round, maxRounds: 8, maxCalls: 10, kind: "round" },
  };
}

const answer = async (p: ReturnType<ReturnType<typeof botBrain>>): Promise<FakeReply> => {
  const r = await p;
  if (r instanceof ModelError) throw r;
  return r;
};

describe("bot-backed brain", () => {
  test("round inputs rebuilt from the request: the briefing, then the latest results in order", () => {
    const r0 = roundInputOf(req([briefing, { role: "operator", text: "header" }], 1, 0));
    expect(r0.briefing).toEqual(briefingOf(0));
    expect(r0.results).toEqual([]);
    const entries: Entry[] = [
      briefing,
      { role: "operator", text: "header" },
      { role: "assistant", reply: { native: [], text: [], calls: [], reasoning: [] } },
      {
        role: "user",
        parts: [
          { kind: "result", callId: "a", content: canonicalJson(ok(0, { x: 1 })), isError: false },
          { kind: "result", callId: "b", content: canonicalJson(ok(0, { y: 2 })), isError: false },
        ],
      },
      { role: "operator", text: "Round trip 2 of 8" },
    ];
    expect(roundInputOf(req(entries, 1, 1)).results).toEqual([ok(0, { x: 1 }), ok(0, { y: 2 })]);
  });

  test("one bot for the whole match; a terminal reply carries the thought; usage is cache-shaped", async () => {
    const brain = botBrain({
      label: "bot:turtle@3",
      seat: "p1",
      seed: 1,
      model: "claude-opus-5-5",
      prefixChars: 4000,
    });
    const fake = new FakeAdapter(SPEC, brain);
    const first = await fake.chat(req([briefing, { role: "operator", text: "header" }], 1, 0));
    expect(first.reply.calls.length).toBeGreaterThan(0);
    const u0 = first.usage[0]?.tokens;
    expect(u0?.cacheWrite5m).toBeGreaterThan(1000);
    expect(u0?.cacheRead).toBe(0);
    // Round 1 of the same turn: the previous request is read from the cache, only the new part written.
    const results = first.reply.calls.map((c) => ({
      kind: "result" as const,
      callId: c.callId,
      content: canonicalJson(ok(0)),
      isError: false,
    }));
    const entries: Entry[] = [
      briefing,
      { role: "operator", text: "header" },
      { role: "assistant", reply: first.reply },
      { role: "user", parts: results },
      { role: "operator", text: "Round trip 2 of 8" },
    ];
    const second = await fake.chat(req(entries, 1, 1));
    const u1 = second.usage[0]?.tokens;
    expect(u1?.cacheRead).toBe(
      1000 + Math.ceil(JSON.stringify([briefing, { role: "operator", text: "header" }]).length / 4),
    );
    const terminal =
      second.reply.calls.length === 0 || second.reply.calls.some((c) => c.name === "end_turn");
    if (terminal) expect(second.reply.text.length).toBe(1);
  });

  test("an attempt aborted while the fake model thinks returns an estimated charge", async () => {
    const time = virtualTime();
    const brain = botBrain({
      label: "bot:turtle@3",
      seat: "p1",
      seed: 1,
      model: "claude-opus-5-5",
      latency: { time, rangeMs: [60_000, 60_000] },
    });
    const ctl = new AbortController();
    const out = time.run(async () => {
      const p = brain(req([briefing, { role: "operator", text: "h" }], 1, 0, ctl.signal), 1);
      ctl.abort(new Error("deadline"));
      return p;
    });
    const r = await out;
    expect(r).toBeInstanceOf(ModelError);
    if (r instanceof ModelError) {
      expect(r.kind).toBe("aborted");
      expect(r.spent.map((u) => [u.estimated, u.tokens.output])).toEqual([[true, 4000]]);
    }
    // Not aborted: the reply comes after the seeded latency, which the reply reports.
    const t2 = virtualTime();
    const b2 = botBrain({
      label: "bot:turtle@3",
      seat: "p1",
      seed: 1,
      latency: { time: t2, rangeMs: [5_000, 5_000] },
    });
    const reply = await answer(
      t2.run(() => Promise.resolve(b2(req([briefing, { role: "operator", text: "h" }], 1, 0), 1))),
    );
    expect(reply.latencyMs).toBe(5_000);
    expect(t2.nowMs()).toBe(5_000);
  });

  test("the out-of-band thought call gets text, never a tool call", async () => {
    const brain = botBrain({ label: "bot:turtle@3", seat: "p1", seed: 1 });
    const r = await answer(
      brain(
        {
          ...req([briefing, { role: "operator", text: "h" }], 1, 0),
          meta: { seat: "p1", turn: 1, round: 0, maxRounds: 8, maxCalls: 10, kind: "thought" },
        },
        1,
      ),
    );
    expect(r.calls ?? []).toEqual([]);
    expect(r.text?.length).toBe(1);
  });
});
