import { ENGINE_VERSION } from "@perfidia/engine";
import { canonicalJson, fnv1a64, sha256Hex } from "@perfidia/engine/core";
import type { HeaderLine, Sha256, TimelineId } from "@perfidia/protocol";

// The fold's version and the ids derived from it (phase-3 design §2.5, §3.3): a log is named by the
// sha256 of its header line (`logId`), and the steps of one log by its timeline id, which also
// changes with the fold's output format (`TIMELINE_VERSION`) and the engine version. A client that
// holds steps of another timeline must start over.

/** Bumped by any change to what the fold outputs for the same log (3: `TurnItem.results`). */
export const TIMELINE_VERSION = 3;

/** The sha256 of the header line as written (canonical JSON). */
export function logIdOf(header: HeaderLine): Sha256 {
  return sha256Hex(canonicalJson(header));
}

/** The timeline id of a log: FNV-1a 64 of its log id, `TIMELINE_VERSION` and `ENGINE_VERSION`. */
export function timelineIdOf(logId: Sha256): TimelineId {
  return fnv1a64(`${logId}:${TIMELINE_VERSION}:${ENGINE_VERSION}`);
}
