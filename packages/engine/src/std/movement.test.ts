import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { MovementId, PlayerId, UnitCounts } from "@perfidia/protocol";
import type { DepartureDraft } from "@perfidia/engine/contracts";
import {
  StdError,
  arriveHome,
  bounce,
  checkStd,
  citiesOf,
  deliverShipment,
  deliverSupport,
  launch,
  startReturn,
  station,
  stockAt,
  turnBack,
  unitsAtHome,
  unstation,
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

function draft(over: Partial<DepartureDraft> & Pick<DepartureDraft, "kind">): DepartureDraft {
  return {
    owner: "p1",
    from: "c1",
    to: "c2",
    island: "i2",
    slot: null,
    units: {},
    cargo: NO_RES,
    gold: 0,
    ...over,
  };
}

function ally(ctx: TestCtx, a: PlayerId, b: PlayerId): void {
  ctx.state.alliances.a1 = { id: "a1", name: "Bloc", members: [a, b], formedAt: 0 };
  for (const p of [a, b]) {
    const player = ctx.state.players[p];
    if (player === undefined) throw new Error("fixture");
    player.alliance = "a1";
  }
}

/** Pops the arrival event of `m` the way the kernel does before calling an arrival handler. */
function popArrival(ctx: TestCtx, m: MovementId): void {
  const mv = movementOf(ctx, m);
  const ev = ctx.state.queue[0];
  if (ev === undefined || ev.seq !== mv.seq) throw new Error(`${m} does not arrive next`);
  ctx.state.queue.shift();
  ctx.setNow(ev.at);
}

describe("launch", () => {
  test("takes the units, schedules the arrival and tells the target's audience, never the mover", () => {
    const ctx = ctxAt(50000);
    ally(ctx, "p2", "p3");
    station(ctx, "c2", { owner: "p1", home: "c4", role: "support", units: { pike: 2 } });
    cityOf(ctx, "c4").units = { pike: 3 };
    const m = launch(ctx, draft({ kind: "attack", units: { axe: 10, ferry: 1 } }), "p2");
    expect(m).toMatch(/^m[0-9a-hjkmnp-tv-z]{5}$/);
    expect(cityOf(ctx, "c1").units).toEqual({ pike: 20, axe: 20, colonist: 1, ferry: 2 });
    expect(movementOf(ctx, m)).toMatchObject({
      kind: "attack",
      owner: "p1",
      home: "c1",
      from: "c1",
      fromIsland: "i1",
      to: "c2",
      toIsland: "i2",
      party: "p2",
      units: { axe: 10, ferry: 1 },
      departAt: 50000,
      arriveAt: 56000,
      back: null,
    });
    expect(ctx.state.queue).toEqual([
      { at: 56000, cls: 7, seq: movementOf(ctx, m).seq, kind: "arrive_attack", ref: m },
    ]);
    expect(ctx.events).toEqual([
      {
        t: 50000,
        type: "incoming_attack",
        public: false,
        to: [
          { p: "p2", as: "party" },
          { p: "p3", as: "ally" },
        ],
        data: {
          movement: m,
          from: "c1",
          by: "p1",
          foe: "p2",
          to: "c2",
          departAt: 50000,
          arriveAt: 56000,
          homecoming: false,
        },
      },
    ]);
    expect(checkStd(ctx.read())).toEqual([]);
  });

  test("a third party stationed in the target hears of an attack, ranked after the target", () => {
    const ctx = ctxAt(50000);
    ally(ctx, "p2", "p3");
    cityOf(ctx, "c2").stationed.push({
      owner: "p3",
      home: "c3",
      role: "support",
      units: { pike: 1 },
    });
    cityOf(ctx, "c3").units = { pike: 9, axe: 10 };
    const m = launch(ctx, draft({ kind: "attack", units: { axe: 1 } }), "p2");
    expect(ctx.events[0]?.to).toEqual([
      { p: "p2", as: "party" },
      { p: "p3", as: "stationed" },
    ]);
    expect(ctx.events[0]?.data["movement"]).toBe(m);
  });

  test("supports and shipments go in full to the owner and its allies; spies and founders to nobody", () => {
    const ctx = ctxAt(100);
    ally(ctx, "p2", "p3");
    launch(ctx, draft({ kind: "support", units: { pike: 5 } }), "p2");
    launch(ctx, draft({ kind: "shipment", cargo: res(10, 20, 30) }), "p2");
    launch(ctx, draft({ kind: "spy", gold: 150 }), "p2");
    launch(
      ctx,
      draft({ kind: "found", to: null, island: "i3", units: { colonist: 1, pike: 2 } }),
      null,
    );
    expect(ctx.events.map((e) => [e.type, e.to])).toEqual([
      [
        "incoming_support",
        [
          { p: "p2", as: "party" },
          { p: "p3", as: "ally" },
        ],
      ],
      [
        "incoming_shipment",
        [
          { p: "p2", as: "party" },
          { p: "p3", as: "ally" },
        ],
      ],
    ]);
    expect(ctx.events[0]?.data["units"]).toEqual({ pike: 5 });
    expect(ctx.events[1]?.data["cargo"]).toEqual(res(10, 20, 30));
    // 803 visible at t = 100; the shipment's cargo and the spy's gold are paid at departure.
    expect(stockAt(ctx.read(), "c1")).toEqual(res(793, 783, 803 - 30 - 150));
    expect(cityOf(ctx, "c1").units).toEqual({ pike: 13, axe: 30, ferry: 3 });
    expect(checkStd(ctx.read())).toEqual([]);
  });

  test("a support to the mover's own city tells only the mover's allies", () => {
    const ctx = ctxAt();
    ally(ctx, "p1", "p3");
    launch(ctx, draft({ kind: "support", to: "c4", units: { pike: 1 } }), "p1");
    expect(ctx.events[0]?.to).toEqual([{ p: "p3", as: "ally" }]);
  });

  test("launching what is not at home, or from a city the mover does not own, is an error", () => {
    const ctx = ctxAt();
    expect(() => launch(ctx, draft({ kind: "attack", units: { axe: 31 } }), "p2")).toThrow(
      StdError,
    );
    expect(() =>
      launch(ctx, draft({ kind: "attack", from: "c2", units: { pike: 1 } }), "p2"),
    ).toThrow(StdError);
    expect(() => launch(ctx, draft({ kind: "attack", units: { nothing: 1 } }), "p2")).toThrow(
      StdError,
    );
  });
});

describe("turnBack", () => {
  test("a recall arrives home at now + max(1, now − departAt) and is announced", () => {
    const ctx = ctxAt(50000);
    const m = launch(ctx, draft({ kind: "attack", units: { axe: 10, ferry: 1 } }), "p2");
    const oldSeq = movementOf(ctx, m).seq;
    ctx.setNow(50300);
    turnBack(ctx, m);
    expect(movementOf(ctx, m)).toMatchObject({
      kind: "return",
      from: "c1",
      fromIsland: "i1",
      to: "c1",
      toIsland: "i1",
      departAt: 50300,
      arriveAt: 50600,
      back: { kind: "attack", at: 50300 },
    });
    expect(ctx.state.queue.map((e) => [e.kind, e.at])).toEqual([["arrive_return", 50600]]);
    expect(ctx.state.queue[0]?.seq).not.toBe(oldSeq);
    const recalled = ctx.ofType("movement_recalled")[0];
    expect(recalled?.to).toEqual([
      { p: "p2", as: "party" },
      { p: "p1", as: "self" },
    ]);
    expect(recalled?.data).toEqual({
      movement: m,
      kind: "attack",
      by: "p1",
      to: "c2",
      arriveAt: 50600,
    });
    advance(ctx, 50600);
    expect(cityOf(ctx, "c1").units).toEqual({ pike: 20, axe: 30, colonist: 1, ferry: 3 });
    expect(ctx.state.movements).toEqual({});
    expect(checkStd(ctx.read())).toEqual([]);
  });

  test("a recall in the launch second still takes one second", () => {
    const ctx = ctxAt(50000);
    const m = launch(ctx, draft({ kind: "support", units: { pike: 1 } }), "p2");
    turnBack(ctx, m);
    expect(movementOf(ctx, m).arriveAt).toBe(50001);
  });

  test("into a home held by another player's hold group, a recall takes at least minTravel", () => {
    const ctx = ctxAt(50000);
    const m = launch(ctx, draft({ kind: "attack", units: { axe: 10, ferry: 1 } }), "p2");
    ctx.setNow(50300);
    cityOf(ctx, "c3").units = { pike: 9, axe: 10 };
    station(ctx, "c1", { owner: "p3", home: "c3", role: "hold", units: { pike: 1 } });
    turnBack(ctx, m);
    expect(movementOf(ctx, m).arriveAt).toBe(50300 + 3600);
    const own = ctxAt(50000);
    const m2 = launch(own, draft({ kind: "attack", units: { axe: 10, ferry: 1 } }), "p2");
    own.setNow(50300);
    cityOf(own, "c4").units = { pike: 4 };
    station(own, "c1", { owner: "p1", home: "c4", role: "hold", units: { pike: 1 } });
    turnBack(own, m2);
    expect(movementOf(own, m2).arriveAt).toBe(50600); // the mover's own hold group does not count
    const late = ctxAt(50000);
    const m3 = launch(late, draft({ kind: "attack", units: { axe: 10, ferry: 1 } }), "p2");
    late.setNow(54000);
    cityOf(late, "c3").units = { pike: 9, axe: 10 };
    station(late, "c1", { owner: "p3", home: "c3", role: "hold", units: { pike: 1 } });
    turnBack(late, m3);
    expect(movementOf(late, m3).arriveAt).toBe(54000 + 4000);
  });
});

describe("bounce, startReturn and arrivals", () => {
  test("a bounce turns the movement into a return from the target island, with its cargo", () => {
    const ctx = ctxAt(0);
    const m = launch(ctx, draft({ kind: "shipment", cargo: res(100, 0, 0) }), "p2");
    popArrival(ctx, m);
    bounce(ctx, m, "owner_changed");
    expect(movementOf(ctx, m)).toMatchObject({
      kind: "return",
      from: "c2",
      fromIsland: "i2",
      to: "c1",
      departAt: 6000,
      arriveAt: 12000,
      cargo: res(100, 0, 0),
      back: { kind: "shipment", at: 6000 },
    });
    expect(ctx.ofType("bounced")).toEqual([
      {
        t: 6000,
        type: "bounced",
        public: false,
        to: [{ p: "p1", as: "self" }],
        data: { movement: m, kind: "shipment", reason: "owner_changed" },
      },
    ]);
    expect(() => bounce(ctx, m)).toThrow(StdError);
    advance(ctx, 12000);
    expect(ctx.ofType("returned")[0]?.data).toEqual({
      movement: m,
      city: "c1",
      units: {},
      cargo: res(100, 0, 0),
    });
  });

  test("startReturn creates a new own movement home, telling nobody", () => {
    const ctx = ctxAt(100);
    station(ctx, "c2", { owner: "p1", home: "c1", role: "support", units: { pike: 4 } });
    const units = unstation(ctx, "c2", "p1", "c1");
    expect(units).toEqual({ pike: 4 });
    const m = startReturn(ctx, { owner: "p1", home: "c1", from: "c2", units, cargo: res(1, 2, 3) });
    expect(movementOf(ctx, m)).toMatchObject({
      kind: "return",
      owner: "p1",
      home: "c1",
      from: "c2",
      fromIsland: "i2",
      to: "c1",
      toIsland: "i1",
      party: null,
      units: { pike: 4 },
      cargo: res(1, 2, 3),
      departAt: 100,
      arriveAt: 6100,
      back: null,
    });
    expect(ctx.events).toEqual([]);
  });

  test("arriveHome puts units home, adds cargo capped and reports the loss", () => {
    const ctx = ctxAt(0);
    cityOf(ctx, "c2").stationed.push({
      owner: "p1",
      home: "c1",
      role: "support",
      units: { pike: 3 },
    });
    cityOf(ctx, "c1").units.pike = 17;
    const units = unstation(ctx, "c2", "p1", "c1");
    const m = startReturn(ctx, {
      owner: "p1",
      home: "c1",
      from: "c2",
      units,
      cargo: res(1500, 0, 0),
    });
    advance(ctx, 6000);
    expect(cityOf(ctx, "c1").units.pike).toBe(20);
    expect(stockAt(ctx.read(), "c1").wood).toBe(2040);
    expect(ctx.ofType("returned")[0]?.data).toEqual({
      movement: m,
      city: "c1",
      units: { pike: 3 },
      cargo: res(1500, 0, 0),
      lost: res(443, 0, 0),
    });
    expect(ctx.state.movements).toEqual({});
    expect(checkStd(ctx.read())).toEqual([]);
  });

  test("arriveHome refuses a home the mover no longer owns", () => {
    const ctx = ctxAt(0);
    const m = startReturn(ctx, { owner: "p1", home: "c1", from: "c1", units: {} });
    cityOf(ctx, "c1").owner = "p2";
    expect(() => arriveHome(ctx, m)).toThrow(StdError);
  });

  test("deliverShipment: the recipient gets the amounts and the loss, the sender only the outcome", () => {
    const ctx = ctxAt(0);
    const m = launch(ctx, draft({ kind: "shipment", cargo: res(100, 600, 50) }), "p2");
    popArrival(ctx, m);
    deliverShipment(ctx, m);
    expect(ctx.ofType("shipment_delivered")).toEqual([
      {
        t: 6000,
        type: "shipment_delivered",
        public: false,
        to: [{ p: "p2", as: "target" }],
        data: {
          movement: m,
          to: "c2",
          outcome: "delivered",
          by: "p1",
          from: "c1",
          res: res(100, 600, 50),
          lost: res(100, 286, 0),
        },
      },
      {
        t: 6000,
        type: "shipment_delivered",
        public: false,
        to: [{ p: "p1", as: "self" }],
        data: { movement: m, to: "c2", outcome: "delivered" },
      },
    ]);
    expect(stockAt(ctx.read(), "c2")).toEqual(res(1000, 1000, 200 + 186 + 50));
    expect(ctx.state.movements).toEqual({});
  });

  test("a shipment to one's own city is reported once, in full", () => {
    const ctx = ctxAt(0);
    const m = launch(ctx, draft({ kind: "shipment", to: "c4", cargo: res(5, 0, 0) }), "p1");
    popArrival(ctx, m);
    deliverShipment(ctx, m);
    const delivered = ctx.ofType("shipment_delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.to).toEqual([{ p: "p1", as: "self" }]);
    expect(delivered[0]?.data["res"]).toEqual(res(5, 0, 0));
  });
});

describe("station and unstation", () => {
  test("groups merge by (owner, home, role) and stay sorted", () => {
    const ctx = ctxAt();
    station(ctx, "c2", { owner: "p3", home: "c3", role: "support", units: { pike: 1 } });
    station(ctx, "c2", { owner: "p1", home: "c4", role: "support", units: { pike: 1 } });
    station(ctx, "c2", { owner: "p1", home: "c1", role: "support", units: { axe: 2 } });
    station(ctx, "c2", { owner: "p1", home: "c1", role: "hold", units: { pike: 1 } });
    station(ctx, "c2", { owner: "p1", home: "c1", role: "support", units: { axe: 1, pike: 1 } });
    expect(cityOf(ctx, "c2").stationed.map((g) => [g.owner, g.home, g.role, g.units])).toEqual([
      ["p1", "c1", "hold", { pike: 1 }],
      ["p1", "c1", "support", { axe: 3, pike: 1 }],
      ["p1", "c4", "support", { pike: 1 }],
      ["p3", "c3", "support", { pike: 1 }],
    ]);
    expect(() =>
      station(ctx, "c2", { owner: "p2", home: "c2", role: "support", units: { pike: 1 } }),
    ).toThrow(StdError);
    expect(() =>
      station(ctx, "c2", { owner: "p1", home: "c1", role: "support", units: {} }),
    ).toThrow(StdError);
  });

  test("unstation takes all, or exactly a part across the groups of one home, and drops empty groups", () => {
    const ctx = ctxAt();
    const c2 = cityOf(ctx, "c2");
    c2.stationed = [
      { owner: "p1", home: "c1", role: "hold", units: { pike: 2, colonist: 1 } },
      { owner: "p1", home: "c1", role: "support", units: { pike: 3 } },
      { owner: "p1", home: "c4", role: "support", units: { pike: 5 } },
    ];
    expect(unstation(ctx, "c2", "p1", "c1", { pike: 4 })).toEqual({ pike: 4 });
    expect(c2.stationed).toEqual([
      { owner: "p1", home: "c1", role: "hold", units: { colonist: 1 } },
      { owner: "p1", home: "c1", role: "support", units: { pike: 1 } },
      { owner: "p1", home: "c4", role: "support", units: { pike: 5 } },
    ]);
    expect(() => unstation(ctx, "c2", "p1", "c4", { pike: 6 })).toThrow(StdError);
    expect(c2.stationed[2]?.units).toEqual({ pike: 5 }); // a failed unstation changes nothing
    expect(unstation(ctx, "c2", "p1", "c1")).toEqual({ pike: 1, colonist: 1 });
    expect(c2.stationed).toEqual([
      { owner: "p1", home: "c4", role: "support", units: { pike: 5 } },
    ]);
    expect(() => unstation(ctx, "c2", "p3", "c3")).toThrow(StdError);
  });
});

// Unit conservation under random sequences of the movement primitives -----------------------------

interface Op {
  readonly kind: number;
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

const PLAYERS: readonly PlayerId[] = ["p1", "p2", "p3"];

function pick<T>(list: readonly T[], i: number): T | undefined {
  return list.length === 0 ? undefined : list[i % list.length];
}

/** A non-empty part of the units at home (each count scaled by `part`/4, at least one unit). */
function partOf(home: UnitCounts, part: number): UnitCounts {
  const out: UnitCounts = {};
  for (const [id, n] of Object.entries(home)) {
    const k = Math.floor(((n ?? 0) * ((part % 4) + 1)) / 4);
    if (k > 0) out[id] = k;
  }
  return out;
}

function apply(ctx: TestCtx, op: Op): void {
  const r = ctx.read();
  const p = PLAYERS[op.a % 3] ?? "p1";
  const from = pick(citiesOf(r, p), op.b);
  const all = Object.values(ctx.state.cities).map((c) => c.id);
  switch (op.kind % 8) {
    case 0:
    case 1:
    case 2: {
      if (from === undefined) return;
      const kind = op.kind % 8 === 0 ? "attack" : op.kind % 8 === 1 ? "support" : "shipment";
      const targets = all.filter((id) => {
        const owner = ctx.state.cities[id]?.owner ?? null;
        if (id === from) return false;
        return kind === "attack" ? owner !== p : owner !== null;
      });
      const to = pick(targets, op.c);
      const target = to === undefined ? undefined : ctx.state.cities[to];
      if (to === undefined || target === undefined) return;
      const units = kind === "shipment" ? {} : partOf(unitsAtHome(r, from), op.c);
      const cargo = kind === "shipment" ? res(op.c % 50, 1, 0) : NO_RES;
      if (kind !== "shipment" && Object.keys(units).length === 0) return;
      const stock = stockAt(r, from);
      if (stock.wood < cargo.wood || stock.stone < cargo.stone) return;
      launch(
        ctx,
        { kind, owner: p, from, to, island: target.island, slot: null, units, cargo, gold: 0 },
        target.owner,
      );
      return;
    }
    case 3: {
      if (from === undefined || (unitsAtHome(r, from).colonist ?? 0) < 1) return;
      const island = pick(["i1", "i2", "i3"] as const, op.c) ?? "i1";
      const units = { ...partOf(unitsAtHome(r, from), op.c), colonist: 1 };
      launch(
        ctx,
        {
          kind: "found",
          owner: p,
          from,
          to: null,
          island,
          slot: null,
          units,
          cargo: NO_RES,
          gold: 0,
        },
        null,
      );
      return;
    }
    case 4: {
      const m = pick(
        Object.values(ctx.state.movements).filter((x) => x.kind !== "return"),
        op.b,
      );
      if (m !== undefined) turnBack(ctx, m.id);
      return;
    }
    case 5: {
      const m = pick(
        Object.values(ctx.state.movements).filter((x) => x.kind !== "return"),
        op.b,
      );
      if (m !== undefined) bounce(ctx, m.id, "test");
      return;
    }
    case 6: {
      const groups = Object.values(ctx.state.cities).flatMap((c) =>
        c.stationed.map((g) => ({ city: c.id, owner: g.owner, home: g.home, units: g.units })),
      );
      const g = pick(groups, op.b);
      if (g === undefined) return;
      const units = op.c % 2 === 0 ? undefined : partOf(g.units, op.c);
      const taken = unstation(ctx, g.city, g.owner, g.home, units);
      if (Object.keys(taken).length === 0) return;
      if (ctx.state.cities[g.home]?.owner === g.owner) {
        startReturn(ctx, { owner: g.owner, home: g.home, from: g.city, units: taken });
      } else {
        station(ctx, g.city, { owner: g.owner, home: g.home, role: "support", units: taken });
      }
      return;
    }
    default:
      advance(ctx, ctx.now + 1 + (op.a % 9000));
  }
}

describe("unit conservation", () => {
  test("random launches, turn backs, bounces, returns, stations and unstations keep every invariant", () => {
    const opArb = fc.record({
      kind: fc.nat({ max: 7 }),
      a: fc.nat({ max: 100000 }),
      b: fc.nat({ max: 1000 }),
      c: fc.nat({ max: 1000 }),
    });
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const ctx = ctxAt(0);
        for (const op of ops) {
          apply(ctx, op);
          expect(checkStd(ctx.read())).toEqual([]);
          expect(danglingRefs(ctx.state)).toEqual([]);
        }
        advance(ctx, ctx.now + 100000);
        expect(ctx.state.movements).toEqual({});
        expect(checkStd(ctx.read())).toEqual([]);
        expect(danglingRefs(ctx.state)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});

describe("stock of shipments", () => {
  test("cargo is paid in whole units at departure", () => {
    const ctx = ctxAt(0);
    launch(ctx, draft({ kind: "shipment", cargo: res(800, 0, 0) }), "p2");
    expect(cityOf(ctx, "c1").stock.wood).toBe(0);
    expect(() => launch(ctx, draft({ kind: "shipment", cargo: res(1, 0, 0) }), "p2")).toThrow(
      StdError,
    );
    expect(cityOf(ctx, "c1").stock.stone).toBe(800 * SCALE);
  });
});

describe("deliverSupport", () => {
  test("stations the group; the owner gets the units, the sender only that it is stationed", () => {
    const ctx = ctxAt(0);
    const m = launch(ctx, draft({ kind: "support", units: { pike: 4, axe: 1 } }), "p2");
    popArrival(ctx, m);
    deliverSupport(ctx, m);
    expect(cityOf(ctx, "c2").stationed).toEqual([
      { owner: "p1", home: "c1", role: "support", units: { pike: 4, axe: 1 } },
    ]);
    expect(ctx.ofType("support_arrived").map((e) => [e.to, e.data])).toEqual([
      [
        [{ p: "p2", as: "target" }],
        { movement: m, by: "p1", to: "c2", units: { pike: 4, axe: 1 } },
      ],
      [[{ p: "p1", as: "self" }], { movement: m, by: "p1", to: "c2" }],
    ]);
    expect(ctx.state.movements).toEqual({});
    expect(checkStd(ctx.read())).toEqual([]);
  });

  test("a reinforcement can join a hold group; a support to one's own city is reported once", () => {
    const ctx = ctxAt(0);
    station(ctx, "c2", { owner: "p1", home: "c1", role: "hold", units: { pike: 1 } });
    cityOf(ctx, "c1").units.pike = 19;
    const hold = launch(ctx, draft({ kind: "support", units: { pike: 2 } }), "p1");
    popArrival(ctx, hold);
    deliverSupport(ctx, hold, "hold");
    expect(cityOf(ctx, "c2").stationed).toEqual([
      { owner: "p1", home: "c1", role: "hold", units: { pike: 3 } },
    ]);
    const own = launch(ctx, draft({ kind: "support", to: "c4", units: { pike: 1 } }), "p1");
    popArrival(ctx, own);
    deliverSupport(ctx, own);
    expect(ctx.ofType("support_arrived").slice(2)).toHaveLength(1);
    expect(checkStd(ctx.read())).toEqual([]);
  });
});

describe("boundary copies (§6.6)", () => {
  test("changing the inputs of a primitive afterwards never changes the state", () => {
    const ctx = ctxAt(0);
    const units: UnitCounts = { pike: 2 };
    const s = launch(ctx, draft({ kind: "shipment", cargo: res(10, 0, 0) }), "p2");
    const m = launch(ctx, draft({ kind: "support", units }), "p2");
    units["pike"] = 9;
    const groupUnits: UnitCounts = { pike: 1 };
    station(ctx, "c2", { owner: "p3", home: "c3", role: "support", units: groupUnits });
    groupUnits["pike"] = 5;
    const back = { kind: "attack" as const, at: 0 };
    const r = startReturn(ctx, { owner: "p1", home: "c1", from: "c4", units: { pike: 1 }, back });
    back.at = 7;
    expect(movementOf(ctx, s).cargo).toEqual(res(10, 0, 0));
    expect(movementOf(ctx, m).units).toEqual({ pike: 2 });
    expect(cityOf(ctx, "c2").stationed[0]?.units).toEqual({ pike: 1 });
    expect(movementOf(ctx, r).back).toEqual({ kind: "attack", at: 0 });
    expect(ctx.ofType("incoming_support")[0]?.data["units"]).toEqual({ pike: 2 });
  });
});
