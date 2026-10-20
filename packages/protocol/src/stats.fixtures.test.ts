// Fixtures of the statistics formats (`stats.ts`), with the valid and invalid cases `schemas.test.ts`
// checks for every exported schema. No tests here.

import { withAt } from "./fixtures.test.ts";
import * as protocol from "./index.ts";
import type {
  Claims,
  MatchStats,
  ModelAggregate,
  ModelDetail,
  ModelSeatRow,
  ModelStatsFile,
  ModelsResponse,
  RatingItem,
  Ratings,
  SeatStats,
  StatsModel,
} from "./index.ts";
import type { SchemaCase } from "./spectator.fixtures.test.ts";

type Path = readonly (string | number)[];
const bad = (base: unknown, path: Path, next: unknown): { value: unknown; path: Path } => ({
  value: withAt(base, path, next),
  path,
});
const extra = (base: unknown, path: Path): { value: unknown; path: Path } => ({
  value: withAt(base, [...path, "bogus"], 1),
  path,
});

const model: StatsModel = {
  provider: "anthropic",
  model: "claude-haiku-5-5",
  endpoint: null,
  effort: "medium",
  intended: null,
  quantization: null,
  effortSent: null,
};

const tokens = {
  input: 412,
  cacheWrite5m: 2930,
  cacheWrite1h: 0,
  cacheRead: 14820,
  output: 1510,
  reasoning: 300,
};

const llmSeat: SeatStats = {
  seat: "p1",
  kind: "llm",
  label: "llm:anthropic/claude-haiku-5-5/medium:odysseus@1",
  key: "anthropic/claude-haiku-5-5/medium",
  id: "anthropic.claude-haiku-5-5.medium",
  name: "Odysseus",
  model,
  profile: "odysseus@1",
  promptVariant: "system",
  reminders: "every-round",
  toolsHash: "0123456789abcdef",
  fake: false,
  outcome: { rank: 1, score: 5120, cities: 4, alive: true, eliminatedAt: null, winner: true },
  play: {
    turns: 24,
    wakes: 24,
    rounds: 61,
    calls: 88,
    accepted: 80,
    rejections: { INVALID_ARGS: 1, NOT_ENOUGH_RESOURCES: 7 },
    thoughts: 20,
    endings: { end_turn: 23, error: 1 },
  },
  diplomacy: {
    messagesSent: 12,
    messagesReceived: 15,
    publicSent: 2,
    proposalsSent: 3,
    proposalsReceived: 2,
    accepted: 1,
    refused: 1,
    alliancesFounded: 1,
    alliancesJoined: 0,
    alliancesLeft: 0,
    pactsSigned: 2,
    pactsKept: 1,
    pactsBroken: 1,
    pactEnds: { betrayal: 1 },
    betrayalsCommitted: 1,
    betrayalsSuffered: 0,
    sameModel: { messages: 4, pacts: 1, alliances: 1 },
    crossModel: { messages: 8, pacts: 1, alliances: 0 },
    selfIdentification: 0,
  },
  military: {
    battlesAttacked: 6,
    battlesDefended: 3,
    battlesWon: 7,
    citiesConquered: 2,
    citiesLost: 0,
    citiesFounded: 1,
  },
  incidents: {
    handoff: null,
    wakeCaps: 0,
    promptCaps: 0,
    fallbackPermille: 0,
    errorWakes: 1,
    refusals: {},
    parallelPermille: 410,
  },
  operations: {
    attempts: 87,
    thoughtCalls: 20,
    stops: { tool_use: 61, end_turn: 24, other: 2 },
    errors: { overloaded: 2 },
    toolErrors: { malformed: 2, invalidArgs: 1 },
    fallbacks: 0,
    toolRounds: 61,
    parallelRounds: 25,
    textChars: 20480,
    reasoningChars: 9000,
    reasoningKinds: { summary: 61 },
    latencyMs: { n: 87, p50: 4200, p95: 12100 },
    ttftMs: { n: 85, p50: 900, p95: 2400 },
  },
  cost: {
    nanoUsd: 412_000_000,
    perWakeNanoUsd: 17_166_666,
    preflightNanoUsd: 1_000_000,
    feesNanoUsd: 0,
    reportedNanoUsd: null,
    estimatedNanoUsd: 0,
    byKind: {
      input: 1_000_000,
      cacheWrite5m: 30_000_000,
      cacheWrite1h: 0,
      cacheRead: 150_000_000,
      output: 230_000_000,
    },
    tokens,
    cacheReadPermille: 813,
    priceCards: ["anthropic/claude-haiku-5-5@2026-10-01"],
    capNanoUsd: null,
  },
};

const botSeat: SeatStats = {
  ...llmSeat,
  seat: "p2",
  kind: "bot",
  label: "bot:conqueror@3",
  key: "bot:conqueror@3",
  id: "bot.conqueror.3",
  name: "Conqueror (bot)",
  model: null,
  profile: null,
  promptVariant: null,
  reminders: null,
  toolsHash: null,
  outcome: { rank: 2, score: 3100, cities: 2, alive: true, eliminatedAt: null, winner: false },
  diplomacy: { ...llmSeat.diplomacy, sameModel: null, crossModel: null },
  incidents: { ...llmSeat.incidents, errorWakes: 0, parallelPermille: null },
  operations: null,
  cost: null,
};

const handedOff: SeatStats = {
  ...llmSeat,
  seat: "p3",
  incidents: {
    ...llmSeat.incidents,
    handoff: { t: 86_400, reason: "cap", label: "bot:conqueror@3" },
  },
};

const matchStats: MatchStats = {
  format: "perfidia-stats/1",
  match: "m01",
  ruleset: "perfidia-1@1.1.0",
  status: "ended",
  verified: true,
  rated: true,
  clock: "lockstep",
  lastT: 604_800,
  endedAt: 604_800,
  result: { reason: "time", winners: ["p1"] },
  fake: false,
  lineup: "budget-mix",
  series: { lineup: "budget-mix", block: 0, index: 1 },
  published: { costs: true },
  seats: [llmSeat, botSeat, handedOff],
  collusion: {
    samePairs: 1,
    crossPairs: 0,
    same: { messages: 4, pacts: 1, alliances: 1 },
    cross: { messages: 0, pacts: 0, alliances: 0 },
  },
  cost: {
    nanoUsd: 830_000_000,
    preflightNanoUsd: 2_000_000,
    probeNanoUsd: 0,
    budgetNanoUsd: 5_000_000_000,
  },
};

const claims: Claims = {
  state: "too_few_matches",
  gap: "70/30",
  models: 4,
  pairs: 6,
  alpha: 0.05 / 6,
  matches: 4,
  needed: 74,
  more: 70,
  power: 0.02,
  table: [
    { gap: "80/20", needed: 32, power: 0.05 },
    { gap: "70/30", needed: 74, power: 0.02 },
    { gap: "60/40", needed: 303, power: 0.01 },
  ],
};

const ratingItem: RatingItem = {
  id: "anthropic.claude-haiku-5-5.medium",
  key: "anthropic/claude-haiku-5-5/medium",
  kind: "llm",
  matches: 80,
  strength: 0.42,
  interval: { lo: 0.1, hi: 0.77 },
  elo: 1572.96,
  eloInterval: { lo: 1517.37, hi: 1633.73 },
  meanRank: 2.4,
  meanRankInterval: { lo: 2.1, hi: 2.8 },
};

const otherItem: RatingItem = {
  ...ratingItem,
  id: "openai.gpt-6-luna.medium",
  key: "openai/gpt-6-luna/medium",
  strength: -0.42,
  interval: { lo: -0.77, hi: -0.1 },
  elo: 1427.04,
  eloInterval: { lo: 1366.27, hi: 1482.63 },
  meanRank: 3.6,
  meanRankInterval: { lo: 3.2, hi: 3.9 },
};

const ratingSet = {
  matches: 80,
  seats: 480,
  items: [ratingItem, otherItem],
  pairs: [
    {
      a: ratingItem.id,
      b: otherItem.id,
      matches: 80,
      aAhead: 56,
      difference: 0.84,
      interval: { lo: 0.3, hi: 1.4 },
    },
  ],
};

const ratings: Ratings = {
  method: "map-plackett-luce",
  priorSigma: 1.5,
  intervals: {
    method: "block-bootstrap",
    level: 0.95,
    blocks: 20,
    replicates: 1000,
    bootstrapSeed: 20_261_019,
  },
  headline: ratingSet,
  clean: { ...ratingSet, seats: 472 },
};

const aggregate: ModelAggregate = {
  id: "anthropic.claude-haiku-5-5.medium",
  key: "anthropic/claude-haiku-5-5/medium",
  kind: "llm",
  model,
  fake: false,
  matches: 4,
  seats: 4,
  rated: 4,
  handoffs: { cap: 1 },
  play: { wakes: 96, rounds: 240, calls: 350, thoughts: 80, rejections: { INVALID_ARGS: 3 } },
  diplomacy: {
    messagesSent: 48,
    messagesReceived: 60,
    pactsSigned: 8,
    pactsKept: 5,
    pactsBroken: 2,
    betrayalsCommitted: 3,
    betrayalsSuffered: 1,
    alliancesFounded: 2,
    alliancesJoined: 1,
    selfIdentification: 0,
  },
  military: {
    battlesAttacked: 20,
    battlesDefended: 12,
    battlesWon: 22,
    citiesConquered: 6,
    citiesLost: 2,
  },
  incidents: { wakeCaps: 0, promptCaps: 1, errorWakes: 2, refusals: {}, parallelPermille: 390 },
  operations: {
    attempts: 350,
    stops: { tool_use: 240, end_turn: 96 },
    errors: {},
    toolErrors: { malformed: 4, invalidArgs: 3 },
    latencyMs: { n: 350, p50: 4100, p95: 11800 },
  },
  cost: {
    nanoUsd: 1_650_000_000,
    perMatchNanoUsd: 412_500_000,
    perWakeNanoUsd: 17_187_500,
    cacheReadPermille: 810,
    tokens,
    byLineup: [{ lineup: "budget-mix", matches: 4, meanNanoUsd: 412_500_000, interval: null }],
  },
  outcome: null,
};

const ranked: ModelAggregate = {
  ...aggregate,
  outcome: {
    rated: 80,
    meanRank: 2.4,
    ranks: [24, 20, 14, 10, 8, 4],
    wins: 24,
    dominationWins: 3,
    citiesMean: 3.2,
  },
};

const seatRow: ModelSeatRow = {
  id: "anthropic.claude-haiku-5-5.medium",
  match: "m01",
  seat: "p1",
  rated: true,
  lineup: "budget-mix",
  profile: "odysseus@1",
  promptVariant: "system",
  handedOff: false,
  wakes: 24,
  costNanoUsd: 412_000_000,
  rank: null,
};

const response: ModelsResponse = {
  format: "perfidia-model-stats/1",
  grouping: "model",
  published: { costs: true },
  matches: [
    {
      match: "m01",
      status: "ended",
      rated: true,
      fake: false,
      lineup: "budget-mix",
      series: { lineup: "budget-mix", block: 0, index: 1 },
      block: "series:budget-mix#0",
      seats: [{ seat: "p1", id: "anthropic.claude-haiku-5-5.medium" }],
    },
  ],
  series: [
    {
      lineup: "budget-mix",
      fake: false,
      order: 4,
      blocks: 1,
      orthogonal: true,
      planned: 4,
      found: 1,
    },
  ],
  blocks: 1,
  models: [aggregate],
  claims,
  ratings: null,
};

const file: ModelStatsFile = { ...response, exploratory: false, seats: [seatRow] };

const detail: ModelDetail = {
  format: "perfidia-model-stats/1",
  grouping: "model",
  published: { costs: true },
  model: aggregate,
  claims,
  rating: null,
  seats: [seatRow],
};

export const STATS_CASES: Record<string, SchemaCase> = {
  ModelIdSchema: {
    schema: protocol.ModelIdSchema,
    valid: ["anthropic.claude-sonnet-5-5.medium", "bot.conqueror.3", "fake.gpt-6-luna.medium-2"],
    invalid: [
      { value: "Anthropic.claude", path: [] },
      { value: "a/b", path: [] },
      { value: ".hidden", path: [] },
      { value: "x".repeat(161), path: [] },
    ],
  },
  StatsGroupingSchema: {
    schema: protocol.StatsGroupingSchema,
    valid: [...protocol.STATS_GROUPINGS],
    invalid: [{ value: "seat", path: [] }],
  },
  StatsModelSchema: {
    schema: protocol.StatsModelSchema,
    valid: [
      model,
      {
        ...model,
        provider: "openrouter",
        model: "z-ai/glm-5.3",
        endpoint: "z-ai/fp8",
        quantization: "fp8",
        effortSent: "low",
      },
      { ...model, provider: "fake", intended: "anthropic" },
    ],
    invalid: [bad(model, ["effort"], "huge"), extra(model, [])],
  },
  StatsSeriesRefSchema: {
    schema: protocol.StatsSeriesRefSchema,
    valid: [{ lineup: "budget-mix", block: 0, index: 1 }],
    invalid: [
      { value: { lineup: "budget-mix", block: 0, index: 0 }, path: ["index"] },
      { value: { lineup: "budget-mix", block: 0, index: 1, seed: 5 }, path: [] },
    ],
  },
  SeatStatsSchema: {
    schema: protocol.SeatStatsSchema,
    valid: [llmSeat, botSeat, handedOff],
    invalid: [
      bad(llmSeat, ["id"], "Anthropic/claude"),
      bad(llmSeat, ["outcome", "rank"], 0),
      bad(llmSeat, ["incidents", "parallelPermille"], 1001),
      bad(llmSeat, ["incidents", "handoff", "reason"], "bored"),
      bad(llmSeat, ["play", "rejections", "INVALID_ARGS"], -1),
      bad(llmSeat, ["cost", "nanoUsd"], 0.5),
      extra(llmSeat, ["diplomacy"]),
    ],
  },
  MatchStatsSchema: {
    schema: protocol.MatchStatsSchema,
    valid: [
      matchStats,
      {
        ...matchStats,
        status: "live",
        rated: false,
        endedAt: null,
        result: null,
        lineup: null,
        series: null,
        published: { costs: false },
        seats: [{ ...llmSeat, cost: null }, botSeat],
        cost: null,
      },
    ],
    invalid: [
      bad(matchStats, ["format"], "perfidia-stats/2"),
      bad(matchStats, ["match"], "../etc"),
      bad(matchStats, ["status"], "running"),
      bad(matchStats, ["clock"], "wall"),
      extra(matchStats, ["collusion"]),
    ],
  },
  ClaimsSchema: {
    schema: protocol.ClaimsSchema,
    valid: [
      claims,
      { ...claims, state: "ok", matches: 80, more: 0, power: 0.83 },
      { ...claims, state: "no_comparison", models: 1, pairs: 0, alpha: 0.05, matches: 0 },
    ],
    invalid: [bad(claims, ["state"], "maybe"), bad(claims, ["more"], -1), extra(claims, [])],
  },
  RatingItemSchema: {
    schema: protocol.RatingItemSchema,
    valid: [ratingItem, { ...ratingItem, kind: "bot", meanRankInterval: null }],
    invalid: [bad(ratingItem, ["interval", "lo"], "low"), extra(ratingItem, ["eloInterval"])],
  },
  RatingsSchema: {
    schema: protocol.RatingsSchema,
    valid: [
      ratings,
      {
        ...ratings,
        intervals: { ...ratings.intervals, method: "laplace", blocks: 3, replicates: 0 },
      },
    ],
    invalid: [
      bad(ratings, ["method"], "elo"),
      bad(ratings, ["intervals", "method"], "jackknife"),
      { value: withAt(ratings, ["intervals", "seed"], 5), path: ["intervals"] },
      bad(ratings, ["headline", "pairs", 0, "a"], "Bad Id"),
    ],
  },
  ModelAggregateSchema: {
    schema: protocol.ModelAggregateSchema,
    valid: [
      aggregate,
      ranked,
      { ...aggregate, operations: null, cost: null },
      {
        ...aggregate,
        id: "bot.conqueror.3",
        key: "bot:conqueror@3",
        kind: "bot",
        model: null,
        operations: null,
        cost: null,
      },
    ],
    invalid: [
      bad(aggregate, ["incidents", "parallelPermille"], -1),
      bad(ranked, ["outcome", "ranks", 0], -1),
      extra(aggregate, ["cost"]),
    ],
  },
  ModelSeatRowSchema: {
    schema: protocol.ModelSeatRowSchema,
    valid: [seatRow, { ...seatRow, rank: 1, costNanoUsd: null, profile: null, lineup: null }],
    invalid: [bad(seatRow, ["rank"], 0), bad(seatRow, ["match"], "a/b"), extra(seatRow, [])],
  },
  ModelsResponseSchema: {
    schema: protocol.ModelsResponseSchema,
    valid: [
      response,
      { ...response, models: [ranked], claims: { ...claims, state: "ok", more: 0 }, ratings },
    ],
    invalid: [
      { value: { ...response, seats: [seatRow] }, path: [] },
      { value: { ...response, exploratory: false }, path: [] },
      bad(response, ["matches", 0, "seats", 0, "id"], "Bad"),
      bad(response, ["series", 0, "order"], 0),
    ],
  },
  ModelStatsFileSchema: {
    schema: protocol.ModelStatsFileSchema,
    valid: [file, { ...file, exploratory: true, ratings }],
    invalid: [
      bad(file, ["format"], "perfidia-model-stats/2"),
      bad(file, ["grouping"], "seat"),
      { value: withAt(file, ["series", 0, "seed"], 5), path: ["series", 0] },
    ],
  },
  ModelDetailSchema: {
    schema: protocol.ModelDetailSchema,
    valid: [detail, { ...detail, model: ranked, rating: ratingItem }],
    invalid: [bad(detail, ["rating", "id"], "Bad"), extra(detail, [])],
  },
};
