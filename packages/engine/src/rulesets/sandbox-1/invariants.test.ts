import { describe, expect, test } from "bun:test";
import { EngineBug } from "@perfidia/engine/kernel";
import { addStationed, scheduleAt } from "@perfidia/engine/testing";
import { SANDBOX_INVARIANTS } from "./invariants.ts";
import { sandboxCity, sandboxMatch, sandboxState } from "./testkit.test.ts";

// The invariants of sandbox-1 (docs/architecture.md §13.3): each catches a planted corruption, and
// a consistent state passes them all.

function base(o: { hillOpen?: boolean } = {}) {
  const now = 50000;
  const { state, rules } = sandboxState({ players: 2, now, ...o });
  sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
  sandboxCity(state, rules, { owner: "p2", id: "c2", island: "i3", capital: true });
  return { state, rules };
}

function failures(state: Parameters<typeof sandboxMatch>[0]): string[] {
  const r = sandboxMatch(state).read();
  return SANDBOX_INVARIANTS.flatMap((inv) => inv.check(r).map((f) => `${inv.name}: ${f}`));
}

describe("sandbox invariants", () => {
  test("a consistent state passes, hill closed or open", () => {
    expect(failures(base().state)).toEqual([]);
    expect(failures(base({ hillOpen: true }).state)).toEqual([]);
  });

  test("hill timer: missing while closed, still queued once open, wrong time or ref", () => {
    const missing = base();
    missing.state.queue = missing.state.queue.filter((e) => e.kind !== "hill_open");
    expect(failures(missing.state)).toEqual([
      "sandbox.hill-timer: the hill is closed and 0 hill_open events are queued, not 1",
    ]);

    const open = base({ hillOpen: true });
    scheduleAt(open.state, open.rules, "hill_open", 172800, "");
    expect(failures(open.state)).toEqual([
      "sandbox.hill-timer: the hill is open but hill_open is still queued",
    ]);

    const twice = base();
    scheduleAt(twice.state, twice.rules, "hill_open", 172800, "");
    expect(failures(twice.state)).toEqual([
      "sandbox.hill-timer: the hill is closed and 2 hill_open events are queued, not 1",
    ]);

    const moved = base();
    moved.state.queue = moved.state.queue.filter((e) => e.kind !== "hill_open");
    scheduleAt(moved.state, moved.rules, "hill_open", 90000, "x");
    expect(failures(moved.state)).toEqual([
      'sandbox.hill-timer: hill_open (seq 3) has ref "x", not ""',
      "sandbox.hill-timer: hill_open (seq 3) is at 90000, not at time.hillOpen (172800)",
    ]);
  });

  test("no neutral city, no hold group", () => {
    const { state, rules } = base();
    sandboxCity(state, rules, { owner: null, id: "c3", island: "i2" });
    addStationed(state, "c2", { owner: "p1", home: "c1", role: "hold", units: { axeman: 1 } });
    expect(failures(state)).toEqual([
      "sandbox.owned-cities: c3 is neutral; sandbox-1 has no neutral city",
      "sandbox.no-hold: c2 has a hold group of p1 from c1",
    ]);
  });

  test("the kernel runs them at every step", () => {
    const { state } = base();
    state.queue = state.queue.filter((e) => e.kind !== "hill_open");
    const match = sandboxMatch(state);
    expect(() => match.checkInvariants("step")).toThrow(EngineBug);
  });
});
