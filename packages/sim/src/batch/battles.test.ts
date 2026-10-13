// What happened on the map in a batch row (docs/architecture.md §12.2): battles joined to their
// reports in either emission order and split into defended, empty and unknown, reliefs (against the
// besieger of a held siege, by the owner or a third player, breaking the siege or not) and
// homecomings; domination countdowns with their bloc's conquered, founded and starting cities and
// how they ended; free slots from the initial world and the foundings, exact on hand-written lines,
// on the committed `scenario-late` golden and, day by day, against the pacing replay of a bots
// golden.

import { describe, expect, test } from "bun:test";
import { getRuleset } from "@perfidia/engine";
import { DAY } from "@perfidia/engine/core";
import { LogLineSchema, type LogLine } from "@perfidia/protocol";
import { FIXTURES_DIR } from "../golden/index.ts";
import { listGoldens, readLog } from "../harness/index.ts";
import {
  battleRecords,
  battleSplit,
  countdownRows,
  freeSlotsAt,
  freeSlotsOf,
  initialFreeSlots,
  isRelief,
  pacingOf,
} from "./index.ts";

function log(rows: readonly unknown[]): LogLine[] {
  return rows.map((r) => LogLineSchema.parse(r));
}

const ev = (t: number, type: string, data: Record<string, unknown> = {}): unknown => ({
  k: "ev",
  t,
  e: { t, type, public: true, to: [], data },
});

const headline = (t: number, city: string, attacker: string, defender: string, kind = "city") =>
  ev(t, "battle", { city, attacker, defender, kind, winner: "attacker" });

/** A full report: the defending units and the points; `null` stacks makes a redacted copy. */
const report = (
  t: number,
  city: string,
  attacker: string,
  defender: string,
  o: {
    readonly kind?: string;
    readonly defenders?: readonly number[] | null;
    readonly points?: readonly [string, number][];
  } = {},
) =>
  ev(t, "battle_report", {
    report: `r${t}${city}`,
    city,
    attacker,
    defender,
    kind: o.kind ?? "city",
    winner: "attacker",
    ...(o.defenders === null
      ? { lost: {} }
      : {
          stacks: [
            {
              side: "attacker",
              owner: attacker,
              unit: "raider",
              before: 50,
              lost: 1,
              survived: 49,
            },
            ...(o.defenders ?? []).map((before) => ({
              side: "defender",
              owner: defender,
              unit: "guard",
              before,
              lost: 0,
              survived: before,
            })),
          ],
          points: (o.points ?? []).map(([player, points]) => ({ player, points })),
        }),
  });

function scenarioLate(): LogLine[] {
  const g = listGoldens(FIXTURES_DIR).find(
    (x) => x.ref === "perfidia-1@1.0.0" && x.name === "scenario-late",
  );
  if (g === undefined) throw new Error("scenario-late is not committed");
  return readLog(g.path);
}

describe("battles", () => {
  test("reports before their headline (perfidia-1) or after it (sandbox-1) join the same battle", () => {
    const before = battleRecords(
      log([
        report(100, "c3", "p1", "p2", { defenders: [5, 2], points: [["p1", 30]] }),
        report(100, "c3", "p1", "p2", { defenders: [5, 2], points: [["p1", 30]] }),
        headline(100, "c3", "p1", "p2"),
        report(100, "c4", "p1", "p3", { defenders: [] }),
        headline(100, "c4", "p1", "p3"),
      ]),
    );
    const after = battleRecords(
      log([
        headline(100, "c3", "p1", "p2"),
        report(100, "c3", "p1", "p2", { defenders: [5, 2], points: [["p1", 30]] }),
        headline(100, "c4", "p1", "p3"),
        report(100, "c4", "p1", "p3", { defenders: [] }),
      ]),
    );
    expect(after).toEqual(before);
    expect(before.map((b) => [b.city, b.defenders, b.points])).toEqual([
      ["c3", 7, [{ player: "p1", points: 30 }]],
      ["c4", 0, []],
    ]);
    expect(battleSplit(before)).toMatchObject({ defended: 1, empty: 1, unknown: 0 });
  });

  test("a battle no full report describes is unknown; reports of another second never join", () => {
    const b = battleRecords(
      log([
        report(99, "c3", "p1", "p2", { defenders: [5] }),
        report(100, "c3", "p1", "neutral", { defenders: null }),
        headline(100, "c3", "p1", "neutral"),
        // A report that matches no headline of its second is dropped.
        report(200, "c9", "p4", "p2", { defenders: [1] }),
        headline(200, "c8", "p4", "p2"),
      ]),
    );
    expect(b.map((x) => [x.city, x.defenders, x.points])).toEqual([
      ["c3", null, null],
      ["c8", null, null],
    ]);
    expect(battleSplit(b)).toMatchObject({ defended: 0, empty: 0, unknown: 2 });
  });

  test("reliefs: against the besieger of a held siege, by the owner or a third player, breaking it or not", () => {
    const lines = log([
      ev(10, "siege_started", { city: "c3", owner: "p2", by: "p1", endsAt: 21610 }),
      ev(20, "siege_started", { city: "c4", owner: "p3", by: "p1", endsAt: 21620 }),
      // The owner relieves c3 and fails; a third player relieves it and breaks the siege.
      report(100, "c3", "p2", "p1", { kind: "relief", defenders: [40] }),
      headline(100, "c3", "p2", "p1", "relief"),
      report(200, "c3", "p5", "p1", { kind: "relief", defenders: [30] }),
      headline(200, "c3", "p5", "p1", "relief"),
      ev(200, "siege_broken", { city: "c3", owner: "p2", by: "p1", cause: "relief" }),
      // A return fights its way into besieged c4: a homecoming, not a relief.
      report(300, "c4", "p3", "p1", { kind: "homecoming", defenders: [20] }),
      headline(300, "c4", "p3", "p1", "homecoming"),
      // c4 falls; a later battle there is a plain city battle.
      ev(21620, "city_conquered", { city: "c4", from: "p3", to: "p1" }),
      report(30000, "c4", "p3", "p1", { defenders: [] }),
      headline(30000, "c4", "p3", "p1"),
      // c3's siege is over: an attack on it is not a relief either.
      report(30000, "c3", "p1", "p2", { defenders: [3] }),
      headline(30000, "c3", "p1", "p2"),
    ]);
    const b = battleRecords(lines);
    expect(b.map((x) => [x.t, x.kind, isRelief(x), x.brokeSiege])).toEqual([
      [100, "relief", true, false],
      [200, "relief", true, true],
      [300, "homecoming", false, false],
      [30000, "city", false, false],
      [30000, "city", false, false],
    ]);
    expect(b[0]?.siege).toEqual({ owner: "p2", by: "p1" });
    expect(battleSplit(b)).toEqual({
      defended: 4,
      empty: 1,
      unknown: 0,
      relief: 2,
      reliefByOwner: 1,
      reliefBroke: 1,
      homecoming: 1,
    });
    expect(battleSplit([])).toEqual({
      defended: 0,
      empty: 0,
      unknown: 0,
      relief: 0,
      reliefByOwner: 0,
      reliefBroke: 0,
      homecoming: 0,
    });
  });

  test("the scenario-late golden: two defended city battles, the owner's failed relief, a homecoming", () => {
    const b = battleRecords(scenarioLate());
    expect(b.map((x) => [x.t, x.city, x.attacker, x.defender, x.kind])).toEqual([
      [4200, "c4", "p1", "p4", "city"],
      [4210, "c6", "p1", "p6", "city"],
      [7800, "c4", "p4", "p1", "relief"],
      [7812, "c4", "p4", "p1", "homecoming"],
    ]);
    expect(b.every((x) => x.defenders !== null && x.defenders > 0)).toBe(true);
    expect(battleSplit(b)).toEqual({
      defended: 4,
      empty: 0,
      unknown: 0,
      relief: 1,
      reliefByOwner: 1,
      reliefBroke: 0,
      homecoming: 1,
    });
    // One copy of each battle's points, whichever recipient's copy carried them.
    expect(b.map((x) => x.points)).toEqual([
      [
        { player: "p1", points: 94 },
        { player: "p4", points: 4 },
      ],
      [
        { player: "p1", points: 70 },
        { player: "p6", points: 2 },
      ],
      [
        { player: "p1", points: 5 },
        { player: "p4", points: 2 },
      ],
      [
        { player: "p1", points: 5 },
        { player: "p4", points: 3 },
      ],
    ]);
  });
});

describe("domination countdowns", () => {
  test("bloc cities split by origin; cancelled with the same-second causes, won, or still open", () => {
    const lines = log([
      ev(100, "city_founded", { city: "c7", island: "i3", slot: 0, owner: "p1" }),
      ev(200, "city_founded", { city: "c8", island: "i4", slot: 0, owner: "p2" }),
      ev(300, "city_conquered", { city: "c3", from: "p4", to: "p1" }),
      // Founded by p2, taken by p5: no longer the bloc's.
      ev(400, "city_conquered", { city: "c8", from: "p2", to: "p5" }),
      ev(500, "domination_started", {
        key: "a1",
        members: ["p1", "p2"],
        cities: 5,
        threshold: 5,
        endsAt: 90500,
      }),
      ev(600, "alliance_left", { alliance: "a1", player: "p2", cause: "betrayal" }),
      ev(600, "betrayal", { by: "p2", against: "p1", relation: "ally", city: "c7" }),
      ev(600, "message", { message: "m1", from: "p3", to: "all", text: "x" }),
      ev(600, "domination_cancelled", { key: "a1", members: ["p1", "p2"], reason: "membership" }),
      ev(700, "domination_started", {
        key: "p5",
        members: ["p5"],
        cities: 3,
        threshold: 3,
        endsAt: 4300,
      }),
      ev(800, "city_conquered", { city: "c9", from: "p5", to: "p1" }),
      ev(800, "domination_cancelled", { key: "p5", members: ["p5"], reason: "condition" }),
      ev(900, "domination_started", {
        key: "p1",
        members: ["p1"],
        cities: 4,
        threshold: 3,
        endsAt: 4500,
      }),
      ev(1000, "domination_started", {
        key: "p3",
        members: ["p3"],
        cities: 3,
        threshold: 3,
        endsAt: 4600,
      }),
      {
        k: "end",
        t: 4500,
        h: "0".repeat(16),
        result: { endedAt: 4500, reason: "domination", winners: ["p1"], standings: [] },
      },
    ]);
    const bots = { p1: "conqueror@2", p2: "opportunist@2", p5: "expander@1" };
    const rows = countdownRows(lines, bots);
    expect(
      rows.map((r) => [r.key, r.bots, r.cities, r.conquered, r.founded, r.initial, r.outcome]),
    ).toEqual([
      ["a1", ["conqueror@2", "opportunist@2"], 5, 1, 1, 3, "cancelled"],
      ["p5", ["expander@1"], 3, 1, 0, 2, "cancelled"],
      ["p1", ["conqueror@2"], 4, 2, 1, 1, "won"],
      ["p3", ["?"], 3, 0, 0, 3, "open"],
    ]);
    expect(rows.map((r) => [r.endedAt, r.reason, r.detail])).toEqual([
      [600, "membership", ["p2 left a1 (betrayal)", "p2 betrayed p1"]],
      [800, "condition", ["c9 lost to p1"]],
      [4500, null, []],
      [null, null, []],
    ]);
    expect(rows[0]).toMatchObject({ t: 500, members: ["p1", "p2"], threshold: 5, endsAt: 90500 });
    // No end line (a fatal run): every countdown not cancelled stays open.
    expect(countdownRows(lines.slice(0, -1), bots).map((r) => r.outcome)).toEqual([
      "cancelled",
      "cancelled",
      "open",
      "open",
    ]);
    expect(countdownRows([], {})).toEqual([]);
  });

  test("the scenario-late golden: an alliance countdown cancelled when a member left, then a lone win", () => {
    const rows = countdownRows(scenarioLate(), {});
    expect(rows).toEqual([
      {
        t: 11400,
        key: "a1",
        members: ["p1", "p2"],
        bots: ["?", "?"],
        cities: 3,
        threshold: 3,
        endsAt: 15000,
        conquered: 1,
        founded: 0,
        initial: 2,
        outcome: "cancelled",
        endedAt: 12000,
        reason: "membership",
        detail: ["p2 left a1"],
      },
      {
        t: 12000,
        key: "p1",
        members: ["p1"],
        bots: ["?"],
        cities: 3,
        threshold: 3,
        endsAt: 15600,
        conquered: 2,
        founded: 0,
        initial: 1,
        outcome: "won",
        endedAt: 15600,
        reason: null,
        detail: [],
      },
    ]);
  });
});

describe("free slots", () => {
  test("the initial ones less the foundings so far, at the end of D5, of D7 (or the match end) and at the end", () => {
    const lines = log([
      ev(3600, "city_founded"),
      ev(5 * DAY, "city_founded"),
      ev(5 * DAY + 1, "city_founded"),
      ev(6 * DAY, "city_founded"),
      ev(7 * DAY + 10, "city_founded"),
    ]);
    expect(freeSlotsOf(lines, 30, 10 * DAY)).toEqual({ initial: 30, d5: 28, d7: 26, end: 25 });
    expect(freeSlotsOf(lines, 30, 7 * DAY)).toEqual({ initial: 30, d5: 28, d7: 26, end: 26 });
    // Ended during D6: no D5 end is missed, D7 is the match end.
    expect(freeSlotsOf(lines, 30, 5 * DAY + 100)).toEqual({ initial: 30, d5: 28, d7: 27, end: 27 });
    // Ended before the end of D5.
    expect(freeSlotsOf(lines, 30, 4 * DAY)).toEqual({ initial: 30, d5: null, d7: 29, end: 29 });
    expect(freeSlotsAt(lines, 30, 0)).toBe(30);
    expect(freeSlotsAt(lines, 30, 3600)).toBe(29);
  });

  test("they match the pacing replay at the end of every day of a bots golden and of scenario-late", () => {
    const g = listGoldens(FIXTURES_DIR).find(
      (x) => x.ref === "perfidia-1@1.0.0" && x.name.startsWith("lockstep-6p-4d-bots-"),
    );
    if (g === undefined) throw new Error("no 4-day perfidia-1 bots golden");
    for (const lines of [readLog(g.path), scenarioLate()]) {
      const header = lines[0];
      if (header?.k !== "header") throw new Error("no header");
      const initial = initialFreeSlots(header.setup, getRuleset(header.setup.ruleset));
      const p = pacingOf(lines);
      expect(p.report.ok).toBe(true);
      const end = lines.at(-1);
      if (end?.k !== "end") throw new Error("no end line");
      for (const d of p.days) {
        const t = Math.min(d.day * DAY, end.t);
        expect({ day: d.day, free: freeSlotsAt(lines, initial, t) }).toEqual({
          day: d.day,
          free: d.freeSlots,
        });
      }
      expect(freeSlotsOf(lines, initial, end.t).end).toBe(p.days.at(-1)?.freeSlots ?? -1);
    }
  }, 15000);
});
