import { create } from "zustand";
import type { CityId, PlayerId } from "../lib/ids.ts";
import { navigate, matchHref } from "../lib/router.ts";
import { readStored, writeStored } from "../lib/storage.ts";

// The UI store (phase-3 design §4.4): filters, selection, open sheets and tabs, the onboarding flag
// (kept in localStorage, every access wrapped). The pair filter mirrors the URL (`?pair=pA,pB`).

export type FeedFilter = "all" | "diplomacy" | "military" | "thoughts" | "private";
export const SIDE_TABS = ["feed", "thoughts", "players"] as const;
export type SideTab = (typeof SIDE_TABS)[number];
export const PHONE_TABS = ["board", "feed", "thoughts", "players"] as const;
export type PhoneTab = (typeof PHONE_TABS)[number];

export function isSideTab(v: string): v is SideTab {
  return SIDE_TABS.some((t) => t === v);
}

export function isPhoneTab(v: string): v is PhoneTab {
  return PHONE_TABS.some((t) => t === v);
}

const ONBOARDING_KEY = "perfidia.howToWatch.seen";

export interface UiState {
  /** The right column's tab (desktop and tablet). */
  readonly sideTab: SideTab;
  /** The tab under the map on a phone. */
  readonly phoneTab: PhoneTab;
  readonly feedFilter: FeedFilter;
  /** Players the feed is limited to (empty: everyone). */
  readonly feedPlayers: readonly PlayerId[];
  /** The pair mode: everything between two players. */
  readonly pair: readonly [PlayerId, PlayerId] | null;
  /** Players highlighted on the map (hovering a leaderboard row or a bloc); empty: none. */
  readonly highlight: readonly PlayerId[];
  /** The player whose dossier sheet is open. */
  readonly selectedPlayer: PlayerId | null;
  readonly selectedCity: CityId | null;
  readonly selectedReport: string | null;
  /** The feed item last clicked (its id, `"<seq>:<i>"`). */
  readonly selectedItem: string | null;
  /** Bots' turn summaries shown among thoughts. */
  readonly showBots: boolean;
  readonly howToWatchOpen: boolean;
  /** The viewer has dismissed "How to watch" once (this browser). */
  readonly onboardingSeen: boolean;
  /** The key moments reel is playing. */
  readonly reelActive: boolean;
  /** The turn whose detail sheet is open (Pass C, `turns/`). */
  readonly openTurn: OpenTurn | null;
}

/** A seat's turn, as the feed's turn items and the annotations number it. */
export interface OpenTurn {
  readonly seat: PlayerId;
  readonly turn: number;
}

export const useUiStore = create<UiState>()(() => ({
  sideTab: "feed",
  phoneTab: "board",
  feedFilter: "all",
  feedPlayers: [],
  pair: null,
  highlight: [],
  selectedPlayer: null,
  selectedCity: null,
  selectedReport: null,
  selectedItem: null,
  showBots: false,
  howToWatchOpen: false,
  onboardingSeen: readStored(ONBOARDING_KEY) === "1",
  reelActive: false,
  openTurn: null,
}));

const set = (patch: Partial<UiState>): void => useUiStore.setState(patch);

/** Actions on the UI store (stable functions, usable outside React). */
export const uiActions = {
  setSideTab: (sideTab: SideTab): void => set({ sideTab }),
  setPhoneTab: (phoneTab: PhoneTab): void => set({ phoneTab }),
  setFeedFilter: (feedFilter: FeedFilter): void => set({ feedFilter }),
  toggleFeedPlayer(p: PlayerId): void {
    const cur = useUiStore.getState().feedPlayers;
    set({ feedPlayers: cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p] });
  },
  clearFeedPlayers: (): void => set({ feedPlayers: [] }),
  /** Sets the pair mode and writes it into the URL of match `id` (replacing the history entry). */
  setPair(id: string, pair: readonly [PlayerId, PlayerId] | null): void {
    set({ pair });
    navigate(matchHref(id, { pair }), { replace: true });
  },
  /** The pair from the URL (the router calls it). */
  syncPair: (pair: readonly [PlayerId, PlayerId] | null): void => {
    const cur = useUiStore.getState().pair;
    if (cur?.[0] !== pair?.[0] || cur?.[1] !== pair?.[1]) set({ pair });
  },
  setHighlight: (highlight: readonly PlayerId[]): void => set({ highlight }),
  openPlayer: (selectedPlayer: PlayerId): void => set({ selectedPlayer }),
  closePlayer: (): void => set({ selectedPlayer: null }),
  selectCity: (selectedCity: CityId | null): void => set({ selectedCity }),
  selectReport: (selectedReport: string | null): void => set({ selectedReport }),
  selectItem: (selectedItem: string | null): void => set({ selectedItem }),
  setShowBots: (showBots: boolean): void => set({ showBots }),
  openHowToWatch: (): void => set({ howToWatchOpen: true }),
  closeHowToWatch(): void {
    writeStored(ONBOARDING_KEY, "1");
    set({ howToWatchOpen: false, onboardingSeen: true });
  },
  /** Opens the turn detail sheet of `seat`'s turn `turn` (Pass C). */
  openTurn: (seat: PlayerId, turn: number): void => set({ openTurn: { seat, turn } }),
  closeTurn: (): void => set({ openTurn: null }),
  startReel: (): void => set({ reelActive: true }),
  stopReel: (): void => set({ reelActive: false }),
  /** Back to defaults when another match opens (the onboarding flag stays). */
  resetForMatch: (): void =>
    set({
      feedFilter: "all",
      feedPlayers: [],
      pair: null,
      highlight: [],
      selectedPlayer: null,
      selectedCity: null,
      selectedReport: null,
      selectedItem: null,
      reelActive: false,
      openTurn: null,
    }),
};
