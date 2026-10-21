import { z } from "zod";
import {
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
  QueueItemIdSchema,
  ReportIdSchema,
  TimePairSchema,
  UnitIdSchema,
} from "./ids.ts";
import { JsonObjectSchema } from "./json.ts";
import { ResSchema, UnitCountsSchema } from "./resources.ts";
import { ErrorCodeSchema, ViolationDetailsSchema } from "./violations.ts";
import {
  ArchiveEntrySchema,
  ArchiveHitSchema,
  CityViewSchema,
  IslandViewSchema,
  LeaderboardViewSchema,
  MapViewSchema,
  PlayerViewSchema,
  RulesInfoSchema,
} from "./views.ts";

// The agent tools (§8.3): exactly the brief's 22 names, the same names and argument shapes in every
// ruleset. Every argument schema is one strict `z.object`, so `z.toJSONSchema` gives a root
// `type: "object"` with no root `anyOf`, `oneOf` or `allOf` (§3.7); refinements check modes that
// exclude each other and do not show in the JSON Schema. A schema changes only by adding optional
// fields (the evolution rule of §3.7).

/** The brief's 22 tools, in the brief's order. */
export const TOOL_NAMES = [
  "view_city",
  "view_island",
  "view_map",
  "view_player",
  "leaderboard",
  "rules",
  "build",
  "recruit",
  "cancel_queue",
  "send_resources",
  "attack",
  "support",
  "spy",
  "recall_troops",
  "found_city",
  "send_message",
  "propose_alliance",
  "answer_proposal",
  "leave_alliance",
  "write_note",
  "read_notes",
  "end_turn",
] as const;
export const ToolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolNameSchema>;

export type ToolFamily = "observe" | "economy" | "military" | "diplomacy" | "memory" | "turn";
/** `read`: views, no engine action; `engine`: becomes engine actions; `gateway`: gateway state only. */
export type ToolKind = "read" | "engine" | "gateway";

/** Family and kind of each tool (§8.3). */
export const TOOL_INFO = {
  view_city: { family: "observe", kind: "read" },
  view_island: { family: "observe", kind: "read" },
  view_map: { family: "observe", kind: "read" },
  view_player: { family: "observe", kind: "read" },
  leaderboard: { family: "observe", kind: "read" },
  rules: { family: "observe", kind: "read" },
  build: { family: "economy", kind: "engine" },
  recruit: { family: "economy", kind: "engine" },
  cancel_queue: { family: "economy", kind: "engine" },
  send_resources: { family: "economy", kind: "engine" },
  attack: { family: "military", kind: "engine" },
  support: { family: "military", kind: "engine" },
  spy: { family: "military", kind: "engine" },
  recall_troops: { family: "military", kind: "engine" },
  found_city: { family: "military", kind: "engine" },
  send_message: { family: "diplomacy", kind: "engine" },
  propose_alliance: { family: "diplomacy", kind: "engine" },
  answer_proposal: { family: "diplomacy", kind: "engine" },
  leave_alliance: { family: "diplomacy", kind: "engine" },
  write_note: { family: "memory", kind: "gateway" },
  read_notes: { family: "memory", kind: "read" },
  end_turn: { family: "turn", kind: "gateway" },
} as const satisfies Readonly<Record<ToolName, { family: ToolFamily; kind: ToolKind }>>;

/** `read_notes` returns at most this many search hits. */
export const READ_NOTES_MAX_HITS = 20;
/** A `recruit` call carries at most this many orders. */
export const RECRUIT_MAX_ORDERS = 5;

// Argument schemas.

export const ViewCityArgsSchema = z.strictObject({ city: CityIdSchema });
export const ViewIslandArgsSchema = z.strictObject({ island: IslandIdSchema });
export const ViewMapArgsSchema = z.strictObject({ fromCity: CityIdSchema.optional() });
export const ViewPlayerArgsSchema = z.strictObject({ player: PlayerIdSchema });
export const LeaderboardArgsSchema = z.strictObject({});
export const RulesArgsSchema = z.strictObject({});

/** One engine `build` action per building, applied in order (not atomic, §7.4); the queue max comes from the rules. */
export const BuildArgsSchema = z.strictObject({
  city: CityIdSchema,
  buildings: z.array(BuildingIdSchema).min(1),
});

/** `"max"`: the largest count possible when this order is applied, after the earlier orders (§7.4). */
export const RecruitOrderSchema = z.strictObject({
  unit: UnitIdSchema,
  count: z.union([z.int().positive(), z.literal("max")]),
});
export const RecruitArgsSchema = z.strictObject({
  city: CityIdSchema,
  orders: z.array(RecruitOrderSchema).min(1).max(RECRUIT_MAX_ORDERS),
});

/** Cancels queue item `#item` and every later item of its queue. */
export const CancelQueueArgsSchema = z.strictObject({
  city: CityIdSchema,
  item: QueueItemIdSchema,
});

const Amount = z.int().nonnegative();
export const SendResourcesArgsSchema = z.strictObject({
  from: CityIdSchema,
  to: CityIdSchema,
  wood: Amount.optional(),
  stone: Amount.optional(),
  gold: Amount.optional(),
});

export const AttackArgsSchema = z.strictObject({
  from: CityIdSchema,
  to: CityIdSchema,
  units: UnitCountsSchema,
});
export const SupportArgsSchema = z.strictObject({
  from: CityIdSchema,
  to: CityIdSchema,
  units: UnitCountsSchema,
});
export const SpyArgsSchema = z.strictObject({ from: CityIdSchema, to: CityIdSchema, gold: Amount });

/**
 * Exactly one mode per call (§7.4): `{movement}` recalls a movement in its window;
 * `{stationedAt, home?, units?}` recalls stationed units (all of them, a home's group, or part of
 * it); `{dismiss: {city, player}}` sends a player's group in your city home.
 */
export const RecallTroopsArgsSchema = z
  .strictObject({
    movement: MovementIdSchema.optional(),
    stationedAt: CityIdSchema.optional(),
    home: CityIdSchema.optional(),
    units: UnitCountsSchema.optional(),
    dismiss: z.strictObject({ city: CityIdSchema, player: PlayerIdSchema }).optional(),
  })
  .superRefine((args, ctx) => {
    const modes = (["movement", "stationedAt", "dismiss"] as const).filter(
      (mode) => args[mode] !== undefined,
    );
    if (modes.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message:
          modes.length === 0
            ? "name exactly one mode: movement, stationedAt or dismiss"
            : `name exactly one mode, not ${modes.join(" and ")}`,
      });
    }
    if (args.stationedAt === undefined) {
      for (const key of ["home", "units"] as const) {
        if (args[key] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} applies to stationed units only: add stationedAt`,
          });
        }
      }
    }
  });

/** `slot` needs `toolOptions.foundSlot`; otherwise the lowest free slot is used. */
export const FoundCityArgsSchema = z.strictObject({
  from: CityIdSchema,
  island: IslandIdSchema,
  units: UnitCountsSchema,
  slot: z.int().nonnegative().optional(),
});

/** A list of players is private; `"all"` is public and wakes nobody. */
export const SendMessageArgsSchema = z.strictObject({
  to: z.union([z.array(PlayerIdSchema).min(1), z.literal("all")]),
  text: z.string(),
});

/** `until` needs `toolOptions.pactUntil`. */
export const ProposeAllianceArgsSchema = z.strictObject({
  to: PlayerIdSchema,
  kind: z.enum(["alliance", "pact"]),
  name: AuthoredNameSchema.optional(),
  text: z.string().optional(),
  until: GameTimeSchema.optional(),
});

export const AnswerProposalArgsSchema = z.strictObject({
  id: ProposalIdSchema,
  accept: z.boolean(),
});

/** Without `with`: leave your alliance. With a pact partner: end that pact; with an ally: leave the alliance. */
export const LeaveAllianceArgsSchema = z.strictObject({ with: PlayerIdSchema.optional() });

export const WriteNoteArgsSchema = z.strictObject({
  text: z.string(),
  mode: z.enum(["append", "replace"]),
});

/**
 * Without arguments: your notes. `search` looks through your archive (`mine`), the public feed
 * (`public`) or both (`all`, the default); `open` returns one full message or report.
 */
export const ReadNotesArgsSchema = z.strictObject({
  search: z
    .strictObject({
      scope: z.enum(["mine", "public", "all"]).optional(),
      /** Case-insensitive substring (ASCII folding) of message text and event summaries. */
      text: z.string().optional(),
      /** Event types. */
      kinds: z.array(EventTypeSchema).optional(),
      /** Counterpart player. */
      with: PlayerIdSchema.optional(),
      since: GameTimeSchema.optional(),
      until: GameTimeSchema.optional(),
      /**
       * Only entries numbered below this `e` (the number every hit shows): older ones. With `more`,
       * pass the last hit's `e` to read the next page.
       */
      before: z.int().positive().optional(),
      limit: z.int().min(1).max(READ_NOTES_MAX_HITS).optional(),
    })
    .optional(),
  open: z.union([MessageIdSchema, ReportIdSchema]).optional(),
});

/**
 * Ends the turn. At most one of `nextWakeIn` (seconds ahead) and `wakeAt` (absolute game time);
 * the time is clamped into the self-wake range. `{}` keeps any pending self-wake (§8.3).
 */
export const EndTurnArgsSchema = z
  .strictObject({
    nextWakeIn: z.int().nonnegative().optional(),
    wakeAt: GameTimeSchema.optional(),
  })
  .superRefine((args, ctx) => {
    if (args.nextWakeIn !== undefined && args.wakeAt !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: "give nextWakeIn or wakeAt, not both (the turn did not end)",
      });
    }
  });

/** The argument schema of every tool. */
export const TOOL_ARGS = {
  view_city: ViewCityArgsSchema,
  view_island: ViewIslandArgsSchema,
  view_map: ViewMapArgsSchema,
  view_player: ViewPlayerArgsSchema,
  leaderboard: LeaderboardArgsSchema,
  rules: RulesArgsSchema,
  build: BuildArgsSchema,
  recruit: RecruitArgsSchema,
  cancel_queue: CancelQueueArgsSchema,
  send_resources: SendResourcesArgsSchema,
  attack: AttackArgsSchema,
  support: SupportArgsSchema,
  spy: SpyArgsSchema,
  recall_troops: RecallTroopsArgsSchema,
  found_city: FoundCityArgsSchema,
  send_message: SendMessageArgsSchema,
  propose_alliance: ProposeAllianceArgsSchema,
  answer_proposal: AnswerProposalArgsSchema,
  leave_alliance: LeaveAllianceArgsSchema,
  write_note: WriteNoteArgsSchema,
  read_notes: ReadNotesArgsSchema,
  end_turn: EndTurnArgsSchema,
} as const satisfies Readonly<Record<ToolName, z.ZodType>>;
export type ToolArgs<T extends ToolName> = z.infer<(typeof TOOL_ARGS)[T]>;

// Calls and results.

/** A call as an agent sends it; `args` is validated by the tool's schema (layer 2 of §7.2). */
export const ToolCallSchema = z.strictObject({ tool: z.string(), args: z.unknown() });
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** A caveat on an accepted call, e.g. `WAKE_CLAMPED` or a ruleset warning such as `CAPITAL_IMMUNE`. */
export const ToolWarningSchema = z.strictObject({ code: ErrorCodeSchema, message: z.string() });
export type ToolWarning = z.infer<typeof ToolWarningSchema>;

export const ToolSuccessSchema = z.strictObject({
  ok: z.literal(true),
  /** The game second at which the call was applied. */
  t: GameTimeSchema,
  data: JsonObjectSchema,
  warnings: z.array(ToolWarningSchema).optional(),
});
export type ToolSuccess = z.infer<typeof ToolSuccessSchema>;

/** A rejected call: what is wrong and how to fix it, with numbers (§7.3). */
export const ToolErrorSchema = z.strictObject({
  ok: z.literal(false),
  t: GameTimeSchema,
  code: ErrorCodeSchema,
  message: z.string(),
  hint: z.string(),
  details: ViolationDetailsSchema.optional(),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

export const ToolResultSchema = z.discriminatedUnion("ok", [ToolSuccessSchema, ToolErrorSchema]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

// Result data (`ToolSuccess.data`) by tool: the fields agents and bots rely on. Every success
// carries the useful consequences: ids, queue item numbers, times as pairs, the cost paid (§7.4).
// The schemas are loose objects, so a result may carry more.

/** A failed item of a batch: layers 5–6 rejected it; the others were still attempted. */
export const BatchItemErrorSchema = z.looseObject({
  ok: z.literal(false),
  code: ErrorCodeSchema,
  message: z.string(),
  hint: z.string(),
  details: ViolationDetailsSchema.optional(),
});

export const BuildItemResultSchema = z.discriminatedUnion("ok", [
  z.looseObject({
    ok: z.literal(true),
    item: QueueItemIdSchema,
    building: BuildingIdSchema,
    level: z.int().positive(),
    end: TimePairSchema,
    cost: ResSchema,
  }),
  BatchItemErrorSchema,
]);
export const RecruitItemResultSchema = z.discriminatedUnion("ok", [
  z.looseObject({
    ok: z.literal(true),
    item: QueueItemIdSchema,
    unit: UnitIdSchema,
    /** The resolved count (`"max"` included). */
    count: z.int().positive(),
    end: TimePairSchema,
    cost: ResSchema,
  }),
  BatchItemErrorSchema,
]);

/** A movement launched or turned home, with its arrival. */
const MovementResult = z.looseObject({ movement: MovementIdSchema, arrive: TimePairSchema });

export const TOOL_RESULT_DATA = {
  view_city: CityViewSchema,
  view_island: IslandViewSchema,
  view_map: MapViewSchema,
  view_player: PlayerViewSchema,
  leaderboard: LeaderboardViewSchema,
  rules: RulesInfoSchema,
  build: z.looseObject({ items: z.array(BuildItemResultSchema).min(1) }),
  recruit: z.looseObject({ items: z.array(RecruitItemResultSchema).min(1) }),
  /** `refund`: what was credited to the stock; `lost`: what the storage cap cut from it. */
  cancel_queue: z.looseObject({
    city: CityIdSchema,
    removed: z.array(QueueItemIdSchema).min(1),
    refund: ResSchema,
    lost: ResSchema,
  }),
  send_resources: MovementResult,
  attack: MovementResult,
  support: MovementResult,
  spy: MovementResult,
  /** Each group travels home as its own return. */
  recall_troops: z.looseObject({
    returns: z.array(
      z.looseObject({ movement: MovementIdSchema, home: CityIdSchema, arrive: TimePairSchema }),
    ),
  }),
  found_city: MovementResult,
  send_message: z.looseObject({ message: MessageIdSchema }),
  propose_alliance: z.looseObject({ proposal: ProposalIdSchema, expires: TimePairSchema }),
  answer_proposal: z.looseObject({ proposal: ProposalIdSchema, accept: z.boolean() }),
  leave_alliance: z.looseObject({}),
  write_note: z.looseObject({ chars: z.int().nonnegative(), max: z.int().nonnegative() }),
  /**
   * `notes` (always under presentation 1; under presentation 2 only without `search` and `open`);
   * `hits` for a search (newest first, with `more` when truncated: the next page is the same search
   * with `before` set to the last hit's `e`); `entry` for `open`.
   */
  read_notes: z.looseObject({
    notes: z.string().optional(),
    hits: z.array(ArchiveHitSchema).max(READ_NOTES_MAX_HITS).optional(),
    more: z.boolean().optional(),
    entry: ArchiveEntrySchema.optional(),
  }),
  /** The pending self-wake after the call (`null`: none), and whether the request was clamped. */
  end_turn: z.looseObject({ wakeAt: TimePairSchema.nullable(), clamped: z.boolean() }),
} as const satisfies Readonly<Record<ToolName, z.ZodType>>;
export type ToolResultData<T extends ToolName> = z.infer<(typeof TOOL_RESULT_DATA)[T]>;
