import type { CityEnt, Frame, MatchMeta, PlayerEnt } from "@perfidia/protocol/spectator";
import {
  endOfMatch,
  genericCity,
  genericPlayer,
  genericReport,
  humanize,
  rawLabel,
} from "./common.ts";
import type { Skin } from "./types.ts";

// The skin of a ruleset without one (phase-3 design §4.5): raw ids, humanised; city and player
// extras read the common fields when present; no domination; the rule says the highest score wins.

export function defaultSkin(ruleset: string): Skin {
  return {
    id: "default",
    ruleset,
    setting: "islands",
    building: rawLabel,
    unit: rawLabel,
    queue: rawLabel,
    islandKind: rawLabel,
    resource: rawLabel,
    battleKind: humanize,
    siegeCause: humanize,
    prizeName: null,
    isPrizeIsland: () => false,
    buildingOrder: [],
    unitOrder: [],
    city: (c: CityEnt) => genericCity(c, false),
    player: (p: PlayerEnt) => genericPlayer(p),
    domination: (_meta: MatchMeta, _frame: Frame) => null,
    ruleSentence: (meta: MatchMeta) => `The highest score at ${endOfMatch(meta)} wins.`,
    report: (type, data) => genericReport(type, data, rawLabel),
  };
}
