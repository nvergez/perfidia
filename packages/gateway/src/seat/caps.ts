import { DAY } from "@perfidia/engine/core";
import type { GameTime, GatewayRules, ToolError } from "@perfidia/protocol";
import { seatError } from "./errors.ts";
import { dayOf, todayCounters } from "./state.ts";
import type { SeatState } from "./types.ts";

// Interface caps (layer 1 and layer 4 of §7.2, numbers of §8.4): round trips, calls per round
// and per wake, attack launches and messages per game day. Each check returns `null` when the call
// may run, or the `ToolError` to return, with its numbers in `message`, `hint` and `details` (the
// wording is `seatErrorText`'s, a function of the details that a `gw` line keeps).

/** Daily counters with a cap: engine-accepted attack launches and `send_message` calls. */
export type DailyCapKind = "attacks" | "messages";

/** The cap of `kind` per game day. */
export function dailyCap(rules: GatewayRules, kind: DailyCapKind): number {
  return kind === "attacks" ? rules.attackLaunchesPerDay : rules.messagesPerDay;
}

/** How many of `kind` the seat used on the game day of `t`. */
export function dailyUsed(s: SeatState, kind: DailyCapKind, t: GameTime): number {
  return todayCounters(s, t)[kind];
}

/** `DAILY_CAP` when the seat already used its `kind` allowance on the game day of `t`. */
export function checkDailyCap(
  s: SeatState,
  rules: GatewayRules,
  kind: DailyCapKind,
  t: GameTime,
): ToolError | null {
  const cap = dailyCap(rules, kind);
  const used = dailyUsed(s, kind, t);
  if (used < cap) return null;
  return seatError("DAILY_CAP", { kind, cap, used, availableAt: (dayOf(t) + 1) * DAY }, t);
}

/** `ROUND_TRIP_CAP` for a call in round `round` (0-based) beyond `roundTripsPerWake`. */
export function checkRoundTrip(rules: GatewayRules, round: number, t: GameTime): ToolError | null {
  const cap = rules.roundTripsPerWake;
  if (round < cap) return null;
  return seatError("ROUND_TRIP_CAP", { cap, round: round + 1 }, t);
}

/** Calls the current round may still run, given the calls already run in this wake. */
export function roundCallCap(rules: GatewayRules, wakeCallsUsed: number): number {
  const perRound = rules.toolCallsPerRoundTrip;
  if (rules.toolCallsPerWake === null) return perRound;
  return Math.max(0, Math.min(perRound, rules.toolCallsPerWake - wakeCallsUsed));
}

/**
 * `CALLS_CAP` for a call when `used.round` calls of this round, or `used.wake` calls of this
 * wake, already ran: a round runs its first `toolCallsPerRoundTrip` calls and stops at
 * `toolCallsPerWake` if set (§8.3).
 */
export function checkCallCap(
  rules: GatewayRules,
  used: { round: number; wake: number },
  t: GameTime,
): ToolError | null {
  const perRound = rules.toolCallsPerRoundTrip;
  if (used.round >= perRound) {
    return seatError("CALLS_CAP", { scope: "round", cap: perRound, used: used.round }, t);
  }
  const perWake = rules.toolCallsPerWake;
  if (perWake !== null && used.wake >= perWake) {
    return seatError("CALLS_CAP", { scope: "wake", cap: perWake, used: used.wake }, t);
  }
  return null;
}

/** The numbers of the briefing's `budget` (§8.2), before times become pairs. */
export interface SeatBudget {
  roundTrips: number;
  callsPerRoundTrip: number;
  callsPerWake: number | null;
  ownWakesLeft: number;
  socialWakesLeft: number;
  selfWakeAt: GameTime | null;
  attacksLeft: number;
  messagesLeft: number;
}

/** The seat's budget at `t`: interface caps and what is left of today's allowances. */
export function seatBudget(s: SeatState, rules: GatewayRules, t: GameTime): SeatBudget {
  const today = todayCounters(s, t);
  return {
    roundTrips: rules.roundTripsPerWake,
    callsPerRoundTrip: rules.toolCallsPerRoundTrip,
    callsPerWake: rules.toolCallsPerWake,
    ownWakesLeft: Math.max(0, rules.ownWakesPerDay - today.ownWakes),
    socialWakesLeft: Math.max(0, rules.socialWakesPerDay - today.socialWakes),
    selfWakeAt: s.wake.selfAt,
    attacksLeft: Math.max(0, rules.attackLaunchesPerDay - today.attacks),
    messagesLeft: Math.max(0, rules.messagesPerDay - today.messages),
  };
}
