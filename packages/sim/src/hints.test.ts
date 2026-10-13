// The bots' combat hints (docs/architecture.md §11.1) are paths into the effective config, so the
// bots that weigh spy reports (rusher@2, conqueror@1) read the numbers of the match, overrides
// included. A renamed config key would leave them on their fallback margins without failing, so
// every path of every ruleset's hints must hold the numbers it promises in the default config.

import { expect, test } from "bun:test";
import { RULESET_HINTS } from "@perfidia/bots";
import { RULESETS } from "@perfidia/engine";
import { JsonObjectSchema, type Json } from "@perfidia/protocol";

function at(start: Json | undefined, path: readonly string[]): Json | undefined {
  let v = start;
  for (const key of path) {
    if (v === undefined || v === null || typeof v !== "object" || Array.isArray(v))
      return undefined;
    if (!Object.hasOwn(v, key)) return undefined;
    v = v[key];
  }
  return v;
}

const isInt = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v);

test("every combat hint path holds an integer (or a quad of them) in each ruleset's defaults", () => {
  let checked = 0;
  for (const rs of RULESETS) {
    const combat = RULESET_HINTS[rs.id]?.combat;
    if (combat === undefined) continue;
    const defaults = JsonObjectSchema.parse(rs.defaults);
    const ints = [
      combat.capitalImmunityEnd,
      combat.wallPmPerLevel,
      combat.baseDefense?.perLevel,
      combat.morale?.perCity,
      combat.morale?.floor,
      combat.lootProtectPerLevel,
    ];
    for (const path of ints) {
      if (path === undefined) continue;
      expect([rs.ref, path.join("."), isInt(at(defaults, path))]).toEqual([
        rs.ref,
        path.join("."),
        true,
      ]);
      checked += 1;
    }
    const quad = combat.baseDefense?.quad;
    if (quad !== undefined) {
      const q = at(defaults, quad);
      for (const k of ["a", "b", "c"]) expect(isInt(at(q, [k]))).toBe(true);
      checked += 1;
    }
    const building = combat.baseDefense?.building;
    if (building !== undefined) {
      const rules = rs.compile(rs.defaults, rs.players(rs.defaults).min);
      expect(rules.buildings.map((b) => b.id)).toContain(building);
    }
  }
  expect(checked).toBeGreaterThanOrEqual(7);
});

test("the relief module's siege length path holds an integer in each ruleset's defaults", () => {
  let checked = 0;
  for (const rs of RULESETS) {
    const path = RULESET_HINTS[rs.id]?.siege?.duration;
    if (path === undefined) continue;
    const defaults = JsonObjectSchema.parse(rs.defaults);
    expect([rs.ref, path.join("."), isInt(at(defaults, path))]).toEqual([
      rs.ref,
      path.join("."),
      true,
    ]);
    checked += 1;
  }
  expect(checked).toBeGreaterThanOrEqual(1);
});
