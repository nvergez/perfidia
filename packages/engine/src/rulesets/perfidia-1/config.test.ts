import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "@perfidia/engine/core";
import type { CompiledRules, ConfigIssue, DeepReadonly } from "@perfidia/protocol";
import fc from "fast-check";
import { checkConfig } from "./check.ts";
import { compileRules } from "./compile.ts";
import {
  PERFIDIA_1_DEFAULTS,
  PERFIDIA_1_REF,
  type PerfidiaConfig,
  PerfidiaConfigSchema,
  playerRange,
} from "./config.ts";

// The config schema of perfidia-1 §16 and property P14, through a local resolution that follows
// docs/architecture.md §3.6 (the kernel's `resolveConfig` is written in parallel): deep-clone the
// defaults, set every dotted path (unknown paths rejected), validate the whole config, then compile
// for every N and run the generic checks (mirrored here) and the ruleset's `check`.

type Resolved =
  | { ok: true; config: PerfidiaConfig; hash: string }
  | { ok: false; errors: ConfigIssue[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): ConfigIssue | null {
  const segments = path.split(".");
  let node: Record<string, unknown> = target;
  for (const [i, seg] of segments.entries()) {
    if (!Object.hasOwn(node, seg)) {
      return { path, message: `unknown key "${seg}"; valid: ${Object.keys(node).join(", ")}` };
    }
    if (i === segments.length - 1) {
      node[seg] = value;
      return null;
    }
    const next = node[seg];
    if (!isRecord(next)) return { path, message: `"${seg}" has no sub-keys` };
    node = next;
  }
  return null;
}

/** The generic checks of docs/architecture.md §3.6 (owned by the kernel), mirrored for this test. */
function genericChecks(rules: DeepReadonly<CompiledRules>): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const g = rules.gateway;
  const fail = (path: string, message: string) => issues.push({ path, message });
  for (const b of rules.buildings) {
    if (b.cost.length !== b.maxLevel + 1 || b.time.length !== b.maxLevel + 1) {
      fail(`buildings.${b.id}`, "tables do not cover maxLevel");
    }
    for (const row of b.time) {
      if (row.length < b.maxLevel + 1 || row.some((t) => t < 1))
        fail(`buildings.${b.id}.time`, "< 1");
    }
  }
  for (const u of rules.units) if (u.time.some((t) => t < 1)) fail(`units.${u.id}.time`, "< 1");
  const cap = rules.levels.storage[rules.newCity.buildings["warehouse"] ?? 0] ?? 0;
  for (const r of ["wood", "stone", "gold"] as const) {
    if (rules.newCity.stock[r] > cap) fail(`start.newCity.stock.${r}`, "above cap");
  }
  if (rules.time.matchEnd < 1) fail("time.matchEnd", "< 1");
  if (g.urgentMinGap >= rules.time.minTravel) fail("gateway.urgentMinGap", "≥ minTravel");
  if (g.selfWake.min < 1) fail("gateway.selfWake.min", "< 1");
  if (g.selfWake.min > g.selfWake.max) fail("gateway.selfWake.min", "> max");
  if (g.safetyWake < g.selfWake.min) fail("gateway.safetyWake", "< selfWake.min");
  if (g.roundTripsPerWake < 1) fail("gateway.roundTripsPerWake", "< 1");
  if (g.toolCallsPerRoundTrip < 1) fail("gateway.toolCallsPerRoundTrip", "< 1");
  if (g.toolCallsPerWake !== null && g.toolCallsPerWake < 1)
    fail("gateway.toolCallsPerWake", "< 1");
  if (g.ownWakesPerDay < 1) fail("gateway.ownWakesPerDay", "< 1");
  if (g.socialWakesPerDay < 1) fail("gateway.socialWakesPerDay", "< 1");
  return issues;
}

function configHash(config: unknown): string {
  return sha256Hex(canonicalJson({ ruleset: PERFIDIA_1_REF, config }));
}

function resolve(overrides: Readonly<Record<string, unknown>>): Resolved {
  const draft: unknown = JSON.parse(canonicalJson(PERFIDIA_1_DEFAULTS));
  if (!isRecord(draft)) throw new Error("the defaults are an object");
  const errors: ConfigIssue[] = [];
  for (const [path, value] of Object.entries(overrides)) {
    const issue = setPath(draft, path, value);
    if (issue !== null) errors.push(issue);
  }
  if (errors.length > 0) return { ok: false, errors };
  const parsed = PerfidiaConfigSchema.safeParse(draft);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  const config = parsed.data;
  const range = playerRange(config);
  for (let n = range.min; n <= range.max; n += 1) {
    const rules = compileRules(config, n);
    errors.push(...genericChecks(rules), ...checkConfig(config, rules));
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config, hash: configHash(config) };
}

function errorsOf(overrides: Readonly<Record<string, unknown>>): ConfigIssue[] {
  const r = resolve(overrides);
  if (r.ok) throw new Error(`expected ${JSON.stringify(overrides)} to be rejected`);
  return r.errors;
}

function paths(overrides: Readonly<Record<string, unknown>>): string[] {
  return errorsOf(overrides).map((e) => e.path);
}

function resolved(overrides: Readonly<Record<string, unknown>>): PerfidiaConfig {
  const r = resolve(overrides);
  if (!r.ok) throw new Error(`expected a valid config, got ${JSON.stringify(r.errors)}`);
  return r.config;
}

describe("defaults", () => {
  test("parse with the schema, unchanged", () => {
    const parsed = PerfidiaConfigSchema.parse(PERFIDIA_1_DEFAULTS);
    expect(canonicalJson(parsed)).toBe(canonicalJson(PERFIDIA_1_DEFAULTS));
  });

  test("resolve with every compile check for N = 6..12", () => {
    expect(resolve({}).ok).toBe(true);
    expect(playerRange(PERFIDIA_1_DEFAULTS)).toEqual({ min: 6, max: 12 });
  });

  test("are deep-frozen", () => {
    expect(Object.isFrozen(PERFIDIA_1_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(PERFIDIA_1_DEFAULTS.units.guard.cost)).toBe(true);
    expect(Object.isFrozen(PERFIDIA_1_DEFAULTS.map.homeRadius)).toBe(true);
  });

  test("hold the numbers of §16", () => {
    const d = PERFIDIA_1_DEFAULTS;
    expect(d.time).toEqual({
      day: 86400,
      matchEnd: 604800,
      protectionEnd: 43200,
      capitalImmunityEnd: 172800,
      minTravel: 3600,
      sameIslandTravel: 3600,
      recallWindow: 600,
      siegeDuration: 21600,
      dominationStart: 259200,
      dominationHold: 86400,
      proposalTtl: 43200,
      pactDuration: 172800,
      killCreditCooldown: 86400,
    });
    expect(d.map.homeRadius).toEqual({
      6: 180,
      7: 207,
      8: 235,
      9: 263,
      10: 291,
      11: 319,
      12: 348,
    });
    expect(d.units.settler).toMatchObject({
      pop: 10,
      time: 5400,
      requires: { barracks: 2, hall: 3 },
    });
    expect(d.gateway.toolCallsPerWake).toBeNull();
    expect(d.start.crown.units).toEqual({ guard: 400, warship: 10 });
  });
});

describe("validation rules of §16 (precise paths)", () => {
  test("every number is an integer", () => {
    expect(paths({ "time.matchEnd": 86400.5 })).toEqual(["time.matchEnd"]);
    expect(paths({ "units.raider.carry": 0.5 })).toEqual(["units.raider.carry"]);
    expect(paths({ "economy.production.a": "5" })).toEqual(["economy.production.a"]);
  });

  test("numbers are non-negative, except the radius offsets", () => {
    expect(paths({ "units.guard.attack": -1 })).toEqual(["units.guard.attack"]);
    expect(paths({ "map.radius.hub": -1 })).toEqual(["map.radius.hub"]);
    expect(paths({ "spy.minGold": -100 })).toEqual(["spy.minGold"]);
    expect(resolved({ "map.radius.frontierOffset": -5 }).map.radius.frontierOffset).toBe(-5);
    expect(resolved({ "map.radius.backyardOffset": -20 }).map.radius.backyardOffset).toBe(-20);
  });

  test("every requires refers to an existing building", () => {
    expect(paths({ "buildings.wall.requires": { tower: 1 } })).toEqual([
      "buildings.wall.requires.tower",
    ]);
    expect(paths({ "units.guard.requires": { barracks: 1, tower: 2 } })).toEqual([
      "units.guard.requires.tower",
    ]);
    expect(paths({ "buildings.wall.requires.barracks": 0 })).toEqual([
      "buildings.wall.requires.barracks",
    ]);
  });

  test("exactly one unit has capacity > 0, and it is naval", () => {
    expect(paths({ "units.warship.capacity": 10 })).toEqual(["units.warship.capacity"]);
    expect(paths({ "units.transport.capacity": 0 })).toEqual(["units"]);
    expect(paths({ "units.transport.domain": "land" })).toEqual(["units.transport.domain"]);
    const moved = resolved({ "units.transport.capacity": 0, "units.warship.capacity": 5 });
    expect(moved.units.warship.capacity).toBe(5);
  });

  test("a naval unit needs a sea pace", () => {
    const { seaPace: _, ...warship } = PERFIDIA_1_DEFAULTS.units.warship;
    expect(paths({ "units.warship": warship })).toEqual(["units.warship.seaPace"]);
  });

  test("homeRadius covers players.min..max and nothing else", () => {
    const missing = errorsOf({
      "map.homeRadius": { 6: 180, 7: 207, 8: 235, 10: 291, 11: 319, 12: 348 },
    });
    expect(missing.map((e) => e.path)).toEqual(["map.homeRadius.9"]);
    expect(missing[0]?.message).toContain("N = 9 is missing");
    const extra = { ...PERFIDIA_1_DEFAULTS.map.homeRadius, 13: 380 };
    expect(paths({ "map.homeRadius": extra })).toEqual(["map.homeRadius.13"]);
    expect(paths({ "map.homeRadius": { ...PERFIDIA_1_DEFAULTS.map.homeRadius, x: 1 } })).toContain(
      "map.homeRadius.x",
    );
  });

  test("home and crown islands have at least one slot", () => {
    expect(paths({ "map.kinds.home.slots": 0 })).toEqual(["map.kinds.home.slots"]);
    expect(paths({ "map.kinds.crown.slots": 0 })).toEqual(["map.kinds.crown.slots"]);
    expect(resolved({ "map.kinds.inner.slots": 0 }).map.kinds.inner.slots).toBe(0);
  });

  test("derived build and recruit times are ≥ 1 by construction", () => {
    const config = resolved({ "buildings.hall.time": 0, "units.guard.time": 0 });
    const rules = compileRules(config, 8);
    const hall = rules.buildings.find((b) => b.id === "hall");
    expect(hall?.time.flat().every((t) => t === 1)).toBe(true);
    expect(rules.units.find((u) => u.id === "guard")?.time.every((t) => t === 1)).toBe(true);
  });

  test("every start stock fits the cap of its start warehouse level", () => {
    expect(paths({ "start.capital.stock.wood": 1001 })).toEqual(["start.capital.stock.wood"]);
    expect(paths({ "start.newCity.stock.gold": 1001 })).toEqual(["start.newCity.stock.gold"]);
    expect(paths({ "start.crown.stock.stone": 3561 })).toEqual(["start.crown.stock.stone"]);
    expect(resolved({ "start.capital.stock.wood": 1000 }).start.capital.stock.wood).toBe(1000);
  });

  test("start levels fit economy.maxLevel", () => {
    expect(paths({ "economy.maxLevel": 4 })).toEqual(
      ["hall", "lumber", "quarry", "mine", "warehouse", "barracks", "harbor", "wall"].map(
        (b) => `start.crown.buildings.${b}`,
      ),
    );
  });

  test("start units are units of the ruleset", () => {
    expect(paths({ "start.capital.units": { guard: 10, archer: 5 } })).toEqual([
      "start.capital.units.archer",
    ]);
  });

  test("the world timer dominationStart is ≥ 1", () => {
    expect(paths({ "time.dominationStart": 0 })).toEqual(["time.dominationStart"]);
  });

  test("scheduled durations are ≥ 1 s", () => {
    for (const path of [
      "time.matchEnd",
      "time.minTravel",
      "time.siegeDuration",
      "time.dominationHold",
      "time.proposalTtl",
      "time.pactDuration",
    ]) {
      expect(paths({ [path]: 0 })).toContain(path);
    }
    expect(resolved({ "time.recallWindow": 0 }).time.recallWindow).toBe(0);
  });

  test("siegeDuration > recallWindow (check)", () => {
    const everyN = Array.from({ length: 7 }, () => "time.siegeDuration");
    expect(paths({ "time.recallWindow": 21600 })).toEqual(everyN);
    expect(paths({ "time.siegeDuration": 600 })).toEqual(everyN);
    expect(resolved({ "time.siegeDuration": 601 }).time.siegeDuration).toBe(601);
  });

  test("sameIslandTravel ≥ minTravel (check)", () => {
    const issues = errorsOf({ "time.sameIslandTravel": 1800 });
    expect(new Set(issues.map((e) => e.path))).toEqual(new Set(["time.sameIslandTravel"]));
    expect(issues[0]?.message).toContain(
      "time.sameIslandTravel (1800) must be ≥ time.minTravel (3600)",
    );
    expect(new Set(paths({ "time.minTravel": 7200 }))).toEqual(new Set(["time.sameIslandTravel"]));
    const both = resolved({ "time.minTravel": 7200, "time.sameIslandTravel": 7200 });
    expect(both.time.minTravel).toBe(7200);
    expect(both.gateway.urgentMinGap).toBeLessThan(7200);
  });

  test("urgentMinGap < minTravel and the gateway minimums (kernel checks, mirrored)", () => {
    expect(paths({ "gateway.urgentMinGap": 3600 })).toContain("gateway.urgentMinGap");
    expect(paths({ "gateway.selfWake.min": 0 })).toContain("gateway.selfWake.min");
    expect(paths({ "gateway.selfWake.min": 50000 })).toContain("gateway.selfWake.min");
    expect(paths({ "gateway.safetyWake": 500 })).toContain("gateway.safetyWake");
    expect(paths({ "gateway.roundTripsPerWake": 0 })).toContain("gateway.roundTripsPerWake");
    expect(paths({ "gateway.toolCallsPerRoundTrip": 0 })).toContain(
      "gateway.toolCallsPerRoundTrip",
    );
    expect(paths({ "gateway.toolCallsPerWake": 0 })).toContain("gateway.toolCallsPerWake");
    expect(paths({ "gateway.ownWakesPerDay": 0 })).toContain("gateway.ownWakesPerDay");
    expect(paths({ "gateway.socialWakesPerDay": 0 })).toContain("gateway.socialWakesPerDay");
    expect(resolved({ "gateway.toolCallsPerWake": 40 }).gateway.toolCallsPerWake).toBe(40);
  });

  test("divisors and per-mille bounds the formulas need", () => {
    expect(paths({ "economy.levelWeightDiv": 0 })).toEqual(["economy.levelWeightDiv"]);
    expect(paths({ "economy.buildTimeOffset": 0 })).toEqual(["economy.buildTimeOffset"]);
    expect(paths({ "diplomacy.allianceSize.divisor": 0 })).toEqual([
      "diplomacy.allianceSize.divisor",
    ]);
    expect(paths({ "scoring.killPopPerPoint": 0 })).toEqual(["scoring.killPopPerPoint"]);
    expect(paths({ "combat.moraleFloorPm": 1001 })).toEqual(["combat.moraleFloorPm"]);
    expect(paths({ "settler.scaleCap": 0 })).toEqual(["settler.scaleCap"]);
  });

  test("upper bounds keep the tables small and the integer maths exact", () => {
    expect(paths({ "economy.maxLevel": 101 })).toEqual(["economy.maxLevel"]);
    expect(paths({ "settler.scaleCap": 101 })).toEqual(["settler.scaleCap"]);
    expect(paths({ "map.homeRadius.8": 5001 })).toEqual(["map.homeRadius.8"]);
    expect(paths({ "map.radius.innerOffset": -5001 })).toEqual(["map.radius.innerOffset"]);
    expect(paths({ "map.radialJitter": 1001 })).toEqual(["map.radialJitter"]);
    expect(paths({ "units.warship.seaPace": 3601 })).toEqual(["units.warship.seaPace"]);
    expect(paths({ "movement.spyPace": 3601 })).toEqual(["movement.spyPace"]);
    expect(paths({ "economy.levelWeight.a": 1e15 })).toContain("economy.levelWeight");
    expect(paths({ "buildings.hall.time": 1e14 })).toEqual(["buildings.hall.time"]);
    expect(paths({ "units.settler.cost.gold": 1e15 })).toContain("units.settler.cost.gold");
    expect(paths({ "start.newCity.stock.wood": 1e13 })).toContain("start.newCity.stock.wood");
    const big = resolved({
      "economy.maxLevel": 100,
      "settler.scaleCap": 100,
      "map.homeRadius.12": 5000,
      "map.radius.backyardOffset": 5000,
      "map.radialJitter": 1000,
      "units.transport.seaPace": 3600,
    });
    expect(compileRules(big, 12).levels.storage).toHaveLength(101);
  });

  test("unknown keys are rejected", () => {
    expect(PerfidiaConfigSchema.safeParse({ ...PERFIDIA_1_DEFAULTS, id: "x" }).success).toBe(false);
    expect(paths({ "time.weekLength": 7 })).toEqual(["time.weekLength"]);
  });
});

describe("fixed fields", () => {
  test("cannot be overridden, and the error names the field and the ref", () => {
    for (const [path, value] of [
      ["players.min", 4],
      ["players.max", 15],
      ["time.day", 3600],
      ["economy.resourceScale", 60],
    ] as const) {
      const errors = errorsOf({ [path]: value });
      expect(errors.map((e) => e.path)).toEqual([path]);
      expect(errors[0]?.message).toContain(`${path} is fixed by perfidia-1@1.0.0`);
    }
  });

  test("accept their own value", () => {
    expect(resolve({ "players.min": 6, "time.day": 86400, "economy.resourceScale": 3600 }).ok).toBe(
      true,
    );
  });
});

describe("short and domination-free matches", () => {
  test("time.matchEnd=86400 parses", () => {
    expect(resolved({ "time.matchEnd": 86400 }).time.matchEnd).toBe(86400);
  });

  test("time.dominationStart=604801 parses", () => {
    expect(resolved({ "time.dominationStart": 604801 }).time.dominationStart).toBe(604801);
  });
});

// P14: any valid override set resolves, and the hash changes iff the effective config changes;
// invalid overrides are rejected with a path; a fixed field cannot be overridden.

const d = PERFIDIA_1_DEFAULTS;
const valid: Record<string, fc.Arbitrary<unknown>> = {
  "time.matchEnd": fc.integer({ min: 1, max: 604800 }),
  "time.protectionEnd": fc.integer({ min: 0, max: 86400 }),
  "time.capitalImmunityEnd": fc.integer({ min: 0, max: 604800 }),
  "time.recallWindow": fc.integer({ min: 0, max: 600 }),
  "time.siegeDuration": fc.integer({ min: 601, max: 43200 }),
  "time.dominationStart": fc.integer({ min: 1, max: 700000 }),
  "time.dominationHold": fc.integer({ min: 1, max: 172800 }),
  "map.homeRadius.8": fc.integer({ min: 100, max: 400 }),
  "map.radialJitter": fc.integer({ min: 0, max: 20 }),
  "map.radius.innerOffset": fc.integer({ min: -120, max: 0 }),
  "map.kinds.frontier.richnessPm": fc.integer({ min: 0, max: 3000 }),
  "economy.production.a": fc.integer({ min: 0, max: 10 }),
  "economy.levelWeightDiv": fc.integer({ min: 1, max: 20 }),
  "buildings.hall.time": fc.integer({ min: 0, max: 5000 }),
  "units.raider.attack": fc.integer({ min: 0, max: 50 }),
  "settler.scaleCap": fc.integer({ min: 1, max: 15 }),
  "combat.moraleFloorPm": fc.integer({ min: 0, max: 1000 }),
  "gateway.ownWakesPerDay": fc.integer({ min: 1, max: 30 }),
  "gateway.urgentMinGap": fc.integer({ min: 0, max: 3599 }),
  "gateway.toolCallsPerWake": fc.option(fc.integer({ min: 1, max: 100 })),
  "scoring.crownBonus": fc.integer({ min: 0, max: 500 }),
  "victory.dominationPm": fc.integer({ min: 0, max: 1000 }),
};

function defaultAt(path: string): unknown {
  let node: unknown = d;
  for (const seg of path.split(".")) node = isRecord(node) ? node[seg] : undefined;
  return node;
}

/** A value for the path: often its default, so that equal overrides are exercised. */
function valueFor(path: string, arb: fc.Arbitrary<unknown>): fc.Arbitrary<unknown> {
  return fc.oneof(fc.constant(defaultAt(path)), arb);
}

const validOverrides = fc
  .subarray(Object.keys(valid))
  .chain((keys) => fc.record(Object.fromEntries(keys.map((k) => [k, valueFor(k, valid[k]!)]))));

/** The radius offsets are the only signed numbers of the config. */
const signed = (path: string): boolean =>
  path.startsWith("map.radius.") && path !== "map.radius.hub";

describe("P14", () => {
  const defaultHash = configHash(d);

  test("any valid override set resolves; the hash changes iff the effective config changes", () => {
    fc.assert(
      fc.property(validOverrides, (overrides) => {
        const r = resolve(overrides);
        if (!r.ok) throw new Error(JSON.stringify(r.errors));
        for (const [path, value] of Object.entries(overrides)) {
          let node: unknown = r.config;
          for (const seg of path.split(".")) node = isRecord(node) ? node[seg] : undefined;
          expect(node).toEqual(value);
        }
        const same = canonicalJson(r.config) === canonicalJson(d);
        expect(r.hash === defaultHash).toBe(same);
      }),
      { numRuns: 150 },
    );
  });

  test("an override equal to the default leaves the hash unchanged", () => {
    const r = resolve({ "time.siegeDuration": 21600, "map.homeRadius.8": 235 });
    expect(r.ok && r.hash).toBe(defaultHash);
  });

  const notInteger = fc.oneof(
    fc.double({ noInteger: true, noNaN: true }),
    fc.string(),
    fc.boolean(),
    fc.constant(null),
    fc.constant([]),
  );
  const invalidValues = fc.oneof(fc.integer({ max: -1 }), notInteger);

  test("invalid values are rejected at their path", () => {
    const overridable = Object.keys(valid).filter((p) => p !== "gateway.toolCallsPerWake");
    fc.assert(
      fc.property(fc.constantFrom(...overridable), invalidValues, (path, value) => {
        fc.pre(!signed(path) || typeof value !== "number" || !Number.isSafeInteger(value));
        const r = resolve({ [path]: value });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.map((e) => e.path)).toContain(path);
      }),
      { numRuns: 300 },
    );
  });

  test("fixed fields reject every other value", () => {
    const fixed: [string, number][] = [
      ["players.min", 6],
      ["players.max", 12],
      ["time.day", 86400],
      ["economy.resourceScale", 3600],
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...fixed),
        fc.oneof(fc.integer({ min: -1e9, max: 1e9 }), invalidValues),
        ([path, own], value) => {
          fc.pre(value !== own);
          const r = resolve({ [path]: value });
          expect(r.ok).toBe(false);
          if (!r.ok) {
            expect(r.errors.map((e) => e.path)).toEqual([path]);
            expect(r.errors[0]?.message).toContain("fixed by perfidia-1@1.0.0");
          }
        },
      ),
    );
  });

  test("compile-check failures are rejected with their path", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 601, max: 50000 }),
        fc.integer({ min: 1, max: 50000 }),
        (siege, recall) => {
          fc.pre(siege <= recall);
          const r = resolve({ "time.siegeDuration": siege, "time.recallWindow": recall });
          expect(r.ok).toBe(false);
          if (!r.ok)
            expect(new Set(r.errors.map((e) => e.path))).toEqual(new Set(["time.siegeDuration"]));
        },
      ),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 601, max: 20000 }),
        fc.integer({ min: 1, max: 20000 }),
        (minTravel, same) => {
          fc.pre(same < minTravel);
          const r = resolve({ "time.minTravel": minTravel, "time.sameIslandTravel": same });
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.errors.map((e) => e.path)).toContain("time.sameIslandTravel");
        },
      ),
    );
  });
});
