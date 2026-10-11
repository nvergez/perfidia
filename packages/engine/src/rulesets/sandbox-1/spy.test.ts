import { describe, expect, test } from "bun:test";
import { addBuildItem, addMovement, addStationed } from "@perfidia/engine/testing";
import { STANDARD_EVENT_DATA } from "@perfidia/protocol";
import { SANDBOX_1_DEFAULTS } from "./config.ts";
import { counterIntel, landPopPresent } from "./spy.ts";
import { cityOf, sandboxCity, sandboxMatch, sandboxState } from "./testkit.test.ts";

// `hooks.arrive.spy` (docs/architecture.md §3.8): success iff gold > 50 + Σ land pop present (ties
// to the target); a failure warns the owner with `spy_detected`, the spier gets `spy_failed`.

function scene(gold: number, spierOwnsTarget = false) {
  const now = 30000;
  const { state, rules } = sandboxState({ players: 3, now });
  sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
  sandboxCity(state, rules, {
    owner: spierOwnsTarget ? "p1" : "p2",
    id: "c2",
    island: "i3",
    units: { spearman: 10, colonist: 1, boat: 2 },
    stock: 300,
  });
  sandboxCity(state, rules, { owner: "p2", id: "c4", island: "i4", capital: true });
  sandboxCity(state, rules, { owner: "p3", id: "c3", island: "i5", capital: true });
  addStationed(state, "c2", {
    owner: "p3",
    home: "c3",
    role: "support",
    units: { axeman: 4, boat: 1 },
  });
  addBuildItem(state, rules, "c2", "camp", { end: now + 90000 });
  const arriveAt = now + 6000;
  const spy = addMovement(state, rules, {
    kind: "spy",
    owner: "p1",
    from: "c1",
    to: "c2",
    gold,
    party: "p2",
    departAt: now - 1000,
    arriveAt,
  });
  return { match: sandboxMatch(state), arriveAt, spy };
}

describe("counter-intelligence", () => {
  test("50 + pop of the land units present, every owner, boats excluded", () => {
    const { match } = scene(100);
    // p2: 10 spearmen + 1 colonist (pop 5); p3: 4 axemen. Boats do not count.
    expect(landPopPresent(match.read(), "c2")).toBe(10 + 5 + 4);
    expect(counterIntel(SANDBOX_1_DEFAULTS, match.read(), "c2")).toBe(69);
  });
});

describe("arrival", () => {
  test("gold = counter-intel fails: the spier learns only that, the owner learns who", () => {
    const { match, arriveAt, spy } = scene(69);
    const { events } = match.advanceTo(arriveAt);
    expect(events).toEqual([
      {
        t: arriveAt,
        type: "spy_failed",
        public: false,
        to: [{ p: "p1", as: "self" }],
        data: { movement: spy.id, city: "c2" },
      },
      {
        t: arriveAt,
        type: "spy_detected",
        public: false,
        to: [{ p: "p2", as: "target" }],
        data: { city: "c2", by: "p1", from: "c1", gold: 69 },
      },
    ]);
    expect(match.read().state.movements[spy.id]).toBeUndefined();
  });

  test("one more gold succeeds: a snapshot report to the spier only", () => {
    const { match, arriveAt, spy } = scene(70);
    const { events } = match.advanceTo(arriveAt);
    expect(events).toHaveLength(1);
    const [report] = events;
    expect(report?.type).toBe("spy_report");
    expect(report?.to).toEqual([{ p: "p1", as: "self" }]);
    expect(STANDARD_EVENT_DATA.spy_report.safeParse(report?.data).success).toBe(true);
    expect(report?.data).toMatchObject({
      city: "c2",
      owner: "p2",
      island: "i3",
      buildings: { keep: 1, camp: 0 },
      units: { spearman: 10, colonist: 1, boat: 2 },
      stationed: [{ player: "p3", home: "c3", role: "support", units: { axeman: 4, boat: 1 } }],
      queues: [{ queue: "build", building: "camp", level: 1, end: 30000 + 90000 }],
    });
    const id = report?.data["report"];
    expect(typeof id === "string" && /^r[0-9a-z]{5}$/.test(id)).toBe(true);
    expect(match.read().state.movements[spy.id]).toBeUndefined();
    // Spying changes nothing in the city.
    expect(cityOf(match, "c2").units).toEqual({ spearman: 10, colonist: 1, boat: 2 });
  });

  test("a spy reaching a city its sender owns simply reports", () => {
    const { match, arriveAt } = scene(0, true);
    const { events } = match.advanceTo(arriveAt);
    expect(events.map((e) => e.type)).toEqual(["spy_report"]);
  });
});
