import { describe, expect, test } from "bun:test";
import { fixtureRules } from "@perfidia/engine/testing";
import type { CompiledRules } from "@perfidia/protocol";
import { MatchConfigError, checkRules } from "./index.ts";

function paths(rules: CompiledRules): string[] {
  return checkRules(rules).map((i) => i.path);
}

describe("checkRules", () => {
  test("the fixture's compiled rules pass for every N", () => {
    for (const n of [2, 3, 4]) expect(checkRules(fixtureRules(n))).toEqual([]);
  });

  test("tables must cover every maxLevel", () => {
    const rules = fixtureRules();
    const [tower] = rules.buildings;
    if (tower === undefined) throw new Error("no building");
    tower.cost = tower.cost.slice(0, 3);
    tower.time = tower.time.slice(0, 2);
    rules.levels.storage = rules.levels.storage.slice(0, 2);
    rules.levels.population = [1];
    const [soldier] = rules.units;
    if (soldier === undefined) throw new Error("no unit");
    soldier.time = [60];
    expect(paths(rules)).toEqual([
      "buildings.0.cost",
      "buildings.0.time",
      "units.0.time",
      "levels.storage",
      "levels.population",
    ]);
  });

  test("build times are indexed by the build-speed building's levels when there is one", () => {
    const rules = fixtureRules();
    rules.roles.buildSpeed = "tower";
    expect(paths(rules)).toContain("buildings.0.time.1");
    rules.roles.buildSpeed = "nowhere";
    expect(paths(rules)).toContain("roles.buildSpeed");
  });

  test("a unit's queue must exist; the new-city stock must fit its storage cap", () => {
    const rules = fixtureRules();
    const [soldier] = rules.units;
    if (soldier === undefined) throw new Error("no unit");
    soldier.queue = "elsewhere";
    rules.newCity.stock.gold = 1001;
    expect(paths(rules)).toEqual(["units.0.queue", "newCity.stock.gold"]);
  });

  test("diplomacy durations are at least 1 s (pactDuration may be null)", () => {
    const rules = fixtureRules();
    rules.diplomacy.proposalTtl = 0;
    rules.diplomacy.pactDuration = 0;
    expect(paths(rules)).toEqual(["diplomacy.proposalTtl", "diplomacy.pactDuration"]);
    rules.diplomacy.proposalTtl = 1;
    rules.diplomacy.pactDuration = null;
    expect(paths(rules)).toEqual([]);
    rules.diplomacy.pactDuration = 1;
    expect(paths(rules)).toEqual([]);
  });

  test("resourceScale must be a multiple of 3600: accrual is exact per second", () => {
    const rules = fixtureRules();
    rules.resourceScale = 1000;
    expect(checkRules(rules)).toEqual([
      {
        path: "resourceScale",
        message:
          "is 1000; it must be a multiple of 3600 so that every rate per hour accrues a whole number of stored units per second",
      },
    ]);
    rules.resourceScale = 7200;
    expect(paths(rules)).toEqual([]);
  });

  test("MatchConfigError lists every issue with its path", () => {
    const e = new MatchConfigError([
      { path: "time.matchEnd", message: "is 0" },
      { path: "", message: "whole config" },
    ]);
    expect(e.issues).toHaveLength(2);
    expect(e.message).toContain("time.matchEnd: is 0");
    expect(e.message).toContain("whole config");
    expect(e.name).toBe("MatchConfigError");
  });
});
