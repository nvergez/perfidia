import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { DAY, fmt, fmtDuration, fmtTime } from "./format.ts";

describe("fmtTime", () => {
  test("matches the §7.3 vectors", () => {
    expect(DAY).toBe(86400);
    expect(fmtTime(0)).toBe("D1 00:00");
    expect(fmtTime(604800)).toBe("D8 00:00");
    expect(fmtTime(223370)).toBe("D3 14:02:50");
    expect(fmtTime(226620)).toBe("D3 14:57");
    expect(fmtTime(226688)).toBe("D3 14:58:08");
    expect(fmtTime(86399)).toBe("D1 23:59:59");
    expect(fmtTime(86400)).toBe("D2 00:00");
    expect(fmtTime(59)).toBe("D1 00:00:59");
  });

  test("round-trips through its fields for any game time", () => {
    const pattern = /^D(\d+) (\d\d):(\d\d)(?::(\d\d))?$/;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 * DAY }), (t) => {
        const match = pattern.exec(fmtTime(t));
        expect(match).not.toBeNull();
        const [, day = "", hh = "", mm = "", ss] = match ?? [];
        expect(ss).not.toBe("00");
        const seconds =
          (Number(day) - 1) * DAY + Number(hh) * 3600 + Number(mm) * 60 + Number(ss ?? "0");
        expect(seconds).toBe(t);
        expect(Number(hh)).toBeLessThan(24);
        expect(Number(mm)).toBeLessThan(60);
      }),
      { numRuns: 2000 },
    );
  });

  test("rejects negative and non-integer times", () => {
    expect(() => fmtTime(-1)).toThrow(RangeError);
    expect(() => fmtTime(1.5)).toThrow(RangeError);
    expect(() => fmtTime(Number.NaN)).toThrow(RangeError);
  });
});

describe("fmtDuration", () => {
  test("matches the §7.3 vectors", () => {
    const vectors: [number, string][] = [
      [0, "0s"],
      [45, "45s"],
      [60, "1m"],
      [7200, "2h"],
      [4800, "1h20m"],
      [4805, "1h20m5s"],
      [86400, "1d"],
      [381480, "4d 9h58m"],
      [3368, "56m8s"],
      [86405, "1d 5s"],
      [90061, "1d 1h1m1s"],
      [3601, "1h1s"],
      [604800, "7d"],
    ];
    for (const [seconds, text] of vectors) expect(fmtDuration(seconds)).toBe(text);
  });

  test("round-trips through its parts for any duration", () => {
    const pattern = /^(?:(\d+)d)? ?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 400 * DAY }), (s) => {
        const text = fmtDuration(s);
        const match = pattern.exec(text);
        expect(match).not.toBeNull();
        const [, d, h, m, sec] = match ?? [];
        expect(
          Number(d ?? 0) * DAY + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(sec ?? 0),
        ).toBe(s);
        expect(text.includes(" ")).toBe(s >= DAY && s % DAY !== 0);
        if (s > 0) expect(text).not.toMatch(/(^|\D)0[dhms]/);
      }),
      { numRuns: 2000 },
    );
  });

  test("rejects negative and non-integer durations", () => {
    expect(() => fmtDuration(-1)).toThrow(RangeError);
    expect(() => fmtDuration(0.5)).toThrow(RangeError);
  });
});

describe("fmt", () => {
  test("is the frozen pair of both formatters", () => {
    expect(fmt.time(223370)).toBe("D3 14:02:50");
    expect(fmt.duration(381480)).toBe("4d 9h58m");
    expect(Object.isFrozen(fmt)).toBe(true);
  });
});
