// P11 (docs/architecture.md §8.5, §13.2): a model test of the wake scheduler with `fc.commands`.
//
// The model keeps its own bookkeeping of every seat (pending triggers by class and origin,
// self-wake, last turn end, budgets charged per game day, urgent wakes per day) and its own formula
// for the wake time. After every command the scheduler must agree with it exactly (wake time, kind,
// due seats, every wake record). Since that formula mirrors the scheduler's, every real wake record
// is also checked on its own, against the triggers the commands produced (their time, class and
// origin), without the formula (`checkRecord`), and so is the real state after another seat's
// action. The trace must satisfy the properties of §8.5:
// - per seat and game day, at most ownWakesPerDay own-charged and socialWakesPerDay social-charged wakes;
// - an own-charged wake always has the seat's due self-wake, or a due own-class trigger caused by
//   the seat itself; another seat's action never touches the seat's own triggers or self-wake, so
//   no sequence of other seats' actions produces an own-charged wake;
// - no alive seat goes more than safetyWake without a wake;
// - an urgent trigger never wakes the seat before max(its time, lastUrgentStart + urgentMinGap),
//   and never later than the first moment after that when the seat is idle;
// - at most ceil(86400 / urgentMinGap) + 1 urgent wakes per seat per game day;
// - own and social wakes never fire before their group window (or self-wake) is due, and every
//   wake drains all pending triggers of those classes, so the triggers of one class first pending
//   inside one group window are delivered by a single wake; urgent triggers are delivered all
//   together by an urgent wake, and never by another one;
// - after a turn ending at t, the next wake is > t unless an urgent trigger is pending and due;
// - a turn ended without a self-wake request (`end_turn {}`, an empty round, the round cap) leaves
//   a pending selfAt unchanged.
// The commands include ending a turn with no request, triggers from other seats and from the seat
// itself, public events (with publicOncePerDay), eliminations, lockstep deferrals (a per-second turn
// cap of 3) and JSON round trips of the whole gateway state.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { DomainEvent, GatewayRules, PlayerId } from "@perfidia/protocol";
import { deliver } from "./deliver.ts";
import { briefed, createGatewayState, seatOf } from "./state.ts";
import { event, oid, RULES, viaJson } from "./testkit.test.ts";
import { closeTurn } from "./turn.ts";
import type { GatewayState, NextWakeKind, WakeRecord, WakeScheduler } from "./types.ts";
import { createWakeScheduler } from "./wake.ts";

const DAY = 86400;
const SEATS: readonly PlayerId[] = ["p1", "p2", "p3"];
const MAX_TURNS_PER_SECOND = 3;
const KIND_ORDER: readonly NextWakeKind[] = ["start", "urgent", "self", "own", "social", "safety"];

/** Who caused a trigger: the seat itself, or another seat (or the match, for public events). */
type Origin = "own" | "other";

interface PendingTrigger {
  t: number;
  reason: string;
  cls: "own" | "social";
  origin: Origin;
}

interface ModelSeat {
  id: PlayerId;
  alive: boolean;
  inTurn: boolean;
  turns: number;
  lastEnd: number;
  urgent: { t: number; reason: string }[];
  normal: PendingTrigger[];
  selfAt: number | null;
  lastUrgentStart: number | null;
  deferTo: number | null;
  turnsAt: { t: number; n: number };
}

/** How often the runs reached each interesting path (asserted after the property). */
interface Stats {
  defers: number;
  urgent: number;
  own: number;
  social: number;
  safety: number;
  self: number;
  moved: number;
  clamped: number;
  eliminated: number;
  roundTrips: number;
  keptSelf: number;
  /** Windows of two or more triggers of one class delivered by one wake. */
  grouped: number;
  /** Urgent wakes delivering two or more urgent triggers. */
  urgentJoined: number;
  /** Battle reports caused by another seat (target or party role) delivered. */
  battleOther: number;
  /** Own-charged wakes carried by an own trigger rather than the self-wake. */
  ownByTrigger: number;
}

interface Model {
  stats: Stats;
  rules: GatewayRules;
  now: number;
  seats: ModelSeat[];
  nextId: number;
  /** `${seat}:${day}:${charge}` → wakes charged. */
  charged: Record<string, number>;
  /** `${seat}:${day}` → urgent wakes. */
  urgentWakes: Record<string, number>;
  onceKeys: string[];
}

interface Real {
  gw: GatewayState;
  wake: WakeScheduler;
}

const seatIndex = (id: PlayerId): number => SEATS.indexOf(id);

function modelSeat(m: Model, id: PlayerId): ModelSeat {
  const s = m.seats[seatIndex(id)];
  if (s === undefined) throw new Error(`no model seat ${id}`);
  return s;
}

function used(m: Model, id: PlayerId, day: number, charge: "own" | "social"): number {
  return m.charged[`${id}:${day}:${charge}`] ?? 0;
}

function moved(m: Model, s: ModelSeat, at: number, charge: "own" | "social"): number | null {
  const cap = charge === "own" ? m.rules.ownWakesPerDay : m.rules.socialWakesPerDay;
  if (cap === 0) return null;
  let day = Math.floor(at / DAY);
  if (used(m, s.id, day, charge) < cap) return at;
  while (used(m, s.id, day, charge) >= cap) day += 1;
  m.stats.moved += 1;
  return day * DAY;
}

const minTime = (list: readonly { t: number }[]): number | null =>
  list.length === 0 ? null : Math.min(...list.map((x) => x.t));

interface Times {
  start: number | null;
  urgent: number | null;
  own: { at: number; kind: "self" | "own" } | null;
  social: number | null;
  safety: number;
}

function times(m: Model, s: ModelSeat): Times {
  const r = m.rules;
  const firstUrgent = minTime(s.urgent);
  const urgent =
    firstUrgent === null
      ? null
      : Math.max(firstUrgent, s.lastUrgentStart === null ? 0 : s.lastUrgentStart + r.urgentMinGap);
  const firstOwn = minTime(s.normal.filter((x) => x.cls === "own"));
  let own: Times["own"] = null;
  const grouped = firstOwn === null ? null : firstOwn + r.groupWindow;
  const raw =
    s.selfAt !== null && (grouped === null || s.selfAt <= grouped)
      ? { at: s.selfAt, kind: "self" as const }
      : grouped !== null
        ? { at: grouped, kind: "own" as const }
        : null;
  if (raw !== null) {
    const at = moved(m, s, Math.max(raw.at, s.lastEnd + 1), "own");
    own = at === null ? null : { at, kind: raw.kind };
  }
  const firstSocial = minTime(s.normal.filter((x) => x.cls === "social"));
  const social =
    firstSocial === null
      ? null
      : moved(m, s, Math.max(firstSocial + r.groupWindow, s.lastEnd + 1), "social");
  return {
    start: s.turns === 0 ? 0 : null,
    urgent,
    own,
    social,
    safety: Math.max(s.lastEnd + r.safetyWake, s.lastEnd + 1),
  };
}

function wakeOf(m: Model, s: ModelSeat): { at: number; kind: NextWakeKind } | null {
  if (!s.alive || s.inTurn) return null;
  const x = times(m, s);
  const candidates: { at: number; kind: NextWakeKind }[] = [];
  if (x.start !== null) candidates.push({ at: x.start, kind: "start" });
  if (x.urgent !== null) candidates.push({ at: x.urgent, kind: "urgent" });
  if (x.own !== null) candidates.push(x.own);
  if (x.social !== null) candidates.push({ at: x.social, kind: "social" });
  candidates.push({ at: x.safety, kind: "safety" });
  const best = candidates.toSorted(
    (a, b) => a.at - b.at || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  )[0]!;
  return s.deferTo !== null && best.at < s.deferTo ? { at: s.deferTo, kind: best.kind } : best;
}

/** The model's wake record for `s` at `t`, after checking the trace properties; mutates the model. */
function modelBegin(m: Model, s: ModelSeat, t: number): WakeRecord {
  const r = m.rules;
  const x = times(m, s);
  const start = s.turns === 0;
  const urgent = x.urgent !== null && x.urgent <= t;
  const ownDue = x.own !== null && x.own.at <= t;
  const socialDue = x.social !== null && x.social <= t;
  const safetyDue = x.safety <= t;
  const selfDue = s.selfAt !== null && s.selfAt <= t;

  const reasons: string[] = [];
  const add = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (start) add("start");
  if (urgent) for (const u of s.urgent) add(u.reason);
  for (const n of s.normal) add(n.reason);
  if (selfDue) add("self");
  if (safetyDue) add("safety");
  const charge = start || urgent || safetyDue ? null : ownDue ? "own" : socialDue ? "social" : null;
  expect(start || urgent || safetyDue || ownDue || socialDue).toBe(true);

  // Never early, never beyond the safety bound.
  if (urgent) {
    expect(t).toBeGreaterThanOrEqual(minTime(s.urgent)!);
    if (s.lastUrgentStart !== null) {
      expect(t).toBeGreaterThanOrEqual(s.lastUrgentStart + r.urgentMinGap);
    }
  }
  if (charge === "own") {
    const firstOwn = minTime(s.normal.filter((n) => n.cls === "own"));
    expect(selfDue || (firstOwn !== null && firstOwn + r.groupWindow <= t)).toBe(true);
  }
  if (charge === "social") {
    const firstSocial = minTime(s.normal.filter((n) => n.cls === "social"));
    expect(firstSocial !== null && firstSocial + r.groupWindow <= t).toBe(true);
  }
  if (s.turns > 0) {
    expect(t).toBeLessThanOrEqual(Math.max(s.lastEnd + Math.max(r.safetyWake, 1), s.deferTo ?? 0));
  }

  if (urgent) {
    s.urgent = [];
    s.lastUrgentStart = t;
    m.stats.urgent += 1;
  }
  if (charge === "own") m.stats.own += 1;
  if (charge === "social") m.stats.social += 1;
  if (safetyDue) m.stats.safety += 1;
  if (selfDue) m.stats.self += 1;
  s.normal = [];
  if (selfDue) s.selfAt = null;
  s.deferTo = null;
  s.inTurn = true;
  s.turns += 1;
  s.turnsAt = s.turnsAt.t === t ? { t, n: s.turnsAt.n + 1 } : { t, n: 1 };
  const day = Math.floor(t / DAY);
  if (charge !== null) {
    const key = `${s.id}:${day}:${charge}`;
    m.charged[key] = (m.charged[key] ?? 0) + 1;
    const cap = charge === "own" ? r.ownWakesPerDay : r.socialWakesPerDay;
    expect(m.charged[key]).toBeLessThanOrEqual(cap);
  }
  if (urgent) {
    const key = `${s.id}:${day}`;
    m.urgentWakes[key] = (m.urgentWakes[key] ?? 0) + 1;
    if (r.urgentMinGap > 0) {
      expect(m.urgentWakes[key]).toBeLessThanOrEqual(Math.ceil(DAY / r.urgentMinGap) + 1);
    }
  }
  return {
    reasons,
    urgent,
    charge,
    day,
    used: { own: used(m, s.id, day, "own"), social: used(m, s.id, day, "social") },
  };
}

interface Pending {
  urgent: { t: number; reason: string }[];
  normal: PendingTrigger[];
  selfAt: number | null;
  lastUrgentStart: number | null;
}

function snapshot(s: ModelSeat): Pending {
  return {
    urgent: s.urgent.map((u) => ({ ...u })),
    normal: s.normal.map((n) => ({ ...n })),
    selfAt: s.selfAt,
    lastUrgentStart: s.lastUrgentStart,
  };
}

/**
 * Checks a real wake record against the triggers pending before it, without the model's formula:
 * which triggers it delivers, when it may fire, and what it may be charged to.
 */
function checkRecord(m: Model, t: number, got: WakeRecord, pending: Pending): void {
  const r = m.rules;
  const delivered = (reason: string): boolean => got.reasons.includes(reason);
  const selfDue = pending.selfAt !== null && pending.selfAt <= t;
  expect(delivered("self")).toBe(selfDue);

  // Every pending own and social trigger is delivered: the triggers of one class first pending
  // inside one group window are delivered by this single wake, and if the wake is charged to that
  // class, it waited for the whole window.
  for (const cls of ["own", "social"] as const) {
    const inClass = pending.normal.filter((n) => n.cls === cls);
    if (inClass.length === 0) continue;
    const first = Math.min(...inClass.map((n) => n.t));
    const window = inClass.filter((n) => n.t < first + r.groupWindow);
    for (const n of inClass)
      expect({ reason: n.reason, delivered: delivered(n.reason) }).toEqual({
        reason: n.reason,
        delivered: true,
      });
    if (window.length > 1) m.stats.grouped += 1;
    if (got.charge === cls && !(cls === "own" && selfDue)) {
      expect(t).toBeGreaterThanOrEqual(first + r.groupWindow);
    }
  }
  if (pending.normal.some((n) => n.origin === "other" && n.reason.startsWith("battle_report "))) {
    m.stats.battleOther += 1;
  }

  // An own-charged wake comes from the seat's own activity: its due self-wake, or a due own-class
  // trigger that the seat caused. Own-class triggers are never caused by another seat.
  expect(pending.normal.filter((n) => n.cls === "own" && n.origin !== "own")).toEqual([]);
  if (got.charge === "own") {
    const own = pending.normal.filter((n) => n.cls === "own" && n.origin === "own");
    const ownDue = own.length > 0 && Math.min(...own.map((n) => n.t)) + r.groupWindow <= t;
    expect(selfDue || ownDue).toBe(true);
    if (!selfDue) m.stats.ownByTrigger += 1;
  }

  // Urgent triggers are delivered all together by an urgent wake, never by another wake, and
  // never before their time or the end of the urgent gap.
  for (const u of pending.urgent) expect(delivered(u.reason)).toBe(got.urgent);
  if (got.urgent) {
    expect(pending.urgent.length).toBeGreaterThan(0);
    expect(t).toBeGreaterThanOrEqual(Math.min(...pending.urgent.map((u) => u.t)));
    if (pending.lastUrgentStart !== null) {
      expect(t).toBeGreaterThanOrEqual(pending.lastUrgentStart + r.urgentMinGap);
    }
    expect(got.charge).toBeNull();
    if (pending.urgent.length > 1) m.stats.urgentJoined += 1;
  }

  // Nothing else is delivered: every reason is a pending trigger or a due start, self or safety.
  const known = new Set([
    ...pending.normal.map((n) => n.reason),
    ...pending.urgent.map((u) => u.reason),
    "start",
    "self",
    "safety",
  ]);
  for (const reason of got.reasons) expect(known.has(reason)).toBe(true);
}

/** Opens a turn for every due seat (deferring those over the per-second cap), comparing each record. */
function settle(m: Model, r: Real): void {
  for (let guard = 0; ; guard += 1) {
    if (guard > 50) throw new Error(`settle at ${m.now} does not converge`);
    const due = r.wake.due(m.now);
    const expected = m.seats
      .filter((s) => {
        const w = wakeOf(m, s);
        return w !== null && w.at <= m.now;
      })
      .map((s) => s.id);
    expect(due).toEqual(expected);
    if (due.length === 0) return;
    for (const id of due) {
      const s = modelSeat(m, id);
      if (s.turnsAt.t === m.now && s.turnsAt.n >= MAX_TURNS_PER_SECOND) {
        r.wake.defer(id, m.now + 1);
        s.deferTo = Math.max(s.deferTo ?? 0, m.now + 1);
        m.stats.defers += 1;
        continue;
      }
      const pending = snapshot(s);
      const want = modelBegin(m, s, m.now);
      const got = r.wake.begin(id, m.now);
      briefed(r.gw, id, m.now);
      checkRecord(m, m.now, got, pending);
      expect(got).toEqual(want);
    }
  }
}

/** The scheduler agrees with the model on every seat, and no idle seat is overdue. */
function checkAll(m: Model, r: Real): void {
  let min: number | null = null;
  for (const s of m.seats) {
    const want = wakeOf(m, s);
    expect(r.wake.peek(s.id)).toEqual(want);
    if (want !== null) {
      expect(want.at).toBeGreaterThan(m.now);
      if (min === null || want.at < min) min = want.at;
    }
    const real = seatOf(r.gw, s.id);
    expect(real.wake.selfAt).toBe(s.selfAt);
    expect(real.wake.inTurn).toBe(s.inTurn);
    expect(real.alive).toBe(s.alive);
  }
  expect(r.wake.nextWakeTime()).toBe(min);
}

type Cmd = fc.Command<Model, Real>;

class Advance implements Cmd {
  constructor(readonly dt: number) {}
  check(): boolean {
    return true;
  }
  run(m: Model, r: Real): void {
    const target = m.now + this.dt;
    for (let guard = 0; ; guard += 1) {
      if (guard > 10000) throw new Error(`advance to ${target} does not converge`);
      const next = r.wake.nextWakeTime();
      const want = m.seats.reduce<number | null>((acc, s) => {
        const w = wakeOf(m, s);
        return w === null ? acc : acc === null ? w.at : Math.min(acc, w.at);
      }, null);
      expect(next).toBe(want);
      if (next === null || next > target) break;
      m.now = Math.max(m.now, next);
      settle(m, r);
    }
    m.now = target;
    checkAll(m, r);
  }
  toString(): string {
    return `Advance(${this.dt})`;
  }
}

type Request = null | { kind: "in" | "at"; v: number };

class EndTurn implements Cmd {
  constructor(
    readonly pick: number,
    readonly request: Request,
  ) {}
  check(m: Readonly<Model>): boolean {
    return m.seats.some((s) => s.inTurn);
  }
  run(m: Model, r: Real): void {
    const open = m.seats.filter((s) => s.inTurn);
    const s = open[this.pick % open.length]!;
    const before = seatOf(r.gw, s.id).wake.selfAt;
    if (this.request !== null) {
      const at =
        this.request.kind === "in" ? m.now + this.request.v : Math.max(0, m.now + this.request.v);
      const lo = m.now + m.rules.selfWake.min;
      const hi = m.now + m.rules.selfWake.max;
      const want = Math.min(hi, Math.max(lo, at));
      expect(r.wake.requestSelfWake(s.id, at, m.now)).toEqual({ at: want, clamped: want !== at });
      if (want !== at) m.stats.clamped += 1;
      s.selfAt = want;
    }
    const { selfAt, next } = closeTurn(r.gw, r.wake, {
      t: m.now,
      seat: s.id,
      why: this.request === null ? "empty_round" : "end_turn",
      rounds: 1,
      selfAt: seatOf(r.gw, s.id).wake.selfAt,
    });
    s.inTurn = false;
    s.lastEnd = m.now;
    if (this.request === null) {
      expect(selfAt).toBe(before);
      if (before !== null) m.stats.keptSelf += 1;
    }
    expect(selfAt).toBe(s.selfAt);
    if (s.alive) {
      const urgentDue = times(m, s).urgent;
      expect(next).not.toBeNull();
      if (urgentDue === null || urgentDue > m.now) expect(next!.at).toBeGreaterThan(m.now);
    } else {
      expect(next).toBeNull();
    }
    settle(m, r);
    checkAll(m, r);
  }
  toString(): string {
    return `EndTurn(${this.pick}, ${JSON.stringify(this.request)})`;
  }
}

const TRIGGER_KINDS = [
  "attack",
  "attack_ally",
  "message",
  "spy_detected",
  "queue",
  "battle_self",
  "battle_target",
  "battle_party",
  "public_message",
  "domination",
  "noise",
] as const;
type TriggerKind = (typeof TRIGGER_KINDS)[number];

class Trigger implements Cmd {
  constructor(
    readonly target: number,
    readonly other: number,
    readonly kind: TriggerKind,
    readonly city: string,
    readonly key: string,
  ) {}
  check(): boolean {
    return true;
  }
  run(m: Model, r: Real): void {
    const t = m.now;
    const to = SEATS[this.target % SEATS.length]!;
    const by = SEATS[(this.target + 1 + (this.other % (SEATS.length - 1))) % SEATS.length]!;
    m.nextId += 1;
    const n = m.nextId;
    let ev: DomainEvent;
    // [seat, class, reason] triggers the model expects (addressed seats only, alive or not).
    let expected: [PlayerId, "urgent" | "own" | "social", string][] = [];
    // Who caused the event, from the point of view of the addressed seat `to`.
    let origin: Origin = "other";
    switch (this.kind) {
      case "attack":
      case "attack_ally": {
        const movement = oid("m", n);
        const role = this.kind === "attack" ? "party" : "ally";
        ev = event(t, "incoming_attack", [[to, role]], {
          movement,
          from: "c9",
          by,
          foe: role === "party" ? to : by,
          to: "c1",
          departAt: t,
          arriveAt: t + 3600,
          homecoming: false,
        });
        expected = [[to, role === "party" ? "urgent" : "social", `incoming_attack ${movement}`]];
        break;
      }
      case "message": {
        const id = oid("g", n);
        ev = event(
          t,
          "message",
          [
            [by, "self"],
            [to, "target"],
          ],
          { message: id, from: by, to: [to], text: "hi" },
        );
        expected = [[to, "social", `message ${id}`]];
        break;
      }
      case "spy_detected":
        ev = event(t, "spy_detected", [[to, "target"]], { city: "c1", by, from: "c9", gold: 100 });
        expected = [[to, "social", `spy_detected ${by}`]];
        break;
      case "queue":
        ev = event(t, "queue_empty", [[to, "self"]], { city: this.city, queue: "build" });
        expected = [[to, "own", `queue_empty ${this.city}`]];
        origin = "own";
        break;
      case "battle_self": {
        const report = oid("r", n);
        ev = event(t, "battle_report", [[to, "self"]], {
          report,
          city: "c9",
          attacker: to,
          defender: by,
          kind: "city",
          winner: "attacker",
        });
        expected = [[to, "own", `battle_report ${report}`]];
        origin = "own";
        break;
      }
      case "battle_target":
      case "battle_party": {
        // `by` attacked: `to` gets its report as the city's owner (target) or as the recorded
        // party (a besieger whose siege was relieved).
        const report = oid("r", n);
        const role = this.kind === "battle_target" ? "target" : "party";
        ev = event(t, "battle_report", [[to, role]], {
          report,
          city: "c1",
          attacker: by,
          defender: to,
          kind: "city",
          winner: "defender",
        });
        expected = [[to, "social", `battle_report ${report}`]];
        break;
      }
      case "public_message":
        ev = event(
          t,
          "message",
          [[by, "self"]],
          { message: oid("g", n), from: by, to: "all", text: "x" },
          true,
        );
        break;
      case "domination": {
        ev = event(t, "domination_started", [], { key: this.key, endsAt: t + DAY }, true);
        const once = `domination_started:${this.key}:${Math.floor(t / DAY)}`;
        if (!m.onceKeys.includes(once)) {
          m.onceKeys.push(once);
          expected = SEATS.map((p) => [p, "urgent", `domination_started ${this.key}`]);
        }
        break;
      }
      case "noise":
        ev = event(
          t,
          "alliance_left",
          [[to, "self"]],
          { alliance: "a1", player: to, cause: "left" },
          true,
        );
        origin = "own";
        break;
    }
    const ownState = (): unknown =>
      SEATS.map((p) => {
        const w = seatOf(r.gw, p).wake;
        return [w.ownFirst, w.selfAt];
      });
    const before = ownState();
    deliver(r.gw, [ev], r.wake);
    // Another seat's action never creates an own trigger or moves a self-wake, for any seat.
    if (origin === "other") expect(ownState()).toEqual(before);
    for (const [p, cls, reason] of expected) {
      const s = modelSeat(m, p);
      if (!s.alive) continue;
      if (cls === "urgent") {
        if (!s.urgent.some((u) => u.reason === reason)) s.urgent.push({ t, reason });
      } else if (!s.normal.some((x) => x.reason === reason && x.cls === cls)) {
        s.normal.push({ t, reason, cls, origin });
      }
    }
    settle(m, r);
    checkAll(m, r);
  }
  toString(): string {
    return `Trigger(${this.target}, ${this.other}, ${this.kind}, ${this.city}, ${this.key})`;
  }
}

/** Repeated urgent triggers on one seat at one second, closing its turn each time: the per-second cap binds when urgentMinGap is 0. */
class Burst implements Cmd {
  constructor(readonly target: number) {}
  check(): boolean {
    return true;
  }
  run(m: Model, r: Real): void {
    for (let i = 0; i < MAX_TURNS_PER_SECOND + 1; i += 1) {
      const s = m.seats[this.target % m.seats.length]!;
      if (s.inTurn) new EndTurn(m.seats.filter((x) => x.inTurn).indexOf(s), null).run(m, r);
      new Trigger(this.target, i, "attack", "c1", "a1").run(m, r);
    }
  }
  toString(): string {
    return `Burst(${this.target})`;
  }
}

class Eliminate implements Cmd {
  constructor(readonly target: number) {}
  check(m: Readonly<Model>): boolean {
    return m.seats.filter((s) => s.alive).length > 1;
  }
  run(m: Model, r: Real): void {
    const alive = m.seats.filter((s) => s.alive);
    const s = alive[this.target % alive.length]!;
    deliver(
      r.gw,
      [event(m.now, "player_eliminated", [[s.id, "self"]], { player: s.id }, true)],
      r.wake,
    );
    s.alive = false;
    m.stats.eliminated += 1;
    s.urgent = [];
    s.normal = [];
    s.selfAt = null;
    s.deferTo = null;
    settle(m, r);
    checkAll(m, r);
  }
  toString(): string {
    return `Eliminate(${this.target})`;
  }
}

class RoundTrip implements Cmd {
  check(): boolean {
    return true;
  }
  run(m: Model, r: Real): void {
    const parsed = viaJson(r.gw);
    expect(parsed).toEqual(r.gw);
    r.gw = parsed;
    m.stats.roundTrips += 1;
    r.wake = createWakeScheduler(r.gw, m.rules);
    checkAll(m, r);
  }
  toString(): string {
    return "RoundTrip";
  }
}

/** perfidia-1's wake table with generated numbers (every combination the kernel checks accept). */
function rulesWith(x: {
  groupWindow: number;
  urgentMinGap: number;
  selfMin: number;
  selfSpan: number;
  safetyExtra: number;
  own: number;
  social: number;
}): GatewayRules {
  return {
    ...RULES,
    groupWindow: x.groupWindow,
    urgentMinGap: x.urgentMinGap,
    selfWake: { min: x.selfMin, max: x.selfMin + x.selfSpan },
    safetyWake: Math.max(1, x.selfMin) + x.safetyExtra,
    ownWakesPerDay: x.own,
    socialWakesPerDay: x.social,
  };
}

const rulesArb: fc.Arbitrary<GatewayRules> = fc.oneof(
  fc.constant(RULES),
  fc
    .record({
      groupWindow: fc.integer({ min: 0, max: 3000 }),
      urgentMinGap: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 3000 })),
      selfMin: fc.integer({ min: 0, max: 3000 }),
      selfSpan: fc.integer({ min: 0, max: 50000 }),
      safetyExtra: fc.integer({ min: 0, max: 60000 }),
      own: fc.integer({ min: 1, max: 4 }),
      social: fc.integer({ min: 1, max: 4 }),
    })
    .map(rulesWith),
);

const requestArb: fc.Arbitrary<Request> = fc.oneof(
  fc.constant(null),
  fc.record({ kind: fc.constant("in" as const), v: fc.integer({ min: 0, max: 60000 }) }),
  fc.record({ kind: fc.constant("at" as const), v: fc.integer({ min: -3000, max: 60000 }) }),
);

const commandsArb = fc.commands(
  [
    fc.integer({ min: 1, max: 30000 }).map((dt): Cmd => new Advance(dt)),
    fc.integer({ min: 1, max: 900 }).map((dt): Cmd => new Advance(dt)),
    fc.tuple(fc.nat(5), requestArb).map(([pick, request]): Cmd => new EndTurn(pick, request)),
    fc.tuple(fc.nat(5), requestArb).map(([pick, request]): Cmd => new EndTurn(pick, request)),
    fc
      .tuple(
        fc.nat(2),
        fc.nat(1),
        fc.constantFrom(...TRIGGER_KINDS),
        fc.constantFrom("c1", "c2"),
        fc.constantFrom("a1", "p2"),
      )
      .map(([target, other, kind, city, key]): Cmd => new Trigger(target, other, kind, city, key)),
    fc
      .tuple(
        fc.nat(2),
        fc.nat(1),
        fc.constantFrom<TriggerKind>("attack", "message", "queue", "battle_target", "battle_party"),
      )
      .map(([target, other, kind]): Cmd => new Trigger(target, other, kind, "c1", "a1")),
    fc.nat(2).map((target): Cmd => new Eliminate(target)),
    fc.nat(2).map((target): Cmd => new Burst(target)),
    fc.constant<Cmd>(new RoundTrip()),
  ],
  { maxCommands: 150, size: "max" },
);

function setup(rules: GatewayRules, stats: Stats): { model: Model; real: Real } {
  const gw = createGatewayState(SEATS);
  const real: Real = { gw, wake: createWakeScheduler(gw, rules) };
  const model: Model = {
    stats,
    rules,
    now: 0,
    seats: SEATS.map((id) => ({
      id,
      alive: true,
      inTurn: false,
      turns: 0,
      lastEnd: 0,
      urgent: [],
      normal: [],
      selfAt: null,
      lastUrgentStart: null,
      deferTo: null,
      turnsAt: { t: -1, n: 0 },
    })),
    nextId: 0,
    charged: {},
    urgentWakes: {},
    onceKeys: [],
  };
  settle(model, real);
  checkAll(model, real);
  return { model, real };
}

describe("P11: wake scheduler model test", () => {
  test("the scheduler matches the model and every §8.5 property holds", () => {
    const stats: Stats = {
      defers: 0,
      urgent: 0,
      own: 0,
      social: 0,
      safety: 0,
      self: 0,
      moved: 0,
      clamped: 0,
      eliminated: 0,
      roundTrips: 0,
      keptSelf: 0,
      grouped: 0,
      urgentJoined: 0,
      battleOther: 0,
      ownByTrigger: 0,
    };
    fc.assert(
      fc.property(rulesArb, commandsArb, (rules, cmds) => {
        fc.modelRun(() => setup(rules, stats), cmds);
      }),
      { numRuns: 300 },
    );
    // Every interesting path was reached by the runs.
    for (const [path, count] of Object.entries(stats)) {
      expect({ path, reached: count > 0 }).toEqual({ path, reached: true });
    }
  }, 60000);
});
