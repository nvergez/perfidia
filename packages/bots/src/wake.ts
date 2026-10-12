// The self-wake a bot asks for with `end_turn` (docs/architecture.md §11.1): its cadence, or earlier
// when something it waits for happens (a queue empties, a rejected call becomes possible, a founding
// lands), never earlier than the wake budget allows and always within `selfWake`.

import { DAY } from "./kit.ts";

/** Game seconds kept above the lower bound when game time moves during a turn (real time). */
export const WAKE_MARGIN = 60;

export interface WakeInput {
  /** The latest game time the bot knows of (the briefing's, then its results'). */
  readonly now: number;
  /**
   * The longest game-time step seen between two rounds of this turn: 0 in lockstep, where every
   * call of a turn is applied at the same second; in real time the think time of a round.
   */
  readonly step: number;
  /** The strategy's wanted delay between own turns. */
  readonly cadence: number;
  /** `rules.gateway.selfWake`, or null while the rules are unknown. */
  readonly selfWake: { readonly min: number; readonly max: number } | null;
  /** Own wakes left today (the briefing's budget). */
  readonly ownWakesLeft: number;
  /** Times worth waking at: queue ends, `availableAt` of rejected calls and items, landings. */
  readonly events: readonly number[];
  /**
   * Times the strategy must be awake at (a launch window opening, its army coming home): the
   * earliest one ahead is kept even when the cadence or the wake budget spread would wake later,
   * within `selfWake`. Omitted or empty: no such time.
   */
  readonly firm?: readonly number[];
}

/**
 * The `wakeAt` to request: the earliest event after `now` and before `now + cadence` (else the
 * cadence), clamped below by the wake budget (the rest of the game day spread over the own wakes
 * left) and `selfWake.min`, above by `selfWake.max`; or the earliest `firm` time ahead when that is
 * sooner (clamped to the self-wake range only).
 *
 * The gateway clamps against the second at which `end_turn` is applied. In lockstep that is `now`.
 * In real time it is one round's think time later, so the lower bound keeps a margin of twice the
 * longest step seen this turn (at least `WAKE_MARGIN`); a last round slower than that may still be
 * clamped by the difference, which the gateway reports as a warning.
 */
export function chooseWake(i: WakeInput): number {
  const { now } = i;
  if (i.selfWake === null) return now + i.cadence;
  const { min, max } = i.selfWake;
  let want = now + i.cadence;
  for (const e of i.events) if (e > now && e < want) want = e;
  const gap = Math.ceil((DAY - (now % DAY)) / Math.max(1, i.ownWakesLeft));
  const margin = i.step > 0 ? Math.min(max - min, Math.max(WAKE_MARGIN, 2 * i.step)) : 0;
  const lo = now + Math.max(min + margin, Math.min(gap, max));
  const hi = now + max;
  const chosen = Math.min(hi, Math.max(lo, want));
  let firm: number | null = null;
  for (const e of i.firm ?? []) if (e > now && (firm === null || e < firm)) firm = e;
  if (firm === null) return chosen;
  return Math.min(chosen, Math.min(hi, Math.max(now + min + margin, firm)));
}
