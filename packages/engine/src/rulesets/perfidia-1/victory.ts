import type { StepInfo } from "@perfidia/engine/contracts";
import {
  compareIds,
  type MatchResult,
  type MovementId,
  type PlayerId,
  type ScheduledEvent,
  type Standing,
} from "@perfidia/protocol";
import { relationsOf, sortedIds } from "@perfidia/engine/std";
import { cancelIfQueued, fail, own, sameMembers, type PCtx, type PRead } from "./common.ts";
import {
  type Bloc,
  bestTiebreak,
  blocCities,
  blocsOf,
  dominationThreshold,
  orderEndingCountdowns,
  totalCities,
} from "./domination.ts";
import { DOMINATION_CANCELLED, DOMINATION_STARTED, type CountdownCancelReason } from "./events.ts";
import { type BlocKey, type PairKey, pairKey } from "./ext.ts";
import { computeStandings, scoreRows, standingsOf, timeWinner } from "./scoring.ts";
import { announceHomecoming, breakSiege, garrisonSettlers } from "./siege.ts";

// Victory and the bookkeeping that runs after every step (perfidia-1 §8.8, §9.3, §13): relation
// history for the kill-credit cooldown, siege abandonment, homecoming warnings for returns created
// by other code, last standing, and the domination countdowns. Time-gated conditions follow the
// world timer `domination_open` (docs/architecture.md §3.1): `afterStep` never compares `now` with
// a threshold.

/** The scheduled event that ends a domination countdown (class 11), ref = the bloc key. */
export const DOMINATION_END = "domination_end";

/** Pairs of players related now (allies or pact partners), through `relationsOf`, sorted. */
export function relatedPairs(r: PRead): PairKey[] {
  const keys = new Set<PairKey>();
  for (const p of sortedIds(r.state.players)) {
    for (const rel of relationsOf(r, p)) if (rel.player !== p) keys.add(pairKey(p, rel.player));
  }
  return [...keys].toSorted(comparePairs);
}

function comparePairs(a: PairKey, b: PairKey): number {
  const [a1 = "", a2 = ""] = a.split("|");
  const [b1 = "", b2 = ""] = b.split("|");
  return compareIds(a1, b1) || compareIds(a2, b2);
}

/** Records when each pair stopped being related (§8.8), and the pairs related now. */
function trackRelations(ctx: PCtx): void {
  const x = ctx.ext();
  const now = relatedPairs(ctx.read());
  for (const key of x.related) if (!now.includes(key)) x.relationEnds[key] = ctx.now;
  if (!sameMembers(x.related, now)) x.related = now;
}

/**
 * Breaks every siege whose garrison has no settler left (§9.3): recalled ("abandoned"), or gone
 * with its eliminated besieger ("eliminated", §9.7). The one path for both.
 */
function checkGarrisons(ctx: PCtx): void {
  const x = ctx.ext();
  const settler = ctx.rules.roles.settler;
  for (const city of sortedIds(x.sieges)) {
    const siege = own(x.sieges, city);
    if (siege === undefined) continue;
    if (garrisonSettlers(ctx.state, settler, city, siege.by) > 0) continue;
    const alive = own(ctx.state.players, siege.by)?.alive ?? false;
    breakSiege(ctx, city, alive ? "abandoned" : "eliminated");
  }
}

/**
 * Tells besiegers about the returns created or re-homed during this step that no code announced
 * yet: a recall, a stationed recall or a dismissal through the domain handlers, and the returns a
 * conquest re-homes onto a besieged fallback (§7.7). Every return heading into a city besieged by
 * another player that does not record that besieger as its party yet, plus the movements recalled
 * in this step (a turned-back attack keeps its launch party).
 */
function announceNewReturns(ctx: PCtx, step: StepInfo): void {
  const recalled = new Set<string>();
  for (const e of step.events) {
    const m = e.data["movement"];
    if (e.type === "movement_recalled" && typeof m === "string") recalled.add(m);
  }
  const sieges = ctx.ext().sieges;
  const pending: { id: MovementId; seq: number }[] = [];
  for (const mv of Object.values(ctx.state.movements)) {
    if (mv.kind !== "return") continue;
    const siege = own(sieges, mv.home);
    if (siege === undefined || siege.by === mv.owner) continue;
    if (mv.party !== siege.by || recalled.has(mv.id)) pending.push({ id: mv.id, seq: mv.seq });
  }
  for (const p of pending.toSorted((a, b) => a.seq - b.seq)) announceHomecoming(ctx, p.id);
}

function cancelCountdown(ctx: PCtx, key: BlocKey, reason: CountdownCancelReason): void {
  const d = ctx.ext().domination;
  const cd = d.countdowns.find((c) => c.bloc === key) ?? fail(`no countdown for ${key}`);
  cancelIfQueued(ctx, cd.seq);
  d.countdowns = d.countdowns.filter((c) => c.bloc !== key);
  ctx.emit({
    type: DOMINATION_CANCELLED,
    public: true,
    to: [],
    data: { key, members: [...cd.members], reason },
  });
}

/** The threshold of the current state (§13.3). */
function threshold(r: PRead): number {
  return dominationThreshold(r.config, r.rules.players, totalCities(r.state));
}

/**
 * Cancels the countdowns whose bloc changed membership (or no longer exists) or no longer
 * qualifies, in bloc-key order (§13.3).
 */
function cancelCountdowns(ctx: PCtx, blocs: readonly Bloc[]): void {
  const need = threshold(ctx.read());
  // `cancelCountdown` replaces the array, so this loop walks the countdowns as they were.
  for (const cd of ctx.ext().domination.countdowns) {
    const bloc = blocs.find((b) => b.key === cd.bloc);
    if (bloc === undefined || !sameMembers(bloc.members, cd.members)) {
      cancelCountdown(ctx, cd.bloc, "membership");
    } else if (blocCities(ctx.state, bloc.members) < need) {
      cancelCountdown(ctx, cd.bloc, "condition");
    }
  }
}

/** Starts a countdown for every qualifying bloc without one, in bloc order (§13.3). */
function startCountdowns(ctx: PCtx, blocs: readonly Bloc[]): void {
  const d = ctx.ext().domination;
  const need = threshold(ctx.read());
  for (const bloc of blocs) {
    if (d.countdowns.some((c) => c.bloc === bloc.key)) continue;
    const cities = blocCities(ctx.state, bloc.members);
    if (cities < need) continue;
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
      data: { key: bloc.key, members: [...members], cities, threshold: need, endsAt },
    });
  }
}

/** The result of a match won now by `winners` (one player, or a bloc's members). */
function resultOf(ctx: PCtx, reason: string, winners: readonly PlayerId[]): MatchResult {
  const sorted = winners.toSorted(compareIds);
  return {
    endedAt: ctx.now,
    reason,
    winners: sorted,
    standings: computeStandings(ctx.config, ctx.state, ctx.ext(), sorted),
  };
}

/**
 * `hooks.afterStep`, after every event and every accepted action: siege abandonment, homecoming
 * warnings, relation history, then (from the `domination_open` timer on) the cancellation of
 * countdowns whose bloc changed or no longer qualifies, the last-standing win when exactly one
 * player is left, and new countdowns for qualifying blocs, in bloc order.
 */
export function afterStep(ctx: PCtx, step: StepInfo): void {
  checkGarrisons(ctx);
  announceNewReturns(ctx, step);
  trackRelations(ctx);
  const open = ctx.ext().domination.open;
  const blocs = blocsOf(ctx.state);
  if (open) cancelCountdowns(ctx, blocs);
  const alive = sortedIds(ctx.state.players).filter((p) => own(ctx.state.players, p)?.alive);
  if (alive.length === 1) {
    ctx.endMatch(resultOf(ctx, "last_standing", alive));
    return;
  }
  if (open) startCountdowns(ctx, blocs);
}

/** `on.domination_open` (the world timer at `dominationStart`): domination is evaluated from now on. */
export function onDominationOpen(ctx: PCtx, _ev: ScheduledEvent): void {
  ctx.ext().domination.open = true;
}

/**
 * `on.domination_end` (class 11): the countdowns ending this second are resolved together, in the
 * order more cities, higher total score, best tie-break position (§13.3). The first whose bloc still
 * qualifies with the same members wins and ends the match; the countdown of this event is removed.
 * One always does: a countdown that stopped qualifying was cancelled by the step that changed it.
 */
export function onDominationEnd(ctx: PCtx, ev: ScheduledEvent): void {
  const x = ctx.ext();
  const d = x.domination;
  const mine = d.countdowns.find((c) => c.bloc === ev.ref && c.seq === ev.seq);
  if (mine === undefined) fail(`domination_end (seq ${ev.seq}) of ${ev.ref} has no countdown`);
  const blocs = blocsOf(ctx.state);
  const need = threshold(ctx.read());
  const rows = scoreRows(ctx.config, ctx.state, x);
  const holding = d.countdowns
    .filter((c) => c.endsAt === ctx.now)
    .flatMap((c) => {
      const bloc = blocs.find((b) => b.key === c.bloc);
      if (bloc === undefined || !sameMembers(bloc.members, c.members)) return [];
      const cities = blocCities(ctx.state, bloc.members);
      if (cities < need) return [];
      let score = 0;
      for (const row of rows) if (bloc.members.includes(row.player)) score += row.score;
      return [
        {
          bloc: bloc.key,
          members: bloc.members,
          cities,
          score,
          bestTiebreak: bestTiebreak(x.tiebreak, bloc.members),
        },
      ];
    });
  d.countdowns = d.countdowns.filter((c) => c !== mine);
  const [first] = orderEndingCountdowns(holding);
  const winner = holding.find((h) => h.bloc === first);
  if (winner !== undefined) {
    ctx.endMatch(resultOf(ctx, "domination", winner.members));
    return;
  }
  // `afterStep` cancels every countdown whose bloc changed or stopped qualifying, at every step,
  // so each countdown ending now still qualifies and one of them has won.
  fail(`domination_end (seq ${ev.seq}) of ${ev.ref}: no ending countdown qualifies`);
}

/**
 * `hooks.standings`: public score parts only (§13.2). While the match runs, players with the same
 * score are ordered by public data only (cities, then the public tie-break order): raw battle
 * points, the third key of the final ranking (§13.4), would otherwise show through the order of
 * tied players (§12). Once the match is over, the final ranking, the winners first.
 */
export function standings(r: PRead): Standing[] {
  const result = r.state.result;
  if (result !== null) return computeStandings(r.config, r.state, r.ext(), result.winners);
  const rows = scoreRows(r.config, r.state, r.ext()).map((row) =>
    Object.assign(row, { battlePoints: 0 }),
  );
  return standingsOf(rows, [], r.ext().tiebreak);
}

/**
 * `hooks.finish` at `matchEnd`, after every other event of that second: the highest score wins, an
 * individual victory even for allies (§13.3).
 */
export function finish(ctx: PCtx): MatchResult {
  const x = ctx.ext();
  const winner = timeWinner(scoreRows(ctx.config, ctx.state, x), x.tiebreak);
  return resultOf(ctx, "time", winner === null ? [] : [winner]);
}
