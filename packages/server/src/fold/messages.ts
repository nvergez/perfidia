import type {
  HourPoint,
  MatchId,
  MatchStatus,
  Moment,
  NotebookHistory,
  ReportDetail,
  Seq,
  SpectatorMap,
  Step,
  TimelineId,
  Verified,
} from "@perfidia/protocol/spectator";
import type { Keyframe, SeatCounts } from "@perfidia/spectator";

// The messages between the server's main thread and its fold workers (phase-3 design §2.5). The
// main thread reads the files and sends raw lines; a worker parses, replays and projects them, and
// sends back what each slice of work added. A fold is named by a `key` (a new key after a log is
// replaced). Steps depend on the log prefix only, so a refold of the same log sends the same steps.

export type ToWorker =
  | {
      readonly type: "open";
      readonly key: number;
      readonly match: MatchId;
      /** The timeline id the frames carry (the log's own, unless the server salted it). */
      readonly timeline: TimelineId;
    }
  | { readonly type: "lines"; readonly key: number; readonly lines: readonly string[] }
  | { readonly type: "close"; readonly key: number };

export interface SeatAux {
  readonly seat: string;
  readonly notes: string;
  readonly counts: SeatCounts;
  /** Score and cities at every hourly checkpoint so far. */
  readonly hourly: readonly HourPoint[];
  /** The notebook's newest versions. */
  readonly notebook: NotebookHistory;
}

export interface FoldBatch {
  /** The cursor of the last line folded (or counted after a halt). */
  readonly lastSeq: Seq;
  readonly lastT: number;
  /** The fold's status: `live`, `ended`, `fatal` or `unverifiable`. */
  readonly status: MatchStatus;
  readonly verified: Verified;
  /** Sent with the first batch (after the header line). */
  readonly map: SpectatorMap | null;
  readonly steps: readonly Step[];
  readonly keyframes: readonly Keyframe[];
  readonly moments: readonly Moment[];
  /** Report copies named by the new steps' items. */
  readonly reports: readonly ReportDetail[];
  /** Seats whose notebook, counts, hourly points or notebook history changed. */
  readonly seats: readonly SeatAux[];
  readonly drift: string | null;
  /** Every line sent so far has been folded. */
  readonly idle: boolean;
}

export type FromWorker =
  | { readonly type: "batch"; readonly key: number; readonly batch: FoldBatch }
  | { readonly type: "failed"; readonly key: number; readonly reason: string };
