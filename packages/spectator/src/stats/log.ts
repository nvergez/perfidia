import type { LogLine, MatchStats, MatchStatus } from "@perfidia/protocol";
import { createSpectatorFold, type SpectatorFold } from "../fold/fold.ts";
import { matchStats, type FoldedMatch, type MatchStatsOptions, type StatsSide } from "./match.ts";

// A whole `match.jsonl` folded and its statistics taken: what the `stats` command line does for a
// run directory (the server never folds outside its workers: it takes the statistics of the steps
// its workers folded, `matchStats`).

/** What the statistics read of a spectator fold. */
export function foldedOf(fold: SpectatorFold): FoldedMatch {
  return {
    header: fold.header,
    steps: fold.steps,
    frame: fold.frame(),
    verified: fold.verified(),
    lastT: fold.lastT,
  };
}

/** What a log's fold says, for its status. */
export interface FoldOutcome {
  /** Level E held and every line was valid. */
  readonly verified: boolean;
  /** The end line's result reason, when the log has one. */
  readonly endReason: string | null;
  /** The log has a `fatal` line. */
  readonly fatal: boolean;
}

/**
 * The statistics of a whole log: its lines in order, the first the header, `null` for a line that
 * is not a valid log line (the match is unverifiable from there). The status is given, or computed
 * from the fold's outcome; without either, the fold's own (`ended`, `fatal`, `unverifiable`, `live`).
 */
export function statsOfLog(
  lines: Iterable<LogLine | null>,
  side: StatsSide,
  o: Omit<MatchStatsOptions, "status"> & {
    readonly status?: MatchStatus | ((f: FoldOutcome) => MatchStatus);
  },
): MatchStats {
  let fold: SpectatorFold | null = null;
  for (const line of lines) {
    if (fold === null) {
      if (line?.k !== "header")
        throw new Error("statsOfLog: the log does not start with a header line");
      fold = createSpectatorFold(line, { match: o.match });
    } else if (line === null) {
      fold.invalid();
    } else {
      fold.push(line);
    }
  }
  if (fold === null) throw new Error("statsOfLog: an empty log");
  const folded = foldedOf(fold);
  const outcome: FoldOutcome = {
    verified: folded.verified.ok,
    endReason: fold.status === "ended" ? (folded.frame.result?.reason ?? null) : null,
    fatal: fold.status === "fatal",
  };
  const status =
    o.status === undefined
      ? fold.status
      : typeof o.status === "function"
        ? o.status(outcome)
        : o.status;
  return matchStats(folded, side, { ...o, status });
}
