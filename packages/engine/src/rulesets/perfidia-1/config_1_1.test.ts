import { describe, expect, test } from "bun:test";
import { idKeyFromSeed } from "@perfidia/engine/core";
import { createMatch, resolveConfig } from "@perfidia/engine/kernel";
import { testStep } from "@perfidia/engine/testing";
import type { Json, PlayerId } from "@perfidia/protocol";
import { playerCounts } from "./check_1_1.ts";
import { PERFIDIA_1_1_DEFAULTS, Perfidia11ConfigSchema } from "./config_1_1.ts";
import { dominationNeed11, mapSlots } from "./domination_1_1.ts";
import { testDomain } from "./fixtures.test.ts";
import type { PRead11 } from "./victory_1_1.ts";
import { perfidia11Visibility as V } from "./visibility_1_1.ts";
import { perfidia1_1_1_0 } from "./v1_1_0.ts";

// The RulesConfig of perfidia-1@1.1.0 (§16): its defaults, the fixed fields naming 1.1.0, the
// renamed ids in every id check, and R5: the bounds of the domination keys and the cross-checks of
// the threshold against the map, each reported once with the N it fails for.

const P11 = perfidia1_1_1_0;

function errors(overrides: Readonly<Record<string, Json>>) {
  const r = resolveConfig(P11, overrides);
  return r.ok ? [] : r.errors;
}

describe("the defaults", () => {
  test("parse, are frozen and resolve for every N", () => {
    expect(Perfidia11ConfigSchema.safeParse(PERFIDIA_1_1_DEFAULTS).success).toBe(true);
    expect(Object.isFrozen(PERFIDIA_1_1_DEFAULTS.victory)).toBe(true);
    expect(resolveConfig(P11, {}).ok).toBe(true);
    expect(PERFIDIA_1_1_DEFAULTS.victory).toEqual({
      dominationPm: 350,
      dominationMinPerPlayer: 2,
      dominationMinConquests: 2,
    });
    expect(PERFIDIA_1_1_DEFAULTS.scoring).toEqual({
      cityBase: 100,
      perBuildingLevel: 1,
      olympusBonus: 100,
      killPopPerPoint: 10,
      killCapPm: 250,
    });
  });

  test("give the thresholds of §13.3: the map's slots and 35% of them, at least 2N", () => {
    const table = [];
    for (let n = 6; n <= 12; n += 1) {
      const slots = mapSlots(PERFIDIA_1_1_DEFAULTS, n);
      table.push([n, slots, dominationNeed11(PERFIDIA_1_1_DEFAULTS.victory, n, slots).cities]);
    }
    expect(table).toEqual([
      [6, 43, 16],
      [7, 50, 18],
      [8, 49, 18],
      [9, 55, 20],
      [10, 61, 22],
      [11, 67, 24],
      [12, 73, 26],
    ]);
  });
});

describe("fixed fields and ids", () => {
  test("a fixed field names perfidia-1@1.1.0", () => {
    expect(errors({ "players.min": 4 })).toEqual([
      {
        path: "players.min",
        message:
          "this field is fixed by perfidia-1@1.1.0 (it must be 6): players.min is fixed by perfidia-1@1.1.0 at 6: it cannot be overridden",
      },
    ]);
    expect(errors({ "time.day": 3600 })[0]?.message).toContain(
      "time.day is fixed by perfidia-1@1.1.0 at 86400: it cannot be overridden",
    );
  });

  test("the id checks list 1.1.0's ids", () => {
    expect(errors({ "buildings.wall.requires": { hall: 1 } })).toEqual([
      {
        path: "buildings.wall.requires.hall",
        message:
          'requires an unknown building "hall"; buildings are acropolis, sawmill, quarry, goldmine, warehouse, barracks, harbor, wall',
      },
    ]);
    expect(errors({ "start.capital.units": { guard: 10 } })).toEqual([
      {
        path: "start.capital.units.guard",
        message: 'unknown unit "guard"; units are hoplite, peltast, settler, transport, trireme',
      },
    ]);
    expect(errors({ "start.olympus.stock.stone": 3561 })).toEqual([
      {
        path: "start.olympus.stock.stone",
        message: "start stock 3561 exceeds the cap of warehouse 5 (3560)",
      },
    ]);
    // 1.0.0's keys are unknown paths in 1.1.0.
    expect(errors({ "units.guard.attack": 5 }).map((e) => e.path)).toEqual(["units.guard.attack"]);
    expect(errors({ "scoring.crownBonus": 5 }).map((e) => e.path)).toEqual(["scoring.crownBonus"]);
    // The conquest trophy was measured and left out of 1.1.0 (§0.1): no such key.
    expect(errors({ "scoring.conquestBonus": 30 }).map((e) => e.path)).toEqual([
      "scoring.conquestBonus",
    ]);
  });
});

describe("R5: the domination keys", () => {
  test("bounds with explanatory messages", () => {
    expect(errors({ "victory.dominationPm": 0 })).toEqual([
      {
        path: "victory.dominationPm",
        message:
          "victory.dominationPm is the share of the map's city slots a bloc must hold, in ‰: at least 1 (350 = 35%). To disable domination, set time.dominationStart after time.matchEnd (604801 with the default 7 days).",
      },
    ]);
    expect(errors({ "victory.dominationPm": 1001 })).toEqual([
      {
        path: "victory.dominationPm",
        message:
          "victory.dominationPm is a share in ‰ of the map's city slots: at most 1000 (all of them).",
      },
    ]);
    expect(errors({ "victory.dominationMinPerPlayer": 0 })).toEqual([
      {
        path: "victory.dominationMinPerPlayer",
        message:
          "victory.dominationMinPerPlayer is the floor of the threshold in cities per player: at least 1 (2 means a bloc needs at least 2N cities).",
      },
    ]);
    expect(errors({ "victory.dominationMinConquests": -1 })).toEqual([
      {
        path: "victory.dominationMinConquests",
        message:
          "victory.dominationMinConquests counts taken cities: 0 or more (0 drops the conquest requirement).",
      },
    ]);
    expect(errors({ "victory.dominationMinConquests": 0 })).toEqual([]);
    expect(errors({ "victory.dominationPm": 1000 })).toEqual([]);
  });

  test("bounds that hold whether domination is on or off: slots per island and the domination counts", () => {
    for (const off of [{}, { "time.dominationStart": 604801 }]) {
      expect(errors({ ...off, "map.kinds.frontier.slots": 100000000000000 })).toEqual([
        { path: "map.kinds.frontier.slots", message: "at most 100 city slots per island" },
      ]);
      expect(errors({ ...off, "map.kinds.olympus.slots": 101 })).toEqual([
        { path: "map.kinds.olympus.slots", message: "at most 100 city slots per island" },
      ]);
      expect(errors({ ...off, "victory.dominationMinPerPlayer": 2000000000000000 })).toEqual([
        {
          path: "victory.dominationMinPerPlayer",
          message: "victory.dominationMinPerPlayer is a number of cities per player: at most 1000.",
        },
      ]);
      expect(errors({ ...off, "victory.dominationMinConquests": 1001 })).toEqual([
        {
          path: "victory.dominationMinConquests",
          message: "victory.dominationMinConquests counts taken cities: at most 1000.",
        },
      ]);
    }
    expect(errors({ "map.kinds.olympus.slots": 0 })[0]?.message).toBe(
      "this island kind holds a start city: it needs ≥ 1 slot",
    );
  });

  test("domination off with every bound at its maximum: the match steps and its views render", () => {
    const most: Record<string, Json> = {
      "time.dominationStart": 604801,
      "victory.dominationMinPerPlayer": 1000,
      "victory.dominationMinConquests": 1000,
      "victory.dominationPm": 1000,
    };
    for (const kind of ["olympus", "home", "backyard", "frontier", "inner", "hub"]) {
      most[`map.kinds.${kind}.slots`] = 100;
    }
    expect(errors(most)).toEqual([]);
    const seats = Array.from({ length: 12 }, (_, i): { id: PlayerId } => ({ id: `p${i + 1}` }));
    const setup = { ruleset: P11.ref, overrides: most, seed: 5, idKey: idKeyFromSeed(5), seats };
    const match = createMatch(setup, P11, testDomain, { invariants: "off" });
    expect(() => testStep(match, () => undefined)).not.toThrow();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a 1.1.0 match reads with 1.1.0's types
    const read = (): PRead11 => match.read() as unknown as PRead11;
    // 100 Olympus slots, then 12 sectors of five kinds (hubs only up to 7 players): 100 + 12 × 400.
    expect(V.publicMatch(read())["domination"]).toMatchObject({ need: 12000, slots: 4900 });
    expect(V.briefing?.(read(), "p1")).toMatchObject({ bloc: { need: 12000, needTaken: 1000 } });
  });

  test("a threshold above the map's slots is reported once, with the N it fails for", () => {
    expect(errors({ "victory.dominationMinPerPlayer": 8 })).toEqual([
      {
        path: "victory.dominationMinPerPlayer",
        message:
          "N = 6..12: the domination threshold (48 cities at N = 6: victory.dominationMinPerPlayer 8 × 6 players) is more than the map's city slots (43 at N = 6): no bloc could ever dominate. Lower victory.dominationMinPerPlayer, raise map.kinds.*.slots, or set time.dominationStart after time.matchEnd to disable domination.",
      },
    ]);
    // 7 × N: 42 ≤ 43 at N = 6 and 49 ≤ 50 at N = 7, but 56 > 49 at N = 8, …
    expect(errors({ "victory.dominationMinPerPlayer": 7 })[0]?.message).toStartWith(
      "N = 8..12: the domination threshold (56 cities at N = 8",
    );
  });

  test("more taken cities than the threshold is reported once, with the bound to use", () => {
    expect(errors({ "victory.dominationMinConquests": 17 })).toEqual([
      {
        path: "victory.dominationMinConquests",
        message:
          "N = 6: victory.dominationMinConquests (17) is above the domination threshold (16 cities at N = 6): lower it to 16 or less.",
      },
    ]);
    expect(errors({ "victory.dominationMinConquests": 21 })[0]?.message).toStartWith(
      "N = 6..9: victory.dominationMinConquests (21)",
    );
  });

  test("no cross-check while domination is off (dominationStart after matchEnd)", () => {
    const off = { "time.dominationStart": 604801 };
    expect(errors({ ...off, "victory.dominationMinPerPlayer": 8 })).toEqual([]);
    expect(errors({ ...off, "victory.dominationMinConquests": 50 })).toEqual([]);
  });

  test("short matches keep domination legal even when no countdown can end in time", () => {
    // --days 1: dominationStart 259200 > matchEnd 86400, domination is off.
    expect(errors({ "time.matchEnd": 86400 })).toEqual([]);
    // --days 3: dominationStart 259200 = matchEnd, the hold cannot end in time; still legal.
    expect(errors({ "time.matchEnd": 259200 })).toEqual([]);
  });

  test("playerCounts names runs of N", () => {
    expect(playerCounts([6])).toBe("6");
    expect(playerCounts([6, 7, 8, 9, 10, 11, 12])).toBe("6..12");
    expect(playerCounts([6, 8, 9, 10, 12])).toBe("6, 8..10, 12");
    expect(playerCounts([])).toBe("");
  });
});
