// What the moments' live region says (phase-3 design §4.5), pure: the newest importance-3 moment
// the playhead has passed, at most one announcement every 5 s. What is already past when the match
// has loaded is not news (the baseline); a moment that comes inside the 5 s window is announced
// when the window ends (the newest one then), not dropped; a seek backwards announces nothing; and
// while the key moments reel runs (its caption is a live region itself) moments pass silently.

export const ANNOUNCE_EVERY_MS = 5_000;

export interface AnnouncedMoment {
  readonly seq: number;
  readonly title: string;
}

export interface AnnounceState {
  /** The newest moment already past (announced, or not news). */
  readonly seq: number;
  /** Client time (ms) of the last announcement. */
  readonly at: number;
}

export type AnnounceAction =
  | { readonly kind: "none" }
  | { readonly kind: "say"; readonly text: string }
  /** Ask again in `ms` (the window is still closed). */
  | { readonly kind: "later"; readonly ms: number };

export interface AnnounceInput {
  /** The newest importance-3 moment up to the playhead, if any. */
  readonly newest: AnnouncedMoment | null;
  /** The match is loaded and the playhead placed (else nothing is decided yet). */
  readonly ready: boolean;
  /** The reel runs: its captions speak. */
  readonly quiet: boolean;
  readonly now: number;
}

export function announce(
  prev: AnnounceState | null,
  i: AnnounceInput,
): { readonly state: AnnounceState | null; readonly action: AnnounceAction } {
  const none = { kind: "none" } as const;
  if (!i.ready) return { state: prev, action: none };
  const seq = i.newest?.seq ?? -1;
  if (prev === null) {
    return { state: { seq, at: Number.NEGATIVE_INFINITY }, action: none };
  }
  if (i.newest === null || seq <= prev.seq || i.quiet) {
    return { state: seq === prev.seq ? prev : { seq, at: prev.at }, action: none };
  }
  const wait = prev.at + ANNOUNCE_EVERY_MS - i.now;
  if (wait > 0) return { state: prev, action: { kind: "later", ms: wait } };
  return { state: { seq, at: i.now }, action: { kind: "say", text: i.newest.title } };
}
