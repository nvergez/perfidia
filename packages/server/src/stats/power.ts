// How many matches before any claim (phase-4 design §6.4). Each match gives one head-to-head result
// per pair of LLM seats (ranks have no ties), so a pair's record is binomial. A claim that one model
// beats another is an exact two-sided binomial test of p = 0.5 at α (Bonferroni: 0.05 / the pairs
// compared); its power at a true head-to-head p is the probability of rejecting. The matches a gap
// needs are the smallest n whose power reaches 80% (the design's 20 / 49 / 199 for one pair at
// 80/20, 70/30, 60/40; 32 / 74 / 303 for six pairs). The power of the exact test is a sawtooth in n:
// a few n above the threshold fall back under 80% (70/30, one pair: 50 and 53, while 51 and 52
// reach it), so the achieved power is reported as it is.

/** The design's claimed gap and the power it asks for. */
export const CLAIM_GAP = { label: "70/30", p: 0.7 } as const;
export const CLAIM_POWER = 0.8;
export const CLAIM_ALPHA = 0.05;
/** The gaps of the design's table. */
export const GAPS: readonly { readonly label: string; readonly p: number }[] = [
  { label: "80/20", p: 0.8 },
  { label: "70/30", p: 0.7 },
  { label: "60/40", p: 0.6 },
];

/** The binomial probabilities of 0…n successes at `p`, from logarithms. */
function pmf(n: number, p: number): number[] {
  const out: number[] = [];
  let logC = 0;
  for (let k = 0; k <= n; k += 1) {
    if (k > 0) logC += Math.log(n - k + 1) - Math.log(k);
    out.push(Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p)));
  }
  return out;
}

/**
 * The power of the exact two-sided binomial test of p = 0.5 at level `alpha` with `n` trials, when
 * the true probability is `p`: reject when X ≤ c or X ≥ n − c, c the largest with P₀(X ≤ c) ≤ α/2.
 */
export function binomialPower(n: number, p: number, alpha: number): number {
  if (n <= 0) return 0;
  const null0 = pmf(n, 0.5);
  let cum = 0;
  let c = -1;
  for (let k = 0; k <= n; k += 1) {
    cum += null0[k] ?? 0;
    if (cum <= alpha / 2 + 1e-12) c = k;
    else break;
  }
  if (c < 0) return 0;
  const alt = pmf(n, p);
  let power = 0;
  for (let k = 0; k <= c; k += 1) power += (alt[k] ?? 0) + (alt[n - k] ?? 0);
  return Math.min(1, power);
}

/** The smallest n whose power reaches `power` (searching up to `max`; `max` + 1 when none does). */
export function matchesNeeded(p: number, alpha: number, power = CLAIM_POWER, max = 5000): number {
  for (let n = 1; n <= max; n += 1) if (binomialPower(n, p, alpha) >= power) return n;
  return max + 1;
}

const memo = new Map<string, number>();

/** `matchesNeeded`, memoised by gap and pairs. */
export function neededFor(p: number, pairs: number): number {
  const key = `${p}:${pairs}`;
  let n = memo.get(key);
  if (n === undefined) {
    n = matchesNeeded(p, CLAIM_ALPHA / Math.max(1, pairs));
    memo.set(key, n);
  }
  return n;
}
