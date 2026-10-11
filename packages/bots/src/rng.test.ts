// The bots' PRNG must be the engine's algorithms exactly (docs/architecture.md §11.1, perfidia-1
// §1.3): the vectors below are the ones the engine's `core/prng.test.ts` checks.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { fnv1a32, mulberry32, randInt, streamOf } from "./rng.ts";

describe("fnv1a32", () => {
  test("matches the engine's vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
    expect(fnv1a32("héllo € \u{1f600}")).toBe(0x746efaad);
    expect(fnv1a32("�")).toBe(0x03479c4a);
    expect(fnv1a32("42:map")).toBe(1731853675);
  });

  test("a lone surrogate hashes as U+FFFD, like a UTF-8 encoder", () => {
    expect(fnv1a32("\ud800")).toBe(fnv1a32("�"));
    expect(fnv1a32("a\udc00b")).toBe(fnv1a32("a�b"));
  });

  test("agrees with a BigInt reference over UTF-8 bytes", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (s) => {
        let h = 0x811c9dc5n;
        for (const byte of Buffer.from(s, "utf8"))
          h = ((h ^ BigInt(byte)) * 16777619n) & 0xffffffffn;
        expect(fnv1a32(s)).toBe(Number(h));
      }),
    );
  });
});

describe("mulberry32", () => {
  test("golden outputs", () => {
    const golden: [number, number[]][] = [
      [0, [1144304738, 1416247, 958946056, 627933444, 2007157716, 2340967985]],
      [1, [2693262067, 11749833, 2265367787, 4213581821, 4159151403, 1207330352]],
      [42, [2581720956, 1925393290, 3661312704, 2876485805, 750819978, 2261697747]],
      [0xffffffff, [3850105811, 813802916, 3073704848, 4054706436, 3630262831, 2315588663]],
    ];
    for (const [seed, outputs] of golden) {
      const rng = mulberry32(seed);
      for (const expected of outputs) expect(rng.nextU32()).toBe(expected);
    }
  });

  test("rejects a seed that is not a uint32", () => {
    for (const bad of [-1, 0x100000000, 1.5, Number.NaN])
      expect(() => mulberry32(bad)).toThrow(RangeError);
  });

  test("streamOf seeds mulberry32 with the FNV-1a 32 of the joined parts", () => {
    const a = streamOf(7, "p3", 3600, 2, 1);
    const b = mulberry32(fnv1a32("7:p3:3600:2:1"));
    for (let i = 0; i < 5; i += 1) expect(a.nextU32()).toBe(b.nextU32());
  });
});

describe("randInt", () => {
  test("stays within its bounds and follows the engine's formula", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 0, max: 100000 }),
        (seed, lo, span) => {
          const u = mulberry32(seed).nextU32();
          const v = randInt(mulberry32(seed), lo, lo + span);
          expect(v).toBeGreaterThanOrEqual(lo);
          expect(v).toBeLessThanOrEqual(lo + span);
          expect(v).toBe(lo + Math.floor((u * (span + 1)) / 4294967296));
        },
      ),
    );
  });

  test("rejects bounds out of order or a span over 2^21", () => {
    expect(() => randInt(mulberry32(1), 2, 1)).toThrow(RangeError);
    expect(() => randInt(mulberry32(1), 0, 2097152)).toThrow(RangeError);
    expect(randInt(mulberry32(1), 0, 2097151)).toBeLessThanOrEqual(2097151);
  });
});
