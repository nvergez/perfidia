import { DAY } from "@perfidia/engine/core";
import type { LlmCallLine, LlmLogLine, PreflightLine } from "../log/schema.ts";
import { type CacheTtl, type Effort, type UsageEntry } from "../model/adapter.ts";
import { entryCost, requirePrice, type Price } from "../model/prices.ts";

// Cost figures of the arena (phase-2 design §5.4, §5.5; phase-4 design §5.3, §5.5):
// - `estimateSeat`: the a-priori estimate of one LLM seat for a match, from the design's
//   assumptions (wakes per day, round trips per wake, a stable prefix read from the cache, a
//   conversation that grows by each reply and its results) and the price table. It reproduces the
//   design's table: about $83 for 4 Opus 5.5 seats at `medium` over 7 lockstep days. Phase 4 adds
//   the effort factor on output per call (an assumption: low 0.6, medium 1.0, high 1.5, xhigh 2.0,
//   max 3.0), so `medium` figures are phase 2's.
// - `projectSpend`: the projection of a measured run to a longer match. A short run is biased low
//   (fewer wakes on day 1, no war yet), so the measured spend is scaled by the bots' per-day wake
//   profile, then 15% is added.
// - `costRows`: spend per seat and model from `llm_calls.jsonl` (`arena cost`): the logged costs,
//   which are the source of truth (phase 4); `repriceRows` recomputes them with today's cards.

/** The assumptions of one estimate scenario (§5.4). */
export interface Scenario {
  /** Wakes per seat per game day, in hundredths (15.5 → 1550). */
  readonly wakesPerDayX100: number;
  /** API calls (round trips) per wake. */
  readonly roundTrips: number;
  /** Output tokens per call, thinking included. */
  readonly outputPerCall: number;
  /** Share of wakes whose stable prefix is cold, in percent. */
  readonly coldPct: number;
}

/** Tools + shared block + seat block, in tokens. */
export const PREFIX_TOKENS = 9_500;
/** The briefing and notes of round 0. */
export const BRIEFING_TOKENS = 1_500;
/** What a round trip appends besides the echoed reply: the results and the reminder. */
export const RESULTS_TOKENS = 1_500;

export const SCENARIOS = {
  /** Lockstep: wakes are dense in time, so 20% of them find the prefix cold. */
  central: { wakesPerDayX100: 1550, roundTrips: 4, outputPerCall: 1_500, coldPct: 20 },
  low: { wakesPerDayX100: 1550, roundTrips: 2, outputPerCall: 800, coldPct: 0 },
  high: { wakesPerDayX100: 2000, roundTrips: 6, outputPerCall: 3_000, coldPct: 100 },
} as const satisfies Record<string, Scenario>;

/**
 * The cost of one wake in nano-dollars: each round trip's prompt is the previous one plus the reply
 * it echoes and its results; everything new is a cache write (at the tail's 5-minute price), the
 * rest a cache read; a cold wake also writes the stable prefix (at `prefixTtl`'s price).
 */
export function wakeCostNano(p: Price, s: Scenario, cold: boolean, prefixTtl: CacheTtl): number {
  let prompt = PREFIX_TOKENS + BRIEFING_TOKENS;
  let written = BRIEFING_TOKENS;
  let read = 0;
  for (let r = 0; r < s.roundTrips; r += 1) {
    if (r > 0) {
      const added = s.outputPerCall + RESULTS_TOKENS;
      prompt += added;
      written += added;
    }
    read += prompt;
  }
  read -= written;
  let cost = written * p.write5m + s.roundTrips * s.outputPerCall * p.output;
  if (cold) {
    read -= PREFIX_TOKENS;
    cost += PREFIX_TOKENS * (prefixTtl === "1h" ? p.write1h : p.write5m);
  }
  return cost + read * p.cacheRead;
}

/**
 * The effort factor on output per call, in percent (phase-4 design §5.3, an assumption that
 * calibration replaces): the scenario's output tokens per call are phase 2's Opus `medium` figures.
 */
export const EFFORT_FACTOR_PCT: Readonly<Record<Effort, number>> = Object.freeze({
  low: 60,
  medium: 100,
  high: 150,
  xhigh: 200,
  max: 300,
});

/** `s` with its output per call scaled by `effort`'s factor (rounded to whole tokens). */
export function withEffort(s: Scenario, effort: Effort): Scenario {
  return { ...s, outputPerCall: Math.round((s.outputPerCall * EFFORT_FACTOR_PCT[effort]) / 100) };
}

export interface SeatEstimate {
  readonly model: string;
  readonly days: number;
  /** Nano-dollars per scenario. */
  readonly low: number;
  readonly central: number;
  readonly high: number;
}

/**
 * The estimate of one seat over `days` game days (§5.4). Lockstep, and real time with a 1-hour
 * TTL, find the prefix cold on 20% of the wakes; real time with a 5-minute TTL on every wake.
 */
export function estimateSeat(
  model: string,
  days: number,
  clock: "lockstep" | "realtime",
  ttl: CacheTtl,
  effort: Effort = "medium",
  price?: Price,
): SeatEstimate {
  const p = price ?? requirePrice(model);
  const scenario = (base: Scenario, coldPct: number): number => {
    const s = withEffort(base, effort);
    const wakesX100 = s.wakesPerDayX100 * days;
    const warm = wakeCostNano(p, s, false, ttl);
    const cold = wakeCostNano(p, s, true, ttl);
    const perWakeX100 = (100 - coldPct) * warm + coldPct * cold;
    return Math.round((wakesX100 * perWakeX100) / 10_000);
  };
  const allCold = clock === "realtime" && ttl === "5m";
  return {
    model,
    days,
    low: scenario(SCENARIOS.low, SCENARIOS.low.coldPct),
    central: scenario(SCENARIOS.central, allCold ? 100 : SCENARIOS.central.coldPct),
    high: scenario(SCENARIOS.high, SCENARIOS.high.coldPct),
  };
}

/** The central scenario's cost of one wake (20% of wakes cold in lockstep), in nano-dollars. */
export function centralWakeNano(
  model: string,
  clock: "lockstep" | "realtime",
  ttl: CacheTtl,
  effort: Effort = "medium",
): number {
  const p = requirePrice(model);
  const s = withEffort(SCENARIOS.central, effort);
  const coldPct = clock === "realtime" && ttl === "5m" ? 100 : s.coldPct;
  const perWakeX100 =
    (100 - coldPct) * wakeCostNano(p, s, false, ttl) + coldPct * wakeCostNano(p, s, true, ttl);
  return Math.round(perWakeX100 / 100);
}

/**
 * Wakes of all six bot seats per game day, summed over seeds 1–4 of a 7-day `perfidia-1@1.1.0`
 * lockstep match whose seats play the arena lineup's bots (opportunist@3, conqueror@3, turtle@3,
 * opportunist@3, opportunist@3, conqueror@3). Measured with `bun run sim -- run --players 6
 * --days 7 --seed <s> --seat p1=opportunist@3 …`. Day 1 is 13% under the mean; days 5–6 are the
 * busiest. Beyond day 7 the last day repeats.
 */
export const BOT_DAY_PROFILE: readonly number[] = Object.freeze([
  337, 313, 368, 400, 434, 444, 420,
]);

/** Weight of game day `d` (from 0) in the profile. */
const dayWeight = (d: number): number =>
  BOT_DAY_PROFILE[Math.min(d, BOT_DAY_PROFILE.length - 1)] ?? 0;

/** Margin of the projection, in percent (§5.5). */
export const PROJECTION_MARGIN_PCT = 15;

/** The profile weight of the first `days` game days; a partial day counts for its share. */
function weightOf(days: number): number {
  let w = 0;
  for (let d = 0; d < days; d += 1) w += dayWeight(d) * Math.min(1, days - d);
  return w;
}

/**
 * The spend of `measuredDays` game days played (fractional: a run that stopped within a day counts
 * that share of it) projected to `days`: scaled by the bots' per-day profile, plus 15%. With
 * `days ≤ measuredDays` the measured spend is returned unchanged; nothing measured projects to 0.
 */
export function projectSpend(spentNano: number, measuredDays: number, days: number): number {
  if (measuredDays <= 0) return 0;
  if (days <= measuredDays) return spentNano;
  return Math.round(
    (spentNano * weightOf(days) * (100 + PROJECTION_MARGIN_PCT)) / (weightOf(measuredDays) * 100),
  );
}

/** Game days a run covered, from its last game time: fractional, a partial day for its share. */
export const daysCovered = (lastT: number): number => Math.max(0, lastT) / DAY;

/** Spend per seat and model, from `llm_call` lines. */
export interface CostRow {
  readonly seat: string;
  readonly model: string;
  readonly calls: number;
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
  readonly nanoUsd: number;
}

const seatNo = (s: string): number => Number(s.slice(1));

const entryOf = (u: LlmCallLine["usage"][number]): UsageEntry => ({
  model: u.model,
  kind: u.kind,
  tokens: u,
  estimated: u.estimated,
});

/**
 * One line's logged cost spread over its usage entries: every entry but the last at its card's
 * price, the last the rest, so the rows of a line add up to its logged cost exactly (one entry, the
 * common case, simply takes it). `reprice`: every entry at today's cards instead.
 */
function lineCosts(
  usage: LlmCallLine["usage"],
  logged: number,
  reprice: boolean,
): readonly number[] {
  const priced = usage.map((u) => entryCost(entryOf(u)).nanoUsd);
  if (reprice || priced.length === 0) return priced;
  const head = priced.slice(0, -1);
  const rest = logged - head.reduce((a, b) => a + b, 0);
  return [...head, Math.max(0, rest)];
}

/**
 * One row per (seat, served-or-billed model), seat order then model, from the logged costs (the
 * source of truth, phase 4: a card changed since the run never rewrites what it cost); a line's
 * cost is spread over its usage entries (`lineCosts`). `reprice`: today's cards instead.
 */
export function costRows(lines: readonly LlmCallLine[], o: { reprice?: boolean } = {}): CostRow[] {
  const rows = new Map<string, CostRow>();
  for (const l of lines) {
    const costs = lineCosts(l.usage, l.costNanoUsd, o.reprice === true);
    for (const [i, u] of l.usage.entries()) {
      const key = `${l.seat}\u0000${u.model}`;
      const prev = rows.get(key) ?? {
        seat: l.seat,
        model: u.model,
        calls: 0,
        input: 0,
        cacheWrite: 0,
        cacheRead: 0,
        output: 0,
        nanoUsd: 0,
      };
      rows.set(key, {
        ...prev,
        calls: prev.calls + 1,
        input: prev.input + u.input,
        cacheWrite: prev.cacheWrite + u.cacheWrite5m + u.cacheWrite1h,
        cacheRead: prev.cacheRead + u.cacheRead,
        output: prev.output + u.output,
        nanoUsd: prev.nanoUsd + (costs[i] ?? 0),
      });
    }
  }
  return [...rows.values()].toSorted(
    (a, b) =>
      seatNo(a.seat) - seatNo(b.seat) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
  );
}

/** The logged spend of the start preflight and of the probes (`preflight` lines). */
export function preflightSpend(lines: readonly LlmLogLine[]): {
  readonly start: number;
  readonly probes: number;
  readonly probeCount: number;
} {
  let start = 0;
  let probes = 0;
  let probeCount = 0;
  for (const l of lines) {
    if (l.k !== "preflight") continue;
    if (l.phase === "start") start += l.costNanoUsd;
    else {
      probes += l.costNanoUsd;
      probeCount += 1;
    }
  }
  return { start, probes, probeCount };
}

/** What a preflight line would cost at today's cards (`--reprice`). */
export function repricePreflight(l: PreflightLine): number {
  return l.usage.reduce((n, u) => n + entryCost(entryOf(u)).nanoUsd, 0);
}

/**
 * Everything a run directory's `llm_calls.jsonl` says was spent: every `llm_call`, `preflight` and
 * `carry` line's logged cost (`--budget-carry` sums this).
 */
export function loggedSpend(lines: readonly LlmLogLine[]): { nanoUsd: number; lines: number } {
  let nanoUsd = 0;
  let n = 0;
  for (const l of lines) {
    if (l.k === "llm_call" || l.k === "preflight" || l.k === "carry") {
      nanoUsd += l.costNanoUsd;
      n += 1;
    }
  }
  return { nanoUsd, lines: n };
}
