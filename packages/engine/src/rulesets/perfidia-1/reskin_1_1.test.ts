import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { resolveConfig } from "@perfidia/engine/kernel";
import type { WorldCtx } from "@perfidia/engine/contracts";
import { createMatch } from "@perfidia/engine/kernel";
import { idKeyFromSeed } from "@perfidia/engine/core";
import { testDomain } from "./fixtures.test.ts";
import type { DeepReadonly, Json, PlayerId, RulesetRef } from "@perfidia/protocol";
import { PERFIDIA_1_DEFAULTS } from "./config.ts";
import { PERFIDIA_1_1_DEFAULTS } from "./config_1_1.ts";
import { NAMES_1_0_0, NAMES_1_1_0, buildingIds, kindIds, unitIds } from "./names.ts";
import { perfidia1_1_0_0 } from "./v1_0_0.ts";
import { perfidia1_1_1_0 } from "./v1_1_0.ts";

// The reskin of perfidia-1@1.1.0 (docs/rulesets/perfidia-1.md §0.1) renames ids and changes no
// number: with every 1.0.0 id renamed, 1.1.0's defaults, compiled rules (for every N, and under
// random number overrides) and initial worlds are 1.0.0's, apart from the keys 1.1.0 adds or
// renames (`victory.dominationMinConquests`, `scoring.conquestBonus`, `scoring.olympusBonus`) and
// the ext's conquest records.

const P1 = perfidia1_1_0_0;
const P11 = perfidia1_1_1_0;

/** 1.0.0 id → 1.1.0 id, for every id that changes. */
const RENAME: ReadonlyMap<string, string> = new Map(
  [
    ...buildingIds(NAMES_1_0_0).map((id, i) => [id, buildingIds(NAMES_1_1_0)[i] ?? id]),
    ...unitIds(NAMES_1_0_0).map((id, i) => [id, unitIds(NAMES_1_1_0)[i] ?? id]),
    ...kindIds(NAMES_1_0_0).map((id, i) => [id, kindIds(NAMES_1_1_0)[i] ?? id]),
    ["crownBonus", "olympusBonus"],
  ].filter((pair): pair is [string, string] => pair[0] !== pair[1]),
);

const renamed = (s: string): string => RENAME.get(s) ?? s;

/** A JSON value with every 1.0.0 id renamed, in keys and in string values. */
function rename(v: unknown): unknown {
  if (typeof v === "string") return renamed(v);
  if (Array.isArray(v)) return v.map(rename);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [renamed(k), rename(x)]));
  }
  return v;
}

const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/** `v` as a record of its own keys, checked. */
function rec(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = x;
  return out;
}

const players = (n: number): PlayerId[] =>
  Array.from({ length: n }, (_, i): PlayerId => `p${i + 1}`);

describe("the defaults", () => {
  test("are 1.0.0's renamed, plus dominationMinConquests 2 and conquestBonus 0", () => {
    const expected = rec(rename(plain(PERFIDIA_1_DEFAULTS)));
    expected["victory"] = { ...rec(expected["victory"]), dominationMinConquests: 2 };
    expected["scoring"] = { ...rec(expected["scoring"]), conquestBonus: 0 };
    expect(plain(PERFIDIA_1_1_DEFAULTS)).toEqual(expected);
  });
});

describe("the compiled rules", () => {
  test("are 1.0.0's renamed for every N (the ruleset ref aside)", () => {
    for (let n = 6; n <= 12; n += 1) {
      const old = rec(rename(plain(P1.compile(P1.defaults, n))));
      const now = rec(plain(P11.compile(P11.defaults, n)));
      expect(now["ruleset"]).toBe("perfidia-1@1.1.0");
      expect({ ...now, ruleset: "" }).toEqual({ ...old, ruleset: "" });
    }
  });

  /** Number leaves of the 1.0.0 defaults that 1.1.0 keeps (every one but the domination keys). */
  const LEAVES: readonly string[] = (() => {
    const out: string[] = [];
    const walk = (v: unknown, path: string[]): void => {
      if (typeof v === "number") out.push(path.join("."));
      else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
      }
    };
    walk(plain(PERFIDIA_1_DEFAULTS), []);
    return out.filter((p) => !p.startsWith("victory.") && !p.startsWith("players."));
  })();

  test("stay 1.0.0's renamed under random number overrides (same accept/reject, same tables)", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...LEAVES), { minLength: 1, maxLength: 4 }),
        fc.array(fc.integer({ min: 0, max: 3000 }), { minLength: 4, maxLength: 4 }),
        fc.integer({ min: 6, max: 12 }),
        (paths, values, n) => {
          const o100: Record<string, Json> = {};
          const o110: Record<string, Json> = {};
          paths.forEach((p, i) => {
            const v = values[i] ?? 0;
            o100[p] = v;
            o110[p.split(".").map(renamed).join(".")] = v;
          });
          const a = resolveConfig(P1, o100);
          const b = resolveConfig(P11, o110);
          expect(b.ok).toBe(a.ok);
          if (!a.ok || !b.ok) {
            if (!a.ok && !b.ok) {
              const paths100 = a.errors.map((e) => e.path.split(".").map(renamed).join("."));
              expect(b.errors.map((e) => e.path)).toEqual(paths100);
            }
            return;
          }
          const old = rec(rename(plain(P1.compile(a.config, n))));
          const now = rec(plain(P11.compile(b.config, n)));
          expect({ ...now, ruleset: "" }).toEqual({ ...old, ruleset: "" });
        },
      ),
      { numRuns: 150 },
    );
  });
});

/** A world context whose named streams are mulberry32-like and deterministic. */
function ctx<C>(
  config: DeepReadonly<C>,
  n: number,
  seed: number,
  rules: WorldCtx<C>["rules"],
): WorldCtx<C> {
  return {
    seed,
    players: players(n),
    config,
    rules,
    rng: (stream) => {
      let s = (seed * 2654435761 + stream.length * 40503) >>> 0;
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
}

describe("the initial world", () => {
  test("is 1.0.0's renamed for several seeds and N, with no conquest yet", () => {
    for (const seed of [1, 2, 99, 4242]) {
      for (const n of [6, 7, 8, 12]) {
        const old = plain(
          P1.hooks.createWorld(ctx(P1.defaults, n, seed, P1.compile(P1.defaults, n))),
        );
        const now = plain(
          P11.hooks.createWorld(ctx(P11.defaults, n, seed, P11.compile(P11.defaults, n))),
        );
        const expected = rec(rename(old));
        expect(now).toEqual({ ...expected, ext: { ...rec(expected["ext"]), conquests: {} } });
      }
    }
  });

  test("a match of either version created with the same seed has the same map and seats", () => {
    for (const n of [6, 12]) {
      const seats = players(n).map((id) => ({ id }));
      const setup = (ruleset: RulesetRef) => ({
        ruleset,
        overrides: {},
        seed: 5,
        idKey: idKeyFromSeed(5),
        seats,
      });
      const a = createMatch(setup(P1.ref), P1, testDomain, { invariants: "step" }).read().state;
      const b = createMatch(setup(P11.ref), P11, testDomain, { invariants: "step" }).read().state;
      expect(plain(b.islands)).toEqual(rename(plain(a.islands)));
      expect(plain(b.cities)).toEqual(rename(plain(a.cities)));
      expect(plain(b.queue)).toEqual(plain(a.queue));
    }
  });
});
