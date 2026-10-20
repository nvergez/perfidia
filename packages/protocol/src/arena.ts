import { z } from "zod";
import { GameTimeSchema, PlayerIdSchema } from "./ids.ts";
import { JsonSchema } from "./json.ts";

// The run-directory formats of the LLM arena (phase-2 design §5.1, §6; docs/phase2.md §7), read by
// the orchestrator that writes them and by the spectator fold and server (phase 3): one line per
// API attempt in `llm_calls.jsonl`, plus hand-off, pause and wake-cap lines; one line per model
// reply that arrived in `replies.jsonl`; `seats.json`; `arena.json`. They carry no format version
// (`arena.json` aside) and will change after calibration, so readers other than the orchestrator
// parse them leniently. Every line is validated before it is written.
//
// Phase 4 (docs/phase4.md, Pass 1a) widens them additively: hand-off reasons beyond the seat cap;
// `preflight`, `prompt_cap`, `kill_switch`, `operator` and `carry` lines in `llm_calls.jsonl`;
// optional `seats.json` fields; and three new files: `estimate.json` (`perfidia-estimate/1`, the
// prediction stored before turn 1), the lineup file (`perfidia-lineup/1`) and `reconcile.json`
// (`perfidia-reconcile/1`, with its input `perfidia-reconcile-input/1`). `arena.json` becomes
// `perfidia-arena/2` (a `budget` and an `exit4` block); the server reads only its status.

/** Reasoning efforts, as the model spec and `seats.json` name them. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const EffortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof EffortSchema>;

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
  effort: EffortSchema,
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

/**
 * Why a seat was handed to its bot: its own safety cap; the match budget's kill switch; an outage
 * (`--on-outage handoff`, reserved); the operator (SIGINT or SIGTERM once).
 */
export const HANDOFF_REASONS = ["cap", "match_budget", "outage", "operator"] as const;
export const HandoffReasonSchema = z.enum(HANDOFF_REASONS);
export type HandoffReason = z.infer<typeof HandoffReasonSchema>;

export const HandoffLineSchema = z.strictObject({
  k: z.literal("handoff"),
  seat: PlayerIdSchema,
  t: Int,
  reason: HandoffReasonSchema,
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

const ErrorFieldSchema = z
  .strictObject({ kind: z.string().min(1), status: z.int().nullable(), message: z.string() })
  .nullable();

/**
 * One preflight group (one provider/model/effort) at the start of a run (`start`, written once the
 * run directory exists) or as a pause-gate probe (`probe`), failed groups included with what they
 * cost: every dollar a run spends is on a line of `llm_calls.jsonl`.
 */
export const PreflightLineSchema = z.strictObject({
  k: z.literal("preflight"),
  phase: z.enum(["start", "probe"]),
  /** `provider/model/effort` of the group. */
  group: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  /** The routing endpoint (OpenRouter, Pass 1b); null for direct providers. */
  endpoint: z.string().nullable(),
  /** The game time of the check: 0 at the start, the last logged time for a probe. */
  t: Int,
  ok: z.boolean(),
  usage: z.array(UsageLineSchema),
  costNanoUsd: Nano,
  /** The price card the requested model's usage was charged at (null when nothing was billed). */
  priceCard: z.string().nullable(),
  error: ErrorFieldSchema,
  /** Informational, left out of determinism comparisons. */
  wallStart: z.string().optional(),
});
export type PreflightLine = z.infer<typeof PreflightLineSchema>;

/** A turn (or thought call) closed because its estimated prompt exceeded the prompt cap. */
export const PromptCapLineSchema = z.strictObject({
  k: z.literal("prompt_cap"),
  seat: PlayerIdSchema,
  turn: Int,
  round: Int,
  kind: z.enum(["round", "thought_call"]),
  t: Int,
  estimateTokens: Int,
  capTokens: z.int().positive(),
});
export type PromptCapLine = z.infer<typeof PromptCapLineSchema>;

/** The match budget's kill switch fired: no attempt starts after it, every LLM seat is handed off. */
export const KillSwitchLineSchema = z.strictObject({
  k: z.literal("kill_switch"),
  t: Int,
  wall: z.string().optional(),
  spentNanoUsd: Nano,
  killAtNanoUsd: Nano,
  budgetNanoUsd: Nano,
  /** `handoff` (the default) or `abort` (`--on-budget abort`). */
  action: z.enum(["handoff", "abort"]),
});
export type KillSwitchLine = z.infer<typeof KillSwitchLineSchema>;

/** An operator signal: the first hands every LLM seat to its bot, the second aborts the run. */
export const OperatorLineSchema = z.strictObject({
  k: z.literal("operator"),
  signal: z.string().min(1),
  action: z.enum(["handoff", "abort"]),
  t: Int,
  wall: z.string().optional(),
});
export type OperatorLine = z.infer<typeof OperatorLineSchema>;

/**
 * `--budget-carry <dir>`: the logged spend of an earlier (crashed) run of the same match budget,
 * counted toward this run's budget from the start. It sums every cost line of that run, its own
 * carry line included, so a chain of re-runs carries all of it.
 */
export const CarryLineSchema = z.strictObject({
  k: z.literal("carry"),
  /** The carried run directory's name. */
  from: z.string().min(1),
  lines: Int,
  costNanoUsd: Nano,
});
export type CarryLine = z.infer<typeof CarryLineSchema>;

export const LlmLogLineSchema = z.discriminatedUnion("k", [
  LlmCallLineSchema,
  HandoffLineSchema,
  PauseLineSchema,
  WakeCapLineSchema,
  PreflightLineSchema,
  PromptCapLineSchema,
  KillSwitchLineSchema,
  OperatorLineSchema,
  CarryLineSchema,
]);
export type LlmLogLine = z.infer<typeof LlmLogLineSchema>;

/** Characters of reasoning summaries kept per reply in `replies.jsonl`; a longer one is cut with "…". */
export const REPLY_REASONING_MAX_CHARS = 20_000;
/** Characters of text kept per reply in `replies.jsonl`; a longer one is cut with "…". */
export const REPLY_TEXT_MAX_CHARS = 4_000;

/**
 * One model reply that arrived (`replies.jsonl`), written right after the `llm_call` line of the
 * same attempt: the provider-agnostic content of the reply, for spectators only. Refused and
 * truncated replies get no line (the conversation never appends them); `--transcripts off` does not
 * affect it. `reasoning` holds the readable summaries the adapter reports and `text` the text
 * blocks, each list cut to its total limit; `calls` the tool calls as sent.
 */
export const ReplyLineSchema = z.strictObject({
  k: z.literal("reply"),
  seat: PlayerIdSchema,
  turn: Int,
  round: Int,
  attempt: z.int().positive(),
  kind: z.enum(["round", "thought_call"]),
  /** As the `llm_call` line's `t`: the game time the request was built on. */
  t: GameTimeSchema,
  stop: StopSchema,
  reasoning: z.array(z.string()),
  text: z.array(z.string()),
  calls: z.array(z.strictObject({ name: z.string(), args: JsonSchema })),
});
export type ReplyLine = z.infer<typeof ReplyLineSchema>;

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

/** Anthropic server-side refusal fallbacks of a seat: `default` sends them, `off` never does. */
export const FallbacksSchema = z.enum(["default", "off"]);
export type Fallbacks = z.infer<typeof FallbacksSchema>;

export const SeatsFileSchema = z.strictObject({
  harness: z.string().min(1),
  promptVersion: z.int().positive(),
  prompts: z.strictObject({
    shared: z.string(),
    operator: z.string(),
    tools: z.string(),
  }),
  /** Phase 4: the lineup id (`--lineup`), when one was used. */
  lineup: z.string().min(1).optional(),
  /** Phase 4: sha256 of `estimate.json`, written before turn 1. */
  estimateSha256: z.string().optional(),
  /** Phase 4: the prompt cap in tokens. */
  promptCapTokens: z.int().positive().optional(),
  /** Phase 4: the match budget (absent without one). */
  budgetNanoUsd: Nano.optional(),
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
        effort: EffortSchema,
        maxTokens: z.int().positive(),
        capNanoUsd: Nano,
        profile: ProfileSchema,
        handoffBot: z.string().min(1),
        /** sha256 of the seat block. */
        prompt: z.string(),
        /** Phase 4: server-side refusal fallbacks (Anthropic). */
        fallbacks: FallbacksSchema.optional(),
      }),
    ]),
  ),
});
export type SeatsFile = z.infer<typeof SeatsFileSchema>;

// `arena.json` (phase-2 design §6): the arena's report of a run, rewritten at each status change
// and at the end; rebuildable from `match.jsonl`, `llm_calls.jsonl` and `seats.json`.

export const ARENA_REPORT_FORMAT = "perfidia-arena/2";

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
  effort: EffortSchema,
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
    .strictObject({
      t: Int,
      time: z.string(),
      label: z.string(),
      spentNanoUsd: Nano,
      reason: HandoffReasonSchema,
    })
    .nullable(),
  /** Turns and thought calls closed by the prompt cap (phase 4). */
  promptCaps: Int,
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

/** What a run cost against its budget (phase 4, docs/phase4.md): every figure a sum of logged lines. */
export const ArenaBudgetSchema = z.strictObject({
  /** The match budget; null when the run had none (no lineup budget and no `--budget-usd`). */
  budgetNanoUsd: Nano.nullable(),
  /** Σ attempt bounds + one probe + the start preflight (`estimate.json`). */
  reserveNanoUsd: Nano,
  /** The kill threshold `budget − reserve`; null without a budget. */
  killAtNanoUsd: Nano.nullable(),
  /** Spend carried from an earlier run (`--budget-carry`). */
  carryNanoUsd: Nano,
  onBudget: z.enum(["handoff", "abort"]),
  /** The prediction stored before turn 1. */
  estimate: z
    .strictObject({
      sha256: z.string(),
      low: Nano,
      central: Nano,
      high: Nano,
      source: z.string(),
    })
    .nullable(),
  /** This run's own spend: attempts + start preflight + probes (carry excluded). */
  actualNanoUsd: Nano,
  attemptsNanoUsd: Nano,
  preflightNanoUsd: Nano,
  probeNanoUsd: Nano,
  /** Lines charged from an estimate (a broken or aborted stream), included in the above. */
  estimatedNanoUsd: Nano,
  /** Platform fees charged apart (OpenRouter, Pass 1b); 0 on direct providers. */
  feesNanoUsd: Nano,
  /** actual + carry ≤ budget; null without a budget. */
  under: z.boolean().nullable(),
  /** low ≤ actual ≤ high of the stored estimate; null without one. */
  withinPrediction: z.boolean().nullable(),
  killSwitch: z
    .strictObject({ fired: z.boolean(), t: Int, wall: z.string().nullable(), spentNanoUsd: Nano })
    .nullable(),
  /** The run's wall window (reconciliation reads usage pages over it). */
  wall: z.strictObject({ start: z.string().nullable(), end: z.string().nullable() }),
  byProvider: z.array(
    z.strictObject({
      provider: z.string(),
      endpoint: z.string().nullable(),
      attempts: Int,
      nanoUsd: Nano,
      reportedNanoUsd: Nano.nullable(),
      estimatedNanoUsd: Nano,
    }),
  ),
});
export type ArenaBudget = z.infer<typeof ArenaBudgetSchema>;

/**
 * Roadmap step 4's exit criterion ("cost per match is known and under the set budget"), §5.1 of
 * the phase-4 design: a lockstep match that ended, with several served models, its prediction
 * stored before turn 1, no hand-off of any reason, its cost inside the prediction and under the
 * budget, Level E, and the provider usage reconciled (`arena reconcile`; null until then).
 */
export const Exit4Schema = z.strictObject({
  /** Distinct models that served the LLM seats' attempts. */
  models: Int,
  ended: z.boolean(),
  estimateStored: z.boolean(),
  noHandoff: z.boolean(),
  withinPrediction: z.boolean(),
  under: z.boolean(),
  levelE: z.boolean(),
  reconciled: z.boolean().nullable(),
  met: z.boolean(),
});
export type Exit4 = z.infer<typeof Exit4Schema>;

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
    /** The preflight and every pause-gate probe (each re-runs it); included in `costNanoUsd`. */
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
  budget: ArenaBudgetSchema,
  exit4: Exit4Schema,
});
export type ArenaReport = z.infer<typeof ArenaReportSchema>;

// `estimate.json` (phase 4, §5.1 and §5.3): the prediction of a run, written once before turn 1;
// its sha256 is in `seats.json`. Integer nano-dollars; no wall time, so `--fake` runs stay
// byte-identical.

export const ESTIMATE_FORMAT = "perfidia-estimate/1";

/** Where a prediction comes from, best first: profiles (≥ 3 seat-days), 1–2 seat-days, the scenario. */
export const PredictionSourceSchema = z.enum(["calibrated", "measured-point", "scenario"]);
export type PredictionSource = z.infer<typeof PredictionSourceSchema>;

export const EstimateFileSchema = z.strictObject({
  format: z.literal(ESTIMATE_FORMAT),
  lineup: z.string().nullable(),
  ruleset: z.string().min(1),
  players: z.int().positive(),
  /** The match length the agents are told, and the game days the run plays (`--stop-after`). */
  matchDays: z.number().positive(),
  days: z.number().positive(),
  clock: z.enum(["lockstep", "realtime"]),
  cacheTtl: z.enum(["5m", "1h"]),
  maxTokens: z.int().positive(),
  promptCapTokens: z.int().positive(),
  seats: z.array(
    z.strictObject({
      seat: PlayerIdSchema,
      provider: z.string().min(1),
      model: z.string().min(1),
      effort: EffortSchema,
      fallbacks: FallbacksSchema,
      profile: z.string().min(1),
      capNanoUsd: Nano,
      wakeCapNanoUsd: Nano.nullable(),
      low: Nano,
      central: Nano,
      high: Nano,
      source: PredictionSourceSchema,
      /** The price cards the seat can be billed at. */
      priceCards: z.array(z.string().min(1)),
      /** The most one attempt of the seat can cost (prompt cap, retry limit, highest prices). */
      attemptBoundNanoUsd: Nano,
    }),
  ),
  match: z.strictObject({ low: Nano, central: Nano, high: Nano, source: PredictionSourceSchema }),
  reserve: z.strictObject({
    attemptBoundsNanoUsd: Nano,
    probeBoundNanoUsd: Nano,
    startPreflightBoundNanoUsd: Nano,
    reserveNanoUsd: Nano,
  }),
  budget: z
    .strictObject({
      budgetNanoUsd: Nano,
      killAtNanoUsd: Nano,
      carryNanoUsd: Nano,
      onBudget: z.enum(["handoff", "abort"]),
    })
    .nullable(),
  /** The assumptions of a scenario prediction, in words. */
  assumptions: z.array(z.string()),
});
export type EstimateFile = z.infer<typeof EstimateFileSchema>;

// The lineup file (`perfidia-lineup/1`, phase 4 §4.1): who plays which seat, with the lineup-wide
// limits and the budget. Amounts in USD are strings, parsed exactly. Pass 1a plans `anthropic`
// seats only; the other providers arrive with their adapters.

export const LINEUP_FORMAT = "perfidia-lineup/1";
export const LINEUP_PROVIDERS = ["anthropic", "openai", "google", "openrouter", "compat"] as const;
const UsdText = z.string().regex(/^[0-9]{1,9}(?:\.[0-9]{1,9})?$/);

export const LineupSeatSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    seat: PlayerIdSchema,
    kind: z.literal("llm"),
    provider: z.enum(LINEUP_PROVIDERS),
    model: z.string().min(1),
    endpoint: z.string().min(1).optional(),
    effort: EffortSchema.optional(),
    profile: z.string().regex(/^[a-z][a-z0-9-]*@[1-9][0-9]*$/),
    capUsd: UsdText.optional(),
    wakeCapUsd: UsdText.optional(),
    handoffBot: z.string().min(1).optional(),
    fallbacks: FallbacksSchema.optional(),
  }),
  z.strictObject({
    seat: PlayerIdSchema,
    kind: z.literal("bot"),
    label: z.string().regex(/^bot:[a-z][a-z0-9-]*(?:@[1-9][0-9]*)?$/),
  }),
]);
export type LineupSeat = z.infer<typeof LineupSeatSchema>;

export const LineupSchema = z.strictObject({
  format: z.literal(LINEUP_FORMAT),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  /** A comparison lineup (one seat per model); repeated models are a warning there. */
  comparison: z.boolean(),
  budgetUsd: UsdText,
  maxTokens: z.int().positive(),
  attemptTimeoutMin: z.int().positive(),
  promptCapTokens: z.int().positive(),
  reminders: z.enum(["every-round", "last-round"]),
  defaults: z.strictObject({
    effort: EffortSchema.optional(),
    fallbacks: FallbacksSchema.optional(),
    zdr: z.boolean().optional(),
  }),
  seats: z.array(LineupSeatSchema).min(1),
});
export type Lineup = z.infer<typeof LineupSchema>;

// Reconciliation (phase 4 §5.6): the provider usage pages' figures for the run's wall window, and
// the check against the ledger (`arena reconcile`).

export const RECONCILE_INPUT_FORMAT = "perfidia-reconcile-input/1";

export const ReconcileInputSchema = z.strictObject({
  format: z.literal(RECONCILE_INPUT_FORMAT),
  providers: z
    .array(
      z.strictObject({
        provider: z.string().min(1),
        /** Pre-tax usage cost of the run's wall window, platform fees excluded. */
        usd: UsdText,
        /** Platform fees and taxes, reported apart and left out of the comparison. */
        feesUsd: UsdText.optional(),
        /** Where the figures were read (a dedicated workspace, project or key). */
        source: z.string().optional(),
        /** Token counts per model, where the usage page shows them. */
        tokens: z
          .array(
            z.strictObject({
              model: z.string().min(1),
              input: Int.optional(),
              cacheWrite: Int.optional(),
              cacheRead: Int.optional(),
              output: Int.optional(),
            }),
          )
          .optional(),
      }),
    )
    .min(1),
});
export type ReconcileInput = z.infer<typeof ReconcileInputSchema>;

export const RECONCILE_FORMAT = "perfidia-reconcile/1";

export const ReconcileFileSchema = z.strictObject({
  format: z.literal(RECONCILE_FORMAT),
  wall: z.strictObject({ start: z.string().nullable(), end: z.string().nullable() }),
  /** Hours from the run's wall end to the check; null when the wall times are virtual. */
  hoursAfterEnd: z.number().nullable(),
  /** Checked less than 48 hours after the run: usage pages may not be complete yet. */
  early: z.boolean(),
  providers: z.array(
    z.strictObject({
      provider: z.string().min(1),
      ledgerNanoUsd: Nano,
      /** The conservative part of estimated (broken-stream) lines: their output. */
      estimatedExcessNanoUsd: Nano,
      reportedNanoUsd: Nano,
      feesNanoUsd: Nano,
      /** max(3% of the ledger, $0.25). */
      toleranceNanoUsd: Nano,
      lowNanoUsd: Nano,
      highNanoUsd: Nano,
      usdOk: z.boolean(),
      tokens: z.array(
        z.strictObject({
          model: z.string().min(1),
          kind: z.enum(["input", "cacheWrite", "cacheRead", "output"]),
          ledger: Int,
          reported: Int,
          ok: z.boolean(),
        }),
      ),
      /** Token counts within ±2% per model; null when the input gave none. */
      tokensOk: z.boolean().nullable(),
      ok: z.boolean(),
    }),
  ),
  ok: z.boolean(),
});
export type ReconcileFile = z.infer<typeof ReconcileFileSchema>;
