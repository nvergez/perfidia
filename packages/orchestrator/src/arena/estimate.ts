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
import { FALLBACK_TARGETS, cardsOf, formatCents, type PriceCard } from "../model/prices.ts";
import {
  BRIEFING_TOKENS,
  EFFORT_FACTOR_PCT,
  PREFIX_TOKENS,
  RESULTS_TOKENS,
  SCENARIOS,
  estimateSeat,
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

/** One LLM seat as the prediction needs it. */
export interface PredictSeat {
  readonly seat: PlayerId;
  readonly provider: string;
  readonly model: string;
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
}

/** The cards of each fallback target of `model`, when its fallbacks are on; else none. */
function fallbackCards(model: string, fallbacks: "default" | "off"): PriceCard[][] {
  if (!fallbacksOn({ model, fallbacks })) return [];
  return (FALLBACK_TARGETS[model] ?? []).map(cardsOf);
}

/** The most one attempt of a seat on `model` can cost (phase-4 design §5.2). */
export function seatAttemptBound(
  model: string,
  fallbacks: "default" | "off",
  maxTokens: number,
  promptCapTokens: number,
): number {
  return attemptBoundNano(
    { maxOutputTokens: maxTokens, fallbacks },
    { served: cardsOf(model), fallback: fallbackCards(model, fallbacks) },
    promptCapTokens,
  );
}

/**
 * The most one preflight check of a group can cost, cold: its sample prompt (`sampleTokens`, an
 * upper bound) at the highest input-side price and `PREFLIGHT_OUTPUT_TOKENS` of output, once on the
 * model and once per fallback target when its fallbacks are on.
 */
export function groupCheckBound(
  model: string,
  fallbacks: "default" | "off",
  sampleTokens: number,
): number {
  const one = (c: readonly TokenPrices[]): number =>
    sampleTokens * maxInputSide(c) + PREFLIGHT_OUTPUT_TOKENS * maxOutputPrice(c);
  let n = one(cardsOf(model));
  for (const f of fallbackCards(model, fallbacks)) n += one(f);
  return n;
}

/** The preflight groups of a set of seats: one per (provider, model, effort, fallbacks on). */
function groupKeys(seats: readonly PredictSeat[]): PredictSeat[] {
  const out = new Map<string, PredictSeat>();
  for (const s of seats) {
    const key = `${s.provider}/${s.model}/${s.effort}|${fallbacksOn(s) ? "fb" : "nofb"}`;
    const prev = out.get(key);
    // The largest sample of the group bounds it (seat blocks differ by a few bytes).
    if (prev === undefined || s.sampleTokens > prev.sampleTokens) out.set(key, s);
  }
  return [...out.values()];
}

/** The prediction and reserve of a run's LLM seats (scenario source, Pass 1a). */
export function predict(seats: readonly PredictSeat[], o: PredictOptions): Prediction {
  const predictions = seats.map((s): SeatPrediction => {
    const e = estimateSeat(s.model, o.days, o.clock, o.cacheTtl, s.effort);
    const cards = [...cardsOf(s.model), ...fallbackCards(s.model, s.fallbacks).flat()];
    return {
      seat: s.seat,
      provider: s.provider,
      model: s.model,
      effort: s.effort,
      fallbacks: s.fallbacks,
      profile: s.profile,
      low: e.low,
      central: e.central,
      high: e.high,
      source: "scenario",
      priceCards: [...new Set(cards.map((c) => c.id))],
      attemptBoundNanoUsd: seatAttemptBound(s.model, s.fallbacks, o.maxTokens, o.promptCapTokens),
    };
  });
  const groups = groupKeys(seats);
  const probe = groups.reduce(
    (n, g) => n + groupCheckBound(g.model, g.fallbacks, g.sampleTokens),
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
    `effort factor on output per call (an assumption): low ${f.low / 100}, medium ${f.medium / 100}, high ${f.high / 100}, xhigh ${f.xhigh / 100}, max ${f.max / 100}`,
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
    seats: p.seats.map((s) => ({
      seat: s.seat,
      provider: s.provider,
      model: s.model,
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
