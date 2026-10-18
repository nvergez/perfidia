import type { Moment } from "@perfidia/protocol/spectator";

// The key moments reel (phase-3 design §4.3), pure: the plan and the state machine that plays it.
// Each chosen moment (importance 3, and 2 as well when there are fewer than 8 of those) becomes a
// clip: seek to `t − 2 h`, play at 1 h/s until `t + 30 min`, then hold its caption. Clips that
// overlap are merged. Holds are sized so the whole reel lasts about two minutes.

export const REEL_SPEED = 3_600;
export const BEFORE_S = 2 * 3_600;
export const AFTER_S = 30 * 60;
/** With fewer importance-3 moments than this, importance 2 joins in. */
export const MIN_KEY = 8;
/** At most this many moments in a reel (the most important, then evenly spread). */
export const MAX_MOMENTS = 16;
const TARGET_MS = 120_000;
const HOLD_MIN_MS = 4_000;
const HOLD_MAX_MS = 9_000;

export interface Clip {
  readonly from: number;
  readonly to: number;
  readonly moments: readonly Moment[];
}

export interface ReelPlan {
  readonly clips: readonly Clip[];
  /** How long each clip's caption stays after it played. */
  readonly holdMs: number;
  /** About how long the whole reel lasts. */
  readonly totalMs: number;
}

/** `n` items of `xs` spread evenly (its first and last kept). */
function spread<T>(xs: readonly T[], n: number): T[] {
  if (xs.length <= n) return [...xs];
  if (n <= 1) return xs.slice(0, Math.max(0, n));
  const out: T[] = [];
  for (let i = 0; i < n; i += 1) {
    const x = xs[Math.round((i * (xs.length - 1)) / (n - 1))];
    if (x !== undefined) out.push(x);
  }
  return out;
}

/** The moments a reel shows, in time order. */
export function reelMoments(moments: readonly Moment[]): Moment[] {
  const key = moments.filter((m) => m.importance >= 3);
  const chosen =
    key.length >= MIN_KEY
      ? spread(key, MAX_MOMENTS)
      : [
          ...key,
          ...spread(
            moments.filter((m) => m.importance === 2),
            MAX_MOMENTS - key.length,
          ),
        ];
  return chosen.toSorted((a, b) => a.seq - b.seq);
}

/** The reel of a match whose replay ends at `end`. */
export function planReel(moments: readonly Moment[], end: number): ReelPlan {
  const clips: { from: number; to: number; moments: Moment[] }[] = [];
  for (const m of reelMoments(moments)) {
    const from = Math.max(0, m.t - BEFORE_S);
    const to = Math.min(end, m.t + AFTER_S);
    const last = clips.at(-1);
    if (last !== undefined && from <= last.to) {
      last.to = Math.max(last.to, to);
      last.moments.push(m);
    } else {
      clips.push({ from, to: Math.max(from, to), moments: [m] });
    }
  }
  const playMs = clips.reduce((n, c) => n + ((c.to - c.from) / REEL_SPEED) * 1000, 0);
  const holdMs =
    clips.length === 0
      ? 0
      : Math.round(
          Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, (TARGET_MS - playMs) / clips.length)),
        );
  return { clips, holdMs, totalMs: Math.round(playMs + holdMs * clips.length) };
}

// The state machine ------------------------------------------------------------------------------

export type ReelState =
  /** Waiting until the clip's start can be shown, then seeking to it. */
  | { readonly k: "wait"; readonly clip: number }
  | { readonly k: "play"; readonly clip: number }
  | { readonly k: "hold"; readonly clip: number; readonly until: number }
  | { readonly k: "done" };

export interface ReelInput {
  /** Client time, ms. */
  readonly now: number;
  readonly playhead: number;
  readonly playing: boolean;
  /** The frame is exact for the playhead (its lines are loaded). */
  readonly known: boolean;
  /** The whole match is loaded (a finished match's steps). */
  readonly complete: boolean;
}

export type ReelCommand =
  | { readonly k: "none" }
  | { readonly k: "start"; readonly t: number }
  | { readonly k: "pause" }
  | { readonly k: "stop" };

const NONE: ReelCommand = Object.freeze({ k: "none" });

/** Game seconds of slack before the viewer is taken to have left the clip (a seek elsewhere). */
const LEFT_S = 3 * 3_600;

export function reelStart(plan: ReelPlan): ReelState {
  return plan.clips.length === 0 ? { k: "done" } : { k: "wait", clip: 0 };
}

/** One step of the reel: the next state and what the playback should do. */
export function reelStep(
  plan: ReelPlan,
  s: ReelState,
  i: ReelInput,
): { readonly state: ReelState; readonly cmd: ReelCommand } {
  if (s.k === "done") return { state: s, cmd: { k: "stop" } };
  const clip = plan.clips[s.clip];
  if (clip === undefined) return { state: { k: "done" }, cmd: { k: "stop" } };
  if (s.k === "wait") {
    // A finished match loads its steps in the background: start once they are all there.
    if (!i.complete) return { state: s, cmd: NONE };
    return { state: { k: "play", clip: s.clip }, cmd: { k: "start", t: clip.from } };
  }
  if (s.k === "play") {
    if (i.playhead >= clip.to) {
      return {
        state: { k: "hold", clip: s.clip, until: i.now + plan.holdMs },
        cmd: { k: "pause" },
      };
    }
    if (i.playhead < clip.from - LEFT_S || i.playhead > clip.to + LEFT_S) {
      return { state: { k: "done" }, cmd: { k: "stop" } };
    }
    return { state: s, cmd: NONE };
  }
  if (i.now < s.until) return { state: s, cmd: NONE };
  return s.clip + 1 < plan.clips.length
    ? { state: { k: "wait", clip: s.clip + 1 }, cmd: NONE }
    : { state: { k: "done" }, cmd: { k: "stop" } };
}

/** Skip to clip `n` (the previous or next one); past the last one, the reel is done. */
export function reelGoto(plan: ReelPlan, n: number): ReelState {
  return n >= plan.clips.length ? { k: "done" } : { k: "wait", clip: Math.max(0, n) };
}

/** The moment a clip's caption shows at `t`: the last one passed, else the first coming. */
export function captionAt(
  clip: Clip,
  t: number,
): { readonly moment: Moment; readonly past: boolean } | null {
  const passed = clip.moments.findLast((m) => m.t <= t);
  if (passed !== undefined) return { moment: passed, past: true };
  const first = clip.moments[0];
  return first === undefined ? null : { moment: first, past: false };
}
