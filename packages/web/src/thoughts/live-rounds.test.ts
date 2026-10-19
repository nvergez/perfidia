import { describe, expect, test } from "bun:test";
import type { TurnAnnotation } from "@perfidia/protocol/spectator";
import { addLiveAnnot, liveTopRound, roundNow, turnKey, type AnnotMsg } from "../store/match.ts";
import { LIVE_ROUNDS_SHOWN, liveView, withLive } from "./live-rounds.ts";

function annot(round: number, o: Partial<AnnotMsg> = {}): AnnotMsg {
  return {
    type: "annot",
    match: "m",
    seat: "p2",
    turn: 7,
    round,
    kind: "round",
    reasoning: [`r${round}`],
    text: [],
    calls: ["view_city"],
    complete: false,
    ...o,
  };
}

/** The live messages of p2's turn 7 after the store took `msgs` in order (`addLiveAnnot`). */
function held(msgs: readonly AnnotMsg[]): readonly AnnotMsg[] {
  let cur: Readonly<Record<string, readonly AnnotMsg[]>> = {};
  for (const m of msgs) cur = addLiveAnnot(cur, m);
  return cur[turnKey("p2", 7)] ?? [];
}

describe("the live rounds of an open turn", () => {
  test("arrive round by round; the newest are shown, the earlier counted until “more”", () => {
    const msgs = held([0, 1, 2, 3, 4].map((n) => annot(n)));
    const short = liveView(msgs, false);
    expect(short.rounds.map((r) => r.key)).toEqual(["round:2", "round:3", "round:4"]);
    expect(short.rounds).toHaveLength(LIVE_ROUNDS_SHOWN);
    expect([short.earlier, short.latest]).toEqual([2, "round:4"]);
    const all = liveView(msgs, true);
    expect([all.rounds.length, all.earlier, all.latest]).toEqual([5, 0, "round:4"]);
    expect(liveTopRound(msgs)).toBe(4);
  });

  test("a reconnect resends the open turn's rounds: no duplicate, the newest text wins", () => {
    const first = [annot(0), annot(1, { reasoning: ["first try"] })];
    // The socket drops; on subscribe the server sends the rounds of the turns open now again, one
    // of them retried meanwhile, plus the round that came while the socket was down.
    const again = [annot(0), annot(1, { reasoning: ["retried"] }), annot(2)];
    const msgs = held([...first, ...again]);
    expect(msgs).toHaveLength(3);
    const v = liveView(msgs, true);
    expect(v.rounds.map((r) => [r.key, r.reasoning[0]])).toEqual([
      ["round:0", "r0"],
      ["round:1", "retried"],
      ["round:2", "r2"],
    ]);
  });

  test("a later turn's rounds never show under the open one; a thought call comes last", () => {
    const msgs = held([annot(0), annot(0, { turn: 8 }), annot(0, { kind: "thought_call" })]);
    expect(liveView(msgs, false).rounds.map((r) => r.key)).toEqual(["round:0", "thought_call:0"]);
    // The thought call is not a round: "thinking… round N" counts rounds only.
    expect(liveTopRound(msgs)).toBe(0);
    expect(liveView([], false)).toEqual({ rounds: [], earlier: 0, latest: null });
    expect(liveTopRound([])).toBeNull();
  });

  test("“thinking… round N”: the newer of the log's round and the live socket's", () => {
    expect(roundNow(null, null)).toBeNull();
    expect(roundNow(2, null)).toBe(2);
    expect(roundNow(null, 3)).toBe(3);
    expect(roundNow(2, 3)).toBe(3);
    expect(roundNow(4, 3)).toBe(4);
  });
});

describe("the hand-over to the closed turn's reasoning", () => {
  const tokens = { input: 1, cacheWrite5m: 2, cacheWrite1h: 0, cacheRead: 3, output: 4 };
  const fetched: TurnAnnotation = {
    seat: "p2",
    turn: 7,
    complete: false,
    rounds: [
      {
        round: 0,
        kind: "round",
        attempts: 2,
        stop: "tool_use",
        refusal: null,
        errors: ["overloaded"],
        reasoning: ["old"],
        text: [],
        calls: ["rules"],
        costNanoUsd: 5,
        tokens,
        latencyMs: 9,
      },
    ],
    spentNanoUsd: 50,
    capNanoUsd: 500,
  };

  test("the live rounds show at once while the annotation loads", () => {
    const a = withLive("p2", 7, null, [annot(1), annot(0)]);
    expect(a?.rounds.map((r) => [r.round, r.reasoning[0], r.costNanoUsd])).toEqual([
      [0, "r0", 0],
      [1, "r1", 0],
    ]);
    expect([a?.complete, a?.spentNanoUsd]).toEqual([false, null]);
    expect(withLive("p2", 7, null, [])).toBeNull();
    expect(withLive("p2", 7, fetched, [])).toBe(fetched);
  });

  test("joined with the annotation: its figures stay, the live text and later rounds join", () => {
    const a = withLive("p2", 7, fetched, [annot(0, { reasoning: ["new"] }), annot(1)]);
    expect(a?.rounds.map((r) => [r.round, r.reasoning[0], r.costNanoUsd, r.attempts])).toEqual([
      [0, "new", 5, 2],
      [1, "r1", 0, 0],
    ]);
    expect(a?.rounds[0]?.errors).toEqual(["overloaded"]);
    expect([a?.spentNanoUsd, a?.capNanoUsd]).toEqual([50, 500]);
  });
});
