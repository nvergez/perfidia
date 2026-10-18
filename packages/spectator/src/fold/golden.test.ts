// The spectator fold on every committed golden (the war golden has its own file): each folds to
// the end, verified, with no gateway drift; its final standings equal its end line; every keyframe
// equals the previous one with its steps applied, and the last frame the first keyframe with every
// step. Steps do not depend on when the fold is read (fast-check over read points), and the ruleset's
// `publicCity` (the fold asks it for p1) does not depend on the viewer, for every registered ruleset.

import { describe, expect, test } from "bun:test";
import { RULESETS, createReplay } from "@perfidia/engine";
import { canonicalJson } from "@perfidia/engine/core";
import { visibilityOf } from "@perfidia/gateway/present";
import type { HeaderLine, LogLine } from "@perfidia/protocol";
import fc from "fast-check";
import { applySteps, standingsOf } from "../reduce/index.ts";
import { WAR_GOLDEN, golden, goldenNames } from "../testkit.test.ts";
import { createSpectatorFold, foldLog } from "./fold.ts";

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const headerOf = (lines: readonly LogLine[]): HeaderLine => {
  const h = lines[0];
  if (h?.k !== "header") throw new Error("no header");
  return h;
};

describe("every golden folds to its end line", () => {
  for (const name of goldenNames().filter((n) => n !== WAR_GOLDEN)) {
    test(name, () => {
      const lines = golden(name);
      const fold = foldLog(lines, { match: "golden" });
      expect([fold.status, fold.verified().ok, fold.gatewayDrift()]).toEqual(["ended", true, null]);
      const end = lines.at(-1);
      if (end?.k !== "end") throw new Error("no end line");
      const frame = fold.frame();
      expect(canonicalJson(standingsOf(frame))).toBe(canonicalJson(end.result.standings));
      expect(frame.result).toEqual({ reason: end.result.reason, winners: end.result.winners });
      for (const [i, kf] of fold.keyframes.entries()) {
        if (i === 0) continue;
        const prev = fold.keyframes[i - 1];
        if (prev === undefined) throw new Error("no keyframe");
        const steps = fold.steps.filter((s) => s.seq > prev.seq && s.seq <= kf.seq);
        expect(canonicalJson(applySteps(prev.frame, steps))).toBe(canonicalJson(kf.frame));
      }
      const first = fold.keyframes[0]?.frame;
      if (first === undefined) throw new Error("no keyframe 0");
      expect(canonicalJson(applySteps(first, fold.steps))).toBe(canonicalJson(frame));
    });
  }
});

describe("steps depend on the log only", () => {
  test("reading the fold at any points along the way gives the same steps (fast-check)", () => {
    const lines = golden("perfidia-1@1.1.0/rt-virtual-6p-1d.jsonl");
    const whole = foldLog(lines, { match: "golden" });
    const steps = JSON.stringify(whole.steps);
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: lines.length - 2 }), { maxLength: 40 }),
        (points) => {
          const at = new Set(points);
          const fold = createSpectatorFold(headerOf(lines), { match: "golden" });
          for (const [i, line] of lines.slice(1).entries()) {
            fold.push(line);
            if (at.has(i)) {
              fold.frame();
              fold.verified();
              void fold.steps.length;
            }
          }
          expect(JSON.stringify(fold.steps)).toBe(steps);
          expect(canonicalJson(fold.frame())).toBe(canonicalJson(whole.frame()));
        },
      ),
      { numRuns: 8 },
    );
  });

  test("a prefix of the log folds to a prefix of the steps, frame for frame", () => {
    const lines = golden("perfidia-1@1.1.0/lockstep-12p-1d.jsonl");
    const whole = foldLog(lines, { match: "golden" });
    for (const cut of [1, 7, 500, 1234, lines.length - 1]) {
      const part = foldLog(lines.slice(0, cut), { match: "golden" });
      const expected = whole.steps.filter((s) => s.seq < cut);
      expect(JSON.stringify(part.steps)).toBe(JSON.stringify(expected));
      expect(part.status).toBe("live");
      const first = whole.keyframes[0]?.frame;
      if (first === undefined) throw new Error("no keyframe 0");
      expect(canonicalJson(applySteps(first, expected))).toBe(canonicalJson(part.frame()));
    }
  });
});

describe("publicCity does not depend on the viewer", () => {
  const byRef = new Map<string, string>();
  for (const name of goldenNames()) {
    const ref = name.split("/")[0] ?? "";
    if (!byRef.has(ref) && !name.includes("6d")) byRef.set(ref, name);
  }
  test("every registered ruleset, every viewer, golden states every 6 hours", () => {
    expect([...byRef.keys()].toSorted(byText)).toEqual(RULESETS.map((r) => r.ref).toSorted(byText));
    for (const name of byRef.values()) {
      const lines = golden(name);
      const header = headerOf(lines);
      const seats = header.setup.seats.map((s) => s.id);
      let checked = 0;
      const replay = createReplay(header, {
        invariants: "off",
        onCheckpoint: (hour, r) => {
          if (hour % 6 !== 0) return;
          const vis = visibilityOf(r);
          for (const city of Object.keys(r.state.cities)) {
            const views = new Set(seats.map((v) => canonicalJson(vis.publicCity(v, city))));
            expect([name, hour, city, views.size]).toEqual([name, hour, city, 1]);
            checked += 1;
          }
        },
      });
      for (const line of lines.slice(1)) replay.push(line);
      expect(checked).toBeGreaterThan(0);
    }
  });
});
