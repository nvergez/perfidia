import { describe, expect, test } from "bun:test";
import { resolveConfig } from "@perfidia/engine/kernel";
import type { ConfigIssue, Json } from "@perfidia/protocol";
import fc from "fast-check";
import { SANDBOX_1_DEFAULTS, SandboxConfigSchema, playerRange } from "./config.ts";
import { sandbox1_1_0_0 } from "./descriptor.ts";

// The config schema and its defaults, through the kernel's `resolveConfig` (docs/architecture.md
// §3.6): every allowed N compiles and passes the generic checks; property P14 for sandbox-1.

function resolve(overrides: Record<string, Json>) {
  return resolveConfig(sandbox1_1_0_0, overrides);
}

function errorsOf(overrides: Record<string, Json>): ConfigIssue[] {
  const r = resolve(overrides);
  if (r.ok) throw new Error(`expected ${JSON.stringify(overrides)} to be rejected`);
  return r.errors;
}

/** Every number reachable from `v` is a safe integer. */
function expectIntegers(v: unknown): void {
  if (typeof v === "number") expect(Number.isSafeInteger(v)).toBe(true);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) expectIntegers(x);
}

describe("defaults", () => {
  test("parse with the schema and keep every number an integer", () => {
    expect(SandboxConfigSchema.safeParse(SANDBOX_1_DEFAULTS).success).toBe(true);
    expectIntegers(SANDBOX_1_DEFAULTS);
  });

  test("resolve with no override, for players 2..12", () => {
    const r = resolve({});
    expect(r.ok).toBe(true);
    expect(playerRange(SANDBOX_1_DEFAULTS)).toEqual({ min: 2, max: 12 });
  });

  test("are frozen", () => {
    expect(Object.isFrozen(SANDBOX_1_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(SANDBOX_1_DEFAULTS.units.spearman.cost)).toBe(true);
  });

  test("hold the numbers of §3.8", () => {
    const c = SANDBOX_1_DEFAULTS;
    expect(c.time).toEqual({
      matchEnd: 604800,
      attackFrom: 21600,
      minTravel: 4800,
      hillOpen: 172800,
      capitalImmunityEnd: 172800,
    });
    expect(c.map).toEqual({
      sectorWidth: 40,
      home: { slots: 2, richnessPm: 1000 },
      shared: { dx: 20, dy: 15, slots: 2, richnessPm: 1500 },
    });
    expect(c.travel.perTile).toBe(60);
    expect(c.start).toEqual({ level: 1, capitalStock: 500, cityStock: 200, spearmen: 8 });
    expect(c.spy).toEqual({ minGold: 50, counterBase: 50 });
    expect(c.combat).toEqual({ keepDefense: 10, lootPm: 500 });
    expect(c.victory).toEqual({ hillPm: 500, hillMinCities: 2 });
    expect(c.score).toEqual({ perCity: 50, perLevel: 2 });
  });
});

describe("rejections name their path", () => {
  test("a fixed field cannot be overridden", () => {
    for (const [path, value] of [
      ["economy.resourceScale", 1800],
      ["players.min", 3],
      ["players.max", 15],
    ] as const) {
      const errors = errorsOf({ [path]: value });
      expect(errors.some((e) => e.path === path && e.message.includes("fixed"))).toBe(true);
    }
  });

  test("an unknown path lists the sibling keys", () => {
    const [e] = errorsOf({ "time.siegeDuration": 3600 });
    expect(e?.path).toBe("time.siegeDuration");
    expect(e?.message).toContain("hillOpen");
  });

  test("floats, negatives and zero durations are rejected", () => {
    expect(errorsOf({ "travel.perTile": 1.5 })[0]?.path).toBe("travel.perTile");
    expect(errorsOf({ "start.spearmen": -1 })[0]?.path).toBe("start.spearmen");
    expect(errorsOf({ "time.minTravel": 0 })[0]?.path).toBe("time.minTravel");
    expect(errorsOf({ "time.hillOpen": 0 })[0]?.path).toBe("time.hillOpen");
    expect(errorsOf({ "units.boat.time": 0 })[0]?.path).toBe("units.boat.time");
  });

  test("cross-field rules", () => {
    expect(errorsOf({ "map.shared.dx": 40 }).map((e) => e.path)).toEqual(["map.shared.dx"]);
    expect(errorsOf({ "start.level": 9 }).map((e) => e.path)).toContain("start.level");
    expect(errorsOf({ "units.colonist.camp": 9 }).map((e) => e.path)).toEqual([
      "units.colonist.camp",
    ]);
    expect(errorsOf({ "economy.militaryKeep": 9 }).map((e) => e.path)).toEqual([
      "economy.militaryKeep",
    ]);
    const stock = errorsOf({ "start.capitalStock": 1501 });
    expect(stock.map((e) => e.path)).toEqual(["start.capitalStock"]);
    expect(stock[0]?.message).toContain("1500");
    expect(resolve({ "start.capitalStock": 1500 }).ok).toBe(true);
  });

  test("the generic compile checks reject what would fail mid-match", () => {
    expect(errorsOf({ "gateway.urgentMinGap": 4800 }).map((e) => e.path)).toContain(
      "gateway.urgentMinGap",
    );
    expect(errorsOf({ "gateway.ownWakesPerDay": 0 }).map((e) => e.path)).toContain(
      "gateway.ownWakesPerDay",
    );
    expect(errorsOf({ "start.cityStock": 1501 }).map((e) => e.path)).toContain(
      "newCity.stock.wood",
    );
  });
});

describe("P14 for sandbox-1", () => {
  /** Valid single overrides, each with a value different from the default. */
  const VALID: readonly [string, Json][] = [
    ["time.minTravel", 6000],
    ["time.matchEnd", 86400],
    ["time.hillOpen", 3600],
    ["time.attackFrom", 0],
    ["map.sectorWidth", 50],
    ["map.shared.dy", 0],
    ["travel.perTile", 30],
    ["economy.maxLevel", 10],
    ["economy.buildTime", 300],
    ["units.axeman.attack", 20],
    ["units.colonist.scaleCap", 3],
    ["start.spearmen", 0],
    ["queues.refundActivePm", 0],
    ["combat.lootPm", 1000],
    ["diplomacy.pactDuration", 86400],
    ["names.cityMaxChars", 8],
    ["victory.hillPm", 667],
    ["gateway.toolCallsPerWake", null],
  ];

  test("valid override sets resolve; the hash changes iff the effective config does", () => {
    const base = resolve({});
    if (!base.ok) throw new Error("defaults must resolve");
    fc.assert(
      fc.property(fc.subarray([...VALID]), fc.boolean(), (picked, withDefault) => {
        const overrides: Record<string, Json> = Object.fromEntries(picked);
        // An override equal to the default never changes the hash.
        if (withDefault) overrides["spy.minGold"] = 50;
        const r = resolve(overrides);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.hash === base.hash).toBe(picked.length === 0);
      }),
      { numRuns: 60 },
    );
  });

  test("the same overrides in another key order give the same hash", () => {
    const a = resolve({ "time.minTravel": 6000, "travel.perTile": 30 });
    const b = resolve({ "travel.perTile": 30, "time.minTravel": 6000 });
    expect(a.ok && b.ok && a.hash === b.hash).toBe(true);
  });
});
