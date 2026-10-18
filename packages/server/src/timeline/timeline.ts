import {
  type FeedItem,
  type FeedKind,
  type FeedPage,
  type Frame,
  type MatchId,
  type MatchStatus,
  type Moment,
  type ReportDetail,
  type Seq,
  type SpectatorMap,
  type Step,
  type StepsPage,
  type TimelineId,
  type Verified,
} from "@perfidia/protocol/spectator";
import type { PlayerId, Sha256 } from "@perfidia/protocol";
import type { Keyframe, SeatCounts } from "@perfidia/spectator";
import { applySteps } from "@perfidia/spectator/reduce";
import type { FoldBatch, SeatAux } from "../fold/messages.ts";

// A match's timeline in the server's memory (phase-3 design §2.5, §2.7): everything the fold of its
// `match.jsonl` produced (steps, keyframes, moments, report copies, the seats' notebooks and counts)
// and the frame at the tail, kept up to date by applying each new step. Batches are applied
// idempotently by cursor: a refold of the same log (after a restart from a cached prefix, or after a
// worker crash) sends steps the timeline already holds, and they are skipped. The timeline holds
// spectator data only (never the header, its seed or id key), so it can be cached as is.

export const CACHE_FORMAT = "perfidia-timeline-cache/1";

export interface FeedEntry {
  readonly seq: Seq;
  readonly item: FeedItem;
}

export interface FeedQuery {
  readonly after?: number | undefined;
  readonly before?: number | undefined;
  readonly kinds?: readonly FeedKind[] | undefined;
  readonly players?: readonly PlayerId[] | undefined;
  readonly pair?: readonly [PlayerId, PlayerId] | undefined;
  readonly private?: boolean | undefined;
  readonly limit: number;
}

export interface Appended {
  /** Steps of every line with `from < seq ≤ to`. */
  readonly from: Seq;
  readonly to: Seq;
  readonly steps: readonly Step[];
}

/** The serialised form of a timeline in the cache directory. */
export interface TimelineData {
  readonly format: typeof CACHE_FORMAT;
  readonly match: MatchId;
  readonly logId: Sha256;
  readonly timeline: TimelineId;
  readonly lastSeq: number;
  readonly lastT: number;
  readonly status: MatchStatus;
  readonly verified: Verified;
  readonly drift: string | null;
  readonly map: SpectatorMap | null;
  readonly steps: readonly Step[];
  readonly keyframes: readonly Keyframe[];
  readonly moments: readonly Moment[];
  readonly reports: readonly ReportDetail[];
  readonly seats: readonly SeatAux[];
}

/** The index of the first element of `xs` whose `seq` is above `after` (binary search). */
function firstAfter(xs: readonly { readonly seq: number }[], after: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((xs[mid]?.seq ?? Infinity) > after) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export class Timeline {
  readonly match: MatchId;
  readonly logId: Sha256;
  readonly timeline: TimelineId;
  map: SpectatorMap | null = null;
  readonly steps: Step[] = [];
  readonly keyframes: Keyframe[] = [];
  readonly moments: Moment[] = [];
  readonly feed: FeedEntry[] = [];
  readonly reports = new Map<string, ReportDetail>();
  readonly seats = new Map<string, { readonly notes: string; readonly counts: SeatCounts }>();
  /** The cursor of the last line folded; -1 before the header. */
  lastSeq = -1;
  lastT = 0;
  /** The fold's status: `live`, `ended`, `fatal` or `unverifiable`. */
  status: MatchStatus = "live";
  verified: Verified = { ok: true, divergence: null };
  drift: string | null = null;
  private tailFrame: Frame | null = null;
  /** Bumped by every change (for response caches). */
  version = 0;

  constructor(match: MatchId, logId: Sha256, timeline: TimelineId) {
    this.match = match;
    this.logId = logId;
    this.timeline = timeline;
  }

  /** The fold reached a line after which the log cannot grow. */
  get final(): boolean {
    return this.status === "ended" || this.status === "fatal";
  }

  /** The frame after the last step (null before the header was folded). */
  tail(): Frame | null {
    return this.tailFrame;
  }

  /** Applies a fold batch; returns the range it added, or null when it added nothing. */
  apply(batch: FoldBatch): Appended | null {
    if (batch.lastSeq <= this.lastSeq && this.lastSeq >= 0) return null;
    const from = this.lastSeq;
    if (batch.map !== null && this.map === null) this.map = batch.map;
    for (const k of batch.keyframes) if (k.seq > from) this.keyframes.push(k);
    const steps = batch.steps.filter((s) => s.seq > from);
    for (const step of steps) {
      this.steps.push(step);
      for (const item of step.items ?? []) this.feed.push({ seq: step.seq, item });
    }
    for (const m of batch.moments) if (m.seq > from) this.moments.push(m);
    for (const r of batch.reports) this.reports.set(r.report, r);
    for (const s of batch.seats) this.seats.set(s.seat, { notes: s.notes, counts: s.counts });
    // The tail: from the latest keyframe when it is ahead of the tail (a keyframe is the fold's frame
    // at its cursor), then the new steps beyond it.
    const keyframe = this.keyframes.at(-1);
    let base = this.tailFrame;
    if (keyframe !== undefined && (base === null || keyframe.seq > base.seq)) base = keyframe.frame;
    if (base !== null) this.tailFrame = steps.length > 0 ? applySteps(base, steps) : base;
    this.lastSeq = batch.lastSeq;
    this.lastT = Math.max(this.lastT, batch.lastT);
    this.status = batch.status;
    this.verified = batch.verified;
    this.drift = batch.drift;
    this.version += 1;
    return { from: Math.max(0, from), to: this.lastSeq, steps };
  }

  /** Steps with `seq > after`, at most `limit`: `to` is the last line the page covers. */
  page(after: number, limit: number): StepsPage {
    const i = firstAfter(this.steps, after);
    const steps = this.steps.slice(i, i + limit);
    const more = i + limit < this.steps.length;
    const last = steps.at(-1);
    const to = more && last !== undefined ? last.seq : Math.max(after, this.lastSeq);
    return { from: after, to, steps, lastSeq: Math.max(0, this.lastSeq), more };
  }

  keyframe(seq: number): Frame | null {
    const i = firstAfter(this.keyframes, seq - 1);
    const k = this.keyframes[i];
    return k !== undefined && k.seq === seq ? k.frame : null;
  }

  feedPage(q: FeedQuery): FeedPage {
    const kinds = q.kinds === undefined || q.kinds.length === 0 ? null : new Set(q.kinds);
    const players = q.players === undefined || q.players.length === 0 ? null : new Set(q.players);
    const match = (e: FeedEntry): boolean => {
      const it = e.item;
      if (kinds !== null && !kinds.has(it.k)) return false;
      if (players !== null && !it.players.some((p) => players.has(p))) return false;
      if (
        q.pair !== undefined &&
        !(it.players.includes(q.pair[0]) && it.players.includes(q.pair[1]))
      )
        return false;
      if (q.private === true && !(it.k === "message" && it.private)) return false;
      return true;
    };
    const out: FeedEntry[] = [];
    if (q.before !== undefined || q.after === undefined) {
      // The latest items before `before` (or the latest of all), in order.
      const end = q.before === undefined ? this.feed.length : firstAfter(this.feed, q.before - 1);
      const floor = q.after ?? -1;
      let i = end - 1;
      for (; i >= 0 && out.length < q.limit; i -= 1) {
        const e = this.feed[i];
        if (e === undefined || e.seq <= floor) break;
        if (match(e)) out.push(e);
      }
      let more = false;
      for (; i >= 0; i -= 1) {
        const e = this.feed[i];
        if (e === undefined || e.seq <= floor) break;
        if (match(e)) {
          more = true;
          break;
        }
      }
      return { items: out.toReversed(), more };
    }
    let i = firstAfter(this.feed, q.after);
    for (; i < this.feed.length && out.length < q.limit; i += 1) {
      const e = this.feed[i];
      if (e !== undefined && match(e)) out.push(e);
    }
    let more = false;
    for (; i < this.feed.length; i += 1) {
      const e = this.feed[i];
      if (e !== undefined && match(e)) {
        more = true;
        break;
      }
    }
    return { items: out, more };
  }

  toData(): TimelineData {
    return {
      format: CACHE_FORMAT,
      match: this.match,
      logId: this.logId,
      timeline: this.timeline,
      lastSeq: this.lastSeq,
      lastT: this.lastT,
      status: this.status,
      verified: this.verified,
      drift: this.drift,
      map: this.map,
      steps: this.steps,
      keyframes: this.keyframes,
      moments: this.moments,
      reports: [...this.reports.values()],
      seats: [...this.seats].map(([seat, s]) => ({ seat, notes: s.notes, counts: s.counts })),
    };
  }

  static fromData(d: TimelineData): Timeline {
    const t = new Timeline(d.match, d.logId, d.timeline);
    t.apply({
      lastSeq: d.lastSeq,
      lastT: d.lastT,
      status: d.status,
      verified: d.verified,
      map: d.map,
      steps: d.steps,
      keyframes: d.keyframes,
      moments: d.moments,
      reports: d.reports,
      seats: d.seats,
      drift: d.drift,
      idle: true,
    });
    return t;
  }
}
