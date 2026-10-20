import { join } from "node:path";
import {
  MODEL_STATS_FORMAT,
  ModelStatsFileSchema,
  type MatchStats,
  type ModelDetail,
  type ModelStatsFile,
  type ModelsResponse,
} from "@perfidia/protocol";
import type { MatchId } from "@perfidia/protocol/spectator";
import { matchStats } from "@perfidia/spectator/stats";
import { apiError, loading, notFound, type ApiResult } from "../service/api.ts";
import type { Registry } from "../service/matches.ts";
import { CALLS_FILE, SEATS_FILE, ARENA_FILE, fileStamp } from "../store/rundir.ts";
import { isFinal } from "../store/status.ts";
import { readRegular } from "../store/tail.ts";
import { SERIES_FILE, readCalls, readCostByKind, readSeries } from "./side.ts";

// The statistics routes (phase-4 design §6.3, docs/phase4.md Pass 3), behind the same visibility as
// every other route (an unpublished match is a 404):
// - `GET /api/matches/:id/stats`: one match's statistics (`perfidia-stats/1`), from the steps its
//   fold workers made (never a fold on this thread), the frame at its tail, and its side files read
//   whole (`llm_calls.jsonl`, `seats.json`, `arena.json`'s cost by kind, the root's `series.json`);
//   a 503 `LOADING` until the first fold has reached the log's tail (statistics of a half-folded log
//   would mix its first hours with the whole side files); a finished match's are kept (up to
//   `MEMO_FINAL`, without reading its timeline back) while its timeline and side files are
//   unchanged, a running match's at most every `LIVE_REFRESH_MS`;
// - `GET /api/models` and `GET /api/models/:id`: the file `bun run stats -- aggregate --out <file>`
//   wrote (`--stats <file>`), re-read when it changes; served only when every match it aggregates is
//   public now (else a 404, or a 503 while one of them loads), never an `--exploratory` file.
// Under `--no-costs`, every cost, token and model-time figure is withheld (null). As defence in
// depth, a models file whose claim state is not `ok` is served without ratings, outcomes or ranks,
// whatever it holds.

/** A running match's statistics are recomputed at most this often (wall ms). */
export const LIVE_REFRESH_MS = 5_000;
/** Running matches whose statistics are kept. */
const MEMO_MATCHES = 32;
/** Finished matches whose statistics are kept (about 10 KB each for six seats). */
export const MEMO_FINAL = 512;
/** The largest statistics file read. */
const MAX_STATS_BYTES = 64 * 1024 * 1024;

const maxAge = (seconds: number): ApiResult["cache"] => ({ kind: "max-age", seconds });

export interface StatsServiceOptions {
  /** `--stats <file>`, or null. */
  readonly file: string | null;
  /** The runs root (its `series.json` groups its matches). */
  readonly runs: string;
  /** What is published (the server's `--no-costs`). */
  readonly costs: boolean;
  readonly now: () => number;
  readonly warn: (message: string) => void;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/** A models file without ratings, outcomes or ranks unless its claim state is `ok` (defence in depth). */
export function withoutClaims(f: ModelStatsFile): ModelStatsFile {
  if (f.claims.state === "ok") return f;
  return {
    ...f,
    ratings: null,
    models: f.models.map((m) => (m.outcome === null ? m : { ...m, outcome: null })),
    seats: f.seats.map((s) => (s.rank === null ? s : { ...s, rank: null })),
  };
}

/** A models file with costs withheld (`--no-costs`). */
export function withoutCosts(f: ModelStatsFile): ModelStatsFile {
  return {
    ...f,
    published: { costs: false },
    models: f.models.map((m) => ({
      ...m,
      cost: null,
      operations: m.operations === null ? null : { ...m.operations, latencyMs: null },
    })),
    seats: f.seats.map((s) => ({ ...s, costNanoUsd: null })),
  };
}

/** `value` as the newest entry of a map kept to `max` entries (the oldest dropped). */
function remember<V>(memo: Map<MatchId, V>, id: MatchId, value: V, max: number): void {
  memo.delete(id);
  memo.set(id, value);
  while (memo.size > max) {
    const oldest = memo.keys().next();
    if (oldest.done === true) break;
    memo.delete(oldest.value);
  }
}

export class StatsService {
  private readonly registry: Registry;
  private readonly o: StatsServiceOptions;
  private readonly memo = new Map<MatchId, { key: string; at: number; stats: MatchStats }>();
  private readonly finalMemo = new Map<MatchId, { key: string; stats: MatchStats }>();
  private file: { stamp: string; value: ModelStatsFile | null } | null = null;

  constructor(registry: Registry, o: StatsServiceOptions) {
    this.registry = registry;
    this.o = o;
  }

  /** `GET /api/matches/:id/stats`. */
  match(id: MatchId): ApiResult {
    const e = this.registry.get(id);
    if (e === null) return notFound(id);
    // Until the first fold reaches the tail, the steps cover only the log's start.
    if (e.loading || e.status.status === "loading") return loading(id);
    const dir = e.ref.dir;
    const final = isFinal(e.status.status);
    const stamps = [
      e.status.status,
      fileStamp(join(dir, CALLS_FILE)),
      fileStamp(join(dir, SEATS_FILE)),
      fileStamp(join(dir, ARENA_FILE)),
      fileStamp(join(this.o.runs, SERIES_FILE)),
    ].join("|");
    // A finished match's statistics change only with its timeline id (a replaced log) or a side file.
    const finalKey = final && e.timelineId !== null ? `${e.timelineId}|${stamps}` : null;
    const kept = finalKey === null ? undefined : this.finalMemo.get(id);
    if (kept !== undefined && kept.key === finalKey) {
      this.finalMemo.delete(id);
      this.finalMemo.set(id, kept);
      return { status: 200, body: kept.stats, cache: maxAge(3600) };
    }
    const t = this.registry.timelineOf(e);
    const tail = t?.tail() ?? null;
    if (t === null || t.lastSeq < 0 || tail === null || e.header === null) return loading(id);
    const key = [t.timeline, t.version, stamps].join("|");
    const now = this.o.now();
    const held = this.memo.get(id);
    const fresh =
      held !== undefined && (held.key === key || (!final && now - held.at < LIVE_REFRESH_MS));
    let stats: MatchStats;
    if (held !== undefined && fresh) {
      stats = held.stats;
    } else {
      const calls = readCalls(dir);
      stats = matchStats(
        { header: e.header, steps: t.steps, frame: tail, verified: t.verified, lastT: t.lastT },
        {
          calls: calls?.lines ?? null,
          seats: e.seatsFile,
          costByKind: readCostByKind(dir),
          fake: e.arena?.fake === true,
        },
        {
          match: id,
          status: e.status.status,
          costs: this.o.costs,
          series: readSeries(this.o.runs).byRun.get(id) ?? null,
        },
      );
      if (finalKey === null) {
        remember(this.memo, id, { key, at: now, stats }, MEMO_MATCHES);
      } else {
        this.memo.delete(id);
        remember(this.finalMemo, id, { key: finalKey, stats }, MEMO_FINAL);
      }
    }
    return { status: 200, body: stats, cache: final ? maxAge(3600) : maxAge(10) };
  }

  /** `GET /api/models`. */
  models(): ApiResult {
    const f = this.public();
    if ("status" in f) return f;
    const { seats: _seats, exploratory: _exploratory, ...rest } = f.file;
    const body: ModelsResponse = rest;
    return { status: 200, body, cache: maxAge(60) };
  }

  /** `GET /api/models/:id`. */
  model(id: string): ApiResult {
    const f = this.public();
    if ("status" in f) return f;
    const file = f.file;
    const model = file.models.find((m) => m.id === id);
    if (model === undefined) {
      return apiError(
        404,
        "NO_MODEL",
        `the statistics have no model ${id}`,
        `GET /api/models lists the ${file.models.length} model id(s)`,
      );
    }
    const body: ModelDetail = {
      format: MODEL_STATS_FORMAT,
      grouping: file.grouping,
      published: file.published,
      model,
      claims: file.claims,
      rating: file.ratings?.headline.items.find((r) => r.id === id) ?? null,
      seats: file.seats.filter((s) => s.id === id),
    };
    return { status: 200, body, cache: maxAge(60) };
  }

  /** The statistics file, when every match it aggregates is public now; else the error to send. */
  private public(): { file: ModelStatsFile } | ApiResult {
    const path = this.o.file;
    const none = apiError(
      404,
      "NO_STATS",
      "this server publishes no model statistics",
      "the operator writes them with bun run stats -- aggregate --runs <dir> --publish <publish.json> --out <file> and serves them with --stats <file>",
    );
    if (path === null) return none;
    const stamp = fileStamp(path);
    if (stamp === null) return none;
    if (this.file?.stamp !== stamp) this.file = { stamp, value: this.read(path) };
    const file = this.file.value;
    if (file === null) return none;
    for (const m of file.matches) {
      if (this.registry.get(m.match) !== null) continue;
      if (this.registry.listed(m.match) && this.registry.entries.get(m.match)?.loading === true) {
        return apiError(
          503,
          "LOADING",
          "the model statistics are loading: a match they aggregate is being folded",
          "retry in a few seconds",
          { "retry-after": "2" },
        );
      }
      return apiError(
        404,
        "STATS_NOT_PUBLIC",
        "the model statistics aggregate a match that is not public",
        "the operator regenerates them with bun run stats -- aggregate --publish <publish.json>",
      );
    }
    const shown = withoutClaims(file);
    return { file: this.o.costs ? shown : withoutCosts(shown) };
  }

  private read(path: string): ModelStatsFile | null {
    const bytes = readRegular(path, MAX_STATS_BYTES);
    if (bytes === null) {
      this.o.warn(`--stats ${path}: not a readable regular file under ${MAX_STATS_BYTES} bytes`);
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(bytes));
    } catch {
      this.o.warn(`--stats ${path}: not JSON`);
      return null;
    }
    const parsed = ModelStatsFileSchema.safeParse(raw);
    if (!parsed.success) {
      this.o.warn(`--stats ${path}: not a perfidia-model-stats/1 file`);
      return null;
    }
    if (parsed.data.exploratory) {
      this.o.warn(`--stats ${path}: an --exploratory file is never served`);
      return null;
    }
    return parsed.data;
  }
}
