import { z } from "zod";
import { MovementKindSchema, ScheduledEventSchema } from "./events.ts";
import {
  AllianceIdSchema,
  AuthoredNameSchema,
  BuildingIdSchema,
  CityIdSchema,
  GameTimeSchema,
  Hash64Schema,
  IslandIdSchema,
  MovementIdSchema,
  PlayerIdSchema,
  ProposalIdSchema,
  QueueIdSchema,
  QueueItemIdSchema,
  RulesetRefSchema,
  Sha256Schema,
  UnitIdSchema,
} from "./ids.ts";
import { JsonSchema, safeRecord } from "./json.ts";
import { MatchResultSchema } from "./match.ts";
import { ResSchema, UnitCountsSchema } from "./resources.ts";

// `GameState` (§4.2): one plain JSON object of normalised records keyed by short ids. Its schema is
// the snapshot format. Derived values (rates, caps, pop, points, free slots) are never stored, nor
// are messages, reports, notes and proposal texts.

const Int = z.int().nonnegative();
/** Seq of a scheduled event. */
const Seq = z.int().nonnegative();

export const PlayerSchema = z.strictObject({
  /** Players have no names: agents know each other only by id. */
  id: PlayerIdSchema,
  alive: z.boolean(),
  eliminatedAt: GameTimeSchema.nullable(),
  /** Read only by std's default relations (§5.4). */
  alliance: AllianceIdSchema.nullable(),
});
export type Player = z.infer<typeof PlayerSchema>;

export const IslandSchema = z.strictObject({
  id: IslandIdSchema,
  /** Integer tiles; may be negative. */
  x: z.int(),
  y: z.int(),
  /** Ruleset label: `home`, `frontier`, `crown`, … */
  kind: z.string().min(1),
  slots: Int,
  /** Production multiplier, per mille. */
  richnessPm: Int,
});
export type Island = z.infer<typeof IslandSchema>;

export const StationedSchema = z.strictObject({
  /** May be the city's owner (units homed in its other cities). */
  owner: PlayerIdSchema,
  /** Units keep their home city. */
  home: CityIdSchema,
  /** `hold`: holding the city against its owner (a `perfidia-1` siege garrison). */
  role: z.enum(["support", "hold"]),
  units: UnitCountsSchema,
});
export type Stationed = z.infer<typeof StationedSchema>;

export const BuildItemSchema = z.strictObject({
  id: QueueItemIdSchema,
  building: BuildingIdSchema,
  /** Projected target at enqueue (cost and duration); completion adds +1 to the current level. */
  level: z.int().positive(),
  cost: ResSchema,
  start: GameTimeSchema,
  end: GameTimeSchema,
  seq: Seq,
});
export type BuildItem = z.infer<typeof BuildItemSchema>;

export const RecruitBatchSchema = z.strictObject({
  id: QueueItemIdSchema,
  unit: UnitIdSchema,
  count: z.int().positive(),
  /** Units already materialised (trickle). */
  done: Int,
  unitTime: z.int().positive(),
  costEach: ResSchema,
  popEach: Int,
  start: GameTimeSchema,
  end: GameTimeSchema,
  seq: Seq,
});
export type RecruitBatch = z.infer<typeof RecruitBatchSchema>;

export const CitySchema = z.strictObject({
  id: CityIdSchema,
  /** The id unless a ruleset lets players rename cities; player-authored. */
  name: AuthoredNameSchema,
  /** `null`: neutral (the Crown). */
  owner: PlayerIdSchema.nullable(),
  island: IslandIdSchema,
  slot: Int,
  capitalOf: PlayerIdSchema.nullable(),
  /** Ruleset marker, e.g. `crown`. */
  tag: z.string().min(1).nullable(),
  foundedAt: GameTimeSchema,
  /** Resource-seconds: whole units × `resourceScale`. */
  stock: ResSchema,
  /** Last materialisation. */
  stockAt: GameTimeSchema,
  /** Every building of the ruleset, 0 included. */
  buildings: safeRecord(BuildingIdSchema, Int),
  /** The owner's units at home (the neutral garrison when `owner` is null). */
  units: UnitCountsSchema,
  /** Sorted by (owner, home, role). */
  stationed: z.array(StationedSchema),
  /** Last queue item number allocated in this city. */
  itemSeq: Int,
  /** Queue order; each item has its own event. */
  build: z.array(BuildItemSchema),
  recruit: safeRecord(QueueIdSchema, z.array(RecruitBatchSchema)),
});
export type City = z.infer<typeof CitySchema>;

export const MovementSchema = z.strictObject({
  id: MovementIdSchema,
  kind: MovementKindSchema,
  owner: PlayerIdSchema,
  /** Where the units belong: the destination of a return. */
  home: CityIdSchema,
  from: CityIdSchema,
  fromIsland: IslandIdSchema,
  /** `null` for found. */
  to: CityIdSchema.nullable(),
  toIsland: IslandIdSchema,
  /** Requested founding slot (`toolOptions.foundSlot`). */
  slot: Int.nullable(),
  /** Recorded at launch by the departure hook; `null` = neutral or not applicable. */
  party: PlayerIdSchema.nullable(),
  units: UnitCountsSchema,
  /** Whole units (shipments, loot, returning cargo). */
  cargo: ResSchema,
  /** Spy gold. */
  gold: Int,
  departAt: GameTimeSchema,
  arriveAt: GameTimeSchema,
  /** Seq of its arrival event. */
  seq: Seq,
  /** Set when a recall or a bounce turned the movement into a return. */
  back: z.strictObject({ kind: MovementKindSchema, at: GameTimeSchema }).nullable(),
});
export type Movement = z.infer<typeof MovementSchema>;

export const ProposalSchema = z.strictObject({
  id: ProposalIdSchema,
  from: PlayerIdSchema,
  to: PlayerIdSchema,
  kind: z.enum(["alliance", "pact"]),
  name: AuthoredNameSchema.nullable(),
  /** Pact end chosen by the proposer (`toolOptions.pactUntil`). */
  until: GameTimeSchema.nullable(),
  expiresAt: GameTimeSchema,
  seq: Seq,
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const AllianceSchema = z.strictObject({
  id: AllianceIdSchema,
  name: AuthoredNameSchema,
  /** Sorted. */
  members: z.array(PlayerIdSchema),
  formedAt: GameTimeSchema,
});
export type Alliance = z.infer<typeof AllianceSchema>;

export const PactSchema = z.strictObject({
  /** `a < b` in `compareIds` order. */
  a: PlayerIdSchema,
  b: PlayerIdSchema,
  since: GameTimeSchema,
  expiresAt: GameTimeSchema.nullable(),
  /** Seq of its `pact_expire` event; `null` when it never expires. */
  seq: Seq.nullable(),
});
export type Pact = z.infer<typeof PactSchema>;

/** Units made and gone per unit id, for unit conservation (§13.3). */
export const LedgerEntrySchema = z.strictObject({
  made: UnitCountsSchema,
  gone: UnitCountsSchema,
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** Last values of each owner's private id counters (§4.1). */
export const OwnCountersSchema = z.strictObject({ m: Int, r: Int, q: Int, g: Int });
export type OwnCounters = z.infer<typeof OwnCountersSchema>;

export const GameStateSchema = z.strictObject({
  v: z.literal(1),
  ruleset: RulesetRefSchema,
  configHash: Sha256Schema,
  /** uint32. */
  seed: z.int().min(0).max(4294967295),
  now: GameTimeSchema,
  status: z.enum(["running", "ended"]),
  /** Last scheduled-event seq (global, monotonic). */
  seq: Seq,
  ids: z.strictObject({
    /** Last allocated city number. */
    c: Int,
    /** Last allocated alliance number. */
    a: Int,
    /** Private kinds, per owner. */
    own: safeRecord(PlayerIdSchema, OwnCountersSchema),
  }),
  /** Running hash of every emitted event (§6.4). */
  evHash: Hash64Schema,
  /** Sorted by (at, cls, seq). */
  queue: z.array(ScheduledEventSchema),
  players: safeRecord(PlayerIdSchema, PlayerSchema),
  islands: safeRecord(IslandIdSchema, IslandSchema),
  cities: safeRecord(CityIdSchema, CitySchema),
  movements: safeRecord(MovementIdSchema, MovementSchema),
  proposals: safeRecord(ProposalIdSchema, ProposalSchema),
  alliances: safeRecord(AllianceIdSchema, AllianceSchema),
  /** Sorted by (a, b), a < b. */
  pacts: z.array(PactSchema),
  /** Unit conservation per owner; the `neutral` entry is always present. */
  ledger: safeRecord(z.union([PlayerIdSchema, z.literal("neutral")]), LedgerEntrySchema).refine(
    (ledger) => Object.hasOwn(ledger, "neutral"),
    {
      error: "the ledger always has a neutral entry",
      path: ["neutral"],
    },
  ),
  /** Ruleset-owned, validated by `ruleset.extSchema`. */
  ext: JsonSchema,
  result: MatchResultSchema.nullable(),
});
export type GameState = z.infer<typeof GameStateSchema>;
