import { verifyLog, type AnyRuleset, type ApplyOutput, type ReplayReport } from "@perfidia/engine";
import { canonicalJson } from "@perfidia/engine/core";
import type { ReadCtx } from "@perfidia/engine/contracts";
import type { InvariantLevel } from "@perfidia/engine/kernel";
import { describeError } from "@perfidia/gateway/clock";
import { explain, gatewayRulesCopy } from "@perfidia/gateway/present";
import {
  briefed,
  closeTurn,
  createGatewayState,
  createWakeScheduler,
  deliver,
  recordAct,
  recordGw,
  seatOf,
  sortedSeats,
  writeNote,
  type GatewayState,
  type WakeScheduler,
} from "@perfidia/gateway/seat";
import type {
  ActLine,
  GameTime,
  GwLine,
  LogLine,
  LogLineKind,
  PlayerId,
  TurnLine,
  Violation,
  WakeLine,
} from "@perfidia/protocol";
import { INTERNAL_FALLBACK } from "./tools.ts";

// The gateway state rebuild (docs/architecture.md §10.5): a fold over a match log through the
// engine's Level E replay (`verifyLog` with `onLine`), calling the same `seat/` functions as the
// live host (`host.ts`), line by line:
//
//   header → createGatewayState, createWakeScheduler (the seats and the compiled gateway rules)
//   ev     → deliver
//   wake   → wake.begin (its reasons, urgency, charge, day and usage checked against the line), briefed
//   act    → recordAct (a rejection worded from the violation the engine re-run returns)
//   gw     → recordGw (the message regenerated from the code and details)
//   note   → writeNote
//   turn   → closeTurn (wake.end, the line's selfAt, lastTurn; its next wake checked)
//   defer  → wake.defer
//
// `obs`, `batch`, `controller`, `ckpt` and `end` change no gateway state. Every change to the live
// gateway state is driven by one of these lines (§8.4), so the rebuild of a complete log equals
// the state `runMatch` returns; a drift is a missing line, never a special case here. A line the
// fold cannot apply as logged (a wake that is not due, a turn that is not open, other reasons or
// another next wake) is reported as `drift` and stops the fold; the engine replay still runs to
// the end of the log for its own report. The rebuild never throws for a bad log.

/** Where and why the fold of the gateway lines stopped. */
export interface RebuildDrift {
  /** Index of the line in the log, from 0 (the header is line 0). */
  readonly index: number;
  readonly k: LogLineKind;
  readonly t: GameTime;
  readonly seat?: PlayerId;
  /** What the line records (or needs). */
  readonly expected: string;
  /** What the rebuilt gateway state gave. */
  readonly actual: string;
}

export interface GatewayRebuild {
  /** The rebuilt gateway state: up to the drift, if any; with no seat when the header failed. */
  readonly gw: GatewayState;
  /** The engine's Level E report (§10.4). */
  readonly report: ReplayReport;
  /** The log was replayed with zero divergence and every gateway line folded. */
  readonly ok: boolean;
  /**
   * A turn is still open at the end of the log (a crash, §10.5): closing it, with
   * `why: "error"`, is the resuming host's job.
   */
  readonly inTurn: boolean;
  /** The seats whose turn is open at the end of the log, sorted by player number. */
  readonly openTurns: readonly PlayerId[];
  /** The first gateway line the fold could not apply, or `null`. */
  readonly drift: RebuildDrift | null;
}

export interface RebuildOptions {
  /** Invariant level of the engine replay; default `checkpoint`, as `verifyLog`. */
  readonly invariants?: InvariantLevel;
}

class Drift extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(`${expected} / ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}

/** The explanation's message of a violation, or `null` when the explainer throws (§7.3). */
function messageOf(v: Violation, r: ReadCtx, seat: PlayerId, gw: GatewayState): string | null {
  try {
    return explain(v, { r, seat, gw }).message;
  } catch {
    return null;
  }
}

/**
 * The message the live host recorded for a `gw` line, regenerated from its code and details: the
 * explanation (seat codes through `seatErrorText`, which `explain` delegates to), the fixed
 * `INTERNAL` text when the `INTERNAL` explainer throws (`internalError`), and the bare code when
 * another explainer throws (a batch item's `rejection`).
 */
function gwMessage(line: GwLine, r: ReadCtx, gw: GatewayState): string {
  const v: Violation = { code: line.r.code, details: { ...line.r.details } };
  const message = messageOf(v, r, line.seat, gw);
  if (message !== null) return message;
  return line.r.code === "INTERNAL" ? INTERNAL_FALLBACK.message : line.r.code;
}

/** The fold of the gateway lines (§10.5). */
class Fold {
  gw: GatewayState = createGatewayState([]);
  private wake: WakeScheduler | null = null;
  private index = -1;
  drift: RebuildDrift | null = null;

  private get scheduler(): WakeScheduler {
    if (this.wake === null) throw new Drift("a header line first", "no gateway state");
    return this.wake;
  }

  line(line: LogLine, r: ReadCtx, applied: ApplyOutput | undefined): void {
    this.index += 1;
    if (this.drift !== null) return;
    try {
      this.apply(line, r, applied);
    } catch (e) {
      const at = {
        index: this.index,
        k: line.k,
        t: line.k === "header" ? 0 : line.t,
        ...("seat" in line ? { seat: line.seat } : {}),
      };
      this.drift =
        e instanceof Drift
          ? { ...at, expected: e.expected, actual: e.actual }
          : { ...at, expected: `the ${line.k} line folds`, actual: describeError(e) };
    }
  }

  private apply(line: LogLine, r: ReadCtx, applied: ApplyOutput | undefined): void {
    switch (line.k) {
      case "header": {
        this.gw = createGatewayState(line.setup.seats.map((s) => s.id));
        this.wake = createWakeScheduler(this.gw, gatewayRulesCopy(r.rules.gateway));
        return;
      }
      case "ev":
        deliver(this.gw, [line.e], this.scheduler);
        return;
      case "wake":
        this.begin(line);
        return;
      case "act":
        this.act(line, r, applied);
        return;
      case "gw":
        recordGw(this.gw, line, gwMessage(line, r, this.gw));
        return;
      case "note": {
        const s = seatOf(this.gw, line.seat);
        const out = writeNote(s, line.text, line.mode, this.scheduler.rules.notesMaxChars, line.t);
        if (!out.ok) throw new Drift(`an accepted ${line.mode} note`, out.message);
        return;
      }
      case "turn":
        this.close(line, r);
        return;
      case "defer":
        this.scheduler.defer(line.seat, line.to);
        return;
      case "obs":
      case "batch":
      case "controller":
      case "ckpt":
      case "end":
      case "fatal":
        return;
    }
  }

  private begin(line: WakeLine): void {
    const rec = this.scheduler.begin(line.seat, line.t);
    const s = seatOf(this.gw, line.seat);
    const logged = canonicalJson({
      turn: line.turn,
      reasons: line.reasons,
      urgent: line.urgent,
      charge: line.charge,
      day: line.day,
      used: line.used,
    });
    const rebuilt = canonicalJson({
      turn: s.turns,
      reasons: rec.reasons,
      urgent: rec.urgent,
      charge: rec.charge,
      day: rec.day,
      used: rec.used,
    });
    if (logged !== rebuilt) throw new Drift(logged, rebuilt);
    briefed(this.gw, line.seat, line.t);
  }

  private act(line: ActLine, r: ReadCtx, applied: ApplyOutput | undefined): void {
    if (applied === undefined) throw new Drift("the engine's verdict on the act line", "none");
    if (applied.ok !== line.r.ok) {
      throw new Drift(`ok: ${String(line.r.ok)}`, `ok: ${String(applied.ok)}`);
    }
    const message = applied.ok ? null : messageOf(applied.violation, r, line.seat, this.gw);
    recordAct(this.gw, line, message);
  }

  private close(line: TurnLine, r: ReadCtx): void {
    const s = seatOf(this.gw, line.seat);
    if (!s.wake.inTurn || s.turns !== line.turn) {
      throw new Drift(
        `turn ${line.turn} of ${line.seat} open`,
        s.wake.inTurn ? `turn ${s.turns} open` : "no open turn",
      );
    }
    const wake = this.scheduler;
    closeTurn(this.gw, wake, {
      t: line.t,
      seat: line.seat,
      why: line.why,
      rounds: line.rounds,
      selfAt: line.selfAt,
      next: line.next,
    });
    // The live host records the scheduler's next wake, or none once the match has ended.
    const peek = wake.peek(line.seat);
    const next = peek === null ? null : { at: peek.at, kind: peek.kind };
    const ended = r.state.status === "ended";
    if (
      line.next === null
        ? next !== null && !ended
        : canonicalJson(next) !== canonicalJson(line.next)
    ) {
      throw new Drift(`next wake ${canonicalJson(line.next)}`, `next wake ${canonicalJson(next)}`);
    }
  }
}

/**
 * Rebuilds the gateway state of a match from its log (§10.5): the engine's Level E replay, with
 * every line folded through the `seat/` functions the live host calls. `resolve` finds the
 * header's ruleset (the registry's `findRuleset`, or a test's resolver).
 */
export function rebuildGatewayState(
  lines: Iterable<LogLine>,
  resolve: (ref: string) => AnyRuleset | undefined,
  opts: RebuildOptions = {},
): GatewayRebuild {
  const fold = new Fold();
  const report = verifyLog(lines, resolve, {
    ...(opts.invariants === undefined ? {} : { invariants: opts.invariants }),
    onLine: (line, r, applied) => fold.line(line, r, applied),
  });
  const openTurns = sortedSeats(fold.gw)
    .filter((s) => s.wake.inTurn)
    .map((s) => s.seat);
  return {
    gw: fold.gw,
    report,
    ok: report.ok && fold.drift === null,
    inTurn: openTurns.length > 0,
    openTurns,
    drift: fold.drift,
  };
}
