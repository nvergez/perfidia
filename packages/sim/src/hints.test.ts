// The bots' combat hints (docs/architecture.md §11.1) are paths into the effective config, so the
// bots that weigh spy reports (rusher@2, conqueror@1) read the numbers of the match, overrides
// included. A renamed config key would leave them on their fallback margins without failing, so
// every path of every ruleset's hints must hold the numbers it promises in the default config.
// Hints are looked up as the bots do (`hintsFor` the exact ref, then the id), for every registered
// ref, test rulesets included: a version that renames ids (perfidia-1@1.1.0) must not read another
// version's ids, so its settling kinds, avoided tags and base-defense building must exist in it.

import { expect, test } from "bun:test";
import { hintsFor } from "@perfidia/bots";
import { RULESETS, createMatch, idKeyFromSeed } from "@perfidia/engine";
import { JsonObjectSchema, type Json, type PlayerId } from "@perfidia/protocol";

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
    const combat = hintsFor(rs.ref).combat;
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
      const ids = rules.buildings.map((b) => b.id);
      expect([rs.ref, building, ids.includes(building)]).toEqual([rs.ref, building, true]);
    }
  }
  expect(checked).toBeGreaterThanOrEqual(14);
});

test("the relief module's siege length path holds an integer in each ruleset's defaults", () => {
  let checked = 0;
  for (const rs of RULESETS) {
    const path = hintsFor(rs.ref).siege?.duration;
    if (path === undefined) continue;
    const defaults = JsonObjectSchema.parse(rs.defaults);
    expect([rs.ref, path.join("."), isInt(at(defaults, path))]).toEqual([
      rs.ref,
      path.join("."),
      true,
    ]);
    checked += 1;
  }
  expect(checked).toBeGreaterThanOrEqual(2);
});

test("every ref's settling kinds and avoided tags exist in its own world", () => {
  for (const rs of RULESETS) {
    const hints = hintsFor(rs.ref);
    const n = rs.players(rs.defaults).min;
    const seats = Array.from({ length: n }, (_, i): { id: PlayerId } => ({ id: `p${i + 1}` }));
    const setup = { ruleset: rs.ref, overrides: {}, seed: 1, idKey: idKeyFromSeed(1), seats };
    const state = createMatch(setup, rs, { invariants: "off" }).read().state;
    const kinds = new Set(Object.values(state.islands).map((i) => i.kind));
    const tags = new Set(
      Object.values(state.cities).flatMap((c) => (c.tag === null ? [] : [c.tag])),
    );
    for (const kind of hints.settleOrder)
      expect([rs.ref, kind, kinds.has(kind)]).toEqual([rs.ref, kind, true]);
    for (const tag of hints.avoidTags)
      expect([rs.ref, tag, tags.has(tag)]).toEqual([rs.ref, tag, true]);
  }
  // perfidia-1@1.1.0 has its own entry; 1.0.0 keeps the id entry, unchanged.
  expect(hintsFor("perfidia-1@1.1.0").avoidTags).toEqual(["olympus"]);
  expect(hintsFor("perfidia-1@1.1.0").combat?.baseDefense?.building).toBe("acropolis");
  expect(hintsFor("perfidia-1@1.0.0")).toBe(hintsFor("perfidia-1"));
  expect(hintsFor("perfidia-1@1.0.0").avoidTags).toEqual(["crown"]);
});
