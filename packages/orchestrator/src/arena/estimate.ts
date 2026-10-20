import type { PlayerId, PromptVariant, ReminderCadence, TokenProfile } from "@perfidia/protocol";
import type { EstimateFile, PredictionSource } from "../log/schema.ts";
import {
  attemptBoundNano,
  maxInputSide,
  maxOutputPrice,
  type CacheTtl,
  type Effort,
  type TokenPrices,
} from "../model/adapter.ts";
import { fallbacksOn } from "../model/anthropic.ts";
import { capabilitiesFor, modelInfo } from "../model/catalog.ts";
import { seededRandom } from "../model/clock.ts";
import {
  ALL_CARDS,
  FALLBACK_TARGETS,
  LEGACY_AT,
  billable,
  cardAt,
  cardsFrom,
  costOf,
  formatCents,
  type BillableCard,
  type PriceCard,
  type PriceContext,
} from "../model/prices.ts";
import { PROMPT_VERSION } from "../seat/prompt.ts";
import {
  BRIEFING_BYTES_PER_TOKEN,
  MIN_CALIBRATED_SEAT_DAYS,
  profileKeyLabel,
  profileKeyText,
  rulesetMajorOf,
  type ProfileKey,
} from "./calibrate.ts";
import {
  BOT_DAY_PROFILE,
  BRIEFING_TOKENS,
  EFFORT_FACTOR_PCT,
  IMPLICIT_HIT_PCT,
  PREFIX_TOKENS,
  PROJECTION_MARGIN_PCT,
  RESULTS_TOKENS,
  SCENARIOS,
  estimateCard,
  projectSpend,
  scenarioCard,
} from "./cost.ts";
import { PREFLIGHT_OUTPUT_TOKENS } from "./preflight.ts";

// The prediction of a run and its budget (phase-4 design §5.1–§5.3, Pass 1a): the `scenario` source
// only (phase 2's scenario, with the effort factor and today's cards; `calibrated` and
// `measured-point` arrive with Pass 2's profiles). Per LLM seat: low, central and high over the
// game days the run plays, the cards it can be billed at, and its attempt bound; for the match,
// the sum of the seat bounds (conservative). The reserve is what can still land after the kill
// switch fires: one attempt per LLM seat (`attemptBoundNano`), one probe of every preflight group,
// and the start preflight; the kill threshold is `K = budget − reserve`. `arena estimate` prints
// it, and `arena run` writes the same numbers to `estimate.json` once, before turn 1.
//
// Pass 1b: every provider. A seat's scenario is priced at its provider's card valid at the run's
// price instant (`priceAt`: the start, or `--price-date`), the platform fee included; its attempt
// bound and the preflight bounds take the highest prices of every card the seat can be billed at
// from that instant on (a later, dearer window included: a run that crosses a price change stays
// within its reserve), the long-context tiers its prompt cap can reach, and its model's own output
// limit for the `max_tokens` retry.
//
// Pass 2: the `measured-point` and `calibrated` sources (design §5.3), from the calibration
// profiles of `arena calibrate` (`arena/calibrate.ts`) whose key is the seat's (provider, model,
// endpoint, effort, prompt variant, reminder cadence, `maxTokens`, `PROMPT_VERSION`, ruleset major),
// on lockstep plans:
// - `measured-point` (1–2 seat-days): central = phase 2's projection (`projectSpend`: the bots'
//   per-day wake profile, +15%) of the measured spend of one seat, re-priced at the cards of the
//   planned wall times; low and high = central × the scenario's low/central and high/central ratios.
//   No percentiles.
// - `calibrated` (≥ 3 seat-days): a seeded bootstrap of 2,000 replicates. Per game day, a wake count
//   drawn from the seat-days measured on that day index, then that many whole wakes drawn from that
//   day's wakes; a day not measured draws a count from any seat-day, scaled by `BOT_DAY_PROFILE`,
//   and wakes from every day, each round's prompt grown by the briefing growth of 7-day fake runs
//   between the wake's day and this one. Every wake is priced at the card of its day's planned wall
//   time. Per seat p10 / p50 / p90; the match is the bootstrap of the seats' sum when every seat is
//   calibrated, else the sum of the seat bounds.

/** Replicates of the calibrated bootstrap (design §5.3). */
export const BOOTSTRAP_REPLICATES = 2_000;
/** The bootstrap's default seed: a prediction is reproducible (same seed, same figures). */
export const BOOTSTRAP_SEED = 20_261_019;
/** Wall hours of a 7-day lockstep match, at most (design §2.9: 10 to 15), an assumption. */
export const LOCKSTEP_WEEK_WALL_HOURS = 15;
/** The planned wall time of one lockstep game day. */
export const LOCKSTEP_WALL_MS_PER_GAME_DAY = Math.ceil((LOCKSTEP_WEEK_WALL_HOURS * 3_600_000) / 7);

/**
 * Wall milliseconds per game day of a plan, to choose the card of each planned day: 0 when every
 * attempt is priced at one pinned instant (`--fake`, `--price-date`); real time from its speed.
 */
export function plannedWallMsPerGameDay(
  clock:
    | { readonly kind: "lockstep" }
    | { readonly kind: "realtime"; readonly speed: { readonly num: number; readonly den: number } },
  priceFixed: string | null,
): number {
  if (priceFixed !== null) return 0;
  if (clock.kind === "lockstep") return LOCKSTEP_WALL_MS_PER_GAME_DAY;
  return Math.ceil((86_400_000 * clock.speed.den) / clock.speed.num);
}

/** One LLM seat as the prediction needs it. */
export interface PredictSeat {
  readonly seat: PlayerId;
  /** The provider whose cards bill the seat (the intended one for a fake seat). */
  readonly provider: string;
  readonly model: string;
  /** OpenRouter's pinned endpoint; null elsewhere. */
  readonly endpoint: string | null;
  readonly effort: Effort;
  readonly fallbacks: "default" | "off";
  readonly profile: string;
  /** An upper bound of the seat's preflight shape check prompt (`sampleTokensUpper`). */
  readonly sampleTokens: number;
  /** Pass 2: the seat's operator channel, part of its profile key (default `system`). */
  readonly promptVariant?: PromptVariant;
}

export interface SeatPrediction {
  readonly seat: PlayerId;
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string | null;
  readonly effort: Effort;
  readonly fallbacks: "default" | "off";
  readonly profile: string;
  readonly low: number;
  readonly central: number;
  readonly high: number;
  readonly source: PredictionSource;
  readonly priceCards: readonly string[];
  readonly attemptBoundNanoUsd: number;
}

export interface Reserve {
  readonly attemptBoundsNanoUsd: number;
  /** One probe: one check of every preflight group, cold. */
  readonly probeBoundNanoUsd: number;
  /** The start preflight, the same checks. */
  readonly startPreflightBoundNanoUsd: number;
  readonly reserveNanoUsd: number;
}

export interface Prediction {
  /** The game days the prediction covers (the run's stop, or the match). */
  readonly days: number;
  readonly seats: readonly SeatPrediction[];
  readonly match: {
    readonly low: number;
    readonly central: number;
    readonly high: number;
    readonly source: PredictionSource;
  };
  readonly reserve: Reserve;
  /** The prediction's assumptions and sources, in words (`estimate.json`, `arena estimate`). */
  readonly assumptions: readonly string[];
}

export interface PredictOptions {
  readonly days: number;
  readonly clock: "lockstep" | "realtime";
  readonly cacheTtl: CacheTtl;
  readonly maxTokens: number;
  readonly promptCapTokens: number;
  /** The UTC instant the cards are chosen at (the run's start, or `--price-date`). */
  readonly priceAt?: string;
  /** Pass 2: the calibration profiles to predict from (none: the scenario only). */
  readonly profiles?: readonly TokenProfile[];
  /** Pass 2: the plan's reminder cadence (profile key; default `every-round`). */
  readonly reminders?: ReminderCadence;
  /** Pass 2: the plan's ruleset id (its major is in the profile key); absent: no profile matches. */
  readonly ruleset?: string;
  /** Pass 2: wall milliseconds per game day (`plannedWallMsPerGameDay`); 0: every day at `priceAt`. */
  readonly wallMsPerGameDay?: number;
  /** Pass 2: the calibrated bootstrap's seed (default `BOOTSTRAP_SEED`). */
  readonly bootstrapSeed?: number;
}

/** Where a seat is billed: its provider, endpoint, and the instant its run starts. */
export interface BillingKey {
  readonly provider?: string;
  readonly endpoint?: string | null;
  readonly from?: string;
}

/** Every card and tier a seat can be billed at from `k.from` on, within its prompt cap. */
function servedCards(model: string, k: BillingKey, promptCap: number): BillableCard[] {
  const cards = cardsFrom(
    k.provider ?? "anthropic",
    model,
    k.endpoint ?? null,
    k.from ?? LEGACY_AT,
  );
  if (cards.length === 0) {
    throw new Error(
      `no price card for ${k.provider ?? "anthropic"}:${model} from ${k.from ?? LEGACY_AT}`,
    );
  }
  return billable(cards, promptCap);
}

/** The platform fee of a seat's cards (the highest), in permille. */
function feeOfCards(model: string, k: BillingKey): number {
  const cards = cardsFrom(
    k.provider ?? "anthropic",
    model,
    k.endpoint ?? null,
    k.from ?? LEGACY_AT,
  );
  return cards.reduce((m, c) => Math.max(m, c.platformFeePermille), 0);
}

/** The cards of each fallback target of `model`, when its fallbacks are on; else none. */
function fallbackCards(
  model: string,
  fallbacks: "default" | "off",
  k: BillingKey,
  promptCap: number,
): BillableCard[][] {
  if ((k.provider ?? "anthropic") !== "anthropic" || !fallbacksOn({ model, fallbacks })) return [];
  return (FALLBACK_TARGETS[model] ?? []).map((t) =>
    servedCards(t, { ...k, endpoint: null }, promptCap),
  );
}

/**
 * The most one attempt of a seat on `model` can cost (phase-4 design §5.2), billed by `k`'s
 * provider (default Anthropic, phase 2) from `k.from` on.
 */
export function seatAttemptBound(
  model: string,
  fallbacks: "default" | "off",
  maxTokens: number,
  promptCapTokens: number,
  k: BillingKey = {},
): number {
  const provider = k.provider ?? "anthropic";
  return attemptBoundNano(
    { maxOutputTokens: maxTokens, fallbacks },
    {
      served: servedCards(model, k, promptCapTokens),
      fallback: fallbackCards(model, fallbacks, k, promptCapTokens),
    },
    promptCapTokens,
    {
      modelMax: capabilitiesFor(provider, model, k.endpoint ?? null).maxOutputTokens,
      feePermille: feeOfCards(model, k),
    },
  );
}

/**
 * The most one preflight check of a group can cost, cold: its sample prompt (`sampleTokens`, an
 * upper bound) at the highest input-side price and `PREFLIGHT_OUTPUT_TOKENS` of output, once on the
 * model and once per fallback target when its fallbacks are on; the platform fee on top. Every
 * long-context tier counts, as in Pass 1a (an upper bound, whatever the sample's length).
 */
export function groupCheckBound(
  model: string,
  fallbacks: "default" | "off",
  sampleTokens: number,
  k: BillingKey = {},
): number {
  return callBound(model, fallbacks, sampleTokens, PREFLIGHT_OUTPUT_TOKENS, k, {
    tierCap: Number.POSITIVE_INFINITY,
  });
}

/**
 * The most one call of `promptTokens` (an upper bound) and at most `outputTokens` of output can
 * cost, cold, without a retry: the prompt at the highest input-side price of every card, tier and
 * geography it can be billed at, and the output at the highest output price, once on the model and
 * once per fallback target when its fallbacks are on; the platform fee on top (the preflight
 * checks, `arena smoke`). `tierCap`: the longest prompt the long-context tiers are checked against
 * (default `promptTokens`: a shorter prompt cannot reach a tier above it; the preflight bounds keep
 * every tier, as in Pass 1a). `ttl`: a request that marks only 5-minute writes is never billed a
 * 1-hour write.
 */
export function callBound(
  model: string,
  fallbacks: "default" | "off",
  promptTokens: number,
  outputTokens: number,
  k: BillingKey = {},
  o: { readonly tierCap?: number; readonly ttl?: CacheTtl } = {},
): number {
  const tierCap = o.tierCap ?? promptTokens;
  const at = (c: readonly TokenPrices[]): TokenPrices[] =>
    o.ttl === "5m" ? c.map((p) => ({ ...p, write1h: p.write5m })) : [...c];
  const one = (c: readonly TokenPrices[], permille: number): number => {
    const nano = Math.ceil(
      (promptTokens * maxInputSide(at(c)) + outputTokens * maxOutputPrice(c)) / 1000,
    );
    return nano + (permille === 0 ? 0 : Math.ceil((nano * permille) / 1000));
  };
  let n = one(servedCards(model, k, tierCap), feeOfCards(model, k));
  for (const f of fallbackCards(model, fallbacks, k, tierCap)) n += one(f, 0);
  return n;
}

/** The preflight groups of a set of seats: one per (provider, model, endpoint, effort, fallbacks). */
function groupKeys(seats: readonly PredictSeat[]): PredictSeat[] {
  const out = new Map<string, PredictSeat>();
  for (const s of seats) {
    const key = `${s.provider}/${s.model}@${s.endpoint ?? ""}/${s.effort}|${fallbacksOn(s) ? "fb" : "nofb"}`;
    const prev = out.get(key);
    // The largest sample of the group bounds it (seat blocks differ by a few bytes).
    if (prev === undefined || s.sampleTokens > prev.sampleTokens) out.set(key, s);
  }
  return [...out.values()];
}

type ProfileRound = TokenProfile["seatDays"][number]["wakes"][number]["rounds"][number];

/** A measured wake and the game day it was measured on. */
interface ProfileWake {
  readonly day: number;
  readonly rounds: readonly ProfileRound[];
}

/** One planned game day: its index, the share of it the run plays, the instant it is priced at. */
interface PlannedDay {
  readonly day: number;
  readonly share: number;
  readonly at: string;
}

/** An instant in ms as an ISO 8601 UTC string. */
const isoOf = (ms: number): string => new Date(ms).toISOString();

/** The bots' per-day wake weight of game day `d` (from 0; the last day repeats). */
const dayWeight = (d: number): number =>
  BOT_DAY_PROFILE[Math.min(d, BOT_DAY_PROFILE.length - 1)] ?? 0;

/** `v × num ÷ den`, rounded half up, exact (BigInt). */
function scaled(v: number, num: number, den: number): number {
  if (den <= 0) return v;
  const d = BigInt(den);
  return Number((BigInt(v) * BigInt(num) * 2n + d) / (2n * d));
}

/** The nearest-rank percentile `p` of ascending `sorted` values. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.max(0, Math.ceil((p * sorted.length) / 100) - 1);
  return sorted[Math.min(i, sorted.length - 1)] ?? 0;
}

/** The briefing growth of a profile as a function of the game day (the last day repeats). */
function growthOf(p: TokenProfile): (day: number) => number {
  const g = p.briefingGrowth.toSorted((a, b) => a.day - b.day);
  return (day) => {
    let v = g[0]?.briefingTokens ?? 0;
    for (const e of g) if (e.day <= day) v = e.briefingTokens;
    return v;
  };
}

/**
 * The cost of one measured wake at `ctx`, in nano-dollars (each attempt priced as the ledger prices
 * a usage entry, the platform fee included), with `delta` tokens of briefing growth: the first
 * attempt reads them uncached, the later ones in the share their prompt was read from the cache.
 * Uncached tokens are cache writes in the measured share (a profile without it: all of them), at
 * the plan's TTL bucket; implicit-cache cards bill writes as input.
 */
function wakeNanoAt(
  model: string,
  rounds: readonly ProfileRound[],
  delta: number,
  ctx: PriceContext,
  ttl: CacheTtl,
): number {
  let n = 0;
  for (const [i, r] of rounds.entries()) {
    const prompt = Math.max(0, r.promptTokens + delta);
    const grownRead =
      i === 0 || r.promptTokens === 0
        ? r.cacheReadTokens
        : r.cacheReadTokens + Math.round((delta * r.cacheReadTokens) / r.promptTokens);
    const read = Math.min(prompt, Math.max(0, grownRead));
    const uncached = prompt - read;
    const before = r.promptTokens - r.cacheReadTokens;
    const write =
      r.cacheWriteTokens === undefined || before <= 0
        ? uncached
        : Math.min(uncached, Math.round((uncached * r.cacheWriteTokens) / before));
    n += costOf(
      [
        {
          model,
          kind: "message",
          tokens: {
            input: uncached - write,
            cacheWrite5m: ttl === "1h" ? 0 : write,
            cacheWrite1h: ttl === "1h" ? write : 0,
            cacheRead: read,
            output: r.outputTokens,
          },
          estimated: false,
        },
      ],
      ctx,
    ).nanoUsd;
  }
  return n;
}

/** What a profile predicts for one seat. */
interface ProfilePrediction {
  readonly low: number;
  readonly central: number;
  readonly high: number;
  readonly source: "calibrated" | "measured-point";
  /** The bootstrap's replicate totals (calibrated), in replicate order. */
  readonly replicates: readonly number[] | null;
}

/**
 * The planned days of a run and the instant each is priced at: of its window's start and end
 * (`wallMsPerGameDay` from `priceAt`), the one whose card makes the measured wakes dearer.
 */
function plannedDays(
  s: PredictSeat,
  wakes: readonly ProfileWake[],
  o: PredictOptions,
  ttl: CacheTtl,
): PlannedDay[] {
  const start = Date.parse(o.priceAt ?? LEGACY_AT);
  const wall = o.wallMsPerGameDay ?? 0;
  const ctx = (at: string): PriceContext => ({ provider: s.provider, endpoint: s.endpoint, at });
  const poolAt = (at: string): number =>
    wakes.reduce((n, w) => n + wakeNanoAt(s.model, w.rounds, 0, ctx(at), ttl), 0);
  const out: PlannedDay[] = [];
  for (let d = 0; d < Math.ceil(o.days); d += 1) {
    const share = Math.min(1, o.days - d);
    const a = isoOf(start + d * wall);
    const b = isoOf(Math.max(start + d * wall, start + Math.ceil((d + share) * wall) - 1));
    const same =
      cardAt(s.provider, s.model, s.endpoint, a)?.id ===
      cardAt(s.provider, s.model, s.endpoint, b)?.id;
    out.push({ day: d, share, at: same || poolAt(a) >= poolAt(b) ? a : b });
  }
  return out;
}

/** `measured-point` (1–2 seat-days): phase 2's projection of one seat's measured spend, re-priced. */
function measuredPoint(
  s: PredictSeat,
  p: TokenProfile,
  days: readonly PlannedDay[],
  scenario: { readonly low: number; readonly central: number; readonly high: number },
  o: PredictOptions,
): ProfilePrediction {
  const ctx = (at: string): PriceContext => ({ provider: s.provider, endpoint: s.endpoint, at });
  const measured = [...new Set(p.seatDays.map((d) => d.day))].toSorted((a, b) => a - b);
  /** One seat's measured spend at `at`: per measured day, the mean of its seat-days. */
  const spendAt = (at: string): number =>
    measured.reduce((n, day) => {
      const of = p.seatDays.filter((sd) => sd.day === day);
      const sum = of.reduce(
        (m, sd) =>
          m +
          sd.wakes.reduce((k, w) => k + wakeNanoAt(s.model, w.rounds, 0, ctx(at), o.cacheTtl), 0),
        0,
      );
      return n + Math.round(sum / of.length);
    }, 0);
  const groups = new Map<string, number>();
  for (const d of days) groups.set(d.at, (groups.get(d.at) ?? 0) + dayWeight(d.day) * d.share);
  const prefix = measured.every((day, i) => day === i);
  let central: number;
  const only = [...groups.keys()];
  if (only.length === 1 && prefix && only[0] !== undefined) {
    central = projectSpend(spendAt(only[0]), measured.length, o.days);
  } else {
    const wm = measured.reduce((n, day) => n + dayWeight(day), 0);
    central = [...groups.entries()].reduce(
      (n, [at, w]) =>
        n + Math.round((spendAt(at) * w * (100 + PROJECTION_MARGIN_PCT)) / (wm * 100)),
      0,
    );
  }
  return {
    low: scaled(central, scenario.low, scenario.central),
    central,
    high: scaled(central, scenario.high, scenario.central),
    source: "measured-point",
    replicates: null,
  };
}

/** `calibrated` (≥ 3 seat-days): the seeded bootstrap of whole wakes by game day. */
function calibrated(
  s: PredictSeat,
  p: TokenProfile,
  days: readonly PlannedDay[],
  o: PredictOptions,
  seed: number,
): ProfilePrediction {
  const ctx = (at: string): PriceContext => ({ provider: s.provider, endpoint: s.endpoint, at });
  const wakes: ProfileWake[] = p.seatDays.flatMap((sd) =>
    sd.wakes.map((w) => ({ day: sd.day, rounds: w.rounds })),
  );
  const growth = growthOf(p);
  const counts = new Map<number, number[]>();
  for (const sd of p.seatDays) counts.set(sd.day, [...(counts.get(sd.day) ?? []), sd.wakes.length]);
  const anyDay = p.seatDays.map((sd) => ({ day: sd.day, count: sd.wakes.length }));
  // Per planned day: where its counts and wakes are drawn from, and every candidate wake's cost.
  const plan = days.map((d) => {
    const own = counts.get(d.day);
    const pool = wakes.flatMap((w, i) => (own === undefined || w.day === d.day ? [i] : []));
    const cost = pool.map((i) => {
      const w = wakes[i];
      if (w === undefined) return 0;
      const delta = own === undefined ? growth(d.day) - growth(w.day) : 0;
      return wakeNanoAt(s.model, w.rounds, delta, ctx(d.at), o.cacheTtl);
    });
    return { ...d, own, cost };
  });
  const rand = seededRandom(seed);
  const pick = (n: number): number => Math.min(n - 1, Math.floor(rand() * n));
  const totals: number[] = [];
  for (let b = 0; b < BOOTSTRAP_REPLICATES; b += 1) {
    let total = 0;
    for (const d of plan) {
      let n: number;
      if (d.own !== undefined) {
        n = d.own[pick(d.own.length)] ?? 0;
      } else {
        const from = anyDay[pick(anyDay.length)];
        n =
          from === undefined
            ? 0
            : Math.round((from.count * dayWeight(d.day)) / dayWeight(from.day));
      }
      if (d.share < 1) n = Math.round(n * d.share);
      if (d.cost.length === 0) continue;
      for (let k = 0; k < n; k += 1) total += d.cost[pick(d.cost.length)] ?? 0;
    }
    totals.push(total);
  }
  const sorted = totals.toSorted((a, b) => a - b);
  return {
    low: percentile(sorted, 10),
    central: percentile(sorted, 50),
    high: percentile(sorted, 90),
    source: "calibrated",
    replicates: totals,
  };
}

/** The bootstrap seed of the `i`-th LLM seat: one independent stream per seat. */
const seatSeed = (seed: number, i: number): number => (seed + Math.imul(i + 1, 0x9e3779b1)) >>> 0;

/** The profile key a seat would be measured under. */
function seatKey(s: PredictSeat, o: PredictOptions, ruleset: string): ProfileKey {
  return {
    provider: s.provider,
    model: s.model,
    endpoint: s.endpoint,
    effort: s.effort,
    promptVariant: s.promptVariant ?? "system",
    reminders: o.reminders ?? "every-round",
    maxTokens: o.maxTokens,
    promptVersion: PROMPT_VERSION,
    rulesetMajor: rulesetMajorOf(ruleset),
  };
}

const SOURCE_RANK: Readonly<Record<PredictionSource, number>> = {
  scenario: 0,
  "measured-point": 1,
  calibrated: 2,
};

/** The prediction and reserve of a run's LLM seats (the scenario, or their profiles: Pass 2). */
export function predict(seats: readonly PredictSeat[], o: PredictOptions): Prediction {
  const at = o.priceAt ?? LEGACY_AT;
  const byKey = new Map((o.profiles ?? []).map((p) => [profileKeyText(p.key), p]));
  const seed = o.bootstrapSeed ?? BOOTSTRAP_SEED;
  const used = new Map<string, { readonly profile: TokenProfile; readonly seats: PlayerId[] }>();
  const lockstepOnly: PlayerId[] = [];
  const replicates: (readonly number[] | null)[] = [];
  const predictions = seats.map((s, i): SeatPrediction => {
    const k: BillingKey = { provider: s.provider, endpoint: s.endpoint, from: at };
    const card = scenarioCard(s.model, { provider: s.provider, endpoint: s.endpoint, at });
    const e = estimateCard(card, o.days, o.clock, o.cacheTtl, s.effort);
    const cards = [
      ...servedCards(s.model, k, o.promptCapTokens),
      ...fallbackCards(s.model, s.fallbacks, k, o.promptCapTokens).flat(),
    ];
    const key = o.ruleset === undefined ? null : profileKeyText(seatKey(s, o, o.ruleset));
    const profile = key === null ? undefined : byKey.get(key);
    let measuredSeat: ProfilePrediction | null = null;
    if (profile !== undefined && profile.seatDays.length > 0) {
      if (o.clock !== "lockstep") {
        lockstepOnly.push(s.seat);
      } else {
        const wakes = profile.seatDays.flatMap((sd) =>
          sd.wakes.map((w) => ({ day: sd.day, rounds: w.rounds })),
        );
        const days = plannedDays(s, wakes, o, o.cacheTtl);
        measuredSeat =
          profile.seatDays.length >= MIN_CALIBRATED_SEAT_DAYS
            ? calibrated(s, profile, days, o, seatSeed(seed, i))
            : measuredPoint(s, profile, days, e, o);
        const u = used.get(key ?? "") ?? { profile, seats: [] };
        used.set(key ?? "", { profile, seats: [...u.seats, s.seat] });
      }
    }
    replicates.push(measuredSeat?.replicates ?? null);
    return {
      seat: s.seat,
      provider: s.provider,
      model: s.model,
      endpoint: s.endpoint,
      effort: s.effort,
      fallbacks: s.fallbacks,
      profile: s.profile,
      low: measuredSeat?.low ?? e.low,
      central: measuredSeat?.central ?? e.central,
      high: measuredSeat?.high ?? e.high,
      source: measuredSeat?.source ?? "scenario",
      priceCards: [...new Set(cards.map((c) => c.id))],
      attemptBoundNanoUsd: seatAttemptBound(
        s.model,
        s.fallbacks,
        o.maxTokens,
        o.promptCapTokens,
        k,
      ),
    };
  });
  const groups = groupKeys(seats);
  const probe = groups.reduce(
    (n, g) =>
      n +
      groupCheckBound(g.model, g.fallbacks, g.sampleTokens, {
        provider: g.provider,
        endpoint: g.endpoint,
        from: at,
      }),
    0,
  );
  const bounds = predictions.reduce((n, s) => n + s.attemptBoundNanoUsd, 0);
  const sum = (k: "low" | "central" | "high"): number => predictions.reduce((n, s) => n + s[k], 0);
  // The match: the bootstrap of the sum when every seat is calibrated, else the sum of the seat
  // bounds (conservative), labelled with the weakest seat source.
  const all = replicates.every((r) => r !== null) && replicates.length > 0;
  let match: Prediction["match"];
  if (all) {
    const totals = Array.from({ length: BOOTSTRAP_REPLICATES }, (_, b) =>
      replicates.reduce((n, r) => n + (r?.[b] ?? 0), 0),
    ).toSorted((a, b) => a - b);
    match = {
      low: percentile(totals, 10),
      central: percentile(totals, 50),
      high: percentile(totals, 90),
      source: "calibrated",
    };
  } else {
    const weakest = predictions.reduce<PredictionSource>(
      (w, s) => (SOURCE_RANK[s.source] < SOURCE_RANK[w] ? s.source : w),
      predictions.length === 0 ? "scenario" : "calibrated",
    );
    match = { low: sum("low"), central: sum("central"), high: sum("high"), source: weakest };
  }
  return {
    days: o.days,
    seats: predictions,
    match,
    reserve: {
      attemptBoundsNanoUsd: bounds,
      probeBoundNanoUsd: probe,
      startPreflightBoundNanoUsd: probe,
      reserveNanoUsd: bounds + 2 * probe,
    },
    assumptions: assumptionsOf(predictions, match, [...used.values()], lockstepOnly, o, seed),
  };
}

/** The seats of a source, for the assumption lines. */
const seatsOf = (ps: readonly SeatPrediction[], source: PredictionSource): string =>
  ps
    .filter((p) => p.source === source)
    .map((p) => p.seat)
    .join(", ");

/**
 * The assumptions of a prediction: the scenario's when a seat uses it, then each other source's,
 * the profiles drawn on and the planned wall times, and how the match interval is made. A
 * scenario-only prediction says exactly `scenarioAssumptions()`.
 */
function assumptionsOf(
  ps: readonly SeatPrediction[],
  match: Prediction["match"],
  used: readonly { readonly profile: TokenProfile; readonly seats: readonly PlayerId[] }[],
  lockstepOnly: readonly PlayerId[],
  o: PredictOptions,
  seed: number,
): string[] {
  const scenario = scenarioAssumptions();
  const out: string[] = [];
  if (ps.length === 0 || ps.some((p) => p.source === "scenario")) {
    out.push(...scenario.slice(0, -1));
  }
  if (lockstepOnly.length > 0) {
    out.push(
      `profiles are measured on lockstep runs: this real-time plan keeps the scenario for ${lockstepOnly.join(", ")}`,
    );
  }
  if (ps.some((p) => p.source === "measured-point")) {
    out.push(
      `source measured-point (${seatsOf(ps, "measured-point")}): 1–2 seat-days of a calibration profile, so no percentiles: central = the measured spend of one seat re-priced at the cards of the planned wall-clock times and projected to the run's days by phase 2's projection (the bots' per-day wake profile, +${PROJECTION_MARGIN_PCT}%); low and high = central × the scenario's low/central and high/central ratios`,
    );
  }
  if (ps.some((p) => p.source === "calibrated")) {
    out.push(
      `source calibrated (${seatsOf(ps, "calibrated")}): a seeded bootstrap (seed ${seed}, ${BOOTSTRAP_REPLICATES} replicates) of the profile's measured wakes: per game day a wake count drawn from the seat-days of that day (a day not measured: any seat-day's, scaled by the bots' per-day wake profile), then whole wakes of that day (a day not measured: of any day, each prompt grown by the briefing growth of 7-day --fake runs, at ${BRIEFING_BYTES_PER_TOKEN} bytes per token); low / central / high = p10 / p50 / p90`,
    );
  }
  for (const u of used) {
    const p = u.profile;
    // Only the bootstrap grows prompts; the projection of a measured point scales spend.
    const growth =
      p.seatDays.length < MIN_CALIBRATED_SEAT_DAYS
        ? ""
        : p.briefingGrowth.length === 0
          ? "; no briefing growth (days not measured keep the measured prompt sizes: biased low)"
          : `; briefing growth over ${p.briefingGrowth.length} game days`;
    out.push(
      `profile ${profileKeyLabel(p.key)} (${u.seats.join(", ")}): ${p.seatDays.length} seat-day(s) on game day(s) ${[...new Set(p.seatDays.map((d) => d.day + 1))].toSorted((a, b) => a - b).join(", ")} from ${p.runs.map((r) => r.run).join(", ")}${growth}`,
    );
  }
  if (used.length > 0) {
    const wall = o.wallMsPerGameDay ?? 0;
    out.push(
      wall === 0
        ? `measured wakes priced at the cards of ${o.priceAt ?? LEGACY_AT} (one pinned instant)`
        : `measured wakes priced at the cards of each game day's planned wall-clock time: from ${o.priceAt ?? LEGACY_AT}, ${(wall / 3_600_000).toFixed(2)} wall-clock hours per game day (lockstep: a 7-day match in at most ${LOCKSTEP_WEEK_WALL_HOURS} hours, an assumption), the dearer card of a day's window`,
    );
  }
  out.push(
    match.source === "calibrated"
      ? "the match interval is p10 / p50 / p90 of the bootstrap of the seats' sum (every seat calibrated)"
      : (scenario.at(-1) ?? ""),
  );
  return out;
}

/** The scenario's assumptions, in words (`estimate.json`, `arena estimate`). */
export function scenarioAssumptions(): string[] {
  const c = SCENARIOS.central;
  const l = SCENARIOS.low;
  const h = SCENARIOS.high;
  const f = EFFORT_FACTOR_PCT;
  return [
    `source scenario (phase 2 §8.1): ${c.wakesPerDayX100 / 100} wakes per seat per game day (high ${h.wakesPerDayX100 / 100}), ${c.roundTrips} round trips per wake (low ${l.roundTrips}, high ${h.roundTrips}), ${c.outputPerCall} output tokens per call at medium effort (low ${l.outputPerCall}, high ${h.outputPerCall}), thinking included`,
    `a ${PREFIX_TOKENS}-token stable prefix read from the cache, a ${BRIEFING_TOKENS}-token briefing, each round trip appending its reply and ${RESULTS_TOKENS} tokens of results; ${c.coldPct}% of wakes cold in lockstep (low none, high all)`,
    `effort factor on output per call (an assumption): low ${f.low / 100}, medium ${f.medium / 100}, high ${f.high / 100}, xhigh ${f.xhigh / 100}, max ${f.max / 100} (none and minimal as low)`,
    `implicit-cache cards (no write premium; hits not guaranteed): ${IMPLICIT_HIT_PCT.low}% of would-be cache reads hit in the low scenario, ${IMPLICIT_HIT_PCT.central}% in the central one, ${IMPLICIT_HIT_PCT.high}% in the high one (a miss bills as input) (an assumption)`,
    "platform fees (OpenRouter's 5.5% on credits) are included in every figure",
    "Opus-medium wake and round counts for every model: per-model verbosity is what calibration (Pass 2) replaces",
    "the match interval is the sum of the seat bounds (conservative)",
  ];
}

/** The budget part of a plan, when it has one. */
export interface PlanBudget {
  readonly budgetNanoUsd: number;
  readonly onBudget: "handoff" | "abort";
  readonly carryNanoUsd: number;
  /** The carried run directory and how many cost lines it had (`--budget-carry`). */
  readonly carryFrom: string | null;
  readonly carryLines: number;
  /** The part of the carry for attempts the carried run may have had in flight (its reserve). */
  readonly carryInFlightNanoUsd: number;
}

/** The kill threshold `K = budget − reserve` (may be ≤ 0 for a budget the plan refuses). */
export const killAtOf = (budget: PlanBudget, p: Prediction): number =>
  budget.budgetNanoUsd - p.reserve.reserveNanoUsd;

/** The reserve as the §4.2 messages print it. */
export function reserveText(r: Reserve): string {
  return `${formatCents(r.reserveNanoUsd)} = attempt bounds ${formatCents(r.attemptBoundsNanoUsd)} + one probe ${formatCents(r.probeBoundNanoUsd)} + start preflight ${formatCents(r.startPreflightBoundNanoUsd)}`;
}

/**
 * The budget checks of phase-4 design §4.2: a kill threshold below the predicted low (the carry
 * counted) refuses the plan with the message returned in `refusal`; below the predicted high, a
 * warning (the kill switch might fire, and the exit criterion would then fail).
 */
export function budgetCheck(
  budget: PlanBudget,
  p: Prediction,
  field: string,
): { readonly refusal: string | null; readonly warnings: readonly string[] } {
  const k = killAtOf(budget, p);
  const room = k - budget.carryNanoUsd;
  const carry = budget.carryNanoUsd > 0 ? ` and the carry ${formatCents(budget.carryNanoUsd)}` : "";
  const head = `budget ${formatCents(budget.budgetNanoUsd)} leaves K = ${formatCents(k)} after the reserve (${reserveText(p.reserve)})${carry}`;
  if (k <= 0 || room < p.match.low) {
    return {
      refusal: `${head}, below the predicted low ${formatCents(p.match.low)}: raise ${field}`,
      warnings: [],
    };
  }
  if (room < p.match.high) {
    return {
      refusal: null,
      warnings: [
        `${head}, below the predicted high ${formatCents(p.match.high)}: the kill switch might fire, and the exit criterion would then fail`,
      ],
    };
  }
  return { refusal: null, warnings: [] };
}

/** One LLM seat of `estimate.json` besides its prediction. */
export interface EstimateSeatExtras {
  readonly capNanoUsd: number;
  readonly wakeCapNanoUsd: number | null;
}

/** `estimate.json` (`perfidia-estimate/1`). */
export function estimateFile(o: {
  readonly priceAt?: string | null;
  readonly lineup: string | null;
  readonly ruleset: string;
  readonly players: number;
  readonly matchDays: number;
  readonly clock: "lockstep" | "realtime";
  readonly cacheTtl: CacheTtl;
  readonly maxTokens: number;
  readonly promptCapTokens: number;
  readonly prediction: Prediction;
  readonly extras: ReadonlyMap<PlayerId, EstimateSeatExtras>;
  readonly budget: PlanBudget | null;
}): EstimateFile {
  const p = o.prediction;
  return {
    format: "perfidia-estimate/1",
    lineup: o.lineup,
    ruleset: o.ruleset,
    players: o.players,
    matchDays: o.matchDays,
    days: p.days,
    clock: o.clock,
    cacheTtl: o.cacheTtl,
    maxTokens: o.maxTokens,
    promptCapTokens: o.promptCapTokens,
    ...(o.priceAt === undefined || o.priceAt === null ? {} : { priceAt: o.priceAt }),
    seats: p.seats.map((s) => ({
      seat: s.seat,
      provider: s.provider,
      model: s.model,
      ...(s.endpoint === null ? {} : { endpoint: s.endpoint }),
      effort: s.effort,
      fallbacks: s.fallbacks,
      profile: s.profile,
      capNanoUsd: o.extras.get(s.seat)?.capNanoUsd ?? 0,
      wakeCapNanoUsd: o.extras.get(s.seat)?.wakeCapNanoUsd ?? null,
      low: s.low,
      central: s.central,
      high: s.high,
      source: s.source,
      priceCards: [...s.priceCards],
      attemptBoundNanoUsd: s.attemptBoundNanoUsd,
    })),
    match: { ...p.match },
    reserve: { ...p.reserve },
    budget:
      o.budget === null
        ? null
        : {
            budgetNanoUsd: o.budget.budgetNanoUsd,
            killAtNanoUsd: Math.max(0, killAtOf(o.budget, p)),
            carryNanoUsd: o.budget.carryNanoUsd,
            onBudget: o.budget.onBudget,
          },
    assumptions: [...p.assumptions],
  };
}

/** A money column of the estimate table. */
function moneyCol(n: number): string {
  return formatCents(n).padEnd(10);
}

/** The prediction as text (`arena estimate`, and the start of `arena run`). */
export function formatEstimate(e: EstimateFile): string {
  const out: string[] = [];
  const stop = e.days === e.matchDays ? "" : ` (the run stops after ${e.days} of them)`;
  out.push(
    `estimate${e.lineup === null ? "" : ` for ${e.lineup}`}: ${e.ruleset} · ${e.players} players · ${e.matchDays} game day(s)${stop} · ${e.clock} · cache ${e.cacheTtl} · max_tokens ${e.maxTokens} · prompt cap ${e.promptCapTokens}`,
  );
  out.push(
    "seat  model              effort  fallbacks  cap        wake cap   low        central    high       attempt bound  source",
  );
  for (const s of e.seats) {
    out.push(
      [
        s.seat.padEnd(5),
        s.model.padEnd(18),
        s.effort.padEnd(7),
        s.fallbacks.padEnd(10),
        moneyCol(s.capNanoUsd),
        (s.wakeCapNanoUsd === null ? "off" : formatCents(s.wakeCapNanoUsd)).padEnd(10),
        moneyCol(s.low),
        moneyCol(s.central),
        moneyCol(s.high),
        formatCents(s.attemptBoundNanoUsd).padEnd(14),
        s.source,
      ].join(" "),
    );
  }
  const how =
    e.match.source === "calibrated"
      ? "p10 / p50 / p90 of the bootstrap of the sum"
      : "the sum of the seat bounds";
  out.push(
    `match (${e.match.source}, ${how}): ${formatCents(e.match.low)} low · ${formatCents(e.match.central)} central · ${formatCents(e.match.high)} high`,
  );
  out.push(`reserve ${reserveText(e.reserve)}`);
  if (e.budget === null) {
    out.push(
      "budget: none (no lineup budget and no --budget-usd): the per-seat caps bound the spend",
    );
  } else {
    const carry = e.budget.carryNanoUsd > 0 ? `, carry ${formatCents(e.budget.carryNanoUsd)}` : "";
    out.push(
      `budget ${formatCents(e.budget.budgetNanoUsd)}${carry} · kill threshold K = ${formatCents(e.budget.killAtNanoUsd)} (budget − reserve) · on budget: ${e.budget.onBudget}`,
    );
  }
  out.push(`price cards: ${[...new Set(e.seats.flatMap((s) => s.priceCards))].join(", ")}`);
  for (const a of e.assumptions) out.push(`assumption: ${a}`);
  return `${out.join("\n")}\n`;
}

/** The seat models' cards, in the order of the design's §5.4 table (fallback-only cards left out). */
export function seatCards(): PriceCard[] {
  return ALL_CARDS.filter((c) => capabilitiesFor(c.provider, c.model).efforts.length > 0).filter(
    (c) => {
      const info = modelInfo(c.provider, c.model);
      return info?.seat === true;
    },
  );
}

/** $/MTok of a pico-dollar price, as the sources print it. */
const perMTokText = (pico: number): string => {
  const whole = Math.floor(pico / 1_000_000);
  const frac = String(pico % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole}.${frac}`;
};

/**
 * The design's §5.4 table (`arena estimate --cards`): per seat-model card, its prices and the
 * scenario estimate (medium effort, lockstep, 5-minute TTL; implicit-cache cards at their hit
 * rates), 1-day central and 7-day low / central / high, without the platform fee (its own column).
 */
export function cardTable(): {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string | null;
  readonly window: string;
  readonly prices: string;
  readonly fee: string;
  readonly day1: number;
  readonly low: number;
  readonly central: number;
  readonly high: number;
}[] {
  return seatCards().map((c) => {
    const week = estimateCard(c, 7, "lockstep", "5m", "medium", { fees: false });
    const day = estimateCard(c, 1, "lockstep", "5m", "medium", { fees: false });
    const write = c.cache === "implicit" ? "–" : perMTokText(c.write5m);
    return {
      id: c.id,
      provider: c.provider,
      model: c.model,
      endpoint: c.endpoint,
      window: `${c.validFrom.slice(0, 10)}${c.validTo === null ? " on" : ` to ${c.validTo.slice(0, 10)}`}`,
      prices: `${perMTokText(c.input)} / ${perMTokText(c.output)} / ${perMTokText(c.cacheRead)} / ${write}`,
      fee: c.platformFeePermille === 0 ? "" : `${c.platformFeePermille / 10}%`,
      day1: day.central,
      low: week.low,
      central: week.central,
      high: week.high,
    };
  });
}

/** `arena estimate --cards`: the table as text. */
export function formatCardTable(): string {
  const rows = cardTable();
  const w = Math.max(...rows.map((r) => r.id.length));
  const out = [
    "seat-model cards (scenario: medium effort, 7 lockstep days, 5m TTL; implicit caches hit 100% low, 70% central, 0% high; platform fees apart)",
    [
      "card".padEnd(w),
      "window".padEnd(24),
      "in / out / read / write ($/MTok)".padEnd(32),
      "fee".padEnd(4),
      "1-day central".padEnd(13),
      "7-day low / central / high",
    ].join("  "),
  ];
  for (const r of rows) {
    out.push(
      [
        r.id.padEnd(w),
        r.window.padEnd(24),
        r.prices.padEnd(32),
        r.fee.padEnd(4),
        formatCents(r.day1).padEnd(13),
        `${formatCents(r.low)} / ${formatCents(r.central)} / ${formatCents(r.high)}`,
      ].join("  "),
    );
  }
  const apart = scenarioAssumptions().filter((a) => !a.startsWith("platform fees"));
  out.push(...apart.map((a) => `assumption: ${a}`));
  return `${out.join("\n")}\n`;
}
