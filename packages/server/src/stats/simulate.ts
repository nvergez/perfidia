import { mulberry32, streamRng, type Rng } from "@perfidia/engine/core";
import { samplePlackettLuce } from "./pl.ts";
import { CLAIM_ALPHA, binomialPower } from "./power.ts";
import { rateMatches, type RankedMatch } from "./rate.ts";

// The power simulation of design §6.4, over synthetic strengths: series of matches drawn from a
// Plackett–Luce model with known log-strengths (four LLM models and two bots, one seat each, as in a
// comparison lineup), rated by the same pipeline as real matches (`rate.ts`), to state how many
// matches a 70/30 head-to-head claim needs with the real estimator. Models A and B differ by
// ln(p / (1 − p)) (so A finishes ahead of B with probability p, a property of Plackett–Luce), the
// other two models and both bots sit between them at 0. For each series length, `reps` series are
// drawn; a claim is made when:
// - binomial: the exact two-sided binomial test on A's head-to-head record against B rejects
//   p = 0.5 at α (one pair) or α / 6 (six pairs, Bonferroni);
// - pipeline: the interval of the strength difference A − B excludes 0, at 95% (one pair) or
//   1 − 0.05 / 6 (six pairs), from the block bootstrap (blocks of 4 matches, as a rotation series'),
//   or from Laplace intervals.
// The fraction of series with a claim is the power. Deterministic for a seed.

export interface PowerOptions {
  /** A's head-to-head probability against B (0.7 for 70/30). */
  readonly p: number;
  /** Series lengths, in matches. */
  readonly matches: readonly number[];
  readonly reps: number;
  /** Bootstrap replicates per series (0: Laplace intervals only). */
  readonly replicates: number;
  readonly seed: number;
  /** Matches per block (4: a rotation block of four models). */
  readonly blockSize?: number;
}

export interface PowerRow {
  readonly matches: number;
  /** The exact binomial power (no simulation), one pair and six pairs. */
  readonly exact: { readonly one: number; readonly six: number };
  /** Simulated: the binomial test on the drawn head-to-head records. */
  readonly binomial: { readonly one: number; readonly six: number };
  /** Simulated: the pipeline's Laplace intervals on the difference. */
  readonly laplace: { readonly one: number; readonly six: number };
  /** Simulated: the pipeline's block-bootstrap interval (one pair, 95%); null without replicates. */
  readonly bootstrap: number | null;
}

/** Items: A, B, C, D (LLM models), then two bots. */
const ITEMS = [0, 1, 2, 3, 4, 5];
const LLM = [0, 1, 2, 3];

/** The binomial test's rejection: X ≤ c or X ≥ n − c at level α, from the null pmf. */
function rejects(ahead: number, n: number, alpha: number): boolean {
  if (n === 0) return false;
  let logC = 0;
  let cum = 0;
  let c = -1;
  for (let k = 0; k <= n; k += 1) {
    if (k > 0) logC += Math.log(n - k + 1) - Math.log(k);
    cum += Math.exp(logC - n * Math.LN2);
    if (cum <= alpha / 2 + 1e-12) c = k;
    else break;
  }
  return c >= 0 && (ahead <= c || ahead >= n - c);
}

/** An interval that excludes 0: a claim. */
const excludes = (x: { readonly lo: number; readonly hi: number } | null): boolean =>
  x !== null && (x.lo > 0 || x.hi < 0);

const uniform =
  (rng: Rng): (() => number) =>
  () =>
    (rng.nextU32() + 0.5) / 4_294_967_296;

/** The simulated power of each series length. */
export function simulatePower(o: PowerOptions): PowerRow[] {
  const delta = Math.log(o.p / (1 - o.p));
  const theta = [delta / 2, -delta / 2, 0, 0, 0, 0];
  const block = o.blockSize ?? 4;
  const six = CLAIM_ALPHA / 6;
  return o.matches.map((n): PowerRow => {
    const draw = uniform(streamRng(o.seed >>> 0, `draw:${n}`));
    const boot = mulberry32(o.seed >>> 0);
    let binOne = 0;
    let binSix = 0;
    let lapOne = 0;
    let lapSix = 0;
    let bootOne = 0;
    for (let r = 0; r < o.reps; r += 1) {
      const matches: RankedMatch[] = [];
      let ahead = 0;
      for (let m = 0; m < n; m += 1) {
        const ranking = samplePlackettLuce(ITEMS, theta, draw);
        if (ranking.indexOf(0) < ranking.indexOf(1)) ahead += 1;
        matches.push({
          block: `b${Math.floor(m / block)}`,
          ranking,
          ranks: ranking.map((_, k) => k + 1),
        });
      }
      if (rejects(ahead, n, CLAIM_ALPHA)) binOne += 1;
      if (rejects(ahead, n, six)) binSix += 1;
      const lap = rateMatches(6, LLM, matches, boot, 0);
      if (excludes(lap.pairs[0]?.interval ?? null)) lapOne += 1;
      const lap6 = rateMatches(6, LLM, matches, boot, 0, 1 - six);
      if (excludes(lap6.pairs[0]?.interval ?? null)) lapSix += 1;
      if (o.replicates > 0) {
        const bs = rateMatches(6, LLM, matches, boot, o.replicates);
        if (excludes(bs.pairs[0]?.interval ?? null)) bootOne += 1;
      }
    }
    const share = (k: number): number => Math.round((k * 1000) / Math.max(1, o.reps)) / 1000;
    return {
      matches: n,
      exact: {
        one: Math.round(binomialPower(n, o.p, CLAIM_ALPHA) * 1000) / 1000,
        six: Math.round(binomialPower(n, o.p, six) * 1000) / 1000,
      },
      binomial: { one: share(binOne), six: share(binSix) },
      laplace: { one: share(lapOne), six: share(lapSix) },
      bootstrap: o.replicates > 0 ? share(bootOne) : null,
    };
  });
}
