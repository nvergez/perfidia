import { ceilDiv } from "@perfidia/engine/core";
import type { DeepReadonly, GameState, PlayerId } from "@perfidia/protocol";
import { isTaken, type Perfidia11Ext } from "./ext_1_1.ts";
import { hasHubs } from "./world.ts";
import type { PerfidiaCore } from "./schema.ts";

// Domination by conquest (perfidia-1@1.1.0 §13.3): the threshold counts the map's city slots, which
// are fixed for a map, and a bloc also needs `victory.dominationMinConquests` taken cities. Blocs,
// countdowns and their same-second order are 1.0.0's (`domination.ts`).

/** The domination keys of 1.1.0's config. */
export interface Victory11 {
  readonly dominationPm: number;
  readonly dominationMinPerPlayer: number;
  readonly dominationMinConquests: number;
}

/** What a bloc must hold to qualify: cities, and taken cities among them. */
export interface DominationNeed {
  readonly cities: number;
  readonly taken: number;
}

/** What a bloc or a player holds: cities (a besieged city counts for its owner), and taken ones. */
export interface Hold {
  readonly cities: number;
  readonly taken: number;
}

const NOTHING: Hold = Object.freeze({ cities: 0, taken: 0 });

/** Every city slot of the map, Olympus included: fixed for a map (§2.4). */
export function totalSlots(state: DeepReadonly<GameState>): number {
  let n = 0;
  for (const island of Object.values(state.islands)) n += island.slots;
  return n;
}

/**
 * The city slots of the map a config lays out for N players: Olympus, and in each of the N sectors
 * a home, backyard, frontier and inner island, plus a hub when N ≤ `map.hubMaxPlayers` (§2.1).
 */
export function mapSlots(config: DeepReadonly<PerfidiaCore>, players: number): number {
  const k = config.map.kinds;
  const slots = (kind: string): number => (Object.hasOwn(k, kind) ? (k[kind]?.slots ?? 0) : 0);
  const sector =
    slots("home") +
    slots("backyard") +
    slots("frontier") +
    slots("inner") +
    (hasHubs(config, players) ? slots("hub") : 0);
  return slots("olympus") + players * sector;
}

/**
 * The threshold (§13.3): `max(dominationMinPerPlayer × N, ceilDiv(dominationPm × slots, 1000))`
 * cities, `dominationMinConquests` of them taken.
 */
export function dominationNeed11(
  victory: Victory11,
  players: number,
  slots: number,
): DominationNeed {
  return {
    cities: Math.max(
      victory.dominationMinPerPlayer * players,
      ceilDiv(victory.dominationPm * slots, 1000),
    ),
    taken: victory.dominationMinConquests,
  };
}

/** What every player holds, in one pass over the cities. */
export function holdByOwner(
  state: DeepReadonly<GameState>,
  x: DeepReadonly<Perfidia11Ext>,
): ReadonlyMap<PlayerId, Hold> {
  const out = new Map<PlayerId, { cities: number; taken: number }>();
  for (const city of Object.values(state.cities)) {
    if (city.owner === null) continue;
    const h = out.get(city.owner) ?? { cities: 0, taken: 0 };
    h.cities += 1;
    if (isTaken(x, city.id, city.owner)) h.taken += 1;
    out.set(city.owner, h);
  }
  return out;
}

/** What a player holds. */
export function holdOf(byOwner: ReadonlyMap<PlayerId, Hold>, p: PlayerId): Hold {
  return byOwner.get(p) ?? NOTHING;
}

/** What the members of a bloc hold together. */
export function blocHold(byOwner: ReadonlyMap<PlayerId, Hold>, members: readonly PlayerId[]): Hold {
  let cities = 0;
  let taken = 0;
  for (const p of members) {
    const h = holdOf(byOwner, p);
    cities += h.cities;
    taken += h.taken;
  }
  return { cities, taken };
}

/** Whether a hold meets the threshold. */
export function holds(need: DominationNeed, have: Hold): boolean {
  return have.cities >= need.cities && have.taken >= need.taken;
}
