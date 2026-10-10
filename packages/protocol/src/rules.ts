import { z } from "zod";
import { MovementKindSchema, ROLES } from "./events.ts";
import {
  BuildingIdSchema,
  EventTypeSchema,
  QueueIdSchema,
  RulesetRefSchema,
  UnitIdSchema,
} from "./ids.ts";
import { RESOURCE_IDS, ResSchema, UnitCountsSchema } from "./resources.ts";

// `CompiledRules` (§3.3), the data contract between a ruleset and the core, with the gateway rules
// it carries (§8.4). The schema checks shapes and integer domains; the semantic checks that name a
// config path (durations ≥ 1, budgets ≥ 1, …) are the kernel's `checkRules` (§3.6).

const Int = z.int().nonnegative();
const PerMille = z.int().min(0).max(1000);

export const WakeClassSchema = z.enum(["urgent", "own", "social"]);
export type WakeClass = z.infer<typeof WakeClassSchema>;

/** Wake rules are keyed by recipient role, plus `"public"` for public events (§8.5). */
export const WakeRoleSchema = z.enum([...ROLES, "public"]);
export type WakeRole = z.infer<typeof WakeRoleSchema>;

/** Interface caps and wake rules (§8.4); part of the hashed rules. */
export const GatewayRulesSchema = z.strictObject({
  roundTripsPerWake: Int,
  toolCallsPerRoundTrip: Int,
  /** `null`: no per-wake call cap. */
  toolCallsPerWake: Int.nullable(),
  /** Self-wakes and own-activity triggers per game day. */
  ownWakesPerDay: Int,
  /** Triggers caused by other players per game day. */
  socialWakesPerDay: Int,
  groupWindow: Int,
  /** Below `time.minTravel` (checked). */
  urgentMinGap: Int,
  /** Self-wake range, in seconds ahead. */
  selfWake: z.strictObject({ min: Int, max: Int }),
  /** Seconds after the end of the last wake. */
  safetyWake: Int,
  /** Counted on engine-accepted launches. */
  attackLaunchesPerDay: Int,
  /** One call counts once. */
  messagesPerDay: Int,
  notesMaxChars: Int,
  /** Event type → class by recipient role; no entry means no wake (inbox or news only). */
  wake: z.record(EventTypeSchema, z.partialRecord(WakeRoleSchema, WakeClassSchema)),
  /** Event types whose public wake fires once per game day per `data.key`. */
  publicOncePerDay: z.array(EventTypeSchema),
});
export type GatewayRules = z.infer<typeof GatewayRulesSchema>;

/** A group of units on the move, as travel times see it (`spy` and `shipment` carry no units). */
export const TravelGroupSchema = z.strictObject({
  kind: MovementKindSchema,
  units: UnitCountsSchema,
});
export type TravelGroup = z.infer<typeof TravelGroupSchema>;

/** A founded city's start: building levels (a building not listed starts at 0), stock in whole units, units (the escort is added). */
export const CitySeedSchema = z.strictObject({
  buildings: z.record(BuildingIdSchema, Int),
  stock: ResSchema,
  units: UnitCountsSchema,
});
export type CitySeed = z.infer<typeof CitySeedSchema>;

const Requirements = z.record(BuildingIdSchema, z.int().positive());

export const BuildingTableSchema = z.strictObject({
  id: BuildingIdSchema,
  maxLevel: z.int().positive(),
  /** `[target level]`; index 0 unused. */
  cost: z.array(ResSchema),
  /** `[target level][buildSpeed level at enqueue]`; every entry ≥ 1 (checked). */
  time: z.array(z.array(Int)),
  /** Checked on levels per `queues.build.requiresOn`. */
  requires: Requirements,
});
export type BuildingTable = z.infer<typeof BuildingTableSchema>;

export const UnitTableSchema = z.strictObject({
  id: UnitIdSchema,
  domain: z.enum(["land", "naval"]),
  attack: Int,
  defense: Int,
  naval: Int,
  carry: Int,
  /** > 0: a carrier (transport). */
  capacity: Int,
  pop: Int,
  /** The settler's real cost comes from `settlerCost[k]`. */
  cost: ResSchema,
  queue: QueueIdSchema,
  /** Checked on completed levels. */
  requires: Requirements,
  /** `[level of the queue's building at enqueue]`; every entry ≥ 1 (checked). */
  time: z.array(Int),
  maxPerOrder: z.int().positive(),
});
export type UnitTable = z.infer<typeof UnitTableSchema>;

const RefundActive = z.union([z.literal("prorata"), z.strictObject({ pm: PerMille })]);
const RecruitRefundActive = z.union([z.literal("uncompleted"), z.strictObject({ pm: PerMille })]);

export const CompiledRulesSchema = z.strictObject({
  ruleset: RulesetRefSchema,
  /** N for this match. */
  players: z.int().positive(),
  /** The game day is always 86400 (core `DAY`). */
  time: z.strictObject({ matchEnd: Int, attackFrom: Int, minTravel: Int }),
  /** Stock is stored × scale (3600: a rate of r/h adds r per second). */
  resourceScale: z.int().positive(),
  /** Canonical order. */
  buildings: z.array(BuildingTableSchema),
  /** Canonical order. */
  units: z.array(UnitTableSchema),
  roles: z.strictObject({
    producers: z.record(z.enum(RESOURCE_IDS), BuildingIdSchema),
    /** Index of the storage cap table. */
    storage: BuildingIdSchema,
    /** Index of the pop cap table. */
    population: BuildingIdSchema,
    /** Second index of build times; `null` = no speed-up. */
    buildSpeed: BuildingIdSchema.nullable(),
    /** `null` when the ruleset has no wall. */
    wall: BuildingIdSchema.nullable(),
    /** The unit that founds cities; its cost scales with k. */
    settler: UnitIdSchema,
  }),
  /** `[level 0..max]`. */
  levels: z.strictObject({
    production: z.array(Int),
    storage: z.array(Int),
    population: z.array(Int),
  }),
  queues: z.strictObject({
    build: z.strictObject({
      max: Int,
      requiresOn: z.enum(["projected", "completed"]),
    }),
    recruit: z.array(
      z.strictObject({
        id: QueueIdSchema,
        building: BuildingIdSchema,
        maxBatches: Int,
        maxCount: Int,
      }),
    ),
    /** Units one by one (`trickle`) or all at batch end (`batch`). */
    delivery: z.enum(["trickle", "batch"]),
    refund: z.strictObject({
      build: z.strictObject({ queuedPm: PerMille, active: RefundActive }),
      /** `"uncompleted"`: the active batch keeps its completed units and refunds the others at `queuedPm`. */
      recruit: z.strictObject({ queuedPm: PerMille, active: RecruitRefundActive }),
    }),
  }),
  /** Index k = cities + settlers owned; clamped to the last entry. */
  settlerCost: z.array(ResSchema).min(1),
  newCity: CitySeedSchema,
  /** `false`: neutral cities (the Crown) do not produce. */
  neutralProduction: z.boolean(),
  movement: z.strictObject({
    recall: z.strictObject({
      window: Int,
      kinds: z.array(z.enum(["attack", "support", "found"])),
      stationed: z.enum(["partial", "whole", "none"]),
      dismiss: z.boolean(),
    }),
    /** In-flight cargo cap `base + perLevel × level(building)`; `null`: no cap. */
    shipment: z.strictObject({ base: Int, perLevel: Int, building: BuildingIdSchema }).nullable(),
    /** Land units crossing water need carrier capacity. */
    transportRule: z.boolean(),
    spyMinGold: Int,
  }),
  diplomacy: z.strictObject({
    allianceMax: Int,
    maxPacts: Int,
    /** `null`: pacts never expire (unless `until` is used). */
    pactDuration: Int.nullable(),
    maxOpenProposals: Int,
    proposalTtl: Int,
    messageMaxChars: Int,
    proposalTextMaxChars: Int,
    allianceNameMaxChars: Int,
  }),
  /** Optional tool arguments this ruleset accepts (§3.7). */
  toolOptions: z.strictObject({ foundSlot: z.boolean(), pactUntil: z.boolean() }),
  gateway: GatewayRulesSchema,
  /** `view_map` columns, e.g. transport / warship / spy. */
  travelProbes: z.array(z.strictObject({ label: z.string().min(1), group: TravelGroupSchema })),
  /** Every scheduled event kind → same-second class (§5.1). */
  eventClasses: z.record(EventTypeSchema, Int),
});
export type CompiledRules = z.infer<typeof CompiledRulesSchema>;
