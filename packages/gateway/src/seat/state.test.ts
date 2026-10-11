import { describe, expect, test } from "bun:test";
import { canonicalJson } from "@perfidia/engine/core";
import {
  LogLineSchema,
  type Action,
  type DomainEvent,
  type GameTime,
  type LogLine,
  type PlayerId,
  type ToolError,
} from "@perfidia/protocol";
import { checkCallCap } from "./caps.ts";
import { deliver } from "./deliver.ts";
import { seatErrorText } from "./errors.ts";
import { writeNote } from "./notes.ts";
import { briefed, createGatewayState, seatOf, sortedSeats, todayCounters } from "./state.ts";
import {
  event,
  incomingAttack,
  message,
  P1,
  P2,
  P3,
  publicMessage,
  queueEmpty,
  RULES,
  viaJson,
} from "./testkit.test.ts";
import { closeTurn, recordAct, recordGw } from "./turn.ts";
import type { GatewayState, WakeScheduler } from "./types.ts";
import { createWakeScheduler } from "./wake.ts";

describe("createGatewayState", () => {
  test("every seat alive, idle, start wake pending; seats sorted; duplicates rejected", () => {
    const gw = createGatewayState(["p10", "p2", "p1"]);
    expect(sortedSeats(gw).map((s) => s.seat)).toEqual(["p1", "p2", "p10"]);
    expect(seatOf(gw, "p2")).toEqual({
      seat: "p2",
      alive: true,
      notes: "",
      inbox: [],
      archive: [],
      lastBriefingAt: 0,
      lastBriefingE: 0,
      wake: {
        inTurn: false,
        urgentAt: null,
        urgentReasons: [],
        lastUrgentStart: null,
        ownFirst: null,
        socialFirst: null,
        selfAt: null,
        lastEnd: 0,
        reasons: [],
        deferTo: null,
      },
      day: { index: 0, ownWakes: 0, socialWakes: 0, attacks: 0, messages: 0 },
      turns: 0,
      lastTurn: null,
      turnFailures: [],
      turnWarnings: [],
    });
    expect(gw.feed).toEqual([]);
    expect(gw.onceKeys).toEqual({});
    expect(gw.delivered).toBe(0);
    expect(() => createGatewayState([P1, P2, P1])).toThrow(/listed twice/);
  });

  test("todayCounters reads zeros for a day that has not started counting", () => {
    const s = seatOf(createGatewayState([P1]), P1);
    s.day = { index: 2, ownWakes: 3, socialWakes: 1, attacks: 4, messages: 5 };
    expect(todayCounters(s, 2 * 86400 + 5)).toEqual(s.day);
    expect(todayCounters(s, 3 * 86400)).toEqual({
      index: 3,
      ownWakes: 0,
      socialWakes: 0,
      attacks: 0,
      messages: 0,
    });
  });
});

/**
 * A live host in miniature: every gateway-state change goes through the seat functions and writes
 * the log line that carries it, as §8.4 requires. `messages` stands in for what the rebuild gets
 * from the engine re-run and the explanations: the wording of each engine rejection, by line
 * number. Seat errors need no such help: their wording comes from the `gw` line's details.
 */
class LiveHost {
  readonly gw: GatewayState;
  readonly wake: WakeScheduler;
  readonly lines: LogLine[] = [];
  readonly messages: Record<number, string> = {};
  private n = 0;

  constructor(players: readonly PlayerId[]) {
    this.gw = createGatewayState(players);
    this.wake = createWakeScheduler(this.gw, RULES);
  }

  ev(...events: DomainEvent[]): void {
    for (const e of events) {
      deliver(this.gw, [e], this.wake);
      this.lines.push({ k: "ev", t: e.t, e });
    }
  }

  /** Opens the turn of every seat due at `t`; returns them. */
  open(t: GameTime): PlayerId[] {
    const due = this.wake.due(t);
    for (const seat of due) {
      const rec = this.wake.begin(seat, t);
      briefed(this.gw, seat, t);
      this.lines.push({ k: "wake", t, seat, turn: seatOf(this.gw, seat).turns, ...rec });
    }
    return due;
  }

  act(t: GameTime, seat: PlayerId, rt: number, a: Action, code: string | null, why = ""): void {
    this.n += 1;
    const r = code === null ? { ok: true as const } : { ok: false as const, code };
    const line: LogLine = {
      k: "act",
      n: this.n,
      t,
      seat,
      turn: seatOf(this.gw, seat).turns,
      rt,
      tool: a.type,
      i: 0,
      a,
      r,
    };
    if (code !== null) this.messages[this.n] = why;
    recordAct(this.gw, line, code === null ? null : why);
    this.lines.push(line);
  }

  reject(seat: PlayerId, rt: number, tool: string, err: ToolError): void {
    this.n += 1;
    const r =
      err.details === undefined
        ? { ok: false as const, code: err.code }
        : { ok: false as const, code: err.code, details: err.details };
    const line: LogLine = {
      k: "gw",
      n: this.n,
      t: err.t,
      seat,
      turn: seatOf(this.gw, seat).turns,
      rt,
      tool,
      r,
    };
    recordGw(this.gw, line, err.message);
    this.lines.push(line);
  }

  note(t: GameTime, seat: PlayerId, rt: number, mode: "append" | "replace", text: string): void {
    const r = writeNote(seatOf(this.gw, seat), text, mode, RULES.notesMaxChars, t);
    if (r.ok) {
      this.n += 1;
      this.lines.push({
        k: "note",
        n: this.n,
        t,
        seat,
        turn: seatOf(this.gw, seat).turns,
        mode,
        text,
      });
    } else {
      this.reject(seat, rt, "write_note", r);
    }
  }

  end(t: GameTime, seat: PlayerId, rounds: number, wakeIn?: number): void {
    if (wakeIn !== undefined) this.wake.requestSelfWake(seat, t + wakeIn, t);
    const why = wakeIn === undefined ? "empty_round" : "end_turn";
    const out = closeTurn(this.gw, this.wake, {
      t,
      seat,
      why,
      rounds,
      selfAt: seatOf(this.gw, seat).wake.selfAt,
    });
    this.lines.push({
      k: "turn",
      t,
      seat,
      turn: seatOf(this.gw, seat).turns,
      rounds,
      calls: 0,
      why,
      selfAt: out.selfAt,
      next: out.next,
    });
  }

  defer(t: GameTime, seat: PlayerId, to: GameTime): void {
    this.wake.defer(seat, to);
    this.lines.push({ k: "defer", t, seat, to });
  }
}

/** The fold of §10.5 over the seat functions, as `rebuildGatewayState` will run it. */
function rebuild(
  players: readonly PlayerId[],
  lines: readonly LogLine[],
  messages: Readonly<Record<number, string>>,
): GatewayState {
  const gw = createGatewayState(players);
  const wake = createWakeScheduler(gw, RULES);
  for (const line of lines) {
    switch (line.k) {
      case "ev":
        deliver(gw, [line.e], wake);
        break;
      case "wake": {
        const rec = wake.begin(line.seat, line.t);
        expect(rec).toEqual({
          reasons: line.reasons,
          urgent: line.urgent,
          charge: line.charge,
          day: line.day,
          used: line.used,
        });
        briefed(gw, line.seat, line.t);
        expect(seatOf(gw, line.seat).turns).toBe(line.turn);
        break;
      }
      case "act":
        recordAct(gw, line, line.r.ok ? null : (messages[line.n] ?? null));
        break;
      case "gw":
        recordGw(
          gw,
          line,
          seatErrorText(line.r.code, line.r.details, line.t)?.message ?? line.r.code,
        );
        break;
      case "note":
        expect(
          writeNote(seatOf(gw, line.seat), line.text, line.mode, RULES.notesMaxChars, line.t).ok,
        ).toBe(true);
        break;
      case "turn": {
        const out = closeTurn(gw, wake, { ...line, next: line.next });
        expect(out).toEqual({ selfAt: line.selfAt, next: line.next });
        break;
      }
      case "defer":
        wake.defer(line.seat, line.to);
        break;
      case "header":
      case "batch":
      case "obs":
      case "controller":
      case "ckpt":
      case "end":
      case "fatal":
        break;
    }
  }
  return gw;
}

const attackAction: Action = { type: "attack", from: "c1", to: "c3", units: { raider: 10 } };
const sendAction: Action = { type: "send_message", to: [P1], text: "truce?" };
const buildAction: Action = { type: "build", city: "c1", building: "hall" };

function scenario(): LiveHost {
  const h = new LiveHost([P1, P2, P3]);
  expect(h.open(0)).toEqual([P1, P2, P3]);
  h.act(0, P1, 0, buildAction, null);
  h.act(0, P1, 0, attackAction, null);
  h.ev(incomingAttack(0, P3, P1, 1));
  h.note(0, P1, 0, "append", "p3 looks weak");
  h.act(0, P1, 1, buildAction, "QUEUE_FULL", "c1's build queue is full (2 of 2).");
  h.end(0, P1, 2, 3600);
  h.act(0, P2, 0, sendAction, null);
  h.ev(message(0, P2, [P1], 1, "truce?"));
  h.reject(P2, 0, "spy", checkCallCap(RULES, { round: 10, wake: 10 }, 0)!);
  h.end(0, P2, 1);
  h.note(0, P3, 0, "replace", "x".repeat(5000)); // too long: a gw line
  h.end(0, P3, 1);
  expect(h.open(0)).toEqual([P3]); // the attack woke p3 at once, after its start turn
  h.end(0, P3, 1, 600);
  expect(h.wake.nextWakeTime()).toBe(600);
  expect(h.open(600)).toEqual([P1, P3]);
  h.ev(publicMessage(600, P3, 2));
  h.end(600, P1, 1); // end_turn {}: the self-wake at 3600 stays
  h.ev(queueEmpty(600, P3));
  h.defer(600, P3, 601);
  h.end(600, P3, 1);
  h.ev(event(700, "player_eliminated", [[P2, "self"]], { player: P2 }, true));
  expect(h.wake.nextWakeTime()).toBe(1200);
  expect(h.open(1200)).toEqual([P3]);
  h.end(1200, P3, 1, 50000); // clamped to 43200 ahead
  expect(h.open(3600)).toEqual([P1]);
  h.note(3600, P1, 0, "append", "p2 is out");
  h.end(3600, P1, 1);
  return h;
}

describe("JSON state and the line-driven rebuild", () => {
  test("the whole gateway state round-trips through JSON", () => {
    const h = scenario();
    const copy = viaJson(h.gw);
    expect(copy).toEqual(h.gw);
    expect(canonicalJson(copy)).toBe(canonicalJson(h.gw));
    // a scheduler over the copy continues exactly like one over the original
    const again = createWakeScheduler(copy, RULES);
    expect(again.nextWakeTime()).toBe(h.wake.nextWakeTime());
    for (const p of [P1, P2, P3]) expect(again.peek(p)).toEqual(h.wake.peek(p));
    const t = h.wake.nextWakeTime()!;
    const due = h.wake.due(t);
    expect(due).toEqual([P3]);
    expect(again.due(t)).toEqual(due);
    expect(again.begin(P3, t)).toEqual(h.wake.begin(P3, t));
    expect(copy).toEqual(h.gw);
  });

  test("the scenario's lines are protocol log lines", () => {
    const h = scenario();
    for (const line of h.lines)
      expect(LogLineSchema.parse(JSON.parse(JSON.stringify(line)))).toEqual(line);
    expect(new Set(h.lines.map((l) => l.k))).toEqual(
      new Set(["wake", "act", "ev", "note", "turn", "gw", "defer"]),
    );
  });

  test("folding the lines through the same functions rebuilds the live state exactly", () => {
    const h = scenario();
    const lines = h.lines.map((l) => LogLineSchema.parse(JSON.parse(JSON.stringify(l))));
    const rebuilt = rebuild([P1, P2, P3], lines, h.messages);
    expect(canonicalJson(rebuilt)).toBe(canonicalJson(h.gw));
    const p1 = seatOf(rebuilt, P1);
    expect(p1.notes).toBe("p3 looks weak\np2 is out");
    expect(p1.day.attacks).toBe(1);
    expect(seatOf(rebuilt, P2).alive).toBe(false);
    expect(seatOf(rebuilt, P2).lastTurn?.unseen).toEqual([
      {
        tool: "spy",
        code: "CALLS_CAP",
        message: "Only the first 10 calls of a round trip run; this was call 11.",
      },
    ]);
    expect(seatOf(rebuilt, P3).lastTurn).toMatchObject({ ended: "end_turn" });
    expect(seatOf(rebuilt, P3).turns).toBe(4); // start, the attack, 600, 1200
    expect(seatOf(rebuilt, P3).wake.selfAt).toBe(1200 + 43200);
  });

  test("a missing line makes the rebuild differ", () => {
    const h = scenario();
    const withoutNote = h.lines.filter((l) => !(l.k === "note" && l.text === "p2 is out"));
    expect(canonicalJson(rebuild([P1, P2, P3], withoutNote, h.messages))).not.toBe(
      canonicalJson(h.gw),
    );
  });
});
