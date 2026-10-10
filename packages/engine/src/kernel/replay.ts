import { canonicalJson } from "@perfidia/engine/core";
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
import { HOUR } from "./snapshot.ts";
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

function withN(d: Omit<ReplayDivergence, "n">, n: number | undefined): ReplayDivergence {
  return n === undefined ? d : { ...d, n };
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
        if (n <= prevN) {
          diverge({
            kind: "order",
            t: line.t,
            n,
            expected: `n > ${prevN}`,
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
    if (config !== canonicalJson(header.config) || resolved.hash !== header.configHash) {
      diverge({
        kind: "config",
        t: 0,
        expected: `config ${header.configHash}: ${canonicalJson(header.config)}`,
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
      const h = this.m.hash();
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
    if (canonicalJson(from.setup) !== canonicalJson(header.setup)) {
      diverge({
        kind: "snapshot",
        t,
        expected: canonicalJson(header.setup),
        actual: canonicalJson(from.setup),
      });
    }
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
      if (n !== undefined) lastN = n;
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

  /** `advanceTo(t)`, split at every hour boundary so `onCheckpoint` sees each checkpoint state. */
  private advance(t: GameTime): void {
    const m = this.m;
    try {
      while (!m.ended) {
        const ck = (Math.floor(m.now / HOUR) + 1) * HOUR;
        if (ck > t) break;
        const out = m.advanceTo(ck);
        this.collect(out.events, out.checkpoints);
      }
      const out = m.advanceTo(t);
      this.collect(out.events, out.checkpoints);
    } catch (error) {
      diverge({ kind: "event", t, expected: "no engine error", actual: errorMessage(error) });
    }
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
    const expected = canonicalJson(line.e);
    if (p === undefined) diverge({ kind: "event", t: line.t, expected, actual: "no event" });
    const actual = canonicalJson(p.e);
    if (actual !== expected) diverge(withN({ kind: "event", t: line.t, expected, actual }, p.n));
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
    let out: ApplyOutput;
    try {
      out = this.m.apply(line.seat, line.a);
    } catch (error) {
      return diverge({
        kind: "result",
        t: line.t,
        n: line.n,
        expected: canonicalJson(line.r),
        actual: errorMessage(error),
      });
    }
    const actual = out.ok ? { ok: true } : { ok: false, code: out.violation.code };
    if (canonicalJson(actual) !== canonicalJson(line.r)) {
      diverge({
        kind: "result",
        t: line.t,
        n: line.n,
        expected: canonicalJson(line.r),
        actual: canonicalJson(actual),
      });
    }
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
    const result = canonicalJson(m.result);
    if (result !== canonicalJson(line.result)) {
      diverge({ kind: "result", t: line.t, expected: canonicalJson(line.result), actual: result });
    }
    const h = m.hash();
    if (h !== line.h) diverge({ kind: "end", t: line.t, expected: line.h, actual: h });
    this.report.finalHash = h;
  }
}

/**
 * Level E verification of a log (§10.4). Returns a report naming the first divergence; never throws
 * for a bad log or an engine error during the replay.
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
