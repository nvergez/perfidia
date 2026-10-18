import type { ClockSpec } from "@perfidia/protocol";
import type { MatchStatus, PublicReason } from "@perfidia/protocol/spectator";
import type { ArenaInfo, SummaryInfo } from "./rundir.ts";

// A match's status (phase-3 design §2.4), in order of precedence: `loading` while the fold has not
// reached the log's tail; `unverifiable` when Level E diverged, a line failed its schema or the
// ruleset is unknown; `ended` with an end line (`degraded` when `arena.json` says too many LLM turns
// failed); then `stopped`, `aborted`, `fatal`, `incomplete` or `degraded` from `arena.json`,
// `summary.json` or a `fatal` line; `paused` from `arena.json`; `stalled` when no line came for
// longer than the clock allows; else `live`. Reasons are a fixed vocabulary, never operator text.

export interface StatusInput {
  /** The fold has not reached the tail yet (or has not started). */
  readonly loading: boolean;
  /** Level E diverged or a line was invalid. */
  readonly unverifiable: boolean;
  /** The end line's result reason, when the log has one. */
  readonly endReason: string | null;
  /** The log has a `fatal` line. */
  readonly fatalLine: boolean;
  readonly arena: ArenaInfo | null;
  readonly summary: SummaryInfo | null;
  readonly clock: ClockSpec | null;
  /** Wall milliseconds since the log last grew. */
  readonly idleMs: number;
}

export interface StatusOut {
  readonly status: MatchStatus;
  readonly reason: PublicReason | null;
}

const LOCKSTEP_STALL_MS = 210 * 60_000;
const MIN_STALL_MS = 10 * 60_000;

/** How long a running match may stay silent before it is `stalled` (§2.4). */
export function stallAfterMs(clock: ClockSpec | null): number {
  if (clock === null || clock.kind === "lockstep") return LOCKSTEP_STALL_MS;
  const [num, den] = clock.speed;
  // A real-time host writes a `ckpt` line every game hour: 3600 / speed wall seconds.
  return Math.max(MIN_STALL_MS, Math.ceil((1.5 * 3600 * 1000 * den) / num));
}

function endReason(reason: string): PublicReason | null {
  return reason === "domination" || reason === "time" || reason === "last_standing" ? reason : null;
}

export function matchStatus(i: StatusInput): StatusOut {
  if (i.loading) return { status: "loading", reason: null };
  if (i.unverifiable) return { status: "unverifiable", reason: "unverifiable" };
  if (i.endReason !== null) {
    if (i.arena?.status === "degraded") return { status: "degraded", reason: "model_errors" };
    return { status: "ended", reason: endReason(i.endReason) };
  }
  if (i.fatalLine) return { status: "fatal", reason: "engine_error" };
  const arena = i.arena?.status;
  switch (arena) {
    case "stopped":
      return { status: "stopped", reason: "stopped_after_day" };
    case "degraded":
      return { status: "degraded", reason: "model_errors" };
    case "aborted":
      return { status: "aborted", reason: "aborted" };
    case "fatal":
      return { status: "fatal", reason: "engine_error" };
    case "incomplete":
      return { status: "incomplete", reason: null };
    case "paused":
      return { status: "paused", reason: "operator_pause" };
    case "running":
    case "ended":
    case undefined:
      break;
  }
  if (i.summary !== null) {
    if (i.summary.status === "fatal") return { status: "fatal", reason: "engine_error" };
    if (i.summary.status === "incomplete") return { status: "incomplete", reason: null };
  }
  if (i.idleMs > stallAfterMs(i.clock)) return { status: "stalled", reason: null };
  return { status: "live", reason: null };
}

/** A status after which the log cannot grow (no stall, no tailing needed for it). */
export function isFinal(status: MatchStatus): boolean {
  return (
    status === "ended" ||
    status === "degraded" ||
    status === "stopped" ||
    status === "aborted" ||
    status === "fatal" ||
    status === "incomplete"
  );
}
