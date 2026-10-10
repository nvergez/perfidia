import { describe, expect, test } from "bun:test";
import { fmtTime } from "@perfidia/engine/core";
import type { AnyRuleset } from "@perfidia/engine/contracts";
import {
  defaultDeparture,
  foundCity as stdFoundCity,
  inFlightCargo,
  stockAt,
} from "@perfidia/engine/std";
import {
  addBuildItem,
  addCity,
  addMovement,
  addStationed,
  testStep,
} from "@perfidia/engine/testing";
import {
  MovementIdSchema,
  type Action,
  type CityId,
  type IslandId,
  type MovementId,
  type Res,
  type UnitCounts,
} from "@perfidia/protocol";
import {
  RICH,
  RICH_OPTIONS,
  accepted,
  cityIn,
  cityOf,
  load,
  res,
  violation,
  world,
} from "./fixtures.test.ts";

const at = (t: number): [number, string] => [t, fmtTime(t)];
const attack = (from: CityId, to: CityId, units: UnitCounts): Action => ({
  type: "attack",
  from,
  to,
  units,
});
const support = (from: CityId, to: CityId, units: UnitCounts): Action => ({
  type: "support",
  from,
  to,
  units,
});
const spy = (from: CityId, to: CityId, gold: number): Action => ({ type: "spy", from, to, gold });
const ship = (from: CityId, to: CityId, r: Res): Action => ({
  type: "send_resources",
  from,
  to,
  res: r,
});
const found = (from: CityId, island: IslandId, units: UnitCounts, slot: number | null = null) =>
  ({ type: "found_city", from, island, units, slot }) satisfies Action;

const ARMY = { soldier: 20, raider: 10, pioneer: 1, ship: 3, galley: 1 };

function army(ruleset: AnyRuleset = RICH, overrides = {}) {
  const { state, rules } = world({ ruleset, units: { c1: ARMY } });
  return { state, rules, m: () => load(state, ruleset, overrides) };
}

function movementId(data: Record<string, unknown>): MovementId {
  return MovementIdSchema.parse(data["movement"]);
}

describe("attack", () => {
  test("launches with the recorded foe, the arrival and the incoming notice", () => {
    const m = army().m();
    const out = m.apply("p1", attack("c1", "c3", { raider: 5 }));
    const data = accepted(out);
    expect(data).toEqual({
      movement: data["movement"] ?? null,
      kind: "attack",
      from: "c1",
      to: "c3",
      island: "i1",
      party: "p3",
      units: { raider: 5 },
      paid: res(0, 0, 0),
      depart: at(0),
      arrive: [3600, "D1 01:00"],
    });
    const id = movementId(data);
    expect(out.ok && out.events).toEqual([
      {
        t: 0,
        type: "incoming_attack",
        public: false,
        to: [{ p: "p3", as: "party" }],
        data: {
          movement: id,
          from: "c1",
          by: "p1",
          foe: "p3",
          to: "c3",
          departAt: 0,
          arriveAt: 3600,
          homecoming: false,
        },
      },
    ]);
    expect(cityIn(m, "c1").units).toEqual({
      soldier: 20,
      raider: 5,
      pioneer: 1,
      ship: 3,
      galley: 1,
    });
  });

  test("across water, land units need carrier capacity (transport rule)", () => {
    const m = army().m();
    expect(violation(m.apply("p1", attack("c1", "c2", { raider: 5 })))).toEqual({
      code: "TRANSPORT_CAPACITY",
      details: { city: "c1", island: "i2", need: 5, capacity: 0, missing: 5 },
    });
    expect(accepted(m.apply("p1", attack("c1", "c2", { raider: 5, ship: 1 })))).toMatchObject({
      arrive: at(5400),
    });
    // Across water, a naval group fights only with naval strength.
    expect(violation(m.apply("p1", attack("c1", "c2", { ship: 1 })))).toEqual({
      code: "NO_UNITS",
      details: { kind: "attack", crossing: true },
    });
    expect(accepted(m.apply("p1", attack("c1", "c2", { galley: 1 })))).toMatchObject({
      party: "p2",
    });
  });

  test("generic departure violations carry their numbers", () => {
    const m = army().m();
    expect(violation(m.apply("p1", attack("c9", "c3", { raider: 1 })))).toEqual({
      code: "UNKNOWN_ID",
      details: { city: "c9" },
    });
    expect(violation(m.apply("p1", attack("c2", "c3", { soldier: 1 })))).toEqual({
      code: "NOT_OWNER",
      details: { city: "c2", owner: "p2" },
    });
    expect(violation(m.apply("p1", attack("c1", "c9", { raider: 1 })))).toEqual({
      code: "UNKNOWN_ID",
      details: { city: "c9" },
    });
    expect(violation(m.apply("p1", attack("c1", "c3", { dragon: 1 })))).toEqual({
      code: "INVALID_ARGS",
      details: { unit: "dragon", reason: "unknown_unit" },
    });
    expect(violation(m.apply("p1", attack("c1", "c3", {})))).toEqual({
      code: "NO_UNITS",
      details: { city: "c1", kind: "attack" },
    });
    expect(violation(m.apply("p1", attack("c1", "c3", { raider: 50 })))).toEqual({
      code: "INSUFFICIENT_UNITS",
      details: { city: "c1", unit: "raider", requested: 50, home: 10 },
    });
    expect(violation(m.apply("p1", attack("c1", "c1", { raider: 1 })))).toEqual({
      code: "INVALID_TARGET",
      details: { city: "c1", kind: "attack" },
    });
  });

  test("ATTACK_PROTECTION until attackFrom", () => {
    const m = army(RICH, { "time.attackFrom": 3600 }).m();
    expect(violation(m.apply("p1", attack("c1", "c3", { raider: 1 })))).toEqual({
      code: "ATTACK_PROTECTION",
      details: { city: "c1", availableAt: 3600 },
    });
    // Other departures are allowed during protection.
    accepted(m.apply("p1", support("c1", "c3", { soldier: 1 })));
    m.advanceTo(3600);
    accepted(m.apply("p1", attack("c1", "c3", { raider: 1 })));
  });

  test("INSUFFICIENT_UNITS gives backAt when units are on their way home, null when not", () => {
    const { state, rules } = world({ units: { c1: ARMY } });
    addStationed(state, "c3", { owner: "p1", home: "c1", role: "support", units: { soldier: 2 } });
    addMovement(state, rules, {
      kind: "return",
      owner: "p1",
      from: "c3",
      to: "c1",
      home: "c1",
      units: { raider: 4 },
      departAt: 0,
      arriveAt: 900,
    });
    const m = load(state);
    expect(violation(m.apply("p1", attack("c1", "c3", { raider: 11 }))).details).toEqual({
      city: "c1",
      unit: "raider",
      requested: 11,
      home: 10,
      backAt: 900,
    });
    expect(violation(m.apply("p1", attack("c1", "c3", { soldier: 21 }))).details).toEqual({
      city: "c1",
      unit: "soldier",
      requested: 21,
      home: 20,
      backAt: null,
    });
  });

  test("a departure hook's warnings and adjusted group are honoured", () => {
    const hooks = RICH.hooks;
    const warned: AnyRuleset = {
      ...RICH,
      hooks: {
        ...hooks,
        departure(r, d) {
          const v = defaultDeparture(r, d);
          if (!v.ok) return v;
          return {
            ...v,
            units: { ...d.units, ship: 2 },
            warnings: [{ code: "TEST_WARNING", details: { city: d.from } }],
          };
        },
      },
    };
    const { state } = world({ ruleset: warned, units: { c1: ARMY } });
    const m = load(state, warned);
    const out = m.apply("p1", attack("c1", "c3", { raider: 1 }));
    expect(out.ok && out.warnings).toEqual([{ code: "TEST_WARNING", details: { city: "c1" } }]);
    expect(cityIn(m, "c1").units["ship"]).toBe(1);
    // The adjusted group must be at home too.
    expect(violation(m.apply("p1", attack("c1", "c3", { raider: 1 }))).details).toMatchObject({
      unit: "ship",
      requested: 2,
      home: 1,
    });
  });

  test("a departure hook's adjusted group is held to the transport rule too", () => {
    const hooks = RICH.hooks;
    const swapped: AnyRuleset = {
      ...RICH,
      hooks: {
        ...hooks,
        departure(r, d) {
          const v = defaultDeparture(r, d);
          return v.ok ? { ...v, units: { soldier: 5 } } : v;
        },
      },
    };
    const m = load(world({ ruleset: swapped, units: { c1: ARMY } }).state, swapped);
    expect(violation(m.apply("p1", support("c1", "c2", { soldier: 1, ship: 1 })))).toEqual({
      code: "TRANSPORT_CAPACITY",
      details: { city: "c1", island: "i2", need: 5, capacity: 0, missing: 5 },
    });
    expect(m.read().state.movements).toEqual({});
    // On one island the rule does not apply: the adjusted group leaves.
    expect(accepted(m.apply("p1", support("c1", "c3", { soldier: 1 })))).toMatchObject({
      units: { soldier: 5 },
    });
  });
});

describe("support", () => {
  test("is stationed with the owner's full copy and the sender's short one", () => {
    const m = army().m();
    const id = movementId(accepted(m.apply("p1", support("c1", "c2", { soldier: 5, ship: 1 }))));
    const events = m.advanceTo(5400).events;
    expect(events.filter((e) => e.type === "support_arrived")).toEqual([
      {
        t: 5400,
        type: "support_arrived",
        public: false,
        to: [{ p: "p2", as: "party" }],
        data: { movement: id, by: "p1", to: "c2", units: { soldier: 5, ship: 1 } },
      },
      {
        t: 5400,
        type: "support_arrived",
        public: false,
        to: [{ p: "p1", as: "self" }],
        data: { movement: id, by: "p1", to: "c2" },
      },
    ]);
    expect(cityIn(m, "c2").stationed).toEqual([
      { owner: "p1", home: "c1", role: "support", units: { soldier: 5, ship: 1 } },
    ]);
  });

  test("bounces when the target's owner is not the party recorded at launch", () => {
    const { state, rules } = world({ units: { c1: ARMY } });
    const mv = addMovement(state, rules, {
      kind: "support",
      owner: "p1",
      from: "c1",
      to: "c2",
      party: "p3",
      units: { soldier: 3, ship: 1 },
      arriveAt: 100,
    });
    const m = load(state);
    const bounced = m.advanceTo(100).events;
    expect(bounced).toEqual([
      {
        t: 100,
        type: "bounced",
        public: false,
        to: [{ p: "p1", as: "self" }],
        data: { movement: mv.id, kind: "support", reason: "owner_changed" },
      },
    ]);
    const home = m.advanceTo(5500).events;
    expect(home.map((e) => e.type)).toEqual(["returned"]);
    expect(cityIn(m, "c1").units).toEqual({ ...ARMY, soldier: 23, ship: 4 });
  });

  test("a support re-homed to its own target arrives home", () => {
    const { state, rules } = world({ units: { c1: ARMY } });
    addCity(state, rules, { owner: "p1", id: "c4", island: "i2", buildings: { vault: 1 } });
    const mv = addMovement(state, rules, {
      kind: "support",
      owner: "p1",
      from: "c4",
      to: "c1",
      home: "c1",
      party: "p1",
      units: { soldier: 2 },
      arriveAt: 5400,
    });
    const m = load(state);
    expect(m.advanceTo(5400).events).toEqual([
      {
        t: 5400,
        type: "returned",
        public: false,
        to: [{ p: "p1", as: "self" }],
        data: { movement: mv.id, city: "c1", units: { soldier: 2 }, cargo: res(0, 0, 0) },
      },
    ]);
    expect(cityIn(m, "c1").units).toEqual({ ...ARMY, soldier: 22 });
  });

  test("a neutral or own origin city is not a support target", () => {
    const { state, rules } = world({ units: { c1: ARMY } });
    addCity(state, rules, { owner: null, id: "c4", island: "i1" });
    const m = load(state);
    expect(violation(m.apply("p1", support("c1", "c4", { soldier: 1 })))).toEqual({
      code: "INVALID_TARGET",
      details: { city: "c4", kind: "support" },
    });
    expect(violation(m.apply("p1", support("c1", "c1", { soldier: 1 }))).code).toBe(
      "INVALID_TARGET",
    );
  });
});

describe("spy", () => {
  test("pays its gold at departure and tells no one", () => {
    const m = army().m();
    const out = m.apply("p1", spy("c1", "c2", 20));
    expect(accepted(out)).toMatchObject({
      kind: "spy",
      party: "p2",
      units: {},
      paid: res(0, 0, 20),
      arrive: at(5400),
    });
    expect(out.ok && out.events).toEqual([]);
    expect(stockAt(m.read(), "c1").gold).toBe(480);
  });

  test("violations carry their numbers", () => {
    const m = army().m();
    expect(violation(m.apply("p1", spy("c1", "c2", 5)))).toEqual({
      code: "SPY_GOLD",
      details: { min: 10, gold: 5 },
    });
    expect(violation(m.apply("p1", spy("c1", "c2", 600)))).toEqual({
      code: "INSUFFICIENT_RESOURCES",
      details: { city: "c1", need_gold: 600, have_gold: 500, rate_gold: 60, availableAt: 6000 },
    });
    expect(violation(m.apply("p1", spy("c1", "c1", 50))).code).toBe("INVALID_TARGET");
  });
});

describe("send_resources", () => {
  test("delivers capped, with the amounts to the recipient and the outcome only to the sender", () => {
    const m = army().m();
    const sent = accepted(m.apply("p1", ship("c1", "c3", res(50, 0, 0))));
    expect(sent).toMatchObject({ kind: "shipment", units: {}, paid: res(50, 0, 0) });
    expect(stockAt(m.read(), "c1").wood).toBe(450);
    const id = movementId(sent);
    const delivered = m.advanceTo(3600).events.filter((e) => e.type === "shipment_delivered");
    expect(delivered).toEqual([
      {
        t: 3600,
        type: "shipment_delivered",
        public: false,
        to: [{ p: "p3", as: "party" }],
        data: {
          movement: id,
          to: "c3",
          outcome: "delivered",
          by: "p1",
          from: "c1",
          res: res(50, 0, 0),
          lost: res(0, 0, 0),
        },
      },
      {
        t: 3600,
        type: "shipment_delivered",
        public: false,
        to: [{ p: "p1", as: "self" }],
        data: { movement: id, to: "c3", outcome: "delivered" },
      },
    ]);
    expect(stockAt(m.read(), "c3").wood).toBe(500 + 60 + 50);
  });

  test("the in-flight cap counts shipments and the returns of bounced ones", () => {
    const { state, rules } = world({ units: { c1: ARMY } });
    addMovement(state, rules, {
      kind: "shipment",
      owner: "p1",
      from: "c1",
      to: "c2",
      party: "p3",
      cargo: { wood: 50 },
      arriveAt: 100,
    });
    const m = load(state);
    // Its recorded party no longer owns the target, so it will bounce: its cargo counts until the
    // return lands, 5400 s after the bounce.
    expect(violation(m.apply("p1", ship("c1", "c3", res(0, 60, 0))))).toEqual({
      code: "SHIPMENT_CAPACITY",
      details: { city: "c1", cap: 100, inFlight: 50, requested: 60, availableAt: 5500 },
    });
    expect(m.advanceTo(100).events.map((e) => e.type)).toEqual(["bounced"]);
    expect(inFlightCargo(m.read(), "c1")).toBe(50);
    expect(violation(m.apply("p1", ship("c1", "c3", res(0, 60, 0)))).details).toMatchObject({
      inFlight: 50,
      availableAt: 5500,
    });
    accepted(m.apply("p1", ship("c1", "c3", res(0, 50, 0))));
    expect(inFlightCargo(m.read(), "c1")).toBe(100);
    // The shipment lands at 3700, the bounced cargo is home at 5500.
    m.advanceTo(5500);
    expect(inFlightCargo(m.read(), "c1")).toBe(0);
  });

  test("availableAt: the first second at which landed cargo or a queued level makes room", () => {
    const { state, rules } = world({ units: { c1: ARMY } });
    addMovement(state, rules, {
      kind: "shipment",
      owner: "p1",
      from: "c1",
      to: "c3",
      party: "p3",
      cargo: { wood: 80 },
      arriveAt: 3600,
    });
    const plain = load(structuredClone(state));
    expect(violation(plain.apply("p1", ship("c1", "c3", res(0, 50, 0)))).details).toEqual({
      city: "c1",
      cap: 100,
      inFlight: 80,
      requested: 50,
      availableAt: 3600,
    });
    // A queued dock level (+100) ending first makes room before the cargo lands.
    addBuildItem(state, rules, "c1", "dock", { end: 2000 });
    const m = load(state);
    expect(violation(m.apply("p1", ship("c1", "c3", res(0, 50, 0)))).details).toMatchObject({
      cap: 100,
      availableAt: 2000,
    });
    // More than any level the queue reaches: the landing cargo is what makes room.
    expect(violation(m.apply("p1", ship("c1", "c3", res(0, 150, 0)))).details).toMatchObject({
      availableAt: 3600,
    });
    expect(violation(m.apply("p1", ship("c1", "c3", res(150, 150, 0)))).details).toMatchObject({
      availableAt: null,
    });
    m.advanceTo(2000);
    accepted(m.apply("p1", ship("c1", "c3", res(0, 50, 0))));
  });

  test("the domain enforces the load and the cap when the hook does not delegate", () => {
    const lax: AnyRuleset = {
      ...RICH,
      hooks: {
        ...RICH.hooks,
        departure(r, d) {
          if (d.kind !== "shipment") return defaultDeparture(r, d);
          const target = d.to === null ? undefined : r.state.cities[d.to];
          return { ok: true, party: target?.owner ?? null };
        },
      },
    };
    const { state, rules } = world({ ruleset: lax, units: { c1: ARMY } });
    addMovement(state, rules, {
      kind: "shipment",
      owner: "p1",
      from: "c1",
      to: "c3",
      party: "p3",
      cargo: { wood: 50 },
      arriveAt: 3600,
    });
    const m = load(state, lax);
    expect(violation(m.apply("p1", ship("c1", "c3", res(0, 60, 0))))).toEqual({
      code: "SHIPMENT_CAPACITY",
      details: { city: "c1", cap: 100, inFlight: 50, requested: 60, availableAt: 3600 },
    });
    expect(violation(m.apply("p1", ship("c1", "c3", res(0, 0, 0))))).toEqual({
      code: "INVALID_ARGS",
      details: { load: 0 },
    });
    accepted(m.apply("p1", ship("c1", "c3", res(0, 50, 0))));
    expect(inFlightCargo(m.read(), "c1")).toBe(100);
  });

  test("a load of zero or beyond the stock is rejected", () => {
    const { state } = world({ units: { c1: ARMY } });
    cityOf(state, "c1").stock = res(50 * 3600, 50 * 3600, 50 * 3600);
    const m = load(state);
    expect(violation(m.apply("p1", ship("c1", "c3", res(0, 0, 0))))).toEqual({
      code: "INVALID_ARGS",
      details: { load: 0 },
    });
    expect(violation(m.apply("p1", ship("c1", "c3", res(0, 0, 90))))).toEqual({
      code: "INSUFFICIENT_RESOURCES",
      details: { city: "c1", need_gold: 90, have_gold: 50, rate_gold: 60, availableAt: 2400 },
    });
  });
});

describe("found_city", () => {
  test("founds in the lowest free slot, consumes one founder and re-homes the escort", () => {
    const m = army().m();
    const out = m.apply("p1", found("c1", "i2", { pioneer: 1, ship: 1 }));
    expect(accepted(out)).toMatchObject({ kind: "found", to: null, island: "i2", party: null });
    expect(out.ok && out.events).toEqual([]);
    const events = m.advanceTo(5400).events;
    expect(events).toEqual([
      {
        t: 5400,
        type: "city_founded",
        public: true,
        to: [{ p: "p1", as: "self" }],
        data: { city: "c4", island: "i2", slot: 1, owner: "p1" },
      },
    ]);
    const c4 = cityIn(m, "c4");
    expect([c4.owner, c4.island, c4.slot, c4.units]).toEqual(["p1", "i2", 1, { ship: 1 }]);
    expect(m.read().state.ledger["p1"]?.gone).toEqual({ pioneer: 1 });
  });

  test("slot is rejected without toolOptions.foundSlot and honoured with it", () => {
    expect(
      violation(
        army()
          .m()
          .apply("p1", found("c1", "i2", { pioneer: 1, ship: 1 }, 3)),
      ),
    ).toEqual({
      code: "INVALID_ARGS",
      details: { field: "slot", ruleset: "domain-test@1.0.0", reason: "unsupported" },
    });
    // With the option, a slot the island does not have is rejected (std.defaultDeparture).
    expect(
      violation(
        army(RICH_OPTIONS)
          .m()
          .apply("p1", found("c1", "i2", { pioneer: 1, ship: 1 }, 4)),
      ),
    ).toEqual({
      code: "INVALID_ARGS",
      details: { island: "i2", slot: 4, slots: 4 },
    });
    const m = army(RICH_OPTIONS).m();
    accepted(m.apply("p1", found("c1", "i2", { pioneer: 1, ship: 1 }, 3)));
    m.advanceTo(5400);
    expect(cityIn(m, "c4").slot).toBe(3);
  });

  test("violations carry their numbers", () => {
    const { state, rules } = world({ units: { c1: ARMY } });
    for (const slot of [1, 2, 3]) addCity(state, rules, { owner: null, island: "i2", slot });
    const m = load(state);
    expect(violation(m.apply("p1", found("c1", "i9", { pioneer: 1 })))).toEqual({
      code: "UNKNOWN_ID",
      details: { island: "i9" },
    });
    expect(violation(m.apply("p1", found("c1", "i2", { pioneer: 1, ship: 1 })))).toEqual({
      code: "NO_FREE_SLOT",
      details: { island: "i2" },
    });
    expect(violation(m.apply("p1", found("c1", "i1", { soldier: 1 })))).toEqual({
      code: "SETTLER_REQUIRED",
      details: { unit: "pioneer" },
    });
    expect(violation(m.apply("p1", found("c1", "i1", {})))).toEqual({
      code: "NO_UNITS",
      details: { city: "c1", kind: "found" },
    });
  });

  test("bounces when the island filled up meanwhile", () => {
    const m = army().m();
    const id = movementId(accepted(m.apply("p1", found("c1", "i2", { pioneer: 1, ship: 1 }))));
    testStep(m, (ctx) => {
      for (let i = 0; i < 3; i += 1) stdFoundCity(ctx, "i2", "p3", {}, null);
    });
    expect(m.advanceTo(5400).events).toEqual([
      {
        t: 5400,
        type: "bounced",
        public: false,
        to: [{ p: "p1", as: "self" }],
        data: { movement: id, kind: "found", reason: "no_free_slot" },
      },
    ]);
    m.advanceTo(10800);
    expect(cityIn(m, "c1").units).toEqual(ARMY);
  });
});
