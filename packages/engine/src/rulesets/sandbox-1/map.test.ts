import { describe, expect, test } from "bun:test";
import type { WorldCtx } from "@perfidia/engine/contracts";
import { idKeyFromSeed, shuffle, streamRng } from "@perfidia/engine/core";
import { createMatch } from "@perfidia/engine/kernel";
import { compareIds, GameStateSchema, PlayerIdSchema, type MatchSetup } from "@perfidia/protocol";
import fc from "fast-check";
import { compileRules } from "./compile.ts";
import { SANDBOX_1_DEFAULTS, SANDBOX_1_REF, type SandboxConfig } from "./config.ts";
import { sandbox1_1_0_0 } from "./descriptor.ts";
import { createWorld, layoutIslands, ringDistance, ringWidth, sectorIslandId } from "./map.ts";
import { sandboxConfig, TEST_DOMAIN } from "./testkit.test.ts";

// The map of sandbox-1 (docs/architecture.md §3.8): a ring of N sectors, 40 tiles wide; per sector
// a home island (2 slots, richness 1000) and a shared island (2 slots, richness 1500) at
// (+20, +15); seats shuffled on the stream `seats`; distances wrap around the ring in x.

function world(players: number, seed: number, config = SANDBOX_1_DEFAULTS) {
  const ids = Array.from({ length: players }, (_, i) => PlayerIdSchema.parse(`p${i + 1}`));
  const taken: string[] = [];
  const w: WorldCtx<SandboxConfig> = {
    seed,
    players: ids,
    config,
    rules: compileRules(config, players),
    rng: (stream) => {
      taken.push(stream);
      return streamRng(seed, stream);
    },
  };
  return { setup: createWorld(w), streams: taken };
}

function setup(players: number, seed = 1): MatchSetup {
  return {
    ruleset: SANDBOX_1_REF,
    overrides: {},
    seed,
    idKey: idKeyFromSeed(seed),
    seats: Array.from({ length: players }, (_, i) => ({ id: PlayerIdSchema.parse(`p${i + 1}`) })),
  };
}

describe("islands", () => {
  for (const n of [2, 7, 12]) {
    test(`N = ${n}: ids i1..i${2 * n}, home and shared islands per sector`, () => {
      const islands = layoutIslands(SANDBOX_1_DEFAULTS, n);
      const ids: string[] = islands.map((i) => i.id);
      expect(ids).toEqual(Array.from({ length: 2 * n }, (_, k) => `i${k + 1}`));
      for (let k = 0; k < n; k += 1) {
        expect(islands[2 * k]).toEqual({
          id: `i${2 * k + 1}`,
          x: 40 * k,
          y: 0,
          kind: "home",
          slots: 2,
          richnessPm: 1000,
        });
        expect(islands[2 * k + 1]).toEqual({
          id: `i${2 * k + 2}`,
          x: 40 * k + 20,
          y: 15,
          kind: "shared",
          slots: 2,
          richnessPm: 1500,
        });
      }
      expect(ringWidth(SANDBOX_1_DEFAULTS, n)).toBe(40 * n);
      expect(sectorIslandId(n - 1, "home")).toBe(`i${2 * n - 1}`);
      expect(sectorIslandId(n - 1, "shared")).toBe(`i${2 * n}`);
    });
  }
});

function islandAt(n: number, id: string) {
  const island = layoutIslands(SANDBOX_1_DEFAULTS, n).find((i) => i.id === id);
  if (island === undefined) throw new Error(`no ${id}`);
  return island;
}

/** The ring distance between two islands of the map of N players. */
function d(n: number, a: string, b: string): number {
  return ringDistance(islandAt(n, a), islandAt(n, b), ringWidth(SANDBOX_1_DEFAULTS, n));
}

describe("distances", () => {
  test("N = 2: the ring is 80 tiles around", () => {
    expect(d(2, "i1", "i2")).toBe(35);
    expect(d(2, "i1", "i3")).toBe(40);
    expect(d(2, "i1", "i4")).toBe(35); // 60 tiles one way, 20 the other
    expect(d(2, "i2", "i4")).toBe(40);
    expect(d(2, "i3", "i3")).toBe(0);
  });

  test("N = 7: the ring is 280 tiles around", () => {
    expect(d(7, "i1", "i13")).toBe(40); // sector 6 wraps to the neighbour of sector 0
    expect(d(7, "i2", "i14")).toBe(40);
    expect(d(7, "i1", "i8")).toBe(155); // 140 either way, + 15
    expect(d(7, "i1", "i7")).toBe(120);
    expect(d(7, "i6", "i9")).toBe(75); // (100, 15) to (160, 0)
  });

  test("N = 12: the ring is 480 tiles around", () => {
    expect(d(12, "i1", "i13")).toBe(240); // the opposite sector
    expect(d(12, "i1", "i24")).toBe(35);
    expect(d(12, "i2", "i23")).toBe(75); // (20, 15) to (440, 0): 60 tiles across the seam
    expect(d(12, "i11", "i14")).toBe(75);
  });

  test("symmetric, zero only on one island, and never above W/2 + dy", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 12 }), fc.nat(), fc.nat(), (n, a, b) => {
        const islands = layoutIslands(SANDBOX_1_DEFAULTS, n);
        const x = islands[a % islands.length];
        const y = islands[b % islands.length];
        if (x === undefined || y === undefined) return;
        const w = ringWidth(SANDBOX_1_DEFAULTS, n);
        const dist = ringDistance(x, y, w);
        expect(dist).toBe(ringDistance(y, x, w));
        expect(dist === 0).toBe(x.id === y.id);
        expect(dist).toBeLessThanOrEqual(w / 2 + 15);
      }),
    );
  });
});

describe("createWorld", () => {
  test("draws seats from the stream `seats` only, and capital c(j+1) sits in slot 0 of sector perm[j]", () => {
    for (const [n, perm] of [
      [7, [5, 4, 0, 2, 3, 1, 6]],
      [12, [4, 1, 9, 5, 11, 8, 2, 0, 6, 7, 3, 10]],
    ] as const) {
      const { setup: s, streams } = world(n, 1);
      expect(streams).toEqual(["seats"]);
      expect(
        shuffle(
          streamRng(1, "seats"),
          Array.from({ length: n }, (_, k) => k),
        ),
      ).toEqual([...perm]);
      expect(s.cities.map((c) => [c.id, c.owner, c.island, c.slot, c.capitalOf])).toEqual(
        perm.map((sector, j) => [`c${j + 1}`, `p${j + 1}`, `i${2 * sector + 1}`, 0, `p${j + 1}`]),
      );
    }
  });

  test("N = 2: two capitals on the two home islands, whatever the seed", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
        const { setup: s } = world(2, seed);
        expect(s.cities.map((c) => c.island).toSorted(compareIds)).toEqual(["i1", "i3"]);
      }),
      { numRuns: 30 },
    );
  });

  test("a capital: start buildings at 1, 500 of each, 8 spearmen, empty queues", () => {
    const { setup: s } = world(7, 3);
    const c1 = s.cities[0];
    expect(c1).toMatchObject({
      id: "c1",
      name: "c1",
      owner: "p1",
      tag: null,
      foundedAt: 0,
      stock: { wood: 500 * 3600, stone: 500 * 3600, gold: 500 * 3600 },
      stockAt: 0,
      buildings: { keep: 1, sawmill: 1, pit: 1, forge: 1, depot: 1, camp: 0, docks: 0 },
      units: { spearman: 8 },
      stationed: [],
      itemSeq: 0,
      build: [],
      recruit: { camp: [], docks: [] },
    });
    expect(s.ext).toEqual({ hillOpen: false });
    expect(s.timers).toEqual([{ kind: "hill_open", at: 172800, ref: "" }]);
  });

  test("follows overrides: sector width, offsets, slots, start", () => {
    const config = sandboxConfig({
      "map.sectorWidth": 30,
      "map.shared.dx": 10,
      "map.shared.dy": 5,
      "map.home.slots": 3,
      "start.spearmen": 0,
      "time.hillOpen": 7200,
    });
    const { setup: s } = world(3, 9, config);
    expect(s.islands[3]).toMatchObject({ id: "i4", x: 40, y: 5 });
    expect(s.islands[2]).toMatchObject({ id: "i3", x: 30, slots: 3 });
    expect(s.cities.every((c) => Object.keys(c.units).length === 0)).toBe(true);
    expect(s.timers[0]?.at).toBe(7200);
  });
});

describe("through the kernel", () => {
  test("createMatch for N = 2..12: valid state, both timers queued, every step invariant", () => {
    for (let n = 2; n <= 12; n += 1) {
      const match = createMatch(setup(n, 100 + n), sandbox1_1_0_0, TEST_DOMAIN, {
        invariants: "step",
      });
      const state = match.read().state;
      expect(GameStateSchema.safeParse(state).success).toBe(true);
      expect(Object.keys(state.islands)).toHaveLength(2 * n);
      expect(Object.keys(state.cities)).toHaveLength(n);
      expect(state.queue.map((e) => [e.kind, e.at, e.cls])).toEqual([
        ["hill_open", 172800, 4],
        ["match_end", 604800, 5],
      ]);
      expect(state.ledger["p1"]?.made).toEqual({ spearman: 8 });
      match.checkInvariants("checkpoint");
    }
  });

  test("the same setup gives the same initial hash; another seed another seating", () => {
    const a = createMatch(setup(7, 5), sandbox1_1_0_0, TEST_DOMAIN);
    const b = createMatch(setup(7, 5), sandbox1_1_0_0, TEST_DOMAIN);
    const c = createMatch(setup(7, 6), sandbox1_1_0_0, TEST_DOMAIN);
    expect(a.hash()).toBe(b.hash());
    expect(c.hash()).not.toBe(a.hash());
  });
});
