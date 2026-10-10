import { describe, expect, test } from "bun:test";
import {
  StdError,
  checkStd,
  disbandHomed,
  eliminate,
  enqueueBuild,
  enqueueRecruit,
  foundCity,
  launch,
  rehomeAll,
  stockAt,
  transferCity,
  turnBack,
} from "./index.ts";
import {
  SCALE,
  advance,
  cityOf,
  ctxAt,
  danglingRefs,
  movementOf,
  res,
  type TestCtx,
} from "./fixtures.test.ts";

const NO_RES = res(0, 0, 0);

describe("foundCity", () => {
  test("founds in the requested slot when free, else the lowest, from the newCity seed plus the escort", () => {
    const ctx = ctxAt(1000);
    cityOf(ctx, "c1").units.pike = 17; // the 3 escorts left c1 with the founding movement
    const id = foundCity(ctx, "i1", "p1", { pike: 3 }, 3);
    expect(id).toBe("c6");
    const c6 = cityOf(ctx, "c6");
    expect(c6).toMatchObject({
      id: "c6",
      name: "c6",
      owner: "p1",
      island: "i1",
      slot: 3,
      capitalOf: null,
      tag: null,
      foundedAt: 1000,
      stock: res(300 * SCALE, 300 * SCALE, 300 * SCALE),
      stockAt: 1000,
      units: { pike: 3 },
      stationed: [],
      itemSeq: 0,
      build: [],
      recruit: { camp: [], dock: [] },
    });
    expect(c6.buildings).toEqual({
      center: 1,
      woodcut: 1,
      stonecut: 1,
      goldpit: 1,
      store: 1,
      camp: 0,
      dock: 0,
      rampart: 0,
    });
    expect(ctx.events).toEqual([
      {
        t: 1000,
        type: "city_founded",
        public: true,
        to: [{ p: "p1", as: "self" }],
        data: { city: "c6", island: "i1", slot: 3, owner: "p1" },
      },
    ]);
    expect(foundCity(ctx, "i1", "p2", {}, 3)).toBe("c7");
    expect(cityOf(ctx, "c7").slot).toBe(2);
    expect(() => foundCity(ctx, "i1", "p2", {}, null)).toThrow(StdError);
    expect(checkStd(ctx.read())).toEqual([]);
  });
});

/** p2 gets a second city, c6 on i3, so it survives losing c2. */
function withSecondCity(ctx: TestCtx): void {
  cityOf(ctx, "c2").units.pike = 13;
  foundCity(ctx, "i3", "p2", { pike: 2 }, null);
}

describe("transferCity and rehomeAll", () => {
  test("a transfer materialises at the old rates, clears the queues and parks the former owner's home units", () => {
    const ctx = ctxAt(0);
    withSecondCity(ctx);
    enqueueBuild(ctx, "c2", "woodcut");
    enqueueRecruit(ctx, "c2", "pike", 2);
    cityOf(ctx, "c2").stationed.push({ owner: "p1", home: "c1", role: "hold", units: { axe: 5 } });
    cityOf(ctx, "c1").units.axe = 25;
    ctx.setNow(3600);
    const stock = stockAt(ctx.read(), "c2");
    ctx.events.length = 0;
    transferCity(ctx, "c2", "p1");
    const c2 = cityOf(ctx, "c2");
    expect(c2.owner).toBe("p1");
    expect(c2.stockAt).toBe(3600);
    expect(stockAt(ctx.read(), "c2")).toEqual(stock);
    expect(c2.build).toEqual([]);
    expect(c2.recruit).toEqual({ camp: [], dock: [] });
    expect(ctx.state.queue).toEqual([]);
    expect(c2.units).toEqual({});
    // The 13 + 2 trickled pikes stay where they are, homed in p2's remaining city c6.
    expect(c2.stationed).toEqual([
      { owner: "p1", home: "c1", role: "support", units: { axe: 5 } },
      { owner: "p2", home: "c6", role: "support", units: { pike: 15 } },
    ]);
    expect(ctx.events).toEqual([]);
    expect(checkStd(ctx.read())).toEqual([]);
    expect(danglingRefs(ctx.state)).toEqual([]);
  });

  test("a former owner with no other city has its home units disbanded at the transfer", () => {
    const ctx = ctxAt(0);
    transferCity(ctx, "c3", "p1");
    expect(cityOf(ctx, "c3").units).toEqual({});
    expect(cityOf(ctx, "c3").stationed).toEqual([]);
    expect(ctx.state.ledger.p3?.gone).toEqual({ pike: 10, axe: 10 });
    expect(checkStd(ctx.read())).toEqual([]);
    expect(danglingRefs(ctx.state)).toEqual([]);
  });

  test("rehomeAll moves everything homed in the lost city to the fallback, and returns sail on", () => {
    const ctx = ctxAt(50000);
    withSecondCity(ctx);
    const out = launch(
      ctx,
      {
        kind: "support",
        owner: "p2",
        from: "c2",
        to: "c3",
        island: "i3",
        slot: null,
        units: { pike: 3 },
        cargo: NO_RES,
        gold: 0,
      },
      "p3",
    );
    const back = launch(
      ctx,
      {
        kind: "attack",
        owner: "p2",
        from: "c2",
        to: "c1",
        island: "i1",
        slot: null,
        units: { pike: 4 },
        cargo: NO_RES,
        gold: 0,
      },
      "p1",
    );
    ctx.setNow(50100);
    turnBack(ctx, back); // home at 50200
    cityOf(ctx, "c2").units.pike = 4;
    cityOf(ctx, "c6").stationed.push({
      owner: "p2",
      home: "c2",
      role: "support",
      units: { pike: 1 },
    });
    cityOf(ctx, "c3").stationed.push({
      owner: "p2",
      home: "c2",
      role: "support",
      units: { pike: 1 },
    });
    expect(checkStd(ctx.read())).toEqual([]);
    transferCity(ctx, "c2", "p1");
    rehomeAll(ctx, "c2", "c6");
    expect(checkStd(ctx.read())).toEqual([]);
    expect(danglingRefs(ctx.state)).toEqual([]);
    expect(movementOf(ctx, out).home).toBe("c6");
    expect(movementOf(ctx, back)).toMatchObject({
      home: "c6",
      to: "c6",
      toIsland: "i3",
      arriveAt: 50200 + 15000,
    });
    expect(ctx.state.queue.find((e) => e.ref === back)?.at).toBe(65200);
    expect(cityOf(ctx, "c2").stationed).toEqual([
      { owner: "p2", home: "c6", role: "support", units: { pike: 4 } },
    ]);
    expect(cityOf(ctx, "c3").stationed).toEqual([
      { owner: "p2", home: "c6", role: "support", units: { pike: 1 } },
    ]);
    expect(cityOf(ctx, "c6").stationed).toEqual([]);
    expect(cityOf(ctx, "c6").units).toEqual({ pike: 3 });
    advance(ctx, 70000);
    expect(cityOf(ctx, "c6").units).toEqual({ pike: 7 });
    expect(checkStd(ctx.read())).toEqual([]);
    expect(danglingRefs(ctx.state)).toEqual([]);
  });

  test("rehomeAll before the transfer parks the home units with the new home directly", () => {
    const ctx = ctxAt(0);
    withSecondCity(ctx);
    rehomeAll(ctx, "c2", "c6");
    expect(cityOf(ctx, "c2").units).toEqual({});
    expect(cityOf(ctx, "c2").stationed).toEqual([
      { owner: "p2", home: "c6", role: "support", units: { pike: 13 } },
    ]);
    transferCity(ctx, "c2", "p1");
    expect(checkStd(ctx.read())).toEqual([]);
    expect(() => rehomeAll(ctx, "c3", "c5")).toThrow(StdError);
  });

  test("a hold group of the new owner becomes a support group; a neutral city's garrison is disbanded", () => {
    const ctx = ctxAt(0);
    cityOf(ctx, "c5").stationed.push({ owner: "p1", home: "c1", role: "hold", units: { axe: 5 } });
    cityOf(ctx, "c1").units.axe = 25;
    transferCity(ctx, "c5", "p1");
    expect(cityOf(ctx, "c5").stationed).toEqual([
      { owner: "p1", home: "c1", role: "support", units: { axe: 5 } },
    ]);
    expect(cityOf(ctx, "c5").units).toEqual({});
    expect(ctx.state.ledger.neutral?.gone).toEqual({ pike: 40 });
    expect(checkStd(ctx.read())).toEqual([]);
  });
});

describe("disbandHomed", () => {
  test("disbands units homed in the city everywhere; unit-less movements keep flying", () => {
    const ctx = ctxAt(0);
    const ship = launch(
      ctx,
      {
        kind: "shipment",
        owner: "p2",
        from: "c2",
        to: "c4",
        island: "i2",
        slot: null,
        units: {},
        cargo: res(10, 0, 0),
        gold: 0,
      },
      "p1",
    );
    const att = launch(
      ctx,
      {
        kind: "support",
        owner: "p2",
        from: "c2",
        to: "c3",
        island: "i3",
        slot: null,
        units: { pike: 5 },
        cargo: NO_RES,
        gold: 0,
      },
      "p3",
    );
    cityOf(ctx, "c3").stationed.push({
      owner: "p2",
      home: "c2",
      role: "support",
      units: { pike: 2 },
    });
    cityOf(ctx, "c2").units.pike = 8;
    disbandHomed(ctx, "c2");
    expect(cityOf(ctx, "c2").units).toEqual({});
    expect(cityOf(ctx, "c3").stationed).toEqual([]);
    expect(ctx.state.movements[att]).toBeUndefined();
    expect(ctx.state.movements[ship]).toBeDefined();
    expect(ctx.state.ledger.p2?.gone).toEqual({ pike: 15 });
    expect(checkStd(ctx.read())).toEqual([]);
    expect(danglingRefs(ctx.state)).toEqual([]);
  });
});

describe("eliminate", () => {
  test("removes every trace of the player and leaves no dangling reference", () => {
    const ctx = ctxAt(50000);
    const players = ctx.state.players;
    if (players.p2 === undefined || players.p3 === undefined) throw new Error("fixture");
    ctx.state.alliances.a1 = { id: "a1", name: "Bloc", members: ["p2", "p3"], formedAt: 0 };
    players.p2.alliance = "a1";
    players.p3.alliance = "a1";
    ctx.state.pacts.push({
      a: "p1",
      b: "p3",
      since: 0,
      expiresAt: 172800,
      seq: ctx.schedule("pact_expire", 172800, "p1|p3"),
    });
    const q = ctx.nextId("q", "p3");
    ctx.state.proposals[q] = {
      id: q,
      from: "p3",
      to: "p1",
      kind: "alliance",
      name: null,
      until: null,
      expiresAt: 90000,
      seq: ctx.schedule("proposal_expire", 90000, q),
    };
    const q2 = ctx.nextId("q", "p1");
    ctx.state.proposals[q2] = {
      id: q2,
      from: "p1",
      to: "p2",
      kind: "pact",
      name: null,
      until: null,
      expiresAt: 90000,
      seq: ctx.schedule("proposal_expire", 90000, q2),
    };
    const m = launch(
      ctx,
      {
        kind: "attack",
        owner: "p3",
        from: "c3",
        to: "c1",
        island: "i1",
        slot: null,
        units: { axe: 4 },
        cargo: NO_RES,
        gold: 0,
      },
      "p1",
    );
    cityOf(ctx, "c3").units.pike = 7;
    cityOf(ctx, "c2").stationed.push({
      owner: "p3",
      home: "c3",
      role: "support",
      units: { pike: 3 },
    });
    enqueueRecruit(ctx, "c3", "pike", 1);
    expect(() => eliminate(ctx, "p3")).toThrow(StdError);
    transferCity(ctx, "c3", "p1");
    ctx.events.length = 0;
    eliminate(ctx, "p3");
    expect(ctx.events.map((e) => [e.type, e.public, e.data])).toEqual([
      ["player_eliminated", true, { player: "p3" }],
      ["alliance_left", true, { alliance: "a1", player: "p3", cause: "eliminated" }],
      ["alliance_dissolved", true, { alliance: "a1" }],
      ["pact_ended", true, { a: "p1", b: "p3", cause: "eliminated" }],
    ]);
    expect(players.p3).toEqual({ id: "p3", alive: false, eliminatedAt: 50000, alliance: null });
    expect(players.p2.alliance).toBeNull();
    expect(ctx.state.alliances).toEqual({});
    expect(ctx.state.pacts).toEqual([]);
    expect(Object.keys(ctx.state.proposals)).toEqual([q2]);
    expect(ctx.state.movements[m]).toBeUndefined();
    expect(cityOf(ctx, "c2").stationed).toEqual([]);
    expect(cityOf(ctx, "c3").stationed).toEqual([]);
    expect(ctx.state.queue.map((e) => e.ref)).toEqual([q2]);
    expect(ctx.state.ledger.p3?.gone).toEqual({ pike: 10, axe: 10 });
    expect(checkStd(ctx.read())).toEqual([]);
    expect(danglingRefs(ctx.state)).toEqual([]);
    expect(() => eliminate(ctx, "p3")).toThrow(StdError);
  });
});
