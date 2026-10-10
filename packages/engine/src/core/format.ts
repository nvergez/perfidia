// Deterministic time formatting (docs/architecture.md §7.3): no Intl, no locale, integers only.

/** Game seconds in a game day. */
export const DAY = 86400;

/** The formatter handed to explainers (structurally identical to the `Fmt` of `contracts`). */
export interface Fmt {
  time(t: number): string;
  duration(s: number): string;
}

function assertNonNegativeInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`${what} must be a non-negative safe integer, got ${n}`);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Game time t as `"D{day} HH:MM"`, with `":SS"` when the seconds are not zero: 223370 → "D3 14:02:50". */
export function fmtTime(t: number): string {
  assertNonNegativeInt(t, "game time");
  const day = Math.floor(t / DAY);
  const second = t - day * DAY;
  const hours = Math.floor(second / 3600);
  const minutes = Math.floor((second % 3600) / 60);
  const seconds = second % 60;
  const hhmm = `D${day + 1} ${pad2(hours)}:${pad2(minutes)}`;
  return seconds === 0 ? hhmm : `${hhmm}:${pad2(seconds)}`;
}

/** Duration s as days, hours, minutes and seconds, zero parts omitted: 381480 → "4d 9h58m", 0 → "0s". */
export function fmtDuration(s: number): string {
  assertNonNegativeInt(s, "duration");
  if (s === 0) return "0s";
  const days = Math.floor(s / DAY);
  const rest = s - days * DAY;
  const hours = Math.floor(rest / 3600);
  const minutes = Math.floor((rest % 3600) / 60);
  const seconds = rest % 60;
  const hms =
    (hours > 0 ? `${hours}h` : "") +
    (minutes > 0 ? `${minutes}m` : "") +
    (seconds > 0 ? `${seconds}s` : "");
  if (days === 0) return hms;
  return hms === "" ? `${days}d` : `${days}d ${hms}`;
}

/** The deterministic formatter of §7.3. */
export const fmt: Fmt = Object.freeze({ time: fmtTime, duration: fmtDuration });
