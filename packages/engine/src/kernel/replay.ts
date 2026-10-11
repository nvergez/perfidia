import { canonicalJson, HOUR } from "@perfidia/engine/core";
import type { AnyRuleset, DomainModule, ReadCtx } from "@perfidia/engine/contracts";
import type {
  CkptLine,
  DomainEvent,
  EndLine,
  EvLine,
  GameTime,
  Hash64,
  HeaderLine,
  LogLine,
  Snapshot,
} from "@perfidia/protocol";
import { resolveConfigFull, rulesHashOf } from "./config.ts";
import { errorMessage } from "./errors.ts";
import type { InvariantLevel } from "./invariants.ts";
import { createMatch, loadMatch, type ApplyOutput, type Match } from "./match.ts";
import { ENGINE_VERSION } from "./version.ts";

// Level E replay verification (docs/architecture.md §10.4): re-runs the logged actions on a fresh
// engine and compares the config, the compiled rules, the initial hash, every act result, every
// event (in the line order of §10.2), every checkpoint, the result and the final hash. Pure and
// browser-runnable. In a divergence, `expected` is what the log records (or what a complete log
// has) and `actual` what the replay produced.

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

class Replayer {
  private readonly report: ReplayReport;
  private readonly opts: VerifyOptions;
  private readonly compare: boolean;
  private readonly pending: Pending[] = [];
  private readonly pendingCk: { hour: number; t: GameTime; h: Hash64 }[] = [];
  private match: Match | null = null;
  /**
   * The last act line, while only its `ev` lines follow it: an `ev` line at its time carries one of
   * its events (§10.2), so a missing event is attributed to its `n`.
   */
  private lastAct: { readonly t: GameTime; readonly n: number } | null = null;

  constructor(report: ReplayReport, opts: VerifyOptions) {
    this.report = report;
    this.opts = opts;
    this.compare = opts.compareEvents ?? true;
  }

  private get m(): Match {
    if (this.match === null) throw new Error("replay: no match");
    return this.match;
  }

  run(
    lines: Iterable<LogLine>,
    resolve: (ref: string) => AnyRuleset | undefined,
    domain: DomainModule,
  ): void {
    const it = lines[Symbol.iterator]();
    const first = it.next();
    if (first.done === true || first.value.k !== "header") {
      diverge({
        kind: "header",
        t: 0,
        expected: "a header line first",
        actual: first.done === true ? "an empty log" : `a ${first.value.k} line`,
      });
    }
    const header = first.value;
    const ruleset = this.start(header, resolve, domain);

    let prevT = 0;
    let prevN = 0;
    const from = this.opts.from;
    if (from !== undefined) {
      [prevT, prevN] = this.skipToSnapshot(it, header, from, ruleset, domain);
    } else {
      this.opts.onLine?.(header, this.m.read());
    }

    let ended = false;
    for (let next = it.next(); next.done !== true; next = it.next()) {
      const line = next.value;
      if (line.k === "header") {
        diverge({
          kind: "order",
          t: prevT,
          expected: "one header line, first",
          actual: "another header line",
        });
      }
      const n = lineN(line);
      if (ended) {
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
      if (line.t < prevT) {
        diverge(
          withN(
            {
              kind: "order",
              t: line.t,
              expected: `t ≥ ${prevT}`,
              actual: `a ${line.k} line at t = ${line.t}`,
            },
            n,
          ),
        );
      }
      if (n !== undefined) {
        // The host numbers act, gw, obs and note lines without gaps (§10.2): a missing one, which
        // changes no engine state and so no hash, would otherwise go unnoticed.
        if (n !== prevN + 1) {
          diverge({
            kind: "order",
            t: line.t,
            n,
            expected: `n = ${prevN + 1}`,
            actual: `a ${line.k} line with n = ${n}`,
          });
        }
        prevN = n;
      }
      prevT = line.t;
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
          this.finish(line);
          ended = true;
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
    }
    if (!ended) {
      diverge({
        kind: "end",
        t: prevT,
        expected: "an end line",
        actual: `the log stops at t = ${prevT}`,
      });
    }
  }

  /** Step 1 of §10.4: ruleset, config, compiled rules; then the match from the header or a snapshot. */
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

  /** Loads `from` and skips to the line right after the `ckpt` line of its hour. */
  private skipToSnapshot(
    it: Iterator<LogLine>,
    header: HeaderLine,
    from: Snapshot,
    ruleset: AnyRuleset,
    domain: DomainModule,
  ): [number, number] {
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
      return [0, 0];
    }
    let lastN = 0;
    for (let next = it.next(); next.done !== true; next = it.next()) {
      const line = next.value;
      const n = lineN(line);
      if (n !== undefined) {
        if (n !== lastN + 1) {
          diverge({
            kind: "order",
            t: line.k === "header" ? 0 : line.t,
            n,
            expected: `n = ${lastN + 1}`,
            actual: `a ${line.k} line with n = ${n}`,
          });
        }
        lastN = n;
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
        if (lastN !== from.afterN) {
          diverge({
            kind: "snapshot",
            t: line.t,
            hour: line.hour,
            expected: `afterN ${lastN}`,
            actual: `afterN ${from.afterN}`,
          });
        }
        return [line.t, lastN];
      }
      if (line.k === "end" || line.k === "fatal") break;
    }
    return diverge({
      kind: "snapshot",
      t,
      hour: from.hour,
      expected: `a ckpt line for hour ${from.hour}`,
      actual: "none before the end of the log",
    });
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
    while (!m.ended) {
      const ck = (Math.floor(m.now / HOUR) + 1) * HOUR;
      if (ck > t) break;
      const out = this.engine({ kind: "event", t }, () => m.advanceTo(ck));
      this.collect(out.events, out.checkpoints);
    }
    const out = this.engine({ kind: "event", t }, () => m.advanceTo(t));
    this.collect(out.events, out.checkpoints);
  }

  private collect(
    events: readonly DomainEvent[],
    checkpoints: readonly { hour: number; t: GameTime; h: Hash64 }[],
  ): void {
    if (this.compare) for (const e of events) this.pending.push({ e });
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
    if (out.ok && this.compare) for (const e of out.events) this.pending.push({ e, n: line.n });
    return out;
  }

  private finish(line: EndLine): void {
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
 * Level E verification of a log (§10.4). Returns a report naming the first divergence; never throws
 * for a bad log (a non-integer number in a line included) or an engine error during the replay. An
 * error thrown by the caller's `onCheckpoint` or `onLine` propagates unchanged: it is not a
 * divergence of the log.
 */
export function verifyLog(
  lines: Iterable<LogLine>,
  resolve: (ref: string) => AnyRuleset | undefined,
  domain: DomainModule,
  opts: VerifyOptions = {},
): ReplayReport {
  const report: ReplayReport = {
    ok: true,
    actions: 0,
    checkpoints: 0,
    finalHash: null,
    warnings: [],
  };
  try {
    new Replayer(report, opts).run(lines, resolve, domain);
  } catch (error) {
    if (!(error instanceof Diverged)) throw error;
    report.ok = false;
    report.finalHash = null;
    report.divergence = error.divergence;
  }
  return report;
}
