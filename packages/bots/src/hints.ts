// Optional per-ruleset hints (docs/architecture.md §11.1). This is the only bots file that may name
// a ruleset or one of its ids (§2.3, §13.4 boundary scan): every other file reads structured data
// from the `rules` tool, the views and the briefing. Without hints a bot still plays; hints only
// sharpen choices that structured data leaves open.

export interface StrategyHints {
  /**
   * Island kinds in settling order: the n-th founding (n = 1 for the second city) prefers an island
   * of kind `settleOrder[n − 1]`; past the end, or when no slot of that kind is reachable, the bot
   * falls back to its generic ranking (richness over travel time).
   */
  readonly settleOrder: readonly string[];
  /** City tags (`view_city` `tag`) of cities the bots never spy on or attack. */
  readonly avoidTags: readonly string[];
  /** Keys of a briefing city's `ext` that mean the city cannot build, recruit or send anything. */
  readonly blockedExt: readonly string[];
  /**
   * How a city's buildings add to its land defense, which the rules data does not carry; read by
   * bots that weigh spy reports (absent: they count the units only, behind a wider margin).
   */
  readonly combat?: CombatHints;
}

/**
 * A city's land defense from a spy report: `(Σ unit defense + base + perLevel × level(building)) ×
 * (1000 + wallPm × level(wall)) / 1000`, the wall being `roles.wall`; and the attacker's morale,
 * `1000 − moralePm × (its cities − the foe's)`, at least `moraleFloorPm` and at most 1000 (‰).
 */
export interface CombatHints {
  readonly building: string;
  readonly base: number;
  readonly perLevel: number;
  readonly wallPm: number;
  readonly moralePm: number;
  readonly moraleFloorPm: number;
}

/** The empty hint set: generic play. */
export const NO_HINTS: StrategyHints = Object.freeze({
  settleOrder: Object.freeze([]),
  avoidTags: Object.freeze([]),
  blockedExt: Object.freeze([]),
});

/** Hints by ruleset id (not ref: every version of a ruleset shares them). */
export const RULESET_HINTS: Readonly<Record<string, StrategyHints>> = Object.freeze({
  // The reference bot of perfidia-1 §15.1: the free home slot, a frontier, the backyard, the inner
  // island, then the next frontier. The Crown is a neutral prize with a garrison bots cannot break.
  // A besieged own city shows `ext.siege` (§8.2) and can neither build nor send.
  "perfidia-1": Object.freeze({
    settleOrder: Object.freeze(["home", "frontier", "backyard", "inner", "frontier"]),
    avoidTags: Object.freeze(["crown"]),
    blockedExt: Object.freeze(["siege"]),
    // §8.2 and §8.5 with the default config: base defense 20·hall + 50, +5% per wall level, and
    // −10% attack per city above the foe, floor 70%.
    combat: Object.freeze({
      building: "hall",
      base: 50,
      perLevel: 20,
      wallPm: 50,
      moralePm: 100,
      moraleFloorPm: 700,
    }),
  }),
  // sandbox-1 §3.8: the home island's second slot, then the shared islands.
  "sandbox-1": Object.freeze({
    settleOrder: Object.freeze(["home", "shared", "shared"]),
    avoidTags: Object.freeze([]),
    blockedExt: Object.freeze([]),
    // §3.8: 10 per keep level, no wall, no morale.
    combat: Object.freeze({
      building: "keep",
      base: 0,
      perLevel: 10,
      wallPm: 0,
      moralePm: 0,
      moraleFloorPm: 1000,
    }),
  }),
});

/** The hints of the ruleset of `ref` (`id@x.y.z` or a bare id), or `NO_HINTS`. */
export function hintsFor(ref: string): StrategyHints {
  const at = ref.indexOf("@");
  const id = at < 0 ? ref : ref.slice(0, at);
  return Object.hasOwn(RULESET_HINTS, id) ? RULESET_HINTS[id]! : NO_HINTS;
}
