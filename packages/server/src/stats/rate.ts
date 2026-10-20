import { randInt, type Rng } from "@perfidia/engine/core";
import type { StatsInterval } from "@perfidia/protocol";
import { PRIOR_SIGMA, fitPlackettLuce, type Ranking } from "./pl.ts";

// Ratings of ranked matches with their intervals (phase-4 design §6.2): the MAP Plackett–Luce fit
// (`pl.ts`), strengths centred on the compared items' mean (every item's without one), the mean
// rank of each item's seats, and the strength difference of every pair of compared items.
//
// Intervals. Laplace posterior intervals from the fit's covariance always; from
// `MIN_BOOTSTRAP_BLOCKS` blocks, a block bootstrap too (whole blocks drawn with replacement, each
// replicate refitted from the full fit; percentile intervals, linear between order statistics), and
// a strength or difference interval is the wider of the two (their union). The percentile
// bootstrap alone is too narrow with blocks of four matches: in simulation (docs/phase4.md §55) a
// 95% interval of two equal models' difference excludes 0 in 16–20% of series at 5 blocks and still
// 6–9% at 30–60 blocks (strength coverage 85% rising to only 92–93%), while Laplace intervals hold
// their level at every length (4–6.5%; coverage 94.6–95.8%). The union keeps Laplace's level and
// still widens where the blocks disagree more than independent matches would (a block plays one
// map). Mean ranks have no Laplace interval: theirs is the bootstrap's, widened about the estimate
// by t(B − 1) / z · √(B / (B − 1)) for B blocks (the small-sample correction of a mean's interval).
// Pair differences carry their own level (`pairLevel`: the claim state's Bonferroni level,
// 1 − 0.05 / pairs), so a pair is "separated" only at the level a ranking claim is made at.

/** Blocks from which a block bootstrap widens the intervals (design §6.2). */
export const MIN_BOOTSTRAP_BLOCKS = 5;
export const LEVEL = 0.95;

export interface RateOptions {
  /** The level of strength and mean-rank intervals (and, by default, pair intervals). */
  readonly level?: number;
  /** The level of the pair differences' intervals (default `level`). */
  readonly pairLevel?: number;
  /** Blocks from which the bootstrap runs (default `MIN_BOOTSTRAP_BLOCKS`). */
  readonly minBlocks?: number;
}

/** One rated match: its bootstrap block, its ranking (item indices, best first) and their ranks. */
export interface RankedMatch {
  readonly block: string;
  readonly ranking: Ranking;
  readonly ranks: readonly number[];
}

export interface Rated {
  /** Centred MAP strengths, by item. */
  readonly strength: number[];
  readonly strengthIv: (StatsInterval | null)[];
  /** Mean rank of each item's seats (NaN without a seat). */
  readonly rank: number[];
  readonly rankIv: (StatsInterval | null)[];
  /** LLM pairs `a < b`: difference a − b and its interval. */
  readonly pairs: readonly {
    readonly a: number;
    readonly b: number;
    readonly difference: number;
    readonly interval: StatsInterval | null;
  }[];
  readonly method: "laplace+block-bootstrap" | "laplace";
  readonly blocks: number;
  /** The bootstrap's own percentile intervals, before the union (the power simulation reads them). */
  readonly bootstrap: {
    readonly strengthIv: readonly (StatsInterval | null)[];
    readonly pairs: readonly (StatsInterval | null)[];
  } | null;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Percentile (linear between order statistics) of sorted values. */
function quantile(sorted: readonly number[], q: number): number {
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(sorted.length - 1, lo + 1);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (h - lo) * (b - a);
}

/** The central `level` interval of the finite values; null without one. */
export function percentileInterval(values: readonly number[], level = LEVEL): StatsInterval | null {
  const finite = values.filter((v) => Number.isFinite(v)).toSorted((a, b) => a - b);
  if (finite.length === 0) return null;
  const tail = (1 - level) / 2;
  return { lo: quantile(finite, tail), hi: quantile(finite, 1 - tail) };
}

const at = (xs: readonly number[], i: number): number => xs[i] ?? 0;

/** The standard normal quantile of `1 − tail` (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lowTail = 0.02425;
  if (p < lowTail) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q +
        at(c, 5)) /
      ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1)
    );
  }
  if (p > 1 - lowTail) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((at(a, 0) * r + at(a, 1)) * r + at(a, 2)) * r + at(a, 3)) * r + at(a, 4)) * r + at(a, 5)) *
      q) /
    (((((at(b, 0) * r + at(b, 1)) * r + at(b, 2)) * r + at(b, 3)) * r + at(b, 4)) * r + 1)
  );
}

/** The quantile of Student's t with `df` degrees of freedom at `p` (Cornish–Fisher, |error| < 0.01 from 4 df). */
export function tQuantile(p: number, df: number): number {
  const z = normalQuantile(p);
  const z3 = z ** 3;
  const z5 = z ** 5;
  const z7 = z ** 7;
  return (
    z +
    (z3 + z) / (4 * df) +
    (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) +
    (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3)
  );
}

/** How much a percentile bootstrap interval over `blocks` blocks is widened (1 at many blocks). */
export function smallSampleFactor(blocks: number, level = LEVEL): number {
  if (blocks < 2) return 1;
  const p = 1 - (1 - level) / 2;
  return (tQuantile(p, blocks - 1) / normalQuantile(p)) * Math.sqrt(blocks / (blocks - 1));
}

/** The union of two intervals (either may be missing). */
function union(a: StatsInterval | null, b: StatsInterval | null): StatsInterval | null {
  if (a === null) return b;
  if (b === null) return a;
  return { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) };
}

/** Strengths minus the mean over the LLM items (over every item without one). */
function centred(theta: readonly number[], llm: readonly number[]): number[] {
  const over = llm.length > 0 ? llm : theta.map((_, i) => i);
  const mean = over.reduce((s, i) => s + (theta[i] ?? 0), 0) / Math.max(1, over.length);
  return theta.map((t) => t - mean);
}

/** Mean rank per item over these matches (NaN where the item has no seat). */
function meanRanks(n: number, matches: readonly RankedMatch[]): number[] {
  const sum = Array.from({ length: n }, () => 0);
  const count = Array.from({ length: n }, () => 0);
  for (const m of matches) {
    for (const [k, i] of m.ranking.entries()) {
      sum[i] = (sum[i] ?? 0) + (m.ranks[k] ?? 0);
      count[i] = (count[i] ?? 0) + 1;
    }
  }
  return sum.map((s, i) => ((count[i] ?? 0) === 0 ? Number.NaN : s / (count[i] ?? 1)));
}

/**
 * Rates `n` items (`llm`: the LLM ones) over ranked matches; `rng` draws the bootstrap's blocks.
 * Deterministic for a given rng seed.
 */
export function rateMatches(
  n: number,
  llm: readonly number[],
  matches: readonly RankedMatch[],
  rng: Rng,
  replicates: number,
  o: RateOptions = {},
): Rated {
  const level = o.level ?? LEVEL;
  const pairLevel = o.pairLevel ?? level;
  const fit = fitPlackettLuce(
    n,
    matches.map((m) => m.ranking),
    { sigma: PRIOR_SIGMA },
  );
  const strength = centred(fit.theta, llm);
  const rank = meanRanks(n, matches);
  const blocks = [...new Set(matches.map((m) => m.block))].toSorted(byText);
  const byBlock = new Map<string, RankedMatch[]>();
  for (const m of matches) byBlock.set(m.block, [...(byBlock.get(m.block) ?? []), m]);
  const pairs: [number, number][] = [];
  for (const [k, a] of llm.entries()) for (const b of llm.slice(k + 1)) pairs.push([a, b]);
  // Laplace: the covariance of the centred strengths, A Σ Aᵀ with A = I − (1/L) 1 e_Lᵀ.
  const z = normalQuantile(1 - (1 - level) / 2);
  const zPair = normalQuantile(1 - (1 - pairLevel) / 2);
  const cov = fit.cov;
  const over = llm.length > 0 ? llm : Array.from({ length: n }, (_, i) => i);
  const c = (i: number, j: number): number => cov[i]?.[j] ?? 0;
  const rowMean = (i: number): number => over.reduce((s, l) => s + c(i, l), 0) / over.length;
  const all = over.reduce((s, l) => s + rowMean(l), 0) / over.length;
  const laplace = strength.map((s, i): StatsInterval => {
    const sd = Math.sqrt(Math.max(0, c(i, i) - 2 * rowMean(i) + all));
    return { lo: s - z * sd, hi: s + z * sd };
  });
  const laplacePairs = pairs.map(([a, b]): StatsInterval => {
    const sd = Math.sqrt(Math.max(0, c(a, a) + c(b, b) - 2 * c(a, b)));
    const d = (strength[a] ?? 0) - (strength[b] ?? 0);
    return { lo: d - zPair * sd, hi: d + zPair * sd };
  });
  const difference = ([a, b]: readonly [number, number]): number =>
    (strength[a] ?? 0) - (strength[b] ?? 0);
  const bootstrap = blocks.length >= (o.minBlocks ?? MIN_BOOTSTRAP_BLOCKS) && replicates > 0;
  if (!bootstrap) {
    return {
      strength,
      strengthIv: laplace,
      rank,
      rankIv: strength.map(() => null),
      pairs: pairs.map((ab, k) => ({
        a: ab[0],
        b: ab[1],
        difference: difference(ab),
        interval: laplacePairs[k] ?? null,
      })),
      method: "laplace",
      blocks: blocks.length,
      bootstrap: null,
    };
  }
  const samples: number[][] = Array.from({ length: n }, () => []);
  const rankSamples: number[][] = Array.from({ length: n }, () => []);
  const pairSamples: number[][] = pairs.map(() => []);
  for (let r = 0; r < replicates; r += 1) {
    const drawn: RankedMatch[] = [];
    for (let b = 0; b < blocks.length; b += 1) {
      drawn.push(...(byBlock.get(blocks[randInt(rng, 0, blocks.length - 1)] ?? "") ?? []));
    }
    const f = fitPlackettLuce(
      n,
      drawn.map((m) => m.ranking),
      { sigma: PRIOR_SIGMA, start: fit.theta, covariance: false },
    );
    const s = centred(f.theta, llm);
    const mr = meanRanks(n, drawn);
    for (let i = 0; i < n; i += 1) {
      samples[i]?.push(s[i] ?? 0);
      rankSamples[i]?.push(mr[i] ?? Number.NaN);
    }
    for (const [k, [a, b]] of pairs.entries()) pairSamples[k]?.push((s[a] ?? 0) - (s[b] ?? 0));
  }
  const bootStrength = samples.map((v) => percentileInterval(v, level));
  const bootPairs = pairs.map((_, k) => percentileInterval(pairSamples[k] ?? [], pairLevel));
  const widen = smallSampleFactor(blocks.length, level);
  return {
    strength,
    strengthIv: strength.map((_, i) => union(laplace[i] ?? null, bootStrength[i] ?? null)),
    rank,
    rankIv: rankSamples.map((v, i) => {
      const iv = percentileInterval(v, level);
      const x = rank[i] ?? Number.NaN;
      if (iv === null || !Number.isFinite(x)) return iv;
      return { lo: x - widen * Math.max(0, x - iv.lo), hi: x + widen * Math.max(0, iv.hi - x) };
    }),
    pairs: pairs.map((ab, k) => ({
      a: ab[0],
      b: ab[1],
      difference: difference(ab),
      interval: union(laplacePairs[k] ?? null, bootPairs[k] ?? null),
    })),
    method: "laplace+block-bootstrap",
    blocks: blocks.length,
    bootstrap: { strengthIv: bootStrength, pairs: bootPairs },
  };
}
