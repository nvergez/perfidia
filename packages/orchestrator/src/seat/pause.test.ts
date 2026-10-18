import { describe, expect, test } from "bun:test";
import { rejection, virtualTime } from "../testkit.test.ts";
import { ArenaAborted, ArenaPauseGate, Breaker, NoPauseGate } from "./pause.ts";
import { RetryBudget, backoffMs } from "./retry.ts";

describe("Breaker", () => {
  test("3 consecutive non-retryable failures of one model, across seats, trip it; a success resets", () => {
    const b = new Breaker();
    const fail = (seat: `p${number}`, model = "m") =>
      b.record({ k: "attempt_failed", model, seat, kind: "bad_request" });
    expect(fail("p1")).toBeNull();
    expect(fail("p2")).toBeNull();
    expect(b.record({ k: "attempt_ok", model: "m" })).toBeNull();
    expect(fail("p3")).toBeNull();
    expect(fail("p4")).toBeNull();
    // Another model and retryable kinds do not count.
    expect(fail("p1", "other")).toBeNull();
    expect(
      b.record({ k: "attempt_failed", model: "m", seat: "p1", kind: "rate_limit" }),
    ).toBeNull();
    expect(fail("p2")).toEqual({
      kind: "breaker",
      message: "3 consecutive bad_request failures on m",
      seat: "p2",
      model: "m",
    });
    // Counting starts over after a trip.
    expect(fail("p2")).toBeNull();
  });

  test("3 consecutive LLM turns closed by a systemic error, any seats, trip it; a clean turn resets", () => {
    const b = new Breaker();
    const err = (seat: `p${number}`, systemic = true) =>
      b.record({ k: "turn_error", seat, error: "x", systemic });
    expect(err("p1")).toBeNull();
    expect(err("p2")).toBeNull();
    expect(b.record({ k: "turn_ok", seat: "p3" })).toBeNull();
    expect(err("p1")).toBeNull();
    expect(err("p2")).toBeNull();
    // A refusal, a truncation or a deadline abort neither counts nor resets.
    expect(err("p4", false)).toBeNull();
    expect(err("p4", false)).toBeNull();
    expect(err("p3")?.message).toBe("3 consecutive LLM turns closed by an error (last: p3: x)");
  });

  test("a tripped breaker closes the arena gate", async () => {
    const time = virtualTime();
    const gate = new ArenaPauseGate({
      clock: { time, random: () => 0 },
      mode: "wait",
      probe: () => Promise.resolve(true),
    });
    for (const seat of ["p1", "p2", "p3"] as const) {
      gate.record({ k: "attempt_failed", model: "m", seat, kind: "unknown" });
    }
    expect(gate.isClosed).toBe(true);
    await time.run(() => gate.open());
    expect(gate.isClosed).toBe(false);
    expect(gate.pausedMs()).toBe(120_000);
  });

  test("a breaker that trips again before any clean LLM turn since its resume aborts: the cause persists", async () => {
    const time = virtualTime();
    const aborts: ArenaAborted[] = [];
    const gate = new ArenaPauseGate({
      clock: { time, random: () => 0 },
      mode: "wait",
      probe: () => Promise.resolve(true),
      onAbort: (e) => aborts.push(e),
    });
    const trip = (): void => {
      for (const seat of ["p1", "p2", "p3"] as const) {
        gate.record({ k: "turn_error", seat, error: "bad_request (400)", systemic: true });
      }
    };
    trip();
    await time.run(() => gate.open());
    // A clean turn after the resume: a later trip pauses again (and resumes).
    gate.record({ k: "turn_ok", seat: "p4" });
    trip();
    expect(gate.isClosed).toBe(true);
    await time.run(() => gate.open());
    expect(aborts).toHaveLength(0);
    // No clean turn since that resume: the next trip aborts at once.
    trip();
    expect(aborts).toHaveLength(1);
    expect(aborts[0]?.message).toContain("the breaker tripped again before any LLM turn closed");
    expect(await rejection(gate.open())).toBeInstanceOf(ArenaAborted);
  });

  test("real time: a tripped breaker is an alert, never an abort; operator errors still abort", async () => {
    const time = virtualTime();
    const alerts: string[] = [];
    const gate = new ArenaPauseGate({
      clock: { time, random: () => 0 },
      mode: "abort",
      probe: () => Promise.resolve(true),
      onAlert: (r) => alerts.push(r.message),
    });
    for (const seat of ["p1", "p2", "p3"] as const) {
      gate.record({
        k: "turn_error",
        seat,
        error: "rate_limit (429), retries exhausted",
        systemic: true,
      });
    }
    expect(alerts).toEqual([
      "3 consecutive LLM turns closed by an error (last: p3: rate_limit (429), retries exhausted)",
    ]);
    expect(gate.abortError).toBeNull();
    await gate.open();
    gate.close({ kind: "auth", message: "invalid x-api-key", seat: "p1", model: "m" });
    expect(gate.abortError?.message).toContain("real time cannot pause");
  });

  test("real time: a second trip with no clean LLM turn since the alert aborts; a clean turn resets", () => {
    const time = virtualTime();
    const alerts: string[] = [];
    const gate = new ArenaPauseGate({
      clock: { time, random: () => 0 },
      mode: "abort",
      probe: () => Promise.resolve(true),
      onAlert: (r) => alerts.push(r.message),
    });
    const trip = (): void => {
      for (const seat of ["p1", "p2", "p3"] as const) {
        gate.record({ k: "turn_error", seat, error: "bad_request (400)", systemic: true });
      }
    };
    trip();
    gate.record({ k: "turn_ok", seat: "p4" });
    trip();
    expect(alerts).toHaveLength(2);
    expect(gate.abortError).toBeNull();
    trip();
    expect(alerts).toHaveLength(2);
    expect(gate.abortError?.message).toContain(
      "the breaker tripped again before any LLM turn closed cleanly since its last alert",
    );
  });
});

describe("gates", () => {
  test("NoPauseGate never waits; a close turns every later wait into ArenaAborted", async () => {
    const gate = new NoPauseGate();
    await gate.open();
    gate.close({ kind: "auth", message: "401", seat: "p1", model: "m" });
    const e = await gate.open().then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ArenaAborted);
  });

  test("a wait behind a closed gate ends with its own signal", async () => {
    const time = virtualTime();
    const gate = new ArenaPauseGate({
      clock: { time, random: () => 0 },
      mode: "wait",
      probe: () => Promise.resolve(false),
      pauseMaxMs: 10_000_000,
    });
    gate.close({ kind: "billing", message: "402", seat: null, model: null });
    const ctl = new AbortController();
    const waiting = gate.open(ctl.signal).then(
      () => "opened",
      (e: unknown) => String(e),
    );
    ctl.abort(new Error("deadline"));
    expect(await waiting).toBe("Error: deadline");
  });
});

const top = (): number => 0.999_999;

describe("retry policy", () => {
  test("full jitter under a doubling ceiling capped at 120 s; retry-after wins, plus up to 2 s", () => {
    expect([0, 1, 2, 3, 4, 5, 10].map((k) => backoffMs(k, null, top))).toEqual([
      4999, 9999, 19999, 39999, 79999, 119999, 119999,
    ]);
    expect(backoffMs(3, null, () => 0)).toBe(0);
    expect(backoffMs(0, 7_000, () => 0.5)).toBe(8_000);
  });

  test("the retry budget stops while the gate is paused", async () => {
    const time = virtualTime();
    const clock = { time, random: () => 0 };
    let ok = false;
    const gate = new ArenaPauseGate({ clock, mode: "wait", probe: () => Promise.resolve(ok) });
    const budget = new RetryBudget(clock, gate, 1_000);
    await time.run(async () => {
      gate.close({ kind: "auth", message: "401", seat: "p1", model: "m" });
      ok = true;
      await gate.open();
    });
    expect(time.nowMs()).toBe(120_000);
    expect(budget.elapsed()).toBe(0);
    expect(budget.allows(1_000)).toBe(true);
    expect(budget.allows(1_001)).toBe(false);
  });
});
