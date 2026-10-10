import { describe, expect, test } from "bun:test";
import { BriefingLastTurnSchema, type Action } from "@perfidia/protocol";
import { briefed, createGatewayState, seatOf } from "./state.ts";
import { P1, RULES } from "./testkit.test.ts";
import { closeTurn, recordAct, recordGw } from "./turn.ts";
import { createWakeScheduler } from "./wake.ts";

const build: Action = { type: "build", city: "c1", building: "hall" };

function opened() {
  const gw = createGatewayState([P1]);
  const wake = createWakeScheduler(gw, RULES);
  wake.begin(P1, 0);
  briefed(gw, P1, 0);
  return { gw, wake, s: seatOf(gw, P1) };
}

describe("lastTurn", () => {
  test("lists the last round's failures and every TURN_OVER or CALLS_CAP, then the next wake", () => {
    const { gw, wake, s } = opened();
    const fail = (rt: number, code: string, message: string) =>
      recordAct(
        gw,
        { t: 0, seat: P1, rt, tool: "build", a: build, r: { ok: false, code } },
        message,
      );
    fail(0, "INSUFFICIENT_RESOURCES", "seen in round 1");
    recordGw(
      gw,
      { seat: P1, rt: 0, tool: "spy", r: { ok: false, code: "CALLS_CAP" } },
      "call 11 did not run",
    );
    recordAct(gw, { t: 0, seat: P1, rt: 1, tool: "build", a: build, r: { ok: true } }, null);
    fail(2, "QUEUE_FULL", "never seen");
    recordGw(
      gw,
      { seat: P1, rt: 2, tool: "attack", r: { ok: false, code: "TURN_OVER" } },
      "after end_turn",
    );
    wake.requestSelfWake(P1, 7200, 0);
    const out = closeTurn(gw, wake, {
      t: 0,
      seat: P1,
      why: "end_turn",
      rounds: 3,
      selfAt: s.wake.selfAt,
    });
    expect(out).toEqual({ selfAt: 7200, next: { at: 7200, kind: "self" } });
    expect(s.lastTurn).toEqual({
      ended: "end_turn",
      unseen: [
        { tool: "spy", code: "CALLS_CAP", message: "call 11 did not run" },
        { tool: "build", code: "QUEUE_FULL", message: "never seen" },
        { tool: "attack", code: "TURN_OVER", message: "after end_turn" },
      ],
      nextWake: { at: 7200, kind: "self" },
    });
    expect(BriefingLastTurnSchema.safeParse({ ...s.lastTurn, nextWake: null }).success).toBe(true);
    expect(s.turnFailures).toEqual([]);
  });

  test("an empty last round leaves the previous round's failures seen", () => {
    const { gw, wake, s } = opened();
    recordAct(
      gw,
      { t: 0, seat: P1, rt: 0, tool: "build", a: build, r: { ok: false, code: "MAX_LEVEL" } },
      "m",
    );
    closeTurn(gw, wake, { t: 0, seat: P1, why: "empty_round", rounds: 2, selfAt: null });
    expect(s.lastTurn).toEqual({
      ended: "empty_round",
      unseen: [],
      nextWake: { at: 43200, kind: "safety" },
    });
  });

  test("a rejection without an explanation falls back to its code", () => {
    const { gw, wake, s } = opened();
    recordAct(
      gw,
      { t: 0, seat: P1, rt: 0, tool: "build", a: build, r: { ok: false, code: "MAX_LEVEL" } },
      null,
    );
    closeTurn(gw, wake, { t: 0, seat: P1, why: "round_cap", rounds: 1, selfAt: null });
    expect(s.lastTurn?.unseen).toEqual([
      { tool: "build", code: "MAX_LEVEL", message: "MAX_LEVEL" },
    ]);
  });

  test("the line's next wake wins when given (rebuild, or a match that ended)", () => {
    const { gw, wake, s } = opened();
    const out = closeTurn(gw, wake, {
      t: 0,
      seat: P1,
      why: "match_ended",
      rounds: 1,
      selfAt: null,
      next: null,
    });
    expect(out.next).toBeNull();
    expect(s.lastTurn?.nextWake).toBeNull();
  });

  test("the turn line's selfAt is the pending self-wake: kept by a turn ended without a request", () => {
    const { gw, wake, s } = opened();
    wake.requestSelfWake(P1, 9000, 0);
    closeTurn(gw, wake, { t: 0, seat: P1, why: "end_turn", rounds: 1, selfAt: s.wake.selfAt });
    s.wake.ownFirst = 100;
    wake.begin(P1, 700);
    const out = closeTurn(gw, wake, {
      t: 800,
      seat: P1,
      why: "end_turn",
      rounds: 1,
      selfAt: s.wake.selfAt,
    });
    expect(out).toEqual({ selfAt: 9000, next: { at: 9000, kind: "self" } });
  });

  test("a new turn starts with no failures", () => {
    const { gw, wake, s } = opened();
    recordAct(
      gw,
      { t: 0, seat: P1, rt: 0, tool: "build", a: build, r: { ok: false, code: "MAX_LEVEL" } },
      "m",
    );
    wake.end(P1, 0); // closed without closeTurn (an aborted turn)
    wake.begin(P1, 43200);
    expect(s.turnFailures).toEqual([]);
  });
});
