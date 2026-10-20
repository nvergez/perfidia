import { z } from "zod";
import {
  EffortSchema,
  HandoffReasonSchema,
  PromptVariantSchema,
  ReminderCadenceSchema,
} from "./arena.ts";
import { GameTimeSchema, PlayerIdSchema, RulesetRefSchema } from "./ids.ts";
import { safeRecord } from "./json.ts";

// Per-model statistics (phase-4 design §6, docs/phase4.md Pass 3). Three formats:
// - `perfidia-stats/1` (`MatchStatsSchema`): one match, seat by seat: who played it (model, effort,
//   profile, prompt variant), what it did (turns, calls, diplomacy, battles), what went wrong
//   (hand-offs, wake and prompt caps, errors, refusals, tool-call errors), what it cost, and where it
//   finished (the end line's standings). A pure fold of the run directory (`@perfidia/spectator/stats`).
// - `perfidia-model-stats/1` (`ModelStatsFileSchema`): many matches aggregated per model (or profile,
//   prompt variant, model × profile), with MAP Plackett–Luce ratings and their intervals, written by
//   `bun run stats -- aggregate` and served by the spectator server (`ModelsResponseSchema`,
//   `ModelDetailSchema`).
// - The claim state (`ClaimsSchema`): how many rated matches a 70/30 head-to-head claim needs (exact
//   binomial test, 80% power, design §6.4) and how many there are. Below it, outcomes and ratings are
//   withheld (null): no ranking is shown on too few matches.
// Costs, tokens and model time are null when the server runs with `--no-costs`
// (`published.costs: false`). Imported by the web through `@perfidia/protocol/spectator`.

export const MATCH_STATS_FORMAT = "perfidia-stats/1";
export const MODEL_STATS_FORMAT = "perfidia-model-stats/1";

const Int = z.int().nonnegative();
const Permille = z.int().min(0).max(1000);
/** Counts by a label (an error kind, a rejection code, a stop): the harness's or the provider's word. */
const Counts = safeRecord(z.string(), Int);

/** A match id, as `MatchIdSchema` of `./spectator.ts` (a run directory's name). */
const StatsMatchIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/);

/** A match status, as `MATCH_STATUSES` of `./spectator.ts` (a test keeps the two lists equal). */
export const STATS_MATCH_STATUSES = [
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

/** A model aggregate's id: a URL path segment (`anthropic.claude-sonnet-5-5.medium`, `bot.conqueror.3`). */
export const ModelIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,159}$/, {
  error:
    "expected a model id: lowercase letters, digits, '.' and '-', e.g. anthropic.claude-sonnet-5-5.medium",
});
export type ModelId = z.infer<typeof ModelIdSchema>;

/** How seats are grouped into items: by model (default), profile, prompt variant, or model × profile. */
export const STATS_GROUPINGS = ["model", "profile", "variant", "model-profile"] as const;
export const StatsGroupingSchema = z.enum(STATS_GROUPINGS);
export type StatsGrouping = z.infer<typeof StatsGroupingSchema>;

/** The model an LLM seat started on. */
export const StatsModelSchema = z.strictObject({
  /** `anthropic`, `openai`, `google`, `openrouter`, `compat`, or `fake` (a bot behind the LLM pipe). */
  provider: z.string(),
  model: z.string(),
  /** The pinned routing endpoint (OpenRouter), e.g. `z-ai/fp8`. */
  endpoint: z.string().nullable(),
  effort: EffortSchema,
  /** A fake seat's intended provider (whose model it mirrors). */
  intended: z.string().nullable(),
  quantization: z.string().nullable(),
  /** The effort the requests carried when it was not the seat's (OpenRouter's nearest level). */
  effortSent: EffortSchema.nullable(),
});
export type StatsModel = z.infer<typeof StatsModelSchema>;

/**
 * A match of a rotation series (`series.json`): its base lineup, block and index. Never the series'
 * seed: each block's game seed derives from it, and seeds are never served.
 */
export const StatsSeriesRefSchema = z.strictObject({
  lineup: z.string(),
  /** From 0. */
  block: Int,
  /** From 1. */
  index: z.int().positive(),
});
export type StatsSeriesRef = z.infer<typeof StatsSeriesRefSchema>;

const PeerCountsSchema = z.strictObject({ messages: Int, pacts: Int, alliances: Int });
export type PeerCounts = z.infer<typeof PeerCountsSchema>;

const PercentilesSchema = z.strictObject({ n: Int, p50: Int, p95: Int });
export type StatsPercentiles = z.infer<typeof PercentilesSchema>;

const TokensSchema = z.strictObject({
  input: Int,
  cacheWrite5m: Int,
  cacheWrite1h: Int,
  cacheRead: Int,
  output: Int,
  /** Reasoning tokens, a part of `output`, where the provider reports them. */
  reasoning: Int,
});
export type StatsTokens = z.infer<typeof TokensSchema>;

const CostByKindSchema = z.strictObject({
  input: Int,
  cacheWrite5m: Int,
  cacheWrite1h: Int,
  cacheRead: Int,
  output: Int,
});

/** Where a seat finished: the end line's standings (the ruleset's at the last line of a match that did not end). */
const SeatOutcomeSchema = z.strictObject({
  /** 1-based, no shared ranks. */
  rank: z.int().positive(),
  score: z.int(),
  cities: Int,
  alive: z.boolean(),
  eliminatedAt: GameTimeSchema.nullable(),
  /** Among the end line's winners (a winning bloc's members all are). */
  winner: z.boolean(),
});

const SeatPlaySchema = z.strictObject({
  /** Every turn the seat ended, whoever controlled it (the dossier's `counts.turns`). */
  turns: Int,
  /** Turns ended while an LLM controlled the seat: its wakes. The rest below are over these. */
  wakes: Int,
  rounds: Int,
  calls: Int,
  /** Calls the engine accepted, and rejections by code (gateway and engine). */
  accepted: Int,
  rejections: Counts,
  /** Wakes with a public thought, and wakes by how they ended (`end_turn`, `error`, …). */
  thoughts: Int,
  endings: Counts,
});

const SeatDiplomacySchema = z.strictObject({
  messagesSent: Int,
  /** Messages to the seat, or to everyone, from another seat. */
  messagesReceived: Int,
  /** Sent to everyone. */
  publicSent: Int,
  proposalsSent: Int,
  proposalsReceived: Int,
  /** Proposals the seat answered: accepted and refused. */
  accepted: Int,
  refused: Int,
  alliancesFounded: Int,
  alliancesJoined: Int,
  alliancesLeft: Int,
  pactsSigned: Int,
  /** Pacts that expired or were active at the end, with no betrayal by the seat of that partner meanwhile. */
  pactsKept: Int,
  /** Betrayals of a pact partner by the seat (`betrayal` with relation `pact`). */
  pactsBroken: Int,
  /** The seat's pacts that ended early, by cause (`left`, `betrayal`, `eliminated`, `superseded`). */
  pactEnds: Counts,
  betrayalsCommitted: Int,
  betrayalsSuffered: Int,
  /**
   * With LLM seats that started on the same model, and on another model (design §3.8): messages
   * sent, pacts signed, alliance memberships shared. Null for a bot seat.
   */
  sameModel: PeerCountsSchema.nullable(),
  crossModel: PeerCountsSchema.nullable(),
  /** Sent messages that name a model, a vendor or "language model" (self-identification, counted only). */
  selfIdentification: Int,
});

const SeatMilitarySchema = z.strictObject({
  battlesAttacked: Int,
  battlesDefended: Int,
  battlesWon: Int,
  citiesConquered: Int,
  citiesLost: Int,
  citiesFounded: Int,
});

const SeatIncidentsSchema = z.strictObject({
  /** The hand-off to the seat's bot: when, why (null when the side files do not say) and to whom. */
  handoff: z
    .strictObject({
      t: GameTimeSchema,
      reason: HandoffReasonSchema.nullable(),
      label: z.string(),
    })
    .nullable(),
  wakeCaps: Int,
  promptCaps: Int,
  /** Attempts a fallback model served, in permille of the attempts. */
  fallbackPermille: Permille,
  /** Wakes closed by an error. */
  errorWakes: Int,
  /** Refused attempts by category. */
  refusals: Counts,
  /** Of the round attempts that called tools, those that called two or more at once, permille; null without one. */
  parallelPermille: Permille.nullable(),
});

/** What the model calls did (null for a bot seat, or an LLM seat without `llm_calls.jsonl`). */
const SeatOperationsSchema = z.strictObject({
  /** HTTP attempts (`llm_call` lines), thought calls included. */
  attempts: Int,
  thoughtCalls: Int,
  stops: Counts,
  /** Failed attempts by error kind. */
  errors: Counts,
  /** Tool-call errors (design §3.5): malformed calls (`stop: "other"`) and the gateway's `INVALID_ARGS`. */
  toolErrors: z.strictObject({ malformed: Int, invalidArgs: Int }),
  /** Attempts a fallback model served. */
  fallbacks: Int,
  /** Round attempts that called tools, and those that called two or more at once (parallel calls). */
  toolRounds: Int,
  parallelRounds: Int,
  /** Characters of reply text and of reasoning (summaries or raw), over the attempts. */
  textChars: Int,
  reasoningChars: Int,
  /** Attempts by what their reasoning is (`summary`, `raw`, `none`), where the lines say. */
  reasoningKinds: Counts,
  /** Wall latency and time to first token per attempt (ms, informational); null under `--no-costs`. */
  latencyMs: PercentilesSchema.nullable(),
  ttftMs: PercentilesSchema.nullable(),
});

/** What the seat cost (null for a bot seat, an LLM seat without `llm_calls.jsonl`, and under `--no-costs`). */
const SeatCostSchema = z.strictObject({
  /** Every attempt and thought call, platform fees included (integer nano-dollars). */
  nanoUsd: Int,
  /** Per wake (rounded down); null without a wake. */
  perWakeNanoUsd: Int.nullable(),
  /** The seat's equal share of its model's start preflight and probes. */
  preflightNanoUsd: Int,
  feesNanoUsd: Int,
  /** The provider's own reported cost (OpenRouter), where every line carries one; else null. */
  reportedNanoUsd: Int.nullable(),
  /** Lines charged from an estimate (a broken stream), included in `nanoUsd`. */
  estimatedNanoUsd: Int,
  /** By token kind at the seat's cards (`arena.json`); null when the run has none. */
  byKind: CostByKindSchema.nullable(),
  tokens: TokensSchema,
  /** Cache reads over prompt tokens (input, writes and reads), permille. */
  cacheReadPermille: Permille,
  /** The price cards charged. */
  priceCards: z.array(z.string()),
  capNanoUsd: Int.nullable(),
});

export const SeatStatsSchema = z.strictObject({
  seat: PlayerIdSchema,
  /** How the seat started: an LLM or a bot (a handed-off seat stays `llm`: intention to treat). */
  kind: z.enum(["llm", "bot"]),
  /** The controller label it started with. */
  label: z.string(),
  /** Its item key as it started: `provider/model[@endpoint]/effort`, or the bot's label. */
  key: z.string(),
  /** `key` as a model id (its aggregate's, unless two keys share one). */
  id: ModelIdSchema,
  /** The profile's first name for an LLM seat (`Odysseus`), `Conqueror (bot)` for a bot. */
  name: z.string(),
  model: StatsModelSchema.nullable(),
  /** `odysseus@1`. */
  profile: z.string().nullable(),
  promptVariant: PromptVariantSchema.nullable(),
  reminders: ReminderCadenceSchema.nullable(),
  toolsHash: z.string().nullable(),
  /** A bot behind the LLM pipe (a `--fake` run or a `fake` provider): never a model's play. */
  fake: z.boolean(),
  outcome: SeatOutcomeSchema,
  play: SeatPlaySchema,
  diplomacy: SeatDiplomacySchema,
  military: SeatMilitarySchema,
  incidents: SeatIncidentsSchema,
  operations: SeatOperationsSchema.nullable(),
  cost: SeatCostSchema.nullable(),
});
export type SeatStats = z.infer<typeof SeatStatsSchema>;

export const MatchStatsSchema = z.strictObject({
  format: z.literal(MATCH_STATS_FORMAT),
  match: StatsMatchIdSchema,
  ruleset: RulesetRefSchema,
  status: z.enum(STATS_MATCH_STATUSES),
  /** Level E of the log. */
  verified: z.boolean(),
  /** Counted in ratings: an end line, status `ended` or `degraded`, verified. */
  rated: z.boolean(),
  clock: z.enum(["lockstep", "realtime"]),
  lastT: GameTimeSchema,
  endedAt: GameTimeSchema.nullable(),
  result: z.strictObject({ reason: z.string(), winners: z.array(PlayerIdSchema) }).nullable(),
  /** A `--fake` run, or a run with fake seats. */
  fake: z.boolean(),
  /** The lineup (a series match: the series' base lineup); null without one. */
  lineup: z.string().nullable(),
  series: StatsSeriesRefSchema.nullable(),
  /** `costs: false`: every cost, token and model-time figure is null (the server's `--no-costs`). */
  published: z.strictObject({ costs: z.boolean() }),
  seats: z.array(SeatStatsSchema),
  /** LLM seat pairs on the same model and on different models, and what they did together (§3.8). */
  collusion: z.strictObject({
    samePairs: Int,
    crossPairs: Int,
    same: PeerCountsSchema,
    cross: PeerCountsSchema,
  }),
  /** The run's own spend; null under `--no-costs` or without `llm_calls.jsonl`. */
  cost: z
    .strictObject({
      /** Attempts, start preflight and probes. */
      nanoUsd: Int,
      preflightNanoUsd: Int,
      probeNanoUsd: Int,
      budgetNanoUsd: Int.nullable(),
    })
    .nullable(),
});
export type MatchStats = z.infer<typeof MatchStatsSchema>;

// Across matches -----------------------------------------------------------------------------------

const IntervalSchema = z.strictObject({ lo: z.number(), hi: z.number() });
export type StatsInterval = z.infer<typeof IntervalSchema>;

/**
 * Whether a ranking claim may be shown (design §6.4): a 70/30 head-to-head needs `needed` rated
 * matches per pair of compared models (exact two-sided binomial test at α = 0.05, Bonferroni over
 * the pairs, 80% power). `too_few_matches`: outcomes and ratings are withheld; `no_comparison`:
 * fewer than two models were compared.
 */
export const ClaimsSchema = z.strictObject({
  state: z.enum(["ok", "too_few_matches", "no_comparison"]),
  /** The claimed head-to-head gap: `70/30`. */
  gap: z.string(),
  /** LLM items compared, and their pairs that met in a rated match. */
  models: Int,
  pairs: Int,
  /** The per-pair significance level: 0.05 / pairs. */
  alpha: z.number(),
  /** Rated matches of the pair that met least. */
  matches: Int,
  needed: Int,
  /** Rated matches still needed (0 when `ok`). */
  more: Int,
  /** The test's power at `matches` for the claimed gap (achieved power). */
  power: z.number(),
  /** The same at the design's three gaps (80/20, 70/30, 60/40). */
  table: z.array(z.strictObject({ gap: z.string(), needed: Int, power: z.number() })),
});
export type Claims = z.infer<typeof ClaimsSchema>;

export const RatingItemSchema = z.strictObject({
  id: ModelIdSchema,
  key: z.string(),
  kind: z.enum(["llm", "bot"]),
  /** Rated matches it played. */
  matches: Int,
  /** MAP log-strength, the LLM items summing to zero, and its interval. */
  strength: z.number(),
  interval: IntervalSchema,
  /** The same on an Elo-like scale: 1500 + 400 · strength / ln 10. */
  elo: z.number(),
  eloInterval: IntervalSchema,
  meanRank: z.number(),
  /** Null with Laplace intervals (fewer than 5 blocks). */
  meanRankInterval: IntervalSchema.nullable(),
});
export type RatingItem = z.infer<typeof RatingItemSchema>;

const RatingSetSchema = z.strictObject({
  matches: Int,
  seats: Int,
  /** Sorted by id, never by strength. */
  items: z.array(RatingItemSchema),
  /** Pairs of LLM items: matches they met in, how often `a` finished ahead, strength difference a − b. */
  pairs: z.array(
    z.strictObject({
      a: ModelIdSchema,
      b: ModelIdSchema,
      matches: Int,
      aAhead: Int,
      difference: z.number(),
      interval: IntervalSchema,
    }),
  ),
});
export type RatingSet = z.infer<typeof RatingSetSchema>;

export const RatingsSchema = z.strictObject({
  method: z.literal("map-plackett-luce"),
  /** The Gaussian prior's standard deviation on log-strengths. */
  priorSigma: z.number(),
  intervals: z.strictObject({
    /** A block bootstrap over rotation blocks; Laplace intervals below 5 blocks. */
    method: z.enum(["block-bootstrap", "laplace"]),
    level: z.number(),
    blocks: Int,
    replicates: Int,
    /** The bootstrap's own seed (not a game's). */
    bootstrapSeed: Int,
  }),
  /** Every seat as it started (intention to treat), handed-off seats included. */
  headline: RatingSetSchema,
  /** Sensitivity: seats handed to their bot left out of each ranking. */
  clean: RatingSetSchema,
});
export type Ratings = z.infer<typeof RatingsSchema>;

/** One item across matches (a model by default). */
export const ModelAggregateSchema = z.strictObject({
  id: ModelIdSchema,
  key: z.string(),
  kind: z.enum(["llm", "bot"]),
  /** The model (null for a bot and outside the `model` grouping). */
  model: StatsModelSchema.nullable(),
  fake: z.boolean(),
  matches: Int,
  seats: Int,
  /** Seats in rated matches. */
  rated: Int,
  /** Hand-offs by reason (`unknown` when the side files do not say). */
  handoffs: Counts,
  play: z.strictObject({
    wakes: Int,
    rounds: Int,
    calls: Int,
    thoughts: Int,
    rejections: Counts,
  }),
  diplomacy: z.strictObject({
    messagesSent: Int,
    messagesReceived: Int,
    pactsSigned: Int,
    pactsKept: Int,
    pactsBroken: Int,
    betrayalsCommitted: Int,
    betrayalsSuffered: Int,
    alliancesFounded: Int,
    alliancesJoined: Int,
    selfIdentification: Int,
  }),
  military: z.strictObject({
    battlesAttacked: Int,
    battlesDefended: Int,
    battlesWon: Int,
    citiesConquered: Int,
    citiesLost: Int,
  }),
  incidents: z.strictObject({
    wakeCaps: Int,
    promptCaps: Int,
    errorWakes: Int,
    refusals: Counts,
    parallelPermille: Permille.nullable(),
  }),
  /** Null when no seat of it has `llm_calls.jsonl` lines. */
  operations: z
    .strictObject({
      attempts: Int,
      stops: Counts,
      errors: Counts,
      toolErrors: z.strictObject({ malformed: Int, invalidArgs: Int }),
      /** The seats' p50 and p95 averaged, weighted by their attempts; null under `--no-costs`. */
      latencyMs: PercentilesSchema.nullable(),
    })
    .nullable(),
  /** Null under `--no-costs` and when no seat of it has a cost. */
  cost: z
    .strictObject({
      nanoUsd: Int,
      perMatchNanoUsd: Int,
      perWakeNanoUsd: Int.nullable(),
      cacheReadPermille: Permille,
      tokens: TokensSchema,
      /** Per lineup (social and urgent wakes depend on the opponents), with a block-bootstrap interval from 5 blocks. */
      byLineup: z.array(
        z.strictObject({
          lineup: z.string(),
          matches: Int,
          meanNanoUsd: Int,
          interval: IntervalSchema.nullable(),
        }),
      ),
    })
    .nullable(),
  /** Final ranks, cities and wins over rated matches: null until the claim threshold is met. */
  outcome: z
    .strictObject({
      rated: Int,
      meanRank: z.number(),
      /** Seats per final rank: `ranks[0]` finished first. */
      ranks: z.array(Int),
      wins: Int,
      dominationWins: Int,
      citiesMean: z.number(),
    })
    .nullable(),
});
export type ModelAggregate = z.infer<typeof ModelAggregateSchema>;

const AggregatedMatchSchema = z.strictObject({
  match: StatsMatchIdSchema,
  status: z.enum(STATS_MATCH_STATUSES),
  rated: z.boolean(),
  fake: z.boolean(),
  lineup: z.string().nullable(),
  series: StatsSeriesRefSchema.nullable(),
  /** The bootstrap block: a series' block, else the match alone. */
  block: z.string(),
  /** Each seat's item. */
  seats: z.array(z.strictObject({ seat: PlayerIdSchema, id: ModelIdSchema })),
});

const SeriesSummarySchema = z.strictObject({
  lineup: z.string(),
  fake: z.boolean(),
  order: z.int().positive(),
  blocks: z.int().positive(),
  orthogonal: z.boolean(),
  /** Matches the manifest plans, and those found aggregated. */
  planned: Int,
  found: Int,
});

/** A model's seat in one match. */
export const ModelSeatRowSchema = z.strictObject({
  id: ModelIdSchema,
  match: StatsMatchIdSchema,
  seat: PlayerIdSchema,
  rated: z.boolean(),
  lineup: z.string().nullable(),
  profile: z.string().nullable(),
  promptVariant: PromptVariantSchema.nullable(),
  handedOff: z.boolean(),
  wakes: Int,
  /** Null under `--no-costs`. */
  costNanoUsd: Int.nullable(),
  /** Null until the claim threshold is met. */
  rank: z.int().positive().nullable(),
});
export type ModelSeatRow = z.infer<typeof ModelSeatRowSchema>;

const modelsShape = {
  format: z.literal(MODEL_STATS_FORMAT),
  grouping: StatsGroupingSchema,
  published: z.strictObject({ costs: z.boolean() }),
  matches: z.array(AggregatedMatchSchema),
  series: z.array(SeriesSummarySchema),
  /** Bootstrap blocks among the rated matches. */
  blocks: Int,
  /** Sorted by id, never by outcome. */
  models: z.array(ModelAggregateSchema),
  claims: ClaimsSchema,
  /** Null until the claim threshold is met (unless `exploratory`). */
  ratings: RatingsSchema.nullable(),
};

/** `bun run stats -- aggregate --out <file>`: what the server's `--stats <file>` serves. */
export const ModelStatsFileSchema = z.strictObject({
  ...modelsShape,
  /** Outcomes and ratings shown below the threshold (`--exploratory`): the server never serves it. */
  exploratory: z.boolean(),
  seats: z.array(ModelSeatRowSchema),
});
export type ModelStatsFile = z.infer<typeof ModelStatsFileSchema>;

/** `GET /api/models`. */
export const ModelsResponseSchema = z.strictObject(modelsShape);
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;

/** `GET /api/models/:id`. */
export const ModelDetailSchema = z.strictObject({
  format: z.literal(MODEL_STATS_FORMAT),
  grouping: StatsGroupingSchema,
  published: z.strictObject({ costs: z.boolean() }),
  model: ModelAggregateSchema,
  claims: ClaimsSchema,
  /** Its headline rating; null until the claim threshold is met. */
  rating: RatingItemSchema.nullable(),
  /** Its seats, match by match. */
  seats: z.array(ModelSeatRowSchema),
});
export type ModelDetail = z.infer<typeof ModelDetailSchema>;
