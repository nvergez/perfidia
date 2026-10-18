import { canonicalJson, HOUR } from "@perfidia/engine/core";
import type { AnyRuleset, DomainModule, ReadCtx } from "@perfidia/engine/contracts";
import type {
  CkptLine,
  DeepReadonly,
  DomainEvent,
  EndLine,
  EvLine,
  GameState,
  GameTime,
  Hash64,
  HeaderLine,
  LogLine,
  Snapshot,
} from "@perfidia/protocol";
import { resolveConfigFull, rulesHashOf } from "./config.ts";
import { EngineMisuse, errorMessage } from "./errors.ts";
import type { InvariantLevel } from "./invariants.ts";
import { createMatch, loadMatch, type ApplyOutput, type Match } from "./match.ts";
import { ENGINE_VERSION } from "./version.ts";

// Level E replay verification (docs/architecture.md §10.4): re-runs the logged actions on a fresh
// engine and compares the config, the compiled rules, the initial hash, every act result, every
// event (in the line order of §10.2), every checkpoint, the result and the final hash. Pure and
// browser-runnable. In a divergence, `expected` is what the log records (or what a complete log
// has) and `actual` what the replay produced. `createReplay` is the incremental form (a log being
// written, line by line, for the spectator fold); `verifyLog` is a loop over it.

export type DivergenceKind =
  | "header"
  | "config"
  | "rules"
  | "snapshot"
  | "initial"
  | "order"
  | "result"
  | "event"
  | "checkpoint"
  | "end";

export interface ReplayDivergence {
  kind: DivergenceKind;
  t: GameTime;
  /** The `n` of the act line concerned: the line itself, or the action that emitted the event. */
  n?: number;
  hour?: number;
  expected: string;
  actual: string;
}

export interface ReplayReport {
  ok: boolean;
  /** Act lines applied. */
  actions: number;
  /** Checkpoints compared with a `ckpt` line. */
  checkpoints: number;
  finalHash: Hash64 | null;
  /** E.g. the log was written by another engine version. */
  warnings: string[];
  divergence?: ReplayDivergence;
}

export interface VerifyOptions {
  invariants?: InvariantLevel;
  /** Resume from this snapshot, right after the `ckpt` line of its hour. */
  from?: Snapshot;
  /** Compare produced events with the `ev` lines (default on). */
  compareEvents?: boolean;
  /** Called at every checkpoint, with the engine exactly in checkpoint state. */
  onCheckpoint?: (hour: number, r: ReadCtx) => void;
  /**
   * Every line in file order, after the engine has processed it; `applied` for act lines. With
   * `from`, only the lines after the snapshot's `ckpt` line.
   */
  onLine?: (line: LogLine, r: ReadCtx, applied?: ApplyOutput) => void;
}

class Diverged extends Error {
  readonly divergence: ReplayDivergence;
  constructor(d: ReplayDivergence) {
    super(`${d.kind} divergence at t = ${d.t}`);
    this.divergence = d;
  }
}

function diverge(d: ReplayDivergence): never {
  throw new Diverged(d);
}

interface Pending {
  readonly e: DomainEvent;
  readonly n?: number;
}

/** Where a divergence is: its kind, time and, when known, the act line's `n` or the hour. */
type Where = Omit<ReplayDivergence, "expected" | "actual">;

function withN(d: Omit<ReplayDivergence, "n">, n: number | undefined): ReplayDivergence {
  return n === undefined ? d : { ...d, n };
}

/**
 * The canonical text of a value read from the log (or a snapshot). Log schemas accept any JSON
 * number, so a non-integer is possible in a corrupted or hand-edited log: it is a divergence at
 * `at`, never a thrown `CanonicalJsonError`.
 */
function logText(value: unknown, what: string, at: Where): string {
  try {
    return canonicalJson(value);
  } catch (error) {
    return diverge({
      ...at,
      expected: `${what} in canonical JSON`,
      actual: `${what}: ${errorMessage(error)}`,
    });
  }
}

function lineN(line: LogLine): number | undefined {
  return line.k === "act" || line.k === "gw" || line.k === "obs" || line.k === "note"
    ? line.n
    : undefined;
}

/** What one pushed line did. */
export interface ReplayStep {
  /** False once the replay has diverged, at this line or an earlier one: nothing more is replayed. */
  readonly ok: boolean;
  /**
   * The engine state may have changed at this line: an act was applied, or at least one scheduled
   * event ran while the engine advanced to the line's time. A world timer that emits nothing (such
   * as perfidia-1's `domination_open`) counts: it moves neither the event hash nor any `ev` line.
   * Checkpoints alone change nothing but `now`.
   */
  readonly changed: boolean;
  /**
   * The events the engine produced at this line, in emission order: the next `ev` lines of the log,
   * this one included when it is an `ev` line at a new time (the same events, when the log holds up).
   */
  readonly events: readonly DomainEvent[];
  /** The engine's verdict on an act line. */
  readonly applied?: ApplyOutput;
}

export interface FinishOptions {
  /** Default true: a log without an end line diverges. False for a log that is still being written. */
  readonly requireEnd?: boolean;
}

/**
 * The incremental Level E replay of one log (§10.4): created from its header, then fed every later
 * line in file order. `verifyLog` is a loop over it. After a divergence nothing more is replayed:
 * `push` returns `ok: false`, and the report names the first divergence.
 */
export interface Replay {
  push(line: LogLine): ReplayStep;
  /** The engine's read view after the last line pushed; throws when no match could be created. */
  read(): ReadCtx;
  /** The first divergence, once there is one. */
  readonly divergence: ReplayDivergence | null;
  /** The end line was replayed. */
  readonly ended: boolean;
  /** Lines given so far, the header included. */
  readonly lines: number;
  /**
   * The engine snapshot right after the last line pushed, which must be the header or a `ckpt`
   * line: `opts.from` of a later replay of the same log resumes there. `EngineMisuse` elsewhere.
   */
  snapshot(): Snapshot;
  /**
   * The report so far. With `requireEnd` (the default) a log without an end line is an `end`
   * divergence, latched like any other; without it, events and checkpoints the engine produced past
   * the last line are not divergences (the log is still being written).
   */
  finish(o?: FinishOptions): ReplayReport;
}

const NOT_OK: ReplayStep = Object.freeze({ ok: false, changed: false, events: [] });

class Replayer implements Replay {
  private readonly report: ReplayReport = {
    ok: true,
    actions: 0,
    checkpoints: 0,
    finalHash: null,
    warnings: [],
  };
  private readonly opts: VerifyOptions;
  private readonly compare: boolean;
  private readonly pending: Pending[] = [];
  private readonly pendingCk: { hour: number; t: GameTime; h: Hash64 }[] = [];
  private match: Match | null = null;
  private state: DeepReadonly<GameState> | null = null;
  /**
   * The last act line, while only its `ev` lines follow it: an `ev` line at its time carries one of
   * its events (§10.2), so a missing event is attributed to its `n`.
   */
  private lastAct: { readonly t: GameTime; readonly n: number } | null = null;
  /** With `opts.from`: skipping the lines up to the `ckpt` line of the snapshot's hour. */
  private skipping = false;
  private skipN = 0;
  private prevT = 0;
  private prevN = 0;
  private lastKind: LogLine["k"] | null = null;
  private diverged: ReplayDivergence | null = null;
  private done = false;
  private count = 0;
  /** What the line being pushed did. */
  private stepEvents: DomainEvent[] = [];
  private stepChanged = false;

  constructor(
    first: LogLine | undefined,
    resolve: (ref: string) => AnyRuleset | undefined,
    domain: DomainModule,
    opts: VerifyOptions,
  ) {
    this.opts = opts;
    this.compare = opts.compareEvents ?? true;
    if (first !== undefined) this.count = 1;
    try {
      if (first === undefined || first.k !== "header") {
        diverge({
          kind: "header",
          t: 0,
          expected: "a header line first",
          actual: first === undefined ? "an empty log" : `a ${first.k} line`,
        });
      }
      const ruleset = this.start(first, resolve, domain);
      const from = opts.from;
      if (from === undefined) this.opts.onLine?.(first, this.m.read());
      else this.skipping = this.loadSnapshot(first, from, ruleset, domain);
    } catch (error) {
      if (!(error instanceof Diverged)) throw error;
      this.latch(error.divergence);
    }
  }

  get divergence(): ReplayDivergence | null {
    return this.diverged;
  }

  get ended(): boolean {
    return this.done;
  }

  get lines(): number {
    return this.count;
  }

  private get m(): Match {
    if (this.match === null) throw new Error("replay: no match");
    return this.match;
  }

  read(): ReadCtx {
    if (this.match === null) {
      throw new EngineMisuse(
        `replay: no match to read (${this.diverged?.kind ?? "header"} divergence)`,
      );
    }
    return this.match.read();
  }

  snapshot(): Snapshot {
    const atCheckpoint =
      this.lastKind === "ckpt" || (this.count === 1 && this.opts.from === undefined);
    if (this.match === null || this.diverged !== null || this.skipping || !atCheckpoint) {
      throw new EngineMisuse(
        "replay.snapshot(): only right after the header or a ckpt line of a replay that holds up",
      );
    }
    return this.match.snapshot(this.prevN);
  }

  push(line: LogLine): ReplayStep {
    this.count += 1;
    if (this.diverged !== null) return NOT_OK;
    const events: DomainEvent[] = [];
    this.stepEvents = events;
    this.stepChanged = false;
    let applied: ApplyOutput | undefined;
    try {
      if (this.skipping) this.skip(line);
      else applied = this.line(line);
    } catch (error) {
      if (!(error instanceof Diverged)) throw error;
      this.latch(error.divergence);
      return { ok: false, changed: this.stepChanged, events };
    }
    this.lastKind = line.k;
    return applied === undefined
      ? { ok: true, changed: this.stepChanged, events }
      : { ok: true, changed: this.stepChanged, events, applied };
  }

  finish(o: FinishOptions = {}): ReplayReport {
    if (this.diverged === null && (o.requireEnd ?? true) && !this.done) {
      const from = this.opts.from;
      this.latch(
        this.skipping && from !== undefined
          ? {
              kind: "snapshot",
              t: from.t,
              hour: from.hour,
              expected: `a ckpt line for hour ${from.hour}`,
              actual: "none before the end of the log",
            }
          : {
              kind: "end",
              t: this.prevT,
              expected: "an end line",
              actual: `the log stops at t = ${this.prevT}`,
            },
      );
    }
    const r = this.report;
    return {
      ok: r.ok,
      actions: r.actions,
      checkpoints: r.checkpoints,
      finalHash: r.finalHash,
      warnings: [...r.warnings],
      ...(r.divergence === undefined ? {} : { divergence: r.divergence }),
    };
  }

  private latch(d: ReplayDivergence): void {
    this.diverged = d;
    this.report.ok = false;
    this.report.finalHash = null;
    this.report.divergence = d;
  }

  /** One line after the header (or after the snapshot's `ckpt` line). */
  private line(line: LogLine): ApplyOutput | undefined {
    if (line.k === "header") {
      diverge({
        kind: "order",
        t: this.prevT,
        expected: "one header line, first",
        actual: "another header line",
      });
    }
    const n = lineN(line);
    if (this.done) {
      diverge(
        withN(
          {
            kind: "order",
            t: line.t,
            expected: "no line after the end line",
            actual: `a ${line.k} line`,
          },
          n,
        ),
      );
    }
    if (line.t < this.prevT) {
      diverge(
        withN(
          {
            kind: "order",
            t: line.t,
            expected: `t ≥ ${this.prevT}`,
            actual: `a ${line.k} line at t = ${line.t}`,
          },
          n,
        ),
      );
    }
    if (n !== undefined) {
      // The host numbers act, gw, obs and note lines without gaps (§10.2): a missing one, which
      // changes no engine state and so no hash, would otherwise go unnoticed.
      if (n !== this.prevN + 1) {
        diverge({
          kind: "order",
          t: line.t,
          n,
          expected: `n = ${this.prevN + 1}`,
          actual: `a ${line.k} line with n = ${n}`,
        });
      }
      this.prevN = n;
    }
    this.prevT = line.t;
    let applied: ApplyOutput | undefined;
    switch (line.k) {
      case "ev":
        this.advance(line.t);
        this.matchEvent(line);
        break;
      case "ckpt":
        this.advance(line.t);
        this.matchCheckpoint(line);
        break;
      case "act":
        this.advance(line.t);
        this.caughtUp(line.k, line.t, n);
        applied = this.applyAct(line);
        break;
      case "wake":
      case "batch":
      case "defer":
      case "controller":
        this.advance(line.t);
        this.caughtUp(line.k, line.t, n);
        break;
      case "gw":
      case "obs":
      case "note":
      case "turn":
        this.advance(line.t);
        break;
      case "end":
        this.advance(line.t);
        this.caughtUp(line.k, line.t, n);
        this.end(line);
        this.done = true;
        break;
      case "fatal":
        diverge({
          kind: "end",
          t: line.t,
          expected: "a log that ends with an end line",
          actual: `a fatal line (${line.error.kind}): ${line.error.message}`,
        });
    }
    if (line.k === "act") this.lastAct = { t: line.t, n: line.n };
    else if (line.k !== "ev") this.lastAct = null;
    this.opts.onLine?.(line, this.m.read(), applied);
    return applied;
  }

  /** Step 1 of §10.4: ruleset, config, compiled rules; then the match from the header (no `from`). */
  private start(
    header: HeaderLine,
    resolve: (ref: string) => AnyRuleset | undefined,
    domain: DomainModule,
  ): AnyRuleset {
    if (header.engine !== ENGINE_VERSION) {
      this.report.warnings.push(
        `the log was written by engine ${header.engine}; replaying with engine ${ENGINE_VERSION} (the hashes decide)`,
      );
    }
    const ref = header.setup.ruleset;
    const ruleset = resolve(ref);
    if (ruleset === undefined) {
      diverge({
        kind: "header",
        t: 0,
        expected: `ruleset ${ref}`,
        actual: `${ref} is not in this build`,
      });
    }
    const resolved = resolveConfigFull(ruleset, header.setup.overrides);
    if (!resolved.ok) {
      diverge({
        kind: "config",
        t: 0,
        expected: `config ${header.configHash}`,
        actual: `the overrides no longer resolve: ${resolved.errors.map((i) => (i.path === "" ? i.message : `${i.path}: ${i.message}`)).join("; ")}`,
      });
    }
    const config = canonicalJson(resolved.config);
    const logged = logText(header.config, "the header's config", { kind: "config", t: 0 });
    if (config !== logged || resolved.hash !== header.configHash) {
      diverge({
        kind: "config",
        t: 0,
        expected: `config ${header.configHash}: ${logged}`,
        actual: `config ${resolved.hash}: ${config}`,
      });
    }
    const rules = resolved.compiled.get(header.setup.seats.length);
    if (rules === undefined) {
      diverge({
        kind: "config",
        t: 0,
        expected: `${header.setup.seats.length} seats`,
        actual: `${ref} allows ${resolved.players.min}..${resolved.players.max} players`,
      });
    }
    const rulesHash = rulesHashOf(rules);
    if (rulesHash !== header.rulesHash) {
      diverge({
        kind: "rules",
        t: 0,
        expected: `rulesHash ${header.rulesHash}`,
        actual: `rulesHash ${rulesHash}: the compiled tables differ for ${ref} under the same config`,
      });
    }
    const level = this.opts.invariants ?? "checkpoint";
    if (this.opts.from === undefined) {
      try {
        this.match = createMatch(header.setup, ruleset, domain, { invariants: level });
      } catch (error) {
        diverge({
          kind: "initial",
          t: 0,
          expected: "a match created from the header",
          actual: errorMessage(error),
        });
      }
      const m = this.m;
      const h = this.engine({ kind: "initial", t: 0 }, () => m.hash());
      if (h !== header.initialHash) {
        diverge({ kind: "initial", t: 0, expected: header.initialHash, actual: h });
      }
    }
    return ruleset;
  }

  /**
   * Loads `from`; returns whether the lines up to the `ckpt` line of its hour must be skipped
   * (false for the snapshot of hour 0, taken before any line).
   */
  private loadSnapshot(
    header: HeaderLine,
    from: Snapshot,
    ruleset: AnyRuleset,
    domain: DomainModule,
  ): boolean {
    const t = from.t;
    const logged = logText(header.setup, "the header's setup", { kind: "snapshot", t });
    const snapped = logText(from.setup, "the snapshot's setup", { kind: "snapshot", t });
    if (snapped !== logged) diverge({ kind: "snapshot", t, expected: logged, actual: snapped });
    if (from.engine !== ENGINE_VERSION) {
      this.report.warnings.push(
        `the snapshot was written by engine ${from.engine}; replaying with ${ENGINE_VERSION}`,
      );
    }
    try {
      this.match = loadMatch(from, ruleset, domain, {
        invariants: this.opts.invariants ?? "checkpoint",
      });
    } catch (error) {
      diverge({
        kind: "snapshot",
        t,
        expected: "a loadable snapshot",
        actual: errorMessage(error),
      });
    }
    if (from.hour === 0) {
      if (from.hash !== header.initialHash || from.afterN !== 0) {
        diverge({
          kind: "snapshot",
          t,
          hour: 0,
          expected: `initial hash ${header.initialHash}, afterN 0`,
          actual: `${from.hash}, afterN ${from.afterN}`,
        });
      }
      return false;
    }
    return true;
  }

  /** A line before the snapshot's `ckpt` line: its `n` is checked, nothing is replayed. */
  private skip(line: LogLine): void {
    const from = this.opts.from;
    if (from === undefined) throw new Error("replay: skipping without a snapshot");
    const n = lineN(line);
    if (n !== undefined) {
      if (n !== this.skipN + 1) {
        diverge({
          kind: "order",
          t: line.k === "header" ? 0 : line.t,
          n,
          expected: `n = ${this.skipN + 1}`,
          actual: `a ${line.k} line with n = ${n}`,
        });
      }
      this.skipN = n;
    }
    if (line.k === "ckpt" && line.hour === from.hour) {
      if (line.h !== from.hash) {
        diverge({
          kind: "snapshot",
          t: line.t,
          hour: line.hour,
          expected: line.h,
          actual: from.hash,
        });
      }
      if (this.skipN !== from.afterN) {
        diverge({
          kind: "snapshot",
          t: line.t,
          hour: line.hour,
          expected: `afterN ${this.skipN}`,
          actual: `afterN ${from.afterN}`,
        });
      }
      this.skipping = false;
      this.prevT = line.t;
      this.prevN = this.skipN;
      return;
    }
    if (line.k === "end" || line.k === "fatal") {
      diverge({
        kind: "snapshot",
        t: from.t,
        hour: from.hour,
        expected: `a ckpt line for hour ${from.hour}`,
        actual: "none before the end of the log",
      });
    }
  }

  /**
   * Runs one engine call; an engine error (an `EngineBug` while replaying) is a divergence at `at`.
   * Only the engine call is covered: an error thrown by a caller's callback propagates.
   */
  private engine<T>(at: Where, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      return diverge({ ...at, expected: "no engine error", actual: errorMessage(error) });
    }
  }

  /** `advanceTo(t)`, split at every hour boundary so `onCheckpoint` sees each checkpoint state. */
  private advance(t: GameTime): void {
    const m = this.m;
    // The live state (read views never copy it); its fields are read again after the advance.
    const state = this.state ?? m.read().state;
    this.state = state;
    const head = state.queue[0];
    const queued = state.queue.length;
    const evHash = state.evHash;
    while (!m.ended) {
      const ck = (Math.floor(m.now / HOUR) + 1) * HOUR;
      if (ck > t) break;
      const out = this.engine({ kind: "event", t }, () => m.advanceTo(ck));
      this.collect(out.events, out.checkpoints);
    }
    const out = this.engine({ kind: "event", t }, () => m.advanceTo(t));
    this.collect(out.events, out.checkpoints);
    // A scheduled event that ran left the head of the queue (a new event never reuses its object).
    if (state.queue[0] !== head || state.queue.length !== queued || state.evHash !== evHash) {
      this.stepChanged = true;
    }
  }

  private collect(
    events: readonly DomainEvent[],
    checkpoints: readonly { hour: number; t: GameTime; h: Hash64 }[],
  ): void {
    for (const e of events) {
      this.stepEvents.push(e);
      if (this.compare) this.pending.push({ e });
    }
    for (const c of checkpoints) {
      this.pendingCk.push(c);
      this.opts.onCheckpoint?.(c.hour, this.m.read());
    }
  }

  private matchEvent(line: EvLine): void {
    const ck = this.pendingCk[0];
    if (ck !== undefined && ck.t < line.t) {
      diverge({
        kind: "checkpoint",
        t: line.t,
        hour: ck.hour,
        expected: "no checkpoint (the log has no ckpt line here)",
        actual: ck.h,
      });
    }
    if (!this.compare) return;
    const p = this.pending.shift();
    const owner = this.lastAct?.t === line.t ? this.lastAct.n : undefined;
    const n = p === undefined ? owner : p.n;
    const at: Where =
      n === undefined ? { kind: "event", t: line.t } : { kind: "event", t: line.t, n };
    const expected = logText(line.e, "the ev line's event", at);
    if (p === undefined) diverge({ ...at, expected, actual: "no event" });
    const actual = canonicalJson(p.e);
    if (actual !== expected) diverge({ ...at, expected, actual });
  }

  private matchCheckpoint(line: CkptLine): void {
    const p = this.pending[0];
    if (p !== undefined) {
      diverge(
        withN(
          {
            kind: "event",
            t: line.t,
            expected: `the ckpt line of hour ${line.hour}`,
            actual: canonicalJson(p.e),
          },
          p.n,
        ),
      );
    }
    const c = this.pendingCk.shift();
    if (c === undefined) {
      diverge({
        kind: "checkpoint",
        t: line.t,
        hour: line.hour,
        expected: line.h,
        actual: "no checkpoint",
      });
    }
    if (c.hour !== line.hour) {
      diverge({
        kind: "checkpoint",
        t: Math.min(c.t, line.t),
        hour: Math.min(c.hour, line.hour),
        expected: `hour ${line.hour}: ${line.h}`,
        actual: `hour ${c.hour}: ${c.h}`,
      });
    }
    if (c.h !== line.h)
      diverge({ kind: "checkpoint", t: line.t, hour: line.hour, expected: line.h, actual: c.h });
    this.report.checkpoints += 1;
  }

  /** The ev and ckpt lines of everything the engine produced so far come before this line. */
  private caughtUp(kind: string, t: GameTime, n: number | undefined): void {
    const p = this.pending[0];
    if (p !== undefined) {
      diverge(
        withN(
          { kind: "event", t, expected: `the ${kind} line`, actual: canonicalJson(p.e) },
          p.n ?? n,
        ),
      );
    }
    const c = this.pendingCk[0];
    if (c !== undefined) {
      diverge(
        withN(
          { kind: "checkpoint", t, hour: c.hour, expected: `the ${kind} line`, actual: c.h },
          n,
        ),
      );
    }
  }

  private applyAct(line: LogLine & { k: "act" }): ApplyOutput {
    const at = { kind: "result", t: line.t, n: line.n } as const;
    const expected = logText(line.r, "the act line's result", at);
    let out: ApplyOutput;
    try {
      out = this.m.apply(line.seat, line.a);
    } catch (error) {
      return diverge({ ...at, expected, actual: errorMessage(error) });
    }
    const actual = canonicalJson(out.ok ? { ok: true } : { ok: false, code: out.violation.code });
    if (actual !== expected) diverge({ ...at, expected, actual });
    this.report.actions += 1;
    if (out.ok) {
      this.stepChanged = true;
      for (const e of out.events) {
        this.stepEvents.push(e);
        if (this.compare) this.pending.push({ e, n: line.n });
      }
    }
    return out;
  }

  private end(line: EndLine): void {
    const m = this.m;
    if (!m.ended) {
      diverge({
        kind: "end",
        t: line.t,
        expected: `the match ended by t = ${line.t}`,
        actual: "the match is still running",
      });
    }
    const expected = logText(line.result, "the end line's result", { kind: "result", t: line.t });
    const result = canonicalJson(this.engine({ kind: "end", t: line.t }, () => m.result));
    if (result !== expected) diverge({ kind: "result", t: line.t, expected, actual: result });
    const h = this.engine({ kind: "end", t: line.t }, () => m.hash());
    if (h !== line.h) diverge({ kind: "end", t: line.t, expected: line.h, actual: h });
    this.report.finalHash = h;
  }
}

/**
 * Starts the incremental Level E replay of a log from its header (§10.4); the later lines go to
 * `push`, in file order. Never throws for a bad header, config or snapshot: the replay starts
 * diverged. An error thrown by the caller's `onCheckpoint` or `onLine` propagates unchanged.
 */
export function createReplay(
  header: HeaderLine,
  resolve: (ref: string) => AnyRuleset | undefined,
  domain: DomainModule,
  opts: VerifyOptions = {},
): Replay {
  return new Replayer(header, resolve, domain, opts);
}

/**
 * Level E verification of a log (§10.4): `createReplay` over its lines, stopping at the first
 * divergence. Returns a report naming the first divergence; never throws for a bad log (a
 * non-integer number in a line included) or an engine error during the replay. An error thrown by
 * the caller's `onCheckpoint` or `onLine` propagates unchanged: it is not a divergence of the log.
 */
export function verifyLog(
  lines: Iterable<LogLine>,
  resolve: (ref: string) => AnyRuleset | undefined,
  domain: DomainModule,
  opts: VerifyOptions = {},
): ReplayReport {
  const it = lines[Symbol.iterator]();
  const first = it.next();
  const replay = new Replayer(first.done === true ? undefined : first.value, resolve, domain, opts);
  if (replay.divergence === null) {
    for (let next = it.next(); next.done !== true; next = it.next()) {
      if (!replay.push(next.value).ok) break;
    }
  }
  return replay.finish();
}
