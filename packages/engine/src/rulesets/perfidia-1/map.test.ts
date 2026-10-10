import { describe, expect, test } from "bun:test";
import type { Rng, WorldCtx, WorldSetup } from "@perfidia/engine/contracts";
import { streamRng } from "@perfidia/engine/core";
import { CitySchema, compareIds, IslandSchema, type PlayerId } from "@perfidia/protocol";
import fc from "fast-check";
import { compileRules } from "./compile.ts";
import { type IslandKind, PERFIDIA_1_DEFAULTS, type PerfidiaConfig } from "./config.ts";
import { type PerfidiaExt, PerfidiaExtSchema } from "./ext.ts";
import {
  createWorld,
  drawMap,
  type LaidIsland,
  layoutIslands,
  type MapDraws,
  sectorIslandId,
} from "./map.ts";
import { distanceTiles, travelBetween } from "./travel.ts";

// Map generation (perfidia-1 §2.3, §2.4, §3) and the fairness guarantee of §2.5.

const d = PERFIDIA_1_DEFAULTS;
const players = (n: number): PlayerId[] =>
  Array.from({ length: n }, (_, i) => `p${i + 1}` as const);

function worldCtx(seed: number, n: number, config: PerfidiaConfig = d): WorldCtx<PerfidiaConfig> {
  const used = new Set<string>();
  return {
    seed,
    players: players(n),
    config,
    rules: compileRules(config, n),
    rng(stream: string): Rng {
      if (used.has(stream)) throw new Error(`stream ${stream} requested twice`);
      used.add(stream);
      return streamRng(seed, stream);
    },
  };
}

function world(seed: number, n: number): WorldSetup<PerfidiaExt> {
  return createWorld(worldCtx(seed, n));
}

const TRANSPORT = { kind: "attack", units: { transport: 1 } } as const;

/**
 * The three assertions of §2.5 on one layout. Plain throws rather than `expect`, because the
 * exhaustive sweep runs them on 40,320 maps.
 */
function assertFair(islands: readonly LaidIsland[], n: number): void {
  const keys = new Set<string>();
  for (const [i, a] of islands.entries()) {
    if (a.x < 0 || a.y < 0) throw new Error(`${a.id} has a negative coordinate`);
    keys.add(`${a.x},${a.y}`);
    for (const b of islands.slice(i + 1)) {
      if (distanceTiles(a, b) < 15) throw new Error(`${a.id} and ${b.id} are closer than 15 tiles`);
    }
  }
  if (keys.size !== islands.length) throw new Error("two islands share coordinates");

  const homes = islands.filter((i) => i.kind === "home");
  if (homes.length !== n) throw new Error(`${homes.length} homes for N = ${n}`);
  const vectors = homes.map((h) =>
    islands
      .filter((o) => o.id !== h.id)
      .map((o) => travelBetween(d, h, o, false, TRANSPORT))
      .toSorted((a, b) => a - b),
  );
  const first = vectors[0]!;
  for (let e = 0; e < first.length; e += 1) {
    let lo = Number.MAX_SAFE_INTEGER;
    let hi = 0;
    for (const v of vectors) {
      lo = Math.min(lo, v[e]!);
      hi = Math.max(hi, v[e]!);
    }
    if (hi - lo > 150) throw new Error(`transport times differ by ${hi - lo} s at rank ${e}`);
  }

  for (const i of islands) {
    if (i.kind !== "frontier" && i.kind !== "inner" && i.kind !== "hub") continue;
    const k = i.sector!;
    const a = homes[k]!;
    const b = homes[(k + 1) % n]!;
    const gap = Math.abs(distanceTiles(i, a) - distanceTiles(i, b));
    if (gap > 3) throw new Error(`${i.id} is ${gap} tiles off equidistance`);
  }
}

describe("§2.4 resulting maps", () => {
  const expected: Record<number, { islands: number; slots: number; free: number }> = {
    6: { islands: 31, slots: 43, free: 6 },
    7: { islands: 36, slots: 50, free: 6 },
    8: { islands: 33, slots: 49, free: 5 },
    9: { islands: 37, slots: 55, free: 5 },
    10: { islands: 41, slots: 61, free: 5 },
    11: { islands: 45, slots: 67, free: 5 },
    12: { islands: 49, slots: 73, free: 5 },
  };

  test("island, slot and free-slot counts per N", () => {
    for (let n = 6; n <= 12; n += 1) {
      const w = world(42, n);
      const slots = w.islands.reduce((s, i) => s + i.slots, 0);
      expect({
        islands: w.islands.length,
        slots,
        free: (slots - w.cities.length) / n,
      }).toEqual(expected[n]!);
    }
  });

  test("distances from a home with median jitter match the table within rounding", () => {
    // [backyard, frontier, inner, hub, Crown, neighbour home, opposite home] in tiles.
    const table: Record<number, (number | null)[]> = {
      6: [80, 93, 105, 131, 180, 180, 360],
      7: [80, 92, 108, 155, 207, 179, 403],
      8: [80, 91, 109, null, 235, 179, 470],
      9: [80, 91, 110, null, 263, 180, 517],
      10: [80, 91, 111, null, 291, 179, 582],
      11: [80, 90, 112, null, 319, 179, 631],
      12: [80, 90, 112, null, 348, 180, 696],
    };
    for (let n = 6; n <= 12; n += 1) {
      for (let rot = 0; rot < 360; rot += 7) {
        const islands = layoutIslands(d, n, {
          rot,
          jitter: { backyard: 0, frontier: 0, inner: 0, hub: 0 },
        });
        const of = (kind: string) => islands.find((i) => i.kind === kind && i.sector === 0);
        const home = of("home")!;
        const homes = islands.filter((i) => i.kind === "home");
        const hub = of("hub");
        const got = [
          distanceTiles(home, of("backyard")!),
          distanceTiles(home, of("frontier")!),
          distanceTiles(home, of("inner")!),
          hub === undefined ? null : distanceTiles(home, hub),
          distanceTiles(home, islands[0]!),
          distanceTiles(home, homes[1]!),
          Math.max(...homes.map((h) => distanceTiles(home, h))),
        ];
        for (const [i, want] of table[n]!.entries()) {
          if (want === null) expect(got[i]).toBeNull();
          else expect(Math.abs(got[i]! - want)).toBeLessThanOrEqual(2);
        }
      }
    }
  });
});

describe("§2.3 layout", () => {
  test("ids: i1 is the Crown at (C, C), then home, backyard, frontier, inner (and hub) per sector", () => {
    for (const n of [6, 7, 8, 12]) {
      const islands = layoutIslands(d, n, drawMap(d, streamRng(9, "map")));
      const C = (d.map.homeRadius[String(n)] ?? 0) + 120;
      expect(islands[0]).toMatchObject({
        id: "i1",
        kind: "crown",
        x: C,
        y: C,
        slots: 1,
        richnessPm: 1500,
      });
      const kinds: readonly IslandKind[] =
        n <= 7
          ? ["home", "backyard", "frontier", "inner", "hub"]
          : ["home", "backyard", "frontier", "inner"];
      for (const [i, island] of islands.slice(1).entries()) {
        expect(island.id).toBe(`i${i + 2}`);
        expect(island.kind).toBe(kinds[i % kinds.length]!);
        expect(island.sector).toBe(Math.floor(i / kinds.length));
        if (island.kind !== "crown") {
          expect(sectorIslandId(d, n, island.sector!, island.kind)).toBe(island.id);
        }
      }
      expect(islands.find((i) => i.kind === "frontier")).toMatchObject({
        slots: 2,
        richnessPm: 1500,
      });
      expect(islands.find((i) => i.kind === "inner")).toMatchObject({ slots: 1, richnessPm: 1250 });
      expect(islands.find((i) => i.kind === "backyard")).toMatchObject({
        slots: 1,
        richnessPm: 1000,
      });
      expect(islands.find((i) => i.kind === "home")).toMatchObject({ slots: 2, richnessPm: 1000 });
    }
  });

  test("sectorIslandId rejects hubs when N > hubMaxPlayers", () => {
    expect(() => sectorIslandId(d, 8, 0, "hub")).toThrow(RangeError);
  });

  test("the map stream: rot in 0..359, jitters in ±radialJitter, hub drawn even without hubs", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4294967295 }), (seed) => {
        const draws: MapDraws = drawMap(d, streamRng(seed, "map"));
        expect(draws.rot).toBeGreaterThanOrEqual(0);
        expect(draws.rot).toBeLessThanOrEqual(359);
        const { backyard, frontier, inner, hub } = draws.jitter;
        for (const j of [backyard, frontier, inner, hub])
          expect(Math.abs(j)).toBeLessThanOrEqual(10);
      }),
    );
  });

  test("rotation is exact up to rounding: every sector has the same shape", () => {
    const islands = layoutIslands(d, 9, drawMap(d, streamRng(3, "map")));
    const shape = (k: number) =>
      islands.filter((i) => i.sector === k).map((i) => distanceTiles(i, islands[0]!));
    for (let k = 1; k < 9; k += 1) {
      for (const [i, v] of shape(k).entries())
        expect(Math.abs(v - shape(0)[i]!)).toBeLessThanOrEqual(1);
    }
  });
});

describe("§2.5 fairness guarantee", () => {
  test("holds for every N = 6..12 over random seeds (fast-check)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 6, max: 12 }),
        fc.integer({ min: 0, max: 4294967295 }),
        (n, seed) => {
          const draws = drawMap(d, streamRng(seed, "map"));
          assertFair(layoutIslands(d, n, draws), n);
          const w = world(seed, n);
          expect(w.islands.map((i) => [i.x, i.y])).toEqual(
            layoutIslands(d, n, draws).map((i) => [i.x, i.y]),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  test(
    "holds over the exhaustive sweep of rot and the jitter extremes",
    () => {
      for (let n = 6; n <= 12; n += 1) {
        for (let rot = 0; rot < 360; rot += 1) {
          for (let mask = 0; mask < 16; mask += 1) {
            const pick = (bit: number) => ((mask >> bit) & 1 ? 10 : -10);
            const jitter = { backyard: pick(0), frontier: pick(1), inner: pick(2), hub: pick(3) };
            assertFair(layoutIslands(d, n, { rot, jitter }), n);
          }
        }
      }
    },
    { timeout: 60_000 },
  );
});

describe("§3 starting state", () => {
  test("capitals c1..cN in slot 0 of distinct home islands, the Crown c(N+1) on i1", () => {
    for (let n = 6; n <= 12; n += 1) {
      const w = world(7 * n, n);
      const homes = new Set(w.islands.filter((i) => i.kind === "home").map((i) => i.id));
      const capitals = w.cities.slice(0, n);
      expect(capitals.map((c) => c.id)).toEqual(players(n).map((_, i) => `c${i + 1}` as const));
      expect(new Set(capitals.map((c) => c.island)).size).toBe(n);
      for (const [j, c] of capitals.entries()) {
        expect(homes.has(c.island)).toBe(true);
        expect(c).toMatchObject({
          name: c.id,
          owner: `p${j + 1}`,
          capitalOf: `p${j + 1}`,
          slot: 0,
          tag: null,
          foundedAt: 0,
          stockAt: 0,
          stock: { wood: 800 * 3600, stone: 800 * 3600, gold: 800 * 3600 },
          buildings: {
            hall: 1,
            lumber: 1,
            quarry: 1,
            mine: 1,
            warehouse: 1,
            barracks: 0,
            harbor: 0,
            wall: 0,
          },
          units: { guard: 10 },
          stationed: [],
          itemSeq: 0,
          build: [],
          recruit: { barracks: [], harbor: [] },
        });
      }
      const crown = w.cities[n];
      expect(w.cities).toHaveLength(n + 1);
      expect(crown).toMatchObject({
        id: `c${n + 1}`,
        owner: null,
        capitalOf: null,
        island: "i1",
        slot: 0,
        tag: "crown",
        stock: { wood: 3000 * 3600, stone: 3000 * 3600, gold: 3000 * 3600 },
        units: { guard: 400, warship: 10 },
      });
      expect(Object.values(crown!.buildings)).toEqual(Array.from({ length: 8 }, () => 5));
      for (const c of w.cities) CitySchema.parse(c);
      for (const i of w.islands) IslandSchema.parse(i);
    }
  });

  test("seats come from the seats stream; the tie-break order from the tiebreak stream", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 6, max: 12 }),
        fc.integer({ min: 0, max: 4294967295 }),
        (n, seed) => {
          const w = world(seed, n);
          expect(w.ext.tiebreak.toSorted(compareIds)).toEqual(players(n));
          expect(PerfidiaExtSchema.parse(w.ext)).toEqual(w.ext);
          expect(w).toEqual(world(seed, n));
        },
      ),
      { numRuns: 50 },
    );
  });

  test("the ext starts empty and the domination timer is scheduled", () => {
    const w = world(1, 6);
    expect(w.ext).toMatchObject({
      sieges: {},
      battlePoints: { p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0 },
      related: [],
      relationEnds: {},
      domination: { open: false, countdowns: [] },
    });
    expect(w.timers).toEqual([{ kind: "domination_open", at: 259200, ref: "" }]);
  });

  test("different seeds give different maps", () => {
    const a = world(1, 8);
    const b = world(2, 8);
    expect(a.islands).not.toEqual(b.islands);
  });
});
