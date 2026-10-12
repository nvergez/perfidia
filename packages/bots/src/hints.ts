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
  /** Where the effective config (`rules` → `config`) keeps the numbers of a battle; absent: unknown. */
  readonly combat?: CombatHints;
}

/** A path of keys into the effective config, e.g. `["time", "attackFrom"]`. */
export type ConfigPath = readonly string[];

/**
 * Battle numbers a bot cannot derive from `CompiledRules`, as paths into the effective config (so
 * overrides count). Bots that read them fall back to safety margins when a path is missing.
 */
export interface CombatHints {
  /** Game time from which a capital can be taken (before it, a won conquest is only a raid). */
  readonly capitalImmunityEnd?: ConfigPath;
  /**
   * A city's base land defense: `a·L² + b·L + c` with `{a, b, c}` at `quad`, where L is the level of
   * `building` (in the views' building levels).
   */
  readonly baseDefense?: { readonly building: string; readonly quad: ConfigPath };
  /** Land defense bonus per wall level, per mille. */
  readonly wallPmPerLevel?: ConfigPath;
  /**
   * Morale (per mille of the attack kept): `1000 − perCity × (attacker's cities − foe's cities)`,
   * clamped to `[floor, 1000]`.
   */
  readonly morale?: { readonly perCity: ConfigPath; readonly floor: ConfigPath };
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
  // Combat (§8.2, §8.5, §9.5): morale, the hall's base defense, the wall bonus, capital immunity.
  "perfidia-1": Object.freeze({
    settleOrder: Object.freeze(["home", "frontier", "backyard", "inner", "frontier"]),
    avoidTags: Object.freeze(["crown"]),
    blockedExt: Object.freeze(["siege"]),
    combat: Object.freeze({
      capitalImmunityEnd: Object.freeze(["time", "capitalImmunityEnd"]),
      baseDefense: Object.freeze({
        building: "hall",
        quad: Object.freeze(["economy", "baseDefense"]),
      }),
      wallPmPerLevel: Object.freeze(["combat", "wallPmPerLevel"]),
      morale: Object.freeze({
        perCity: Object.freeze(["combat", "moralePmPerCity"]),
        floor: Object.freeze(["combat", "moraleFloorPm"]),
      }),
    }),
  }),
  // sandbox-1 §3.8: the home island's second slot, then the shared islands; capitals fall from
  // `capitalImmunityEnd` on.
  "sandbox-1": Object.freeze({
    settleOrder: Object.freeze(["home", "shared", "shared"]),
    avoidTags: Object.freeze([]),
    blockedExt: Object.freeze([]),
    combat: Object.freeze({
      capitalImmunityEnd: Object.freeze(["time", "capitalImmunityEnd"]),
    }),
  }),
});

/** The hints of the ruleset of `ref` (`id@x.y.z` or a bare id), or `NO_HINTS`. */
export function hintsFor(ref: string): StrategyHints {
  const at = ref.indexOf("@");
  const id = at < 0 ? ref : ref.slice(0, at);
  return Object.hasOwn(RULESET_HINTS, id) ? RULESET_HINTS[id]! : NO_HINTS;
}
