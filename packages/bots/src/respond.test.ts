// The responder side of the war-call protocol (`respond.ts`) and the bots that use it, turtle@3 and
// opportunist@3, on rules shaped like perfidia-1 (its hints: the siege and the countdowns in the
// public extras). The caller is a stand-in: its calls are written into the briefings by the test
// (`war.ts` composes them), as an ally's private messages would arrive.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type {
  Briefing,
  CityId,
  IslandId,
  JsonObject,
  PlayerId,
  ToolCall,
} from "@perfidia/protocol";
import {
  advance,
  capital,
  callsTo,
  counts,
  perfidiaGame,
  playTurn,
  res,
  str,
  strs,
  type FakeGame,
  type FCity,
  type TurnLog,
} from "./fixtures.test.ts";
import { DAY, fmtTime } from "./kit.ts";
import { encodeMemory, parseMemory } from "./memory.ts";
import { botVersions, createBotVersion } from "./registry.ts";
import { streamOf } from "./rng.ts";
import { opportunist2Params } from "./strategies/opportunist2.ts";
import type { BotStrategy } from "./strategies/strategy.ts";
import {
  composeCall,
  composeCancel,
  parseWar,
  readBook,
  WAR_LIMITS,
  type WarAck,
  type WarCall,
} from "./war.ts";

type Msg = Briefing["msgs"][number];

const pair = (t: number): [number, string] => [t, fmtTime(t)];

const DEVELOPED = {
  hall: 5,
  lumber: 4,
  quarry: 4,
  mine: 4,
  warehouse: 5,
  barracks: 3,
  harbor: 3,
  wall: 1,
};

function v3(strategy: BotStrategy, seat: PlayerId = "p1", seed = 11) {
  return createBotVersion(strategy, 3, { seat, seed, strict: true });
}

/** The briefings carry `inbox` (the fake's carry no message) and `ext`. */
function withInbox(game: FakeGame, inbox: Map<PlayerId, Msg[]>, ext: JsonObject = {}): void {
  const briefing = game.briefing.bind(game);
  game.briefing = (seat: PlayerId, notes?: string, perWake?: number | null): Briefing => ({
    ...briefing(seat, notes, perWake),
    msgs: inbox.get(seat) ?? [],
    ext,
  });
}

/** The map rows carry each city's public extras, as `view_map` does (the fake leaves them out). */
function withMapExtras(game: FakeGame): void {
  const respond = game.respond.bind(game);
  game.respond = (seat: PlayerId, c: ToolCall) => {
    const r = respond(seat, c);
    if (c.tool !== "view_map" || !r.ok) return r;
    const rows = r.data["cities"];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
        const id = row["id"];
        const city = typeof id === "string" ? game.cities.find((x) => x.id === id) : undefined;
        if (city !== undefined && Object.keys(city.ext).length > 0) row["ext"] = city.ext;
      }
    }
    return r;
  };
}

/** A weak colony (not a capital) of `owner` on `island`. */
function colonyOf(id: CityId, owner: PlayerId, island: IslandId): FCity {
  const c = capital(id, owner, island, { ...DEVELOPED, wall: 0 }, res(300, 300, 300), {
    guard: 1,
  });
  c.capitalOf = null;
  return c;
}

function msg(from: PlayerId, to: readonly PlayerId[] | "all", text: string): Msg {
  return { id: "g0000a", from, to: to === "all" ? "all" : [...to], text };
}

/** p1 allied with p2, at D2 14:00, with an army in its developed capital. */
function allied(): FakeGame {
  const game = perfidiaGame(6);
  game.t = DAY + 14 * 3600;
  const c1 = game.city("c1");
  c1.levels = { ...DEVELOPED };
  c1.stock = res(400, 400, 400);
  c1.units = { raider: 100, guard: 60, transport: 10 };
  game.relations.set("p1", [{ player: "p2", kind: "ally", until: null }]);
  game.relations.set("p2", [{ player: "p1", kind: "ally", until: null }]);
  game.alliance.set("p1", "a1");
  game.alliance.set("p2", "a1");
  withMapExtras(game);
  return game;
}

/** A call of p2's with its window `from` seconds ahead, an hour long. */
function callOf(game: FakeGame, role: WarCall["role"], target: CityId, from: number): WarCall {
  return {
    id: "k1",
    role,
    target,
    t0: game.t + from,
    t1: game.t + from + 3600,
    vs: null,
    lands: game.t + from + 1800,
  };
}

/** The war messages a turn sent, with their recipients. */
function warSent(log: TurnLog): { to: string[]; text: string }[] {
  return callsTo(log, "send_message")
    .map((m) => ({ to: strs(m["to"]), text: str(m["text"]) }))
    .filter((m) => /WAR#/.test(m.text));
}

/** The answers a turn sent. */
function acks(log: TurnLog): WarAck[] {
  return warSent(log).flatMap((m) =>
    parseWar(m.text).flatMap((i) => (i.kind === "ack" ? [i.ack] : [])),
  );
}

function noViolations(game: FakeGame): void {
  expect(game.violations).toEqual([]);
}

/** Plays the next turn of `seat` at `t`, with what the previous turn wrote in its notes. */
async function turnAt(
  game: FakeGame,
  strategy: BotStrategy,
  t: number,
  turn: number,
  seed = 11,
): Promise<TurnLog> {
  advance(game, t);
  const log = await playTurn(v3(strategy, "p1", seed), game, "p1", { turn });
  noViolations(game);
  return log;
}

describe("answering an ally's call", () => {
  test("opportunist@3 says yes to a strike it can land, then launches at its planned time", async () => {
    const game = allied();
    // c3 (p3) is 2 sectors away: 360 tiles, 6 h with transports.
    const call = callOf(game, "strike", "c3", 8 * 3600);
    const inbox = new Map([["p1" as PlayerId, [msg("p2", ["p1"], composeCall(call))]]]);
    withInbox(game, inbox);
    const first = await playTurn(v3("opportunist"), game, "p1");
    noViolations(game);
    const yes = acks(first);
    expect(yes.map((a) => [a.id, a.yes])).toEqual([["k1", true]]);
    expect(warSent(first)[0]!.to).toEqual(["p2"]);
    const lands = yes[0]!.lands!;
    expect(lands).toBeGreaterThanOrEqual(call.t0);
    expect(lands).toBeLessThanOrEqual(call.t1);
    // Nothing leaves yet: the launch waits for a firm self-wake.
    expect(callsTo(first, "attack").filter((a) => a["to"] === "c3")).toEqual([]);
    const launch = lands - 6 * 3600;
    expect(first.wakeAt).toBeLessThanOrEqual(launch);
    const book = readBook(parseMemory(game.notes.get("p1") ?? "", "opportunist"));
    expect(book.map((e) => [e.from, e.call.id, e.state, e.at])).toEqual([
      ["p2", "k1", "yes", launch],
    ]);

    inbox.clear();
    // Awake earlier for its economy: the strike still waits for its time.
    const early = await turnAt(game, "opportunist", first.wakeAt ?? launch, 2);
    if (game.t < launch) {
      expect(callsTo(early, "attack").filter((a) => a["to"] === "c3")).toEqual([]);
      expect(early.wakeAt).toBeLessThanOrEqual(launch);
    }
    const second = await turnAt(game, "opportunist", launch, 3);
    const strikes = callsTo(second, "attack").filter((a) => a["to"] === "c3");
    expect(strikes.length).toBe(1);
    const units = counts(strikes[0]!["units"]);
    // A seeded share of its 100 raiders, with the transports that carry them; guards stay home.
    expect(units["raider"]).toBeGreaterThanOrEqual(70);
    expect(units["raider"]).toBeLessThanOrEqual(90);
    expect(units["guard"]).toBeUndefined();
    expect(units["transport"]).toBe(Math.ceil(units["raider"]! / 20));
    const sent = readBook(parseMemory(game.notes.get("p1") ?? "", "opportunist"));
    expect(sent.map((e) => [e.state, e.at])).toEqual([["sent", lands]]);
    // Kept its word once: the next turn sends nothing more there.
    const third = await turnAt(game, "opportunist", launch + 1200, 4);
    expect(callsTo(third, "attack").filter((a) => a["to"] === "c3")).toEqual([]);
  });

  test("turtle@3 holds an ally's city with defenders, and declines a strike", async () => {
    const game = allied();
    const hold = callOf(game, "hold", "c2", 5 * 3600);
    const strike = { ...callOf(game, "strike", "c3", 8 * 3600), id: "k2" };
    const inbox = new Map([
      ["p1" as PlayerId, [msg("p2", ["p1"], `${composeCall(hold)}; ${composeCall(strike)}`)]],
    ]);
    withInbox(game, inbox);
    const first = await playTurn(v3("turtle"), game, "p1");
    noViolations(game);
    // One message to the caller: the yes first, then the no with its reason.
    const sent = warSent(first);
    expect(sent.length).toBe(1);
    expect(sent[0]!.text.length).toBeLessThanOrEqual(WAR_LIMITS.text);
    const answers = acks(first);
    expect(answers.map((a) => [a.id, a.yes, a.why])).toEqual([
      ["k1", true, null],
      ["k2", false, "i defend, no strikes"],
    ]);
    // c2 is one sector away: 180 tiles, 3 h with transports.
    const launch = answers[0]!.lands! - 3 * 3600;
    expect(launch).toBeGreaterThan(game.t);
    inbox.clear();
    const second = await turnAt(game, "turtle", launch, 2);
    const supports = callsTo(second, "support").filter((s) => s["to"] === "c2");
    expect(supports.length).toBe(1);
    const units = counts(supports[0]!["units"]);
    expect(units["guard"]).toBeGreaterThan(0);
    expect(units["raider"]).toBeUndefined();
    // The turtle never attacks for a call.
    expect(callsTo(second, "attack")).toEqual([]);
  });

  test("never for a non-ally, a public call or a fake one; never against itself, an ally or a pact partner", async () => {
    const game = allied();
    game.relations.set("p1", [
      { player: "p2", kind: "ally", until: null },
      { player: "p4", kind: "pact", until: null },
    ]);
    const at = (target: CityId, id: string): string =>
      composeCall({ ...callOf(game, "strike", target, 10 * 3600), id });
    const inbox = new Map([
      [
        "p1" as PlayerId,
        [
          msg("p3", ["p1"], at("c5", "k1")),
          msg("p2", "all", at("c5", "k2")),
          msg("p2", ["p1"], `${at("c1", "k3")}; ${at("c4", "k4")}`),
          msg("p2", ["p1"], "WAR#k5 strike c99999 land D9 99:99-12:00 garbage"),
        ],
      ],
    ]);
    withInbox(game, inbox);
    const log = await playTurn(v3("opportunist"), game, "p1");
    noViolations(game);
    expect(acks(log).map((a) => [a.id, a.yes, a.why])).toEqual([
      ["k3", false, "my city"],
      ["k4", false, "we have a pact"],
    ]);
    expect(warSent(log).every((m) => m.to.length === 1 && m.to[0] === "p2")).toBe(true);
    expect(callsTo(log, "attack").filter((a) => a["to"] !== "c2")).toEqual([]);
  });

  test("a second strike while a promised one has not left is busy; a defense still gets a yes", async () => {
    const game = allied();
    const first = callOf(game, "strike", "c3", 8 * 3600);
    const inbox = new Map([["p1" as PlayerId, [msg("p2", ["p1"], composeCall(first))]]]);
    withInbox(game, inbox);
    const one = await playTurn(v3("opportunist"), game, "p1");
    expect(acks(one).map((a) => [a.id, a.yes])).toEqual([["k1", true]]);
    const second = { ...callOf(game, "strike", "c3", 9 * 3600), id: "k2" };
    const hold = { ...callOf(game, "hold", "c2", 5 * 3600), id: "k3" };
    inbox.set("p1", [msg("p2", ["p1"], `${composeCall(second)}; ${composeCall(hold)}`)]);
    // Enough defenders that a share of them is worth sending.
    game.city("c1").units["guard"] = 120;
    const two = await turnAt(game, "opportunist", game.t + 600, 2);
    expect(acks(two).map((a) => [a.id, a.yes, a.why])).toEqual([
      ["k3", true, null],
      ["k2", false, "busy"],
    ]);
  });

  test("a launch later today needs an own wake left for it: otherwise the call is declined", async () => {
    for (const [left, yes] of [
      [12, true],
      [1, false],
    ] as const) {
      const game = allied();
      game.budget.ownWakesLeft = left;
      // The launch comes about 2 h from now, today.
      const call = callOf(game, "strike", "c3", 8 * 3600);
      withInbox(game, new Map([["p1", [msg("p2", ["p1"], composeCall(call))]]]));
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const log = await playTurn(v3("opportunist"), game, "p1");
      const answer = acks(log).map((a) => [a.yes, a.why]);
      expect(answer).toEqual([yes ? [true, null] : [false, "no wake left today"]]);
    }
  });

  test("a call past its window is declined; one more than a day ahead waits, unanswered", async () => {
    const game = allied();
    const gone = { ...callOf(game, "strike", "c3", 3600), id: "k1" };
    const far = { ...callOf(game, "strike", "c3", 2 * DAY), id: "k2" };
    withInbox(
      game,
      new Map([["p1", [msg("p2", ["p1"], `${composeCall(gone)}; ${composeCall(far)}`)]]]),
    );
    const log = await playTurn(v3("opportunist"), game, "p1");
    noViolations(game);
    expect(acks(log).map((a) => [a.id, a.yes, a.why])).toEqual([["k1", false, "too far"]]);
    const book = readBook(parseMemory(game.notes.get("p1") ?? "", "opportunist"));
    expect(book.map((e) => [e.call.id, e.state])).toEqual([
      ["k1", "no"],
      ["k2", "open"],
    ]);
  });

  test("answers keep messages in hand: a no only while more than 6 are left, a yes while more than 1", async () => {
    for (const [left, expected] of [
      [7, 1],
      [6, 0],
    ] as const) {
      const game = allied();
      game.budget.messagesLeft = left;
      const strike = callOf(game, "strike", "c3", 8 * 3600);
      withInbox(game, new Map([["p1", [msg("p2", ["p1"], composeCall(strike))]]]));
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const log = await playTurn(v3("turtle"), game, "p1");
      expect([left, warSent(log).length]).toEqual([left, expected]);
    }
    for (const [left, expected] of [
      [2, 1],
      [1, 0],
    ] as const) {
      const game = allied();
      game.budget.messagesLeft = left;
      const hold = callOf(game, "hold", "c2", 5 * 3600);
      withInbox(game, new Map([["p1", [msg("p2", ["p1"], composeCall(hold))]]]));
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const log = await playTurn(v3("turtle"), game, "p1");
      expect([left, warSent(log).length]).toEqual([left, expected]);
      // A yes it could not send is still kept.
      const book = readBook(parseMemory(game.notes.get("p1") ?? "", "turtle"));
      expect(book.map((e) => e.state)).toEqual(["yes"]);
    }
  });
});

describe("keeping its word on a changing world", () => {
  test("a siege call: the defense leaves once the ally's siege has become a conquest", async () => {
    const game = allied();
    const c3 = game.city("c3");
    const ends = game.t + 2 * 3600;
    c3.ext = { siege: { by: "p2", ends: pair(ends) } };
    // The window opens 4 h after the siege's end: the defense lands on the ally's conquest.
    const siege: WarCall = { ...callOf(game, "siege", "c3", 2 * 3600 + 6 * 3600 + 1800) };
    const inbox = new Map([["p1" as PlayerId, [msg("p2", ["p1"], composeCall(siege))]]]);
    withInbox(game, inbox);
    const first = await playTurn(v3("turtle"), game, "p1");
    noViolations(game);
    const yes = acks(first);
    expect(yes.map((a) => [a.id, a.yes])).toEqual([["k1", true]]);
    const launch = yes[0]!.lands! - 6 * 3600;
    expect(launch).toBeGreaterThan(ends);
    inbox.clear();
    // The conquest: c3 is p2's now.
    c3.owner = "p2";
    c3.capitalOf = null;
    c3.ext = {};
    const second = await turnAt(game, "turtle", launch, 2);
    expect(callsTo(second, "support").filter((s) => s["to"] === "c3").length).toBe(1);
  });

  test("a siege call whose siege broke: nothing leaves, and a late no tells the caller", async () => {
    const game = allied();
    const c3 = game.city("c3");
    c3.ext = { siege: { by: "p2", ends: pair(game.t + 2 * 3600) } };
    const siege: WarCall = { ...callOf(game, "siege", "c3", 8 * 3600 + 1800) };
    const inbox = new Map([["p1" as PlayerId, [msg("p2", ["p1"], composeCall(siege))]]]);
    withInbox(game, inbox);
    const first = await playTurn(v3("turtle"), game, "p1");
    const launch = acks(first)[0]!.lands! - 6 * 3600;
    inbox.clear();
    c3.ext = {};
    const second = await turnAt(game, "turtle", launch, 2);
    expect(callsTo(second, "support").filter((s) => s["to"] === "c3")).toEqual([]);
    expect(acks(second).map((a) => [a.id, a.yes, a.why])).toEqual([["k1", false, "not your city"]]);
  });

  test("a cancelled call: nothing leaves; a strike still in its recall window is called back", async () => {
    const game = allied();
    const call = callOf(game, "strike", "c3", 8 * 3600);
    const inbox = new Map([["p1" as PlayerId, [msg("p2", ["p1"], composeCall(call))]]]);
    withInbox(game, inbox);
    const first = await playTurn(v3("opportunist"), game, "p1");
    const launch = acks(first)[0]!.lands! - 6 * 3600;
    inbox.clear();
    const second = await turnAt(game, "opportunist", launch, 2);
    expect(callsTo(second, "attack").filter((a) => a["to"] === "c3").length).toBe(1);
    const strike = game.moves.find((m) => m.owner === "p1" && m.kind === "attack" && m.to === "c3");
    if (strike === undefined) throw new Error("the strike left");
    // The caller calls it off 5 minutes later: the strike turns back.
    inbox.set("p1", [msg("p2", ["p1"], composeCancel("k1", "siege broken"))]);
    const third = await turnAt(game, "opportunist", launch + 300, 3);
    expect(callsTo(third, "recall_troops")).toEqual([{ movement: strike.id }]);

    // Cancelled before its launch: nothing leaves at the planned time.
    const other = allied();
    const box = new Map([["p1" as PlayerId, [msg("p2", ["p1"], composeCall(call))]]]);
    withInbox(other, box);
    const answered = await playTurn(v3("opportunist"), other, "p1");
    const at = acks(answered)[0]!.lands! - 6 * 3600;
    box.set("p1", [msg("p2", ["p1"], composeCancel("k1"))]);
    const cancelled = await turnAt(other, "opportunist", at - 3600, 2);
    expect(callsTo(cancelled, "attack").filter((a) => a["to"] === "c3")).toEqual([]);
    box.clear();
    const due = await turnAt(other, "opportunist", at, 3);
    expect(callsTo(due, "attack").filter((a) => a["to"] === "c3")).toEqual([]);
  });

  test("a strike whose target came under siege meanwhile is not launched (it would fight the besieger)", async () => {
    const game = allied();
    const call = callOf(game, "strike", "c3", 8 * 3600);
    const inbox = new Map([["p1" as PlayerId, [msg("p2", ["p1"], composeCall(call))]]]);
    withInbox(game, inbox);
    const first = await playTurn(v3("opportunist"), game, "p1");
    const launch = acks(first)[0]!.lands! - 6 * 3600;
    inbox.clear();
    game.city("c3").ext = { siege: { by: "p2", ends: pair(launch + 3 * 3600) } };
    const second = await turnAt(game, "opportunist", launch, 2);
    expect(callsTo(second, "attack").filter((a) => a["to"] === "c3")).toEqual([]);
  });

  test("an ally's conquest is held: defenders leave once the ally owns the city", async () => {
    const game = allied();
    const c3 = game.city("c3");
    const ends = game.t + 3 * 3600;
    c3.ext = { siege: { by: "p2", ends: pair(ends) } };
    const first = await playTurn(v3("turtle"), game, "p1");
    noViolations(game);
    expect(callsTo(first, "support").filter((s) => s["to"] === "c3")).toEqual([]);
    expect(first.wakeAt).toBeLessThanOrEqual(ends + 120);
    expect(parseMemory(game.notes.get("p1") ?? "", "turtle").x["gwc3"]).toBe(ends);
    c3.owner = "p2";
    c3.capitalOf = null;
    c3.ext = {};
    const second = await turnAt(game, "turtle", ends + 120, 2);
    const holds = callsTo(second, "support").filter((s) => s["to"] === "c3");
    expect(holds.length).toBe(1);
    expect(counts(holds[0]!["units"])["guard"]).toBeGreaterThanOrEqual(5);
    expect(parseMemory(game.notes.get("p1") ?? "", "turtle").x["gwc3"]).toBeUndefined();
  });
});

/** p1 (opportunist@3) allied with p2 on its betrayal day, top of the board; p2's capital is weak. */
function betrayalDay(seed: number): FakeGame {
  const prm = opportunist2Params(streamOf(seed, "p1", "opportunist", "params"));
  const game = allied();
  game.t = prm.betrayDay * DAY + 14 * 3600;
  game.city("c1").units = { raider: 60, transport: 4, guard: 10 };
  game.city("c2").units = { guard: 3 };
  return game;
}

describe("opportunist@3 between loyalty and betrayal", () => {
  test("in reach of a betrayal it keeps silent towards that ally, and betrays as opportunist@2 does", async () => {
    const seed = 11;
    const game = betrayalDay(seed);
    const call = callOf(game, "strike", "c3", 8 * 3600);
    withInbox(game, new Map([["p1", [msg("p2", ["p1"], composeCall(call))]]]));
    const log = await playTurn(v3("opportunist", "p1", seed), game, "p1");
    noViolations(game);
    expect(warSent(log)).toEqual([]);
    expect(callsTo(log, "attack").map((a) => a["to"])).toContain("c2");
    // The call stays open in its notes, unanswered.
    const book = readBook(parseMemory(game.notes.get("p1") ?? "", "opportunist"));
    expect(book.map((e) => [e.call.id, e.state])).toEqual([["k1", "open"]]);
  });

  test("an alliance with the player its raid is on the way to: the raid is called back, or the offer waits", async () => {
    for (const recallable of [true, false]) {
      const game = perfidiaGame(6);
      game.t = 3 * DAY + 3600;
      game.city("c1").levels = { ...DEVELOPED };
      game.moves.push({
        id: "m4rad0",
        kind: "attack",
        owner: "p1",
        from: "c1",
        to: "c2",
        island: "i6",
        units: { raider: 40, transport: 2 },
        depart: game.t - 300,
        arrive: game.t + 10_500,
        recallableUntil: recallable ? game.t + 300 : game.t - 1,
      });
      game.proposals.push({
        id: "q0000a",
        from: "p2",
        to: "p1",
        kind: "alliance",
        name: "League p2",
        text: "together?",
        expires: pair(game.t + 40_000),
      });
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const log = await playTurn(v3("opportunist"), game, "p1");
      noViolations(game);
      const answers = callsTo(log, "answer_proposal");
      const recalls = callsTo(log, "recall_troops");
      if (recallable) {
        expect(answers).toEqual([{ id: "q0000a", accept: true }]);
        expect(recalls).toContainEqual({ movement: "m4rad0" });
      } else {
        expect(answers).toEqual([]);
        expect(recalls).toEqual([]);
      }
    }
  });

  test("during its own bloc's countdown it answers its ally and betrays no one", async () => {
    const seed = 11;
    const game = betrayalDay(seed);
    const call = callOf(game, "strike", "c3", 8 * 3600);
    withInbox(game, new Map([["p1", [msg("p2", ["p1"], composeCall(call))]]]), {
      countdowns: [
        { key: "a1", members: ["p1", "p2"], cities: 12, need: 12, ends: pair(game.t + 50000) },
      ],
    });
    const log = await playTurn(v3("opportunist", "p1", seed), game, "p1");
    noViolations(game);
    expect(acks(log).map((a) => [a.id, a.yes])).toEqual([["k1", true]]);
    expect(callsTo(log, "attack").map((a) => a["to"])).not.toContain("c2");
  });

  test("it calls its ally to strike the common enemy it raids, never a city its ally has a pact with", async () => {
    for (const pact of [false, true]) {
      const game = allied();
      game.t = 2 * DAY + 14 * 3600;
      // A weak stranger, freshly spied: c4 (p4), 540 tiles away (9 h).
      game.intel.set("p1|c4", {
        type: "spy_report",
        at: game.t - 600,
        data: { report: "r00001", city: "c4", units: { home: { guard: 1 } } },
      });
      for (const p of ["p2", "p3", "p5", "p6"]) {
        game.intel.set(`p1|c${p.slice(1)}`, {
          type: "spy_report",
          at: game.t - 600,
          data: { report: "r00002", city: `c${p.slice(1)}`, units: { home: { guard: 400 } } },
        });
      }
      const respond = game.respond.bind(game);
      game.respond = (seat: PlayerId, c: ToolCall) => {
        const r = respond(seat, c);
        if (c.tool !== "leaderboard" || !r.ok || !pact) return r;
        const rows = r.data["standings"];
        if (!Array.isArray(rows)) return r;
        // The board shows p2's pact with p4.
        for (const row of rows) {
          if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
          if (row["player"] === "p2")
            row["relations"] = [{ player: "p4", kind: "pact", until: null }];
        }
        return r;
      };
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const log = await playTurn(v3("opportunist"), game, "p1");
      noViolations(game);
      expect(callsTo(log, "attack").map((a) => a["to"])).toEqual(["c4"]);
      const calls = warSent(log).flatMap((m) =>
        parseWar(m.text).flatMap((i) => (i.kind === "call" ? [{ to: m.to, call: i.call }] : [])),
      );
      if (pact) {
        expect(calls).toEqual([]);
        continue;
      }
      expect(calls.length).toBe(1);
      const c = calls[0]!;
      expect(c.to).toEqual(["p2"]);
      expect([c.call.role, c.call.target, c.call.vs]).toEqual(["strike", "c4", "p4"]);
      const lands = game.t + 9 * 3600;
      expect(c.call.lands).toBe(lands);
      expect(c.call.t0).toBeLessThanOrEqual(lands);
      expect(c.call.t1).toBeGreaterThanOrEqual(lands);
      // Its own call is in its book, its raid sent, with its landing.
      const book = readBook(parseMemory(game.notes.get("p1") ?? "", "opportunist"));
      expect(book.map((e) => [e.from, e.call.target, e.state, e.at])).toEqual([
        ["p1", "c4", "sent", lands],
      ]);
    }
  });

  test("a near common enemy becomes a joint raid: called now, launched to land in the window, or called off", async () => {
    for (const besieged of [false, true]) {
      const game = allied();
      game.t = 2 * DAY + 14 * 3600;
      // A weak colony of p3 on p1's frontier island, 92 tiles away.
      const c20 = colonyOf("c20", "p3", "i4");
      game.cities.push(c20);
      game.intel.set("p1|c20", {
        type: "spy_report",
        at: game.t - 600,
        data: { report: "r00001", city: "c20", units: { home: { guard: 1 } } },
      });
      for (const c of ["c2", "c3", "c4", "c5", "c6"]) {
        game.intel.set(`p1|${c}`, {
          type: "spy_report",
          at: game.t - 600,
          data: { report: "r00002", city: c, units: { home: { guard: 400 } } },
        });
      }
      const inbox = new Map<PlayerId, Msg[]>();
      withInbox(game, inbox);
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const first = await playTurn(v3("opportunist"), game, "p1");
      noViolations(game);
      expect(callsTo(first, "attack")).toEqual([]);
      const calls = warSent(first).flatMap((m) =>
        parseWar(m.text).flatMap((i) => (i.kind === "call" ? [i.call] : [])),
      );
      expect(calls.map((c) => [c.role, c.target])).toEqual([["strike", "c20"]]);
      const call = calls[0]!;
      const lands = call.lands!;
      // Landing 4 to 6 h ahead, inside the window; the launch waits for a firm self-wake.
      expect(lands - game.t).toBeGreaterThanOrEqual(4 * 3600);
      expect(lands - game.t).toBeLessThanOrEqual(6 * 3600);
      expect([call.t0 <= lands, call.t1 >= lands]).toEqual([true, true]);
      const launch = lands - game.travel("i2", "i4", 0);
      expect(first.wakeAt).toBeLessThanOrEqual(launch);
      // The ally answers yes meanwhile.
      inbox.set("p1", [msg("p2", ["p1"], `WAR#${call.id} yes, landing ${fmtTime(lands)}`)]);
      if (besieged) c20.ext = { siege: { by: "p5", ends: pair(launch + 3 * 3600) } };
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const second = await turnAt(game, "opportunist", launch, 2);
      const raids = callsTo(second, "attack").filter((a) => a["to"] === "c20");
      const book = readBook(parseMemory(game.notes.get("p1") ?? "", "opportunist"));
      const own = book.filter((e) => e.from === "p1");
      if (besieged) {
        expect(raids).toEqual([]);
        expect(warSent(second).map((m) => m.text)).toEqual([
          composeCancel(call.id, "target under siege"),
        ]);
        expect(own.map((e) => e.state)).toEqual(["cancelled"]);
      } else {
        expect(raids.length).toBe(1);
        expect(counts(raids[0]!["units"])["raider"]).toBe(100);
        expect(own.map((e) => [e.state, e.at, e.answers])).toEqual([
          ["sent", lands, { p2: lands }],
        ]);
      }
    }
  });
});

/** The calls of one turn of `strategy` hearing a strike and a hold call. */
async function twoCallsTurn(strategy: BotStrategy): Promise<readonly ToolCall[]> {
  const game = allied();
  const calls = [
    composeCall(callOf(game, "strike", "c3", 8 * 3600)),
    composeCall({ ...callOf(game, "hold", "c2", 5 * 3600), id: "k2" }),
  ];
  withInbox(game, new Map([["p1", [msg("p2", ["p1"], calls.join("; "))]]]));
  return (await playTurn(v3(strategy), game, "p1")).calls;
}

/** A random inbox: well-formed calls (any role, target, window, sender), cancels and noise. */
const inboxArb = fc.array(
  fc.record({
    from: fc.constantFrom<PlayerId>("p1", "p2", "p3", "p4"),
    to: fc.oneof(
      fc.constant<"all">("all"),
      fc.subarray<PlayerId>(["p1", "p2", "p3"], { minLength: 1 }),
    ),
    items: fc.array(
      fc.oneof(
        fc.record({
          kind: fc.constant("call" as const),
          role: fc.constantFrom<WarCall["role"]>("strike", "siege", "hold"),
          target: fc.constantFrom<CityId>("c1", "c2", "c3", "c4", "c5", "c7", "c99"),
          from: fc.integer({ min: -3 * 3600, max: 2 * DAY }),
          len: fc.integer({ min: 0, max: 6 * 3600 }),
          id: fc.integer({ min: 1, max: 40 }),
        }),
        fc.record({ kind: fc.constant("cancel" as const), id: fc.integer({ min: 1, max: 40 }) }),
        fc.record({ kind: fc.constant("text" as const), text: fc.string({ maxLength: 40 }) }),
      ),
      { maxLength: 4 },
    ),
  }),
  { maxLength: 5 },
);

describe("robustness", () => {
  test("property: whatever the inbox, valid calls, no attack on itself, an ally or a pact partner, answers only to allies", async () => {
    await fc.assert(
      fc.asyncProperty(
        inboxArb,
        fc.constantFrom<BotStrategy>("turtle", "opportunist"),
        fc.integer({ min: 0, max: 20 }),
        async (raw, strategy, messagesLeft) => {
          const game = allied();
          game.relations.set("p1", [
            { player: "p2", kind: "ally", until: null },
            { player: "p4", kind: "pact", until: null },
          ]);
          game.budget.messagesLeft = messagesLeft;
          const now = game.t;
          const msgs = raw.map((m) =>
            msg(
              m.from,
              m.to,
              m.items
                .map((i) =>
                  i.kind === "call"
                    ? composeCall({
                        id: `k${i.id}`,
                        role: i.role,
                        target: i.target,
                        t0: Math.max(0, now + i.from),
                        t1: Math.max(0, now + i.from) + i.len,
                        vs: null,
                        lands: null,
                      })
                    : i.kind === "cancel"
                      ? composeCancel(`k${i.id}`)
                      : i.text,
                )
                .join("; "),
            ),
          );
          withInbox(game, new Map([["p1", msgs]]));
          const log = await playTurn(v3(strategy), game, "p1");
          expect(game.violations).toEqual([]);
          expect(log.endedBy).toBe("end_turn");
          const spared = new Set(["c1", "c2", "c4"]);
          expect(callsTo(log, "attack").filter((a) => spared.has(str(a["to"])))).toEqual([]);
          expect(callsTo(log, "send_message").length).toBeLessThanOrEqual(messagesLeft);
          for (const m of warSent(log)) {
            expect(m.text.length).toBeLessThanOrEqual(WAR_LIMITS.text);
            expect(m.to).toEqual(["p2"]);
          }
        },
      ),
      { numRuns: 60 },
    );
  }, 60_000);

  test("foreign notes and messages are read as nothing; the book survives other memo lines", async () => {
    for (const notes of ["", "free text an LLM wrote", '{"v":2,"s":"turtle","m":["wc garbage"]}']) {
      const game = allied();
      game.notes.set("p1", notes);
      withInbox(
        game,
        new Map([
          [
            "p1",
            [
              msg("p2", ["p1"], "war#zz9 strike c3 land D99 25:61-26:00; WAR#"),
              msg("p2", ["p1"], `${"x".repeat(100_000)} WAR#k1 hold c2 land D2 20:00-21:00`),
            ],
          ],
        ]),
      );
      // oxlint-disable-next-line no-await-in-loop -- one game at a time
      const log = await playTurn(v3("turtle"), game, "p1");
      noViolations(game);
      expect(log.endedBy).toBe("end_turn");
      expect(warSent(log)).toEqual([]);
    }
    const memory = {
      ...parseMemory("", "turtle"),
      m: Array.from({ length: 30 }, (_, i) => `memo ${i}`),
    };
    const game = allied();
    game.notes.set("p1", encodeMemory(memory, 4000));
    const hold = callOf(game, "hold", "c2", 5 * 3600);
    withInbox(game, new Map([["p1", [msg("p2", ["p1"], composeCall(hold))]]]));
    await playTurn(v3("turtle"), game, "p1");
    const book = readBook(parseMemory(game.notes.get("p1") ?? "", "turtle"));
    expect(book.map((e) => [e.call.id, e.state])).toEqual([["k1", "yes"]]);
  });

  test("deterministic: the same game gives the same calls", async () => {
    for (const s of ["turtle", "opportunist"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one strategy at a time
      expect(await twoCallsTurn(s)).toEqual(await twoCallsTurn(s));
    }
  });

  test("the new versions are registered beside the frozen ones", () => {
    expect(botVersions("turtle")).toEqual([1, 2, 3]);
    expect(botVersions("opportunist")).toEqual([1, 2, 3]);
  });
});
