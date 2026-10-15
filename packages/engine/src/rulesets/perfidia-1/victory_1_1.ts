import type { Ctx, ReadCtx, StepInfo } from "@perfidia/engine/contracts";
import { sortedIds } from "@perfidia/engine/std";
import {
  CityIdSchema,
  compareIds,
  type MatchResult,
  type PlayerId,
  type ScheduledEvent,
  type Standing,
} from "@perfidia/protocol";
import { cityOf, fail, own, sameMembers } from "./common.ts";
import type { Perfidia11Config } from "./config_1_1.ts";
import { type Bloc, bestTiebreak, blocsOf, orderEndingCountdowns } from "./domination.ts";
import {
  blocHold,
  type DominationNeed,
  dominationNeed11,
  type Hold,
  holdByOwner,
  holds,
  totalSlots,
} from "./domination_1_1.ts";
import { DOMINATION_STARTED } from "./events.ts";
import { type Perfidia11Ext, recordConquest } from "./ext_1_1.ts";
import { standingsOf, timeWinner } from "./score.ts";
import { computeStandings11, scoreParts11, scoreRows11 } from "./scoring_1_1.ts";
import { siegeHooksWith } from "./siege.ts";
import {
  DOMINATION_END,
  announceNewReturns,
  cancelCountdown,
  checkGarrisons,
  trackRelations,
} from "./victory.ts";

// Victory of perfidia-1@1.1.0 (docs/rulesets/perfidia-1.md §13.3): 1.0.0's bookkeeping after every
// step, last standing and time victory, with domination by conquest. A bloc qualifies with
// `need.cities` cities, a threshold fixed for the map, of which `need.taken` are taken: a city is
// taken when its owner got it by conquest and never owned it before. Conquests are recorded by the
// `siege_end` hook, before `afterStep` evaluates the countdowns of the same step.

export type PCtx11 = Ctx<Perfidia11Config, Perfidia11Ext>;
export type PRead11 = ReadCtx<Perfidia11Config, Perfidia11Ext>;

const siege11 = siegeHooksWith(scoreParts11);

/** `SiegeHooks.eliminatePlayer` of 1.1.0: the frozen score counts 1.1.0's city points. */
export const eliminatePlayer11 = siege11.eliminatePlayer;

/**
 * `on.siege_end` of 1.1.0 (class 9): 1.0.0's conquest or break, then the conquest record of a city
 * that changed hands. An eliminated former owner's score was frozen before the city fell, with the
 * record as it stood.
 */
export function onSiegeEnd11(ctx: PCtx11, ev: ScheduledEvent): void {
  const city = CityIdSchema.parse(ev.ref);
  const from = cityOf(ctx.state, city).owner;
  siege11.onSiegeEnd(ctx, ev);
  const to = cityOf(ctx.state, city).owner;
  if (to !== null && to !== from) recordConquest(ctx.ext(), city, from, to);
}

/** The threshold of the match (§13.3): fixed by the map and N. */
export function need11(r: PRead11): DominationNeed {
  return dominationNeed11(r.config.victory, r.rules.players, totalSlots(r.state));
}

/**
 * Cancels the countdowns whose bloc changed membership (or no longer exists) or no longer
 * qualifies (too few cities or too few taken cities), in bloc-key order.
 */
function cancelCountdowns11(
  ctx: PCtx11,
  blocs: readonly Bloc[],
  byOwner: ReadonlyMap<PlayerId, Hold>,
  need: DominationNeed,
): void {
  // `cancelCountdown` replaces the array, so this loop walks the countdowns as they were.
  for (const cd of ctx.ext().domination.countdowns) {
    const bloc = blocs.find((b) => b.key === cd.bloc);
    if (bloc === undefined || !sameMembers(bloc.members, cd.members)) {
      cancelCountdown(ctx, cd.bloc, "membership");
    } else if (!holds(need, blocHold(byOwner, bloc.members))) {
      cancelCountdown(ctx, cd.bloc, "condition");
    }
  }
}

/** Starts a countdown for every qualifying bloc without one, in bloc order. */
function startCountdowns11(
  ctx: PCtx11,
  blocs: readonly Bloc[],
  byOwner: ReadonlyMap<PlayerId, Hold>,
  need: DominationNeed,
): void {
  const d = ctx.ext().domination;
  for (const bloc of blocs) {
    if (d.countdowns.some((c) => c.bloc === bloc.key)) continue;
    const have = blocHold(byOwner, bloc.members);
    if (!holds(need, have)) continue;
    const endsAt = ctx.now + ctx.config.time.dominationHold;
    const seq = ctx.schedule(DOMINATION_END, endsAt, bloc.key);
    const members = [...bloc.members];
    d.countdowns = [
      ...d.countdowns,
      { bloc: bloc.key, members, startedAt: ctx.now, endsAt, seq },
    ].toSorted((a, b) => compareIds(a.bloc, b.bloc));
    ctx.emit({
      type: DOMINATION_STARTED,
      public: true,
      to: [],
      data: {
        key: bloc.key,
        members: [...members],
        cities: have.cities,
        taken: have.taken,
        threshold: need.cities,
        needTaken: need.taken,
        endsAt,
      },
    });
  }
}

/** The result of a match won now by `winners` (one player, or a bloc's members). */
function resultOf11(ctx: PCtx11, reason: string, winners: readonly PlayerId[]): MatchResult {
  const sorted = winners.toSorted(compareIds);
  return {
    endedAt: ctx.now,
    reason,
    winners: sorted,
    standings: computeStandings11(ctx.config, ctx.state, ctx.ext(), sorted),
  };
}

/**
 * `hooks.afterStep` of 1.1.0, in 1.0.0's order: siege abandonment, homecoming warnings, relation
 * history, then (from the `domination_open` timer on) the cancellation of countdowns whose bloc
 * changed or no longer qualifies, the last-standing win, and new countdowns for qualifying blocs.
 */
export function afterStep11(ctx: PCtx11, step: StepInfo): void {
  checkGarrisons(ctx);
  announceNewReturns(ctx, step);
  trackRelations(ctx);
  const open = ctx.ext().domination.open;
  const blocs = blocsOf(ctx.state);
  const byOwner = open ? holdByOwner(ctx.state, ctx.ext()) : new Map<PlayerId, Hold>();
  const need = need11(ctx.read());
  if (open) cancelCountdowns11(ctx, blocs, byOwner, need);
  const alive = sortedIds(ctx.state.players).filter((p) => own(ctx.state.players, p)?.alive);
  if (alive.length === 1) {
    ctx.endMatch(resultOf11(ctx, "last_standing", alive));
    return;
  }
  if (open) startCountdowns11(ctx, blocs, byOwner, need);
}

/**
 * `on.domination_end` of 1.1.0 (class 11): the countdowns ending this second are resolved together
 * in 1.0.0's order (more cities, higher total score, best tie-break position); the first whose
 * bloc still qualifies with the same members wins.
 */
export function onDominationEnd11(ctx: PCtx11, ev: ScheduledEvent): void {
  const x = ctx.ext();
  const d = x.domination;
  const mine = d.countdowns.find((c) => c.bloc === ev.ref && c.seq === ev.seq);
  if (mine === undefined) fail(`domination_end (seq ${ev.seq}) of ${ev.ref} has no countdown`);
  const blocs = blocsOf(ctx.state);
  const need = need11(ctx.read());
  const byOwner = holdByOwner(ctx.state, x);
  const rows = scoreRows11(ctx.config, ctx.state, x);
  const holding = d.countdowns
    .filter((c) => c.endsAt === ctx.now)
    .flatMap((c) => {
      const bloc = blocs.find((b) => b.key === c.bloc);
      if (bloc === undefined || !sameMembers(bloc.members, c.members)) return [];
      const have = blocHold(byOwner, bloc.members);
      if (!holds(need, have)) return [];
      let score = 0;
      for (const row of rows) if (bloc.members.includes(row.player)) score += row.score;
      return [
        {
          bloc: bloc.key,
          members: bloc.members,
          cities: have.cities,
          score,
          bestTiebreak: bestTiebreak(x.tiebreak, bloc.members),
        },
      ];
    });
  d.countdowns = d.countdowns.filter((c) => c !== mine);
  const [first] = orderEndingCountdowns(holding);
  const winner = holding.find((h) => h.bloc === first);
  if (winner !== undefined) {
    ctx.endMatch(resultOf11(ctx, "domination", winner.members));
    return;
  }
  // `afterStep` cancels every countdown whose bloc changed or stopped qualifying, at every step,
  // so each countdown ending now still qualifies and one of them has won.
  fail(`domination_end (seq ${ev.seq}) of ${ev.ref}: no ending countdown qualifies`);
}

/**
 * `hooks.standings` of 1.1.0: public score parts only; while the match runs, ties are ordered by
 * public data only (cities, then the tie-break order), as in 1.0.0.
 */
export function standings11(r: PRead11): Standing[] {
  const result = r.state.result;
  if (result !== null) return computeStandings11(r.config, r.state, r.ext(), result.winners);
  const rows = scoreRows11(r.config, r.state, r.ext()).map((row) =>
    Object.assign(row, { battlePoints: 0 }),
  );
  return standingsOf(rows, [], r.ext().tiebreak);
}

/** `hooks.finish` of 1.1.0 at `matchEnd`: the highest score wins (§13.3). */
export function finish11(ctx: PCtx11): MatchResult {
  const x = ctx.ext();
  const winner = timeWinner(scoreRows11(ctx.config, ctx.state, x), x.tiebreak);
  return resultOf11(ctx, "time", winner === null ? [] : [winner]);
}

/**
 * What is wrong with the running countdowns of a state (empty when nothing): each needs its bloc to
 * qualify now. Not an invariant: a state can be built (P10 staging) with a countdown that does not
 * qualify, and `afterStep` cancels it at the next step. Tests and batch checks call it after steps.
 */
export function countdownsQualifyProblems(r: PRead11): string[] {
  const x = r.ext();
  if (!x.domination.open || r.state.status !== "running") return [];
  const need = need11(r);
  const byOwner = holdByOwner(r.state, x);
  const out: string[] = [];
  for (const c of x.domination.countdowns) {
    const have = blocHold(byOwner, c.members);
    if (!holds(need, have)) {
      out.push(
        `countdown of ${c.bloc}: ${have.cities} cities (${have.taken} taken), the threshold is ${need.cities} (${need.taken} taken)`,
      );
    }
  }
  return out;
}
