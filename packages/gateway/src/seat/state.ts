import { DAY } from "@perfidia/engine/core";
import { compareIds, type GameTime, type PlayerId } from "@perfidia/protocol";
import type { DayCounters, Delivered, GatewayState, SeatState, SeatWake } from "./types.ts";

// Creation of the gateway state, lookups, per-day counters and the briefing cursor (§8.4).

/** Game day of `t`: the per-day counters are keyed by `floor(t / 86400)`. */
export function dayOf(t: GameTime): number {
  return Math.floor(t / DAY);
}

export function initialSeatWake(): SeatWake {
  return {
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
  };
}

function initialSeat(seat: PlayerId): SeatState {
  return {
    seat,
    alive: true,
    notes: "",
    inbox: [],
    archive: [],
    lastBriefingAt: 0,
    lastBriefingE: 0,
    wake: initialSeatWake(),
    day: { index: 0, ownWakes: 0, socialWakes: 0, attacks: 0, messages: 0 },
    turns: 0,
    lastTurn: null,
    turnFailures: [],
    turnWarnings: [],
  };
}

/** A fresh gateway state: every seat alive, idle, with its start wake pending at t = 0. */
export function createGatewayState(players: readonly PlayerId[]): GatewayState {
  const sorted = players.toSorted(compareIds);
  for (const [i, p] of sorted.entries()) {
    if (i > 0 && sorted[i - 1] === p) {
      throw new Error(`createGatewayState: seat ${p} is listed twice`);
    }
  }
  const seats: Record<PlayerId, SeatState> = Object.fromEntries(
    sorted.map((p) => [p, initialSeat(p)]),
  );
  return { seats, feed: [], onceKeys: {}, delivered: 0 };
}

/** Whether `p` is a seat of this match. */
export function isSeat(gw: GatewayState, p: string): p is PlayerId {
  return Object.hasOwn(gw.seats, p);
}

/** The seat's state; throws on an unknown seat (a host bug, never player input). */
export function seatOf(gw: GatewayState, seat: PlayerId): SeatState {
  const s = Object.hasOwn(gw.seats, seat) ? gw.seats[seat] : undefined;
  if (s === undefined) throw new Error(`unknown seat ${seat}`);
  return s;
}

/** Every seat, sorted by player number. */
export function sortedSeats(gw: GatewayState): SeatState[] {
  return Object.values(gw.seats).toSorted((a, b) => compareIds(a.seat, b.seat));
}

/** Moves the counters to the day of `t` when it is a later day (counters restart from zero). */
export function rollDay(s: SeatState, t: GameTime): DayCounters {
  const index = dayOf(t);
  if (index > s.day.index) {
    s.day = { index, ownWakes: 0, socialWakes: 0, attacks: 0, messages: 0 };
  }
  return s.day;
}

/** The counters of the day of `t`, as a fresh object (zeros for a day that has not started counting). */
export function todayCounters(s: SeatState, t: GameTime): DayCounters {
  const index = dayOf(t);
  if (index === s.day.index) return { ...s.day };
  return { index, ownWakes: 0, socialWakes: 0, attacks: 0, messages: 0 };
}

/**
 * Called once the briefing of a wake is built: the inbox is emptied and the news cursor moves to
 * the last delivered event. The host builds the briefing between `begin` and this call; the
 * rebuild calls it right after `begin` for each `wake` line. An addition to the `wake` fold of
 * §10.5, which names `begin` alone.
 */
export function briefed(gw: GatewayState, seat: PlayerId, t: GameTime): void {
  const s = seatOf(gw, seat);
  s.inbox = [];
  s.lastBriefingAt = t;
  s.lastBriefingE = gw.delivered;
}

/** Whether the delivered event is addressed to `seat`. */
export function addressedTo(d: Delivered, seat: PlayerId): boolean {
  return d.event.to.some((r) => r.p === seat);
}

/**
 * Public events delivered since the seat's last briefing, oldest first, except those addressed to
 * the seat, which its inbox already holds. A deviation from §8.4 ("feed after lastBriefingAt"): the
 * cursor is the delivery number `lastBriefingE`, and the addressed events are left out.
 */
export function unreadNews(gw: GatewayState, seat: PlayerId): Delivered[] {
  const s = seatOf(gw, seat);
  return gw.feed.filter((d) => d.e > s.lastBriefingE && !addressedTo(d, seat));
}
