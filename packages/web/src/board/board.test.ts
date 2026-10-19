import { describe, expect, test } from "bun:test";
import type { DominationView } from "../skins/index.ts";
import {
  blocStanding,
  cityShare,
  countdownOf,
  countdownProgress,
  partLabel,
  scoreSegments,
  sortBlocs,
  splitBlocs,
  takenPips,
} from "./board.ts";

// The leaderboard's and the bloc progress's pure pieces (phase-3 design §4.3).

describe("board", () => {
  test("score parts read as words", () => {
    expect(partLabel("cityPoints")).toBe("City points");
    expect(partLabel("battle_score")).toBe("Battle score");
    expect(partLabel("x")).toBe("X");
  });

  test("score segments: positive parts, largest first, scaled on the leader", () => {
    const s = scoreSegments({ battleScore: 52, cityPoints: 988, penalty: -5 }, 1315);
    expect(s.map((x) => x.key)).toEqual(["cityPoints", "battleScore"]);
    expect(s[0]?.pct).toBeCloseTo((988 / 1315) * 100, 6);
    expect(scoreSegments({ a: 1 }, 0)[0]?.pct).toBe(0);
  });

  test("blocs closest to a win first; taken pips; shares capped at the need", () => {
    const blocs = sortBlocs([
      { key: "p3", members: ["p3"], cities: 4, taken: 0 },
      { key: "a3", members: ["p2", "p5"], cities: 16, taken: 1 },
      { key: "a1", members: ["p1", "p4"], cities: 16, taken: 2 },
    ]);
    expect(blocs.map((b) => b.key)).toEqual(["a1", "a3", "p3"]);
    expect(takenPips(1, 2)).toEqual([true, false]);
    expect(takenPips(3, 2)).toEqual([true, true]);
    expect(takenPips(0, null)).toEqual([]);
    expect(cityShare(8, 16)).toBe(0.5);
    expect(cityShare(20, 16)).toBe(1);
    expect(cityShare(3, null)).toBe(0);
  });

  test("a countdown's progress over the hold", () => {
    const d: DominationView = {
      open: true,
      need: 16,
      needTaken: 2,
      slots: 43,
      blocs: [],
      countdowns: [{ key: "a1", members: ["p1"], cities: 16, taken: 2, endsAt: 1000 }],
      opensAt: 0,
      hold: 400,
      startBy: 0,
    };
    const c = countdownOf(d, "a1");
    expect(c).not.toBeNull();
    if (c === null) return;
    expect(countdownProgress(c, 400, 600)).toBe(0);
    expect(countdownProgress(c, 400, 800)).toBe(0.5);
    expect(countdownProgress(c, 400, 2000)).toBe(1);
    expect(countdownProgress(c, null, 800)).toBeNull();
    expect(countdownOf(d, "a2")).toBeNull();
  });

  test("where a bloc stands: won, counting down, short of conquests, short of cities", () => {
    const end: DominationView = {
      open: true,
      need: 16,
      needTaken: 2,
      slots: 43,
      blocs: [
        { key: "a1", members: ["p1", "p4"], cities: 16, taken: 2 },
        { key: "a3", members: ["p2", "p5"], cities: 16, taken: 1 },
        { key: "p6", members: ["p6"], cities: 5, taken: 0 },
        { key: "p3", members: ["p3"], cities: 4, taken: 0 },
      ],
      countdowns: [],
      opensAt: 259_200,
      hold: 86_400,
      startBy: 432_000,
    };
    const [a1, a3, p6] = end.blocs;
    if (a1 === undefined || a3 === undefined || p6 === undefined) throw new Error("fixture");
    expect(blocStanding(a1, end, ["p4", "p1"])).toEqual({ kind: "won" });
    expect(blocStanding(a1, end, null)).toEqual({ kind: "none" });
    expect(blocStanding(a3, end, ["p1", "p4"])).toEqual({ kind: "needs-taken", missing: 1 });
    expect(blocStanding(p6, end, ["p1", "p4"])).toEqual({ kind: "needs-cities", missing: 11 });
    const running = {
      ...end,
      countdowns: [{ key: "a1", members: ["p1", "p4"], cities: 16, taken: 2, endsAt: 498_807 }],
    } satisfies DominationView;
    expect(blocStanding(a1, running, null)).toEqual({ kind: "countdown" });
    // Alliances get rows; lone players short of the cities share one line.
    const split = splitBlocs(end.blocs, end, ["p1", "p4"]);
    expect(split.rows.map((b) => b.key)).toEqual(["a1", "a3"]);
    expect(split.alone.map((b) => b.key)).toEqual(["p6", "p3"]);
  });
});
