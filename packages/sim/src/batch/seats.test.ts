// Per seat and per bot (docs/architecture.md §12.2): score parts read from the final standings,
// the Crown and building-level points derived from the log when the standings do not expose them,
// battle points from the full reports, cities founded, conquered and lost, eliminations suffered
// and inflicted; the per-bot rows with wins per seat and their 95% Wilson interval. Exact on
// hand-written lines (under the committed `scenario-late` header) and on that golden itself.

import { describe, expect, test } from "bun:test";
import { LogLineSchema, type LogLine } from "@perfidia/protocol";
import { FIXTURES_DIR } from "../golden/index.ts";
import { listGoldens, readLog } from "../harness/index.ts";
import { summarize } from "../summary/index.ts";
import { battleRecords, botName, seatRows, strategyRows, wilson, type SeatRow } from "./index.ts";

function scenarioLate(): LogLine[] {
  const g = listGoldens(FIXTURES_DIR).find(
    (x) => x.ref === "perfidia-1@1.0.0" && x.name === "scenario-late",
  );
  if (g === undefined) throw new Error("scenario-late is not committed");
  return readLog(g.path);
}

const ev = (t: number, type: string, data: Record<string, unknown> = {}): unknown => ({
  k: "ev",
  t,
  e: { t, type, public: true, to: [], data },
});

const battle = (
  t: number,
  city: string,
  attacker: string,
  defender: string,
  defenders: readonly number[],
  points: readonly [string, number][],
): unknown[] => [
  ev(t, "battle_report", {
    report: `r${t}`,
    city,
    attacker,
    defender,
    kind: "city",
    winner: "attacker",
    stacks: defenders.map((before) => ({ side: "defender", owner: defender, before })),
    points: points.map(([player, p]) => ({ player, points: p })),
  }),
  ev(t, "battle", { city, attacker, defender, kind: "city", winner: "attacker" }),
];

const standing = (
  player: string,
  rank: number,
  cities: number,
  parts: Record<string, number>,
  alive = true,
) => ({
  player,
  rank,
  score: Object.values(parts).reduce((a, b) => a + b, 0),
  parts,
  cities,
  alive,
});

/** Hand-written events under the scenario-late header (its config: cityBase 100, crownBonus 100). */
function handWritten(
  o: { readonly config?: Record<string, unknown>; readonly parts?: boolean } = {},
) {
  const header = scenarioLate()[0];
  if (header?.k !== "header") throw new Error("no header");
  const levels = o.parts === true;
  const rows: unknown[] = [
    { ...header, ...(o.config === undefined ? {} : { config: o.config }) },
    ev(100, "city_founded", { city: "c8", island: "i2", slot: 0, owner: "p1" }),
    ...battle(150, "c7", "p2", "neutral", [400], [["p2", 50]]),
    ev(200, "city_conquered", { city: "c7", from: null, to: "p2" }),
    ev(300, "city_conquered", { city: "c8", from: "p1", to: "p3" }),
    ev(400, "city_conquered", { city: "c1", from: "p1", to: "p3" }),
    ev(400, "player_eliminated", { player: "p1" }),
    ...battle(500, "c4", "p3", "p4", [], [["p3", 30]]),
    {
      k: "end",
      t: 1000,
      h: "0".repeat(16),
      result: {
        endedAt: 1000,
        reason: "time",
        winners: ["p3"],
        standings: [
          standing("p3", 1, 3, {
            cityPoints: 340,
            battleScore: 3,
            ...(levels ? { levelPoints: 7 } : {}),
          }),
          standing("p2", 2, 2, { cityPoints: 320, battleScore: 5 }),
          standing("p5", 3, 1, { cityPoints: 110, battleScore: 0 }),
          standing("p4", 4, 1, { cityPoints: 105, battleScore: 0 }),
          standing("p6", 5, 1, { cityPoints: 101, battleScore: 0 }),
          standing("p1", 6, 0, { cityPoints: 105, battleScore: 0 }, false),
        ],
      },
    },
  ];
  return rows.map((r) => LogLineSchema.parse(r));
}

const bySeat = (rows: readonly SeatRow[]): Record<string, SeatRow> =>
  Object.fromEntries(rows.map((r) => [r.seat, r]));

/** The rows with other bot labels. */
const rename = (rows: readonly SeatRow[], bot: (i: number) => string): SeatRow[] =>
  rows.map((x, i) => Object.assign({}, x, { bot: bot(i) }));

describe("seat rows", () => {
  test("parts from the standings, Crown and level points derived, cities and eliminations from the events", () => {
    const lines = handWritten();
    const s = summarize(lines);
    const rows = seatRows(lines, s, battleRecords(lines));
    expect(rows.map((r) => r.seat)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);
    const r = bySeat(rows);
    expect(r["p3"]).toEqual({
      seat: "p3",
      bot: "scenario:late@1",
      winner: true,
      rank: 1,
      score: 343,
      parts: { battleScore: 3, cityPoints: 340 },
      cityPoints: 340,
      levelPoints: 40,
      crownPoints: 0,
      battleScore: 3,
      battlePoints: 30,
      cities: 3,
      founded: 0,
      conquered: 2,
      lost: 0,
      crowns: 0,
      eliminatedAt: null,
      eliminatedBy: null,
      eliminations: 1,
    });
    // The Crown (taken from no owner) is worth crownBonus to its holder.
    expect(r["p2"]).toMatchObject({
      crowns: 1,
      crownPoints: 100,
      levelPoints: 20,
      battlePoints: 50,
    });
    // An eliminated seat's score is frozen with its last city: not split.
    expect(r["p1"]).toMatchObject({
      winner: false,
      founded: 1,
      conquered: 0,
      lost: 2,
      cities: 0,
      cityPoints: 105,
      levelPoints: null,
      crownPoints: null,
      battlePoints: 0,
      eliminatedAt: 400,
      eliminatedBy: "p3",
      eliminations: 0,
    });
    expect(r["p4"]).toMatchObject({ lost: 0, battlePoints: 0, levelPoints: 5 });
  });

  test("a part the standings expose is taken as is; without the scoring keys nothing is derived", () => {
    const lines = handWritten({ config: {}, parts: true });
    const rows = bySeat(seatRows(lines, summarize(lines), battleRecords(lines)));
    expect(rows["p3"]).toMatchObject({ levelPoints: 7, crownPoints: null });
    expect(rows["p2"]).toMatchObject({ levelPoints: null, crownPoints: null, crowns: 1 });
    // Battles whose reports carry no points: battle points unknown. No battle at all: zero.
    const noPoints = lines.map((l) =>
      l.k === "ev" && l.e.type === "battle_report"
        ? { ...l, e: { ...l.e, data: { ...l.e.data, points: "?" } } }
        : l,
    );
    expect(seatRows(noPoints, summarize(noPoints), battleRecords(noPoints))[0]?.battlePoints).toBe(
      null,
    );
    expect(seatRows(lines, summarize(lines), [])[0]?.battlePoints).toBe(0);
  });

  test("an unfinished match: no standings, the events still counted", () => {
    const lines = handWritten().slice(0, -1);
    const r = bySeat(seatRows(lines, summarize(lines), battleRecords(lines)));
    expect(r["p3"]).toMatchObject({
      rank: null,
      score: null,
      parts: {},
      cityPoints: null,
      levelPoints: null,
      cities: null,
      conquered: 2,
      eliminations: 1,
      winner: false,
    });
  });

  test("the scenario-late golden", () => {
    const lines = scenarioLate();
    const r = bySeat(seatRows(lines, summarize(lines), battleRecords(lines)));
    expect(r["p1"]).toMatchObject({
      winner: true,
      rank: 1,
      score: 332,
      cityPoints: 315,
      levelPoints: 15,
      crownPoints: 0,
      battleScore: 17,
      // 94 + 70 + 5 + 5, one copy per battle; floor(174 / 10) = 17.
      battlePoints: 174,
      cities: 3,
      founded: 0,
      conquered: 2,
      lost: 0,
      eliminations: 1,
    });
    expect(r["p4"]).toMatchObject({ founded: 1, lost: 1, cities: 1, battlePoints: 9 });
    expect(r["p6"]).toMatchObject({
      lost: 1,
      cities: 0,
      eliminatedAt: 11410,
      eliminatedBy: "p1",
      levelPoints: null,
      battlePoints: 2,
    });
    expect(Object.values(r).every((x) => x.bot === "scenario:late@1")).toBe(true);
  });

  test("bot names drop the bot: prefix only", () => {
    expect(botName("bot:rusher@2")).toBe("rusher@2");
    expect(botName("llm:x")).toBe("llm:x");
  });
});

describe("bot rows", () => {
  test("the 95% Wilson interval", () => {
    expect(wilson(12, 30)).toEqual([0.246, 0.577]);
    expect(wilson(0, 6)).toEqual([0, 0.39]);
    expect(wilson(6, 6)).toEqual([0.61, 1]);
    expect(wilson(1, 2)).toEqual([0.095, 0.905]);
    expect(wilson(0, 0)).toEqual([0, 1]);
  });

  test("per bot label over the seats of ended runs: wins per seat, means and totals", () => {
    const lines = handWritten();
    const seats = rename(seatRows(lines, summarize(lines), battleRecords(lines)), (i) =>
      i % 2 === 0 ? "b@1" : "a@1",
    );
    // p1, p3, p5 are b@1; p2, p4, p6 are a@1. The fatal run's seats are left out.
    const rows = strategyRows([
      { status: "ended", seats },
      { status: "ended", seats },
      { status: "fatal", seats: rename(seats, () => "c@1") },
    ]);
    expect(rows.map((x) => x.bot)).toEqual(["a@1", "b@1"]);
    const [a, b] = rows;
    expect(b).toEqual({
      bot: "b@1",
      seats: 6,
      wins: 2,
      winsPerSeat: 0.333,
      winsPerSeatCi: wilson(2, 6),
      score: 186,
      cityPoints: 185,
      // p1's frozen score is not split: the mean of p3 (40) and p5 (10).
      levelPoints: 25,
      crownPoints: 0,
      battleScore: 1,
      battlePoints: 10,
      cities: 1.33,
      founded: 0.33,
      conquered: 0.67,
      lost: 0.67,
      crowns: 0,
      eliminated: 2,
      inflicted: 2,
    });
    expect(a).toMatchObject({
      seats: 6,
      wins: 0,
      winsPerSeat: 0,
      winsPerSeatCi: [0, 0.39],
      crownPoints: 33.33,
      crowns: 2,
      eliminated: 0,
      inflicted: 0,
    });
    expect(strategyRows([])).toEqual([]);
  });
});
