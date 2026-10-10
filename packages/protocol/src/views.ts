import { z } from "zod";
import { MovementKindSchema, RecipientSchema } from "./events.ts";
import {
  AllianceIdSchema,
  BuildingIdSchema,
  CityIdSchema,
  DurationPairSchema,
  EventTypeSchema,
  IslandIdSchema,
  MovementIdSchema,
  PlayerIdSchema,
  ProposalIdSchema,
  QueueIdSchema,
  QueueItemIdSchema,
  ReportIdSchema,
  RulesetRefSchema,
  Sha256Schema,
  TimePairSchema,
  UnitIdSchema,
} from "./ids.ts";
import { JsonObjectSchema } from "./json.ts";
import { ResSchema, UnitCountsSchema } from "./resources.ts";
import { GatewayRulesSchema } from "./rules.ts";

// Fog-of-war views returned by the read tools (§8.1). Views are fresh objects built by the gateway's
// presentation layer; every time and duration is a pair `[integer, text]` (§7.3). The schemas list
// the fields agents and bots rely on and are loose objects, so a view may carry more (a ruleset's
// extras always go under `ext`).

const Int = z.int().nonnegative();
const Count = z.int().nonnegative();

/** A relation as agents see it (through `std.relationsOf`). */
export const RelationViewSchema = z.looseObject({
  player: PlayerIdSchema,
  kind: z.enum(["ally", "pact"]),
  /** Pact expiry; `null` = no expiry. */
  until: TimePairSchema.nullable(),
});
export type RelationView = z.infer<typeof RelationViewSchema>;

/**
 * A movement shown according to `movementAccess` (§8.1): `own` and `full` in full; `incoming`
 * without composition (no `units`, `cargo` or `gold`).
 */
export const MovementViewSchema = z.looseObject({
  id: MovementIdSchema,
  kind: MovementKindSchema,
  access: z.enum(["own", "full", "incoming"]),
  owner: PlayerIdSchema,
  from: CityIdSchema,
  /** `null` for found. */
  to: CityIdSchema.nullable(),
  /** Recorded foe or party; `null` = neutral or not applicable. */
  party: PlayerIdSchema.nullable(),
  depart: TimePairSchema,
  arrive: TimePairSchema,
  /** When a recall or a bounce turned it back. */
  turnedBack: TimePairSchema.nullable().optional(),
  /** A return heading into a besieged city (a coming homecoming battle). */
  homecoming: z.boolean().optional(),
  home: CityIdSchema.optional(),
  units: UnitCountsSchema.optional(),
  cargo: ResSchema.optional(),
  gold: Int.optional(),
  /** Own movements: the end of the recall window, `null` when it cannot be recalled. */
  recallableUntil: TimePairSchema.nullable().optional(),
});
export type MovementView = z.infer<typeof MovementViewSchema>;

export const StationedViewSchema = z.looseObject({
  owner: PlayerIdSchema,
  home: CityIdSchema,
  role: z.enum(["support", "hold"]),
  units: UnitCountsSchema,
});
export type StationedView = z.infer<typeof StationedViewSchema>;

/**
 * The latest spy or battle report about a city in the seat's archive, with its age: what a seat
 * knows of a city it cannot see (§8.1).
 */
export const IntelSnapshotSchema = z.looseObject({
  report: ReportIdSchema,
  type: z.enum(["spy_report", "battle_report"]),
  at: TimePairSchema,
  age: DurationPairSchema,
  data: JsonObjectSchema,
});
export type IntelSnapshot = z.infer<typeof IntelSnapshotSchema>;

const CityCommon = {
  id: CityIdSchema,
  name: z.string(),
  owner: PlayerIdSchema.nullable(),
  island: IslandIdSchema,
  slot: Int,
  capitalOf: PlayerIdSchema.nullable(),
  tag: z.string().nullable(),
  /** Ruleset extras of `publicCity(r, viewer, city)` (siege flag, Crown, …); `{}` when none. */
  ext: JsonObjectSchema,
};

export const BuildItemViewSchema = z.looseObject({
  item: QueueItemIdSchema,
  building: BuildingIdSchema,
  /** Target level: the current completed level plus its position among the queued items of that building. */
  level: z.int().positive(),
  start: TimePairSchema,
  end: TimePairSchema,
});
export type BuildItemView = z.infer<typeof BuildItemViewSchema>;

export const RecruitBatchViewSchema = z.looseObject({
  item: QueueItemIdSchema,
  unit: UnitIdSchema,
  count: z.int().positive(),
  done: Count,
  start: TimePairSchema,
  end: TimePairSchema,
});
export type RecruitBatchView = z.infer<typeof RecruitBatchViewSchema>;

/** A city the seat can see in full: its own, or an ally's (`cityAccess = "full"`). */
export const CityViewFullSchema = z.looseObject({
  access: z.literal("full"),
  ...CityCommon,
  /** Whole units. */
  stock: ResSchema,
  /** Per game hour. */
  rates: ResSchema,
  cap: Int,
  pop: z.looseObject({ used: Int, cap: Int }),
  buildings: z.record(BuildingIdSchema, Int),
  build: z.array(BuildItemViewSchema),
  recruit: z.record(QueueIdSchema, z.array(RecruitBatchViewSchema)),
  /** The owner's units at home (trickled units included). */
  units: UnitCountsSchema,
  stationed: z.array(StationedViewSchema),
  /** Visible incoming movements, with foe, launch and arrival times. */
  incoming: z.array(MovementViewSchema),
});
export type CityViewFull = z.infer<typeof CityViewFullSchema>;

/** Any other city: public fields, extras, and the latest intel snapshot (`null` when none). */
export const CityViewPublicSchema = z.looseObject({
  access: z.literal("public"),
  ...CityCommon,
  intel: IntelSnapshotSchema.nullable(),
});
export type CityViewPublic = z.infer<typeof CityViewPublicSchema>;

/** Result data of `view_city`. */
export const CityViewSchema = z.discriminatedUnion("access", [
  CityViewFullSchema,
  CityViewPublicSchema,
]);
export type CityView = z.infer<typeof CityViewSchema>;

/** A city's public fields, as listed by `view_map` and `view_island`. */
export const CityRowSchema = z.looseObject({
  id: CityIdSchema,
  island: IslandIdSchema,
  slot: Int,
  owner: PlayerIdSchema.nullable(),
  capitalOf: PlayerIdSchema.nullable(),
  ext: JsonObjectSchema.optional(),
});
export type CityRow = z.infer<typeof CityRowSchema>;

/** Result data of `view_island`. Travel times use the ruleset's `travelProbes`, in `probes` order. */
export const IslandViewSchema = z.looseObject({
  id: IslandIdSchema,
  kind: z.string(),
  x: z.int(),
  y: z.int(),
  richnessPm: Int,
  slots: Int,
  cities: z.array(CityRowSchema),
  /** Free slot numbers. */
  free: z.array(Int),
  /** Probe labels, e.g. `["transport", "warship", "spy"]`. */
  probes: z.array(z.string()),
  /** From each own city: one duration per probe. */
  travel: z.array(z.looseObject({ from: CityIdSchema, times: z.array(DurationPairSchema) })),
});
export type IslandView = z.infer<typeof IslandViewSchema>;

export const MapIslandSchema = z.looseObject({
  id: IslandIdSchema,
  kind: z.string(),
  x: z.int(),
  y: z.int(),
  richnessPm: Int,
  slots: Int,
  /** Number of free slots. */
  free: Int,
});
export type MapIsland = z.infer<typeof MapIslandSchema>;

/** Result data of `view_map`. With `fromCity`, `travel` gives one duration per probe to every island. */
export const MapViewSchema = z.looseObject({
  islands: z.array(MapIslandSchema),
  cities: z.array(CityRowSchema),
  from: CityIdSchema.optional(),
  probes: z.array(z.string()).optional(),
  travel: z.record(IslandIdSchema, z.array(DurationPairSchema)).optional(),
});
export type MapView = z.infer<typeof MapViewSchema>;

/** An open proposal to or from the seat, with its text from the seat's archive. */
export const ProposalViewSchema = z.looseObject({
  id: ProposalIdSchema,
  from: PlayerIdSchema,
  to: PlayerIdSchema,
  kind: z.enum(["alliance", "pact"]),
  name: z.string().nullable(),
  text: z.string(),
  until: TimePairSchema.nullable().optional(),
  expires: TimePairSchema,
});
export type ProposalView = z.infer<typeof ProposalViewSchema>;

/** The seat's own section of `view_player` on itself (§8.1). */
export const PlayerPrivateViewSchema = z.looseObject({
  movements: z.array(MovementViewSchema),
  /** Own groups stationed abroad (`hold` garrisons included). */
  stationed: z.array(
    z.looseObject({
      city: CityIdSchema,
      role: z.enum(["support", "hold"]),
      home: CityIdSchema,
      units: UnitCountsSchema,
    }),
  ),
  settler: z.looseObject({ k: Count, cost: ResSchema }),
  proposals: z.array(ProposalViewSchema),
  /** Today's counters (game day `day`). */
  today: z.looseObject({
    day: Count,
    ownWakes: Count,
    socialWakes: Count,
    attacks: Count,
    messages: Count,
  }),
  /** The pending self-wake. */
  selfWakeAt: TimePairSchema.nullable(),
});
export type PlayerPrivateView = z.infer<typeof PlayerPrivateViewSchema>;

/** Result data of `view_player`: a public profile, plus `private` on the seat itself. */
export const PlayerViewSchema = z.looseObject({
  id: PlayerIdSchema,
  alive: z.boolean(),
  eliminatedAt: TimePairSchema.nullable(),
  alliance: AllianceIdSchema.nullable(),
  cities: z.array(CityIdSchema),
  score: z.int(),
  /** Public score parts (never raw battle points). */
  parts: z.record(z.string(), z.int()),
  relations: z.array(RelationViewSchema),
  /** Relation to the viewer. */
  relation: z.enum(["self", "ally", "pact", "none"]),
  /** `publicPlayer` extras. */
  ext: JsonObjectSchema,
  private: PlayerPrivateViewSchema.optional(),
});
export type PlayerView = z.infer<typeof PlayerViewSchema>;

/** Result data of `leaderboard`: standings with relations, plus `publicMatch` extras (countdowns, tie-break order). */
export const LeaderboardViewSchema = z.looseObject({
  standings: z.array(
    z.looseObject({
      rank: z.int().positive(),
      player: PlayerIdSchema,
      score: z.int(),
      parts: z.record(z.string(), z.int()),
      cities: Count,
      alive: z.boolean(),
      alliance: AllianceIdSchema.nullable(),
      relations: z.array(RelationViewSchema),
    }),
  ),
  ext: JsonObjectSchema,
});
export type LeaderboardView = z.infer<typeof LeaderboardViewSchema>;

/** One entry of the seat's archive or of the public feed, as `read_notes` search lists it. */
export const ArchiveHitSchema = z.looseObject({
  /** Delivery number, in `ev`-line order. */
  e: Count,
  t: TimePairSchema,
  type: EventTypeSchema,
  public: z.boolean(),
  /** The message or report id, for `read_notes {open}`; `null` for other events. */
  id: z.string().nullable(),
  /** Deterministic one-line summary. */
  summary: z.string(),
});
export type ArchiveHit = z.infer<typeof ArchiveHitSchema>;

/** A full archive entry, as `read_notes {open: id}` returns it. */
export const ArchiveEntrySchema = z.looseObject({
  e: Count,
  t: TimePairSchema,
  type: EventTypeSchema,
  public: z.boolean(),
  id: z.string().nullable(),
  /** The event's own fields; player-authored text is a typed field. */
  data: JsonObjectSchema,
  to: z.array(RecipientSchema),
});
export type ArchiveEntry = z.infer<typeof ArchiveEntrySchema>;

/** A ruleset's extra tool as listed by `rules` (§3.7). */
export const ExtraToolInfoSchema = z.looseObject({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  family: z.enum(["observe", "economy", "military", "diplomacy"]),
  kind: z.enum(["read", "write"]),
  description: z.string(),
  inputSchema: JsonObjectSchema,
});
export type ExtraToolInfo = z.infer<typeof ExtraToolInfoSchema>;

/**
 * Result data of `rules` (§8.1). `rules` is the agent-relevant part of `CompiledRules`, rendered
 * compactly where it helps, but `rules.gateway` is kept whole: every numeric `GatewayRules` field,
 * the wake table and `publicOncePerDay`. Bots read caps there, never in `interface`.
 */
export const RulesInfoSchema = z.looseObject({
  ruleset: RulesetRefSchema,
  title: z.string(),
  configHash: Sha256Schema,
  rulesHash: Sha256Schema,
  /** Gateway-owned interface rules, the same template for every ruleset. */
  interface: z.string(),
  /** The ruleset's game rules only. */
  cheatSheet: z.string(),
  /** The effective config. */
  config: JsonObjectSchema,
  rules: z.looseObject({ gateway: GatewayRulesSchema }),
  extraTools: z.array(ExtraToolInfoSchema),
});
export type RulesInfo = z.infer<typeof RulesInfoSchema>;
