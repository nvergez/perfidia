import {
  type DeepReadonly,
  type Res,
  ResSchema,
  type RulesetRef,
  safeRecord,
  z,
} from "@perfidia/protocol";
import { type PerfidiaNames, buildingIds, seedKeys, unitIds } from "./names.ts";

// The building blocks of every perfidia-1 version's RulesConfig (§16): integer field types, the
// bounds beyond §16, the sub-schemas whose keys name no id, the sections a version shares with
// 1.0.0 (its fixed fields naming the version), and the cross-field rules of the schema for a
// version's ids (`crossFieldIssuesFor`). `config.ts` assembles 1.0.0's schema from them.

/** The two recruit queues (§6.3); each is named after the building that trains it. */
export const RECRUIT_QUEUES = Object.freeze(["barracks", "harbor"] as const);
export type RecruitQueue = (typeof RECRUIT_QUEUES)[number];

export const Int = z.int().nonnegative();
export const AtLeastOne = z.int().min(1);

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

export const Tiles = Int.max(MAX_TILES, { error: `at most ${MAX_TILES} tiles` });
export const Offset = z
  .int()
  .min(-MAX_TILES)
  .max(MAX_TILES, { error: `at most ±${MAX_TILES} tiles` });
export const Pace = Int.max(MAX_PACE, { error: `at most ${MAX_PACE} seconds per tile` });
export const TableSize = z
  .int()
  .min(1)
  .max(MAX_TABLE_SIZE, { error: `at most ${MAX_TABLE_SIZE}` });

/** A field the version `ref` fixes: overriding it is rejected with a message naming the field. */
export function fixed<const V extends number>(value: V, path: string, ref: RulesetRef) {
  return z.literal(value, {
    error: `${path} is fixed by ${ref} at ${value}: it cannot be overridden`,
  });
}

/** A scheduled duration: every scheduled duration is ≥ 1 s (§1.4), so 0 is rejected here. */
export function duration(path: string) {
  return z.int().min(1, { error: `${path} is a scheduled duration: it must be ≥ 1 s` });
}

/** `a·L² + b·L + c`. */
export const QuadSchema = z.strictObject({ a: Int, b: Int, c: Int });
export type Quad = z.infer<typeof QuadSchema>;

/** Building levels or unit requirements; keys are checked against the buildings in `superRefine`. */
export const RequiresSchema = safeRecord(z.string(), z.int().positive());

export const BuildingSchema = z.strictObject({
  cost: ResSchema,
  time: Int,
  requires: RequiresSchema,
});

export const UnitSchema = z.strictObject({
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

/** Unit counts of a city seed; keys are checked against the units in `superRefine`. */
export const SeedUnitsSchema = safeRecord(z.string(), z.int().positive());

export const KindSchema = z.strictObject({ slots: Int, richnessPm: Int });
/** Slot 0 of a home island holds the capital and the prize island its city: both need ≥ 1 slot. */
export const OccupiedKindSchema = z.strictObject({
  slots: z.int().min(1, { error: "this island kind holds a start city: it needs ≥ 1 slot" }),
  richnessPm: Int,
});

const DECIMAL_KEY = /^(0|[1-9][0-9]*)$/;

/**
 * The sections of the config that name no id, as the version `ref` declares them (its fixed fields
 * name it); `map` without its `kinds`.
 */
export function coreSections(ref: RulesetRef) {
  return {
    players: z.strictObject({
      min: fixed(6, "players.min", ref),
      max: fixed(12, "players.max", ref),
    }),
    time: z.strictObject({
      day: fixed(86400, "time.day", ref),
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
    }),
    economy: z.strictObject({
      resourceScale: fixed(3600, "economy.resourceScale", ref),
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
  };
}

type Sections = ReturnType<typeof coreSections>;
type Out<K extends keyof Sections> = z.infer<Sections[K]>;

export type UnitConfig = z.infer<typeof UnitSchema>;
export type BuildingConfig = z.infer<typeof BuildingSchema>;
export type KindConfig = z.infer<typeof KindSchema>;

/** A start city of the config (§3); its building levels and units are keyed by the version's ids. */
export interface CitySeedConfig {
  readonly buildings: Readonly<Record<string, number>>;
  /** Whole units of each resource. */
  readonly stock: Res;
  readonly units: Readonly<Record<string, number>>;
}

/**
 * What every perfidia-1 version's config has in common: the shared sections, and the id-keyed ones
 * as records. The modules every version shares read a config through this type.
 */
export interface PerfidiaCore {
  players: Out<"players">;
  time: Out<"time">;
  map: Out<"map"> & { kinds: Readonly<Record<string, KindConfig>> };
  start: Readonly<Record<string, CitySeedConfig>>;
  economy: Out<"economy">;
  buildings: Readonly<Record<string, BuildingConfig>>;
  units: Readonly<Record<string, UnitConfig>>;
  settler: Out<"settler">;
  queues: Out<"queues">;
  movement: Out<"movement">;
  combat: Out<"combat">;
  spy: Out<"spy">;
  diplomacy: Out<"diplomacy">;
  scoring: {
    cityBase: number;
    perBuildingLevel: number;
    killPopPerPoint: number;
    killCapPm: number;
  };
  victory: { dominationPm: number; dominationMinPerPlayer: number };
  gateway: Out<"gateway">;
}

/** The own entry `key` of a record a schema has already checked: a missing one is an engine bug. */
export function entry<T>(record: Readonly<Record<string, T>>, key: string, path: string): T {
  const v = Object.hasOwn(record, key) ? record[key] : undefined;
  if (v === undefined) throw new RangeError(`${path}.${key} is missing from a parsed config`);
  return v;
}

/** `a·x² + b·x + c`, asserting a safe integer result. */
export function quad(q: DeepReadonly<Quad>, x: number): number {
  const v = q.a * x * x + q.b * x + q.c;
  if (!Number.isSafeInteger(v)) {
    throw new RangeError(`quadratic value at ${x} is not a safe integer`);
  }
  return v;
}

/** Allowed N (`Ruleset.players`). */
export function playerRange(config: DeepReadonly<PerfidiaCore>): { min: number; max: number } {
  return { min: config.players.min, max: config.players.max };
}

/** The home radius R for N players (§2.2); throws when the config has none. */
export function homeRadius(config: DeepReadonly<PerfidiaCore>, players: number): number {
  const r = config.map.homeRadius[String(players)];
  if (r === undefined) throw new RangeError(`map.homeRadius has no entry for N = ${players}`);
  return r;
}

const unsafe = (v: number): boolean => !Number.isSafeInteger(v);

const QUADS = ["levelWeight", "production", "warehouseCap", "popCap", "baseDefense"] as const;
const RESOURCES = ["wood", "stone", "gold"] as const;

/**
 * The cross-field rules of §16 that belong to the schema, each reported at a precise path, for the
 * ids of a version.
 */
export function crossFieldIssuesFor(
  names: PerfidiaNames,
): (c: PerfidiaCore, ctx: z.RefinementCtx) => void {
  const buildings = buildingIds(names);
  const units = unitIds(names);
  const seeds = seedKeys(names);
  const buildingSet: ReadonlySet<string> = new Set(buildings);
  const unitSet: ReadonlySet<string> = new Set(units);
  const settler = names.units.settler;
  const warehouse = names.buildings.warehouse;
  return function crossFieldIssues(c: PerfidiaCore, ctx: z.RefinementCtx): void {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: "custom", path, message, input: c });
    };
    const buildingOf = (id: string) => entry(c.buildings, id, "buildings");
    const unitOf = (id: string) => entry(c.units, id, "units");
    const seedOf = (seed: string) => entry(c.start, seed, "start");

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
    for (const id of buildings) {
      const b = buildingOf(id);
      for (const r of RESOURCES) {
        if (unsafe(b.cost[r] * w))
          issue(["buildings", id, "cost", r], "too large for the level tables");
      }
      if (unsafe(b.time * w)) issue(["buildings", id, "time"], "too large for the level tables");
    }
    for (const id of units) {
      if (unsafe(unitOf(id).time * (e.recruitTimeOffset + 1))) {
        issue(["units", id, "time"], "too large for the recruit tables");
      }
    }
    for (const r of RESOURCES) {
      if (unsafe(unitOf(settler).cost[r] * c.settler.scaleCap)) {
        issue(["units", settler, "cost", r], "too large for the settler cost table");
      }
    }
    for (const seed of seeds) {
      for (const r of RESOURCES) {
        if (unsafe(seedOf(seed).stock[r] * e.resourceScale)) {
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

    const known = buildings.join(", ");
    for (const id of buildings) {
      for (const req of Object.keys(buildingOf(id).requires)) {
        if (!buildingSet.has(req)) {
          issue(
            ["buildings", id, "requires", req],
            `requires an unknown building "${req}"; buildings are ${known}`,
          );
        }
      }
    }
    for (const id of units) {
      for (const req of Object.keys(unitOf(id).requires)) {
        if (!buildingSet.has(req)) {
          issue(
            ["units", id, "requires", req],
            `requires an unknown building "${req}"; buildings are ${known}`,
          );
        }
      }
    }

    const carriers = units.filter((id) => unitOf(id).capacity > 0);
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
      if (unitOf(id).domain !== "naval") {
        issue(["units", id, "domain"], `${id} carries units (capacity > 0), so it must be naval`);
      }
    }
    for (const id of units) {
      if (unitOf(id).domain === "naval" && unitOf(id).seaPace === undefined) {
        issue(["units", id, "seaPace"], `${id} is naval, so it needs a seaPace (seconds per tile)`);
      }
    }

    for (const seed of seeds) {
      const s = seedOf(seed);
      for (const id of buildings) {
        const startLevel = entry(s.buildings, id, `start.${seed}.buildings`);
        if (startLevel > c.economy.maxLevel) {
          issue(
            ["start", seed, "buildings", id],
            `start level ${startLevel} is above economy.maxLevel (${c.economy.maxLevel})`,
          );
        }
      }
      for (const unit of Object.keys(s.units)) {
        if (!unitSet.has(unit)) {
          issue(
            ["start", seed, "units", unit],
            `unknown unit "${unit}"; units are ${units.join(", ")}`,
          );
        }
      }
      // A warehouse above maxLevel is reported above; its cap is not defined.
      const level = entry(s.buildings, warehouse, `start.${seed}.buildings`);
      if (level > top) continue;
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
  };
}

/** Freezes a config (defaults) and everything in it. */
export function deepFreeze(value: unknown): void {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}
