import { describe, expect, test } from "bun:test";
import {
  CompiledRulesSchema,
  GameStateSchema,
  type GameState,
  type PlayerId,
} from "@perfidia/protocol";
import { canonicalJson } from "@perfidia/engine/core";
import type { ReadCtx, Relation } from "@perfidia/engine/contracts";
import {
  accrualPerSecond,
  affordableAt,
  citiesOf,
  enqueueBuild,
  enqueueRecruit,
  fallbackCity,
  freeSlots,
  inFlightCargo,
  insufficientResources,
  isHeldAgainst,
  launch,
  maxAffordable,
  popCap,
  popUsed,
  queueEtas,
  rates,
  relation,
  relationsOf,
  settlerK,
  sortedIds,
  stockAt,
  storageCap,
  travel,
  unitCost,
  unitsAtHome,
  bounce,
  stackGroups,
  slotUnits,
  incomingAudience,
  defaultVisibility,
  defaultDeparture,
  checkStd,
} from "./index.ts";
import {
  RULES,
  SCALE,
  TestCtx,
  cityOf,
  ctxAt,
  deepFreeze,
  fixtureRuleset,
  res,
  world,
} from "./fixtures.test.ts";

describe("fixtures", () => {
  test("the rules and the world parse with the protocol schemas and pass the std invariants", () => {
    expect(() => CompiledRulesSchema.parse(RULES)).not.toThrow();
    expect(() => GameStateSchema.parse(world())).not.toThrow();
    expect(checkStd(ctxAt().read())).toEqual([]);
  });
});

describe("economy", () => {
  test("rates, caps and stock follow the tables and the island richness", () => {
    const r = ctxAt(3600).read();
    expect(rates(r, "c1")).toEqual(res(110, 110, 110));
    expect(rates(r, "c2")).toEqual(res(112, 112, 112)); // floor(75 × 1500 / 1000)
    expect(rates(r, "c5")).toEqual(res(0, 0, 0)); // neutral cities do not produce here
    expect(storageCap(r, "c1")).toBe(2040);
    expect(popCap(r, "c1")).toBe(118);
    expect(stockAt(r, "c1")).toEqual(res(910, 910, 910));
    expect(stockAt(r, "c1", 0)).toEqual(res(800, 800, 800));
    // c2 holds 1000 wood under a cap of 1000: the cap stops growth.
    expect(stockAt(r, "c2")).toEqual(res(1000, 612, 312));
  });

  test("affordableAt is exact (§7.3 example) and null when unreachable", () => {
    const ctx = ctxAt(223320);
    const island = ctx.state.islands.i2;
    if (island === undefined) throw new Error("fixture");
    island.richnessPm = 1128; // floor(275 × 1128 / 1000) = 310 gold per hour at level 5
    const c2 = cityOf(ctx, "c2");
    c2.buildings["goldpit"] = 5;
    c2.buildings["store"] = 5;
    c2.stock = res(0, 0, 1210 * SCALE);
    c2.stockAt = 223320;
    const r = ctx.read();
    expect(rates(r, "c2").gold).toBe(310);
    expect(affordableAt(r, "c2", res(0, 0, 1500))).toBe(226688);
    expect(affordableAt(r, "c2", res(0, 0, 1210))).toBe(223320);
    expect(affordableAt(r, "c2", res(0, 0, 3561))).toBeNull(); // above the cap of 3560
    const v = insufficientResources(r, "c2", res(0, 0, 1500));
    expect(v).toEqual({
      code: "INSUFFICIENT_RESOURCES",
      details: {
        city: "c2",
        need_gold: 1500,
        have_gold: 1210,
        rate_gold: 310,
        availableAt: 226688,
      },
    });
    expect(insufficientResources(r, "c2", res(0, 0, 1210))).toBeNull();
    // A shortfall in a resource that is not produced is never covered.
    expect(affordableAt(ctx.read(), "c5", res(2000, 0, 0))).toBeNull();
  });

  test("one second after the fractional threshold the stock is affordable, not before", () => {
    const ctx = ctxAt(0);
    const at = affordableAt(ctx.read(), "c1", res(0, 0, 1500));
    expect(at).toBe(22910); // ceilDiv(700 × 3600, 110)
    if (at === null) throw new Error("unreachable");
    expect(stockAt(ctx.read(), "c1", at).gold).toBe(1500);
    expect(stockAt(ctx.read(), "c1", at - 1).gold).toBe(1499);
  });

  test("maxAffordable takes the scarcest resource", () => {
    const r = ctxAt().read();
    expect(maxAffordable(r, "c1", res(30, 60, 30))).toBe(13);
    expect(maxAffordable(r, "c1", res(0, 0, 0))).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("accrual needs a whole number of stored units per second", () => {
    expect(accrualPerSecond(RULES, 110)).toBe(110);
    expect(() => accrualPerSecond({ ...RULES, resourceScale: 1000 }, 7)).toThrow();
  });
});

describe("units and population", () => {
  test("unitsAtHome includes trickled units; popUsed counts homed units and the queue", () => {
    const ctx = ctxAt();
    expect(popUsed(ctx.read(), "c1")).toBe(66);
    enqueueRecruit(ctx, "c1", "pike", 5); // 272 s per unit at camp 2
    expect(popUsed(ctx.read(), "c1")).toBe(71);
    ctx.setNow(600);
    expect(unitsAtHome(ctx.read(), "c1").pike).toBe(22);
    expect(unitsAtHome(ctx.read(), "c1", 272 * 5).pike).toBe(25);
    expect(cityOf(ctx, "c1").units.pike).toBe(20); // nothing was written
    expect(popUsed(ctx.read(), "c1")).toBe(71);
  });

  test("popUsed counts units homed in the city wherever they are", () => {
    const ctx = ctxAt(50000);
    launch(
      ctx,
      {
        kind: "attack",
        owner: "p1",
        from: "c1",
        to: "c2",
        island: "i2",
        slot: null,
        units: { axe: 10, ferry: 1 },
        cargo: res(0, 0, 0),
        gold: 0,
      },
      "p2",
    );
    expect(popUsed(ctx.read(), "c1")).toBe(66);
    expect(cityOf(ctx, "c1").units).toEqual({ pike: 20, axe: 20, colonist: 1, ferry: 2 });
  });

  test("settlerK counts cities and every founding unit owned; unitCost scales with it", () => {
    const ctx = ctxAt();
    const r = ctx.read();
    expect(settlerK(r, "p1")).toBe(3); // c1, c4 and one colonist at home
    expect(settlerK(r, "p2")).toBe(1);
    expect(unitCost(r, "c1", "colonist")).toEqual(res(1350, 1350, 2250));
    expect(unitCost(r, "c1", "pike")).toEqual(res(30, 60, 30));
    const c1 = cityOf(ctx, "c1");
    c1.stock = res(3000 * SCALE, 3000 * SCALE, 3000 * SCALE);
    c1.buildings["store"] = 6;
    enqueueRecruit(ctx, "c1", "colonist", 1);
    expect(settlerK(ctx.read(), "p1")).toBe(4);
    expect(unitCost(ctx.read(), "c1", "colonist")).toEqual(res(1800, 1800, 3000));
  });
});

describe("map, movements and relations", () => {
  test("freeSlots, citiesOf, fallbackCity and sortedIds use id order", () => {
    const ctx = ctxAt();
    const r = ctx.read();
    expect(freeSlots(r, "i1")).toEqual([2, 3]);
    expect(freeSlots(r, "i2")).toEqual([2]);
    expect(citiesOf(r, "p1")).toEqual(["c1", "c4"]);
    expect(fallbackCity(r, "p2")).toBe("c2");
    const c4 = cityOf(ctx, "c4");
    ctx.state.cities.c10 = { ...c4, id: "c10", slot: 2 };
    delete ctx.state.cities.c1;
    expect(citiesOf(ctx.read(), "p1")).toEqual(["c4", "c10"]);
    expect(sortedIds({ p10: 1, p2: 2, p1: 3 })).toEqual(["p1", "p2", "p10"]);
  });

  test("travel goes through the ruleset hook", () => {
    const r = ctxAt().read();
    expect(travel(r, "i1", "i1", { kind: "attack", units: { axe: 1 } })).toBe(3600);
    expect(travel(r, "i1", "i2", { kind: "attack", units: { axe: 1, ferry: 1 } })).toBe(6000);
    expect(travel(r, "i1", "i3", { kind: "attack", units: { axe: 1, ferry: 1 } })).toBe(9000);
    expect(travel(r, "i2", "i3", { kind: "attack", units: { ferry: 1 } })).toBe(15000);
    expect(travel(r, "i2", "i3", { kind: "attack", units: { galley: 1 } })).toBe(11250);
    expect(travel(r, "i2", "i3", { kind: "spy", units: {} })).toBe(7500);
    expect(travel(r, "i1", "i2", { kind: "spy", units: {} })).toBe(3600);
  });

  test("inFlightCargo counts shipments and the returns of bounced shipments", () => {
    const ctx = ctxAt();
    const ship = (wood: number) =>
      launch(
        ctx,
        {
          kind: "shipment",
          owner: "p1",
          from: "c1",
          to: "c2",
          island: "i2",
          slot: null,
          units: {},
          cargo: res(wood, 0, 0),
          gold: 0,
        },
        "p2",
      );
    const a = ship(100);
    ship(50);
    expect(inFlightCargo(ctx.read(), "c1")).toBe(150);
    ctx.setNow(3600);
    bounce(ctx, a);
    expect(ctx.state.movements[a]?.kind).toBe("return");
    expect(inFlightCargo(ctx.read(), "c1")).toBe(150);
    expect(inFlightCargo(ctx.read(), "c4")).toBe(0);
  });

  test("relations: the default model, and a fixture hook that replaces it", () => {
    const ctx = ctxAt();
    ctx.state.alliances.a1 = { id: "a1", name: "North", members: ["p1", "p2"], formedAt: 0 };
    const p1 = ctx.state.players.p1;
    const p2 = ctx.state.players.p2;
    if (p1 === undefined || p2 === undefined) throw new Error("fixture");
    p1.alliance = "a1";
    p2.alliance = "a1";
    ctx.state.pacts.push({ a: "p1", b: "p3", since: 0, expiresAt: 172800, seq: null });
    const r = ctx.read();
    expect(relation(r, "p1", "p1")).toBe("self");
    expect(relation(r, "p1", "p2")).toBe("ally");
    expect(relation(r, "p3", "p1")).toBe("pact");
    expect(relation(r, "p2", "p3")).toBe("none");
    expect(relationsOf(r, "p1")).toEqual([
      { player: "p2", kind: "ally", until: null },
      { player: "p3", kind: "pact", until: 172800 },
    ]);
    const all: PlayerId[] = ["p1", "p2", "p3"];
    const everyoneAllied = new TestCtx(
      world(),
      RULES,
      fixtureRuleset((_r, p) =>
        all.filter((q) => q !== p).map((q): Relation => ({ player: q, kind: "ally", until: null })),
      ),
    );
    expect(relation(everyoneAllied.read(), "p2", "p3")).toBe("ally");
    expect(relation(ctxAt().read(), "p2", "p3")).toBe("none");
  });

  test("isHeldAgainst sees hold groups of other players only", () => {
    const ctx = ctxAt();
    const c2 = cityOf(ctx, "c2");
    c2.stationed.push({ owner: "p2", home: "c1", role: "hold", units: { pike: 1 } });
    expect(isHeldAgainst(ctx.read(), "c2", "p2")).toBe(false);
    c2.stationed.unshift({ owner: "p1", home: "c1", role: "hold", units: { pike: 1 } });
    expect(isHeldAgainst(ctx.read(), "c2", "p2")).toBe(true);
    expect(isHeldAgainst(ctx.read(), "c1", "p1")).toBe(false);
  });
});

describe("queueEtas", () => {
  test("lists build items with their shown target and recruit batches with trickle progress", () => {
    const ctx = ctxAt();
    enqueueBuild(ctx, "c1", "woodcut");
    enqueueBuild(ctx, "c1", "store");
    enqueueBuild(ctx, "c1", "woodcut");
    enqueueRecruit(ctx, "c1", "pike", 3);
    ctx.setNow(300);
    const etas = queueEtas(ctx.read(), "c1");
    expect(
      etas.map((e) =>
        e.kind === "build" ? `${e.building} ${e.level}` : `${e.unit} ${e.done}/${e.count}`,
      ),
    ).toEqual(["woodcut 3", "store 4", "woodcut 4", "pike 1/3"]);
    const pike = etas[3];
    expect(pike?.kind === "recruit" ? pike.nextAt : null).toBe(544);
    expect(etas[1]?.start).toBe(etas[0]?.end);
  });
});

describe("P3: derivations never write", () => {
  test("every derivation over a deep-frozen state leaves it byte-identical", () => {
    const ctx = ctxAt();
    enqueueBuild(ctx, "c1", "woodcut");
    enqueueRecruit(ctx, "c1", "pike", 4);
    const m = launch(
      ctx,
      {
        kind: "attack",
        owner: "p1",
        from: "c1",
        to: "c2",
        island: "i2",
        slot: null,
        units: { axe: 5, ferry: 1 },
        cargo: res(0, 0, 0),
        gold: 0,
      },
      "p2",
    );
    ctx.setNow(1000);
    const state: GameState = deepFreeze(structuredClone(ctx.state));
    const before = canonicalJson(state);
    const r: ReadCtx = { ...ctx.read(), state, now: 1000 };
    for (const id of ["c1", "c2", "c3", "c4", "c5"] as const) {
      rates(r, id);
      storageCap(r, id);
      popCap(r, id);
      popUsed(r, id);
      stockAt(r, id);
      stockAt(r, id, 5000);
      unitsAtHome(r, id);
      unitsAtHome(r, id, 5000);
      affordableAt(r, id, res(5000, 1, 1));
      maxAffordable(r, id, res(1, 2, 3));
      insufficientResources(r, id, res(5000, 0, 0));
      queueEtas(r, id);
      inFlightCargo(r, id);
      isHeldAgainst(r, id, "p1");
      for (const owner of ["p1", "p2", null] as const) {
        for (const slot of stackGroups(r, id, owner)) slotUnits(r, slot);
      }
      for (const p of ["p1", "p2", "p3"] as const) {
        defaultVisibility.cityAccess(r, p, id);
        defaultVisibility.publicCity(r, p, id);
      }
    }
    for (const p of ["p1", "p2", "p3"] as const) {
      settlerK(r, p);
      citiesOf(r, p);
      fallbackCity(r, p);
      relationsOf(r, p);
      relation(r, p, "p1");
      defaultVisibility.movementAccess(r, p, m);
      defaultVisibility.publicPlayer(r, p);
    }
    unitCost(r, "c1", "colonist");
    freeSlots(r, "i1");
    travel(r, "i1", "i2", { kind: "attack", units: { ferry: 1 } });
    incomingAudience(r, m);
    defaultVisibility.publicMatch(r);
    defaultDeparture(r, {
      kind: "shipment",
      owner: "p1",
      from: "c1",
      to: "c2",
      island: "i2",
      slot: null,
      units: {},
      cargo: res(10, 0, 0),
      gold: 0,
    });
    checkStd(r);
    expect(canonicalJson(state)).toBe(before);
  });
});
