import { createMatch, type AnyRuleset } from "@perfidia/engine";
import { DAY } from "@perfidia/engine/core";
import { z, type GameTime, type LogLine, type MatchSetup, type PlayerId } from "@perfidia/protocol";
import { freeSlotCount } from "./pacing.ts";
import { R1_CONQUERED, R1_SHARE_PM, type R1Rule } from "./teams.ts";

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

/**
 * The initial world of `setup`: its free city slots, all its slots, each city's owner, and the R1
 * rule of its effective config (`teamRecords`), when the config has the perfidia-1 domination keys.
 */
export interface InitialWorld {
  readonly free: number;
  readonly slots: number;
  readonly owners: ReadonlyMap<string, PlayerId | null>;
  readonly rule?: R1Rule;
}

/** The domination keys of a perfidia-1 config (1.1.0 adds `dominationMinConquests`). */
const DominationKeysSchema = z.looseObject({
  time: z.looseObject({ matchEnd: z.int(), dominationStart: z.int(), dominationHold: z.int() }),
  victory: z.looseObject({
    dominationPm: z.int(),
    dominationMinPerPlayer: z.int(),
    dominationMinConquests: z.int().optional(),
  }),
});

/**
 * The R1 rule of a config: its own threshold when it has `victory.dominationMinConquests`
 * (perfidia-1@1.1.0 on), else the proposed values with its floor and timers; null without them.
 */
export function r1RuleOf(config: unknown, players: number): R1Rule | null {
  const c = DominationKeysSchema.safeParse(config);
  if (!c.success) return null;
  const v = c.data.victory;
  const own = v.dominationMinConquests !== undefined;
  return {
    pm: own ? v.dominationPm : R1_SHARE_PM,
    minPerPlayer: v.dominationMinPerPlayer,
    players,
    minConquests: v.dominationMinConquests ?? R1_CONQUERED,
    open: c.data.time.dominationStart,
    hold: c.data.time.dominationHold,
    matchEnd: c.data.time.matchEnd,
  };
}

/** The initial world of `setup` (created once, as `initialFreeSlots` does). */
export function initialWorld(setup: MatchSetup, ruleset: AnyRuleset): InitialWorld {
  const match = createMatch(setup, ruleset).read();
  const state = match.state;
  let slots = 0;
  for (const isl of Object.values(state.islands)) slots += isl.slots;
  const owners = new Map<string, PlayerId | null>();
  for (const c of Object.values(state.cities)) owners.set(c.id, c.owner);
  const rule = r1RuleOf(match.config, setup.seats.length);
  const world = { free: freeSlotCount(state), slots, owners };
  return rule === null ? world : { ...world, rule };
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
