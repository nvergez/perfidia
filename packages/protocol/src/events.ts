import { z } from "zod";
import {
  AllianceIdSchema,
  AuthoredNameSchema,
  BuildingIdSchema,
  CityIdSchema,
  EventTypeSchema,
  GameTimeSchema,
  IslandIdSchema,
  MessageIdSchema,
  MovementIdSchema,
  PlayerIdSchema,
  ProposalIdSchema,
  QueueIdSchema,
  QueueItemIdSchema,
  ReportIdSchema,
  UnitIdSchema,
} from "./ids.ts";
import { JsonObjectSchema } from "./json.ts";
import { ResSchema, UnitCountsSchema } from "./resources.ts";

// Scheduled events (§5.1) and the domain event envelope with its audiences (§8.6).

/** The six movement kinds (§4.2). Defined here because state, rules and events all use it. */
export const MOVEMENT_KINDS = ["attack", "support", "found", "spy", "shipment", "return"] as const;
export const MovementKindSchema = z.enum(MOVEMENT_KINDS);
export type MovementKind = z.infer<typeof MovementKindSchema>;

/** A pending event of the queue, totally ordered by `(at, cls, seq)`. */
export const ScheduledEventSchema = z.strictObject({
  at: GameTimeSchema,
  /** From `rules.eventClasses[kind]`. */
  cls: z.int().nonnegative(),
  /** Global and unique, assigned at (re)scheduling. */
  seq: z.int().nonnegative(),
  kind: EventTypeSchema,
  /** Entity id: city, movement, proposal, pact key `"p1|p4"`, or `""`. */
  ref: z.string(),
});
export type ScheduledEvent = z.infer<typeof ScheduledEventSchema>;

/** Scheduled event kinds handled by the kernel and the domain module (§5.1). Rulesets add their own. */
export const DOMAIN_EVENT_KINDS = [
  "build_done",
  "recruit_done",
  "arrive_return",
  "arrive_support",
  "arrive_shipment",
  "arrive_spy",
  "arrive_attack",
  "arrive_found",
  "proposal_expire",
  "pact_expire",
  "match_end",
] as const;
export type DomainEventKind = (typeof DOMAIN_EVENT_KINDS)[number];

/**
 * Recipient roles, in priority order: a player appears once in `DomainEvent.to`, with the first
 * role of this list that applies (§8.6).
 */
export const ROLES = ["party", "self", "target", "stationed", "ally"] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const RecipientSchema = z.strictObject({ p: PlayerIdSchema, as: RoleSchema });
export type Recipient = z.infer<typeof RecipientSchema>;

/**
 * An emitted event. It is folded into `evHash` and routed to its recipients; it is never stored in
 * the engine state. An event whose content differs by audience is emitted once per audience.
 */
export const DomainEventSchema = z
  .strictObject({
    t: GameTimeSchema,
    type: EventTypeSchema,
    /** In everyone's news feed. */
    public: z.boolean(),
    /** Seats addressed, with a role (wake rules, archive); one entry per player. */
    to: z.array(RecipientSchema),
    data: JsonObjectSchema,
  })
  .superRefine((e, ctx) => {
    const seen = new Set<string>();
    for (const [i, r] of e.to.entries()) {
      if (seen.has(r.p)) {
        ctx.addIssue({
          code: "custom",
          path: ["to", i, "p"],
          message: `${r.p} is addressed twice: one entry per player`,
        });
      }
      seen.add(r.p);
    }
  });
export type DomainEvent = z.infer<typeof DomainEventSchema>;

// Standard event types: one name and data shape in every ruleset (§8.6). The schemas list the
// fields every ruleset must provide; they are loose objects, so a ruleset may add fields (its
// reports carry its own battle details). Per-recipient copies of one event share the schema, so the
// fields absent from some copies are optional.

const PlayerOrNull = PlayerIdSchema.nullable();
/** A snake_case label chosen by the ruleset (battle types, bounce reasons). */
const Label = z.string().regex(/^[a-z][a-z0-9_]*$/, { error: "expected a snake_case label" });
const OriginalKind = z.enum(["attack", "support", "found", "spy", "shipment"]);

export const STANDARD_EVENT_DATA = {
  /** A build item completed; `level` is the building's new level. To the owner. */
  build_done: z.looseObject({
    city: CityIdSchema,
    item: QueueItemIdSchema,
    building: BuildingIdSchema,
    level: z.int().positive(),
  }),
  /** A recruit batch completed (every unit delivered). To the owner. */
  recruit_done: z.looseObject({
    city: CityIdSchema,
    item: QueueItemIdSchema,
    queue: QueueIdSchema,
    unit: UnitIdSchema,
    count: z.int().positive(),
  }),
  /** Emitted only by a completion that empties its queue (§5.4). */
  queue_empty: z.looseObject({ city: CityIdSchema, queue: QueueIdSchema }),
  /** No composition. `foe` is the recorded foe (`null`: neutral). */
  incoming_attack: z.looseObject({
    movement: MovementIdSchema,
    from: CityIdSchema,
    by: PlayerIdSchema,
    foe: PlayerOrNull,
    to: CityIdSchema,
    departAt: GameTimeSchema,
    arriveAt: GameTimeSchema,
    /** A return heading into a besieged city: a coming homecoming battle. */
    homecoming: z.boolean(),
  }),
  /** Seen in full by the city owner and its allies. */
  incoming_support: z.looseObject({
    movement: MovementIdSchema,
    from: CityIdSchema,
    by: PlayerIdSchema,
    to: CityIdSchema,
    departAt: GameTimeSchema,
    arriveAt: GameTimeSchema,
    units: UnitCountsSchema,
  }),
  /** Seen in full by the city owner and its allies. */
  incoming_shipment: z.looseObject({
    movement: MovementIdSchema,
    from: CityIdSchema,
    by: PlayerIdSchema,
    to: CityIdSchema,
    departAt: GameTimeSchema,
    arriveAt: GameTimeSchema,
    cargo: ResSchema,
  }),
  /** A movement turned back ("turned back at t", the event's `t`); `arriveAt` is its arrival home. */
  movement_recalled: z.looseObject({
    movement: MovementIdSchema,
    kind: OriginalKind,
    by: PlayerIdSchema,
    to: CityIdSchema.nullable(),
    arriveAt: GameTimeSchema,
  }),
  /** The city owner's copy carries `units`; the sender's copy says only that the group is stationed. */
  support_arrived: z.looseObject({
    movement: MovementIdSchema,
    by: PlayerIdSchema,
    to: CityIdSchema,
    units: UnitCountsSchema.optional(),
  }),
  /**
   * The recipient's copy carries the amounts (`res`) and the overflow lost (`lost`); the sender's
   * copy is `{movement, to, outcome}` only (§8.6).
   */
  shipment_delivered: z.looseObject({
    movement: MovementIdSchema,
    to: CityIdSchema,
    outcome: z.literal("delivered"),
    by: PlayerIdSchema.optional(),
    from: CityIdSchema.optional(),
    res: ResSchema.optional(),
    lost: ResSchema.optional(),
  }),
  /** The movement turned into a return at once; `reason` is public (e.g. `owner_changed`). To the mover. */
  bounced: z.looseObject({
    movement: MovementIdSchema,
    kind: OriginalKind,
    reason: Label,
  }),
  /** Units and cargo are home; `lost` is the cargo over the storage cap. To the owner. */
  returned: z.looseObject({
    movement: MovementIdSchema,
    city: CityIdSchema,
    units: UnitCountsSchema,
    cargo: ResSchema,
    lost: ResSchema.optional(),
  }),
  city_founded: z.looseObject({
    city: CityIdSchema,
    island: IslandIdSchema,
    slot: z.int().nonnegative(),
    owner: PlayerIdSchema,
  }),
  /** The text is carried by the event, never stored in the state. */
  message: z.looseObject({
    message: MessageIdSchema,
    from: PlayerIdSchema,
    to: z.union([z.array(PlayerIdSchema).min(1), z.literal("all")]),
    text: z.string(),
  }),
  proposal: z.looseObject({
    proposal: ProposalIdSchema,
    from: PlayerIdSchema,
    to: PlayerIdSchema,
    kind: z.enum(["alliance", "pact"]),
    name: AuthoredNameSchema.nullable(),
    text: z.string(),
    until: GameTimeSchema.nullable(),
    expiresAt: GameTimeSchema,
  }),
  proposal_answered: z.looseObject({
    proposal: ProposalIdSchema,
    from: PlayerIdSchema,
    to: PlayerIdSchema,
    kind: z.enum(["alliance", "pact"]),
    accept: z.boolean(),
  }),
  proposal_expired: z.looseObject({
    proposal: ProposalIdSchema,
    from: PlayerIdSchema,
    to: PlayerIdSchema,
    kind: z.enum(["alliance", "pact"]),
  }),
  alliance_formed: z.looseObject({
    alliance: AllianceIdSchema,
    name: AuthoredNameSchema,
    members: z.array(PlayerIdSchema).min(1),
  }),
  alliance_joined: z.looseObject({ alliance: AllianceIdSchema, player: PlayerIdSchema }),
  alliance_left: z.looseObject({
    alliance: AllianceIdSchema,
    player: PlayerIdSchema,
    cause: z.enum(["left", "betrayal", "eliminated"]),
  }),
  alliance_dissolved: z.looseObject({ alliance: AllianceIdSchema }),
  pact_signed: z.looseObject({
    a: PlayerIdSchema,
    b: PlayerIdSchema,
    expiresAt: GameTimeSchema.nullable(),
  }),
  pact_renewed: z.looseObject({
    a: PlayerIdSchema,
    b: PlayerIdSchema,
    expiresAt: GameTimeSchema.nullable(),
  }),
  pact_ended: z.looseObject({
    a: PlayerIdSchema,
    b: PlayerIdSchema,
    cause: z.enum(["left", "betrayal", "eliminated", "superseded"]),
  }),
  pact_expired: z.looseObject({ a: PlayerIdSchema, b: PlayerIdSchema }),
  /** The battle headline, no numbers; `public: false` in a ruleset whose battles are not public. */
  battle: z.looseObject({
    city: CityIdSchema,
    attacker: PlayerIdSchema,
    defender: z.union([PlayerIdSchema, z.literal("neutral")]),
    /** Ruleset label of the battle type, e.g. `city`, `relief`, `homecoming`. */
    kind: Label,
    winner: z.enum(["attacker", "defender"]),
  }),
  /** Per recipient, already redacted by the ruleset; the details are the ruleset's. */
  battle_report: z.looseObject({
    report: ReportIdSchema,
    city: CityIdSchema,
    attacker: PlayerIdSchema,
    defender: z.union([PlayerIdSchema, z.literal("neutral")]),
    kind: Label,
    winner: z.enum(["attacker", "defender"]),
  }),
  /** To the spier; the snapshot's fields are the ruleset's. */
  spy_report: z.looseObject({ report: ReportIdSchema, city: CityIdSchema }),
  /** To the spier, who learns only that it failed. */
  spy_failed: z.looseObject({ movement: MovementIdSchema, city: CityIdSchema }),
  /** To the city owner: the spier, the origin city and the gold spent. */
  spy_detected: z.looseObject({
    city: CityIdSchema,
    by: PlayerIdSchema,
    from: CityIdSchema,
    gold: z.int().nonnegative(),
  }),
  /** `from` is `null` for a neutral city. */
  city_conquered: z.looseObject({ city: CityIdSchema, from: PlayerOrNull, to: PlayerIdSchema }),
  player_eliminated: z.looseObject({ player: PlayerIdSchema }),
  betrayal: z.looseObject({
    by: PlayerIdSchema,
    against: PlayerIdSchema,
    relation: z.enum(["ally", "pact"]),
    city: CityIdSchema,
  }),
  match_ended: z.looseObject({ reason: z.string().min(1), winners: z.array(PlayerIdSchema) }),
} as const satisfies Readonly<Record<string, z.ZodType>>;

export type StandardEventType = keyof typeof STANDARD_EVENT_DATA;
export type StandardEventData<T extends StandardEventType> = z.infer<
  (typeof STANDARD_EVENT_DATA)[T]
>;

/** Every standard event type, in the order of §8.6. */
export const STANDARD_EVENT_TYPES = [
  "build_done",
  "recruit_done",
  "queue_empty",
  "incoming_attack",
  "incoming_support",
  "incoming_shipment",
  "movement_recalled",
  "support_arrived",
  "shipment_delivered",
  "bounced",
  "returned",
  "city_founded",
  "message",
  "proposal",
  "proposal_answered",
  "proposal_expired",
  "alliance_formed",
  "alliance_joined",
  "alliance_left",
  "alliance_dissolved",
  "pact_signed",
  "pact_renewed",
  "pact_ended",
  "pact_expired",
  "battle",
  "battle_report",
  "spy_report",
  "spy_failed",
  "spy_detected",
  "city_conquered",
  "player_eliminated",
  "betrayal",
  "match_ended",
] as const satisfies readonly StandardEventType[];
export const StandardEventTypeSchema = z.enum(STANDARD_EVENT_TYPES);

/**
 * Standard event types whose payload depends on hidden data by design (§8.6); exempt from the
 * transition non-interference property P15. A ruleset declares its own in `Ruleset.intelEvents`.
 */
export const INTEL_EVENT_TYPES = [
  "battle",
  "battle_report",
  "spy_report",
  "spy_failed",
  "spy_detected",
  "city_conquered",
  "player_eliminated",
  "betrayal",
] as const satisfies readonly StandardEventType[];
