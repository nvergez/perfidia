import { describe, expect, test } from "bun:test";
import type { AnyRuleset } from "@perfidia/engine/contracts";
import { fmt, idKeyFromSeed } from "@perfidia/engine/core";
import { createMatch, type Match } from "@perfidia/engine/kernel";
import { findRuleset, getRuleset, RULESETS } from "@perfidia/engine/rulesets";
import {
  DOMAIN_EVENT_KINDS,
  PlayerIdSchema,
  compareIds,
  type MatchSetup,
} from "@perfidia/protocol";
import { PERFIDIA_1_ERRORS } from "./errors.ts";
import { PERFIDIA_1_INTEL_EVENTS } from "./events.ts";
import { extOf11 } from "./fixtures_1_1.test.ts";
import { testDomain } from "./fixtures.test.ts";
import { perfidia1_1_0_0 } from "./v1_0_0.ts";
import { perfidia1_1_1_0 } from "./v1_1_0.ts";

// The `perfidia1_1_1_0` descriptor: identity, the bare id resolving to it, the hooks it shares with
// 1.0.0 and those it replaces, and whole matches through the kernel under step invariants, the
// same seed giving the same hashes.

const P1 = perfidia1_1_0_0;
const P11 = perfidia1_1_1_0;

describe("the descriptor", () => {
  test("is perfidia-1@1.1.0, published, the bare id's version; 1.0.0 stays reachable", () => {
    expect([P11.id, P11.version, P11.ref, P11.status, P11.title]).toEqual([
      "perfidia-1",
      "1.1.0",
      "perfidia-1@1.1.0",
      "published",
      "Perfidia V1.1",
    ]);
    expect(RULESETS).toContain(P11);
    expect(findRuleset("perfidia-1")).toBe(P11);
    expect(getRuleset("perfidia-1")).toBe(P11);
    expect(getRuleset("perfidia-1@1.0.0")).toBe(P1);
    expect(Object.isFrozen(P11)).toBe(true);
    expect(Object.isFrozen(P11.hooks)).toBe(true);
  });

  test("shares 1.0.0's unchanged hooks and errors, and replaces the ones that changed", () => {
    const a: AnyRuleset = P11;
    const b: AnyRuleset = P1;
    const h = a.hooks;
    const h1 = b.hooks;
    /** Whether both descriptors' hooks hold the very same value at `key`. */
    const shared = (key: string): boolean => Object.is(Reflect.get(h, key), Reflect.get(h1, key));
    for (const k of ["travelTime", "departure", "guard"]) expect([k, shared(k)]).toEqual([k, true]);
    for (const k of ["afterStep", "standings", "finish", "visibility"]) {
      expect([k, shared(k)]).toEqual([k, false]);
    }
    expect(h.arrive).toEqual(h1.arrive);
    expect(h.on?.["domination_open"]).toBe(h1.on?.["domination_open"]);
    for (const k of ["siege_end", "domination_end"]) expect(h.on?.[k]).not.toBe(h1.on?.[k]);
    expect(P11.errors).toBe(PERFIDIA_1_ERRORS);
    expect(P11.intelEvents).toBe(PERFIDIA_1_INTEL_EVENTS);
    expect(Object.keys(P11.eventSchemas).toSorted(compareIds)).toEqual(
      Object.keys(P1.eventSchemas).toSorted(compareIds),
    );
    expect(P11.eventSchemas["domination_started"]).not.toBe(P1.eventSchemas["domination_started"]);
    for (const v of P11.errorSamples) {
      expect(P11.errors[v.code]?.(v, fmt).message.length ?? 0).toBeGreaterThan(0);
    }
    expect(P11.tools).toBeUndefined();
  });

  test("handles every scheduled event kind with a class", () => {
    const classes = P11.compile(P11.defaults, 6).eventClasses;
    const own = Object.keys(P11.hooks.on ?? {}).toSorted(compareIds);
    expect(own).toEqual(["domination_end", "domination_open", "siege_end"]);
    const handled = new Set<string>([...DOMAIN_EVENT_KINDS, ...own]);
    expect(Object.keys(classes).toSorted(compareIds)).toEqual([...handled].toSorted(compareIds));
  });
});

function setup(players: number, seed: number): MatchSetup {
  return {
    ruleset: P11.ref,
    overrides: { "time.matchEnd": 86400, "time.dominationStart": 3600 },
    seed,
    idKey: idKeyFromSeed(seed),
    seats: Array.from({ length: players }, (_, i) => ({ id: PlayerIdSchema.parse(`p${i + 1}`) })),
  };
}

function day(players: number, seed: number): { match: Match; hashes: string[] } {
  const match = createMatch(setup(players, seed), P11, testDomain, { invariants: "step" });
  const hashes = [match.hash()];
  for (let t = 21600; t <= 86400; t += 21600) {
    match.advanceTo(t);
    hashes.push(match.hash());
  }
  return { match, hashes };
}

describe("a whole match through the kernel", () => {
  for (const players of [6, 12]) {
    test(`N = ${players}: created, opened for domination, ended on time, deterministic`, () => {
      const { match, hashes } = day(players, 3);
      const x = extOf11(match);
      expect(x.domination.open).toBe(true);
      expect(x.conquests).toEqual({});
      expect(match.result).toMatchObject({ reason: "time", endedAt: 86400 });
      const olympus = Object.values(match.read().state.cities).filter((c) => c.tag === "olympus");
      expect(olympus.map((c) => [c.owner, c.units])).toEqual([
        [null, { hoplite: 400, trireme: 10 }],
      ]);
      expect(day(players, 3).hashes).toEqual(hashes);
      expect(day(players, 4).hashes[0]).not.toBe(hashes[0]);
    });
  }
});
