// Exact integer helpers (docs/architecture.md §6.1, perfidia-1 §1.2). Every input and output is a
// safe integer; a violated precondition throws a RangeError, which the kernel reports as an engine
// bug. No implementation-approximated maths: only `Math.floor`, `Math.ceil`, `Math.sqrt` (correctly
// rounded) and plain arithmetic whose operands and results stay below 2^53.

/** Returns `n` unchanged, or throws a RangeError naming `what` when `n` is not a safe integer. */
export function assertSafeInt(n: number, what = "value"): number {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} must be a safe integer, got ${n}`);
  return n;
}

function assertDivisor(b: number): void {
  assertSafeInt(b, "divisor");
  if (b === 0) throw new RangeError("division by zero");
}

/** Maps -0 to 0, so results compare and serialise like the integers they are. */
function noNegZero(n: number): number {
  return n === 0 ? 0 : n;
}

/**
 * `floor(a / b)` for safe integers, b ≠ 0, either sign. The float quotient is exact enough: for
 * |a| < 2^53 the rounding error is smaller than the distance 1/|b| to the next integer.
 */
export function floorDiv(a: number, b: number): number {
  assertSafeInt(a, "dividend");
  assertDivisor(b);
  return noNegZero(Math.floor(a / b));
}

/** `ceil(a / b)` for safe integers, b ≠ 0, either sign; equals `floor((a + b − 1) / b)` for a ≥ 0, b > 0. */
export function ceilDiv(a: number, b: number): number {
  assertSafeInt(a, "dividend");
  assertDivisor(b);
  return noNegZero(Math.ceil(a / b));
}

/**
 * `sign(n) · floor((2·|n| + d) / (2d))` for d > 0: n / d rounded half away from zero. Computed
 * through the remainder, so `2·|n| + d` never has to fit in a safe integer.
 */
export function rdiv(n: number, d: number): number {
  assertSafeInt(n, "numerator");
  assertSafeInt(d, "divisor");
  if (d <= 0) throw new RangeError(`rdiv divisor must be > 0, got ${d}`);
  const abs = Math.abs(n);
  const q = Math.floor(abs / d);
  const r = abs - q * d;
  const rounded = 2 * r >= d ? q + 1 : q;
  return noNegZero(n < 0 ? -rounded : rounded);
}

/** The largest s ≥ 0 with s² ≤ n: `floor(Math.sqrt(n))` corrected by ±1 until exact. */
export function isqrt(n: number): number {
  assertSafeInt(n, "isqrt argument");
  if (n < 0) throw new RangeError(`isqrt argument must be ≥ 0, got ${n}`);
  let s = Math.floor(Math.sqrt(n));
  while (s * s > n) s -= 1;
  while ((s + 1) * (s + 1) <= n) s += 1;
  return s;
}

/** `b^e` by repeated multiplication, e ≥ 0; throws when the result is not a safe integer. */
export function ipow(b: number, e: number): number {
  assertSafeInt(b, "base");
  assertSafeInt(e, "exponent");
  if (e < 0) throw new RangeError(`exponent must be ≥ 0, got ${e}`);
  if (e === 0 || b === 1) return 1;
  if (b === 0) return 0;
  if (b === -1) return e % 2 === 0 ? 1 : -1;
  // |b| ≥ 2 leaves the safe range after at most 53 steps, so the loop is short.
  let result = 1;
  for (let i = 0; i < e; i += 1) {
    result *= b;
    if (!Number.isSafeInteger(result)) {
      throw new RangeError(`ipow(${b}, ${e}) exceeds the safe integer range`);
    }
  }
  return result;
}

/** `x` limited to [lo, hi], safe integers with lo ≤ hi. */
export function clamp(x: number, lo: number, hi: number): number {
  assertSafeInt(x, "clamp value");
  assertSafeInt(lo, "clamp lower bound");
  assertSafeInt(hi, "clamp upper bound");
  if (lo > hi) throw new RangeError(`clamp bounds out of order: ${lo} > ${hi}`);
  return x < lo ? lo : x > hi ? hi : x;
}

/** `floor(a · b / c)`, asserting that the product `a · b` is a safe integer. */
export function mulDiv(a: number, b: number, c: number): number {
  assertSafeInt(a, "mulDiv factor");
  assertSafeInt(b, "mulDiv factor");
  return floorDiv(assertSafeInt(a * b, `mulDiv product ${a}·${b}`), c);
}

/**
 * Square-law loss in per mille (perfidia-1 §1.2), for 0 ≤ L ≤ W and W > 0:
 * `r = floor(1000·L / W)`, result `floor(r·r / 1000)`, ≈ 1000·(L/W)², in 0..1000.
 */
export function lossPm(L: number, W: number): number {
  assertSafeInt(L, "loser strength");
  assertSafeInt(W, "winner strength");
  if (W <= 0 || L < 0 || L > W) {
    throw new RangeError(`lossPm needs 0 ≤ L ≤ W and W > 0, got L = ${L}, W = ${W}`);
  }
  const r = mulDiv(1000, L, W);
  return Math.floor((r * r) / 1000);
}

/** Casualties `floor((n·q + 500) / 1000)`: n units at q per mille, rounded half up (perfidia-1 §1.2). */
export function cas(n: number, q: number): number {
  assertSafeInt(n, "unit count");
  assertSafeInt(q, "per-mille rate");
  if (n < 0 || q < 0 || q > 1000) {
    throw new RangeError(`cas needs n ≥ 0 and 0 ≤ q ≤ 1000, got n = ${n}, q = ${q}`);
  }
  return floorDiv(assertSafeInt(n * q + 500, `cas numerator for n = ${n}`), 1000);
}
