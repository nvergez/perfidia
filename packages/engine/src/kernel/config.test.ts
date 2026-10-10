import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@perfidia/engine/core";
import type { Ruleset } from "@perfidia/engine/contracts";
import {
  FIXTURE_DEFAULTS,
  FixtureConfigSchema,
  fixtureRuleset,
  type FixtureConfig,
  type FixtureExt,
} from "@perfidia/engine/testing";
import { z, type ConfigIssue, type Json } from "@perfidia/protocol";
import fc from "fast-check";
import { configHashOf, parseOverride, resolveConfig } from "./index.ts";

function errorsOf(overrides: Record<string, Json>): ConfigIssue[] {
  const r = resolveConfig(fixtureRuleset, overrides);
  if (r.ok) throw new Error(`expected a rejection of ${JSON.stringify(overrides)}`);
  return r.errors;
}

function hashOf(overrides: Record<string, Json>): string {
  const r = resolveConfig(fixtureRuleset, overrides);
  if (!r.ok) throw new Error(`unexpected rejection: ${JSON.stringify(r.errors)}`);
  return r.hash;
}

describe("parseOverride", () => {
  test("parses JSON values and falls back to a string", () => {
    expect(parseOverride("time.travel=4000")).toEqual({ path: "time.travel", value: 4000 });
    expect(parseOverride("a.b=true")).toEqual({ path: "a.b", value: true });
    expect(parseOverride("homeRadius.6=[1,2]")).toEqual({ path: "homeRadius.6", value: [1, 2] });
    expect(parseOverride('name="x=y"')).toEqual({ path: "name", value: "x=y" });
    expect(parseOverride("name=hello")).toEqual({ path: "name", value: "hello" });
    expect(parseOverride("a=")).toEqual({ path: "a", value: "" });
  });

  test("rejects a missing '=', a bad path and a __proto__ key", () => {
    expect(parseOverride("time.travel")).toHaveProperty("error");
    expect(parseOverride("a..b=1")).toHaveProperty("error");
    expect(parseOverride("=1")).toHaveProperty("error");
    expect(parseOverride("__proto__.x=1")).toHaveProperty("error");
    expect(parseOverride('a={"__proto__":{"x":1}}')).toHaveProperty("error");
  });
});

describe("resolveConfig", () => {
  test("the defaults resolve to themselves, hashed with the ref", () => {
    const r = resolveConfig(fixtureRuleset, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(canonicalJson(r.config)).toBe(canonicalJson(FIXTURE_DEFAULTS));
    expect(r.hash).toBe(configHashOf(fixtureRuleset.ref, FIXTURE_DEFAULTS));
  });

  test("an override sets a nested value; the defaults are never touched", () => {
    const r = resolveConfig(fixtureRuleset, {
      "time.travel": 4000,
      "gateway.selfWake": { min: 60, max: 600 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.time.travel).toBe(4000);
    expect(r.config.gateway.selfWake).toEqual({ min: 60, max: 600 });
    expect(FIXTURE_DEFAULTS.time.travel).toBe(5400);
  });

  test("an unknown path is rejected with the valid sibling keys", () => {
    const [issue] = errorsOf({ "time.nope": 1 });
    expect(issue?.path).toBe("time.nope");
    expect(issue?.message).toContain(
      "valid keys: attackFrom, buildTime, matchEnd, minTravel, openAt, recruitTime, sameIsland, travel",
    );
    expect(errorsOf({ nope: 1 })[0]?.message).toContain(
      "valid keys: gateway, players, resourceScale, start, time",
    );
    expect(errorsOf({ "time.travel.x": 1 })[0]?.message).toContain("is a value, not an object");
  });

  test("an invalid value is rejected with its path; so is a float", () => {
    expect(errorsOf({ "time.travel": -5 }).map((i) => i.path)).toEqual(["time.travel"]);
    const [float] = errorsOf({ "time.travel": 1.5 });
    expect(float?.path).toBe("time.travel");
    expect(float?.message).toContain("int");
    expect(errorsOf({ "start.stock": "many" }).map((i) => i.path)).toEqual(["start.stock"]);
  });

  test("a fixed field cannot be overridden", () => {
    const [issue] = errorsOf({ resourceScale: 7200 });
    expect(issue?.path).toBe("resourceScale");
    expect(issue?.message).toContain("fixed by fixture-1@1.0.0");
    expect(errorsOf({ "players.max": 6 })[0]?.message).toContain("fixed by fixture-1@1.0.0");
  });

  test("a config that cannot be hashed is a config error, never a throw", () => {
    const loose: Ruleset<FixtureConfig & { ratio: number }, FixtureExt> = {
      ...fixtureRuleset,
      configSchema: FixtureConfigSchema.extend({ ratio: z.number() }),
      defaults: { ...FIXTURE_DEFAULTS, ratio: 1 },
    };
    const r = resolveConfig(loose, { ratio: 0.5 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.path).toBe("ratio");
    expect(r.errors[0]?.message).toContain("cannot be hashed");
  });

  test("array elements are set with numeric segments; an index out of range lists the valid ones", () => {
    const withArray: Ruleset<FixtureConfig & { bonus: number[] }, FixtureExt> = {
      ...fixtureRuleset,
      configSchema: FixtureConfigSchema.extend({ bonus: z.array(z.int()) }),
      defaults: { ...FIXTURE_DEFAULTS, bonus: [1, 2, 3] },
    };
    const r = resolveConfig(withArray, { "bonus.1": 20 });
    expect(r.ok && r.config.bonus).toEqual([1, 20, 3]);
    const bad = resolveConfig(withArray, { "bonus.3": 1 });
    expect(!bad.ok && bad.errors[0]?.message).toContain("valid indices: 0..2");
    const word = resolveConfig(withArray, { "bonus.x": 1 });
    expect(!word.ok && word.errors[0]?.path).toBe("bonus.x");
  });

  test("the hash ignores key order and an override equal to the default", () => {
    expect(hashOf({ "time.travel": 5400 })).toBe(hashOf({}));
    expect(hashOf({ "start.stock": 100, "time.travel": 4000 })).toBe(
      hashOf({ "time.travel": 4000, "start.stock": 100 }),
    );
    const a = configHashOf("x@1.0.0", { b: 1, a: { d: 2, c: 3 } });
    expect(configHashOf("x@1.0.0", { a: { c: 3, d: 2 }, b: 1 })).toBe(a);
    expect(hashOf({ "time.travel": 4000 })).not.toBe(hashOf({}));
  });
});

describe("compile checks (§3.6), one rejection per generic check, each naming its path", () => {
  const cases: [string, Record<string, Json>, string][] = [
    ["selfWake.min > selfWake.max", { "gateway.selfWake.min": 30000 }, "gateway.selfWake.min"],
    ["safetyWake < selfWake.min", { "gateway.safetyWake": 100 }, "gateway.safetyWake"],
    ["selfWake.min = 0", { "gateway.selfWake.min": 0 }, "gateway.selfWake.min"],
    ["roundTripsPerWake = 0", { "gateway.roundTripsPerWake": 0 }, "gateway.roundTripsPerWake"],
    [
      "toolCallsPerRoundTrip = 0",
      { "gateway.toolCallsPerRoundTrip": 0 },
      "gateway.toolCallsPerRoundTrip",
    ],
    ["toolCallsPerWake = 0", { "gateway.toolCallsPerWake": 0 }, "gateway.toolCallsPerWake"],
    ["ownWakesPerDay = 0", { "gateway.ownWakesPerDay": 0 }, "gateway.ownWakesPerDay"],
    ["socialWakesPerDay = 0", { "gateway.socialWakesPerDay": 0 }, "gateway.socialWakesPerDay"],
    ["matchEnd = 0", { "time.matchEnd": 0 }, "time.matchEnd"],
    ["urgentMinGap = minTravel", { "gateway.urgentMinGap": 3600 }, "gateway.urgentMinGap"],
    ["urgentMinGap > minTravel", { "time.minTravel": 200 }, "gateway.urgentMinGap"],
    ["minTravel = 0", { "time.minTravel": 0 }, "time.minTravel"],
    ["a build time of 0 s", { "time.buildTime": 0 }, "buildings.0.time.1.0"],
    ["a recruit time of 0 s", { "time.recruitTime": 0 }, "units.0.time.0"],
    ["the ruleset's own check", { "start.soldiers": 2000 }, "start.soldiers"],
  ];
  for (const [name, overrides, path] of cases) {
    test(name, () => {
      const paths = errorsOf(overrides).map((i) => i.path);
      expect(paths).toContain(path);
    });
  }

  test("toolCallsPerWake null is allowed", () => {
    expect(resolveConfig(fixtureRuleset, { "gateway.toolCallsPerWake": null }).ok).toBe(true);
  });

  test("a compile that throws or returns a malformed table is reported, never thrown", () => {
    const throwing: Ruleset<FixtureConfig, FixtureExt> = {
      ...fixtureRuleset,
      compile: () => {
        throw new Error("boom");
      },
    };
    const r = resolveConfig(throwing, {});
    expect(!r.ok && r.errors[0]?.message).toContain("boom");
    const malformed: Ruleset<FixtureConfig, FixtureExt> = {
      ...fixtureRuleset,
      compile: (c, n) => ({ ...fixtureRuleset.compile(c, n), resourceScale: 0.5 }),
    };
    const m = resolveConfig(malformed, {});
    expect(!m.ok && m.errors.map((i) => i.path)).toContain("resourceScale");
  });
});

describe("P14: overrides", () => {
  const valid = fc.record(
    {
      "time.travel": fc.integer({ min: 3600, max: 20000 }),
      "time.openAt": fc.integer({ min: 1, max: 80000 }),
      "start.stock": fc.integer({ min: 0, max: 1000 }),
      "start.soldiers": fc.integer({ min: 0, max: 1000 }),
      "gateway.messagesPerDay": fc.integer({ min: 0, max: 50 }),
      "time.matchEnd": fc.integer({ min: 1, max: 200000 }),
    },
    { requiredKeys: [] },
  );

  test("any valid override set resolves, and the hash changes iff the effective config changes", () => {
    fc.assert(
      fc.property(valid, valid, (a, b) => {
        const ra = resolveConfig(fixtureRuleset, a);
        const rb = resolveConfig(fixtureRuleset, b);
        if (!ra.ok || !rb.ok) return false;
        const sameConfig = canonicalJson(ra.config) === canonicalJson(rb.config);
        return sameConfig === (ra.hash === rb.hash);
      }),
      { numRuns: 200 },
    );
  });

  test("invalid overrides are rejected with their path", () => {
    const field = fc.constantFrom(
      "time.travel",
      "time.openAt",
      "start.stock",
      "gateway.messagesPerDay",
    );
    const bad = fc.oneof(
      fc.integer({ max: -1 }),
      fc.double({ noInteger: true, noNaN: true, noDefaultInfinity: true }),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
    );
    fc.assert(
      fc.property(field, bad, (path, value) => {
        const r = resolveConfig(fixtureRuleset, { [path]: value });
        return !r.ok && r.errors.some((i) => i.path === path);
      }),
      { numRuns: 200 },
    );
  });

  test("a fixed field cannot be overridden by any other value", () => {
    fc.assert(
      fc.property(
        fc.integer().filter((n) => n !== 3600),
        (value) => {
          const r = resolveConfig(fixtureRuleset, { resourceScale: value });
          return (
            !r.ok &&
            r.errors.some((i) => i.path === "resourceScale" && i.message.includes("fixed by"))
          );
        },
      ),
    );
  });
});
