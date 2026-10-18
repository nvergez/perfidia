// Game time for display, as the engine formats it (`fmtTime`, `fmtDuration`): `D3 14:02` (with
// `:SS` when the seconds are not zero), `4d 9h58m`. The web cannot import the engine, so this is a
// copy; a test checks it against the engine's on random times.

const DAY = 86_400;

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** A game time: `D1 00:00` at 0; days from 1. */
export function fmtGameTime(t: number): string {
  const day = Math.floor(t / DAY);
  const second = t - day * DAY;
  const hours = Math.floor(second / 3600);
  const minutes = Math.floor((second % 3600) / 60);
  const seconds = second % 60;
  const hhmm = `D${day + 1} ${pad2(hours)}:${pad2(minutes)}`;
  return seconds === 0 ? hhmm : `${hhmm}:${pad2(seconds)}`;
}

/** A duration: days, hours, minutes and seconds, zero parts left out; `0s` for 0. */
export function fmtGameDuration(s: number): string {
  if (s === 0) return "0s";
  const days = Math.floor(s / DAY);
  const hours = Math.floor((s % DAY) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const head = days > 0 ? `${days}d` : "";
  const tail = `${hours > 0 ? `${hours}h` : ""}${minutes > 0 ? `${minutes}m` : ""}${seconds > 0 ? `${seconds}s` : ""}`;
  return head !== "" && tail !== "" ? `${head} ${tail}` : `${head}${tail}`;
}
