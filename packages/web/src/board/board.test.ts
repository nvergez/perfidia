import { describe, expect, test } from "bun:test";
import type { DominationView } from "../skins/index.ts";
import {
  cityShare,
  countdownOf,
  countdownProgress,
  partLabel,
  scoreSegments,
  sortBlocs,
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
});
