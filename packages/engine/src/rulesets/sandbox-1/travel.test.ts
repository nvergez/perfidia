import { describe, expect, test } from "bun:test";
import { idKeyFromSeed } from "@perfidia/engine/core";
import { createMatch } from "@perfidia/engine/kernel";
import { sortedIds } from "@perfidia/engine/std";
import { PlayerIdSchema, type IslandId, type TravelGroup } from "@perfidia/protocol";
import fc from "fast-check";
import { SANDBOX_1_DEFAULTS, SANDBOX_1_REF } from "./config.ts";
import { sandbox1_1_0_0 } from "./descriptor.ts";
import { layoutIslands, ringDistance, ringWidth } from "./map.ts";
import { TEST_DOMAIN } from "./testkit.test.ts";
import { travelBetween } from "./travel.ts";

// Travel = minTravel + 60 · d for every movement kind, with minTravel = 4800 (not perfidia-1's
// 3600), and 4800 on one island (docs/architecture.md §3.8).

const GROUPS: TravelGroup[] = [
  { kind: "attack", units: { axeman: 10, boat: 2 } },
  { kind: "support", units: { spearman: 3 } },
  { kind: "found", units: { colonist: 1 } },
  { kind: "spy", units: {} },
  { kind: "shipment", units: {} },
  { kind: "return", units: { boat: 1 } },
];

function match(players: number, overrides: Record<string, number> = {}) {
  return createMatch(
    {
      ruleset: SANDBOX_1_REF,
      overrides,
      seed: 11,
      idKey: idKeyFromSeed(11),
      seats: Array.from({ length: players }, (_, i) => ({ id: PlayerIdSchema.parse(`p${i + 1}`) })),
    },
    sandbox1_1_0_0,
    TEST_DOMAIN,
  );
}

describe("travel time", () => {
  test("examples: 4800 + 60·d, 4800 on one island", () => {
    const islands = layoutIslands(SANDBOX_1_DEFAULTS, 7);
    const i = (k: number) => islands[k - 1] ?? { x: 0, y: 0 };
    expect(travelBetween(SANDBOX_1_DEFAULTS, 7, i(1), i(1))).toBe(4800);
    expect(travelBetween(SANDBOX_1_DEFAULTS, 7, i(1), i(2))).toBe(4800 + 60 * 35);
    expect(travelBetween(SANDBOX_1_DEFAULTS, 7, i(1), i(13))).toBe(4800 + 60 * 40);
    expect(travelBetween(SANDBOX_1_DEFAULTS, 7, i(1), i(8))).toBe(4800 + 60 * 155);
  });

  test("the hook gives minTravel + perTile · d for every pair and every group, N = 2..12", () => {
    for (let n = 2; n <= 12; n += 1) {
      const m = match(n);
      const r = m.read();
      const ids = sortedIds(r.state.islands);
      const w = ringWidth(SANDBOX_1_DEFAULTS, n);
      for (const a of ids) {
        for (const b of ids) {
          const ia = r.state.islands[a];
          const ib = r.state.islands[b];
          if (ia === undefined || ib === undefined) throw new Error("missing island");
          const expected = 4800 + 60 * ringDistance(ia, ib, w);
          for (const g of GROUPS) {
            expect(r.ruleset.hooks.travelTime(r, a, b, g)).toBe(expected);
          }
          if (a === b) expect(expected).toBe(4800);
          else expect(expected).toBeGreaterThan(4800);
        }
      }
    }
  });

  test("follows time.minTravel and travel.perTile, and is symmetric", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 12 }),
        fc.integer({ min: 301, max: 20000 }),
        fc.integer({ min: 0, max: 600 }),
        (n, minTravel, perTile) => {
          const m = match(n, { "time.minTravel": minTravel, "travel.perTile": perTile });
          const r = m.read();
          const a: IslandId = "i1";
          const b: IslandId = `i${2 * n}`;
          const ia = r.state.islands[a];
          const ib = r.state.islands[b];
          if (ia === undefined || ib === undefined) throw new Error("missing island");
          const d = ringDistance(ia, ib, ringWidth(SANDBOX_1_DEFAULTS, n));
          const g: TravelGroup = { kind: "attack", units: {} };
          expect(r.ruleset.hooks.travelTime(r, a, b, g)).toBe(minTravel + perTile * d);
          expect(r.ruleset.hooks.travelTime(r, b, a, g)).toBe(minTravel + perTile * d);
          expect(r.ruleset.hooks.travelTime(r, a, a, g)).toBe(minTravel);
        },
      ),
      { numRuns: 25 },
    );
  });
});
