import { describe, expect, test } from "bun:test";
import { ToolErrorSchema, type Action, type GatewayRules } from "@perfidia/protocol";
import {
  checkCallCap,
  checkDailyCap,
  checkRoundTrip,
  dailyUsed,
  roundCallCap,
  seatBudget,
} from "./caps.ts";
import { createGatewayState, seatOf } from "./state.ts";
import { P1, RULES } from "./testkit.test.ts";
import { recordAct } from "./turn.ts";
import { createWakeScheduler } from "./wake.ts";

const DAY = 86400;
const attack: Action = { type: "attack", from: "c1", to: "c2", units: { raider: 5 } };
const send: Action = { type: "send_message", to: ["p2", "p3", "p4"], text: "hi" };
const found: Action = {
  type: "found_city",
  from: "c1",
  island: "i2",
  units: { settler: 1 },
  slot: null,
};

function seat() {
  const gw = createGatewayState([P1, "p2", "p3", "p4"]);
  return { gw, s: seatOf(gw, P1) };
}

describe("daily caps", () => {
  test("DAILY_CAP after 20 engine-accepted attack launches in a game day, with numbers", () => {
    const { gw, s } = seat();
    const t = 2 * DAY + 50000;
    for (let i = 0; i < 20; i += 1) {
      expect(checkDailyCap(s, RULES, "attacks", t)).toBeNull();
      recordAct(gw, { t, seat: P1, rt: 0, tool: "attack", a: attack, r: { ok: true } }, null);
      recordAct(
        gw,
        {
          t,
          seat: P1,
          rt: 0,
          tool: "attack",
          a: attack,
          r: { ok: false, code: "INSUFFICIENT_UNITS" },
        },
        "c1 has 0 raiders at home, 5 requested.",
      );
    }
    expect(dailyUsed(s, "attacks", t)).toBe(20);
    const err = checkDailyCap(s, RULES, "attacks", t);
    expect(err).toEqual({
      ok: false,
      t,
      code: "DAILY_CAP",
      message: "20 of 20 attack launches already used on D3: the limit is 20 per game day.",
      hint: "The count restarts at D4 00:00 (in 10h6m40s); use this turn for other orders.",
      details: { kind: "attacks", cap: 20, used: 20, availableAt: 3 * DAY },
    });
    expect(ToolErrorSchema.parse(err)).toEqual(err!);
    expect(checkDailyCap(s, RULES, "attacks", 3 * DAY)).toBeNull();
    expect(dailyUsed(s, "attacks", 3 * DAY)).toBe(0);
  });

  test("a send_message call counts once whatever its recipients; other actions count nothing", () => {
    const { gw, s } = seat();
    for (let i = 0; i < 19; i += 1) {
      recordAct(
        gw,
        { t: 100, seat: P1, rt: 1, tool: "send_message", a: send, r: { ok: true } },
        null,
      );
    }
    recordAct(gw, { t: 100, seat: P1, rt: 1, tool: "found_city", a: found, r: { ok: true } }, null);
    expect(dailyUsed(s, "messages", 100)).toBe(19);
    expect(dailyUsed(s, "attacks", 100)).toBe(0);
    expect(checkDailyCap(s, RULES, "messages", 100)).toBeNull();
    recordAct(
      gw,
      { t: 101, seat: P1, rt: 1, tool: "send_message", a: send, r: { ok: true } },
      null,
    );
    expect(checkDailyCap(s, RULES, "messages", 101)).toMatchObject({
      code: "DAILY_CAP",
      message: "20 of 20 messages already used on D1: the limit is 20 per game day.",
      details: { kind: "messages", cap: 20, used: 20, availableAt: DAY },
    });
  });

  test("counters follow the day of each line: a turn crossing midnight counts on the new day", () => {
    const { gw, s } = seat();
    recordAct(
      gw,
      { t: DAY - 1, seat: P1, rt: 0, tool: "attack", a: attack, r: { ok: true } },
      null,
    );
    recordAct(
      gw,
      { t: DAY + 1, seat: P1, rt: 1, tool: "attack", a: attack, r: { ok: true } },
      null,
    );
    expect(s.day).toEqual({ index: 1, ownWakes: 0, socialWakes: 0, attacks: 1, messages: 0 });
    expect(dailyUsed(s, "attacks", DAY - 1)).toBe(0);
  });
});

describe("turn caps", () => {
  test("CALLS_CAP beyond the per-round cap, with numbers", () => {
    expect(checkCallCap(RULES, { round: 9, wake: 25 }, 7)).toBeNull();
    const err = checkCallCap(RULES, { round: 10, wake: 30 }, 7);
    expect(err).toEqual({
      ok: false,
      t: 7,
      code: "CALLS_CAP",
      message: "Only the first 10 calls of a round trip run; this was call 11.",
      hint: "Send at most 10 calls per round trip; send this one again in the next round.",
      details: { scope: "round", cap: 10, used: 10 },
    });
    expect(ToolErrorSchema.parse(err)).toEqual(err!);
  });

  test("CALLS_CAP at the per-wake cap when the ruleset sets one", () => {
    const rules: GatewayRules = { ...RULES, toolCallsPerWake: 12 };
    expect(checkCallCap(rules, { round: 1, wake: 11 }, 0)).toBeNull();
    expect(checkCallCap(rules, { round: 2, wake: 12 }, 0)).toMatchObject({
      code: "CALLS_CAP",
      message: "A wake runs at most 12 calls, and 12 already ran.",
      details: { scope: "wake", cap: 12, used: 12 },
    });
    expect(roundCallCap(rules, 0)).toBe(10);
    expect(roundCallCap(rules, 5)).toBe(7);
    expect(roundCallCap(rules, 12)).toBe(0);
    expect(roundCallCap(RULES, 1000)).toBe(10);
  });

  test("ROUND_TRIP_CAP beyond roundTripsPerWake", () => {
    expect(checkRoundTrip(RULES, 7, 0)).toBeNull();
    const err = checkRoundTrip(RULES, 8, 0);
    expect(err).toMatchObject({
      code: "ROUND_TRIP_CAP",
      message: "A wake has at most 8 round trips; this call came in round trip 9.",
      details: { cap: 8, round: 9 },
    });
    expect(ToolErrorSchema.parse(err)).toEqual(err!);
  });
});

describe("seatBudget", () => {
  test("what is left of today's allowances, and the pending self-wake", () => {
    const { gw, s } = seat();
    const wake = createWakeScheduler(gw, RULES);
    wake.begin(P1, 0);
    wake.end(P1, 0);
    s.wake.ownFirst = 100;
    wake.begin(P1, 700); // own-charged
    for (let i = 0; i < 3; i += 1) {
      recordAct(gw, { t: 800, seat: P1, rt: 0, tool: "attack", a: attack, r: { ok: true } }, null);
    }
    recordAct(
      gw,
      { t: 800, seat: P1, rt: 0, tool: "send_message", a: send, r: { ok: true } },
      null,
    );
    wake.requestSelfWake(P1, 5000, 800);
    expect(seatBudget(s, RULES, 800)).toEqual({
      roundTrips: 8,
      callsPerRoundTrip: 10,
      callsPerWake: null,
      ownWakesLeft: 11,
      socialWakesLeft: 8,
      selfWakeAt: 5000,
      attacksLeft: 17,
      messagesLeft: 19,
    });
    expect(seatBudget(s, RULES, DAY)).toMatchObject({
      ownWakesLeft: 12,
      attacksLeft: 20,
      messagesLeft: 20,
    });
  });
});
