// Think time (docs/architecture.md §9.4): seeded per-round latency on an injected time source.

import { describe, expect, test } from "bun:test";
import type { RoundInput, RoundOutput, SeatAgent, Sleep, TimeSource } from "@perfidia/protocol";
import { inSequence, perfidiaGame, upTo } from "./fixtures.test.ts";
import { thinkLatencyMs, withThinkTime } from "./think.ts";

class FakeTime implements TimeSource {
  now = 1000;
  readonly sleeps: number[] = [];
  nowMs(): number {
    return this.now;
  }
  sleepUntil(ms: number): Sleep {
    this.sleeps.push(ms - this.now);
    this.now = ms;
    return { done: Promise.resolve(), cancel: () => undefined };
  }
}

const OUT: RoundOutput = { calls: [{ tool: "end_turn", args: { wakeAt: 9000 } }], thought: "done" };
const inner: SeatAgent = { label: "bot:test@1", round: () => Promise.resolve(OUT) };
const briefing = perfidiaGame(6).briefing("p1");

function input(turn: number, round: number): RoundInput {
  return { seat: "p1", turn, round, maxRounds: 8, maxCalls: 10, briefing, results: [] };
}

describe("withThinkTime", () => {
  test("returns the inner output after a seeded latency within the range", async () => {
    const time = new FakeTime();
    const agent = withThinkTime(inner, { time, latencyMs: [2000, 60000], seed: 42 });
    expect(agent.label).toBe("bot:test@1");
    const outs: RoundOutput[] = [];
    await inSequence(upTo(20), async (round) => {
      outs.push(await agent.round(input(1, round)));
    });
    for (const out of outs) expect(out).toEqual(OUT);
    expect(time.sleeps.length).toBe(20);
    for (const s of time.sleeps) {
      expect(s).toBeGreaterThanOrEqual(2000);
      expect(s).toBeLessThanOrEqual(60000);
    }
    expect(new Set(time.sleeps).size).toBeGreaterThan(10);
  });

  test("latencies are a pure function of the seed, the seat, the turn, the round and t", () => {
    const o = { time: new FakeTime(), latencyMs: [2000, 60000] as const, seed: 7 };
    expect(thinkLatencyMs(o, input(3, 2))).toBe(thinkLatencyMs(o, input(3, 2)));
    const other = { ...o, seed: 8 };
    const draws = upTo(30).map((r) => [
      thinkLatencyMs(o, input(1, r)),
      thinkLatencyMs(other, input(1, r)),
    ]);
    expect(draws.some(([a, b]) => a !== b)).toBe(true);
  });

  test("no sleep at zero latency; a fixed latency sleeps exactly that", async () => {
    const zero = new FakeTime();
    await withThinkTime(inner, { time: zero, latencyMs: [0, 0], seed: 1 }).round(input(1, 0));
    expect(zero.sleeps).toEqual([]);
    const fixed = new FakeTime();
    await withThinkTime(inner, { time: fixed, latencyMs: [250, 250], seed: 1 }).round(input(1, 0));
    expect(fixed.sleeps).toEqual([250]);
  });

  test("an agent error propagates without sleeping", async () => {
    const time = new FakeTime();
    const failing: SeatAgent = { label: "bot:x@1", round: () => Promise.reject(new Error("boom")) };
    let message = "";
    try {
      await withThinkTime(failing, { time, latencyMs: [10, 20], seed: 1 }).round(input(1, 0));
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe("boom");
    expect(time.sleeps).toEqual([]);
  });

  test("rejects an invalid range", () => {
    const time = new FakeTime();
    for (const latencyMs of [
      [-1, 5],
      [5, 4],
      [1.5, 2],
      [0, 3_000_000],
    ] as const) {
      expect(() => withThinkTime(inner, { time, latencyMs, seed: 1 })).toThrow(RangeError);
    }
  });
});
