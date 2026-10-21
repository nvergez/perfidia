// How many matches before any claim (phase-4 design §6.4): the exact binomial computation gives the
// design's table (20 / 49 / 199 matches for one pair, 32 / 74 / 303 for six, at 80% power) and the
// draft's under-powered counts (0.38, 0.42, 0.46); the claim state follows the least-met pair; and
// the pipeline's simulated power is deterministic for a seed and sits near the exact test's.

import { describe, expect, test } from "bun:test";
import { claimsOf } from "./aggregate.ts";
import { binomialPower, matchesNeeded, neededFor } from "./power.ts";
import { simulatePower } from "./simulate.ts";

describe("the exact binomial test", () => {
  test("the design's table of matches needed for 80% power", () => {
    expect([neededFor(0.8, 1), neededFor(0.7, 1), neededFor(0.6, 1)]).toEqual([20, 49, 199]);
    expect([neededFor(0.8, 6), neededFor(0.7, 6), neededFor(0.6, 6)]).toEqual([32, 74, 303]);
    expect(matchesNeeded(0.7, 0.05)).toBe(49);
  });

  test("the draft's counts had about half the power, and power is a sawtooth in n", () => {
    expect(binomialPower(10, 0.8, 0.05)).toBeCloseTo(0.38, 2);
    expect(binomialPower(20, 0.7, 0.05)).toBeCloseTo(0.42, 2);
    expect(binomialPower(90, 0.6, 0.05)).toBeCloseTo(0.46, 2);
    expect(binomialPower(49, 0.7, 0.05)).toBeGreaterThanOrEqual(0.8);
    // Above the threshold the exact test can dip under 80% again: n = 50 and 53, not 51 or 52.
    expect(binomialPower(50, 0.7, 0.05)).toBeLessThan(0.8);
    expect(binomialPower(51, 0.7, 0.05)).toBeGreaterThanOrEqual(0.8);
    expect(binomialPower(52, 0.7, 0.05)).toBeGreaterThanOrEqual(0.8);
    expect(binomialPower(53, 0.7, 0.05)).toBeLessThan(0.8);
    expect(binomialPower(0, 0.7, 0.05)).toBe(0);
  });
});

describe("the claim state", () => {
  const llm = new Set([0, 1, 2, 3]);
  const match = [0, 1, 2, 3, 4, 5];

  test("four models meeting in every match: six pairs, 74 matches needed", () => {
    const few = claimsOf(
      Array.from({ length: 10 }, () => match),
      llm,
    );
    expect([few.state, few.models, few.pairs, few.matches, few.needed, few.more]).toEqual([
      "too_few_matches",
      4,
      6,
      10,
      74,
      64,
    ]);
    expect(few.alpha).toBeCloseTo(0.05 / 6, 6);
    expect(few.table.map((g) => [g.gap, g.needed])).toEqual([
      ["80/20", 32],
      ["70/30", 74],
      ["60/40", 303],
    ]);
    const enough = claimsOf(
      Array.from({ length: 74 }, () => match),
      llm,
    );
    expect([enough.state, enough.more]).toEqual(["ok", 0]);
    expect(enough.power).toBeGreaterThanOrEqual(0.8);
  });

  test("the least-met pair decides; one model alone is no comparison", () => {
    const rated = [
      ...Array.from({ length: 60 }, () => [0, 1, 4, 5]),
      ...Array.from({ length: 3 }, () => [0, 2, 4, 5]),
    ];
    const c = claimsOf(rated, new Set([0, 1, 2]));
    // 1 and 2 never met: three pairs, the least met in 0 matches.
    expect([c.state, c.pairs, c.unmet, c.matches]).toEqual(["too_few_matches", 3, 1, 0]);
    const met = claimsOf([...rated, [1, 2, 4, 5]], new Set([0, 1, 2]));
    expect([met.pairs, met.unmet, met.matches]).toEqual([3, 0, 1]);
    expect(claimsOf([[0, 4, 5]], new Set([0])).state).toBe("no_comparison");
    expect(claimsOf([], llm).state).toBe("no_comparison");
  });
});

describe("the simulated power of the rating pipeline", () => {
  test("deterministic for a seed; near the exact test's", () => {
    const o = { p: 0.7, matches: [20], reps: 40, replicates: 0, seed: 3 };
    const a = simulatePower(o);
    expect(simulatePower(o)).toEqual(a);
    const row = a[0];
    expect(row?.exact.one).toBeCloseTo(binomialPower(20, 0.7, 0.05), 3);
    // The simulated binomial test estimates the exact power within sampling error (40 series).
    expect(Math.abs((row?.binomial.one ?? 0) - (row?.exact.one ?? 0))).toBeLessThan(0.25);
    expect(row?.bootstrap).toBeNull();
    expect(row?.served).toBeNull();
  });

  test("p = 0.5 measures the size: the served intervals' false claims stay near 5%", () => {
    const [row] = simulatePower({ p: 0.5, matches: [20], reps: 120, replicates: 60, seed: 8 });
    if (row === undefined) throw new Error("no row");
    // Two equal models: every claim is false. The exact test holds its level by construction.
    expect(row.exact.one).toBeLessThanOrEqual(0.05);
    expect(row.laplace.one).toBeLessThanOrEqual(0.1);
    expect(row.served ?? 1).toBeLessThanOrEqual(0.1);
    // The served interval is never narrower than Laplace's: it claims no more often.
    expect(row.served ?? 1).toBeLessThanOrEqual(row.laplace.one);
  });
});
