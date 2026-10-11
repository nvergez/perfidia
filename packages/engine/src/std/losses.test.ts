import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { StdError, allocateLosses, enqueueRecruit, slotUnits, stackGroups } from "./index.ts";
import { cityOf, ctxAt } from "./fixtures.test.ts";

describe("allocateLosses", () => {
  test("73 losses over groups of 60 and 40 give 44 and 29 (perfidia-1 §9.8)", () => {
    expect(allocateLosses([60, 40], 73)).toEqual([44, 29]);
  });

  test("ties in the remainder go to the earlier group", () => {
    expect(allocateLosses([10, 10], 1)).toEqual([1, 0]);
    expect(allocateLosses([5, 5, 5], 2)).toEqual([1, 1, 0]);
    expect(allocateLosses([1, 3, 1], 1)).toEqual([0, 1, 0]);
  });

  test("edge cases: no loss, every unit, empty groups, and a loss above the total", () => {
    expect(allocateLosses([], 0)).toEqual([]);
    expect(allocateLosses([0, 7, 0], 7)).toEqual([0, 7, 0]);
    expect(allocateLosses([3, 0], 0)).toEqual([0, 0]);
    expect(() => allocateLosses([3, 4], 8)).toThrow(StdError);
    expect(() => allocateLosses([3, -1], 1)).toThrow(StdError);
  });

  test("always sums to the loss, never exceeds a group, and stays within 1 of the share", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100000 }), { maxLength: 12 }),
        fc.integer({ min: 0, max: 1000 }),
        (groups, permille) => {
          const n = groups.reduce((a, b) => a + b, 0);
          const loss = Math.floor((n * permille) / 1000);
          const out = allocateLosses(groups, loss);
          expect(out.reduce((a, b) => a + b, 0)).toBe(loss);
          out.forEach((x, i) => {
            const g = groups[i] ?? 0;
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThanOrEqual(g);
            if (n > 0) {
              expect(x * n).toBeGreaterThanOrEqual(loss * g - n);
              expect(x * n).toBeLessThanOrEqual(loss * g + n);
            }
          });
        },
      ),
    );
  });
});

describe("stack groups", () => {
  test("home first for the city's owner, then stationed groups by home city and role", () => {
    const ctx = ctxAt();
    const c2 = cityOf(ctx, "c2");
    c2.stationed = [
      { owner: "p1", home: "c1", role: "hold", units: { axe: 3 } },
      { owner: "p1", home: "c4", role: "support", units: { pike: 2 } },
      { owner: "p2", home: "c10", role: "support", units: { pike: 4 } },
      { owner: "p3", home: "c3", role: "support", units: { pike: 1 } },
    ];
    const r = ctx.read();
    expect(stackGroups(r, "c2", "p2")).toEqual([
      { at: "home", city: "c2" },
      { at: "stationed", city: "c2", owner: "p2", home: "c10", role: "support" },
    ]);
    expect(stackGroups(r, "c2", "p1")).toEqual([
      { at: "stationed", city: "c2", owner: "p1", home: "c1", role: "hold" },
      { at: "stationed", city: "c2", owner: "p1", home: "c4", role: "support" },
    ]);
    expect(stackGroups(r, "c5", null)).toEqual([{ at: "home", city: "c5" }]);
    expect(stackGroups(r, "c2", null)).toEqual([]);
    expect(
      slotUnits(r, { at: "stationed", city: "c2", owner: "p1", home: "c4", role: "support" }),
    ).toEqual({
      pike: 2,
    });
    expect(
      slotUnits(r, { at: "stationed", city: "c2", owner: "p1", home: "c4", role: "hold" }),
    ).toEqual({});
  });

  test("the home slot includes units trickled by now", () => {
    const ctx = ctxAt();
    enqueueRecruit(ctx, "c1", "pike", 3);
    ctx.setNow(600);
    expect(slotUnits(ctx.read(), { at: "home", city: "c1" }).pike).toBe(22);
  });
});
