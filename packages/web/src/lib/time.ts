import { fmtGameDuration, fmtGameTime } from "@perfidia/spectator/reduce";

// Game time for display: `D3 14:02` (the engine's `fmtTime`, seconds shown when not zero), the
// clock without seconds, days, durations in words and playback speeds. Game time is integer
// game-seconds since the match start; day 1 starts at 0.

export const MINUTE = 60;
export const HOUR = 3_600;
export const DAY = 86_400;

/** `D3 14:02` (`:SS` appended when the seconds are not zero), exactly as the engine prints it. */
export function fmtTime(t: number): string {
  return fmtGameTime(t);
}

/** `4d 9h58m`, exactly as the engine prints a duration. */
export function fmtDuration(s: number): string {
  return fmtGameDuration(s);
}

/** The game day of `t`, from 1. */
export function dayOf(t: number): number {
  return Math.floor(t / DAY) + 1;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** `D3 14:02`, seconds dropped (a clock that ticks once a game minute). */
export function fmtClock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const second = s % DAY;
  return `D${dayOf(s)} ${pad2(Math.floor(second / HOUR))}:${pad2(Math.floor((second % HOUR) / MINUTE))}`;
}

/** A span in words: `24 h`, `6 h`, `1 h 30 min`, `45 min`, `2 d 3 h`, `30 s`. */
export function fmtSpan(s: number): string {
  const v = Math.max(0, Math.round(s));
  if (v < MINUTE) return `${v} s`;
  const d = Math.floor(v / DAY);
  const h = Math.floor((v % DAY) / HOUR);
  const m = Math.floor((v % HOUR) / MINUTE);
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

/** How long ago, in game time: `just now`, `12 min ago`, `3 h ago`, `2 d ago`. */
export function fmtAgo(dt: number): string {
  const v = Math.max(0, Math.floor(dt));
  if (v < MINUTE) return "just now";
  if (v < HOUR) return `${Math.floor(v / MINUTE)} min ago`;
  if (v < DAY) return `${Math.floor(v / HOUR)} h ago`;
  return `${Math.floor(v / DAY)} d ago`;
}

/** Replay speeds in game-seconds per wall-second: 5 min/s, 15 min/s, 1 h/s, 3 h/s, 6 h/s. */
export const SPEEDS = [300, 900, 3_600, 10_800, 21_600] as const;
export type Speed = (typeof SPEEDS)[number];
/** 1 h/s: a 7-day match in about 3 minutes. */
export const DEFAULT_SPEED: Speed = 3_600;

/** `5 min/s`, `1 h/s`. */
export function fmtSpeed(gameSecondsPerSecond: number): string {
  const v = gameSecondsPerSecond;
  if (v >= HOUR && v % HOUR === 0) return `${v / HOUR} h/s`;
  if (v >= MINUTE && v % MINUTE === 0) return `${v / MINUTE} min/s`;
  return `${v} s/s`;
}
