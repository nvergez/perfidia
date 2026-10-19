// The live clock of a real-time match (phase-3 design §3.2): the server's `clock` message gives the
// game time, the speed and a cap; the client anchors it on its own receipt time (never the server's
// wall clock: a 60 s skew at speed 3 would be 3 game minutes) and extrapolates, stopping at the cap
// (`min(matchEnd, lastT + 3600)`): beyond it the UI says "waiting for the server".

export interface ClockAnchor {
  /** Game time at receipt. */
  readonly t: number;
  /** Game-seconds per wall-second, as `[num, den]`. */
  readonly speed: readonly [number, number];
  readonly cap: number;
  /** The client's `performance.now()` at receipt, in milliseconds. */
  readonly at: number;
}

/** The extrapolated game time at `nowMs` (client time), capped; never before the anchor. */
export function clockNow(a: ClockAnchor, nowMs: number): number {
  const [num, den] = a.speed;
  const dt = Math.max(0, nowMs - a.at) / 1000;
  return Math.min(a.cap, a.t + (dt * num) / den);
}

/** Whether the extrapolation has reached its cap (the server has not confirmed later time yet). */
export function clockCapped(a: ClockAnchor, nowMs: number): boolean {
  return clockNow(a, nowMs) >= a.cap && a.cap > a.t;
}
