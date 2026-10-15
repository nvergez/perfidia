import { parseWar } from "@perfidia/bots";
import { fmtTime } from "@perfidia/engine/core";
import type { JsonObject, LogLine, PlayerId } from "@perfidia/protocol";
import { controllerText, type ControllerSpan } from "@perfidia/sim";
import {
  ARENA_REPORT_FORMAT,
  ArenaReportSchema,
  type ArenaReport,
  type ArenaSeatReport,
  type ArenaStatus,
  type ExitCriterion,
  type LlmCallLine,
  type LlmLogLine,
  type PauseLine,
} from "../log/schema.ts";
import { ZERO_TOKENS, type TokenUsage, type UsageEntry } from "../model/adapter.ts";
import { formatUsd, priceFor } from "../model/prices.ts";
import { PROMPT_VERSION } from "../seat/prompt.ts";
import { costRows, daysCovered, estimateSeat, projectSpend } from "./cost.ts";
import { DEFAULT_ARENA_DAYS, llmSeatsOf, matchEndOf, type ArenaPlan } from "./plan.ts";

// `arena.json` (phase-2 design §6): a pure fold over the match log, the LLM log and the plan. Per
// LLM seat: cost by token kind, attempts, stops, errors, refusals, fallbacks and served-by shares,
// cache misses, wake caps, thought coverage, think time, rejections, the hand-off; then the
// totals, the a-priori estimate and the projection of the measured spend (§5.4, §5.5), the
// recommended real-time speed, pauses and alerts, Level E, and the exit criterion: an alliance
// formed and a betrayal, overall and with an LLM seat as betrayer or victim.

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
  readonly preflightNanoUsd: number;
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
  const days = Math.round(matchEndOf(plan) / 86_400);
  const measuredDays = daysCovered(end?.t ?? lastT);
  // A calibration run (`--days 1` or 2) is projected to a full match (§5.5).
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
      for (const u of l.usage) {
        const e = entryOf(u);
        const p = priceFor(e).price;
        tokens = addTokens(tokens, e.tokens);
        costByKind.input += u.input * p.input;
        costByKind.cacheWrite5m += u.cacheWrite5m * p.write5m;
        costByKind.cacheWrite1h += u.cacheWrite1h * p.write1h;
        costByKind.cacheRead += u.cacheRead * p.cacheRead;
        costByKind.output += u.output * p.output;
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
    const est = estimateSeat(s.model, days, clockKind, plan.cacheTtl);
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
            }
          : null,
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
    lastT,
    endedAt: end?.t ?? null,
    result: end === null ? null : { reason: end.reason, winners: end.winners },
    seats,
    bots,
    totals: {
      costNanoUsd: seats.reduce((n, s) => n + s.costNanoUsd, 0),
      attempts,
      tokens,
      cacheReadPct: prompt === 0 ? 0 : Math.round((tokens.cacheRead * 100) / prompt),
      fallbackPermille: attempts === 0 ? 0 : Math.round((fallbacks * 1000) / attempts),
      preflightNanoUsd: r.preflightNanoUsd,
    },
    estimate: {
      low: seats.reduce((n, s) => n + s.estimate.low, 0),
      central: seats.reduce((n, s) => n + s.estimate.central, 0),
      high: seats.reduce((n, s) => n + s.estimate.high, 0),
    },
    projection: {
      fromDays: measuredDays,
      toDays,
      costNanoUsd: seats.reduce((n, s) => n + s.projectedNanoUsd, 0),
    },
    recommendedSpeed: recommendedSpeed(percentiles([...allThink.values()]).p95),
    pauses: r.calls.filter((l): l is PauseLine => l.k === "pause"),
    alerts: [...r.alerts],
    daily: [...r.days],
    llmToBotWarCalls: warCalls,
    levelE: r.levelE,
    exit: exitCriterion(r.lines),
  };
  return ArenaReportSchema.parse(report);
}

const usd = formatUsd;

/** The report as text, for the end of `arena run`. */
export function formatReport(r: ArenaReport): string {
  const out: string[] = [];
  out.push(
    `arena: ${r.status}${r.reason === null ? "" : ` (${r.reason})`} · ${r.ruleset} · seed ${r.seed} · ${r.players} players · ${r.clock}${r.fake ? " · fake models" : ""}`,
  );
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
  out.push(
    `estimate for ${r.days} days: ${usd(r.estimate.low)} low · ${usd(r.estimate.central)} central · ${usd(r.estimate.high)} high; projection from ${r.projection.fromDays} measured day(s): ${usd(r.projection.costNanoUsd)}`,
  );
  if (r.recommendedSpeed !== null) {
    out.push(
      `real-time speed ≤ ${r.recommendedSpeed.num}/${r.recommendedSpeed.den} (≈ ${r.recommendedSpeed.approx}), from p95 think time ${Math.round(r.recommendedSpeed.p95ThinkMs / 1000)} s`,
    );
  }
  const e = r.exit;
  out.push(
    `exit criterion: ${e.alliancesFormed} alliance(s) formed, ${e.betrayals} betrayal(s): ${e.met ? "met" : "not met"}; with an LLM seat: ${e.llm.betrayals} betrayal(s) (${e.llm.asBetrayer} as betrayer, ${e.llm.asVictim} as victim), ${e.llm.alliances} alliance(s): ${e.llm.met ? "met" : "not met"}`,
  );
  if (r.levelE !== null) {
    out.push(
      `Level E: ${r.levelE.ok ? "ok" : "FAILED"} (${r.levelE.actions} actions, ${r.levelE.checkpoints} checkpoints)${r.levelE.divergence === null ? "" : `: ${r.levelE.divergence}`}`,
    );
  }
  for (const a of r.alerts) out.push(`alert: ${a}`);
  return `${out.join("\n")}\n`;
}

/** `arena cost <run-dir>`: spend per seat and model. */
export function formatCost(lines: readonly LlmLogLine[]): string {
  const rows = costRows(lines.filter((l): l is LlmCallLine => l.k === "llm_call"));
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
  out.push(`total ${usd(total)}`);
  return `${out.join("\n")}\n`;
}
