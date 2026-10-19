import { describe, expect, test } from "bun:test";
import { fmtTime as engineFmtTime } from "@perfidia/engine/core";
import fc from "fast-check";
import { dayOf, fmtAgo, fmtClock, fmtSpan, fmtSpeed, fmtTime, SPEEDS } from "./time.ts";

describe("game time for display", () => {
  test("fmtTime equals the engine's fmtTime on 10,000 random times", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30 * 86_400 }), (t) => fmtTime(t) === engineFmtTime(t)),
      { numRuns: 10_000 },
    );
    expect(fmtTime(0)).toBe("D1 00:00");
    expect(fmtTime(291_392)).toBe(engineFmtTime(291_392));
  });

  test("the clock drops seconds; days count from 1", () => {
    expect(fmtClock(0)).toBe("D1 00:00");
    expect(fmtClock(412_407)).toBe("D5 18:33");
    expect(fmtClock(86_399)).toBe("D1 23:59");
    expect(dayOf(0)).toBe(1);
    expect(dayOf(86_400)).toBe(2);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30 * 86_400 }), (t) =>
        engineFmtTime(t).startsWith(fmtClock(t)),
      ),
      { numRuns: 1_000 },
    );
  });

  test("spans, ago and speeds", () => {
    expect([fmtSpan(86_400), fmtSpan(3_600), fmtSpan(5_400), fmtSpan(2_700), fmtSpan(30)]).toEqual([
      "1 d",
      "1 h",
      "1 h 30 min",
      "45 min",
      "30 s",
    ]);
    expect([fmtAgo(10), fmtAgo(720), fmtAgo(10_800), fmtAgo(200_000)]).toEqual([
      "just now",
      "12 min ago",
      "3 h ago",
      "2 d ago",
    ]);
    expect(SPEEDS.map(fmtSpeed)).toEqual(["5 min/s", "15 min/s", "1 h/s", "3 h/s", "6 h/s"]);
  });
});
