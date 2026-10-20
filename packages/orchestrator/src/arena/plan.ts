import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createMatch, type AnyRuleset, type InvariantLevel } from "@perfidia/engine";
import { idKeyFromSeed } from "@perfidia/engine/core";
import { rulesInfo } from "@perfidia/gateway/present";
import { toolDefinitions } from "@perfidia/gateway/runtime";
import { IdKeySchema, type MatchSetup, type PlayerId } from "@perfidia/protocol";
import {
  INVARIANT_LEVELS,
  UsageError,
  checkCreation,
  checkOverrides,
  harness,
  overridesFrom,
  parseBotChoice,
  playerRange,
  randomIdKey,
  rulesetFor,
} from "@perfidia/sim";
import {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  DEFAULT_CAP_NANO_USD,
  DEFAULT_LINEUP,
  DEFAULT_MAX_INFLIGHT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PAUSE_MAX_MS,
  DEFAULT_RETRY_BUDGET_MS,
  DEFAULT_WAKE_CAP_NANO_USD,
  cacheTtlFor,
  lockstepRoundTimeoutMs,
  type SeatSpec,
} from "../defaults.ts";
import { LlmLogLineSchema, type EstimateFile, type Lineup } from "../log/schema.ts";
import { DEFAULT_BASE_URL } from "../model/anthropic.ts";
import {
  DEFAULT_PROMPT_CAP_TOKENS,
  EFFORTS,
  type CacheTtl,
  type Effort,
  type ModelTool,
} from "../model/adapter.ts";
import { requirePrice, usdToNano } from "../model/prices.ts";
import { anthropicTools } from "../model/tools.ts";
import type { SeatPolicy } from "../seat/agent.ts";
import { PROFILES, findProfile, profileRef, type Profile } from "../seat/personalities.ts";
import { seatPrompt, sharedPrompt } from "../seat/prompt.ts";
import { centralWakeNano, loggedSpend } from "./cost.ts";
import {
  budgetCheck,
  estimateFile,
  predict,
  type PlanBudget,
  type Prediction,
} from "./estimate.ts";
import { defaultSeatCap, defaultWakeCap, fallbacksFor, loadLineup } from "./lineup.ts";
import { sampleTokensUpper } from "./preflight.ts";

/** The largest seed. */
const UINT32_MAX = 4_294_967_295;

// The plan of an `arena run` (phase-2 design §8): every flag checked, the lineup resolved (the
// default of §4.4 or a `--lineup` file, then `--seat` overrides), the models priced, the timeouts
// derived, and the environment read once (`PERFIDIA_ANTHROPIC_API_KEY`,
// `PERFIDIA_ANTHROPIC_BASE_URL`; nothing else). Every check runs before any file is written: a bad
// command line is a `UsageError` (exit code 3) and leaves no run directory behind.
//
// Phase 4 (Pass 1a): the plan also holds the prediction (`estimate.json`, written before turn 1),
// the prompt cap, each seat's fallbacks and wake cap, and the match budget: a budget whose kill
// threshold `K = budget − reserve` (less any carry) falls below the predicted low is refused with
// the design's §4.2 message; below the predicted high it is a warning.

/** The environment of the harness: the only variables it reads. */
export interface ArenaEnv {
  readonly apiKey: string | null;
  readonly baseURL: string | null;
  /** `PERFIDIA_LIVE=1`: the opt-in live test only. */
  readonly live: boolean;
}

const KEY_VAR = "PERFIDIA_ANTHROPIC_API_KEY";
const BASE_VAR = "PERFIDIA_ANTHROPIC_BASE_URL";

/** Reads the harness's variables from `env` (the CLI passes the process environment). */
export function arenaEnv(env: Readonly<Record<string, string | undefined>>): ArenaEnv {
  const get = (name: string): string | null => {
    const v = Object.hasOwn(env, name) ? env[name] : undefined;
    return v === undefined || v.trim() === "" ? null : v.trim();
  };
  return { apiKey: get(KEY_VAR), baseURL: get(BASE_VAR), live: get("PERFIDIA_LIVE") === "1" };
}

/** Model aliases of `--seat` (a full `claude-…` id is taken as is). */
export const MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "opus-5-5": "claude-opus-5-5",
  "sonnet-5-5": "claude-sonnet-5-5",
  "haiku-5-5": "claude-haiku-5-5",
});

/**
 * The models a seat may run on: the 5.5 family the request shape is built for (mid-conversation
 * `system` messages, adaptive thinking with `effort`). The other priced models are fallback
 * targets only: Claude Sonnet 5, for one, rejects the operator entries with a 400.
 */
export const SEAT_MODELS: readonly string[] = Object.freeze(Object.values(MODEL_ALIASES));

/** An LLM seat of the plan. */
export interface LlmSeatPlan {
  readonly seat: PlayerId;
  readonly kind: "llm";
  readonly provider: "anthropic";
  readonly model: string;
  readonly effort: Effort;
  readonly profile: Profile;
  readonly capNanoUsd: number;
  /** The seat's per-wake soft cap; `null`: none. */
  readonly wakeCapNanoUsd: number | null;
  /** Anthropic server-side refusal fallbacks (phase 4: `off` by default on Claude Sonnet 5.5). */
  readonly fallbacks: "default" | "off";
  /** The hand-off bot's label, `bot:<strategy>@<n>`. */
  readonly handoffBot: string;
  /** `--fake`: the bot whose rounds the fake model replays (`bot:<strategy>@<n>`). */
  readonly brain: string;
}

export interface BotSeatPlan {
  readonly seat: PlayerId;
  readonly kind: "bot";
  readonly label: string;
}

export type SeatPlan = LlmSeatPlan | BotSeatPlan;

export type ArenaClock =
  | { readonly kind: "lockstep"; readonly roundTimeoutMs: number }
  | {
      readonly kind: "realtime";
      readonly speed: { readonly num: number; readonly den: number };
      /** Per round (the driver's timer). */
      readonly turnTimeoutMs: number;
      /** Bots' think time, ms. */
      readonly botLatencyMs: readonly [number, number];
    };

export interface ArenaPlan {
  readonly ruleset: AnyRuleset;
  readonly setup: MatchSetup;
  readonly seats: readonly SeatPlan[];
  /** Every LLM seat plays a bot-backed fake model: no API, no key, $0. */
  readonly fake: boolean;
  readonly clock: ArenaClock;
  /** `virtual` (tests, `--fake`): wall time is simulated; `system`: real. */
  readonly time: "virtual" | "system";
  readonly policy: SeatPolicy;
  readonly pauseMaxMs: number;
  readonly wakeCapNanoUsd: number | null;
  readonly maxInflight: number;
  readonly maxTokens: number;
  readonly cacheTtl: CacheTtl;
  readonly transcripts: boolean;
  readonly watch: boolean;
  readonly invariants: InvariantLevel;
  readonly snapshotEvery: number;
  /** USD per seat per game day above which a day's spend is an alert (×2), by model; null: the estimate. */
  readonly calibratedNanoUsdPerDay: number | null;
  readonly env: ArenaEnv;
  /** The base URL the client uses (`PERFIDIA_ANTHROPIC_BASE_URL` or the API's). */
  readonly baseURL: string;
  /**
   * `--stop-after N`: the run stops at the end of game day N (game second `N × 86 400`), and the
   * match keeps its full length for the agents (a calibration run plays the real game); `null`:
   * the run plays the match to its end.
   */
  readonly stopAt: number | null;
  /** The lineup id (`--lineup`); null for the default lineup and `--seat`. */
  readonly lineup: string | null;
  /** The prompt cap in tokens (phase 4 §5.2). */
  readonly promptCapTokens: number;
  /** The match budget (a lineup's `budgetUsd` or `--budget-usd`); null: none. */
  readonly budget: PlanBudget | null;
  /** The prediction and reserve of the LLM seats. */
  readonly prediction: Prediction;
  /** `estimate.json`, as `arena run` writes it before turn 1. */
  readonly estimate: EstimateFile;
  /** The shared system block and the tools every seat gets (also the preflight bounds' input). */
  readonly texts: { readonly shared: string; readonly tools: readonly ModelTool[] };
  /** Plan warnings (the kill switch might fire, …), printed before the run starts. */
  readonly warnings: readonly string[];
}

/** What an `arena run` command line asks for, parsed but not yet checked. */
export interface ArenaRequest {
  readonly ruleset?: string | undefined;
  readonly overrides?: readonly string[] | undefined;
  readonly seed?: number | undefined;
  readonly players?: number | undefined;
  readonly days?: number | undefined;
  /** Stop the run at the end of this game day, the match keeping its length (`--stop-after`). */
  readonly stopAfterDays?: number | undefined;
  /** `random` (default), `seed`, or 32 hex characters. */
  readonly idKey?: string | undefined;
  readonly seats?: readonly string[] | undefined;
  readonly brains?: readonly string[] | undefined;
  readonly clock?: string | undefined;
  readonly time?: string | undefined;
  readonly speed?: { readonly num: number; readonly den: number } | undefined;
  readonly turnTimeoutMs?: number | undefined;
  readonly retryBudgetMs?: number | undefined;
  readonly pauseMaxMs?: number | undefined;
  readonly attemptTimeoutMs?: number | undefined;
  readonly botLatencyMs?: readonly [number, number] | undefined;
  readonly capUsd?: string | undefined;
  readonly seatCaps?: readonly string[] | undefined;
  readonly handoffBot?: string | undefined;
  /** `off` disables the per-wake cap. */
  readonly wakeCapUsd?: string | undefined;
  readonly calibratedUsdPerDay?: string | undefined;
  readonly maxInflight?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly cacheTtl?: string | undefined;
  readonly thoughtCall?: string | undefined;
  readonly transcripts?: string | undefined;
  readonly watch?: boolean | undefined;
  readonly fake?: boolean | undefined;
  readonly invariants?: string | undefined;
  readonly snapshotEvery?: number | undefined;
  readonly allowTest?: boolean | undefined;
  /** A preset name or a `perfidia-lineup/1` file (phase 4). */
  readonly lineup?: string | undefined;
  /** The match budget in USD; overrides the lineup's `budgetUsd`. */
  readonly budgetUsd?: string | undefined;
  /** `handoff` (default) or `abort` when the kill switch fires. */
  readonly onBudget?: string | undefined;
  /** A crashed run of the same budget: its logged spend counts toward this run's budget. */
  readonly budgetCarry?: string | undefined;
  /** The prompt cap in tokens (default the lineup's, else 160 000). */
  readonly promptCap?: number | undefined;
}

export const DEFAULT_ARENA_DAYS = 7;
/** Real time: the driver's timer per round. */
export const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
/** Real time: bots' think time (§8). */
export const DEFAULT_BOT_LATENCY_MS: readonly [number, number] = [20_000, 90_000];
/** `--fake --clock realtime`: game-seconds per second when `--speed` is not given. */
export const FAKE_REALTIME_SPEED = { num: 3, den: 1 } as const;
/** The agent's own deadline stops this much before the driver's timer: lockstep, real time. */
export const LOCKSTEP_DEADLINE_MARGIN_MS = 60_000;
export const REALTIME_DEADLINE_MARGIN_MS = 10_000;

const DURATION = /^([0-9]+)(ms|s|m|h)?$/;
const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** The longest timer a runtime keeps (2^31 − 1 ms, about 24.8 days); a longer one fires at once. */
export const MAX_TIMER_MS = 2_147_483_647;

/** `90s`, `5m`, `2h`, `1500ms` or bare milliseconds, as integer milliseconds in 1..`MAX_TIMER_MS`. */
export function parseDuration(text: string, flag: string): number {
  const m = DURATION.exec(text.trim());
  if (m?.[1] === undefined) {
    throw new UsageError(`${flag} must be a duration such as 90s, 5m or 2h, got "${text}"`);
  }
  const ms = Number(m[1]) * (UNIT_MS[m[2] ?? "ms"] ?? 1);
  if (!Number.isSafeInteger(ms) || ms < 1) {
    throw new UsageError(`${flag} must be a positive duration, got "${text}"`);
  }
  if (ms > MAX_TIMER_MS) {
    throw new UsageError(`${flag} must be at most 596h (a timer's limit), got "${text}"`);
  }
  return ms;
}

/** The largest amount a USD flag takes: $1 000 000 (nano-dollars stay exact integers). */
export const MAX_USD_NANO = 1_000_000 * 1_000_000_000;

/** An amount in USD (`100`, `2.5`) as integer nano-dollars; `flag` names it in the error. */
export function parseUsd(text: string, flag: string): number {
  let nano: number;
  try {
    nano = usdToNano(text);
  } catch {
    throw new UsageError(`${flag} must be an amount in USD such as 100 or 2.5, got "${text}"`);
  }
  if (!Number.isSafeInteger(nano) || nano > MAX_USD_NANO) {
    throw new UsageError(`${flag} must be at most 1000000 (USD), got "${text}"`);
  }
  return nano;
}

/** Hosts an `http:` base URL may name: the key never leaves the machine in cleartext. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function botLabelOf(text: string, what: string): string {
  const raw = text.startsWith("bot:") ? text.slice(4) : text;
  try {
    return harness.choiceLabel(parseBotChoice(raw));
  } catch (error) {
    if (error instanceof UsageError) throw new UsageError(`${what}: ${error.message}`);
    throw error;
  }
}

const SEAT_SPEC = /^(p[1-9][0-9]*)=(.+)$/;

function seatOf(text: string, flag: string, players: number): { seat: PlayerId; value: string } {
  const m = SEAT_SPEC.exec(text);
  if (m?.[1] === undefined || m[2] === undefined) {
    throw new UsageError(`${flag} ${text}: write pN=…, such as p3=…`);
  }
  const seat = m[1];
  if (Number(seat.slice(1)) > players) {
    throw new UsageError(`${flag} ${text}: the match has seats p1..p${players}`);
  }
  return { seat: `p${Number(seat.slice(1))}`, value: m[2] };
}

const LLM_SPEC_HELP =
  "write claude:<model>:<effort>:<profile>, such as claude:opus-5-5:medium:odysseus (models: opus-5-5, sonnet-5-5, haiku-5-5 or a full claude-… id)";

/** One `--seat` value: `claude:<model>:<effort>:<profile>` or `bot:<strategy>[@n]`. */
export function parseSeatSpec(seat: PlayerId, value: string): SeatSpec {
  if (value.startsWith("bot:")) {
    return { seat, kind: "bot", label: botLabelOf(value, `--seat ${seat}=${value}`) };
  }
  const parts = value.split(":");
  if (parts[0] !== "claude") {
    throw new UsageError(
      `--seat ${seat}=${value}: a seat is claude:… (an LLM) or bot:… (a scripted bot); ${LLM_SPEC_HELP}`,
    );
  }
  if (parts.length !== 4) throw new UsageError(`--seat ${seat}=${value}: ${LLM_SPEC_HELP}`);
  const [, alias = "", effort = "", profileText = ""] = parts;
  const model = Object.hasOwn(MODEL_ALIASES, alias) ? (MODEL_ALIASES[alias] ?? alias) : alias;
  if (!model.startsWith("claude-")) {
    throw new UsageError(`--seat ${seat}=${value}: unknown model "${alias}"; ${LLM_SPEC_HELP}`);
  }
  if (!SEAT_MODELS.includes(model)) {
    throw new UsageError(
      `--seat ${seat}=${value}: ${model} is not a seat model; a seat runs on ${SEAT_MODELS.join(", ")} (the other priced models are fallback targets only)`,
    );
  }
  const e = EFFORTS.find((x) => x === effort);
  if (e === undefined) {
    throw new UsageError(
      `--seat ${seat}=${value}: effort must be one of ${EFFORTS.join(", ")}, got "${effort}"`,
    );
  }
  const profile = findProfile(profileText);
  if (profile === undefined) {
    throw new UsageError(
      `--seat ${seat}=${value}: unknown profile "${profileText}"; the profiles are ${PROFILES.map(profileRef).join(", ")}`,
    );
  }
  return {
    seat,
    kind: "llm",
    provider: "anthropic",
    model,
    effort: e,
    profile: profileRef(profile),
  };
}

/**
 * The lineup: the base one on seats p1..pN (the default of §4.4, or a lineup file's seats), then
 * the `--seat` overrides.
 */
export function lineupOf(
  texts: readonly string[],
  players: number,
  base: readonly SeatSpec[] = DEFAULT_LINEUP,
): SeatSpec[] {
  const bySeat = new Map<PlayerId, SeatSpec>();
  for (const s of base) {
    if (Number(s.seat.slice(1)) <= players) bySeat.set(s.seat, s);
  }
  const given = new Set<PlayerId>();
  for (const text of texts) {
    const { seat, value } = seatOf(text, "--seat", players);
    if (given.has(seat)) throw new UsageError(`--seat ${seat} is given twice`);
    given.add(seat);
    bySeat.set(seat, parseSeatSpec(seat, value));
  }
  const out: SeatSpec[] = [];
  for (let i = 1; i <= players; i += 1) {
    const seat: PlayerId = `p${i}`;
    const spec = bySeat.get(seat);
    if (spec === undefined) {
      throw new UsageError(
        `${seat} has no controller (the default lineup covers p1..p6): add --seat ${seat}=bot:<strategy> or --seat ${seat}=claude:…`,
      );
    }
    out.push(spec);
  }
  return out;
}

function seatCaps(texts: readonly string[], players: number): Map<PlayerId, number> {
  const out = new Map<PlayerId, number>();
  for (const text of texts) {
    const { seat, value } = seatOf(text, "--seat-cap", players);
    if (out.has(seat)) throw new UsageError(`--seat-cap ${seat} is given twice`);
    out.set(seat, parseUsd(value, `--seat-cap ${seat}`));
  }
  return out;
}

function brainsOf(texts: readonly string[], players: number): Map<PlayerId, string> {
  const out = new Map<PlayerId, string>();
  for (const text of texts) {
    const { seat, value } = seatOf(text, "--brain", players);
    if (out.has(seat)) throw new UsageError(`--brain ${seat} is given twice`);
    out.set(seat, botLabelOf(value, `--brain ${text}`));
  }
  return out;
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
  fallback: T,
): T {
  if (value === undefined) return fallback;
  const v = allowed.find((x) => x === value);
  if (v === undefined) {
    throw new UsageError(`${flag} must be one of ${allowed.join(", ")}, got "${value}"`);
  }
  return v;
}

/** A fresh uint32 seed from the platform's CSPRNG (printed and logged in the header). */
export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

export interface PlanOptions {
  readonly randomSeed?: () => number;
  readonly randomKey?: () => string;
  /** `false`: no API key needed (`arena estimate` plans without sending anything). Default true. */
  readonly requireKey?: boolean;
}

/** What a lineup file adds to one of its LLM seats. */
interface LineupExtras {
  readonly capNanoUsd: number | null;
  readonly wakeCapNanoUsd: number | null;
  readonly handoffBot: string | null;
  readonly fallbacks: "default" | "off" | undefined;
}

/** A lineup file's seats as seat specs, and its per-seat extras (Pass 1a: anthropic seats only). */
function lineupSeats(lineup: Lineup): {
  readonly specs: SeatSpec[];
  readonly extras: Map<PlayerId, LineupExtras>;
} {
  const where = `--lineup ${lineup.id}`;
  if (lineup.reminders !== "every-round") {
    throw new UsageError(
      `${where}: reminders "${lineup.reminders}" arrive with the non-Anthropic seats (phase 4, Pass 1b); this build sends a reminder every round ("every-round")`,
    );
  }
  const specs: SeatSpec[] = [];
  const extras = new Map<PlayerId, LineupExtras>();
  for (const s of lineup.seats) {
    if (s.kind === "bot") {
      specs.push({ seat: s.seat, kind: "bot", label: botLabelOf(s.label, `${where}: ${s.seat}`) });
      continue;
    }
    if (s.provider !== "anthropic") {
      throw new UsageError(
        `${where}: ${s.seat}: provider ${s.provider} is not planned by this build (phase 4 Pass 1a plans anthropic seats; ${s.provider} arrives with its adapter in Pass 2)`,
      );
    }
    if (s.endpoint !== undefined) {
      throw new UsageError(`${where}: ${s.seat}: an endpoint applies to openrouter seats only`);
    }
    const model = Object.hasOwn(MODEL_ALIASES, s.model)
      ? (MODEL_ALIASES[s.model] ?? s.model)
      : s.model;
    if (!SEAT_MODELS.includes(model)) {
      throw new UsageError(
        `${where}: ${s.seat}: ${model} is not a seat model; a seat runs on ${SEAT_MODELS.join(", ")}`,
      );
    }
    if (findProfile(s.profile) === undefined) {
      throw new UsageError(
        `${where}: ${s.seat}: unknown profile "${s.profile}"; the profiles are ${PROFILES.map(profileRef).join(", ")}`,
      );
    }
    specs.push({
      seat: s.seat,
      kind: "llm",
      provider: "anthropic",
      model,
      effort: s.effort ?? lineup.defaults.effort ?? "medium",
      profile: s.profile,
    });
    extras.set(s.seat, {
      capNanoUsd: s.capUsd === undefined ? null : parseUsd(s.capUsd, `${where}: ${s.seat} capUsd`),
      wakeCapNanoUsd:
        s.wakeCapUsd === undefined
          ? null
          : parseUsd(s.wakeCapUsd, `${where}: ${s.seat} wakeCapUsd`),
      handoffBot:
        s.handoffBot === undefined
          ? null
          : botLabelOf(s.handoffBot, `${where}: ${s.seat} handoffBot`),
      fallbacks: fallbacksFor(s.seat, model, s.fallbacks, lineup.defaults.fallbacks),
    });
  }
  return { specs, extras };
}

/**
 * The logged spend of a crashed run (`--budget-carry <dir>`): every cost line of its
 * `llm_calls.jsonl`, its own carry line included.
 */
function carryOf(dir: string): { readonly nanoUsd: number; readonly lines: number } {
  const path = existsSync(dir) && statSync(dir).isDirectory() ? join(dir, "llm_calls.jsonl") : dir;
  if (!existsSync(path)) {
    throw new UsageError(`--budget-carry ${dir}: no llm_calls.jsonl (not an arena run directory)`);
  }
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter((r) => r.trim() !== "");
  const lines = rows.flatMap((r, i) => {
    let raw: unknown;
    try {
      raw = JSON.parse(r);
    } catch {
      // A crash can cut the last line short: it was never complete, so it carries nothing.
      if (i === rows.length - 1) return [];
      throw new UsageError(`--budget-carry ${dir}: line ${i + 1} is not JSON`);
    }
    const parsed = LlmLogLineSchema.safeParse(raw);
    if (!parsed.success) {
      throw new UsageError(`--budget-carry ${dir}: line ${i + 1} is not an LLM log line`);
    }
    return [parsed.data];
  });
  return loggedSpend(lines);
}

/**
 * Checks an arena request completely and returns its plan; throws `UsageError` (exit 3) on
 * anything wrong. With LLM seats and no `--fake`, the API key must be set.
 */
export function planArena(req: ArenaRequest, env: ArenaEnv, o: PlanOptions = {}): ArenaPlan {
  const fake = req.fake ?? false;
  const ruleset = rulesetFor(req.ruleset ?? "perfidia-1", req.allowTest ?? false);
  const overrides = overridesFrom(req.overrides ?? [], req.days);
  // The arena's default length is a week, unless `--override time.matchEnd` sets it.
  if (!Object.hasOwn(overrides, "time.matchEnd")) {
    overrides["time.matchEnd"] = DEFAULT_ARENA_DAYS * 86_400;
  }
  const config = checkOverrides(ruleset, overrides);
  const range = playerRange(ruleset, config);
  const lineup = req.lineup === undefined ? null : loadLineup(req.lineup);
  const fromLineup = lineup === null ? null : lineupSeats(lineup);
  const players = req.players ?? fromLineup?.specs.length ?? DEFAULT_LINEUP.length;
  if (players < range.min || players > range.max) {
    throw new UsageError(
      `--players ${players} is outside the player range of ${ruleset.ref}: ${range.min}..${range.max}`,
    );
  }
  const seed = req.seed ?? (o.randomSeed ?? randomSeed)();
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > UINT32_MAX) {
    throw new UsageError(`--seed must be a uint32, got ${seed}`);
  }
  let idKey: string;
  if (req.idKey === undefined || req.idKey === "random") idKey = (o.randomKey ?? randomIdKey)();
  else if (req.idKey === "seed") idKey = idKeyFromSeed(seed);
  else {
    const parsed = IdKeySchema.safeParse(req.idKey);
    if (!parsed.success) {
      throw new UsageError(
        `--id-key must be 32 lowercase hex characters, "random" or "seed", got "${req.idKey}"`,
      );
    }
    idKey = parsed.data;
  }

  const overridden = new Set((req.seats ?? []).map((t) => seatOf(t, "--seat", players).seat));
  const specs = lineupOf(req.seats ?? [], players, fromLineup?.specs ?? DEFAULT_LINEUP);
  const extrasOf = (seat: PlayerId): LineupExtras | undefined =>
    overridden.has(seat) ? undefined : fromLineup?.extras.get(seat);
  const capFlag = req.capUsd === undefined ? null : parseUsd(req.capUsd, "--cap-usd");
  const caps = seatCaps(req.seatCaps ?? [], players);
  const brains = brainsOf(req.brains ?? [], players);
  const handoffAll =
    req.handoffBot === undefined ? null : botLabelOf(req.handoffBot, "--handoff-bot");
  // Seats first without their caps: the lineup's default caps depend on the prediction.
  const drafts = specs.map((s) => {
    if (s.kind === "bot") {
      if (caps.has(s.seat)) throw new UsageError(`--seat-cap ${s.seat}: ${s.seat} is a bot`);
      if (brains.has(s.seat)) throw new UsageError(`--brain ${s.seat}: ${s.seat} is a bot`);
      return s;
    }
    const profile = findProfile(s.profile);
    if (profile === undefined) throw new UsageError(`${s.seat}: unknown profile ${s.profile}`);
    try {
      requirePrice(s.model);
    } catch (error) {
      throw new UsageError(`${s.seat}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const extras = extrasOf(s.seat);
    const handoffBot =
      handoffAll ??
      extras?.handoffBot ??
      botLabelOf(profile.handoffBot, `${s.seat}'s hand-off bot`);
    return {
      seat: s.seat,
      kind: "llm" as const,
      provider: "anthropic" as const,
      model: s.model,
      effort: s.effort,
      profile,
      handoffBot,
      brain: brains.get(s.seat) ?? handoffBot,
      fallbacks: extras?.fallbacks ?? fallbacksFor(s.seat, s.model, undefined, undefined),
    };
  });
  if (!fake && brains.size > 0) throw new UsageError("--brain applies to --fake runs only");
  const llmDrafts = drafts.flatMap((s) => (s.kind === "llm" ? [s] : []));

  const clockKind = oneOf(req.clock, ["lockstep", "realtime"] as const, "--clock", "lockstep");
  const time = oneOf(
    req.time,
    ["virtual", "system"] as const,
    "--time",
    fake ? "virtual" : "system",
  );
  if (time === "virtual" && !fake) {
    throw new UsageError(
      "--time virtual simulates the clock: it needs --fake (real models answer in real time)",
    );
  }
  const attemptTimeoutMs =
    req.attemptTimeoutMs ??
    (lineup === null ? DEFAULT_ATTEMPT_TIMEOUT_MS : lineup.attemptTimeoutMin * 60_000);
  if (attemptTimeoutMs > MAX_TIMER_MS) {
    throw new UsageError(`--lineup ${lineup?.id ?? ""}: attemptTimeoutMin is over a timer's limit`);
  }
  const promptCapTokens = req.promptCap ?? lineup?.promptCapTokens ?? DEFAULT_PROMPT_CAP_TOKENS;
  const pauseMaxMs = req.pauseMaxMs ?? DEFAULT_PAUSE_MAX_MS;
  const thoughtCall =
    oneOf(req.thoughtCall, ["off", "on"] as const, "--thought-call", "off") === "on";
  let clock: ArenaClock;
  let policy: SeatPolicy;
  if (clockKind === "lockstep") {
    for (const [flag, v] of [
      ["--speed", req.speed],
      ["--turn-timeout", req.turnTimeoutMs],
      ["--bot-latency", req.botLatencyMs],
    ] as const) {
      if (v !== undefined) throw new UsageError(`${flag} applies to --clock realtime only`);
    }
    const retryBudgetMs = req.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
    const roundTimeoutMs = lockstepRoundTimeoutMs(retryBudgetMs, pauseMaxMs, attemptTimeoutMs);
    if (roundTimeoutMs > MAX_TIMER_MS) {
      throw new UsageError(
        `--retry-budget + --pause-max + 2 × --attempt-timeout is the lockstep round timeout: it must stay under 596h (a timer's limit), got ${Math.ceil(roundTimeoutMs / 3_600_000)}h`,
      );
    }
    clock = { kind: "lockstep", roundTimeoutMs };
    policy = {
      retryBudgetMs,
      attemptTimeoutMs,
      roundDeadlineMs: roundTimeoutMs - LOCKSTEP_DEADLINE_MARGIN_MS,
      thoughtCall,
      promptCapTokens,
    };
  } else {
    for (const [flag, v] of [
      ["--retry-budget", req.retryBudgetMs],
      ["--pause-max", req.pauseMaxMs],
    ] as const) {
      if (v !== undefined) {
        throw new UsageError(
          `${flag} applies to --clock lockstep only (real time aborts instead of pausing)`,
        );
      }
    }
    const speed = req.speed ?? (fake ? FAKE_REALTIME_SPEED : undefined);
    if (speed === undefined) {
      throw new UsageError(
        "--clock realtime needs --speed (game-seconds per second): calibrate it from a lockstep run's arena.json (recommendedSpeed)",
      );
    }
    const turnTimeoutMs = req.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    if (turnTimeoutMs <= REALTIME_DEADLINE_MARGIN_MS) {
      throw new UsageError(`--turn-timeout must exceed ${REALTIME_DEADLINE_MARGIN_MS / 1000}s`);
    }
    const deadline = turnTimeoutMs - REALTIME_DEADLINE_MARGIN_MS;
    clock = {
      kind: "realtime",
      speed,
      turnTimeoutMs,
      botLatencyMs: req.botLatencyMs ?? DEFAULT_BOT_LATENCY_MS,
    };
    policy = {
      retryBudgetMs: deadline,
      attemptTimeoutMs: Math.min(attemptTimeoutMs, deadline),
      roundDeadlineMs: deadline,
      thoughtCall,
      promptCapTokens,
    };
  }

  const wakeCapFlag =
    req.wakeCapUsd === "off"
      ? null
      : req.wakeCapUsd === undefined
        ? undefined
        : parseUsd(req.wakeCapUsd, "--wake-cap-usd");
  const wakeCapNanoUsd = wakeCapFlag === undefined ? DEFAULT_WAKE_CAP_NANO_USD : wakeCapFlag;
  const cacheTtl = oneOf(
    req.cacheTtl,
    ["5m", "1h"] as const,
    "--cache-ttl",
    cacheTtlFor(clockKind),
  );
  const transcripts =
    oneOf(req.transcripts, ["full", "off"] as const, "--transcripts", "full") === "full";
  const invariants = oneOf(req.invariants, INVARIANT_LEVELS, "--invariants", "checkpoint");
  const maxTokens = req.maxTokens ?? lineup?.maxTokens ?? DEFAULT_MAX_TOKENS;

  if (llmDrafts.length > 0 && !fake && env.apiKey === null && o.requireKey !== false) {
    throw new UsageError(
      `${KEY_VAR} is not set: the LLM seats (${llmDrafts.map((s) => s.seat).join(", ")}) need it. Export it, or pass --fake for a bot-backed fake model ($0, no API)`,
    );
  }
  const baseURL = env.baseURL ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(baseURL);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(url.protocol);
  } catch {
    throw new UsageError(`${BASE_VAR} is not an http(s) URL: "${baseURL}"`);
  }
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    throw new UsageError(
      `${BASE_VAR} is http:// on ${url.hostname}: the API key would cross the network in cleartext; use https:// (http:// is for a local proxy on localhost, 127.0.0.1 or [::1])`,
    );
  }

  const matchEnd = overrides["time.matchEnd"];
  const matchDays = typeof matchEnd === "number" ? matchEnd / 86_400 : DEFAULT_ARENA_DAYS;
  let stopAt: number | null = null;
  if (req.stopAfterDays !== undefined) {
    const n = req.stopAfterDays;
    if (matchDays <= 1) {
      throw new UsageError(
        `--stop-after needs a match longer than one day (this one lasts ${matchDays} days)`,
      );
    }
    if (!Number.isSafeInteger(n) || n < 1 || n >= matchDays) {
      throw new UsageError(
        `--stop-after must be a whole number of game days from 1 to ${Math.ceil(matchDays) - 1} (the match lasts ${matchDays} days), got ${n}`,
      );
    }
    stopAt = n * 86_400;
  }

  const setup = harness.setupFor(ruleset, { seed, players, overrides, idKey });
  checkCreation(setup, ruleset);

  // The prediction (phase 4 §5.3), from the texts every seat will get.
  const texts = {
    shared: sharedPrompt(rulesInfo(createMatch(setup, ruleset)), setup.seats.length),
    tools: anthropicTools(toolDefinitions(ruleset)),
  };
  const days = stopAt === null ? matchDays : stopAt / 86_400;
  const prediction = predict(
    llmDrafts.map((s) => ({
      seat: s.seat,
      provider: s.provider,
      model: s.model,
      effort: s.effort,
      fallbacks: s.fallbacks,
      profile: profileRef(s.profile),
      sampleTokens: sampleTokensUpper({
        seat: s.seat,
        prompt: { shared: texts.shared, seat: seatPrompt(s.seat, s.profile) },
        tools: texts.tools,
      }),
    })),
    { days, clock: clockKind, cacheTtl, maxTokens, promptCapTokens },
  );
  const predicted = new Map(prediction.seats.map((p) => [p.seat, p]));

  // Caps: --seat-cap, the lineup seat's, --cap-usd, the lineup default (§3.9), phase 2's $100.
  // Wake caps: --wake-cap-usd, the lineup seat's, the lineup default (§3.9), phase 2's $2.
  const seats: SeatPlan[] = [];
  for (const d of drafts) {
    if (d.kind === "bot") {
      seats.push(d);
      continue;
    }
    const extras = extrasOf(d.seat);
    const high = predicted.get(d.seat)?.high ?? 0;
    const capNanoUsd =
      caps.get(d.seat) ??
      extras?.capNanoUsd ??
      capFlag ??
      (lineup === null ? DEFAULT_CAP_NANO_USD : defaultSeatCap(high));
    const seatWakeCap =
      wakeCapFlag !== undefined
        ? wakeCapFlag
        : (extras?.wakeCapNanoUsd ??
          (lineup === null
            ? DEFAULT_WAKE_CAP_NANO_USD
            : defaultWakeCap(centralWakeNano(d.model, clockKind, cacheTtl, d.effort))));
    seats.push({ ...d, capNanoUsd, wakeCapNanoUsd: seatWakeCap });
  }
  const llmSeats = seats.filter((s): s is LlmSeatPlan => s.kind === "llm");

  // The match budget (phase 4 §5.2, §4.2).
  const onBudget = oneOf(req.onBudget, ["handoff", "abort"] as const, "--on-budget", "handoff");
  const budgetText = req.budgetUsd ?? lineup?.budgetUsd;
  const budgetField = req.budgetUsd !== undefined ? "--budget-usd" : "the lineup's budgetUsd";
  let budget: PlanBudget | null = null;
  const warnings: string[] = [];
  if (budgetText === undefined) {
    if (req.budgetCarry !== undefined) {
      throw new UsageError("--budget-carry needs a match budget (--budget-usd or a lineup's)");
    }
    if (req.onBudget !== undefined) {
      throw new UsageError("--on-budget needs a match budget (--budget-usd or a lineup's)");
    }
  } else if (llmSeats.length > 0) {
    const budgetNanoUsd = parseUsd(
      budgetText,
      req.budgetUsd !== undefined ? "--budget-usd" : `--lineup ${lineup?.id ?? ""}: budgetUsd`,
    );
    const carry =
      req.budgetCarry === undefined ? { nanoUsd: 0, lines: 0 } : carryOf(req.budgetCarry);
    budget = {
      budgetNanoUsd,
      onBudget,
      carryNanoUsd: carry.nanoUsd,
      carryFrom: req.budgetCarry === undefined ? null : basename(req.budgetCarry),
      carryLines: carry.lines,
    };
    const check = budgetCheck(budget, prediction, budgetField);
    if (check.refusal !== null) throw new UsageError(check.refusal);
    warnings.push(...check.warnings);
  }
  if (lineup?.comparison === true) {
    const models = llmSeats.map((s) => s.model);
    const repeated = [...new Set(models.filter((m, i) => models.indexOf(m) !== i))];
    if (repeated.length > 0) {
      warnings.push(
        `--lineup ${lineup.id} is a comparison lineup but repeats ${repeated.join(", ")}: one seat per model is the rule (§3.8)`,
      );
    }
  }
  const estimate = estimateFile({
    lineup: lineup?.id ?? null,
    ruleset: setup.ruleset,
    players: setup.seats.length,
    matchDays,
    clock: clockKind,
    cacheTtl,
    maxTokens,
    promptCapTokens,
    prediction,
    extras: new Map(
      llmSeats.map((s) => [s.seat, { capNanoUsd: s.capNanoUsd, wakeCapNanoUsd: s.wakeCapNanoUsd }]),
    ),
    budget,
  });

  return {
    ruleset,
    setup,
    seats,
    fake,
    clock,
    time,
    policy,
    pauseMaxMs,
    wakeCapNanoUsd,
    maxInflight: req.maxInflight ?? DEFAULT_MAX_INFLIGHT,
    maxTokens,
    cacheTtl,
    transcripts,
    watch: req.watch ?? false,
    invariants,
    snapshotEvery: req.snapshotEvery ?? 24,
    calibratedNanoUsdPerDay:
      req.calibratedUsdPerDay === undefined
        ? null
        : parseUsd(req.calibratedUsdPerDay, "--calibrated-usd-per-day"),
    env,
    baseURL,
    stopAt,
    lineup: lineup?.id ?? null,
    promptCapTokens,
    budget,
    prediction,
    estimate,
    texts,
    warnings,
  };
}

/** The LLM seats of a plan. */
export function llmSeatsOf(plan: ArenaPlan): LlmSeatPlan[] {
  return plan.seats.filter((s): s is LlmSeatPlan => s.kind === "llm");
}

/** The match length in game seconds. */
export function matchEndOf(plan: ArenaPlan): number {
  const end = plan.setup.overrides["time.matchEnd"];
  return typeof end === "number" ? end : DEFAULT_ARENA_DAYS * 86_400;
}
