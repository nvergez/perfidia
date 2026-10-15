import { type DeepReadonly, ResSchema, type RulesetRef, z } from "@perfidia/protocol";
import { NAMES_1_1_0 } from "./names.ts";
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

// The RulesConfig of perfidia-1@1.1.0 (docs/rulesets/perfidia-1.md §16): 1.0.0's, with the ids of
// the Greek setting (§0.1), `victory.dominationMinConquests` (domination by conquest, §13.3), the
// bounds of the domination keys (R5) and `scoring.conquestBonus` (the conquest trophy, §13.1).
// Every other key and number is 1.0.0's. The cross-checks that need N are `check_1_1.ts`'s.

export const PERFIDIA_1_1_VERSION = "1.1.0";
export const PERFIDIA_1_1_REF: RulesetRef = "perfidia-1@1.1.0";

/** Building ids in canonical order (§1.1). */
export const BUILDING_IDS_1_1 = Object.freeze([
  "acropolis",
  "woodcutter",
  "quarry",
  "goldmine",
  "warehouse",
  "barracks",
  "harbor",
  "wall",
] as const);

/** Unit ids in canonical order (§1.1). */
export const UNIT_IDS_1_1 = Object.freeze([
  "hoplite",
  "peltast",
  "settler",
  "transport",
  "trireme",
] as const);

/** Island kinds in canonical order (§1.1). */
export const ISLAND_KINDS_1_1 = Object.freeze([
  "olympus",
  "home",
  "backyard",
  "frontier",
  "inner",
  "hub",
] as const);

/** The `City.tag` of the neutral city on Olympus (§9.6), also its `start` seed key. */
export const OLYMPUS_TAG = "olympus";

const LevelsSchema = z.strictObject({
  acropolis: Int,
  woodcutter: Int,
  quarry: Int,
  goldmine: Int,
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

const DISABLE_HINT =
  "To disable domination, set time.dominationStart after time.matchEnd (604801 with the default 7 days).";

const VictorySchema = z.strictObject({
  dominationPm: z
    .int()
    .min(1, {
      error: `victory.dominationPm is the share of the map's city slots a bloc must hold, in ‰: at least 1 (400 = 40%). ${DISABLE_HINT}`,
    })
    .max(1000, {
      error:
        "victory.dominationPm is a share in ‰ of the map's city slots: at most 1000 (all of them).",
    }),
  dominationMinPerPlayer: z.int().min(1, {
    error:
      "victory.dominationMinPerPlayer is the floor of the threshold in cities per player: at least 1 (2 means a bloc needs at least 2N cities).",
  }),
  dominationMinConquests: z.int().min(0, {
    error:
      "victory.dominationMinConquests counts taken cities: 0 or more (0 drops the conquest requirement).",
  }),
});

const core = coreSections(PERFIDIA_1_1_REF);

const ConfigShape = z.strictObject({
  players: core.players,
  time: core.time,
  map: core.map.extend({
    kinds: z.strictObject({
      olympus: OccupiedKindSchema,
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
    olympus: CitySeedSchema,
  }),
  economy: core.economy,
  buildings: z.strictObject({
    acropolis: BuildingSchema,
    woodcutter: BuildingSchema,
    quarry: BuildingSchema,
    goldmine: BuildingSchema,
    warehouse: BuildingSchema,
    barracks: BuildingSchema,
    harbor: BuildingSchema,
    wall: BuildingSchema,
  }),
  units: z.strictObject({
    hoplite: UnitSchema,
    peltast: UnitSchema,
    settler: UnitSchema,
    transport: UnitSchema,
    trireme: UnitSchema,
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
    olympusBonus: Int,
    /** Points of a taken city held (§13.1); 0 leaves conquests out of the score. */
    conquestBonus: Int,
    killPopPerPoint: AtLeastOne,
    killCapPm: Int,
  }),
  victory: VictorySchema,
  gateway: core.gateway,
});

/** The perfidia-1@1.1.0 RulesConfig schema (§16). */
export const Perfidia11ConfigSchema = ConfigShape.superRefine(crossFieldIssuesFor(NAMES_1_1_0));
export type Perfidia11Config = z.infer<typeof Perfidia11ConfigSchema>;

const res = (wood: number, stone: number, gold: number) => ({ wood, stone, gold });

const START_LEVELS = {
  acropolis: 1,
  woodcutter: 1,
  quarry: 1,
  goldmine: 1,
  warehouse: 1,
  barracks: 0,
  harbor: 0,
  wall: 0,
};

const defaults: Perfidia11Config = {
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
      olympus: { slots: 1, richnessPm: 1500 },
      home: { slots: 2, richnessPm: 1000 },
      backyard: { slots: 1, richnessPm: 1000 },
      frontier: { slots: 2, richnessPm: 1500 },
      inner: { slots: 1, richnessPm: 1250 },
      hub: { slots: 1, richnessPm: 1250 },
    },
  },
  start: {
    capital: { buildings: { ...START_LEVELS }, stock: res(800, 800, 800), units: { hoplite: 10 } },
    newCity: { buildings: { ...START_LEVELS }, stock: res(300, 300, 300), units: {} },
    olympus: {
      buildings: {
        acropolis: 5,
        woodcutter: 5,
        quarry: 5,
        goldmine: 5,
        warehouse: 5,
        barracks: 5,
        harbor: 5,
        wall: 5,
      },
      stock: res(3000, 3000, 3000),
      units: { hoplite: 400, trireme: 10 },
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
    acropolis: { cost: res(90, 90, 60), time: 1800, requires: {} },
    woodcutter: { cost: res(20, 50, 30), time: 1500, requires: {} },
    quarry: { cost: res(50, 20, 30), time: 1500, requires: {} },
    goldmine: { cost: res(50, 50, 10), time: 1500, requires: {} },
    warehouse: { cost: res(60, 60, 20), time: 1200, requires: {} },
    barracks: { cost: res(60, 80, 50), time: 1500, requires: { acropolis: 2 } },
    harbor: { cost: res(100, 60, 60), time: 2400, requires: { acropolis: 3 } },
    wall: { cost: res(30, 120, 30), time: 1500, requires: { barracks: 1 } },
  },
  units: {
    hoplite: {
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
    peltast: {
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
      requires: { barracks: 2, acropolis: 3 },
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
    trireme: {
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
    olympusBonus: 100,
    conquestBonus: 0,
    killPopPerPoint: 10,
    killCapPm: 250,
  },
  victory: { dominationPm: 400, dominationMinPerPlayer: 2, dominationMinConquests: 2 },
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

/** The defaults of perfidia-1@1.1.0 (§16), deep-frozen. */
export const PERFIDIA_1_1_DEFAULTS: DeepReadonly<Perfidia11Config> = defaults;
