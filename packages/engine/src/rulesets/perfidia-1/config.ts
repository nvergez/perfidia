import { type DeepReadonly, ResSchema, type RulesetRef, safeRecord, z } from "@perfidia/protocol";

// The RulesConfig of perfidia-1 §16 as a Zod schema, with its defaults. Every number is an integer;
// the fixed fields are `z.literal`. The cross-field rules of §16 that belong to the schema live in
// the final `superRefine`; `check.ts` adds the ruleset's compile checks, and the kernel runs the
// generic ones (docs/architecture.md §3.6).

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

/** The two recruit queues (§6.3); each is named after the building that trains it. */
export const RECRUIT_QUEUES = Object.freeze(["barracks", "harbor"] as const);
export type RecruitQueue = (typeof RECRUIT_QUEUES)[number];

/** The `City.tag` of the neutral Crown city (§9.6). */
export const CROWN_TAG = "crown";

const Int = z.int().nonnegative();
const AtLeastOne = z.int().min(1);

// Upper bounds beyond §16, so that no schema-valid config makes `compile` or `createWorld` throw,
// allocate huge tables or lose integer exactness (docs/architecture.md §3.6: a bad config is
// rejected with a path, never by an engine bug or a hang). Each is far above the defaults.

/** Levels per table (`[0..maxLevel]`) and settler cost entries (`[0..scaleCap]`). */
export const MAX_TABLE_SIZE = 100;
/** Map radii in tiles: with paces ≤ MAX_PACE, `pace² · d²` stays below 2^53 (§7.2). */
export const MAX_TILES = 5000;
/** Radial jitter in tiles. */
export const MAX_JITTER = 1000;
/** Seconds per tile. */
export const MAX_PACE = 3600;

const Tiles = Int.max(MAX_TILES, { error: `at most ${MAX_TILES} tiles` });
const Offset = z
  .int()
  .min(-MAX_TILES)
  .max(MAX_TILES, { error: `at most ±${MAX_TILES} tiles` });
const Pace = Int.max(MAX_PACE, { error: `at most ${MAX_PACE} seconds per tile` });
const TableSize = z
  .int()
  .min(1)
  .max(MAX_TABLE_SIZE, { error: `at most ${MAX_TABLE_SIZE}` });

/** A field `perfidia-1@1.0.0` fixes: overriding it is rejected with a message naming the field. */
function fixed<const V extends number>(value: V, path: string) {
  return z.literal(value, {
    error: `${path} is fixed by ${PERFIDIA_1_REF} at ${value}: it cannot be overridden`,
  });
}

/** A scheduled duration: every scheduled duration is ≥ 1 s (§1.4), so 0 is rejected here. */
function duration(path: string) {
  return z.int().min(1, { error: `${path} is a scheduled duration: it must be ≥ 1 s` });
}

/** `a·L² + b·L + c`. */
const QuadSchema = z.strictObject({ a: Int, b: Int, c: Int });
export type Quad = z.infer<typeof QuadSchema>;

/** Building levels or unit requirements; keys are checked against the buildings in `superRefine`. */
const RequiresSchema = safeRecord(z.string(), z.int().positive());

const BuildingSchema = z.strictObject({ cost: ResSchema, time: Int, requires: RequiresSchema });

const UnitSchema = z.strictObject({
  domain: z.enum(["land", "naval"]),
  attack: Int,
  defense: Int,
  naval: Int,
  carry: Int,
  capacity: Int,
  pop: Int,
  cost: ResSchema,
  time: Int,
  queue: z.enum(RECRUIT_QUEUES),
  requires: RequiresSchema,
  /** Seconds per tile; every naval unit has one (§7.2). */
  seaPace: Pace.optional(),
});

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

/** Unit counts of a city seed; keys are checked against the units in `superRefine`. */
const SeedUnitsSchema = safeRecord(z.string(), z.int().positive());

const CitySeedSchema = z.strictObject({
  buildings: LevelsSchema,
  /** Whole units of each resource. */
  stock: ResSchema,
  units: SeedUnitsSchema,
});

const KindSchema = z.strictObject({ slots: Int, richnessPm: Int });
/** Slot 0 of a home island holds the capital and the Crown island holds the Crown: both need ≥ 1 slot. */
const OccupiedKindSchema = z.strictObject({
  slots: z.int().min(1, { error: "this island kind holds a start city: it needs ≥ 1 slot" }),
  richnessPm: Int,
});

const DECIMAL_KEY = /^(0|[1-9][0-9]*)$/;

const ConfigShape = z.strictObject({
  players: z.strictObject({ min: fixed(6, "players.min"), max: fixed(12, "players.max") }),
  time: z.strictObject({
    day: fixed(86400, "time.day"),
    matchEnd: duration("time.matchEnd"),
    protectionEnd: Int,
    capitalImmunityEnd: Int,
    minTravel: duration("time.minTravel"),
    sameIslandTravel: duration("time.sameIslandTravel"),
    recallWindow: Int,
    siegeDuration: duration("time.siegeDuration"),
    dominationStart: z.int().min(1, {
      error:
        "time.dominationStart is a world timer: it must be ≥ 1 (a value after time.matchEnd, such as 604801, disables domination)",
    }),
    dominationHold: duration("time.dominationHold"),
    proposalTtl: duration("time.proposalTtl"),
    pactDuration: duration("time.pactDuration"),
    killCreditCooldown: Int,
  }),
  map: z.strictObject({
    /** Home radius R by player count N; keys are decimal N (`map.homeRadius.6`). */
    homeRadius: safeRecord(
      z.string().regex(DECIMAL_KEY, { error: "homeRadius keys are player counts, such as 6" }),
      Tiles,
    ),
    /** C = R + centerMargin. */
    centerMargin: Tiles,
    /** The radius offsets are the only signed numbers of the config (§16). */
    radius: z.strictObject({
      backyardOffset: Offset,
      frontierOffset: Offset,
      innerOffset: Offset,
      /** Absolute radius of the hub ring. */
      hub: Tiles,
    }),
    hubMaxPlayers: Int,
    radialJitter: Int.max(MAX_JITTER, { error: `at most ${MAX_JITTER} tiles` }),
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
  economy: z.strictObject({
    resourceScale: fixed(3600, "economy.resourceScale"),
    maxLevel: TableSize,
    levelWeight: QuadSchema,
    levelWeightDiv: AtLeastOne,
    production: QuadSchema,
    warehouseCap: QuadSchema,
    lootProtectPerLevel: Int,
    popCap: QuadSchema,
    baseDefense: QuadSchema,
    /** Build times divide by `buildTimeOffset + hall`, hall 0 included. */
    buildTimeOffset: AtLeastOne,
    /** Unit times are `× (offset + 1) / (offset + level)`, level 0 included. */
    recruitTimeOffset: AtLeastOne,
  }),
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
  settler: z.strictObject({ scaleCap: TableSize, maxPerOrder: AtLeastOne }),
  queues: z.strictObject({ buildMax: Int, recruitBatchesMax: Int, batchMaxUnits: AtLeastOne }),
  movement: z.strictObject({
    spyPace: Pace,
    homeboundPace: Pace,
    shipment: z.strictObject({ base: Int, perHarborLevel: Int, pace: Pace }),
  }),
  combat: z.strictObject({
    wallPmPerLevel: Int,
    wallBreachOnLoss: Int,
    moralePmPerCity: Int,
    moraleFloorPm: z.int().min(0).max(1000, { error: "combat.moraleFloorPm is at most 1000‰" }),
  }),
  spy: z.strictObject({
    minGold: Int,
    counterBase: Int,
    counterPerWall: Int,
    counterPerLandPop: Int,
  }),
  diplomacy: z.strictObject({
    allianceSize: z.strictObject({ min: Int, divisor: AtLeastOne }),
    maxPacts: Int,
    maxOpenProposals: Int,
    messageMaxChars: Int,
    proposalTextMaxChars: Int,
    allianceNameMaxChars: Int,
  }),
  scoring: z.strictObject({
    cityBase: Int,
    perBuildingLevel: Int,
    crownBonus: Int,
    killPopPerPoint: AtLeastOne,
    killCapPm: Int,
  }),
  victory: z.strictObject({ dominationPm: Int, dominationMinPerPlayer: Int }),
  gateway: z.strictObject({
    roundTripsPerWake: Int,
    toolCallsPerRoundTrip: Int,
    /** `null`: no per-wake call cap. */
    toolCallsPerWake: Int.nullable(),
    ownWakesPerDay: Int,
    socialWakesPerDay: Int,
    groupWindow: Int,
    urgentMinGap: Int,
    selfWake: z.strictObject({ min: Int, max: Int }),
    safetyWake: Int,
    attackLaunchesPerDay: Int,
    messagesPerDay: Int,
    notesMaxChars: Int,
  }),
});

type ConfigShapeOutput = z.infer<typeof ConfigShape>;

/** `a·x² + b·x + c`, asserting a safe integer result. */
export function quad(q: DeepReadonly<Quad>, x: number): number {
  const v = q.a * x * x + q.b * x + q.c;
  if (!Number.isSafeInteger(v)) {
    throw new RangeError(`quadratic value at ${x} is not a safe integer`);
  }
  return v;
}

const unsafe = (v: number): boolean => !Number.isSafeInteger(v);

const QUADS = ["levelWeight", "production", "warehouseCap", "popCap", "baseDefense"] as const;
const RESOURCES = ["wood", "stone", "gold"] as const;
const SEEDS = ["capital", "newCity", "crown"] as const;

const BUILDING_SET: ReadonlySet<string> = new Set(BUILDING_IDS);
const UNIT_SET: ReadonlySet<string> = new Set(UNIT_IDS);

/** The cross-field rules of §16 that belong to the schema, each reported at a precise path. */
function crossFieldIssues(c: ConfigShapeOutput, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: "custom", path, message, input: c });
  };

  // The products `compile` and the map compute must stay safe integers. The quadratics have
  // non-negative coefficients, so their largest value is at maxLevel.
  const e = c.economy;
  const top = e.maxLevel;
  for (const name of QUADS) {
    const q = e[name];
    if (unsafe(q.a * top * top + q.b * top + q.c)) {
      issue(["economy", name], `too large: its value at level ${top} is not a safe integer`);
    }
  }
  const w = e.levelWeight.a * top * top + e.levelWeight.b * top + e.levelWeight.c;
  for (const id of BUILDING_IDS) {
    const b = c.buildings[id];
    for (const r of RESOURCES) {
      if (unsafe(b.cost[r] * w))
        issue(["buildings", id, "cost", r], "too large for the level tables");
    }
    if (unsafe(b.time * w)) issue(["buildings", id, "time"], "too large for the level tables");
  }
  for (const id of UNIT_IDS) {
    if (unsafe(c.units[id].time * (e.recruitTimeOffset + 1))) {
      issue(["units", id, "time"], "too large for the recruit tables");
    }
  }
  for (const r of RESOURCES) {
    if (unsafe(c.units.settler.cost[r] * c.settler.scaleCap)) {
      issue(["units", "settler", "cost", r], "too large for the settler cost table");
    }
  }
  for (const seed of SEEDS) {
    for (const r of RESOURCES) {
      if (unsafe(c.start[seed].stock[r] * e.resourceScale)) {
        issue(["start", seed, "stock", r], "too large to store in resource-seconds");
      }
    }
  }

  for (let n = c.players.min; n <= c.players.max; n += 1) {
    if (!Object.hasOwn(c.map.homeRadius, String(n))) {
      issue(
        ["map", "homeRadius", String(n)],
        `map.homeRadius must give R for every N in ${c.players.min}..${c.players.max}: N = ${n} is missing`,
      );
    }
  }
  for (const key of Object.keys(c.map.homeRadius)) {
    const n = Number(key);
    if (n < c.players.min || n > c.players.max) {
      issue(
        ["map", "homeRadius", key],
        `map.homeRadius.${key} is unused: players are ${c.players.min}..${c.players.max}`,
      );
    }
  }

  const known = BUILDING_IDS.join(", ");
  for (const id of BUILDING_IDS) {
    for (const req of Object.keys(c.buildings[id].requires)) {
      if (!BUILDING_SET.has(req)) {
        issue(
          ["buildings", id, "requires", req],
          `requires an unknown building "${req}"; buildings are ${known}`,
        );
      }
    }
  }
  for (const id of UNIT_IDS) {
    for (const req of Object.keys(c.units[id].requires)) {
      if (!BUILDING_SET.has(req)) {
        issue(
          ["units", id, "requires", req],
          `requires an unknown building "${req}"; buildings are ${known}`,
        );
      }
    }
  }

  const carriers = UNIT_IDS.filter((id) => c.units[id].capacity > 0);
  if (carriers.length === 0) {
    issue(["units"], "exactly one unit must have capacity > 0 (the naval carrier); none has");
  }
  for (const id of carriers.slice(1)) {
    issue(
      ["units", id, "capacity"],
      `exactly one unit may have capacity > 0, but ${carriers.join(" and ")} have`,
    );
  }
  for (const id of carriers) {
    if (c.units[id].domain !== "naval") {
      issue(["units", id, "domain"], `${id} carries units (capacity > 0), so it must be naval`);
    }
  }
  for (const id of UNIT_IDS) {
    if (c.units[id].domain === "naval" && c.units[id].seaPace === undefined) {
      issue(["units", id, "seaPace"], `${id} is naval, so it needs a seaPace (seconds per tile)`);
    }
  }

  for (const seed of SEEDS) {
    const s = c.start[seed];
    for (const id of BUILDING_IDS) {
      if (s.buildings[id] > c.economy.maxLevel) {
        issue(
          ["start", seed, "buildings", id],
          `start level ${s.buildings[id]} is above economy.maxLevel (${c.economy.maxLevel})`,
        );
      }
    }
    for (const unit of Object.keys(s.units)) {
      if (!UNIT_SET.has(unit)) {
        issue(
          ["start", seed, "units", unit],
          `unknown unit "${unit}"; units are ${UNIT_IDS.join(", ")}`,
        );
      }
    }
    // A warehouse above maxLevel is reported above; its cap is not defined.
    if (s.buildings.warehouse > top) continue;
    const level = s.buildings.warehouse;
    const cap = e.warehouseCap.a * level * level + e.warehouseCap.b * level + e.warehouseCap.c;
    for (const r of RESOURCES) {
      if (s.stock[r] > cap) {
        issue(
          ["start", seed, "stock", r],
          `start stock ${s.stock[r]} exceeds the cap of warehouse ${level} (${cap})`,
        );
      }
    }
  }
}

/** The perfidia-1 RulesConfig schema (§16). */
export const PerfidiaConfigSchema = ConfigShape.superRefine(crossFieldIssues);
export type PerfidiaConfig = z.infer<typeof PerfidiaConfigSchema>;

function deepFreeze(value: unknown): void {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}

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

/** Allowed N (`Ruleset.players`). */
export function playerRange(config: DeepReadonly<PerfidiaConfig>): { min: number; max: number } {
  return { min: config.players.min, max: config.players.max };
}

/** The home radius R for N players (§2.2); throws when the config has none. */
export function homeRadius(config: DeepReadonly<PerfidiaConfig>, players: number): number {
  const r = config.map.homeRadius[String(players)];
  if (r === undefined) throw new RangeError(`map.homeRadius has no entry for N = ${players}`);
  return r;
}
