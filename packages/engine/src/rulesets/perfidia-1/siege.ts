import {
  CityIdSchema,
  type CityId,
  type DeepReadonly,
  type GameState,
  type MovementId,
  type PlayerId,
  type Recipient,
  type Res,
  type Role,
  type ScheduledEvent,
  type UnitCounts,
} from "@perfidia/protocol";
import {
  clearQueues,
  cleanUnits,
  eliminate,
  fallbackCity,
  hasUnits,
  putHome,
  recipients,
  rehomeAll,
  relationsOf,
  removeUnits,
  startReturn,
  station,
  transferCity,
  unstation,
} from "@perfidia/engine/std";
import {
  cancelIfQueued,
  cityOf,
  countIn,
  draftCityOf,
  draftMovementOf,
  fail,
  holdGroups,
  own,
  type PCtx,
  type PRead,
  type PRead100,
} from "./common.ts";
import { QUEUES_REFUNDED, SIEGE_BROKEN, SIEGE_STARTED, type SiegeBreakCause } from "./events.ts";
import type { PerfidiaExt } from "./ext.ts";
import { scoreRows } from "./scoring.ts";

// Sieges, conquest and elimination (perfidia-1 §9). A siege is the record `ext.sieges[city]` plus
// its garrison, the besieger's `hold` groups in the city, and its `siege_end` event (class 9).
//
// Homecoming warnings (§9.3, §12): the besieger is told about every return heading into the city
// it besieges, as an `incoming_attack` with `homecoming: true` and `from: null` addressed to it as
// `party`, from the siege start or from the return's creation. The origin stays hidden: it is the
// target of a bounced movement, or a city where the returning player had troops stationed. A told
// return records the besieger as its `party` (the foe of the coming homecoming battle), which is
// how `afterStep` recognises the returns other code created during a step and tells each one once.
// When the siege ends, the returns heading into the city drop that foe again (`party: null`), so
// no view shows a stale one.

/** The scheduled event that ends a siege (class 9), ref = the city. */
export const SIEGE_END = "siege_end";

type State = DeepReadonly<GameState>;

/** The public score parts frozen at an elimination (§9.7). */
type ScoreParts = PerfidiaExt["frozenScores"][PlayerId];

/** Settlers left in the besieger's garrison of the city. */
export function garrisonSettlers(
  state: State,
  settler: string,
  city: CityId,
  by: PlayerId,
): number {
  return countIn(holdGroups(state, city, by), settler);
}

/** Allies of a player (`relationsOf`, kind `ally`), sorted. */
function alliesOf(r: PRead, p: PlayerId | null): PlayerId[] {
  if (p === null) return [];
  return relationsOf(r, p)
    .filter((rel) => rel.kind === "ally")
    .map((rel) => rel.player);
}

function audience(entries: readonly (readonly [PlayerId | null, Role])[]): Recipient[] {
  return recipients(entries);
}

/**
 * Tells the besieger of a return's home that the return is coming (a homecoming battle), and
 * records the besieger as the return's `party`. No-op for anything but a return heading into a
 * city besieged by another player.
 */
export function announceHomecoming(ctx: PCtx, m: MovementId): void {
  const mv = draftMovementOf(ctx, m);
  if (mv.kind !== "return") return;
  const siege = own(ctx.ext().sieges, mv.home);
  if (siege === undefined || siege.by === mv.owner) return;
  mv.party = siege.by;
  ctx.emit({
    type: "incoming_attack",
    public: false,
    to: [{ p: siege.by, as: "party" }],
    data: {
      movement: m,
      from: null,
      by: mv.owner,
      foe: siege.by,
      to: mv.home,
      departAt: mv.departAt,
      arriveAt: mv.arriveAt,
      homecoming: true,
    },
  });
}

/** Returns heading into `city`, in the order of their arrival events (seq). */
export function returnsInto(state: State, city: CityId): MovementId[] {
  return Object.values(state.movements)
    .filter((m) => m.kind === "return" && m.home === city)
    .toSorted((a, b) => a.seq - b.seq)
    .map((m) => m.id);
}

/** The siege of `city` by `by` is over: the returns heading there no longer have a homecoming foe. */
function forgetHomecomings(ctx: PCtx, city: CityId, by: PlayerId): void {
  for (const m of returnsInto(ctx.state, city)) {
    const mv = draftMovementOf(ctx, m);
    if (mv.party === by) mv.party = null;
  }
}

/** Whether any resource of `r` is non-zero. */
function anyRes(r: Readonly<Res>): boolean {
  return r.wood > 0 || r.stone > 0 || r.gold > 0;
}

/**
 * Starts a siege of `city` by `by` (§9.1): the attack's survivors (`units`, homed in `home`) and the
 * attacker's stand-aside groups in the city become its garrison; the city's queues are cancelled
 * with normal refunds (no `queue_empty`); `siege_end` is scheduled `siegeDuration` later; the public
 * `siege_started` goes to the besieger, the owner and the owner's allies, then the owner's private
 * `queues_refunded` (what was credited and what the warehouse cap cut, §4.3) when anything was
 * due; every return already heading into the city is announced to the besieger.
 */
export function startSiege(
  ctx: PCtx,
  city: CityId,
  by: PlayerId,
  home: CityId,
  units: Readonly<UnitCounts>,
): void {
  if (hasUnits(units)) station(ctx, city, { owner: by, home, role: "hold", units: { ...units } });
  const aside = draftCityOf(ctx, city)
    .stationed.filter((g) => g.owner === by && g.role === "support")
    .map((g) => g.home);
  for (const h of aside) {
    const moved = unstation(ctx, city, by, h, undefined, "support");
    station(ctx, city, { owner: by, home: h, role: "hold", units: moved });
  }
  const refunded = clearQueues(ctx, city, true);
  const endsAt = ctx.now + ctx.config.time.siegeDuration;
  const seq = ctx.schedule(SIEGE_END, endsAt, city);
  ctx.ext().sieges[city] = { by, startedAt: ctx.now, endsAt, seq };
  const owner = cityOf(ctx.state, city).owner;
  const allies = alliesOf(ctx.read(), owner).map((p) => [p, "ally"] as const);
  ctx.emit({
    type: SIEGE_STARTED,
    public: true,
    to: audience([[by, "self"], [owner, "target"], ...allies]),
    data: { city, owner, by, endsAt },
  });
  if (owner !== null && (anyRes(refunded.refund) || anyRes(refunded.lost))) {
    ctx.emit({
      type: QUEUES_REFUNDED,
      public: false,
      to: [{ p: owner, as: "target" }],
      data: { city, refund: { ...refunded.refund }, lost: { ...refunded.lost } },
    });
  }
  for (const m of returnsInto(ctx.state, city)) announceHomecoming(ctx, m);
}

/**
 * Ends the siege of `city` without a conquest (§9.3): the record and its `siege_end` event are
 * removed, the public `siege_broken` goes to the besieger and the owner, and the surviving garrison
 * units start their return trips home (each announced if its home is besieged in turn).
 */
export function breakSiege(ctx: PCtx, city: CityId, cause: SiegeBreakCause): void {
  const x = ctx.ext();
  const siege = own(x.sieges, city) ?? fail(`${city} is not besieged`);
  const by = siege.by;
  cancelIfQueued(ctx, siege.seq);
  delete x.sieges[city];
  forgetHomecomings(ctx, city, by);
  const owner = cityOf(ctx.state, city).owner;
  ctx.emit({
    type: SIEGE_BROKEN,
    public: true,
    to: audience([
      [by, "self"],
      [owner, "target"],
    ]),
    data: { city, owner, by, cause },
  });
  for (const home of holdGroups(ctx.state, city, by).map((g) => g.home)) {
    const units = unstation(ctx, city, by, home, undefined, "hold");
    announceHomecoming(ctx, startReturn(ctx, { owner: by, home, from: city, units }));
  }
}

/**
 * How a version computes a player's public score parts now (§13.1), for the score frozen at an
 * elimination; method-style, so a version's own context type fits.
 */
export type ScorePartsOf = { of(r: PRead, p: PlayerId): ScoreParts }["of"];

/** The siege hooks that freeze a score: the same code for every version, with its own score. */
export interface SiegeHooks {
  /**
   * Eliminates `p` (§9.7): its score freezes at `score` (by default its parts now; a conquest
   * passes the parts it had with its last city), then `std.eliminate` removes its units, movements
   * and proposals and ends its alliance and pacts. The sieges `p` held lose their garrison with its
   * units; `afterStep`'s garrison sweep breaks them (cause `eliminated`) at the end of this step,
   * the one mechanism for every garrison left without a settler.
   */
  readonly eliminatePlayer: (ctx: PCtx, p: PlayerId, score?: ScoreParts) => void;
  /**
   * `on.siege_end` (class 9, after every attack of that second): the siege ends in a conquest while
   * its garrison holds a settler. A garrison without one (never left by `afterStep`) only breaks it.
   */
  readonly onSiegeEnd: (ctx: PCtx, ev: ScheduledEvent) => void;
}

/** The siege hooks of a version whose public score parts are `scoreParts`. */
export function siegeHooksWith(scoreParts: ScorePartsOf): SiegeHooks {
  function eliminatePlayer(
    ctx: PCtx,
    p: PlayerId,
    score: ScoreParts = scoreParts(ctx.read(), p),
  ): void {
    ctx.ext().frozenScores[p] = { cityPoints: score.cityPoints, battleScore: score.battleScore };
    eliminate(ctx, p);
  }

  /**
   * Conquest at the end of a siege (§9.4): one settler of the garrison is consumed, the rest of the
   * garrison is re-homed to the city as the new owner's units at home, the city changes hands with
   * its buildings and stock, the public `city_conquered` goes out, and the former owner falls back
   * on its lowest-numbered city (everything homed in the conquered city is re-homed there and returns
   * heading to it sail on, §7.7) or is eliminated when it has none left, with the score it had
   * before this city fell (§9.7). Returns that sail on into a besieged fallback are announced to its
   * besieger by `afterStep`'s sweep at the end of this step, as every return other code re-homes.
   */
  function conquer(ctx: PCtx, city: CityId, by: PlayerId): void {
    const settler = ctx.rules.roles.settler;
    const first =
      holdGroups(ctx.state, city, by).find((g) => (g.units[settler] ?? 0) > 0) ??
      fail(`the garrison of ${city} has no settler to consume`);
    removeUnits(
      ctx,
      { at: "stationed", city, owner: by, home: first.home, role: "hold" },
      { [settler]: 1 },
      "consumed",
    );
    const garrison: UnitCounts = {};
    for (const home of holdGroups(ctx.state, city, by).map((g) => g.home)) {
      const units = unstation(ctx, city, by, home, undefined, "hold");
      for (const [unit, n] of Object.entries(units))
        garrison[unit] = (garrison[unit] ?? 0) + (n ?? 0);
    }
    const former = cityOf(ctx.state, city).owner;
    const lastScore = former === null ? undefined : scoreParts(ctx.read(), former);
    forgetHomecomings(ctx, city, by);
    transferCity(ctx, city, by);
    if (hasUnits(garrison)) putHome(ctx, city, cleanUnits(ctx.rules, garrison));
    ctx.emit({
      type: "city_conquered",
      public: true,
      to: audience([
        [by, "self"],
        [former, "target"],
      ]),
      data: { city, from: former, to: by },
    });
    if (former === null) return;
    const fallback = fallbackCity(ctx.read(), former);
    if (fallback === null) {
      eliminatePlayer(ctx, former, lastScore);
      return;
    }
    rehomeAll(ctx, city, fallback);
  }

  function onSiegeEnd(ctx: PCtx, ev: ScheduledEvent): void {
    const city = CityIdSchema.parse(ev.ref);
    const x = ctx.ext();
    const siege = own(x.sieges, city);
    if (siege === undefined || siege.seq !== ev.seq) {
      fail(`siege_end (seq ${ev.seq}) of ${city} has no matching siege`);
    }
    if (garrisonSettlers(ctx.state, ctx.rules.roles.settler, city, siege.by) === 0) {
      breakSiege(ctx, city, "abandoned");
      return;
    }
    delete x.sieges[city];
    conquer(ctx, city, siege.by);
  }

  return Object.freeze({ eliminatePlayer, onSiegeEnd });
}

/** The public score parts of `p` now under perfidia-1@1.0.0 (§13.1). */
function scoreParts100(r: PRead100, p: PlayerId): ScoreParts {
  const row =
    scoreRows(r.config, r.state, r.ext()).find((x) => x.player === p) ??
    fail(`player ${p} does not exist`);
  return { cityPoints: row.cityPoints, battleScore: row.battleScore };
}

const hooks100 = siegeHooksWith(scoreParts100);

/** `SiegeHooks.eliminatePlayer` of perfidia-1@1.0.0. */
export const eliminatePlayer = hooks100.eliminatePlayer;

/** `on.siege_end` of perfidia-1@1.0.0. */
export const onSiegeEnd = hooks100.onSiegeEnd;
