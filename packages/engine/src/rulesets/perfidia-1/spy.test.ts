import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { PERFIDIA_1_DEFAULTS } from "./config.ts";
import { counterIntel, spyGoldNeeded, spySucceeds } from "./spy.ts";

// Espionage thresholds of perfidia-1 §10 (and the Crown's, §9.6).

const d = PERFIDIA_1_DEFAULTS;

describe("counter-intel", () => {
  test("100 + 50 · wall + Σ land pop present", () => {
    expect(counterIntel(d, 0, 0)).toBe(100);
    expect(counterIntel(d, 3, 25)).toBe(275);
  });

  test("a day-4 capital (wall 2, 147 pop) needs > 347 gold", () => {
    const counter = counterIntel(d, 2, 147);
    expect(counter).toBe(347);
    expect(spySucceeds(347, counter)).toBe(false);
    expect(spySucceeds(348, counter)).toBe(true);
    expect(spyGoldNeeded(counter)).toBe(348);
  });

  test("a maxed turtle (wall 10, 440 guards) needs > 1040 gold", () => {
    expect(counterIntel(d, 10, 440)).toBe(1040);
  });

  test("the Crown (wall 5, 400 guards; warships are not land pop) needs > 750 gold", () => {
    expect(counterIntel(d, 5, 400)).toBe(750);
  });

  test("ties go to the target; more gold never hurts (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 10000 }),
        (wall, pop, gold) => {
          const counter = counterIntel(d, wall, pop);
          expect(spySucceeds(counter, counter)).toBe(false);
          if (spySucceeds(gold, counter)) expect(spySucceeds(gold + 1, counter)).toBe(true);
          expect(counterIntel(d, wall + 1, pop)).toBeGreaterThan(counter);
        },
      ),
    );
  });
});
