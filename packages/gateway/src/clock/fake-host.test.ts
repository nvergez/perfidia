import { describe, expect, test } from "bun:test";
import {
  call,
  describeRecord,
  FakeHost,
  FakeHostError,
  replayFakeTrace,
  traceViolations,
} from "./fake-host.ts";
import type { TurnHandle } from "./types.ts";

// The driver tests rest on this double, so its wake model and its contract checks are tested too.

function started(options: Partial<ConstructorParameters<typeof FakeHost>[0]> = {}): FakeHost {
  const host = new FakeHost({ seed: 1, endsAt: 100_000, seats: 2, ...options });
  host.start();
  return host;
}

/** `TurnHandle.close` as §9.1 writes it. */
const legacyClose = (error?: string): void => void error;

describe("FakeHost", () => {
  test("every seat starts due at 0; a seat in a turn has no wake time", () => {
    const host = started();
    expect(host.dueSeats(0)).toEqual(["p1", "p2"]);
    const h = host.openTurn("p1");
    expect(host.wakeTime("p1")).toBeNull();
    expect(host.dueSeats(0)).toEqual(["p2"]);
    h.execute({ calls: [call("end_turn", { wakeAt: 700 })] });
    expect(h.done).toBe(true);
    h.close();
    expect(host.wakeTime("p1")).toBe(700);
  });

  test("a normal trigger during a turn wakes at max(first + window, end + 1)", () => {
    const host = started({ groupWindow: 600 });
    const h = host.openTurn("p1");
    host.advanceTo(1000);
    host.trigger("p1", "normal");
    host.advanceTo(5000);
    h.execute({ calls: [] });
    h.close();
    expect(host.wakeTime("p1")).toBe(5001);
  });

  test("urgent triggers respect the gap; defer moves a wake; safety wakes after the last end", () => {
    const host = started({ urgentGap: 600, safetyWake: 43200 });
    host.trigger("p1", "urgent");
    const h = host.openTurn("p1");
    h.execute({ calls: [] });
    h.close();
    host.trigger("p1", "urgent");
    expect(host.wakeTime("p1")).toBe(600);
    host.defer("p1", 900);
    expect(host.wakeTime("p1")).toBe(900);
    const h2 = host.openTurn("p2");
    h2.execute({ calls: [] });
    h2.close();
    expect(host.wakeTime("p2")).toBe(43200);
  });

  test("throws when a driver breaks the contract", () => {
    const host = started();
    expect(() => host.openTurn("p1")).not.toThrow();
    expect(() => host.openTurn("p1")).toThrow(FakeHostError);
    expect(() => host.advanceTo(-1)).toThrow("time goes back");
    expect(() => host.advanceTo(200_000)).toThrow("beyond endsAt");
    expect(() => host.finish()).toThrow("turns still open: p1");
    const other = started();
    other.advanceTo(10);
    const h = other.openTurn("p2");
    expect(() => h.close()).toThrow("not done");
    h.execute({ calls: [call("end_turn")] });
    expect(() => h.execute({ calls: [] })).toThrow("after the turn ended");
    h.close();
    expect(() => h.close()).toThrow("twice");
    expect(() => other.openTurn("p2")).toThrow("not due");
  });

  test("calls after end_turn get TURN_OVER, calls after the end MATCH_ENDED", () => {
    const host = started({ endsAt: 50, doneOnEnd: false });
    const h = host.openTurn("p1");
    h.execute({ calls: [call("view_city"), call("end_turn"), call("attack", { target: "p2" })] });
    h.close();
    expect(host.wakeTime("p2")).toBe(0);
    const h2 = host.openTurn("p2");
    host.advanceTo(50);
    h2.execute({ calls: [call("attack", { target: "p1" })] });
    expect(h2.done).toBe(false);
    h2.execute({ calls: [call("end_turn")] });
    h2.close();
    expect(host.trace.map(describeRecord).filter((l) => l.startsWith("exec"))).toEqual([
      "exec p1#1.0 @0 view_city,end_turn,attack!TURN_OVER",
      "exec p2#1.0 @50 attack!MATCH_ENDED",
      "exec p2#1.1 @50 end_turn!MATCH_ENDED",
    ]);
  });

  test("close(failure) logs the failure's cause as why; a §9.1-style close(error?: string) does not type-check", () => {
    const host = started();
    host.openTurn("p1").close({ error: "no answer within 5000 ms", cause: "timeout" });
    host.openTurn("p2").close({ error: "Error: boom", cause: "error" });
    expect(host.trace.map(describeRecord).filter((l) => l.startsWith("turn"))).toEqual([
      "turn p1#1 @0 timeout: no answer within 5000 ms",
      "turn p2#1 @0 error: Error: boom",
    ]);
    // @ts-expect-error -- a host written to the §9.1 signature would log every timeout as "error"
    const close: TurnHandle["close"] = legacyClose;
    expect(typeof close).toBe("function");
  });

  test("a trace replays to itself, and the invariant checker catches a broken one", () => {
    const options = { seed: 1, endsAt: 100, seats: 1 };
    const host = new FakeHost(options);
    host.start();
    const h = host.openTurn("p1");
    h.execute({ calls: [call("send_message", { to: "p1" })], thought: "hm" });
    h.execute({ calls: [] });
    h.close();
    host.advanceTo(100);
    host.finish();
    expect(traceViolations(host.trace)).toEqual([]);
    expect(replayFakeTrace(options, host.trace).trace).toEqual(host.trace);
    const broken = host.trace.filter((r) => r.k !== "turn");
    expect(traceViolations(broken)).toEqual(["turns left open: p1"]);
    const twice = [...host.trace.slice(0, 3), ...host.trace.slice(1)];
    expect(traceViolations(twice).length).toBeGreaterThan(0);
  });
});
