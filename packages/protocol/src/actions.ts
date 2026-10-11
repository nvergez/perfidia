import { z } from "zod";
import {
  AuthoredNameSchema,
  BuildingIdSchema,
  CityIdSchema,
  GameTimeSchema,
  IslandIdSchema,
  MovementIdSchema,
  PlayerIdSchema,
  ProposalIdSchema,
  QueueItemIdSchema,
  UnitIdSchema,
} from "./ids.ts";
import { JsonSchema } from "./json.ts";
import { ResSchema, UnitCountsSchema } from "./resources.ts";

// Engine actions (§7.1): what the gateway submits after layers 1–5 of §7.2, and what `act` log lines
// record. Gameplay limits (text lengths, levels, costs) are the engine's to check, with explanations.

export const BuildActionSchema = z.strictObject({
  type: z.literal("build"),
  city: CityIdSchema,
  building: BuildingIdSchema,
});
export const RecruitActionSchema = z.strictObject({
  type: z.literal("recruit"),
  city: CityIdSchema,
  unit: UnitIdSchema,
  /** The resolved count (a tool's `"max"` is resolved before submission). */
  count: z.int().positive(),
});
/** Cancels that item and every later item of its queue. */
export const CancelQueueActionSchema = z.strictObject({
  type: z.literal("cancel_queue"),
  city: CityIdSchema,
  item: QueueItemIdSchema,
});
export const SendResourcesActionSchema = z.strictObject({
  type: z.literal("send_resources"),
  from: CityIdSchema,
  to: CityIdSchema,
  res: ResSchema,
});
export const AttackActionSchema = z.strictObject({
  type: z.literal("attack"),
  from: CityIdSchema,
  to: CityIdSchema,
  units: UnitCountsSchema,
});
export const SupportActionSchema = z.strictObject({
  type: z.literal("support"),
  from: CityIdSchema,
  to: CityIdSchema,
  units: UnitCountsSchema,
});
export const SpyActionSchema = z.strictObject({
  type: z.literal("spy"),
  from: CityIdSchema,
  to: CityIdSchema,
  gold: z.int().nonnegative(),
});
export const FoundCityActionSchema = z.strictObject({
  type: z.literal("found_city"),
  from: CityIdSchema,
  island: IslandIdSchema,
  units: UnitCountsSchema,
  /** Only with `toolOptions.foundSlot`; otherwise `null`. */
  slot: z.int().nonnegative().nullable(),
});
export const RecallActionSchema = z.strictObject({
  type: z.literal("recall"),
  movement: MovementIdSchema,
});
export const RecallStationedActionSchema = z.strictObject({
  type: z.literal("recall_stationed"),
  at: CityIdSchema,
  /** Names one group when the seat has groups from several homes in `at`. */
  home: CityIdSchema.nullable(),
  /** `null`: the named group whole, or every group of the seat there. */
  units: UnitCountsSchema.nullable(),
});
export const DismissActionSchema = z.strictObject({
  type: z.literal("dismiss"),
  city: CityIdSchema,
  player: PlayerIdSchema,
});
export const SendMessageActionSchema = z.strictObject({
  type: z.literal("send_message"),
  /** A list is private; `"all"` is public. */
  to: z.union([z.array(PlayerIdSchema).min(1), z.literal("all")]),
  text: z.string(),
});
export const ProposeActionSchema = z.strictObject({
  type: z.literal("propose"),
  to: PlayerIdSchema,
  kind: z.enum(["alliance", "pact"]),
  name: AuthoredNameSchema.nullable(),
  text: z.string(),
  /** Only with `toolOptions.pactUntil`; otherwise `null`. */
  until: GameTimeSchema.nullable(),
});
export const AnswerActionSchema = z.strictObject({
  type: z.literal("answer"),
  proposal: ProposalIdSchema,
  accept: z.boolean(),
});
/** `with: null` leaves my alliance; a player ends my relation with them. */
export const LeaveActionSchema = z.strictObject({
  type: z.literal("leave"),
  with: PlayerIdSchema.nullable(),
});
/** A ruleset's write extra tool (§3.7), handled by `hooks.actions.ext`. */
export const ExtActionSchema = z.strictObject({
  type: z.literal("ext"),
  tool: z.string().regex(/^[a-z][a-z0-9_]*$/, { error: "expected a snake_case tool name" }),
  args: JsonSchema,
});

export const ActionSchema = z.discriminatedUnion("type", [
  BuildActionSchema,
  RecruitActionSchema,
  CancelQueueActionSchema,
  SendResourcesActionSchema,
  AttackActionSchema,
  SupportActionSchema,
  SpyActionSchema,
  FoundCityActionSchema,
  RecallActionSchema,
  RecallStationedActionSchema,
  DismissActionSchema,
  SendMessageActionSchema,
  ProposeActionSchema,
  AnswerActionSchema,
  LeaveActionSchema,
  ExtActionSchema,
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionType = Action["type"];
export type ActionOf<T extends ActionType> = Extract<Action, { type: T }>;

/** Every action type, in the order of §7.1. */
export const ACTION_TYPES = [
  "build",
  "recruit",
  "cancel_queue",
  "send_resources",
  "attack",
  "support",
  "spy",
  "found_city",
  "recall",
  "recall_stationed",
  "dismiss",
  "send_message",
  "propose",
  "answer",
  "leave",
  "ext",
] as const satisfies readonly ActionType[];
