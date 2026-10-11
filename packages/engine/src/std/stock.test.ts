import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { canonicalJson } from "@perfidia/engine/core";
import {
  StdError,
  addCapped,
  materialize,
  setLevel,
  spend,
  stockAt,
  stockSecondsAt,
  storageCap,
  unitsAtHome,
} from "./index.ts";
import { SCALE, cityOf, ctxAt, res, type TestCtx } from "./fixtures.test.ts";

interface Setup {
  readonly levels: readonly [number, number, number];
  readonly store: number;
  readonly richness: number;
  readonly fill: readonly [number, number, number];
  readonly batch: {
    readonly count: number;
    readonly unitTime: number;
    readonly start: number;
  } | null;
}

const setupArb: fc.Arbitrary<Setup> = fc.record({
  levels: fc.tuple(
    fc.integer({ min: 0, max: 10 }),
    fc.integer({ min: 0, max: 10 }),
    fc.integer({ min: 0, max: 10 }),
  ),
  store: fc.integer({ min: 0, max: 10 }),
  richness: fc.integer({ min: 0, max: 3000 }),
  fill: fc.tuple(
    fc.integer({ min: 0, max: 1000 }),
    fc.integer({ min: 0, max: 1000 }),
    fc.integer({ min: 0, max: 1000 }),
  ),
  batch: fc.option(
    fc.record({
      count: fc.integer({ min: 1, max: 40 }),
      unitTime: fc.integer({ min: 1, max: 900 }),
      start: fc.integer({ min: 0, max: 5000 }),
    }),
    { nil: null },
  ),
});

/** A context whose city c1 has the given levels, richness, stock (per mille of the cap) and batch. */
function build(s: Setup): TestCtx {
  const ctx = ctxAt(0);
  const c = cityOf(ctx, "c1");
  const island = ctx.state.islands.i1;
  if (island === undefined) throw new Error("fixture");
  island.richnessPm = s.richness;
  c.buildings["woodcut"] = s.levels[0];
  c.buildings["stonecut"] = s.levels[1];
  c.buildings["goldpit"] = s.levels[2];
  c.buildings["store"] = s.store;
  const capS = storageCap(ctx.read(), "c1") * SCALE;
  c.stock = res(
    Math.floor((capS * s.fill[0]) / 1000),
    Math.floor((capS * s.fill[1]) / 1000),
    Math.floor((capS * s.fill[2]) / 1000),
  );
  if (s.batch !== null) {
    const end = s.batch.start + s.batch.count * s.batch.unitTime;
    c.recruit["camp"] = [
      {
        id: 1,
        unit: "pike",
        count: s.batch.count,
        done: 0,
        unitTime: s.batch.unitTime,
        costEach: res(30, 60, 30),
        popEach: 1,
        start: s.batch.start,
        end,
        seq: ctx.schedule("recruit_done", end, "c1"),
      },
    ];
    c.itemSeq = 1;
  }
  return ctx;
}

const snapshot = (ctx: TestCtx): string =>
  canonicalJson({ city: ctx.state.cities.c1, ledger: ctx.state.ledger });

describe("P2: accrual is path-independent", () => {
  test("any split of an interval gives the same stock and the same delivered units", () => {
    fc.assert(
      fc.property(
        setupArb,
        fc.array(fc.integer({ min: 0, max: 400000 }), { maxLength: 8 }),
        fc.integer({ min: 0, max: 400000 }),
        (s, splits, end) => {
          const once = build(s);
          once.setNow(end);
          materialize(once, "c1");
          const split = build(s);
          for (const t of splits.filter((x) => x <= end).toSorted((a, b) => a - b)) {
            split.setNow(t);
            materialize(split, "c1");
          }
          split.setNow(end);
          materialize(split, "c1");
          expect(snapshot(split)).toBe(snapshot(once));
        },
      ),
    );
  });
});

describe("materialize", () => {
  test("is idempotent and agrees with stockAt and unitsAtHome", () => {
    fc.assert(
      fc.property(setupArb, fc.integer({ min: 0, max: 400000 }), (s, t) => {
        const ctx = build(s);
        ctx.setNow(t);
        const r = ctx.read();
        const seconds = stockSecondsAt(r, "c1", t);
        const stock = stockAt(r, "c1");
        const units = unitsAtHome(r, "c1");
        materialize(ctx, "c1");
        const c = cityOf(ctx, "c1");
        expect(c.stock).toEqual(seconds);
        expect(c.stockAt).toBe(t);
        expect(stockAt(ctx.read(), "c1")).toEqual(stock);
        expect(c.units).toEqual(units);
        expect(unitsAtHome(ctx.read(), "c1")).toEqual(units);
        const once = snapshot(ctx);
        materialize(ctx, "c1");
        expect(snapshot(ctx)).toBe(once);
      }),
    );
  });

  test("trickle: unit j of a batch lands at start + j·unitTime and is made in the ledger", () => {
    const ctx = build({
      levels: [1, 1, 1],
      store: 1,
      richness: 1000,
      fill: [0, 0, 0],
      batch: { count: 3, unitTime: 100, start: 50 },
    });
    ctx.setNow(249);
    materialize(ctx, "c1");
    expect(cityOf(ctx, "c1").units.pike).toBe(21);
    expect(cityOf(ctx, "c1").recruit["camp"]?.[0]?.done).toBe(1);
    ctx.setNow(250);
    materialize(ctx, "c1");
    expect(cityOf(ctx, "c1").units.pike).toBe(22);
    expect(ctx.state.ledger.p1?.made.pike).toBe(27);
  });

  test("rejects a time before the last materialisation", () => {
    const ctx = ctxAt(100);
    materialize(ctx, "c1");
    expect(() => stockAt(ctx.read(), "c1", 50)).toThrow(StdError);
  });
});

describe("spend, addCapped, setLevel", () => {
  test("spend pays whole units and refuses a shortfall", () => {
    const ctx = ctxAt(3600);
    spend(ctx, "c1", res(910, 0, 10));
    expect(stockAt(ctx.read(), "c1")).toEqual(res(0, 910, 900));
    expect(() => spend(ctx, "c1", res(1, 0, 0))).toThrow(StdError);
    expect(() => spend(ctx, "c1", res(-1, 0, 0))).toThrow(StdError);
  });

  test("addCapped caps at the warehouse and reports the visible loss", () => {
    const ctx = ctxAt(0);
    const lost = addCapped(ctx, "c2", res(50, 600, 100));
    expect(lost).toEqual(res(50, 100, 0));
    expect(stockAt(ctx.read(), "c2")).toEqual(res(1000, 1000, 300));
    const c2 = cityOf(ctx, "c2");
    c2.stock.gold = 1000 * SCALE - 1800; // half a unit below the cap: 999 visible
    expect(addCapped(ctx, "c2", res(0, 0, 1))).toEqual(res(0, 0, 0));
    expect(c2.stock.gold).toBe(1000 * SCALE);
    expect(addCapped(ctx, "c2", res(0, 0, 3))).toEqual(res(0, 0, 3));
  });

  test("setLevel materialises first, so the new rate counts from now", () => {
    const ctx = ctxAt(3600);
    setLevel(ctx, "c1", "woodcut", 5);
    expect(cityOf(ctx, "c1").stockAt).toBe(3600);
    ctx.setNow(7200);
    expect(stockAt(ctx.read(), "c1").wood).toBe(910 + 275);
    expect(() => setLevel(ctx, "c1", "woodcut", 11)).toThrow(StdError);
    expect(() => setLevel(ctx, "c1", "nothing", 1)).toThrow(StdError);
  });
});
