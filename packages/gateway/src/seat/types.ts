import type {
  DomainEvent,
  ErrorCode,
  GameTime,
  GatewayRules,
  PlayerId,
  ToolArgs,
  TurnEnd,
  WakeKind,
  WakeReason,
  WakeRole,
} from "@perfidia/protocol";

// Gateway seat state (docs/architecture.md §8.4, §8.5). Everything here is plain JSON: no Map, no
// Set, no undefined property, no class instance, so the whole state round-trips through JSON and
// `rebuildGatewayState` (§10.5) can rebuild it from the log lines alone. It is not hashed.

/** One delivered engine event; the same entry is shared by the archives, inboxes and feed it reaches. */
export interface Delivered {
  /** Delivery number, from 1, in `ev`-line order. */
  readonly e: number;
  readonly event: DomainEvent;
}

/**
 * The wake scheduler's state of one seat (§8.5). Two fields are additions to the shape of §8.5:
 * `urgentReasons`, because urgent triggers still inside the urgent gap stay pending when an earlier
 * non-urgent wake drains the others, and `deferTo`, the lockstep per-second turn cap of `defer`.
 */
export interface SeatWake {
  /** The only notion of "in flight" used by the drivers. */
  inTurn: boolean;
  /** Earliest undelivered urgent trigger. */
  urgentAt: GameTime | null;
  /** Reasons of the undelivered urgent triggers, in arrival order. */
  urgentReasons: WakeReason[];
  /** Start of the last wake that carried an urgent reason. */
  lastUrgentStart: GameTime | null;
  /** First undelivered own trigger (queue empty, own reports). */
  ownFirst: GameTime | null;
  /** First undelivered social trigger. */
  socialFirst: GameTime | null;
  /** Requested self-wake; pending until it fires or is replaced. */
  selfAt: GameTime | null;
  /** End of the last turn (safety base). */
  lastEnd: GameTime;
  /** Reasons of the undelivered own and social triggers, in arrival order; drained into the next briefing. */
  reasons: WakeReason[];
  /** No wake before this time (lockstep per-second turn cap); cleared when the seat wakes. */
  deferTo: GameTime | null;
}

/** Per-day counters, keyed by game day `floor(t / 86400)`; a later day starts from zero. */
export interface DayCounters {
  index: number;
  ownWakes: number;
  socialWakes: number;
  /** Engine-accepted attack launches. */
  attacks: number;
  /** Engine-accepted `send_message` calls (one call counts once). */
  messages: number;
}

/** A failed call of the current turn, kept until the turn closes (for `lastTurn.unseen`). */
export interface TurnFailure {
  /** Round index, from 0. */
  round: number;
  tool: string;
  code: ErrorCode;
  message: string;
}

/** How the previous turn ended (§8.2): the briefing's `lastTurn`, before times become pairs. */
export interface LastTurn {
  ended: TurnEnd;
  /** Failed results the agent never saw: the last round's failures, and every `TURN_OVER` or `CALLS_CAP`. */
  unseen: { tool: string; code: ErrorCode; message: string }[];
  /** The effective next wake when the turn closed; `null` when there is none. */
  nextWake: { at: GameTime; kind: WakeKind } | null;
}

export interface SeatState {
  readonly seat: PlayerId;
  alive: boolean;
  notes: string;
  /** Addressed to the seat since its last briefing. */
  inbox: Delivered[];
  /** Everything ever addressed to the seat, append-only. */
  archive: Delivered[];
  lastBriefingAt: GameTime;
  /**
   * `GatewayState.delivered` at the last briefing (an addition to §8.4): the seat's news is the
   * feed after it. A time alone cannot split the events of one second into those delivered before
   * the briefing and those delivered after it.
   */
  lastBriefingE: number;
  wake: SeatWake;
  day: DayCounters;
  /** Turns begun so far; the current or last turn's number. `0`: the start wake is pending. */
  turns: number;
  lastTurn: LastTurn | null;
  /** Failures of the turn in progress (an addition to §8.4); emptied when a turn begins or closes. */
  turnFailures: TurnFailure[];
}

export interface GatewayState {
  readonly seats: Record<PlayerId, SeatState>;
  /** Every public event, append-only; a seat's news is the feed after its last briefing. */
  readonly feed: Delivered[];
  /** `${type}:${key}:${day}` already used by `publicOncePerDay`. */
  readonly onceKeys: Record<string, true>;
  /** Running delivery number: the `e` of the last delivered event. */
  delivered: number;
}

/** What a wake opens with, as the `wake` log line records it. */
export interface WakeRecord {
  reasons: WakeReason[];
  urgent: boolean;
  /** The budget charged: none for an urgent, safety or start wake. */
  charge: "own" | "social" | null;
  /** Game day of the wake. */
  day: number;
  /** The day's usage after this wake. */
  used: { own: number; social: number };
}

/** The kind of a seat's next wake: the five of `WakeKind`, plus the start wake at t = 0. */
export type NextWakeKind = WakeKind | "start";

export interface NextWake {
  at: GameTime;
  kind: NextWakeKind;
}

/** The wake scheduler of §8.5: a stateless view over `GatewayState`; its state lives in `SeatState.wake`. */
export interface WakeScheduler {
  readonly rules: GatewayRules;
  /** Records a trigger for `seat` if `rules.wake[ev.type][role]` names a class. */
  ingest(seat: PlayerId, ev: DomainEvent, role: WakeRole): void;
  /** Clamps `at` into `[now + selfWake.min, now + selfWake.max]` and makes it the pending self-wake. */
  requestSelfWake(seat: PlayerId, at: GameTime, now: GameTime): { at: GameTime; clamped: boolean };
  /** Earliest wake of an idle, alive seat; `null` when none. */
  nextWakeTime(): GameTime | null;
  /** Idle, alive seats whose wake time is `<= t`, sorted by player number. */
  due(t: GameTime): PlayerId[];
  /** The seat's effective next wake; `null` while it is in a turn or eliminated. */
  peek(seat: PlayerId): NextWake | null;
  /** Opens a turn: drains the due reasons, charges a budget, counts the turn. */
  begin(seat: PlayerId, t: GameTime): WakeRecord;
  /** Closes the turn: clears `inTurn` synchronously and sets `lastEnd`. */
  end(seat: PlayerId, t: GameTime): void;
  /** No wake before `to` (lockstep per-second turn cap). */
  defer(seat: PlayerId, to: GameTime): void;
  /** The seat never wakes again; its pending triggers are dropped. */
  eliminate(seat: PlayerId): void;
}

/** The `search` argument of `read_notes` (§8.3). */
export type ArchiveQuery = NonNullable<ToolArgs<"read_notes">["search"]>;
