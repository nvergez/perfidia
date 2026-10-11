import { compareIds, PlayerIdSchema, z } from "@perfidia/protocol";
import type {
  Briefing,
  GameTime,
  MatchResult,
  PlayerId,
  RoundInput,
  RoundOutput,
  SeatAgent,
  TimeSource,
  ToolCall,
  ToolResult,
  TurnEnd,
} from "@perfidia/protocol";
import type { AgentFailure, ClockHost, TurnHandle } from "./types.ts";

// A scripted `ClockHost` for driver tests (§9.4: "Driver tests use a scripted FakeHost"): a test
// double, kept in a `*.test.ts` kit like every test kit and never exported. It models just enough
// of the wake scheduler of §8.5 to make the drivers' behaviour observable: a start wake at 0,
// urgent triggers with a gap, normal triggers grouped by a window, self-wakes, a safety wake, no
// wake time while a seat is in a turn, and `end(t)` pushing normal wakes to `t + 1`. Every state
// change goes through a method a driver calls, and is recorded in `trace`, so `replayFakeTrace`
// can rebuild a run from its trace.
// It throws `FakeHostError` whenever a driver breaks the `ClockHost` contract.

export class FakeHostError extends Error {
  override readonly name = "FakeHostError";
}

/** A scripted engine event: at `at`, a trigger for `seat`. */
export interface FakeEvent {
  readonly at: GameTime;
  readonly trigger: "urgent" | "normal";
  readonly seat: PlayerId;
}

export interface FakeHostOptions {
  readonly seed: number;
  readonly endsAt: GameTime;
  /** Seats `p1..pN`. */
  readonly seats: number;
  readonly events?: readonly FakeEvent[];
  /** Round cap per turn (default 8). */
  readonly maxRounds?: number;
  /** Normal triggers wake at `first + groupWindow` (default 600). */
  readonly groupWindow?: number;
  /** Minimum time between the starts of two urgent wakes (default 600). */
  readonly urgentGap?: number;
  /** A seat wakes at the latest this long after its last turn ended (default 43200). */
  readonly safetyWake?: number;
  /**
   * When true (default), a turn is done as soon as the match ends; when false, a turn open at the
   * end keeps playing until `end_turn`, an empty round or the round cap (its calls get
   * `MATCH_ENDED`), so the real-time "in-flight turns finish after the end" path is observable.
   */
  readonly doneOnEnd?: boolean;
  /** An extra effect of each applied call, after the built-in ones. Must be deterministic. */
  readonly onCall?: (host: FakeHost, seat: PlayerId, call: ToolCall) => void;
}

export type FakeRecord =
  | { readonly k: "start" }
  | { readonly k: "advance"; readonly t: GameTime }
  | {
      readonly k: "ev";
      readonly t: GameTime;
      readonly trigger: "urgent" | "normal";
      readonly seat: PlayerId;
    }
  | { readonly k: "ended"; readonly t: GameTime }
  | { readonly k: "eliminated"; readonly t: GameTime; readonly seat: PlayerId }
  | { readonly k: "wake"; readonly t: GameTime; readonly seat: PlayerId; readonly turn: number }
  | {
      readonly k: "batch";
      readonly t: GameTime;
      readonly b: number;
      readonly order: readonly PlayerId[];
    }
  | {
      readonly k: "exec";
      readonly t: GameTime;
      readonly seat: PlayerId;
      readonly turn: number;
      readonly round: number;
      readonly calls: readonly ToolCall[];
      readonly thought?: string;
      readonly codes: readonly string[];
    }
  | {
      readonly k: "turn";
      readonly t: GameTime;
      readonly seat: PlayerId;
      readonly turn: number;
      readonly rounds: number;
      readonly why: TurnEnd;
      readonly error?: string;
    }
  | { readonly k: "defer"; readonly t: GameTime; readonly seat: PlayerId; readonly to: GameTime }
  | { readonly k: "end"; readonly t: GameTime };

interface SeatState {
  alive: boolean;
  inTurn: boolean;
  turns: number;
  start: boolean;
  urgentAt: GameTime | null;
  lastUrgentStart: GameTime | null;
  normalFirst: GameTime | null;
  selfAt: GameTime | null;
  lastEnd: GameTime;
  deferTo: GameTime | null;
}

/** A call: `{tool, args}` (built-in fake effects: `attack {target}`, `send_message {to}`, `end_turn {wakeAt?}`). */
export function call(tool: string, args: Record<string, unknown> = {}): ToolCall {
  return { tool, args };
}

const ArgsShape = z.record(z.string(), z.unknown());

function argOf(c: ToolCall, key: string): unknown {
  const args = ArgsShape.safeParse(c.args);
  return args.success ? args.data[key] : undefined;
}

function asPlayer(value: unknown): PlayerId | null {
  const parsed = PlayerIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function copyCalls(calls: readonly ToolCall[]): ToolCall[] {
  return calls.map((c) => ({
    tool: c.tool,
    args: JSON.parse(JSON.stringify(c.args ?? null)) as unknown,
  }));
}

export class FakeHost implements ClockHost {
  readonly seed: number;
  readonly endsAt: GameTime;
  readonly options: FakeHostOptions;
  readonly trace: FakeRecord[] = [];

  readonly #seats = new Map<PlayerId, SeatState>();
  readonly #events: FakeEvent[];
  readonly #maxRounds: number;
  readonly #groupWindow: number;
  readonly #urgentGap: number;
  readonly #safetyWake: number;
  readonly #doneOnEnd: boolean;
  #now: GameTime = 0;
  #started = false;
  #ended = false;
  #finished = false;

  constructor(options: FakeHostOptions) {
    this.options = options;
    this.seed = options.seed;
    this.endsAt = options.endsAt;
    this.#maxRounds = options.maxRounds ?? 8;
    this.#groupWindow = options.groupWindow ?? 600;
    this.#urgentGap = options.urgentGap ?? 600;
    this.#safetyWake = options.safetyWake ?? 43200;
    this.#doneOnEnd = options.doneOnEnd ?? true;
    this.#events = (options.events ?? [])
      .map((e, i) => ({ e, i }))
      .toSorted((a, b) => a.e.at - b.e.at || a.i - b.i)
      .map((x) => x.e);
    for (let i = 1; i <= options.seats; i += 1) {
      this.#seats.set(`p${i}`, {
        alive: true,
        inTurn: false,
        turns: 0,
        start: true,
        urgentAt: null,
        lastUrgentStart: null,
        normalFirst: null,
        selfAt: null,
        lastEnd: 0,
        deferTo: null,
      });
    }
  }

  get seats(): PlayerId[] {
    return [...this.#seats.keys()];
  }

  now(): GameTime {
    return this.#now;
  }

  ended(): boolean {
    return this.#ended;
  }

  get finished(): boolean {
    return this.#finished;
  }

  /** Seats currently in a turn, by player number. */
  inTurn(): PlayerId[] {
    return this.seats.filter((p) => this.#seat(p).inTurn);
  }

  #seat(p: PlayerId): SeatState {
    const s = this.#seats.get(p);
    if (s === undefined) throw new FakeHostError(`unknown seat ${p}`);
    return s;
  }

  #record(r: FakeRecord): void {
    this.trace.push(r);
  }

  start(): void {
    if (this.#started) throw new FakeHostError("start() called twice");
    this.#started = true;
    this.#record({ k: "start" });
    this.advanceTo(0);
  }

  advanceTo(t: GameTime): void {
    if (!this.#started) throw new FakeHostError("advanceTo before start");
    if (!Number.isSafeInteger(t)) throw new FakeHostError(`advanceTo(${t}): not an integer`);
    if (t < this.#now) throw new FakeHostError(`advanceTo(${t}): time goes back from ${this.#now}`);
    if (t === this.#now) return;
    if (this.#ended)
      throw new FakeHostError(`advanceTo(${t}) after the match ended at ${this.#now}`);
    if (t > this.endsAt) throw new FakeHostError(`advanceTo(${t}) beyond endsAt ${this.endsAt}`);
    // Events fire at their own times (a late advance fires them late, never out of order), then
    // time reaches t.
    while (this.#events.length > 0 && this.#events[0]!.at <= t) {
      const e = this.#events.shift()!;
      this.#now = Math.max(this.#now, e.at);
      this.#record({ k: "ev", t: this.#now, trigger: e.trigger, seat: e.seat });
      this.trigger(e.seat, e.trigger);
    }
    this.#now = t;
    this.#record({ k: "advance", t });
    if (t === this.endsAt) this.endMatch();
  }

  /** A trigger for `seat` at `now()`, as an engine event or a call would cause. */
  trigger(seat: PlayerId, kind: "urgent" | "normal"): void {
    const s = this.#seat(seat);
    if (!s.alive) return;
    if (kind === "urgent")
      s.urgentAt = s.urgentAt === null ? this.#now : Math.min(s.urgentAt, this.#now);
    else s.normalFirst ??= this.#now;
  }

  /** Ends the match at `now()` (as a win or the `match_end` event would). */
  endMatch(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#events.length = 0;
    this.#record({ k: "ended", t: this.#now });
  }

  eliminate(seat: PlayerId): void {
    const s = this.#seat(seat);
    if (!s.alive) return;
    s.alive = false;
    this.#record({ k: "eliminated", t: this.#now, seat });
  }

  /** The wake time of an idle, alive seat (§8.5, simplified); `null` for a seat in a turn. */
  wakeTime(seat: PlayerId): GameTime | null {
    const s = this.#seat(seat);
    if (!s.alive || s.inTurn) return null;
    const candidates: GameTime[] = [s.lastEnd + this.#safetyWake];
    if (s.start) candidates.push(0);
    if (s.urgentAt !== null) {
      candidates.push(
        s.lastUrgentStart === null
          ? s.urgentAt
          : Math.max(s.urgentAt, s.lastUrgentStart + this.#urgentGap),
      );
    }
    if (s.normalFirst !== null) {
      candidates.push(Math.max(s.normalFirst + this.#groupWindow, s.lastEnd + 1));
    }
    if (s.selfAt !== null) candidates.push(Math.max(s.selfAt, s.lastEnd + 1));
    const at = Math.min(...candidates);
    return s.deferTo === null ? at : Math.max(at, s.deferTo);
  }

  nextTime(): GameTime | null {
    if (this.#ended) return null;
    let next = this.endsAt;
    const event = this.#events[0];
    if (event !== undefined) next = Math.min(next, event.at);
    for (const p of this.#seats.keys()) {
      const w = this.wakeTime(p);
      if (w !== null) next = Math.min(next, w);
    }
    return next;
  }

  dueSeats(t: GameTime): PlayerId[] {
    return this.seats
      .filter((p) => {
        const w = this.wakeTime(p);
        return w !== null && w <= t;
      })
      .toSorted(compareIds);
  }

  openTurn(seat: PlayerId): TurnHandle {
    const s = this.#seat(seat);
    if (this.#finished) throw new FakeHostError(`openTurn(${seat}) after finish`);
    if (!s.alive) throw new FakeHostError(`openTurn(${seat}): the seat is eliminated`);
    if (s.inTurn) throw new FakeHostError(`openTurn(${seat}): the seat is already in a turn`);
    const w = this.wakeTime(seat);
    if (w === null || w > this.#now) {
      throw new FakeHostError(`openTurn(${seat}) at ${this.#now}: not due (wake ${w})`);
    }
    const now = this.#now;
    s.inTurn = true;
    s.turns += 1;
    s.start = false;
    if (s.urgentAt !== null && s.urgentAt <= now) {
      s.urgentAt = null;
      s.lastUrgentStart = now;
    }
    s.normalFirst = null;
    if (s.selfAt !== null && s.selfAt <= now) s.selfAt = null;
    s.deferTo = null;
    this.#record({ k: "wake", t: now, seat, turn: s.turns });
    return new FakeTurn(this, seat, s.turns, this.#maxRounds, this.#briefing(seat));
  }

  logBatch(t: GameTime, b: number, order: readonly PlayerId[]): void {
    if (t !== this.#now) throw new FakeHostError(`logBatch(${t}) at ${this.#now}`);
    this.#record({ k: "batch", t, b, order: [...order] });
  }

  defer(seat: PlayerId, to: GameTime): void {
    const s = this.#seat(seat);
    if (s.inTurn) throw new FakeHostError(`defer(${seat}) during its turn`);
    if (to <= this.#now) throw new FakeHostError(`defer(${seat}, ${to}) not after ${this.#now}`);
    s.deferTo = to;
    this.#record({ k: "defer", t: this.#now, seat, to });
  }

  finish(): MatchResult {
    if (this.#finished) throw new FakeHostError("finish() called twice");
    const open = this.inTurn();
    if (open.length > 0)
      throw new FakeHostError(`finish() with turns still open: ${open.join(", ")}`);
    this.#finished = true;
    this.#record({ k: "end", t: this.#now });
    return { endedAt: this.#now, reason: "time", winners: [], standings: [] };
  }

  /** @internal Applies one round of `seat`'s turn; called by `FakeTurn.execute`. */
  applyRound(turn: FakeTurn, out: RoundOutput): ToolResult[] {
    const results: ToolResult[] = [];
    const codes: string[] = [];
    let over = false;
    for (const c of out.calls) {
      let code = "ok";
      if (over) code = "TURN_OVER";
      else if (this.#ended) code = "MATCH_ENDED";
      else if (!this.#seat(turn.seat).alive) code = "ELIMINATED";
      if (code === "ok") {
        this.#effect(turn.seat, c);
        results.push({ ok: true, t: this.#now, data: {} });
      } else {
        results.push({ ok: false, t: this.#now, code, message: code, hint: "" });
      }
      // `end_turn` ends the turn after its round even when the match has ended meanwhile.
      if (c.tool === "end_turn" && code !== "TURN_OVER") over = true;
      codes.push(code);
    }
    const r: FakeRecord = {
      k: "exec",
      t: this.#now,
      seat: turn.seat,
      turn: turn.turn,
      round: turn.round,
      calls: copyCalls(out.calls),
      codes,
      ...(out.thought === undefined ? {} : { thought: out.thought }),
    };
    this.#record(r);
    if (over) turn.endTurn();
    return results;
  }

  #effect(seat: PlayerId, c: ToolCall): void {
    if (c.tool === "attack") {
      const target = asPlayer(argOf(c, "target"));
      if (target !== null) this.trigger(target, "urgent");
    } else if (c.tool === "send_message") {
      const to = asPlayer(argOf(c, "to"));
      if (to !== null) this.trigger(to, "normal");
    } else if (c.tool === "end_turn") {
      const wakeAt = argOf(c, "wakeAt");
      if (typeof wakeAt === "number" && Number.isSafeInteger(wakeAt) && wakeAt > this.#now) {
        this.#seat(seat).selfAt = wakeAt;
      }
    }
    this.options.onCall?.(this, seat, c);
  }

  /** @internal Closes `seat`'s turn; called by `FakeTurn.close`. */
  closeTurn(turn: FakeTurn, why: TurnEnd, error: string | undefined): void {
    const s = this.#seat(turn.seat);
    s.inTurn = false;
    s.lastEnd = this.#now;
    this.#record({
      k: "turn",
      t: this.#now,
      seat: turn.seat,
      turn: turn.turn,
      rounds: turn.round,
      why,
      ...(error === undefined ? {} : { error }),
    });
  }

  /** @internal */
  isAlive(seat: PlayerId): boolean {
    return this.#seat(seat).alive;
  }

  /** @internal */
  get doneOnEnd(): boolean {
    return this.#doneOnEnd;
  }

  #briefing(seat: PlayerId): Briefing {
    return {
      you: seat,
      t: this.#now,
      time: `t${this.#now}`,
      left: [this.endsAt - this.#now, ""],
      ruleset: "fake-1@1.0.0",
      wake: { urgent: false, reasons: [] },
      lastTurn: null,
      cities: [],
      incoming: [],
      moves: [],
      msgs: [],
      proposals: [],
      events: [],
      news: [],
      notes: "",
      budget: {
        roundTrips: this.#maxRounds,
        callsPerRoundTrip: 10,
        ownWakesLeft: 12,
        socialWakesLeft: 8,
        selfWakeAt: null,
        attacksLeft: 20,
        messagesLeft: 20,
      },
      ext: {},
    };
  }
}

export class FakeTurn implements TurnHandle {
  readonly seat: PlayerId;
  readonly turn: number;
  readonly #host: FakeHost;
  readonly #maxRounds: number;
  readonly #briefing: Briefing;
  #round = 0;
  #results: ToolResult[] = [];
  #endTurn = false;
  #emptyRound = false;
  #closed = false;

  constructor(host: FakeHost, seat: PlayerId, turn: number, maxRounds: number, briefing: Briefing) {
    this.#host = host;
    this.seat = seat;
    this.turn = turn;
    this.#maxRounds = maxRounds;
    this.#briefing = briefing;
  }

  get round(): number {
    return this.#round;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The turn ended by its own rules: `end_turn`, an empty round or the round cap. */
  get #over(): boolean {
    return this.#endTurn || this.#emptyRound || this.#round >= this.#maxRounds;
  }

  get done(): boolean {
    return (
      this.#closed ||
      this.#over ||
      !this.#host.isAlive(this.seat) ||
      (this.#host.doneOnEnd && this.#host.ended())
    );
  }

  input(): RoundInput {
    if (this.#closed) throw new FakeHostError(`${this.seat}: input() on a closed turn`);
    return {
      seat: this.seat,
      turn: this.turn,
      round: this.#round,
      maxRounds: this.#maxRounds,
      maxCalls: 10,
      briefing: this.#briefing,
      results: this.#results,
    };
  }

  execute(out: RoundOutput): void {
    if (this.#closed) throw new FakeHostError(`${this.seat}: execute() on a closed turn`);
    if (this.#over) throw new FakeHostError(`${this.seat}: execute() after the turn ended`);
    this.#results = this.#host.applyRound(this, out);
    this.#round += 1;
    if (out.calls.length === 0) this.#emptyRound = true;
  }

  /** @internal */
  endTurn(): void {
    this.#endTurn = true;
  }

  close(failure?: AgentFailure): void {
    if (this.#closed) throw new FakeHostError(`${this.seat}: close() called twice`);
    let why: TurnEnd;
    if (failure !== undefined) why = failure.cause;
    else if (this.#endTurn) why = "end_turn";
    else if (this.#emptyRound) why = "empty_round";
    else if (this.#round >= this.#maxRounds) why = "round_cap";
    else if (!this.#host.isAlive(this.seat)) why = "eliminated";
    else if (this.#host.ended()) why = "match_ended";
    else throw new FakeHostError(`${this.seat}: close() on a turn that is not done`);
    this.#closed = true;
    this.#host.closeTurn(this, why, failure?.error);
  }
}

/**
 * A `FakeHost` that logs every call a driver makes to it or to its turn handles (`openTurn p2`,
 * `nextTime`, `execute p1`, …; a handle's `done` also reads `ended`), and throws
 * `Error("host failure in <call>")` on the call named `failOn`, as an engine bug would.
 */
export class CallLogHost extends FakeHost {
  readonly calls: string[] = [];
  readonly #failOn: string | undefined;

  constructor(options: FakeHostOptions, failOn?: string) {
    super(options);
    this.#failOn = failOn;
  }

  #log(c: string): void {
    this.calls.push(c);
    if (c === this.#failOn) throw new Error(`host failure in ${c}`);
  }

  override now(): GameTime {
    this.#log("now");
    return super.now();
  }

  override ended(): boolean {
    this.#log("ended");
    return super.ended();
  }

  override start(): void {
    this.#log("start");
    super.start();
  }

  override advanceTo(t: GameTime): void {
    this.#log(`advanceTo ${t}`);
    super.advanceTo(t);
  }

  override nextTime(): GameTime | null {
    this.#log("nextTime");
    return super.nextTime();
  }

  override dueSeats(t: GameTime): PlayerId[] {
    this.#log(`dueSeats ${t}`);
    return super.dueSeats(t);
  }

  override openTurn(seat: PlayerId): TurnHandle {
    this.#log(`openTurn ${seat}`);
    const h = super.openTurn(seat);
    const log = (c: string): void => this.#log(`${c} ${seat}`);
    return {
      seat,
      get done(): boolean {
        log("done");
        return h.done;
      },
      input: () => {
        log("input");
        return h.input();
      },
      execute: (out) => {
        log("execute");
        h.execute(out);
      },
      close: (failure) => {
        log("close");
        h.close(failure);
      },
    };
  }

  override logBatch(t: GameTime, b: number, order: readonly PlayerId[]): void {
    this.#log(`logBatch ${t} ${b}`);
    super.logBatch(t, b, order);
  }

  override defer(seat: PlayerId, to: GameTime): void {
    this.#log(`defer ${seat}`);
    super.defer(seat, to);
  }

  override finish(): MatchResult {
    this.#log("finish");
    return super.finish();
  }
}

/**
 * Rebuilds a run from its trace on a fresh host with the same options: every driver call is
 * replayed in trace order (engine events and the match end are re-derived). Returns the new host,
 * whose trace equals the original when the trace is self-consistent.
 */
export function replayFakeTrace(options: FakeHostOptions, trace: readonly FakeRecord[]): FakeHost {
  const host = new FakeHost(options);
  const turns = new Map<PlayerId, TurnHandle>();
  const handle = (seat: PlayerId): TurnHandle => {
    const h = turns.get(seat);
    if (h === undefined) throw new FakeHostError(`replay: no open turn for ${seat}`);
    return h;
  };
  for (const r of trace) {
    switch (r.k) {
      case "start":
        host.start();
        break;
      case "advance":
        host.advanceTo(r.t);
        break;
      case "ev":
      case "ended":
      case "eliminated":
        break;
      case "wake":
        turns.set(r.seat, host.openTurn(r.seat));
        break;
      case "batch":
        host.logBatch(r.t, r.b, r.order);
        break;
      case "exec":
        handle(r.seat).execute(
          r.thought === undefined ? { calls: r.calls } : { calls: r.calls, thought: r.thought },
        );
        break;
      case "turn":
        if (r.error === undefined) handle(r.seat).close();
        else
          handle(r.seat).close({
            error: r.error,
            cause: r.why === "timeout" ? "timeout" : "error",
          });
        turns.delete(r.seat);
        break;
      case "defer":
        host.defer(r.seat, r.to);
        break;
      case "end":
        host.finish();
        break;
    }
  }
  return host;
}

/** One record as a short line, e.g. `exec p1#2.0 @100 attack,end_turn`, for readable expectations. */
export function describeRecord(r: FakeRecord): string {
  switch (r.k) {
    case "start":
      return "start";
    case "advance":
      return `advance ${r.t}`;
    case "ev":
      return `ev ${r.trigger} ${r.seat} @${r.t}`;
    case "ended":
      return `ended @${r.t}`;
    case "eliminated":
      return `eliminated ${r.seat} @${r.t}`;
    case "wake":
      return `wake ${r.seat}#${r.turn} @${r.t}`;
    case "batch":
      return `batch ${r.b} @${r.t} [${r.order.join(",")}]`;
    case "exec": {
      const tools = r.calls.map((c, i) =>
        r.codes[i] === "ok" ? c.tool : `${c.tool}!${r.codes[i]}`,
      );
      return `exec ${r.seat}#${r.turn}.${r.round} @${r.t} ${tools.join(",") || "-"}`;
    }
    case "turn":
      return `turn ${r.seat}#${r.turn} @${r.t} ${r.why}${r.error === undefined ? "" : `: ${r.error}`}`;
    case "defer":
      return `defer ${r.seat} @${r.t} -> ${r.to}`;
    case "end":
      return `end @${r.t}`;
  }
  throw new FakeHostError("unknown record kind");
}

/**
 * The structural invariants of a driver's trace, as messages (empty when they all hold): `start`
 * first and `end` last; game time never goes back; per seat, `wake`, its rounds `exec` 0, 1, … and
 * its `turn` alternate (one turn per seat), turns numbered from 1; `defer` only for an idle seat.
 */
export function traceViolations(trace: readonly FakeRecord[]): string[] {
  const out: string[] = [];
  const open = new Map<PlayerId, { turn: number; rounds: number }>();
  const turns = new Map<PlayerId, number>();
  let t = 0;
  if (trace[0]?.k !== "start") out.push("the trace does not begin with start");
  for (const [i, r] of trace.entries()) {
    if (r.k === "start") continue;
    if (r.t < t) out.push(`#${i} ${r.k}: time goes back from ${t} to ${r.t}`);
    t = Math.max(t, r.t);
    if (r.k === "end" && i !== trace.length - 1) out.push(`#${i}: records after end`);
    if (r.k === "wake") {
      if (open.has(r.seat)) out.push(`#${i}: ${r.seat} woken during its turn`);
      const expected = (turns.get(r.seat) ?? 0) + 1;
      if (r.turn !== expected) out.push(`#${i}: ${r.seat} turn ${r.turn}, expected ${expected}`);
      turns.set(r.seat, r.turn);
      open.set(r.seat, { turn: r.turn, rounds: 0 });
    } else if (r.k === "exec") {
      const o = open.get(r.seat);
      if (o === undefined || o.turn !== r.turn) out.push(`#${i}: ${r.seat} plays outside a turn`);
      else if (r.round !== o.rounds)
        out.push(`#${i}: ${r.seat} round ${r.round}, expected ${o.rounds}`);
      else o.rounds += 1;
    } else if (r.k === "turn") {
      const o = open.get(r.seat);
      if (o === undefined || o.turn !== r.turn)
        out.push(`#${i}: ${r.seat} closes a turn it is not in`);
      else if (o.rounds !== r.rounds)
        out.push(`#${i}: ${r.seat} closes after ${r.rounds} rounds, played ${o.rounds}`);
      open.delete(r.seat);
    } else if (r.k === "defer" && open.has(r.seat)) {
      out.push(`#${i}: ${r.seat} deferred during its turn`);
    }
  }
  const last = trace.at(-1);
  if (last?.k === "end" && open.size > 0)
    out.push(`turns left open: ${[...open.keys()].join(", ")}`);
  return out;
}

/** What `p` rejects with; throws if it fulfils. */
export async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection, got a fulfilment");
}

// Values an agent controls that cannot be printed or parsed without throwing.

/** An `Error` whose `message` getter throws. */
export function unprintableError(): Error {
  const e = new Error("hidden");
  Object.defineProperty(e, "message", {
    get(): never {
      throw new Error("message getter");
    },
  });
  return e;
}

/** A revoked Proxy of an `Error`: even `instanceof` on it throws. */
export function revokedError(): Error {
  const { proxy, revoke } = Proxy.revocable(new Error("revoked"), {});
  revoke();
  return proxy;
}

/** A round answer whose `calls` getter throws (schema parsing lets the throw through). */
export function hostileAnswer(): unknown {
  return {
    get calls(): never {
      throw new Error("calls getter");
    },
  };
}

// Agents for driver tests.

export type Script = (input: RoundInput) => RoundOutput;

/** An agent that answers `value` whatever it is: its type lies on purpose, to test the drivers' output check. */
export function answering(value: unknown, label = "fake:malformed@1"): SeatAgent {
  return {
    label,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a deliberately malformed answer
    round: () => Promise.resolve(value) as Promise<RoundOutput>,
  };
}

/** Answers each round at once with `script(input)`. */
export function scriptedAgent(script: Script, label = "fake:scripted@1"): SeatAgent {
  return { label, round: (input) => Promise.resolve(script(input)) };
}

/** Thinks `thinkMs(input)` ms of `time`, then answers `script(input)`. */
export function thinkingAgent(
  time: TimeSource,
  thinkMs: number | ((input: RoundInput) => number),
  script: Script,
  label = "fake:thinking@1",
): SeatAgent {
  return {
    label,
    async round(input: RoundInput): Promise<RoundOutput> {
      const ms = typeof thinkMs === "number" ? thinkMs : thinkMs(input);
      await time.sleepUntil(time.nowMs() + ms).done;
      return script(input);
    },
  };
}

/** Plays `rounds` rounds of `calls(input)`, the last one ending with `end_turn` (`wakeAt` if given). */
export function playRounds(
  rounds: number,
  calls: (input: RoundInput) => ToolCall[] = () => [call("view_city")],
  wakeAt?: (input: RoundInput) => GameTime | undefined,
): Script {
  return (input) => {
    const own = calls(input);
    if (input.round + 1 < rounds) return { calls: own };
    const at = wakeAt?.(input);
    return { calls: [...own, call("end_turn", at === undefined ? {} : { wakeAt: at })] };
  };
}
