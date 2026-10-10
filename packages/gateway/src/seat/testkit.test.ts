// Shared fixtures for the seat tests (no tests here): gateway rules shaped like perfidia-1 §14,
// event builders, and a small host-like driver that wakes due seats and records the wake lines.

import {
  GatewayRulesSchema,
  type DomainEvent,
  type GameTime,
  type GatewayRules,
  type JsonObject,
  type PlayerId,
  type Role,
} from "@perfidia/protocol";
import { briefed, createGatewayState, seatOf } from "./state.ts";
import { closeTurn } from "./turn.ts";
import type { GatewayState, WakeRecord, WakeScheduler } from "./types.ts";
import { createWakeScheduler } from "./wake.ts";
import { deliver } from "./deliver.ts";

/** perfidia-1 §14.1 caps and the §14.2 wake table. */
export const RULES: GatewayRules = GatewayRulesSchema.parse({
  roundTripsPerWake: 8,
  toolCallsPerRoundTrip: 10,
  toolCallsPerWake: null,
  ownWakesPerDay: 12,
  socialWakesPerDay: 8,
  groupWindow: 600,
  urgentMinGap: 600,
  selfWake: { min: 600, max: 43200 },
  safetyWake: 43200,
  attackLaunchesPerDay: 20,
  messagesPerDay: 20,
  notesMaxChars: 4000,
  wake: {
    incoming_attack: { party: "urgent", target: "social", ally: "social", stationed: "social" },
    siege_started: { target: "urgent", ally: "urgent" },
    city_conquered: { target: "urgent" },
    betrayal: { target: "urgent" },
    domination_started: { public: "urgent" },
    queue_empty: { self: "own" },
    battle_report: { self: "own", target: "social", stationed: "social", party: "social" },
    spy_report: { self: "own" },
    spy_failed: { self: "own" },
    message: { target: "social" },
    proposal: { target: "social" },
    proposal_answered: { target: "social" },
    spy_detected: { target: "social" },
  },
  publicOncePerDay: ["domination_started"],
});

export const P1: PlayerId = "p1";
export const P2: PlayerId = "p2";
export const P3: PlayerId = "p3";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** An opaque id of `prefix` for test number `n` (`g00001`, …): valid, distinct per `n`. */
export function oid(prefix: "m" | "r" | "q" | "g", n: number): string {
  let rest = "";
  let v = n;
  for (let i = 0; i < 5; i += 1) {
    rest = ALPHABET[v % 32]! + rest;
    v = Math.floor(v / 32);
  }
  return prefix + rest;
}

export function event(
  t: GameTime,
  type: string,
  to: readonly (readonly [PlayerId, Role])[],
  data: JsonObject = {},
  isPublic = false,
): DomainEvent {
  return { t, type, public: isPublic, to: to.map(([p, as]) => ({ p, as })), data };
}

/** `by` attacks a city of `target`: urgent for the target as the recorded foe. */
export function incomingAttack(
  t: GameTime,
  target: PlayerId,
  by: PlayerId,
  n: number,
): DomainEvent {
  return event(t, "incoming_attack", [[target, "party"]], {
    movement: oid("m", n),
    from: "c9",
    by,
    foe: target,
    to: "c1",
    departAt: t,
    arriveAt: t + 3600,
    homecoming: false,
  });
}

/** A private message from `from` to `to`: social for the addressees. */
export function message(
  t: GameTime,
  from: PlayerId,
  to: readonly PlayerId[],
  n: number,
  text = `hello ${n}`,
): DomainEvent {
  return event(t, "message", [[from, "self"], ...to.map((p): [PlayerId, Role] => [p, "target"])], {
    message: oid("g", n),
    from,
    to: [...to],
    text,
  });
}

/** A public message (`to: "all"`): in the feed, addressed to nobody but its sender. */
export function publicMessage(
  t: GameTime,
  from: PlayerId,
  n: number,
  text = `news ${n}`,
): DomainEvent {
  return event(
    t,
    "message",
    [[from, "self"]],
    { message: oid("g", n), from, to: "all", text },
    true,
  );
}

/** An own trigger: a queue of `seat`'s city became empty. */
export function queueEmpty(t: GameTime, seat: PlayerId, city = "c1"): DomainEvent {
  return event(t, "queue_empty", [[seat, "self"]], { city, queue: "build" });
}

export function dominationStarted(t: GameTime, key: string): DomainEvent {
  return event(t, "domination_started", [], { key, endsAt: t + 86400 }, true);
}

function isGatewayState(value: unknown): value is GatewayState {
  return (
    typeof value === "object" &&
    value !== null &&
    "seats" in value &&
    "feed" in value &&
    "onceKeys" in value &&
    "delivered" in value
  );
}

/** The state after a JSON round trip, as a log reader or another process would see it. */
export function viaJson(gw: GatewayState): GatewayState {
  const parsed: unknown = JSON.parse(JSON.stringify(gw));
  if (!isGatewayState(parsed)) throw new Error("not a gateway state");
  return parsed;
}

export interface WakeLog {
  seat: PlayerId;
  t: GameTime;
  rec: WakeRecord;
}

/**
 * A minimal host: delivers events, wakes due seats at their wake time (each wake line recorded),
 * and closes turns. With `autoClose`, every turn ends at once with `end_turn {}` (lockstep-like).
 */
export class Driver {
  readonly gw: GatewayState;
  readonly wake: WakeScheduler;
  now: GameTime = 0;
  readonly wakes: WakeLog[] = [];
  autoClose: boolean;

  constructor(
    rules: GatewayRules = RULES,
    players: readonly PlayerId[] = [P1, P2, P3],
    autoClose = true,
  ) {
    this.gw = createGatewayState(players);
    this.wake = createWakeScheduler(this.gw, rules);
    this.autoClose = autoClose;
  }

  /** Delivers at `ev.t` (time moves there first, waking seats due before it), then wakes seats due now. */
  deliver(...events: DomainEvent[]): void {
    for (const ev of events) {
      this.advance(ev.t);
      deliver(this.gw, [ev], this.wake);
      this.settle();
    }
  }

  /** Opens a turn for every seat due at `now`, until none is due. */
  settle(): void {
    for (let guard = 0; ; guard += 1) {
      if (guard > 50) throw new Error(`settle at ${this.now} does not converge`);
      const due = this.wake.due(this.now);
      if (due.length === 0) return;
      for (const seat of due) {
        const rec = this.wake.begin(seat, this.now);
        briefed(this.gw, seat, this.now);
        this.wakes.push({ seat, t: this.now, rec });
        if (this.autoClose) this.close(seat);
      }
    }
  }

  /** Moves time to `to`, waking every seat at its wake time on the way. */
  advance(to: GameTime): void {
    for (let guard = 0; ; guard += 1) {
      if (guard > 10000) throw new Error(`advance to ${to} does not converge`);
      const next = this.wake.nextWakeTime();
      if (next === null || next > to) break;
      this.now = Math.max(this.now, next);
      this.settle();
    }
    this.now = Math.max(this.now, to);
  }

  /** Ends `seat`'s turn at `now`; `selfIn` requests a self-wake that many seconds ahead. */
  close(seat: PlayerId, selfIn?: number): void {
    if (selfIn !== undefined) this.wake.requestSelfWake(seat, this.now + selfIn, this.now);
    closeTurn(this.gw, this.wake, {
      t: this.now,
      seat,
      why: "end_turn",
      rounds: 1,
      selfAt: seatOf(this.gw, seat).wake.selfAt,
    });
  }

  wakesOf(seat: PlayerId): WakeLog[] {
    return this.wakes.filter((w) => w.seat === seat);
  }

  lastWake(seat: PlayerId): WakeLog {
    const list = this.wakesOf(seat);
    const last = list.at(-1);
    if (last === undefined) throw new Error(`${seat} never woke`);
    return last;
  }
}
