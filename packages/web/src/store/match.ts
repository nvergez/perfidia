import type {
  Frame,
  MatchMeta,
  MatchStatus,
  Moment,
  PlayerDossier,
  PublicReason,
  ReportDetail,
  ServerMsg,
  TurnAnnotation,
} from "@perfidia/protocol/spectator";
import { create } from "zustand";
import type { Mode } from "../playback/playback.ts";
import type { FeedEntry } from "../playback/timeline.ts";
import type { Skin } from "../skins/index.ts";

// The match store (phase-3 design §4.4): what the match view shows, written only by the session
// (`store/session.ts`), read by the views through the hooks of `store/hooks.ts`. The frame is the
// match at the playhead; `feed` holds every feed item up to it; caches hold annotations, dossiers
// and reports fetched on demand.

export type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "error"; readonly message: string };

export type AnnotMsg = Extract<ServerMsg, { type: "annot" }>;

export interface LoadError {
  readonly code: string;
  readonly message: string;
  readonly hint: string;
}

export interface MatchState {
  /** The match open in the view (null on other pages). */
  readonly id: string | null;
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly error: LoadError | null;
  readonly meta: MatchMeta | null;
  readonly skin: Skin | null;
  /** The match's status now (the meta's, then the live socket's). */
  readonly status: MatchStatus | null;
  readonly reason: PublicReason | null;
  /** The match at the playhead (null until the first frame arrives). */
  readonly frame: Frame | null;
  /** Game time of the playhead (updated at most ~10 times a second between frame changes). */
  readonly playhead: number;
  readonly mode: Mode;
  readonly playing: boolean;
  /** Replay speed, game-seconds per wall-second. */
  readonly speed: number;
  /** The frame is exact for the playhead (false while the lines there are still loading). */
  readonly known: boolean;
  /** Live real time: the clock is at its cap (waiting for the server). */
  readonly waiting: boolean;
  /** Every feed item up to the frame's cursor, in order. */
  readonly feed: readonly FeedEntry[];
  /** Every moment of the match (importance ≥ 2), in order. */
  readonly moments: readonly Moment[];
  /** What the client holds: from the first frame's time to the last step's time. */
  readonly loaded: { readonly fromT: number; readonly toT: number; readonly complete: boolean };
  readonly connection: "none" | "connecting" | "open" | "closed";
  /** Client time (`performance.now()`) of the last live steps message, for "waiting for the model". */
  readonly lastLiveAt: number | null;
  readonly annotations: Readonly<Record<string, Loadable<TurnAnnotation>>>;
  /** Live `annot` messages by `seat:turn`, in arrival order (Pass C shows them round by round). */
  readonly liveAnnots: Readonly<Record<string, readonly AnnotMsg[]>>;
  readonly dossiers: Readonly<Record<string, Loadable<PlayerDossier>>>;
  readonly reports: Readonly<Record<string, Loadable<ReportDetail>>>;
}

export const INITIAL_MATCH_STATE: MatchState = Object.freeze({
  id: null,
  phase: "idle",
  error: null,
  meta: null,
  skin: null,
  status: null,
  reason: null,
  frame: null,
  playhead: 0,
  mode: "replay",
  playing: false,
  speed: 3_600,
  known: true,
  waiting: false,
  feed: [],
  moments: [],
  loaded: { fromT: 0, toT: 0, complete: false },
  connection: "none",
  lastLiveAt: null,
  annotations: {},
  liveAnnots: {},
  dossiers: {},
  reports: {},
});

/** `seat:turn`, the key of annotation caches. */
export function turnKey(seat: string, turn: number): string {
  return `${seat}:${turn}`;
}

export const useMatchStore = create<MatchState>()(() => INITIAL_MATCH_STATE);
