import { describe, expect, test } from "bun:test";
import { type City, type GameState, GameStateSchema, type PlayerId } from "@perfidia/protocol";
import fc from "fast-check";
import { PERFIDIA_1_DEFAULTS } from "./config.ts";
import { initialExt, type PerfidiaExt } from "./ext.ts";
import {
  battleScore,
  cityPoints,
  computeStandings,
  type RankRow,
  rankPlayers,
  scoreRows,
  standingsOf,
  timeWinner,
} from "./scoring.ts";

// Score, standings and final ranking of perfidia-1 §13.1, §13.2 and §13.4.

const d = PERFIDIA_1_DEFAULTS;

const FRESH = {
  hall: 1,
  lumber: 1,
  quarry: 1,
  mine: 1,
  warehouse: 1,
  barracks: 0,
  harbor: 0,
  wall: 0,
};
const MAXED = {
  hall: 10,
  lumber: 10,
  quarry: 10,
  mine: 10,
  warehouse: 10,
  barracks: 10,
  harbor: 10,
  wall: 10,
};
const ALL5 = {
  hall: 5,
  lumber: 5,
  quarry: 5,
  mine: 5,
  warehouse: 5,
  barracks: 5,
  harbor: 5,
  wall: 5,
};

function city(
  n: number,
  owner: PlayerId | null,
  buildings: Record<string, number>,
  tag: string | null = null,
): City {
  return {
    id: `c${n}`,
    name: `c${n}`,
    owner,
    island: "i1",
    slot: n,
    capitalOf: null,
    tag,
    foundedAt: 0,
    stock: { wood: 0, stone: 0, gold: 0 },
    stockAt: 0,
    buildings,
    units: {},
    stationed: [],
    itemSeq: 0,
    build: [],
    recruit: { barracks: [], harbor: [] },
  };
}

function state(
  players: {
    id: PlayerId;
    alive?: boolean;
    eliminatedAt?: number | null;
    alliance?: `a${number}` | null;
  }[],
  cities: City[],
  ext: PerfidiaExt,
  alliances: Record<string, PlayerId[]> = {},
): GameState {
  return GameStateSchema.parse({
    v: 1,
    ruleset: "perfidia-1@1.0.0",
    configHash: "0".repeat(64),
    seed: 1,
    now: 0,
    status: "running",
    seq: 0,
    ids: { c: cities.length, a: Object.keys(alliances).length, own: {} },
    evHash: "cbf29ce484222325",
    queue: [],
    players: Object.fromEntries(
      players.map((p) => [
        p.id,
        {
          id: p.id,
          alive: p.alive ?? true,
          eliminatedAt: p.eliminatedAt ?? null,
          alliance: p.alliance ?? null,
        },
      ]),
    ),
    islands: { i1: { id: "i1", x: 0, y: 0, kind: "crown", slots: 20, richnessPm: 1000 } },
    cities: Object.fromEntries(cities.map((c) => [c.id, c])),
    movements: {},
    proposals: {},
    alliances: Object.fromEntries(
      Object.entries(alliances).map(([id, members]) => [
        id,
        { id, name: id, members, formedAt: 0 },
      ]),
    ),
    pacts: [],
    ledger: { neutral: { made: {}, gone: {} } },
    ext,
    result: null,
  });
}

describe("§13.1 score", () => {
  test("a fresh city is worth 105, a maxed city 180, the Crown 240", () => {
    expect(cityPoints(d, 5, false)).toBe(105);
    expect(cityPoints(d, 80, false)).toBe(180);
    expect(cityPoints(d, 40, true)).toBe(240);
  });

  test("battle score = min(floor(bp / 10), floor(cityPoints / 4))", () => {
    expect(battleScore(d, 234, 420)).toBe(23);
    expect(battleScore(d, 2340, 420)).toBe(105);
    expect(battleScore(d, 9, 105)).toBe(0);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100000 }),
        fc.integer({ min: 0, max: 5000 }),
        (bp, cp) => {
          const bs = battleScore(d, bp, cp);
          expect(bs).toBeLessThanOrEqual(Math.floor(cp / 4));
          expect(bs).toBeLessThanOrEqual(Math.floor(bp / 10));
          expect(bs).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  test("scoreRows counts owned cities, building levels, the Crown bonus and capped battle points", () => {
    const ext = initialExt(["p1", "p2", "p3"], ["p2", "p3", "p1"]);
    ext.battlePoints["p1"] = 2340;
    ext.battlePoints["p2"] = 95;
    const s = state(
      [{ id: "p1" }, { id: "p2" }, { id: "p3", alive: false, eliminatedAt: 5000 }],
      [
        city(1, "p1", FRESH),
        city(2, "p1", MAXED),
        city(3, "p2", ALL5, "crown"),
        city(4, null, ALL5, "crown"),
      ],
      ext,
    );
    expect(scoreRows(d, s, ext)).toEqual([
      {
        player: "p1",
        alive: true,
        eliminatedAt: null,
        score: 285 + 71,
        cities: 2,
        battlePoints: 2340,
        cityPoints: 285,
        battleScore: 71,
      },
      {
        player: "p2",
        alive: true,
        eliminatedAt: null,
        score: 249,
        cities: 1,
        battlePoints: 95,
        cityPoints: 240,
        battleScore: 9,
      },
      {
        player: "p3",
        alive: false,
        eliminatedAt: 5000,
        score: 0,
        cities: 0,
        battlePoints: 0,
        cityPoints: 0,
        battleScore: 0,
      },
    ]);
  });
});

const row = (
  player: PlayerId,
  score: number,
  cities: number,
  battlePoints = 0,
  eliminatedAt: number | null = null,
): RankRow => ({
  player,
  alive: eliminatedAt === null,
  eliminatedAt,
  score,
  cities,
  battlePoints,
});

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

describe("§13.4 final ranking", () => {
  test("winners first, then survivors by score, cities, battle points and tie-break order", () => {
    const rows = [
      row("p1", 500, 4),
      row("p2", 600, 5),
      row("p3", 500, 5),
      row("p4", 500, 4, 30),
      row("p5", 500, 4, 30),
      row("p6", 300, 2),
    ];
    const tiebreak: PlayerId[] = ["p6", "p5", "p4", "p3", "p2", "p1"];
    expect(rankPlayers(rows, [], tiebreak)).toEqual(["p2", "p3", "p5", "p4", "p1", "p6"]);
    expect(rankPlayers(rows, ["p6", "p1"], tiebreak)).toEqual(["p1", "p6", "p2", "p3", "p5", "p4"]);
  });

  test("eliminated players last: latest elimination first, then tie-break order", () => {
    const rows = [
      row("p1", 0, 0, 0, 100000),
      row("p2", 0, 0, 0, 200000),
      row("p3", 105, 1),
      row("p4", 0, 0, 0, 100000),
    ];
    expect(rankPlayers(rows, [], ["p4", "p3", "p2", "p1"])).toEqual(["p3", "p2", "p4", "p1"]);
    expect(rankPlayers(rows, [], ["p1", "p2", "p3", "p4"])).toEqual(["p3", "p2", "p1", "p4"]);
  });

  test("standings: no shared ranks, public parts only", () => {
    const ext = initialExt(["p1", "p2"], ["p2", "p1"]);
    // 9 raw battle points give no battle score, but break the tie against the tie-break order.
    ext.battlePoints["p1"] = 9;
    const s = state(
      [{ id: "p1" }, { id: "p2" }],
      [city(1, "p1", FRESH), city(2, "p2", FRESH)],
      ext,
    );
    const standings = computeStandings(d, s, ext);
    expect(standings).toEqual([
      {
        player: "p1",
        rank: 1,
        score: 105,
        parts: { cityPoints: 105, battleScore: 0 },
        cities: 1,
        alive: true,
      },
      {
        player: "p2",
        rank: 2,
        score: 105,
        parts: { cityPoints: 105, battleScore: 0 },
        cities: 1,
        alive: true,
      },
    ]);
    expect(JSON.stringify(standings)).not.toContain("9");
    expect(JSON.stringify(standings)).not.toContain("battlePoints");
    const ext2 = initialExt(["p1", "p2"], ["p2", "p1"]);
    expect(standingsOf(scoreRows(d, s, ext2), [], ext2.tiebreak).map((x) => x.player)).toEqual([
      "p2",
      "p1",
    ]);
    const winners = computeStandings(d, s, ext2, ["p1"]);
    expect(winners.map((x) => [x.player, x.rank])).toEqual([
      ["p1", 1],
      ["p2", 2],
    ]);
  });

  test("raw battle points break a tie of score and cities", () => {
    const rows = [row("p1", 105, 1, 49), row("p2", 105, 1, 50)];
    expect(rankPlayers(rows, [], ["p1", "p2"])).toEqual(["p2", "p1"]);
  });

  test("the time winner is the first survivor", () => {
    const rows = [row("p1", 100, 1), row("p2", 300, 2), row("p3", 0, 0, 0, 5)];
    expect(timeWinner(rows, ["p1", "p2", "p3"])).toBe("p2");
    expect(timeWinner([row("p1", 0, 0, 0, 5)], ["p1"])).toBeNull();
  });

  test("the ranking is a permutation and deterministic (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            score: fc.integer({ min: 0, max: 1000 }),
            cities: fc.integer({ min: 0, max: 10 }),
            bp: fc.integer({ min: 0, max: 500 }),
            out: fc.option(fc.integer({ min: 1, max: 600000 })),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        fc.integer({ min: 0, max: 1000 }),
        (specs, salt) => {
          const rows = specs.map((s, i) => row(`p${i + 1}`, s.score, s.cities, s.bp, s.out));
          const tiebreak = rows
            .map((r) => r.player)
            .toSorted((a, b) => ((a.length * salt) % 7) - ((b.length * salt) % 7) || byText(a, b));
          const ranked = rankPlayers(rows, [], tiebreak);
          expect(ranked.toSorted(byText)).toEqual(rows.map((r) => r.player).toSorted(byText));
          expect(rankPlayers(rows.toReversed(), [], tiebreak)).toEqual(ranked);
        },
      ),
    );
  });
});
