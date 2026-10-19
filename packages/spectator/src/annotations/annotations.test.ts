import { describe, expect, test } from "bun:test";
import type { LlmCallLine, ReplyLine } from "@perfidia/protocol";
import { LABEL_MAX_CHARS, TOOL_NAME_MAX_CHARS } from "../clean.ts";
import { createAnnotationFold } from "./annotations.ts";

// The annotation fold on hand-made side lines: what the harness logs as labels (a refusal's
// category, an error's kind) and the tool names an agent sends are cleaned and cut like the rest of
// the spectator text; under `costs: false` no figure is served, model time included.

const HOSTILE = "<b>cat</b>‮evil‬⁦iso⁩​zw";

function call(over: Partial<LlmCallLine>): LlmCallLine {
  return {
    k: "llm_call",
    seat: "p1",
    turn: 1,
    round: 0,
    attempt: 1,
    kind: "round",
    t: 60,
    latencyMs: 2345,
    ttftMs: null,
    provider: "fake",
    model: "fake",
    servedBy: null,
    effort: "low",
    maxTokens: 1000,
    stop: "tool_use",
    rawStop: null,
    refusal: null,
    fallback: false,
    cacheMiss: false,
    usage: [],
    costNanoUsd: 5_000_000,
    seatSpentNanoUsd: 5_000_000,
    capNanoUsd: 1_000_000_000,
    wakeSpentNanoUsd: 5_000_000,
    unpriced: [],
    calls: 1,
    textChars: 0,
    reasoningChars: 0,
    requestId: null,
    error: null,
    ...over,
  };
}

function reply(names: readonly string[]): ReplyLine {
  return {
    k: "reply",
    seat: "p1",
    turn: 1,
    round: 1,
    attempt: 1,
    kind: "round",
    t: 60,
    stop: "tool_use",
    reasoning: ["thinking"],
    text: [],
    calls: names.map((name) => ({ name, args: {} })),
  };
}

describe("labels and tool names", () => {
  test("a refusal's category, error kinds and tool names are cleaned and cut", () => {
    const a = createAnnotationFold();
    a.call(
      call({
        stop: "refusal",
        refusal: { category: HOSTILE, explanation: "never served", recommendedModel: null },
      }),
    );
    a.call(
      call({ attempt: 2, stop: "error", error: { kind: HOSTILE, status: 529, message: "x" } }),
    );
    a.call(call({ round: 1, error: { kind: "k".repeat(500), status: null, message: "x" } }));
    a.call(call({ round: 2, stop: "refusal", refusal: null }));
    a.call(
      call({
        round: 3,
        stop: "refusal",
        refusal: { category: "‮", explanation: null, recommendedModel: null },
      }),
    );
    a.reply(reply([HOSTILE, "t".repeat(5000), "view_city"]));
    const rounds = a.turn("p1", 1)?.rounds ?? [];
    const [r0, r1, r2, r3] = rounds;
    expect(r0?.refusal).toBe("<b>cat</b>evilisozw");
    expect(r0?.errors).toEqual(["<b>cat</b>evilisozw"]);
    expect(r1?.errors).toEqual(["k".repeat(LABEL_MAX_CHARS)]);
    expect(r1?.calls).toEqual([
      "<b>cat</b>evilisozw",
      "t".repeat(TOOL_NAME_MAX_CHARS),
      "view_city",
    ]);
    expect([r2?.refusal, r3?.refusal]).toEqual(["uncategorised", "uncategorised"]);
    expect(JSON.stringify(rounds)).not.toMatch(/[‪-‮⁦-⁩​]/u);
  });
});

describe("the policy", () => {
  test("costs: false serves no cost, token, model time, spend or cap", () => {
    const a = createAnnotationFold({ costs: false, reasoning: true });
    a.call(call({}));
    a.reply({ ...reply(["view_city"]), round: 0 });
    const t = a.turn("p1", 1);
    expect(t?.rounds.map((r) => [r.costNanoUsd, r.latencyMs, r.attempts, r.calls])).toEqual([
      [0, 0, 1, ["view_city"]],
    ]);
    expect([t?.spentNanoUsd, t?.capNanoUsd, a.spend("p1")]).toEqual([null, null, null]);
    const all = createAnnotationFold();
    all.call(call({}));
    expect(all.turn("p1", 1)?.rounds[0]?.latencyMs).toBe(2345);
  });
});
