import { z } from "zod";
import { ActionSchema } from "./actions.ts";
import { TurnEndSchema, WakeKindSchema, WakeReasonSchema } from "./briefing.ts";
import { DomainEventSchema } from "./events.ts";
import { GameTimeSchema, Hash64Schema, PlayerIdSchema, SemverSchema, Sha256Schema } from "./ids.ts";
import { JsonObjectSchema, JsonSchema } from "./json.ts";
import { ClockSpecSchema, MatchResultSchema, MatchSetupSchema } from "./match.ts";
import { GameStateSchema } from "./state.ts";
import { ErrorCodeSchema, ViolationDetailsSchema } from "./violations.ts";

// The match log (§10.2): one canonical JSON object per line, append-only, in the order the host
// changes state. Keys starting with `wall` are informational (present only when the host has a wall
// source) and excluded from byte-for-byte comparisons. Snapshots (§10.3) are taken at checkpoints.

export const LOG_FORMAT = "perfidia-log/1";
export const SNAPSHOT_FORMAT = "perfidia-snapshot/1";

const Int = z.int().nonnegative();
/** Global sequence over `act`, `gw`, `obs` and `note` lines, from 1, strictly increasing. */
const N = z.int().positive();
/** The seat's turn number, from 1. */
const Turn = z.int().positive();
/** Round index within the turn, from 0. */
const Round = Int;
/** A tool name as the agent sent it (unknown names are logged too). */
const ToolName = z.string();

export const HeaderLineSchema = z.strictObject({
  k: z.literal("header"),
  format: z.literal(LOG_FORMAT),
  /** `ENGINE_VERSION`. */
  engine: SemverSchema,
  /** Ruleset ref, overrides, seed, `idKey`, seats: operator data, never shown to agents. */
  setup: MatchSetupSchema,
  /** The full effective config. */
  config: JsonObjectSchema,
  configHash: Sha256Schema,
  rulesHash: Sha256Schema,
  /** Controller labels at t = 0, e.g. `bot:expander@1`. */
  controllers: z.record(PlayerIdSchema, z.string().min(1)),
  clock: ClockSpecSchema,
  initialHash: Hash64Schema,
  /** ISO wall time at start. */
  wallStart: z.string().optional(),
});

/** A seat's turn opens: its reasons, whether it is urgent, the budget charged and the day's usage after it. */
export const WakeLineSchema = z.strictObject({
  k: z.literal("wake"),
  t: GameTimeSchema,
  seat: PlayerIdSchema,
  turn: Turn,
  reasons: z.array(WakeReasonSchema).min(1),
  urgent: z.boolean(),
  charge: z.enum(["own", "social"]).nullable(),
  /** Game day, `floor(t / 86400)`. */
  day: Int,
  used: z.strictObject({ own: Int, social: Int }),
});

/** The seeded lockstep order of batch `b` at second `t` (§9.2). */
export const BatchLineSchema = z.strictObject({
  k: z.literal("batch"),
  t: GameTimeSchema,
  b: Int,
  order: z.array(PlayerIdSchema),
});

/** The engine's verdict as logged: `ok`, and the code of a rejection. */
export const ActResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: ErrorCodeSchema }),
]);

/** A call that reached the engine, accepted or rejected; replayed at Level E. */
export const ActLineSchema = z.strictObject({
  k: z.literal("act"),
  n: N,
  t: GameTimeSchema,
  seat: PlayerIdSchema,
  turn: Turn,
  rt: Round,
  tool: ToolName,
  /** Item index within an expanded batch (0 for single actions). */
  i: Int,
  /** The resolved action (counts resolved, `"max"` never appears). */
  a: ActionSchema,
  r: ActResultSchema,
});

/** A call rejected by the gateway (layers 1–4 of §7.2, with its details) or an `INTERNAL` failure (with `error`). */
export const GwLineSchema = z.strictObject({
  k: z.literal("gw"),
  n: N,
  t: GameTimeSchema,
  seat: PlayerIdSchema,
  turn: Turn,
  rt: Round,
  tool: ToolName,
  r: z.strictObject({
    ok: z.literal(false),
    code: ErrorCodeSchema,
    details: ViolationDetailsSchema.optional(),
  }),
  error: z.string().optional(),
});

/** A read tool call, for statistics. */
export const ObsLineSchema = z.strictObject({
  k: z.literal("obs"),
  n: N,
  t: GameTimeSchema,
  seat: PlayerIdSchema,
  turn: Turn,
  rt: Round,
  tool: ToolName,
  args: JsonSchema,
  /** Size of the result as sent. */
  bytes: Int,
});

/** An accepted `write_note`; notes are rebuilt from these lines. */
export const NoteLineSchema = z.strictObject({
  k: z.literal("note"),
  n: N,
  t: GameTimeSchema,
  seat: PlayerIdSchema,
  turn: Turn,
  mode: z.enum(["append", "replace"]),
  text: z.string(),
});

/** A turn closes. `selfAt` is the self-wake pending after it; `next` the effective next wake. */
export const TurnLineSchema = z.strictObject({
  k: z.literal("turn"),
  t: GameTimeSchema,
  seat: PlayerIdSchema,
  turn: Turn,
  rounds: Int,
  calls: Int,
  why: TurnEndSchema,
  selfAt: GameTimeSchema.nullable(),
  /** `null` when the seat has no next wake (eliminated, or the match ended). */
  next: z.strictObject({ at: GameTimeSchema, kind: WakeKindSchema }).nullable(),
  /** The agent's last short text: its public thought. */
  thought: z.string().optional(),
  /** The agent error or timeout that closed the turn. */
  error: z.string().optional(),
  /** Wall duration of the turn. */
  wallMs: Int.optional(),
});

/** A seat moved to `to` by the lockstep per-second turn cap. */
export const DeferLineSchema = z.strictObject({
  k: z.literal("defer"),
  t: GameTimeSchema,
  seat: PlayerIdSchema,
  to: GameTimeSchema,
});

/** A seat handed to another controller (§8.7). */
export const ControllerLineSchema = z.strictObject({
  k: z.literal("controller"),
  t: GameTimeSchema,
  seat: PlayerIdSchema,
  label: z.string().min(1),
});

/** An engine event (covered by `evHash`). */
export const EvLineSchema = z.strictObject({
  k: z.literal("ev"),
  t: GameTimeSchema,
  e: DomainEventSchema,
});

/** The state hash at checkpoint `hour` (t = 3600 · hour). */
export const CkptLineSchema = z.strictObject({
  k: z.literal("ckpt"),
  t: GameTimeSchema,
  hour: z.int().positive(),
  h: Hash64Schema,
});

export const EndLineSchema = z.strictObject({
  k: z.literal("end"),
  t: GameTimeSchema,
  h: Hash64Schema,
  result: MatchResultSchema,
});

/** The match aborted: an invariant failure, an engine bug, a driver error or (strict) an agent error. */
export const FatalLineSchema = z.strictObject({
  k: z.literal("fatal"),
  t: GameTimeSchema,
  error: z.strictObject({
    kind: z.enum(["invariant", "engine", "driver", "agent"]),
    message: z.string(),
    details: JsonObjectSchema.optional(),
  }),
});

export const LogLineSchema = z.discriminatedUnion("k", [
  HeaderLineSchema,
  WakeLineSchema,
  BatchLineSchema,
  ActLineSchema,
  GwLineSchema,
  ObsLineSchema,
  NoteLineSchema,
  TurnLineSchema,
  DeferLineSchema,
  ControllerLineSchema,
  EvLineSchema,
  CkptLineSchema,
  EndLineSchema,
  FatalLineSchema,
]);
export type LogLine = z.infer<typeof LogLineSchema>;
export type LogLineKind = LogLine["k"];
export type LogLineOf<K extends LogLineKind> = Extract<LogLine, { k: K }>;
export type HeaderLine = LogLineOf<"header">;
export type WakeLine = LogLineOf<"wake">;
export type BatchLine = LogLineOf<"batch">;
export type ActLine = LogLineOf<"act">;
export type GwLine = LogLineOf<"gw">;
export type ObsLine = LogLineOf<"obs">;
export type NoteLine = LogLineOf<"note">;
export type TurnLine = LogLineOf<"turn">;
export type DeferLine = LogLineOf<"defer">;
export type ControllerLine = LogLineOf<"controller">;
export type EvLine = LogLineOf<"ev">;
export type CkptLine = LogLineOf<"ckpt">;
export type EndLine = LogLineOf<"end">;
export type FatalLine = LogLineOf<"fatal">;

/** Every line kind, in the order of §10.2. */
export const LOG_LINE_KINDS = [
  "header",
  "wake",
  "batch",
  "act",
  "gw",
  "obs",
  "note",
  "turn",
  "defer",
  "controller",
  "ev",
  "ckpt",
  "end",
  "fatal",
] as const satisfies readonly LogLineKind[];

/**
 * Engine state at a checkpoint (§10.3). `hash` equals the `h` of the `ckpt` line of `hour`, and
 * `afterN` is the `n` of the last numbered line written before that `ckpt` line (0 when none). The
 * full `setup` makes a snapshot of a match with overrides load on its own.
 */
export const SnapshotSchema = z.strictObject({
  format: z.literal(SNAPSHOT_FORMAT),
  engine: SemverSchema,
  setup: MatchSetupSchema,
  configHash: Sha256Schema,
  rulesHash: Sha256Schema,
  hour: Int,
  t: GameTimeSchema,
  afterN: Int,
  hash: Hash64Schema,
  state: GameStateSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
