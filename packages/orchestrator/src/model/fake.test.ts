import { describe, expect, test } from "bun:test";
import { ModelError, type ChatRequest } from "./adapter.ts";
import { FakeAdapter, scripted } from "./fake.ts";

const spec = {
  provider: "fake",
  model: "claude-opus-5-5",
  effort: "low" as const,
  maxOutputTokens: 16_000,
  cacheTtl: "5m" as const,
};

const req = (seat: `p${number}`, round = 0, signal?: AbortSignal): ChatRequest => ({
  prompt: { shared: "S".repeat(400), seat: "seat" },
  tools: [],
  entries: [{ role: "user", parts: [{ kind: "text", text: "{}" }] }],
  ...(signal === undefined ? {} : { signal }),
  meta: { seat, turn: 1, round, maxRounds: 8, maxCalls: 10, kind: "round" },
});

describe("FakeAdapter", () => {
  test("Anthropic-shaped native content, stable call ids, deterministic usage: a write first, reads after", async () => {
    const fake = new FakeAdapter(spec, () => ({
      text: ["hi"],
      reasoning: ["why"],
      calls: [{ name: "view_map", args: {} }],
    }));
    const a = await fake.chat(req("p1"));
    const b = await fake.chat(req("p1", 1));
    const c = await fake.chat(req("p2"));
    expect(a.reply.native).toEqual([
      { type: "thinking", thinking: "why", signature: "fake" },
      { type: "text", text: "hi" },
      { type: "tool_use", id: "fk-p1-1-0-1-0", name: "view_map", input: {} },
    ]);
    expect(a.stop).toBe("tool_use");
    expect(b.reply.calls[0]?.callId).toBe("fk-p1-1-1-2-0");
    expect(a.usage[0]?.tokens.cacheWrite5m).toBeGreaterThan(100);
    expect(a.usage[0]?.tokens.cacheRead).toBe(0);
    expect(b.usage[0]?.tokens.cacheWrite5m).toBe(0);
    expect(b.usage[0]?.tokens.cacheRead).toBe(a.usage[0]?.tokens.cacheWrite5m ?? -1);
    expect(c.usage[0]?.tokens.cacheWrite5m).toBe(a.usage[0]?.tokens.cacheWrite5m ?? -1);
    expect(fake.requests).toHaveLength(3);
    expect(fake.label).toBe("fake/claude-opus-5-5/low");
  });

  test("refusals carry no reply; errors are thrown; an aborted signal aborts", async () => {
    const fake = new FakeAdapter(
      spec,
      scripted([
        { stop: "refusal", text: ["no"], calls: [{ name: "x", args: {} }] },
        new ModelError("rate_limit", "429"),
      ]),
    );
    const r = await fake.chat(req("p1"));
    expect(r.reply.calls).toEqual([]);
    expect(r.refusal).toEqual({ category: null, explanation: null, recommendedModel: null });
    const e = await fake.chat(req("p1")).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ModelError);
    const ctl = new AbortController();
    ctl.abort();
    const aborted = await fake.chat(req("p1", 0, ctl.signal)).then(
      () => null,
      (x: unknown) => x,
    );
    expect(aborted instanceof ModelError ? aborted.kind : null).toBe("aborted");
    const exhausted = await fake.chat(req("p1")).then(
      () => null,
      (x: unknown) => String(x),
    );
    expect(exhausted).toContain("scripted brain: no step");
  });

  test("build gives the request layout; preflight is free", async () => {
    const fake = new FakeAdapter(spec, () => ({}));
    expect(fake.build(req("p1"))).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 16_000,
      tools: [],
      system: [
        { type: "text", text: "S".repeat(400) },
        { type: "text", text: "seat" },
      ],
      messages: [{ role: "user", content: [{ kind: "text", text: "{}" }] }],
    });
    expect(await fake.preflight(req("p1"))).toEqual({
      model: "claude-opus-5-5",
      allowedFallbackModels: [],
      usage: [],
    });
  });
});
