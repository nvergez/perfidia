import { verifyLog, type AnyRuleset, type ReplayReport } from "@perfidia/engine";
import { canonicalJson, fnv1a64 } from "@perfidia/engine/core";
import type { GameTime, Hash64, LogLine, PlayerId } from "@perfidia/protocol";

// `--trace-hashes` (docs/architecture.md §1 "Hashes", §12.1): the full state hash after every action
// that reached the engine, for hunting the first diverging action between two runs. `runMatch` has
// no option to forward the engine's `traceHashes`, so the trace is computed by a Level E replay of
// the written log, hashing the state after each `act` line exactly as the engine's trace would.

export interface TraceEntry {
  readonly n: number;
  readonly t: GameTime;
  readonly seat: PlayerId;
  readonly ok: boolean;
  /** FNV-1a 64 of the canonical state after the action. */
  readonly h: Hash64;
}

/** The trace of a log, and the replay report (a divergence stops the trace where it occurred). */
export function traceHashes(
  lines: Iterable<LogLine>,
  resolve?: (ref: string) => AnyRuleset | undefined,
): { readonly report: ReplayReport; readonly entries: TraceEntry[] } {
  const entries: TraceEntry[] = [];
  const opts = {
    onLine(line: LogLine, r: { readonly state: unknown }): void {
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
  return { report, entries };
}
