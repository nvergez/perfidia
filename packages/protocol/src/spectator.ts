import { z } from "zod";
import { EffortSchema, ProfileSchema, TokenUsageSchema } from "./arena.ts";
import { TurnEndSchema, WakeKindSchema } from "./briefing.ts";
import { MovementKindSchema } from "./events.ts";
import {
  AllianceIdSchema,
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
  ReportIdSchema,
  RulesetRefSchema,
  SemverSchema,
  Sha256Schema,
  UnitIdSchema,
} from "./ids.ts";
import { JsonObjectSchema, safePartialRecord, safeRecord } from "./json.ts";
import { ClockSpecSchema, type Standing } from "./match.ts";
import { ResSchema, UnitCountsSchema } from "./resources.ts";
import {
  AllianceSchema,
  MovementSchema,
  PactSchema,
  ProposalSchema,
  StationedSchema,
} from "./state.ts";

// The spectator formats (phase-3 design §2.6, §2.7, §3): what the read-only server sends to the
// web app about a match. A `Frame` is the whole match as spectators see it at one log line (every
// city, army, movement, relation and seat: everything the agents hide from each other); a `Step`
// is what one line of `match.jsonl` changed (a `Patch` that replaces whole entities) and the feed
// items it yields; keyframes are frames at known cursors. Cursors (`seq`) are 0-based line numbers
// of `match.jsonl` (the header is 0). Frames hold materialised values only: a city's stock is in
// whole units at `stockAt` with rates per hour, never a value derived at a later time. Player text
// is plain text (newlines kept, other control and bidi characters removed by the fold). Secrets
// never appear: no `idKey`, no seed, no API key, no prompt text, no request id, no error text.
// Imported by the web through the `@perfidia/protocol/spectator` sub-path, which leaves the rest of
// the protocol out of its bundle.

export const SPECTATOR_FORMAT = "perfidia-spectator/1";

/** A player's standing: the web derives the leaderboard from a frame's players (`standingsOf`). */
export type { Standing };

/** A match id: its run directory's name. A key of the index, never a path. */
export const MatchIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/, {
  error: "expected a match id: letters, digits and . _ @ -, up to 128 characters",
});
export type MatchId = z.infer<typeof MatchIdSchema>;

/** FNV-1a 64 of the log id and the fold and engine versions: a new value means new steps. */
export const TimelineIdSchema = z.string().regex(/^[0-9a-f]{16}$/, {
  error: "expected a timeline id: 16 lowercase hex characters",
});
export type TimelineId = z.infer<typeof TimelineIdSchema>;

/** A cursor: a 0-based line number of `match.jsonl` (the header is 0). */
export const SeqSchema = z.int().nonnegative();
export type Seq = z.infer<typeof SeqSchema>;

export const MATCH_STATUSES = [
  "loading",
  "live",
  "paused",
  "stalled",
  "ended",
  "stopped",
  "degraded",
  "aborted",
  "fatal",
  "incomplete",
  "unverifiable",
  "unpublished",
] as const;
export const MatchStatusSchema = z.enum(MATCH_STATUSES);
export type MatchStatus = z.infer<typeof MatchStatusSchema>;

/** Why a match stopped or is shown as it is: a fixed vocabulary, never operator text. */
export const PublicReasonSchema = z.enum([
  "domination",
  "time",
  "last_standing",
  "stopped_after_day",
  "aborted",
  "engine_error",
  "model_errors",
  "operator_pause",
  "unverifiable",
]);
export type PublicReason = z.infer<typeof PublicReasonSchema>;

const Int = z.int().nonnegative();
const Importance = z.int().min(0).max(3);

/** The public part of an LLM seat's profile (its hand-off bot is listed apart). */
const PublicProfileSchema = ProfileSchema.omit({ handoffBot: true });
export type PublicProfile = z.infer<typeof PublicProfileSchema>;

const SeatModelSchema = z.strictObject({
  provider: z.string(),
  model: z.string(),
  effort: EffortSchema,
});
export type SeatModel = z.infer<typeof SeatModelSchema>;

/** Who plays a seat: from `seats.json`, the header's controller labels and `arena.json`. */
export const SeatInfoSchema = z.strictObject({
  seat: PlayerIdSchema,
  kind: z.enum(["llm", "bot"]),
  /** `Odysseus` for an LLM seat, the bot's strategy for a bot. */
  name: z.string(),
  /** The controller label at the start, e.g. `bot:turtle@3`. */
  label: z.string(),
  /** One of 12 player colours. */
  color: z.int().min(0).max(11),
  /** Provider `fake` or a `--fake` run: a bot behind the LLM pipe, never shown as the model. */
  fake: z.boolean(),
  model: SeatModelSchema.nullable(),
  profile: PublicProfileSchema.nullable(),
  handoffBot: z.string().nullable(),
});
export type SeatInfo = z.infer<typeof SeatInfoSchema>;

const SpectatorIslandSchema = z.strictObject({
  id: IslandIdSchema,
  kind: z.string(),
  x: z.int(),
  y: z.int(),
  slots: Int,
  richnessPm: Int,
});
export type SpectatorIsland = z.infer<typeof SpectatorIslandSchema>;

/** The map's islands and the box `[0, width] × [0, height]` that holds them (tiles). */
export const SpectatorMapSchema = z.strictObject({
  width: Int,
  height: Int,
  islands: z.array(SpectatorIslandSchema),
});
export type SpectatorMap = z.infer<typeof SpectatorMapSchema>;

/** Level E of the log so far: `divergence` names the first one, in a fixed wording. */
const VerifiedSchema = z.strictObject({
  ok: z.boolean(),
  divergence: z.string().nullable(),
});
export type Verified = z.infer<typeof VerifiedSchema>;

export const MatchMetaSchema = z.strictObject({
  format: z.literal(SPECTATOR_FORMAT),
  id: MatchIdSchema,
  title: z.string(),
  description: z.string().nullable(),
  ruleset: RulesetRefSchema,
  engine: SemverSchema,
  configHash: Sha256Schema,
  rulesHash: Sha256Schema,
  /** The effective config of the header. */
  config: JsonObjectSchema,
  clock: ClockSpecSchema,
  matchEnd: GameTimeSchema,
  seats: z.array(SeatInfoSchema),
  map: SpectatorMapSchema,
  status: MatchStatusSchema,
  reason: PublicReasonSchema.nullable(),
  /** ISO wall time of the start, when the log has one. */
  wallStart: z.string().nullable(),
  lastSeq: SeqSchema,
  lastT: GameTimeSchema,
  /** sha256 of the header line. */
  logId: Sha256Schema,
  timeline: TimelineIdSchema,
  /** Cursors of the frames the keyframe route serves. */
  keyframes: z.array(SeqSchema),
  verified: VerifiedSchema,
});
export type MatchMeta = z.infer<typeof MatchMetaSchema>;

// Frame entities -----------------------------------------------------------------------------------

export const CityEntSchema = z.strictObject({
  id: CityIdSchema,
  name: z.string(),
  owner: PlayerIdSchema.nullable(),
  island: IslandIdSchema,
  slot: Int,
  capitalOf: PlayerIdSchema.nullable(),
  tag: z.string().nullable(),
  buildings: safeRecord(BuildingIdSchema, Int),
  /** The owner's units at home (the neutral garrison of a neutral city). */
  units: UnitCountsSchema,
  stationed: z.array(StationedSchema),
  /** Whole units at `stockAt`, as stored; `perHour` is the production rate, `cap` the storage cap. */
  stock: ResSchema,
  stockAt: GameTimeSchema,
  perHour: ResSchema,
  cap: Int,
  pop: z.strictObject({ used: Int, cap: Int }),
  /** The ruleset's public extras of the city (`publicCity`): points, sieges, taken cities. */
  ext: JsonObjectSchema,
});
export type CityEnt = z.infer<typeof CityEntSchema>;

/** A queue item's key: its city and the city's item number, `c3#7`. */
export const QueueKeySchema = z.string().regex(/^c[1-9][0-9]*#[1-9][0-9]*$/, {
  error: "expected a queue item key: a city id, '#' and its item number, such as c3#7",
});
export type QueueKey = z.infer<typeof QueueKeySchema>;

/**
 * One item of a city's build queue or recruit queues: a building and its target level, or a recruit
 * batch with the units delivered as stored (trickle delivery materialises them when the city is
 * touched). A queue's order is its items' `start` order.
 */
export const QueueEntSchema = z.strictObject({
  city: CityIdSchema,
  item: z.int().positive(),
  /** `build`, or a recruit queue id of the ruleset. */
  queue: QueueIdSchema,
  building: BuildingIdSchema.nullable(),
  level: z.int().positive().nullable(),
  unit: UnitIdSchema.nullable(),
  count: z.int().positive().nullable(),
  done: Int.nullable(),
  start: GameTimeSchema,
  end: GameTimeSchema,
});
export type QueueEnt = z.infer<typeof QueueEntSchema>;

/** Where a movement was turned back (a recall or a bounce), interpolated on its way out (tiles). */
const TurnedAtSchema = z.strictObject({ t: GameTimeSchema, x: z.int(), y: z.int() });
export type TurnedAt = z.infer<typeof TurnedAtSchema>;

export const MovementEntSchema = MovementSchema.pick({
  id: true,
  kind: true,
  owner: true,
  home: true,
  from: true,
  fromIsland: true,
  to: true,
  toIsland: true,
  party: true,
  units: true,
  cargo: true,
  gold: true,
  departAt: true,
  arriveAt: true,
  back: true,
}).extend({ turnedAt: TurnedAtSchema.nullable() });
export type MovementEnt = z.infer<typeof MovementEntSchema>;

const RelationEntSchema = z.strictObject({
  player: PlayerIdSchema,
  kind: z.enum(["ally", "pact"]),
  /** Pact expiry; `null`: none. */
  until: GameTimeSchema.nullable(),
});
export type RelationEnt = z.infer<typeof RelationEntSchema>;

export const PlayerEntSchema = z.strictObject({
  id: PlayerIdSchema,
  alive: z.boolean(),
  eliminatedAt: GameTimeSchema.nullable(),
  alliance: AllianceIdSchema.nullable(),
  rank: z.int().positive(),
  score: z.int(),
  parts: safeRecord(z.string(), z.int()),
  cities: Int,
  relations: z.array(RelationEntSchema),
  /** Every unit the player owns, at home, stationed or moving, and its population: hidden from players. */
  army: z.strictObject({ pop: Int, units: UnitCountsSchema }),
  /** The ruleset's public extras of the player (`publicPlayer`). */
  ext: JsonObjectSchema,
});
export type PlayerEnt = z.infer<typeof PlayerEntSchema>;

export const SeatEntSchema = z.strictObject({
  seat: PlayerIdSchema,
  /** The controller label now (an LLM seat handed to a bot shows the bot's). */
  controller: z.string(),
  inTurn: z.boolean(),
  /** Turns opened so far. */
  turn: Int,
  /** The round of the open turn, from the last call's `rt`; `null` when none was logged. */
  round: Int.nullable(),
  /** When the open (or last) turn started. */
  wakeT: GameTimeSchema.nullable(),
  reasons: z.array(z.string()),
  urgent: z.boolean(),
  /** The effective next wake (the gateway's scheduler); `start` before the seat's first turn. */
  next: z
    .strictObject({ at: GameTimeSchema, kind: z.enum(["start", ...WakeKindSchema.options]) })
    .nullable(),
  /** The last public thought (400 characters at most). */
  lastThought: z.strictObject({ turn: Int, t: GameTimeSchema, text: z.string() }).nullable(),
  notesChars: Int,
  /** The hand-off to a bot, when there was one. */
  handoff: z.strictObject({ t: GameTimeSchema, label: z.string() }).nullable(),
});
export type SeatEnt = z.infer<typeof SeatEntSchema>;

const FramePactSchema = PactSchema.omit({ seq: true });
export type FramePact = z.infer<typeof FramePactSchema>;
const FrameProposalSchema = ProposalSchema.omit({ seq: true });
export type FrameProposal = z.infer<typeof FrameProposalSchema>;

const FrameResultSchema = z.strictObject({
  reason: z.string(),
  winners: z.array(PlayerIdSchema),
});
export type FrameResult = z.infer<typeof FrameResultSchema>;

export const FrameSchema = z.strictObject({
  format: z.literal(SPECTATOR_FORMAT),
  match: MatchIdSchema,
  timeline: TimelineIdSchema,
  /** The cursor of the last step applied (or of the keyframe). */
  seq: SeqSchema,
  t: GameTimeSchema,
  status: MatchStatusSchema,
  result: FrameResultSchema.nullable(),
  /** The ruleset's public extras of the match (`publicMatch`): domination, tie-break. */
  ext: JsonObjectSchema,
  /**
   * Every city, player and seat. The standings are the players' `rank`, `score`, `parts`, `cities`
   * and `alive` (the ruleset's, the end line's once the match has ended), in rank order.
   */
  cities: safeRecord(CityIdSchema, CityEntSchema),
  /** Every build item and recruit batch of every city, by `c3#7` key. */
  queues: safeRecord(QueueKeySchema, QueueEntSchema),
  movements: safeRecord(MovementIdSchema, MovementEntSchema),
  players: safeRecord(PlayerIdSchema, PlayerEntSchema),
  seats: safeRecord(PlayerIdSchema, SeatEntSchema),
  alliances: safeRecord(AllianceIdSchema, AllianceSchema),
  pacts: z.array(FramePactSchema),
  /** Open proposals, in the order they were made. */
  proposals: z.array(FrameProposalSchema),
});
export type Frame = z.infer<typeof FrameSchema>;

/**
 * What one line changed: whole entities by id (`null` deletes one), and, for the entities that
 * change most (cities, queue items, players, seats), the changed top-level fields of an entity the
 * frame already holds (`cityFields`, `queueFields`, `playerFields`, `seatFields`); the arrays and `ext` whole; `status` and
 * `result` when they change. Applying it is a plain assign, delete or field assign.
 */
export const PatchSchema = z.strictObject({
  cities: safePartialRecord(CityIdSchema, CityEntSchema.nullable()).optional(),
  cityFields: safePartialRecord(CityIdSchema, CityEntSchema.partial()).optional(),
  queues: safePartialRecord(QueueKeySchema, QueueEntSchema.nullable()).optional(),
  queueFields: safePartialRecord(QueueKeySchema, QueueEntSchema.partial()).optional(),
  movements: safePartialRecord(MovementIdSchema, MovementEntSchema.nullable()).optional(),
  players: safePartialRecord(PlayerIdSchema, PlayerEntSchema.nullable()).optional(),
  playerFields: safePartialRecord(PlayerIdSchema, PlayerEntSchema.partial()).optional(),
  seats: safePartialRecord(PlayerIdSchema, SeatEntSchema.nullable()).optional(),
  seatFields: safePartialRecord(PlayerIdSchema, SeatEntSchema.partial()).optional(),
  alliances: safePartialRecord(AllianceIdSchema, AllianceSchema.nullable()).optional(),
  pacts: z.array(FramePactSchema).optional(),
  proposals: z.array(FrameProposalSchema).optional(),
  ext: JsonObjectSchema.optional(),
  status: MatchStatusSchema.optional(),
  result: FrameResultSchema.nullable().optional(),
});
export type Patch = z.infer<typeof PatchSchema>;

// Feed items ---------------------------------------------------------------------------------------

/** Every feed item: a stable id `"<seq>:<i>"`, its time, the players it involves and its importance. */
const itemBase = {
  id: z.string().regex(/^[0-9]+:[0-9]+$/),
  t: GameTimeSchema,
  players: z.array(PlayerIdSchema),
  /** 0 (background) to 3 (a key moment); 2 and above are moments. */
  importance: Importance,
};

const MessageItemSchema = z.strictObject({
  k: z.literal("message"),
  ...itemBase,
  message: MessageIdSchema,
  from: PlayerIdSchema,
  to: z.union([z.array(PlayerIdSchema), z.literal("all")]),
  /** Not to everyone: only the recipients saw it. */
  private: z.boolean(),
  text: z.string(),
  /** The sender's turn it was sent in (its thought of that turn is the same turn's `turn` item). */
  turn: Int.nullable(),
});

const ProposalItemSchema = z.strictObject({
  k: z.literal("proposal"),
  ...itemBase,
  proposal: ProposalIdSchema,
  from: PlayerIdSchema,
  to: PlayerIdSchema,
  kind: z.enum(["alliance", "pact"]),
  name: z.string().nullable(),
  text: z.string(),
  until: GameTimeSchema.nullable(),
  expiresAt: GameTimeSchema,
});

const AnswerItemSchema = z.strictObject({
  k: z.literal("answer"),
  ...itemBase,
  proposal: ProposalIdSchema,
  from: PlayerIdSchema,
  to: PlayerIdSchema,
  kind: z.enum(["alliance", "pact"]),
  accept: z.boolean(),
});

const ExpiredItemSchema = z.strictObject({
  k: z.literal("expired"),
  ...itemBase,
  proposal: ProposalIdSchema,
  from: PlayerIdSchema,
  to: PlayerIdSchema,
  kind: z.enum(["alliance", "pact"]),
});

const DiplomacyItemSchema = z.strictObject({
  k: z.literal("diplomacy"),
  ...itemBase,
  event: z.enum([
    "alliance_formed",
    "alliance_joined",
    "alliance_left",
    "alliance_dissolved",
    "pact_signed",
    "pact_renewed",
    "pact_ended",
    "pact_expired",
  ]),
  alliance: AllianceIdSchema.nullable(),
  /** The alliance's name (formed). */
  name: z.string().nullable(),
  cause: z.enum(["left", "betrayal", "eliminated", "superseded"]).nullable(),
  /** A pact's expiry (signed, renewed). */
  expiresAt: GameTimeSchema.nullable(),
});

/** The context of a betrayal or of an attack launched against an ally: what came before, from the log. */
const MomentContextSchema = z.strictObject({
  /** The betrayer's last private messages to the victim within 48 game hours, oldest first. */
  messages: z.array(z.strictObject({ item: z.string(), t: GameTimeSchema, text: z.string() })),
  /** The betrayer's last public thoughts naming the victim in that window, oldest first. */
  thoughts: z.array(z.strictObject({ turn: Int, t: GameTimeSchema, text: z.string() })),
  /** When the broken relation began, when the log tells. */
  since: GameTimeSchema.nullable(),
});
export type MomentContext = z.infer<typeof MomentContextSchema>;

const BetrayalItemSchema = z.strictObject({
  k: z.literal("betrayal"),
  ...itemBase,
  by: PlayerIdSchema,
  against: PlayerIdSchema,
  relation: z.enum(["ally", "pact"]),
  city: CityIdSchema,
  context: MomentContextSchema,
});

const LaunchItemSchema = z.strictObject({
  k: z.literal("launch"),
  ...itemBase,
  movement: MovementIdSchema,
  kind: MovementKindSchema,
  owner: PlayerIdSchema,
  from: CityIdSchema,
  to: CityIdSchema.nullable(),
  toIsland: IslandIdSchema,
  /** The target city's owner at launch (`null`: neutral, or a founding). */
  target: PlayerIdSchema.nullable(),
  departAt: GameTimeSchema,
  arriveAt: GameTimeSchema,
  units: UnitCountsSchema,
  pop: Int,
  settlers: z.boolean(),
  /** An attack on the attacker's ally or pact partner at launch. */
  againstAlly: z.enum(["ally", "pact"]).nullable(),
  context: MomentContextSchema.nullable(),
});

const BattleItemSchema = z.strictObject({
  k: z.literal("battle"),
  ...itemBase,
  city: CityIdSchema,
  attacker: PlayerIdSchema,
  defender: z.union([PlayerIdSchema, z.literal("neutral")]),
  /** The ruleset's battle type, e.g. `city`, `relief`, `homecoming`. */
  kind: z.string(),
  winner: z.enum(["attacker", "defender"]),
  /** Every recipient's copy of its report. */
  reports: z.array(ReportIdSchema),
  /** A siege started or broke in the same second at that city. */
  siege: z.enum(["started", "broken"]).nullable(),
  /** The city changed hands in the same second. */
  fell: z.boolean(),
});

const SiegeItemSchema = z.strictObject({
  k: z.literal("siege"),
  ...itemBase,
  event: z.enum(["started", "broken"]),
  city: CityIdSchema,
  owner: PlayerIdSchema.nullable(),
  by: PlayerIdSchema,
  endsAt: GameTimeSchema.nullable(),
  cause: z.string().nullable(),
});

const ConquestItemSchema = z.strictObject({
  k: z.literal("conquest"),
  ...itemBase,
  city: CityIdSchema,
  from: PlayerIdSchema.nullable(),
  to: PlayerIdSchema,
  /** The city carries the ruleset's prize tag (perfidia-1: Mount Olympus). */
  prize: z.boolean(),
});

const FoundingItemSchema = z.strictObject({
  k: z.literal("founding"),
  ...itemBase,
  city: CityIdSchema,
  island: IslandIdSchema,
  slot: Int,
  owner: PlayerIdSchema,
});

const SpyItemSchema = z.strictObject({
  k: z.literal("spy"),
  ...itemBase,
  event: z.enum(["spy_report", "spy_failed", "spy_detected"]),
  city: CityIdSchema,
  /** The spier, when the event names it. */
  by: PlayerIdSchema.nullable(),
  report: ReportIdSchema.nullable(),
});

const EliminationItemSchema = z.strictObject({
  k: z.literal("elimination"),
  ...itemBase,
  player: PlayerIdSchema,
});

const CountdownItemSchema = z.strictObject({
  k: z.literal("countdown"),
  ...itemBase,
  event: z.enum(["started", "cancelled"]),
  /** The bloc's key. */
  key: z.string(),
  members: z.array(PlayerIdSchema),
  cities: Int.nullable(),
  taken: Int.nullable(),
  need: Int.nullable(),
  needTaken: Int.nullable(),
  endsAt: GameTimeSchema.nullable(),
  reason: z.string().nullable(),
});

/** A public event of a type the fold does not map (another ruleset's), with its data. */
const EventItemSchema = z.strictObject({
  k: z.literal("event"),
  ...itemBase,
  type: EventTypeSchema,
  data: JsonObjectSchema,
});

const TurnItemSchema = z.strictObject({
  k: z.literal("turn"),
  ...itemBase,
  seat: PlayerIdSchema,
  turn: Int,
  /** An LLM seat's turn (a bot's turns are importance 0). */
  llm: z.boolean(),
  wakeT: GameTimeSchema.nullable(),
  reasons: z.array(z.string()),
  urgent: z.boolean(),
  why: TurnEndSchema,
  rounds: Int,
  calls: Int,
  /** Engine-accepted calls, and the rejected ones by code (gateway and engine). */
  accepted: Int,
  rejected: z.array(z.strictObject({ code: z.string(), count: z.int().positive() })),
  /** Messages sent in the turn. */
  messages: z.array(MessageIdSchema),
  thought: z.string().nullable(),
});

const HandoffItemSchema = z.strictObject({
  k: z.literal("handoff"),
  ...itemBase,
  seat: PlayerIdSchema,
  /** The new controller label, and the one before. */
  label: z.string(),
  from: z.string(),
});

const EndItemSchema = z.strictObject({
  k: z.literal("end"),
  ...itemBase,
  reason: z.string(),
  winners: z.array(PlayerIdSchema),
});

export const FeedItemSchema = z.discriminatedUnion("k", [
  MessageItemSchema,
  ProposalItemSchema,
  AnswerItemSchema,
  ExpiredItemSchema,
  DiplomacyItemSchema,
  BetrayalItemSchema,
  LaunchItemSchema,
  BattleItemSchema,
  SiegeItemSchema,
  ConquestItemSchema,
  FoundingItemSchema,
  SpyItemSchema,
  EliminationItemSchema,
  CountdownItemSchema,
  EventItemSchema,
  TurnItemSchema,
  HandoffItemSchema,
  EndItemSchema,
]);
export type FeedItem = z.infer<typeof FeedItemSchema>;
export type FeedKind = FeedItem["k"];
export type FeedItemOf<K extends FeedKind> = Extract<FeedItem, { k: K }>;

/** Every feed item kind, in the order of the design's table. */
export const FEED_KINDS = [
  "message",
  "proposal",
  "answer",
  "expired",
  "diplomacy",
  "betrayal",
  "launch",
  "battle",
  "siege",
  "conquest",
  "founding",
  "spy",
  "elimination",
  "countdown",
  "event",
  "turn",
  "handoff",
  "end",
] as const satisfies readonly FeedKind[];
export const FeedKindSchema = z.enum(FEED_KINDS);

/** What one line of `match.jsonl` changed and yielded; a line that does neither has no step. */
export const StepSchema = z.strictObject({
  seq: SeqSchema,
  t: GameTimeSchema,
  patch: PatchSchema.optional(),
  items: z.array(FeedItemSchema).optional(),
});
export type Step = z.infer<typeof StepSchema>;

/** A feed item of importance 2 or more, with a short title for the timeline and the reel. */
export const MomentSchema = z.strictObject({
  item: z.string(),
  seq: SeqSchema,
  t: GameTimeSchema,
  k: FeedKindSchema,
  importance: Importance,
  title: z.string(),
  players: z.array(PlayerIdSchema),
  cities: z.array(CityIdSchema),
  context: MomentContextSchema.optional(),
});
export type Moment = z.infer<typeof MomentSchema>;

// Annotations (from the side files; mutable, never part of the steps) -----------------------------

const AnnotationRoundSchema = z.strictObject({
  round: Int,
  kind: z.enum(["round", "thought_call"]),
  /** HTTP attempts of the round (`llm_call` lines). */
  attempts: Int,
  /** The last attempt's stop reason. */
  stop: z.string().nullable(),
  /** The refusal category of a refused attempt (never its explanation). */
  refusal: z.string().nullable(),
  /** Error kinds of failed attempts (never their messages). */
  errors: z.array(z.string()),
  reasoning: z.array(z.string()),
  text: z.array(z.string()),
  /** Tool names of the reply's calls. */
  calls: z.array(z.string()),
  costNanoUsd: Int,
  tokens: TokenUsageSchema,
  latencyMs: Int,
});
export type AnnotationRound = z.infer<typeof AnnotationRoundSchema>;

export const TurnAnnotationSchema = z.strictObject({
  seat: PlayerIdSchema,
  turn: Int,
  /** No later side line of this turn can come (a later turn's line exists, or the run is over). */
  complete: z.boolean(),
  rounds: z.array(AnnotationRoundSchema),
  /** The seat's spend after this turn and its cap; `null` when costs are not public. */
  spentNanoUsd: Int.nullable(),
  capNanoUsd: Int.nullable(),
});
export type TurnAnnotation = z.infer<typeof TurnAnnotationSchema>;

// REST payloads ----------------------------------------------------------------------------------

export const MatchListItemSchema = z.strictObject({
  id: MatchIdSchema,
  title: z.string(),
  status: MatchStatusSchema,
  reason: PublicReasonSchema.nullable(),
  ruleset: RulesetRefSchema,
  players: Int,
  lastT: GameTimeSchema,
  /** Game day of `lastT`, from 1. */
  day: z.int().positive(),
  leader: PlayerIdSchema.nullable(),
  winners: z.array(PlayerIdSchema).nullable(),
  featured: z.boolean(),
  seats: z.array(
    SeatInfoSchema.pick({ seat: true, name: true, kind: true, model: true, fake: true }),
  ),
});
export type MatchListItem = z.infer<typeof MatchListItemSchema>;

export const StepsPageSchema = z.strictObject({
  /** Steps with `from < seq ≤ to`. */
  from: z.int().min(-1),
  to: z.int().min(-1),
  steps: z.array(StepSchema),
  lastSeq: SeqSchema,
  more: z.boolean(),
});
export type StepsPage = z.infer<typeof StepsPageSchema>;

export const FeedPageSchema = z.strictObject({
  items: z.array(z.strictObject({ seq: SeqSchema, item: FeedItemSchema })),
  more: z.boolean(),
});
export type FeedPage = z.infer<typeof FeedPageSchema>;

export const PlayerDossierSchema = z.strictObject({
  seat: SeatInfoSchema,
  /** The seat's notebook now (agent-authored text). */
  notes: z.string(),
  counts: z.strictObject({
    turns: Int,
    messagesSent: Int,
    messagesReceived: Int,
  }),
  spentNanoUsd: Int.nullable(),
  capNanoUsd: Int.nullable(),
  handoff: z.strictObject({ t: GameTimeSchema, label: z.string() }).nullable(),
});
export type PlayerDossier = z.infer<typeof PlayerDossierSchema>;

export const ReportDetailSchema = z.strictObject({
  report: ReportIdSchema,
  seq: SeqSchema,
  t: GameTimeSchema,
  type: EventTypeSchema,
  city: CityIdSchema,
  /** Who received this copy. */
  recipient: PlayerIdSchema.nullable(),
  /** The ruleset's report, as that recipient got it. */
  data: JsonObjectSchema,
  /** The other recipients' copies of the same battle. */
  copies: z.array(ReportIdSchema),
});
export type ReportDetail = z.infer<typeof ReportDetailSchema>;

export const HealthSchema = z.strictObject({
  ok: z.boolean(),
  version: z.string(),
  format: z.literal(SPECTATOR_FORMAT),
  uptimeS: Int,
  folding: Int,
});
export type Health = z.infer<typeof HealthSchema>;

/** Errors are data: what is wrong and how to fix it. */
export const ApiErrorSchema = z.strictObject({
  ok: z.literal(false),
  code: z.string(),
  message: z.string(),
  hint: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// WebSocket (`/api/live`, one match per socket) -------------------------------------------------

export const ClientMsgSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("subscribe"),
    match: MatchIdSchema,
    timeline: TimelineIdSchema,
    /** The client's cursor: the last line it holds. */
    after: SeqSchema,
  }),
  z.strictObject({ type: z.literal("ping"), n: Int }),
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

export const ServerMsgSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("hello"), format: z.literal(SPECTATOR_FORMAT) }),
  z.strictObject({
    type: z.literal("steps"),
    match: MatchIdSchema,
    timeline: TimelineIdSchema,
    /** Every step with `from < seq ≤ to`. */
    from: SeqSchema,
    to: SeqSchema,
    steps: z.array(StepSchema),
  }),
  z.strictObject({
    type: z.literal("status"),
    match: MatchIdSchema,
    status: MatchStatusSchema,
    reason: PublicReasonSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal("clock"),
    match: MatchIdSchema,
    t: GameTimeSchema,
    speed: z.tuple([z.int().positive(), z.int().positive()]).nullable(),
    cap: GameTimeSchema,
  }),
  z.strictObject({
    type: z.literal("annot"),
    match: MatchIdSchema,
    seat: PlayerIdSchema,
    turn: Int,
    round: Int,
    reasoning: z.array(z.string()),
    text: z.array(z.string()),
    calls: z.array(z.string()),
    complete: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("resync"),
    match: MatchIdSchema,
    reason: z.enum(["gap", "log_replaced", "timeline", "backpressure"]),
  }),
  z.strictObject({ type: z.literal("error"), code: z.string(), message: z.string() }),
  z.strictObject({ type: z.literal("pong"), n: Int }),
]);
export type ServerMsg = z.infer<typeof ServerMsgSchema>;
