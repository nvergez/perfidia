import { describe, expect, test } from "bun:test";
import * as present from "@perfidia/gateway/present";
import { cutText } from "./common.ts";
import { durationPair, isTimeKey, renderData, renderEvent, timePair } from "./index.ts";
import { P1, event, fixtureMatch } from "./testkit.test.ts";

describe("@perfidia/gateway/present", () => {
  test("the public module path exposes the presentation", () => {
    for (const name of [
      "viewCity",
      "viewIsland",
      "viewMap",
      "viewPlayer",
      "leaderboard",
      "rulesInfo",
      "buildBriefing",
      "explain",
      "toolError",
      "toolWarning",
      "renderEvent",
      "interfaceText",
      "agentRules",
    ]) {
      expect(typeof (present as Record<string, unknown>)[name]).toBe("function");
    }
    expect(present.BRIEFING_TARGET_CHARS).toBe(2400);
    expect(present.MESSAGE_CUT).toBe(300);
  });

  test("time pairs (§7.3)", () => {
    expect(timePair(226620)).toEqual([226620, "D3 14:57"]);
    expect(timePair(223370)).toEqual([223370, "D3 14:02:50"]);
    expect(durationPair(381480)).toEqual([381480, "4d 9h58m"]);
    expect(durationPair(0)).toEqual([0, "0s"]);
  });

  test("event rendering: times as pairs, typed text, no recipients", () => {
    expect(["at", "t", "until", "since", "arriveAt", "expiresAt", "endsAt"].every(isTimeKey)).toBe(
      true,
    );
    expect(["seat", "format", "At", "city", "count"].some(isTimeKey)).toBe(false);
    const ev = event(100, "incoming_attack", [[P1, "party"]], {
      movement: "m00001",
      from: "c5",
      by: "p3",
      foe: P1,
      to: "c1",
      departAt: 100,
      arriveAt: 3700,
      homecoming: false,
    });
    // The event's own time comes first, as a pair (`at`).
    expect(renderEvent(ev)).toEqual({
      type: "incoming_attack",
      at: [100, "D1 00:01:40"],
      movement: "m00001",
      from: "c5",
      by: "p3",
      foe: P1,
      to: "c1",
      departAt: [100, "D1 00:01:40"],
      arriveAt: [3700, "D1 01:01:40"],
      homecoming: false,
    });
    expect(
      renderData({ text: `a\tb${"x".repeat(400)}`, nested: { endsAt: 86400, list: [{ at: 60 }] } }),
    ).toEqual({
      text: `a b${"x".repeat(297)}`,
      cut: true,
      nested: { endsAt: [86400, "D2 00:00"], list: [{ at: [60, "D1 00:01"] }] },
    });
    // A data field named `at` (a ruleset's) keeps its own value.
    expect(renderEvent(event(500, "hill_taken", [[P1, "self"]], { at: 400 }))).toEqual({
      type: "hill_taken",
      at: [400, "D1 00:06:40"],
    });
  });

  test("a cut never splits a surrogate pair", () => {
    const shield = "\u{1F6E1}";
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
    // The 300th code unit is the first half of the emoji: the cut keeps 299 units.
    const across = renderData({ text: `${"x".repeat(299)}${shield}${"y".repeat(20)}` });
    expect(across).toEqual({ text: "x".repeat(299), cut: true });
    // The emoji ends at the 300th code unit: it is kept whole.
    const before = renderData({ text: `${"x".repeat(298)}${shield}${"y".repeat(20)}` });
    expect(before).toEqual({ text: `${"x".repeat(298)}${shield}`, cut: true });
    for (const v of [across["text"], before["text"]]) {
      expect(typeof v === "string" && !lone.test(v)).toBe(true);
    }
    expect(cutText("ab", 5)).toBe("ab");
    expect(cutText(`a${shield}`, 2)).toBe("a");
    expect(cutText(`a${shield}`, 3)).toBe(`a${shield}`);
  });

  test("a match's read context is all the views need", () => {
    const match = fixtureMatch();
    expect(present.viewMap(match.read(), P1)?.islands).toHaveLength(2);
  });
});
