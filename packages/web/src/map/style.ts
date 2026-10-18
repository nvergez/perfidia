import type { SpectatorIsland } from "@perfidia/protocol/spectator";

// The map's colours: island tints by kind (in the order kinds first appear on the map, so no ruleset
// knowledge is needed here; the skin names them), the prize island in Olympus gold, and one outline
// hue per alliance (a bloc reads at a glance from its rings, apart from the players' fills).

const LAND = Object.freeze([
  "#2E4A3F",
  "#3B4C5E",
  "#4A4537",
  "#2F4F5B",
  "#463E52",
  "#3C5233",
  "#53413A",
  "#334155",
]);

export const PRIZE_LAND = "#6B5A24";
export const PRIZE_EDGE = "oklch(0.82 0.13 85)";

/** A tint for each island kind, in the order the kinds first appear. */
export function landTints(islands: readonly SpectatorIsland[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const i of islands) {
    if (!out.has(i.kind)) out.set(i.kind, LAND[out.size % LAND.length] ?? "#334155");
  }
  return out;
}

/** Light outline hues for alliances, apart from the 12 player colours. */
const BLOCS = Object.freeze(["#F8FAFC", "#9EE7FF", "#FFB3E6", "#C4F5A5", "#D9C2FF", "#FFC29E"]);

/** An alliance's outline hue, stable for its id (`a1`, `a7`). */
export function blocColor(alliance: string): string {
  const n = Number(alliance.slice(1));
  const i = Number.isInteger(n) && n > 0 ? (n - 1) % BLOCS.length : 0;
  return BLOCS[i] ?? "#F8FAFC";
}

/** The betrayal red, for attacks launched against an ally. */
export const BETRAYAL = "oklch(0.63 0.21 25)";
