import { parseWar } from "@perfidia/bots";
import { fmtTime } from "@perfidia/engine/core";
import type { JsonObject, LogLine, PlayerId } from "@perfidia/protocol";
import { controllerText, type ControllerSpan } from "@perfidia/sim";
import {
  ARENA_REPORT_FORMAT,
  ArenaReportSchema,
  type ArenaBudget,
  type ArenaReport,
  type ArenaSeatReport,
  type ArenaStatus,
  type EstimateFile,
  type Exit4,
  type ExitCriterion,
  type LlmCallLine,
  type LlmLogLine,
  type PauseLine,
  type PreflightLine,
} from "../log/schema.ts";
import { ZERO_TOKENS, type TokenUsage, type UsageEntry } from "../model/adapter.ts";
import { formatCents, formatUsd, picoByKind, priceOf, type PriceContext } from "../model/prices.ts";
import { PROMPT_VERSION } from "../seat/prompt.ts";
import {
  costRows,
  daysCovered,
  estimateCard,
  preflightSpend,
  projectSpend,
  repricePreflight,
  scenarioCard,
} from "./cost.ts";
import {
  DEFAULT_ARENA_DAYS,
  isLoopback,
  llmSeatsOf,
  matchEndOf,
  providerEnv,
  type ArenaPlan,
} from "./plan.ts";
import { providerInfo } from "./providers.ts";

// `arena.json` (phase-2 design §6): a pure fold over the match log, the LLM log and the plan. Per
// LLM seat: cost by token kind, attempts, stops, errors, refusals, fallbacks and served-by shares,
// cache misses, wake caps, prompt-cap stops, thought coverage, think time, rejections, the
// hand-off; then the totals, the a-priori estimate and the projection of the measured spend (§5.4,
// §5.5), the recommended real-time speed, pauses and alerts, Level E, and the exit criterion: an
// alliance formed and a betrayal, overall and with an LLM seat as betrayer or victim.
//
// Phase 4 (`perfidia-arena/2`): the `budget` block (budget, reserve, kill threshold, carry, the
// stored prediction, the actual spend split into attempts, start preflight and probes, the kill
// switch, the wall window, spend by provider), every figure a sum of logged line costs, and the
// `exit4` block, roadmap step 4's criterion (`reconciled` stays null until `arena reconcile`).
// Pass 1b: costs by kind at each seat's provider card (the one the ledger charged), spend by
// provider and endpoint, platform fees and the providers' own reported costs.

export const HARNESS_VERSION = "orchestrator/1";

/** Minimum travel time of the map in game-seconds: the real-time speed rule's numerator (§10.2). */
export const MIN_TRAVEL_S = 3_600;

export interface LevelE {
  readonly ok: boolean;
  readonly actions: number;
  readonly checkpoints: number;
  readonly divergence: string | null;
}

export interface DayRow {
  readonly day: number;
  readonly seat: PlayerId;
  readonly dayNanoUsd: number;
  readonly spentNanoUsd: number;
  readonly projectedNanoUsd: number;
}

export interface ReportInput {
  readonly plan: ArenaPlan;
  readonly status: ArenaStatus;
  readonly reason: string | null;
  readonly lines: readonly LogLine[];
  readonly calls: readonly LlmLogLine[];
  readonly alerts: readonly string[];
  readonly days: readonly DayRow[];
  readonly levelE: LevelE | null;
  /** `estimate.json` as written before turn 1, and its sha256; null when none was written. */
  readonly estimate: { readonly file: EstimateFile; readonly sha256: string } | null;
  /** The run's wall window (`end` null while it runs). */
  readonly wall: { readonly start: string | null; readonly end: string | null };
}

/** Controller spans per seat: the header's, then one per `controller` line. */
export function controllerSpans(lines: readonly LogLine[]): Map<PlayerId, ControllerSpan[]> {
  const out = new Map<PlayerId, ControllerSpan[]>();
  for (const l of lines) {
    if (l.k === "header") {
      for (const [seat, label] of Object.entries(l.controllers)) {
        out.set(`p${Number(seat.slice(1))}`, [{ label, from: 0 }]);
      }
    } else if (l.k === "controller") {
      out.get(l.seat)?.push({ label: l.label, from: l.t });
    }
  }
  return out;
}

/** The label that played `seat` at `t`. */
export function controllerAt(spans: Map<PlayerId, ControllerSpan[]>, seat: string, t: number) {
  let label = "";
  for (const s of spans.get(`p${Number(seat.slice(1))}`) ?? []) if (s.from <= t) label = s.label;
  return label;
}

const isLlm = (label: string): boolean => label.startsWith("llm:");

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function bump(rec: Record<string, number>, key: string, by = 1): void {
  rec[key] = (rec[key] ?? 0) + by;
}

function sorted(rec: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(rec).toSorted(byText)) {
    out[k] = rec[k] ?? 0;
  }
  return out;
}

/** Nearest-rank percentiles of integer samples. */
function percentiles(values: readonly number[]): {
  turns: number;
  p50: number;
  p95: number;
  max: number;
} {
  if (values.length === 0) return { turns: 0, p50: 0, p95: 0, max: 0 };
  const s = values.toSorted((a, b) => a - b);
  const at = (q: number): number => s[Math.max(0, Math.ceil(q * s.length) - 1)] ?? 0;
  return { turns: s.length, p50: at(0.5), p95: at(0.95), max: s.at(-1) ?? 0 };
}

const addTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
  cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
});

const entryOf = (u: LlmCallLine["usage"][number]): UsageEntry => ({
  model: u.model,
  kind: u.kind,
  tokens: {
    input: u.input,
    cacheWrite5m: u.cacheWrite5m,
    cacheWrite1h: u.cacheWrite1h,
    cacheRead: u.cacheRead,
    output: u.output,
  },
  estimated: u.estimated,
  ...(u.geo === undefined ? {} : { geo: u.geo }),
});

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** speed ≤ minTravel / (10 × 1.5 × p95 think time), as a reduced fraction (§10.2, question 5). */
export function recommendedSpeed(p95ThinkMs: number): ArenaReport["recommendedSpeed"] {
  if (p95ThinkMs <= 0) return null;
  const num = MIN_TRAVEL_S * 1000 * 2;
  const den = 10 * 3 * p95ThinkMs;
  const g = gcd(num, den);
  return { p95ThinkMs, num: num / g, den: den / g, approx: Math.round((num * 100) / den) / 100 };
}

function stringField(data: JsonObject, key: string): string | null {
  const v = Object.hasOwn(data, key) ? data[key] : undefined;
  return typeof v === "string" ? v : null;
}

/** The exit criterion (§6): alliances formed and betrayals, overall and with an LLM seat. */
export function exitCriterion(lines: readonly LogLine[]): ExitCriterion {
  const spans = controllerSpans(lines);
  const events: ExitCriterion["events"] = [];
  let alliances = 0;
  let betrayals = 0;
  let llmAlliances = 0;
  let asBetrayer = 0;
  let asVictim = 0;
  let llmBetrayals = 0;
  for (const l of lines) {
    if (l.k !== "ev") continue;
    const d = l.e.data;
    if (l.e.type === "alliance_formed") {
      const raw = Object.hasOwn(d, "members") ? d["members"] : undefined;
      const members = (Array.isArray(raw) ? raw : []).flatMap((m): PlayerId[] =>
        typeof m === "string" ? [`p${Number(m.slice(1))}`] : [],
      );
      const llm = members.filter((m) => isLlm(controllerAt(spans, m, l.t)));
      alliances += 1;
      if (llm.length > 0) llmAlliances += 1;
      events.push({
        t: l.t,
        time: fmtTime(l.t),
        type: "alliance_formed",
        seats: members,
        relation: null,
        llm,
      });
    } else if (l.e.type === "betrayal") {
      const by = stringField(d, "by");
      const against = stringField(d, "against");
      if (by === null || against === null) continue;
      const seats: PlayerId[] = [`p${Number(by.slice(1))}`, `p${Number(against.slice(1))}`];
      const llm = seats.filter((s) => isLlm(controllerAt(spans, s, l.t)));
      betrayals += 1;
      const b = llm.includes(seats[0] ?? "p0");
      const v = llm.includes(seats[1] ?? "p0");
      if (b) asBetrayer += 1;
      if (v) asVictim += 1;
      if (b || v) llmBetrayals += 1;
      events.push({
        t: l.t,
        time: fmtTime(l.t),
        type: "betrayal",
        seats,
        relation: stringField(d, "relation"),
        llm,
      });
    }
  }
  return {
    alliancesFormed: alliances,
    betrayals,
    met: alliances > 0 && betrayals > 0,
    llm: {
      alliances: llmAlliances,
      asBetrayer,
      asVictim,
      betrayals: llmBetrayals,
      met: alliances > 0 && llmBetrayals > 0,
    },
    events,
  };
}

/** A run whose LLM turns closed by an error reach this share (in percent) is `degraded`. */
export const DEGRADED_ERROR_PCT = 25;
/** ... once it has at least this many LLM turns. */
export const DEGRADED_MIN_TURNS = 8;

/** LLM turns closed by an error, of all LLM turns; `degraded` past `DEGRADED_ERROR_PCT`. */
export function turnErrors(r: ArenaReport): {
  readonly errors: number;
  readonly turns: number;
  readonly degraded: boolean;
} {
  let errors = 0;
  let turns = 0;
  for (const s of r.seats) {
    turns += s.thoughts.turns;
    errors += s.thoughts.byWhy["error"]?.turns ?? 0;
  }
  const degraded = turns >= DEGRADED_MIN_TURNS && errors * 100 >= DEGRADED_ERROR_PCT * turns;
  return { errors, turns, degraded };
}

/** Builds `arena.json`; validated by its schema. */
export function buildReport(r: ReportInput): ArenaReport {
  const plan = r.plan;
  const spans = controllerSpans(r.lines);
  const header = r.lines[0]?.k === "header" ? r.lines[0] : null;
  let lastT = 0;
  let end: { t: number; reason: string; winners: PlayerId[] } | null = null;
  for (const l of r.lines) {
    if (l.k !== "header") lastT = Math.max(lastT, l.t);
    if (l.k === "end") end = { t: l.t, reason: l.result.reason, winners: [...l.result.winners] };
  }
  const days = matchEndOf(plan) / 86_400;
  const measuredDays = daysCovered(end?.t ?? lastT);
  // A calibration run (`--stop-after 1`) or a short match is projected to a full week (§5.5).
  const toDays = Math.max(DEFAULT_ARENA_DAYS, days);
  const clockKind = plan.clock.kind;
  const llmCalls = r.calls.filter((l): l is LlmCallLine => l.k === "llm_call");

  const seats: ArenaSeatReport[] = llmSeatsOf(plan).map((s): ArenaSeatReport => {
    const mine = llmCalls.filter((l) => l.seat === s.seat);
    const costByKind = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
    let tokens: TokenUsage = ZERO_TOKENS;
    const stops: Record<string, number> = {};
    const errors: Record<string, number> = {};
    const refusals: Record<string, number> = {};
    const servedBy: Record<string, number> = {};
    const unpriced = new Set<string>();
    const thinkByTurn = new Map<number, number>();
    let cost = 0;
    let fallbacks = 0;
    let cacheMisses = 0;
    for (const l of mine) {
      cost += l.costNanoUsd;
      bump(stops, l.stop);
      if (l.error !== null) bump(errors, l.error.kind);
      if (l.stop === "refusal") bump(refusals, l.refusal?.category ?? "uncategorised");
      if (l.servedBy !== null) bump(servedBy, l.servedBy);
      if (l.fallback) fallbacks += 1;
      if (l.cacheMiss) cacheMisses += 1;
      for (const m of l.unpriced) unpriced.add(m);
      thinkByTurn.set(l.turn, (thinkByTurn.get(l.turn) ?? 0) + l.latencyMs);
      // The card the ledger charged: the seat's provider, at the attempt's start or the pin.
      const ctx: PriceContext = {
        provider: s.provider,
        endpoint: s.endpoint,
        at: plan.priceFixed ?? l.wallStart ?? plan.priceAt,
      };
      for (const u of l.usage) {
        const e = entryOf(u);
        const k = picoByKind(e, priceOf(e, ctx).prices);
        tokens = addTokens(tokens, e.tokens);
        costByKind.input += Math.ceil(k.input / 1000);
        costByKind.cacheWrite5m += Math.ceil(k.cacheWrite5m / 1000);
        costByKind.cacheWrite1h += Math.ceil(k.cacheWrite1h / 1000);
        costByKind.cacheRead += Math.ceil(k.cacheRead / 1000);
        costByKind.output += Math.ceil(k.output / 1000);
      }
    }
    const llmTurn = (seat: string, t: number): boolean =>
      seat === s.seat && isLlm(controllerAt(spans, seat, t));
    const byWhy: Record<string, { turns: number; withThought: number }> = {};
    let turns = 0;
    let withThought = 0;
    let calls = 0;
    const rejections: Record<string, number> = {};
    for (const l of r.lines) {
      if (l.k === "turn" && llmTurn(l.seat, l.t)) {
        turns += 1;
        calls += l.calls;
        const w = (byWhy[l.why] ??= { turns: 0, withThought: 0 });
        w.turns += 1;
        if (l.thought !== undefined) {
          withThought += 1;
          w.withThought += 1;
        }
      } else if (l.k === "gw" && llmTurn(l.seat, l.t)) {
        bump(rejections, l.r.code);
      } else if (l.k === "act" && !l.r.ok && llmTurn(l.seat, l.t)) {
        bump(rejections, l.r.code);
      }
    }
    const handoffLine = r.calls.find((l) => l.k === "handoff" && l.seat === s.seat);
    const controllerLine = r.lines.find(
      (l): l is Extract<LogLine, { k: "controller" }> =>
        l.k === "controller" && l.seat === s.seat && !isLlm(l.label),
    );
    const est = estimateCard(
      scenarioCard(s.model, { provider: s.provider, endpoint: s.endpoint, at: plan.priceAt }),
      days,
      clockKind,
      plan.cacheTtl,
      s.effort,
    );
    return {
      seat: s.seat,
      label: header?.controllers[s.seat] ?? "",
      controllers: controllerText(spans.get(s.seat) ?? []),
      profile: `${s.profile.id}@${s.profile.version}`,
      name: s.profile.name,
      provider: plan.fake ? "fake" : s.provider,
      model: s.model,
      effort: s.effort,
      capNanoUsd: s.capNanoUsd,
      costNanoUsd: cost,
      costByKind,
      tokens,
      attempts: mine.length,
      stops: sorted(stops),
      errors: sorted(errors),
      refusals: sorted(refusals),
      fallbacks,
      servedBy: sorted(servedBy),
      cacheMisses,
      wakeCaps: r.calls.filter((l) => l.k === "wake_cap" && l.seat === s.seat).length,
      unpriced: [...unpriced].toSorted(byText),
      thoughts: { turns, withThought, byWhy },
      thinkMs: percentiles([...thinkByTurn.values()]),
      rejections: sorted(rejections),
      calls,
      handoff:
        handoffLine?.k === "handoff"
          ? {
              t: controllerLine?.t ?? handoffLine.t,
              time: fmtTime(controllerLine?.t ?? handoffLine.t),
              label: handoffLine.label,
              spentNanoUsd: handoffLine.spentNanoUsd,
              reason: handoffLine.reason,
            }
          : null,
      promptCaps: r.calls.filter((l) => l.k === "prompt_cap" && l.seat === s.seat).length,
      estimate: { low: est.low, central: est.central, high: est.high },
      projectedNanoUsd: projectSpend(cost, measuredDays, toDays),
    };
  });

  const bots = (header === null ? [] : Object.keys(header.controllers))
    .map((seat): PlayerId => `p${Number(seat.slice(1))}`)
    .filter((seat) => !seats.some((x) => x.seat === seat))
    .map((seat) => ({ seat, controllers: controllerText(spans.get(seat) ?? []) }));

  let tokens: TokenUsage = ZERO_TOKENS;
  for (const s of seats) tokens = addTokens(tokens, s.tokens);
  const prompt = tokens.input + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead;
  const attempts = seats.reduce((n, s) => n + s.attempts, 0);
  const fallbacks = seats.reduce((n, s) => n + s.fallbacks, 0);
  const allThink = llmCalls.reduce((m, l) => {
    const k = `${l.seat}:${l.turn}`;
    m.set(k, (m.get(k) ?? 0) + l.latencyMs);
    return m;
  }, new Map<string, number>());

  let warCalls = 0;
  for (const l of r.lines) {
    if (l.k !== "ev" || l.e.type !== "message") continue;
    const from = stringField(l.e.data, "from");
    const text = stringField(l.e.data, "text");
    const to = Object.hasOwn(l.e.data, "to") ? l.e.data["to"] : undefined;
    if (from === null || text === null || !Array.isArray(to)) continue;
    if (!isLlm(controllerAt(spans, from, l.t))) continue;
    const toBot = to.some((x) => typeof x === "string" && !isLlm(controllerAt(spans, x, l.t)));
    if (toBot && parseWar(text).length > 0) warCalls += 1;
  }

  const levelE = r.levelE;
  const budget = budgetBlock(r, llmCalls);
  const exit4 = exit4Of(r, budget, llmCalls);
  const baseUrls = baseUrlsOf(plan);
  const seatsCost = seats.reduce((n, s) => n + s.costNanoUsd, 0);
  const pre = preflightSpend(r.calls);

  const report: ArenaReport = {
    format: ARENA_REPORT_FORMAT,
    status: r.status,
    reason: r.reason,
    fake: plan.fake,
    ruleset: plan.setup.ruleset,
    seed: plan.setup.seed,
    players: plan.setup.seats.length,
    days,
    clock:
      plan.clock.kind === "lockstep"
        ? "lockstep"
        : `realtime ${plan.clock.speed.num}/${plan.clock.speed.den} (${plan.time})`,
    promptVersion: PROMPT_VERSION,
    harness: HARNESS_VERSION,
    ...(baseUrls === null ? {} : { baseUrls }),
    lastT,
    endedAt: end?.t ?? null,
    result: end === null ? null : { reason: end.reason, winners: end.winners },
    seats,
    bots,
    totals: {
      costNanoUsd: seatsCost + pre.start + pre.probes,
      attempts,
      tokens,
      cacheReadPct: prompt === 0 ? 0 : Math.round((tokens.cacheRead * 100) / prompt),
      fallbackPermille: attempts === 0 ? 0 : Math.round((fallbacks * 1000) / attempts),
      preflightNanoUsd: pre.start + pre.probes,
    },
    estimate: {
      low: seats.reduce((n, s) => n + s.estimate.low, 0),
      central: seats.reduce((n, s) => n + s.estimate.central, 0),
      high: seats.reduce((n, s) => n + s.estimate.high, 0),
    },
    projection: {
      fromDays: Math.round(measuredDays * 1000) / 1000,
      toDays,
      costNanoUsd: seats.reduce((n, s) => n + s.projectedNanoUsd, 0),
    },
    recommendedSpeed: recommendedSpeed(percentiles([...allThink.values()]).p95),
    pauses: r.calls.filter((l): l is PauseLine => l.k === "pause"),
    alerts: [...r.alerts],
    daily: [...r.days],
    llmToBotWarCalls: warCalls,
    levelE,
    exit: exitCriterion(r.lines),
    budget,
    exit4,
  };
  return ArenaReportSchema.parse(report);
}

/** Whether any usage entry of `l` is an estimate (a broken stream, a failed count). */
function isEstimated(l: { readonly usage: readonly { readonly estimated: boolean }[] }): boolean {
  return l.usage.some((u) => u.estimated);
}

/** The `budget` block (phase 4 §5.5): every figure a sum of logged line costs. */
export function budgetBlock(r: ReportInput, llmCalls: readonly LlmCallLine[]): ArenaBudget {
  const plan = r.plan;
  const pre = preflightSpend(r.calls);
  const attemptsNanoUsd = llmCalls.reduce((n, l) => n + l.costNanoUsd, 0);
  const actual = attemptsNanoUsd + pre.start + pre.probes;
  const preflights = r.calls.filter((l): l is PreflightLine => l.k === "preflight");
  const estimatedNanoUsd =
    llmCalls.reduce((n, l) => n + (isEstimated(l) ? l.costNanoUsd : 0), 0) +
    preflights.reduce((n, l) => n + (isEstimated(l) ? l.costNanoUsd : 0), 0);
  const byProvider = new Map<
    string,
    {
      provider: string;
      endpoint: string | null;
      attempts: number;
      nanoUsd: number;
      estimatedNanoUsd: number;
      reportedNanoUsd: number | null;
    }
  >();
  let feesNanoUsd = 0;
  const add = (
    l: {
      readonly provider: string;
      readonly endpoint?: string | null | undefined;
      readonly costNanoUsd: number;
      readonly feeNanoUsd?: number | undefined;
      readonly reportedCostNanoUsd?: number | undefined;
    },
    estimated: boolean,
    attempt: boolean,
  ): void => {
    const endpoint = l.endpoint ?? null;
    const key = `${l.provider}\u0000${endpoint ?? ""}`;
    const row = byProvider.get(key) ?? {
      provider: l.provider,
      endpoint,
      attempts: 0,
      nanoUsd: 0,
      estimatedNanoUsd: 0,
      reportedNanoUsd: null,
    };
    row.nanoUsd += l.costNanoUsd;
    if (estimated) row.estimatedNanoUsd += l.costNanoUsd;
    if (attempt) row.attempts += 1;
    if (l.reportedCostNanoUsd !== undefined) {
      row.reportedNanoUsd = (row.reportedNanoUsd ?? 0) + l.reportedCostNanoUsd;
    }
    feesNanoUsd += l.feeNanoUsd ?? 0;
    byProvider.set(key, row);
  };
  for (const l of llmCalls) add(l, isEstimated(l), true);
  for (const l of preflights) add(l, isEstimated(l), false);
  const killLine = r.calls.find((l) => l.k === "kill_switch");
  const carry = plan.budget?.carryNanoUsd ?? 0;
  const budgetNanoUsd = plan.budget?.budgetNanoUsd ?? null;
  const stored = r.estimate;
  const low = stored?.file.match.low ?? null;
  const high = stored?.file.match.high ?? null;
  return {
    budgetNanoUsd,
    reserveNanoUsd: plan.prediction.reserve.reserveNanoUsd,
    killAtNanoUsd:
      budgetNanoUsd === null
        ? null
        : Math.max(0, budgetNanoUsd - plan.prediction.reserve.reserveNanoUsd),
    carryNanoUsd: carry,
    onBudget: plan.budget?.onBudget ?? "handoff",
    estimate:
      stored === null
        ? null
        : {
            sha256: stored.sha256,
            low: stored.file.match.low,
            central: stored.file.match.central,
            high: stored.file.match.high,
            source: stored.file.match.source,
          },
    actualNanoUsd: actual,
    attemptsNanoUsd,
    preflightNanoUsd: pre.start,
    probeNanoUsd: pre.probes,
    estimatedNanoUsd,
    feesNanoUsd,
    under: budgetNanoUsd === null ? null : actual + carry <= budgetNanoUsd,
    // The prediction covers the seats' attempts (the scenario has no preflight): the attempts are
    // compared with it, the start preflight and probes are reported apart (phase-4 review).
    withinPrediction:
      low === null || high === null ? null : attemptsNanoUsd >= low && attemptsNanoUsd <= high,
    killSwitch:
      killLine?.k === "kill_switch"
        ? {
            fired: true,
            t: killLine.t,
            wall: killLine.wall ?? null,
            spentNanoUsd: killLine.spentNanoUsd,
          }
        : null,
    wall: { start: r.wall.start, end: r.wall.end },
    byProvider: [...byProvider.entries()]
      .toSorted(([a], [b]) => byText(a, b))
      .map(([, row]) => ({
        provider: row.provider,
        endpoint: row.endpoint,
        attempts: row.attempts,
        nanoUsd: row.nanoUsd,
        reportedNanoUsd: row.reportedNanoUsd,
        estimatedNanoUsd: row.estimatedNanoUsd,
      })),
  };
}

/**
 * The `exit4` block (phase 4 §5.1): a lockstep match that ended, at least 2 distinct served models
 * among the LLM seats' attempts, its prediction stored before turn 1, no hand-off of any reason and
 * no kill switch, its attempt spend inside the stored [low, high] and its total under the budget,
 * Level E, and reconciled (null until `arena reconcile` fills it, so `met` is false until then). A
 * `--fake` run computes every part but is never `met`: no model served it and nothing was spent.
 */
export function exit4Of(
  r: ReportInput,
  budget: ArenaBudget,
  llmCalls: readonly LlmCallLine[],
): Exit4 {
  const served = new Set<string>();
  for (const l of llmCalls) if (l.servedBy !== null) served.add(l.servedBy);
  const handoffs = r.calls.some((l) => l.k === "handoff");
  const parts = {
    models: served.size,
    ended: r.status === "ended" && r.plan.clock.kind === "lockstep",
    estimateStored: r.estimate !== null,
    noHandoff: !handoffs && budget.killSwitch === null,
    withinPrediction: budget.withinPrediction === true,
    under: budget.under === true,
    levelE: r.levelE?.ok === true,
    reconciled: null,
  };
  const loopback = onLoopback(baseUrlsOf(r.plan));
  return { ...parts, met: exit4Met(parts, { fake: r.plan.fake, loopback }) };
}

/**
 * The origins of the plan's base URLs that are not their provider's default, by provider (the M1
 * rehearsal: a run against a stub left no trace and could reach `met`); null when every LLM seat
 * uses its provider's default, and on `--fake` (no network).
 */
export function baseUrlsOf(plan: ArenaPlan): Record<string, string> | null {
  if (plan.fake) return null;
  const out: Record<string, string> = {};
  for (const s of llmSeatsOf(plan)) {
    const fallback = providerInfo(s.provider)?.defaultBaseUrl ?? null;
    const base = providerEnv(plan.env, s.provider).baseURL ?? fallback;
    if (base === null) continue;
    const origin = new URL(base).origin;
    if (fallback === null || origin !== new URL(fallback).origin) out[s.provider] = origin;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** Whether a recorded base URL is on loopback: a stub or a local proxy, which a claim cannot tell from the provider. */
export function onLoopback(baseUrls: Readonly<Record<string, string>> | null | undefined): boolean {
  return Object.values(baseUrls ?? {}).some(isLoopback);
}

/**
 * `exit4.met`: every part holds, with at least two served models and a reconciled run, and the
 * run was real (a `--fake` run rehearses the path at $0: it never meets the criterion) and served
 * by the providers' own hosts (`loopback`: a base URL on loopback, a stub or a local proxy).
 */
export function exit4Met(
  e: Omit<Exit4, "met">,
  o: { readonly fake: boolean; readonly loopback: boolean },
): boolean {
  return (
    !o.fake &&
    !o.loopback &&
    e.models >= 2 &&
    e.ended &&
    e.estimateStored &&
    e.noHandoff &&
    e.withinPrediction &&
    e.under &&
    e.levelE &&
    e.reconciled === true
  );
}

const usd = formatUsd;

/** The start of a `--stop-after` run's reason. */
export const STOPPED = "stopped at the end of game day";

/** The report as text, for the end of `arena run`. */
export function formatReport(r: ArenaReport): string {
  const out: string[] = [];
  out.push(
    `arena: ${r.status}${r.reason === null ? "" : ` (${r.reason})`} · ${r.ruleset} · seed ${r.seed} · ${r.players} players · ${r.clock}${r.fake ? " · fake models" : ""}`,
  );
  if (r.baseUrls !== undefined) {
    const list = Object.entries(r.baseUrls).map(([p, origin]) => `${p} ${origin}`);
    out.push(
      `base URLs: ${list.join(", ")} (not the providers' defaults${onLoopback(r.baseUrls) ? "; on loopback, a stub or a local proxy: the exit criterion of step 4 is never met" : ""})`,
    );
  }
  if (r.result !== null) {
    out.push(
      `result: ${r.result.reason} at ${fmtTime(r.endedAt ?? 0)}, winners ${r.result.winners.join(", ") || "none"}`,
    );
  } else out.push(`stopped at ${fmtTime(r.lastT)}`);
  out.push(
    "seat  cost         attempts  turns  thought  think p50/p95 s  errors  refusals  fallbacks  hand-off",
  );
  for (const s of r.seats) {
    const errors = Object.values(s.errors).reduce((n, x) => n + x, 0);
    const refusals = Object.values(s.refusals).reduce((n, x) => n + x, 0);
    out.push(
      [
        s.seat.padEnd(4),
        usd(s.costNanoUsd).padEnd(11),
        String(s.attempts).padStart(8),
        String(s.thoughts.turns).padStart(6),
        `${s.thoughts.withThought}/${s.thoughts.turns}`.padStart(8),
        `${Math.round(s.thinkMs.p50 / 1000)}/${Math.round(s.thinkMs.p95 / 1000)}`.padStart(16),
        String(errors).padStart(7),
        String(refusals).padStart(9),
        String(s.fallbacks).padStart(10),
        s.handoff === null ? "  -" : `  ${s.handoff.label} at ${s.handoff.time}`,
      ].join(" "),
    );
  }
  for (const b of r.bots) out.push(`${b.seat.padEnd(4)} ${b.controllers}`);
  out.push(
    `total ${usd(r.totals.costNanoUsd)} (preflight ${usd(r.totals.preflightNanoUsd)}), cache reads ${r.totals.cacheReadPct}% of prompt tokens, fallbacks ${r.totals.fallbackPermille}‰`,
  );
  // Under one measured day the projection multiplies minutes of spend by days (the M1 rehearsal
  // printed $1,077.92 for an abort at 00:10): arena.json keeps it, the text leaves it out.
  out.push(
    `estimate for ${r.days} days: ${usd(r.estimate.low)} low · ${usd(r.estimate.central)} central · ${usd(r.estimate.high)} high; ${r.projection.fromDays < 1 ? `no projection (${r.projection.fromDays} measured day(s), under one)` : `projection from ${r.projection.fromDays} measured day(s): ${usd(r.projection.costNanoUsd)}`}`,
  );
  if (r.recommendedSpeed !== null) {
    out.push(
      `real-time speed for a later real-time run of these seats ≤ ${r.recommendedSpeed.num}/${r.recommendedSpeed.den} (≈ ${r.recommendedSpeed.approx}), from p95 think time ${Math.round(r.recommendedSpeed.p95ThinkMs / 1000)} s`,
    );
  }
  const e = r.exit;
  out.push(
    `exit criterion: ${e.alliancesFormed} alliance(s) formed, ${e.betrayals} betrayal(s): ${e.met ? "met" : "not met"}; with an LLM seat: ${e.llm.betrayals} betrayal(s) (${e.llm.asBetrayer} as betrayer, ${e.llm.asVictim} as victim), ${e.llm.alliances} alliance(s): ${e.llm.met ? "met" : "not met"}`,
  );
  if (r.levelE !== null) {
    const ok =
      r.status === "stopped" || r.reason?.startsWith(STOPPED) === true ? "ok up to the stop" : "ok";
    // An aborted log has no end line by design: when that is its only divergence, Level E holds
    // up to the abort (arena.json keeps `ok: false`, as `sim verify` reads the log).
    const cut = r.status === "aborted" && r.levelE.divergence?.startsWith("end at") === true;
    out.push(
      cut
        ? `Level E: ok up to the abort (${r.levelE.actions} actions, ${r.levelE.checkpoints} checkpoints; no end line: the run was aborted)`
        : `Level E: ${r.levelE.ok ? ok : "FAILED"} (${r.levelE.actions} actions, ${r.levelE.checkpoints} checkpoints)${r.levelE.divergence === null ? "" : `: ${r.levelE.divergence}`}`,
    );
  }
  const b = r.budget;
  const parts = [
    `spent ${formatCents(b.actualNanoUsd)} (attempts ${formatCents(b.attemptsNanoUsd)}, start preflight ${formatCents(b.preflightNanoUsd)}, probes ${formatCents(b.probeNanoUsd)}${b.estimatedNanoUsd > 0 ? `, of which estimated ${formatCents(b.estimatedNanoUsd)}` : ""})`,
  ];
  if (b.estimate !== null) {
    parts.push(
      `prediction ${formatCents(b.estimate.low)}–${formatCents(b.estimate.high)} (${b.estimate.source}): ${b.withinPrediction === true ? "inside" : "outside"}`,
    );
  }
  if (b.budgetNanoUsd !== null) {
    parts.push(
      `budget ${formatCents(b.budgetNanoUsd)}${b.carryNanoUsd > 0 ? ` (carry ${formatCents(b.carryNanoUsd)})` : ""}, K = ${formatCents(b.killAtNanoUsd ?? 0)}: ${b.under === true ? "under" : "OVER"}`,
    );
  } else parts.push("no match budget");
  if (b.killSwitch !== null) parts.push(`kill switch fired at ${fmtTime(b.killSwitch.t)}`);
  out.push(`budget: ${parts.join("; ")}`);
  const x = r.exit4;
  out.push(
    `exit criterion of step 4: ${x.met ? "met" : "not met"} (models ${x.models}, ended ${x.ended}, estimate stored ${x.estimateStored}, no hand-off ${x.noHandoff}, within prediction ${x.withinPrediction}, under budget ${x.under}, Level E ${x.levelE}, reconciled ${x.reconciled === null ? "not yet: run arena reconcile" : x.reconciled})`,
  );
  for (const a of r.alerts) out.push(`alert: ${a}`);
  return `${out.join("\n")}\n`;
}

/**
 * `arena cost <run-dir>`: spend per seat and model, then the preflight and probes, from the logged
 * costs (phase 4: a card changed since the run never rewrites what it cost). `reprice`: every line
 * at today's cards, with the difference.
 */
export function formatCost(
  lines: readonly LlmLogLine[],
  o: { reprice?: boolean; at?: string } = {},
): string {
  const llmCalls = lines.filter((l): l is LlmCallLine => l.k === "llm_call");
  const rows = costRows(llmCalls);
  const out = [
    "seat  model                attempts  input      write      read        output     cost",
  ];
  let total = 0;
  for (const r of rows) {
    total += r.nanoUsd;
    out.push(
      [
        r.seat.padEnd(5),
        r.model.padEnd(20),
        String(r.calls).padStart(8),
        String(r.input).padStart(10),
        String(r.cacheWrite).padStart(10),
        String(r.cacheRead).padStart(11),
        String(r.output).padStart(10),
        ` ${usd(r.nanoUsd)}`,
      ].join(" "),
    );
  }
  const pre = preflightSpend(lines);
  if (lines.some((l) => l.k === "preflight")) {
    out.push(`preflight ${usd(pre.start)} · probes ${usd(pre.probes)} (${pre.probeCount} checks)`);
  }
  total += pre.start + pre.probes;
  const carry = lines.reduce((n, l) => n + (l.k === "carry" ? l.costNanoUsd : 0), 0);
  out.push(
    `total ${usd(total)}${carry > 0 ? ` (plus ${usd(carry)} carried from an earlier run)` : ""}`,
  );
  if (o.reprice === true) {
    const again =
      costRows(llmCalls, { reprice: true, ...(o.at === undefined ? {} : { at: o.at }) }).reduce(
        (n, r) => n + r.nanoUsd,
        0,
      ) + lines.reduce((n, l) => n + (l.k === "preflight" ? repricePreflight(l, o.at) : 0), 0);
    out.push(
      `repriced at today's cards: ${usd(again)} (${again >= total ? "+" : "-"}${usd(Math.abs(again - total))})`,
    );
  }
  return `${out.join("\n")}\n`;
}
