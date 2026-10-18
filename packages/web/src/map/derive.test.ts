import { describe, expect, test } from "bun:test";
import type { FeedItem, ReportDetail } from "@perfidia/protocol/spectator";
import type { FeedEntry } from "../playback/timeline.ts";
import { citiesOfItem, createFeedFacts, fullestCopy, recentBattles } from "./derive.ts";

const HOUR = 3_600;

function battle(
  seq: number,
  t: number,
  city: `c${number}`,
  winner: "attacker" | "defender",
): FeedEntry {
  return {
    seq,
    item: {
      k: "battle",
      id: `${seq}:0`,
      t,
      players: ["p1", "p2"],
      importance: 2,
      city,
      attacker: "p1",
      defender: city === "c9" ? "neutral" : "p2",
      kind: "city",
      winner,
      reports: [`r${seq}a`, `r${seq}b`],
      siege: null,
      fell: false,
    },
  };
}

function launch(
  seq: number,
  movement: `m${string}`,
  againstAlly: "ally" | "pact" | null,
): FeedEntry {
  return {
    seq,
    item: {
      k: "launch",
      id: `${seq}:0`,
      t: seq,
      players: ["p2", "p3"],
      importance: againstAlly === null ? 2 : 3,
      movement,
      kind: "attack",
      owner: "p2",
      from: "c2",
      to: "c18",
      toIsland: "i8",
      target: "p3",
      departAt: seq,
      arriveAt: seq + HOUR,
      units: { u: 10 },
      pop: 10,
      settlers: false,
      foe: "p3",
      againstAlly,
      context: null,
    },
  };
}

function siege(seq: number, t: number, city: `c${number}`, endsAt: number): FeedEntry {
  const item: FeedItem = {
    k: "siege",
    id: `${seq}:0`,
    t,
    players: ["p1", "p2"],
    importance: 2,
    event: "started",
    city,
    owner: "p2",
    by: "p1",
    endsAt,
    cause: null,
  };
  return { seq, item };
}

describe("battles that flash", () => {
  const feed = [
    battle(1, 1 * HOUR, "c1", "attacker"),
    battle(2, 5 * HOUR, "c2", "defender"),
    battle(3, 6 * HOUR, "c2", "attacker"),
    battle(4, 6 * HOUR + 60, "c9", "defender"),
  ];

  test("the last two game hours, the latest battle per city, in the winner's name", () => {
    const at = recentBattles(feed, 6 * HOUR + 120);
    expect(at.map((b) => [b.city, b.winner])).toEqual([
      ["c9", null],
      ["c2", "p1"],
    ]);
    expect(at[1]?.reports).toEqual(["r3a", "r3b"]);
  });

  test("a battle stops flashing two hours after it", () => {
    expect(recentBattles(feed, 8 * HOUR + 61).map((b) => b.city)).toEqual([]);
    expect(recentBattles(feed, 8 * HOUR).map((b) => b.city)).toEqual(["c9", "c2"]);
  });
});

describe("facts read from the feed", () => {
  test("attacks on allies and siege starts, read incrementally and again after a seek back", () => {
    const facts = createFeedFacts();
    const a = [launch(1, "m1", null), launch(2, "m2", "ally")];
    const f1 = facts(a);
    expect([...f1.againstAlly]).toEqual([["m2", "ally"]]);
    // More entries without anything relevant: the same object.
    const b = [...a, battle(3, 3, "c1", "attacker")];
    expect(facts(b)).toBe(f1);
    const c = [...b, siege(4, 4, "c5", 4 + 6 * HOUR), launch(5, "m5", "pact")];
    const f2 = facts(c);
    expect([...f2.againstAlly]).toEqual([
      ["m2", "ally"],
      ["m5", "pact"],
    ]);
    expect(f2.siegeStarts.get("c5")).toEqual({ t: 4, endsAt: 4 + 6 * HOUR });
    // A seek back: the feed is a shorter list; the facts start over.
    const f3 = facts([a[0] ?? launch(1, "m1", null)]);
    expect(f3.againstAlly.size).toBe(0);
    expect(f3.siegeStarts.size).toBe(0);
  });
});

const copy = (report: `r${string}`, data: ReportDetail["data"]): ReportDetail => ({
  report,
  seq: 1,
  t: 1,
  type: "battle_report",
  city: "c1",
  recipient: "p1",
  data,
  copies: [],
});

describe("the fullest copy of a report", () => {
  test("the defender's copy when the attacker's is redacted; the first on a tie", () => {
    const redacted = copy("ra", { winner: "defender", lost: { u: 3 } });
    const full = copy("rb", { winner: "defender", stacks: [{ unit: "u", before: 3, lost: 3 }] });
    expect(fullestCopy([redacted, full])?.report).toBe("rb");
    expect(fullestCopy([full, copy("rc", { ...full.data })])?.report).toBe("rb");
    expect(fullestCopy([])).toBeNull();
  });
});

describe("the cities of a selected feed item", () => {
  const feed = [battle(3, 10, "c4", "attacker"), launch(5, "m1", "ally"), siege(9, 20, "c7", 99)];
  test("a battle's or siege's city, a launch's target; nothing for an unknown id", () => {
    expect(citiesOfItem(feed, "3:0", 10)).toEqual(["c4"]);
    expect(citiesOfItem(feed, "5:0", 5)).toEqual(["c18"]);
    expect(citiesOfItem(feed, "9:0", 20)).toEqual(["c7"]);
    expect(citiesOfItem(feed, "9:1", 20)).toEqual([]);
    expect(citiesOfItem(feed, "4:0", 20)).toEqual([]);
    expect(citiesOfItem(feed, "x", 20)).toEqual([]);
    expect(citiesOfItem(feed, null, 20)).toEqual([]);
  });

  test("only from an hour before the item to six hours after it", () => {
    expect(citiesOfItem(feed, "9:0", 20 - HOUR)).toEqual(["c7"]);
    expect(citiesOfItem(feed, "9:0", 20 - HOUR - 1)).toEqual([]);
    expect(citiesOfItem(feed, "9:0", 20 + 6 * HOUR)).toEqual(["c7"]);
    expect(citiesOfItem(feed, "9:0", 20 + 6 * HOUR + 1)).toEqual([]);
  });
});
