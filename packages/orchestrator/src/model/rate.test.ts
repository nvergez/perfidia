import { describe, expect, test } from "bun:test";
import { VirtualTime } from "@perfidia/gateway/clock";
import { seededRandom, sleepMs, timeoutSignal } from "./clock.ts";
import { RateGate, RateGates } from "./rate.ts";

const virtual = (): VirtualTime =>
  new VirtualTime({ yieldMacrotask: () => new Promise((r) => setImmediate(r)) });

describe("RateGate", () => {
  test("at most maxInflight requests at once; a release lets the next waiter in", async () => {
    const time = virtual();
    const gate = new RateGate({ clock: { time, random: () => 0 }, maxInflight: 2 });
    const log: string[] = [];
    const job = async (name: string, ms: number): Promise<void> => {
      const release = await gate.acquire();
      log.push(`${name} start ${time.nowMs()}`);
      await sleepMs(time, ms);
      log.push(`${name} end ${time.nowMs()}`);
      release();
      release(); // idempotent
    };
    await time.run(() => Promise.all([job("a", 100), job("b", 300), job("c", 50)]));
    expect(log).toEqual([
      "a start 0",
      "b start 0",
      "a end 100",
      "c start 100",
      "c end 150",
      "b end 300",
    ]);
    expect(gate.inflight).toBe(0);
  });

  test("a hold (429 retry-after) stops every seat on the model; the release is jittered per waiter", async () => {
    const time = virtual();
    const gate = new RateGate({
      clock: { time, random: seededRandom(7) },
      maxInflight: 4,
      releaseJitterMs: 2000,
    });
    const started: number[] = [];
    await time.run(async () => {
      gate.holdFor(30_000);
      // A shorter hold never shortens a longer one.
      gate.holdFor(10);
      expect(gate.notBefore).toBe(30_000);
      await Promise.all(
        [1, 2, 3].map(async () => {
          const release = await gate.acquire();
          started.push(time.nowMs());
          release();
        }),
      );
    });
    expect(started).toHaveLength(3);
    for (const t of started) {
      expect(t).toBeGreaterThanOrEqual(30_000);
      expect(t).toBeLessThan(32_000);
    }
    expect(new Set(started).size).toBe(3);
  });

  test("an abort while waiting rejects and leaves the queue", async () => {
    const time = virtual();
    const gate = new RateGate({ clock: { time, random: () => 0 }, maxInflight: 1 });
    let error: unknown = null;
    await time.run(async () => {
      const release = await gate.acquire();
      const t = timeoutSignal(time, 500, "round deadline");
      const waiting = gate.acquire(t.signal).then(
        () => null,
        (e: unknown) => e,
      );
      await sleepMs(time, 10);
      expect(gate.waiting).toBe(1);
      error = await waiting;
      expect(gate.waiting).toBe(0);
      release();
    });
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("round deadline");
    expect(gate.inflight).toBe(0);
  });

  test("one gate per (provider, model)", () => {
    const time = virtual();
    const gates = new RateGates({ clock: { time, random: () => 0 } });
    expect(gates.gate("anthropic", "claude-opus-5-5")).toBe(
      gates.gate("anthropic", "claude-opus-5-5"),
    );
    expect(gates.gate("anthropic", "claude-opus-5-5")).not.toBe(
      gates.gate("anthropic", "claude-haiku-5-5"),
    );
    expect(() => new RateGate({ clock: { time, random: () => 0 }, maxInflight: 0 })).toThrow(
      "maxInflight",
    );
  });
});

describe("clock helpers", () => {
  test("seededRandom is deterministic and in [0, 1)", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  test("sleepMs rejects at once on an aborted signal and cancels its timer on abort", async () => {
    const time = virtual();
    await time.run(async () => {
      const ctl = new AbortController();
      ctl.abort(new Error("stop"));
      const early = await sleepMs(time, 100, ctl.signal).then(
        () => null,
        (e: unknown) => e,
      );
      expect(String(early)).toContain("stop");
      const late = new AbortController();
      const p = sleepMs(time, 10_000, late.signal);
      late.abort(new Error("late"));
      expect(
        String(
          await p.then(
            () => null,
            (e: unknown) => e,
          ),
        ),
      ).toContain("late");
      expect(time.pending).toBe(0);
    });
  });
});
