import type {
  Frame,
  MatchMeta,
  Moment,
  PlayerDossier,
  ReportDetail,
  SeatInfo,
  Standing,
  TurnAnnotation,
} from "@perfidia/protocol/spectator";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { PlayerId } from "../lib/ids.ts";
import type { FeedEntry } from "../playback/timeline.ts";
import type { DominationView, Skin } from "../skins/index.ts";
import {
  liveTopRound,
  roundNow,
  turnKey,
  useMatchStore,
  type AnnotMsg,
  type Loadable,
  type MatchState,
} from "./match.ts";
import {
  colorOf,
  labelOf,
  momentsUntil,
  seatOf,
  selectDomination,
  selectStandings,
} from "./selectors.ts";
import { loaders, onTick } from "./session.ts";
import { useUiStore, type UiState } from "./ui.ts";

// React hooks over the stores, for every view. Each reads the smallest slice it needs, so a view
// re-renders only when that slice changes; derived values are memoised (`selectors.ts`). Controls
// are plain functions: `controls` and `loaders` (`session.ts`), `uiActions` (`ui.ts`).

export function useMatch<T>(selector: (s: MatchState) => T): T {
  return useMatchStore(selector);
}

export function useUi<T>(selector: (s: UiState) => T): T {
  return useUiStore(selector);
}

export const useMeta = (): MatchMeta | null => useMatchStore((s) => s.meta);
export const useSkin = (): Skin | null => useMatchStore((s) => s.skin);
export const useFrame = (): Frame | null => useMatchStore((s) => s.frame);
export const usePlayhead = (): number => useMatchStore((s) => s.playhead);
export const useFeed = (): readonly FeedEntry[] => useMatchStore((s) => s.feed);
export const useMoments = (): readonly Moment[] => useMatchStore((s) => s.moments);

const NO_SEATS: readonly SeatInfo[] = Object.freeze([]);

export function useSeats(): readonly SeatInfo[] {
  return useMatchStore((s) => s.meta?.seats ?? NO_SEATS);
}

export function useSeat(seat: string): SeatInfo | null {
  return useMatchStore((s) => seatOf(s.meta, seat));
}

/** "Odysseus · p1". */
export function useSeatLabel(seat: string): string {
  return useMatchStore((s) => labelOf(s.meta, seat));
}

export function useSeatColor(seat: string | null): string {
  return useMatchStore((s) => colorOf(s.meta, seat));
}

/** The players by rank at the playhead. */
export function useStandings(): readonly Standing[] {
  return useMatchStore((s) => selectStandings(s.frame));
}

/** Blocs, countdowns and the domination threshold at the playhead (null: the ruleset has none). */
export function useDomination(): DominationView | null {
  return useMatchStore((s) => selectDomination(s.skin, s.meta, s.frame));
}

/** The win rule in one sentence, numbers from the match. */
export function useRuleSentence(): string | null {
  return useMatchStore((s) =>
    s.skin === null || s.meta === null || s.frame === null
      ? null
      : s.skin.ruleSentence(s.meta, s.frame),
  );
}

/** The moments up to the frame shown. */
export function useMomentsSoFar(): readonly Moment[] {
  return useMatchStore((s) => momentsUntil(s.moments, s.frame?.seq ?? -1));
}

/** A turn's annotation (reasoning, text, costs), fetched when `enabled`; null until asked. */
export function useAnnotation(
  seat: PlayerId,
  turn: number,
  enabled = true,
): Loadable<TurnAnnotation> | null {
  const entry = useMatchStore((s) => s.annotations[turnKey(seat, turn)] ?? null);
  useEffect(() => {
    if (enabled) loaders.annotation(seat, turn);
  }, [seat, turn, enabled]);
  return entry;
}

const NO_ANNOTS: readonly AnnotMsg[] = Object.freeze([]);

/**
 * The rounds of `seat`'s turn `turn` as the live socket brought them (`annot` messages, in arrival
 * order, a resent round replaced in place); empty for a finished match or a turn not followed live.
 */
export function useLiveAnnots(seat: PlayerId, turn: number): readonly AnnotMsg[] {
  return useMatchStore((s) => s.liveAnnots[turnKey(seat, turn)] ?? NO_ANNOTS);
}

/**
 * The round (0-based) `seat` is in, while it is in a turn: the newer of the log's (its last call's)
 * and the live socket's (a reply arrives before its calls are logged); null otherwise. Shared by
 * the leaderboard, the Thoughts column and the turn detail, so they never disagree.
 */
export function useRoundNow(seat: PlayerId): number | null {
  return useMatchStore((s) => {
    const ent = s.frame?.seats[seat];
    if (ent === undefined || !ent.inTurn) return null;
    return roundNow(ent.round, liveTopRound(s.liveAnnots[turnKey(seat, ent.turn)] ?? NO_ANNOTS));
  });
}

export interface Published {
  /** Cost, tokens, spend and cap are served (else zeros and nulls: say so, show no figure). */
  readonly costs: boolean;
  /** Reasoning summaries and reply text are served (else empty lists: say so). */
  readonly reasoning: boolean;
}

const ALL_PUBLISHED: Published = Object.freeze({ costs: true, reasoning: true });

/** What the server publishes of the agents' side files for this match (`MatchMeta.published`). */
export function usePublished(): Published {
  return useMatchStore((s) => s.meta?.published ?? ALL_PUBLISHED);
}

/** A seat's dossier (notebook, counts, spend), fetched when `seat` is set. */
export function useDossier(seat: PlayerId | null): Loadable<PlayerDossier> | null {
  const entry = useMatchStore((s) => (seat === null ? null : (s.dossiers[seat] ?? null)));
  useEffect(() => {
    if (seat !== null) loaders.dossier(seat);
  }, [seat]);
  return entry;
}

/** A report (the fullest copy is the caller's choice, from `ReportDetail.copies`). */
export function useReport(report: string | null): Loadable<ReportDetail> | null {
  const entry = useMatchStore((s) => (report === null ? null : (s.reports[report] ?? null)));
  useEffect(() => {
    if (report !== null) loaders.report(report);
  }, [report]);
  return entry;
}

/** Calls `fn` with the exact playhead on every animation frame while playing or live. */
export function useTick(fn: (playhead: number) => void): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  }, [fn]);
  useEffect(() => onTick((t) => ref.current(t)), []);
}

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribeReduced(cb: () => void): () => void {
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** The viewer asked for reduced motion: no moving markers or animations, positions only. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

const DESKTOP = "(min-width: 1280px)";
const TABLET = "(min-width: 768px)";

function subscribeMedia(cb: () => void): () => void {
  const a = window.matchMedia(DESKTOP);
  const b = window.matchMedia(TABLET);
  a.addEventListener("change", cb);
  b.addEventListener("change", cb);
  return () => {
    a.removeEventListener("change", cb);
    b.removeEventListener("change", cb);
  };
}

export type Layout = "desktop" | "tablet" | "phone";

function layoutNow(): Layout {
  if (window.matchMedia(DESKTOP).matches) return "desktop";
  if (window.matchMedia(TABLET).matches) return "tablet";
  return "phone";
}

/** The match view's layout: desktop (≥ 1280 px), tablet (≥ 768 px) or phone. */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribeMedia, layoutNow, () => "desktop");
}
