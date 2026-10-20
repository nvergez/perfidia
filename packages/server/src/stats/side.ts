import { join } from "node:path";
import {
  LlmLogLineSchema,
  PlayerIdSchema,
  SeriesManifestSchema,
  type LlmLogLine,
  type PlayerId,
  type SeriesManifest,
  type StatsSeriesRef,
} from "@perfidia/protocol";
import type { CostByKind } from "@perfidia/spectator/stats";
import { z } from "zod";
import { ARENA_FILE, CALLS_FILE } from "../store/rundir.ts";
import { readRegular } from "../store/tail.ts";
import type { SeriesSummary } from "./aggregate.ts";

// The side files the statistics read besides `seats.json` (which `store/rundir.ts` reads): the whole
// of `llm_calls.jsonl` (complete lines only; a line that fails its schema is skipped and counted),
// the cost by token kind of `arena.json` (either report version, read leniently: the server keeps
// nothing else of it), and a rotation series' `series.json` (`perfidia-series/1`), which groups the
// run directories under a root into the series' blocks. Files are read without following a link.

export const SERIES_FILE = "series.json";
/** The largest `llm_calls.jsonl` read whole (a 7-day match writes a few megabytes). */
export const MAX_CALLS_BYTES = 256 * 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: false });

/** The complete lines of a file's bytes (the text after the last newline is left out). */
function completeLines(bytes: Uint8Array): string[] {
  const text = decoder.decode(bytes);
  const end = text.lastIndexOf("\n");
  return end < 0 ? [] : text.slice(0, end).split("\n");
}

/** `llm_calls.jsonl` parsed; null when the run has none (or it is not a regular file, or too big). */
export function readCalls(dir: string): { lines: LlmLogLine[]; bad: number } | null {
  const bytes = readRegular(join(dir, CALLS_FILE), MAX_CALLS_BYTES);
  if (bytes === null) return null;
  const lines: LlmLogLine[] = [];
  let bad = 0;
  for (const raw of completeLines(bytes)) {
    if (raw.trim() === "") continue;
    try {
      const parsed = LlmLogLineSchema.safeParse(JSON.parse(raw));
      if (parsed.success) lines.push(parsed.data);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { lines, bad };
}

const Nano = z.int().nonnegative();
const ArenaCostsSchema = z.looseObject({
  seats: z.array(
    z.looseObject({
      seat: PlayerIdSchema,
      costByKind: z.looseObject({
        input: Nano,
        cacheWrite5m: Nano,
        cacheWrite1h: Nano,
        cacheRead: Nano,
        output: Nano,
      }),
    }),
  ),
});

/** `arena.json`'s cost by token kind per LLM seat; null without a report that says. */
export function readCostByKind(dir: string): Map<PlayerId, CostByKind> | null {
  const bytes = readRegular(join(dir, ARENA_FILE), 16 * 1024 * 1024);
  if (bytes === null) return null;
  let parsed;
  try {
    parsed = ArenaCostsSchema.safeParse(JSON.parse(decoder.decode(bytes)));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const out = new Map<PlayerId, CostByKind>();
  for (const s of parsed.data.seats) {
    const k = s.costByKind;
    out.set(s.seat, {
      input: k.input,
      cacheWrite5m: k.cacheWrite5m,
      cacheWrite1h: k.cacheWrite1h,
      cacheRead: k.cacheRead,
      output: k.output,
    });
  }
  return out;
}

export interface SeriesOfRoot {
  /** The series match each run directory (by name) is. */
  readonly byRun: ReadonlyMap<string, StatsSeriesRef>;
  readonly manifest: SeriesManifest | null;
  /** Why `series.json` was not used, when it exists and does not parse. */
  readonly warning: string | null;
}

const NONE: SeriesOfRoot = { byRun: new Map(), manifest: null, warning: null };

/** The rotation series a runs root holds (`<root>/series.json`), if it is one. */
export function readSeries(root: string): SeriesOfRoot {
  const bytes = readRegular(join(root, SERIES_FILE), 16 * 1024 * 1024);
  if (bytes === null) return NONE;
  let parsed;
  try {
    parsed = SeriesManifestSchema.safeParse(JSON.parse(decoder.decode(bytes)));
  } catch {
    return { ...NONE, warning: `${SERIES_FILE} is not JSON: its matches are not grouped` };
  }
  if (!parsed.success) {
    return {
      ...NONE,
      warning: `${SERIES_FILE} is not a perfidia-series/1 manifest: its matches are not grouped`,
    };
  }
  const m = parsed.data;
  const byRun = new Map<string, StatsSeriesRef>();
  for (const row of m.matches) {
    byRun.set(row.run, { lineup: m.lineup, block: row.block, index: row.index });
  }
  return { byRun, manifest: m, warning: null };
}

/** A series' summary, with the matches found among `runs`. */
export function seriesSummary(s: SeriesOfRoot, runs: readonly string[]): SeriesSummary | null {
  const m = s.manifest;
  if (m === null) return null;
  return {
    lineup: m.lineup,
    fake: m.fake,
    order: m.order,
    blocks: m.blocks,
    orthogonal: m.orthogonal,
    planned: m.matches.length,
    found: runs.filter((r) => s.byRun.has(r)).length,
  };
}
