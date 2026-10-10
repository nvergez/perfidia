import { describe, expect, test } from "bun:test";
import type { GatewayRules, PlayerId } from "@perfidia/protocol";
import { deliver } from "./deliver.ts";
import { briefed, createGatewayState, seatOf } from "./state.ts";
import {
  dominationStarted,
  Driver,
  event,
  incomingAttack,
  message,
  P1,
  P2,
  P3,
  publicMessage,
  queueEmpty,
  RULES,
} from "./testkit.test.ts";
import { closeTurn } from "./turn.ts";
import { createWakeScheduler, isPublicMessage, wakeClassOf, wakeReasonOf } from "./wake.ts";

const DAY = 86400;

/** A driver whose seats are past their start wake, idle since t = 0. */
function started(rules: GatewayRules = RULES, autoClose = true): Driver {
  const d = new Driver(rules, [P1, P2, P3], autoClose);
  d.settle();
  if (!autoClose) for (const p of [P1, P2, P3]) d.close(p);
  return d;
}

describe("start and safety wakes", () => {
  test("every seat wakes at t = 0, sorted by player number, exempt from both budgets", () => {
    const players: PlayerId[] = ["p10", "p2", "p1"];
    const gw = createGatewayState(players);
    const wake = createWakeScheduler(gw, RULES);
    expect(wake.nextWakeTime()).toBe(0);
    expect(wake.due(0)).toEqual(["p1", "p2", "p10"]);
    expect(wake.peek("p2")).toEqual({ at: 0, kind: "start" });
    expect(wake.begin("p2", 0)).toEqual({
      reasons: ["start"],
      urgent: false,
      charge: null,
      day: 0,
      used: { own: 0, social: 0 },
    });
    expect(seatOf(gw, "p2").turns).toBe(1);
    expect(wake.due(0)).toEqual(["p1", "p10"]);
  });

  test("the start wake carries the triggers delivered before it and stays exempt", () => {
    const gw = createGatewayState([P1, P2]);
    const wake = createWakeScheduler(gw, RULES);
    deliver(gw, [message(0, P2, [P1], 1), queueEmpty(0, P1)], wake);
    const rec = wake.begin(P1, 0);
    expect(rec.reasons).toEqual(["start", "message g00001", "queue_empty c1"]);
    expect(rec.charge).toBeNull();
  });

  test("the safety wake comes safetyWake (43200 s) after the end of the last turn", () => {
    const d = new Driver(RULES, [P1], false);
    d.settle();
    d.advance(500);
    d.close(P1);
    expect(d.wake.peek(P1)).toEqual({ at: 43700, kind: "safety" });
    d.advance(43699);
    expect(d.wakesOf(P1)).toHaveLength(1);
    d.advance(43700);
    expect(d.lastWake(P1)).toEqual({
      seat: P1,
      t: 43700,
      rec: {
        reasons: ["safety"],
        urgent: false,
        charge: null,
        day: 0,
        used: { own: 0, social: 0 },
      },
    });
  });
});

describe("urgent wakes", () => {
  test("two attacks launched 100 s apart wake the target at t and t + 600", () => {
    const d = started();
    d.deliver(incomingAttack(10000, P1, P2, 1));
    expect(d.lastWake(P1)).toEqual({
      seat: P1,
      t: 10000,
      rec: {
        reasons: ["incoming_attack m00001"],
        urgent: true,
        charge: null,
        day: 0,
        used: { own: 0, social: 0 },
      },
    });
    d.deliver(incomingAttack(10100, P1, P2, 2));
    expect(d.wake.peek(P1)).toEqual({ at: 10600, kind: "urgent" });
    d.advance(20000);
    const urgent = d.wakesOf(P1).filter((w) => w.rec.urgent);
    expect(urgent.map((w) => w.t)).toEqual([10000, 10600]);
    expect(urgent[1]!.rec.reasons).toEqual(["incoming_attack m00002"]);
  });

  test("urgent triggers inside the gap join one wake at the end of the gap", () => {
    const d = started();
    d.deliver(incomingAttack(10000, P1, P2, 1));
    d.deliver(incomingAttack(10100, P1, P2, 2), incomingAttack(10500, P1, P3, 3));
    d.advance(11000);
    const urgent = d.wakesOf(P1).filter((w) => w.rec.urgent);
    expect(urgent.map((w) => [w.t, w.rec.reasons])).toEqual([
      [10000, ["incoming_attack m00001"]],
      [10600, ["incoming_attack m00002", "incoming_attack m00003"]],
    ]);
  });

  test("an urgent trigger during a turn fires when the turn ends, at that very second", () => {
    const d = started(RULES, false);
    d.deliver(queueEmpty(1000, P1));
    d.advance(1600);
    expect(seatOf(d.gw, P1).wake.inTurn).toBe(true);
    d.deliver(incomingAttack(2000, P1, P2, 1));
    expect(d.wake.due(2000)).toEqual([]);
    expect(d.wake.nextWakeTime()).toBe(43200);
    d.advance(3000);
    d.close(P1);
    expect(d.wake.peek(P1)).toEqual({ at: 2000, kind: "urgent" });
    expect(d.wake.due(3000)).toEqual([P1]);
    d.settle();
    expect(d.lastWake(P1).t).toBe(3000);
    expect(d.lastWake(P1).rec.urgent).toBe(true);
  });

  test("an urgent wake drains every pending own and social reason and stays exempt", () => {
    const d = started();
    d.deliver(incomingAttack(10000, P1, P2, 1));
    d.deliver(queueEmpty(10001, P1));
    d.deliver(incomingAttack(10050, P1, P2, 2));
    d.deliver(message(10200, P2, [P1], 1));
    expect(d.wake.peek(P1)).toEqual({ at: 10600, kind: "urgent" });
    d.advance(10600);
    expect(d.lastWake(P1).rec.reasons).toEqual([
      "incoming_attack m00002",
      "queue_empty c1",
      "message g00001",
    ]);
    expect(d.lastWake(P1).rec.charge).toBeNull();
  });

  test("an urgent trigger inside the gap stays pending through an earlier social wake", () => {
    // A group window shorter than the urgent gap lets a social wake fall inside the gap.
    const d = started({ ...RULES, groupWindow: 100 });
    d.deliver(incomingAttack(10000, P1, P2, 1)); // urgent wake at 10000: gap until 10600
    d.deliver(incomingAttack(10050, P1, P2, 2)); // urgent time 10600
    d.deliver(message(10100, P2, [P1], 1)); // social time 10200
    expect(d.wake.peek(P1)).toEqual({ at: 10200, kind: "social" });
    d.advance(10200);
    expect(d.lastWake(P1)).toEqual({
      seat: P1,
      t: 10200,
      rec: {
        reasons: ["message g00001"],
        urgent: false,
        charge: "social",
        day: 0,
        used: { own: 0, social: 1 },
      },
    });
    expect(seatOf(d.gw, P1).wake.urgentReasons).toEqual(["incoming_attack m00002"]);
    expect(d.wake.peek(P1)).toEqual({ at: 10600, kind: "urgent" });
    d.advance(10600);
    expect(d.lastWake(P1)).toMatchObject({
      t: 10600,
      rec: { reasons: ["incoming_attack m00002"], urgent: true, charge: null },
    });
    expect(
      d
        .wakesOf(P1)
        .filter((w) => w.rec.urgent)
        .map((w) => w.t),
    ).toEqual([10000, 10600]);
  });

  test("a self-wake inside the urgent gap does not carry a pending urgent trigger", () => {
    const d = started(RULES, false);
    d.deliver(incomingAttack(10000, P1, P2, 1)); // urgent wake at 10000, still in its turn
    d.close(P1, 700); // self-wake at 10700
    d.deliver(incomingAttack(10500, P1, P2, 2)); // urgent time 10600
    d.advance(10600);
    expect(d.lastWake(P1)).toMatchObject({ t: 10600, rec: { urgent: true } });
    d.close(P1); // end_turn {}: the self-wake at 10700 stays pending
    d.deliver(incomingAttack(10650, P1, P2, 3)); // urgent time 11200
    d.advance(10700);
    expect(d.lastWake(P1)).toEqual({
      seat: P1,
      t: 10700,
      rec: { reasons: ["self"], urgent: false, charge: "own", day: 0, used: { own: 1, social: 0 } },
    });
    d.close(P1);
    d.advance(11200);
    expect(d.lastWake(P1)).toMatchObject({
      t: 11200,
      rec: { reasons: ["incoming_attack m00003"], urgent: true, charge: null },
    });
  });
});

describe("budgets", () => {
  // A safety wake longer than a day, so the budget moves are not hidden by an earlier safety wake.
  const small: GatewayRules = {
    ...RULES,
    ownWakesPerDay: 2,
    socialWakesPerDay: 2,
    safetyWake: 2 * DAY,
  };

  test("an exhausted own budget moves own wakes to the next day while social wakes still fire", () => {
    const d = started(small);
    d.deliver(queueEmpty(1000, P1, "c1"));
    d.deliver(queueEmpty(2000, P1, "c2"));
    d.advance(2600);
    expect(d.wakesOf(P1).map((w) => [w.t, w.rec.charge, w.rec.used])).toEqual([
      [0, null, { own: 0, social: 0 }],
      [1600, "own", { own: 1, social: 0 }],
      [2600, "own", { own: 2, social: 0 }],
    ]);
    d.deliver(queueEmpty(3000, P1, "c3"));
    expect(d.wake.peek(P1)).toEqual({ at: DAY, kind: "own" });
    d.deliver(message(4000, P2, [P1], 1));
    d.advance(4600);
    expect(d.lastWake(P1)).toEqual({
      seat: P1,
      t: 4600,
      rec: {
        reasons: ["queue_empty c3", "message g00001"],
        urgent: false,
        charge: "social",
        day: 0,
        used: { own: 2, social: 1 },
      },
    });
    d.deliver(queueEmpty(5000, P1, "c4"));
    d.advance(DAY - 1);
    expect(d.lastWake(P1).t).toBe(4600);
    d.advance(DAY);
    expect(d.lastWake(P1)).toEqual({
      seat: P1,
      t: DAY,
      rec: {
        reasons: ["queue_empty c4"],
        urgent: false,
        charge: "own",
        day: 1,
        used: { own: 1, social: 0 },
      },
    });
  });

  test("an exhausted social budget moves social wakes to the next day while own wakes still fire", () => {
    const d = started(small, false);
    for (const [t, n] of [
      [1000, 1],
      [2000, 2],
    ] as const) {
      d.deliver(message(t, P2, [P1], n));
      d.advance(t + 600);
      d.close(P1);
    }
    expect(d.wakesOf(P1).map((w) => w.rec.charge)).toEqual([null, "social", "social"]);
    d.deliver(message(3000, P2, [P1], 3));
    expect(d.wake.peek(P1)).toEqual({ at: DAY, kind: "social" });
    d.deliver(queueEmpty(4000, P1));
    d.advance(4600);
    expect(d.lastWake(P1)).toMatchObject({
      t: 4600,
      rec: {
        reasons: ["message g00003", "queue_empty c1"],
        charge: "own",
        used: { own: 1, social: 2 },
      },
    });
    d.close(P1, 7200); // a self-wake still fires on day 0
    d.deliver(message(5000, P2, [P1], 4));
    d.advance(11800);
    expect(d.lastWake(P1)).toMatchObject({
      t: 11800,
      rec: { reasons: ["message g00004", "self"], charge: "own", used: { own: 2, social: 2 } },
    });
    d.close(P1);
    d.deliver(message(12000, P2, [P1], 5));
    d.advance(DAY);
    expect(d.lastWake(P1)).toMatchObject({
      t: DAY,
      rec: { reasons: ["message g00005"], charge: "social", day: 1, used: { own: 0, social: 1 } },
    });
  });

  test("30 messages a day from another seat never produce an own-charged wake", () => {
    const d = started();
    for (let i = 0; i < 30; i += 1) d.deliver(message(1000 + i * 2800, P2, [P1], i + 1));
    d.advance(2 * DAY);
    const wakes = d.wakesOf(P1);
    expect(wakes.some((w) => w.rec.charge === "own")).toBe(false);
    const day0 = wakes.filter((w) => w.rec.day === 0 && w.rec.charge === "social");
    expect(day0).toHaveLength(RULES.socialWakesPerDay);
    // every message reached a wake, the last ones on the next day
    const reasons = wakes.flatMap((w) => w.rec.reasons).filter((r) => r.startsWith("message"));
    expect(reasons).toHaveLength(30);
  });

  test("the budget day is the day of the wake time, not of the trigger", () => {
    const tight: GatewayRules = { ...RULES, ownWakesPerDay: 1 };
    const d = started(tight);
    d.deliver(queueEmpty(1000, P1, "c1"));
    d.advance(1600);
    d.deliver(queueEmpty(DAY - 400, P1, "c2")); // grouped time DAY + 200: day 1, not moved
    expect(d.wake.peek(P1)).toEqual({ at: DAY + 200, kind: "own" });
    d.deliver(queueEmpty(DAY + 300, P1, "c3"));
    d.advance(DAY + 200);
    expect(d.lastWake(P1).rec).toMatchObject({ charge: "own", day: 1, used: { own: 1 } });
  });

  test("a budget of 0 never wakes the class; the safety wake still does", () => {
    const none: GatewayRules = { ...RULES, socialWakesPerDay: 0 };
    const d = started(none);
    d.deliver(message(1000, P2, [P1], 1));
    expect(d.wake.peek(P1)).toEqual({ at: 43200, kind: "safety" });
    d.advance(43200);
    expect(d.lastWake(P1).rec).toMatchObject({
      reasons: ["message g00001", "safety"],
      charge: null,
    });
  });
});

describe("grouping and turns", () => {
  test("triggers of one class inside the group window produce one wake", () => {
    const d = started();
    d.deliver(queueEmpty(1000, P1, "c1"), queueEmpty(1200, P1, "c2"), queueEmpty(1599, P1, "c3"));
    d.advance(5000);
    const own = d.wakesOf(P1).filter((w) => w.rec.charge === "own");
    expect(own.map((w) => [w.t, w.rec.reasons])).toEqual([
      [1600, ["queue_empty c1", "queue_empty c2", "queue_empty c3"]],
    ]);
  });

  test("a normal trigger during a turn longer than groupWindow wakes at max(first + window, end + 1)", () => {
    const d = started(RULES, false);
    d.deliver(queueEmpty(1000, P1));
    d.advance(1600); // own wake: P1 is in a turn from 1600
    d.deliver(message(1700, P2, [P1], 1));
    d.advance(5000);
    d.close(P1);
    expect(d.wake.peek(P1)).toEqual({ at: 5001, kind: "social" });
    d.advance(5001);
    expect(d.lastWake(P1).t).toBe(5001);
    d.deliver(message(9900, P2, [P1], 2));
    d.advance(10000);
    d.close(P1);
    expect(d.wake.peek(P1)).toEqual({ at: 10500, kind: "social" });
  });

  test("a seat in a turn has no wake time: nextWakeTime and due ignore it", () => {
    const d = started(RULES, false);
    d.deliver(queueEmpty(1000, P1));
    d.advance(1600);
    d.deliver(message(1700, P2, [P1], 1), queueEmpty(1800, P1));
    expect(d.wake.peek(P1)).toBeNull();
    expect(d.wake.due(100000)).toEqual([P2, P3]);
    expect(d.wake.nextWakeTime()).toBe(43200);
  });

  test("after a turn ending at t, the next wake is later than t unless an urgent trigger is due", () => {
    const d = started({ ...RULES, groupWindow: 0 }, false);
    d.deliver(queueEmpty(1000, P1));
    d.advance(1000); // own wake at 1000 (window 0), P1 in its turn
    d.deliver(queueEmpty(1700, P1), message(1700, P2, [P1], 1));
    d.close(P1);
    expect(d.wake.peek(P1)).toEqual({ at: 1701, kind: "own" });
    d.advance(1701);
    d.deliver(incomingAttack(1800, P1, P2, 1), queueEmpty(1800, P1));
    d.close(P1);
    expect(d.wake.peek(P1)).toEqual({ at: 1800, kind: "urgent" });
  });
});

describe("self-wakes", () => {
  test("a self-wake survives an urgent wake and fires later, and survives a turn ended without a request", () => {
    const d = started(RULES, false);
    d.advance(100);
    d.deliver(queueEmpty(100, P1));
    d.advance(700);
    d.close(P1, 7200); // self-wake at 7900
    expect(seatOf(d.gw, P1).wake.selfAt).toBe(7900);
    d.deliver(incomingAttack(3000, P1, P2, 1));
    expect(d.lastWake(P1)).toMatchObject({ t: 3000, rec: { reasons: ["incoming_attack m00001"] } });
    expect(seatOf(d.gw, P1).wake.selfAt).toBe(7900);
    d.close(P1); // end_turn {}
    expect(seatOf(d.gw, P1).wake.selfAt).toBe(7900);
    expect(d.wake.peek(P1)).toEqual({ at: 7900, kind: "self" });
    d.advance(7900);
    expect(d.lastWake(P1)).toEqual({
      seat: P1,
      t: 7900,
      rec: { reasons: ["self"], urgent: false, charge: "own", day: 0, used: { own: 2, social: 0 } },
    });
    expect(seatOf(d.gw, P1).wake.selfAt).toBeNull();
  });

  test("clamping into [now + selfWake.min, now + selfWake.max] is reported", () => {
    const gw = createGatewayState([P1]);
    const wake = createWakeScheduler(gw, RULES);
    expect(wake.requestSelfWake(P1, 1010, 1000)).toEqual({ at: 1600, clamped: true });
    expect(wake.requestSelfWake(P1, 1000 + 50000, 1000)).toEqual({ at: 44200, clamped: true });
    expect(wake.requestSelfWake(P1, 2000, 1000)).toEqual({ at: 2000, clamped: false });
    expect(wake.requestSelfWake(P1, 1600, 1000)).toEqual({ at: 1600, clamped: false });
    expect(wake.requestSelfWake(P1, 44200, 1000)).toEqual({ at: 44200, clamped: false });
    expect(wake.requestSelfWake(P1, 1000 + Number.MAX_SAFE_INTEGER, 1000)).toEqual({
      at: 44200,
      clamped: true,
    });
    expect(seatOf(gw, P1).wake.selfAt).toBe(44200);
  });

  test("the clamp range starts at the end_turn call time, which the seat state does not hold", () => {
    const d = started(RULES, false);
    d.deliver(queueEmpty(1000, P1));
    d.advance(1600);
    expect(d.lastWake(P1).t).toBe(1600);
    d.advance(5000); // a real-time turn: the agent calls end_turn {nextWakeIn: 100} at 5000
    const s = seatOf(d.gw, P1);
    expect([s.wake.inTurn, s.wake.lastEnd, s.lastBriefingAt]).toEqual([true, 0, 1600]);
    // from lastEnd the floor would be 600, from the wake 2200: only `now` gives 5600
    expect(d.wake.requestSelfWake(P1, 5100, 5000)).toEqual({ at: 5600, clamped: true });
    d.close(P1);
    expect(s.wake.selfAt).toBe(5600);
    expect(s.lastTurn?.nextWake).toEqual({ at: 5600, kind: "self" });
  });

  test("a later request replaces the pending self-wake", () => {
    const d = started(RULES, false);
    d.deliver(queueEmpty(1000, P1));
    d.advance(1600);
    d.close(P1, 20000);
    d.deliver(message(2000, P2, [P1], 1));
    d.advance(2600);
    d.close(P1, 1000);
    expect(d.wake.peek(P1)).toEqual({ at: 3600, kind: "self" });
  });
});

describe("public events", () => {
  test("public messages never wake anyone", () => {
    const d = started();
    const before = [P1, P2, P3].map((p) => d.wake.peek(p));
    d.deliver(publicMessage(5000, P2, 1));
    expect([P1, P2, P3].map((p) => d.wake.peek(p))).toEqual(before);
    expect(d.wakes).toHaveLength(3);
    expect(d.gw.feed.map((x) => x.e)).toEqual([1]);
  });

  test("a public message addressed to other seats as target wakes nobody, even with a public entry", () => {
    // The engine may address a `to: "all"` message to every seat (for their archives); the wake
    // table may even name `message.public`. Neither wakes anyone.
    const rules: GatewayRules = {
      ...RULES,
      wake: { ...RULES.wake, message: { target: "urgent", public: "social" } },
    };
    const d = started(rules);
    const wakeState = () => [P1, P2, P3].map((p) => JSON.stringify(seatOf(d.gw, p).wake));
    const before = wakeState();
    const broadcast = event(
      5000,
      "message",
      [
        [P2, "self"],
        [P1, "target"],
        [P3, "target"],
      ],
      { message: "g00001", from: P2, to: "all", text: "hear ye" },
      true,
    );
    d.deliver(broadcast);
    expect(wakeState()).toEqual(before);
    expect(d.wakes).toHaveLength(3);
    expect(seatOf(d.gw, P1).archive.map((x) => x.e)).toEqual([1]);
    expect(d.gw.feed.map((x) => x.e)).toEqual([1]);
    // `to: "all"` alone makes it public for the wake rules, and a private message still wakes
    d.deliver({ ...broadcast, t: 5100, public: false });
    expect(wakeState()).toEqual(before);
    d.deliver(message(5200, P2, [P1], 2));
    expect(d.lastWake(P1)).toMatchObject({ t: 5200, rec: { urgent: true } });
  });

  test("domination_started wakes the public role once per bloc per game day", () => {
    const d = started();
    const t0 = 3 * DAY + 1000;
    d.deliver(dominationStarted(t0, "a1"));
    expect(d.wakes.filter((w) => w.t === t0).map((w) => w.seat)).toEqual([P1, P2, P3]);
    expect(d.wakes.filter((w) => w.t === t0).every((w) => w.rec.urgent)).toBe(true);
    d.deliver(dominationStarted(t0 + 5000, "a1")); // same bloc, same day: news only
    expect(d.wakes.some((w) => w.t === t0 + 5000)).toBe(false);
    d.deliver(dominationStarted(t0 + 6000, "p3")); // another bloc
    expect(d.wakes.filter((w) => w.t === t0 + 6000)).toHaveLength(3);
    d.deliver(dominationStarted(4 * DAY + 10, "a1")); // the next game day
    expect(d.wakes.filter((w) => w.t === 4 * DAY + 10)).toHaveLength(3);
    expect(Object.keys(d.gw.onceKeys).toSorted((a, b) => (a < b ? -1 : 1))).toEqual([
      "domination_started:a1:3",
      "domination_started:a1:4",
      "domination_started:p3:3",
    ]);
    expect(d.gw.feed).toHaveLength(4);
  });

  test("a public event is ingested for every seat with the public role and also per recipient role", () => {
    const rules: GatewayRules = {
      ...RULES,
      wake: { ...RULES.wake, city_conquered: { target: "urgent", public: "social" } },
    };
    const d = started(rules);
    const conquered = event(
      5000,
      "city_conquered",
      [[P1, "target"]],
      { city: "c3", from: P1, to: P2 },
      true,
    );
    d.deliver(conquered);
    expect(d.lastWake(P1)).toMatchObject({
      t: 5000,
      rec: { urgent: true, reasons: ["city_conquered c3"] },
    });
    expect(d.wake.peek(P2)).toEqual({ at: 5600, kind: "social" });
    expect(d.wake.peek(P3)).toEqual({ at: 5600, kind: "social" });
  });
});

describe("defer and elimination", () => {
  test("a deferred seat is not due before `to`, then wakes with its reasons", () => {
    const d = started(RULES, false);
    d.deliver(incomingAttack(5000, P1, P2, 1));
    // P1 woke at 5000; close and imagine the lockstep cap binds for P2 instead
    d.close(P1);
    deliver(d.gw, [incomingAttack(6000, P2, P1, 2)], d.wake);
    d.now = 6000;
    expect(d.wake.due(6000)).toEqual([P2]);
    d.wake.defer(P2, 6001);
    expect(d.wake.due(6000)).toEqual([]);
    expect(d.wake.peek(P2)).toEqual({ at: 6001, kind: "urgent" });
    expect(d.wake.nextWakeTime()).toBe(6001);
    expect(() => d.wake.begin(P2, 6000)).toThrow(/not due/);
    expect(d.wake.begin(P2, 6001)).toMatchObject({
      reasons: ["incoming_attack m00002"],
      urgent: true,
    });
    expect(seatOf(d.gw, P2).wake.deferTo).toBeNull();
  });

  test("an eliminated seat never wakes again and ignores triggers", () => {
    const d = started();
    d.deliver(event(5000, "player_eliminated", [[P3, "self"]], { player: P3 }, true));
    expect(seatOf(d.gw, P3).alive).toBe(false);
    expect(d.wake.peek(P3)).toBeNull();
    d.deliver(incomingAttack(6000, P3, P1, 1), message(6000, P1, [P3], 1));
    d.advance(10 * DAY);
    expect(d.wakesOf(P3).every((w) => w.t < 5000)).toBe(true);
    expect(seatOf(d.gw, P3).wake.urgentAt).toBeNull();
    expect(() => d.wake.begin(P3, 10 * DAY)).toThrow(/eliminated/);
  });

  test("misuse throws: begin while in a turn or not due, end while idle", () => {
    const gw = createGatewayState([P1]);
    const wake = createWakeScheduler(gw, RULES);
    wake.begin(P1, 0);
    expect(() => wake.begin(P1, 0)).toThrow(/already in a turn/);
    wake.end(P1, 0);
    expect(() => wake.end(P1, 0)).toThrow(/not in a turn/);
    expect(() => wake.begin(P1, 100)).toThrow(/not due/);
    expect(() => wake.peek("p9")).toThrow(/unknown seat/);
  });
});

describe("classification and reasons", () => {
  test("isPublicMessage: a message to all, or a public message", () => {
    expect(isPublicMessage(publicMessage(0, P2, 1))).toBe(true);
    expect(isPublicMessage({ ...publicMessage(0, P2, 1), public: false })).toBe(true);
    expect(isPublicMessage(message(0, P2, [P1], 1))).toBe(false);
    expect(isPublicMessage(dominationStarted(0, "a1"))).toBe(false);
  });

  test("rules.wake[type][role] gives the class; no entry means no wake", () => {
    expect(wakeClassOf(RULES, "incoming_attack", "party")).toBe("urgent");
    expect(wakeClassOf(RULES, "incoming_attack", "target")).toBe("social");
    expect(wakeClassOf(RULES, "incoming_attack", "self")).toBeNull();
    expect(wakeClassOf(RULES, "alliance_left", "public")).toBeNull();
    expect(wakeClassOf(RULES, "constructor", "self")).toBeNull();
    expect(wakeClassOf(RULES, "to_string", "public")).toBeNull();
  });

  test("a reason is the type and the id the event concerns", () => {
    expect(wakeReasonOf(incomingAttack(0, P1, P2, 7))).toBe("incoming_attack m00007");
    expect(wakeReasonOf(message(0, P2, [P1], 9))).toBe("message g00009");
    expect(wakeReasonOf(queueEmpty(0, P1, "c4"))).toBe("queue_empty c4");
    expect(
      wakeReasonOf(event(0, "betrayal", [], { by: P2, against: P1, relation: "pact", city: "c3" })),
    ).toBe("betrayal p2");
    expect(wakeReasonOf(event(0, "custom", [], { note: "x" }))).toBe("custom");
    expect(wakeReasonOf(event(0, "custom", [], { city: "has space" }))).toBe("custom");
  });

  test("a trigger repeated with the same reason is listed once", () => {
    const gw = createGatewayState([P1]);
    const wake = createWakeScheduler(gw, RULES);
    wake.begin(P1, 0);
    briefed(gw, P1, 0);
    closeTurn(gw, wake, { t: 0, seat: P1, why: "end_turn", rounds: 1, selfAt: null });
    deliver(gw, [queueEmpty(10, P1, "c1"), queueEmpty(20, P1, "c1")], wake);
    expect(wake.begin(P1, 610).reasons).toEqual(["queue_empty c1"]);
  });
});
