// The match summary (docs/architecture.md §12.2): exact metrics on hand-written logs (wakes per seat
// per day by class, deferred turns from `defer` lines, a hand-off from a `controller` line, an
// `INTERNAL` `gw` line, rejections by layer, event counts and sieges), the fatal and incomplete
// cases, and agreement with the host's own statistics on a real run.

import { describe, expect, test } from "bun:test";
import { LogLineSchema, type LogLine } from "@perfidia/protocol";
import { jsonlText, runBots } from "../harness/index.ts";
import { LogShapeError, formatSummary, summarize, wakeClass } from "./index.ts";

const H16 = (c: string): string => c.repeat(16);

/** Parses hand-written lines with the log schema, so a fixture is always a valid log. */
function log(rows: readonly unknown[]): LogLine[] {
  return rows.map((r) => LogLineSchema.parse(r));
}

const HEADER = {
  k: "header",
  format: "perfidia-log/1",
  engine: "0.1.0",
  setup: {
    ruleset: "perfidia-1@1.0.0",
    overrides: { "time.matchEnd": 172800 },
    seed: 7,
    idKey: "0".repeat(32),
    seats: [{ id: "p1" }, { id: "p2" }],
  },
  config: { time: { matchEnd: 172800 } },
  configHash: "a".repeat(64),
  rulesHash: "b".repeat(64),
  controllers: { p1: "bot:expander@1", p2: "llm:claude" },
  clock: { kind: "lockstep", maxTurnsPerSecond: 3 },
  initialHash: H16("0"),
};

const wake = (
  t: number,
  seat: string,
  turn: number,
  reasons: string[],
  urgent: boolean,
  charge: "own" | "social" | null,
): unknown => ({
  k: "wake",
  t,
  seat,
  turn,
  reasons,
  urgent,
  charge,
  day: Math.floor(t / 86400),
  used: { own: 0, social: 0 },
});

const turn = (t: number, seat: string, n: number, rounds: number, calls: number): unknown => ({
  k: "turn",
  t,
  seat,
  turn: n,
  rounds,
  calls,
  why: "end_turn",
  selfAt: null,
  next: null,
});

const ev = (t: number, type: string, data: Record<string, unknown>): unknown => ({
  k: "ev",
  t,
  e: { t, type, public: true, to: [], data },
});

const BODY: readonly unknown[] = [
  wake(0, "p1", 1, ["start"], false, null),
  wake(0, "p2", 1, ["start"], false, null),
  { k: "batch", t: 0, b: 0, order: ["p2", "p1"] },
  {
    k: "act",
    n: 1,
    t: 0,
    seat: "p2",
    turn: 1,
    rt: 0,
    tool: "build",
    i: 0,
    a: { type: "build", city: "c2", building: "hall" },
    r: { ok: false, code: "REQUIREMENT_MISSING" },
  },
  {
    k: "gw",
    n: 2,
    t: 0,
    seat: "p2",
    turn: 1,
    rt: 0,
    tool: "view_city",
    r: { ok: false, code: "INTERNAL" },
    error: "boom",
  },
  {
    k: "gw",
    n: 3,
    t: 0,
    seat: "p2",
    turn: 1,
    rt: 0,
    tool: "attack",
    r: { ok: false, code: "DAILY_CAP", details: { cap: 20, used: 20 } },
  },
  {
    k: "act",
    n: 4,
    t: 0,
    seat: "p1",
    turn: 1,
    rt: 0,
    tool: "build",
    i: 0,
    a: { type: "build", city: "c1", building: "hall" },
    r: { ok: true },
  },
  { k: "obs", n: 5, t: 0, seat: "p1", turn: 1, rt: 1, tool: "view_city", args: {}, bytes: 10 },
  { k: "note", n: 6, t: 0, seat: "p1", turn: 1, mode: "replace", text: "x" },
  turn(0, "p2", 1, 1, 3),
  turn(0, "p1", 1, 2, 3),
  ev(3000, "battle", {
    city: "c2",
    attacker: "p1",
    defender: "p2",
    kind: "city",
    winner: "attacker",
  }),
  ev(3000, "siege_started", { city: "c2", owner: "p2", by: "p1", endsAt: 9000 }),
  { k: "ckpt", t: 3600, hour: 1, h: H16("1") },
  { k: "controller", t: 5000, seat: "p2", label: "bot:turtle@1" },
  wake(7200, "p1", 2, ["self"], false, "own"),
  { k: "defer", t: 7200, seat: "p2", to: 7201 },
  turn(7200, "p1", 2, 4, 9),
  wake(7201, "p2", 2, ["incoming_attack"], true, null),
  turn(7201, "p2", 2, 1, 0),
  ev(9000, "city_conquered", { city: "c2", from: "p2", to: "p1" }),
  ev(9000, "player_eliminated", { player: "p2" }),
  ev(20000, "message", { message: "m0k4qz", from: "p1", to: "all", text: "salut à tous ✓ 🙂" }),
  ev(30000, "pact_signed", { a: "p1", b: "p2", expiresAt: null }),
  ev(40000, "siege_started", { city: "c3", owner: null, by: "p1", endsAt: 50000 }),
  ev(41000, "siege_broken", { city: "c3", owner: null, by: "p1", cause: "relief" }),
  ev(42000, "betrayal", { by: "p1", against: "p2", relation: "pact", city: "c2" }),
  ev(43000, "city_founded", { city: "c4", island: "i2", slot: 1, owner: "p1" }),
  wake(90000, "p1", 3, ["message"], false, "social"),
  turn(90000, "p1", 3, 1, 1),
  wake(100000, "p1", 4, ["safety"], false, null),
  turn(100000, "p1", 4, 1, 1),
  { k: "defer", t: 100000, seat: "p1", to: 100001 },
];

const END = {
  k: "end",
  t: 172800,
  h: H16("2"),
  result: {
    endedAt: 172800,
    reason: "time",
    winners: ["p1"],
    standings: [
      {
        player: "p1",
        rank: 1,
        score: 300,
        parts: { cityPoints: 300, battleScore: 0 },
        cities: 3,
        alive: true,
      },
      { player: "p2", rank: 2, score: 0, parts: {}, cities: 0, alive: false },
    ],
  },
};

describe("summarize", () => {
  test("is exact on a hand-written log", () => {
    const lines = log([HEADER, ...BODY, END]);
    const s = summarize(lines, { wallMs: 2000 });
    expect(s.status).toBe("ended");
    expect([s.ruleset, s.seed, s.players, s.endedAt, s.endDay, s.reason]).toEqual([
      "perfidia-1@1.0.0",
      7,
      2,
      172800,
      2,
      "time",
    ]);
    expect(s.winners).toEqual(["p1"]);
    expect(s.finalHash).toBe(H16("2"));

    const [p1, p2] = s.seats;
    expect(s.wakes.days).toBe(2);
    expect(p1?.wakes).toEqual([
      { urgent: 0, own: 1, social: 0, safety: 0, start: 1, deferred: 0 },
      { urgent: 0, own: 0, social: 1, safety: 1, start: 0, deferred: 1 },
    ]);
    expect(p2?.wakes).toEqual([
      { urgent: 1, own: 0, social: 0, safety: 0, start: 1, deferred: 1 },
      { urgent: 0, own: 0, social: 0, safety: 0, start: 0, deferred: 0 },
    ]);
    expect(s.wakes.total).toEqual({
      urgent: 1,
      own: 1,
      social: 1,
      safety: 1,
      start: 2,
      deferred: 2,
    });
    expect(s.wakes.perSeatPerDay).toEqual({ mean: 1.5, max: 2 });

    expect(p1?.controller).toBe("bot:expander@1");
    expect(p2?.controllers).toEqual([
      { label: "llm:claude", from: 0 },
      { label: "bot:turtle@1", from: 5000 },
    ]);
    expect(p2?.controller).toBe("llm:claude → bot:turtle@1 at D1 01:23:20");
    expect(p2?.strategy).toBe("turtle");
    expect(p1?.strategy).toBe("expander");
    expect([p1?.rank, p1?.score, p1?.cities, p1?.alive]).toEqual([1, 300, 3, true]);
    expect(p1?.parts).toEqual({ battleScore: 0, cityPoints: 300 });
    expect([p2?.alive, p2?.eliminatedAt]).toEqual([false, 9000]);
    expect([p1?.turns, p1?.calls, p2?.turns, p2?.calls]).toEqual([4, 14, 2, 3]);

    expect(s.internal).toBe(1);
    expect(s.rejections).toEqual({
      gateway: { DAILY_CAP: 1, INTERNAL: 1 },
      engine: { REQUIREMENT_MISSING: 1 },
    });
    expect([s.turns, s.rounds, s.calls]).toEqual([6, 10, 17]);
    expect(s.perWake.rounds).toEqual({ mean: 1.67, p95: 4, max: 4 });
    expect(s.perWake.calls).toEqual({ mean: 2.83, p95: 9, max: 9 });

    expect(s.events).toEqual({
      battles: 1,
      conquests: 1,
      foundings: 1,
      eliminations: 1,
      siegesStarted: 2,
      siegesHeld: 1,
      siegesBroken: 1,
      alliancesFormed: 0,
      alliancesJoined: 0,
      alliancesLeft: 0,
      pactsSigned: 1,
      pactsRenewed: 0,
      pactsEnded: 0,
      pactsExpired: 0,
      betrayals: 1,
      messages: 1,
      proposals: 0,
      spyReports: 0,
    });
    expect(s.engineEvents).toBe(10);
    expect(s.lines).toBe(lines.length);
    expect(s.logBytes).toBe(Buffer.byteLength(jsonlText(lines)));
    expect([s.wallMs, s.eventsPerSecond]).toEqual([2000, 5]);

    const text = formatSummary(s);
    expect(text).toContain("winners p1 (bot:expander@1)");
    expect(text).toContain("INTERNAL failures: 1");
    expect(text).toContain("llm:claude → bot:turtle@1 at D1 01:23:20");
    expect(text).toContain("p2    1/0/0/0/1 +1d  0/0/0/0/0");
  });

  test("a fatal line, a log that stops, and lines that are not a log", () => {
    const fatal = summarize(
      log([
        HEADER,
        ...BODY.slice(0, 8),
        { k: "fatal", t: 0, error: { kind: "engine", message: "bug" } },
      ]),
    );
    expect(fatal.status).toBe("fatal");
    expect(fatal.fatal).toEqual({ t: 0, kind: "engine", message: "bug" });
    expect([fatal.endedAt, fatal.reason, fatal.winners, fatal.seats[0]?.rank]).toEqual([
      null,
      null,
      [],
      null,
    ]);
    const killed = summarize(log([HEADER, ...BODY.slice(0, 14)]));
    expect([killed.status, killed.lastT, killed.wakes.days]).toEqual(["incomplete", 3600, 1]);
    expect(() => summarize(log(BODY.slice(0, 2)))).toThrow(LogShapeError);
    expect(() => summarize(log([HEADER, HEADER]))).toThrow(LogShapeError);
    expect(() => summarize(log([HEADER, wake(0, "p9", 1, ["start"], false, null)]))).toThrow(
      "p9, which is not a seat",
    );
  });

  test("wake classes follow the host's precedence", () => {
    expect(wakeClass({ reasons: ["start", "x"], urgent: true, charge: "own" })).toBe("start");
    expect(wakeClass({ reasons: ["x"], urgent: true, charge: "own" })).toBe("urgent");
    expect(wakeClass({ reasons: ["x"], urgent: false, charge: "own" })).toBe("own");
    expect(wakeClass({ reasons: ["x"], urgent: false, charge: "social" })).toBe("social");
    expect(wakeClass({ reasons: ["safety"], urgent: false, charge: null })).toBe("safety");
  });

  test("agrees with the host's statistics on a real run of each ruleset", async () => {
    for (const ruleset of ["perfidia-1", "sandbox-1"]) {
      // oxlint-disable-next-line no-await-in-loop -- one match at a time
      const out = await runBots({
        ruleset,
        seed: 9,
        players: 6,
        days: 1,
        clock: { kind: "lockstep" },
        strict: true,
      });
      const s = summarize(out.lines);
      for (const seat of s.seats) expect(seat.wakes).toEqual(out.run.stats.wakes[seat.seat] ?? []);
      expect(s.turns).toBe(out.run.stats.turns);
      expect(s.calls).toBe(out.run.stats.calls);
      expect(s.engineEvents).toBe(out.run.stats.engineEvents);
      expect(s.logBytes).toBe(Buffer.byteLength(out.sink.text()));
      expect(s.winners).toEqual(out.run.result.winners);
      expect(s.internal).toBe(0);
    }
  });
});
