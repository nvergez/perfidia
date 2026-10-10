import { describe, expect, test } from "bun:test";
import type { DepartureDraft, DepartureVerdict } from "@perfidia/engine/contracts";
import type { Match } from "@perfidia/engine/kernel";
import {
  type Action,
  type CityId,
  type IslandId,
  MovementIdSchema,
  type PlayerId,
  type UnitCounts,
} from "@perfidia/protocol";
import { besiege, city, cityIn, load, plain, world } from "./fixtures.test.ts";

// `hooks.departure` (perfidia-1 §7.3) and `hooks.guard` (§9.2): foe and party, relief of an own
// besieged city, NOT_BESIEGER, CITY_BESIEGED, the garrison that cannot be dismissed.

const T = 200000;
const ENDS = T + 21600;

/**
 * p1: c1 (i1) and c4 (i3, besieged by p3); p2: c2 (i2); p3: c3 (i3); p5: c5 (i4, besieged by p2);
 * p6: c6 (i1); the neutral Crown c7 (i2).
 */
function setting(): Match {
  const w = world({ now: T });
  city(w, {
    id: "c1",
    owner: "p1",
    island: "i1",
    buildings: { warehouse: 1 },
    stock: 500,
    units: { raider: 10, warship: 2, transport: 1 },
  });
  city(w, { id: "c2", owner: "p2", island: "i2" });
  city(w, { id: "c3", owner: "p3", island: "i3" });
  city(w, { id: "c4", owner: "p1", island: "i3" });
  city(w, { id: "c5", owner: "p5", island: "i4" });
  city(w, { id: "c6", owner: "p6", island: "i1" });
  city(w, { id: "c7", owner: null, island: "i2", tag: "crown" });
  besiege(w, { city: "c4", by: "p3", garrison: [{ home: "c3", units: { settler: 1 } }] });
  besiege(w, { city: "c5", by: "p2", garrison: [{ home: "c2", units: { settler: 1 } }] });
  return load(w);
}

function draft(
  match: Match,
  kind: DepartureDraft["kind"],
  owner: PlayerId,
  from: CityId,
  to: CityId | null,
  o: { units?: UnitCounts; island?: IslandId } = {},
): DepartureDraft {
  const target = to === null ? undefined : match.read().state.cities[to];
  return {
    kind,
    owner,
    from,
    to,
    island: o.island ?? target?.island ?? "i1",
    slot: null,
    units: o.units ?? {},
    cargo: { wood: kind === "shipment" ? 10 : 0, stone: 0, gold: 0 },
    gold: kind === "spy" ? 100 : 0,
  };
}

function verdict(match: Match, d: DepartureDraft): DepartureVerdict {
  const hooks = match.ruleset.hooks;
  if (hooks.departure === undefined) throw new Error("perfidia-1 has a departure hook");
  return hooks.departure(match.read(), d);
}

const RAIDERS = { units: { raider: 5 } };

describe("hooks.departure (§7.3)", () => {
  test("an attack records the owner as its foe, or the besieger of a besieged target", () => {
    const m = setting();
    expect(verdict(m, draft(m, "attack", "p1", "c1", "c2", RAIDERS))).toEqual({
      ok: true,
      party: "p2",
    });
    expect(verdict(m, draft(m, "attack", "p1", "c1", "c5", RAIDERS))).toEqual({
      ok: true,
      party: "p2",
    });
    expect(verdict(m, draft(m, "attack", "p1", "c1", "c7", RAIDERS))).toEqual({
      ok: true,
      party: null,
    });
  });

  test("an own city only as a relief of its siege, never a city the mover besieges", () => {
    const m = setting();
    expect(verdict(m, draft(m, "attack", "p1", "c1", "c4", RAIDERS))).toEqual({
      ok: true,
      party: "p3",
    });
    expect(verdict(m, draft(m, "attack", "p2", "c2", "c2", RAIDERS))).toEqual({
      ok: false,
      violation: {
        code: "INVALID_TARGET",
        details: { city: "c2", kind: "attack", reason: "own_city" },
      },
    });
    expect(verdict(m, draft(m, "attack", "p2", "c2", "c5", RAIDERS))).toEqual({
      ok: false,
      violation: {
        code: "INVALID_TARGET",
        details: { city: "c5", kind: "attack", reason: "besieged_by_you" },
      },
    });
  });

  test("an attack must fight: a land attacker, or a warship across water", () => {
    const m = setting();
    const ships = { units: { warship: 2 } };
    expect(verdict(m, draft(m, "attack", "p1", "c1", "c2", ships)).ok).toBe(true);
    expect(verdict(m, draft(m, "attack", "p1", "c1", "c2", { units: { transport: 1 } }))).toEqual({
      ok: false,
      violation: { code: "NO_UNITS", details: { kind: "attack", crossing: true } },
    });
    // c6 shares i1 with c1: warships alone cannot fight on the same island.
    expect(verdict(m, draft(m, "attack", "p1", "c1", "c6", ships))).toEqual({
      ok: false,
      violation: { code: "NO_UNITS", details: { kind: "attack", crossing: false } },
    });
  });

  test("only the besieger may support a besieged city, recorded as the party", () => {
    const m = setting();
    const blocked = { code: "NOT_BESIEGER", details: { city: "c5", by: "p2", endsAt: ENDS } };
    expect(verdict(m, draft(m, "support", "p1", "c1", "c5", RAIDERS))).toEqual({
      ok: false,
      violation: blocked,
    });
    expect(verdict(m, draft(m, "support", "p1", "c1", "c4", RAIDERS))).toEqual({
      ok: false,
      violation: { code: "NOT_BESIEGER", details: { city: "c4", by: "p3", endsAt: ENDS } },
    });
    expect(verdict(m, draft(m, "support", "p2", "c2", "c5", RAIDERS))).toEqual({
      ok: true,
      party: "p2",
    });
    expect(verdict(m, draft(m, "support", "p1", "c1", "c2", RAIDERS))).toEqual({
      ok: true,
      party: "p2",
    });
  });

  test("the besieger of the neutral Crown reinforces it with support; nobody supports it otherwise", () => {
    const free = setting();
    expect(verdict(free, draft(free, "support", "p1", "c1", "c7", RAIDERS))).toEqual({
      ok: false,
      violation: { code: "INVALID_TARGET", details: { city: "c7", kind: "support" } },
    });
    const w = world({ now: T });
    city(w, { id: "c1", owner: "p1", island: "i1", units: { guard: 20, settler: 1 } });
    city(w, { id: "c2", owner: "p2", island: "i2", units: { guard: 5 } });
    city(w, { id: "c7", owner: null, island: "i2", tag: "crown" });
    besiege(w, {
      city: "c7",
      by: "p1",
      garrison: [{ home: "c1", units: { settler: 1, raider: 5 } }],
    });
    const m = load(w);
    const units = { guard: 20, settler: 1 };
    expect(verdict(m, draft(m, "support", "p1", "c1", "c7", { units }))).toEqual({
      ok: true,
      party: "p1",
    });
    expect(verdict(m, draft(m, "support", "p2", "c2", "c7", RAIDERS))).toEqual({
      ok: false,
      violation: { code: "NOT_BESIEGER", details: { city: "c7", by: "p1", endsAt: ENDS } },
    });
    expect(verdict(m, draft(m, "attack", "p1", "c1", "c7", { units }))).toMatchObject({
      ok: false,
      violation: { details: { reason: "besieged_by_you" } },
    });

    const out = m.apply("p1", { type: "support", from: "c1", to: "c7", units });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const id = MovementIdSchema.parse(out.data["movement"]);
    const arriveAt = m.read().state.movements[id]?.arriveAt ?? 0;
    const { events } = m.advanceTo(arriveAt);
    expect(events.map((e) => e.type)).toEqual(["support_arrived"]);
    expect(events[0]?.to).toEqual([{ p: "p1", as: "self" }]);
    expect(plain(cityIn(m, "c7").stationed)).toEqual([
      { owner: "p1", home: "c1", role: "hold", units: { guard: 20, raider: 5, settler: 2 } },
    ]);
    expect(m.read().state.movements[id]).toBeUndefined();
  });

  test("no shipment to a besieged city; spies may watch one; nothing leaves a besieged city", () => {
    const m = setting();
    expect(verdict(m, draft(m, "shipment", "p1", "c1", "c5"))).toEqual({
      ok: false,
      violation: { code: "CITY_BESIEGED", details: { city: "c5", by: "p2", endsAt: ENDS } },
    });
    expect(verdict(m, draft(m, "spy", "p1", "c1", "c5"))).toEqual({ ok: true, party: "p5" });
    expect(verdict(m, draft(m, "shipment", "p1", "c1", "c2"))).toEqual({ ok: true, party: "p2" });
    for (const kind of ["attack", "support", "spy", "shipment", "found"] as const) {
      expect(
        verdict(m, draft(m, kind, "p1", "c4", kind === "found" ? null : "c2", RAIDERS)),
      ).toEqual({
        ok: false,
        violation: { code: "CITY_BESIEGED", details: { city: "c4", by: "p3", endsAt: ENDS } },
      });
    }
  });
});

describe("hooks.guard (§9.2)", () => {
  const FROM_C4: readonly Action[] = [
    { type: "build", city: "c4", building: "hall" },
    { type: "recruit", city: "c4", unit: "guard", count: 1 },
    { type: "send_resources", from: "c4", to: "c1", res: { wood: 1, stone: 0, gold: 0 } },
    { type: "attack", from: "c4", to: "c2", units: { raider: 1 } },
    { type: "support", from: "c4", to: "c1", units: { raider: 1 } },
    { type: "spy", from: "c4", to: "c2", gold: 100 },
    { type: "found_city", from: "c4", island: "i4", units: { settler: 1 }, slot: null },
    { type: "dismiss", city: "c4", player: "p3" },
  ];

  for (const a of FROM_C4) {
    test(`the owner of a besieged city cannot ${a.type} from it`, () => {
      const m = setting();
      const before = m.hash();
      expect(m.apply("p1", a)).toEqual({
        ok: false,
        violation: { code: "CITY_BESIEGED", details: { city: "c4", by: "p3", endsAt: ENDS } },
      });
      expect(m.hash()).toBe(before);
    });
  }

  test("other players, other cities and recalls are left to the actions' own checks", () => {
    const m = setting();
    const r = m.read();
    const hooks = m.ruleset.hooks;
    const call = (seat: PlayerId, a: Action) => {
      if (hooks.guard === undefined) throw new Error("perfidia-1 has a guard");
      return hooks.guard(r, seat, a);
    };
    expect(call("p2", { type: "build", city: "c4", building: "hall" })).toBeNull();
    expect(call("p1", { type: "build", city: "c1", building: "hall" })).toBeNull();
    expect(call("p1", { type: "dismiss", city: "c4", player: "p2" })).toBeNull();
    expect(call("p1", { type: "recall_stationed", at: "c2", home: "c4", units: null })).toBeNull();
    expect(call("p3", { type: "recall_stationed", at: "c4", home: "c3", units: null })).toBeNull();
    expect(call("p1", { type: "cancel_queue", city: "c4", item: 1 })).toBeNull();
  });
});
