import { describe, expect, test } from "bun:test";
import { stockAt } from "@perfidia/engine/std";
import { addMovement, addStationed } from "@perfidia/engine/testing";
import type { MovementKind, PlayerId, Res, UnitCounts } from "@perfidia/protocol";
import {
  besiege,
  city,
  cityIn,
  copyFor,
  load,
  movementBy,
  ofType,
  plain,
  world,
  type World,
} from "./fixtures.test.ts";

// The non-battle arrivals of perfidia-1 (§7.5, §10) and the bounces of attacks, through the kernel.

const T = 200000;

function arriving(
  w: World,
  o: {
    kind: MovementKind;
    owner: PlayerId;
    from: `c${number}`;
    to: `c${number}` | null;
    home?: `c${number}`;
    party?: PlayerId | null;
    units?: UnitCounts;
    cargo?: Partial<Res>;
    gold?: number;
    toIsland?: `i${number}`;
  },
) {
  return addMovement(w.state, w.rules, {
    ...o,
    departAt: T - 3599,
    arriveAt: T + 1,
  });
}

function spyWorld(gold: number, spierOwnsTarget = false) {
  const w = world({ now: T });
  city(w, { id: "c1", owner: "p1", island: "i1" });
  city(w, { id: "c3", owner: "p3", island: "i3" });
  city(w, {
    id: "c2",
    owner: spierOwnsTarget ? "p1" : "p2",
    island: "i2",
    buildings: { wall: 2, barracks: 1, warehouse: 2 },
    stock: 400,
    units: { guard: 10, raider: 5, warship: 2 },
  });
  addStationed(w.state, "c2", { owner: "p3", home: "c3", role: "support", units: { guard: 7 } });
  const m = arriving(w, { kind: "spy", owner: "p1", from: "c1", to: "c2", party: "p2", gold });
  return { match: load(w), id: m.id };
}

describe("arrive.spy (§10)", () => {
  test("counter-intel is 100 + 50·wall + every land pop present; ties go to the target", () => {
    const { match, id } = spyWorld(222);
    const { events } = match.advanceTo(T + 1);
    expect(events.map((e) => e.type)).toEqual(["spy_failed", "spy_detected"]);
    expect(copyFor(events, "spy_failed", "p1")).toMatchObject({
      to: [{ p: "p1", as: "self" }],
      data: { movement: id, city: "c2" },
    });
    expect(copyFor(events, "spy_detected", "p2")).toMatchObject({
      to: [{ p: "p2", as: "target" }],
      data: { city: "c2", by: "p1", from: "c1", gold: 222 },
    });
    expect(match.read().state.movements[id]).toBeUndefined();
  });

  test("a success reports a snapshot to the spier only; the target is not told", () => {
    const { match } = spyWorld(223);
    const { events } = match.advanceTo(T + 1);
    expect(events.map((e) => e.type)).toEqual(["spy_report"]);
    const r = copyFor(events, "spy_report", "p1").data;
    expect(r).toMatchObject({
      city: "c2",
      owner: "p2",
      island: "i2",
      wall: 2,
      siege: null,
      queues: [],
      units: [
        { owner: "p2", role: "home", units: { guard: 10, raider: 5, warship: 2 } },
        { owner: "p3", role: "stationed", home: "c3", units: { guard: 7 } },
      ],
    });
    expect(r["buildings"]).toMatchObject({ wall: 2, barracks: 1, warehouse: 2, hall: 0 });
    expect(r["stock"]).toEqual(stockAt(match.read(), "c2"));
  });

  test("a spier that owns the target by now simply gets the report", () => {
    const { match } = spyWorld(100, true);
    const { events } = match.advanceTo(T + 1);
    expect(events.map((e) => e.type)).toEqual(["spy_report"]);
  });

  test("the garrison counts in the counter-intel; the Crown needs more than 750 gold", () => {
    for (const [gold, type] of [
      [750, "spy_failed"],
      [751, "spy_report"],
    ] as const) {
      const w = world({ now: T });
      city(w, { id: "c1", owner: "p1", island: "i1" });
      city(w, {
        id: "c7",
        owner: null,
        island: "i2",
        tag: "crown",
        buildings: { hall: 5, wall: 5, warehouse: 5 },
        units: { guard: 400, warship: 10 },
      });
      arriving(w, { kind: "spy", owner: "p1", from: "c1", to: "c7", party: null, gold });
      const match = load(w);
      expect(match.advanceTo(T + 1).events.map((e) => e.type)).toEqual([type]);
    }
    const w = world({ now: T });
    city(w, { id: "c1", owner: "p1", island: "i1" });
    city(w, { id: "c2", owner: "p2", island: "i2" });
    city(w, { id: "c4", owner: "p4", island: "i4" });
    besiege(w, {
      city: "c2",
      by: "p4",
      garrison: [{ home: "c4", units: { settler: 1, raider: 3 } }],
    });
    arriving(w, { kind: "spy", owner: "p1", from: "c1", to: "c2", party: "p2", gold: 113 });
    const { events } = load(w).advanceTo(T + 1);
    expect(events.map((e) => e.type)).toEqual(["spy_failed", "spy_detected"]);
  });
});

function base(): World {
  const w = world({ now: T });
  city(w, { id: "c1", owner: "p1", island: "i1", buildings: { warehouse: 2 } });
  city(w, { id: "c2", owner: "p2", island: "i2", buildings: { warehouse: 1 }, stock: 900 });
  city(w, { id: "c3", owner: "p3", island: "i3" });
  return w;
}

describe("arrive.support and arrive.shipment (§7.5, §9.2)", () => {
  test("a support becomes a stationed group; the owner sees the units, the sender only that", () => {
    const w = base();
    const m = arriving(w, {
      kind: "support",
      owner: "p1",
      from: "c1",
      to: "c2",
      party: "p2",
      units: { guard: 8 },
    });
    const match = load(w);
    const { events } = match.advanceTo(T + 1);
    expect(plain(cityIn(match, "c2").stationed)).toEqual([
      { owner: "p1", home: "c1", role: "support", units: { guard: 8 } },
    ]);
    expect(copyFor(events, "support_arrived", "p2").data).toEqual({
      movement: m.id,
      by: "p1",
      to: "c2",
      units: { guard: 8 },
    });
    expect(copyFor(events, "support_arrived", "p1").data).toEqual({
      movement: m.id,
      by: "p1",
      to: "c2",
    });
  });

  test("supports and shipments bounce from a city besieged by someone else", () => {
    for (const kind of ["support", "shipment"] as const) {
      const w = base();
      besiege(w, { city: "c2", by: "p3", garrison: [{ home: "c3", units: { settler: 1 } }] });
      const m = arriving(w, {
        kind,
        owner: "p1",
        from: "c1",
        to: "c2",
        party: "p2",
        ...(kind === "support" ? { units: { guard: 8 } } : { cargo: { wood: 100 } }),
      });
      const match = load(w);
      const { events } = match.advanceTo(T + 1);
      expect(copyFor(events, "bounced", "p1").data).toEqual({
        movement: m.id,
        kind,
        reason: "target_besieged",
      });
      const back = match.read().state.movements[m.id];
      expect(back?.kind).toBe("return");
      expect(back?.home).toBe("c1");
      expect(back?.cargo.wood).toBe(kind === "shipment" ? 100 : 0);
    }
  });

  test("supports, shipments and attacks bounce when the target changed hands", () => {
    for (const kind of ["support", "shipment", "attack"] as const) {
      const w = base();
      const m = arriving(w, {
        kind,
        owner: "p1",
        from: "c1",
        to: "c2",
        party: "p3",
        ...(kind === "shipment" ? { cargo: { gold: 10 } } : { units: { raider: 4 } }),
      });
      const match = load(w);
      const { events } = match.advanceTo(T + 1);
      expect(copyFor(events, "bounced", "p1").data).toMatchObject({
        kind,
        reason: "target_changed",
      });
      expect(match.read().state.movements[m.id]?.kind).toBe("return");
    }
  });

  test("an attack bounces from a city besieged by a third player", () => {
    const w = base();
    besiege(w, { city: "c2", by: "p3", garrison: [{ home: "c3", units: { settler: 1 } }] });
    const m = arriving(w, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      party: "p2",
      units: { raider: 4 },
    });
    const { events } = load(w).advanceTo(T + 1);
    expect(copyFor(events, "bounced", "p1").data).toMatchObject({
      movement: m.id,
      reason: "target_besieged",
    });
    expect(ofType(events, "battle")).toEqual([]);
  });

  test("a shipment is delivered capped; the sender learns only that it was delivered", () => {
    const w = base();
    const m = arriving(w, {
      kind: "shipment",
      owner: "p1",
      from: "c1",
      to: "c2",
      party: "p2",
      cargo: { wood: 200, gold: 50 },
    });
    const match = load(w);
    const { events } = match.advanceTo(T + 1);
    // Warehouse 1 holds 1000: 900 + 200 wood overflows by 100.
    expect(copyFor(events, "shipment_delivered", "p2").data).toEqual({
      movement: m.id,
      to: "c2",
      outcome: "delivered",
      by: "p1",
      from: "c1",
      res: { wood: 200, stone: 0, gold: 50 },
      lost: { wood: 100, stone: 0, gold: 0 },
    });
    expect(copyFor(events, "shipment_delivered", "p1").data).toEqual({
      movement: m.id,
      to: "c2",
      outcome: "delivered",
    });
    expect(stockAt(match.read(), "c2")).toEqual({ wood: 1000, stone: 900, gold: 950 });
  });
});

describe("arrive.found and arrive.return (§7.5)", () => {
  test("a founding takes the lowest free slot, consumes one settler and re-homes the rest", () => {
    const w = world({ now: T });
    city(w, { id: "c1", owner: "p1", island: "i1" });
    city(w, { id: "c2", owner: "p2", island: "i2", slot: 0 });
    city(w, { id: "c3", owner: "p3", island: "i2", slot: 2 });
    arriving(w, {
      kind: "found",
      owner: "p1",
      from: "c1",
      to: null,
      toIsland: "i2",
      units: { settler: 2, guard: 3, transport: 1 },
    });
    const match = load(w);
    const { events } = match.advanceTo(T + 1);
    expect(ofType(events, "city_founded")).toEqual([
      {
        t: T + 1,
        type: "city_founded",
        public: true,
        to: [{ p: "p1", as: "self" }],
        data: { city: "c4", island: "i2", slot: 1, owner: "p1" },
      },
    ]);
    const c4 = cityIn(match, "c4");
    expect(plain(c4.units)).toEqual({ guard: 3, settler: 1, transport: 1 });
    expect(plain(c4.stock)).toEqual({ wood: 300 * 3600, stone: 300 * 3600, gold: 300 * 3600 });
    expect(match.read().state.ledger["p1"]?.gone).toEqual({ settler: 1 });
  });

  test("a founding bounces when the island is full", () => {
    const w = world({
      now: T,
      islands: [
        { x: 0, y: 0, slots: 2 },
        { x: 90, y: 0, slots: 1 },
      ],
    });
    city(w, { id: "c1", owner: "p1", island: "i1" });
    city(w, { id: "c2", owner: "p2", island: "i2" });
    const m = arriving(w, {
      kind: "found",
      owner: "p1",
      from: "c1",
      to: null,
      toIsland: "i2",
      units: { settler: 1 },
    });
    const match = load(w);
    const { events } = match.advanceTo(T + 1);
    expect(copyFor(events, "bounced", "p1").data).toEqual({
      movement: m.id,
      kind: "found",
      reason: "no_free_slot",
    });
    expect(movementBy(match, "p1", "return").units).toEqual({ settler: 1 });
  });

  test("a return into a home that is not besieged brings units and cargo home, capped", () => {
    const w = world({ now: T });
    city(w, { id: "c1", owner: "p1", island: "i1", stock: 600 });
    city(w, { id: "c2", owner: "p2", island: "i2" });
    const m = arriving(w, {
      kind: "return",
      owner: "p1",
      from: "c2",
      to: "c1",
      home: "c1",
      units: { raider: 7 },
      cargo: { wood: 100 },
    });
    const match = load(w);
    const { events } = match.advanceTo(T + 1);
    expect(copyFor(events, "returned", "p1").data).toEqual({
      movement: m.id,
      city: "c1",
      units: { raider: 7 },
      cargo: { wood: 100, stone: 0, gold: 0 },
      lost: { wood: 40, stone: 0, gold: 0 },
    });
    expect(plain(cityIn(match, "c1").units)).toEqual({ raider: 7 });
  });
});
