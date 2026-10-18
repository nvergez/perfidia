import { describe, expect, test } from "bun:test";
import type { Step } from "@perfidia/protocol/spectator";
import fc from "fast-check";
import { frame, naive, scoreStep } from "../testkit.test.ts";
import { KEYFRAME_EVERY, Timeline, lastAtOrBefore } from "./timeline.ts";

/** Steps at increasing cursors (gaps allowed) and non-decreasing times, each a new score. */
function stepsOf(gaps: readonly number[], dts: readonly number[]): Step[] {
  const out: Step[] = [];
  let seq = 0;
  let t = 0;
  for (const [i, g] of gaps.entries()) {
    seq += 1 + g;
    t += dts[i] ?? 0;
    out.push(scoreStep(seq, t, i + 1, i % 3 === 0));
  }
  return out;
}

const score = (f: { players: { p1?: { score: number } } } | null): number | undefined =>
  f?.players.p1?.score;

describe("lastAtOrBefore", () => {
  test("binary search for the last element at or before a value", () => {
    const xs = [1, 3, 3, 7];
    expect([0, 1, 2, 3, 6, 7, 9].map((v) => lastAtOrBefore(xs, v, (x) => x))).toEqual([
      -1, 0, 0, 2, 2, 3, 3,
    ]);
    expect(lastAtOrBefore([], 5, (x: number) => x)).toBe(-1);
  });
});

describe("the client timeline", () => {
  test("frames at any time equal a plain reduction (random steps, random seeks)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 1_200 }),
        fc.array(fc.integer({ min: 0, max: 50 }), { maxLength: 1_200 }),
        fc.array(fc.integer({ min: 0, max: 70_000 }), { minLength: 1, maxLength: 20 }),
        (gaps, dts, seeks) => {
          const base = frame(0, 0);
          const steps = stepsOf(gaps, dts);
          const tl = new Timeline();
          tl.addFrame(base);
          const last = steps.at(-1)?.seq ?? 0;
          expect(tl.addSteps(0, last, steps)).toBe(true);
          let prev:
            | { pos: { segment: number; index: number }; frame: ReturnType<typeof frame> }
            | undefined;
          for (const t of seeks) {
            const found = tl.locate(t);
            if (found === null) throw new Error("no position");
            const f = tl.frameAt(found.pos, prev);
            expect(score(f)).toBe(score(naive(base, steps, t)));
            if (f !== null) prev = { pos: found.pos, frame: f };
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  test("keeps a client keyframe every 500 steps as it reduces", () => {
    const base = frame(0, 0);
    const steps = stepsOf(
      Array.from({ length: 1_600 }, () => 0),
      Array.from({ length: 1_600 }, () => 1),
    );
    const tl = new Timeline();
    tl.addFrame(base);
    tl.addSteps(0, 1_600, steps);
    const end = tl.head();
    if (end === null) throw new Error("no head");
    tl.frameAt(end);
    expect(tl.keyframeIndexes(0)).toEqual([
      KEYFRAME_EVERY - 1,
      2 * KEYFRAME_EVERY - 1,
      3 * KEYFRAME_EVERY - 1,
    ]);
    // A seek near the end starts from the last keyframe: same frame as from the base.
    const pos = { segment: 0, index: 1_550 };
    expect(score(tl.frameAt(pos))).toBe(1_551);
  });

  test("a later frame starts its own segment; steps join them once they reach it", () => {
    const base = frame(0, 0);
    const steps = stepsOf([0, 0, 0, 0, 0, 0], [10, 10, 10, 10, 10, 10]);
    const tl = new Timeline();
    // The tail first (`/latest`), as a replay that opens at the end does.
    const latest = {
      ...frame(6, 60),
      players: { ...base.players, p1: { ...base.players.p1!, score: 6 } },
    };
    tl.addFrame(latest);
    expect(tl.segmentCount).toBe(1);
    expect(tl.locate(0)?.known).toBe(false);
    tl.addFrame(base);
    expect(tl.segmentCount).toBe(2);
    expect(tl.addSteps(0, 3, steps.slice(0, 3))).toBe(true);
    expect(tl.segmentCount).toBe(2);
    // A time in the hole between the two segments is not known yet.
    expect(tl.locate(45)?.known).toBe(false);
    expect(tl.locate(25)?.known).toBe(true);
    expect(tl.addSteps(3, 6, steps.slice(3))).toBe(true);
    expect(tl.segmentCount).toBe(1);
    expect(score(tl.frameAt(tl.locate(60)!.pos))).toBe(6);
    expect(score(tl.frameAt(tl.locate(35)!.pos))).toBe(3);
    // Steps that do not join what is held are refused (a gap).
    expect(tl.addSteps(9, 12, [scoreStep(12, 70, 9)])).toBe(false);
    expect(tl.addSteps(6, 12, [scoreStep(12, 70, 9)])).toBe(true);
    expect(tl.headSeq).toBe(12);
  });

  test("feed entries up to a cursor, across segments, in order", () => {
    const tl = new Timeline();
    tl.addFrame(frame(0, 0));
    const steps = stepsOf([0, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1]);
    tl.addSteps(0, 7, steps);
    expect(tl.feedUntil(7).map((e) => e.seq)).toEqual([1, 4, 7]);
    expect(tl.feedUntil(5).map((e) => e.seq)).toEqual([1, 4]);
    expect(tl.feedCount(5)).toBe(2);
    expect(tl.feedUntil(0)).toEqual([]);
  });

  test("an overlapping page adds only the steps past what is held: no duplicates", () => {
    const tl = new Timeline();
    tl.addFrame(frame(0, 0));
    const steps = stepsOf([0, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1]);
    expect(tl.addSteps(0, 4, steps.slice(0, 4))).toBe(true);
    // (2, 7] overlaps the held (0, 4]: steps 3 and 4 are already there.
    expect(tl.addSteps(2, 7, steps.slice(2))).toBe(true);
    expect(tl.feedUntil(7).map((e) => e.seq)).toEqual([1, 4, 7]);
    expect(score(tl.frameAt(tl.locateSeq(7) ?? { segment: 0, index: 0 }))).toBe(7);
    // A page wholly inside what is held changes nothing; one past a gap does not join.
    const v = tl.version;
    expect(tl.addSteps(1, 3, steps.slice(1, 3))).toBe(true);
    expect(tl.version).toBe(v);
    expect(tl.addSteps(9, 12, [])).toBe(false);
  });

  test("seq positions: just after a line, null when not held", () => {
    const tl = new Timeline();
    tl.addFrame(frame(0, 0));
    tl.addSteps(0, 10, [scoreStep(3, 30, 1), scoreStep(7, 70, 2)]);
    expect(tl.locateSeq(5)).toEqual({ segment: 0, index: 0 });
    expect(tl.locateSeq(2)).toEqual({ segment: 0, index: -1 });
    expect(tl.locateSeq(11)).toBeNull();
    expect(tl.timeAt({ segment: 0, index: 1 })).toBe(70);
  });
});
