import { describe, expect, test } from "bun:test";
import type { JsonObject, LogLine } from "@perfidia/protocol";
import { watchLines } from "./watch.ts";

const ctx = { names: { p3: "Odysseus" } };

const ev = (t: number, type: string, data: JsonObject, isPublic = false): LogLine => ({
  k: "ev",
  t,
  e: { t, type, public: isPublic, to: [], data },
});

describe("watchLines", () => {
  test("thoughts, messages, diplomacy, conquests and hand-offs become readable lines", () => {
    const lines: LogLine[] = [
      {
        k: "turn",
        t: 223320,
        seat: "p3",
        turn: 12,
        rounds: 2,
        calls: 4,
        why: "end_turn",
        selfAt: null,
        next: null,
        thought: "A pact with p5 buys two quiet days;\nc12 falls at dawn.",
      },
      ev(223380, "message", {
        message: "g1",
        from: "p3",
        to: ["p5"],
        text: "Friend, let us agree not to fight.",
      }),
      ev(223390, "message", { message: "g2", from: "p4", to: "all", text: "Beware of p3." }, true),
      ev(223400, "proposal", {
        proposal: "q1",
        from: "p3",
        to: "p5",
        kind: "alliance",
        name: "Ithaca",
        text: "Together.",
      }),
      ev(
        223410,
        "alliance_formed",
        { alliance: "a1", name: "Ithaca", members: ["p3", "p5"] },
        true,
      ),
      ev(300000, "betrayal", { by: "p3", against: "p5", relation: "ally", city: "c12" }, true),
      ev(300100, "city_conquered", { city: "c12", from: "p5", to: "p3" }, true),
      { k: "controller", t: 389100, seat: "p3", label: "bot:opportunist@3" },
      ev(389200, "battle", {
        city: "c1",
        attacker: "p1",
        defender: "p2",
        kind: "city",
        winner: "attacker",
      }),
      {
        k: "turn",
        t: 400000,
        seat: "p1",
        turn: 3,
        rounds: 1,
        calls: 0,
        why: "error",
        selfAt: null,
        next: null,
        error: "AgentError: llm p1 turn 3 round 0: refusal (cyber) on claude-opus-5-5",
      },
    ];
    expect(lines.flatMap((l) => watchLines(l, ctx))).toEqual([
      'D3 14:02  p3 Odysseus thinks: "A pact with p5 buys two quiet days; c12 falls at dawn."',
      'D3 14:03  p3 → p5 (private): "Friend, let us agree not to fight."',
      'D3 14:03:10  p4 → all (public): "Beware of p3."',
      'D3 14:03:20  p3 proposes alliance to p5 ("Ithaca"): "Together."',
      'D3 14:03:30  alliance "Ithaca" formed: p3, p5',
      "D4 11:20  BETRAYAL: p3 attacks p5 (ally) at c12",
      "D4 11:21:40  p3 takes c12 from p5",
      "D5 12:05  p3 Odysseus handed to bot:opportunist@3",
      "D5 15:06:40  p1 turn 3 closed: error",
    ]);
  });

  test("player text is cut and kept on one line", () => {
    const [line] = watchLines(
      ev(0, "message", { from: "p1", to: ["p2"], text: `${"x".repeat(200)}\nmore` }),
      { names: {}, cut: 20 },
    );
    expect(line).toBe(`D1 00:00  p1 → p2 (private): "${"x".repeat(19)}…"`);
  });
});
