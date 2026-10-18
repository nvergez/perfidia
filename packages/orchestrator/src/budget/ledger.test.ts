import { describe, expect, test } from "bun:test";
import type { SeatAgent } from "@perfidia/protocol";
import type { UsageEntry } from "../model/adapter.ts";
import { BudgetLedger, type HandoffNote } from "./ledger.ts";

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
