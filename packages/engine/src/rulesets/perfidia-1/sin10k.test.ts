import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { cosT, normaliseAngle, SIN10K, sinT } from "./sin10k.ts";

// Regenerates SIN10K with exact integer arithmetic (no Math.sin, banned in the engine): π by
// Machin's formula and sin by its Taylor series, both in 60-digit BigInt fixed point.

const DIGITS = 60;
const ONE = (() => {
  let v = 1n;
  for (let i = 0; i < DIGITS; i += 1) v *= 10n;
  return v;
})();

/** `arctan(1/x)` in fixed point. */
function atanInverse(x: bigint): bigint {
  let sum = 0n;
  let power = ONE / x;
  const x2 = x * x;
  for (let k = 1n, sign = 1n; power !== 0n; k += 2n, sign = -sign) {
    sum += (sign * power) / k;
    power /= x2;
  }
  return sum;
}

const PI = 16n * atanInverse(5n) - 4n * atanInverse(239n);

/** `sin(x)` for x in fixed point, |x| ≤ π/2. */
function sinFixed(x: bigint): bigint {
  let sum = 0n;
  let term = x;
  for (let n = 1n; term !== 0n; n += 2n) {
    sum += term;
    term = (-term * x * x) / ONE / ONE / ((n + 1n) * (n + 2n));
  }
  return sum;
}

/** `round(10000 · sin(d/10 °))`, half up (only sin 30° = 1/2 is a rational tie, and it is exact). */
function expectedSin10k(d: number): number {
  const scaled = sinFixed((PI * BigInt(d)) / 1800n) * 10000n;
  return Number((scaled + ONE / 2n) / ONE);
}

describe("SIN10K", () => {
  test("has 901 entries and the spot checks of perfidia-1 §2.2", () => {
    expect(SIN10K).toHaveLength(901);
    expect(SIN10K[0]).toBe(0);
    expect(SIN10K[300]).toBe(5000);
    expect(SIN10K[450]).toBe(7071);
    expect(SIN10K[600]).toBe(8660);
    expect(SIN10K[900]).toBe(10000);
  });

  test("is regenerated exactly by integer arithmetic", () => {
    const regenerated = Array.from({ length: 901 }, (_, d) => expectedSin10k(d));
    expect([...SIN10K]).toEqual(regenerated);
  });

  test("is frozen and non-decreasing", () => {
    expect(Object.isFrozen(SIN10K)).toBe(true);
    for (let d = 1; d <= 900; d += 1) expect(SIN10K[d]!).toBeGreaterThanOrEqual(SIN10K[d - 1]!);
  });
});

describe("sinT and cosT", () => {
  test("follow the quadrant rules of §2.2", () => {
    expect(sinT(0)).toBe(0);
    expect(sinT(900)).toBe(10000);
    expect(sinT(1800)).toBe(0);
    expect(sinT(2700)).toBe(-10000);
    expect(sinT(3600)).toBe(0);
    expect(sinT(1500)).toBe(SIN10K[300]!);
    expect(sinT(2100)).toBe(-SIN10K[300]!);
    expect(sinT(3300)).toBe(-SIN10K[300]!);
    expect(cosT(0)).toBe(10000);
    expect(cosT(600)).toBe(5000);
    expect(cosT(1800)).toBe(-10000);
  });

  test("are periodic, odd/even and phase-shifted (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100000, max: 100000 }), (a) => {
        expect(sinT(a + 3600)).toBe(sinT(a));
        expect(sinT(-a)).toBe(-sinT(a) || 0);
        expect(cosT(-a)).toBe(cosT(a));
        expect(sinT(1800 - a)).toBe(sinT(a));
        expect(cosT(a)).toBe(sinT(a + 900));
        expect(normaliseAngle(a)).toBeGreaterThanOrEqual(0);
        expect(normaliseAngle(a)).toBeLessThan(3600);
      }),
    );
  });

  test("reject non-integer angles", () => {
    expect(() => sinT(1.5)).toThrow(RangeError);
  });
});
