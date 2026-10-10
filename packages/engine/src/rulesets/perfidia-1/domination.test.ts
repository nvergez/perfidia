import { describe, expect, test } from "bun:test";
import {
  type AllianceId,
  type GameState,
  GameStateSchema,
  type PlayerId,
} from "@perfidia/protocol";
import fc from "fast-check";
import { PERFIDIA_1_DEFAULTS } from "./config.ts";
import {
  bestTiebreak,
  blocCities,
  blocsOf,
  dominationThreshold,
  orderEndingCountdowns,
  qualifies,
  totalCities,
} from "./domination.ts";
import { initialExt } from "./ext.ts";

// Domination of perfidia-1 §13.3: blocs, qualification and same-second ordering.

const d = PERFIDIA_1_DEFAULTS;

/** A state with `owners[i]` owning city c(i+1) (null = neutral) and the given alliances. */
function state(
  players: { id: PlayerId; alive?: boolean; alliance?: AllianceId }[],
  owners: (PlayerId | null)[],
  alliances: Record<AllianceId, PlayerId[]> = {},
): GameState {
  const cities = owners.map((owner, i) => ({
    id: `c${i + 1}`,
    name: `c${i + 1}`,
    owner,
    island: "i1",
    slot: i,
    capitalOf: null,
    tag: null,
    foundedAt: 0,
    stock: { wood: 0, stone: 0, gold: 0 },
    stockAt: 0,
    buildings: { hall: 1 },
    units: {},
    stationed: [],
    itemSeq: 0,
    build: [],
    recruit: {},
  }));
  return GameStateSchema.parse({
    v: 1,
    ruleset: "perfidia-1@1.0.0",
    configHash: "0".repeat(64),
    seed: 1,
    now: 300000,
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
          eliminatedAt: p.alive === false ? 1 : null,
          alliance: p.alliance ?? null,
        },
      ]),
    ),
    islands: { i1: { id: "i1", x: 0, y: 0, kind: "home", slots: 99, richnessPm: 1000 } },
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
    ext: initialExt(
      players.map((p) => p.id),
      players.map((p) => p.id),
    ),
    result: null,
  });
}

describe("threshold", () => {
  test("max(2N, ceilDiv(400 × totalCities, 1000))", () => {
    expect(dominationThreshold(d, 6, 7)).toBe(12);
    expect(dominationThreshold(d, 6, 43)).toBe(18);
    expect(dominationThreshold(d, 8, 49)).toBe(20);
    expect(dominationThreshold(d, 12, 73)).toBe(30);
    expect(dominationThreshold(d, 12, 25)).toBe(24);
    expect(dominationThreshold(d, 6, 31)).toBe(13);
  });

  test("qualification is monotone in the bloc's cities (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 6, max: 12 }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (n, total, cities) => {
          if (qualifies(d, n, total, cities)) expect(qualifies(d, n, total, cities + 1)).toBe(true);
          expect(qualifies(d, n, total, dominationThreshold(d, n, total))).toBe(true);
        },
      ),
    );
  });
});

describe("blocs", () => {
  test("alliances by id, then lone alive players by id; eliminated players form no bloc", () => {
    const s = state(
      [
        { id: "p1" },
        { id: "p2", alliance: "a2" },
        { id: "p3", alliance: "a10" },
        { id: "p4", alive: false },
        { id: "p10" },
        { id: "p5", alliance: "a2" },
        { id: "p6", alliance: "a10" },
      ],
      ["p1", "p2", "p3", null],
      { a2: ["p5", "p2"], a10: ["p3", "p6"] },
    );
    expect(blocsOf(s)).toEqual([
      { key: "a2", alliance: "a2", members: ["p2", "p5"] },
      { key: "a10", alliance: "a10", members: ["p3", "p6"] },
      { key: "p1", alliance: null, members: ["p1"] },
      { key: "p10", alliance: null, members: ["p10"] },
    ]);
  });

  test("cities: every city counts in the total, the Crown included; a bloc counts its members'", () => {
    const s = state(
      [{ id: "p1", alliance: "a1" }, { id: "p2", alliance: "a1" }, { id: "p3" }],
      ["p1", "p1", "p2", "p3", null],
      { a1: ["p1", "p2"] },
    );
    expect(totalCities(s)).toBe(5);
    expect(blocCities(s, ["p1", "p2"])).toBe(3);
    expect(blocCities(s, ["p3"])).toBe(1);
  });
});

describe("same-second countdown ends", () => {
  test("more cities, then higher total score, then best tie-break position", () => {
    expect(
      orderEndingCountdowns([
        { bloc: "p3", cities: 20, score: 2000, bestTiebreak: 4 },
        { bloc: "a1", cities: 21, score: 1000, bestTiebreak: 5 },
        { bloc: "a2", cities: 20, score: 2000, bestTiebreak: 1 },
        { bloc: "p7", cities: 20, score: 2100, bestTiebreak: 9 },
      ]),
    ).toEqual(["a1", "p7", "a2", "p3"]);
  });

  test("best tie-break position among members", () => {
    const tiebreak: PlayerId[] = ["p4", "p2", "p1", "p3"];
    expect(bestTiebreak(tiebreak, ["p1", "p3"])).toBe(2);
    expect(bestTiebreak(tiebreak, ["p3", "p2"])).toBe(1);
    expect(() => bestTiebreak(tiebreak, ["p9"])).toThrow(RangeError);
  });
});
