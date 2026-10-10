import {
  AllianceIdSchema,
  CityIdSchema,
  compareIds,
  type CityId,
  type DeepReadonly,
  GameTimeSchema,
  type GameTime,
  type PlayerId,
  PlayerIdSchema,
  safeRecord,
  z,
} from "@perfidia/protocol";

// `state.ext` of perfidia-1 (docs/architecture.md §4.2): sieges by city, raw battle points (never
// public), the public tie-break order, the relation history behind the kill-credit cooldown
// (§8.8), and the domination flag and countdowns (§13.3).

/** A running siege (§9.1); its garrison is the besieger's `hold` groups in the city. */
export const SiegeSchema = z.strictObject({
  by: PlayerIdSchema,
  startedAt: GameTimeSchema,
  endsAt: GameTimeSchema,
  /** Seq of its `siege_end` event (ref = the city). */
  seq: z.int().nonnegative(),
});
export type Siege = z.infer<typeof SiegeSchema>;

/** A bloc key (§13.3): the alliance id, or the player id of a player outside any alliance. */
export const BlocKeySchema = z.union([AllianceIdSchema, PlayerIdSchema]);
export type BlocKey = z.infer<typeof BlocKeySchema>;

/** A running domination countdown (§13.3). */
export const CountdownSchema = z.strictObject({
  bloc: BlocKeySchema,
  /** The bloc's members when the countdown started, sorted; a change cancels it. */
  members: z.array(PlayerIdSchema).min(1),
  startedAt: GameTimeSchema,
  endsAt: GameTimeSchema,
  /** Seq of its `domination_end` event (ref = the bloc key). */
  seq: z.int().nonnegative(),
});
export type Countdown = z.infer<typeof CountdownSchema>;

/** Two players in `compareIds` order, `"p1|p4"`. */
export const PairKeySchema = z.string().regex(/^p[1-9][0-9]*\|p[1-9][0-9]*$/, {
  error: 'expected a player pair key such as "p1|p4"',
});
export type PairKey = z.infer<typeof PairKeySchema>;

export const PerfidiaExtSchema = z.strictObject({
  /** The public tie-break order (§2.3 step 7), from t = 0. */
  tiebreak: z.array(PlayerIdSchema),
  sieges: safeRecord(CityIdSchema, SiegeSchema),
  /** Raw battle points (§8.8) by player; never public, only the capped battle score is. */
  battlePoints: safeRecord(PlayerIdSchema, z.int().nonnegative()),
  /** Pairs related (allies or pact partners) at the end of the last step, sorted. */
  related: z.array(PairKeySchema),
  /** When each pair last stopped being related: the kill-credit cooldown (§8.8). */
  relationEnds: safeRecord(PairKeySchema, GameTimeSchema),
  domination: z.strictObject({
    /** Set by the `domination_open` world timer (§3.1); domination is evaluated only from then. */
    open: z.boolean(),
    /** Sorted by bloc key (`compareIds`). */
    countdowns: z.array(CountdownSchema),
  }),
});
export type PerfidiaExt = z.infer<typeof PerfidiaExtSchema>;

type Ext = DeepReadonly<PerfidiaExt>;

/** The ext of a new world: no siege, no battle point, no relation, domination closed. */
export function initialExt(
  players: readonly PlayerId[],
  tiebreak: readonly PlayerId[],
): PerfidiaExt {
  const battlePoints: Record<PlayerId, number> = {};
  for (const p of players) battlePoints[p] = 0;
  return {
    tiebreak: [...tiebreak],
    sieges: {},
    battlePoints,
    related: [],
    relationEnds: {},
    domination: { open: false, countdowns: [] },
  };
}

/** The pair key of two distinct players, in `compareIds` order. */
export function pairKey(a: PlayerId, b: PlayerId): PairKey {
  if (a === b) throw new RangeError(`a pair needs two players, got ${a} twice`);
  return compareIds(a, b) < 0 ? `${a}|${b}` : `${b}|${a}`;
}

/** The running siege of `city`, or null. */
export function siegeOf(x: Ext, city: CityId): DeepReadonly<Siege> | null {
  return Object.hasOwn(x.sieges, city) ? (x.sieges[city] ?? null) : null;
}

/** The besieger of `city`, or null when it is not besieged. */
export function besiegerOf(x: Ext, city: CityId): PlayerId | null {
  return siegeOf(x, city)?.by ?? null;
}

/** Raw battle points of `p` (0 when none were recorded). */
export function battlePointsOf(x: Ext, p: PlayerId): number {
  return Object.hasOwn(x.battlePoints, p) ? (x.battlePoints[p] ?? 0) : 0;
}

/** Whether `a` and `b` were related at the end of the last step. */
export function wereRelated(x: Ext, a: PlayerId, b: PlayerId): boolean {
  return x.related.includes(pairKey(a, b));
}

/** When `a` and `b` last stopped being related, or null if they never did. */
export function relationEndedAt(x: Ext, a: PlayerId, b: PlayerId): GameTime | null {
  const key = pairKey(a, b);
  return Object.hasOwn(x.relationEnds, key) ? (x.relationEnds[key] ?? null) : null;
}

/** The running countdown of a bloc, or null. */
export function countdownOf(x: Ext, bloc: BlocKey): DeepReadonly<Countdown> | null {
  return x.domination.countdowns.find((c) => c.bloc === bloc) ?? null;
}

/** 0-based position of `p` in the public tie-break order (lower is better); throws if absent. */
export function tiebreakPosition(x: Ext, p: PlayerId): number {
  const i = x.tiebreak.indexOf(p);
  if (i < 0) throw new RangeError(`${p} is not in the tie-break order`);
  return i;
}
