// Teamwork in a batch row (docs/architecture.md §12.2): joint attacks (allied attackers landing at
// one city within an hour, with the war call behind them), sieges and how they were held, war-call
// messages and the reach of the R1 domination rule (perfidia-1@1.1.0 §13.3; for a 1.0.0 log, 1.1.0's
// defaults). Exact on hand-written lines; then one real batch, whose teamwork must agree with
// its own log and summary.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeAck, composeCall, composeCancel, parseWar } from "@perfidia/bots";
import { LogLineSchema, type LogLine, type PlayerId } from "@perfidia/protocol";
import { DEFAULT_BOTS } from "../harness/index.ts";
import { readLog } from "../io/index.ts";
import { summarize } from "../summary/index.ts";
import {
  BATCH_FORMAT,
  JOINT_WINDOW,
  batchRunDir,
  parseVariant,
  runBatch,
  siegeCounts,
  teamBotRows,
  teamRecords,
  teamStat,
  type InitialMap,
  type TeamOfMatch,
} from "./index.ts";

function log(rows: readonly unknown[]): LogLine[] {
  return rows.map((r) => LogLineSchema.parse(r));
}

const ev = (t: number, type: string, data: Record<string, unknown> = {}): unknown => ({
  k: "ev",
  t,
  e: { t, type, public: true, to: [], data },
});

const controllers = (labels: readonly string[]): unknown[] =>
  labels.map((label, i) => ({ k: "controller", t: 0, seat: `p${i + 1}`, label }));

const SEATS = [
  "bot:conqueror@2",
  "bot:expander@2",
  "bot:turtle@2",
  "bot:rusher@3",
  "bot:opportunist@2",
  "bot:expander@2",
];

const battle = (t: number, city: string, attacker: string, defender: string, kind = "city") =>
  ev(t, "battle", { city, attacker, defender, kind, winner: "attacker" });

const support = (n: number, t: number, seat: string, to: string, ok = true): unknown => ({
  k: "act",
  n,
  t,
  seat,
  turn: 1,
  rt: 0,
  tool: "support",
  i: 0,
  a: { type: "support", from: "c1", to, units: { guard: 5 } },
  r: ok ? { ok: true } : { ok: false, code: "CITY_BESIEGED" },
});

const message = (t: number, from: string, to: readonly string[] | "all", text: string) =>
  ev(t, "message", { message: "g0000a", from, to, text });

describe("joint attacks", () => {
  const lines = log([
    ...controllers(SEATS),
    ev(100, "alliance_formed", { alliance: "a1", name: "a1", members: ["p1", "p2"] }),
    message(500, "p1", ["p2"], "WAR#k1 strike c9 land D1 00:15-00:35"),
    // c9: p1 and p2 within the hour, p3 (not allied) in between, a homecoming apart.
    battle(1000, "c9", "p1", "p5"),
    battle(1100, "c9", "p2", "p5", "homecoming"),
    battle(1500, "c9", "p3", "p5"),
    battle(2000, "c9", "p2", "p5"),
    // c9 again later: 4000 s apart, not joint.
    battle(9000, "c9", "p1", "p5"),
    battle(13000, "c9", "p2", "p5"),
    // c10: exactly an hour apart, joint, no call behind it.
    battle(5000, "c10", "p1", "p6"),
    battle(5000 + JOINT_WINDOW, "c10", "p2", "p6"),
    // c12: a chain of three waves within the hour of each other, one joint attack.
    battle(30000, "c12", "p1", "p4"),
    battle(33000, "c12", "p2", "p4"),
    battle(36000, "c12", "p1", "p4"),
    // p2 leaves: no longer allied.
    ev(40000, "alliance_left", { alliance: "a1", player: "p2", cause: "left" }),
    ev(40000, "alliance_dissolved", { alliance: "a1" }),
    battle(41000, "c11", "p1", "p6"),
    battle(41500, "c11", "p2", "p6"),
  ]);
  const { joint } = teamRecords(lines, null);

  test("allied attackers landing within the hour, by city, with the call behind them", () => {
    expect(joint).toEqual([
      {
        t: 1000,
        last: 2000,
        city: "c9",
        defender: "p5",
        players: ["p1", "p2"],
        bots: ["conqueror@2", "expander@2"],
        battles: 2,
        caller: "p1",
      },
      {
        t: 5000,
        last: 5000 + JOINT_WINDOW,
        city: "c10",
        defender: "p6",
        players: ["p1", "p2"],
        bots: ["conqueror@2", "expander@2"],
        battles: 2,
        caller: null,
      },
      {
        t: 30000,
        last: 36000,
        city: "c12",
        defender: "p4",
        players: ["p1", "p2"],
        bots: ["conqueror@2", "expander@2"],
        battles: 3,
        caller: null,
      },
    ]);
  });

  test("per bot label: as the caller or as a participant", () => {
    const rows = teamBotRows([{ ...teamRecords(lines, null), ...asMatch(lines) }]);
    expect(rows.map((r) => [r.bot, r.jointCalled, r.jointJoined])).toEqual([
      ["conqueror@2", 1, 2],
      ["expander@2", 0, 3],
    ]);
  });
});

/** What the aggregates read of a match, from its lines. */
function asMatch(lines: readonly LogLine[], initial: InitialMap | null = null): TeamOfMatch {
  const r = teamRecords(lines, initial);
  return { joint: r.joint, sieges: r.sieges, warCalls: r.calls, warCallers: r.callers, r1: r.r1 };
}

describe("sieges", () => {
  const lines = log([
    ...controllers(SEATS),
    ev(40000, "siege_started", { city: "c20", owner: "p3", by: "p1", endsAt: 61600 }),
    ev(40000, "support_arrived", { movement: "m0000b", by: "p1", to: "c20" }),
    support(1, 41000, "p1", "c20"),
    support(2, 41000, "p1", "c20", false),
    support(3, 41000, "p4", "c20"),
    ev(43000, "support_arrived", { movement: "m0000c", by: "p1", to: "c20", units: { guard: 5 } }),
    ev(43000, "support_arrived", { movement: "m0000c", by: "p1", to: "c20" }),
    battle(45000, "c20", "p3", "p1", "relief"),
    battle(46000, "c20", "p3", "p1", "homecoming"),
    ev(50000, "siege_started", { city: "c21", owner: "p4", by: "p2", endsAt: 71600 }),
    support(4, 50500, "p1", "c21"),
    ev(51000, "support_arrived", { movement: "m0000d", by: "p4", to: "c21" }),
    battle(52000, "c21", "p6", "p2", "relief"),
    ev(52000, "siege_broken", { city: "c21", owner: "p4", by: "p2", cause: "relief" }),
    ev(53000, "siege_started", { city: "c22", owner: "p5", by: "p2", endsAt: 74600 }),
    ev(54000, "siege_broken", { city: "c22", owner: "p5", by: "p2", cause: "abandoned" }),
    ev(61600, "city_conquered", { city: "c20", from: "p3", to: "p1" }),
    ev(70000, "siege_started", { city: "c23", owner: "p6", by: "p4", endsAt: 91600 }),
    ev(71000, "siege_started", { city: "c24", owner: "p6", by: "p4", endsAt: 92600 }),
    ev(72000, "siege_broken", { city: "c24", owner: "p6", by: "p4", cause: "homecoming" }),
  ]);
  const { sieges } = teamRecords(lines, null);

  test("each siege: reinforcements sent and joined, reliefs, homecomings and how it ended", () => {
    expect(
      sieges.map((s) => [
        s.city,
        s.by,
        s.bot,
        s.joined,
        s.sent,
        s.reliefs,
        s.homecomings,
        s.outcome,
      ]),
    ).toEqual([
      ["c20", "p1", "conqueror@2", 2, 1, 1, 1, "conquered"],
      ["c21", "p2", "expander@2", 0, 0, 1, 0, "relief"],
      ["c22", "p2", "expander@2", 0, 0, 0, 0, "abandoned"],
      ["c23", "p4", "rusher@3", 0, 0, 0, 0, "open"],
      ["c24", "p4", "rusher@3", 0, 0, 0, 0, "homecoming"],
    ]);
    expect(sieges.map((s) => s.endedAt)).toEqual([61600, 52000, 54000, null, 72000]);
  });

  test("counted by how they were held and ended, in total and per besieger", () => {
    expect(siegeCounts(sieges)).toEqual({
      sieges: 5,
      reinforced: 1,
      relieved: 2,
      conquered: 1,
      broken: 1,
      abandoned: 1,
      other: 2,
    });
    const rows = teamBotRows([asMatch(lines)]);
    expect(rows.map((r) => [r.bot, r.sieges.sieges, r.sieges.conquered, r.sieges.other])).toEqual([
      ["conqueror@2", 1, 1, 0],
      ["expander@2", 2, 0, 0],
      ["rusher@3", 2, 0, 2],
    ]);
  });
});

describe("war-call messages", () => {
  const call = composeCall({
    id: "k1",
    role: "strike",
    target: "c9",
    t0: 3600,
    t1: 4800,
    vs: null,
    lands: null,
  });
  const lines = log([
    ...controllers(SEATS),
    message(100, "p1", ["p2", "p4"], call),
    message(200, "p2", ["p1"], composeAck("k1", true, 4000)),
    message(250, "p2", ["p1"], composeAck("k1", true, 4100)),
    message(300, "p4", ["p1"], composeAck("k1", false, null, "too far")),
    message(310, "p5", ["p1"], composeAck("k1", true, 4000)),
    message(320, "p3", "all", "WAR#k2 strike c9 land D1 01:00-01:10"),
    message(330, "p2", ["p1"], composeCancel("k1")),
    message(340, "p1", ["p2", "p4"], composeCancel("k1", "target gone")),
    message(350, "p1", ["p2"], "WAR#zz hello there"),
    message(360, "p1", ["p2"], "we remain friends"),
  ]);
  const r = teamRecords(lines, null);

  test("calls, the calls answered, answers yes and no, cancels; anything else is stray", () => {
    expect(r.calls).toEqual({ calls: 1, answered: 1, yes: 2, no: 1, cancels: 1, stray: 3 });
  });

  test("per sender controller", () => {
    expect(r.callers).toEqual({
      "conqueror@2": { calls: 1, yes: 0, no: 0 },
      "expander@2": { calls: 0, yes: 2, no: 0 },
      "rusher@3": { calls: 0, yes: 0, no: 1 },
    });
  });
});

const found = (t: number, city: number, owner: string) =>
  ev(t, "city_founded", { city: `c${city}`, island: "i2", slot: 0, owner });

/** The R1 rule of perfidia-1@1.1.0's defaults at N = 6. */
const RULE = {
  pm: 350,
  minPerPlayer: 3,
  players: 6,
  minConquests: 2,
  open: 259200,
  hold: 86400,
  matchEnd: 604800,
};

describe("R1 reach", () => {
  // Six seats with their capitals c1..c6, the neutral c7, 43 slots: R1 needs 16 cities.
  const owners = new Map<string, PlayerId | null>([
    ...Array.from({ length: 6 }, (_, i): [string, PlayerId] => [`c${i + 1}`, `p${i + 1}`]),
    ["c7", null],
  ]);
  const initial: InitialMap = { slots: 43, owners };
  test("the largest bloc, the bloc with conquests and the first time R1 was met", () => {
    const rows: unknown[] = [
      ...controllers(SEATS),
      // p1 and p2 found 7 cities each: 16 cities with their capitals, none conquered.
      ...Array.from({ length: 14 }, (_, i) => found(1000 + i, 8 + i, i % 2 === 0 ? "p1" : "p2")),
      ev(2000, "alliance_formed", { alliance: "a1", name: "a1", members: ["p1", "p2"] }),
      // A lone p5 takes the neutral city and one of p3's: 3 cities, 2 conquered.
      ev(3000, "city_conquered", { city: "c7", from: null, to: "p5" }),
      ev(3100, "city_conquered", { city: "c3", from: "p3", to: "p5" }),
      ev(3100, "player_eliminated", { player: "p3" }),
      // The alliance takes two of p4's (its capital and one founded later): 18 with 2 conquered.
      found(3500, 22, "p4"),
      ev(4000, "city_conquered", { city: "c4", from: "p4", to: "p1" }),
      ev(5000, "city_conquered", { city: "c22", from: "p4", to: "p2" }),
      ev(5000, "player_eliminated", { player: "p4" }),
    ];
    const r1 = teamRecords(log(rows), initial).r1;
    // Both conquests took cities from p4, outside the bloc; the log ends as R1 is met, so it was
    // never held for 24 h.
    expect(r1).toEqual({
      slots: 43,
      need: 16,
      needTaken: 2,
      maxCities: 18,
      maxConquered: 2,
      maxAt: 5000,
      maxBloc: ["conqueror@2", "expander@2"],
      fightingMax: 18,
      shortfall: 0,
      mostConquered: 2,
      reachedAt: 5000,
      reachedBy: ["conqueror@2", "expander@2"],
      takenFromBloc: 0,
      heldAt: null,
    });
    // Without the second conquest the bloc stays at 17, one conquered: R1 not met. The best bloc
    // with 2 taken cities is p5's 3, 13 short of 16.
    const short = teamRecords(log(rows.slice(0, -2)), initial).r1;
    expect(short?.reachedAt).toBeNull();
    expect([short?.maxCities, short?.maxConquered, short?.fightingMax]).toEqual([17, 1, 3]);
    expect(short?.shortfall).toBe(13);
    expect(teamRecords(log(rows), null).r1).toBeNull();
  });

  test("a city is taken by an owner that never owned it: a recapture is not, an ally's is", () => {
    // A threshold of 1 city with 2 taken: only the taken count matters.
    const rule = { ...RULE, pm: 1, minPerPlayer: 1, players: 1, minConquests: 2 };
    const r1 = (rows: readonly unknown[]) =>
      teamRecords(log([...controllers(SEATS), ...rows]), { slots: 43, owners, rule }).r1;
    // p1 takes c2 from p2, p2 takes it back (not taken: p2 owned it) and takes c4 from p4: p2
    // holds one taken city, not two. Counting every conquest, it would have had two.
    const recapture = [
      ev(1000, "city_conquered", { city: "c2", from: "p2", to: "p1" }),
      ev(2000, "city_conquered", { city: "c2", from: "p1", to: "p2" }),
      ev(3000, "city_conquered", { city: "c4", from: "p4", to: "p2" }),
    ];
    expect(r1(recapture)).toMatchObject({ reachedAt: null, mostConquered: 1, fightingMax: null });
    // p1 takes c3 from p3 and loses it to p4; p1's ally p5 takes it from p4 (taken for p5, though
    // p1 owned it: laundering through an ally) and takes c6 from p6: the bloc has two, one of them
    // taken from a member of the bloc.
    const laundering = [
      ev(500, "alliance_formed", { alliance: "a1", name: "a1", members: ["p1", "p5"] }),
      ev(1000, "city_conquered", { city: "c3", from: "p3", to: "p1" }),
      ev(2000, "city_conquered", { city: "c3", from: "p1", to: "p4" }),
      ev(3000, "city_conquered", { city: "c3", from: "p4", to: "p5" }),
      ev(4000, "city_conquered", { city: "c6", from: "p6", to: "p5" }),
    ];
    expect(r1(laundering)).toMatchObject({ reachedAt: 4000, takenFromBloc: 1, mostConquered: 2 });
  });

  test("with the match's rule: the 2N floor, the taken cities, and a 24 h hold from the opening", () => {
    // 4 seats' worth of floor (minPerPlayer 3 × 6 = 18) over 1‰ of 43 slots: 18 cities, 1 taken.
    const rule = { ...RULE, pm: 1, minConquests: 1 };
    const rows: unknown[] = [
      ...controllers(SEATS),
      ...Array.from({ length: 15 }, (_, i) => found(1000 + i, 8 + i, i % 2 === 0 ? "p1" : "p2")),
      ev(2000, "alliance_formed", { alliance: "a1", name: "a1", members: ["p1", "p2"] }),
      // 17 cities, then a conquest from p3: 18 with 1 taken, before the opening (day 4).
      ev(100000, "city_conquered", { city: "c3", from: "p3", to: "p1" }),
      ev(100000, "player_eliminated", { player: "p3" }),
      ev(400000, "message", { from: "p4", to: "all", text: "still here" }),
    ];
    const r1 = teamRecords(log(rows), { slots: 43, owners, rule }).r1;
    expect(r1).toMatchObject({ need: 18, needTaken: 1, reachedAt: 100000, takenFromBloc: 0 });
    // Met from t = 100000, counted from the opening at 259200: held 24 h later.
    expect(r1?.heldAt).toBe(259200 + 86400);
    // A member leaving before the hold ends breaks it.
    const left = [
      ...rows.slice(0, -1),
      ev(300000, "alliance_left", { alliance: "a1", player: "p2", cause: "left" }),
      ...rows.slice(-1),
    ];
    expect(teamRecords(log(left), { slots: 43, owners, rule }).r1?.heldAt).toBeNull();
    // A match ending before the hold ends: never held.
    const ended = { ...rule, matchEnd: 300000 };
    expect(teamRecords(log(rows), { slots: 43, owners, rule: ended }).r1?.heldAt).toBeNull();
  });
});

describe("a variant's teamwork", () => {
  test("totals and means over the runs", () => {
    const base: TeamOfMatch = {
      joint: [],
      sieges: [],
      warCalls: { calls: 0, answered: 0, yes: 0, no: 0, cancels: 0, stray: 0 },
      warCallers: {},
      r1: {
        slots: 43,
        need: 18,
        needTaken: 2,
        maxCities: 12,
        maxConquered: 0,
        maxAt: 100,
        maxBloc: [],
        fightingMax: null,
        shortfall: null,
        mostConquered: 0,
        reachedAt: null,
        reachedBy: [],
        takenFromBloc: null,
        heldAt: null,
      },
    };
    const joint = {
      t: 1,
      last: 2,
      city: "c9",
      defender: "p5",
      players: ["p1", "p2"] as PlayerId[],
      bots: ["a@1", "b@1"],
      battles: 2,
      caller: "p1" as PlayerId,
    };
    const stat = teamStat([
      base,
      {
        ...base,
        joint: [joint, { ...joint, caller: null }],
        warCalls: { calls: 2, answered: 1, yes: 1, no: 1, cancels: 0, stray: 1 },
        r1: {
          ...base.r1!,
          maxCities: 19,
          maxConquered: 3,
          fightingMax: 19,
          shortfall: 0,
          reachedAt: 500,
          takenFromBloc: 1,
          heldAt: 86900,
        },
      },
      { ...base, r1: null },
    ]);
    expect(stat).toEqual({
      runs: 3,
      joint: { mean: 0.67, runs: 1, total: 2, called: 1 },
      calls: { calls: 2, answered: 1, yes: 1, no: 1, cancels: 0, stray: 1 },
      sieges: {
        sieges: 0,
        reinforced: 0,
        relieved: 0,
        conquered: 0,
        broken: 0,
        abandoned: 0,
        other: 0,
      },
      r1: {
        runs: 2,
        need: 18,
        reached: 1,
        held: 1,
        maxCities: 15.5,
        maxConquered: 1.5,
        fightingRuns: 1,
        fightingMax: 19,
        shortfall: 0,
      },
    });
  });
});

describe("a real batch", () => {
  test("its teamwork agrees with its log and summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perfidia-sim-teams-"));
    try {
      const variant = parseVariant("base: perfidia-1");
      const result = await runBatch(
        {
          variants: [variant],
          seeds: [1],
          players: 6,
          bots: DEFAULT_BOTS,
          days: null,
          pacing: false,
        },
        { out: dir },
      );
      expect(result.format).toBe(BATCH_FORMAT);
      expect(BATCH_FORMAT).toBe("perfidia-batch/5");
      const m = result.variants[0]!.matches[0]!;
      const lines = readLog(join(batchRunDir(dir, 0, 1), "match.jsonl"));
      const s = summarize(lines);
      expect(m.sieges).toHaveLength(s.events.siegesStarted);
      expect(m.sieges.filter((x) => x.outcome === "conquered")).toHaveLength(s.events.siegesHeld);
      expect(
        m.sieges.filter((x) => x.outcome !== "conquered" && x.outcome !== "open"),
      ).toHaveLength(s.events.siegesBroken);
      expect(m.r1).toMatchObject({ slots: 43, need: 16 });
      const most = Math.max(...m.seats.map((x) => x.cities ?? 0));
      expect(m.r1?.maxCities).toBeGreaterThanOrEqual(most);
      // The war calls (opportunist@3 sends some): each private message's calls, as the log has them.
      const calls = lines.flatMap((l) =>
        l.k === "ev" && l.e.type === "message" && l.e.data["to"] !== "all"
          ? parseWar(typeof l.e.data["text"] === "string" ? l.e.data["text"] : "").filter(
              (i) => i.kind === "call",
            )
          : [],
      );
      expect(m.warCalls.calls).toBe(calls.length);
      for (const j of m.joint) expect(j.players.length).toBeGreaterThanOrEqual(2);
      const agg = result.variants[0]!.aggregate;
      expect(agg.team.sieges.sieges).toBe(m.sieges.length);
      expect(agg.teamBots.reduce((a, b) => a + b.sieges.sieges, 0)).toBe(m.sieges.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
