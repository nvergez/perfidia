import { verifyLog, type AnyRuleset, type ReplayReport } from "@perfidia/engine";
import { canonicalJson, fnv1a64 } from "@perfidia/engine/core";
import type { GameTime, Hash64, LogLine, PlayerId } from "@perfidia/protocol";
import { readLogLines, writeFileAtomic } from "../io/index.ts";

// `--trace-hashes` (docs/architecture.md §1 "Hashes", §12.1): the full state hash after every action
// that reached the engine, for hunting the first diverging action between two runs. Deviation from
// §5.3: `runMatch` (§8.7) has no option to forward the engine's `traceHashes`, so this trace is not
// recorded live; it is computed by a Level E replay of the written log, hashing the state after
// each `act` line as the engine's own trace does (a test checks that the two agree). It therefore
// cannot show a live-versus-replay divergence by itself: compare it with the trace of another run.

export interface TraceEntry {
  readonly n: number;
  readonly t: GameTime;
  readonly seat: PlayerId;
  readonly ok: boolean;
  /** FNV-1a 64 of the canonical state after the action. */
  readonly h: Hash64;
}

/**
 * The trace of a log and the replay report (a divergence stops the trace where it occurred);
 * `replayed` counts the lines the replay accepted, the header included.
 */
export function traceHashes(
  lines: Iterable<LogLine>,
  resolve?: (ref: string) => AnyRuleset | undefined,
): { readonly report: ReplayReport; readonly entries: TraceEntry[]; readonly replayed: number } {
  const entries: TraceEntry[] = [];
  let replayed = 0;
  const opts = {
    onLine(line: LogLine, r: { readonly state: unknown }): void {
      replayed += 1;
      if (line.k !== "act") return;
      entries.push({
        n: line.n,
        t: line.t,
        seat: line.seat,
        ok: line.r.ok,
        h: fnv1a64(canonicalJson(r.state)),
      });
    },
  };
  const report = resolve === undefined ? verifyLog(lines, opts) : verifyLog(lines, resolve, opts);
  return { report, entries, replayed };
}

export interface TraceOutcome {
  /** Actions traced. */
  readonly traced: number;
  /** Why the trace does not cover the whole log (its replay diverged), or null. */
  readonly problem: string | null;
}

/**
 * Writes the trace of the log at `log` to `path`, one canonical JSON entry per line. A log that
 * stops on a fatal line is traced up to it: its replay necessarily stops at that line, which is no
 * problem; a replay that diverges anywhere else is reported.
 */
export function writeTrace(log: string, path: string): TraceOutcome {
  const { report, entries, replayed } = traceHashes(readLogLines(log));
  writeFileAtomic(path, entries.map((e) => `${canonicalJson(e)}\n`).join(""));
  let total = 0;
  let last: LogLine | undefined;
  for (const line of readLogLines(log)) {
    total += 1;
    last = line;
  }
  const stoppedAtFatal = last?.k === "fatal" && replayed === total - 1;
  return {
    traced: entries.length,
    problem:
      report.ok || stoppedAtFatal
        ? null
        : `the trace replay diverged after ${entries.length} action(s): ${JSON.stringify(report.divergence)}`,
  };
}
