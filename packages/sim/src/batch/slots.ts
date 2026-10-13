import { createMatch, type AnyRuleset } from "@perfidia/engine";
import { DAY } from "@perfidia/engine/core";
import type { GameTime, LogLine, MatchSetup } from "@perfidia/protocol";
import { freeSlotCount } from "./pacing.ts";

// Free city slots over a match (docs/architecture.md §12.2), without a replay: a city is only ever
// added, by a founding into a free slot, and never removed, so the free slots at `t` are those of
// the initial world (created again from the log's setup) less the `city_founded` events up to `t`.
// The pacing replay measures the same numbers from the state at each day's end (§13.9).

export interface FreeSlots {
  /** At the match start. */
  readonly initial: number;
  /** At the end of game day 5 (t = 432000); null when the match ended before. */
  readonly d5: number | null;
  /** At the end of game day 7, or at the match end when it ended before. */
  readonly d7: number;
  readonly end: number;
}

/** The free city slots of the initial world of `setup`. */
export function initialFreeSlots(setup: MatchSetup, ruleset: AnyRuleset): number {
  return freeSlotCount(createMatch(setup, ruleset).read().state);
}

/** The game times of the `city_founded` events. */
function foundingTimes(lines: Iterable<LogLine>): GameTime[] {
  const out: GameTime[] = [];
  for (const line of lines) {
    if (line.k === "ev" && line.e.type === "city_founded") out.push(line.t);
  }
  return out;
}

/** The free slots once every event up to `t` (included) has run, from the `initial` ones. */
export function freeSlotsAt(lines: Iterable<LogLine>, initial: number, t: GameTime): number {
  return initial - foundingTimes(lines).filter((x) => x <= t).length;
}

/** The free slots at the end of days 5 and 7 and at the match end (`endedAt`). */
export function freeSlotsOf(
  lines: Iterable<LogLine>,
  initial: number,
  endedAt: GameTime,
): FreeSlots {
  const foundings = foundingTimes(lines);
  const at = (t: GameTime): number => initial - foundings.filter((x) => x <= t).length;
  return {
    initial,
    d5: endedAt >= 5 * DAY ? at(5 * DAY) : null,
    d7: at(Math.min(7 * DAY, endedAt)),
    end: at(endedAt),
  };
}
