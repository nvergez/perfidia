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
   * Where the effective config (`rules` → `config`) keeps the numbers of a battle, which the rules
   * data does not carry; read by bots that weigh spy reports. Absent, or a path missing: they fall
   * back to safety margins.
   */
  readonly combat?: CombatHints;
  /**
   * Where a besieged city's public `ext` (map rows, city views) names its besieger and the siege's
   * end, and where the config keeps a siege's length. Read by the relief module (`relief.ts`) only;
   * absent, a besieger is found from the city's `hold` groups and a siege has no known end.
   */
  readonly siege?: SiegeHints;
  /**
   * Where the running domination countdowns are listed. Read by the relief module (`relief.ts`,
   * whose countdown helpers conqueror@2 uses too); absent, the bot never reacts to a countdown.
   */
  readonly domination?: DominationHints;
}

/** A path of keys into the effective config, e.g. `["time", "attackFrom"]`. */
export type ConfigPath = readonly string[];

/** Siege fields of a city's public `ext`, and the siege length in the effective config. */
export interface SiegeHints {
  /** Path in the city's `ext` to the besieger's player id. */
  readonly by: ConfigPath;
  /** Path in the city's `ext` to the siege's end: a game time, or a `[time, text]` pair. */
  readonly ends: ConfigPath;
  /** Path in the effective config to a siege's length in seconds. */
  readonly duration?: ConfigPath;
}

/** Domination countdowns: where the briefing lists them and how one reads. */
export interface DominationHints {
  /** Path in the briefing's `ext` to the array of running countdowns. */
  readonly countdowns: ConfigPath;
  /** Key of a countdown's member list (player ids). */
  readonly members: string;
  /** Key of a countdown's end: a game time, or a `[time, text]` pair. */
  readonly ends: string;
  /** Path in the leaderboard's `ext` to the bloc threshold in cities. */
  readonly need?: ConfigPath;
  /**
   * Path in the leaderboard's `ext` to the taken (conquered) cities the threshold also asks for,
   * and path in the briefing's `ext` to the taken cities of the seat's own bloc. Absent (or a path
   * missing), the threshold is cities only.
   */
  readonly needTaken?: ConfigPath;
  readonly ownTaken?: ConfigPath;
}

/**
 * Battle numbers a bot cannot derive from `CompiledRules`, as paths into the effective config (so
 * overrides count). A city's land defense is `(Σ unit defense + base) × (1000 + wallPm × wall) /
 * 1000`, the wall being `roles.wall`.
 */
export interface CombatHints {
  /** Game time from which a capital can be taken (before it, a won conquest is only a raid). */
  readonly capitalImmunityEnd?: ConfigPath;
  /**
   * A city's base land defense at level L of `building` (in the views' building levels):
   * `a·L² + b·L + c` with `{a, b, c}` at `quad`, or `n·L` with the integer n at `perLevel`.
   */
  readonly baseDefense?: {
    readonly building: string;
    readonly quad?: ConfigPath;
    readonly perLevel?: ConfigPath;
  };
  /** Land defense bonus per wall level, per mille. */
  readonly wallPmPerLevel?: ConfigPath;
  /**
   * Morale (per mille of the attack kept): `1000 − perCity × (attacker's cities − foe's cities)`,
   * clamped to `[floor, 1000]`.
   */
  readonly morale?: { readonly perCity: ConfigPath; readonly floor: ConfigPath };
  /**
   * Stock of each resource a raid cannot take, per level of the storage building (`roles.storage`).
   * Absent: every unit of stock counts as lootable. Read by `rusher@3` only.
   */
  readonly lootProtectPerLevel?: ConfigPath;
}

/** The empty hint set: generic play. */
export const NO_HINTS: StrategyHints = Object.freeze({
  settleOrder: Object.freeze([]),
  avoidTags: Object.freeze([]),
  blockedExt: Object.freeze([]),
});

/**
 * Hints by exact ruleset ref (`id@x.y.z`) or by ruleset id: `hintsFor` tries the exact ref first,
 * then the id, so the id entry serves every version without its own (a version that renames ids
 * needs its own entry).
 */
export const RULESET_HINTS: Readonly<Record<string, StrategyHints>> = Object.freeze({
  // The reference bot of perfidia-1 §15.1: the free home slot, a frontier, the backyard, the inner
  // island, then the next frontier. The Crown is a neutral prize with a garrison bots cannot break.
  // A besieged own city shows `ext.siege` (§8.2) and can neither build nor send.
  // Combat (§8.2, §8.5, §8.7, §9.5): morale, the hall's base defense, the wall bonus, capital
  // immunity, the stock a raid cannot take.
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
      lootProtectPerLevel: Object.freeze(["economy", "lootProtectPerLevel"]),
    }),
    // §12: a besieged city's public extras `siege {by, ends}`; §16 `time.siegeDuration`. §13.2:
    // the briefing's `countdowns [{key, members, cities, need, ends}]`, the leaderboard's
    // `domination.need`.
    siege: Object.freeze({
      by: Object.freeze(["siege", "by"]),
      ends: Object.freeze(["siege", "ends"]),
      duration: Object.freeze(["time", "siegeDuration"]),
    }),
    domination: Object.freeze({
      countdowns: Object.freeze(["countdowns"]),
      members: "members",
      ends: "ends",
      need: Object.freeze(["domination", "need"]),
    }),
  }),
  // perfidia-1@1.1.0 (docs/rulesets/perfidia-1.md §0.1): 1.0.0's hints with the ids of the Greek
  // setting (the acropolis gives the base defense, and the neutral prize city is tagged olympus),
  // and where the taken cities domination by conquest asks for are shown.
  "perfidia-1@1.1.0": Object.freeze({
    settleOrder: Object.freeze(["home", "frontier", "backyard", "inner", "frontier"]),
    avoidTags: Object.freeze(["olympus"]),
    blockedExt: Object.freeze(["siege"]),
    combat: Object.freeze({
      capitalImmunityEnd: Object.freeze(["time", "capitalImmunityEnd"]),
      baseDefense: Object.freeze({
        building: "acropolis",
        quad: Object.freeze(["economy", "baseDefense"]),
      }),
      wallPmPerLevel: Object.freeze(["combat", "wallPmPerLevel"]),
      morale: Object.freeze({
        perCity: Object.freeze(["combat", "moralePmPerCity"]),
        floor: Object.freeze(["combat", "moraleFloorPm"]),
      }),
      lootProtectPerLevel: Object.freeze(["economy", "lootProtectPerLevel"]),
    }),
    // §12: `siege {by, ends}` as in 1.0.0. §13.2: the briefing's `countdowns [{key, members,
    // cities, taken, need, needTaken, ends}]` and own `bloc {…, taken}`, the leaderboard's
    // `domination.need` (cities) and `domination.needTaken`: domination needs taken cities.
    siege: Object.freeze({
      by: Object.freeze(["siege", "by"]),
      ends: Object.freeze(["siege", "ends"]),
      duration: Object.freeze(["time", "siegeDuration"]),
    }),
    domination: Object.freeze({
      countdowns: Object.freeze(["countdowns"]),
      members: "members",
      ends: "ends",
      need: Object.freeze(["domination", "need"]),
      needTaken: Object.freeze(["domination", "needTaken"]),
      ownTaken: Object.freeze(["bloc", "taken"]),
    }),
  }),
  // sandbox-1 §3.8: the home island's second slot, then the shared islands; capitals fall from
  // `capitalImmunityEnd` on.
  "sandbox-1": Object.freeze({
    settleOrder: Object.freeze(["home", "shared", "shared"]),
    avoidTags: Object.freeze([]),
    blockedExt: Object.freeze([]),
    // §3.8: 10 per keep level by default, no wall, no morale.
    combat: Object.freeze({
      capitalImmunityEnd: Object.freeze(["time", "capitalImmunityEnd"]),
      baseDefense: Object.freeze({
        building: "keep",
        perLevel: Object.freeze(["combat", "keepDefense"]),
      }),
    }),
  }),
});

/**
 * The hints of the ruleset of `ref`: the entry of the exact ref (`id@x.y.z`), else the entry of its
 * id (a bare id reads the id entry only), else `NO_HINTS`.
 */
export function hintsFor(ref: string): StrategyHints {
  if (Object.hasOwn(RULESET_HINTS, ref)) return RULESET_HINTS[ref]!;
  const at = ref.indexOf("@");
  const id = at < 0 ? ref : ref.slice(0, at);
  return Object.hasOwn(RULESET_HINTS, id) ? RULESET_HINTS[id]! : NO_HINTS;
}
