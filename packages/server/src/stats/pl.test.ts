// MAP Plackett–Luce (phase-4 design §6.2, §8.8): on rankings drawn from known strengths the fit
// recovers them (fast-check over strengths and seeds), it is deterministic, finite when an item is
// always last (the prior), at a stationary point of the log-posterior, and the pipeline's intervals
// cover the truth; a hand-computed case pins the likelihood. The served intervals hold their level
// where the percentile block bootstrap alone does not (a synthetic coverage check, review fix), and
// pairs carry the claim's Bonferroni level.
// The synthetic coverage simulation runs in the slow suite (PERFIDIA_SLOW=1, docs/architecture.md
// §13.8: `bun run test:slow`, run by `bun run test:exit`).

import { describe, expect, test } from "bun:test";
import { mulberry32 } from "@perfidia/engine/core";
import fc from "fast-check";
import { PRIOR_SIGMA, fitPlackettLuce, samplePlackettLuce } from "./pl.ts";
import {
  MIN_BOOTSTRAP_BLOCKS,
  normalQuantile,
  rateMatches,
  smallSampleFactor,
  tQuantile,
  type RankedMatch,
} from "./rate.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

const uniform = (seed: number): (() => number) => {
  const rng = mulberry32(seed >>> 0);
  return () => (rng.nextU32() + 0.5) / 4_294_967_296;
};

const width = (iv: { readonly lo: number; readonly hi: number }): number => iv.hi - iv.lo;

const centred = (xs: readonly number[]): number[] => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.map((x) => x - mean);
};

describe("MAP Plackett–Luce", () => {
  test("recovers known strengths from 600 drawn rankings (fast-check, 25 runs)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -120, max: 120 }), { minLength: 3, maxLength: 6 }),
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        (hundredths, seed) => {
          const truth = centred(hundredths.map((h) => h / 100));
          const items = truth.map((_, i) => i);
          const u = uniform(seed);
          const rankings = Array.from({ length: 600 }, () => samplePlackettLuce(items, truth, u));
          const fit = fitPlackettLuce(items.length, rankings);
          const est = centred(fit.theta);
          for (const [i, t] of truth.entries()) {
            expect(Math.abs((est[i] ?? 0) - t)).toBeLessThan(0.3);
          }
          // Every pair more than 0.6 apart comes out in the right order.
          for (const a of items) {
            for (const b of items) {
              if ((truth[a] ?? 0) - (truth[b] ?? 0) > 0.6) {
                expect((est[a] ?? 0) > (est[b] ?? 0)).toBe(true);
              }
            }
          }
        },
      ),
      { numRuns: 25, seed: 4242 },
    );
  });

  test("deterministic, stationary, and finite when an item is always last", () => {
    const u = uniform(7);
    const truth = [0.8, 0.2, -0.3];
    const rankings = Array.from({ length: 40 }, () => [
      ...samplePlackettLuce([0, 1, 2], truth, u),
      3,
    ]);
    const a = fitPlackettLuce(4, rankings);
    const b = fitPlackettLuce(4, rankings);
    expect(a).toEqual(b);
    // Item 3 always last: without the prior its strength would run to −∞.
    expect(Number.isFinite(a.theta[3] ?? Number.NaN)).toBe(true);
    expect(a.theta[3] ?? 0).toBeLessThan(-2);
    // At the mode the gradient vanishes: nudging any strength lowers the log-posterior.
    const logPost = (theta: readonly number[]): number => {
      let v = theta.reduce((s, t) => s - (t * t) / (2 * PRIOR_SIGMA * PRIOR_SIGMA), 0);
      for (const r of rankings) {
        for (let k = 0; k < r.length - 1; k += 1) {
          const z = r.slice(k).reduce((s, i) => s + Math.exp(theta[i] ?? 0), 0);
          v += (theta[r[k] ?? 0] ?? 0) - Math.log(z);
        }
      }
      return v;
    };
    const at = logPost(a.theta);
    for (let i = 0; i < 4; i += 1) {
      for (const d of [1e-4, -1e-4]) {
        const nudged = a.theta.map((t, j) => (j === i ? t + d : t));
        expect(logPost(nudged)).toBeLessThanOrEqual(at + 1e-12);
      }
    }
    // The covariance is symmetric and positive on its diagonal.
    for (let i = 0; i < 4; i += 1) {
      expect(a.cov[i]?.[i] ?? 0).toBeGreaterThan(0);
      for (let j = 0; j < 4; j += 1) {
        expect(Math.abs((a.cov[i]?.[j] ?? 0) - (a.cov[j]?.[i] ?? 0))).toBeLessThan(1e-12);
      }
    }
  });

  test("one two-item ranking: the posterior mode solves 1 − σ(2θ) = θ / σ²", () => {
    // Item 0 beats item 1 once; by symmetry θ₁ = −θ₀ and the mode solves 1 − p = θ₀/σ², p the
    // probability of the observed order, exp(θ₀)/(exp(θ₀) + exp(−θ₀)).
    const fit = fitPlackettLuce(2, [[0, 1]]);
    const t = fit.theta[0] ?? 0;
    expect(fit.theta[1] ?? 0).toBeCloseTo(-t, 12);
    const p = Math.exp(t) / (Math.exp(t) + Math.exp(-t));
    expect(1 - p).toBeCloseTo(t / (PRIOR_SIGMA * PRIOR_SIGMA), 10);
  });

  test("the pipeline's intervals: deterministic for a seed, and they cover the truth", () => {
    const truth = [0.6, 0.2, -0.2, -0.6, 0, 0];
    const u = uniform(99);
    const matches = Array.from({ length: 40 }, (_, m) => {
      const ranking = samplePlackettLuce([0, 1, 2, 3, 4, 5], truth, u);
      return { block: `b${Math.floor(m / 4)}`, ranking, ranks: ranking.map((_x, k) => k + 1) };
    });
    const once = rateMatches(6, [0, 1, 2, 3], matches, mulberry32(11), 300);
    const again = rateMatches(6, [0, 1, 2, 3], matches, mulberry32(11), 300);
    expect(once).toEqual(again);
    expect(once.method).toBe("laplace+block-bootstrap");
    expect(once.blocks).toBe(10);
    const other = rateMatches(6, [0, 1, 2, 3], matches, mulberry32(12), 300);
    expect(other.bootstrap?.strengthIv).not.toEqual(once.bootstrap?.strengthIv);
    expect(other.strength).toEqual(once.strength);
    // A served interval is the union of Laplace's and the bootstrap's: it holds both.
    const lap = rateMatches(6, [0, 1, 2, 3], matches, mulberry32(11), 0);
    for (const [i, iv] of once.strengthIv.entries()) {
      const l = lap.strengthIv[i];
      const b = once.bootstrap?.strengthIv[i];
      expect(iv !== null && l !== null && l !== undefined && iv.lo <= l.lo && iv.hi >= l.hi).toBe(
        true,
      );
      expect(iv !== null && b !== null && b !== undefined && iv.lo <= b.lo && iv.hi >= b.hi).toBe(
        true,
      );
    }
    // The LLM items' strengths sum to zero; the truth (centred alike) is inside every interval.
    expect(Math.abs(once.strength.slice(0, 4).reduce((a, b) => a + b, 0))).toBeLessThan(1e-9);
    const t = centred(truth.slice(0, 4));
    for (const [i, x] of t.entries()) {
      const iv = once.strengthIv[i];
      expect(iv !== null && iv !== undefined && iv.lo <= x && x <= iv.hi).toBe(true);
    }
    // Below 5 blocks: Laplace intervals, no mean-rank interval.
    const few = rateMatches(6, [0, 1, 2, 3], matches.slice(0, 16), mulberry32(11), 300);
    expect(few.method).toBe("laplace");
    expect(few.blocks).toBeLessThan(MIN_BOOTSTRAP_BLOCKS);
    expect(few.rankIv.every((x) => x === null)).toBe(true);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 6);
    expect(normalQuantile(0.005)).toBeCloseTo(-2.575829, 6);
  });

  test("pairs at the claim's Bonferroni level: Laplace half-widths scale by z", () => {
    const u = uniform(5);
    const matches = Array.from({ length: 12 }, (_, m) => {
      const ranking = samplePlackettLuce([0, 1, 2, 3, 4, 5], [0.4, 0, 0, -0.4, -1, -1], u);
      return { block: `b${Math.floor(m / 4)}`, ranking, ranks: ranking.map((_x, k) => k + 1) };
    });
    const at95 = rateMatches(6, [0, 1, 2, 3], matches, mulberry32(1), 0);
    const corrected = rateMatches(6, [0, 1, 2, 3], matches, mulberry32(1), 0, {
      pairLevel: 1 - 0.05 / 6,
    });
    const ratio = normalQuantile(1 - 0.05 / 12) / normalQuantile(0.975);
    expect(ratio).toBeCloseTo(2.638 / 1.96, 2);
    for (const [k, p] of corrected.pairs.entries()) {
      const q = at95.pairs[k];
      if (p.interval === null || q?.interval === null || q === undefined)
        throw new Error("no pair");
      expect(width(p.interval) / width(q.interval)).toBeCloseTo(ratio, 6);
    }
    // Strengths keep their 95%.
    expect(corrected.strengthIv).toEqual(at95.strengthIv);
  });

  test("small-sample factor: t(B − 1)/z·√(B/(B − 1)), near 1 with many blocks", () => {
    expect(tQuantile(0.975, 4)).toBeCloseTo(2.776, 1);
    expect(tQuantile(0.975, 18)).toBeCloseTo(2.101, 2);
    expect(tQuantile(0.975, 1000)).toBeCloseTo(1.962, 2);
    expect(smallSampleFactor(5)).toBeCloseTo((2.776 / 1.96) * Math.sqrt(5 / 4), 1);
    expect(smallSampleFactor(1000)).toBeCloseTo(1, 2);
  });

  xtest("coverage (synthetic): the bootstrap alone runs narrow at 5 blocks; the served intervals do not", () => {
    // 80 series of 20 matches (5 blocks of 4), four equal models and two weaker bots; 60 replicates.
    const theta = [0, 0, 0, 0, -1, -1.5];
    // An equal model's expected rank (about 2.95), by Monte Carlo.
    const mc = uniform(99);
    let sum = 0;
    for (let k = 0; k < 40_000; k += 1) {
      const order = samplePlackettLuce([0, 1, 2, 3, 4, 5], theta, mc);
      for (let i = 0; i < 4; i += 1) sum += order.indexOf(i) + 1;
    }
    const rank = sum / 160_000;
    const u = uniform(2026);
    const rng = mulberry32(7);
    let served = 0;
    let raw = 0;
    let ranked = 0;
    let n = 0;
    let falsePairs = 0;
    const series = 80;
    for (let r = 0; r < series; r += 1) {
      const ms: RankedMatch[] = Array.from({ length: 20 }, (_, m) => {
        const ranking = samplePlackettLuce([0, 1, 2, 3, 4, 5], theta, u);
        return { block: `b${Math.floor(m / 4)}`, ranking, ranks: ranking.map((_x, k) => k + 1) };
      });
      const out = rateMatches(6, [0, 1, 2, 3], ms, rng, 60);
      for (let i = 0; i < 4; i += 1) {
        n += 1;
        const a = out.strengthIv[i];
        const b = out.bootstrap?.strengthIv[i];
        if (a !== null && a !== undefined && a.lo <= 0 && 0 <= a.hi) served += 1;
        if (b !== null && b !== undefined && b.lo <= 0 && 0 <= b.hi) raw += 1;
        const iv = out.rankIv[i];
        if (iv !== null && iv !== undefined && iv.lo <= rank && rank <= iv.hi) ranked += 1;
      }
      const p = out.pairs[0]?.interval;
      if (p !== null && p !== undefined && (p.lo > 0 || p.hi < 0)) falsePairs += 1;
    }
    // Measured on this draw: served 0.96, raw 0.83; mean ranks 0.93 widened by the small-sample
    // factor, 0.82 without it (docs/phase4.md §55 has the 200-series table).
    expect(served / n).toBeGreaterThanOrEqual(0.93);
    expect(raw / n).toBeLessThan(served / n);
    expect(ranked / n).toBeGreaterThanOrEqual(0.9);
    expect(falsePairs / series).toBeLessThanOrEqual(0.1);
  });
});
