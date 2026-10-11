// The self-wake choice (docs/architecture.md §11.1): the cadence or the earliest awaited event,
// within the wake budget and `selfWake`, with a margin when game time moves during the turn.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { chooseWake, WAKE_MARGIN, type WakeInput } from "./wake.ts";

const DAY = 86400;
const base: WakeInput = {
  now: 3600,
  step: 0,
  cadence: 7200,
  selfWake: { min: 600, max: 43200 },
  // Many own wakes left: the budget gap is small, so only `selfWake.min` bounds from below.
  ownWakesLeft: 1000,
  events: [],
};

describe("chooseWake", () => {
  test("the cadence when nothing comes sooner", () => {
    expect(chooseWake(base)).toBe(3600 + 7200);
    expect(chooseWake({ ...base, events: [3600 + 9000, 3000] })).toBe(3600 + 7200);
  });

  test("the earliest event between now and the cadence", () => {
    expect(chooseWake({ ...base, events: [3600 + 5000, 3600 + 2500, 3600 + 6000] })).toBe(
      3600 + 2500,
    );
  });

  test("never sooner than selfWake.min, never later than selfWake.max", () => {
    expect(chooseWake({ ...base, events: [3600 + 100] })).toBe(3600 + 600);
    expect(chooseWake({ ...base, cadence: 90000 })).toBe(3600 + 43200);
  });

  test("never sooner than the rest of the day spread over the own wakes left", () => {
    // 82800 s left today over 12 wakes: one every 6900 s at most.
    expect(chooseWake({ ...base, ownWakesLeft: 12, events: [3600 + 1000] })).toBe(3600 + 6900);
    // With no own wake left, the whole rest of the day, up to selfWake.max.
    expect(chooseWake({ ...base, ownWakesLeft: 0, events: [3600 + 1000] })).toBe(3600 + 43200);
    expect(chooseWake({ ...base, now: DAY - 1000, ownWakesLeft: 0, events: [DAY - 300] })).toBe(
      DAY,
    );
  });

  test("keeps a margin above selfWake.min when game time moved during the turn", () => {
    const at = chooseWake({ ...base, step: 10, events: [3600 + 100] });
    expect(at).toBe(3600 + 600 + WAKE_MARGIN);
    expect(chooseWake({ ...base, step: 200, events: [3600 + 100] })).toBe(3600 + 600 + 400);
    // An event beyond the margin is taken as it is.
    expect(chooseWake({ ...base, step: 200, events: [3600 + 2000] })).toBe(3600 + 2000);
    // The margin never pushes the wake past selfWake.max.
    const tight = { ...base, selfWake: { min: 600, max: 700 }, step: 5000 };
    expect(chooseWake({ ...tight, events: [3600 + 100] })).toBe(3600 + 700);
  });

  test("without the rules: the cadence", () => {
    expect(chooseWake({ ...base, selfWake: null, events: [3700] })).toBe(3600 + 7200);
  });

  test("property: always within [now + min, now + max], at or after the margin", () => {
    const input = fc.record({
      now: fc.integer({ min: 0, max: 7 * DAY }),
      step: fc.integer({ min: 0, max: 3600 }),
      cadence: fc.integer({ min: 1, max: 2 * DAY }),
      min: fc.integer({ min: 0, max: 7200 }),
      span: fc.integer({ min: 0, max: DAY }),
      ownWakesLeft: fc.integer({ min: 0, max: 50 }),
      events: fc.array(fc.integer({ min: -DAY, max: 9 * DAY }), { maxLength: 8 }),
    });
    fc.assert(
      fc.property(input, (i) => {
        const selfWake = { min: i.min, max: i.min + i.span };
        const at = chooseWake({ ...i, selfWake });
        expect(at).toBeGreaterThanOrEqual(i.now + selfWake.min);
        expect(at).toBeLessThanOrEqual(i.now + selfWake.max);
        if (i.step > 0) {
          const margin = Math.min(i.span, Math.max(WAKE_MARGIN, 2 * i.step));
          expect(at).toBeGreaterThanOrEqual(i.now + selfWake.min + margin);
        }
      }),
    );
  });
});
