import { type DeepReadonly, ResSchema, type RulesetRef, z } from "@perfidia/protocol";
import { NAMES_1_0_0 } from "./names.ts";
import {
  AtLeastOne,
  BuildingSchema,
  coreSections,
  crossFieldIssuesFor,
  deepFreeze,
  Int,
  KindSchema,
  OccupiedKindSchema,
  SeedUnitsSchema,
  UnitSchema,
} from "./schema.ts";

// The RulesConfig of perfidia-1 §16 as a Zod schema, with its defaults. Every number is an integer;
// the fixed fields are `z.literal`. The cross-field rules of §16 that belong to the schema live in
// the final `superRefine`; `check.ts` adds the ruleset's compile checks, and the kernel runs the
// generic ones (docs/architecture.md §3.6). The building blocks, which later versions share, are
// `schema.ts`'s.

export {
  MAX_JITTER,
  MAX_PACE,
  MAX_TABLE_SIZE,
  MAX_TILES,
  RECRUIT_QUEUES,
  homeRadius,
  playerRange,
  quad,
  type BuildingConfig,
  type CitySeedConfig,
  type KindConfig,
  type PerfidiaCore,
  type Quad,
  type RecruitQueue,
  type UnitConfig,
} from "./schema.ts";

export const PERFIDIA_1_ID = "perfidia-1";
export const PERFIDIA_1_VERSION = "1.0.0";
export const PERFIDIA_1_REF: RulesetRef = "perfidia-1@1.0.0";

/** Building ids in canonical order (§1.1). */
export const BUILDING_IDS = Object.freeze([
  "hall",
  "lumber",
  "quarry",
  "mine",
  "warehouse",
  "barracks",
  "harbor",
  "wall",
] as const);
export type PerfidiaBuilding = (typeof BUILDING_IDS)[number];

/** Unit ids in canonical order (§1.1). */
export const UNIT_IDS = Object.freeze([
  "guard",
  "raider",
  "settler",
  "transport",
  "warship",
] as const);
export type PerfidiaUnit = (typeof UNIT_IDS)[number];

/** Island kinds in canonical order (§1.1). */
export const ISLAND_KINDS = Object.freeze([
  "crown",
  "home",
  "backyard",
  "frontier",
  "inner",
  "hub",
] as const);
export type IslandKind = (typeof ISLAND_KINDS)[number];

/** The `City.tag` of the neutral Crown city (§9.6). */
export const CROWN_TAG = "crown";

const LevelsSchema = z.strictObject({
  hall: Int,
  lumber: Int,
  quarry: Int,
  mine: Int,
  warehouse: Int,
  barracks: Int,
  harbor: Int,
  wall: Int,
});

const CitySeedSchema = z.strictObject({
  buildings: LevelsSchema,
  /** Whole units of each resource. */
  stock: ResSchema,
  units: SeedUnitsSchema,
});

const core = coreSections(PERFIDIA_1_REF);

const ConfigShape = z.strictObject({
  players: core.players,
  time: core.time,
  map: core.map.extend({
    kinds: z.strictObject({
      crown: OccupiedKindSchema,
      home: OccupiedKindSchema,
      backyard: KindSchema,
      frontier: KindSchema,
      inner: KindSchema,
      hub: KindSchema,
    }),
  }),
  start: z.strictObject({
    capital: CitySeedSchema,
    newCity: CitySeedSchema,
    crown: CitySeedSchema,
  }),
  economy: core.economy,
  buildings: z.strictObject({
    hall: BuildingSchema,
    lumber: BuildingSchema,
    quarry: BuildingSchema,
    mine: BuildingSchema,
    warehouse: BuildingSchema,
    barracks: BuildingSchema,
    harbor: BuildingSchema,
    wall: BuildingSchema,
  }),
  units: z.strictObject({
    guard: UnitSchema,
    raider: UnitSchema,
    settler: UnitSchema,
    transport: UnitSchema,
    warship: UnitSchema,
  }),
  settler: core.settler,
  queues: core.queues,
  movement: core.movement,
  combat: core.combat,
  spy: core.spy,
  diplomacy: core.diplomacy,
  scoring: z.strictObject({
    cityBase: Int,
    perBuildingLevel: Int,
    crownBonus: Int,
    killPopPerPoint: AtLeastOne,
    killCapPm: Int,
  }),
  victory: z.strictObject({ dominationPm: Int, dominationMinPerPlayer: Int }),
  gateway: core.gateway,
});

/** The perfidia-1 RulesConfig schema (§16). */
export const PerfidiaConfigSchema = ConfigShape.superRefine(crossFieldIssuesFor(NAMES_1_0_0));
export type PerfidiaConfig = z.infer<typeof PerfidiaConfigSchema>;

const res = (wood: number, stone: number, gold: number) => ({ wood, stone, gold });

const START_LEVELS = {
  hall: 1,
  lumber: 1,
  quarry: 1,
  mine: 1,
  warehouse: 1,
  barracks: 0,
  harbor: 0,
  wall: 0,
};

const defaults: PerfidiaConfig = {
  players: { min: 6, max: 12 },
  time: {
    day: 86400,
    matchEnd: 604800,
    protectionEnd: 43200,
    capitalImmunityEnd: 172800,
    minTravel: 3600,
    sameIslandTravel: 3600,
    recallWindow: 600,
    siegeDuration: 21600,
    dominationStart: 259200,
    dominationHold: 86400,
    proposalTtl: 43200,
    pactDuration: 172800,
    killCreditCooldown: 86400,
  },
  map: {
    homeRadius: { 6: 180, 7: 207, 8: 235, 9: 263, 10: 291, 11: 319, 12: 348 },
    centerMargin: 120,
    radius: { backyardOffset: 80, frontierOffset: 0, innerOffset: -80, hub: 60 },
    hubMaxPlayers: 7,
    radialJitter: 10,
    kinds: {
      crown: { slots: 1, richnessPm: 1500 },
      home: { slots: 2, richnessPm: 1000 },
      backyard: { slots: 1, richnessPm: 1000 },
      frontier: { slots: 2, richnessPm: 1500 },
      inner: { slots: 1, richnessPm: 1250 },
      hub: { slots: 1, richnessPm: 1250 },
    },
  },
  start: {
    capital: { buildings: { ...START_LEVELS }, stock: res(800, 800, 800), units: { guard: 10 } },
    newCity: { buildings: { ...START_LEVELS }, stock: res(300, 300, 300), units: {} },
    crown: {
      buildings: {
        hall: 5,
        lumber: 5,
        quarry: 5,
        mine: 5,
        warehouse: 5,
        barracks: 5,
        harbor: 5,
        wall: 5,
      },
      stock: res(3000, 3000, 3000),
      units: { guard: 400, warship: 10 },
    },
  },
  economy: {
    resourceScale: 3600,
    maxLevel: 10,
    levelWeight: { a: 1, b: 3, c: 6 },
    levelWeightDiv: 10,
    production: { a: 5, b: 20, c: 50 },
    warehouseCap: { a: 60, b: 280, c: 660 },
    lootProtectPerLevel: 100,
    popCap: { a: 2, b: 20, c: 40 },
    baseDefense: { a: 0, b: 20, c: 50 },
    buildTimeOffset: 9,
    recruitTimeOffset: 9,
  },
  buildings: {
    hall: { cost: res(90, 90, 60), time: 1800, requires: {} },
    lumber: { cost: res(20, 50, 30), time: 1500, requires: {} },
    quarry: { cost: res(50, 20, 30), time: 1500, requires: {} },
    mine: { cost: res(50, 50, 10), time: 1500, requires: {} },
    warehouse: { cost: res(60, 60, 20), time: 1200, requires: {} },
    barracks: { cost: res(60, 80, 50), time: 1500, requires: { hall: 2 } },
    harbor: { cost: res(100, 60, 60), time: 2400, requires: { hall: 3 } },
    wall: { cost: res(30, 120, 30), time: 1500, requires: { barracks: 1 } },
  },
  units: {
    guard: {
      domain: "land",
      attack: 5,
      defense: 20,
      naval: 0,
      carry: 10,
      capacity: 0,
      pop: 1,
      cost: res(30, 60, 30),
      time: 300,
      queue: "barracks",
      requires: { barracks: 1 },
    },
    raider: {
      domain: "land",
      attack: 20,
      defense: 5,
      naval: 0,
      carry: 50,
      capacity: 0,
      pop: 1,
      cost: res(50, 20, 60),
      time: 300,
      queue: "barracks",
      requires: { barracks: 1 },
    },
    settler: {
      domain: "land",
      attack: 0,
      defense: 0,
      naval: 0,
      carry: 0,
      capacity: 0,
      pop: 10,
      cost: res(450, 450, 750),
      time: 5400,
      queue: "barracks",
      requires: { barracks: 2, hall: 3 },
    },
    transport: {
      domain: "naval",
      attack: 0,
      defense: 0,
      naval: 0,
      carry: 0,
      capacity: 20,
      pop: 2,
      cost: res(120, 40, 80),
      time: 1200,
      queue: "harbor",
      requires: { harbor: 1 },
      seaPace: 60,
    },
    warship: {
      domain: "naval",
      attack: 0,
      defense: 0,
      naval: 50,
      carry: 0,
      capacity: 0,
      pop: 4,
      cost: res(150, 100, 250),
      time: 2400,
      queue: "harbor",
      requires: { harbor: 3 },
      seaPace: 45,
    },
  },
  settler: { scaleCap: 10, maxPerOrder: 1 },
  queues: { buildMax: 5, recruitBatchesMax: 5, batchMaxUnits: 500 },
  movement: {
    spyPace: 30,
    homeboundPace: 60,
    shipment: { base: 500, perHarborLevel: 500, pace: 60 },
  },
  combat: { wallPmPerLevel: 50, wallBreachOnLoss: 1, moralePmPerCity: 100, moraleFloorPm: 700 },
  spy: { minGold: 100, counterBase: 100, counterPerWall: 50, counterPerLandPop: 1 },
  diplomacy: {
    allianceSize: { min: 2, divisor: 3 },
    maxPacts: 2,
    maxOpenProposals: 3,
    messageMaxChars: 1000,
    proposalTextMaxChars: 300,
    allianceNameMaxChars: 24,
  },
  scoring: {
    cityBase: 100,
    perBuildingLevel: 1,
    crownBonus: 100,
    killPopPerPoint: 10,
    killCapPm: 250,
  },
  victory: { dominationPm: 400, dominationMinPerPlayer: 2 },
  gateway: {
    roundTripsPerWake: 8,
    toolCallsPerRoundTrip: 10,
    toolCallsPerWake: null,
    ownWakesPerDay: 12,
    socialWakesPerDay: 8,
    groupWindow: 600,
    urgentMinGap: 600,
    selfWake: { min: 600, max: 43200 },
    safetyWake: 43200,
    attackLaunchesPerDay: 20,
    messagesPerDay: 20,
    notesMaxChars: 4000,
  },
};

deepFreeze(defaults);

/** The defaults of perfidia-1@1.0.0 (§16), deep-frozen. */
export const PERFIDIA_1_DEFAULTS: DeepReadonly<PerfidiaConfig> = defaults;
