import type { HourPoint } from "@perfidia/protocol/spectator";
import { prettyJson } from "../lib/json.ts";

// The dossier extras' pure parts (phase-3 design §4.2 Pass C, docs/phase3.md §16.8): what is known
// at the playhead (points and versions up to it), the notebook laid out for reading (a JSON
// notebook indented, as Pass B shows it), a line diff between two versions with its hunks, and the
// geometry of a sparkline. No DOM.

/** How many of `xs` (in time order) are at or before `t` (binary search). */
export function countUntil(xs: readonly { readonly t: number }[], t: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((xs[mid]?.t ?? Infinity) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Layout {
  readonly text: string;
  readonly json: boolean;
}

/** The last texts laid out: a version's text is laid out again as the next version's `prev`. */
const LAYOUTS = new Map<string, Layout>();
const LAYOUTS_KEPT = 64;

/**
 * A notebook's text as shown: a JSON notebook indented (a bot's memory, within the bounds of
 * `prettyJson`), else as written. Remembered for the last 64 texts.
 */
export function layout(text: string): Layout {
  const held = LAYOUTS.get(text);
  if (held !== undefined) return held;
  const pretty = prettyJson(text);
  const out: Layout = pretty === null ? { text, json: false } : { text: pretty, json: true };
  if (LAYOUTS.size >= LAYOUTS_KEPT) {
    const oldest = LAYOUTS.keys().next();
    if (oldest.done !== true) LAYOUTS.delete(oldest.value);
  }
  LAYOUTS.set(text, out);
  return out;
}

export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
  readonly kind: DiffKind;
  readonly text: string;
}

/** Above this many cells, the middle of a diff is shown as removed then added (no LCS). */
const LCS_CELLS = 250_000;

/** The lines of `b` against those of `a`: kept, added and removed, in reading order. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a === "" ? [] : a.split("\n");
  const y = b === "" ? [] : b.split("\n");
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head += 1;
  let tail = 0;
  while (
    tail < x.length - head &&
    tail < y.length - head &&
    x[x.length - 1 - tail] === y[y.length - 1 - tail]
  ) {
    tail += 1;
  }
  const out: DiffLine[] = x.slice(0, head).map((text) => ({ kind: "same", text }));
  const xm = x.slice(head, x.length - tail);
  const ym = y.slice(head, y.length - tail);
  if (xm.length * ym.length > LCS_CELLS) {
    for (const text of xm) out.push({ kind: "del", text });
    for (const text of ym) out.push({ kind: "add", text });
  } else {
    out.push(...lcsDiff(xm, ym));
  }
  for (const text of x.slice(x.length - tail)) out.push({ kind: "same", text });
  return out;
}

/** The diff of two line lists by their longest common subsequence (removals before additions). */
function lcsDiff(x: readonly string[], y: readonly string[]): DiffLine[] {
  const n = x.length;
  const m = y.length;
  const w = m + 1;
  // len[i * w + j]: the LCS length of x[i..] and y[j..].
  const len = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      len[i * w + j] =
        x[i] === y[j]
          ? (len[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(len[(i + 1) * w + j] ?? 0, len[i * w + j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      out.push({ kind: "same", text: x[i] ?? "" });
      i += 1;
      j += 1;
    } else if (j >= m || (i < n && (len[(i + 1) * w + j] ?? 0) >= (len[i * w + j + 1] ?? 0))) {
      out.push({ kind: "del", text: x[i] ?? "" });
      i += 1;
    } else {
      out.push({ kind: "add", text: y[j] ?? "" });
      j += 1;
    }
  }
  return out;
}

/** A run of a diff to show: changed lines with `context` kept lines around them. */
export interface Hunk {
  /** Kept lines left out before this hunk. */
  readonly skipped: number;
  readonly lines: readonly DiffLine[];
}

/** The hunks of a diff, and the kept lines left out after the last one. */
export function hunksOf(
  diff: readonly DiffLine[],
  context = 1,
): { readonly hunks: Hunk[]; readonly after: number } {
  const keep = diff.map(() => false);
  for (const [i, d] of diff.entries()) {
    if (d.kind === "same") continue;
    for (let k = Math.max(0, i - context); k <= Math.min(diff.length - 1, i + context); k += 1) {
      keep[k] = true;
    }
  }
  const hunks: Hunk[] = [];
  let skipped = 0;
  let cur: DiffLine[] | null = null;
  for (const [i, d] of diff.entries()) {
    if (keep[i] === true) {
      if (cur === null) {
        cur = [];
        hunks.push({ skipped, lines: cur });
        skipped = 0;
      }
      cur.push(d);
    } else {
      cur = null;
      skipped += 1;
    }
  }
  return { hunks, after: skipped };
}

/** Added and removed lines of a diff. */
export function diffStats(diff: readonly DiffLine[]): {
  readonly add: number;
  readonly del: number;
} {
  let add = 0;
  let del = 0;
  for (const d of diff) {
    if (d.kind === "add") add += 1;
    else if (d.kind === "del") del += 1;
  }
  return { add, del };
}

export interface Spark {
  /** The line through the points, in the box `[0, 100] × [0, 100]` (y down). */
  readonly path: string;
  /** Each point's position in percent of the box. */
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  readonly min: number;
  readonly max: number;
}

/**
 * A sparkline's geometry: x by time across the box, y from `min(0, lowest)` to the highest value
 * (a flat series sits on its value); `step` draws a value held until the next point (cities).
 */
export function sparkOf(
  points: readonly HourPoint[],
  value: (p: HourPoint) => number,
  step: boolean,
): Spark {
  const vs = points.map(value);
  const t0 = points[0]?.t ?? 0;
  const t1 = points.at(-1)?.t ?? 0;
  const min = Math.min(0, ...vs);
  const max = Math.max(min + 1, ...vs);
  const xs = points.map((p) => (t1 === t0 ? 100 : ((p.t - t0) / (t1 - t0)) * 100));
  const ys = vs.map((v) => 100 - ((v - min) / (max - min)) * 100);
  let path = "";
  for (const [i, x] of xs.entries()) {
    const y = ys[i] ?? 0;
    if (i === 0) path = `M${r(xs.length === 1 ? 0 : x)} ${r(y)}`;
    else if (step) path += `H${r(x)}V${r(y)}`;
    else path += `L${r(x)} ${r(y)}`;
  }
  if (xs.length === 1) path += "H100";
  return { path, xs, ys, min, max };
}

const r = (v: number): string => String(Math.round(v * 100) / 100);

/** The index of the point nearest to `x` (percent of the box), or -1 with no points. */
export function nearest(xs: readonly number[], x: number): number {
  let best = -1;
  let dist = Infinity;
  for (const [i, v] of xs.entries()) {
    const d = Math.abs(v - x);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}
