import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_VERSION } from "@perfidia/engine";
import { sha256Hex } from "@perfidia/engine/core";
import type { Sha256 } from "@perfidia/protocol";
import type { MatchId, TimelineId } from "@perfidia/protocol/spectator";
import { TIMELINE_VERSION } from "@perfidia/spectator";
import { z } from "zod";
import { CACHE_FORMAT, Timeline, type LogSource, type TimelineData } from "./timeline.ts";

// The timeline cache (phase-3 design §0.2 item 4, §2.5): a fold runs once per log and fold version;
// its output is written gzipped to the server's own cache directory and read back after a restart
// (milliseconds instead of a refold). A file is named by the timeline id (which changes with the
// log, `TIMELINE_VERSION` and `ENGINE_VERSION`), the match id and the log id, and is written through
// a temporary file and a rename. The directory is outside every served path; the files hold
// spectator data only. A file that does not parse is deleted and the log refolded. A file's name
// ends with the fold and engine versions that wrote it: at startup the files of other versions
// (and the untagged names written before Pass C's review) are deleted, since their timeline ids are
// never asked for again.
//
// A file also records the log prefix it was folded from (`source`: its length and a hash of its
// last bytes). Two different logs can share a header, hence a log id (a lockstep rerun with the same
// seed into the same directory): before a cached timeline is trusted, the caller checks the source
// against the file, and a mismatch (`stale`) means the file is another log. The stale cache file is
// kept, so the old log's timeline id stays taken and the new log gets another one.

const HeadSchema = z.looseObject({
  format: z.literal(CACHE_FORMAT),
  match: z.string(),
  logId: z.string(),
  timeline: z.string(),
  lastSeq: z.int().min(-1),
  status: z.string(),
  steps: z.array(z.unknown()),
  keyframes: z.array(z.unknown()),
  source: z.strictObject({ bytes: z.int().min(0), tail: z.string() }),
});

/**
 * A cache file's content. The server's own file, produced by the fold: its head is checked, its
 * steps and frames are not validated again (that would cost more than the load itself).
 */
function isTimelineData(v: unknown): v is TimelineData {
  return HeadSchema.safeParse(v).success;
}

export type CacheLoad =
  | { readonly kind: "hit"; readonly timeline: Timeline; readonly source: LogSource }
  | { readonly kind: "miss" }
  /** The file holds another log with the same header (its source does not match). */
  | { readonly kind: "stale" };

/** Whether the log file still holds the prefix a cached timeline was folded from. */
export type SourceCheck = (source: LogSource, final: boolean) => boolean;

/** The versions a cache file was written by, at the end of its name. */
export const CACHE_VERSION_TAG = `t${TIMELINE_VERSION}e${ENGINE_VERSION}`;
/** The name of a cache file of any version (versions before the tag wrote none), or its temporary. */
const CACHE_NAME =
  /^[0-9a-f]{16}-[0-9a-f]{16}-[0-9a-f]{16}(?:-t\d+e[0-9a-z.+-]+)?\.json\.gz(?:\.tmp)?$/;

export class TimelineCache {
  readonly dir: string;
  /** Files of other fold or engine versions deleted when this cache opened its directory. */
  readonly pruned: number;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.pruned = prune(dir);
  }

  path(match: MatchId, logId: Sha256, timeline: TimelineId): string {
    return join(
      this.dir,
      `${timeline}-${sha256Hex(match).slice(0, 16)}-${logId.slice(0, 16)}-${CACHE_VERSION_TAG}.json.gz`,
    );
  }

  /** A cached timeline; `check` (omitted: trusted) decides whether it is still the file's. */
  load(match: MatchId, logId: Sha256, timeline: TimelineId, check?: SourceCheck): CacheLoad {
    const path = this.path(match, logId, timeline);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch {
      return { kind: "miss" };
    }
    let data: TimelineData;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(bytes)));
      if (!isTimelineData(parsed)) throw new Error("not a timeline cache file");
      data = parsed;
    } catch {
      rmSync(path, { force: true });
      return { kind: "miss" };
    }
    if (data.match !== match || data.logId !== logId || data.timeline !== timeline) {
      return { kind: "miss" };
    }
    const final = data.status === "ended" || data.status === "fatal";
    if (check !== undefined && !check(data.source, final)) return { kind: "stale" };
    try {
      return { kind: "hit", timeline: Timeline.fromData(data), source: data.source };
    } catch {
      rmSync(path, { force: true });
      return { kind: "miss" };
    }
  }

  save(t: Timeline, source: LogSource): void {
    const path = this.path(t.match, t.logId, t.timeline);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, Bun.gzipSync(JSON.stringify(t.toData(source))));
    renameSync(tmp, path);
  }
}

/** Deletes the cache files of other versions in `dir` (other files are left alone); how many. */
function prune(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (!CACHE_NAME.test(name) || name.includes(`-${CACHE_VERSION_TAG}.json.gz`)) continue;
    rmSync(join(dir, name), { force: true });
    n += 1;
  }
  return n;
}
