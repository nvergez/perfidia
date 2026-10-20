// Fixtures of the run-directory formats (`arena.ts`) and of the spectator formats (`spectator.ts`),
// with the valid and invalid cases `schemas.test.ts` checks for every exported schema. No tests here.

import type { ZodType } from "zod";
import { SHA, withAt } from "./fixtures.test.ts";
import * as protocol from "./index.ts";
import type {
  ArenaBudget,
  ArenaReport,
  ArenaSeatReport,
  EstimateFile,
  Exit4,
  Lineup,
  ReconcileFile,
  TokenProfile,
  SeriesManifest,
  ReconcileInput,
  CityEnt,
  FeedItem,
  Frame,
  LlmCallLine,
  MatchListItem,
  MatchMeta,
  Moment,
  MovementEnt,
  Patch,
  PlayerEnt,
  QueueEnt,
  PlayerDossier,
  ReplyLine,
  ReportDetail,
  SeatEnt,
  SeatInfo,
  SeatsFile,
  SpectatorMap,
  Step,
  TurnAnnotation,
} from "./index.ts";

type Path = readonly (string | number)[];
interface Invalid {
  readonly value: unknown;
  readonly path: Path;
}
export interface SchemaCase {
  readonly schema: ZodType;
  readonly valid: readonly unknown[];
  readonly invalid: readonly Invalid[];
}

const bad = (base: unknown, path: Path, next: unknown): Invalid => ({
  value: withAt(base, path, next),
  path,
});
const extra = (base: unknown, path: Path): Invalid => ({
  value: withAt(base, [...path, "bogus"], 1),
  path,
});

// Run-directory lines and files ------------------------------------------------------------------

const tokens = { input: 412, cacheWrite5m: 2930, cacheWrite1h: 0, cacheRead: 14820, output: 1510 };
const usageLine = {
  model: "claude-opus-5-5",
  kind: "message",
  ...tokens,
  estimated: false,
} as const;

export const llmCallLine: LlmCallLine = {
  k: "llm_call",
  seat: "p3",
  turn: 12,
  round: 2,
  attempt: 1,
  kind: "round",
  t: 223320,
  wallStart: "2026-10-20T14:02:11.120Z",
  latencyMs: 23140,
  ttftMs: 4210,
  provider: "anthropic",
  model: "claude-opus-5-5",
  servedBy: "claude-opus-5-5",
  effort: "medium",
  maxTokens: 16000,
  stop: "tool_use",
  rawStop: "tool_use",
  refusal: null,
  fallback: false,
  cacheMiss: false,
  usage: [usageLine],
  costNanoUsd: 49462000,
  seatSpentNanoUsd: 3120000000,
  capNanoUsd: 100000000000,
  wakeSpentNanoUsd: 131000000,
  unpriced: [],
  calls: 3,
  textChars: 96,
  reasoningChars: 840,
  requestId: "req_1",
  error: null,
};

const handoffLine = {
  k: "handoff",
  seat: "p3",
  t: 389100,
  reason: "cap",
  label: "bot:turtle@3",
  spentNanoUsd: 100012000000,
  capNanoUsd: 100000000000,
} as const;

const pauseLine = {
  k: "pause",
  wallStart: "2026-10-20T14:02:11.120Z",
  wallEnd: null,
  reason: "billing: credit balance too low (p1, claude-opus-5-5)",
  seat: "p1",
  model: "claude-opus-5-5",
  outcome: "aborted",
  pausedMs: 120000,
} as const;

const wakeCapLine = {
  k: "wake_cap",
  seat: "p2",
  turn: 7,
  round: 3,
  t: 90000,
  wakeSpentNanoUsd: 2000000000,
  wakeCapNanoUsd: 2000000000,
} as const;

export const replyLine: ReplyLine = {
  k: "reply",
  seat: "p1",
  turn: 3,
  round: 0,
  attempt: 1,
  kind: "round",
  t: 3600,
  stop: "tool_use",
  reasoning: ["Fake reasoning: build"],
  text: [],
  calls: [{ name: "build", args: { city: "c1", buildings: ["acropolis"] } }],
};

const profile = {
  id: "odysseus",
  version: 1,
  name: "Odysseus, the schemer",
  goal: "Finish first.",
  temperament: "Patient.",
  word: "A tool, not a bond.",
  style: "Warm.",
  handoffBot: "opportunist@3",
} as const;

const seatsFile: SeatsFile = {
  harness: "orchestrator/1",
  promptVersion: 2,
  prompts: { shared: SHA, operator: SHA, tools: SHA },
  seats: [
    {
      seat: "p1",
      kind: "llm",
      label: "llm:fake/claude-opus-5-5/medium:odysseus@1:p2",
      provider: "fake",
      model: "claude-opus-5-5",
      effort: "medium",
      maxTokens: 16000,
      capNanoUsd: 100000000000,
      profile: { ...profile },
      handoffBot: "bot:opportunist@3",
      prompt: SHA,
    },
    { seat: "p2", kind: "bot", label: "bot:turtle@3" },
  ],
};

const seatReport: ArenaSeatReport = {
  seat: "p1",
  label: "llm:fake/claude-opus-5-5/medium:odysseus@1:p2",
  controllers: "llm:fake/claude-opus-5-5/medium:odysseus@1:p2",
  profile: "odysseus@1",
  name: "Odysseus, the schemer",
  provider: "fake",
  model: "claude-opus-5-5",
  effort: "medium",
  capNanoUsd: 100000000000,
  costNanoUsd: 765749400,
  costByKind: {
    input: 0,
    cacheWrite5m: 319390000,
    cacheWrite1h: 0,
    cacheRead: 93539400,
    output: 352820000,
  },
  tokens: { input: 0, cacheWrite5m: 63878, cacheWrite1h: 0, cacheRead: 467697, output: 17641 },
  attempts: 51,
  stops: { tool_use: 51 },
  errors: {},
  refusals: {},
  fallbacks: 0,
  servedBy: { "claude-opus-5-5": 51 },
  cacheMisses: 0,
  wakeCaps: 0,
  unpriced: [],
  thoughts: { turns: 14, withThought: 14, byWhy: { end_turn: { turns: 14, withThought: 14 } } },
  thinkMs: { turns: 14, p50: 0, p95: 0, max: 0 },
  rejections: { ALREADY_ALLIED: 1 },
  calls: 141,
  handoff: null,
  promptCaps: 0,
  estimate: { low: 854050000, central: 2974760000, high: 10950000000 },
  projectedNanoUsd: 7097156308,
};

const exitEvent = {
  t: 600,
  time: "D1 00:10",
  type: "alliance_formed",
  seats: ["p1", "p4"],
  relation: null,
  llm: ["p1", "p4"],
} as const;

const exitCriterion = {
  alliancesFormed: 1,
  betrayals: 0,
  met: false,
  llm: { alliances: 1, asBetrayer: 0, asVictim: 0, betrayals: 0, met: false },
  events: [exitEvent],
} as const;

const arenaBudget: ArenaBudget = {
  budgetNanoUsd: 55000000000,
  reserveNanoUsd: 2000000000,
  killAtNanoUsd: 53000000000,
  carryNanoUsd: 0,
  onBudget: "handoff",
  estimate: {
    sha256: SHA,
    low: 3416200000,
    central: 11899040000,
    high: 43800000000,
    source: "scenario",
  },
  actualNanoUsd: 2836708800,
  attemptsNanoUsd: 2836708800,
  preflightNanoUsd: 0,
  probeNanoUsd: 0,
  estimatedNanoUsd: 0,
  feesNanoUsd: 0,
  under: true,
  withinPrediction: false,
  killSwitch: null,
  wall: { start: "+0ms", end: "+5ms" },
  byProvider: [
    {
      provider: "fake",
      endpoint: null,
      attempts: 193,
      nanoUsd: 2836708800,
      reportedNanoUsd: null,
      estimatedNanoUsd: 0,
    },
  ],
};

const exit4: Exit4 = {
  models: 1,
  ended: true,
  estimateStored: true,
  noHandoff: true,
  withinPrediction: false,
  under: true,
  levelE: true,
  reconciled: null,
  met: false,
};

const arenaReport: ArenaReport = {
  format: "perfidia-arena/2",
  status: "ended",
  reason: null,
  fake: true,
  ruleset: "perfidia-1@1.1.0",
  seed: 1,
  players: 6,
  days: 1,
  clock: "lockstep",
  promptVersion: 2,
  harness: "orchestrator/1",
  lastT: 86400,
  endedAt: 86400,
  result: { reason: "time", winners: ["p4"] },
  seats: [seatReport],
  bots: [{ seat: "p5", controllers: "bot:opportunist@3" }],
  totals: {
    costNanoUsd: 2836708800,
    attempts: 193,
    tokens: { input: 0, cacheWrite5m: 234624, cacheWrite1h: 0, cacheRead: 1732544, output: 65854 },
    cacheReadPct: 88,
    fallbackPermille: 0,
    preflightNanoUsd: 0,
  },
  estimate: { low: 3416200000, central: 11899040000, high: 43800000000 },
  projection: { fromDays: 1, toDays: 7, costNanoUsd: 26291324231 },
  recommendedSpeed: null,
  pauses: [],
  alerts: [],
  daily: [],
  llmToBotWarCalls: 0,
  levelE: { ok: true, actions: 174, checkpoints: 23, divergence: null },
  exit: {
    ...exitCriterion,
    llm: { ...exitCriterion.llm },
    events: [{ ...exitEvent, seats: ["p1", "p4"], llm: ["p1", "p4"] }],
  },
  budget: arenaBudget,
  exit4,
};

/** `arena.json` as phases 2 and 3 wrote it (`perfidia-arena/1`): ec8e2ad's fixture. */
const arenaReportV1 = {
  format: "perfidia-arena/1",
  status: "ended",
  reason: null,
  fake: true,
  ruleset: "perfidia-1@1.1.0",
  seed: 1,
  players: 6,
  days: 1,
  clock: "lockstep",
  promptVersion: 2,
  harness: "orchestrator/1",
  lastT: 86400,
  endedAt: 86400,
  result: { reason: "time", winners: ["p4"] },
  seats: [
    {
      ...Object.fromEntries(Object.entries(seatReport).filter(([k]) => k !== "promptCaps")),
      handoff: { t: 3600, time: "D1 01:00", label: "bot:turtle@3", spentNanoUsd: 100000000 },
    },
  ],
  bots: [{ seat: "p5", controllers: "bot:opportunist@3" }],
  totals: {
    costNanoUsd: 2836708800,
    attempts: 193,
    tokens: { input: 0, cacheWrite5m: 234624, cacheWrite1h: 0, cacheRead: 1732544, output: 65854 },
    cacheReadPct: 88,
    fallbackPermille: 0,
    preflightNanoUsd: 0,
  },
  estimate: { low: 3416200000, central: 11899040000, high: 43800000000 },
  projection: { fromDays: 1, toDays: 7, costNanoUsd: 26291324231 },
  recommendedSpeed: null,
  pauses: [],
  alerts: [],
  daily: [],
  llmToBotWarCalls: 0,
  levelE: { ok: true, actions: 174, checkpoints: 23, divergence: null },
  exit: {
    ...exitCriterion,
    llm: { ...exitCriterion.llm },
    events: [{ ...exitEvent, seats: ["p1", "p4"], llm: ["p1", "p4"] }],
  },
};

const preflightLine = {
  k: "preflight",
  phase: "start",
  group: "anthropic/claude-sonnet-5-5/medium",
  provider: "anthropic",
  model: "claude-sonnet-5-5",
  endpoint: null,
  t: 0,
  ok: true,
  usage: [{ ...usageLine, model: "claude-sonnet-5-5" }],
  costNanoUsd: 27000000,
  priceCard: "anthropic:claude-sonnet-5-5@2026-10-20",
  error: null,
  wallStart: "2026-10-20T14:02:11.120Z",
} as const;

const promptCapLine = {
  k: "prompt_cap",
  seat: "p2",
  turn: 9,
  round: 4,
  kind: "round",
  t: 120000,
  estimateTokens: 163220,
  capTokens: 160000,
} as const;

const killSwitchLine = {
  k: "kill_switch",
  t: 150000,
  wall: "2026-10-20T19:02:11.120Z",
  spentNanoUsd: 53010000000,
  killAtNanoUsd: 53000000000,
  budgetNanoUsd: 55000000000,
  action: "handoff",
} as const;

const operatorLine = {
  k: "operator",
  signal: "SIGINT",
  action: "handoff",
  t: 150000,
} as const;

const carryLine = { k: "carry", from: "match-1", lines: 812, costNanoUsd: 4120000000 } as const;

const estimateFile: EstimateFile = {
  format: "perfidia-estimate/1",
  lineup: "claude-duo",
  ruleset: "perfidia-1@1.1.0",
  players: 6,
  matchDays: 7,
  days: 7,
  clock: "lockstep",
  cacheTtl: "5m",
  maxTokens: 16000,
  promptCapTokens: 160000,
  seats: [
    {
      seat: "p1",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      effort: "medium",
      fallbacks: "off",
      profile: "odysseus@1",
      capNanoUsd: 79460000000,
      wakeCapNanoUsd: 2000000000,
      low: 3210000000,
      central: 10950000000,
      high: 39730000000,
      source: "scenario",
      priceCards: ["anthropic:claude-sonnet-5-5@2026-10-20"],
      attemptBoundNanoUsd: 960000000,
    },
  ],
  match: { low: 3210000000, central: 10950000000, high: 39730000000, source: "scenario" },
  reserve: {
    attemptBoundsNanoUsd: 960000000,
    probeBoundNanoUsd: 130000000,
    startPreflightBoundNanoUsd: 130000000,
    reserveNanoUsd: 1220000000,
  },
  budget: {
    budgetNanoUsd: 55000000000,
    killAtNanoUsd: 53780000000,
    carryNanoUsd: 0,
    onBudget: "handoff",
  },
  assumptions: ["15.5 wakes per seat per game day"],
};

const lineup: Lineup = {
  format: "perfidia-lineup/1",
  id: "claude-duo",
  title: "Claude exit lineup",
  comparison: false,
  budgetUsd: "55",
  maxTokens: 16000,
  attemptTimeoutMin: 10,
  promptCapTokens: 160000,
  reminders: "every-round",
  defaults: { effort: "medium" },
  seats: [
    {
      seat: "p1",
      kind: "llm",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      profile: "odysseus@1",
      fallbacks: "off",
    },
    { seat: "p5", kind: "bot", label: "bot:opportunist@3" },
  ],
};

const reconcileInput: ReconcileInput = {
  format: "perfidia-reconcile-input/1",
  providers: [
    {
      provider: "anthropic",
      usd: "12.34",
      source: "Console usage, workspace perfidia-m1",
      tokens: [{ model: "claude-sonnet-5-5", input: 1200, output: 98000 }],
    },
  ],
};

const reconcileFile: ReconcileFile = {
  format: "perfidia-reconcile/1",
  wall: { start: "2026-10-20T08:00:00.000Z", end: "2026-10-20T20:00:00.000Z" },
  hoursAfterEnd: 50,
  early: false,
  providers: [
    {
      provider: "anthropic",
      ledgerNanoUsd: 12500000000,
      estimatedExcessNanoUsd: 0,
      reportedNanoUsd: 12340000000,
      feesNanoUsd: 0,
      toleranceNanoUsd: 375000000,
      lowNanoUsd: 12125000000,
      highNanoUsd: 12875000000,
      usdOk: true,
      tokens: [
        { model: "claude-sonnet-5-5", kind: "output", ledger: 98100, reported: 98000, ok: true },
      ],
      tokensOk: true,
      ok: true,
    },
  ],
  ok: true,
};

const tokenProfile: TokenProfile = {
  format: "perfidia-profile/1",
  key: {
    provider: "openai",
    model: "gpt-6.1-sol",
    endpoint: null,
    effort: "medium",
    promptVariant: "developer",
    reminders: "last-round",
    maxTokens: 32768,
    promptVersion: 2,
    rulesetMajor: "perfidia-1@1",
  },
  runs: [{ run: "mid-tier-cal", seed: 7 }],
  seatDays: [
    {
      run: "mid-tier-cal",
      seat: "p2",
      day: 0,
      wakes: [{ rounds: [{ promptTokens: 11000, outputTokens: 1400, cacheReadTokens: 9500 }] }],
    },
  ],
  briefingGrowth: [{ day: 0, briefingTokens: 1500 }],
};

const seriesManifest: SeriesManifest = {
  format: "perfidia-series/1",
  lineup: "budget-mix",
  seed: 1,
  fake: true,
  order: 2,
  blocks: 1,
  orthogonal: false,
  positions: ["p1", "p2"],
  models: [
    { provider: "anthropic", model: "claude-haiku-5-5", endpoint: null, effort: "medium" },
    { provider: "openrouter", model: "z-ai/glm-5.3-flash", endpoint: "z-ai/fp8", effort: "medium" },
  ],
  profiles: ["odysseus@1", "achilles@1"],
  matches: [
    {
      index: 1,
      block: 0,
      run: "m01",
      seed: 7,
      seats: [
        { seat: "p1", model: 1, profile: 0 },
        { seat: "p2", model: 0, profile: 1 },
      ],
      status: "ended",
      code: 0,
      levelE: true,
      costNanoUsd: 367630000,
    },
    {
      index: 2,
      block: 0,
      run: "m02",
      seed: 7,
      seats: [
        { seat: "p1", model: 0, profile: 1 },
        { seat: "p2", model: 1, profile: 0 },
      ],
      status: "planned",
      code: null,
      levelE: null,
      costNanoUsd: null,
    },
  ],
};

export const ARENA_CASES: Record<string, SchemaCase> = {
  EffortSchema: {
    schema: protocol.EffortSchema,
    valid: ["low", "medium", "xhigh", "max", "none", "minimal"],
    invalid: [{ value: "huge", path: [] }],
  },
  TokenUsageSchema: {
    schema: protocol.TokenUsageSchema,
    valid: [tokens],
    invalid: [bad(tokens, ["output"], -1), extra(tokens, [])],
  },
  UsageLineSchema: {
    schema: protocol.UsageLineSchema,
    valid: [usageLine, { ...usageLine, reasoning: 900 }, { ...usageLine, geo: "us" }],
    invalid: [
      bad(usageLine, ["kind"], "batch"),
      bad(usageLine, ["model"], ""),
      bad(usageLine, ["reasoning"], -1),
    ],
  },
  StopSchema: {
    schema: protocol.StopSchema,
    valid: ["end_turn", "tool_use", "refusal", "error"],
    invalid: [{ value: "stop_sequence", path: [] }],
  },
  LlmCallLineSchema: {
    schema: protocol.LlmCallLineSchema,
    valid: [
      llmCallLine,
      { ...llmCallLine, inbox: ["g0k4qz"] },
      {
        ...llmCallLine,
        provider: "openrouter",
        model: "z-ai/glm-5.3",
        effort: "minimal",
        endpoint: "z-ai/fp8",
        priceCard: "openrouter:z-ai/glm-5.3(z-ai/fp8)@2026-10-20",
        feeNanoUsd: 1200,
        reportedCostNanoUsd: 21000,
        reasoningKind: "raw",
      },
    ],
    invalid: [
      bad(llmCallLine, ["attempt"], 0),
      bad(llmCallLine, ["costNanoUsd"], -1),
      bad(llmCallLine, ["effort"], "huge"),
      extra(llmCallLine, []),
      bad(llmCallLine, ["reasoningKind"], "hidden"),
      bad(llmCallLine, ["endpoint"], ""),
      bad(llmCallLine, ["feeNanoUsd"], -1),
    ],
  },
  HandoffReasonSchema: {
    schema: protocol.HandoffReasonSchema,
    valid: ["cap", "match_budget", "outage", "operator"],
    invalid: [{ value: "boredom", path: [] }],
  },
  HandoffLineSchema: {
    schema: protocol.HandoffLineSchema,
    valid: [handoffLine, { ...handoffLine, reason: "match_budget" }],
    invalid: [bad(handoffLine, ["reason"], "boredom")],
  },
  PreflightLineSchema: {
    schema: protocol.PreflightLineSchema,
    valid: [
      preflightLine,
      {
        ...preflightLine,
        phase: "probe",
        ok: false,
        usage: [],
        costNanoUsd: 0,
        priceCard: null,
        error: { kind: "billing", status: 402, message: "credit balance too low" },
      },
      { ...preflightLine, provider: "openrouter", endpoint: "z-ai/fp8", feeNanoUsd: 55 },
    ],
    invalid: [
      bad(preflightLine, ["phase"], "middle"),
      bad(preflightLine, ["costNanoUsd"], -1),
      extra(preflightLine, []),
      bad(preflightLine, ["feeNanoUsd"], -1),
    ],
  },
  PromptCapLineSchema: {
    schema: protocol.PromptCapLineSchema,
    valid: [promptCapLine],
    invalid: [bad(promptCapLine, ["capTokens"], 0)],
  },
  KillSwitchLineSchema: {
    schema: protocol.KillSwitchLineSchema,
    valid: [killSwitchLine],
    invalid: [bad(killSwitchLine, ["action"], "panic")],
  },
  OperatorLineSchema: {
    schema: protocol.OperatorLineSchema,
    valid: [
      operatorLine,
      { ...operatorLine, action: "abort", signal: "SIGTERM" },
      { ...operatorLine, action: "exit", signal: "SIGHUP" },
    ],
    invalid: [bad(operatorLine, ["signal"], "")],
  },
  CarryLineSchema: {
    schema: protocol.CarryLineSchema,
    valid: [carryLine, { ...carryLine, inFlightNanoUsd: 2200000000 }],
    invalid: [bad(carryLine, ["costNanoUsd"], -1), bad(carryLine, ["inFlightNanoUsd"], -1)],
  },
  PauseLineSchema: {
    schema: protocol.PauseLineSchema,
    valid: [pauseLine],
    invalid: [bad(pauseLine, ["outcome"], "paused")],
  },
  WakeCapLineSchema: {
    schema: protocol.WakeCapLineSchema,
    valid: [wakeCapLine],
    invalid: [bad(wakeCapLine, ["seat"], "p0")],
  },
  LlmLogLineSchema: {
    schema: protocol.LlmLogLineSchema,
    valid: [
      llmCallLine,
      handoffLine,
      pauseLine,
      wakeCapLine,
      preflightLine,
      promptCapLine,
      killSwitchLine,
      operatorLine,
      carryLine,
    ],
    invalid: [bad(handoffLine, ["k"], "reply"), bad(wakeCapLine, ["turn"], -1)],
  },
  ReplyLineSchema: {
    schema: protocol.ReplyLineSchema,
    valid: [replyLine, { ...replyLine, kind: "thought_call", calls: [], text: ["Hold."] }],
    invalid: [
      bad(replyLine, ["attempt"], 0),
      bad(replyLine, ["reasoning", 0], 1),
      bad(replyLine, ["calls", 0, "name"], 7),
      extra(replyLine, []),
    ],
  },
  ProfileSchema: {
    schema: protocol.ProfileSchema,
    valid: [profile],
    invalid: [bad(profile, ["id"], "Odysseus"), bad(profile, ["version"], 0)],
  },
  FallbacksSchema: {
    schema: protocol.FallbacksSchema,
    valid: ["default", "off"],
    invalid: [{ value: "on", path: [] }],
  },
  SeatsFileSchema: {
    schema: protocol.SeatsFileSchema,
    valid: [
      seatsFile,
      {
        ...seatsFile,
        lineup: "claude-duo",
        estimateSha256: SHA,
        promptCapTokens: 160000,
        budgetNanoUsd: 55000000000,
        seats: [{ ...seatsFile.seats[0], fallbacks: "off" }, seatsFile.seats[1]],
      },
      {
        ...seatsFile,
        lineup: "mid-tier",
        priceDate: "2026-10-19",
        seats: [
          {
            ...seatsFile.seats[0],
            provider: "fake",
            model: "z-ai/glm-5.3",
            intended: { provider: "openrouter", model: "z-ai/glm-5.3", endpoint: "z-ai/fp8" },
            endpoint: "z-ai/fp8",
            quantization: "fp8",
            promptVariant: "envelope",
            reminders: "last-round",
            sharedHash: SHA,
            toolsHash: SHA,
            operatorHash: SHA,
          },
          { ...seatsFile.seats[0], seat: "p2", reasoningContext: "all_turns" },
        ],
      },
    ],
    invalid: [
      bad(seatsFile, ["seats", 0, "effort"], "huge"),
      bad(seatsFile, ["seats", 1, "kind"], "human"),
      bad(seatsFile, ["seats", 0, "fallbacks"], "on"),
      bad(seatsFile, ["promptCapTokens"], 0),
      bad(seatsFile, ["seats", 0, "promptVariant"], "whisper"),
      bad(seatsFile, ["seats", 0, "reminders"], "never"),
      bad(seatsFile, ["seats", 0, "reasoningContext"], "some_turns"),
      {
        value: withAt(seatsFile, ["seats", 0, "intended"], {
          provider: "openai",
          model: "gpt-6-luna",
        }),
        path: ["seats", 0, "intended", "endpoint"],
      },
    ],
  },
  ArenaStatusSchema: {
    schema: protocol.ArenaStatusSchema,
    valid: ["running", "degraded", "incomplete"],
    invalid: [{ value: "loading", path: [] }],
  },
  ArenaSeatReportSchema: {
    schema: protocol.ArenaSeatReportSchema,
    valid: [seatReport],
    invalid: [bad(seatReport, ["costNanoUsd"], -1), bad(seatReport, ["thinkMs", "p95"], 1.5)],
  },
  ExitEventSchema: {
    schema: protocol.ExitEventSchema,
    valid: [exitEvent],
    invalid: [bad(exitEvent, ["type"], "pact_signed")],
  },
  ExitCriterionSchema: {
    schema: protocol.ExitCriterionSchema,
    valid: [exitCriterion],
    invalid: [bad(exitCriterion, ["llm", "met"], "no")],
  },
  ArenaBudgetSchema: {
    schema: protocol.ArenaBudgetSchema,
    valid: [
      arenaBudget,
      {
        ...arenaBudget,
        budgetNanoUsd: null,
        killAtNanoUsd: null,
        under: null,
        estimate: null,
        withinPrediction: null,
      },
    ],
    invalid: [bad(arenaBudget, ["onBudget"], "panic"), bad(arenaBudget, ["actualNanoUsd"], -1)],
  },
  Exit4Schema: {
    schema: protocol.Exit4Schema,
    valid: [exit4, { ...exit4, reconciled: true, models: 2, withinPrediction: true, met: true }],
    invalid: [bad(exit4, ["met"], null), bad(exit4, ["models"], -1)],
  },
  ArenaReportSchema: {
    schema: protocol.ArenaReportSchema,
    valid: [arenaReport],
    invalid: [
      bad(arenaReport, ["format"], "perfidia-arena/1"),
      bad(arenaReport, ["status"], "loading"),
      bad(arenaReport, ["seats", 0, "seat"], "x1"),
      bad(arenaReport, ["exit4", "ended"], "yes"),
    ],
  },
  ArenaSeatReportV1Schema: {
    schema: protocol.ArenaSeatReportV1Schema,
    valid: [arenaReportV1.seats[0], { ...arenaReportV1.seats[0], handoff: null }],
    invalid: [
      extra(arenaReportV1.seats[0], []),
      // A phase-4 hand-off (with its reason) is not a phase-2 one.
      { value: withAt(arenaReportV1.seats[0], ["handoff", "reason"], "cap"), path: ["handoff"] },
    ],
  },
  // The phase-2 and phase-3 cases of `ArenaReportSchema` (ec8e2ad), now this schema's.
  ArenaReportV1Schema: {
    schema: protocol.ArenaReportV1Schema,
    valid: [arenaReportV1],
    invalid: [
      bad(arenaReportV1, ["format"], "perfidia-arena/2"),
      bad(arenaReportV1, ["status"], "loading"),
      bad(arenaReportV1, ["seats", 0, "seat"], "x1"),
      { value: { ...arenaReportV1, budget: arenaBudget }, path: [] },
    ],
  },
  ArenaReportAnySchema: {
    schema: protocol.ArenaReportAnySchema,
    valid: [arenaReport, arenaReportV1],
    invalid: [
      bad(arenaReport, ["format"], "perfidia-arena/3"),
      bad(arenaReportV1, ["status"], "loading"),
    ],
  },
  PredictionSourceSchema: {
    schema: protocol.PredictionSourceSchema,
    valid: ["calibrated", "measured-point", "scenario"],
    invalid: [{ value: "guess", path: [] }],
  },
  EstimateFileSchema: {
    schema: protocol.EstimateFileSchema,
    valid: [
      estimateFile,
      { ...estimateFile, lineup: null, budget: null, days: 1 },
      {
        ...estimateFile,
        priceAt: "2026-10-19T00:00:00.000Z",
        seats: estimateFile.seats.map((x) => ({ ...x, endpoint: "z-ai/fp8" })),
      },
    ],
    invalid: [
      bad(estimateFile, ["seats", 0, "endpoint"], ""),
      bad(estimateFile, ["format"], "perfidia-estimate/0"),
      bad(estimateFile, ["seats", 0, "source"], "guess"),
      bad(estimateFile, ["match", "high"], -1),
    ],
  },
  LineupSeatSchema: {
    schema: protocol.LineupSeatSchema,
    valid: [lineup.seats[0], lineup.seats[1]],
    invalid: [
      bad(lineup.seats[0], ["profile"], "odysseus"),
      bad(lineup.seats[0], ["provider"], "acme"),
      bad(lineup.seats[1], ["label"], "opportunist@3"),
    ],
  },
  LineupSchema: {
    schema: protocol.LineupSchema,
    valid: [lineup],
    invalid: [
      bad(lineup, ["budgetUsd"], "55 USD"),
      bad(lineup, ["reminders"], "never"),
      bad(lineup, ["seats", 0, "capUsd"], "-1"),
      extra(lineup, []),
    ],
  },
  ReconcileInputSchema: {
    schema: protocol.ReconcileInputSchema,
    valid: [reconcileInput],
    invalid: [
      bad(reconcileInput, ["providers", 0, "usd"], "12,34"),
      bad(reconcileInput, ["providers"], []),
    ],
  },
  ReconcileFileSchema: {
    schema: protocol.ReconcileFileSchema,
    valid: [
      reconcileFile,
      withAt(reconcileFile, ["providers", 0, "tokens", 0, "estimated"], 15000),
    ],
    invalid: [
      bad(reconcileFile, ["providers", 0, "tokens", 0, "kind"], "thinking"),
      bad(reconcileFile, ["providers", 0, "tokens", 0, "estimated"], -1),
    ],
  },
  ProviderSchema: {
    schema: protocol.ProviderSchema,
    valid: ["anthropic", "openai", "google", "openrouter", "compat", "fake"],
    invalid: [{ value: "acme", path: [] }],
  },
  PromptVariantSchema: {
    schema: protocol.PromptVariantSchema,
    valid: ["system", "developer", "envelope"],
    invalid: [{ value: "whisper", path: [] }],
  },
  ReminderCadenceSchema: {
    schema: protocol.ReminderCadenceSchema,
    valid: ["every-round", "last-round"],
    invalid: [{ value: "never", path: [] }],
  },
  ReasoningContextSchema: {
    schema: protocol.ReasoningContextSchema,
    valid: ["auto", "current_turn", "all_turns"],
    invalid: [{ value: "some_turns", path: [] }],
  },
  TokenProfileSchema: {
    schema: protocol.TokenProfileSchema,
    valid: [
      tokenProfile,
      { ...tokenProfile, seatDays: [], briefingGrowth: [] },
      withAt(tokenProfile, ["seatDays", 0, "wakes", 0, "rounds", 0, "cacheWriteTokens"], 1500),
    ],
    invalid: [
      bad(tokenProfile, ["format"], "perfidia-profile/0"),
      bad(tokenProfile, ["key", "rulesetMajor"], "perfidia-1@1.1.0"),
      bad(tokenProfile, ["seatDays", 0, "wakes", 0, "rounds"], []),
      bad(tokenProfile, ["key", "promptVariant"], "whisper"),
      bad(tokenProfile, ["seatDays", 0, "wakes", 0, "rounds", 0, "cacheWriteTokens"], -1),
      extra(tokenProfile, []),
    ],
  },
  SeriesManifestSchema: {
    schema: protocol.SeriesManifestSchema,
    valid: [seriesManifest, { ...seriesManifest, matches: [] }],
    invalid: [
      bad(seriesManifest, ["format"], "perfidia-series/0"),
      bad(seriesManifest, ["matches", 1, "status"], "queued"),
      bad(seriesManifest, ["models", 0, "effort"], "huge"),
      bad(seriesManifest, ["positions"], []),
      extra(seriesManifest, ["matches", 0]),
    ],
  },
};

// Spectator formats -------------------------------------------------------------------------------

const base: { t: number; players: ("p1" | "p2")[]; importance: number } = {
  t: 3600,
  players: ["p1", "p2"],
  importance: 1,
};

const context = {
  messages: [{ item: "12:0", t: 3600, text: "we stand together" }],
  thoughts: [{ turn: 4, t: 3500, text: "p1 is weak" }],
  since: 1800,
};

/** One feed item of every kind. */
export const ITEMS: Record<FeedItem["k"], FeedItem> = {
  message: {
    k: "message",
    id: "12:0",
    ...base,
    message: "g0k4qz",
    from: "p1",
    to: ["p2"],
    private: true,
    text: "Line one\nline two",
    turn: 3,
  },
  proposal: {
    k: "proposal",
    id: "13:0",
    ...base,
    proposal: "q0k4qz",
    from: "p1",
    to: "p2",
    kind: "alliance",
    name: "League p1",
    text: "join me",
    until: null,
    expiresAt: 7200,
  },
  answer: {
    k: "answer",
    id: "14:0",
    ...base,
    proposal: "q0k4qz",
    from: "p1",
    to: "p2",
    kind: "alliance",
    accept: true,
  },
  expired: {
    k: "expired",
    id: "15:0",
    ...base,
    proposal: "q0k4qz",
    from: "p1",
    to: "p2",
    kind: "pact",
  },
  diplomacy: {
    k: "diplomacy",
    id: "16:0",
    ...base,
    importance: 2,
    event: "alliance_formed",
    alliance: "a1",
    name: "League p1",
    cause: null,
    expiresAt: null,
  },
  betrayal: {
    k: "betrayal",
    id: "17:0",
    ...base,
    importance: 3,
    by: "p2",
    against: "p1",
    relation: "ally",
    city: "c3",
    context,
  },
  launch: {
    k: "launch",
    id: "18:0",
    ...base,
    importance: 3,
    movement: "m0k4qz",
    kind: "attack",
    owner: "p2",
    from: "c2",
    to: "c1",
    toIsland: "i1",
    target: "p1",
    departAt: 3600,
    arriveAt: 9000,
    units: { hoplite: 10 },
    pop: 10,
    settlers: false,
    foe: "p1",
    againstAlly: "ally",
    context,
  },
  battle: {
    k: "battle",
    id: "19:0",
    ...base,
    city: "c1",
    attacker: "p2",
    defender: "neutral",
    kind: "city",
    winner: "attacker",
    reports: ["r0k4qz"],
    siege: "started",
    fell: false,
  },
  siege: {
    k: "siege",
    id: "20:0",
    ...base,
    importance: 2,
    event: "started",
    city: "c1",
    owner: null,
    by: "p2",
    endsAt: 30000,
    cause: null,
  },
  conquest: {
    k: "conquest",
    id: "21:0",
    ...base,
    importance: 3,
    city: "c1",
    from: "p1",
    to: "p2",
    prize: false,
  },
  founding: {
    k: "founding",
    id: "22:0",
    ...base,
    importance: 0,
    city: "c9",
    island: "i4",
    slot: 1,
    owner: "p1",
  },
  spy: {
    k: "spy",
    id: "23:0",
    ...base,
    importance: 0,
    event: "spy_report",
    city: "c1",
    by: "p2",
    report: "r0k4qz",
  },
  elimination: { k: "elimination", id: "24:0", ...base, importance: 3, player: "p1" },
  countdown: {
    k: "countdown",
    id: "25:0",
    ...base,
    importance: 3,
    event: "started",
    key: "a1",
    members: ["p1", "p2"],
    cities: 16,
    taken: 2,
    need: 16,
    needTaken: 2,
    endsAt: 90000,
    reason: null,
  },
  event: {
    k: "event",
    id: "26:0",
    ...base,
    type: "storm_warning",
    data: { island: "i3" },
  },
  turn: {
    k: "turn",
    id: "27:0",
    ...base,
    seat: "p1",
    turn: 3,
    llm: true,
    wakeT: 3500,
    reasons: ["message g0k4qz"],
    urgent: false,
    why: "end_turn",
    rounds: 2,
    calls: 4,
    accepted: 3,
    rejected: [{ code: "INVALID_ARGS", count: 1 }],
    messages: ["g0k4qz"],
    thought: "Hold the line.",
    results: [
      { rt: 0, tool: "view_map", items: 1, ok: 1, codes: [] },
      { rt: 1, tool: "send_message", items: 1, ok: 1, codes: [] },
      { rt: 1, tool: "batch", items: 3, ok: 2, codes: ["INVALID_ARGS"] },
      { rt: null, tool: "write_note", items: 1, ok: 1, codes: [] },
    ],
  },
  handoff: {
    k: "handoff",
    id: "28:0",
    ...base,
    importance: 2,
    seat: "p1",
    label: "bot:turtle@3",
    from: "llm:fake/claude-opus-5-5/medium:odysseus@1:p2",
  },
  end: {
    k: "end",
    id: "29:0",
    ...base,
    importance: 3,
    reason: "domination",
    winners: ["p1", "p2"],
  },
};

const cityEnt: CityEnt = {
  id: "c1",
  name: "c1",
  owner: "p1",
  island: "i1",
  slot: 0,
  capitalOf: "p1",
  tag: null,
  buildings: { acropolis: 1 },
  units: { hoplite: 10 },
  stationed: [{ owner: "p2", home: "c2", role: "support", units: { hoplite: 2 } }],
  stock: { wood: 800, stone: 800, gold: 800 },
  stockAt: 0,
  perHour: { wood: 20, stone: 20, gold: 20 },
  cap: 280,
  pop: { used: 13, cap: 20 },
  ext: { points: 101 },
};

const buildItem: QueueEnt = {
  city: "c1",
  item: 3,
  queue: "build",
  building: "acropolis",
  level: 2,
  unit: null,
  count: null,
  done: null,
  start: 0,
  end: 1800,
};
const recruitItem: QueueEnt = {
  city: "c1",
  item: 4,
  queue: "barracks",
  building: null,
  level: null,
  unit: "hoplite",
  count: 3,
  done: 1,
  start: 0,
  end: 900,
};

const movementEnt: MovementEnt = {
  id: "m0k4qz",
  kind: "return",
  owner: "p2",
  home: "c2",
  from: "c2",
  fromIsland: "i2",
  to: "c2",
  toIsland: "i2",
  party: "p1",
  units: { hoplite: 10 },
  cargo: { wood: 0, stone: 0, gold: 0 },
  gold: 0,
  departAt: 5000,
  arriveAt: 6400,
  back: { kind: "attack", at: 5000 },
  turnedAt: { t: 5000, x: 120, y: -40 },
};

const playerEnt: PlayerEnt = {
  id: "p1",
  alive: true,
  eliminatedAt: null,
  alliance: "a1",
  rank: 1,
  score: 100,
  parts: { cityPoints: 100 },
  cities: 1,
  relations: [{ player: "p2", kind: "pact", until: null }],
  army: { pop: 10, units: { hoplite: 10 } },
  ext: { tiebreak: 1 },
};

const seatEnt: SeatEnt = {
  seat: "p1",
  controller: "bot:turtle@3",
  inTurn: true,
  turn: 4,
  round: 2,
  wakeT: 3500,
  reasons: ["start"],
  urgent: false,
  next: null,
  lastThought: { turn: 3, t: 3000, text: "Hold." },
  notesChars: 12,
  handoff: null,
};

/** A frame with one entity of each collection. */
export const FRAME: Frame = {
  format: "perfidia-spectator/1",
  match: "perfidia-1@1.1.0-s1-6p-1d-lockstep",
  timeline: "0123456789abcdef",
  seq: 0,
  t: 0,
  status: "live",
  result: null,
  ext: { domination: { open: false } },
  cities: { c1: structuredClone(cityEnt) },
  queues: { "c1#3": structuredClone(buildItem), "c1#4": structuredClone(recruitItem) },
  movements: { m0k4qz: structuredClone(movementEnt) },
  players: { p1: structuredClone(playerEnt) },
  seats: { p1: structuredClone(seatEnt) },
  alliances: { a1: { id: "a1", name: "League p1", members: ["p1"], formedAt: 600 } },
  pacts: [{ a: "p1", b: "p2", since: 0, expiresAt: null }],
  proposals: [
    {
      id: "q0k4qz",
      from: "p1",
      to: "p2",
      kind: "pact",
      name: null,
      until: null,
      expiresAt: 7200,
    },
  ],
};

const patch: Patch = {
  cities: { c1: structuredClone(cityEnt), c2: null },
  cityFields: { c3: { stock: { wood: 1, stone: 2, gold: 3 }, stockAt: 3600 } },
  queues: { "c1#5": structuredClone(buildItem), "c1#3": null },
  queueFields: { "c1#4": { done: 2 } },
  seatFields: { p1: { round: 3 } },
  movements: { m0k4qz: null },
  status: "ended",
  result: { reason: "time", winners: ["p1"] },
};

const step: Step = { seq: 12, t: 3600, patch, items: [ITEMS.message, ITEMS.turn] };

const moment: Moment = {
  item: "17:0",
  seq: 17,
  t: 3600,
  k: "betrayal",
  importance: 3,
  title: "p2 betrayed its ally p1 at c3",
  players: ["p2", "p1"],
  cities: ["c3"],
  context,
};

const annotation: TurnAnnotation = {
  seat: "p1",
  turn: 3,
  complete: true,
  rounds: [
    {
      round: 0,
      kind: "round",
      attempts: 1,
      stop: "tool_use",
      refusal: null,
      errors: [],
      reasoning: ["thinking"],
      text: [],
      calls: ["view_map"],
      costNanoUsd: 1000,
      tokens: { input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 2, output: 3 },
      latencyMs: 10,
    },
  ],
  spentNanoUsd: 1000,
  capNanoUsd: null,
};

const seatInfo: SeatInfo = {
  seat: "p1",
  kind: "llm",
  name: "Odysseus",
  label: "llm:fake/claude-opus-5-5/medium:odysseus@1:p2",
  color: 0,
  fake: true,
  model: { provider: "fake", model: "claude-opus-5-5", effort: "medium" },
  profile: {
    id: "odysseus",
    version: 1,
    name: "Odysseus",
    goal: "win",
    temperament: "calm",
    word: "flexible",
    style: "terse",
  },
  handoffBot: "bot:opportunist@3",
};

const map: SpectatorMap = {
  width: 600,
  height: 600,
  islands: [{ id: "i1", kind: "olympus", x: 300, y: 300, slots: 1, richnessPm: 1500 }],
};

const meta: MatchMeta = {
  format: "perfidia-spectator/1",
  id: "war",
  title: "War",
  description: null,
  ruleset: "perfidia-1@1.1.0",
  engine: "0.1.0",
  configHash: SHA,
  rulesHash: SHA,
  config: {},
  clock: { kind: "lockstep", maxTurnsPerSecond: 3 },
  matchEnd: 604800,
  seats: [seatInfo],
  map,
  status: "live",
  reason: null,
  wallStart: null,
  lastSeq: 0,
  lastT: 0,
  logId: SHA,
  timeline: "0123456789abcdef",
  keyframes: [0],
  verified: { ok: true, divergence: null },
  published: { costs: true, reasoning: true },
};

const listItem: MatchListItem = {
  id: "war",
  title: "War",
  status: "ended",
  reason: "domination",
  ruleset: "perfidia-1@1.1.0",
  players: 6,
  lastT: 498807,
  day: 6,
  leader: "p4",
  winners: ["p1", "p4"],
  featured: true,
  seats: [{ seat: "p1", name: "Odysseus", kind: "llm", model: null, fake: false }],
};

const dossier: PlayerDossier = {
  seat: seatInfo,
  notes: "plan: grow",
  counts: { turns: 3, messagesSent: 1, messagesReceived: 2 },
  spentNanoUsd: null,
  capNanoUsd: null,
  handoff: null,
  hourly: [
    { t: 3600, score: 120, cities: 1 },
    { t: 7200, score: 135, cities: 2 },
  ],
  notebook: {
    total: 3,
    versions: [
      { t: 3000, turn: 2, mode: "replace", head: 0, tail: 0, text: "plan" },
      { t: 5400, turn: 3, mode: "append", head: 4, tail: 0, text: ": grow" },
    ],
  },
};

const report: ReportDetail = {
  report: "r0k4qz",
  seq: 850,
  t: 54001,
  type: "battle_report",
  city: "c10",
  recipient: "p1",
  data: { winner: "attacker" },
  copies: ["rbbm82"],
};

export const SPECTATOR_CASES: Record<string, SchemaCase> = {
  MatchIdSchema: {
    schema: protocol.MatchIdSchema,
    valid: ["perfidia-1@1.1.0-s1-6p-1d-lockstep", "war", "a.b_c"],
    invalid: [
      { value: "../etc", path: [] },
      { value: ".hidden", path: [] },
      { value: "x".repeat(129), path: [] },
      { value: "a/b", path: [] },
    ],
  },
  TimelineIdSchema: {
    schema: protocol.TimelineIdSchema,
    valid: ["0123456789abcdef"],
    invalid: [{ value: "0123456789ABCDEF", path: [] }],
  },
  SeqSchema: {
    schema: protocol.SeqSchema,
    valid: [0, 16252],
    invalid: [{ value: -1, path: [] }],
  },
  MatchStatusSchema: {
    schema: protocol.MatchStatusSchema,
    valid: [...protocol.MATCH_STATUSES],
    invalid: [{ value: "running", path: [] }],
  },
  PublicReasonSchema: {
    schema: protocol.PublicReasonSchema,
    valid: ["domination", "unverifiable"],
    invalid: [{ value: "the operator paused it", path: [] }],
  },
  SeatInfoSchema: {
    schema: protocol.SeatInfoSchema,
    valid: [
      seatInfo,
      { ...seatInfo, kind: "bot", model: null, profile: null, handoffBot: null },
      {
        ...seatInfo,
        label: "llm:openrouter/z-ai%2Fglm-5.3@z-ai%2Ffp8/medium:agamemnon@1:p2-env",
        fake: false,
        model: {
          provider: "openrouter",
          model: "z-ai/glm-5.3",
          effort: "medium",
          endpoint: "z-ai/fp8",
        },
      },
    ],
    invalid: [
      bad(seatInfo, ["color"], 12),
      { value: withAt(seatInfo, ["profile", "handoffBot"], "bot:turtle@3"), path: ["profile"] },
      extra(seatInfo, []),
    ],
  },
  SpectatorMapSchema: {
    schema: protocol.SpectatorMapSchema,
    valid: [map],
    invalid: [bad(map, ["islands", 0, "id"], "c1")],
  },
  MatchMetaSchema: {
    schema: protocol.MatchMetaSchema,
    valid: [meta, { ...meta, published: { costs: false, reasoning: false } }],
    invalid: [
      bad(meta, ["id"], "../etc"),
      bad(meta, ["reason"], "operator text"),
      bad(meta, ["timeline"], "xyz"),
      bad(meta, ["published", "costs"], "yes"),
      extra(meta, ["published"]),
      extra(meta, []),
    ],
  },
  TurnCallSchema: {
    schema: protocol.TurnCallSchema,
    valid: [
      { rt: 0, tool: "view_map", items: 1, ok: 1, codes: [] },
      { rt: null, tool: "write_note", items: 1, ok: 1, codes: [] },
      { rt: 2, tool: "batch", items: 4, ok: 0, codes: ["INVALID_ARGS", "NOT_ENOUGH"] },
    ],
    invalid: [
      { value: { rt: 0, tool: "x", items: 0, ok: 0, codes: [] }, path: ["items"] },
      { value: { rt: -1, tool: "x", items: 1, ok: 1, codes: [] }, path: ["rt"] },
      { value: { rt: 0, tool: "x", items: 1, ok: 1, codes: [], args: {} }, path: [] },
    ],
  },
  CityEntSchema: {
    schema: protocol.CityEntSchema,
    valid: [cityEnt],
    invalid: [
      bad(cityEnt, ["stock", "wood"], -1),
      bad(cityEnt, ["pop", "used"], -1),
      extra(cityEnt, []),
    ],
  },
  QueueKeySchema: {
    schema: protocol.QueueKeySchema,
    valid: ["c3#7", "c12#120"],
    invalid: [
      { value: "c3", path: [] },
      { value: "c3#0", path: [] },
      { value: "p3#7", path: [] },
    ],
  },
  QueueEntSchema: {
    schema: protocol.QueueEntSchema,
    valid: [buildItem, recruitItem],
    invalid: [bad(buildItem, ["item"], 0), bad(recruitItem, ["done"], -1), extra(buildItem, [])],
  },
  MovementEntSchema: {
    schema: protocol.MovementEntSchema,
    valid: [movementEnt, { ...movementEnt, back: null, turnedAt: null }],
    invalid: [
      bad(movementEnt, ["turnedAt", "x"], 1.5),
      { value: withAt(movementEnt, ["seq"], 3), path: [] },
    ],
  },
  PlayerEntSchema: {
    schema: protocol.PlayerEntSchema,
    valid: [playerEnt],
    invalid: [bad(playerEnt, ["relations", 0, "kind"], "enemy"), bad(playerEnt, ["rank"], 0)],
  },
  SeatEntSchema: {
    schema: protocol.SeatEntSchema,
    valid: [seatEnt],
    invalid: [
      { value: withAt(seatEnt, ["next"], { at: 1, kind: "never" }), path: ["next", "kind"] },
      extra(seatEnt, []),
    ],
  },
  FrameSchema: {
    schema: protocol.FrameSchema,
    valid: [FRAME],
    invalid: [
      bad(FRAME, ["format"], "perfidia-spectator/0"),
      bad(FRAME, ["cities", "c1", "owner"], "nobody"),
      { value: withAt(FRAME, ["pacts", 0, "seq"], 3), path: ["pacts", 0] },
      extra(FRAME, []),
    ],
  },
  PatchSchema: {
    schema: protocol.PatchSchema,
    valid: [patch, {}],
    invalid: [
      bad(patch, ["status"], "running"),
      bad(patch, ["cityFields", "c3", "stockAt"], -1),
      { value: withAt(patch, ["seatFields", "p1", "seed"], 1), path: ["seatFields", "p1"] },
      extra(patch, []),
    ],
  },
  FeedItemSchema: {
    schema: protocol.FeedItemSchema,
    valid: Object.values(ITEMS),
    invalid: [
      bad(ITEMS.message, ["id"], "a:b"),
      bad(ITEMS.betrayal, ["context", "since"], -1),
      bad(ITEMS.launch, ["againstAlly"], "enemy"),
      bad(ITEMS.launch, ["foe"], "neutral"),
      bad(ITEMS.turn, ["importance"], 4),
      bad(ITEMS.turn, ["results", 0, "ok"], -1),
      extra(ITEMS.turn, ["results", 0]),
    ],
  },
  FeedKindSchema: {
    schema: protocol.FeedKindSchema,
    valid: [...protocol.FEED_KINDS],
    invalid: [{ value: "rumour", path: [] }],
  },
  StepSchema: {
    schema: protocol.StepSchema,
    valid: [step, { seq: 3, t: 0 }],
    invalid: [bad(step, ["seq"], -1), bad(step, ["items", 0, "k"], "rumour")],
  },
  MomentSchema: {
    schema: protocol.MomentSchema,
    valid: [moment],
    invalid: [bad(moment, ["k"], "rumour"), bad(moment, ["cities", 0], "p1")],
  },
  TurnAnnotationSchema: {
    schema: protocol.TurnAnnotationSchema,
    valid: [
      annotation,
      {
        ...annotation,
        rounds: annotation.rounds.map((r) => ({ ...r, reasoningKind: "raw" as const })),
      },
    ],
    invalid: [
      bad(annotation, ["rounds", 0, "kind"], "batch"),
      bad(annotation, ["rounds", 0, "tokens", "output"], -1),
    ],
  },
  MatchListItemSchema: {
    schema: protocol.MatchListItemSchema,
    valid: [listItem],
    invalid: [
      bad(listItem, ["day"], 0),
      { value: withAt(listItem, ["seats", 0, "label"], "x"), path: ["seats", 0] },
    ],
  },
  StepsPageSchema: {
    schema: protocol.StepsPageSchema,
    valid: [{ from: -1, to: 12, steps: [step], lastSeq: 16252, more: true }],
    invalid: [{ value: { from: -2, to: 0, steps: [], lastSeq: 0, more: false }, path: ["from"] }],
  },
  FeedPageSchema: {
    schema: protocol.FeedPageSchema,
    valid: [{ items: [{ seq: 12, item: ITEMS.message }], more: false }],
    invalid: [
      {
        value: { items: [{ seq: -1, item: ITEMS.message }], more: false },
        path: ["items", 0, "seq"],
      },
    ],
  },
  PlayerDossierSchema: {
    schema: protocol.PlayerDossierSchema,
    valid: [dossier, { ...dossier, hourly: [], notebook: { total: 0, versions: [] } }],
    invalid: [
      bad(dossier, ["counts", "turns"], -1),
      bad(dossier, ["hourly", 0, "cities"], -1),
      extra(dossier, ["hourly", 1]),
      bad(dossier, ["notebook", "versions", 1, "mode"], "rewrite"),
      bad(dossier, ["notebook", "versions", 0, "head"], -1),
      extra(dossier, ["notebook", "versions", 0]),
      bad(dossier, ["notebook", "total"], undefined),
    ],
  },
  ReportDetailSchema: {
    schema: protocol.ReportDetailSchema,
    valid: [report],
    invalid: [bad(report, ["copies", 0], "r1"), bad(report, ["city"], "i1")],
  },
  HealthSchema: {
    schema: protocol.HealthSchema,
    valid: [{ ok: true, version: "0.1.0", format: "perfidia-spectator/1", uptimeS: 3, folding: 0 }],
    invalid: [
      {
        value: { ok: true, version: "0.1.0", format: "x", uptimeS: 3, folding: 0 },
        path: ["format"],
      },
    ],
  },
  ApiErrorSchema: {
    schema: protocol.ApiErrorSchema,
    valid: [{ ok: false, code: "UNKNOWN_MATCH", message: "no match x", hint: "list /api/matches" }],
    invalid: [{ value: { ok: true, code: "X", message: "m", hint: "h" }, path: ["ok"] }],
  },
  ClientMsgSchema: {
    schema: protocol.ClientMsgSchema,
    valid: [
      { type: "subscribe", match: "war", timeline: "0123456789abcdef", after: 12 },
      { type: "ping", n: 1 },
    ],
    invalid: [
      {
        value: { type: "subscribe", match: "war", timeline: "0123456789abcdef", after: -1 },
        path: ["after"],
      },
    ],
  },
  ServerMsgSchema: {
    schema: protocol.ServerMsgSchema,
    valid: [
      { type: "hello", format: "perfidia-spectator/1" },
      { type: "steps", match: "war", timeline: "0123456789abcdef", from: 0, to: 12, steps: [step] },
      { type: "status", match: "war", status: "stalled", reason: null },
      { type: "clock", match: "war", t: 3600, speed: [3, 1], cap: 7200 },
      {
        type: "annot",
        match: "war",
        seat: "p1",
        turn: 3,
        round: 0,
        kind: "round",
        reasoning: ["thinking"],
        text: [],
        calls: ["view_map"],
        complete: false,
      },
      { type: "resync", match: "war", reason: "gap" },
      { type: "resync", match: "war", reason: "behind" },
      { type: "error", code: "UNKNOWN_MATCH", message: "no match x" },
      { type: "pong", n: 1 },
    ],
    invalid: [
      {
        value: {
          type: "annot",
          match: "war",
          seat: "p1",
          turn: 3,
          round: 0,
          kind: "reply",
          reasoning: [],
          text: [],
          calls: [],
          complete: false,
        },
        path: ["kind"],
      },
      { value: { type: "resync", match: "war", reason: "boredom" }, path: ["reason"] },
      {
        value: { type: "status", match: "war", status: "running", reason: null },
        path: ["status"],
      },
    ],
  },
};
