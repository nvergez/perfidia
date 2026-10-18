import type { CityEnt, Frame, MatchMeta, PlayerEnt } from "@perfidia/protocol/spectator";
import type { PlayerId } from "../lib/ids.ts";

// What a skin tells the views about a ruleset (phase-3 design §4.5): labels for its buildings,
// units, queues, island kinds and resources, its `ext` objects read into typed views (blocs,
// sieges, taken cities), the one-sentence win rule built from the config, and battle reports as
// rows. Ruleset ids (buildings, units, queues, events, tags) are named in `src/skins/**` only;
// every other web source asks a skin.

/** A generic icon a skin may give an id; `src/common/skin-icon.tsx` draws it. */
export type SkinIcon =
  | "landmark"
  | "trees"
  | "pickaxe"
  | "coins"
  | "warehouse"
  | "swords"
  | "ship"
  | "shield"
  | "user"
  | "users"
  | "anchor"
  | "crown"
  | "mountain"
  | "home"
  | "tent"
  | "box"
  | "circle";

export interface Label {
  readonly name: string;
  /** A plural for counts ("12 hoplites"). */
  readonly plural: string;
  readonly icon: SkinIcon;
}

export interface DominationBloc {
  /** The bloc's key (an alliance id, or a lone player's id). */
  readonly key: string;
  readonly members: readonly PlayerId[];
  readonly cities: number;
  readonly taken: number;
}

export interface DominationCountdown {
  readonly key: string;
  readonly members: readonly PlayerId[];
  readonly cities: number | null;
  readonly taken: number | null;
  /** When the bloc wins if it holds. */
  readonly endsAt: number | null;
}

/** The win-by-domination state of a frame, numbers from the match. */
export interface DominationView {
  /** The window is open (countdowns may start). */
  readonly open: boolean;
  /** Cities a bloc must hold, and how many of them taken by conquest (null: no such condition). */
  readonly need: number | null;
  readonly needTaken: number | null;
  /** City slots on the map. */
  readonly slots: number | null;
  readonly blocs: readonly DominationBloc[];
  readonly countdowns: readonly DominationCountdown[];
  /** When the window opens, how long a bloc must hold, the last start that can still win. */
  readonly opensAt: number | null;
  readonly hold: number | null;
  readonly startBy: number | null;
}

export interface CityExtView {
  readonly points: number | null;
  /** The neutral prize city (perfidia-1: Mount Olympus). */
  readonly prize: boolean;
  /** Counts as taken by conquest for its owner's bloc. */
  readonly taken: boolean;
  /** Former owners, oldest first. */
  readonly former: readonly PlayerId[];
  readonly siege: { readonly by: PlayerId; readonly endsAt: number | null } | null;
}

export interface PlayerExtView {
  /** Position in the public tie-break order (1 = best). */
  readonly tiebreak: number | null;
  /** Cities taken by conquest and held. */
  readonly taken: number | null;
}

export interface ReportRow {
  readonly label: string;
  readonly value: string;
}

export interface ReportStack {
  readonly owner: string;
  readonly side: string;
  readonly unit: string;
  readonly before: number;
  readonly lost: number;
  readonly survived: number;
}

export interface ReportView {
  readonly title: string;
  readonly rows: readonly ReportRow[];
  readonly stacks: readonly ReportStack[];
}

export interface Skin {
  /** `perfidia-1`, or `default` for a ruleset without a skin. */
  readonly id: string;
  /** The ruleset ref it was asked for. */
  readonly ruleset: string;
  /** The setting in a few words, for headers ("Greek islands"). */
  readonly setting: string;
  building(id: string): Label;
  unit(id: string): Label;
  /** A queue: `build`, or a recruit queue of the ruleset. */
  queue(id: string): Label;
  islandKind(kind: string): Label;
  resource(id: string): Label;
  /** A battle's type (`BattleItem.kind`), e.g. "assault", "relief". */
  battleKind(kind: string): string;
  /** A siege's end cause (`SiegeItem.cause`). */
  siegeCause(cause: string): string;
  /** The prize island kind's name ("Mount Olympus"), when the ruleset has one. */
  readonly prizeName: string | null;
  isPrizeIsland(kind: string): boolean;
  /** Canonical display orders. */
  readonly buildingOrder: readonly string[];
  readonly unitOrder: readonly string[];
  city(c: CityEnt): CityExtView;
  player(p: PlayerEnt): PlayerExtView;
  domination(meta: MatchMeta, frame: Frame): DominationView | null;
  /** The win rule in one sentence, its numbers from the match's config and state. */
  ruleSentence(meta: MatchMeta, frame: Frame): string;
  /** A report's data (`ReportDetail.data`) as rows. */
  report(type: string, data: Readonly<Record<string, unknown>>): ReportView;
}
