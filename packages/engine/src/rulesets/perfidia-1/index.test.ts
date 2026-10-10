import { describe, expect, test } from "bun:test";
import type { AnyRuleset, ReadCtx, Ruleset, WorldCtx } from "@perfidia/engine/contracts";
import { canonicalJson, fnv1a64, sha256Hex, streamRng } from "@perfidia/engine/core";
import * as perfidia from "@perfidia/engine/rulesets/perfidia-1";
import {
  type CompiledRules,
  CompiledRulesSchema,
  type GameState,
  GameStateSchema,
  type PlayerId,
} from "@perfidia/protocol";
import { checkConfig } from "./check.ts";
import { renderCheatSheet } from "./cheatsheet.ts";
import { compileRules } from "./compile.ts";
import {
  PERFIDIA_1_DEFAULTS,
  PERFIDIA_1_ID,
  PERFIDIA_1_REF,
  PERFIDIA_1_VERSION,
  type PerfidiaConfig,
  PerfidiaConfigSchema,
  playerRange,
} from "./config.ts";
import { blocsOf, dominationThreshold, totalCities } from "./domination.ts";
import { PERFIDIA_1_ERROR_SAMPLES, PERFIDIA_1_ERRORS } from "./errors.ts";
import { type PerfidiaExt, PerfidiaExtSchema } from "./ext.ts";
import { createWorld } from "./map.ts";
import { computeStandings } from "./scoring.ts";
import { travelTime } from "./travel.ts";

// The wave-3 modules together: they fit the `Ruleset` contract (the descriptor itself and the
// mechanics hooks are T11's), and a created world forms a valid `GameState` on which the
// `travelTime` hook honours the speed rule for every travel probe (docs/architecture.md §3.6).

const unimplemented = (): never => {
  throw new Error("a wave-4 hook (T11)");
};

/** A test-only descriptor assembled from the wave-3 modules. */
const ruleset: Ruleset<PerfidiaConfig, PerfidiaExt> = {
  id: PERFIDIA_1_ID,
  version: PERFIDIA_1_VERSION,
  ref: PERFIDIA_1_REF,
  status: "published",
  title: "perfidia-1 (wave-3 test descriptor)",
  configSchema: PerfidiaConfigSchema,
  defaults: PERFIDIA_1_DEFAULTS,
  extSchema: PerfidiaExtSchema,
  players: playerRange,
  compile: compileRules,
  check: checkConfig,
  cheatSheet: renderCheatSheet,
  hooks: {
    createWorld,
    travelTime,
    arrive: { attack: unimplemented, spy: unimplemented },
    standings: (r) => computeStandings(r.config, r.state, r.ext()),
    finish: unimplemented,
  },
  errors: PERFIDIA_1_ERRORS,
  errorSamples: PERFIDIA_1_ERROR_SAMPLES,
  eventSchemas: {},
};

const asAny: AnyRuleset = ruleset;

function worldCtx(seed: number, n: number, config: PerfidiaConfig): WorldCtx<PerfidiaConfig> {
  return {
    seed,
    players: Array.from({ length: n }, (_, i): PlayerId => `p${i + 1}`),
    config,
    rules: compileRules(config, n),
    rng: (stream) => streamRng(seed, stream),
  };
}

const made = (units: Record<string, number>) => ({ made: units, gone: {} });

/** The state the kernel would build from the world (§5.3 creation), checked by the schema. */
function stateOf(seed: number, n: number, config: PerfidiaConfig): GameState {
  const w = createWorld(worldCtx(seed, n, config));
  const players = Array.from({ length: n }, (_, i): PlayerId => `p${i + 1}`);
  return GameStateSchema.parse({
    v: 1,
    ruleset: PERFIDIA_1_REF,
    configHash: sha256Hex(canonicalJson({ ruleset: PERFIDIA_1_REF, config })),
    seed,
    now: 0,
    status: "running",
    seq: 0,
    ids: {
      c: w.cities.length,
      a: 0,
      own: Object.fromEntries(players.map((p) => [p, { m: 0, r: 0, q: 0, g: 0 }])),
    },
    evHash: fnv1a64(""),
    queue: [],
    players: Object.fromEntries(
      players.map((p) => [p, { id: p, alive: true, eliminatedAt: null, alliance: null }]),
    ),
    islands: Object.fromEntries(w.islands.map((i) => [i.id, i])),
    cities: Object.fromEntries(w.cities.map((c) => [c.id, c])),
    movements: {},
    proposals: {},
    alliances: {},
    pacts: [],
    ledger: {
      neutral: made({ guard: 400, warship: 10 }),
      ...Object.fromEntries(players.map((p) => [p, made({ guard: 10 })])),
    },
    ext: w.ext,
    result: null,
  });
}

function readCtx(
  state: GameState,
  config: PerfidiaConfig,
  rules: CompiledRules,
): ReadCtx<PerfidiaConfig, PerfidiaExt> {
  const ext = PerfidiaExtSchema.parse(state.ext);
  return { state, now: state.now, rules, config, ruleset, ext: () => ext };
}

describe("the wave-3 modules", () => {
  test("fit the Ruleset contract and the registry type", () => {
    expect(asAny.ref).toBe("perfidia-1@1.0.0");
    expect(ruleset.configSchema.parse(ruleset.defaults)).toEqual(PERFIDIA_1_DEFAULTS);
    expect(ruleset.players(PERFIDIA_1_DEFAULTS)).toEqual({ min: 6, max: 12 });
    for (let n = 6; n <= 12; n += 1) {
      const rules = ruleset.compile(PERFIDIA_1_DEFAULTS, n);
      expect(CompiledRulesSchema.safeParse(rules).success).toBe(true);
      expect(ruleset.check?.(PERFIDIA_1_DEFAULTS, rules)).toEqual([]);
    }
  });

  test("the barrel exports every module", () => {
    for (const name of [
      "PerfidiaConfigSchema",
      "PERFIDIA_1_DEFAULTS",
      "checkConfig",
      "compileRules",
      "renderCheatSheet",
      "SIN10K",
      "createWorld",
      "travelTime",
      "resolveBattle",
      "counterIntel",
      "computeStandings",
      "dominationThreshold",
      "PerfidiaExtSchema",
      "PERFIDIA_1_ERRORS",
      "PERFIDIA_1_ERROR_SAMPLES",
    ]) {
      expect(Object.hasOwn(perfidia, name)).toBe(true);
    }
  });
});

describe("a created world", () => {
  test("is a valid GameState with a valid ext, for every N", () => {
    for (let n = 6; n <= 12; n += 1) {
      const s = stateOf(1000 + n, n, PERFIDIA_1_DEFAULTS);
      expect(canonicalJson(PerfidiaExtSchema.parse(s.ext))).toBe(canonicalJson(s.ext));
      expect(s.ids.c).toBe(n + 1);
    }
  });

  test("travel times are ≥ minTravel for every pair of islands and every probe (creation check)", () => {
    for (const n of [6, 7, 8, 12]) {
      const config = PERFIDIA_1_DEFAULTS;
      const rules = compileRules(config, n);
      const r = readCtx(stateOf(n, n, config), config, rules);
      const ids = Object.values(r.state.islands).map((i) => i.id);
      for (const probe of rules.travelProbes) {
        for (const a of ids) {
          for (const b of ids) {
            expect(ruleset.hooks.travelTime(r, a, b, probe.group)).toBeGreaterThanOrEqual(
              rules.time.minTravel,
            );
          }
        }
      }
    }
  });

  test("time.minTravel=7200 time.sameIslandTravel=7200: travel = max(7200, …), 7200 on the same island", () => {
    const config = PerfidiaConfigSchema.parse({
      ...structuredClone(PERFIDIA_1_DEFAULTS),
      time: { ...PERFIDIA_1_DEFAULTS.time, minTravel: 7200, sameIslandTravel: 7200 },
    });
    expect(checkConfig(config, compileRules(config, 8))).toEqual([]);
    const rules = compileRules(config, 8);
    const r = readCtx(stateOf(5, 8, config), config, rules);
    const transport = { kind: "attack", units: { transport: 1 } } as const;
    // i2 is sector 0's home; i3 its backyard (80 tiles); i6 sector 1's home (~180 tiles).
    expect(travelTime(r, "i2", "i2", transport)).toBe(7200);
    expect(travelTime(r, "i2", "i3", transport)).toBe(7200);
    const far = travelTime(r, "i2", "i6", transport);
    expect(far).toBeGreaterThan(10000);
    expect(far).toBe(Math.max(7200, far));
  });

  test("standings, blocs and the threshold on the initial world", () => {
    const config = PERFIDIA_1_DEFAULTS;
    const rules = compileRules(config, 6);
    const s = stateOf(77, 6, config);
    const r = readCtx(s, config, rules);
    const standings = ruleset.hooks.standings(r);
    expect(standings.map((x) => x.score)).toEqual(Array.from({ length: 6 }, () => 105));
    expect(standings.map((x) => x.player)).toEqual([...r.ext().tiebreak]);
    expect(blocsOf(s).map((b) => b.key)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    expect(totalCities(s)).toBe(7);
    expect(dominationThreshold(config, 6, totalCities(s))).toBe(12);
  });
});
