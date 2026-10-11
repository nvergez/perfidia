import { type DeepReadonly, type RulesetRef, z } from "@perfidia/protocol";

// The config of sandbox-1 (docs/architecture.md §3.8) as a Zod schema, with its defaults. Every
// number of §3.8 is a config default and every number is an integer; the fixed fields are
// `z.literal`. Cross-field rules live in the final `superRefine`; the kernel runs the generic
// compile checks (§3.6).
//
// sandbox-1 is a test ruleset: it exists to prove that two rulesets coexist in one build and that
// the core does not secretly depend on perfidia-1. So none of its building, unit or queue ids is
// shared with perfidia-1, and its numbers differ wherever core, gateway or bot code could hard-code
// one (minTravel 4800, not 3600).

export const SANDBOX_1_ID = "sandbox-1";
export const SANDBOX_1_VERSION = "1.0.0";
export const SANDBOX_1_REF: RulesetRef = "sandbox-1@1.0.0";

/** Building ids in canonical order. */
export const SANDBOX_BUILDINGS = Object.freeze([
  "keep",
  "sawmill",
  "pit",
  "forge",
  "depot",
  "camp",
  "docks",
] as const);
export type SandboxBuilding = (typeof SANDBOX_BUILDINGS)[number];

/** Unit ids in canonical order. */
export const SANDBOX_UNITS = Object.freeze(["spearman", "axeman", "colonist", "boat"] as const);
export type SandboxUnit = (typeof SANDBOX_UNITS)[number];

/** The two recruit queues; each is named after the building that trains it. */
export const SANDBOX_QUEUES = Object.freeze(["camp", "docks"] as const);
export type SandboxQueue = (typeof SANDBOX_QUEUES)[number];

/** Island kinds: one of each per sector. */
export const SANDBOX_ISLAND_KINDS = Object.freeze(["home", "shared"] as const);
export type SandboxIslandKind = (typeof SANDBOX_ISLAND_KINDS)[number];

/** The buildings a capital and a founded city start with (at `start.level`); the others start at 0. */
export const START_BUILDINGS: readonly SandboxBuilding[] = Object.freeze([
  "keep",
  "sawmill",
  "pit",
  "forge",
  "depot",
]);

// Upper bounds, so that no schema-valid config makes `compile`, `createWorld` or a battle lose
// integer exactness (docs/architecture.md §3.6: a bad config is rejected with a path, never by an
// engine bug). Each is far above the defaults.

/** Building levels: tables have `maxLevel + 1` entries. */
export const MAX_LEVEL = 50;
/** Per-level coefficients and bases of the level tables, unit stats. */
export const MAX_PARAM = 10_000;
/** Amounts of resources: costs, stocks, spy gold, shipment caps. */
export const MAX_AMOUNT = 1_000_000;
/** Times and durations in game-seconds (about 1157 game days). */
export const MAX_TIME = 100_000_000;
/** Map sizes in tiles. */
export const MAX_TILES = 10_000;
/** Seconds per tile. */
export const MAX_PACE = 3600;
/** Slots per island. */
export const MAX_SLOTS = 100;
/** Island richness, per mille. */
export const MAX_RICHNESS_PM = 5000;
/** Unit counts in a config (start units, batch sizes). */
export const MAX_COUNT = 100_000;

const Int = z.int().nonnegative();
const Param = Int.max(MAX_PARAM, { error: `at most ${MAX_PARAM}` });
const Amount = Int.max(MAX_AMOUNT, { error: `at most ${MAX_AMOUNT}` });
const Time = Int.max(MAX_TIME, { error: `at most ${MAX_TIME} s` });
const Tiles = Int.max(MAX_TILES, { error: `at most ${MAX_TILES} tiles` });
const Richness = Int.max(MAX_RICHNESS_PM, { error: `at most ${MAX_RICHNESS_PM}‰` });
const Count = Int.max(MAX_COUNT, { error: `at most ${MAX_COUNT}` });
const PerMille = Int.max(1000, { error: "at most 1000‰" });
const Level = Int.max(MAX_LEVEL, { error: `at most ${MAX_LEVEL}` });
const AtLeastOne = z.int().min(1, { error: "must be ≥ 1" });

/** A field `sandbox-1@1.0.0` fixes: overriding it is rejected with a message naming the field. */
function fixed<const V extends number>(value: V, path: string) {
  return z.literal(value, {
    error: `${path} is fixed by ${SANDBOX_1_REF} at ${value}: it cannot be overridden`,
  });
}

/** A scheduled duration or a world timer: every scheduled duration is ≥ 1 s (§3.6). */
function duration(path: string) {
  return z
    .int()
    .min(1, { error: `${path} is a scheduled duration: it must be ≥ 1 s` })
    .max(MAX_TIME, { error: `at most ${MAX_TIME} s` });
}

const CostSchema = z.strictObject({ wood: Amount, stone: Amount, gold: Amount });

/** A land fighter (spearman, axeman), recruited in the camp. */
const FighterSchema = z.strictObject({
  attack: Param,
  defense: Param,
  carry: Param,
  pop: Param,
  cost: CostSchema,
  time: duration("unit time"),
  /** Camp level required; 0 = none. */
  camp: Level,
});

const ColonistSchema = z.strictObject({
  pop: Param,
  /** Cost of the k-th colonist is `cost × min(k, scaleCap)`. */
  cost: CostSchema,
  scaleCap: AtLeastOne.max(MAX_LEVEL, { error: `at most ${MAX_LEVEL}` }),
  time: duration("units.colonist.time"),
  camp: Level,
  maxPerOrder: AtLeastOne.max(MAX_COUNT, { error: `at most ${MAX_COUNT}` }),
});

const BoatSchema = z.strictObject({
  /** Pop of land units one boat carries across water (the transport rule). */
  capacity: Param,
  pop: Param,
  cost: CostSchema,
  time: duration("units.boat.time"),
  /** Docks level required; 0 = none. */
  docks: Level,
});

const ConfigShape = z.strictObject({
  players: z.strictObject({ min: fixed(2, "players.min"), max: fixed(12, "players.max") }),
  time: z.strictObject({
    matchEnd: duration("time.matchEnd"),
    attackFrom: Time,
    minTravel: duration("time.minTravel"),
    /** The `hill_open` world timer. */
    hillOpen: duration("time.hillOpen"),
    /** A capital is captured only by an attack landing at or after this time. */
    capitalImmunityEnd: Time,
  }),
  map: z.strictObject({
    /** Tiles per sector along the ring; the ring is `sectorWidth × N` tiles around. */
    sectorWidth: AtLeastOne.max(MAX_TILES, { error: `at most ${MAX_TILES} tiles` }),
    home: z.strictObject({
      slots: AtLeastOne.max(MAX_SLOTS, {
        error: `at most ${MAX_SLOTS}`,
      }),
      richnessPm: Richness,
    }),
    shared: z.strictObject({
      /** Offset from the sector's home island; `dx < sectorWidth` (checked). */
      dx: Tiles,
      dy: Tiles,
      slots: Int.max(MAX_SLOTS, { error: `at most ${MAX_SLOTS}` }),
      richnessPm: Richness,
    }),
  }),
  travel: z.strictObject({
    /** Seconds per tile on top of `time.minTravel`, for every movement kind. */
    perTile: Int.max(MAX_PACE, { error: `at most ${MAX_PACE} s per tile` }),
  }),
  economy: z.strictObject({
    resourceScale: fixed(3600, "economy.resourceScale"),
    maxLevel: AtLeastOne.max(MAX_LEVEL, { error: `at most ${MAX_LEVEL}` }),
    /** Per hour: `level0` at level 0, `base + perLevel × L` from level 1. */
    production: z.strictObject({ level0: Param, base: Param, perLevel: Param }),
    /** Depot level L holds `base + perLevel × L` of each resource. */
    storage: z.strictObject({ base: Param, perLevel: Param }),
    /** Keep level L allows `base + perLevel × L` pop. */
    population: z.strictObject({ base: Param, perLevel: Param }),
    /** Level L costs `buildCost × L`. */
    buildCost: z.strictObject({ wood: Param, stone: Param, gold: Param }),
    /** Level L takes `buildTime × L` s. */
    buildTime: AtLeastOne.max(MAX_PARAM, { error: `at most ${MAX_PARAM} s per level` }),
    /** Keep level the camp and the docks require; 0 = none. */
    militaryKeep: Level,
  }),
  units: z.strictObject({
    spearman: FighterSchema,
    axeman: FighterSchema,
    colonist: ColonistSchema,
    boat: BoatSchema,
  }),
  start: z.strictObject({
    /** Level of the start buildings (keep, sawmill, pit, forge, depot) in capitals and founded cities. */
    level: Level,
    /** Whole units of each resource in a capital. */
    capitalStock: Amount,
    /** Whole units of each resource in a founded city. */
    cityStock: Amount,
    /** Spearmen at home in each capital. */
    spearmen: Count,
  }),
  queues: z.strictObject({
    buildMax: AtLeastOne.max(MAX_PARAM, { error: `at most ${MAX_PARAM}` }),
    recruitBatches: AtLeastOne.max(MAX_PARAM, { error: `at most ${MAX_PARAM}` }),
    /** Units per order and per batch (the colonist has its own `maxPerOrder`). */
    batchMax: AtLeastOne.max(MAX_COUNT, { error: `at most ${MAX_COUNT}` }),
    /** Refund of a queued item that has not started. */
    refundQueuedPm: PerMille,
    /** Refund of the item in progress. */
    refundActivePm: PerMille,
  }),
  movement: z.strictObject({
    /** Supports in flight can be recalled within this many seconds of launch. */
    recallWindow: Time,
    /** In-flight cargo cap `shipmentBase + shipmentPerDocks × docks`. */
    shipmentBase: Amount,
    shipmentPerDocks: Amount,
  }),
  combat: z.strictObject({
    /** Defense per keep level. */
    keepDefense: Param,
    /** Share of each resource in stock that a raid can take. */
    lootPm: PerMille,
  }),
  spy: z.strictObject({
    minGold: Amount,
    /** A spy succeeds iff `gold > counterBase + Σ land pop present`. */
    counterBase: Amount,
  }),
  diplomacy: z.strictObject({
    allianceMax: AtLeastOne.max(MAX_PARAM, { error: `at most ${MAX_PARAM}` }),
    maxPacts: Param,
    /** `null`: pacts never expire. */
    pactDuration: duration("diplomacy.pactDuration").nullable(),
    maxOpenProposals: Param,
    proposalTtl: duration("diplomacy.proposalTtl"),
    messageMaxChars: Param,
    proposalTextMaxChars: Param,
    allianceNameMaxChars: Param,
  }),
  names: z.strictObject({
    /** Longest city name `rename_city` accepts. */
    cityMaxChars: AtLeastOne.max(MAX_PARAM, { error: `at most ${MAX_PARAM}` }),
  }),
  score: z.strictObject({ perCity: Param, perLevel: Param }),
  victory: z.strictObject({
    /** Hill: a player wins with ≥ `ceilDiv(totalCities × hillPm, 1000)` cities… */
    hillPm: AtLeastOne.max(1000, { error: "at most 1000‰" }),
    /** …and at least this many. */
    hillMinCities: AtLeastOne.max(MAX_COUNT, { error: `at most ${MAX_COUNT}` }),
  }),
  gateway: z.strictObject({
    roundTripsPerWake: Param,
    toolCallsPerRoundTrip: Param,
    /** `null`: no per-wake call cap. */
    toolCallsPerWake: Param.nullable(),
    ownWakesPerDay: Param,
    socialWakesPerDay: Param,
    groupWindow: Time,
    urgentMinGap: Time,
    selfWake: z.strictObject({ min: Time, max: Time }),
    safetyWake: Time,
    attackLaunchesPerDay: Param,
    messagesPerDay: Param,
    notesMaxChars: Param,
  }),
});

type ConfigShapeOutput = z.infer<typeof ConfigShape>;

/** The cross-field rules: issues with the dotted config path they concern. */
function crossFieldIssues(config: ConfigShapeOutput, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: "custom", path, message });
  };
  const max = config.economy.maxLevel;
  if (config.map.shared.dx >= config.map.sectorWidth) {
    issue(
      ["map", "shared", "dx"],
      `is ${config.map.shared.dx}; the shared island must sit inside its sector (below map.sectorWidth = ${config.map.sectorWidth}), so ring distances stay well defined`,
    );
  }
  if (config.start.level > max) {
    issue(["start", "level"], `is ${config.start.level}, above economy.maxLevel (${max})`);
  }
  const levels: [string[], number][] = [
    [["economy", "militaryKeep"], config.economy.militaryKeep],
    [["units", "spearman", "camp"], config.units.spearman.camp],
    [["units", "axeman", "camp"], config.units.axeman.camp],
    [["units", "colonist", "camp"], config.units.colonist.camp],
    [["units", "boat", "docks"], config.units.boat.docks],
  ];
  for (const [path, level] of levels) {
    if (level > max) {
      issue(
        path,
        `requires level ${level}, above economy.maxLevel (${max}): it could never be met`,
      );
    }
  }
  const cap = config.economy.storage.base + config.economy.storage.perLevel * config.start.level;
  if (config.start.capitalStock > cap) {
    issue(
      ["start", "capitalStock"],
      `is ${config.start.capitalStock}, above the storage cap ${cap} of a depot at start.level ${config.start.level}`,
    );
  }
}

/** The sandbox-1 config schema (docs/architecture.md §3.8). */
export const SandboxConfigSchema = ConfigShape.superRefine(crossFieldIssues);
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

function deepFreeze(value: unknown): void {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}

const res = (wood: number, stone: number, gold: number) => ({ wood, stone, gold });

const defaults: SandboxConfig = {
  players: { min: 2, max: 12 },
  time: {
    matchEnd: 604800,
    attackFrom: 21600,
    minTravel: 4800,
    hillOpen: 172800,
    capitalImmunityEnd: 172800,
  },
  map: {
    sectorWidth: 40,
    home: { slots: 2, richnessPm: 1000 },
    shared: { dx: 20, dy: 15, slots: 2, richnessPm: 1500 },
  },
  travel: { perTile: 60 },
  economy: {
    resourceScale: 3600,
    maxLevel: 8,
    production: { level0: 20, base: 40, perLevel: 40 },
    storage: { base: 800, perLevel: 700 },
    population: { base: 50, perLevel: 40 },
    buildCost: res(30, 30, 10),
    buildTime: 600,
    militaryKeep: 2,
  },
  units: {
    spearman: {
      attack: 5,
      defense: 15,
      carry: 10,
      pop: 1,
      cost: res(20, 30, 20),
      time: 240,
      camp: 1,
    },
    axeman: {
      attack: 15,
      defense: 5,
      carry: 25,
      pop: 1,
      cost: res(30, 20, 25),
      time: 240,
      camp: 1,
    },
    colonist: {
      pop: 5,
      cost: res(300, 300, 300),
      scaleCap: 6,
      time: 3600,
      camp: 2,
      maxPerOrder: 1,
    },
    boat: { capacity: 15, pop: 2, cost: res(100, 30, 50), time: 900, docks: 1 },
  },
  start: { level: 1, capitalStock: 500, cityStock: 200, spearmen: 8 },
  queues: {
    buildMax: 4,
    recruitBatches: 4,
    batchMax: 300,
    refundQueuedPm: 1000,
    refundActivePm: 500,
  },
  movement: { recallWindow: 900, shipmentBase: 300, shipmentPerDocks: 300 },
  combat: { keepDefense: 10, lootPm: 500 },
  spy: { minGold: 50, counterBase: 50 },
  diplomacy: {
    allianceMax: 3,
    maxPacts: 1,
    pactDuration: null,
    maxOpenProposals: 2,
    proposalTtl: 21600,
    messageMaxChars: 500,
    proposalTextMaxChars: 200,
    allianceNameMaxChars: 16,
  },
  names: { cityMaxChars: 16 },
  score: { perCity: 50, perLevel: 2 },
  victory: { hillPm: 500, hillMinCities: 2 },
  gateway: {
    roundTripsPerWake: 6,
    toolCallsPerRoundTrip: 8,
    toolCallsPerWake: 30,
    ownWakesPerDay: 8,
    socialWakesPerDay: 6,
    groupWindow: 300,
    urgentMinGap: 300,
    selfWake: { min: 1800, max: 21600 },
    safetyWake: 21600,
    attackLaunchesPerDay: 10,
    messagesPerDay: 10,
    notesMaxChars: 2000,
  },
};
deepFreeze(defaults);

/** The default config of sandbox-1@1.0.0 (frozen). */
export const SANDBOX_1_DEFAULTS: DeepReadonly<SandboxConfig> = defaults;

/** `Ruleset.players`: the allowed player counts (2–12). */
export function playerRange(config: DeepReadonly<SandboxConfig>): { min: number; max: number } {
  return { min: config.players.min, max: config.players.max };
}
