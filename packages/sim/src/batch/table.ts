import { fmtTime } from "@perfidia/engine/core";
import { table } from "../summary/index.ts";
import type { BatchResult, MatchRow, VariantResult } from "./batch.ts";
import type { FirstTimeStat } from "./fights.ts";

// The batch tables (docs/architecture.md §12.2): one row per variant (or per match with
// `--per-match`), the fights table (end reasons, first battle, conquest and elimination, domination
// countdowns) per variant, and with `--pacing` the per-day pacing table of §13.9. A variant name
// longer than its column is printed on a line of its own, its numbers on the next. Game times are
// printed on the game clock to the minute, `D1 13:12` (day 1, 13:12 after the match start).

const VARIANT_WIDTH = 30;
const f1 = (x: number): string => x.toFixed(1);

/** A game time on the game clock, to the minute (`D1 13:12`); `-` for none. */
export function gameClockText(t: number | null): string {
  return t === null ? "-" : fmtTime(t - (t % 60));
}

/** `mean / min` of a first-event time, with the number of runs when not every run had one. */
function firstText(stat: FirstTimeStat, runs: number): string {
  if (stat.runs === 0) return "-";
  const text = `${gameClockText(stat.mean)} / ${gameClockText(stat.min)}`;
  return stat.runs === runs ? text : `${text} (${stat.runs} of ${runs})`;
}

/** `a 3, b 1`, or `none` when there is nothing to count. */
function countsText(w: Readonly<Record<string, number>>, none = "none"): string {
  const parts = Object.entries(w).map(([s, n]) => `${s} ${n}`);
  return parts.length === 0 ? none : parts.join(", ");
}

/** Rows whose first cell is too long get it on a line of its own. */
function withLongNames(rows: readonly (readonly string[])[], right: ReadonlySet<number>): string[] {
  const fitted = rows.map((r) => ((r[0] ?? "").length > VARIANT_WIDTH ? ["", ...r.slice(1)] : r));
  const rendered = table(fitted, right);
  const out: string[] = [];
  for (const [i, r] of rows.entries()) {
    if ((r[0] ?? "").length > VARIANT_WIDTH) out.push(r[0] ?? "");
    out.push(rendered[i] ?? "");
  }
  return out;
}

/** One row per variant: runs, winners by strategy, end day, battles, conquests, eliminations, wakes. */
export function variantTable(result: BatchResult): string {
  const head = [
    "variant",
    "runs",
    "winners (by strategy)",
    "end day",
    "battles",
    "conquests",
    "elims",
    "wakes/seat/day (mean / max)",
  ];
  const rows = result.variants.map((v) => {
    const a = v.aggregate;
    return [
      v.text,
      `${a.runs}${a.fatal > 0 ? ` (${a.fatal} fatal)` : ""}`,
      countsText(a.winners),
      f1(a.endDay),
      f1(a.battles),
      f1(a.conquests),
      f1(a.eliminations),
      `${f1(a.wakesPerSeatPerDay.mean)} / ${a.wakesPerSeatPerDay.max}`,
    ];
  });
  return `${withLongNames([head, ...rows], new Set([1, 3, 4, 5, 6])).join("\n")}\n`;
}

function matchCells(v: VariantResult, m: MatchRow): string[] {
  return [
    v.text,
    String(m.seed),
    m.status === "ended" ? (m.reason ?? "?") : m.status,
    m.winners.length === 0 ? "-" : `${m.winners.join(",")} (${m.winnerStrategies.join(",")})`,
    m.endDay === null ? "-" : f1(m.endDay),
    String(m.battles),
    String(m.conquests),
    String(m.eliminations),
    gameClockText(m.firstBattleT),
    gameClockText(m.firstConquestT),
    gameClockText(m.firstEliminationT),
    m.dominationCountdowns === 0
      ? "-"
      : `${m.dominationCountdowns} from ${gameClockText(m.firstDominationT)}`,
    `${f1(m.wakesPerSeatPerDay.mean)} / ${m.wakesPerSeatPerDay.max}`,
    m.finalHash ?? "-",
  ];
}

/** `--per-match`: one row per match. */
export function matchTable(result: BatchResult): string {
  const head = [
    "variant",
    "seed",
    "end",
    "winners",
    "end day",
    "battles",
    "conquests",
    "elims",
    "1st battle",
    "1st conquest",
    "1st elim",
    "countdowns",
    "wakes/seat/day",
    "final hash",
  ];
  const rows = result.variants.flatMap((v) =>
    v.matches.map((m, i) => (i === 0 ? matchCells(v, m) : ["", ...matchCells(v, m).slice(1)])),
  );
  return `${withLongNames([head, ...rows], new Set([1, 4, 5, 6, 7])).join("\n")}\n`;
}

/**
 * Per variant: the end reasons, the first battle, conquest and elimination (mean and earliest over
 * the runs that had one), the runs with an elimination and with a domination countdown, and who
 * eliminated whom (bot versions: an elimination count may be one predator and one prey).
 */
export function fightTable(result: BatchResult): string {
  const head = [
    "variant",
    "runs",
    "ends",
    "1st battle (mean / min)",
    "1st conquest (mean / min)",
    "1st elim (mean / min)",
    "runs with elim",
    "runs with countdown",
    "elims (who > whom)",
  ];
  const rows = result.variants.map((v) => {
    const a = v.aggregate;
    return [
      v.text,
      String(a.runs),
      countsText(a.reasons, "-"),
      firstText(a.firstBattle, a.runs),
      firstText(a.firstConquest, a.runs),
      firstText(a.firstElimination, a.runs),
      String(a.runsWithElimination),
      String(a.runsWithCountdown),
      countsText(a.eliminationsBy, "-"),
    ];
  });
  const title = "fights · game clock to the minute, mean / earliest over the runs that had one";
  return `${title}\n${withLongNames([head, ...rows], new Set([1, 6, 7])).join("\n")}\n`;
}

/** `--pacing`: per variant and game day, the measures of §13.9 averaged over the seeds. */
export function pacingTable(result: BatchResult): string {
  const head = [
    "variant",
    "day",
    "runs",
    "cities/player mean",
    "min",
    "max",
    "free slots",
    "army pop",
    "score",
    "battles",
    "conquests",
    "elims",
    "sieges started",
    "held",
    "broken",
  ];
  const rows = result.variants.flatMap((v) =>
    (v.pacing ?? []).map((d, i) => [
      i === 0 ? v.text : "",
      `D${d.day}`,
      String(d.runs),
      f1(d.citiesMean),
      String(d.citiesMin),
      String(d.citiesMax),
      f1(d.freeSlots),
      f1(d.armyPopMean),
      f1(d.scoreMean),
      f1(d.battles),
      f1(d.conquests),
      f1(d.eliminations),
      f1(d.siegesStarted),
      f1(d.siegesHeld),
      f1(d.siegesBroken),
    ]),
  );
  const title = `pacing · N = ${result.players} · ${result.seeds.length} seed(s) per variant · measured at the end of each game day`;
  return `${title}\n${withLongNames([head, ...rows], new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])).join("\n")}\n`;
}
