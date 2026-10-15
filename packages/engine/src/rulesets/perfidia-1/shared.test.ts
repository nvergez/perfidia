import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { compareIds, type DeepReadonly, type PlayerId, type TravelGroup } from "@perfidia/protocol";
import { compileRulesWith } from "./compiler.ts";
import {
  BUILDING_IDS,
  ISLAND_KINDS,
  PERFIDIA_1_DEFAULTS,
  type PerfidiaConfig,
  UNIT_IDS,
} from "./config.ts";
import { initialExt } from "./ext.ts";
import { matchFromState } from "@perfidia/engine/testing";
import type { AnyRuleset, WorldCtx } from "@perfidia/engine/contracts";
import { besiege, city, extOf, testDomain, world, type World } from "./fixtures.test.ts";
import {
  BUILDING_ROLES,
  KIND_ROLES,
  NAMES_1_0_0,
  NAMES_1_1_0,
  type PerfidiaNames,
  UNIT_ROLES,
  buildingIds,
  kindIds,
  unitIds,
} from "./names.ts";
import { type PerfidiaCore } from "./schema.ts";
import { scoreRowsBy } from "./score.ts";
import { scoreRows } from "./scoring.ts";
import { siegeHooksWith } from "./siege.ts";
import { paceOf } from "./travel.ts";
import { perfidia1_1_0_0 } from "./v1_0_0.ts";
import { createWorldWith } from "./world.ts";

// The modules every perfidia-1 version shares (names, compiler, world, score, siege hooks, travel)
// against the 1.0.0 code they were factored out of: with 1.0.0's ids they behave as before.

const P1 = perfidia1_1_0_0;

function matchWith(w: World, rs: AnyRuleset) {
  return matchFromState(w.state, rs, { domain: testDomain });
}

describe("the id tables", () => {
  const ID = /^[a-z][a-z_]*$/;
  for (const names of [NAMES_1_0_0, NAMES_1_1_0]) {
    test(`${names.ref}: every role has a distinct lowercase id`, () => {
      for (const ids of [buildingIds(names), unitIds(names), kindIds(names)]) {
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(ID);
      }
      expect(names.prize).toBe(names.kinds.crown);
    });
  }

  test("1.0.0's ids are its roles, in the canonical orders of config.ts", () => {
    expect(buildingIds(NAMES_1_0_0)).toEqual([...BUILDING_IDS]);
    expect(unitIds(NAMES_1_0_0)).toEqual([...UNIT_IDS]);
    expect(kindIds(NAMES_1_0_0)).toEqual([...ISLAND_KINDS]);
    expect([...BUILDING_ROLES, ...UNIT_ROLES, ...KIND_ROLES]).toEqual([
      ...BUILDING_IDS,
      ...UNIT_IDS,
      ...ISLAND_KINDS,
    ]);
  });
});

describe("compileRulesWith and createWorldWith", () => {
  test("bound to 1.0.0's ids, they are the descriptor's compile and createWorld", () => {
    for (let n = 6; n <= 12; n += 1) {
      expect(compileRulesWith(NAMES_1_0_0)(P1.defaults, n)).toEqual(P1.compile(P1.defaults, n));
    }
    const create = createWorldWith(NAMES_1_0_0, initialExt);
    for (const seed of [1, 7, 4242]) {
      for (const n of [6, 7, 8, 12]) {
        const players = Array.from({ length: n }, (_, i): PlayerId => `p${i + 1}`);
        const ctx = (): WorldCtx<PerfidiaConfig> => {
          const streams = new Map<string, number>();
          return {
            seed,
            players,
            config: P1.defaults,
            rules: P1.compile(P1.defaults, n),
            rng: (stream) => {
              let s = (seed * 7919 + stream.length * 104729 + (streams.get(stream) ?? 0)) >>> 0;
              streams.set(stream, (streams.get(stream) ?? 0) + 1);
              return {
                nextU32: () => {
                  s = (s + 0x6d2b79f5) >>> 0;
                  let t = s;
                  t = Math.imul(t ^ (t >>> 15), t | 1);
                  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                  return (t ^ (t >>> 14)) >>> 0;
                },
              };
            },
          };
        };
        expect(create(ctx())).toEqual(P1.hooks.createWorld(ctx()));
      }
    }
  });
});

/** `paceOf` as 1.0.0 wrote it: over the canonical unit ids, ignoring every other group id. */
function paceOf100(config: DeepReadonly<PerfidiaCore>, group: DeepReadonly<TravelGroup>): number {
  if (group.kind === "spy") return config.movement.spyPace;
  if (group.kind === "shipment") return config.movement.shipment.pace;
  let pace: number | null = null;
  for (const id of UNIT_IDS) {
    const u = config.units[id];
    const n = group.units[id] ?? 0;
    if (u !== undefined && n > 0 && u.domain === "naval") {
      const p = u.seaPace ?? config.movement.homeboundPace;
      pace = pace === null ? p : Math.max(pace, p);
    }
  }
  return pace ?? config.movement.homeboundPace;
}

describe("paceOf over the config's units", () => {
  const kinds = ["attack", "support", "found", "return", "spy", "shipment"] as const;
  const ids = [...UNIT_IDS, "tower", "trireme"];

  test("equals 1.0.0's for every unit mix, group kind and sea pace, and ignores unknown ids", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...kinds),
        fc.dictionary(fc.constantFrom(...ids), fc.integer({ min: 0, max: 3 })),
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 200 }),
        (kind, units, transportPace, warshipPace) => {
          const config = {
            ...PERFIDIA_1_DEFAULTS,
            units: {
              ...PERFIDIA_1_DEFAULTS.units,
              transport: { ...PERFIDIA_1_DEFAULTS.units.transport, seaPace: transportPace },
              warship: { ...PERFIDIA_1_DEFAULTS.units.warship, seaPace: warshipPace },
            },
          };
          const group: TravelGroup = { kind, units };
          expect(paceOf(config, group)).toBe(paceOf100(config, group));
        },
      ),
      { numRuns: 400 },
    );
    const probe: TravelGroup = { kind: "attack", units: { tower: 5, guard: 3 } };
    expect(paceOf(PERFIDIA_1_DEFAULTS, probe)).toBe(PERFIDIA_1_DEFAULTS.movement.homeboundPace);
  });
});

/** 1.0.0's city points, written out: 100 + Σ building levels + 100 for the Crown. */
function points100(c: { buildings: Readonly<Record<string, number>>; tag: string | null }): number {
  return (
    100 +
    BUILDING_IDS.reduce((n, b) => n + (c.buildings[b] ?? 0), 0) +
    (c.tag === "crown" ? 100 : 0)
  );
}

describe("scoreRowsBy", () => {
  test("with 1.0.0's city points it is scoreRows, frozen scores included", () => {
    const w = world();
    city(w, { id: "c1", owner: "p1", island: "i1", buildings: { hall: 3, wall: 2 } });
    city(w, { id: "c2", owner: "p1", island: "i2", tag: "crown" });
    city(w, { id: "c3", owner: "p2", island: "i3", buildings: { mine: 4 } });
    w.ext.battlePoints["p2"] = 2000;
    w.state.players["p6"]!.alive = false;
    w.ext.frozenScores["p6"] = { cityPoints: 333, battleScore: 7 };
    expect(scoreRowsBy(w.config, w.state, w.ext, points100)).toEqual(
      scoreRows(w.config, w.state, w.ext),
    );
  });
});

/** p5's last city c14 falls to p2's siege at T + 100. */
function lastCityFalls() {
  const T = 200000;
  const w = world({ now: T });
  city(w, { id: "c1", owner: "p1", island: "i3" });
  city(w, { id: "c2", owner: "p2", island: "i1" });
  city(w, { id: "c3", owner: "p3", island: "i3" });
  city(w, { id: "c4", owner: "p4", island: "i4" });
  city(w, { id: "c6", owner: "p6", island: "i4" });
  city(w, { id: "c14", owner: "p5", island: "i2", buildings: { hall: 2 } });
  besiege(w, {
    city: "c14",
    by: "p2",
    garrison: [{ home: "c2", units: { settler: 1, raider: 3 } }],
    endsAt: T + 100,
  });
  w.ext.battlePoints["p5"] = 1000;
  return { w, T };
}

describe("siegeHooksWith", () => {
  test("1.0.0's hooks freeze the score the player had with its last city", () => {
    const { w, T } = lastCityFalls();
    const match = matchWith(w, P1);
    match.advanceTo(T + 100);
    // c14 is worth 100 + 2 = 102; the battle score is capped at floor(102 / 4) = 25.
    expect(extOf(match).frozenScores).toEqual({ p5: { cityPoints: 102, battleScore: 25 } });
  });

  test("a version's own score parts are what freezes, read before the city changes hands", () => {
    const { w, T } = lastCityFalls();
    const seen: string[] = [];
    const hooks = siegeHooksWith((r, p) => {
      seen.push(`${p}:${r.state.cities["c14"]?.owner ?? "none"}`);
      return { cityPoints: 7, battleScore: 3 };
    });
    const custom = Object.freeze({
      ...P1,
      hooks: Object.freeze({
        ...P1.hooks,
        on: Object.freeze({ ...P1.hooks.on, siege_end: hooks.onSiegeEnd }),
      }),
    });
    const match = matchWith(w, custom);
    match.advanceTo(T + 100);
    expect(extOf(match).frozenScores).toEqual({ p5: { cityPoints: 7, battleScore: 3 } });
    expect(seen).toEqual(["p5:p5"]);
  });
});

/** Names round-trip: each table maps roles to ids one to one. */
function inverse(names: PerfidiaNames): Map<string, string> {
  const out = new Map<string, string>();
  for (const [role, id] of [
    ...Object.entries(names.buildings),
    ...Object.entries(names.units),
    ...Object.entries(names.kinds),
  ]) {
    out.set(id, role);
  }
  return out;
}

test("1.1.0 renames only the ids the reskin names; the rest keep their 1.0.0 id", () => {
  const renamed = [...inverse(NAMES_1_1_0)].filter(([id, role]) => id !== role);
  expect(renamed.toSorted((a, b) => compareIds(a[0], b[0]))).toEqual([
    ["acropolis", "hall"],
    ["goldmine", "mine"],
    ["hoplite", "guard"],
    ["olympus", "crown"],
    ["peltast", "raider"],
    ["sawmill", "lumber"],
    ["trireme", "warship"],
  ]);
});
