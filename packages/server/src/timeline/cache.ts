import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@perfidia/engine/core";
import type { Sha256 } from "@perfidia/protocol";
import type { MatchId, TimelineId } from "@perfidia/protocol/spectator";
import { z } from "zod";
import { CACHE_FORMAT, Timeline, type TimelineData } from "./timeline.ts";

// The timeline cache (phase-3 design §0.2 item 4, §2.5): a fold runs once per log and fold version;
// its output is written gzipped to the server's own cache directory and read back after a restart
// (milliseconds instead of a refold). A file is named by the timeline id (which changes with the
// log, `TIMELINE_VERSION` and `ENGINE_VERSION`), the match id and the log id, and is written through
// a temporary file and a rename. The directory is outside every served path; the files hold
// spectator data only. A file that does not parse is deleted and the log refolded.

const HeadSchema = z.looseObject({
  format: z.literal(CACHE_FORMAT),
  match: z.string(),
  logId: z.string(),
  timeline: z.string(),
  lastSeq: z.int().min(-1),
  steps: z.array(z.unknown()),
  keyframes: z.array(z.unknown()),
});

/**
 * A cache file's content. The server's own file, produced by the fold: its head is checked, its
 * steps and frames are not validated again (that would cost more than the load itself).
 */
function isTimelineData(v: unknown): v is TimelineData {
  return HeadSchema.safeParse(v).success;
}

export class TimelineCache {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  path(match: MatchId, logId: Sha256, timeline: TimelineId): string {
    return join(
      this.dir,
      `${timeline}-${sha256Hex(match).slice(0, 16)}-${logId.slice(0, 16)}.json.gz`,
    );
  }

  load(match: MatchId, logId: Sha256, timeline: TimelineId): Timeline | null {
    const path = this.path(match, logId, timeline);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(readFileSync(path));
    } catch {
      return null;
    }
    try {
      const data: unknown = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(bytes)));
      if (!isTimelineData(data)) throw new Error("not a timeline cache file");
      if (data.match !== match || data.logId !== logId || data.timeline !== timeline) return null;
      return Timeline.fromData(data);
    } catch {
      rmSync(path, { force: true });
      return null;
    }
  }

  save(t: Timeline): void {
    const path = this.path(t.match, t.logId, t.timeline);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, Bun.gzipSync(JSON.stringify(t.toData())));
    renameSync(tmp, path);
  }
}
