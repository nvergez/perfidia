import { EFFORTS } from "../model/adapter.ts";
import { PlayerIdSchema, z } from "@perfidia/protocol";

// The run-directory formats of the orchestrator (phase-2 design §5.1, §6): one line per API
// attempt in `llm_calls.jsonl`, plus hand-off, pause and wake-cap lines; `seats.json`. They live
// here, not in protocol, until phase 3 (the server and the web app) reads them: the formats will
// change after calibration. Every line is validated before it is written.

const Int = z.int().nonnegative();
const Nano = z.int().nonnegative();

export const TokenUsageSchema = z.strictObject({
  input: Int,
  cacheWrite5m: Int,
  cacheWrite1h: Int,
  cacheRead: Int,
  output: Int,
});

export const UsageLineSchema = z.strictObject({
  model: z.string().min(1),
  kind: z.enum(["message", "fallback"]),
  input: Int,
  cacheWrite5m: Int,
  cacheWrite1h: Int,
  cacheRead: Int,
  output: Int,
  estimated: z.boolean(),
});
export type UsageLine = z.infer<typeof UsageLineSchema>;

export const StopSchema = z.enum([
  "end_turn",
  "tool_use",
  "max_tokens",
  "refusal",
  "pause",
  "other",
  "error",
]);

export const LlmCallLineSchema = z.strictObject({
  k: z.literal("llm_call"),
  seat: PlayerIdSchema,
  turn: Int,
  round: Int,
  /** Harness attempts of this round (every HTTP attempt has its own line: the SDK never retries). */
  attempt: z.int().positive(),
  /** `thought_call`: the out-of-band thought call (§3.5). */
  kind: z.enum(["round", "thought_call"]),
  /** The game time the request was built on: `briefing.t` in round 0, else the latest result's `t`. */
  t: Int,
  /** Wall fields: informational, left out of determinism comparisons. */
  wallStart: z.string().optional(),
  latencyMs: Int,
  ttftMs: Int.nullable(),
  provider: z.string().min(1),
  model: z.string().min(1),
  servedBy: z.string().nullable(),
  effort: z.enum(EFFORTS),
  maxTokens: z.int().positive(),
  stop: StopSchema,
  rawStop: z.string().nullable(),
  refusal: z
    .strictObject({
      category: z.string().nullable(),
      explanation: z.string().nullable(),
      recommendedModel: z.string().nullable(),
    })
    .nullable(),
  fallback: z.boolean(),
  /** The cache read fell clearly below the previous request's prompt of the same turn (§2.5). */
  cacheMiss: z.boolean(),
  usage: z.array(UsageLineSchema),
  costNanoUsd: Nano,
  seatSpentNanoUsd: Nano,
  capNanoUsd: Nano,
  wakeSpentNanoUsd: Nano,
  /** Served models without a price, charged at the highest rates. */
  unpriced: z.array(z.string()),
  calls: Int,
  textChars: Int,
  reasoningChars: Int,
  requestId: z.string().nullable(),
  error: z
    .strictObject({ kind: z.string().min(1), status: z.int().nullable(), message: z.string() })
    .nullable(),
});
export type LlmCallLine = z.infer<typeof LlmCallLineSchema>;

export const HandoffLineSchema = z.strictObject({
  k: z.literal("handoff"),
  seat: PlayerIdSchema,
  t: Int,
  reason: z.literal("cap"),
  label: z.string().min(1),
  spentNanoUsd: Nano,
  capNanoUsd: Nano,
});
export type HandoffLine = z.infer<typeof HandoffLineSchema>;

export const PauseLineSchema = z.strictObject({
  k: z.literal("pause"),
  wallStart: z.string(),
  wallEnd: z.string().nullable(),
  reason: z.string().min(1),
  seat: PlayerIdSchema.nullable(),
  model: z.string().nullable(),
  outcome: z.enum(["resumed", "aborted"]),
  pausedMs: Int,
});
export type PauseLine = z.infer<typeof PauseLineSchema>;

export const WakeCapLineSchema = z.strictObject({
  k: z.literal("wake_cap"),
  seat: PlayerIdSchema,
  turn: Int,
  round: Int,
  t: Int,
  wakeSpentNanoUsd: Nano,
  wakeCapNanoUsd: Nano,
});
export type WakeCapLine = z.infer<typeof WakeCapLineSchema>;

export const LlmLogLineSchema = z.discriminatedUnion("k", [
  LlmCallLineSchema,
  HandoffLineSchema,
  PauseLineSchema,
  WakeCapLineSchema,
]);
export type LlmLogLine = z.infer<typeof LlmLogLineSchema>;

export const ProfileSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.int().positive(),
  name: z.string().min(1),
  goal: z.string().min(1),
  temperament: z.string().min(1),
  word: z.string().min(1),
  style: z.string().min(1),
  handoffBot: z.string().min(1),
});

export const SeatsFileSchema = z.strictObject({
  harness: z.string().min(1),
  promptVersion: z.int().positive(),
  prompts: z.strictObject({
    shared: z.string(),
    operator: z.string(),
    tools: z.string(),
  }),
  seats: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        seat: PlayerIdSchema,
        kind: z.literal("bot"),
        label: z.string().min(1),
      }),
      z.strictObject({
        seat: PlayerIdSchema,
        kind: z.literal("llm"),
        label: z.string().min(1),
        provider: z.string().min(1),
        model: z.string().min(1),
        effort: z.enum(EFFORTS),
        maxTokens: z.int().positive(),
        capNanoUsd: Nano,
        profile: ProfileSchema,
        handoffBot: z.string().min(1),
        /** sha256 of the seat block. */
        prompt: z.string(),
      }),
    ]),
  ),
});
export type SeatsFile = z.infer<typeof SeatsFileSchema>;
