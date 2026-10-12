// `conqueror@2` (docs/architecture.md §11.2): plays for conquests, as a proxy for a competent warlike
// player. It keeps conqueror@1's battle model (`conqueror.ts`: defense estimates from spy reports
// and the config's combat numbers, waves landing in one second, trains timed from the travel times,
// sieges held and reinforced, founders recruited just in time) and changes the strategy around it:
//
// - Victim by expected value: for every player it can reach and is not allied with, a city's value
//   over its estimated cost (the defense to break after morale, an overhead per strike and the
//   travel; without intel, a prior that grows by the day), weighted up for a bloc running a
//   domination countdown it is not in (stop the leader), for the leader once clearly ahead, for a
//   player that attacked the seat, for the player an ally names, for a city it lost (retake) and for
//   a player with few cities left once all can fall; down for a pact partner and for a city the
//   army cannot break yet. A player's best city counts. The victim is kept unless another is
//   clearly better (more so once a wave left for it), and the next follows as soon as it falls or
//   costs too much: campaigns chain.
// - Targets: the victim's capital first once the army could strike it, then its cities cheapest
//   first. Colonies can be taken from the end of protection, capitals once their immunity ends.
// - Founders go to a free slot or a conquest, whichever is worth more (a conquest counts twice: a
//   city gained, one taken from a rival), so it keeps founding while slots are in reach; those a
//   strike wants or holds stay home, and a campaign that can finish its victim keeps them all.
// - Trains: a spy leaves with the helpers (paid to see through twice the garrison last seen). At the
//   timed launch, a fresher report that shows more than `abortPm` of the defense planned on, or with
//   which the waves no longer win, or the failure of that spy, calls the founders' waves off.
// - Scouting: one spy per turn on the best city of another player whose intel is stale, so that the
//   next campaign starts from fresh intel.
// - Own wakes: scouting spies and idle queues wait while the own wakes left would not see the day
//   out; a spy whose report may lead to a strike needs only one to spare.
// - Army: the attackers' unlock first, units before buildings in the capital, carriers wherever an
//   army or founders would otherwise be stuck on their island.
// - Diplomacy: from day 2, once a day while it has no alliance, it proposes a war alliance to the
//   strongest of its nearest neighbours that is not its victim (a pact when that neighbour has an
//   alliance already); it accepts pacts and one alliance from anyone but its victim and a rival
//   bloc; it tells its allies its victim ("war on pX") and weighs the player they name; it supports
//   an ally's city under attack when its defenders land first.
//
// Memory (notes, §11.1): conqueror@1's flags (see `conqueror.ts`), plus `ae`/`ap` (the defense a
// train was planned on, and when), `hw` (since when founders are held for a strike), `lo<city>` (a
// city lost, and when), `sc<city>` (a scouting spy), `dp` (the day after its last proposal), `mv`
// (the victim told to its allies) and `jv`/`jt` (the player an ally named, and when). Handled ids
// `a<movement>`: an attack on an ally's city answered.

import {
  compareIds,
  type CityId,
  type CityRow,
  type IslandId,
  type PlayerId,
  type ToolCall,
} from "@perfidia/protocol";
import {
  addRes,
  call,
  countOf,
  DAY,
  fmtTime,
  landPop,
  meets,
  pmRes,
  scaleRes,
  timesAffordable,
  unitsInReport,
  ZERO,
} from "../kit.ts";
import { economyWishes, ownWakesBefore, unlockWishes, type Knobs, type Planner } from "../plan.ts";
import { fnv1a32, randInt, type BotRng } from "../rng.ts";
import type { OwnCity, World } from "../world.ts";
import {
  allAttackers,
  armyBreaks,
  assault,
  besiegedRow,
  citiesByOwner,
  conquestFounders,
  defenseValue,
  forgeCity,
  founderCity,
  holdCities,
  holdSieges,
  launch,
  moraleAgainst,
  NO_DEFENSE,
  noteDefense,
  opensAt,
  reachOf,
  rememberAttackers,
  seatNumber,
  spyOn,
  storeAhead,
  strike,
  targetDefense,
  tidy,
  trainWaits,
  transports,
  type ConquerorParams,
  type Defense,
  type Target,
} from "./conqueror.ts";
import type { StrategyDef } from "./strategy.ts";

export interface Conqueror2Params extends ConquerorParams {
  /** Weight (‰) of the leader, when it is ahead of the seat. */
  readonly leaderPm: number;
  /** Weight (‰) of the members of a bloc running a domination countdown the seat is not in. */
  readonly countdownPm: number;
  /** Weight (‰) of the current victim once a conquest wave left for it. */
  readonly keepPm: number;
  /** Cities of other players read (and weighed) per turn. */
  readonly scout: number;
  /** A train's founders' waves stay home when fresher intel shows more than abortPm ‰ of the defense planned on. */
  readonly abortPm: number;
}

export function conqueror2Params(rng: BotRng): Conqueror2Params {
  return {
    marginPm: randInt(rng, 1400, 1600),
    sizePm: randInt(rng, 2200, 2800),
    minAttackers: randInt(rng, 12, 18),
    spyMult: randInt(rng, 2, 4),
    stale: randInt(rng, 21600, 36000),
    growthPm: randInt(rng, 40, 60),
    founders: 2,
    scan: 6,
    salt: randInt(rng, 0, 1048575),
    leaderPm: randInt(rng, 1300, 1700),
    countdownPm: randInt(rng, 2500, 3500),
    keepPm: randInt(rng, 2000, 2500),
    scout: 6,
    abortPm: 2000,
  };
}

/** The value of a city in the expected-value ratio (its cost is in defense points). */
const VALUE = 1_000_000;
/** Defense points added to every strike's cost: its founders and what the waves lose. */
const OVERHEAD = 400;
/** Defense points added to a strike's cost per hour of travel. */
const TRAVEL_COST = 300;
/** Weight (‰) of the current victim before any wave left for it: it yields only to a better one. */
const SWITCH_PM = 1500;
/** Weight (‰) of a pact partner (a betrayal costs its reputation). */
const PACT_PM = 500;
/** Weight (‰) of a player that attacked the seat within a day. */
const ATTACKER_PM = 1500;
/** Weight (‰) of the victim an ally named (or the player attacking that ally) within a day. */
const NAMED_PM = 2000;
/** Weight (‰) of a player with 1, 2 or 3 cities left, once all can fall: its elimination is near. */
const FEW_CITIES_PM: readonly number[] = Object.freeze([2500, 1800, 1400]);
/** The leader weighs more only once its score is this much (‰) of the seat's, from day 2. */
const LEAD_PM = 1100;
/** Weight (‰) of a victim given up as out of reach within a day. */
const OUT_PM = 500;
/** Weight (‰) of a city the whole army cannot break yet (on the latest intel). */
const UNBREAKABLE_PM = 250;
/** Weight (‰) of a city the seat lost within `RETAKE_FOR`: retaking it comes first. */
const RETAKE_PM = 2000;
const RETAKE_FOR = 2 * DAY;
/** A capital still immune counts as a target from this long before it opens. */
const SOON = 6 * 3600;
/** Defense assumed for a city without intel: base + perDay × days elapsed. */
const CAPITAL_PRIOR = Object.freeze({ base: 300, perDay: 600 });
const COLONY_PRIOR = Object.freeze({ base: 150, perDay: 250 });
/** A scouted city is not spied again within this, and intel younger than it needs no scouting. */
const SCOUT_STALE = 12 * 3600;
/** A planned train is dropped this long after its landing time (as conqueror@1). */
const TRAIN_EXPIRY = 6 * 3600;
/** Fewest defenders sent to support an ally's city. */
const MIN_SUPPORT = 5;
/**
 * Own wakes kept for the rest of the game day: one per this many seconds, beyond what will wake the
 * seat anyway. A spy costs one (its report wakes the seat), so spies wait when they would leave the
 * evening without wakes.
 */
const WAKE_SPACING = 4 * 3600;
/** Packs of the unit mix in a batch long enough to start an idle queue while own wakes are short. */
const LONG_PACKS = 8;
/** A strike is worth founders once every attacker could break the city by this margin (‰). */
const STRIKE_PM = 1800;
/** Founders held for a strike that does not leave are released to found cities after this. */
const HOLD_MAX = 4 * 3600;
/** Value (‰) of a conquest against a founding: the city's points, and as much taken from a rival. */
const CONQUEST_PM = 2000;
/** Defense points a founding costs beside its travel (the escort, the time), against a strike's. */
const SLOT_COST = 300;
/** Nearest players (by travel to their nearest city) among which an alliance is sought. */
const NEIGHBOURS = 3;
const SEAT_ID = /^p[1-9][0-9]*$/;

const bySeat = (n: number): PlayerId => `p${n}`;

// What the seat knows of the other players this turn.

interface Standing {
  readonly rank: number;
  readonly score: number;
  readonly cities: number;
  readonly alliance: string | null;
}

interface Context {
  readonly standings: ReadonlyMap<PlayerId, Standing>;
  /** Rank 1 of the leaderboard, when read. */
  readonly leader: PlayerId | null;
  /** Members of the blocs running a domination countdown the seat is not part of. */
  readonly rivals: ReadonlySet<PlayerId>;
  readonly allies: readonly PlayerId[];
  /** The victim an ally named within a day. */
  readonly named: PlayerId | null;
}

/** The members of every running domination countdown (the briefing's `ext.countdowns`). */
function countdownBlocs(w: World): PlayerId[][] {
  const raw = w.briefing.ext["countdowns"];
  if (!Array.isArray(raw)) return [];
  const out: PlayerId[][] = [];
  for (const c of raw) {
    if (c === null || typeof c !== "object" || Array.isArray(c)) continue;
    const members = c["members"];
    if (!Array.isArray(members)) continue;
    const ids: PlayerId[] = [];
    for (const m of members) {
      if (typeof m === "string" && SEAT_ID.test(m)) ids.push(bySeat(Number(m.slice(1))));
    }
    if (ids.length > 0) out.push(ids);
  }
  return out;
}

function contextOf(p: Planner): Context {
  const { w } = p;
  const standings = new Map<PlayerId, Standing>();
  let leader: PlayerId | null = null;
  for (const s of w.board?.standings ?? []) {
    if (!s.alive) continue;
    standings.set(s.player, {
      rank: s.rank,
      score: s.score,
      cities: s.cities,
      alliance: s.alliance,
    });
    if (s.rank === 1) leader = s.player;
  }
  const rivals = new Set<PlayerId>();
  for (const bloc of countdownBlocs(w)) {
    if (bloc.includes(w.seat)) continue;
    for (const m of bloc) rivals.add(m);
  }
  const allies = [...w.relations.entries()]
    .filter(([, kind]) => kind === "ally")
    .map(([q]) => q)
    .toSorted(compareIds);
  const jv = p.flag("jv") ?? 0;
  const jt = p.flag("jt") ?? 0;
  const named = jv > 0 && w.t - jt < DAY ? bySeat(jv) : null;
  return { standings, leader, rivals, allies, named };
}

/**
 * Reads its allies' messages: "war on pX" names their victim, and a call for help ("attack on c5
 * by p2") names their attacker. Remembered for a day (`jv`, `jt`).
 */
function hearAllies(p: Planner): void {
  const { w } = p;
  for (const m of w.briefing.msgs) {
    if (w.relations.get(m.from) !== "ally") continue;
    const hit = /\bwar on (p[1-9][0-9]*)\b/i.exec(m.text) ?? /\bby (p[1-9][0-9]*)\b/i.exec(m.text);
    const who = hit?.[1];
    if (who === undefined) continue;
    const n = Number(who.slice(1));
    if (bySeat(n) === w.seat || w.relations.get(bySeat(n)) === "ally") continue;
    p.setFlag("jv", n);
    p.setFlag("jt", w.t);
  }
}

/** Remembers the cities the seat lost to a conquest (`lo<city>`: when), from the briefing's events. */
function rememberLosses(p: Planner): void {
  const { w } = p;
  for (const e of [...w.briefing.events, ...w.briefing.news]) {
    if (e.type !== "city_conquered" || e["from"] !== w.seat) continue;
    const city = e["city"];
    if (typeof city !== "string" || !/^c[1-9][0-9]*$/.test(city)) continue;
    p.setFlag(`lo${city}`, w.t);
  }
}

/** True when the seat lost `city` within `RETAKE_FOR`. */
function lostRecently(p: Planner, city: CityId): boolean {
  const at = p.flag(`lo${city}`);
  return at !== null && p.w.t - at < RETAKE_FOR;
}

// Costs and values.

/** The defense assumed for a city the seat has no usable intel on. */
function priorDefense(w: World, row: CityRow): number {
  const prior = row.capitalOf === null ? COLONY_PRIOR : CAPITAL_PRIOR;
  return prior.base + Math.floor((prior.perDay * w.t) / DAY);
}

interface Cost {
  /** Defense points: the defense after morale, the overhead and the travel. */
  readonly cost: number;
  /** Every attacker at home could break it by the conquest margin (on the latest intel). */
  readonly breaks: boolean;
}

/** What taking `row` (owned by a player with `foes` cities) costs, from the intel read this turn. */
function cityCost(
  p: Planner,
  prm: Conqueror2Params,
  row: CityRow,
  travel: number,
  foes: number,
): Cost {
  const { w } = p;
  const d = targetDefense(p, prm, row, travel);
  const value = d === null ? priorDefense(w, row) : defenseValue(d);
  const m = Math.max(1, moraleAgainst(w, foes));
  const eff = Math.ceil((value * 1000) / m);
  let army = 0;
  for (const c of w.cities) army += allAttackers(p, c, row.island)?.strength ?? 0;
  return {
    cost: eff + OVERHEAD + Math.floor((travel * TRAVEL_COST) / 3600),
    breaks: army * 1000 >= eff * prm.marginPm,
  };
}

/** The cost of `row` before anything is read (reads are chosen from it): the prior and the travel. */
function priorCost(w: World, row: CityRow, travel: number): number {
  return priorDefense(w, row) + OVERHEAD + Math.floor((travel * TRAVEL_COST) / 3600);
}

/** A player as a victim: its best city's weighted value per cost. */
interface Option {
  readonly q: PlayerId;
  readonly ev: number;
  readonly row: CityRow;
  /** What weighed most, for the memo. */
  readonly why: string;
}

/** True when `row` may be struck by waves landing after `travel`, or soon (an immune capital). */
function takeable(w: World, row: CityRow, travel: number): boolean {
  return w.t + travel + SOON >= opensAt(w, row);
}

/** The players the seat could go for, best first (seeded tie-break). */
function options(p: Planner, prm: Conqueror2Params, ctx: Context): Option[] {
  const { w } = p;
  const cur = remembered(w);
  const committed = (p.flag("ac") ?? 0) > 0;
  const me = ctx.standings.get(w.seat);
  const held = holdCities(w);
  const out: (Option & { tie: number })[] = [];
  for (const [q, rows] of citiesByOwner(w)) {
    if (w.relations.get(q) === "ally") continue;
    const n = seatNumber(q);
    let weight = 1000;
    const why: string[] = [];
    const mul = (pm: number, tag: string | null): void => {
      weight = Math.floor((weight * pm) / 1000);
      if (tag !== null) why.push(tag);
    };
    const them = ctx.standings.get(q);
    if (ctx.rivals.has(q)) mul(prm.countdownPm, "countdown");
    else if (
      q === ctx.leader &&
      w.day >= 1 &&
      them !== undefined &&
      me !== undefined &&
      them.score * 1000 > me.score * LEAD_PM
    ) {
      mul(prm.leaderPm, "leader");
    }
    if (ctx.named === q) mul(NAMED_PM, "ally's foe");
    const hit = n === null ? undefined : w.memory.x[`ha${n}`];
    if (hit !== undefined && hit > 0 && w.t - hit < DAY) mul(ATTACKER_PM, "attacked us");
    // A few cities left weigh more once all can fall (its capital's immunity ends soon).
    const few = FEW_CITIES_PM[rows.length - 1];
    const capital = rows.find((r) => r.capitalOf === q);
    const reach = capital === undefined ? null : reachOf(w, [capital]);
    const open = capital === undefined || (reach !== null && takeable(w, capital, reach));
    if (few !== undefined && open)
      mul(few, rows.length === 1 ? "last city" : `${rows.length} cities`);
    if (w.relations.get(q) === "pact") mul(PACT_PM, null);
    const gone = n === null ? undefined : w.memory.x[`ox${n}`];
    if (gone !== undefined && gone > 0 && w.t - gone < DAY) mul(OUT_PM, null);
    if (q === cur) mul(committed ? prm.keepPm : SWITCH_PM, null);
    let best: { ev: number; row: CityRow } | null = null;
    for (const row of rows) {
      const travel = reachOf(w, [row]);
      if (travel === null || !takeable(w, row, travel)) continue;
      if (besiegedRow(w, row) || held.has(row.id)) continue;
      const c = cityCost(p, prm, row, travel, rows.length);
      let ev = Math.floor((VALUE * weight) / 1000 / Math.max(1, c.cost));
      if (lostRecently(p, row.id)) ev = Math.floor((ev * RETAKE_PM) / 1000);
      // An army away (in a siege, coming home) does not end a campaign under way.
      if (!c.breaks && !(q === cur && committed)) ev = Math.floor((ev * UNBREAKABLE_PM) / 1000);
      if (
        best === null ||
        ev > best.ev ||
        (ev === best.ev && compareIds(row.id, best.row.id) < 0)
      ) {
        best = { ev, row };
      }
    }
    if (best === null) continue;
    const reason = lostRecently(p, best.row.id) ? "retake" : (why[0] ?? "cheapest");
    out.push({ q, ev: best.ev, row: best.row, why: reason, tie: fnv1a32(`${prm.salt}:${q}`) });
  }
  return out
    .toSorted((a, b) => b.ev - a.ev || a.tie - b.tie || compareIds(a.q, b.q))
    .map(({ q, ev, row, why }) => ({ q, ev, row, why }));
}

/** The current victim from memory, or null. */
function remembered(w: World): PlayerId | null {
  const n = w.memory.x["av"] ?? 0;
  return n > 0 ? bySeat(n) : null;
}

/** Picks the victim (the best option) and records a change in the notes. */
function settleVictim(p: Planner, opts: readonly Option[]): PlayerId | null {
  const { w } = p;
  const before = remembered(w);
  const best = opts[0] ?? null;
  const v = best?.q ?? null;
  if (v === before) return v;
  if (before !== null && (p.flag("ac") ?? 0) > 0) {
    const gone = !citiesByOwner(w).has(before);
    p.memo(`${before} ${gone ? "gone" : "dropped"} ${fmtTime(w.t)}`);
    const n = seatNumber(before);
    if (!gone && n !== null) p.setFlag(`ox${n}`, w.t);
  }
  p.setFlag("av", v === null ? 0 : (seatNumber(v) ?? 0));
  p.setFlag("ac", 0);
  if (best !== null) p.memo(`victim ${best.q} ${fmtTime(w.t)} (${best.why}, ${best.row.id})`);
  return v;
}

// Targets.

/**
 * The victim's cities the seat can reach, in the order it goes for them: its capital first when the
 * army could strike it (it trains the army and the founders that take and retake its colonies, and
 * the victim falls with it), then the cities that can be taken by the time the waves land, cheapest
 * first (a city lost recently counts at half its cost); then capitals still immune.
 */
function victimTargets(p: Planner, prm: Conqueror2Params, victim: PlayerId): Target[] {
  const { w } = p;
  const rows = (w.map?.cities ?? []).filter((c) => c.owner === victim);
  const out: { tg: Target; rank: number; cost: number }[] = [];
  for (const row of rows) {
    const travel = reachOf(w, [row]);
    if (travel === null) continue;
    const tg: Target = { row, besieged: besiegedRow(w, row), travel };
    const open = w.t + travel >= opensAt(w, row);
    const c = open ? cityCost(p, prm, row, travel, rows.length) : null;
    const raw = c?.cost ?? 0;
    const cost = lostRecently(p, row.id) ? Math.floor((raw * 1000) / RETAKE_PM) : raw;
    const d = row.capitalOf === victim && c !== null ? targetDefense(p, prm, row, travel) : null;
    const head = d !== null && armyBreaks(p, { ...prm, marginPm: STRIKE_PM }, tg, d, rows.length);
    out.push({ tg, rank: head ? 0 : open ? 1 : 2, cost });
  }
  return out
    .toSorted((a, b) => a.rank - b.rank || a.cost - b.cost || compareIds(a.tg.row.id, b.tg.row.id))
    .map((x) => x.tg);
}

/** The cities `reads` asks for: the victim's (cheapest first by prior) and the train's target. */
function victimReads(w: World, prm: Conqueror2Params, victim: PlayerId | null): CityId[] {
  const out: CityId[] = [];
  const at = w.memory.x["at"] ?? 0;
  if (at > 0) out.push(`c${at}`);
  if (victim === null) return out;
  const rows: { row: CityRow; cost: number }[] = [];
  for (const row of w.map?.cities ?? []) {
    if (row.owner !== victim) continue;
    const travel = reachOf(w, [row]);
    if (travel !== null) rows.push({ row, cost: priorCost(w, row, travel) });
  }
  for (const { row } of rows
    .toSorted((a, b) => a.cost - b.cost || compareIds(a.row.id, b.row.id))
    .slice(0, prm.scan)) {
    out.push(row.id);
  }
  return out;
}

/** Other players' cities `reads` asks for: each one's two cheapest by prior, `prm.scout` at most. */
function scoutReads(w: World, prm: Conqueror2Params, victim: PlayerId | null): CityId[] {
  const picks: { row: CityRow; cost: number }[] = [];
  for (const [q, rows] of citiesByOwner(w)) {
    if (q === victim || w.relations.get(q) === "ally") continue;
    const mine: { row: CityRow; cost: number }[] = [];
    for (const row of rows) {
      const travel = reachOf(w, [row]);
      if (travel === null || !takeable(w, row, travel)) continue;
      mine.push({ row, cost: priorCost(w, row, travel) });
    }
    picks.push(
      ...mine.toSorted((a, b) => a.cost - b.cost || compareIds(a.row.id, b.row.id)).slice(0, 2),
    );
  }
  return picks
    .toSorted((a, b) => a.cost - b.cost || compareIds(a.row.id, b.row.id))
    .slice(0, prm.scout)
    .map((x) => x.row.id);
}

// Strikes and trains.

/**
 * conqueror@1's strike; when it plans a train, the defense planned on and the time are remembered
 * (`ae`, `ap`) and a spy leaves to check it before the timed launch.
 */
function strikeChecked(
  p: Planner,
  prm: Conqueror2Params,
  tg: Target,
  d: Defense,
  foes: number,
): boolean {
  const before = p.flag("at") ?? 0;
  const ok = strike(p, prm, tg, d, foes);
  const after = p.flag("at") ?? 0;
  if (ok && after > 0 && after !== before) {
    p.setFlag("ae", defenseValue(d));
    p.setFlag("ap", p.w.t);
    checkSpy(p, prm, tg);
  }
  return ok;
}

/**
 * A spy on a train's target that lands as soon as possible, paid to see through twice the land pop
 * last seen there: if it fails, the garrison has at least doubled.
 */
function checkSpy(p: Planner, prm: Conqueror2Params, tg: Target): void {
  const { w } = p;
  const kit = w.kit;
  if (p.inFlight("spy", tg.row.id) || !wakesSpare(p, 1)) return;
  const view = w.views.get(tg.row.id);
  const seen =
    view?.access === "public" && view.intel !== null
      ? landPop(kit, unitsInReport(kit, view.intel.data))
      : 0;
  const from = w.cities
    .filter((c) => !c.blocked)
    .map((c) => ({ c, travel: w.travel(c.id, tg.row.island, true) }))
    .filter((x): x is { c: OwnCity; travel: number } => x.travel !== null)
    .toSorted((a, b) => a.travel - b.travel || compareIds(a.c.id, b.c.id))
    .find((x) => p.stockOf(x.c.id).gold >= kit.rules.movement.spyMinGold)?.c;
  if (from === undefined) return;
  const gold = Math.min(
    p.stockOf(from.id).gold,
    kit.rules.movement.spyMinGold * prm.spyMult + 2 * seen,
  );
  p.spy(from, tg.row.id, gold);
  p.setFlag(`sp${tg.row.id}`, w.t);
}

/** The fastest spy travel from an own city to `island`, or null. */
function spyTravel(w: World, island: IslandId): number | null {
  let best: number | null = null;
  for (const c of w.cities) {
    const t = w.travel(c.id, island, true);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

/**
 * True when the own wakes left today cover the rest of the day at one per `WAKE_SPACING`, what will
 * wake the seat anyway (its queues that empty and its reports that land, `ownWakesBefore`, spies
 * planned this turn included) and `extra` more reports.
 */
function wakesSpare(p: Planner, extra: number): boolean {
  const { w } = p;
  const end = (w.day + 1) * DAY;
  const need = Math.ceil((end - w.t) / WAKE_SPACING);
  return ownWakesBefore(p, end) + extra + need <= w.briefing.budget.ownWakesLeft;
}

/** True when the own wakes left today cover what will wake the seat anyway and `extra` more. */
function wakesLeft(p: Planner, extra: number): boolean {
  const { w } = p;
  return ownWakesBefore(p, (w.day + 1) * DAY) + extra < w.briefing.budget.ownWakesLeft;
}

/** Drops a planned train's flags. */
function dropTrain(p: Planner): void {
  for (const f of ["at", "aw", "ae", "ap"]) p.clearFlag(f);
}

/** Recalls the seat's attacks on `city` still within their recall window. */
function recallTrain(p: Planner, city: CityId): void {
  const { w } = p;
  for (const m of w.self?.private?.movements ?? []) {
    if (m.owner !== w.seat || m.kind !== "attack" || m.to !== city) continue;
    const until = m.recallableUntil?.[0] ?? null;
    if (until !== null && until > w.t) p.recall(m.id);
  }
}

/**
 * Launches the founders' island's waves of a planned train once their time has come, as
 * conqueror@1 does, unless fresher intel says the train fails: a spy report newer than the plan
 * that shows more than `abortPm` of the defense planned on, or with which the waves no longer win,
 * or the check spy failed. Then the train is called off (helpers still in their recall window come
 * back) and the city is weighed again on the new report.
 */
function trainStep(p: Planner, prm: Conqueror2Params, victim: PlayerId | null): void {
  const { w } = p;
  const tc = p.flag("at") ?? 0;
  const ta = p.flag("aw") ?? 0;
  if (tc <= 0) return;
  const id: CityId = `c${tc}`;
  const row = w.map?.cities.find((c) => c.id === id);
  if (row === undefined || row.owner !== victim || besiegedRow(w, row) || w.t > ta + TRAIN_EXPIRY) {
    dropTrain(p);
    return;
  }
  const f = founderCity(p, row.island);
  const travel = f === null ? null : w.travel(f.id, row.island, false);
  if (f === null || travel === null) {
    dropTrain(p);
    return;
  }
  if (w.t + travel < ta) {
    p.wakeAt(ta - travel);
    return;
  }
  const d = targetDefense(p, prm, row, travel) ?? NO_DEFENSE;
  const foes = w.map?.cities.filter((c) => c.owner === victim).length ?? 1;
  const tg: Target = { row, besieged: false, travel };
  const m = moraleAgainst(w, foes);
  const helpers = p.flag(`dk${id}`) ?? 0;
  const planned = p.flag("ap") ?? 0;
  const estimate = p.flag("ae") ?? 0;
  const view = w.views.get(id);
  const intelAt = view?.access === "public" && view.intel !== null ? view.intel.at[0] : null;
  const newer =
    view?.access === "public" &&
    view.intel?.type === "spy_report" &&
    intelAt !== null &&
    intelAt > planned;
  const sent = p.flag(`sp${id}`) ?? 0;
  const fly = spyTravel(w, row.island);
  const failed =
    !newer &&
    sent >= planned &&
    planned > 0 &&
    fly !== null &&
    w.t > sent + fly + 60 &&
    (intelAt === null || intelAt < sent);
  const waves = assault(p, prm, tg, d, m, helpers > 0 ? [helpers] : [], !newer);
  let why: string | null = null;
  if (failed) why = "spy failed";
  else if (newer && estimate > 0 && defenseValue(d) * 1000 > estimate * prm.abortPm) {
    why = `D${defenseValue(d)} vs D${estimate}`;
  } else if (waves === null) why = `D${defenseValue(d)}: short`;
  if (why !== null) {
    recallTrain(p, id);
    p.memo(`train ${id} called off ${fmtTime(w.t)}: ${why}`);
    p.clearFlag(`dk${id}`);
  } else if (waves !== null && launch(p, id, row.island, waves, m)) {
    p.setFlag("ac", 1);
  }
  dropTrain(p);
}

// Offense.

interface Offense {
  /** Islands of the strikes that wait for a founder, in order. */
  readonly wanted: IslandId[];
  /** The island of a strike the army can make that holds the founders at home (intel or waves on their way). */
  readonly holding: IslandId | null;
}

/** A victim city as `offense` sees it this turn. */
interface Sighting {
  readonly tg: Target;
  readonly label: string;
  readonly taken: boolean;
  readonly d: Defense | null;
  readonly breaks: boolean;
  readonly ready: boolean;
}

/**
 * conqueror@1's offense over this version's targets (`victimTargets`): spies the victim's cities
 * whose intel is missing or stale, strikes the first that is ready, and has the first the army could
 * break hold the founders (the cities after it are only scouted); a city too strong for the whole
 * army is passed over.
 */
function offense(
  p: Planner,
  prm: Conqueror2Params,
  victim: PlayerId | null,
  strikes: boolean,
): Offense {
  const { w } = p;
  const kit = w.kit;
  if (victim === null || kit.roles.attacker === null) return { wanted: [], holding: null };
  const targets = victimTargets(p, prm, victim);
  const foes = targets.length;
  const holds = holdCities(w);
  const attackOpen = w.t >= kit.rules.time.attackFrom && p.attacksLeft > 0;
  const train = trainWaits(p);
  let spies = 0;
  const seen: Sighting[] = [];
  for (const tg of targets.slice(0, prm.scan)) {
    const label = tg.row.id;
    const taken = holds.has(tg.row.id) || p.inFlight("attack", tg.row.id);
    if (taken || tg.besieged) {
      seen.push({ tg, label, taken, d: null, breaks: false, ready: false });
      continue;
    }
    const view = w.views.get(tg.row.id);
    const avoided =
      view?.tag !== null && view?.tag !== undefined && w.hints.avoidTags.includes(view.tag);
    if (view === undefined || avoided) {
      seen.push({ tg, label, taken, d: null, breaks: false, ready: false });
      continue;
    }
    const open = opensAt(w, tg.row);
    if (w.t + tg.travel + 4 * 3600 < open) {
      p.wakeAt(open - tg.travel - 4 * 3600);
      seen.push({ tg, label, taken, d: null, breaks: false, ready: false });
      continue;
    }
    const d = targetDefense(p, prm, tg.row, tg.travel);
    const fresh = d !== null && d.age <= prm.stale;
    // A spy whose report may lead to a strike (the army could strike the city on its older intel)
    // is worth one of the own wakes kept for the rest of the day; others wait for spare ones.
    const strikable = d !== null && armyBreaks(p, { ...prm, marginPm: STRIKE_PM }, tg, d, foes);
    const spyable =
      w.t + 2 * 3600 >= kit.rules.time.attackFrom &&
      (wakesSpare(p, 1) || (strikable && wakesLeft(p, 1)));
    if (!fresh && !train && spies < 2 && spyable) {
      if (spyOn(p, prm, tg, view)) spies += 1;
    }
    const breaks = d !== null && armyBreaks(p, prm, tg, d, foes);
    const ready = breaks && fresh && attackOpen && w.t + tg.travel >= open;
    const text = d === null ? label : `${label} D${defenseValue(d)}`;
    seen.push({ tg, label: text, taken, d, breaks, ready });
  }

  const wanted: IslandId[] = [];
  let hold = train;
  const trainTarget = w.map?.cities.find((c) => c.id === `c${p.flag("at") ?? 0}`);
  let holding: IslandId | null = train ? (trainTarget?.island ?? null) : null;
  for (const x of seen) {
    if (x.d === null || x.taken) continue;
    if (!x.breaks) {
      p.summary.push(`${x.label}: too strong`);
      continue;
    }
    // A strike needs a wider margin than breaking the city (the founders must survive): until the
    // army has it, founders are neither wanted nor held for this city.
    if (!armyBreaks(p, { ...prm, marginPm: STRIKE_PM }, x.tg, x.d, foes)) {
      p.summary.push(`${x.label}: army gathering`);
      hold = true;
      continue;
    }
    const free = founderCity(p, x.tg.row.island) !== null;
    if (strikes && !free && !wanted.includes(x.tg.row.island)) {
      wanted.push(x.tg.row.island);
      p.summary.push(`${x.label}: founder wanted (k${w.self?.private?.settler.k ?? 0})`);
    }
    const now = strikes && !hold && x.ready && free;
    if (strikes && !hold && free) holding = x.tg.row.island;
    hold = true;
    if (!now) continue;
    if (strikeChecked(p, prm, x.tg, x.d, foes)) {
      p.setFlag("ac", 1);
      hold = trainWaits(p);
      holding = hold ? x.tg.row.island : null;
    } else {
      p.summary.push(`${x.label}: waiting`);
    }
  }
  return { wanted, holding };
}

/**
 * One spy per turn on the best city of another player (by the options' order) whose intel is
 * missing or older than `SCOUT_STALE`, and not scouted within it (`sc<city>`).
 */
function scout(
  p: Planner,
  prm: Conqueror2Params,
  opts: readonly Option[],
  victim: PlayerId | null,
): void {
  const { w } = p;
  const kit = w.kit;
  if (w.t + 2 * 3600 < kit.rules.time.attackFrom || trainWaits(p) || !wakesSpare(p, 1)) return;
  for (const o of opts) {
    if (o.q === victim) continue;
    const view = w.views.get(o.row.id);
    if (view === undefined || view.access !== "public") continue;
    if (view.tag !== null && w.hints.avoidTags.includes(view.tag)) continue;
    const age = view.intel === null ? null : w.t - view.intel.at[0];
    if (age !== null && age < SCOUT_STALE) continue;
    const last = p.flag(`sc${o.row.id}`);
    if (last !== null && w.t - last < SCOUT_STALE) continue;
    if (p.inFlight("spy", o.row.id)) continue;
    const travel = reachOf(w, [o.row]);
    if (travel === null) continue;
    if (spyOn(p, prm, { row: o.row, besieged: false, travel }, view)) {
      p.setFlag(`sc${o.row.id}`, w.t);
      p.summary.push(`scout ${o.row.id} (${o.q})`);
    }
    return;
  }
}

/**
 * The expected value of a founding: the free slot a founder would go to (`pickSlot`, from the city
 * where it is nearest), against `SLOT_COST` and its travel; 0 when no slot is in reach.
 */
function slotEv(p: Planner): number {
  let best = 0;
  for (const c of p.w.cities) {
    if (c.blocked) continue;
    const slot = p.pickSlot(c, null);
    if (slot === null) continue;
    const ev = Math.floor(VALUE / (SLOT_COST + Math.floor((slot.travel * TRAVEL_COST) / 3600)));
    if (ev > best) best = ev;
  }
  return best;
}

/**
 * True when `c` may take a batch of the unit mix while own wakes are short: its attackers' queue is
 * busy (the batch only delays the wake its end brings), or the batch would hold `LONG_PACKS` packs
 * (long enough not to end before the next wake).
 */
function recruitNow(p: Planner, c: OwnCity): boolean {
  const { w, k } = p;
  const kit = w.kit;
  const attacker = kit.roles.attacker;
  const arow = attacker === null ? undefined : kit.units.get(attacker);
  if (arow === undefined) return false;
  if ((c.recruit[arow.queue]?.length ?? 0) > 0) return true;
  const drow = kit.roles.defender === null ? undefined : kit.units.get(kit.roles.defender);
  const cost = addRes(
    scaleRes(arow.cost, k.mix.attacker),
    drow === undefined ? ZERO : scaleRes(drow.cost, k.mix.defender),
  );
  const pop = arow.pop * k.mix.attacker + (drow?.pop ?? 0) * k.mix.defender;
  const packs = Math.min(
    timesAffordable(pmRes(p.budgetOf(c.id), k.spendPm), cost),
    Math.floor(p.popFreeOf(c.id) / Math.max(1, pop)),
  );
  return packs >= LONG_PACKS;
}

/**
 * Carriers where founders are (at home or queued): enough to lift them with `minAttackers`
 * attackers, since a strike's founders' wave leaves from their city and crosses water with its
 * own carriers (the generic carriers follow the attackers only).
 */
function founderCarriers(p: Planner, prm: Conqueror2Params): void {
  const { w } = p;
  const kit = w.kit;
  const { carrier, founder, attacker } = kit.roles;
  const row = carrier === null ? undefined : kit.units.get(carrier);
  if (carrier === null || row === undefined || row.capacity <= 0) return;
  if (!kit.rules.movement.transportRule) return;
  const fpop = kit.units.get(founder)?.pop ?? 0;
  const apop = attacker === null ? 0 : (kit.units.get(attacker)?.pop ?? 0);
  for (const c of w.cities) {
    const founders = countOf(p.homeOf(c.id), founder) + p.queued(c, founder);
    if (founders <= 0 || !p.canRecruit(c, carrier)) continue;
    const lift = founders * fpop + prm.minAttackers * apop;
    const want = Math.ceil(lift / row.capacity) - countOf(c.units, carrier) - p.queued(c, carrier);
    const n = Math.min(
      want,
      timesAffordable(p.budgetOf(c.id), row.cost),
      Math.floor(p.popFreeOf(c.id) / Math.max(1, row.pop)),
    );
    if (n > 0) p.recruit(c, [{ unit: carrier, count: n }]);
  }
}

/**
 * An army cannot cross water without its carriers: a city with `minAttackers` attackers (home or
 * queued) that cannot recruit carriers yet asks for what unlocks them, ahead of its economy.
 */
function harbors(p: Planner, prm: Conqueror2Params): void {
  const { w } = p;
  const kit = w.kit;
  const { carrier, attacker } = kit.roles;
  const row = carrier === null ? undefined : kit.units.get(carrier);
  if (row === undefined || attacker === null || !kit.rules.movement.transportRule) return;
  for (const c of w.cities) {
    if (c.blocked || c.levels === null || meets(row.requires, c.levels)) continue;
    if (countOf(c.units, attacker) + p.queued(c, attacker) < prm.minAttackers) continue;
    p.wish(c.id, ...unlockWishes(kit, carrier));
  }
}

/** True when a founder leaving some own city has a free slot in reach. */
function slotInReach(p: Planner): boolean {
  return p.w.cities.some((c) => !c.blocked && p.pickSlot(c, null) !== null);
}

/**
 * Once no free slot is in reach, one founder is kept in hand even before a strike asks for it: the
 * island of the victim's first target, when no founder is at home or queued anywhere.
 */
function spareFounder(p: Planner, prm: Conqueror2Params, victim: PlayerId | null): IslandId[] {
  const { w } = p;
  const founder = w.kit.roles.founder;
  if (victim === null || slotInReach(p)) return [];
  if (w.cities.some((c) => countOf(p.homeOf(c.id), founder) + p.queued(c, founder) > 0)) return [];
  const first = victimTargets(p, prm, victim)[0];
  return first === undefined ? [] : [first.row.island];
}

// Diplomacy.

/**
 * Answers proposals (pacts from anyone but its victim and a rival bloc, one alliance); from day 2,
 * once a day while it has no alliance, proposes a war alliance to the strongest of its nearest
 * neighbours that is neither its victim nor in a rival bloc (a pact when that neighbour has an
 * alliance already); tells its allies its victim.
 */
function diplomacy(p: Planner, ctx: Context, victim: PlayerId | null): void {
  const { w } = p;
  const d = w.kit.rules.diplomacy;
  let allied = w.self?.alliance !== null && w.self?.alliance !== undefined;
  p.answer((pr) => {
    if (pr.from === victim || ctx.rivals.has(pr.from)) return false;
    if (pr.kind === "pact") return true;
    if (allied || d.allianceMax < 2) return false;
    allied = true;
    return true;
  });
  if (allied) {
    coordinate(p, ctx, victim);
    return;
  }
  p.clearFlag("mv");
  if (w.day < 1 || d.allianceMax < 2 || (p.flag("dp") ?? 0) > w.day) return;
  const open = w.briefing.proposals.filter((q) => q.from === w.seat);
  if (open.length >= d.maxOpenProposals || open.some((q) => q.kind === "alliance")) return;
  const near = [...citiesByOwner(w)]
    .filter(([q]) => q !== victim && !ctx.rivals.has(q) && !w.relations.has(q))
    .map(([q, rows]) => ({ q, reach: reachOf(w, rows) }))
    .filter((x): x is { q: PlayerId; reach: number } => x.reach !== null)
    .toSorted((a, b) => a.reach - b.reach || compareIds(a.q, b.q))
    .slice(0, NEIGHBOURS);
  const strongest = near.toSorted(
    (a, b) =>
      (ctx.standings.get(b.q)?.score ?? 0) - (ctx.standings.get(a.q)?.score ?? 0) ||
      a.reach - b.reach ||
      compareIds(a.q, b.q),
  )[0];
  if (strongest === undefined) return;
  p.setFlag("dp", w.day + 1);
  const against = victim === null ? "our enemies" : victim;
  if ((ctx.standings.get(strongest.q)?.alliance ?? null) === null) {
    p.propose(
      strongest.q,
      "alliance",
      `War alliance: together against ${against}. I take their cities; we share the land and the win.`,
      `War ${w.seat}`,
    );
  } else if ([...w.relations.values()].filter((k) => k === "pact").length < d.maxPacts) {
    p.propose(strongest.q, "pact", `Peace between us while I fight ${against}?`, null);
  }
}

/** Tells its allies its victim and its first target, once per victim (`mv`). */
function coordinate(p: Planner, ctx: Context, victim: PlayerId | null): void {
  if (ctx.allies.length === 0 || victim === null) return;
  const n = seatNumber(victim);
  if (n === null || p.flag("mv") === n) return;
  if (p.message(ctx.allies, `war on ${victim}: I am taking their cities. Join me.`)) {
    p.setFlag("mv", n);
  }
}

/**
 * Sends defenders to an ally's city under attack by someone outside the alliance, once per attack
 * (`a<movement>`): a third of those at home in the nearest own city whose support lands first, at
 * least `MIN_SUPPORT`, unless the seat already has a group stationed there.
 */
function supportAllies(p: Planner): void {
  const { w } = p;
  const kit = w.kit;
  const defender = kit.roles.defender;
  if (defender === null) return;
  const stationed = new Set(
    (w.self?.private?.stationed ?? []).filter((s) => s.role === "support").map((s) => s.city),
  );
  for (const inc of w.briefing.incoming) {
    if (inc.kind !== "attack" || inc.homecoming === true || inc.arrive[0] <= w.t) continue;
    if (p.handled(`a${inc.id}`)) continue;
    const row = w.map?.cities.find((c) => c.id === inc.to);
    const owner = row?.owner ?? null;
    if (row === undefined || owner === null || w.relations.get(owner) !== "ally") continue;
    if (inc.by === w.seat || w.relations.get(inc.by) === "ally") continue;
    p.markHandled(`a${inc.id}`);
    if (besiegedRow(w, row) || stationed.has(row.id)) continue;
    const pop = Math.max(1, kit.units.get(defender)?.pop ?? 1);
    const helpers = w.cities
      .filter((c) => !c.blocked)
      .map((c) => ({ c, travel: w.travel(c.id, row.island, false) }))
      .filter((x): x is { c: OwnCity; travel: number } => x.travel !== null)
      .filter((x) => w.t + x.travel < inc.arrive[0])
      .toSorted((a, b) => a.travel - b.travel || compareIds(a.c.id, b.c.id));
    for (const { c } of helpers) {
      const n = Math.min(
        Math.floor(countOf(p.homeOf(c.id), defender) / 3),
        Math.floor(p.liftCapacity(c, row.island) / pop),
      );
      if (n < MIN_SUPPORT) continue;
      const group = p.withCarriers(c, row.island, { [defender]: n });
      if (group === null) continue;
      p.support(c, row.id, group);
      stationed.add(row.id);
      break;
    }
  }
}

/** Drops this version's flags that no longer matter: old scouting spies, an old ally's victim, a dead train's checks. */
function tidyMore(p: Planner): void {
  const { w } = p;
  for (const [name, value] of Object.entries(p.memory.x)) {
    if (/^scc[1-9][0-9]*$/.test(name) && w.t - value >= SCOUT_STALE) p.clearFlag(name);
    if (/^loc[1-9][0-9]*$/.test(name) && w.t - value >= RETAKE_FOR) p.clearFlag(name);
  }
  if ((p.flag("jt") ?? 0) > 0 && w.t - (p.flag("jt") ?? 0) >= DAY) {
    p.clearFlag("jv");
    p.clearFlag("jt");
  }
  if ((p.flag("at") ?? 0) <= 0) {
    p.clearFlag("ae");
    p.clearFlag("ap");
  }
}

/**
 * True when the victim's best city is worth a founder more than a free slot is: its value counts
 * twice (`CONQUEST_PM`), as a city gained and one taken from a rival.
 */
function conquestPays(p: Planner, opts: readonly Option[], victim: PlayerId | null): boolean {
  const best = opts.find((o) => o.q === victim) ?? null;
  return best !== null && Math.floor((best.ev * CONQUEST_PM) / 1000) >= slotEv(p);
}

/**
 * Founders found cities, except those a strike wants or holds (`HOLD_MAX` at most): they stay home
 * in the city that would lead it, and no founder is recruited to found meanwhile. A committed
 * campaign whose next strike could finish its victim (two cities left at most) keeps every founder.
 * Conquest founders are recruited for the strikes that want one (or one spare once no slot is
 * left), with the carriers to lift them.
 */
function foundersFor(p: Planner, prm: Conqueror2Params, victim: PlayerId | null, o: Offense): void {
  const { w } = p;
  const since = p.flag("hw");
  if (o.holding === null) p.clearFlag("hw");
  else if (since === null) p.setFlag("hw", w.t);
  const hold = o.holding !== null && (since === null || w.t - since <= HOLD_MAX);
  const keep = new Map<CityId, number>();
  const island = hold ? o.holding : (o.wanted[0] ?? null);
  const lead = island === null ? null : founderCity(p, island);
  if (lead !== null) keep.set(lead.id, prm.founders);
  const left = victim === null ? 0 : (citiesByOwner(w).get(victim)?.length ?? 0);
  const finishing =
    (p.flag("ac") ?? 0) > 0 && left > 0 && left <= 2 && (hold || o.wanted.length > 0);
  if (!finishing) p.settle(keep);
  if (!finishing && !hold && o.wanted.length === 0) p.founder();
  conquestFounders(p, prm, o.wanted.length > 0 ? o.wanted : spareFounder(p, prm, victim));
  founderCarriers(p, prm);
}

/**
 * The army and the buildings. Every queue that runs dry wakes the seat (own budget): while the own
 * wakes left would not see the day out (`wakesSpare`), no idle build queue is started and an idle
 * recruit queue only for a long batch. The army comes first in the forge city (the capital), after
 * the buildings elsewhere; an army that cannot cross water asks for its carriers first.
 */
function grow(p: Planner, prm: Conqueror2Params): void {
  const spare = wakesSpare(p, 0);
  const forge = forgeCity(p.w)?.id ?? null;
  harbors(p, prm);
  const may = (c: OwnCity): boolean => spare || recruitNow(p, c);
  p.units(undefined, (c) => c.id === forge && may(c));
  if (spare) p.economy((c) => storeAhead(p, c));
  else p.economyWith((c) => (c.build.length === 0 ? [] : economyWishes(p, c, storeAhead(p, c))));
  transports(p);
  p.units(undefined, (c) => c.id !== forge && may(c));
}

export const conqueror2: StrategyDef = Object.freeze<StrategyDef>({
  name: "conqueror",
  version: 2,
  brain(rng) {
    const prm = conqueror2Params(rng);
    const knobs: Knobs = {
      cadence: randInt(rng, 5400, 7200),
      settle: true,
      maxCities: 64,
      producerBase: randInt(rng, 3, 4),
      producerPerDay: 2,
      wallBase: 0,
      wallPerDay: 0,
      spendPm: randInt(rng, 800, 900),
      mix: { defender: 1, attacker: 2, navy: 0 },
      carriers: true,
      supportOwn: true,
      escort: randInt(rng, 2, 3),
      militaryFirst: true,
    };
    return {
      knobs,
      reads(w: World): ToolCall[] {
        const victim = remembered(w);
        const cities = [...victimReads(w, prm, victim), ...scoutReads(w, prm, victim)];
        return [call("leaderboard", {}), ...cities.map((city) => call("view_city", { city }))];
      },
      plan(p) {
        rememberAttackers(p);
        rememberLosses(p);
        hearAllies(p);
        const ctx = contextOf(p);
        const opts = options(p, prm, ctx);
        const victim = settleVictim(p, opts);
        tidy(p, victim);
        tidyMore(p);
        noteDefense(p, prm, victim);
        diplomacy(p, ctx, victim);
        holdSieges(p);
        p.supportThreatened();
        supportAllies(p);
        trainStep(p, prm, victim);
        const o = offense(p, prm, victim, conquestPays(p, opts, victim));
        scout(p, prm, opts, victim);
        // While a train waits, nothing is queued: every queue that empties would cost an own wake.
        if (trainWaits(p)) return;
        foundersFor(p, prm, victim, o);
        grow(p, prm);
      },
    };
  },
});
