import { describe, expect, test } from "bun:test";
import { checkStd, enqueueBuild, enqueueRecruit, launch, stdInvariants } from "./index.ts";
import { SCALE, cityOf, ctxAt, movementOf, res, type TestCtx } from "./fixtures.test.ts";

/** A busy but valid state: queues, a movement in flight and a stationed group. */
function busy(): TestCtx {
  const ctx = ctxAt(50000);
  enqueueBuild(ctx, "c1", "woodcut");
  enqueueBuild(ctx, "c1", "store");
  enqueueRecruit(ctx, "c1", "pike", 3);
  launch(
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
  cityOf(ctx, "c3").units.pike = 8;
  cityOf(ctx, "c2").stationed.push({
    owner: "p3",
    home: "c3",
    role: "support",
    units: { pike: 2 },
  });
  return ctx;
}

function onlyMovement(ctx: TestCtx) {
  const m = Object.values(ctx.state.movements)[0];
  if (m === undefined) throw new Error("fixture");
  return movementOf(ctx, m.id);
}

/** One planted corruption per invariant (several where an invariant checks several things). */
const PLANTS: Readonly<Record<string, readonly ((ctx: TestCtx) => void)[]>> = {
  "std.safe-ints": [
    (ctx) => {
      cityOf(ctx, "c1").stock.wood = 1.5;
    },
    (ctx) => {
      cityOf(ctx, "c3").foundedAt = -1;
    },
    (ctx) => {
      ctx.state.ext = { score: -3 };
    },
  ],
  "std.stock-cap": [
    (ctx) => {
      cityOf(ctx, "c2").stock.gold = 1000 * SCALE + 1;
    },
    (ctx) => {
      cityOf(ctx, "c2").stockAt = 50001;
    },
  ],
  "std.recruit-batches": [
    (ctx) => {
      const b = cityOf(ctx, "c1").recruit["camp"]?.[0];
      if (b !== undefined) b.popEach = 2;
    },
    (ctx) => {
      const b = cityOf(ctx, "c1").recruit["camp"]?.[0];
      if (b !== undefined) b.done = 4;
    },
    (ctx) => {
      const b = cityOf(ctx, "c1").recruit["camp"]?.[0];
      if (b !== undefined) b.end += 1;
    },
    (ctx) => {
      const b = cityOf(ctx, "c1").recruit["camp"]?.[0];
      if (b !== undefined) b.unit = "galley";
    },
  ],
  "std.unit-conservation": [
    (ctx) => {
      cityOf(ctx, "c1").units.pike = 21;
    },
    (ctx) => {
      onlyMovement(ctx).units = { axe: 4, ferry: 1 };
    },
    (ctx) => {
      const g = cityOf(ctx, "c2").stationed[0];
      if (g !== undefined) g.owner = "p2";
    },
  ],
  "std.stationed": [
    (ctx) => {
      cityOf(ctx, "c2").stationed.unshift({
        owner: "p3",
        home: "c3",
        role: "support",
        units: { pike: 1 },
      });
    },
    (ctx) => {
      const g = cityOf(ctx, "c2").stationed[0];
      if (g !== undefined) g.units = {};
    },
    (ctx) => {
      const g = cityOf(ctx, "c2").stationed[0];
      if (g !== undefined) g.home = "c2";
    },
    (ctx) => {
      cityOf(ctx, "c2").stationed.unshift({
        owner: "p1",
        home: "c9",
        role: "support",
        units: { pike: 1 },
      });
    },
  ],
  "std.slots": [
    (ctx) => {
      cityOf(ctx, "c4").slot = 0;
    },
    (ctx) => {
      cityOf(ctx, "c4").slot = 3;
    },
  ],
  "std.eliminated": [
    (ctx) => {
      const p3 = ctx.state.players.p3;
      if (p3 !== undefined) {
        p3.alive = false;
        p3.eliminatedAt = 100;
      }
    },
  ],
  "std.attack-min-travel": [
    (ctx) => {
      const m = onlyMovement(ctx);
      m.arriveAt = m.departAt + 3599;
    },
  ],
  "std.movements": [
    (ctx) => {
      onlyMovement(ctx).home = "c9";
    },
    (ctx) => {
      onlyMovement(ctx).toIsland = "i9";
    },
    (ctx) => {
      onlyMovement(ctx).departAt = 50001;
    },
    (ctx) => {
      onlyMovement(ctx).to = null;
    },
  ],
  "std.homes": [
    (ctx) => {
      onlyMovement(ctx).home = "c2";
    },
    (ctx) => {
      cityOf(ctx, "c1").owner = null;
    },
    (ctx) => {
      cityOf(ctx, "c3").owner = "p2";
    },
  ],
  "std.buildings": [
    (ctx) => {
      delete cityOf(ctx, "c1").buildings["rampart"];
    },
    (ctx) => {
      cityOf(ctx, "c1").buildings["woodcut"] = 11;
    },
    (ctx) => {
      cityOf(ctx, "c1").buildings["tower"] = 1;
    },
  ],
  "std.queues": [
    (ctx) => {
      const [a, b] = cityOf(ctx, "c1").build;
      if (a !== undefined && b !== undefined) b.start = a.end - 1;
    },
    (ctx) => {
      const a = cityOf(ctx, "c1").build[0];
      if (a !== undefined) a.id = 3;
    },
    (ctx) => {
      cityOf(ctx, "c1").itemSeq = 2;
    },
    (ctx) => {
      cityOf(ctx, "c1").recruit["barn"] = [];
    },
    (ctx) => {
      delete cityOf(ctx, "c1").recruit["dock"];
    },
  ],
  "std.units-known": [
    (ctx) => {
      cityOf(ctx, "c3").units["dragon"] = 1;
    },
    (ctx) => {
      cityOf(ctx, "c3").units.axe = 0;
    },
  ],
};

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe("std invariants", () => {
  test("a busy valid state passes every invariant", () => {
    expect(checkStd(busy().read())).toEqual([]);
  });

  test("every invariant has planted corruptions", () => {
    expect(Object.keys(PLANTS).toSorted(byName)).toEqual(
      stdInvariants.map((i) => i.name).toSorted(byName),
    );
  });

  for (const inv of stdInvariants) {
    const plants = PLANTS[inv.name] ?? [];
    plants.forEach((plant, i) => {
      test(`${inv.name} catches planted corruption ${i + 1}`, () => {
        const ctx = busy();
        expect(inv.check(ctx.read())).toEqual([]);
        plant(ctx);
        expect(inv.check(ctx.read()).length).toBeGreaterThan(0);
      });
    });
  }

  test("island coordinates may be negative", () => {
    const ctx = busy();
    const island = ctx.state.islands.i1;
    if (island === undefined) throw new Error("fixture");
    island.x = -5;
    expect(checkStd(ctx.read())).toEqual([]);
  });

  test("reports are capped", () => {
    const ctx = busy();
    for (const c of Object.values(ctx.state.cities)) {
      c.stock = res(-1, -1, -1);
      c.stockAt = -1;
      c.foundedAt = -1;
    }
    const out = stdInvariants.find((i) => i.name === "std.safe-ints")?.check(ctx.read()) ?? [];
    expect(out).toHaveLength(21);
    expect(out[20]).toBe("… 5 more");
  });
});
