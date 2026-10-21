// MAP Plackett–Luce (phase-4 design §6.2): each item i (a model, or a bot) has a log-strength θᵢ;
// a match's full ranking, best first, has the probability
//   Π_k exp(θ_{r_k}) / Σ_{j ≥ k} exp(θ_{r_j}),
// every seat an entry (two seats of one model are two entries of the same item). The prior is a
// Gaussian N(0, σ²) on every θᵢ (σ = 1.5), which keeps the fit finite when the comparison graph is
// not strongly connected (few matches, a bot always last). The log-posterior is strictly concave:
// Newton's method from θ = 0, with step halving, converges in a few iterations, deterministically.
// The Laplace approximation of the posterior covariance is the inverse of the negative Hessian at
// the mode. Under Plackett–Luce, P(i finishes ahead of j) = exp(θᵢ) / (exp(θᵢ) + exp(θⱼ)).

/** The prior's standard deviation on log-strengths (design §6.2). */
export const PRIOR_SIGMA = 1.5;

export interface PlFit {
  /** The MAP log-strengths. */
  readonly theta: number[];
  /** The posterior covariance (Laplace): the inverse of the negative Hessian at the mode. */
  readonly cov: number[][];
  readonly iterations: number;
}

/** A ranking: item indices of its seats, best first. */
export type Ranking = readonly number[];

interface Eval {
  readonly value: number;
  readonly grad: number[];
  /** The negative Hessian (positive definite). */
  readonly neg: number[][];
}

/** The log-posterior, its gradient and its negative Hessian at `theta`. */
function evaluate(
  n: number,
  rankings: readonly Ranking[],
  theta: readonly number[],
  sigma: number,
): Eval {
  const inv = 1 / (sigma * sigma);
  let value = 0;
  const grad = Array.from({ length: n }, () => 0);
  const neg: number[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
  for (let i = 0; i < n; i += 1) {
    const t = theta[i] ?? 0;
    value -= (t * t * inv) / 2;
    grad[i] = -t * inv;
    const row = neg[i];
    if (row !== undefined) row[i] = inv;
  }
  const q = Array.from({ length: n }, () => 0);
  for (const r of rankings) {
    for (let k = 0; k < r.length - 1; k += 1) {
      const top = r[k] ?? 0;
      // The stage's normaliser, from its largest exponent for stability.
      let max = Number.NEGATIVE_INFINITY;
      for (let e = k; e < r.length; e += 1) max = Math.max(max, theta[r[e] ?? 0] ?? 0);
      let z = 0;
      for (let e = k; e < r.length; e += 1) z += Math.exp((theta[r[e] ?? 0] ?? 0) - max);
      value += (theta[top] ?? 0) - max - Math.log(z);
      grad[top] = (grad[top] ?? 0) + 1;
      const touched: number[] = [];
      for (let e = k; e < r.length; e += 1) {
        const i = r[e] ?? 0;
        const p = Math.exp((theta[i] ?? 0) - max) / z;
        if ((q[i] ?? 0) === 0) touched.push(i);
        q[i] = (q[i] ?? 0) + p;
      }
      for (const a of touched) {
        const qa = q[a] ?? 0;
        grad[a] = (grad[a] ?? 0) - qa;
        const row = neg[a];
        if (row === undefined) continue;
        row[a] = (row[a] ?? 0) + qa;
        for (const b of touched) row[b] = (row[b] ?? 0) - qa * (q[b] ?? 0);
      }
      for (const a of touched) q[a] = 0;
    }
  }
  return { value, grad, neg };
}

/** The Cholesky factor L of a symmetric positive-definite matrix (`m = L Lᵀ`). */
function cholesky(m: readonly (readonly number[])[]): number[][] {
  const n = m.length;
  const l: number[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
  for (let i = 0; i < n; i += 1) {
    const li = l[i] ?? [];
    for (let j = 0; j <= i; j += 1) {
      const lj = l[j] ?? [];
      let s = m[i]?.[j] ?? 0;
      for (let k = 0; k < j; k += 1) s -= (li[k] ?? 0) * (lj[k] ?? 0);
      if (i === j) {
        if (!(s > 0)) throw new Error("Plackett–Luce: the Hessian is not positive definite");
        li[i] = Math.sqrt(s);
      } else {
        li[j] = s / (lj[j] ?? 1);
      }
    }
  }
  return l;
}

/** Solves `L Lᵀ x = b`. */
function solve(l: readonly (readonly number[])[], b: readonly number[]): number[] {
  const n = l.length;
  const y = Array.from({ length: n }, () => 0);
  for (let i = 0; i < n; i += 1) {
    let s = b[i] ?? 0;
    for (let k = 0; k < i; k += 1) s -= (l[i]?.[k] ?? 0) * (y[k] ?? 0);
    y[i] = s / (l[i]?.[i] ?? 1);
  }
  const x = Array.from({ length: n }, () => 0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = y[i] ?? 0;
    for (let k = i + 1; k < n; k += 1) s -= (l[k]?.[i] ?? 0) * (x[k] ?? 0);
    x[i] = s / (l[i]?.[i] ?? 1);
  }
  return x;
}

/** The inverse of a symmetric positive-definite matrix. */
function inverse(m: readonly (readonly number[])[]): number[][] {
  const l = cholesky(m);
  const n = m.length;
  const cols = Array.from({ length: n }, (_, j) =>
    solve(
      l,
      Array.from({ length: n }, (_x, i) => (i === j ? 1 : 0)),
    ),
  );
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_x, j) => cols[j]?.[i] ?? 0),
  );
}

export interface PlOptions {
  readonly sigma?: number;
  /** Where Newton starts (default θ = 0); the bootstrap starts from the full fit. */
  readonly start?: readonly number[];
  readonly maxIterations?: number;
  /** Skip the covariance (the bootstrap's replicates need only θ). */
  readonly covariance?: boolean;
}

/** The MAP fit of `n` items to `rankings` (items absent from every ranking keep θ = 0). */
export function fitPlackettLuce(n: number, rankings: readonly Ranking[], o: PlOptions = {}): PlFit {
  const sigma = o.sigma ?? PRIOR_SIGMA;
  const max = o.maxIterations ?? 100;
  let theta = Array.from({ length: n }, (_, i) => o.start?.[i] ?? 0);
  let cur = evaluate(n, rankings, theta, sigma);
  let iterations = 0;
  for (; iterations < max; iterations += 1) {
    const step = solve(cholesky(cur.neg), cur.grad);
    let scale = 1;
    let next = theta.map((t, i) => t + (step[i] ?? 0));
    let ev = evaluate(n, rankings, next, sigma);
    // Halve the step until the posterior does not decrease (concave: a full step nearly always does).
    while (ev.value < cur.value - 1e-12 && scale > 1e-6) {
      scale /= 2;
      next = theta.map((t, i) => t + scale * (step[i] ?? 0));
      ev = evaluate(n, rankings, next, sigma);
    }
    const moved = step.reduce((m, s) => Math.max(m, Math.abs(s * scale)), 0);
    theta = next;
    cur = ev;
    if (moved < 1e-10) {
      iterations += 1;
      break;
    }
  }
  return {
    theta,
    cov: o.covariance === false ? [] : inverse(cur.neg),
    iterations,
  };
}

/** A ranking drawn from Plackett–Luce with log-strengths `theta` (`u`: uniform draws in (0, 1)). */
export function samplePlackettLuce(
  items: readonly number[],
  theta: readonly number[],
  u: () => number,
): number[] {
  const left = [...items];
  const out: number[] = [];
  while (left.length > 0) {
    const w = left.map((i) => Math.exp(theta[i] ?? 0));
    const total = w.reduce((a, b) => a + b, 0);
    let x = u() * total;
    let pick = left.length - 1;
    for (let k = 0; k < left.length; k += 1) {
      x -= w[k] ?? 0;
      if (x < 0) {
        pick = k;
        break;
      }
    }
    out.push(left[pick] ?? 0);
    left.splice(pick, 1);
  }
  return out;
}
