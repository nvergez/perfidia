import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { fnv1a32, mulberry32, randInt, type Rng, shuffle, streamRng } from "./prng.ts";

const MASK32 = 0xffffffffn;

/**
 * mulberry32 written independently over unsigned BigInt arithmetic modulo 2^32: `Math.imul` is a
 * product modulo 2^32 and `>>>` an unsigned shift, so every step maps one to one.
 */
function referenceMulberry32(seed: number): () => number {
  let s = BigInt(seed);
  return () => {
    s = (s + 0x6d2b79f5n) & MASK32;
    let t = s;
    t = ((t ^ (t >> 15n)) * (t | 1n)) & MASK32;
    t = (t ^ ((t + (((t ^ (t >> 7n)) * (t | 61n)) & MASK32)) & MASK32)) & MASK32;
    return Number((t ^ (t >> 14n)) & MASK32);
  };
}

/** A fixed sequence of uint32 outputs, counting how many were drawn. */
function scripted(values: readonly number[]): Rng & { drawn: number } {
  const rng = {
    drawn: 0,
    nextU32(): number {
      const value = values[rng.drawn % values.length] ?? 0;
      rng.drawn += 1;
      return value;
    },
  };
  return rng;
}

const uint32 = fc.integer({ min: 0, max: 0xffffffff });
const byValue = (a: number, b: number): number => a - b;

/** Any UTF-16 string, lone surrogates included. */
const anyString = fc
  .array(
    fc.oneof(
      fc.string({ unit: "binary", maxLength: 4 }),
      fc.integer({ min: 0xd800, max: 0xdfff }).map((c) => String.fromCharCode(c)),
      fc.string({ maxLength: 8 }),
    ),
    { maxLength: 12 },
  )
  .map((parts) => parts.join(""));

describe("fnv1a32", () => {
  test("matches the standard vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
    expect(fnv1a32("héllo € \u{1f600}")).toBe(0x746efaad);
    expect(fnv1a32("�")).toBe(0x03479c4a);
  });

  test("agrees with a BigInt reference and returns a uint32", () => {
    fc.assert(
      fc.property(anyString, (s) => {
        let h = 0x811c9dc5n;
        for (const byte of new TextEncoder().encode(s))
          h = ((h ^ BigInt(byte)) * 16777619n) & 0xffffffffn;
        const got = fnv1a32(s);
        expect(got).toBe(Number(h));
        expect(Number.isInteger(got) && got >= 0 && got <= 0xffffffff).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});

describe("mulberry32", () => {
  test("golden outputs (computed independently in Python and by the reference below)", () => {
    const golden: [number, number[]][] = [
      [0, [1144304738, 1416247, 958946056, 627933444, 2007157716, 2340967985]],
      [1, [2693262067, 11749833, 2265367787, 4213581821, 4159151403, 1207330352]],
      [42, [2581720956, 1925393290, 3661312704, 2876485805, 750819978, 2261697747]],
      [0xffffffff, [3850105811, 813802916, 3073704848, 4054706436, 3630262831, 2315588663]],
    ];
    for (const [seed, outputs] of golden) {
      const rng = mulberry32(seed);
      const reference = referenceMulberry32(seed);
      for (const expected of outputs) {
        expect(reference()).toBe(expected);
        expect(rng.nextU32()).toBe(expected);
      }
    }
  });

  test("agrees with the BigInt reference for any seed", () => {
    fc.assert(
      fc.property(uint32, (seed) => {
        const rng = mulberry32(seed);
        const reference = referenceMulberry32(seed);
        for (let i = 0; i < 20; i += 1) expect(rng.nextU32()).toBe(reference());
      }),
      { numRuns: 1000 },
    );
  });

  test("rejects a seed that is not a uint32", () => {
    for (const bad of [-1, 0x100000000, 1.5, Number.NaN]) {
      expect(() => mulberry32(bad)).toThrow(RangeError);
    }
  });
});

describe("streamRng", () => {
  test("seeds mulberry32 with fnv1a32(`${seed}:${name}`)", () => {
    expect(fnv1a32("42:map")).toBe(1731853675);
    const golden: [string, number[]][] = [
      ["map", [2261093118, 2557458510, 3186670292, 456300785]],
      ["seats", [809053665, 3849857949, 1787285280, 418431171]],
      ["tiebreak", [1315120133, 2020561242, 2096690568, 2506817427]],
      ["lockstep:3600:0", [1690344286, 1724966558, 921073279, 3586088172]],
    ];
    for (const [name, outputs] of golden) {
      const rng = streamRng(42, name);
      expect(outputs.map(() => rng.nextU32())).toEqual(outputs);
    }
    fc.assert(
      fc.property(uint32, fc.string(), (seed, name) => {
        const a = streamRng(seed, name);
        const b = mulberry32(fnv1a32(`${seed}:${name}`));
        for (let i = 0; i < 5; i += 1) expect(a.nextU32()).toBe(b.nextU32());
      }),
    );
  });

  test("streams are independent: drawing from one never shifts another", () => {
    const alone = streamRng(7, "seats");
    const expected = [alone.nextU32(), alone.nextU32(), alone.nextU32()];
    const map = streamRng(7, "map");
    const seats = streamRng(7, "seats");
    for (let i = 0; i < 100; i += 1) map.nextU32();
    expect([seats.nextU32(), seats.nextU32(), seats.nextU32()]).toEqual(expected);
  });

  test("rejects a match seed that is not a uint32", () => {
    expect(() => streamRng(-1, "map")).toThrow(RangeError);
    expect(() => streamRng(2.5, "map")).toThrow(RangeError);
  });
});

describe("randInt", () => {
  test("stays within [lo, hi] and equals lo + floor(u · span / 2^32)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 2_097_151 }),
        uint32,
        (lo, width, u) => {
          const hi = lo + width;
          const x = randInt(scripted([u]), lo, hi);
          expect(x).toBeGreaterThanOrEqual(lo);
          expect(x).toBeLessThanOrEqual(hi);
          expect(x).toBe(lo + Number((BigInt(u) * BigInt(width + 1)) >> 32n));
        },
      ),
      { numRuns: 5000 },
    );
  });

  test("reaches both bounds and consumes exactly one draw", () => {
    const rng = scripted([0, 0xffffffff]);
    expect(randInt(rng, -10, 10)).toBe(-10);
    expect(randInt(rng, -10, 10)).toBe(10);
    expect(rng.drawn).toBe(2);
    expect(randInt(scripted([0xffffffff]), 0, 359)).toBe(359);
    expect(randInt(scripted([0x80000000]), 0, 1)).toBe(1);
    expect(randInt(scripted([0x7fffffff]), 0, 1)).toBe(0);
    expect(randInt(scripted([123]), 5, 5)).toBe(5);
  });

  test("rejects reversed bounds, a span above 2^21 and a broken Rng", () => {
    expect(() => randInt(scripted([0]), 2, 1)).toThrow(RangeError);
    expect(() => randInt(scripted([0]), 0, 2_097_152)).toThrow(RangeError);
    expect(randInt(scripted([0xffffffff]), 0, 2_097_151)).toBe(2_097_151);
    expect(() => randInt(scripted([0.5]), 0, 1)).toThrow(RangeError);
    expect(() => randInt(scripted([0x100000000]), 0, 1)).toThrow(RangeError);
    expect(() => randInt(scripted([0]), 0.5, 1)).toThrow(RangeError);
  });

  test("spreads draws over the whole range", () => {
    const rng = streamRng(1, "spread");
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6000; i += 1) {
      const k = randInt(rng, 0, 5);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const count of counts) expect(count).toBeGreaterThan(850);
  });
});

describe("shuffle", () => {
  test("returns a permutation and leaves the input untouched", () => {
    fc.assert(
      fc.property(uint32, fc.array(fc.integer(), { maxLength: 60 }), (seed, list) => {
        const before = list.slice();
        const out = shuffle(mulberry32(seed), list);
        expect(list).toEqual(before);
        expect(out).not.toBe(list);
        expect(out.toSorted(byValue)).toEqual(list.toSorted(byValue));
      }),
      { numRuns: 1000 },
    );
  });

  test("is Fisher–Yates from the end with j = randInt(0, i), one draw per i ≥ 1", () => {
    fc.assert(
      fc.property(uint32, fc.integer({ min: 0, max: 40 }), (seed, n) => {
        const list = Array.from({ length: n }, (_, i) => i);
        const rng = Object.assign(mulberry32(seed), { drawn: 0 });
        const counting: Rng = {
          nextU32: () => {
            rng.drawn += 1;
            return rng.nextU32();
          },
        };
        const out = shuffle(counting, list);
        const reference = list.slice();
        const draws = mulberry32(seed);
        for (let i = n - 1; i >= 1; i -= 1) {
          const j = Number((BigInt(draws.nextU32()) * BigInt(i + 1)) >> 32n);
          const tmp = reference[i] ?? -1;
          reference[i] = reference[j] ?? -1;
          reference[j] = tmp;
        }
        expect(out).toEqual(reference);
        expect(rng.drawn).toBe(Math.max(0, n - 1));
      }),
      { numRuns: 500 },
    );
  });

  test("is deterministic for a seed and reaches every permutation of three items", () => {
    expect(shuffle(streamRng(42, "seats"), [0, 1, 2, 3, 4, 5])).toEqual(
      shuffle(streamRng(42, "seats"), [0, 1, 2, 3, 4, 5]),
    );
    const seen = new Set<string>();
    for (let seed = 0; seed < 200; seed += 1)
      seen.add(shuffle(mulberry32(seed), ["a", "b", "c"]).join(""));
    expect(seen.size).toBe(6);
    expect(shuffle(mulberry32(1), [])).toEqual([]);
    expect(shuffle(mulberry32(1), ["x"])).toEqual(["x"]);
  });
});
