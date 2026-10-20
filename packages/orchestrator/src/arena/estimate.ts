import type { PlayerId } from "@perfidia/protocol";
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
import {
  ALL_CARDS,
  FALLBACK_TARGETS,
  LEGACY_AT,
  billable,
  cardsFrom,
  formatCents,
  type BillableCard,
  type PriceCard,
} from "../model/prices.ts";
import {
  BRIEFING_TOKENS,
  EFFORT_FACTOR_PCT,
  IMPLICIT_HIT_PCT,
  PREFIX_TOKENS,
  RESULTS_TOKENS,
  SCENARIOS,
  estimateCard,
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
}

export interface PredictOptions {
  readonly days: number;
  readonly clock: "lockstep" | "realtime";
  readonly cacheTtl: CacheTtl;
  readonly maxTokens: number;
  readonly promptCapTokens: number;
  /** The UTC instant the cards are chosen at (the run's start, or `--price-date`). */
  readonly priceAt?: string;
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
  const one = (c: readonly TokenPrices[], permille: number): number => {
    const nano = Math.ceil(
      (sampleTokens * maxInputSide(c) + PREFLIGHT_OUTPUT_TOKENS * maxOutputPrice(c)) / 1000,
    );
    return nano + (permille === 0 ? 0 : Math.ceil((nano * permille) / 1000));
  };
  const all = Number.POSITIVE_INFINITY;
  let n = one(servedCards(model, k, all), feeOfCards(model, k));
  for (const f of fallbackCards(model, fallbacks, k, all)) n += one(f, 0);
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

/** The prediction and reserve of a run's LLM seats (scenario source). */
export function predict(seats: readonly PredictSeat[], o: PredictOptions): Prediction {
  const at = o.priceAt ?? LEGACY_AT;
  const predictions = seats.map((s): SeatPrediction => {
    const k: BillingKey = { provider: s.provider, endpoint: s.endpoint, from: at };
    const card = scenarioCard(s.model, { provider: s.provider, endpoint: s.endpoint, at });
    const e = estimateCard(card, o.days, o.clock, o.cacheTtl, s.effort);
    const cards = [
      ...servedCards(s.model, k, o.promptCapTokens),
      ...fallbackCards(s.model, s.fallbacks, k, o.promptCapTokens).flat(),
    ];
    return {
      seat: s.seat,
      provider: s.provider,
      model: s.model,
      endpoint: s.endpoint,
      effort: s.effort,
      fallbacks: s.fallbacks,
      profile: s.profile,
      low: e.low,
      central: e.central,
      high: e.high,
      source: "scenario",
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
  return {
    days: o.days,
    seats: predictions,
    match: { low: sum("low"), central: sum("central"), high: sum("high"), source: "scenario" },
    reserve: {
      attemptBoundsNanoUsd: bounds,
      probeBoundNanoUsd: probe,
      startPreflightBoundNanoUsd: probe,
      reserveNanoUsd: bounds + 2 * probe,
    },
  };
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
    assumptions: scenarioAssumptions(),
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
  out.push(
    `match (${e.match.source}, the sum of the seat bounds): ${formatCents(e.match.low)} low · ${formatCents(e.match.central)} central · ${formatCents(e.match.high)} high`,
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
