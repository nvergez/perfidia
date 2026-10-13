// `conqueror@3` (docs/architecture.md §11.2): conqueror@2 (`conqueror2.ts`, frozen) played as a
// warlord that builds a strike force early, holds what it takes and fights beside its allies. Kept
// from conqueror@2 (this file copies what it keeps): the victim by expected value (leader,
// countdown, attacker, the ally's foe, retake and few-cities weights), its cities cheapest first,
// the founders between free slots and conquests, the trains and their check spy, the scouting spy,
// the own-wake pacing and the diplomacy; conqueror@1's battle model (`conqueror.ts`). Changed:
//
// - Strike force: once its second city is founded, the forge city raises attackers first while the
//   seat owns fewer than 50 (before capitals can fall, before its founders), then 50 + 15 a day; the
//   rest of its army is two defenders for one attacker: a siege is held by its garrison.
// - Safer strikes: the defense a strike meets adds the support it provokes (every attack is seen at
//   launch: the owner's nearest city whose support lands first sends half its defenders per attack,
//   each ally of the owner a share of its nearest city's; cities without intel at a prior, and a spy
//   on the one that decides a strike), weighed for the founders' city's flight; a strike flies 2.5 h
//   at most (longer flights lost every unit far more often); a strike leaves on a spy report younger
//   than `fresh` (a spy first, the strike at its report's wake) unless no own wake is left for one.
//   A fresh colony (its founding seen in the public feed) is weighed at a young city's prior.
// - Garrison: the troops that follow the founders' wave go as supports (a support of the attacker
//   stationed in the target stands aside in the battle and joins the siege, perfidia-1 §8.1, §9.1),
//   with covering supports from its other cities landing within the hour after it, sized to hold
//   against the relief its owner can send (`reliefOf`): the garrison stands, and shows, when the owner
//   wakes to the siege and weighs a relief. One attack instead of two or three is seen, so less
//   support comes. A support stranded in a stranger's city (a strike that failed) is called home.
// - Sieges held: a strike whose garrison could not hold against the owner's known army is not made
//   (nor are founders recruited for it); each attack on a siege (a relief) is met with defenders from
//   the cities whose support lands first, enough for the founders to survive what it likely brings;
//   a garrison a relief its origin's spy report shows stronger than every helper can make would beat
//   is called home (the units live). Allies are asked to hold the city once it falls (`siege` call).
// - War calls (`war.ts`): a strike on a capital or a strong city waits for the allies in reach that
//   answered its last call: a `strike` call names a landing window before its founders, whose waves
//   leave at a timed wake, weighed again then on the intel of then (never counting on the allies);
//   a call-off is cancelled to them. It answers its allies' calls: a strike on a stranger's city with
//   a share of its attackers landing in the window (its own victim's first), defenders for a hold or
//   a conquest, never while its own train waits or an attack is on its way to it.
// - Trains and joint strikes call themselves off on a spy report showing more than `abortPm` of the
//   defense planned on (1.4–1.6×, conqueror@2: 2×), a failed check spy, or a garrison that would not
//   hold.
// - Its victim is kept 4 h once chosen (estimates move with every report); a war alliance goes to a
//   neighbour seen attacking first, and a player asked is not asked again for 2 days.
//
// Memory (notes, §11.1): conqueror@2's flags, plus `aj` (a planned joint strike: its call number),
// `wq` (the last call number), `jx` (a joint strike called off), `wd<seat>` (an ally that left a
// strike call unanswered), `gw<city>` (a siege's `siege` call sent), `vt` (when the victim was chosen),
// `fc<city>` (a stranger's city founded), `f<seat>` (a player seen attacking), `pd<seat>` (an alliance
// asked); handled ids `w<movement>` (a relief answered), `wk<call>` (a call's answers weighed). War
// calls and answers are memo lines `wc …` (`war.ts`), written last.

import {
  compareIds,
  type CityId,
  type CityRow,
  type IslandId,
  type PlayerId,
  type Json,
  type JsonObject,
  type ToolCall,
} from "@perfidia/protocol";
import {
  call,
  configInt,
  countOf,
  DAY,
  fmtTime,
  landPop,
  meets,
  pmRes,
  power,
  timesAffordable,
  unitsInReport,
} from "../kit.ts";
import { paceBuilds, paceRecruits, wakesInHand } from "../pace.ts";
import { ownWakesBefore, unlockWishes, type Knobs, type Planner } from "../plan.ts";
import { rivalCountdowns } from "../relief.ts";
import { fnv1a32, randInt, type BotRng } from "../rng.ts";
import {
  absorbWar,
  composeAck,
  composeCall,
  composeCancel,
  hearWar,
  joinWar,
  judgeWar,
  launchTime,
  mayMessage,
  pickCall,
  readBook,
  warId,
  warTarget,
  writeBook,
  type WarCandidate,
  type WarEntry,
  type WarOption,
} from "../war.ts";
import type { OwnCity, World } from "../world.ts";
import {
  allAttackers,
  armyBreaks,
  assault,
  besiegedRow,
  citiesByOwner,
  conquestFounders,
  defenseOf,
  defenseValue,
  forgeCity,
  founderCity,
  holdCities,
  moraleAgainst,
  NO_DEFENSE,
  noteDefense,
  opensAt,
  reachOf,
  rememberAttackers,
  seatNumber,
  spyOn,
  storeAhead,
  targetDefense,
  tidy,
  trainWaits,
  transports,
  type Defense,
  type Target,
} from "./conqueror.ts";
import { conqueror2Params, type Conqueror2Params } from "./conqueror2.ts";
import type { StrategyDef } from "./strategy.ts";

export interface Conqueror3Params extends Conqueror2Params {
  /** A strike leaves on a spy report at most this old (s); an older one is refreshed first. */
  readonly fresh: number;
  /** Weight (‰) of the support a strike provokes (the owner's and its allies' nearest cities). */
  readonly reactPm: number;
  /** A garrison facing a relief of attack A is raised to A × holdPm / 1000 (two founders: 5/6 of it). */
  readonly holdPm: number;
  /** Share (‰) of a city's attackers (a strike) or defenders (a hold) sent on an ally's call. */
  readonly warSharePm: number;
}

export function conqueror3Params(rng: BotRng): Conqueror3Params {
  return {
    ...conqueror2Params(rng),
    abortPm: randInt(rng, 1400, 1600),
    fresh: randInt(rng, 5400, 9000),
    reactPm: randInt(rng, 900, 1100),
    holdPm: randInt(rng, 1600, 1800),
    warSharePm: randInt(rng, 500, 700),
  };
}

/** The value of a city in the expected-value ratio (its cost is in defense points). */
const VALUE = 1_000_000;
/** Defense points added to every strike's cost: its founders and what the waves lose. */
const OVERHEAD = 400;
/** Defense points added to a strike's cost per hour of travel (twice conqueror@2's: short flights first). */
const TRAVEL_COST = 600;
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
/** A planned train is dropped this long after its landing time. */
const TRAIN_EXPIRY = 6 * 3600;
/** Helpers of a train land this long before its founders' wave at most; waves in a train at most. */
const TRAIN_WINDOW = 2 * 3600;
const TRAIN_MAX = 4;
/** Own wakes a train keeps in hand beyond the one its timed launch needs. */
const TRAIN_SPARE = 1;
/** Fewest defenders sent to support an ally's city. */
const MIN_SUPPORT = 5;
/** Own wakes in hand a scouting spy needs. */
const SCOUT_HAND = 2;
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
/** A victim is kept this long once chosen, unless it is out of reach (`settleVictim`). */
const VICTIM_HOLD = 4 * 3600;
/** A player asked for an alliance is not asked again within this; one seen attacking stays a fighter as long. */
const ASKED_FOR = 2 * DAY;
/** conqueror@1's pad (`defenseOf`), and what is kept of it on intel younger than `fresh` at landing. */
const DEFENSE_PAD = 200;
const FRESH_PAD = 60;
/**
 * A support whose travel (timed on the map at the seat's sea pace, a rounding away from the real
 * one) is this close to the waves' lands with or before them: in the same second, supports land
 * first.
 */
const TRAVEL_SLACK = 120;
/** Share (‰) of an ally's nearest city's defenders assumed to come per attack seen (relief pack: 300–450). */
const ALLY_REACT_PM = 400;
/** Covering supports land at most this long after the founders' wave; cities that send them, at most. */
const COVER_AFTER = 3600;
const COVER_CITIES = 4;
/** Share (‰) of a city's defenders sent to a siege at most (a strike's cover, or against a relief). */
const HOLD_SHARE_PM = 800;
const HOLD_CITIES = 4;
/**
 * A relief launched against a garrison of defense D is assumed to bring at least this much of D (‰):
 * a lost relief that reaches 0.71·D still kills a lone founder (perfidia-1 §9.3), with a margin.
 */
const RELIEF_PM = 800;
/** Attack assumed at home in an owner's city without a spy report: base + perDay × days elapsed. */
const RELIEF_PRIOR = Object.freeze({ base: 150, perDay: 150 });
/** A relief draws its waves from this many of the owner's cities at most (the relief pack: 3). */
const RELIEF_CITIES = 3;
/** A spy report older than this says nothing of a relief force. */
const RELIEF_STALE = DAY;
/**
 * A strike flies this long at most: every city of the owner and of its allies that its support
 * reaches sooner defends against it (in the re-baseline, 3 to 5 h flights lost every unit in a
 * third to a half of conqueror@2's strikes, against one in ten below 3 h). The campaign hops
 * closer through the cities it takes.
 */
const MAX_FLIGHT = 9000;

/** A joint strike is not called again within this of one called off. */
const JOINT_COOLDOWN = 3 * 3600;
/**
 * The strike force: once its second city is founded (or on its way), and from 6 h before attacks
 * open, the forge city raises attackers first while the seat owns fewer than this many (at home,
 * queued, away), in batches of at least `EARLY_BATCH`: 50 before capitals can fall (`EARLY_PM` of
 * its budget, paid before the founders), then 50 + 15 a day (`LATE_PM`). Its mix otherwise favours
 * defenders (a siege is held by its garrison).
 */
const EARLY_ATTACKERS = 50;
const ATTACKERS_PER_DAY = 15;
const EARLY_PM = 900;
const LATE_PM = 650;
const EARLY_BATCH = 6;
/** A strike on a capital or on a city this strong (defense) waits for the allies in reach. */
const JOINT_DEFENSE = 1000;
/** An ally that left a strike call unanswered is not waited for again within this. */
const DEAF_FOR = DAY;
/** A joint strike lands this long after the call at least, the allies' window ending before it. */
const JOINT_LEAD = 3 * 3600;
const JOINT_WINDOW = 1800;
/** Allies' cities farther than this from the target (map distance at the seat's pace) are not counted in reach. */
const JOINT_REACH = 5 * 3600;
/** A responder's strike carries at least this many attackers. */
const WAR_MIN_ATTACKERS = 15;
/** A `siege` call asks allies to land this long after the siege ends, for this long. */
const SIEGE_CALL_AFTER = 3600;
const SIEGE_CALL_SPAN = 4 * 3600;

const bySeat = (n: number): PlayerId => `p${n}`;

/** `c12` → 12, or null. */
function cityNumber(id: string): number | null {
  const m = /^c([1-9][0-9]*)$/.exec(id);
  return m?.[1] === undefined ? null : Number(m[1]);
}

type Waves = NonNullable<ReturnType<typeof assault>>;
type Wave = Waves[number];

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
  const rivals = new Set<PlayerId>(rivalCountdowns(w).flatMap((c) => c.members));
  const allies = [...w.relations.entries()]
    .filter(([, kind]) => kind === "ally")
    .map(([q]) => q)
    .toSorted(compareIds);
  const jv = p.flag("jv") ?? 0;
  const jt = p.flag("jt") ?? 0;
  const named = jv > 0 && w.t - jt < DAY ? bySeat(jv) : null;
  return { standings, leader, rivals, allies, named };
}

/** The other members of `q`'s alliance, from the leaderboard (none when it was not read). */
function blocOf(w: World, q: PlayerId): Set<PlayerId> {
  const out = new Set<PlayerId>();
  const mine = w.board?.standings.find((s) => s.player === q)?.alliance ?? null;
  if (mine === null) return out;
  for (const s of w.board?.standings ?? []) {
    if (s.player !== q && s.alive && s.alliance === mine) out.add(s.player);
  }
  return out;
}

/**
 * Reads its allies' messages: "war on pX" names their victim, and a call for help ("attack on c5
 * by p2") names their attacker. Remembered for a day (`jv`, `jt`). War calls are read apart.
 */
function hearAllies(p: Planner): void {
  const { w } = p;
  for (const m of w.briefing.msgs) {
    if (w.relations.get(m.from) !== "ally" || /war#/i.test(m.text)) continue;
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

// Geometry.

/** The integer square root of `n` ≥ 0. */
function isqrt(n: number): number {
  if (n <= 0) return 0;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r -= 1;
  while ((r + 1) * (r + 1) <= n) r += 1;
  return r;
}

/** Tiles between two islands of the map, or null when one is not on it. */
function tiles(w: World, a: IslandId, b: IslandId): number | null {
  const ia = w.map?.islands.find((x) => x.id === a);
  const ib = w.map?.islands.find((x) => x.id === b);
  if (ia === undefined || ib === undefined) return null;
  const dx = ia.x - ib.x;
  const dy = ia.y - ib.y;
  return isqrt(dx * dx + dy * dy);
}

/**
 * Seconds a group takes per 1000 tiles across the sea, from the seat's own travel times: the lower
 * median of travel ÷ distance over the islands its cities reach in more than `minTravel`; null when
 * none is known.
 */
function seaPace(w: World): number | null {
  const min = w.kit.rules.time.minTravel;
  const ratios: number[] = [];
  for (const c of w.cities) {
    for (const isl of w.map?.islands ?? []) {
      if (isl.id === c.island) continue;
      const t = w.travel(c.id, isl.id, false);
      const d = tiles(w, c.island, isl.id);
      if (t === null || d === null || d <= 0 || t <= min) continue;
      ratios.push(Math.floor((t * 1000) / d));
    }
  }
  if (ratios.length === 0) return null;
  return ratios.toSorted((a, b) => a - b)[Math.floor((ratios.length - 1) / 2)] ?? null;
}

/** A walk on one island: the seat's own travel to its own island, or `minTravel`. */
function walk(w: World): number {
  for (const c of w.cities) {
    const t = w.travel(c.id, c.island, false);
    if (t !== null) return t;
  }
  return w.kit.rules.time.minTravel;
}

/** A group's travel between two islands of the map at `pace` (s per 1000 tiles), or null. */
function islandTravel(w: World, pace: number | null, a: IslandId, b: IslandId): number | null {
  if (a === b) return walk(w);
  const d = tiles(w, a, b);
  if (pace === null || d === null) return null;
  return Math.max(w.kit.rules.time.minTravel, Math.ceil((pace * d) / 1000));
}

// Defense estimates.

/** Unit defense assumed in a city without intel that may send support: base + perDay × days (since its founding). */
const SUPPORT_PRIOR = Object.freeze({
  capital: Object.freeze({ base: 100, perDay: 300 }),
  colony: Object.freeze({ base: 50, perDay: 150 }),
});

/** Growth (‰ per hour of a report's age) of the units a support city is assumed to hold, at most doubled. */
const SUPPORT_GROWTH_PM = 25;

/**
 * The defense of the units its last spy report showed in a city that may send support (grown by
 * `SUPPORT_GROWTH_PM` per hour of the report's age, at most doubled; its own estimate when the seat
 * sees it in full); without one, `SUPPORT_PRIOR`, at least `floor`.
 */
function unitsSeen(p: Planner, prm: Conqueror3Params, row: CityRow, floor: number): number {
  const { w } = p;
  const kit = w.kit;
  const view = w.views.get(row.id);
  if (view?.access === "full") return defenseOf(w, view, prm.growthPm, 0)?.units ?? floor;
  if (view?.access === "public" && view.intel?.type === "spy_report") {
    const seen = power(kit, unitsInReport(kit, view.intel.data), "defense", true);
    const hours = Math.floor(Math.max(0, w.t - view.intel.at[0]) / 3600);
    return seen + Math.floor((seen * Math.min(1000, SUPPORT_GROWTH_PM * hours)) / 1000);
  }
  const prior = row.capitalOf === null ? SUPPORT_PRIOR.colony : SUPPORT_PRIOR.capital;
  const since = row.capitalOf === null ? (p.flag(`fc${row.id}`) ?? 0) : 0;
  return Math.max(floor, prior.base + Math.floor((prior.perDay * Math.max(0, w.t - since)) / DAY));
}

/**
 * The owner's city whose support would land first on `row` within `ahead` seconds when the seat has
 * no spy report on it (the support counted at a prior), or null: a spy there may show a strike open.
 */
function blindSupport(p: Planner, row: CityRow, ahead: number): CityRow | null {
  const { w } = p;
  const pace = seaPace(w);
  let best: { o: CityRow; travel: number } | null = null;
  for (const o of w.map?.cities ?? []) {
    if (o.id === row.id || o.owner === null || o.owner !== row.owner) continue;
    const travel = islandTravel(w, pace, o.island, row.island);
    if (travel === null || travel > ahead + TRAVEL_SLACK) continue;
    if (
      best === null ||
      travel < best.travel ||
      (travel === best.travel && compareIds(o.id, best.o.id) < 0)
    ) {
      best = { o, travel };
    }
  }
  if (best === null) return null;
  const view = w.views.get(best.o.id);
  const age = spyAge(w, best.o.id);
  return view?.access === "public" && (age === null || age > DAY) ? best.o : null;
}

/**
 * The support `waves` attacks on `row` provoke before they land `ahead` seconds from now: each attack
 * is seen at launch, and the owner's nearest other city whose support lands first sends half its
 * defenders per attack (1 − 2⁻ⁿ of them), each of the owner's allies `ALLY_REACT_PM` of its nearest
 * city's per attack; all weighed by `reactPm`. A city seen without carriers when the rules need them
 * to cross water sends none; one without intel counts at its prior (at least `own`). conqueror@1 counts the
 * owner's cities on the target's island at half their units (`targetDefense`): an owner's city there
 * adds only what it sends beyond that half.
 */
function provoked(
  p: Planner,
  prm: Conqueror3Params,
  row: CityRow,
  ahead: number,
  waves: number,
  own: number,
): number {
  const { w } = p;
  const kit = w.kit;
  const owner = row.owner;
  if (owner === null || waves <= 0) return 0;
  const pace = seaPace(w);
  const allies = blocOf(w, owner);
  const carrier = kit.roles.carrier;
  const nearest = new Map<PlayerId, { travel: number; units: number; sameIsland: boolean }>();
  for (const o of w.map?.cities ?? []) {
    if (o.id === row.id || o.owner === null) continue;
    if (o.owner !== owner && !allies.has(o.owner)) continue;
    const travel = islandTravel(w, pace, o.island, row.island);
    if (travel === null || travel > ahead + TRAVEL_SLACK) continue;
    const ov = w.views.get(o.id);
    const seen = ov?.access === "public" && ov.intel?.type === "spy_report" ? ov.intel.data : null;
    if (seen !== null && kit.rules.movement.transportRule && carrier !== null) {
      if (o.island !== row.island && countOf(unitsInReport(kit, seen), carrier) <= 0) continue;
    }
    const units = unitsSeen(p, prm, o, own);
    const prev = nearest.get(o.owner);
    if (
      prev === undefined ||
      travel < prev.travel ||
      (travel === prev.travel && units > prev.units)
    ) {
      nearest.set(o.owner, { travel, units, sameIsland: o.island === row.island });
    }
  }
  const n = Math.min(waves, 6);
  let sum = 0;
  for (const [q, x] of nearest) {
    let share: number;
    if (q === owner) {
      let keep = 1000;
      for (let i = 0; i < n; i += 1) keep = Math.floor(keep / 2);
      share = 1000 - keep;
      if (x.sameIsland) share = Math.max(0, share - 500);
    } else {
      // Each attack seen moves a share of what the ally's nearest city still has at home.
      let keep = 1000;
      for (let i = 0; i < n; i += 1) keep = Math.floor((keep * (1000 - ALLY_REACT_PM)) / 1000);
      share = 1000 - keep;
    }
    sum += Math.floor((x.units * share) / 1000);
  }
  return Math.floor((sum * prm.reactPm) / 1000);
}

/**
 * The defense `waves` attacks landing on `row` in `ahead` seconds meet: conqueror@1's estimate
 * (`targetDefense`: the city, at least the floor remembered for it, half the units of its owner's
 * cities on its island) with a smaller pad when the intel is younger than `fresh` at landing, plus
 * the support the attacks provoke (`provoked`).
 */
function defenseAt(
  p: Planner,
  prm: Conqueror3Params,
  row: CityRow,
  ahead: number,
  waves = 2,
): Defense | null {
  const d = targetDefense(p, prm, row, ahead);
  if (d === null) return null;
  const units = d.age <= prm.fresh ? Math.max(0, d.units - (DEFENSE_PAD - FRESH_PAD)) : d.units;
  return { ...d, units: units + provoked(p, prm, row, ahead, waves, units) };
}

/**
 * The defense assumed for a city the seat has no usable intel on: the prior grows from the match's
 * start, or from the city's founding when the seat saw it (`fc<city>`, a day): a fresh colony holds
 * little more than its escort.
 */
function priorDefense(
  w: World,
  row: CityRow,
  flags: Readonly<Record<string, number>> = w.memory.x,
): number {
  const prior = row.capitalOf === null ? COLONY_PRIOR : CAPITAL_PRIOR;
  const founded = row.capitalOf === null ? (flags[`fc${row.id}`] ?? 0) : 0;
  return prior.base + Math.floor((prior.perDay * Math.max(0, w.t - founded)) / DAY);
}

/** Remembers who was seen attacking in the public battle headlines (`f<seat>`: when). */
function watchFighters(p: Planner): void {
  const { w } = p;
  for (const e of [...w.briefing.news, ...w.briefing.events]) {
    if (e.type !== "battle") continue;
    const attacker = e["attacker"];
    const m = typeof attacker === "string" ? /^p([1-9][0-9]*)$/.exec(attacker) : null;
    if (m?.[1] === undefined || attacker === w.seat) continue;
    p.setFlag(`f${m[1]}`, w.t);
  }
}

/** Remembers for a day when strangers founded their cities (`fc<city>`), from the public feed. */
function rememberFoundings(p: Planner): void {
  const { w } = p;
  for (const e of [...w.briefing.events, ...w.briefing.news]) {
    if (e.type !== "city_founded" || e["owner"] === w.seat) continue;
    const city = e["city"];
    const at: unknown = e["at"];
    const t: unknown = Array.isArray(at) ? at[0] : at;
    if (typeof city !== "string" || !/^c[1-9][0-9]*$/.test(city) || typeof t !== "number") continue;
    if (w.t - t < DAY) p.setFlag(`fc${city}`, t);
  }
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
  prm: Conqueror3Params,
  row: CityRow,
  travel: number,
  foes: number,
): Cost {
  const { w } = p;
  const d = defenseAt(p, prm, row, travel);
  const value = d === null ? priorDefense(w, row, p.memory.x) : defenseValue(d);
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
function options(p: Planner, prm: Conqueror3Params, ctx: Context): Option[] {
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
      if (travel === null || travel > MAX_FLIGHT || !takeable(w, row, travel)) continue;
      if (besiegedRow(w, row) || held.has(row.id)) continue;
      const c = cityCost(p, prm, row, travel, rows.length);
      let ev = Math.floor((VALUE * weight) / 1000 / Math.max(1, c.cost));
      if (lostRecently(p, row.id)) ev = Math.floor((ev * RETAKE_PM) / 1000);
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
  // A victim still among the options is kept for `VICTIM_HOLD` after it was chosen: estimates move
  // with every report (and a city's floor is forgotten once its owner is no longer the victim), and
  // a victim changed every turn would be no campaign at all.
  const since = p.flag("vt");
  if (
    before !== null &&
    since !== null &&
    w.t - since < VICTIM_HOLD &&
    opts.some((o) => o.q === before)
  ) {
    return before;
  }
  const best = opts[0] ?? null;
  const v = best?.q ?? null;
  if (v === before) return v;
  p.setFlag("vt", w.t);
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
 * army could strike it, then the cities that can be taken by the time the waves land, cheapest first
 * (a city lost recently counts at half its cost); then capitals still immune.
 */
function victimTargets(p: Planner, prm: Conqueror3Params, victim: PlayerId): Target[] {
  const { w } = p;
  const rows = (w.map?.cities ?? []).filter((c) => c.owner === victim);
  const out: { tg: Target; rank: number; cost: number }[] = [];
  for (const row of rows) {
    const travel = reachOf(w, [row]);
    if (travel === null || travel > MAX_FLIGHT) continue;
    const tg: Target = { row, besieged: besiegedRow(w, row), travel };
    const open = w.t + travel >= opensAt(w, row);
    const c = open ? cityCost(p, prm, row, travel, rows.length) : null;
    const raw = c?.cost ?? 0;
    const cost = lostRecently(p, row.id) ? Math.floor((raw * 1000) / RETAKE_PM) : raw;
    const d = row.capitalOf === victim && c !== null ? defenseAt(p, prm, row, travel) : null;
    const head = d !== null && armyBreaks(p, { ...prm, marginPm: STRIKE_PM }, tg, d, rows.length);
    out.push({ tg, rank: head ? 0 : open ? 1 : 2, cost });
  }
  return out
    .toSorted((a, b) => a.rank - b.rank || a.cost - b.cost || compareIds(a.tg.row.id, b.tg.row.id))
    .map((x) => x.tg);
}

/** The cities `reads` asks for: the victim's (cheapest first by prior) and the train's target. */
function victimReads(w: World, prm: Conqueror3Params, victim: PlayerId | null): CityId[] {
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
function scoutReads(w: World, prm: Conqueror3Params, victim: PlayerId | null): CityId[] {
  const picks: { row: CityRow; cost: number }[] = [];
  for (const [q, rows] of citiesByOwner(w)) {
    if (q === victim || w.relations.get(q) === "ally") continue;
    const mine: { row: CityRow; cost: number }[] = [];
    for (const row of rows) {
      const travel = reachOf(w, [row]);
      if (travel === null || travel > MAX_FLIGHT || !takeable(w, row, travel)) continue;
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

// Strikes.

/**
 * A support from `c` to `to` of up to `want` units (defenders first, then attackers), cut to what
 * its carriers lift across water; returns its land defense (0 when nothing left).
 */
function sendSupport(
  p: Planner,
  c: OwnCity,
  to: CityId,
  island: IslandId,
  want: Readonly<Record<string, number>>,
): number {
  const kit = p.w.kit;
  const { defender, attacker } = kit.roles;
  let lift = p.liftCapacity(c, island);
  const home = p.homeOf(c.id);
  const land: Record<string, number> = {};
  for (const u of [defender, attacker]) {
    if (u === null) continue;
    const pop = Math.max(1, kit.units.get(u)?.pop ?? 1);
    const n = Math.max(0, Math.min(want[u] ?? 0, countOf(home, u), Math.floor(lift / pop)));
    if (n <= 0) continue;
    land[u] = n;
    lift -= n * pop;
  }
  if (landPop(kit, land) <= 0) return 0;
  const group = p.withCarriers(c, island, land);
  if (group === null) return 0;
  p.support(c, to, group);
  return power(kit, group, "defense", true);
}

/** True before capitals can fall (hints), when colonies are the only targets. */
function early(w: World): boolean {
  return w.t < (configInt(w.kit, w.hints.combat?.capitalImmunityEnd) ?? 2 * DAY);
}

/** The own city (not blocked) nearest to `island`, or null. */
function nearestCity(w: World, island: IslandId): OwnCity | null {
  let best: { c: OwnCity; t: number } | null = null;
  for (const c of w.cities) {
    if (c.blocked) continue;
    const t = w.travel(c.id, island, false);
    if (t !== null && (best === null || t < best.t)) best = { c, t };
  }
  return best?.c ?? null;
}

/** True when an attack whose foe is the seat is on its way to `c`. */
function underAttack(w: World, c: CityId): boolean {
  return w.briefing.incoming.some(
    (i) =>
      i.kind === "attack" &&
      i.to === c &&
      i.arrive[0] > w.t &&
      (i.foe === undefined || i.foe === null || i.foe === w.seat),
  );
}

/**
 * The garrison that follows a founders' wave, sized to `need` (the land defense a siege of the city
 * needs against its expected relief, `holdNeed`). First the cities of `from`'s island whose support
 * lands in the same second, as supports (they land first and stand aside in the battle; a siege
 * makes them its garrison): their attackers left at home and, while the garrison is short of `need`,
 * their defenders (the forge city sends half of its at most, the others three quarters). Then
 * covering supports from the seat's other cities that land within `COVER_AFTER` of the founders and
 * are not under attack, nearest first (`COVER_CITIES` at most), up to `HOLD_SHARE_PM` of their
 * defenders each, until `need` is met. Returns the defense sent.
 */
function garrisonAndCover(
  p: Planner,
  prm: Conqueror3Params,
  from: OwnCity,
  tg: Target,
  lands: number,
  need: number,
): number {
  const { w } = p;
  const kit = w.kit;
  const { defender, attacker } = kit.roles;
  const forge = forgeCity(w)?.id;
  const island = tg.row.island;
  const per = defender === null ? 1 : Math.max(1, kit.units.get(defender)?.defense ?? 1);
  let sent = 0;
  const wanting = (cap: number): number => {
    const short = need - heldDefense(p, prm, tg.row, sent);
    return short <= 0 ? 0 : Math.min(cap, Math.ceil(short / per) + 1);
  };
  for (const c of w.cities) {
    if (c.blocked || c.island !== from.island) continue;
    const t = w.travel(c.id, island, false);
    if (t === null || w.t + t !== lands) continue;
    const have = countOf(p.homeOf(c.id), defender);
    const want: Record<string, number> = {};
    if (defender !== null) {
      want[defender] = wanting(Math.floor((have * (c.id === forge ? 500 : 750)) / 1000));
    }
    if (attacker !== null) want[attacker] = countOf(p.homeOf(c.id), attacker);
    sent += sendSupport(p, c, tg.row.id, island, want);
  }
  if (defender === null) return sent;
  const covers = w.cities
    .filter((c) => !c.blocked && c.island !== from.island && !underAttack(w, c.id))
    .map((c) => ({ c, travel: w.travel(c.id, island, false) }))
    .filter((x): x is { c: OwnCity; travel: number } => x.travel !== null)
    .filter((x) => w.t + x.travel <= lands + COVER_AFTER)
    .toSorted((a, b) => a.travel - b.travel || compareIds(a.c.id, b.c.id))
    .slice(0, COVER_CITIES);
  for (const { c } of covers) {
    const n = wanting(Math.floor((countOf(p.homeOf(c.id), defender) * HOLD_SHARE_PM) / 1000));
    if (n <= 0) break;
    if (n < MIN_SUPPORT) continue;
    sent += sendSupport(p, c, tg.row.id, island, { [defender]: n });
  }
  return sent;
}

/** The owner's morale (‰) when it attacks the seat (a relief of its city, the seat its foe). */
function moraleOf(w: World, owner: PlayerId): number {
  const h = w.hints.combat?.morale;
  const per = configInt(w.kit, h?.perCity);
  const floor = configInt(w.kit, h?.floor);
  if (per === null || per <= 0) return 1000;
  let theirs = 0;
  for (const c of w.map?.cities ?? []) if (c.owner === owner) theirs += 1;
  const mine = w.cities.length + holdCities(w).size;
  return Math.max(floor ?? 0, Math.min(1000, 1000 - per * (theirs - mine)));
}

/** The attack a relief of `row` may bring, and whether a spy report backs it. */
interface Relief {
  readonly attack: number;
  readonly known: boolean;
}

/**
 * The attack the owner of `row` can send against a siege there: the attackers at home in its other
 * cities on their last spy report (grown with its age; a city without a report younger than a day
 * at `RELIEF_PRIOR`), its `RELIEF_CITIES` strongest, after its morale against the seat.
 */
function reliefOf(p: Planner, prm: Conqueror3Params, row: CityRow): Relief {
  const { w } = p;
  const kit = w.kit;
  const owner = row.owner;
  if (owner === null) return { attack: 0, known: false };
  const prior = RELIEF_PRIOR.base + Math.floor((RELIEF_PRIOR.perDay * w.t) / DAY);
  const per: number[] = [];
  let known = false;
  for (const o of w.map?.cities ?? []) {
    if (o.owner !== owner || o.id === row.id || besiegedRow(w, o)) continue;
    const view = w.views.get(o.id);
    const intel = view?.access === "public" ? view.intel : null;
    const age = intel === null || intel === undefined ? null : Math.max(0, w.t - intel.at[0]);
    if (intel?.type === "spy_report" && age !== null && age <= RELIEF_STALE) {
      const seen = power(kit, unitsInReport(kit, intel.data), "attack", true);
      per.push(seen + Math.floor((seen * prm.growthPm * Math.floor(age / 3600)) / 1000));
      known = true;
    } else {
      per.push(prior);
    }
  }
  const top = per
    .toSorted((a, b) => b - a)
    .slice(0, RELIEF_CITIES)
    .reduce((a, x) => a + x, 0);
  return { attack: Math.floor((top * moraleOf(w, owner)) / 1000), known };
}

/** The garrison defense a siege of `row` needs against `relief` (two founders survive a narrower loss). */
function holdNeed(prm: Conqueror3Params, relief: number, founders: number): number {
  const pm = founders >= 2 ? Math.floor((prm.holdPm * 5) / 6) : prm.holdPm;
  return Math.floor((relief * pm) / 1000);
}

/**
 * The defense the seat could station in a siege of `tg` landing at `lands` from `from`: its island's
 * defenders (the forge city keeps half) and `HOLD_SHARE_PM` of those of the cities whose support
 * lands within `COVER_AFTER` (not under attack), behind the city's base defense and breached wall.
 */
function garrisonPotential(
  p: Planner,
  prm: Conqueror3Params,
  from: OwnCity,
  tg: Target,
  lands: number,
): number {
  const { w } = p;
  const kit = w.kit;
  const defender = kit.roles.defender;
  if (defender === null) return 0;
  const per = kit.units.get(defender)?.defense ?? 0;
  const forge = forgeCity(w)?.id;
  let units = 0;
  for (const c of w.cities) {
    if (c.blocked) continue;
    const t = w.travel(c.id, tg.row.island, false);
    if (t === null) continue;
    const have = countOf(p.homeOf(c.id), defender);
    if (c.island === from.island && w.t + t === lands) {
      units += (c.id === forge ? Math.floor(have / 2) : have) * per;
    } else if (w.t + t <= lands + COVER_AFTER && !underAttack(w, c.id)) {
      units += Math.floor((have * HOLD_SHARE_PM) / 1000) * per;
    }
  }
  return heldDefense(p, prm, tg.row, units);
}

/** Adds `attack` to the attack sent at `city` by its current strike (`dk`). */
function addStrike(p: Planner, city: CityId, attack: number): void {
  if (attack > 0) p.setFlag(`dk${city}`, (p.flag(`dk${city}`) ?? 0) + attack);
}

/**
 * Launches `waves` in order, then the garrison and the covering supports (`garrisonAndCover`); true
 * when the founders' wave left. The attack sent (after morale `m`) is added to the strike's `dk`.
 */
function launch(
  p: Planner,
  prm: Conqueror3Params,
  tg: Target,
  waves: readonly Wave[],
  m: number,
): boolean {
  const kit = p.w.kit;
  if (p.attacksLeft < waves.length) return false;
  let sent = false;
  let strength = 0;
  for (const x of waves) {
    if (!p.attack(x.from, tg.row.id, x.units)) continue;
    strength += x.strength;
    if (countOf(x.units, kit.roles.founder) > 0) sent = true;
  }
  const lead = waves.at(-1);
  if (sent && lead !== undefined) {
    const founders = countOf(lead.units, kit.roles.founder);
    const relief = reliefOf(p, prm, tg.row);
    const need = holdNeed(prm, relief.attack, founders);
    const cover = garrisonAndCover(p, prm, lead.from, tg, p.w.t + lead.travel, need);
    if (cover > 0)
      p.summary.push(`${tg.row.id}: garrison D${cover} follows (relief A${relief.attack})`);
  }
  addStrike(p, tg.row.id, Math.floor((strength * m) / 1000));
  return sent;
}

/**
 * True when the seat can count on an own wake at `at`: on a later game day, or when today's own
 * wakes left cover what will wake it before, the wake at `at` and `TRAIN_SPARE`.
 */
function wakeFor(p: Planner, at: number): boolean {
  const { w } = p;
  if (at >= (w.day + 1) * DAY) return true;
  return ownWakesBefore(p, at) + 1 + TRAIN_SPARE <= w.briefing.budget.ownWakesLeft;
}

/**
 * A conquest of `tg` (conqueror@1's `strike`, with this version's launch and defense): the waves of
 * the founders' island in one second when they suffice; otherwise a train, helpers from islands 10
 * min to 2 h farther leaving now and the founders' island's waves timed to land a minute after them.
 * True when the founders' wave left or a train was planned.
 */
function strike(p: Planner, prm: Conqueror3Params, tg: Target, d: Defense, foes: number): boolean {
  const { w } = p;
  const kit = w.kit;
  const m = moraleAgainst(w, foes);
  const eff = (strength: number): number => Math.floor((strength * m) / 1000);
  const open = opensAt(w, tg.row);
  const island = tg.row.island;
  const f = founderCity(p, island);
  const travel = f === null ? null : w.travel(f.id, island, false);
  if (f === null || travel === null) return false;
  if (travel > MAX_FLIGHT) {
    p.summary.push(`${tg.row.id}: founders too far (${Math.floor(travel / 60)} min)`);
    return false;
  }
  if (w.t + travel < open) {
    p.wakeAt(open - travel);
    return false;
  }
  const now = assault(p, prm, tg, d, m, [], false);
  if (now !== null) {
    p.clearFlag(`dk${tg.row.id}`);
    return launch(p, prm, tg, now, m);
  }
  const helpers = w.cities
    .map((c) => allAttackers(p, c, island))
    .filter(
      (x): x is Wave =>
        x !== null &&
        countOf(x.units, kit.roles.attacker) >= prm.minAttackers &&
        x.travel >= travel + 600 &&
        x.travel <= Math.min(travel + TRAIN_WINDOW, MAX_FLIGHT),
    )
    .toSorted(
      (a, b) => b.strength - a.strength || a.travel - b.travel || compareIds(a.from.id, b.from.id),
    );
  const chosen: Wave[] = [];
  for (const h of helpers) {
    if (chosen.length >= TRAIN_MAX) break;
    chosen.push(h);
    const sorted = chosen.toSorted((a, b) => b.travel - a.travel);
    const earlier = sorted.map((x) => eff(x.strength));
    const landing = Math.max(...chosen.map((x) => w.t + x.travel));
    const late = defenseAt(p, prm, tg.row, landing + 60 - w.t, chosen.length + 1) ?? d;
    if (assault(p, prm, tg, late, m, earlier, false) === null) continue;
    const n = cityNumber(tg.row.id);
    if (landing < open || p.attacksLeft < chosen.length + 2 || n === null) return false;
    if (!wakeFor(p, landing + 60 - travel)) {
      p.summary.push(`${tg.row.id}: train waits for own wakes`);
      return false;
    }
    p.clearFlag(`dk${tg.row.id}`);
    for (const x of sorted) {
      if (p.attack(x.from, tg.row.id, x.units)) addStrike(p, tg.row.id, eff(x.strength));
    }
    p.setFlag("at", n);
    p.setFlag("aw", landing + 60);
    p.wakeAt(landing + 60 - travel);
    p.memo(`train ${tg.row.id} ${fmtTime(landing + 60)}`);
    return true;
  }
  return false;
}

/**
 * The strike; when it plans a train, the defense planned on and the time are remembered (`ae`,
 * `ap`) and a spy leaves to check it before the timed launch.
 */
function strikeChecked(
  p: Planner,
  prm: Conqueror3Params,
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
function checkSpy(p: Planner, prm: Conqueror3Params, tg: Target): void {
  const { w } = p;
  const kit = w.kit;
  if (p.inFlight("spy", tg.row.id) || (wakesInHand(p) < 1 && !wakesLeft(p, 1))) return;
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

/** True when the own wakes left today cover what will wake the seat anyway and `extra` more. */
function wakesLeft(p: Planner, extra: number): boolean {
  const { w } = p;
  return ownWakesBefore(p, (w.day + 1) * DAY) + extra < w.briefing.budget.ownWakesLeft;
}

/** Drops a planned train's flags. */
function dropTrain(p: Planner): void {
  for (const f of ["at", "aw", "ae", "ap", "aj"]) p.clearFlag(f);
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
 * Launches the founders' island's waves of a planned train (or joint strike) once their time has
 * come, unless fresher intel says it fails: a spy report newer than the plan that shows more than
 * `abortPm` of the defense planned on, or with which the waves no longer win, or the failure of the
 * check spy. A joint strike (`aj`) launches only when its own waves win on the latest estimate (the
 * allies' strikes are a bonus, never counted on); a train whose helpers left commits on older intel.
 * A strike called off recalls the helpers still in their recall window and cancels its war call.
 */
function trainStep(
  p: Planner,
  prm: Conqueror3Params,
  victim: PlayerId | null,
  book: WarEntry[],
): void {
  const { w } = p;
  const tc = p.flag("at") ?? 0;
  const ta = p.flag("aw") ?? 0;
  const joint = p.flag("aj") ?? 0;
  if (tc <= 0) return;
  const id: CityId = `c${tc}`;
  const row = w.map?.cities.find((c) => c.id === id);
  const cancel = (why: string): void => {
    if (joint > 0) {
      cancelCall(p, book, warId(joint), why);
      p.setFlag("jx", w.t);
    }
    dropTrain(p);
  };
  if (row === undefined || row.owner !== victim || besiegedRow(w, row) || w.t > ta + TRAIN_EXPIRY) {
    cancel(row === undefined || row.owner !== victim ? "target changed" : "target besieged");
    return;
  }
  const f = founderCity(p, row.island);
  const travel = f === null ? null : w.travel(f.id, row.island, false);
  if (f === null || travel === null) {
    cancel("no founder");
    return;
  }
  if (w.t + travel < ta) {
    p.wakeAt(ta - travel);
    return;
  }
  const foes = w.map?.cities.filter((c) => c.owner === victim).length ?? 1;
  const helpers = p.flag(`dk${id}`) ?? 0;
  const d = defenseAt(p, prm, row, travel, joint > 0 ? 1 : 2) ?? NO_DEFENSE;
  const tg: Target = { row, besieged: false, travel };
  const m = moraleAgainst(w, foes);
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
  const commit = joint === 0 && helpers > 0 && !newer;
  const waves = assault(p, prm, tg, d, m, helpers > 0 ? [helpers] : [], commit);
  // A siege its owner's known army would relieve is not started (as in `offense`); a train whose
  // helpers already left goes on, its waves being on their way anyway.
  const relief = reliefOf(p, prm, row);
  const need = holdNeed(
    prm,
    relief.attack,
    Math.min(prm.founders, countOf(p.homeOf(f.id), w.kit.roles.founder)),
  );
  const hold = garrisonPotential(p, prm, f, tg, w.t + travel);
  let why: string | null = null;
  if (failed) why = "spy failed";
  else if (helpers === 0 && travel > MAX_FLIGHT) why = "founders too far";
  else if (helpers === 0 && relief.known && hold < need) why = `would not hold (D${hold})`;
  else if (newer && estimate > 0 && defenseValue(d) * 1000 > estimate * prm.abortPm) {
    why = `D${defenseValue(d)} vs D${estimate}`;
  } else if (waves === null) why = `D${defenseValue(d)}: short`;
  if (why !== null) {
    recallTrain(p, id);
    p.memo(`${joint > 0 ? "joint" : "train"} ${id} called off ${fmtTime(w.t)}: ${why}`);
    p.clearFlag(`dk${id}`);
    cancel(why);
    return;
  }
  if (waves !== null && launch(p, prm, tg, waves, m)) p.setFlag("ac", 1);
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

/** Age (s) of the latest spy report on `city`, or null without one. */
function spyAge(w: World, city: CityId): number | null {
  const view = w.views.get(city);
  if (view?.access !== "public" || view.intel?.type !== "spy_report") return null;
  return Math.max(0, w.t - view.intel.at[0]);
}

/**
 * conqueror@2's offense over this version's targets: spies the victim's cities whose intel is
 * missing or stale, strikes the first that is ready, and has the first the army could break hold the
 * founders. A strike waits for a spy report younger than `fresh` (one leaves for it); a strike on a
 * capital or a strong city waits for the allies in reach (`jointStrike`).
 */
function offense(
  p: Planner,
  prm: Conqueror3Params,
  ctx: Context,
  victim: PlayerId | null,
  strikes: boolean,
  book: WarEntry[],
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
    // The waves fly from the founders' city (the nearest city may be another): the defense is weighed
    // for that flight, every support that lands sooner included.
    const lead = founderCity(p, tg.row.island);
    const flight = (lead === null ? null : w.travel(lead.id, tg.row.island, false)) ?? tg.travel;
    const d = defenseAt(p, prm, tg.row, flight);
    const stale = d === null || d.age > prm.stale;
    const age = spyAge(w, tg.row.id);
    const young = age !== null && age <= prm.fresh;
    // A city never spied counts at the prior: a spy on it may lead to a strike when the army would
    // break that.
    const prior = priorDefense(w, tg.row, p.memory.x);
    const guess: Defense = d ?? { ...NO_DEFENSE, units: prior, age: prm.stale + 1 };
    const strikable = armyBreaks(p, { ...prm, marginPm: STRIKE_PM }, tg, guess, foes);
    // A city the army could strike on older intel is spied again before the strike (its report wakes
    // the seat, and the strike leaves then); the others only when their intel is stale.
    const due = stale || (strikable && !young);
    const spyable =
      w.t + 2 * 3600 >= kit.rules.time.attackFrom &&
      (wakesInHand(p) >= 1 || ((strikable || early(w)) && wakesLeft(p, 1)));
    let checking = p.inFlight("spy", tg.row.id);
    if (due && !train && spies < 2 && spyable && spyOn(p, prm, tg, view)) {
      spies += 1;
      checking = true;
    }
    // A strike that only the support counted at a prior forbids: a spy on that support's city.
    if (d !== null && young && !strikable && !train && spies < 2 && wakesLeft(p, 1)) {
      const bare = defenseAt(p, prm, tg.row, flight, 0);
      const blind = blindSupport(p, tg.row, flight);
      const bv = blind === null ? undefined : w.views.get(blind.id);
      const could = bare !== null && armyBreaks(p, { ...prm, marginPm: STRIKE_PM }, tg, bare, foes);
      if (could && blind !== null && bv !== undefined && !p.inFlight("spy", blind.id)) {
        const reach = reachOf(w, [blind]) ?? tg.travel;
        if (spyOn(p, prm, { row: blind, besieged: false, travel: reach }, bv)) {
          spies += 1;
          p.summary.push(`spy ${blind.id}: support for ${tg.row.id}`);
        }
      }
    }
    const breaks = d !== null && armyBreaks(p, prm, tg, d, foes);
    // On intel older than `fresh`, the strike waits for the spy on its way; without one (no own wake
    // to spare for its report), it leaves on intel within `stale`, as conqueror@2's did.
    const intel = young || (!checking && !stale);
    const ready = breaks && intel && attackOpen && w.t + tg.travel >= open;
    const text = d === null ? label : `${label} D${defenseValue(d)}`;
    seen.push({ tg, label: text, taken, d, breaks, ready });
  }

  const wanted: IslandId[] = [];
  let hold = train;
  const trainTarget = w.map?.cities.find((c) => c.id === `c${p.flag("at") ?? 0}`);
  let holding: IslandId | null = train ? (trainTarget?.island ?? null) : null;
  for (const x of seen) {
    if (x.taken) continue;
    if (x.d === null) {
      if (!x.tg.besieged) p.summary.push(`${x.label}: no intel`);
      continue;
    }
    if (!x.breaks) {
      p.summary.push(`${x.label}: too strong`);
      continue;
    }
    if (!armyBreaks(p, { ...prm, marginPm: STRIKE_PM }, x.tg, x.d, foes)) {
      p.summary.push(`${x.label}: army gathering`);
      hold = true;
      continue;
    }
    // A siege the owner would relieve is not started: its founders and garrison would be lost. The
    // garrison is weighed from the founders' city, or the nearest city before a founder is there.
    const f = founderCity(p, x.tg.row.island);
    const lead = f ?? nearestCity(w, x.tg.row.island);
    const flight = lead === null ? null : w.travel(lead.id, x.tg.row.island, false);
    if (lead !== null && flight !== null) {
      const relief = reliefOf(p, prm, x.tg.row);
      const founders = Math.max(
        1,
        Math.min(prm.founders, countOf(p.homeOf(lead.id), kit.roles.founder)),
      );
      const need = holdNeed(prm, relief.attack, founders);
      const can = garrisonPotential(p, prm, lead, x.tg, w.t + flight);
      if (relief.known && can < need) {
        p.summary.push(`${x.label}: would not hold (D${can} vs relief A${relief.attack})`);
        continue;
      }
    }
    const free = f !== null;
    if (strikes && !free && !wanted.includes(x.tg.row.island)) {
      wanted.push(x.tg.row.island);
      p.summary.push(`${x.label}: founder wanted (k${w.self?.private?.settler.k ?? 0})`);
    }
    const now = strikes && !hold && x.ready && free;
    if (strikes && !hold && free) holding = x.tg.row.island;
    hold = true;
    if (!now) {
      if (strikes && free && !x.ready) p.summary.push(`${x.label}: waiting for intel`);
      continue;
    }
    if (jointStrike(p, prm, ctx, x.tg, x.d, foes, book) || strikeChecked(p, prm, x.tg, x.d, foes)) {
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
  prm: Conqueror3Params,
  opts: readonly Option[],
  victim: PlayerId | null,
): void {
  const { w } = p;
  const kit = w.kit;
  if (w.t + 2 * 3600 < kit.rules.time.attackFrom || trainWaits(p)) return;
  if (wakesInHand(p) < SCOUT_HAND) return;
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

// Sieges.

/** The land defense of `units` held in `row` (the city's base defense and wall from the latest intel). */
function heldDefense(p: Planner, prm: Conqueror3Params, row: CityRow, units: number): number {
  const view = p.w.views.get(row.id);
  const d = view === undefined ? null : defenseOf(p.w, view, prm.growthPm, 0);
  if (d === null) return units;
  return defenseValue(d, units, Math.max(0, d.wall - 1));
}

/** The attack a movement from `from` may bring: its origin's last spy report, or null. */
function attackFromIntel(w: World, from: CityId | null): number | null {
  if (from === null) return null;
  const view = w.views.get(from);
  if (view === undefined || view.access !== "public" || view.intel?.type !== "spy_report") {
    return null;
  }
  return power(w.kit, unitsInReport(w.kit, view.intel.data), "attack", true);
}

/**
 * Holds the seat's sieges. On the first turn of a siege, defenders from the nearest city (half of
 * them), as conqueror@1. Against each attack on its way to a siege (a relief or a homecoming), the
 * garrison is raised before it lands: the attack is assumed to be at least what its origin's last
 * spy report shows and at least `RELIEF_PM` of the garrison's defense then (a relief is launched to
 * win), and the garrison is raised to `holdPm` of it (5/6 of that with two founders, which survive a
 * narrower loss), with up to `HOLD_SHARE_PM` of the defenders of the cities whose support lands
 * first, nearest first. When even every one of them leaves the garrison short of the attack itself,
 * the garrison is called home: the siege is lost, its units are not.
 */
function holdSieges(p: Planner, prm: Conqueror3Params): void {
  const { w } = p;
  const kit = w.kit;
  const { defender, founder } = kit.roles;
  if (defender === null) return;
  const recall = kit.rules.movement.recall.stationed !== "none";
  const inbound = new Map<CityId, { arrive: number; defense: number }[]>();
  for (const m of w.self?.private?.movements ?? []) {
    if (m.owner !== w.seat || m.kind !== "support" || m.to === null || m.units === undefined)
      continue;
    const list = inbound.get(m.to) ?? [];
    list.push({ arrive: m.arrive[0], defense: power(kit, m.units, "defense", true) });
    inbound.set(m.to, list);
  }
  for (const [city, garrison] of holdCities(w)) {
    const row = w.map?.cities.find((c) => c.id === city);
    if (row === undefined) continue;
    const fresh = p.flag(`gr${city}`) === null;
    const threats = w.briefing.incoming
      .filter((i) => i.to === city && i.kind === "attack" && i.arrive[0] > w.t)
      .filter((i) => !p.handled(`w${i.id}`))
      .toSorted((a, b) => a.arrive[0] - b.arrive[0] || compareIds(a.id, b.id));
    const units = power(kit, garrison, "defense", true);
    if (fresh) {
      // The garrison left with the strike was sized to the relief expected; what it lacks now (its
      // losses, a relief seen stronger since) comes from the nearest city.
      p.setFlag(`gr${city}`, w.t);
      const all = (inbound.get(city) ?? []).reduce((a, x) => a + x.defense, 0);
      const need = holdNeed(prm, reliefOf(p, prm, row).attack, countOf(garrison, founder));
      const short = need - heldDefense(p, prm, row, units + all);
      if (threats.length === 0 && short > 0) {
        reinforce(p, row, Number.MAX_SAFE_INTEGER, 500, 1, short);
      }
    }
    if (threats.length === 0) continue;
    const first = threats[0]!.arrive[0];
    const coming = (inbound.get(city) ?? [])
      .filter((x) => x.arrive < first)
      .reduce((a, x) => a + x.defense, 0);
    const now = heldDefense(p, prm, row, units + coming);
    let worst = Math.floor((now * RELIEF_PM) / 1000);
    let known = 0;
    for (const i of threats) {
      const intel = attackFromIntel(w, i.from);
      if (intel === null) continue;
      const a = Math.floor((intel * moraleOf(w, i.by)) / 1000);
      known = Math.max(known, a);
      worst = Math.max(worst, a);
    }
    const need = holdNeed(prm, worst, countOf(garrison, founder));
    for (const i of threats) p.markHandled(`w${i.id}`);
    if (now >= need) continue;
    const added = reinforce(p, row, first, HOLD_SHARE_PM, HOLD_CITIES, need - now);
    const after = heldDefense(p, prm, row, units + coming + added);
    p.summary.push(`${city}: relief due ${fmtTime(first)}, held D${after} vs A≥${worst}`);
    if (known === 0 || after * 1000 >= known * 1000 || !recall) continue;
    // A relief its origin's spy report shows stronger than every helper can make the garrison wins
    // outright: the siege is lost, its units need not be.
    p.recallStationed(city);
    p.memo(`gave up ${city} ${fmtTime(w.t)}: D${after} vs A${known}`);
  }
}

/**
 * Supports for a siege of `row` from the seat's cities whose support lands before `before`, nearest
 * first, at most `cities` of them, each sending `sharePm` of its defenders (fewer once `want`
 * defense is sent, when given). Returns the defense sent (before the city's base and wall).
 */
function reinforce(
  p: Planner,
  row: CityRow,
  before: number,
  sharePm: number,
  cities: number,
  want: number | null = null,
): number {
  const { w } = p;
  const kit = w.kit;
  const defender = kit.roles.defender;
  if (defender === null) return 0;
  const per = Math.max(1, kit.units.get(defender)?.defense ?? 1);
  const helpers = w.cities
    .filter((c) => !c.blocked && !underAttack(w, c.id))
    .map((c) => ({ c, travel: w.travel(c.id, row.island, false) }))
    .filter((x): x is { c: OwnCity; travel: number } => x.travel !== null)
    .filter((x) => w.t + x.travel < before)
    .toSorted((a, b) => a.travel - b.travel || compareIds(a.c.id, b.c.id))
    .slice(0, cities);
  let sent = 0;
  for (const { c } of helpers) {
    let n = Math.floor((countOf(p.homeOf(c.id), defender) * sharePm) / 1000);
    if (want !== null) {
      // The garrison's defense counts the city's wall bonus: a defender adds about its defense.
      const left = Math.max(0, want - sent);
      n = Math.min(n, Math.ceil(left / per) + 1);
    }
    if (n <= 0) continue;
    sent += sendSupport(p, c, row.id, row.island, { [defender]: n });
    if (want !== null && sent >= want) break;
  }
  return sent;
}

/**
 * Calls home the seat's supports stationed in a city that is neither its own nor an ally's, once no
 * attack of the seat is on its way there: the garrison of a strike that failed (it stands aside
 * there, and would defend that city against anyone else).
 */
function recallStrays(p: Planner): void {
  const { w } = p;
  const done = new Set<CityId>();
  for (const s of w.self?.private?.stationed ?? []) {
    if (s.role !== "support" || done.has(s.city) || p.inFlight("attack", s.city)) continue;
    const row = w.map?.cities.find((c) => c.id === s.city);
    if (row === undefined || row.owner === null || row.owner === w.seat) continue;
    if (w.relations.get(row.owner) === "ally") continue;
    p.recallStationed(s.city);
    done.add(s.city);
  }
}

// War calls.

/** The seat's next call id (`wq`, a counter in the notes). */
function nextCallId(p: Planner): { id: string; n: number } {
  const n = (p.flag("wq") ?? 0) + 1;
  p.setFlag("wq", n);
  return { id: warId(n), n };
}

/**
 * Allies with a city that could reach `row` within `JOINT_REACH` (map distance at the seat's pace),
 * with the travel of their nearest city, by id.
 */
function alliesInReach(w: World, ctx: Context, row: CityRow): { q: PlayerId; travel: number }[] {
  const pace = seaPace(w);
  const out = new Map<PlayerId, number>();
  for (const o of w.map?.cities ?? []) {
    if (o.owner === null || !ctx.allies.includes(o.owner)) continue;
    const t = islandTravel(w, pace, o.island, row.island);
    if (t === null || t > JOINT_REACH) continue;
    out.set(o.owner, Math.min(out.get(o.owner) ?? t, t));
  }
  return [...out].map(([q, travel]) => ({ q, travel })).toSorted((a, b) => compareIds(a.q, b.q));
}

/** True when `q` left the seat's last strike call unanswered within `DEAF_FOR` (`wd<seat>`). */
function deaf(p: Planner, q: PlayerId): boolean {
  const n = seatNumber(q);
  const at = n === null ? null : p.flag(`wd${n}`);
  return at !== null && p.w.t - at < DEAF_FOR;
}

/**
 * Once the window of one of the seat's own strike calls has passed: each ally that gave no answer is
 * not waited for again within `DEAF_FOR` (`wd<seat>`); one that answered is waited for again.
 */
function markDeaf(p: Planner, ctx: Context, book: readonly WarEntry[]): void {
  const { w } = p;
  for (const e of book) {
    if (e.from !== w.seat || e.call.role !== "strike" || e.call.t1 > w.t) continue;
    if (p.handled(`wk${e.call.id}`)) continue;
    p.markHandled(`wk${e.call.id}`);
    for (const q of ctx.allies) {
      const n = seatNumber(q);
      if (n === null) continue;
      if (Object.hasOwn(e.answers, q)) p.clearFlag(`wd${n}`);
      else p.setFlag(`wd${n}`, w.t);
    }
  }
  for (const [name, at] of Object.entries(p.memory.x)) {
    if (/^wd[1-9][0-9]*$/.test(name) && w.t - at >= DEAF_FOR) p.clearFlag(name);
  }
}

/** Rounds `t` up to the next multiple of 300 s (clock times people read). */
const roundUp = (t: number): number => Math.ceil(t / 300) * 300;

/**
 * A strike on a capital or on a city of `JOINT_DEFENSE` or more waits for the seat's allies in reach:
 * a `strike` call to all of them names a window ending a few minutes before the seat's founders
 * land, at least `JOINT_LEAD` from now; the founders' island's waves leave at a timed wake (a train
 * without helpers of its own, `aj`), weighed again then (`trainStep`). A spy leaves to land before
 * that wake. False when the strike does not wait (no ally in reach, no message to spare, a call of
 * the seat still open, or the wake not affordable).
 */
function jointStrike(
  p: Planner,
  prm: Conqueror3Params,
  ctx: Context,
  tg: Target,
  d: Defense,
  foes: number,
  book: WarEntry[],
): boolean {
  const { w } = p;
  const row = tg.row;
  const strong = row.capitalOf !== null || defenseValue(d) >= JOINT_DEFENSE;
  if (!strong || ctx.allies.length === 0 || !mayMessage("call", p.messagesLeft)) return false;
  if (book.some((e) => e.from === w.seat && e.state === "sent" && e.call.t1 + 3600 > w.t)) {
    return false;
  }
  const off = p.flag("jx");
  if (off !== null && w.t - off < JOINT_COOLDOWN) return false;
  // Allies that left the seat's last strike call unanswered are not waited for (`wd<seat>`).
  const reach = alliesInReach(w, ctx, row).filter((x) => !deaf(p, x.q));
  const allies = reach.map((x) => x.q);
  const f = founderCity(p, row.island);
  const travel = f === null ? null : w.travel(f.id, row.island, false);
  const n = cityNumber(row.id);
  if (allies.length === 0 || f === null || travel === null || n === null) return false;
  if (p.attacksLeft < 3 || travel > MAX_FLIGHT) return false;
  // The allies hear the call at their next wake and leave at a wake of theirs: their farthest
  // travel and half an hour come before the window.
  const farthest = Math.max(...reach.map((x) => x.travel));
  const lands = roundUp(w.t + Math.max(travel, JOINT_LEAD, farthest + 1800 + JOINT_WINDOW)) + 120;
  const launchAt = lands - travel;
  if (lands < opensAt(w, row) || !wakeFor(p, launchAt)) return false;
  // The seat's own waves must still win then, without counting on the allies.
  const late = defenseAt(p, prm, row, lands - w.t) ?? d;
  if (assault(p, prm, tg, late, moraleAgainst(w, foes), [], false) === null) return false;
  const { id, n: seq } = nextCallId(p);
  const t1 = lands - 120;
  const t0 = t1 - JOINT_WINDOW;
  const callText = composeCall({
    id,
    role: "strike",
    target: row.id,
    t0,
    t1,
    vs: row.owner,
    lands,
  });
  if (!p.message(allies, callText)) return false;
  book.push({
    from: w.seat,
    call: { id, role: "strike", target: row.id, t0, t1, vs: null, lands: null },
    state: "sent",
    at: lands,
    answers: {},
  });
  p.setFlag("at", n);
  p.setFlag("aw", lands);
  p.setFlag("aj", seq);
  p.setFlag("ae", defenseValue(d));
  p.setFlag("ap", w.t);
  p.wakeAt(launchAt);
  const fly = spyTravel(w, row.island);
  if (fly !== null && w.t + fly + 600 < launchAt) checkSpy(p, prm, tg);
  p.memo(`joint ${row.id} ${fmtTime(lands)} with ${allies.join(",")}`);
  p.summary.push(`${row.id}: joint strike called (${id}, ${foes} cities)`);
  return true;
}

/** Cancels the seat's own call `id` to its allies, when it is still open and a message can go. */
function cancelCall(p: Planner, book: WarEntry[], id: string, why: string): void {
  const { w } = p;
  const i = book.findIndex((e) => e.from === w.seat && e.call.id === id && e.state === "sent");
  if (i < 0) return;
  const e = book[i]!;
  book[i] = { ...e, state: "cancelled" };
  const allies = [...w.relations.entries()]
    .filter(([, k]) => k === "ally")
    .map(([q]) => q)
    .toSorted(compareIds);
  if (allies.length > 0 && e.call.t1 > w.t && mayMessage("cancel", p.messagesLeft)) {
    p.message(allies, composeCancel(id, why));
  }
}

/**
 * Once per siege, when the seat has allies: a `siege` call asking them to hold the city once it
 * falls, landing from `SIEGE_CALL_AFTER` after the siege's end (`gw<city>`).
 */
function callSiegeHelp(p: Planner, ctx: Context, book: WarEntry[]): void {
  const { w } = p;
  if (ctx.allies.length === 0) return;
  for (const city of holdCities(w).keys()) {
    if (p.flag(`gw${city}`) !== null) continue;
    const row = w.map?.cities.find((c) => c.id === city);
    const ends = siegeEnds(w, city);
    if (row === undefined || ends === null || ends <= w.t) continue;
    p.setFlag(`gw${city}`, w.t);
    const allies = alliesInReach(w, ctx, row).map((x) => x.q);
    if (allies.length === 0 || !mayMessage("call", p.messagesLeft)) continue;
    const { id } = nextCallId(p);
    const t0 = roundUp(ends + SIEGE_CALL_AFTER);
    const t1 = t0 + SIEGE_CALL_SPAN;
    const text = composeCall({
      id,
      role: "siege",
      target: city,
      t0,
      t1,
      vs: row.owner,
      lands: null,
    });
    if (!p.message(allies, text)) continue;
    book.push({
      from: w.seat,
      call: { id, role: "siege", target: city, t0, t1, vs: null, lands: null },
      state: "sent",
      at: null,
      answers: {},
    });
  }
}

/** The value at `path` in a city's public extras, or undefined. */
function extAt(ext: JsonObject | undefined, path: readonly string[]): Json | undefined {
  let cur: Json | undefined = ext;
  for (const key of path) {
    if (cur === undefined || cur === null || typeof cur !== "object" || Array.isArray(cur)) {
      return undefined;
    }
    if (!Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** The siege end of `city` from its public extras (hints: a time or a `[time, text]` pair), or null. */
function siegeEnds(w: World, city: CityId): number | null {
  const path = w.hints.siege?.ends;
  const row = w.map?.cities.find((c) => c.id === city);
  if (path === undefined || row === undefined) return null;
  const v = extAt(row.ext, path);
  const raw = Array.isArray(v) ? v[0] : v;
  return typeof raw === "number" && Number.isSafeInteger(raw) ? raw : null;
}

/**
 * Answers its allies' calls (`war.ts`): every open call is judged (`judgeWar`: never against itself,
 * an ally or a pact partner, never for a distrusted caller, in reach and with force enough), and the
 * best (`pickCall`: its own victim's cities first) is answered yes: a strike sends `warSharePm` of
 * the attackers of the cities that land in the window (at least `WAR_MIN_ATTACKERS`), a hold or a
 * siege that share of their defenders, now or at a timed wake (`yes` in the book). The others are
 * answered no while messages are plentiful, or left silent. Nothing while its own train waits.
 */
function respond(
  p: Planner,
  prm: Conqueror3Params,
  victim: PlayerId | null,
  book: WarEntry[],
): void {
  const { w } = p;
  const kit = w.kit;
  const attack = kit.roles.attacker === null ? 0 : (kit.units.get(kit.roles.attacker)?.attack ?? 0);
  const guard = kit.roles.defender === null ? 0 : (kit.units.get(kit.roles.defender)?.defense ?? 0);
  const answers = new Map<PlayerId, string[]>();
  const say = (to: PlayerId, text: string): void => {
    answers.set(to, [...(answers.get(to) ?? []), text]);
  };
  const busy = trainWaits(p);
  const distrust = new Set<PlayerId>();
  for (const [name, at] of Object.entries(p.memory.x)) {
    const m = /^ha([1-9][0-9]*)$/.exec(name);
    if (m !== null && w.t - at < DAY) distrust.add(bySeat(Number(m[1])));
  }
  const judged = new Map<string, { j: ReturnType<typeof judgeWar>; e: WarEntry }>();
  const cands: WarCandidate[] = [];
  for (const e of book) {
    if (e.from === w.seat || e.state !== "open") continue;
    const hits = e.call.role === "strike";
    const j = judgeWar(w, e.from, e.call, {
      sharePm: prm.warSharePm,
      minForce: hits ? WAR_MIN_ATTACKERS * attack : MIN_SUPPORT * guard,
      attacksLeft: p.attacksLeft,
      distrust,
    });
    judged.set(`${e.from}/${e.call.id}`, { j, e });
    const when = siegeLaunch(w, e, j.options[0]?.launch ?? null);
    if (j.verdict.accept && !busy && when !== null) {
      cands.push({ from: e.from, call: e.call, launch: when });
    }
  }
  const prefer = new Set<PlayerId>(victim === null ? [] : [victim]);
  const ownerOf = (c: CityId): PlayerId | null =>
    w.map?.cities.find((x) => x.id === c)?.owner ?? null;
  const pick = pickCall(cands, prefer, ownerOf);
  for (const [key, { j, e }] of judged) {
    const i = book.findIndex((x) => `${x.from}/${x.call.id}` === key);
    if (i < 0) continue;
    if (pick !== null && pick.from === e.from && pick.call.id === e.call.id) {
      if (!mayMessage("yes", p.messagesLeft)) continue;
      const opts = j.options;
      const lands = pick.launch.lands;
      book[i] = { ...e, state: "yes", at: pick.launch.at };
      say(e.from, composeAck(e.call.id, true, lands));
      if (pick.launch.at <= w.t) {
        const yes = book[i];
        if (yes !== undefined && answerCall(p, prm, yes, opts)) {
          book[i] = { ...yes, state: "sent", at: lands };
        }
      } else {
        p.wakeAt(pick.launch.at);
      }
      continue;
    }
    book[i] = { ...e, state: "no" };
    const unreachable =
      j.verdict.accept && siegeLaunch(w, e, j.options[0]?.launch ?? null) === null;
    const why = busy
      ? "busy"
      : unreachable
        ? "too far"
        : j.verdict.accept
          ? "other call"
          : j.verdict.why;
    if (mayMessage("no", p.messagesLeft)) say(e.from, composeAck(e.call.id, false, null, why));
  }
  // Calls answered yes whose launch has come; the others keep their launch's wake.
  for (const [i, e] of book.entries()) {
    if (e.from === w.seat || e.state !== "yes" || e.at === null) continue;
    if (e.at > w.t) {
      p.wakeAt(e.at);
      continue;
    }
    if (busy) {
      book[i] = { ...e, state: "no" };
      continue;
    }
    const j = judgeWar(w, e.from, e.call, {
      sharePm: prm.warSharePm,
      minForce: 1,
      attacksLeft: p.attacksLeft,
      distrust,
    });
    const ok = j.verdict.accept && answerCall(p, prm, e, j.options);
    book[i] = { ...e, state: ok ? "sent" : "no" };
    if (!ok && mayMessage("no", p.messagesLeft))
      say(e.from, composeAck(e.call.id, false, null, "cannot go"));
  }
  for (const [to, texts] of [...answers].toSorted((a, b) => compareIds(a[0], b[0]))) {
    p.message([to], joinWar(texts));
  }
}

/** A siege call's launch, never before the siege ends (a support to a besieged city is refused). */
function siegeLaunch(
  w: World,
  e: WarEntry,
  best: { at: number; lands: number } | null,
): { at: number; lands: number } | null {
  if (best === null || e.call.role !== "siege") return best;
  const ends = siegeEnds(w, e.call.target);
  if (ends === null || best.at >= ends) return best;
  const travel = best.lands - best.at;
  return launchTime(e.call, travel, w.t, {
    minDelay: w.kit.gateway.selfWake.min,
    earliest: ends + 60,
  });
}

/**
 * Sends what an accepted call asks from the cities whose launch is now: attackers for a strike (at
 * least `WAR_MIN_ATTACKERS` in all), defenders for a hold or a siege, each with its carriers. True
 * when something left.
 */
function answerCall(
  p: Planner,
  prm: Conqueror3Params,
  e: WarEntry,
  opts: readonly WarOption[],
): boolean {
  const { w } = p;
  const kit = w.kit;
  const target = warTarget(w, e.call.target);
  if (target === null) return false;
  const hits = e.call.role === "strike";
  const unit = hits ? kit.roles.attacker : kit.roles.defender;
  if (unit === null) return false;
  let left = 0;
  for (const o of opts) {
    if (o.launch.at > w.t) continue;
    const c = p.city(o.city);
    if (c === undefined || c.blocked) continue;
    const pop = Math.max(1, kit.units.get(unit)?.pop ?? 1);
    const want = Math.min(
      Math.floor((countOf(p.homeOf(c.id), unit) * prm.warSharePm) / 1000),
      Math.floor(p.liftCapacity(c, target.island) / pop),
    );
    if (want < (hits ? WAR_MIN_ATTACKERS : MIN_SUPPORT)) continue;
    const group = p.withCarriers(c, target.island, { [unit]: want });
    if (group === null) continue;
    if (hits) {
      if (!p.attack(c, target.id, group)) continue;
    } else {
      p.support(c, target.id, group);
    }
    left += 1;
  }
  if (left > 0) p.memo(`${e.call.role} ${e.call.target} for ${e.from} ${fmtTime(w.t)}`);
  return left > 0;
}

// Founders and army (as conqueror@2).

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

/** Carriers where founders are (at home or queued): enough to lift them with `minAttackers` attackers. */
function founderCarriers(p: Planner, prm: Conqueror3Params): void {
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

/** A city whose army cannot cross water asks for what unlocks its carriers, ahead of its economy. */
function harbors(p: Planner, prm: Conqueror3Params): void {
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

/** Once no free slot is in reach, one founder is kept in hand: the island of the victim's first target. */
function spareFounder(p: Planner, prm: Conqueror3Params, victim: PlayerId | null): IslandId[] {
  const { w } = p;
  const founder = w.kit.roles.founder;
  if (victim === null || slotInReach(p)) return [];
  if (w.cities.some((c) => countOf(p.homeOf(c.id), founder) + p.queued(c, founder) > 0)) return [];
  const first = victimTargets(p, prm, victim)[0];
  return first === undefined ? [] : [first.row.island];
}

// Diplomacy (as conqueror@2).

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
  // A player asked within `ASKED_FOR` is not asked again (it let the offer expire, or refused).
  const asked = (q: PlayerId): boolean => {
    const n = seatNumber(q);
    const at = n === null ? null : p.flag(`pd${n}`);
    return at !== null && w.t - at < ASKED_FOR;
  };
  const near = [...citiesByOwner(w)]
    .filter(([q]) => q !== victim && !ctx.rivals.has(q) && !w.relations.has(q) && !asked(q))
    .map(([q, rows]) => ({ q, reach: reachOf(w, rows) }))
    .filter((x): x is { q: PlayerId; reach: number } => x.reach !== null)
    .toSorted((a, b) => a.reach - b.reach || compareIds(a.q, b.q))
    .slice(0, NEIGHBOURS);
  // A war alliance is best with a player seen attacking (the public battle headlines, `f<seat>`).
  const fighter = (q: PlayerId): number => {
    const n = seatNumber(q);
    const seen = n === null ? null : p.flag(`f${n}`);
    return seen !== null && w.t - seen < ASKED_FOR ? 1 : 0;
  };
  const strongest = near.toSorted(
    (a, b) =>
      fighter(b.q) - fighter(a.q) ||
      (ctx.standings.get(b.q)?.score ?? 0) - (ctx.standings.get(a.q)?.score ?? 0) ||
      a.reach - b.reach ||
      compareIds(a.q, b.q),
  )[0];
  if (strongest === undefined) return;
  p.setFlag("dp", w.day + 1);
  const pn = seatNumber(strongest.q);
  if (pn !== null) p.setFlag(`pd${pn}`, w.t);
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

/** Drops this version's flags that no longer matter. */
function tidyMore(p: Planner): void {
  const { w } = p;
  const held = holdCities(w);
  for (const [name, value] of Object.entries(p.memory.x)) {
    if (/^scc[1-9][0-9]*$/.test(name) && w.t - value >= SCOUT_STALE) p.clearFlag(name);
    if (/^loc[1-9][0-9]*$/.test(name) && w.t - value >= RETAKE_FOR) p.clearFlag(name);
    if (/^fcc[1-9][0-9]*$/.test(name) && w.t - value >= DAY) p.clearFlag(name);
    if (/^(f|pd)[1-9][0-9]*$/.test(name) && w.t - value >= ASKED_FOR) p.clearFlag(name);
    const gw = /^gw(c[1-9][0-9]*)$/.exec(name);
    if (gw !== null && ![...held.keys()].some((c) => c === gw[1])) p.clearFlag(name);
  }
  if ((p.flag("jt") ?? 0) > 0 && w.t - (p.flag("jt") ?? 0) >= DAY) {
    p.clearFlag("jv");
    p.clearFlag("jt");
  }
  if ((p.flag("at") ?? 0) <= 0) {
    for (const f of ["ae", "ap", "aj"]) p.clearFlag(f);
  }
}

/** True when the victim's best city is worth a founder more than a free slot is. */
function conquestPays(p: Planner, opts: readonly Option[], victim: PlayerId | null): boolean {
  const best = opts.find((o) => o.q === victim) ?? null;
  return best !== null && Math.floor((best.ev * CONQUEST_PM) / 1000) >= slotEv(p);
}

/**
 * Founders found cities, except those a strike wants or holds (`HOLD_MAX` at most); a committed
 * campaign whose next strike could finish its victim keeps every founder. Conquest founders are
 * recruited for the strikes that want one, with the carriers to lift them.
 */
function foundersFor(p: Planner, prm: Conqueror3Params, victim: PlayerId | null, o: Offense): void {
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
 * The strike force (`EARLY_ATTACKERS`, then `ATTACKERS_PER_DAY` more a day once capitals can fall):
 * from 6 h before attacks open, once the seat has a second city or one on its way, the forge city
 * recruits attackers first while the seat owns fewer (at home, queued, stationed or moving).
 */
function strikeForce(p: Planner, sharePm: number): void {
  const { w } = p;
  const kit = w.kit;
  const attacker = kit.roles.attacker;
  const end = configInt(kit, w.hints.combat?.capitalImmunityEnd) ?? 2 * DAY;
  if (attacker === null || w.t + 6 * 3600 < kit.rules.time.attackFrom) return;
  const forge = forgeCity(w);
  const row = kit.units.get(attacker);
  if (forge === null || row === undefined || !p.canRecruit(forge, attacker)) return;
  const flying = Object.values(p.memory.f).reduce((a, etas) => a + etas.length, 0);
  if (w.cities.length + flying < 2) return;
  const floor =
    EARLY_ATTACKERS + (w.t < end ? 0 : Math.floor((ATTACKERS_PER_DAY * (w.t - end)) / DAY));
  let have = 0;
  for (const c of w.cities) have += countOf(c.units, attacker) + p.queued(c, attacker);
  for (const s of w.self?.private?.stationed ?? []) have += countOf(s.units, attacker);
  for (const m of w.self?.private?.movements ?? []) {
    if (m.owner === w.seat && m.units !== undefined) have += countOf(m.units, attacker);
  }
  const n = Math.min(
    floor - have,
    timesAffordable(pmRes(p.budgetOf(forge.id), sharePm), row.cost),
    Math.floor(p.popFreeOf(forge.id) / Math.max(1, row.pop)),
    row.maxPerOrder,
  );
  if (n >= EARLY_BATCH) p.recruit(forge, [{ unit: attacker, count: n }]);
  liftForce(p, forge);
}

/**
 * Carriers in `c` for its attackers and founders (at home and queued), so that the strike force can
 * cross water (the generic plan orders them in batches of six, `transports`), recruited where the
 * carriers' queue is free.
 */
function liftForce(p: Planner, c: OwnCity): void {
  const kit = p.w.kit;
  const { carrier, attacker, founder } = kit.roles;
  const row = carrier === null ? undefined : kit.units.get(carrier);
  if (carrier === null || row === undefined || row.capacity <= 0) return;
  if (!kit.rules.movement.transportRule || !p.canRecruit(c, carrier)) return;
  const pop = (u: string | null): number => (u === null ? 0 : (kit.units.get(u)?.pop ?? 0));
  const count = (u: string | null): number =>
    u === null ? 0 : countOf(c.units, u) + p.queued(c, u);
  const land = count(attacker) * pop(attacker) + count(founder) * pop(founder);
  const want = Math.ceil(land / row.capacity) - count(carrier);
  const n = Math.min(
    want,
    timesAffordable(p.budgetOf(c.id), row.cost),
    Math.floor(p.popFreeOf(c.id) / Math.max(1, row.pop)),
    row.maxPerOrder,
  );
  if (n > 0) p.recruit(c, [{ unit: carrier, count: n }]);
}

/** The army and the buildings, paced on the seat's own wakes (`pace.ts`), as conqueror@2. */
function grow(p: Planner, prm: Conqueror3Params): void {
  const forge = forgeCity(p.w)?.id ?? null;
  strikeForce(p, LATE_PM);
  harbors(p, prm);
  paceRecruits(p);
  p.units(undefined, (c) => c.id === forge);
  paceBuilds(p);
  p.economy((c) => storeAhead(p, c));
  transports(p, true);
  paceRecruits(p);
  p.units(undefined, (c) => c.id !== forge);
}

export const conqueror3: StrategyDef = Object.freeze<StrategyDef>({
  name: "conqueror",
  version: 3,
  preview: true,
  brain(rng) {
    const prm = conqueror3Params(rng);
    const knobs: Knobs = {
      cadence: randInt(rng, 5400, 7200),
      settle: true,
      maxCities: 64,
      producerBase: randInt(rng, 3, 4),
      producerPerDay: 2,
      wallBase: 0,
      wallPerDay: 0,
      spendPm: randInt(rng, 800, 900),
      mix: { defender: 2, attacker: 1, navy: 0 },
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
        const { w } = p;
        rememberAttackers(p);
        rememberLosses(p);
        rememberFoundings(p);
        watchFighters(p);
        hearAllies(p);
        const inbox = hearWar(w.briefing.msgs, w.seat, w.relations);
        const book = absorbWar(readBook(p.memory), inbox.heard, w.seat);
        const ctx = contextOf(p);
        const opts = options(p, prm, ctx);
        const victim = settleVictim(p, opts);
        tidy(p, victim);
        tidyMore(p);
        noteDefense(p, prm, victim);
        diplomacy(p, ctx, victim);
        recallStrays(p);
        holdSieges(p, prm);
        callSiegeHelp(p, ctx, book);
        p.supportThreatened();
        supportAllies(p);
        markDeaf(p, ctx, book);
        trainStep(p, prm, victim, book);
        respond(p, prm, victim, book);
        const o = offense(p, prm, ctx, victim, conquestPays(p, opts, victim), book);
        scout(p, prm, opts, victim);
        if (!trainWaits(p)) {
          // Before capitals can fall, the strike force is paid before the founders.
          if (early(w)) strikeForce(p, EARLY_PM);
          foundersFor(p, prm, victim, o);
          grow(p, prm);
        }
        p.memory = writeBook(p.memory, book, w.t);
      },
    };
  },
});
