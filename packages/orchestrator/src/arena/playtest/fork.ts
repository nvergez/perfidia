import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMatch, findRuleset, type AnyRuleset } from "@perfidia/engine";
import { DAY, canonicalJson, fmtTime, sha256Hex } from "@perfidia/engine/core";
import { createLockstepDriver, type ClockHost, type TurnHandle } from "@perfidia/gateway/clock";
import { buildBriefing } from "@perfidia/gateway/present";
import { sortedSeats, type WakeRecord } from "@perfidia/gateway/seat";
import { HostTurn, MatchHost, createGatewayFold, type LogSink } from "@perfidia/gateway/runtime";
import {
  LogLineSchema,
  type DomainEvent,
  type HeaderLine,
  type LogLine,
  type MatchResult,
  type PlayerId,
  type SeatAgent,
  type WakeLine,
} from "@perfidia/protocol";

// The fork of a playtest (`arena playtest`): a run's match state rebuilt at one LLM seat's turn,
// from its `match.jsonl` alone, as a live `MatchHost` that plays on. The run directory is only
// read.
//
// - The log is replayed line by line on a fresh engine (the Level E replay: every event, checkpoint
//   and act result is checked against the log) and folded into the host's own gateway state with
//   the gateway's rebuild fold (`createGatewayFold`), so the host is exactly the live host of the
//   run at the cut, but for its line numbers, its counters and its controllers.
// - The cut is the start of the game second of the target's wake (before its first wake line),
//   when the target opened in the second's first batch: the lockstep driver then replays the
//   whole second, every seat due in it waking as in the run. When the target opened later in its
//   second (a wake in a later batch, or its second turn in the same second), the cut is its wake
//   line itself, and the turns other seats still had open at that line are closed as empty rounds
//   (`closed`): the fork cannot continue a turn another agent was in the middle of.
// - The driver is the gateway's lockstep driver on a view of the host whose `start()` does
//   nothing, so the fork plays on from the cut exactly as a run plays on from a second.

/** A playtest error the command line reports as a usage, config or input problem (exit 3). */
export class PlaytestError extends Error {
  override readonly name = "PlaytestError";
}

/** A run's match log, as read (nothing in the run directory is ever written). */
export interface RunLog {
  readonly dir: string;
  readonly path: string;
  /** sha256 of the file's bytes: a session refuses a run whose log changed. */
  readonly sha256: string;
  /** The canonical JSON of each line, as the file holds it. */
  readonly texts: readonly string[];
  readonly lines: readonly LogLine[];
  readonly header: HeaderLine;
}

export function readRunLog(dir: string): RunLog {
  const path = join(dir, "match.jsonl");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new PlaytestError(`${dir}: no match.jsonl (not a run directory)`);
  }
  const texts = text.split("\n").filter((l) => l !== "");
  const lines = texts.map((l, i) => {
    const parsed = LogLineSchema.safeParse(JSON.parse(l));
    if (!parsed.success) throw new PlaytestError(`${path}: line ${i + 1} is not a log line`);
    return parsed.data;
  });
  const header = lines[0];
  if (header?.k !== "header") throw new PlaytestError(`${path}: no header line`);
  return { dir, path, sha256: sha256Hex(text), texts, lines, header };
}

/** Where a playtest starts: a seat's turn number, or its first wake at or after a game time. */
export type AtSpec =
  | { readonly kind: "turn"; readonly turn: number }
  | { readonly kind: "time"; readonly t: number };

/**
 * `--at`: `12` or `turn:12` (the seat's 12th turn), `t:93600` (a game second), or `D2 02:00`,
 * `D2T02:00`, `D2-02:00:30` (a game time as the briefings write it).
 */
export function parseAt(text: string): AtSpec {
  const s = text.trim();
  const turn = /^(?:turn[:=]?)?(\d{1,7})$/i.exec(s);
  if (turn !== null) return { kind: "turn", turn: Number(turn[1]) };
  const t = /^t[:=](\d{1,9})$/i.exec(s);
  if (t !== null) return { kind: "time", t: Number(t[1]) };
  const d = /^D(\d{1,4})[ T_-]?(\d{1,2}):(\d{2})(?::(\d{2}))?$/i.exec(s);
  if (d !== null) {
    const [day, h, m, sec] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(d[4] ?? "0")];
    if (day >= 1 && h < 24 && m < 60 && sec < 60) {
      return { kind: "time", t: (day - 1) * DAY + h * 3600 + m * 60 + sec };
    }
  }
  throw new PlaytestError(
    `--at must be a turn number (12, turn:12), a game second (t:93600) or a game time (D2 02:00), got "${text}"`,
  );
}

/** The turn a playtest opens, and where the fork cuts the log. */
export interface Target {
  readonly seat: PlayerId;
  readonly turn: number;
  readonly t: number;
  /** Index of the turn's wake line in the log (the header is line 0). */
  readonly wakeIndex: number;
  /** Index of the first line the fork does not replay. */
  readonly cut: number;
  /** `second`: the cut is the start of the wake's second; `mid-second`: the wake line itself. */
  readonly mode: "second" | "mid-second";
  /** The controller of the seat at the turn (an `llm:` label). */
  readonly controller: string;
}

const isWake = (l: LogLine, seat: PlayerId): l is WakeLine => l.k === "wake" && l.seat === seat;

/** The turn `at` names for `seat`, checked to be an LLM seat's turn; throws a `PlaytestError`. */
export function findTarget(run: RunLog, seat: PlayerId, at: AtSpec): Target {
  const { lines, header } = run;
  if (!Object.hasOwn(header.controllers, seat)) {
    throw new PlaytestError(
      `${seat} is not a seat of this run (${Object.keys(header.controllers).join(", ")})`,
    );
  }
  const wakes: { line: WakeLine; index: number }[] = [];
  for (const [index, line] of lines.entries()) if (isWake(line, seat)) wakes.push({ line, index });
  const last = wakes.at(-1)?.line;
  const range =
    last === undefined
      ? "it has no turn in this log"
      : `its turns are 1..${last.turn}, from D1 00:00 to ${fmtTime(last.t)}`;
  const found =
    at.kind === "turn"
      ? wakes.find((w) => w.line.turn === at.turn)
      : wakes.find((w) => w.line.t >= at.t);
  if (found === undefined) {
    const what = at.kind === "turn" ? `turn ${at.turn}` : `a turn at or after ${fmtTime(at.t)}`;
    throw new PlaytestError(`${seat} has no ${what} in this log (${range})`);
  }
  const { line: wake, index: wakeIndex } = found;
  let controller = header.controllers[seat] ?? "";
  for (const l of lines.slice(0, wakeIndex)) {
    if (l.k === "controller" && l.seat === seat) controller = l.label;
  }
  if (!controller.startsWith("llm:")) {
    throw new PlaytestError(
      `${seat}'s turn ${wake.turn} is played by ${controller}, not by an LLM seat: playtest an LLM seat's turn (one before its hand-off, if it had one)`,
    );
  }
  // The second's play begins with its first line that is neither an event nor a checkpoint.
  let start = wakeIndex;
  while (start > 0) {
    const prev = lines[start - 1];
    if (prev === undefined || prev.k === "header" || prev.t !== wake.t) break;
    if (prev.k === "ev" || prev.k === "ckpt") break;
    start -= 1;
  }
  // Only wake and controller lines of other seats between the second's start and the wake: the
  // target opened in the second's first batch, and the driver can replay the whole second.
  const clean = lines
    .slice(start, wakeIndex)
    .every((l) => (l.k === "wake" || l.k === "controller") && l.seat !== seat);
  return {
    seat,
    turn: wake.turn,
    t: wake.t,
    wakeIndex,
    cut: clean ? start : wakeIndex,
    mode: clean ? "second" : "mid-second",
    controller,
  };
}

/** The fork's own log: canonical lines in memory, with a hook on every line (the session's stops). */
export class ForkSink implements LogSink {
  readonly lines: string[] = [];
  onLine: ((line: LogLine, text: string) => void) | null = null;

  write(line: LogLine): void {
    const text = canonicalJson(line);
    this.lines.push(text);
    this.onLine?.(line, text);
  }
}

export interface Fork {
  readonly host: MatchHost;
  readonly sink: ForkSink;
  readonly ruleset: AnyRuleset;
  /** The run's per-second turn cap of a seat (its lockstep clock). */
  readonly maxTurnsPerSecond: number;
  /** Seats whose open turns were closed at a mid-second cut, by player number. */
  readonly closed: readonly PlayerId[];
}

const divergence = (run: RunLog, i: number, expected: string, actual: string): PlaytestError =>
  new PlaytestError(
    `${run.path}: line ${i + 1} does not replay on this build (expected ${expected.slice(0, 200)}; got ${actual.slice(0, 200)}): the log is corrupt or was written by another engine`,
  );

/**
 * The run's state at `target.cut`, as a live host whose agents are `agents` (one per seat). The
 * engine replay and the gateway fold must hold up to the cut, else a `PlaytestError`.
 */
export function forkAt(
  run: RunLog,
  target: Target,
  agents: Map<PlayerId, SeatAgent>,
  sink: ForkSink = new ForkSink(),
): Fork {
  const header = run.header;
  const clock = header.clock;
  if (clock.kind !== "lockstep") {
    throw new PlaytestError(
      `this run's clock is ${clock.kind}: a playtest replays lockstep runs only`,
    );
  }
  const ruleset = findRuleset(header.setup.ruleset);
  if (ruleset === undefined) {
    throw new PlaytestError(`the run's ruleset ${header.setup.ruleset} is not in this build`);
  }
  const match = createMatch(header.setup, ruleset, { invariants: "checkpoint" });
  if (
    match.hash() !== header.initialHash ||
    match.configHash !== header.configHash ||
    match.rulesHash !== header.rulesHash
  ) {
    throw new PlaytestError(
      `the run's header does not match this build's ${header.setup.ruleset} (initial, config or rules hash)`,
    );
  }
  const host = new MatchHost({ match, sink, agents, clock: header.clock, snapshotEvery: 0 });
  host.start();
  // The host's start lines (the second 0 before any turn) are the log's own.
  const first = sink.lines.length;
  for (let i = 1; i < first; i += 1) {
    const mine = sink.lines[i] ?? "";
    const theirs = run.texts[i] ?? "";
    if (mine !== theirs) throw divergence(run, i, theirs, mine);
  }
  if (target.cut < first)
    throw new PlaytestError(`the cut (line ${target.cut + 1}) is in the log's start`);
  const fold = createGatewayFold({ gw: host.gw, index: first - 1 });
  const events: DomainEvent[] = [];
  const checkpoints: { readonly hour: number; readonly h: string }[] = [];
  const caughtUp = (i: number): void => {
    const e = events[0];
    const c = checkpoints[0];
    if (e !== undefined) throw divergence(run, i, `no pending event`, canonicalJson(e));
    if (c !== undefined) throw divergence(run, i, `no pending checkpoint`, `hour ${c.hour}`);
  };
  for (let i = first; i < target.cut; i += 1) {
    const line = run.lines[i];
    if (line === undefined || line.k === "header" || line.k === "end" || line.k === "fatal") {
      throw divergence(run, i, "a line of a running match", line?.k ?? "nothing");
    }
    const out = match.advanceTo(line.t);
    events.push(...out.events);
    checkpoints.push(...out.checkpoints);
    let applied: ReturnType<typeof match.apply> | undefined;
    switch (line.k) {
      case "ev": {
        const e = events.shift();
        const theirs = canonicalJson(line.e);
        const mine = e === undefined ? "no event" : canonicalJson(e);
        if (mine !== theirs) throw divergence(run, i, theirs, mine);
        break;
      }
      case "ckpt": {
        const c = checkpoints.shift();
        if (c === undefined || c.hour !== line.hour || c.h !== line.h) {
          throw divergence(
            run,
            i,
            `hour ${line.hour}: ${line.h}`,
            c === undefined ? "no checkpoint" : `hour ${c.hour}: ${c.h}`,
          );
        }
        break;
      }
      case "act": {
        caughtUp(i);
        applied = match.apply(line.seat, line.a);
        const mine = canonicalJson(
          applied.ok ? { ok: true } : { ok: false, code: applied.violation.code },
        );
        if (mine !== canonicalJson(line.r)) throw divergence(run, i, canonicalJson(line.r), mine);
        if (applied.ok) events.push(...applied.events);
        break;
      }
      case "wake":
      case "batch":
      case "defer":
      case "controller":
        caughtUp(i);
        break;
      case "gw":
      case "obs":
      case "note":
      case "turn":
        break;
    }
    fold.line(line, match.read(), applied);
    const drift = fold.drift;
    if (drift !== null) {
      throw divergence(run, drift.index, drift.expected, `the gateway fold: ${drift.actual}`);
    }
  }
  caughtUp(target.cut);
  // The second of the cut: nothing of it is left to replay in the engine.
  const before = sink.lines.length;
  host.advanceTo(target.t);
  if (sink.lines.length !== before) {
    throw divergence(
      run,
      target.cut,
      "no engine line before the cut's turn",
      sink.lines.at(-1) ?? "",
    );
  }
  const closed: PlayerId[] = [];
  if (target.mode === "mid-second") {
    for (const s of sortedSeats(host.gw)) {
      if (!s.wake.inTurn || s.seat === target.seat) continue;
      const wake = lastWake(run, s.seat, target.cut);
      if (wake === undefined) throw divergence(run, target.cut, `${s.seat}'s wake line`, "none");
      const rec: WakeRecord = {
        reasons: [...wake.reasons],
        urgent: wake.urgent,
        charge: wake.charge,
        day: wake.day,
        used: { own: wake.used.own, social: wake.used.social },
      };
      const turn = new HostTurn(
        host,
        s.seat,
        wake.turn,
        buildBriefing(match.read(), s.seat, host.gw, rec),
        undefined,
      );
      turn.execute({ calls: [] });
      turn.close();
      closed.push(s.seat);
    }
  }
  return { host, sink, ruleset, maxTurnsPerSecond: clock.maxTurnsPerSecond, closed };
}

function lastWake(run: RunLog, seat: PlayerId, before: number): WakeLine | undefined {
  for (let i = before - 1; i >= 0; i -= 1) {
    const l = run.lines[i];
    if (l !== undefined && isWake(l, seat)) return l;
  }
  return undefined;
}

/**
 * Plays the fork on from its cut with the gateway's lockstep driver (`maxTurnsPerSecond` from the
 * run's header); `openTurn` wraps each turn handle the driver gets (the session watches its seat's).
 * Resolves with the match result if the match ends; never settles while an agent never answers.
 */
export function playOn(
  fork: Fork,
  agents: ReadonlyMap<PlayerId, SeatAgent>,
  openTurn: (seat: PlayerId, handle: TurnHandle) => TurnHandle,
): Promise<MatchResult> {
  const host = fork.host;
  const view: ClockHost = {
    seed: host.seed,
    endsAt: host.endsAt,
    now: () => host.now(),
    ended: () => host.ended(),
    start: () => undefined,
    advanceTo: (t) => host.advanceTo(t),
    nextTime: () => host.nextTime(),
    dueSeats: (t) => host.dueSeats(t),
    openTurn: (seat) => openTurn(seat, host.openTurn(seat)),
    logBatch: (t, b, order) => host.logBatch(t, b, order),
    defer: (seat, to) => host.defer(seat, to),
    finish: () => host.finish(),
  };
  return createLockstepDriver({ maxTurnsPerSecond: fork.maxTurnsPerSecond }).run(view, agents);
}
