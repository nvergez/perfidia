import { clamp, DAY } from "@perfidia/engine/core";
import type {
  DomainEvent,
  GameTime,
  GatewayRules,
  PlayerId,
  WakeClass,
  WakeReason,
  WakeRole,
} from "@perfidia/protocol";
import { dayOf, rollDay, seatOf, sortedSeats } from "./state.ts";
import type { GatewayState, NextWake, SeatState, WakeRecord, WakeScheduler } from "./types.ts";

// The wake scheduler of docs/architecture.md §8.5, pure. Its state lives in `SeatState.wake` and
// `SeatState.day`, so a scheduler is only a view over a `GatewayState` and its rules.
//
// The wake time of an idle seat is the minimum of:
// - start: 0 before the first turn (exempt);
// - urgent: max(urgentAt, lastUrgentStart + urgentMinGap) (exempt);
// - own: min(ownFirst + groupWindow, selfAt), at least lastEnd + 1, moved to the start of the next
//   game day while that day's own allowance is used up;
// - social: socialFirst + groupWindow, at least lastEnd + 1, moved likewise for the social allowance;
// - safety: lastEnd + safetyWake, at least lastEnd + 1 (exempt);
// and never before `deferTo`.
//
// A wake drains every pending own and social reason, the self-wake if its time has come, and the
// urgent reasons only once their gap has passed: an urgent trigger inside the gap stays pending
// and fires at the end of the gap, so a wake is exempt as urgent at most once per urgentMinGap and
// a budget-charged wake never rides on an urgent reason it did not wait for. This is a deviation
// from the letter of the §8.5 `begin` bullet ("drains every pending reason") and of perfidia-1
// §14.2 ("delivers every pending trigger"), made to keep their gap rule ("at most one urgent wake
// starts per 600 s") and the P11 urgent-timing bullet, which the literal drain would break. The
// briefing still lists every incoming attack (§8.2), so a non-urgent wake inside the gap does not
// hide one.
//
// Public messages never wake (§8.5, perfidia-1 §11.1), whatever their audience or the wake table:
// `message` is a standard event type, so the check stays ruleset-agnostic.

const KIND_ORDER: readonly NextWake["kind"][] = [
  "start",
  "urgent",
  "self",
  "own",
  "social",
  "safety",
];

/** The class of a trigger for `role`, or `null` when the event does not wake that role. */
export function wakeClassOf(rules: GatewayRules, type: string, role: WakeRole): WakeClass | null {
  if (!Object.hasOwn(rules.wake, type)) return null;
  const entry = rules.wake[type];
  if (entry === undefined || !Object.hasOwn(entry, role)) return null;
  return entry[role] ?? null;
}

/** A public message (`send_message` to `"all"`): it goes to the feed and never wakes anyone. */
export function isPublicMessage(ev: DomainEvent): boolean {
  return ev.type === "message" && (ev.public || ev.data.to === "all");
}

/** Data fields naming what an event concerns, in the order the wake reason picks the first. */
const REASON_KEYS = [
  "movement",
  "message",
  "proposal",
  "report",
  "by",
  "player",
  "city",
  "alliance",
  "key",
] as const;

/** One printable ASCII token, so a reason stays `type id`. */
const TOKEN = /^[!-~]{1,64}$/;

/** `incoming_attack m0k4qz`: the event type and the id it concerns, or the type alone. */
export function wakeReasonOf(ev: DomainEvent): WakeReason {
  for (const key of REASON_KEYS) {
    const value = Object.hasOwn(ev.data, key) ? ev.data[key] : undefined;
    if (typeof value === "string" && TOKEN.test(value)) return `${ev.type} ${value}`;
    if (typeof value === "number" && Number.isSafeInteger(value)) return `${ev.type} ${value}`;
  }
  return ev.type;
}

function pushUnique(list: WakeReason[], reason: WakeReason): void {
  if (!list.includes(reason)) list.push(reason);
}

const earliest = (a: GameTime | null, b: GameTime): GameTime => (a === null ? b : Math.min(a, b));

export function createWakeScheduler(gw: GatewayState, rules: GatewayRules): WakeScheduler {
  /** Moves `at` past every game day whose allowance is used up; `null` when the budget is 0. */
  const budgetMove = (s: SeatState, at: GameTime, charge: "own" | "social"): GameTime | null => {
    const cap = charge === "own" ? rules.ownWakesPerDay : rules.socialWakesPerDay;
    if (cap <= 0) return null;
    const used = (day: number): number =>
      day !== s.day.index ? 0 : charge === "own" ? s.day.ownWakes : s.day.socialWakes;
    let day = dayOf(at);
    if (used(day) < cap) return at;
    while (used(day) >= cap) day += 1;
    return day * DAY;
  };

  const urgentTime = (s: SeatState): GameTime | null => {
    const w = s.wake;
    if (w.urgentAt === null) return null;
    return w.lastUrgentStart === null
      ? w.urgentAt
      : Math.max(w.urgentAt, w.lastUrgentStart + rules.urgentMinGap);
  };

  const ownTime = (s: SeatState): { at: GameTime; kind: "self" | "own" } | null => {
    const w = s.wake;
    let at: GameTime | null = null;
    let kind: "self" | "own" = "self";
    if (w.selfAt !== null) at = w.selfAt;
    if (w.ownFirst !== null) {
      const grouped = w.ownFirst + rules.groupWindow;
      if (at === null || grouped < at) {
        at = grouped;
        kind = "own";
      }
    }
    if (at === null) return null;
    const moved = budgetMove(s, Math.max(at, w.lastEnd + 1), "own");
    return moved === null ? null : { at: moved, kind };
  };

  const socialTime = (s: SeatState): GameTime | null => {
    const w = s.wake;
    if (w.socialFirst === null) return null;
    return budgetMove(s, Math.max(w.socialFirst + rules.groupWindow, w.lastEnd + 1), "social");
  };

  const safetyTime = (s: SeatState): GameTime =>
    Math.max(s.wake.lastEnd + rules.safetyWake, s.wake.lastEnd + 1);

  const nextOf = (s: SeatState): NextWake | null => {
    if (!s.alive || s.wake.inTurn) return null;
    const candidates: NextWake[] = [];
    if (s.turns === 0) candidates.push({ at: 0, kind: "start" });
    const urgent = urgentTime(s);
    if (urgent !== null) candidates.push({ at: urgent, kind: "urgent" });
    const own = ownTime(s);
    if (own !== null) candidates.push(own);
    const social = socialTime(s);
    if (social !== null) candidates.push({ at: social, kind: "social" });
    candidates.push({ at: safetyTime(s), kind: "safety" });
    let best = candidates[0]!;
    for (const c of candidates) {
      if (
        c.at < best.at ||
        (c.at === best.at && KIND_ORDER.indexOf(c.kind) < KIND_ORDER.indexOf(best.kind))
      ) {
        best = c;
      }
    }
    const deferTo = s.wake.deferTo;
    return deferTo !== null && best.at < deferTo ? { at: deferTo, kind: best.kind } : { ...best };
  };

  const ingest = (seat: PlayerId, ev: DomainEvent, role: WakeRole): void => {
    if (isPublicMessage(ev)) return;
    const cls = wakeClassOf(rules, ev.type, role);
    if (cls === null) return;
    const s = seatOf(gw, seat);
    if (!s.alive) return;
    const w = s.wake;
    const reason = wakeReasonOf(ev);
    switch (cls) {
      case "urgent":
        w.urgentAt = earliest(w.urgentAt, ev.t);
        pushUnique(w.urgentReasons, reason);
        break;
      case "own":
        w.ownFirst = earliest(w.ownFirst, ev.t);
        pushUnique(w.reasons, reason);
        break;
      case "social":
        w.socialFirst = earliest(w.socialFirst, ev.t);
        pushUnique(w.reasons, reason);
        break;
    }
  };

  const requestSelfWake = (
    seat: PlayerId,
    at: GameTime,
    now: GameTime,
  ): { at: GameTime; clamped: boolean } => {
    const s = seatOf(gw, seat);
    const lo = now + rules.selfWake.min;
    const hi = now + rules.selfWake.max;
    // `now + nextWakeIn` may leave the safe-integer range for absurd delays: that is "too late".
    const value = Number.isSafeInteger(at) ? clamp(at, lo, hi) : at > hi ? hi : lo;
    s.wake.selfAt = value;
    return { at: value, clamped: value !== at };
  };

  const nextWakeTime = (): GameTime | null => {
    let min: GameTime | null = null;
    for (const s of sortedSeats(gw)) {
      const next = nextOf(s);
      if (next !== null && (min === null || next.at < min)) min = next.at;
    }
    return min;
  };

  const due = (t: GameTime): PlayerId[] =>
    sortedSeats(gw)
      .filter((s) => {
        const next = nextOf(s);
        return next !== null && next.at <= t;
      })
      .map((s) => s.seat);

  const peek = (seat: PlayerId): NextWake | null => nextOf(seatOf(gw, seat));

  const begin = (seat: PlayerId, t: GameTime): WakeRecord => {
    const s = seatOf(gw, seat);
    if (!s.alive) throw new Error(`wake.begin: ${seat} is eliminated`);
    if (s.wake.inTurn) throw new Error(`wake.begin: ${seat} is already in a turn`);
    const next = nextOf(s);
    if (next === null || next.at > t) {
      throw new Error(`wake.begin: ${seat} is not due at ${t} (next wake ${next?.at ?? "none"})`);
    }
    const w = s.wake;
    const start = s.turns === 0;
    const urgentAt = urgentTime(s);
    const urgent = urgentAt !== null && urgentAt <= t;
    const own = ownTime(s);
    const ownDue = own !== null && own.at <= t;
    const social = socialTime(s);
    const socialDue = social !== null && social <= t;
    const safetyDue = safetyTime(s) <= t;
    const selfDue = w.selfAt !== null && w.selfAt <= t;

    const reasons: WakeReason[] = [];
    if (start) pushUnique(reasons, "start");
    if (urgent) for (const r of w.urgentReasons) pushUnique(reasons, r);
    for (const r of w.reasons) pushUnique(reasons, r);
    if (selfDue) pushUnique(reasons, "self");
    if (safetyDue) pushUnique(reasons, "safety");

    let charge: WakeRecord["charge"];
    if (start || urgent || safetyDue) charge = null;
    else if (ownDue) charge = "own";
    else if (socialDue) charge = "social";
    else throw new Error(`wake.begin: ${seat} is due at ${t} without a due reason`);

    if (urgent) {
      w.urgentAt = null;
      w.urgentReasons = [];
      w.lastUrgentStart = t;
    }
    w.ownFirst = null;
    w.socialFirst = null;
    w.reasons = [];
    if (selfDue) w.selfAt = null;
    w.deferTo = null;
    w.inTurn = true;

    const day = rollDay(s, t);
    if (charge === "own") day.ownWakes += 1;
    else if (charge === "social") day.socialWakes += 1;
    s.turns += 1;
    s.turnFailures = [];
    s.turnWarnings = [];
    return {
      reasons,
      urgent,
      charge,
      day: day.index,
      used: { own: day.ownWakes, social: day.socialWakes },
    };
  };

  const end = (seat: PlayerId, t: GameTime): void => {
    const s = seatOf(gw, seat);
    if (!s.wake.inTurn) throw new Error(`wake.end: ${seat} is not in a turn`);
    s.wake.inTurn = false;
    s.wake.lastEnd = t;
  };

  const defer = (seat: PlayerId, to: GameTime): void => {
    const w = seatOf(gw, seat).wake;
    w.deferTo = w.deferTo === null ? to : Math.max(w.deferTo, to);
  };

  const eliminate = (seat: PlayerId): void => {
    const s = seatOf(gw, seat);
    s.alive = false;
    const w = s.wake;
    w.urgentAt = null;
    w.urgentReasons = [];
    w.ownFirst = null;
    w.socialFirst = null;
    w.selfAt = null;
    w.reasons = [];
    w.deferTo = null;
  };

  return Object.freeze({
    rules,
    ingest,
    requestSelfWake,
    nextWakeTime,
    due,
    peek,
    begin,
    end,
    defer,
    eliminate,
  });
}
