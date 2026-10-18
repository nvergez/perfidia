import { readFileSync } from "node:fs";
import { MatchIdSchema, type MatchId } from "@perfidia/protocol/spectator";
import { z } from "zod";

// The public list (phase-3 design §2.4): `publish.json` names the matches spectators may see, each
// with a title, a description, a `featured` flag and its visibility: `live` (everything as it
// happens) or `after_end` (the match appears, with everything, only once its log has an end line;
// computed from the log, so it survives restarts). The file is re-read when it changes: removing an
// id unpublishes that match from every route at once (the kill switch). A file that fails to parse
// at startup stops the server; later, a read that fails is retried (an editor may be halfway
// through writing it) and, if it still fails, publishes nothing until it is fixed (fail closed).
// Replace the file atomically (write a temporary file, then rename it) to avoid the retries. Without
// a file, every discovered run is listed (local development, `--all-runs`).

export const PUBLISH_FORMAT = "perfidia-publish/1";

const PublishEntrySchema = z.strictObject({
  id: MatchIdSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(2_000).nullable().optional(),
  featured: z.boolean().optional(),
  visibility: z.enum(["live", "after_end"]).optional(),
});

export const PublishFileSchema = z.strictObject({
  format: z.literal(PUBLISH_FORMAT),
  matches: z.array(PublishEntrySchema).max(10_000),
});
export type PublishFile = z.infer<typeof PublishFileSchema>;

export interface PublishEntry {
  readonly id: MatchId;
  readonly title: string;
  readonly description: string | null;
  readonly featured: boolean;
  readonly visibility: "live" | "after_end";
}

export class PublishList {
  /** The file, or null: every run is public (development). */
  readonly path: string | null;
  private entries = new Map<MatchId, PublishEntry>();
  private text: string | null = null;
  /** Why the last read failed, if it did (nothing is published meanwhile). */
  error: string | null = null;

  constructor(path: string | null) {
    this.path = path;
  }

  /** Whether every discovered run is public (no file). */
  get open(): boolean {
    return this.path === null;
  }

  /**
   * Re-reads the file; returns whether the public list changed. Throws on the first read when the
   * file is missing or invalid (the server must not start publishing nothing by mistake). Later, a
   * failed read publishes nothing (fail closed); `tryLoad` reads without that.
   */
  load(o: { readonly first?: boolean } = {}): boolean {
    const r = this.tryLoad();
    if (r.ok) return r.changed;
    if (o.first === true) throw new Error(r.error);
    return this.failClosed(r.error);
  }

  /** Re-reads the file; on a failure, keeps the current list and says why. */
  tryLoad():
    | { readonly ok: true; readonly changed: boolean }
    | { readonly ok: false; readonly error: string } {
    if (this.path === null) return { ok: true, changed: false };
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e) {
      return {
        ok: false,
        error: `cannot read ${this.path}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (text === this.text && this.error === null) return { ok: true, changed: false };
    let parsed;
    try {
      parsed = PublishFileSchema.safeParse(JSON.parse(text));
    } catch (e) {
      return {
        ok: false,
        error: `${this.path}: not JSON (${e instanceof Error ? e.message : String(e)})`,
      };
    }
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        error: `${this.path}: ${issue === undefined ? "invalid" : `${issue.path.join(".")}: ${issue.message}`}`,
      };
    }
    const next = new Map<MatchId, PublishEntry>();
    for (const m of parsed.data.matches) {
      next.set(m.id, {
        id: m.id,
        title: m.title,
        description: m.description ?? null,
        featured: m.featured === true,
        visibility: m.visibility ?? "live",
      });
    }
    const changed = JSON.stringify([...this.entries]) !== JSON.stringify([...next]);
    this.entries = next;
    this.text = text;
    this.error = null;
    return { ok: true, changed };
  }

  /** The entry of a match, or null when it is not public. */
  entry(id: MatchId): PublishEntry | null {
    if (this.path === null) {
      return { id, title: id, description: null, featured: false, visibility: "live" };
    }
    return this.entries.get(id) ?? null;
  }

  /** Publishes nothing until the file reads again; returns whether the list changed. */
  failClosed(message: string): boolean {
    const changed = this.entries.size > 0;
    this.entries = new Map();
    this.text = null;
    this.error = message;
    return changed;
  }
}
