import {
  CityIdSchema,
  compareIds,
  type CityId,
  type DeepReadonly,
  type PlayerId,
  PlayerIdSchema,
  safeRecord,
  z,
} from "@perfidia/protocol";
import { own } from "./common.ts";
import { initialExt, PerfidiaExtSchema } from "./ext.ts";

// `state.ext` of perfidia-1@1.1.0: 1.0.0's, plus the conquest record of every city that changed
// hands by conquest (docs/rulesets/perfidia-1.md §13.3), which says whether its owner took it.

/** How the owner of a conquered city got it (§9.4), and who owned it before. */
export const ConquestSchema = z.strictObject({
  /** The player holding the city under this record: always its current owner. */
  by: PlayerIdSchema,
  /** Every player that owned the city before `by` took it, its first owner included, sorted. */
  former: z.array(PlayerIdSchema),
});
export type Conquest = z.infer<typeof ConquestSchema>;

export const Perfidia11ExtSchema = PerfidiaExtSchema.extend({
  /** Cities that changed hands by conquest (§9.4), by city id; other cities have no entry. */
  conquests: safeRecord(CityIdSchema, ConquestSchema),
});
export type Perfidia11Ext = z.infer<typeof Perfidia11ExtSchema>;

type Ext = DeepReadonly<Perfidia11Ext>;

/** The ext of a new world: 1.0.0's, and no conquest yet. */
export function initialExt11(
  players: readonly PlayerId[],
  tiebreak: readonly PlayerId[],
): Perfidia11Ext {
  return { ...initialExt(players, tiebreak), conquests: {} };
}

/** The conquest record of `city`, or null when it never changed hands. */
export function conquestOf(x: Ext, city: CityId): DeepReadonly<Conquest> | null {
  return own(x.conquests, city) ?? null;
}

/**
 * Whether `city` is taken by `owner` (§13.3): `owner` got it by conquest and never owned it before.
 * Founded cities, cities never conquered and cities a former owner recaptured are not taken.
 */
export function isTaken(x: Ext, city: CityId, owner: PlayerId | null): boolean {
  const c = conquestOf(x, city);
  return owner !== null && c !== null && c.by === owner && !c.former.includes(owner);
}

/**
 * Records that `to` conquered `city` from `from` (null for the neutral Olympus city): `from` joins
 * the former owners, which stay listed for good, so each player can take a city at most once.
 */
export function recordConquest(
  x: Perfidia11Ext,
  city: CityId,
  from: PlayerId | null,
  to: PlayerId,
): void {
  const prev = own(x.conquests, city)?.former ?? [];
  const former =
    from === null || prev.includes(from) ? [...prev] : [...prev, from].toSorted(compareIds);
  x.conquests[city] = { by: to, former };
}
