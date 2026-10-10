import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { PERFIDIA_1_DEFAULTS, type PerfidiaConfig, PerfidiaConfigSchema } from "./config.ts";
import { distance2, distanceTiles, paceOf, travelBetween } from "./travel.ts";

// Travel times of perfidia-1 §7.2. The hook itself (`travelTime` over a match state) is exercised
// in index.test.ts.

const d = PERFIDIA_1_DEFAULTS;
const at = (x: number, y: number) => ({ x, y });

function withTimes(minTravel: number, sameIslandTravel: number): PerfidiaConfig {
  const c = PerfidiaConfigSchema.parse(structuredClone(d));
  c.time.minTravel = minTravel;
  c.time.sameIslandTravel = sameIslandTravel;
  return PerfidiaConfigSchema.parse(c);
}

describe("paceOf", () => {
  test("paces of §7.2", () => {
    expect(paceOf(d, { kind: "attack", units: { raider: 20, transport: 1 } })).toBe(60);
    expect(paceOf(d, { kind: "attack", units: { warship: 3 } })).toBe(45);
    expect(paceOf(d, { kind: "attack", units: { warship: 3, transport: 1, raider: 5 } })).toBe(60);
    expect(paceOf(d, { kind: "spy", units: {} })).toBe(30);
    expect(paceOf(d, { kind: "shipment", units: {} })).toBe(60);
    expect(paceOf(d, { kind: "return", units: { raider: 40 } })).toBe(60);
    expect(paceOf(d, { kind: "return", units: {} })).toBe(60);
    expect(paceOf(d, { kind: "support", units: { guard: 5 } })).toBe(60);
  });
});

describe("travelBetween", () => {
  test("worked example of §8.12: 90 tiles by transport take 5400 s", () => {
    expect(
      travelBetween(d, at(0, 0), at(90, 0), false, { kind: "attack", units: { transport: 19 } }),
    ).toBe(5400);
  });

  test("§2.4 frontier at N = 6 (93 tiles): 1h33 / 1h09 / 1h00", () => {
    const a = at(0, 0);
    const b = at(93, 0);
    expect(travelBetween(d, a, b, false, { kind: "attack", units: { transport: 1 } })).toBe(5580);
    expect(travelBetween(d, a, b, false, { kind: "attack", units: { warship: 1 } })).toBe(4185);
    expect(travelBetween(d, a, b, false, { kind: "spy", units: {} })).toBe(3600);
  });

  test("uses isqrt(pace² · d²), not pace · isqrt(d²)", () => {
    // d² = 2 (one diagonal tile): isqrt(3600 · 2) = 84, while 60 · isqrt(2) = 60.
    expect(distance2(at(0, 0), at(1, 1))).toBe(2);
    const c = withTimes(1, 1);
    expect(
      travelBetween(c, at(0, 0), at(1, 1), false, { kind: "attack", units: { transport: 1 } }),
    ).toBe(84);
  });

  test("never less than minTravel; same island takes sameIslandTravel", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.constantFrom("attack", "spy", "shipment", "return"),
        (x1, y1, x2, y2, kind) => {
          const t = travelBetween(d, at(x1, y1), at(x2, y2), false, { kind, units: {} });
          expect(t).toBeGreaterThanOrEqual(3600);
          expect(travelBetween(d, at(x2, y2), at(x1, y1), false, { kind, units: {} })).toBe(t);
          expect(travelBetween(d, at(x1, y1), at(x2, y2), true, { kind, units: {} })).toBe(3600);
        },
      ),
    );
  });

  test("reads time.minTravel and time.sameIslandTravel from the config (7200)", () => {
    const c = withTimes(7200, 7200);
    const group = { kind: "attack", units: { transport: 1 } } as const;
    expect(travelBetween(c, at(0, 0), at(80, 0), false, group)).toBe(7200);
    expect(travelBetween(c, at(0, 0), at(180, 0), false, group)).toBe(10800);
    expect(travelBetween(c, at(5, 5), at(5, 5), true, group)).toBe(7200);
    const longer = withTimes(3600, 5400);
    expect(travelBetween(longer, at(5, 5), at(5, 5), true, group)).toBe(5400);
  });

  test("distanceTiles is isqrt(d²)", () => {
    expect(distanceTiles(at(0, 0), at(3, 4))).toBe(5);
    expect(distanceTiles(at(0, 0), at(10, 10))).toBe(14);
  });
});
