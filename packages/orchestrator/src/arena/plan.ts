import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createMatch, type AnyRuleset, type InvariantLevel } from "@perfidia/engine";
import { idKeyFromSeed } from "@perfidia/engine/core";
import { rulesInfo } from "@perfidia/gateway/present";
import { toolDefinitions } from "@perfidia/gateway/runtime";
import {
  IdKeySchema,
  type MatchSetup,
  type PlayerId,
  type PromptVariant,
  type ReminderCadence,
} from "@perfidia/protocol";
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
import {
  EstimateFileSchema,
  LlmLogLineSchema,
  type EstimateFile,
  type Lineup,
} from "../log/schema.ts";
import { DEFAULT_BASE_URL } from "../model/anthropic.ts";
import {
  DEFAULT_PROMPT_CAP_TOKENS,
  EFFORTS,
  encodeLabelPart,
  type CacheTtl,
  type Effort,
  type ModelTool,
} from "../model/adapter.ts";
import {
  CATALOG_CHECKED,
  capabilitiesFor,
  modelInfo,
  seatModels,
  type ModelInfo,
} from "../model/catalog.ts";
import { effortSent } from "../model/compat.ts";
import { cardAt, cardsFrom, formatCents, usdToNano } from "../model/prices.ts";
import { modelTools } from "../model/tools.ts";
import type { SeatPolicy } from "../seat/agent.ts";
import { PROFILES, findProfile, profileRef, type Profile } from "../seat/personalities.ts";
import { seatPrompt, sharedPrompt } from "../seat/prompt.ts";
import { EFFORT_FACTOR_PCT, centralWakeNanoOf, loggedSpend, scenarioCard } from "./cost.ts";
import { profilesFor } from "./calibrate.ts";
import {
  budgetCheck,
  estimateFile,
  plannedWallMsPerGameDay,
  predict,
  type PlanBudget,
  type Prediction,
} from "./estimate.ts";
import { defaultSeatCap, defaultWakeCap, fallbacksFor, loadLineup } from "./lineup.ts";
import { sampleTokensUpper } from "./preflight.ts";
import {
  PROVIDERS,
  REQUIRED_PARAMS,
  SNAPSHOT_ENDPOINTS,
  providerInfo,
  toolsFor,
  type EndpointSource,
  type ProviderInfo,
} from "./providers.ts";

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
//
// Pass 1b: every provider. The environment holds `PERFIDIA_<PROVIDER>_API_KEY` and `_BASE_URL` for
// Anthropic, OpenAI, Google, OpenRouter and compat (nothing else); a key is required only for a
// provider some seat plays on, and the error names those seats. A seat is
// `pN=<provider>:<model>[@<endpoint>]:<effort>:<profile>` (`claude:` stays Anthropic's alias), or a
// lineup seat. Each is checked against the model catalog and the price cards (design §4.2): a
// known seat model, an effort it accepts, a card valid at the plan's price instant, an OpenRouter
// pin that is a full endpoint slug listing every needed parameter (and ZDR-listed under `zdr`),
// a context of at least 200K tokens and an output limit of twice `maxTokens`, an attempt timeout of
// at least the provider's minimum. A provider without an adapter in this build runs only with
// `--fake`, whose seats mirror it and are priced at its cards on one pinned date. A lineup with a
// non-Anthropic seat defaults to 32,768 output tokens, `last-round` reminders and a 15-minute
// attempt timeout (the owner's comparison defaults).

/** One provider's key and base URL, as the environment gives them. */
export interface ProviderEnv {
  readonly apiKey: string | null;
  readonly baseURL: string | null;
}

/** The environment of the harness: the only variables it reads. */
export interface ArenaEnv {
  /** Anthropic's (`PERFIDIA_ANTHROPIC_API_KEY`, phase 2). */
  readonly apiKey: string | null;
  readonly baseURL: string | null;
  /** `PERFIDIA_LIVE=1`: the opt-in live test only. */
  readonly live: boolean;
  /** Pass 1b: the other providers' `PERFIDIA_<PROVIDER>_API_KEY` and `_BASE_URL`. */
  readonly providers?: Readonly<Record<string, ProviderEnv>>;
}

const KEY_VAR = PROVIDERS.anthropic.keyVar;
const BASE_VAR = PROVIDERS.anthropic.baseUrlVar;

/** Reads the harness's variables from `env` (the CLI passes the process environment). */
export function arenaEnv(env: Readonly<Record<string, string | undefined>>): ArenaEnv {
  const get = (name: string): string | null => {
    const v = Object.hasOwn(env, name) ? env[name] : undefined;
    return v === undefined || v.trim() === "" ? null : v.trim();
  };
  const providers: Record<string, ProviderEnv> = {};
  for (const p of Object.values(PROVIDERS)) {
    if (p.id !== "anthropic")
      providers[p.id] = { apiKey: get(p.keyVar), baseURL: get(p.baseUrlVar) };
  }
  return {
    apiKey: get(KEY_VAR),
    baseURL: get(BASE_VAR),
    live: get("PERFIDIA_LIVE") === "1",
    providers,
  };
}

/** One provider's key and base URL from a plan's environment. */
export function providerEnv(env: ArenaEnv, provider: string): ProviderEnv {
  if (provider === "anthropic") return { apiKey: env.apiKey, baseURL: env.baseURL };
  return env.providers?.[provider] ?? { apiKey: null, baseURL: null };
}

/** Model aliases of `--seat` (a full `claude-…` id is taken as is). */
export const MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "opus-5-5": "claude-opus-5-5",
  "sonnet-5-5": "claude-sonnet-5-5",
  "haiku-5-5": "claude-haiku-5-5",
  "fable-5-1": "claude-fable-5-1",
});

/**
 * The Claude models a seat may run on: the 5.5 family and Claude Fable 5.1, which take the request
 * shape (mid-conversation `system` messages, adaptive thinking with `effort`). The other priced
 * Claude models are fallback targets only: Claude Sonnet 5, for one, rejects the operator entries.
 */
export const SEAT_MODELS: readonly string[] = Object.freeze(
  seatModels("anthropic").map((m) => m.model),
);

/** The providers seats are planned on (`claude` is Anthropic's alias in `--seat`). */
const SEAT_PROVIDERS = Object.keys(PROVIDERS);

/** The output limit of mixed lineups and the owner's comparison timeout (design §3.1, decision 7). */
export const MIXED_MAX_TOKENS = 32_768;
export const MIXED_ATTEMPT_TIMEOUT_MS = 15 * 60_000;
/** A seat's model needs this much context (design §3.4). */
export const MIN_CONTEXT_TOKENS = 200_000;
/** Days within which a price change of a seat's card is a warning. */
export const PRICE_CHANGE_WARN_MS = 2 * 86_400_000;
/** Gemini Tier 1's monthly account cap (design §4.2, billing page). */
export const GOOGLE_TIER1_MONTHLY_NANO_USD = 250_000_000_000;

/** An LLM seat of the plan. */
export interface LlmSeatPlan {
  readonly seat: PlayerId;
  readonly kind: "llm";
  /** The provider the seat plays on (on `--fake`: the one its fake model mirrors and is priced at). */
  readonly provider: ProviderInfo["id"];
  readonly model: string;
  /** OpenRouter's pinned endpoint; null elsewhere. */
  readonly endpoint: string | null;
  /** The endpoint's quantization (OpenRouter metadata); null elsewhere. */
  readonly quantization: string | null;
  /** The operator channel of the seat's shared block (its provider's). */
  readonly promptVariant: PromptVariant;
  /** OpenAI `reasoning.context` (`all_turns` on GPT-6.1 Sol); null elsewhere. */
  readonly reasoningContext: "all_turns" | null;
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
  /** The reminder cadence of every seat (one per lineup, design §3.2). */
  readonly reminders: ReminderCadence;
  /** The UTC instant the prediction's cards are chosen at (the plan's start or `--price-date`). */
  readonly priceAt: string;
  /** `--fake` or `--price-date`: every attempt is priced at this instant (byte-identical runs). */
  readonly priceFixed: string | null;
  /** The prompt cap in tokens (phase 4 §5.2). */
  readonly promptCapTokens: number;
  /** The match budget (a lineup's `budgetUsd` or `--budget-usd`); null: none. */
  readonly budget: PlanBudget | null;
  /** The prediction and reserve of the LLM seats. */
  readonly prediction: Prediction;
  /** `estimate.json`, as `arena run` writes it before turn 1. */
  readonly estimate: EstimateFile;
  /**
   * The shared system block (the `system` variant: phase 2's text) and the tools every seat gets
   * (also the preflight bounds' input); `shared` per operator channel for the seats that use it.
   */
  readonly texts: {
    readonly shared: string;
    readonly tools: readonly ModelTool[];
    readonly sharedByVariant: Readonly<Partial<Record<PromptVariant, string>>>;
  };
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
  /** `YYYY-MM-DD`: price at that UTC day's start (`--fake` and `arena estimate` only). */
  readonly priceDate?: string | undefined;
  /** Pass 2: a directory of calibration profiles the prediction draws on; `off` or absent: none. */
  readonly profiles?: string | undefined;
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

/**
 * The Anthropic base URL, checked (exit 3 otherwise): an http(s) URL, `http:` on loopback only
 * (the key never crosses the network in cleartext). `arena run`, `estimate` and `smoke` share it.
 */
export function checkedBaseUrl(baseURL: string, variable: string = BASE_VAR): string {
  let url: URL;
  try {
    url = new URL(baseURL);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(url.protocol);
  } catch {
    throw new UsageError(`${variable} is not an http(s) URL: "${baseURL}"`);
  }
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
    throw new UsageError(
      `${variable} is http:// on ${url.hostname}: the API key would cross the network in cleartext; use https:// (http:// is for a local proxy on localhost, 127.0.0.1 or [::1])`,
    );
  }
  return baseURL;
}

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
  "write claude:<model>:<effort>:<profile>, such as claude:opus-5-5:medium:odysseus (models: opus-5-5, sonnet-5-5, haiku-5-5, fable-5-1 or a full claude-… id), or <provider>:<model>[@<endpoint>]:<effort>:<profile> with provider openai, google, openrouter or compat, such as openrouter:z-ai/glm-5.3@z-ai/fp8:medium:agamemnon";

/** A seat model of a provider, by alias or id; undefined when unknown. */
function seatModelOf(provider: string, text: string): string {
  if (provider === "anthropic") {
    return Object.hasOwn(MODEL_ALIASES, text) ? (MODEL_ALIASES[text] ?? text) : text;
  }
  return text;
}

/**
 * `pN=bot:<strategy>[@n]`, or an LLM seat: `claude:<model>:<effort>:<profile>` (Anthropic's alias)
 * or `<provider>:<model>[@<endpoint>]:<effort>:<profile>`. The model and its effort are checked
 * here; the plan checks the rest (cards, endpoints, limits).
 */
export function parseSeatSpec(seat: PlayerId, value: string): SeatSpec {
  if (value.startsWith("bot:")) {
    return { seat, kind: "bot", label: botLabelOf(value, `--seat ${seat}=${value}`) };
  }
  const parts = value.split(":");
  const head = parts[0] ?? "";
  const provider = head === "claude" ? "anthropic" : head;
  if (head !== "claude" && !SEAT_PROVIDERS.includes(head)) {
    throw new UsageError(
      `--seat ${seat}=${value}: a seat is claude:… (an LLM) or bot:… (a scripted bot); ${LLM_SPEC_HELP}`,
    );
  }
  if (parts.length !== 4) throw new UsageError(`--seat ${seat}=${value}: ${LLM_SPEC_HELP}`);
  const [, modelText = "", effort = "", profileText = ""] = parts;
  const at = provider === "openrouter" ? modelText.indexOf("@") : -1;
  const model = seatModelOf(provider, at < 0 ? modelText : modelText.slice(0, at));
  const endpoint = at < 0 ? undefined : modelText.slice(at + 1);
  const where = `--seat ${seat}=${value}`;
  if (provider === "anthropic" && !model.startsWith("claude-")) {
    throw new UsageError(`${where}: unknown model "${modelText}"; ${LLM_SPEC_HELP}`);
  }
  const info = checkSeatModel(where, provider, model);
  const e = EFFORTS.find((x) => x === effort);
  const accepted = info?.capabilities.efforts ?? EFFORTS;
  if (e === undefined || !accepted.includes(e)) {
    throw new UsageError(`${where}: effort must be one of ${accepted.join(", ")}, got "${effort}"`);
  }
  const profile = findProfile(profileText);
  if (profile === undefined) {
    throw new UsageError(
      `${where}: unknown profile "${profileText}"; the profiles are ${PROFILES.map(profileRef).join(", ")}`,
    );
  }
  return {
    seat,
    kind: "llm",
    provider,
    model,
    effort: e,
    profile: profileRef(profile),
    ...(endpoint === undefined ? {} : { endpoint }),
  };
}

/**
 * The catalog entry of a seat's model; a model that is not a seat model of its provider is refused
 * (compat models are not catalogued: their card decides).
 */
function checkSeatModel(where: string, provider: string, model: string): ModelInfo | undefined {
  if (provider === "compat") return undefined;
  const info = modelInfo(provider, model);
  if (info?.seat !== true) {
    const models = seatModels(provider).map((m) => m.model);
    throw new UsageError(
      `${where}: ${model} is not a seat model; a seat runs on ${models.join(", ")}${provider === "anthropic" ? " (the other priced models are fallback targets only)" : ""}`,
    );
  }
  return info;
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
  /**
   * `false`: no API key and no adapter needed (`arena estimate` plans without sending anything).
   * Default true.
   */
  readonly requireKey?: boolean;
  /** The wall clock in ms (the price instant of a plan without `--price-date`); default `Date.now`. */
  readonly now?: () => number;
  /** OpenRouter endpoint metadata (design §2.5); default the snapshot checked on 2026-10-20. */
  readonly endpoints?: EndpointSource;
}

const PRICE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `--price-date YYYY-MM-DD` as that UTC day's start. */
export function priceDateOf(text: string): string {
  const m = PRICE_DATE.exec(text.trim());
  const iso = m === null ? "" : `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`;
  if (m === null || Number.isNaN(Date.parse(iso)) || new Date(iso).toISOString() !== iso) {
    throw new UsageError(`--price-date must be a UTC date such as 2026-10-19, got "${text}"`);
  }
  return iso;
}

/** The UTC start of the day of `ms`. */
const dayStart = (ms: number): string => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00.000Z`;

/** A draft LLM seat, before its caps (they depend on the prediction). */
interface LlmDraft {
  readonly seat: PlayerId;
  readonly kind: "llm";
  readonly provider: ProviderInfo["id"];
  readonly model: string;
  readonly endpoint: string | null;
  readonly quantization: string | null;
  readonly promptVariant: PromptVariant;
  readonly reasoningContext: "all_turns" | null;
  readonly effort: Effort;
  readonly profile: Profile;
  readonly handoffBot: string;
  readonly brain: string;
  readonly fallbacks: "default" | "off";
}

/**
 * The provider-level checks of one LLM seat (design §4.2): a card valid at the price instant, an
 * OpenRouter pin that is a full endpoint slug of the model listing every needed parameter (and
 * ZDR-listed when `zdr`), context and output limits. Returns the endpoint's quantization and the
 * seat's warnings.
 */
function checkSeat(
  d: Pick<LlmDraft, "seat" | "provider" | "model" | "endpoint" | "effort">,
  o: {
    readonly priceAt: string;
    readonly maxTokens: number;
    readonly attemptTimeoutMs: number;
    readonly zdr: boolean;
    readonly endpoints: EndpointSource;
  },
): { readonly quantization: string | null; readonly warnings: string[] } {
  const p = providerInfo(d.provider);
  if (p === undefined) throw new UsageError(`${d.seat}: unknown provider ${d.provider}`);
  const warnings: string[] = [];
  let quantization: string | null = null;
  if (p.needsEndpoint) {
    if (d.endpoint === null) {
      throw new UsageError(
        `${d.seat}: openrouter seats need a full endpoint slug (e.g. "z-ai/fp8") so routing cannot change the model: write ${d.model}@<endpoint>`,
      );
    }
    const e = o.endpoints(d.model, d.endpoint);
    if (e === undefined) {
      // A provider slug (`z-ai`) routes to any of its endpoints (phase-4 review): name them.
      const tags = new Set<string>();
      for (const x of modelInfo("openrouter", d.model)?.endpoints ?? []) {
        tags.add(x.tag);
        for (const t of x.siblings) tags.add(t);
      }
      const wider = [...tags].filter((t) => t.startsWith(`${d.endpoint}/`));
      if (wider.length > 0) {
        throw new UsageError(
          `${d.seat}: ${d.endpoint} is not a full endpoint slug: it matches ${wider.join(", ")}, so routing could change the model's endpoint; pin one of them (e.g. ${d.model}@${wider[0] ?? ""})`,
        );
      }
      throw new UsageError(
        `${d.seat}: ${d.endpoint} is not an endpoint of ${d.model} on OpenRouter (its /endpoints list)`,
      );
    }
    const wider = e.siblings.filter((t) => t.startsWith(`${d.endpoint}/`));
    if (wider.length > 0) {
      throw new UsageError(
        `${d.seat}: ${d.endpoint} is not a full endpoint slug: it also matches ${wider.join(", ")}; pin one of them`,
      );
    }
    const missing = REQUIRED_PARAMS.filter((x) => !e.supportedParams.includes(x));
    if (missing.length > 0) {
      throw new UsageError(
        `${d.seat}: ${d.model}@${d.endpoint} does not list ${missing.join(", ")} in its supported parameters: a seat needs tools, tool_choice, max_tokens and reasoning`,
      );
    }
    if (o.zdr && !e.zdr) {
      throw new UsageError(
        `${d.seat}: ${d.model}@${d.endpoint} is not in OpenRouter's zero-data-retention list while the lineup asks zdr: pin a listed endpoint or set defaults.zdr to false`,
      );
    }
    if (!e.supportedParams.includes("parallel_tool_calls")) {
      warnings.push(
        `${d.seat}: ${d.model}@${d.endpoint} does not list parallel_tool_calls: it is not sent, and a seat that never makes parallel calls gets fewer calls per wake (reported per seat)`,
      );
    }
    quantization = e.quantization;
  } else if (d.endpoint !== null) {
    throw new UsageError(`${d.seat}: an endpoint applies to openrouter seats only`);
  }
  if (cardAt(d.provider, d.model, d.endpoint, o.priceAt) === null) {
    const id = `${d.provider}:${d.model}${d.endpoint === null ? "" : `@${d.endpoint}`}`;
    throw new UsageError(
      `${d.seat}: no price card for ${id} valid at ${o.priceAt.slice(0, 16)}Z; add it to ${p.pricesFile}`,
    );
  }
  try {
    encodeLabelPart(d.model);
    if (d.endpoint !== null) encodeLabelPart(d.endpoint);
  } catch (e) {
    throw new UsageError(`${d.seat}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const caps = capabilitiesFor(d.provider, d.model, d.endpoint);
  if (caps.contextTokens < MIN_CONTEXT_TOKENS) {
    throw new UsageError(
      `${d.seat}: ${d.model} has a context of ${caps.contextTokens} tokens, under ${MIN_CONTEXT_TOKENS}`,
    );
  }
  if (caps.maxOutputTokens < 2 * o.maxTokens) {
    throw new UsageError(
      `${d.seat}: ${d.model} returns at most ${caps.maxOutputTokens} output tokens, under twice the lineup's maxTokens ${o.maxTokens} (the max_tokens retry): lower maxTokens`,
    );
  }
  if (o.attemptTimeoutMs < caps.minAttemptTimeoutMs) {
    throw new UsageError(
      `${d.seat}: ${d.model} needs an attempt timeout of at least ${caps.minAttemptTimeoutMs / 60_000} min, got ${o.attemptTimeoutMs / 60_000} min: raise attemptTimeoutMin`,
    );
  }
  const info = modelInfo(d.provider, d.model);
  const advertised = info?.advertisedEfforts ?? null;
  if (advertised !== null && info !== undefined && !advertised.includes(d.effort)) {
    // Phase-4 review C9, settled with Pass 2's adapter: the request carries the nearest level the
    // model lists (`effortSent`), recorded per seat (`effortSent` in seats.json).
    const f = effortFactorText;
    const sent = effortSent(d.provider, d.model, d.effort);
    warnings.push(
      `${d.seat}: OpenRouter lists ${d.model}'s efforts as ${advertised.join(", ")}, default ${info.defaultEffort} (models list, ${CATALOG_CHECKED}): ${d.effort} is sent as ${sent}, the nearest listed level (OpenRouter maps an unlisted effort to the nearest supported level with no rule for a tie; the harness sends the lower level of a tie itself); the prediction keeps ${d.effort}'s output factor ${f(d.effort)} against ${sent}'s ${f(sent)}, an upper bound; unverified until a smoke records the reasoning tokens; set the seat's effort to one of ${advertised.join(", ")} to send that level instead`,
    );
  }
  for (const n of info?.notes ?? []) warnings.push(`${d.seat}: ${n}`);
  // A price change soon after the start: both cards are charged by wall time.
  const start = Date.parse(o.priceAt);
  for (const c of cardsFrom(d.provider, d.model, d.endpoint, o.priceAt)) {
    const from = Date.parse(c.validFrom);
    if (from > start && from - start <= PRICE_CHANGE_WARN_MS) {
      warnings.push(
        `${d.seat}: ${d.model}'s price changes at ${c.validFrom} (card ${c.id}), within two days of the start: attempts after it are billed at the new card, and the reserve already counts it`,
      );
    }
  }
  return { quantization, warnings };
}

/** An effort's output factor as the warnings print it (`1`, `3`). */
const effortFactorText = (e: Effort): string => `${EFFORT_FACTOR_PCT[e] / 100}`;

/** What a lineup file adds to one of its LLM seats. */
interface LineupExtras {
  readonly capNanoUsd: number | null;
  readonly wakeCapNanoUsd: number | null;
  readonly handoffBot: string | null;
  readonly fallbacks: "default" | "off" | undefined;
}

/** A lineup file's seats as seat specs, and its per-seat extras. */
function lineupSeats(lineup: Lineup): {
  readonly specs: SeatSpec[];
  readonly extras: Map<PlayerId, LineupExtras>;
} {
  const where = `--lineup ${lineup.id}`;
  const specs: SeatSpec[] = [];
  const extras = new Map<PlayerId, LineupExtras>();
  for (const s of lineup.seats) {
    if (s.kind === "bot") {
      specs.push({ seat: s.seat, kind: "bot", label: botLabelOf(s.label, `${where}: ${s.seat}`) });
      continue;
    }
    const at = `${where}: ${s.seat}`;
    const model = seatModelOf(s.provider, s.model);
    const info = checkSeatModel(at, s.provider, model);
    if (findProfile(s.profile) === undefined) {
      throw new UsageError(
        `${at}: unknown profile "${s.profile}"; the profiles are ${PROFILES.map(profileRef).join(", ")}`,
      );
    }
    const effort = s.effort ?? lineup.defaults.effort ?? "medium";
    const accepted = info?.capabilities.efforts ?? EFFORTS;
    if (!accepted.includes(effort)) {
      throw new UsageError(
        `${s.seat}: ${model} accepts effort ${accepted.join(", ")}; got ${effort}`,
      );
    }
    specs.push({
      seat: s.seat,
      kind: "llm",
      provider: s.provider,
      model,
      effort,
      profile: s.profile,
      ...(s.endpoint === undefined ? {} : { endpoint: s.endpoint }),
    });
    extras.set(s.seat, {
      capNanoUsd: s.capUsd === undefined ? null : parseUsd(s.capUsd, `${at} capUsd`),
      wakeCapNanoUsd:
        s.wakeCapUsd === undefined ? null : parseUsd(s.wakeCapUsd, `${at} wakeCapUsd`),
      handoffBot: s.handoffBot === undefined ? null : botLabelOf(s.handoffBot, `${at} handoffBot`),
      fallbacks:
        s.provider === "anthropic"
          ? fallbacksFor(s.seat, model, s.fallbacks, lineup.defaults.fallbacks)
          : nonAnthropicFallbacks(s.seat, model, s.fallbacks),
    });
  }
  return { specs, extras };
}

/** Server-side fallbacks are Anthropic's: any other seat records `off`, and `default` is refused. */
function nonAnthropicFallbacks(seat: string, model: string, own: "default" | "off" | undefined) {
  if (own === "default") {
    throw new UsageError(
      `${seat}: ${model} has no server-side refusal fallback: set its fallbacks to "off" (or leave them out)`,
    );
  }
  return "off" as const;
}

/** The `arena.json` statuses of a run that ended normally: every attempt of it was logged. */
const SETTLED: ReadonlySet<string> = new Set(["ended", "stopped", "degraded"]);

/**
 * What a carried run may have had in flight when it died (phase-4 review): nothing when its
 * `arena.json` says it ended normally; otherwise its reserve from `estimate.json` (one attempt per
 * LLM seat, a probe, the start preflight), the most that can have been billed without a line.
 */
function inFlightOf(dir: string): number {
  const read = (name: string): unknown => {
    const path = join(dir, name);
    if (!existsSync(path)) return undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      return value;
    } catch {
      return undefined;
    }
  };
  const arena = read("arena.json");
  const status: unknown =
    arena !== null && typeof arena === "object" ? Reflect.get(arena, "status") : undefined;
  if (typeof status === "string" && SETTLED.has(status)) return 0;
  const estimate = EstimateFileSchema.safeParse(read("estimate.json"));
  if (!estimate.success) {
    throw new UsageError(
      `--budget-carry ${dir}: the run did not end (arena.json status ${typeof status === "string" ? status : "missing"}) and has no readable estimate.json to bound the attempts it may have had in flight`,
    );
  }
  return estimate.data.reserve.reserveNanoUsd;
}

/**
 * The spend of a crashed run (`--budget-carry <dir>`): every cost line of its `llm_calls.jsonl`,
 * its own carry line included, plus what it may have had in flight (`inFlightOf`).
 */
function carryOf(dir: string): {
  readonly nanoUsd: number;
  readonly lines: number;
  readonly inFlightNanoUsd: number;
} {
  const isDir = existsSync(dir) && statSync(dir).isDirectory();
  const path = isDir ? join(dir, "llm_calls.jsonl") : dir;
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
  const logged = loggedSpend(lines);
  const inFlightNanoUsd = inFlightOf(isDir ? dir : dirname(path));
  return {
    nanoUsd: logged.nanoUsd + inFlightNanoUsd,
    lines: logged.lines,
    inFlightNanoUsd,
  };
}

/**
 * Checks an arena request completely and returns its plan; throws `UsageError` (exit 3) on
 * anything wrong. With LLM seats and no `--fake`, the API key must be set.
 */
export function planArena(req: ArenaRequest, env: ArenaEnv, o: PlanOptions = {}): ArenaPlan {
  const fake = req.fake ?? false;
  const forRun = o.requireKey !== false;
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

  // The price instant: `--price-date` (fake runs and estimates), else now; a fake run prices every
  // attempt at one instant (the day's start), so its files are byte-identical.
  if (req.priceDate !== undefined && forRun && !fake) {
    throw new UsageError(
      "--price-date applies to --fake runs and arena estimate: a real run is priced at each attempt's wall-clock start",
    );
  }
  const nowMs = (o.now ?? Date.now)();
  const priceAt =
    req.priceDate !== undefined
      ? priceDateOf(req.priceDate)
      : fake
        ? dayStart(nowMs)
        : new Date(nowMs).toISOString();
  const priceFixed = fake ? priceAt : null;

  const overridden = new Set((req.seats ?? []).map((t) => seatOf(t, "--seat", players).seat));
  const specs = lineupOf(req.seats ?? [], players, fromLineup?.specs ?? DEFAULT_LINEUP);
  const extrasOf = (seat: PlayerId): LineupExtras | undefined =>
    overridden.has(seat) ? undefined : fromLineup?.extras.get(seat);
  const capFlag = req.capUsd === undefined ? null : parseUsd(req.capUsd, "--cap-usd");
  const caps = seatCaps(req.seatCaps ?? [], players);
  const brains = brainsOf(req.brains ?? [], players);
  const handoffAll =
    req.handoffBot === undefined ? null : botLabelOf(req.handoffBot, "--handoff-bot");
  const llmSpecs = specs.flatMap((s) => (s.kind === "llm" ? [s] : []));
  const mixed = llmSpecs.some((s) => s.provider !== "anthropic");

  // Lineup-wide limits: the lineup's, else phase 2's for Claude seats only and the owner's
  // comparison defaults with any other provider (32,768 tokens, last-round, 15 minutes).
  const maxTokens =
    req.maxTokens ?? lineup?.maxTokens ?? (mixed ? MIXED_MAX_TOKENS : DEFAULT_MAX_TOKENS);
  const reminders: ReminderCadence = lineup?.reminders ?? (mixed ? "last-round" : "every-round");
  const attemptTimeoutMs =
    req.attemptTimeoutMs ??
    (lineup === null
      ? mixed
        ? MIXED_ATTEMPT_TIMEOUT_MS
        : DEFAULT_ATTEMPT_TIMEOUT_MS
      : lineup.attemptTimeoutMin * 60_000);
  if (attemptTimeoutMs > MAX_TIMER_MS) {
    throw new UsageError(`--lineup ${lineup?.id ?? ""}: attemptTimeoutMin is over a timer's limit`);
  }
  const zdr = lineup?.defaults.zdr ?? true;
  const endpoints = o.endpoints ?? SNAPSHOT_ENDPOINTS;
  const warnings: string[] = [];

  // Seats first without their caps: the lineup's default caps depend on the prediction.
  const drafts = specs.map((s): LlmDraft | SeatSpec => {
    if (s.kind === "bot") {
      if (caps.has(s.seat)) throw new UsageError(`--seat-cap ${s.seat}: ${s.seat} is a bot`);
      if (brains.has(s.seat)) throw new UsageError(`--brain ${s.seat}: ${s.seat} is a bot`);
      return s;
    }
    const profile = findProfile(s.profile);
    if (profile === undefined) throw new UsageError(`${s.seat}: unknown profile ${s.profile}`);
    const provider = providerInfo(s.provider);
    if (provider === undefined) throw new UsageError(`${s.seat}: unknown provider ${s.provider}`);
    const endpoint = s.endpoint ?? null;
    const checked = checkSeat(
      { seat: s.seat, provider: provider.id, model: s.model, endpoint, effort: s.effort },
      { priceAt, maxTokens, attemptTimeoutMs, zdr, endpoints },
    );
    warnings.push(...checked.warnings);
    if (forRun && !fake && !provider.adapter) {
      throw new UsageError(
        `${s.seat}: ${provider.id} has no adapter in this build (phase 4 Pass 2 adds it): rehearse the lineup with --fake, which mirrors ${provider.id} at $0`,
      );
    }
    const extras = extrasOf(s.seat);
    const handoffBot =
      handoffAll ??
      extras?.handoffBot ??
      botLabelOf(profile.handoffBot, `${s.seat}'s hand-off bot`);
    const info = modelInfo(provider.id, s.model);
    return {
      seat: s.seat,
      kind: "llm",
      provider: provider.id,
      model: s.model,
      endpoint,
      quantization: checked.quantization,
      promptVariant: capabilitiesFor(provider.id, s.model, endpoint).operatorChannel,
      reasoningContext: info?.reasoningContext ?? null,
      effort: s.effort,
      profile,
      handoffBot,
      brain: brains.get(s.seat) ?? handoffBot,
      // A `--seat` override takes the lineup's defaults too (phase-4 review): only its own
      // per-seat values are the lineup seat's.
      fallbacks:
        extras?.fallbacks ??
        (provider.id === "anthropic"
          ? fallbacksFor(s.seat, s.model, undefined, lineup?.defaults.fallbacks)
          : "off"),
    };
  });
  if (!fake && brains.size > 0) throw new UsageError("--brain applies to --fake runs only");
  const llmDrafts = drafts.flatMap((s) => (s.kind === "llm" && "handoffBot" in s ? [s] : []));

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

  // Keys and base URLs: only for the providers some seat plays on (a real run).
  if (forRun && !fake) {
    const byProvider = new Map<string, PlayerId[]>();
    for (const d of llmDrafts)
      byProvider.set(d.provider, [...(byProvider.get(d.provider) ?? []), d.seat]);
    for (const [id, seats] of byProvider) {
      const p = providerInfo(id);
      if (p === undefined) continue;
      const pe = providerEnv(env, id);
      const base = pe.baseURL ?? p.defaultBaseUrl;
      if (base === null) {
        throw new UsageError(
          `${p.baseUrlVar} is not set: the ${id} seats (${seats.join(", ")}) need a base URL`,
        );
      }
      if (id !== "anthropic") {
        // Pass 2: the same check as Anthropic's (http:// on loopback only), and the provider's own.
        checkedBaseUrl(base, p.baseUrlVar);
        const problem = p.baseUrlProblem?.(base) ?? null;
        if (problem !== null) throw new UsageError(`${problem} (seats ${seats.join(", ")})`);
      }
      const loopback = isLoopback(base);
      if (pe.apiKey === null && (p.key === "always" || !loopback)) {
        throw new UsageError(
          `${p.keyVar} is not set: the LLM seats (${seats.join(", ")}) need it. Export it, or pass --fake for a bot-backed fake model ($0, no API)`,
        );
      }
    }
  }
  const baseURL = checkedBaseUrl(env.baseURL ?? DEFAULT_BASE_URL);

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
  const info = rulesInfo(createMatch(setup, ruleset));
  const sharedByVariant: Partial<Record<PromptVariant, string>> = {
    system: sharedPrompt(info, setup.seats.length, "system"),
  };
  for (const d of llmDrafts) {
    sharedByVariant[d.promptVariant] ??= sharedPrompt(info, setup.seats.length, d.promptVariant);
  }
  const texts = {
    shared: sharedByVariant.system ?? "",
    tools: modelTools(toolDefinitions(ruleset)),
    sharedByVariant,
  };
  const days = stopAt === null ? matchDays : stopAt / 86_400;
  const prediction = predict(
    llmDrafts.map((s) => ({
      seat: s.seat,
      provider: s.provider,
      model: s.model,
      endpoint: s.endpoint,
      effort: s.effort,
      fallbacks: s.fallbacks,
      profile: profileRef(s.profile),
      sampleTokens: sampleTokensUpper(
        {
          seat: s.seat,
          prompt: {
            shared: sharedByVariant[s.promptVariant] ?? texts.shared,
            seat: seatPrompt(s.seat, s.profile),
          },
          tools: toolsFor(s.provider, texts.tools),
        },
        s.promptVariant,
      ),
      promptVariant: s.promptVariant,
    })),
    {
      days,
      clock: clockKind,
      cacheTtl,
      maxTokens,
      promptCapTokens,
      priceAt,
      profiles: profilesFor(req.profiles),
      reminders,
      ruleset: setup.ruleset,
      wallMsPerGameDay: plannedWallMsPerGameDay(clock, priceFixed),
    },
  );
  const predicted = new Map(prediction.seats.map((p) => [p.seat, p]));

  // Caps: --seat-cap, the lineup seat's, --cap-usd, the lineup default (§3.9), phase 2's $100.
  // Wake caps: --wake-cap-usd, the lineup seat's, the lineup default (§3.9), phase 2's $2.
  const seats: SeatPlan[] = [];
  for (const d of drafts) {
    if (!("handoffBot" in d)) {
      if (d.kind === "bot") seats.push(d);
      continue;
    }
    const extras = extrasOf(d.seat);
    const high = predicted.get(d.seat)?.high ?? 0;
    const capNanoUsd =
      caps.get(d.seat) ??
      extras?.capNanoUsd ??
      capFlag ??
      (lineup === null ? DEFAULT_CAP_NANO_USD : defaultSeatCap(high));
    const card = scenarioCard(d.model, { provider: d.provider, endpoint: d.endpoint, at: priceAt });
    const seatWakeCap =
      wakeCapFlag !== undefined
        ? wakeCapFlag
        : (extras?.wakeCapNanoUsd ??
          (lineup === null
            ? DEFAULT_WAKE_CAP_NANO_USD
            : defaultWakeCap(centralWakeNanoOf(card, clockKind, cacheTtl, d.effort))));
    seats.push({ ...d, capNanoUsd, wakeCapNanoUsd: seatWakeCap });
  }
  const llmSeats = seats.filter((s): s is LlmSeatPlan => s.kind === "llm");

  // The match budget (phase 4 §5.2, §4.2).
  const onBudget = oneOf(req.onBudget, ["handoff", "abort"] as const, "--on-budget", "handoff");
  const budgetText = req.budgetUsd ?? lineup?.budgetUsd;
  const budgetField = req.budgetUsd !== undefined ? "--budget-usd" : "the lineup's budgetUsd";
  let budget: PlanBudget | null = null;
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
      req.budgetCarry === undefined
        ? { nanoUsd: 0, lines: 0, inFlightNanoUsd: 0 }
        : carryOf(req.budgetCarry);
    budget = {
      budgetNanoUsd,
      onBudget,
      carryNanoUsd: carry.nanoUsd,
      carryFrom: req.budgetCarry === undefined ? null : basename(req.budgetCarry),
      carryLines: carry.lines,
      carryInFlightNanoUsd: carry.inFlightNanoUsd,
    };
    const check = budgetCheck(budget, prediction, budgetField);
    if (check.refusal !== null) throw new UsageError(check.refusal);
    warnings.push(...check.warnings);
  }
  if (lineup?.comparison === true) {
    // No other model may serve a turn in a comparison (design §3.5).
    const on = llmSeats.filter((s) => s.fallbacks !== "off");
    if (on.length > 0) {
      throw new UsageError(
        `--lineup ${lineup.id} is a comparison lineup, but ${on.map((s) => `${s.seat} (${s.model})`).join(", ")} would run with server-side fallbacks on: another model could serve its turns (design §3.5); set the seat's fallbacks, or the lineup's defaults.fallbacks, to "off"`,
      );
    }
    const models = llmSeats.map((s) => s.model);
    const repeated = [...new Set(models.filter((m, i) => models.indexOf(m) !== i))];
    if (repeated.length > 0) {
      warnings.push(
        `--lineup ${lineup.id} is a comparison lineup but repeats ${repeated.join(", ")}: one seat per model is the rule (§3.8)`,
      );
    }
  }
  // Gemini Tier 1 pauses an account at $250 a month (design §4.2): the run's Google high alone.
  const googleHigh = prediction.seats
    .filter((p) => p.provider === "google")
    .reduce((n, p) => n + p.high, 0);
  if (googleHigh > GOOGLE_TIER1_MONTHLY_NANO_USD) {
    warnings.push(
      `the Google seats' predicted high ${formatCents(googleHigh)} exceeds Gemini Tier 1's $250 monthly account cap: the service pauses until the 1st once it is reached`,
    );
  }
  const estimate = estimateFile({
    priceAt,
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
    reminders,
    priceAt,
    priceFixed,
    promptCapTokens,
    budget,
    prediction,
    estimate,
    texts,
    warnings,
  };
}

/** Whether a base URL names a loopback host. */
function isLoopback(base: string): boolean {
  try {
    return LOOPBACK.has(new URL(base).hostname);
  } catch {
    return false;
  }
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
