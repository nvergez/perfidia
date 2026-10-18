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
  /** A refusal: the ids of the turn's inbox messages (a refusal-DoS suspect, §3.8). */
  inbox: z.array(z.string()).optional(),
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

// `arena.json` (phase-2 design §6): the arena's report of a run, rewritten at each status change
// and at the end; rebuildable from `match.jsonl`, `llm_calls.jsonl` and `seats.json`.

export const ARENA_REPORT_FORMAT = "perfidia-arena/1";

export const ArenaStatusSchema = z.enum([
  "running",
  "paused",
  "ended",
  /** `--stop-after`: the run stopped at a day boundary, the match unfinished by design. */
  "stopped",
  /** Ended or stopped, but too many LLM turns closed by an error (`DEGRADED_ERROR_PCT`). */
  "degraded",
  "fatal",
  "aborted",
  "incomplete",
]);
export type ArenaStatus = z.infer<typeof ArenaStatusSchema>;

const Count = z.record(z.string(), Int);
const CostByKind = z.strictObject({
  input: Nano,
  cacheWrite5m: Nano,
  cacheWrite1h: Nano,
  cacheRead: Nano,
  output: Nano,
});
const Percentiles = z.strictObject({ turns: Int, p50: Int, p95: Int, max: Int });
const Estimate = z.strictObject({ low: Nano, central: Nano, high: Nano });

export const ArenaSeatReportSchema = z.strictObject({
  seat: PlayerIdSchema,
  /** The LLM label the seat started with (empty before the header is written). */
  label: z.string(),
  /** `llm:… → bot:turtle@3 at D5 06:00` with a hand-off. */
  controllers: z.string(),
  profile: z.string(),
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  effort: z.enum(EFFORTS),
  capNanoUsd: Nano,
  costNanoUsd: Nano,
  costByKind: CostByKind,
  tokens: TokenUsageSchema,
  /** `llm_call` lines (every HTTP attempt), thought calls included. */
  attempts: Int,
  stops: Count,
  errors: Count,
  /** Refused replies by `stop_details.category` (`uncategorised` for null). */
  refusals: Count,
  /** Attempts a fallback model served. */
  fallbacks: Int,
  servedBy: Count,
  cacheMisses: Int,
  wakeCaps: Int,
  unpriced: z.array(z.string()),
  /** Turns played while the seat was an LLM, and those with a public thought, by end reason. */
  thoughts: z.strictObject({
    turns: Int,
    withThought: Int,
    byWhy: z.record(z.string(), z.strictObject({ turns: Int, withThought: Int })),
  }),
  /** Think time per turn: the sum of its attempts' latencies (ms), backoff and pauses excluded. */
  thinkMs: Percentiles,
  /** Gateway and engine rejections of the seat's LLM turns, by code, and the calls they come from. */
  rejections: Count,
  calls: Int,
  handoff: z
    .strictObject({ t: Int, time: z.string(), label: z.string(), spentNanoUsd: Nano })
    .nullable(),
  estimate: Estimate,
  projectedNanoUsd: Nano,
});
export type ArenaSeatReport = z.infer<typeof ArenaSeatReportSchema>;

export const ExitEventSchema = z.strictObject({
  t: Int,
  time: z.string(),
  type: z.enum(["alliance_formed", "betrayal"]),
  /** `alliance_formed`: the members; `betrayal`: the betrayer then the victim. */
  seats: z.array(PlayerIdSchema),
  relation: z.string().nullable(),
  /** The seats among them that an LLM played at that time. */
  llm: z.array(PlayerIdSchema),
});

export const ExitCriterionSchema = z.strictObject({
  alliancesFormed: Int,
  betrayals: Int,
  /** At least one alliance formed and one betrayal, by anyone. */
  met: z.boolean(),
  llm: z.strictObject({
    /** Alliances with an LLM seat among their founding members. */
    alliances: Int,
    asBetrayer: Int,
    asVictim: Int,
    /** Betrayals with an LLM seat as betrayer or victim. */
    betrayals: Int,
    /** At least one alliance formed and one betrayal with an LLM seat as betrayer or victim. */
    met: z.boolean(),
  }),
  events: z.array(ExitEventSchema),
});
export type ExitCriterion = z.infer<typeof ExitCriterionSchema>;

export const ArenaReportSchema = z.strictObject({
  format: z.literal(ARENA_REPORT_FORMAT),
  status: ArenaStatusSchema,
  /** Why the run stopped early (an abort, a fatal line, a crash, `--stop-after`) or is degraded. */
  reason: z.string().nullable(),
  fake: z.boolean(),
  ruleset: z.string(),
  seed: z.int().nonnegative(),
  players: Int,
  /** The match length in game days (fractional below a day). */
  days: z.number().nonnegative(),
  clock: z.string(),
  promptVersion: z.int().positive(),
  harness: z.string(),
  /** The last game time of the log, and the match's end (`null` while it runs or after a stop). */
  lastT: Int,
  endedAt: Int.nullable(),
  result: z.strictObject({ reason: z.string(), winners: z.array(PlayerIdSchema) }).nullable(),
  seats: z.array(ArenaSeatReportSchema),
  bots: z.array(z.strictObject({ seat: PlayerIdSchema, controllers: z.string() })),
  totals: z.strictObject({
    costNanoUsd: Nano,
    attempts: Int,
    tokens: TokenUsageSchema,
    /** Cache reads over all prompt tokens, in percent. */
    cacheReadPct: Int,
    /** Attempts a fallback model served, in permille of the attempts. */
    fallbackPermille: Int,
    /** The preflight and every pause-gate probe (each re-runs it). */
    preflightNanoUsd: Nano,
  }),
  estimate: Estimate,
  /** `fromDays`: the game days measured, fractional (a run that stopped within a day). */
  projection: z.strictObject({
    fromDays: z.number().nonnegative(),
    toDays: z.number().nonnegative(),
    costNanoUsd: Nano,
  }),
  /** speed ≤ 3600 / (10 × 1.5 × p95 think time): null without measured think time. */
  recommendedSpeed: z
    .strictObject({
      p95ThinkMs: Int,
      num: z.int().positive(),
      den: z.int().positive(),
      approx: z.number(),
    })
    .nullable(),
  pauses: z.array(PauseLineSchema),
  alerts: z.array(z.string()),
  /** Spend per LLM seat at each game-day boundary (the daily tripwire, §5.3). */
  daily: z.array(
    z.strictObject({
      day: Int,
      seat: PlayerIdSchema,
      dayNanoUsd: Nano,
      spentNanoUsd: Nano,
      projectedNanoUsd: Nano,
    }),
  ),
  /** Messages from LLM seats to bot seats that carry well-formed war tags (§4.4). */
  llmToBotWarCalls: Int,
  levelE: z
    .strictObject({
      ok: z.boolean(),
      actions: Int,
      checkpoints: Int,
      divergence: z.string().nullable(),
    })
    .nullable(),
  exit: ExitCriterionSchema,
});
export type ArenaReport = z.infer<typeof ArenaReportSchema>;
