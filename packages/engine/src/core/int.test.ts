import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  assertSafeInt,
  cas,
  ceilDiv,
  clamp,
  floorDiv,
  ipow,
  isqrt,
  lossPm,
  mulDiv,
  rdiv,
} from "./int.ts";

const MAX = Number.MAX_SAFE_INTEGER;
const P26 = 67_108_864;
const P27 = 134_217_728;
const P30 = 1_073_741_824;
const P40 = 1_099_511_627_776;
const P52 = 4_503_599_627_370_496;
const safeInt = fc.integer({ min: -MAX, max: MAX });
const nonZero = safeInt.filter((n) => n !== 0);

/** Exact floor division over BigInt (BigInt division truncates toward zero). */
function bigFloorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function bigCeilDiv(a: bigint, b: bigint): bigint {
  return -bigFloorDiv(-a, b);
}

/** Largest s with s² ≤ n, by Newton's method on BigInt. */
function bigIsqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

describe("assertSafeInt", () => {
  test("returns safe integers and rejects everything else", () => {
    expect(assertSafeInt(0)).toBe(0);
    expect(assertSafeInt(-MAX)).toBe(-MAX);
    for (const bad of [0.5, Number.NaN, Number.POSITIVE_INFINITY, MAX + 1, -MAX - 1]) {
      expect(() => assertSafeInt(bad, "x")).toThrow(RangeError);
    }
    expect(() => assertSafeInt(1.5, "stock")).toThrow("stock must be a safe integer, got 1.5");
  });
});

describe("floorDiv and ceilDiv", () => {
  test("match BigInt floor and ceiling for every safe pair", () => {
    fc.assert(
      fc.property(safeInt, nonZero, (a, b) => {
        expect(floorDiv(a, b)).toBe(Number(bigFloorDiv(BigInt(a), BigInt(b))));
        expect(ceilDiv(a, b)).toBe(Number(bigCeilDiv(BigInt(a), BigInt(b))));
      }),
      { numRuns: 5000 },
    );
  });

  test("ceilDiv equals the ruleset definition floor((a + b − 1) / b) for a ≥ 0, b > 0", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: P40 }), fc.integer({ min: 1, max: P40 }), (a, b) => {
        expect(ceilDiv(a, b)).toBe(floorDiv(a + b - 1, b));
        expect(ceilDiv(a, b) * b).toBeGreaterThanOrEqual(a);
        expect((ceilDiv(a, b) - 1) * b).toBeLessThan(a === 0 ? 1 : a);
      }),
    );
  });

  test("edge values", () => {
    expect(floorDiv(7, 2)).toBe(3);
    expect(floorDiv(-7, 2)).toBe(-4);
    expect(floorDiv(7, -2)).toBe(-4);
    expect(floorDiv(-7, -2)).toBe(3);
    expect(ceilDiv(7, 2)).toBe(4);
    expect(ceilDiv(-7, 2)).toBe(-3);
    expect(ceilDiv(0, 5)).toBe(0);
    expect(Object.is(ceilDiv(-1, 5), 0)).toBe(true);
    expect(Object.is(floorDiv(0, -5), 0)).toBe(true);
    expect(floorDiv(MAX, 1)).toBe(MAX);
    expect(floorDiv(MAX, MAX - 1)).toBe(1);
    expect(ceilDiv(MAX - 1, MAX)).toBe(1);
    // §7.3: 290 gold missing at +310 gold/h.
    expect(ceilDiv(290 * 3600, 310)).toBe(3368);
  });

  test("reject a zero divisor and non-integers", () => {
    expect(() => floorDiv(1, 0)).toThrow(RangeError);
    expect(() => ceilDiv(1, 0)).toThrow(RangeError);
    expect(() => floorDiv(1.5, 2)).toThrow(RangeError);
    expect(() => ceilDiv(1, 0.5)).toThrow(RangeError);
    expect(() => floorDiv(MAX + 1, 2)).toThrow(RangeError);
  });
});

describe("rdiv", () => {
  test("equals sign(n) · floor((2·|n| + d) / (2d)) over BigInt", () => {
    fc.assert(
      fc.property(safeInt, fc.integer({ min: 1, max: MAX }), (n, d) => {
        const abs = BigInt(Math.abs(n));
        const big = BigInt(d);
        const magnitude = (2n * abs + big) / (2n * big);
        expect(rdiv(n, d)).toBe(Number(n < 0 ? -magnitude : magnitude));
      }),
      { numRuns: 5000 },
    );
  });

  test("rounds half away from zero and is odd-symmetric", () => {
    expect(rdiv(5, 2)).toBe(3);
    expect(rdiv(-5, 2)).toBe(-3);
    expect(rdiv(4, 3)).toBe(1);
    expect(rdiv(-4, 3)).toBe(-1);
    expect(rdiv(15000, 10000)).toBe(2);
    expect(rdiv(14999, 10000)).toBe(1);
    expect(Object.is(rdiv(-1, 3), 0)).toBe(true);
    fc.assert(
      fc.property(safeInt, fc.integer({ min: 1, max: P30 }), (n, d) => {
        expect(rdiv(-n, d)).toBe(-rdiv(n, d) || 0);
        // |n/d − rdiv(n, d)| ≤ 1/2, i.e. |2n − 2d·rdiv| ≤ d, checked exactly.
        const error = 2n * BigInt(n) - 2n * BigInt(d) * BigInt(rdiv(n, d));
        expect(error <= BigInt(d) && -error <= BigInt(d)).toBe(true);
      }),
    );
  });

  test("rejects a divisor ≤ 0", () => {
    expect(() => rdiv(1, 0)).toThrow(RangeError);
    expect(() => rdiv(1, -2)).toThrow(RangeError);
  });
});

describe("isqrt", () => {
  test("is exact against BigInt for random n < 2^52", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: P52 - 1 }), (n) => {
        expect(isqrt(n)).toBe(Number(bigIsqrt(BigInt(n))));
      }),
      { numRuns: 20000 },
    );
  });

  test("is exact around perfect squares, up to MAX_SAFE_INTEGER", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 94906265 }), (s) => {
        const square = s * s;
        expect(isqrt(square)).toBe(s);
        if (square > 0) expect(isqrt(square - 1)).toBe(s - 1);
        if (square + 2 * s <= MAX) expect(isqrt(square + 2 * s)).toBe(s);
      }),
      { numRuns: 20000 },
    );
    for (const n of [0, 1, 2, 3, 4, 8, 9, 10, MAX, MAX - 1, 9007199136250225, 9007199136250224]) {
      expect(isqrt(n)).toBe(Number(bigIsqrt(BigInt(n))));
    }
    // perfidia-1 §8.12: isqrt(60² · 90²).
    expect(isqrt(3600 * 8100)).toBe(5400);
  });

  test("rejects negative and non-integer arguments", () => {
    expect(() => isqrt(-1)).toThrow(RangeError);
    expect(() => isqrt(2.5)).toThrow(RangeError);
  });
});

describe("ipow", () => {
  test("is exact against BigInt, and throws beyond the safe range", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100, max: 100 }), fc.integer({ min: 0, max: 64 }), (b, e) => {
        const exact = BigInt(b) ** BigInt(e);
        if (exact <= BigInt(MAX) && exact >= -BigInt(MAX)) expect(ipow(b, e)).toBe(Number(exact));
        else expect(() => ipow(b, e)).toThrow(RangeError);
      }),
      { numRuns: 5000 },
    );
  });

  test("edge values", () => {
    expect(ipow(2, 32)).toBe(4294967296);
    expect(ipow(2, 52)).toBe(4503599627370496);
    expect(() => ipow(2, 53)).toThrow(RangeError);
    expect(ipow(-2, 53 - 1)).toBe(4503599627370496);
    expect(ipow(3, 33)).toBe(5559060566555523);
    expect(() => ipow(3, 34)).toThrow(RangeError);
    expect(ipow(10, 15)).toBe(1000000000000000);
    expect(() => ipow(10, 16)).toThrow(RangeError);
    expect(ipow(0, 0)).toBe(1);
    expect(ipow(0, 5)).toBe(0);
    expect(ipow(1, MAX)).toBe(1);
    expect(ipow(-1, MAX)).toBe(-1);
    expect(ipow(-1, MAX - 1)).toBe(1);
    expect(ipow(MAX, 1)).toBe(MAX);
    expect(() => ipow(MAX, 2)).toThrow(RangeError);
    expect(() => ipow(2, -1)).toThrow(RangeError);
    expect(() => ipow(2, 0.5)).toThrow(RangeError);
  });
});

describe("clamp", () => {
  test("limits to the bounds", () => {
    fc.assert(
      fc.property(safeInt, safeInt, safeInt, (x, a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const c = clamp(x, lo, hi);
        expect(c).toBe(Math.min(Math.max(x, lo), hi));
      }),
    );
    expect(clamp(5, 7, 10)).toBe(7);
    expect(clamp(12, 7, 10)).toBe(10);
    expect(clamp(8, 7, 10)).toBe(8);
    expect(() => clamp(1, 3, 2)).toThrow(RangeError);
    expect(() => clamp(0.5, 0, 1)).toThrow(RangeError);
  });
});

describe("mulDiv", () => {
  test("equals floor(a·b / c) over BigInt whenever a·b is safe", () => {
    const factor = fc.integer({ min: -P26, max: P26 });
    fc.assert(
      fc.property(factor, factor, nonZero, (a, b, c) => {
        expect(mulDiv(a, b, c)).toBe(Number(bigFloorDiv(BigInt(a) * BigInt(b), BigInt(c))));
      }),
      { numRuns: 5000 },
    );
  });

  test("throws when the product is not a safe integer, or on a zero divisor", () => {
    expect(mulDiv(3600, 1210, 7)).toBe(622285);
    expect(() => mulDiv(P27, P26, 3)).toThrow(RangeError);
    expect(() => mulDiv(1, 1, 0)).toThrow(RangeError);
  });
});

describe("lossPm and cas (perfidia-1 §1.2, §8)", () => {
  test("reproduce the ruleset's worked values", () => {
    expect(lossPm(1, 2)).toBe(250);
    expect(lossPm(250, 320)).toBe(609);
    expect(lossPm(4704, 5760)).toBe(665);
    expect(lossPm(1115, 2400)).toBe(215);
    expect(lossPm(150, 200)).toBe(562);
    expect(lossPm(957, 1200)).toBe(635);
    expect(cas(8, 609)).toBe(5);
    expect(cas(360, 665)).toBe(239);
    expect(cas(1, 665)).toBe(1);
  });

  test("reproduce the §8.3 table and tie rule", () => {
    expect(lossPm(1, 2)).toBe(250);
    expect(lossPm(2, 3)).toBe(443);
    expect(lossPm(1, 3)).toBe(110);
    expect(lossPm(3, 4)).toBe(562);
    expect(lossPm(100, 141)).toBe(502);
    expect(lossPm(70, 70)).toBe(1000);
    expect(lossPm(0, 70)).toBe(0);
  });

  test("match their definitions and bounds", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4_000_000_000 }), fc.nat(), (W, seed) => {
        const L = seed % (W + 1);
        const r = (1000n * BigInt(L)) / BigInt(W);
        const q = lossPm(L, W);
        expect(q).toBe(Number((r * r) / 1000n));
        expect(q).toBeGreaterThanOrEqual(0);
        expect(q).toBeLessThanOrEqual(1000);
      }),
      { numRuns: 5000 },
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 1000 }),
        (n, q) => {
          const c = cas(n, q);
          expect(c).toBe(Number((BigInt(n) * BigInt(q) + 500n) / 1000n));
          expect(c).toBeLessThanOrEqual(n);
        },
      ),
      { numRuns: 5000 },
    );
  });

  test("reject arguments outside their domain", () => {
    expect(() => lossPm(3, 2)).toThrow(RangeError);
    expect(() => lossPm(0, 0)).toThrow(RangeError);
    expect(() => lossPm(-1, 2)).toThrow(RangeError);
    expect(() => cas(-1, 10)).toThrow(RangeError);
    expect(() => cas(10, 1001)).toThrow(RangeError);
    expect(() => cas(10, -1)).toThrow(RangeError);
    expect(() => cas(1.5, 10)).toThrow(RangeError);
  });
});
