import type { FeedItem, Frame, Step } from "@perfidia/protocol/spectator";
import { applySteps } from "@perfidia/spectator/reduce";

// The client's timeline (phase-3 design §4.4): every frame and step the client holds, as segments.
// A segment starts at a known frame (a keyframe, or `/latest`) and holds the steps after it, with
// `to` the cursor up to which every line is known (steps are sparse: a line that changed nothing has
// no step, so coverage is tracked apart from the steps). Steps pages fill a segment from keyframe 0;
// live steps extend the one that starts at `/latest`; once a segment's coverage reaches the next
// one's base, they merge. Frames inside a segment come from its base or a client keyframe (one every
// 500 steps, kept as the steps are reduced; frames share every untouched entity, so they are cheap)
// and the steps after it. Pure: no I/O, no timers.

/** Client keyframes: a frame is kept after every this many steps. */
export const KEYFRAME_EVERY = 500;

/** A feed item and the cursor of the line that yielded it. */
export interface FeedEntry {
  readonly seq: number;
  readonly item: FeedItem;
}

interface Segment {
  readonly base: Frame;
  readonly steps: Step[];
  /** Every line with `seq ≤ to` is known. */
  to: number;
  /** Frames after `steps[i]`, by `i` (client keyframes and merged bases). */
  readonly frames: Map<number, Frame>;
  /** Sorted keys of `frames`. */
  readonly frameAt: number[];
  readonly items: FeedEntry[];
}

/** A place in the timeline: a segment and the index of the last step applied (−1: its base). */
export interface Position {
  readonly segment: number;
  readonly index: number;
}

/** The last index `i` of `xs` (sorted by `key`) with `key(xs[i]) ≤ v`, −1 when none. */
export function lastAtOrBefore<T>(xs: readonly T[], v: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = xs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const x = xs[mid];
    if (x !== undefined && key(x) <= v) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

const stepSeq = (s: Step): number => s.seq;
const stepT = (s: Step): number => s.t;
const entrySeq = (e: FeedEntry): number => e.seq;
const num = (n: number): number => n;

function insertSorted(xs: number[], v: number): void {
  const i = lastAtOrBefore(xs, v, num);
  if (xs[i] === v) return;
  xs.splice(i + 1, 0, v);
}

function pushItems(seg: Segment, step: Step): void {
  for (const item of step.items ?? []) seg.items.push({ seq: step.seq, item });
}

export class Timeline {
  private readonly segs: Segment[] = [];
  /** Bumped by every change of what the timeline holds. */
  version = 0;
  /** Bumped when segments are added or merged: positions taken before are stale. */
  structure = 0;

  get segmentCount(): number {
    return this.segs.length;
  }

  /** True when no frame is held yet. */
  get empty(): boolean {
    return this.segs.length === 0;
  }

  /** The cursor up to which the last segment is known (−1 when empty). */
  get headSeq(): number {
    return this.segs.at(-1)?.to ?? -1;
  }

  /** The time of the last step or frame held (0 when empty). */
  get headT(): number {
    const last = this.segs.at(-1);
    return last === undefined ? 0 : this.endT(last);
  }

  /** The time of the first frame held. */
  get startT(): number {
    return this.segs[0]?.base.t ?? 0;
  }

  /** The cursor of the first frame held (−1 when empty). */
  get startSeq(): number {
    return this.segs[0]?.base.seq ?? -1;
  }

  /** Coverage of each segment, `[base cursor, to]` and `[base time, last step time]`. */
  ranges(): {
    readonly fromSeq: number;
    readonly toSeq: number;
    readonly fromT: number;
    readonly toT: number;
  }[] {
    return this.segs.map((s) => ({
      fromSeq: s.base.seq,
      toSeq: s.to,
      fromT: s.base.t,
      toT: this.endT(s),
    }));
  }

  /** Whether every line up to `seq` from the first frame is held (no hole before it). */
  coversFromStart(seq: number): boolean {
    const first = this.segs[0];
    return first !== undefined && first.to >= seq;
  }

  private endT(seg: Segment): number {
    return seg.steps.at(-1)?.t ?? seg.base.t;
  }

  /** Adds a known frame: a new segment, or a client keyframe inside a segment that covers it. */
  addFrame(frame: Frame): void {
    const at = lastAtOrBefore(this.segs, frame.seq, (s) => s.base.seq);
    const seg = this.segs[at];
    if (seg !== undefined && frame.seq <= seg.to) {
      const i = lastAtOrBefore(seg.steps, frame.seq, stepSeq);
      if (i >= 0 && !seg.frames.has(i)) {
        const step = seg.steps[i];
        if (step !== undefined) {
          seg.frames.set(i, { ...frame, seq: step.seq, t: step.t });
          insertSorted(seg.frameAt, i);
        }
      }
      return;
    }
    const fresh: Segment = {
      base: frame,
      steps: [],
      to: frame.seq,
      frames: new Map(),
      frameAt: [],
      items: [],
    };
    this.segs.splice(at + 1, 0, fresh);
    this.version += 1;
    this.structure += 1;
    this.mergeFrom(at + 1);
  }

  /**
   * Adds the steps of the range `(from, to]` (every step of that range, as a page or a live message
   * carries them). It extends the segment that covers `from`; false when none does (a gap: the
   * caller fetches what is missing). Steps already held are skipped.
   */
  addSteps(from: number, to: number, steps: readonly Step[]): boolean {
    const at = lastAtOrBefore(this.segs, from, (s) => s.base.seq);
    const seg = this.segs[at];
    if (seg === undefined || from > seg.to) return false;
    if (to <= seg.to) return true;
    for (const step of steps) {
      if (step.seq <= seg.to || step.seq > to) continue;
      seg.steps.push(step);
      pushItems(seg, step);
    }
    seg.to = to;
    this.version += 1;
    this.mergeFrom(at);
    return true;
  }

  /** Merges the segments after `at` that its coverage reaches. */
  private mergeFrom(at: number): void {
    const seg = this.segs[at];
    if (seg === undefined) return;
    for (;;) {
      const next = this.segs[at + 1];
      if (next === undefined || next.base.seq > seg.to) return;
      const i = lastAtOrBefore(seg.steps, next.base.seq, stepSeq);
      const step = seg.steps[i];
      if (step !== undefined && !seg.frames.has(i)) {
        seg.frames.set(i, { ...next.base, seq: step.seq, t: step.t });
        insertSorted(seg.frameAt, i);
      }
      for (const s of next.steps) {
        if (s.seq <= seg.to) continue;
        seg.steps.push(s);
        pushItems(seg, s);
      }
      seg.to = Math.max(seg.to, next.to);
      this.segs.splice(at + 1, 1);
      this.structure += 1;
    }
  }

  /**
   * The position of game time `t`: the last step with `step.t ≤ t` in the latest segment that
   * starts at or before `t` (the first segment's base when `t` is before everything). `known` is
   * false when `t` falls after a segment's last step but before the next segment: lines there are
   * not loaded yet, so the frame shown is the closest one before.
   */
  locate(t: number): { readonly pos: Position; readonly known: boolean } | null {
    if (this.segs.length === 0) return null;
    let at = lastAtOrBefore(this.segs, t, (s) => s.base.t);
    if (at < 0) at = 0;
    const seg = this.segs[at];
    if (seg === undefined) return null;
    const index = lastAtOrBefore(seg.steps, t, stepT);
    const known = t >= seg.base.t && (at === this.segs.length - 1 || t <= this.endT(seg));
    return { pos: { segment: at, index }, known };
  }

  /** The position just after line `seq` (its step applied, if it has one); null when not held. */
  locateSeq(seq: number): Position | null {
    const at = lastAtOrBefore(this.segs, seq, (s) => s.base.seq);
    const seg = this.segs[at];
    if (seg === undefined || seq > seg.to) return null;
    return { segment: at, index: lastAtOrBefore(seg.steps, seq, stepSeq) };
  }

  /** The position of the last step held. */
  head(): Position | null {
    const at = this.segs.length - 1;
    const seg = this.segs[at];
    return seg === undefined ? null : { segment: at, index: seg.steps.length - 1 };
  }

  /** The step at a position (null at a base). */
  stepAt(pos: Position): Step | null {
    return this.segs[pos.segment]?.steps[pos.index] ?? null;
  }

  /** The time of a position. */
  timeAt(pos: Position): number {
    const seg = this.segs[pos.segment];
    if (seg === undefined) return 0;
    return seg.steps[pos.index]?.t ?? seg.base.t;
  }

  /** The cursor of a position. */
  seqAt(pos: Position): number {
    const seg = this.segs[pos.segment];
    if (seg === undefined) return -1;
    return seg.steps[pos.index]?.seq ?? seg.base.seq;
  }

  /** The time of the first step after a position, or null at the end of its segment. */
  nextT(pos: Position): number | null {
    return this.segs[pos.segment]?.steps[pos.index + 1]?.t ?? null;
  }

  /**
   * The frame at a position, from the closest frame before it (`from`, when given and in the same
   * segment at or before it, else a client keyframe or the base) and the steps after; client
   * keyframes are kept on the way.
   */
  frameAt(pos: Position, from?: { readonly pos: Position; readonly frame: Frame }): Frame | null {
    const seg = this.segs[pos.segment];
    if (seg === undefined) return null;
    const index = Math.min(pos.index, seg.steps.length - 1);
    let start = -1;
    let frame = seg.base;
    const k = lastAtOrBefore(seg.frameAt, index, num);
    const kIndex = seg.frameAt[k];
    if (kIndex !== undefined) {
      const kept = seg.frames.get(kIndex);
      if (kept !== undefined) {
        start = kIndex;
        frame = kept;
      }
    }
    if (
      from !== undefined &&
      from.pos.segment === pos.segment &&
      from.pos.index <= index &&
      from.pos.index >= start
    ) {
      start = from.pos.index;
      frame = from.frame;
    }
    // In runs up to each client keyframe point (every KEYFRAME_EVERY steps): a run copies each
    // record it touches once (`applySteps`).
    for (let i = start + 1; i <= index;) {
      const kf = Math.ceil((i + 1) / KEYFRAME_EVERY) * KEYFRAME_EVERY - 1;
      const stop = Math.min(index, kf, seg.steps.length - 1);
      if (stop < i) break;
      frame = applySteps(frame, seg.steps.slice(i, stop + 1));
      if (stop === kf && !seg.frames.has(kf)) {
        seg.frames.set(kf, frame);
        insertSorted(seg.frameAt, kf);
      }
      i = stop + 1;
    }
    return frame;
  }

  /** Feed entries of every line up to `seq`, in order (from every segment held). */
  feedUntil(seq: number): FeedEntry[] {
    const out: FeedEntry[] = [];
    for (const seg of this.segs) {
      if (seg.base.seq > seq) break;
      const n = lastAtOrBefore(seg.items, seq, entrySeq) + 1;
      for (let i = 0; i < n; i += 1) {
        const e = seg.items[i];
        if (e !== undefined) out.push(e);
      }
    }
    return out;
  }

  /** How many feed entries `feedUntil(seq)` holds. */
  feedCount(seq: number): number {
    let n = 0;
    for (const seg of this.segs) {
      if (seg.base.seq > seq) break;
      n += lastAtOrBefore(seg.items, seq, entrySeq) + 1;
    }
    return n;
  }

  /** Every step held, in order (all segments). */
  *allSteps(): Generator<Step> {
    for (const seg of this.segs) yield* seg.steps;
  }

  /** Client keyframes held in a segment (for tests and diagnostics). */
  keyframeIndexes(segment: number): readonly number[] {
    return this.segs[segment]?.frameAt ?? [];
  }
}
