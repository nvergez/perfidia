import { join } from "node:path";
import { botLabel, type BotStrategy } from "@perfidia/bots";
import { ENGINE_VERSION } from "@perfidia/engine";
import { MemorySink, teeSink, type LogSink } from "@perfidia/gateway";
import type { ClockSpec, Json, LogLine, PlayerId } from "@perfidia/protocol";
import { errorText } from "../args.ts";
import { normalisedHash, prepareBotRun, runPrepared, setupFor } from "../harness/index.ts";
import { RunDirSink, assertFreeRunDir, runPaths, writeFileAtomic } from "../io/index.ts";
import { checkCreation } from "../run/index.ts";
import { LogShapeError, summarize, type MatchSummary } from "../summary/index.ts";
import { fightTimes, firstTimeStat, type FightTimes, type FirstTimeStat } from "./fights.ts";
import { aggregatePacing, pacingOf, type PacingDay, type PacingRow } from "./pacing.ts";
import type { Variant } from "./variants.ts";

// `sim batch` (docs/architecture.md §12.1, §12.2): every variant over the same seeds with the same
// bots and seat assignment, in lockstep, with id keys from `idKeyFromSeed`, so every row is
// reproducible from its seed. Matches run one at a time and share nothing, so the results do not
// depend on the variant order. The JSON records the provenance of every row: for each variant the
// ref, overrides, `configHash`, `rulesHash`, `ENGINE_VERSION`, bot labels and seeds, and for each
// match its final hash and end reason (plus the normalised log hash), with its fight times (first
// battle, conquest and elimination, domination countdowns) next to its counts. With `--out`, every
// match keeps a full run directory (§10.1: log, snapshots, `summary.json`), and the whole batch is
// checked before its first match, so a taken directory or a match that cannot be created writes
// nothing.

/**
 * Bumped when the JSON shape changes (§12.2): 2 added the fight times, the end reasons and the
 * pacing days' conquests and eliminations.
 */
export const BATCH_FORMAT = "perfidia-batch/2";

export interface BatchPlan {
  readonly variants: readonly Variant[];
  readonly seeds: readonly number[];
  readonly players: number;
  readonly bots: readonly BotStrategy[];
  /** `--days`, already folded into each variant's overrides; recorded for provenance. */
  readonly days: number | null;
  readonly pacing: boolean;
}

export interface MatchRow extends FightTimes {
  readonly seed: number;
  readonly status: MatchSummary["status"];
  readonly error: string | null;
  readonly finalHash: string | null;
  /** SHA-256 of the normalised log: equal hashes mean byte-identical normalised logs. */
  readonly logHash: string;
  readonly reason: string | null;
  readonly endedAt: number | null;
  readonly endDay: number | null;
  readonly winners: PlayerId[];
  /** Distinct strategies among the winners. */
  readonly winnerStrategies: string[];
  readonly battles: number;
  readonly conquests: number;
  readonly eliminations: number;
  readonly foundings: number;
  readonly wakesPerSeatPerDay: { readonly mean: number; readonly max: number };
  readonly internal: number;
  /** With `--pacing`: whether the Level E replay of the pacing pass matched, and the days. */
  readonly replayOk?: boolean;
  readonly pacing?: PacingDay[];
}

export interface VariantAggregate {
  readonly runs: number;
  readonly fatal: number;
  /** Ended matches per end reason (`time`, `domination`, `last_standing`, …), most frequent first. */
  readonly reasons: Readonly<Record<string, number>>;
  /** Matches won per strategy (a strategy counts once per match it is among the winners). */
  readonly winners: Readonly<Record<string, number>>;
  readonly endDay: number;
  readonly battles: number;
  readonly conquests: number;
  readonly eliminations: number;
  /** First battle, conquest and elimination: mean and earliest over the runs that had one. */
  readonly firstBattle: FirstTimeStat;
  readonly firstConquest: FirstTimeStat;
  readonly firstElimination: FirstTimeStat;
  /** Runs with at least one elimination. */
  readonly runsWithElimination: number;
  /** Runs where at least one domination countdown opened. */
  readonly runsWithCountdown: number;
  readonly wakesPerSeatPerDay: { readonly mean: number; readonly max: number };
  readonly internal: number;
}

export interface VariantResult {
  readonly text: string;
  readonly label: string | null;
  readonly ref: string;
  readonly overrides: Readonly<Record<string, Json>>;
  readonly configHash: string | null;
  readonly rulesHash: string | null;
  readonly engine: string;
  /** Seat → bot label (the same for every variant). */
  readonly controllers: Readonly<Record<string, string>>;
  readonly seeds: readonly number[];
  readonly matches: MatchRow[];
  readonly aggregate: VariantAggregate;
  readonly pacing?: PacingRow[];
}

export interface BatchResult {
  readonly format: typeof BATCH_FORMAT;
  readonly engine: string;
  readonly players: number;
  readonly seeds: readonly number[];
  readonly days: number | null;
  /** The bot labels cycled over the seats. */
  readonly bots: readonly string[];
  readonly clock: ClockSpec;
  readonly variants: VariantResult[];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : round2(xs.reduce((a, b) => a + b, 0) / xs.length);
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Counts by key, most frequent first (ties by code unit). */
function countsByFrequency(keys: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const k of keys) counts[k] = (counts[k] ?? 0) + 1;
  const ordered: Record<string, number> = {};
  for (const [k, n] of Object.entries(counts).toSorted(
    (a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]),
  )) {
    ordered[k] = n;
  }
  return ordered;
}

function aggregate(matches: readonly MatchRow[]): VariantAggregate {
  const ended = matches.filter((m) => m.endDay !== null);
  return {
    runs: matches.length,
    fatal: matches.filter((m) => m.status !== "ended").length,
    reasons: countsByFrequency(
      matches.flatMap((m) => (m.status === "ended" && m.reason !== null ? [m.reason] : [])),
    ),
    winners: countsByFrequency(matches.flatMap((m) => m.winnerStrategies)),
    endDay: mean(ended.map((m) => m.endDay ?? 0)),
    battles: mean(matches.map((m) => m.battles)),
    conquests: mean(matches.map((m) => m.conquests)),
    eliminations: mean(matches.map((m) => m.eliminations)),
    firstBattle: firstTimeStat(matches.map((m) => m.firstBattleT)),
    firstConquest: firstTimeStat(matches.map((m) => m.firstConquestT)),
    firstElimination: firstTimeStat(matches.map((m) => m.firstEliminationT)),
    runsWithElimination: matches.filter((m) => m.eliminations > 0).length,
    runsWithCountdown: matches.filter((m) => m.dominationCountdowns > 0).length,
    wakesPerSeatPerDay: {
      mean: mean(matches.map((m) => m.wakesPerSeatPerDay.mean)),
      max: Math.max(0, ...matches.map((m) => m.wakesPerSeatPerDay.max)),
    },
    internal: matches.reduce((a, m) => a + m.internal, 0),
  };
}

/** Where a match of a batch writes its run directory under `--out`. */
export function batchRunDir(out: string, variantIndex: number, seed: number): string {
  return join(out, `v${variantIndex + 1}-s${seed}`);
}

/**
 * Checks a batch before any match runs, so a bad batch exits 3 having written nothing: every
 * (variant, seed) match can be created (the creation checks of §3.6, as `run` does), and with
 * `out`, no match's run directory already holds a run. Throws `UsageError`.
 */
export function preflightBatch(plan: BatchPlan, out?: string): void {
  for (const [vi, v] of plan.variants.entries()) {
    for (const seed of plan.seeds) {
      const setup = setupFor(v.ruleset, { seed, players: plan.players, overrides: v.overrides });
      checkCreation(setup, v.ruleset, ` of variant "${v.text}" with seed ${seed}`);
      if (out !== undefined) assertFreeRunDir(batchRunDir(out, vi, seed));
    }
  }
}

/**
 * One match of a variant: in memory, and into `dir` when given, with its `summary.json` (§10.1).
 * The summary is null when the log has no header (the match failed before writing it).
 */
async function playMatch(
  plan: BatchPlan,
  v: Variant,
  seed: number,
  dir: string | null,
): Promise<{
  readonly lines: LogLine[];
  readonly summary: MatchSummary | null;
  readonly error: string | null;
}> {
  const prepared = prepareBotRun({
    ruleset: v.ruleset,
    seed,
    players: plan.players,
    overrides: v.overrides,
    bots: plan.bots,
    clock: { kind: "lockstep" },
  });
  const memory = new MemorySink();
  const sink: LogSink = dir === null ? memory : teeSink(new RunDirSink(dir), memory);
  let error: string | null = null;
  const t0 = performance.now();
  try {
    await runPrepared(prepared, sink);
  } catch (e) {
    error = errorText(e);
  }
  const wallMs = Math.round(performance.now() - t0);
  sink.flush?.();
  const lines = memory.parsed();
  let summary: MatchSummary | null = null;
  try {
    summary = summarize(lines, { wallMs });
  } catch (e) {
    if (!(e instanceof LogShapeError)) throw e;
    error ??= e.message;
  }
  if (dir !== null && summary !== null) {
    writeFileAtomic(runPaths(dir).summary, `${JSON.stringify(summary, null, 2)}\n`);
  }
  return { lines, summary, error };
}

/** The row of a match whose log has no summary (it stopped before its header). */
function failedRow(seed: number, lines: readonly LogLine[], error: string | null): MatchRow {
  return {
    seed,
    status: "fatal",
    error: error ?? "the match wrote no header line",
    finalHash: null,
    logHash: normalisedHash(lines),
    reason: null,
    endedAt: null,
    endDay: null,
    winners: [],
    winnerStrategies: [],
    battles: 0,
    conquests: 0,
    eliminations: 0,
    foundings: 0,
    ...fightTimes(lines),
    wakesPerSeatPerDay: { mean: 0, max: 0 },
    internal: 0,
  };
}

function rowOf(
  seed: number,
  lines: readonly LogLine[],
  s: MatchSummary | null,
  error: string | null,
  pacing: boolean,
): MatchRow {
  if (s === null) return failedRow(seed, lines, error);
  const winnerStrategies = [
    ...new Set(s.winners.map((w) => s.seats.find((x) => x.seat === w)?.strategy ?? w)),
  ].toSorted(byCodeUnit);
  const row: MatchRow = {
    seed,
    status: s.status,
    error,
    finalHash: s.finalHash,
    logHash: normalisedHash(lines),
    reason: s.reason,
    endedAt: s.endedAt,
    endDay: s.endDay,
    winners: s.winners,
    winnerStrategies,
    battles: s.events.battles,
    conquests: s.events.conquests,
    eliminations: s.events.eliminations,
    foundings: s.events.foundings,
    ...fightTimes(lines),
    wakesPerSeatPerDay: s.wakes.perSeatPerDay,
    internal: s.internal,
  };
  if (!pacing || s.status !== "ended") return row;
  const p = pacingOf(lines);
  return { ...row, replayOk: p.report.ok, pacing: p.days };
}

/**
 * Runs a batch. `progress` hears about each match as it ends; `out` keeps every match's run
 * directory (`<out>/v<i>-s<seed>`), else the logs stay in memory. The batch is checked first
 * (`preflightBatch`): a `UsageError` there means no match ran and nothing was written.
 */
export async function runBatch(
  plan: BatchPlan,
  o: {
    readonly out?: string | undefined;
    readonly progress?: (v: Variant, seed: number, row: MatchRow) => void;
  } = {},
): Promise<BatchResult> {
  preflightBatch(plan, o.out);
  const results: VariantResult[] = [];
  let clock: ClockSpec = { kind: "lockstep", maxTurnsPerSecond: 3 };
  let controllers: Record<string, string> = {};
  for (const [vi, v] of plan.variants.entries()) {
    const matches: MatchRow[] = [];
    let configHash: string | null = null;
    let rulesHash: string | null = null;
    for (const seed of plan.seeds) {
      const dir = o.out === undefined ? null : batchRunDir(o.out, vi, seed);
      // oxlint-disable-next-line no-await-in-loop -- one match at a time: bounded memory, no shared state
      const { lines, summary, error } = await playMatch(plan, v, seed, dir);
      const header = lines[0];
      if (header?.k === "header") {
        configHash ??= header.configHash;
        rulesHash ??= header.rulesHash;
        clock = header.clock;
        controllers = { ...header.controllers };
      }
      const row = rowOf(seed, lines, summary, error, plan.pacing);
      matches.push(row);
      o.progress?.(v, seed, row);
    }
    results.push({
      text: v.text,
      label: v.label,
      ref: v.ruleset.ref,
      overrides: v.overrides,
      configHash,
      rulesHash,
      engine: ENGINE_VERSION,
      controllers,
      seeds: [...plan.seeds],
      matches,
      aggregate: aggregate(matches),
      ...(plan.pacing ? { pacing: aggregatePacing(matches.map((m) => m.pacing ?? [])) } : {}),
    });
  }
  return {
    format: BATCH_FORMAT,
    engine: ENGINE_VERSION,
    players: plan.players,
    seeds: [...plan.seeds],
    days: plan.days,
    bots: plan.bots.map((b) => botLabel(b)),
    clock,
    variants: results,
  };
}

/** Writes the batch JSON (pretty-printed, one trailing newline). */
export function writeBatchJson(path: string, result: BatchResult): void {
  writeFileAtomic(path, `${JSON.stringify(result, null, 2)}\n`);
}
