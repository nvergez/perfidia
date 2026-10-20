import { describe, expect, test } from "bun:test";
import type { SeatAgent } from "@perfidia/protocol";
import type { UsageEntry } from "../model/adapter.ts";
import { BudgetLedger, MatchBudget, type HandoffNote, type KillNote } from "./ledger.ts";

const bot = (label: string): SeatAgent => ({ label, round: () => Promise.resolve({ calls: [] }) });

const opus = (input: number, output = 0, estimated = false): UsageEntry => ({
  model: "claude-opus-5-5",
  kind: "message",
  tokens: { input, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output },
  estimated,
});

function ledger(caps: [`p${number}`, number][], wakeCap: number | null = null) {
  const notes: HandoffNote[] = [];
  const built: string[] = [];
  const l = new BudgetLedger({
    caps: new Map(caps),
    wakeCapNanoUsd: wakeCap,
    handoffTo: (seat) => {
      built.push(seat);
      return { label: `bot:turtle@3`, agent: bot("bot:turtle@3") };
    },
    onHandoff: (n) => notes.push(n),
  });
  return { l, notes, built };
}

describe("BudgetLedger", () => {
  test("charges add up per seat and per wake, in integer nano-dollars", () => {
    const { l } = ledger([
      ["p1", 1_000_000_000],
      ["p2", 1_000_000_000],
    ]);
    const a = l.charge("p1", 1, 0, [opus(1000, 100)]);
    expect(a).toMatchObject({
      costNanoUsd: 1000 * 4000 + 100 * 20000,
      seatSpentNanoUsd: 6_000_000,
      wakeSpentNanoUsd: 6_000_000,
      crossedCap: false,
    });
    l.charge("p1", 1, 10, [opus(1000)]);
    expect(l.wakeSpent("p1", 1)).toBe(10_000_000);
    // A new turn starts a new wake.
    l.charge("p1", 2, 3600, [opus(10)]);
    expect(l.wakeSpent("p1", 2)).toBe(40_000);
    expect(l.wakeSpent("p1", 1)).toBe(0);
    expect(l.spent("p1")).toBe(10_040_000);
    expect(l.spent("p2")).toBe(0);
    expect(l.totals()).toEqual([
      { seat: "p1", spentNanoUsd: 10_040_000, capNanoUsd: 1_000_000_000 },
      { seat: "p2", spentNanoUsd: 0, capNanoUsd: 1_000_000_000 },
    ]);
  });

  test("the charge that crosses the cap queues one hand-off; later requests do nothing; take() once", () => {
    const { l, notes, built } = ledger([["p1", 5_000_000]]);
    expect(l.charge("p1", 1, 0, [opus(1000)]).crossedCap).toBe(false);
    expect(l.over("p1")).toBe(false);
    const c = l.charge("p1", 1, 60, [opus(500)]);
    expect(c.crossedCap).toBe(true);
    expect(l.over("p1")).toBe(true);
    l.requestHandoff("p1", "cap", 70);
    l.charge("p1", 2, 3600, [opus(1)]);
    expect(notes).toEqual([
      {
        seat: "p1",
        t: 60,
        reason: "cap",
        label: "bot:turtle@3",
        spentNanoUsd: 6_000_000,
        capNanoUsd: 5_000_000,
      },
    ]);
    expect(built).toEqual(["p1"]);
    expect(l.take("p2", 0)).toBeNull();
    expect(l.take("p1", 3600)?.label).toBe("bot:turtle@3");
    expect(l.handedOff("p1")).toBe(true);
    expect(l.take("p1", 7200)).toBeNull();
    l.requestHandoff("p1", "cap", 7200);
    expect(notes).toHaveLength(1);
  });

  test("the per-wake soft cap", () => {
    const { l } = ledger([["p1", 100_000_000_000]], 2_000_000);
    l.charge("p1", 3, 0, [opus(400)]);
    expect(l.wakeOver("p1", 3)).toBe(false);
    l.charge("p1", 3, 0, [opus(100)]);
    expect(l.wakeOver("p1", 3)).toBe(true);
    expect(l.wakeOver("p1", 4)).toBe(false);
    expect(ledger([["p1", 1]], null).l.wakeOver("p1", 1)).toBe(false);
  });

  test("estimated charges count like any other; unknown seats and bad caps are refused", () => {
    const { l } = ledger([["p1", 100_000_000_000]]);
    expect(l.charge("p1", 1, 0, [opus(0, 4000, true)]).costNanoUsd).toBe(80_000_000);
    expect(() => l.charge("p9", 1, 0, [])).toThrow("p9 is not an LLM seat");
    expect(() => ledger([["p1", -1]])).toThrow("must be an integer ≥ 0");
    expect(() => ledger([["p1", 1.5]])).toThrow("must be an integer ≥ 0");
  });

  test("an unpriced served model is charged at the highest rates and reported", () => {
    const { l } = ledger([["p1", 100_000_000_000]]);
    const c = l.charge("p1", 1, 0, [{ ...opus(1), model: "claude-unknown-1" }]);
    expect(c.unpriced).toEqual(["claude-unknown-1"]);
    expect(c.costNanoUsd).toBe(5_000);
  });
});

/** A Sonnet 5.5 message that produced `output` tokens. */
const sonnet = (output: number): UsageEntry => ({
  model: "claude-sonnet-5-5",
  kind: "message",
  tokens: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output },
  estimated: false,
});

/** A ledger of two seats under a match budget, with its kill and hand-off notes. */
function matched(budget: number, reserve: number, carry = 0) {
  const kills: KillNote[] = [];
  const match = new MatchBudget({
    budgetNanoUsd: budget,
    reserveNanoUsd: reserve,
    carryNanoUsd: carry,
    onKill: (k) => kills.push(k),
  });
  const notes: HandoffNote[] = [];
  const l = new BudgetLedger({
    caps: new Map([
      ["p1", 100_000_000_000],
      ["p2", 1_000_000],
    ]),
    wakeCapNanoUsd: null,
    handoffTo: (seat) => ({ label: `bot:turtle@3`, agent: bot(`bot ${seat}`) }),
    onHandoff: (n) => notes.push(n),
    match,
  });
  return { match, l, notes, kills };
}

describe("MatchBudget and the kill switch (phase 4 §5.2)", () => {
  test("K = budget − reserve; the charge that reaches K fires once and halts every seat", () => {
    const { match, l, notes, kills } = matched(1_000_000_000, 400_000_000);
    expect(match.killAtNanoUsd).toBe(600_000_000);
    l.charge("p1", 1, 100, [sonnet(50_000)]); // $0.50
    expect([match.killed, l.over("p1"), l.over("p2")]).toEqual([false, false, false]);
    l.charge("p1", 1, 200, [sonnet(10_000)]); // $0.10: $0.60 = K
    expect(match.killed).toBe(true);
    expect(kills).toEqual([
      {
        t: 200,
        spentNanoUsd: 600_000_000,
        killAtNanoUsd: 600_000_000,
        budgetNanoUsd: 1_000_000_000,
      },
    ]);
    expect([l.over("p1"), l.over("p2"), l.overReason("p1"), l.halted]).toEqual([
      true,
      true,
      "match_budget",
      "match_budget",
    ]);
    expect(notes.map((n) => [n.seat, n.reason, n.t])).toEqual([
      ["p1", "match_budget", 200],
      ["p2", "match_budget", 200],
    ]);
    // In-flight attempts still land (charged, counted), nothing fires twice.
    l.charge("p2", 3, 250, [sonnet(1_000)]);
    expect(match.spentNanoUsd).toBe(610_000_000);
    expect(kills).toHaveLength(1);
    expect(notes).toHaveLength(2);
    expect(l.allHandedOff()).toBe(true);
  });

  test("a seat over its own cap keeps its cap hand-off; the kill hands off the rest", () => {
    const { l, notes } = matched(1_000_000_000, 100_000_000);
    l.charge("p2", 1, 10, [sonnet(200)]); // over p2's $0.001 cap
    expect(l.overReason("p2")).toBe("cap");
    l.charge("p1", 1, 20, [sonnet(90_000)]);
    expect(notes.map((n) => [n.seat, n.reason])).toEqual([
      ["p2", "cap"],
      ["p1", "match_budget"],
    ]);
  });

  test("the carry counts from the start; a carry at K kills before any attempt", () => {
    const { match, l } = matched(1_000_000_000, 400_000_000, 250_000_000);
    expect(match.spentNanoUsd).toBe(250_000_000);
    l.charge("p1", 1, 0, [sonnet(35_000)]);
    expect(match.killed).toBe(true);
    const at = matched(1_000_000_000, 400_000_000, 600_000_000);
    expect([at.match.killed, at.l.over("p1")]).toEqual([true, true]);
    expect(at.notes.map((n) => n.reason)).toEqual(["match_budget", "match_budget"]);
  });

  test("probes and the preflight count through add(); the operator halt is its own reason", () => {
    const { match, l, notes } = matched(1_000_000_000, 400_000_000);
    match.add(599_999_999, 0);
    expect(match.killed).toBe(false);
    l.halt("operator", 3600);
    l.halt("match_budget", 3700);
    expect(notes.map((n) => n.reason)).toEqual(["operator", "operator"]);
    match.add(1, 3800);
    expect(l.halted).toBe("operator");
    expect(() => new MatchBudget({ budgetNanoUsd: 1, reserveNanoUsd: 2 })).toThrow("exceeds");
    expect(() => match.add(-1, 0)).toThrow("integer ≥ 0");
  });

  test("per-seat wake caps over the ledger-wide one", () => {
    const l = new BudgetLedger({
      caps: new Map([
        ["p1", 100_000_000_000],
        ["p2", 100_000_000_000],
        ["p3", 100_000_000_000],
      ]),
      wakeCapNanoUsd: 2_000_000_000,
      wakeCaps: new Map([
        ["p1", 100_000_000],
        ["p2", null],
      ]),
      handoffTo: () => ({ label: "bot:turtle@3", agent: bot("bot:turtle@3") }),
    });
    expect([l.wakeCap("p1"), l.wakeCap("p2"), l.wakeCap("p3")]).toEqual([
      100_000_000,
      null,
      2_000_000_000,
    ]);
    l.charge("p1", 1, 0, [sonnet(10_000)]);
    l.charge("p2", 1, 0, [sonnet(1_000_000)]);
    expect([l.wakeOver("p1", 1), l.wakeOver("p2", 1)]).toEqual([true, false]);
  });
});
