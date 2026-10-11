import { DAY } from "@perfidia/engine/core";
import {
  ENGINE_VERSION,
  HOUR,
  type ApplyOutput,
  type Match,
  type StepOutput,
} from "@perfidia/engine/kernel";
import {
  describeError,
  type AgentFailure,
  type ClockHost,
  type TurnHandle,
} from "@perfidia/gateway/clock";
import { buildBriefing, explain, gatewayRulesCopy, toolError } from "@perfidia/gateway/present";
import {
  briefed,
  checkCallCap,
  checkRoundTrip,
  closeTurn,
  createGatewayState,
  createWakeScheduler,
  deliver,
  recordAct,
  recordGw,
  recordWarnings,
  roundCallCap,
  seatOf,
  type GatewayState,
  type WakeRecord,
  type WakeScheduler,
} from "@perfidia/gateway/seat";
import {
  LOG_FORMAT,
  type Action,
  type Briefing,
  type ClockSpec,
  type DomainEvent,
  type GameTime,
  type JsonObject,
  type LogLine,
  type MatchResult,
  type PlayerId,
  type RoundInput,
  type RoundOutput,
  type SeatAgent,
  type ToolCall,
  type ToolError,
  type ToolResult,
  type TurnEnd,
} from "@perfidia/protocol";
import type { LogSink } from "./sink.ts";
import {
  HostFailure,
  clampWarning,
  copyOf,
  createToolRegistry,
  canonicalBytes,
  internalError,
  invokeTool,
  isFatal,
  jsonData,
  warningText,
  type ToolEnv,
  type ToolRegistry,
} from "./tools.ts";

// The match host (docs/architecture.md §8.7, §9.1): the `ClockHost` the drivers run. It owns the
// engine match, the gateway state, the wake scheduler, the tool registry and the log sink, and
// writes every line of §10.2 in the order it changes state: `advanceTo` runs the engine step (split
// at snapshot hours, §10.3), writes the `ev` and `ckpt` lines, flushes the sink after checkpoint
// lines (§10.1) and delivers the events; `openTurn` applies a due hand-off (`controller` line),
// opens the wake (`wake` line) and builds the briefing; a turn's `execute` runs the turn gate
// (layer 1 of §7.2) and each call's tool (`act`, `gw`, `obs`, `note` lines); `close` writes the
// `turn` line; `defer` and `logBatch` write theirs. Everything handed to an agent is a canonical
// copy (§6.6).

/** A seat handed to another controller (§8.7): applied when its first turn at or after `at` opens. */
export interface Handoff {
  readonly seat: PlayerId;
  readonly at: GameTime;
  readonly label: string;
  readonly agent: SeatAgent;
}

/** Wall time for the informational `wall*` keys (injected by `sim`; absent in tests). */
export interface WallSource {
  nowMs(): number;
  iso(): string;
}

/** A call failed inside the gateway (`INTERNAL`) while the host runs in strict mode (§7.3): fatal. */
export class GatewayInternalError extends Error {
  readonly seat: PlayerId;
  readonly tool: string;

  constructor(seat: PlayerId, tool: string, error: string) {
    super(`${seat}: ${tool} failed inside the gateway (INTERNAL): ${error}`);
    this.name = "GatewayInternalError";
    this.seat = seat;
    this.tool = tool;
  }
}

/** Wakes of one seat on one game day, by class (§12.2), and the turns the per-second cap deferred. */
export interface WakeCounts {
  urgent: number;
  own: number;
  social: number;
  safety: number;
  start: number;
  deferred: number;
}

export interface HostStats {
  turns: number;
  calls: number;
  engineEvents: number;
  /** Per seat, per game day. */
  wakes: Record<PlayerId, WakeCounts[]>;
}

export interface MatchHostOptions {
  /** A match created and not advanced yet: the header's `initialHash` is its hash. */
  readonly match: Match;
  readonly sink: LogSink;
  /** The seats' agents; a hand-off replaces an entry, so drivers must read this very map. */
  readonly agents: Map<PlayerId, SeatAgent>;
  /** The clock spec recorded in the header. */
  readonly clock: ClockSpec;
  readonly handoffs?: readonly Handoff[];
  readonly wall?: WallSource;
  /** Snapshot every this many game hours, at checkpoints; 0 = the final one only. Default 24. */
  readonly snapshotEvery?: number;
  /** `INTERNAL` is fatal (tests). */
  readonly strict?: boolean;
  /** The tool registry (default `createToolRegistry(match.ruleset)`); tests pass doubles. */
  readonly tools?: ToolRegistry;
}

/** The `ev` and `ckpt` lines of an engine step, in the order of §10.2. */
function stepLines(out: StepOutput): LogLine[] {
  const lines: LogLine[] = [];
  let i = 0;
  for (const c of out.checkpoints) {
    for (; i < out.events.length && (out.events[i]?.t ?? Infinity) <= c.t; i += 1) {
      const e = out.events[i];
      if (e !== undefined) lines.push({ k: "ev", t: e.t, e });
    }
    lines.push({ k: "ckpt", t: c.t, hour: c.hour, h: c.h });
  }
  for (; i < out.events.length; i += 1) {
    const e = out.events[i];
    if (e !== undefined) lines.push({ k: "ev", t: e.t, e });
  }
  return lines;
}

export class MatchHost implements ClockHost {
  readonly match: Match;
  readonly gw: GatewayState;
  readonly wake: WakeScheduler;
  readonly tools: ToolRegistry;
  readonly seed: number;
  readonly endsAt: GameTime;
  readonly strict: boolean;
  private readonly sink: LogSink;
  private readonly agents: Map<PlayerId, SeatAgent>;
  private readonly clock: ClockSpec;
  private readonly wall: WallSource | undefined;
  private readonly every: number;
  private readonly pending: Handoff[];
  private readonly counts: HostStats;
  private n = 0;
  private lastSnapHour = 0;
  private started = false;
  private finished = false;

  constructor(o: MatchHostOptions) {
    this.match = o.match;
    this.sink = o.sink;
    this.agents = o.agents;
    this.clock = o.clock;
    this.wall = o.wall;
    this.strict = o.strict ?? false;
    this.every = o.snapshotEvery ?? 24;
    if (!Number.isSafeInteger(this.every) || this.every < 0) {
      throw new Error(`snapshotEvery must be an integer ≥ 0, got ${this.every}`);
    }
    this.seed = o.match.setup.seed;
    this.endsAt = o.match.rules.time.matchEnd;
    const seats = o.match.setup.seats.map((s) => s.id);
    this.gw = createGatewayState(seats);
    this.wake = createWakeScheduler(this.gw, gatewayRulesCopy(o.match.rules.gateway));
    this.tools = o.tools ?? createToolRegistry(o.match.ruleset);
    for (const seat of seats) {
      const label = o.agents.get(seat)?.label;
      if (typeof label !== "string" || label === "") {
        throw new Error(`seat ${seat} has no agent with a label`);
      }
    }
    this.pending = (o.handoffs ?? [])
      .map((h, i) => ({ h, i }))
      .toSorted((a, b) => a.h.at - b.h.at || a.i - b.i)
      .map(({ h }) => h);
    for (const h of this.pending) {
      if (!seats.includes(h.seat)) throw new Error(`hand-off to ${h.seat}, which is not a seat`);
      if (!Number.isSafeInteger(h.at) || h.at < 0) {
        throw new Error(`hand-off of ${h.seat} at ${h.at}: a game time is an integer ≥ 0`);
      }
      if (h.label === "") throw new Error(`hand-off of ${h.seat}: the label is empty`);
    }
    const days = Math.max(1, Math.ceil(this.endsAt / DAY));
    const wakes: Record<PlayerId, WakeCounts[]> = {};
    for (const seat of seats) {
      wakes[seat] = Array.from({ length: days }, () => ({
        urgent: 0,
        own: 0,
        social: 0,
        safety: 0,
        start: 0,
        deferred: 0,
      }));
    }
    this.counts = { turns: 0, calls: 0, engineEvents: 0, wakes };
  }

  // Lines ----------------------------------------------------------------------------------------

  private write(line: LogLine): void {
    try {
      // The sink gets its own copy (§6.6, P16): the host goes on using the line's objects (the
      // events it delivers, the act and gw lines it records), which a sink must not be able to change.
      this.sink.write(copyOf(line));
    } catch (e) {
      throw new HostFailure(`the log sink failed on a ${line.k} line`, e);
    }
  }

  private nextN(): number {
    this.n += 1;
    return this.n;
  }

  /** The `n` of the last numbered line written (0 when none). */
  get lastN(): number {
    return this.n;
  }

  // ClockHost ------------------------------------------------------------------------------------

  now(): GameTime {
    return this.match.now;
  }

  ended(): boolean {
    return this.match.ended;
  }

  start(): void {
    if (this.started) throw new Error("start() called twice");
    const m = this.match;
    const controllers: Record<string, string> = {};
    for (const seat of m.setup.seats) controllers[seat.id] = this.agents.get(seat.id)?.label ?? "";
    const header: LogLine = {
      k: "header",
      format: LOG_FORMAT,
      engine: ENGINE_VERSION,
      setup: copyOf(m.setup),
      config: jsonData(m.config),
      configHash: m.configHash,
      rulesHash: m.rulesHash,
      controllers,
      clock: copyOf(this.clock),
      initialHash: m.hash(),
    };
    if (this.wall !== undefined) header.wallStart = this.wall.iso();
    this.write(header);
    this.started = true;
    this.advanceTo(0);
  }

  advanceTo(t: GameTime): void {
    this.assertRunning("advanceTo");
    const m = this.match;
    while (this.every > 0 && !m.ended) {
      const hour = this.lastSnapHour + this.every;
      const at = hour * HOUR;
      if (at > t) break;
      this.step(at);
      if (!m.ended) this.takeSnapshot();
      this.lastSnapHour = hour;
    }
    if (!m.ended) this.step(t);
  }

  private step(t: GameTime): void {
    const out = this.match.advanceTo(t);
    for (const line of stepLines(out)) this.write(line);
    // A file sink holds whole hours: a killed run keeps every line up to its last checkpoint, and
    // a snapshot file never exists without its `ckpt` line on disk (§10.1, §10.3).
    if (out.checkpoints.length > 0) this.flush();
    this.deliver(out.events);
  }

  private deliver(events: readonly DomainEvent[]): void {
    if (events.length === 0) return;
    deliver(this.gw, events, this.wake);
    this.counts.engineEvents += events.length;
  }

  private takeSnapshot(): void {
    const snap = this.match.snapshot(this.n);
    try {
      this.sink.snapshot?.(snap);
    } catch (e) {
      throw new HostFailure("the log sink failed on a snapshot", e);
    }
  }

  nextTime(): GameTime | null {
    if (this.match.ended) return null;
    const event = this.match.nextEventTime();
    const wake = this.wake.nextWakeTime();
    if (event === null) return wake;
    return wake === null ? event : Math.min(event, wake);
  }

  dueSeats(t: GameTime): PlayerId[] {
    if (this.match.ended) return [];
    return this.wake.due(t);
  }

  openTurn(seat: PlayerId): TurnHandle {
    this.assertRunning("openTurn");
    const t = this.match.now;
    this.applyHandoffs(seat, t);
    const rec = this.wake.begin(seat, t);
    const s = seatOf(this.gw, seat);
    this.write({
      k: "wake",
      t,
      seat,
      turn: s.turns,
      reasons: [...rec.reasons],
      urgent: rec.urgent,
      charge: rec.charge,
      day: rec.day,
      used: { own: rec.used.own, social: rec.used.social },
    });
    this.countWake(seat, rec);
    const briefing = copyOf(buildBriefing(this.match.read(), seat, this.gw, rec));
    briefed(this.gw, seat, t);
    this.counts.turns += 1;
    return new HostTurn(this, seat, s.turns, briefing, this.wall?.nowMs());
  }

  logBatch(t: GameTime, b: number, order: readonly PlayerId[]): void {
    this.assertRunning("logBatch");
    this.write({ k: "batch", t, b, order: [...order] });
  }

  defer(seat: PlayerId, to: GameTime): void {
    this.assertRunning("defer");
    this.wake.defer(seat, to);
    const t = this.match.now;
    this.write({ k: "defer", t, seat, to });
    this.dayCounts(seat, t).deferred += 1;
  }

  finish(): MatchResult {
    this.assertRunning("finish");
    const m = this.match;
    const result = m.result;
    if (result === null) throw new Error("finish() before the match ended");
    this.write({ k: "end", t: m.now, h: m.hash(), result });
    // Nothing may follow the end line, not even a fatal line for a failing snapshot or flush.
    this.finished = true;
    // The end line is durable before the final snapshot exists, as each ckpt line is before its own.
    this.flush();
    this.takeSnapshot();
    this.flush();
    return result;
  }

  /**
   * The `fatal` line of an error that aborts the match (§8.7), then a flush; never throws. Nothing
   * is written before the header or after the end line.
   */
  fatal(error: unknown, kind: "invariant" | "engine" | "driver" | "agent", message: string): void {
    if (!this.started || this.finished) return;
    let t = 0;
    try {
      t = this.match.now;
    } catch {
      // the match's state is unreadable: the line keeps t = 0
    }
    let details: JsonObject | undefined;
    if (
      error !== null &&
      typeof error === "object" &&
      "details" in error &&
      typeof error.details === "object"
    ) {
      try {
        details = jsonData(error.details);
      } catch {
        details = undefined;
      }
    }
    try {
      this.sink.write({
        k: "fatal",
        t,
        error: details === undefined ? { kind, message } : { kind, message, details },
      });
      this.flush();
    } catch {
      // a sink that cannot write the fatal line cannot write anything else either
    } finally {
      this.finished = true;
    }
  }

  private flush(): void {
    try {
      this.sink.flush?.();
    } catch (e) {
      throw new HostFailure("the log sink failed to flush", e);
    }
  }

  private assertRunning(what: string): void {
    if (!this.started) throw new Error(`${what}() before start()`);
    if (this.finished) throw new Error(`${what}() after the match finished`);
  }

  // Hand-offs and statistics ----------------------------------------------------------------------

  private applyHandoffs(seat: PlayerId, t: GameTime): void {
    for (let i = 0; i < this.pending.length;) {
      const h = this.pending[i];
      if (h === undefined || h.seat !== seat || h.at > t) {
        i += 1;
        continue;
      }
      this.pending.splice(i, 1);
      this.agents.set(seat, h.agent);
      this.write({ k: "controller", t, seat, label: h.label });
    }
  }

  private dayCounts(seat: PlayerId, t: GameTime): WakeCounts {
    const days = this.counts.wakes[seat];
    if (days === undefined) throw new Error(`no statistics for ${seat}`);
    const day = Math.floor(t / DAY);
    while (days.length <= day) {
      days.push({ urgent: 0, own: 0, social: 0, safety: 0, start: 0, deferred: 0 });
    }
    const counts = days[day];
    if (counts === undefined) throw new Error(`no statistics for ${seat} on day ${day}`);
    return counts;
  }

  private countWake(seat: PlayerId, rec: WakeRecord): void {
    const c = this.dayCounts(seat, this.match.now);
    if (rec.reasons.includes("start")) c.start += 1;
    else if (rec.urgent) c.urgent += 1;
    else if (rec.charge === "own") c.own += 1;
    else if (rec.charge === "social") c.social += 1;
    else c.safety += 1;
  }

  /** Counters so far (a copy). */
  stats(): HostStats {
    return copyOf(this.counts);
  }

  // Turns (called by HostTurn) -------------------------------------------------------------------

  /** Whether `seat` is still alive in the engine (an eliminated seat's calls get `ELIMINATED`). */
  isAlive(seat: PlayerId): boolean {
    const players = this.match.read().state.players;
    return Object.hasOwn(players, seat) && players[seat]?.alive === true;
  }

  /** Layer 1 of §7.2: the turn gate, before the call's tool runs; `null` when the call may run. */
  gate(turn: HostTurn, used: { round: number; wake: number }): ToolError | null {
    const m = this.match;
    const t = m.now;
    const env = { r: m.read(), seat: turn.seat, gw: this.gw };
    if (turn.endTurnSeen) return toolError({ code: "TURN_OVER", details: {} }, env);
    if (m.ended || t >= m.rules.time.matchEnd) {
      return toolError({ code: "MATCH_ENDED", details: { matchEnd: m.rules.time.matchEnd } }, env);
    }
    const player = env.r.state.players[turn.seat];
    if (player === undefined || !player.alive) {
      const details = { player: turn.seat, eliminatedAt: player?.eliminatedAt ?? null };
      return toolError({ code: "ELIMINATED", details }, env);
    }
    return checkRoundTrip(this.wake.rules, turn.round, t) ?? checkCallCap(this.wake.rules, used, t);
  }

  /**
   * One call of `turn`: the turn gate (layer 1), then its tool (layers 2–6) and the `gw` or `obs`
   * line it needs. A gateway error thrown by the gate or by a tool before the call changed anything
   * is `INTERNAL` (§7.3): a `gw` line with the error, fatal in strict mode. `ran` says whether the
   * call passed the gate (and counts against the round's and the wake's call caps).
   */
  runCall(
    turn: HostTurn,
    call: ToolCall,
    index: number,
    used: { round: number; wake: number },
  ): { readonly result: ToolResult; readonly ran: boolean } {
    let rejected: ToolError | null;
    try {
      rejected = this.gate(turn, used);
    } catch (e) {
      if (isFatal(e)) throw e;
      return { result: this.internal(turn, call.tool, describeError(e)), ran: false };
    }
    if (rejected !== null) {
      this.writeGw(turn, call.tool, rejected);
      return { result: copyOf(rejected), ran: false };
    }
    const env: ToolEnv = {
      match: this.match,
      seat: turn.seat,
      gw: this.gw,
      gatewayRules: this.wake.rules,
      turn: { index: turn.turn, round: turn.round, call: index },
      submit: (a, i) => this.submit(turn, call.tool, a, i),
      rejectItem: (i, error) => this.writeGw(turn, call.tool, error, { i }),
      note: (mode, text) => this.writeNote(turn, mode, text),
      endTurn: (wakeAt) => {
        const set =
          wakeAt === null ? null : this.wake.requestSelfWake(turn.seat, wakeAt, this.match.now);
        if (wakeAt !== null && set !== null && set.clamped) {
          turn.clamp = { requested: Math.min(wakeAt, Number.MAX_SAFE_INTEGER), at: set.at };
        }
        turn.markEndTurn();
        return set;
      },
    };
    const out = invokeTool(this.tools, env, call);
    if (out.line === "obs") {
      this.write({
        k: "obs",
        n: this.nextN(),
        t: this.match.now,
        seat: turn.seat,
        turn: turn.turn,
        rt: turn.round,
        tool: call.tool,
        args: out.args ?? {},
        bytes: canonicalBytes(out.result),
      });
    } else if (out.line === "gw") {
      this.writeGw(
        turn,
        call.tool,
        out.result,
        out.error === undefined ? {} : { error: out.error },
      );
      if (out.error !== undefined && this.strict) {
        throw new GatewayInternalError(turn.seat, call.tool, out.error);
      }
    }
    return { result: out.result, ran: true };
  }

  /** `INTERNAL` for a call whose gateway code threw: its `gw` line with the error; fatal in strict mode. */
  private internal(turn: HostTurn, tool: string, error: string): ToolResult {
    const result = internalError(this.match, turn.seat, this.gw);
    this.writeGw(turn, tool, result, { error });
    if (this.strict) throw new GatewayInternalError(turn.seat, tool, error);
    return copyOf(result);
  }

  /**
   * The `gw` line of a call the gateway rejected (or `INTERNAL`, with `error`), or of batch item
   * `i` that never reached the engine, and its turn bookkeeping. Once the line is written, a
   * failure to record it is a `HostFailure`: the log already holds the line.
   */
  private writeGw(
    turn: HostTurn,
    tool: string,
    result: ToolResult,
    o: { readonly error?: string; readonly i?: number } = {},
  ): void {
    if (result.ok) throw new HostFailure(`writeGw: ${turn.seat}'s ${tool} call succeeded`);
    const details = result.details;
    const line: LogLine = {
      k: "gw",
      n: this.nextN(),
      t: this.match.now,
      seat: turn.seat,
      turn: turn.turn,
      rt: turn.round,
      tool,
      r:
        details === undefined || Object.keys(details).length === 0
          ? { ok: false, code: result.code }
          : { ok: false, code: result.code, details: { ...details } },
    };
    if (o.i !== undefined) line.i = o.i;
    if (o.error !== undefined) line.error = o.error;
    this.write(line);
    try {
      recordGw(this.gw, line, result.message);
    } catch (e) {
      throw new HostFailure(`recording ${turn.seat}'s ${tool} rejection failed`, e);
    }
  }

  /** `ToolEnv.submit`: one engine action, its `act` line, then the `ev` lines and delivery of its events. */
  private submit(turn: HostTurn, tool: string, a: Action, i: number): ApplyOutput {
    const m = this.match;
    const out = m.apply(turn.seat, a);
    try {
      let message: string | null = null;
      if (!out.ok) {
        try {
          message = explain(out.violation, { r: m.read(), seat: turn.seat, gw: this.gw }).message;
        } catch {
          message = null;
        }
      }
      const line: LogLine = {
        k: "act",
        n: this.nextN(),
        t: m.now,
        seat: turn.seat,
        turn: turn.turn,
        rt: turn.round,
        tool,
        i,
        a: copyOf(a),
        r: out.ok ? { ok: true } : { ok: false, code: out.violation.code },
      };
      this.write(line);
      const env = { r: m.read(), seat: turn.seat, gw: this.gw };
      const warnings = out.ok ? out.warnings.map((w) => warningText(w, env)) : [];
      recordAct(this.gw, line, message, warnings);
      if (out.ok) {
        for (const e of out.events) this.write({ k: "ev", t: e.t, e });
        this.deliver(out.events);
      }
    } catch (e) {
      if (e instanceof HostFailure) throw e;
      throw new HostFailure(`recording ${turn.seat}'s ${tool} action failed`, e);
    }
    return out;
  }

  /** `ToolEnv.note`: the `note` line of an accepted `write_note`. */
  private writeNote(turn: HostTurn, mode: "append" | "replace", text: string): void {
    this.write({
      k: "note",
      n: this.nextN(),
      t: this.match.now,
      seat: turn.seat,
      turn: turn.turn,
      mode,
      text,
    });
  }

  /**
   * Closes `turn`: its `end_turn` clamp as a warning of the last round, the scheduler's end,
   * `lastTurn`, then the `turn` line (with the clamp, so the rebuild records the same warning).
   */
  closeTurnOf(turn: HostTurn, why: TurnEnd, error: string | undefined): void {
    const m = this.match;
    const t = m.now;
    const s = seatOf(this.gw, turn.seat);
    const clamp = turn.clamp;
    if (clamp !== undefined) {
      const env = { r: m.read(), seat: turn.seat, gw: this.gw };
      recordWarnings(this.gw, turn.seat, turn.round - 1, "end_turn", [
        warningText(clampWarning(clamp), env),
      ]);
    }
    const out = closeTurn(this.gw, this.wake, {
      t,
      seat: turn.seat,
      why,
      rounds: turn.round,
      selfAt: s.wake.selfAt,
      ...(m.ended ? { next: null } : {}),
    });
    const line: LogLine = {
      k: "turn",
      t,
      seat: turn.seat,
      turn: turn.turn,
      rounds: turn.round,
      calls: turn.calls,
      why,
      selfAt: out.selfAt,
      next: out.next,
    };
    if (clamp !== undefined) line.clamp = { requested: clamp.requested, at: clamp.at };
    if (turn.thought !== undefined) line.thought = turn.thought;
    if (error !== undefined) line.error = error;
    if (this.wall !== undefined && turn.wallStart !== undefined) {
      line.wallMs = Math.max(0, this.wall.nowMs() - turn.wallStart);
    }
    this.write(line);
    this.counts.calls += turn.calls;
  }
}

/** One open turn (§9.1): the rounds of a seat between its `wake` line and its `turn` line. */
export class HostTurn implements TurnHandle {
  readonly seat: PlayerId;
  /** The seat's turn number, from 1. */
  readonly turn: number;
  readonly wallStart: number | undefined;
  private readonly host: MatchHost;
  private readonly briefing: Briefing;
  /** Rounds executed. */
  round = 0;
  /** Calls received, rejected ones included. */
  calls = 0;
  thought: string | undefined;
  /** `end_turn` ran in the current round: later calls of the round get `TURN_OVER`. */
  endTurnSeen = false;
  /** The self-wake `end_turn` asked for and the one it got, when it was clamped. */
  clamp: { readonly requested: number; readonly at: number } | undefined;
  private results: ToolResult[] = [];
  /** Calls of this turn that passed the gate (the per-wake call cap). */
  private run = 0;
  private ending: TurnEnd | null = null;
  private closed = false;

  constructor(
    host: MatchHost,
    seat: PlayerId,
    turn: number,
    briefing: Briefing,
    wallStart: number | undefined,
  ) {
    this.host = host;
    this.seat = seat;
    this.turn = turn;
    this.briefing = briefing;
    this.wallStart = wallStart;
  }

  private get maxRounds(): number {
    return this.host.wake.rules.roundTripsPerWake;
  }

  get done(): boolean {
    return (
      this.closed ||
      this.ending !== null ||
      this.round >= this.maxRounds ||
      this.host.match.ended ||
      !this.host.isAlive(this.seat)
    );
  }

  input(): RoundInput {
    if (this.closed) throw new Error(`${this.seat}: input() on a closed turn`);
    return copyOf({
      seat: this.seat,
      turn: this.turn,
      round: this.round,
      maxRounds: this.maxRounds,
      maxCalls: roundCallCap(this.host.wake.rules, this.run),
      briefing: this.briefing,
      results: this.results,
    });
  }

  markEndTurn(): void {
    this.endTurnSeen = true;
  }

  execute(out: RoundOutput): void {
    if (this.closed) throw new Error(`${this.seat}: execute() on a closed turn`);
    if (this.ending !== null || this.round >= this.maxRounds) {
      throw new Error(
        `${this.seat}: execute() after the turn ended (${this.ending ?? "round_cap"})`,
      );
    }
    const results: ToolResult[] = [];
    let ranThisRound = 0;
    for (const [index, call] of out.calls.entries()) {
      this.calls += 1;
      const done = this.host.runCall(this, call, index, { round: ranThisRound, wake: this.run });
      if (done.ran) {
        ranThisRound += 1;
        this.run += 1;
      }
      results.push(done.result);
    }
    if (out.thought !== undefined) this.thought = out.thought;
    this.results = results;
    this.round += 1;
    if (this.endTurnSeen) this.ending = "end_turn";
    else if (out.calls.length === 0) this.ending = "empty_round";
  }

  close(failure?: AgentFailure): void {
    if (this.closed) throw new Error(`${this.seat}: close() called twice`);
    let why: TurnEnd;
    if (failure !== undefined) why = failure.cause;
    else if (this.ending !== null) why = this.ending;
    else if (this.round >= this.maxRounds) why = "round_cap";
    else if (!this.host.isAlive(this.seat)) why = "eliminated";
    else if (this.host.match.ended) why = "match_ended";
    else throw new Error(`${this.seat}: close() on a turn that is not done`);
    this.closed = true;
    this.host.closeTurnOf(this, why, failure?.error);
  }
}
