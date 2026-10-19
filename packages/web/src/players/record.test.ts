import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  countUntil,
  diffStats,
  hunksOf,
  layout,
  lineDiff,
  nearest,
  sparkOf,
  type DiffLine,
} from "./record.ts";

// The dossier extras' pure parts: the playhead cut, the JSON layout, the line diff (the old text is
// its kept and removed lines, the new one its kept and added lines, and nothing kept is reported as
// changed), the hunks, and the sparkline geometry.

const side = (d: readonly DiffLine[], drop: "add" | "del"): string =>
  d
    .filter((l) => l.kind !== drop)
    .map((l) => l.text)
    .join("\n");

describe("countUntil", () => {
  test("counts the items at or before t", () => {
    const xs = [{ t: 10 }, { t: 20 }, { t: 20 }, { t: 30 }];
    expect([0, 9, 10, 19, 20, 29, 30, 99].map((t) => countUntil(xs, t))).toEqual([
      0, 0, 1, 1, 3, 3, 4, 4,
    ]);
    expect(countUntil([], 5)).toBe(0);
  });
});

describe("layout", () => {
  test("a JSON notebook is indented; prose stays as written", () => {
    expect(layout('{"v":2,"m":[1]}')).toEqual({
      text: '{\n  "v": 2,\n  "m": [\n    1\n  ]\n}',
      json: true,
    });
    expect(layout("plan: grow\n{not json")).toEqual({ text: "plan: grow\n{not json", json: false });
  });
});

describe("lineDiff", () => {
  test("an append, a changed line, a clear, a first version", () => {
    expect(lineDiff("a\nb", "a\nb\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
      { kind: "add", text: "c" },
    ]);
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
    ]);
    expect(lineDiff("a", "")).toEqual([{ kind: "del", text: "a" }]);
    expect(lineDiff("", "x\ny")).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ]);
  });

  test("rebuilds both texts and keeps a longest common run (fast-check)", () => {
    const lines = fc.array(fc.constantFrom("a", "b", "c", ""), { maxLength: 12 });
    fc.assert(
      fc.property(lines, lines, (xa, ya) => {
        const a = xa.join("\n");
        const b = ya.join("\n");
        const d = lineDiff(a, b);
        expect(side(d, "add")).toBe(a === "" ? "" : a);
        expect(side(d, "del")).toBe(b === "" ? "" : b);
        if (a === b) expect(diffStats(d)).toEqual({ add: 0, del: 0 });
      }),
      { numRuns: 400 },
    );
  });

  test("a large rewrite is shown removed then added", () => {
    const a = Array.from({ length: 600 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 600 }, (_, i) => `b${i}`).join("\n");
    const d = lineDiff(`top\n${a}`, `top\n${b}`);
    expect(diffStats(d)).toEqual({ add: 600, del: 600 });
    expect(d[0]).toEqual({ kind: "same", text: "top" });
    expect(d[1]?.kind).toBe("del");
    expect(d.at(-1)?.kind).toBe("add");
  });
});

describe("hunksOf", () => {
  test("changed lines with one line of context, the rest counted as skipped", () => {
    const d = lineDiff("1\n2\n3\n4\n5\n6\n7\n8", "1\n2\nX\n4\n5\n6\n7\nY");
    const { hunks, after } = hunksOf(d);
    expect(hunks.map((h) => [h.skipped, h.lines.map((l) => `${l.kind}:${l.text}`)])).toEqual([
      [1, ["same:2", "del:3", "add:X", "same:4"]],
      [2, ["same:7", "del:8", "add:Y"]],
    ]);
    expect(after).toBe(0);
    expect(hunksOf(lineDiff("a\nb", "a\nb"))).toEqual({ hunks: [], after: 2 });
  });
});

describe("sparkOf", () => {
  const pts = [
    { t: 3600, score: 100, cities: 1 },
    { t: 7200, score: 150, cities: 2 },
    { t: 10_800, score: 200, cities: 2 },
  ];

  test("x by time across the box, y from zero to the highest value", () => {
    const s = sparkOf(pts, (p) => p.score, false);
    expect(s.xs).toEqual([0, 50, 100]);
    expect(s.ys).toEqual([50, 25, 0]);
    expect([s.min, s.max]).toEqual([0, 200]);
    expect(s.path).toBe("M0 50L50 25L100 0");
    expect(sparkOf(pts, (p) => p.cities, true).path).toBe("M0 50H50V0H100V0");
  });

  test("one point is a flat line; no point is an empty path; the nearest point", () => {
    expect(sparkOf(pts.slice(0, 1), (p) => p.score, false).path).toBe("M0 0H100");
    expect(sparkOf([], (p) => p.score, false).path).toBe("");
    expect(sparkOf([{ t: 0, score: 0, cities: 0 }], (p) => p.score, false).path).toBe("M0 100H100");
    expect([nearest([0, 50, 100], 30), nearest([0, 50, 100], 80), nearest([], 3)]).toEqual([
      1, 2, -1,
    ]);
  });
});
