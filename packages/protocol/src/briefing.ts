import { z } from "zod";
import {
  BuildingIdSchema,
  CityIdSchema,
  DurationPairSchema,
  EventTypeSchema,
  GameTimeSchema,
  IslandIdSchema,
  MessageIdSchema,
  MovementIdSchema,
  PlayerIdSchema,
  ProposalIdSchema,
  QueueIdSchema,
  QueueItemIdSchema,
  RulesetRefSchema,
  TimePairSchema,
  UnitIdSchema,
} from "./ids.ts";
import { JsonObjectSchema, safeRecord } from "./json.ts";
import { MovementKindSchema } from "./events.ts";
import { UnitCountsSchema } from "./resources.ts";
import { ErrorCodeSchema } from "./violations.ts";

// The briefing an agent receives at every wake (§8.2): compact, deterministic JSON. Its fields are
// the ones of the §8.2 example; resource arrays follow `wood, stone, gold`. Lists other than
// `incoming` and `proposals` may be truncated, with a `more` entry naming the exact call.

const Count = z.int().nonnegative();
const Triple = z.tuple([Count, Count, Count]);

/**
 * Why a seat woke, as the briefing and the `wake` log line show it: `start`, `safety`, `self`, or
 * an event type followed by the id it concerns, such as `incoming_attack m0k4qz`.
 */
export const WakeReasonSchema = z.string().min(1);
export type WakeReason = z.infer<typeof WakeReasonSchema>;

/** The kind of a seat's next wake (§8.5): the earliest of the urgent, own, self, social and safety times. */
export const WakeKindSchema = z.enum(["urgent", "own", "self", "social", "safety"]);
export type WakeKind = z.infer<typeof WakeKindSchema>;

/**
 * How a turn ended, in the `turn` log line (`why`) and in the next briefing's `lastTurn`: the six
 * endings of §8.2 (`end_turn`, an empty round, the round-trip cap, a timeout, an agent error, the
 * end of the match), plus `eliminated`, which §9.1 lists among the endings of a `TurnHandle`: the
 * seat was eliminated while its turn was open (real time). An eliminated seat never wakes again,
 * so `eliminated` appears only in `turn` lines, never in a briefing. Reaching `toolCallsPerWake`
 * does not end a turn: further calls are rejected with `CALLS_CAP` (§8.3).
 */
export const TurnEndSchema = z.enum([
  "end_turn",
  "empty_round",
  "round_cap",
  "timeout",
  "error",
  "match_ended",
  "eliminated",
]);
export type TurnEnd = z.infer<typeof TurnEndSchema>;

/**
 * The previous turn's ending, the failed results the agent never saw, the warnings on accepted
 * calls it never saw (those of the turn's last round trip, `end_turn`'s `WAKE_CLAMPED` included:
 * no result of that round trip ever reaches the agent), and the effective next wake.
 */
export const BriefingLastTurnSchema = z.looseObject({
  ended: TurnEndSchema,
  unseen: z.array(z.looseObject({ tool: z.string(), code: ErrorCodeSchema, message: z.string() })),
  warnings: z.array(
    z.looseObject({ tool: z.string(), code: ErrorCodeSchema, message: z.string() }),
  ),
  nextWake: z.looseObject({ at: TimePairSchema, kind: WakeKindSchema }).nullable(),
});
export type BriefingLastTurn = z.infer<typeof BriefingLastTurnSchema>;

export const BriefingCitySchema = z.looseObject({
  id: CityIdSchema,
  isl: IslandIdSchema,
  /** Whole units, `[wood, stone, gold]`. */
  res: Triple,
  /** Per game hour. */
  rate: Triple,
  cap: Count,
  /** `[used, cap]`. */
  pop: z.tuple([Count, Count]),
  build: z.array(
    z.looseObject({
      item: QueueItemIdSchema,
      b: BuildingIdSchema,
      lvl: z.int().positive(),
      end: TimePairSchema,
    }),
  ),
  recruit: safeRecord(
    QueueIdSchema,
    z.array(
      z.looseObject({
        item: QueueItemIdSchema,
        unit: UnitIdSchema,
        n: z.int().positive(),
        end: TimePairSchema,
      }),
    ),
  ),
  /** Units at home. */
  units: UnitCountsSchema,
  /** Number of groups stationed in the city. */
  stationed: Count,
  /** `publicCity` extras, omitted when empty (e.g. `perfidia-1`'s siege of an own city). */
  ext: JsonObjectSchema.optional(),
});
export type BriefingCity = z.infer<typeof BriefingCitySchema>;

/** An incoming movement; every incoming attack is listed, with its recorded foe, whatever the truncation. */
export const BriefingIncomingSchema = z.looseObject({
  id: MovementIdSchema,
  kind: MovementKindSchema,
  /** `null` for a return heading into a city you besiege: its origin is hidden (perfidia-1 §12). */
  from: CityIdSchema.nullable(),
  by: PlayerIdSchema,
  foe: PlayerIdSchema.nullable().optional(),
  to: CityIdSchema,
  depart: TimePairSchema,
  arrive: TimePairSchema,
  homecoming: z.boolean().optional(),
  turnedBack: TimePairSchema.optional(),
});
export type BriefingIncoming = z.infer<typeof BriefingIncomingSchema>;

export const BriefingMoveSchema = z.looseObject({
  id: MovementIdSchema,
  kind: MovementKindSchema,
  to: CityIdSchema.nullable(),
  arrive: TimePairSchema,
});

export const BriefingMessageSchema = z.looseObject({
  id: MessageIdSchema,
  from: PlayerIdSchema,
  to: z.union([z.array(PlayerIdSchema), z.literal("all")]),
  /** Player-authored, control characters stripped, cut at 300 characters. */
  text: z.string(),
  /** The text was cut; `read_notes {open: id}` returns it whole. */
  cut: z.literal(true).optional(),
});

export const BriefingProposalSchema = z.looseObject({
  id: ProposalIdSchema,
  from: PlayerIdSchema,
  to: PlayerIdSchema,
  kind: z.enum(["alliance", "pact"]),
  name: z.string().nullable(),
  text: z.string(),
  until: TimePairSchema.nullable().optional(),
  expires: TimePairSchema,
});

/** An event or a news item: its type and its data fields, flattened. */
export const BriefingEventSchema = z.looseObject({ type: EventTypeSchema });

export const BriefingBudgetSchema = z.looseObject({
  roundTrips: Count,
  callsPerRoundTrip: Count,
  /** Per-wake call cap; `null` or absent when the ruleset has none. */
  callsPerWake: Count.nullable().optional(),
  ownWakesLeft: Count,
  socialWakesLeft: Count,
  /** The pending self-wake. */
  selfWakeAt: TimePairSchema.nullable(),
  attacksLeft: Count,
  messagesLeft: Count,
});

/** A truncated list: how many entries were left out, and the exact call that lists them. */
export const BriefingMoreSchema = z.looseObject({
  count: z.int().positive(),
  call: z.looseObject({ tool: z.string(), args: JsonObjectSchema }),
});

export const BriefingSchema = z.looseObject({
  you: PlayerIdSchema,
  t: GameTimeSchema,
  /** `fmtTime(t)`, e.g. `D3 14:02`. */
  time: z.string(),
  /** Time left in the match. */
  left: DurationPairSchema,
  ruleset: RulesetRefSchema,
  wake: z.looseObject({ urgent: z.boolean(), reasons: z.array(WakeReasonSchema) }),
  /** `null` at the seat's first wake. */
  lastTurn: BriefingLastTurnSchema.nullable(),
  cities: z.array(BriefingCitySchema),
  incoming: z.array(BriefingIncomingSchema),
  moves: z.array(BriefingMoveSchema),
  msgs: z.array(BriefingMessageSchema),
  /** Every open proposal to and from the seat, with its text. */
  proposals: z.array(BriefingProposalSchema),
  events: z.array(BriefingEventSchema),
  news: z.array(BriefingEventSchema),
  /** Verbatim, bounded by `notesMaxChars`. */
  notes: z.string(),
  budget: BriefingBudgetSchema,
  /** `visibility.briefing(r, seat)`, default `publicMatch(r)`. */
  ext: JsonObjectSchema,
  /** Truncated lists, by list name (`moves`, `msgs`, `events`, `news`). */
  more: safeRecord(z.string(), BriefingMoreSchema).optional(),
});
export type Briefing = z.infer<typeof BriefingSchema>;
