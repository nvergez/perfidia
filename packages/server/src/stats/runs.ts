import { basename, join } from "node:path";
import {
  LogLineSchema,
  MatchStatsSchema,
  type LogLine,
  type MatchStats,
  type StatsSeriesRef,
} from "@perfidia/protocol";
import { MatchIdSchema } from "@perfidia/protocol/spectator";
import { statsOfLog } from "@perfidia/spectator/stats";
import { LOG_FILE, LOG_FILE_GZ, discoverRuns } from "../store/discover.ts";
import type { PublishList } from "../store/publish.ts";
import { fileStamp, readArenaFile, readSeatsFile, readSummaryFile } from "../store/rundir.ts";
import { matchStatus } from "../store/status.ts";
import { readGzLines, readRegular } from "../store/tail.ts";
import type { SeriesSummary } from "./aggregate.ts";
import { readCalls, readCostByKind, readSeries, seriesSummary } from "./side.ts";

// The run directories of the `stats` command line (never the server, which takes the statistics of
// the steps its fold workers made): each `match.jsonl` (or `match.jsonl.gz`) folded whole, with its
// side files, its status as the server would show it (`store/status.ts`), and its series match when
// the root is a rotation series (`series.json`). A root is read as the server reads it
// (`store/discover.ts`: its subdirectories holding a log), so a statistics file's match ids are the
// server's. With a `publish.json`, only the matches the server would show (`store/publish.ts`,
// `service/matches.ts`): listed, verified (level E), and `live` or ended; the others are left out
// with a warning, so a file written with `--publish` is one the server serves. Each run's
// statistics are checked against `perfidia-stats/1` on their own: a run that does not fit is left
// out with a warning, never the whole aggregate.

const decoder = new TextDecoder("utf-8", { fatal: false });

export interface RunStats {
  readonly id: string;
  readonly stats: MatchStats;
  /** What was skipped or could not be read, in words. */
  readonly warnings: readonly string[];
}

/** A log's lines parsed; `null` for a line that is not a valid log line. */
function logLines(path: string, gz: boolean): (LogLine | null)[] {
  let rows: string[];
  if (gz) {
    rows = readGzLines(path);
  } else {
    const bytes = readRegular(path);
    if (bytes === null) throw new Error(`cannot read ${path}`);
    const text = decoder.decode(bytes);
    const end = text.lastIndexOf("\n");
    rows = end < 0 ? [] : text.slice(0, end).split("\n");
  }
  return rows.map((raw) => {
    try {
      const parsed = LogLineSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  });
}

/** The statistics of one run directory (its log, `llm_calls.jsonl`, `seats.json`, `arena.json`). */
export function statsOfRunDir(
  dir: string,
  o: {
    readonly id?: string;
    readonly costs?: boolean;
    readonly series?: StatsSeriesRef | null;
  } = {},
): RunStats {
  const id = o.id ?? basename(dir);
  if (!MatchIdSchema.safeParse(id).success) {
    throw new Error(`${id}: a run directory's name must be a match id (letters, digits, . _ @ -)`);
  }
  const gzPath = join(dir, LOG_FILE_GZ);
  const plainPath = join(dir, LOG_FILE);
  const gz = fileStamp(plainPath) === null && fileStamp(gzPath) !== null;
  const lines = logLines(gz ? gzPath : plainPath, gz);
  const warnings: string[] = [];
  const bad = lines.filter((l) => l === null).length;
  if (bad > 0)
    warnings.push(`${id}: ${bad} line(s) of the log are not valid log lines: unverifiable`);
  const calls = readCalls(dir);
  if (calls !== null && calls.bad > 0) {
    warnings.push(`${id}: ${calls.bad} line(s) of llm_calls.jsonl do not parse: left out`);
  }
  const seats = readSeatsFile(dir);
  if (!seats.ok && !seats.missing)
    warnings.push(`${id}: seats.json does not parse: seats from the log`);
  const arena = readArenaFile(dir);
  const summary = readSummaryFile(dir);
  const header = lines[0];
  const stats = statsOfLog(
    lines,
    {
      calls: calls?.lines ?? null,
      seats: seats.ok ? seats.value : null,
      costByKind: readCostByKind(dir),
      fake: arena.ok && arena.value.fake,
    },
    {
      match: id,
      costs: o.costs !== false,
      series: o.series ?? null,
      status: (f) =>
        matchStatus({
          loading: false,
          unverifiable: !f.verified,
          endReason: f.endReason,
          fatalLine: f.fatal,
          arena: arena.ok ? arena.value : null,
          summary: summary.ok ? summary.value : null,
          clock: header?.k === "header" ? header.clock : null,
          idleMs: 0,
        }).status,
    },
  );
  return { id, stats, warnings };
}

export interface RootStats {
  readonly runs: readonly RunStats[];
  readonly series: readonly SeriesSummary[];
  readonly warnings: readonly string[];
}

/** The statistics of every run directory under `root` (with `publish`, the public ones only). */
export function statsOfRoot(
  root: string,
  o: { readonly costs?: boolean; readonly publish?: PublishList | null } = {},
): RootStats {
  const series = readSeries(root);
  const warnings: string[] = series.warning === null ? [] : [series.warning];
  const runs: RunStats[] = [];
  for (const ref of discoverRuns(root)) {
    const entry = o.publish === null || o.publish === undefined ? null : o.publish.entry(ref.id);
    if (o.publish !== null && o.publish !== undefined && entry === null) continue;
    try {
      const r = statsOfRunDir(ref.dir, {
        id: ref.id,
        costs: o.costs !== false,
        series: series.byRun.get(ref.id) ?? null,
      });
      if (entry !== null && !r.stats.verified) {
        warnings.push(
          `${ref.id}: its log does not verify (level E): the server hides it: left out`,
        );
        continue;
      }
      if (entry?.visibility === "after_end" && r.stats.result === null) {
        warnings.push(`${ref.id}: published after its end, and it has not ended: left out`);
        continue;
      }
      const fits = MatchStatsSchema.safeParse(r.stats);
      if (!fits.success) {
        const where = fits.error.issues[0]?.path.join(".") ?? "";
        warnings.push(
          `${ref.id}: its statistics do not fit perfidia-stats/1 (at ${where}): left out`,
        );
        continue;
      }
      runs.push({ ...r, stats: fits.data });
      warnings.push(...r.warnings);
    } catch (e) {
      warnings.push(`${ref.id}: ${e instanceof Error ? e.message : String(e)}: left out`);
    }
  }
  const summary = seriesSummary(
    series,
    runs.map((r) => r.id),
  );
  return { runs, series: summary === null ? [] : [summary], warnings };
}
