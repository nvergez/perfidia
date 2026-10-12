// `rusher@2` (docs/architecture.md §11.2): a rush that lands when protection ends (perfidia-1
// §15.1, §15.2). rusher@1 (`rusher.ts`) stays registered unchanged; this is a new version (§11.1).
//
// Opening (before `attackFrom`): the main city builds only what the first wave needs (the producers
// of the attackers' main resources, the attackers' recruit building, then the carriers' building
// when the nearest stranger is across water) and spends the rest on attackers: a batch when a
// resource nears the storage cap, and a final batch with the carriers that lift the army when its
// spies leave. It spies the two nearest strangers (colonies first), each timed so that its report
// lands one wake-grouping window before protection ends, and asks to be awake then. Every batch
// that ends and every report wakes the seat on its own budget, so the opening recruits in few
// batches and keeps wakes for the afternoon.
//
// Then it strikes whenever its army is home: a conquest attempt with one founder on the weakest
// colony (no one's capital) when a fresh spy report shows its attack beating the estimated defense
// by a wide seeded margin (it holds the army for a colony it may take while that report comes),
// otherwise a raid on the weakest target above a narrower one. The estimate is the latest spy
// report's units, the buildings' share (with the combat hints) and what the city's stock can train
// on warning, or after its own won battle the shares remembered at launch; plus what the owner's
// other cities on that island can walk over; the margin grows with the intel's age at arrival and
// morale applies. A city that beat one of its attacks, or one of its spies, is left alone for a
// seeded cooldown. Before each strike it spies the weakest target whose intel would be stale
// (colonies first, at most six spies a day), timed so that the report lands as the army gets home,
// and asks to be awake then. Between waves it rebuilds attackers and a few defenders in batches
// long enough not to wake it for nothing, keeps one founder ready while a colony is in reach, and
// settles only once none is. It recalls an attack within the window when a fresher spy report
// shows a stronger defense.

import {
  compareIds,
  RESOURCE_IDS,
  type CityId,
  type CityView,
  type PlayerId,
  type Res,
  type ResourceId,
  type ToolCall,
  type UnitId,
} from "@perfidia/protocol";
import {
  addRes,
  call,
  countOf,
  covers,
  etaAfford,
  landPop,
  largest,
  meets,
  pmRes,
  power,
  res,
  scaleRes,
  storageLevelFor,
  subRes,
  timesAffordable,
  unitsInReport,
  type Kit,
} from "../kit.ts";
import {
  mainCity,
  nearby,
  projectedLevels,
  unlockWishes,
  type Planner,
  type Wish,
} from "../plan.ts";
import { randInt, type BotRng } from "../rng.ts";
import type { OtherCity, OwnCity, World } from "../world.ts";
import type { StrategyDef } from "./strategy.ts";

export interface Rusher2Params {
  /** Raid when the attack (morale applied) is ≥ estimated defense × raidPm / 1000 on fresh intel. */
  readonly raidPm: number;
  /** A conquest attempt with one founder needs ≥ estimated defense × conquerPm / 1000. */
  readonly conquerPm: number;
  /** Margin added per full hour of intel age at arrival (its age now plus the travel), in ‰. */
  readonly agePm: number;
  /** Intel older than this at strike time is refreshed by a spy first. */
  readonly stale: number;
  /** Fewest attackers worth a launch. */
  readonly minAttackers: number;
  /** Seconds a city that beat one of its attacks is left alone (unless a newer spy report came). */
  readonly cooldown: number;
  /** Without a spy target, the opening's final batch comes this long before protection ends. */
  readonly finalLead: number;
  /** Cities spied before protection ends (the nearest, colonies first). */
  readonly preSpies: number;
  /** Producer level of the attackers' main resources before protection ends. */
  readonly rushLevel: number;
  /** Targets read and weighed per turn, nearest first. */
  readonly scan: number;
  /** Settles up to this many cities, only when no colony is in reach. */
  readonly maxCities: number;
}

export function rusher2Params(rng: BotRng): Rusher2Params {
  return {
    raidPm: randInt(rng, 1200, 1400),
    conquerPm: randInt(rng, 1750, 1950),
    agePm: randInt(rng, 20, 40),
    stale: randInt(rng, 3 * 3600, 5 * 3600),
    minAttackers: randInt(rng, 8, 12),
    cooldown: randInt(rng, 8 * 3600, 12 * 3600),
    finalLead: randInt(rng, 6600, 7800),
    preSpies: 2,
    rushLevel: 3,
    scan: 7,
    maxCities: randInt(rng, 3, 4),
  };
}

/** Extra margin when the hints do not say how buildings add to a city's defense (units only). */
const UNHINTED_PM = 500;
/** Founders sent with a conquest attempt. */
const CONQUEST_FOUNDERS = 1;
/** Spy gold = spyMinGold × SPY_MULT plus the land pop last seen (twice the last gold after a failure). */
const SPY_MULT = 2;
/** After protection, a spy launch due within this many seconds is sent now rather than waited for. */
const SPY_SLACK = 2400;
/** In the opening, the spy leaves (and the final batch is queued) within this of its launch time. */
const OPENING_SLACK = 300;
/**
 * In the opening, overflow batches stop when this few own wakes are left: each batch wakes the seat
 * when it ends, and the strike, its battle report and the army's return need wakes of the same day.
 */
const OPENING_RESERVE = 8;
/** Fewest attackers an overflow batch of the opening is worth (a smaller one only wakes the seat). */
const OVERFLOW_MIN = 5;
/**
 * Share (‰) of a target's stock assumed spent on defenders once it sees the attack coming: bots
 * spend most of their stock on a mix of units when they wake, about a third of it on defenders.
 */
const REACTION_PM = 300;
/** Intel older than this is not attacked on, whatever the margin (it is spied again first). */
const MAX_AGE = 86400;
/**
 * Spies sent per game day: each report wakes the seat (own budget), so spying every turn would
 * leave no wake for the strikes.
 */
const SPY_PER_DAY = 6;

/** The resources an attacker mostly costs: each one that is at least a third of its cost. */
function attackResources(kit: Kit): ResourceId[] {
  const atk = kit.roles.attacker;
  const cost = atk === null ? null : (kit.units.get(atk)?.cost ?? null);
  if (cost === null) return [];
  const total = cost.wood + cost.stone + cost.gold;
  return RESOURCE_IDS.filter((r) => cost[r] > 0 && cost[r] * 3 >= total);
}

/** Cities (map rows) whose public `ext` shows a blocking state, such as a siege. */
function blockedCities(w: World): Set<CityId> {
  const out = new Set<CityId>();
  for (const row of w.map?.cities ?? []) {
    const ext = row.ext ?? {};
    if (w.hints.blockedExt.some((k) => Object.hasOwn(ext, k))) out.add(row.id);
  }
  return out;
}

/** Other players' cities whose owner has no relation with the seat and that are not besieged, nearest first. */
function strangers(w: World, from: OwnCity): OtherCity[] {
  const blocked = blockedCities(w);
  return nearby(
    w,
    from,
    (o) => o.owner !== null && !w.relations.has(o.owner) && !blocked.has(o.id),
  );
}

/** True when the city was read and its tag is not one the hints avoid. */
function weighable(w: World, view: CityView | undefined): view is CityView {
  return view !== undefined && (view.tag === null || !w.hints.avoidTags.includes(view.tag));
}

/** A number-valued record of a report's data (`buildings`), or empty. */
function levelsOf(data: Readonly<Record<string, unknown>>): Record<string, number> {
  const raw = data["buildings"];
  const out: Record<string, number> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

export interface Estimate {
  /** Estimated land defense. */
  readonly d: number;
  /** Its buildings' share (what is left once every defender died). */
  readonly base: number;
  /** The units' share, without the wall. */
  readonly units: number;
  /** When the intel was gathered. */
  readonly at: number;
  /** Land pop seen in the city (spy reports), or null. */
  readonly pop: number | null;
  /** True for a spy report (a snapshot of the units), false for the seat's own won battle. */
  readonly seen: boolean;
}

/** The stock a report's data shows (`stock`), or null. */
function stockIn(data: Readonly<Record<string, unknown>>): Res | null {
  const raw = data["stock"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[k] = v;
  }
  if (RESOURCE_IDS.some((r) => out[r] === undefined)) return null;
  return res(out["wood"] ?? 0, out["stone"] ?? 0, out["gold"] ?? 0);
}

/**
 * The defense a city can add once it sees an attack coming (every incoming attack wakes its owner,
 * who spends its stock on units): `REACTION_PM` of its stock in defenders, when its buildings can
 * train them.
 */
function reaction(kit: Kit, levels: Readonly<Record<string, number>>, stock: Res | null): number {
  const def = kit.roles.defender;
  const row = def === null ? undefined : kit.units.get(def);
  if (row === undefined || stock === null || !meets(row.requires, levels)) return 0;
  const q = kit.queues.get(row.queue);
  if (q !== undefined && (levels[q.building] ?? 0) < 1) return 0;
  const n = Math.min(row.maxPerOrder, timesAffordable(pmRes(stock, REACTION_PM), row.cost));
  return n * row.defense;
}

/**
 * The defense of a city from the seat's latest intel: a spy report's units, the buildings' share
 * (with the combat hints) and what its stock can still train on warning; or, after the seat's own
 * won battle there, the buildings' share and the units' share remembered at launch (the defender
 * rebuilds and gets support). Anything else is unknown (null).
 */
export function estimateCity(w: World, p: Planner, view: CityView | undefined): Estimate | null {
  if (view === undefined || view.access !== "public" || view.intel === null) return null;
  const kit = w.kit;
  const intel = view.intel;
  const at = intel.at[0];
  const data = intel.data;
  if (intel.type === "battle_report") {
    if (data["attacker"] !== w.seat || data["winner"] !== "attacker") return null;
    const base = p.flag(`b${view.id}`);
    const units = p.flag(`u${view.id}`) ?? 0;
    if (base === null) return null;
    return { d: base + units, base, units, at, pop: null, seen: false };
  }
  const units = unitsInReport(kit, data);
  const sum = power(kit, units, "defense", true);
  const h = w.hints.combat;
  const levels = levelsOf(data);
  const own = h === undefined ? 0 : h.base + h.perLevel * (levels[h.building] ?? 0);
  const wall = kit.wall === null ? 0 : (levels[kit.wall] ?? 0);
  const factor = h === undefined ? 1000 : 1000 + h.wallPm * wall;
  const react = reaction(kit, levels, stockIn(data));
  return {
    d: Math.floor(((sum + own + react) * factor) / 1000),
    base: Math.floor((own * factor) / 1000),
    units: sum,
    at,
    pop: landPop(kit, units),
    seen: true,
  };
}

/** The seat's morale against `foe` (‰), from the combat hints; 1000 without them. */
function moraleAgainst(w: World, foe: PlayerId | null): number {
  const h = w.hints.combat;
  if (h === undefined || h.moralePm <= 0 || foe === null) return 1000;
  const mine = w.cities.length;
  const theirs = w.others.filter((o) => o.owner === foe).length;
  const m = 1000 - h.moralePm * (mine - theirs);
  return Math.max(h.moraleFloorPm, Math.min(1000, m));
}

/**
 * True when the city is left alone for now: it beat one of the seat's attacks within the cooldown
 * and no newer spy report came, or the seat's last spy there failed (its counter-intelligence beat
 * the gold: a strong city) within the cooldown.
 */
function cooling(w: World, p: Planner, prm: Rusher2Params, view: CityView, army: number): boolean {
  const intel = view.access === "public" ? view.intel : null;
  const lost = p.flag(`l${view.id}`);
  if (lost !== null && w.t - lost < prm.cooldown) {
    if (intel === null || intel.type !== "spy_report" || intel.at[0] <= lost) return true;
  }
  const spied = p.flag(`s${view.id}`);
  if (spied === null || p.inFlight("spy", view.id)) return false;
  if (intel !== null && intel.at[0] >= spied) return false;
  // The last spy failed: the city's counter-intelligence beat its gold. It is left alone for the
  // cooldown, and after it while the defense that gold implies is beyond the army.
  if (w.t - spied < prm.cooldown) return true;
  return impliedDefense(w.kit, p.flag(`g${view.id}`) ?? 0) * prm.raidPm > army * 1000;
}

/**
 * The least land defense a city that beat a spy of `gold` holds: its counter-intelligence grows
 * with the pop present above a base (taken as twice the minimum spy gold), in defenders.
 */
function impliedDefense(kit: Kit, gold: number): number {
  const def = kit.roles.defender;
  const row = def === null ? undefined : kit.units.get(def);
  if (row === undefined) return 0;
  const pop = Math.max(0, gold - 2 * kit.rules.movement.spyMinGold);
  return Math.floor((pop * row.defense) / Math.max(1, row.pop));
}

/** Remembers a lost attack on a city (from its latest report), for the cooldown. */
function noteLosses(w: World, p: Planner): void {
  for (const view of w.views.values()) {
    if (view.access !== "public" || view.intel === null) continue;
    const { type, data, at } = view.intel;
    if (type !== "battle_report" || data["attacker"] !== w.seat) continue;
    if (data["winner"] === "attacker") continue;
    const flag = `l${view.id}`;
    if ((p.flag(flag) ?? -1) < at[0]) p.setFlag(flag, at[0]);
  }
}

/** Arrival times of the seat's attackers on their way home, earliest first. */
function returning(w: World): number[] {
  const atk = w.kit.roles.attacker;
  return (w.self?.private?.movements ?? [])
    .filter((m) => m.kind === "return" && m.owner === w.seat && countOf(m.units ?? {}, atk) > 0)
    .map((m) => m.arrive[0])
    .toSorted((a, b) => a - b);
}

/**
 * When the army can next strike: now (or `attackFrom`) when enough attackers are home; else when
 * the first attackers come home; before protection ends, `attackFrom`; otherwise null.
 */
function strikeTime(w: World, p: Planner, prm: Rusher2Params, main: OwnCity): number | null {
  const from = w.kit.rules.time.attackFrom;
  const atk = w.kit.roles.attacker;
  if (atk === null) return null;
  if (countOf(p.homeOf(main.id), atk) >= prm.minAttackers) return Math.max(w.t, from);
  const back = returning(w)[0];
  if (back !== undefined) return Math.max(back, from);
  return w.t < from ? from : null;
}

/** The land attack the army can bring at `strike`: attackers at home, queued, and home by then. */
function armyAt(p: Planner, main: OwnCity, strike: number): number {
  const { w } = p;
  const atk = w.kit.roles.attacker;
  if (atk === null) return 0;
  let n = countOf(p.homeOf(main.id), atk) + p.queued(main, atk);
  for (const m of w.self?.private?.movements ?? []) {
    if (m.kind === "return" && m.owner === w.seat && m.arrive[0] <= strike) {
      n += countOf(m.units ?? {}, atk);
    }
  }
  return power(w.kit, { [atk]: n }, "attack", true);
}

interface SpyRow {
  readonly target: OtherCity;
  readonly view: CityView;
  readonly est: Estimate | null;
}

/**
 * The cities worth spying (read this turn, not avoided, not cooling, not already attacked), in
 * order: colonies before capitals (the rusher's prey), and within each the known weakest first (by
 * their last estimate), then the unknown, nearest first. With `nearFirst` (the opening, when
 * nothing is known yet), the nearest first, colonies first among cities about as far.
 */
function spyOrder(
  p: Planner,
  prm: Rusher2Params,
  main: OwnCity,
  army: number,
  nearFirst = false,
): SpyRow[] {
  const { w } = p;
  const rows: (SpyRow & { i: number; hours: number })[] = [];
  for (const [i, target] of strangers(w, main).slice(0, prm.scan).entries()) {
    const view = w.views.get(target.id);
    if (!weighable(w, view) || view.access !== "public") continue;
    if (cooling(w, p, prm, view, army) || p.inFlight("attack", target.id)) continue;
    // Travel in whole hours, rounded: cities about as far count as equally near.
    const hours = Math.floor(((w.travel(main.id, target.island, false) ?? 0) + 1800) / 3600);
    rows.push({ target, view, est: estimateCity(w, p, view), i, hours });
  }
  const capital = (r: SpyRow): number => (r.target.capitalOf === null ? 0 : 1);
  const unknown = (r: SpyRow): number => (r.est === null ? 1 : 0);
  return rows.toSorted((a, b) => {
    if (nearFirst) return a.hours - b.hours || capital(a) - capital(b) || a.i - b.i;
    return (
      capital(a) - capital(b) ||
      unknown(a) - unknown(b) ||
      (a.est?.d ?? a.hours) - (b.est?.d ?? b.hours) ||
      a.i - b.i
    );
  });
}

/** When a spy to `target` must leave so that its report lands one grouping window before `strike`. */
function spyLaunch(w: World, main: OwnCity, target: OtherCity, strike: number): number | null {
  const travel = w.travel(main.id, target.island, true);
  return travel === null ? null : strike - travel - w.kit.gateway.groupWindow;
}

/** Spy gold for a city: `spyMinGold × SPY_MULT` plus the pop last seen, or twice the last gold after a failed spy. */
function spyGoldFor(
  p: Planner,
  main: OwnCity,
  view: CityView,
  est: Estimate | null,
): number | null {
  const min = p.w.kit.rules.movement.spyMinGold;
  let gold = Math.max(min, min * SPY_MULT + (est?.pop ?? 0));
  const last = p.flag(`s${view.id}`);
  const lastGold = p.flag(`g${view.id}`);
  const intel = view.access === "public" ? view.intel : null;
  // The last spy landed (none is in flight when this is asked) without a report: it failed.
  const failed = last !== null && lastGold !== null && (intel === null || intel.at[0] < last);
  if (failed) gold = Math.max(gold, lastGold * 2);
  if (p.stockOf(main.id).gold < gold) return null;
  return gold;
}

/** Spies the seat may still send today (`SPY_PER_DAY`, counted in the flags `sd` and `sn`). */
function spiesLeft(p: Planner): number {
  return p.flag("sd") === p.w.day + 1
    ? Math.max(0, SPY_PER_DAY - (p.flag("sn") ?? 0))
    : SPY_PER_DAY;
}

function sendSpy(p: Planner, main: OwnCity, row: SpyRow): boolean {
  if (spiesLeft(p) <= 0) return false;
  const gold = spyGoldFor(p, main, row.view, row.est);
  if (gold === null) return false;
  p.spy(main, row.target.id, gold);
  p.setFlag(`s${row.target.id}`, p.w.t);
  p.setFlag(`g${row.target.id}`, gold);
  const today = p.flag("sd") === p.w.day + 1 ? (p.flag("sn") ?? 0) : 0;
  p.setFlag("sd", p.w.day + 1);
  p.setFlag("sn", today + 1);
  return true;
}

/**
 * Spies for the next strike after protection: nothing while a target with intel still fresh then is
 * weak enough for the army; otherwise the first city of `spyOrder` whose intel would be stale and
 * that was not last seen far beyond the army, leaving now when its launch time is less than
 * `SPY_SLACK` ahead, else asking to be awake then. Asks to be awake at the strike, too.
 */
function scout(p: Planner, prm: Rusher2Params, main: OwnCity): void {
  const { w } = p;
  const strike = strikeTime(w, p, prm, main);
  if (strike === null) return;
  if (strike > w.t) p.wakeAt(strike);
  const army = armyAt(p, main, strike);
  const rows = spyOrder(p, prm, main, army);
  // With a founder ready, a colony is weighed for a conquest, which needs a spy report.
  const founder = w.kit.roles.founder;
  const founding = countOf(p.homeOf(main.id), founder) + p.queued(main, founder) > 0;
  const fresh = (r: SpyRow): boolean =>
    r.est !== null &&
    strike - r.est.at <= prm.stale &&
    (r.est.seen || !founding || r.target.capitalOf !== null);
  const spyFor = (row: SpyRow): void => {
    const launch = spyLaunch(w, main, row.target, strike);
    if (launch === null) return;
    if (launch > w.t + SPY_SLACK) p.wakeAt(launch);
    else sendSpy(p, main, row);
  };
  if (rows.some((r) => p.inFlight("spy", r.target.id))) return;
  // With a founder ready, the colonies the army may take come first (`offense` holds the army).
  if (founding) {
    const colony = rows.find(
      (r) =>
        r.target.capitalOf === null &&
        !fresh(r) &&
        (r.est === null || army * 1000 >= r.est.d * prm.conquerPm),
    );
    if (colony !== undefined) {
      spyFor(colony);
      return;
    }
  }
  // A target the army beats on intel still fresh at the strike, weighed as `offense` weighs it
  // (support, morale, age): nothing to spy.
  const beatable = candidates(p, prm, main).some(
    (c) =>
      strike - c.est.at <= prm.stale &&
      (c.est.seen || !founding || c.target.capitalOf !== null) &&
      strong(army, c, prm.raidPm),
  );
  if (beatable) return;
  for (const row of rows) {
    // Known cities are spied again only when the army may now beat them.
    if (fresh(row) || (row.est !== null && row.est.d * prm.raidPm > army * 1250)) continue;
    spyFor(row);
    return;
  }
}

/** The opening's spy target (the first city of `spyOrder`) and when its spy leaves, if known. */
function openingSpies(
  p: Planner,
  prm: Rusher2Params,
  main: OwnCity,
): { row: SpyRow; launch: number }[] {
  const { w } = p;
  const strike = w.kit.rules.time.attackFrom;
  const out: { row: SpyRow; launch: number }[] = [];
  const hours = (o: OtherCity): number => (w.travel(main.id, o.island, false) ?? 0) / 3600;
  const nearest = strangers(w, main)[0];
  for (const row of spyOrder(p, prm, main, armyAt(p, main, strike), true)) {
    if (out.length >= prm.preSpies) break;
    // Only the nearest strangers (within an hour of the nearest) are first-wave targets.
    if (nearest !== undefined && hours(row.target) > hours(nearest) + 1) break;
    const launch = spyLaunch(w, main, row.target, strike);
    // A report that would land after protection ends is of no use to the first wave.
    if (launch !== null && launch + OPENING_SLACK >= w.t) out.push({ row, launch });
  }
  return out;
}

/** Whether the first wave must cross water: the nearest stranger is on another island. */
function firstWaveAcrossWater(w: World, main: OwnCity): boolean {
  if (!w.kit.rules.movement.transportRule || w.kit.roles.carrier === null) return false;
  const first = strangers(w, main)[0];
  return first !== undefined && first.island !== main.island;
}

/**
 * The opening's build wishes for the main city (null for the others: the generic wishes): its
 * population building when nearly full, the attackers' resource producers to level 2, the
 * attackers' unlock, those producers to `rushLevel`, then the carriers' unlock when needed.
 */
function rushWishes(w: World, main: OwnCity, prm: Rusher2Params, c: OwnCity): Wish[] | null {
  if (c.id !== main.id) return null;
  const kit = w.kit;
  const lv = projectedLevels(c);
  const out: Wish[] = [];
  if ((c.popCap - c.popUsed) * 4 < c.popCap) {
    out.push({ building: kit.population, level: (lv[kit.population] ?? 0) + 1 });
  }
  const producers = [...new Set(attackResources(kit).map((r) => kit.producers[r]))];
  for (const b of producers) out.push({ building: b, level: Math.min(2, prm.rushLevel) });
  out.push(...unlockWishes(kit, kit.roles.attacker));
  for (const b of producers) out.push({ building: b, level: prm.rushLevel });
  if (firstWaveAcrossWater(w, main)) out.push(...unlockWishes(kit, kit.roles.carrier));
  return out;
}

/**
 * Seconds one `unit` takes to train in the main city: from its table when the rules carry it,
 * else from a batch of that unit in the city's full view (remembered as the flag `ut`), else null.
 */
function unitTime(p: Planner, c: OwnCity, unit: UnitId): number | null {
  const kit = p.w.kit;
  const row = kit.units.get(unit);
  const q = row === undefined ? undefined : kit.queues.get(row.queue);
  if (row === undefined || q === undefined || c.levels === null) return null;
  const table = row.time;
  if (table !== undefined && table.length > 0) {
    return table[Math.min(c.levels[q.building] ?? 0, table.length - 1)] ?? null;
  }
  const view = p.w.views.get(c.id);
  if (view !== undefined && view.access === "full") {
    for (const b of view.recruit[row.queue] ?? []) {
      if (b.unit !== unit || b.count <= 0) continue;
      const each = Math.floor((b.end[0] - b.start[0]) / b.count);
      if (each > 0) p.setFlag("ut", each);
    }
  }
  return p.flag("ut");
}

/**
 * The opening's units in the main city: with `final`, first the carriers that lift every attacker
 * (home, queued and ordered now) when the first wave crosses water; then every attacker the budget
 * and pop allow, keeping `keepGold`: with `final` no more than can train before `doneBy`, without
 * it at least `OVERFLOW_MIN` or none.
 */
function rushUnits(
  p: Planner,
  main: OwnCity,
  keepGold: number,
  final: boolean,
  doneBy: number,
): void {
  const { w } = p;
  const kit = w.kit;
  const atk = kit.roles.attacker;
  if (atk === null) return;
  const arow = kit.units.get(atk);
  if (arow === undefined) return;
  let budget = subRes(p.budgetOf(main.id), res(0, 0, keepGold));
  let free = p.popFreeOf(main.id);
  const apop = Math.max(1, arow.pop);
  const qmax = kit.queues.get(arow.queue)?.maxCount ?? arow.maxPerOrder;
  let atkN = p.canRecruit(main, atk)
    ? Math.min(
        timesAffordable(budget, arow.cost),
        Math.floor(Math.max(0, free) / apop),
        arow.maxPerOrder,
        qmax,
      )
    : 0;
  if (final) {
    const each = unitTime(p, main, atk);
    const busy = (main.recruit[arow.queue] ?? []).reduce((end, b) => Math.max(end, b.end), w.t);
    if (each !== null && each > 0) atkN = Math.min(atkN, Math.floor((doneBy - busy) / each));
  }
  const orders: { unit: UnitId; count: number }[] = [];
  const car = kit.roles.carrier;
  const crow = car === null ? undefined : kit.units.get(car);
  if (final && car !== null && crow !== undefined && crow.capacity > 0) {
    if (firstWaveAcrossWater(w, main) && p.canRecruit(main, car)) {
      const army = countOf(p.homeOf(main.id), atk) + p.queued(main, atk) + Math.max(0, atkN);
      const have = countOf(p.homeOf(main.id), car) + p.queued(main, car);
      const need = Math.ceil((army * apop) / crow.capacity) - have;
      const n = Math.min(
        need,
        timesAffordable(budget, crow.cost),
        Math.floor(free / Math.max(1, crow.pop)),
        crow.maxPerOrder,
      );
      if (n > 0) {
        orders.push({ unit: car, count: n });
        budget = subRes(budget, scaleRes(crow.cost, n));
        free -= crow.pop * n;
        atkN = Math.min(
          atkN,
          timesAffordable(budget, arow.cost),
          Math.floor(Math.max(0, free) / apop),
        );
      }
    }
  }
  if (atkN > 0 && (final || atkN >= OVERFLOW_MIN)) orders.push({ unit: atk, count: atkN });
  if (orders.length > 0) p.recruit(main, orders);
}

/**
 * The opening turn: the rush builds; the spy and the final batch at the spy's launch time (or
 * `finalLead` before protection ends without a target), keeping the spy's gold until it leaves; a
 * batch before that when an attacker resource nears the storage cap and enough own wakes are left.
 */
function opening(p: Planner, prm: Rusher2Params, main: OwnCity): void {
  const { w } = p;
  const kit = w.kit;
  const from = kit.rules.time.attackFrom;
  p.wakeAt(from);
  p.economyWith((c) => rushWishes(w, main, prm, c));
  // The planned spies that have not left yet (each city is spied once before protection ends).
  const pending = openingSpies(p, prm, main).filter(
    (s) => p.flag(`s${s.row.target.id}`) === null && !p.inFlight("spy", s.row.target.id),
  );
  const done = p.flag("fr") !== null;
  const finalAt =
    pending.length === 0
      ? from - prm.finalLead
      : pending.reduce((t, s) => Math.min(t, s.launch), Number.MAX_SAFE_INTEGER);
  const final = !done && w.t + OPENING_SLACK >= finalAt;
  for (const s of pending) {
    // Once the final batch is queued, a report landing up to an hour early is still fresh at the
    // strike; before, a spy leaves only at its time. Otherwise the seat wakes for it.
    const due = final || done ? s.launch <= w.t + 3600 : s.launch <= w.t + OPENING_SLACK;
    if (due) sendSpy(p, main, s.row);
    else p.wakeAt(s.launch);
  }
  if (done) return;
  if (final) {
    // Done once the attackers can be trained here; until then each wake tries again.
    if (p.canRecruit(main, kit.roles.attacker)) p.setFlag("fr", w.t);
    rushUnits(p, main, 0, true, from - kit.gateway.groupWindow);
    return;
  }
  p.wakeAt(finalAt);
  if (w.briefing.budget.ownWakesLeft <= OPENING_RESERVE) return;
  const stock = p.stockOf(main.id);
  if (attackResources(kit).some((r) => stock[r] * 10 >= main.cap * 7)) {
    const keep = kit.rules.movement.spyMinGold * SPY_MULT * pending.length;
    rushUnits(p, main, keep, false, from);
  }
}

interface Candidate {
  readonly target: OtherCity;
  readonly est: Estimate;
  /** Margin added for the intel's age at arrival (‰). */
  readonly agePm: number;
  readonly morale: number;
  readonly travel: number;
}

/**
 * The defense that can walk over from the target owner's other cities on the target's island
 * before an attack lands (a bot sends half its defenders to a threatened city): half the units last
 * seen there, or, for a city without intel, as much as the target's own units or buildings' share.
 */
function supportFor(p: Planner, target: OtherCity, own: Estimate): number {
  const { w } = p;
  let sum = 0;
  for (const o of w.others) {
    if (o.id === target.id || o.owner !== target.owner || o.island !== target.island) continue;
    const est = estimateCity(w, p, w.views.get(o.id));
    sum += est === null ? Math.max(own.units, own.base) : Math.floor(est.units / 2);
  }
  return sum;
}

/**
 * The targets weighed this turn: read, not avoided, not cooling down, without an attack of the
 * seat already on its way, with intel at most `MAX_AGE` old (its age raises the margin).
 */
function candidates(p: Planner, prm: Rusher2Params, main: OwnCity): Candidate[] {
  const { w } = p;
  const out: Candidate[] = [];
  const unhinted = w.hints.combat === undefined ? UNHINTED_PM : 0;
  const army = power(w.kit, p.homeOf(main.id), "attack", true);
  for (const target of strangers(w, main).slice(0, prm.scan)) {
    const view = w.views.get(target.id);
    if (!weighable(w, view) || cooling(w, p, prm, view, army)) continue;
    if (p.inFlight("attack", target.id)) continue;
    const seen = estimateCity(w, p, view);
    if (seen === null) continue;
    const age = Math.max(0, w.t - seen.at);
    if (age > MAX_AGE) continue;
    const travel = w.travel(main.id, target.island, false);
    if (travel === null) continue;
    out.push({
      target,
      est: { ...seen, d: seen.d + supportFor(p, target, seen) },
      agePm: prm.agePm * Math.floor((age + travel) / 3600) + unhinted,
      morale: moraleAgainst(w, target.owner),
      travel,
    });
  }
  return out;
}

const weakest = (a: Candidate, b: Candidate): number =>
  a.est.d - b.est.d || a.travel - b.travel || compareIds(a.target.id, b.target.id);

/** True when `strength` (morale applied) beats the candidate's estimate by `pm` plus its age margin. */
function strong(strength: number, c: Candidate, pm: number): boolean {
  const a = Math.floor((strength * c.morale) / 1000);
  return a > c.est.d && a * 1000 >= c.est.d * (pm + c.agePm);
}

/** Launches one attack: a conquest attempt on the weakest colony, else a raid on the weakest target. */
function offense(p: Planner, prm: Rusher2Params, main: OwnCity): void {
  const { w } = p;
  const kit = w.kit;
  const atk = kit.roles.attacker;
  if (atk === null || w.t < kit.rules.time.attackFrom || p.attacksLeft <= 0) return;
  if (countOf(p.homeOf(main.id), atk) < prm.minAttackers) return;
  const cands = candidates(p, prm, main);
  const launch = (c: Candidate, units: Record<string, number>, kind: string): void => {
    if (!p.attack(main, c.target.id, units)) return;
    p.setFlag(`b${c.target.id}`, c.est.base);
    p.setFlag(`u${c.target.id}`, c.est.units);
    p.memo(`${kind} ${c.target.id} D${w.day + 1}`);
  };
  const founder = kit.roles.founder;
  if (countOf(p.homeOf(main.id), founder) >= CONQUEST_FOUNDERS) {
    // A founder is risked only on a fresh spy report: a won battle says nothing of what came since.
    const ready = (c: Candidate): boolean => c.est.seen && w.t - c.est.at <= prm.stale;
    const colonies = cands.filter((x) => x.target.capitalOf === null);
    for (const c of colonies.filter(ready).toSorted(weakest)) {
      const g = p.attackGroup(main, c.target.island, CONQUEST_FOUNDERS);
      if (g === null || countOf(g.units, founder) !== CONQUEST_FOUNDERS) continue;
      if (countOf(g.units, atk) < prm.minAttackers || !strong(g.strength, c, prm.conquerPm)) {
        continue;
      }
      launch(c, g.units, "siege");
      return;
    }
    // A colony the army could take on what was last seen waits for its fresh report (`scout`),
    // when a spy is on its way or can leave now: the army stays home rather than raid elsewhere.
    const g = p.attackGroup(main, main.island, CONQUEST_FOUNDERS);
    const strength = g === null ? 0 : g.strength;
    const spyGold = SPY_MULT * kit.rules.movement.spyMinGold;
    const canSpy = spiesLeft(p) > 0 && p.stockOf(main.id).gold >= spyGold;
    const held = colonies.filter((c) => !ready(c) && strength * 1000 >= c.est.d * prm.conquerPm);
    if (held.some((c) => p.inFlight("spy", c.target.id)) || (held.length > 0 && canSpy)) return;
  }
  for (const c of cands.toSorted(weakest)) {
    const g = p.attackGroup(main, c.target.island, 0);
    if (g === null || countOf(g.units, atk) < prm.minAttackers) continue;
    if (!strong(g.strength, c, prm.raidPm)) continue;
    launch(c, g.units, "raid");
    return;
  }
}

/** Recalls an attack within the window when a spy report newer than its launch shows a stronger defense. */
function recallWeakened(p: Planner, prm: Rusher2Params): void {
  const { w } = p;
  const kinds: readonly string[] = w.kit.rules.movement.recall.kinds;
  if (!kinds.includes("attack")) return;
  for (const m of w.self?.private?.movements ?? []) {
    if (m.kind !== "attack" || m.owner !== w.seat || m.to === null || m.units === undefined)
      continue;
    const until = m.recallableUntil ?? null;
    if (until === null || until[0] < w.t) continue;
    const view = w.views.get(m.to);
    if (view === undefined || view.access !== "public" || view.intel === null) continue;
    if (view.intel.type !== "spy_report" || view.intel.at[0] <= m.depart[0]) continue;
    const est = estimateCity(w, p, view);
    if (est === null) continue;
    const strength = power(w.kit, m.units, "attack", true);
    if (strength * 1000 < est.d * prm.raidPm) p.recall(m.id);
  }
}

/**
 * Keeps one founder at home for the next conquest: recruits it in the main city, reserving its cost
 * when it is affordable soon, or asks for the buildings (and the storage) it needs.
 */
function conquestFounder(p: Planner, main: OwnCity): void {
  const { w } = p;
  const kit = w.kit;
  const founder = kit.roles.founder;
  if (countOf(p.homeOf(main.id), founder) + p.queued(main, founder) >= CONQUEST_FOUNDERS) return;
  const row = kit.units.get(founder);
  if (row === undefined || main.levels === null) return;
  if (!p.canRecruit(main, founder)) {
    p.wish(main.id, ...unlockWishes(kit, founder));
    return;
  }
  const cost = w.self?.private?.settler.cost;
  if (cost === undefined) return;
  if (largest(cost) > main.cap) {
    const level = storageLevelFor(kit, largest(cost));
    if (level !== null) p.wish(main.id, { building: kit.storage, level });
    return;
  }
  if (p.popFreeOf(main.id) < row.pop) return;
  if (covers(p.stockOf(main.id), cost)) {
    p.recruit(main, [{ unit: founder, count: 1 }], cost);
    return;
  }
  const eta = etaAfford(p.stockOf(main.id), main.rate, cost, main.cap);
  if (eta !== null && eta <= 2 * p.k.cadence) p.reserve(main.id, cost);
}

/** Units of `unit` in the seat's own movements (attacks, returns, sieges on their way). */
function unitsAway(w: World, unit: UnitId | null): number {
  let n = 0;
  for (const m of w.self?.private?.movements ?? []) {
    if (m.owner === w.seat) n += countOf(m.units ?? {}, unit);
  }
  return n;
}
const attackersAway = (w: World): number => unitsAway(w, w.kit.roles.attacker);
const carriersAway = (w: World): number => unitsAway(w, w.kit.roles.carrier);

/** When the city's recruit queue `queue` empties (now when it is empty). */
function queueEnd(w: World, c: OwnCity, queue: string): number {
  return (c.recruit[queue] ?? []).reduce((end, b) => Math.max(end, b.end), w.t);
}

/**
 * The army between waves, city by city, from `spendPm` of what is left: in the main city the
 * carriers that lift its attackers plus one (room for a founder); then packs of the mix (attackers
 * and defenders). Every recruit queue that runs dry wakes the seat (own budget), so a batch that
 * would start an idle queue is ordered only when it keeps it busy for half a cadence, or when the
 * stock nears the storage cap; a busy queue takes any batch.
 */
function recruitArmy(p: Planner, main: OwnCity): void {
  const { w, k } = p;
  const kit = w.kit;
  const atk = kit.roles.attacker;
  const arow = atk === null ? undefined : kit.units.get(atk);
  if (atk === null || arow === undefined) return;
  const def = kit.roles.defender;
  const drow = def === null ? undefined : kit.units.get(def);
  const car = kit.roles.carrier;
  const crow = car === null ? undefined : kit.units.get(car);
  // The main city keeps the gold of one spy, so the next strike is never blind for want of it.
  const spyGold = res(0, 0, kit.rules.movement.spyMinGold * SPY_MULT);
  for (const c of w.cities) {
    if (c.blocked || c.levels === null) continue;
    const spendable = c.id === main.id ? subRes(p.budgetOf(c.id), spyGold) : p.budgetOf(c.id);
    let budget = pmRes(spendable, k.spendPm);
    let free = p.popFreeOf(c.id);
    const orders: { unit: UnitId; count: number }[] = [];
    if (c.id === main.id && car !== null && crow !== undefined && crow.capacity > 0) {
      if (kit.rules.movement.transportRule && p.canRecruit(c, car)) {
        const lift = countOf(c.units, atk) + p.queued(c, atk) + attackersAway(w);
        const have = countOf(c.units, car) + p.queued(c, car) + carriersAway(w);
        const want = Math.ceil((lift * Math.max(1, arow.pop)) / crow.capacity) + 1 - have;
        const n = Math.min(
          want,
          timesAffordable(budget, crow.cost),
          Math.floor(free / Math.max(1, crow.pop)),
          crow.maxPerOrder,
        );
        if (n > 0) {
          orders.push({ unit: car, count: n });
          budget = subRes(budget, scaleRes(crow.cost, n));
          free -= crow.pop * n;
        }
      }
    }
    if (p.canRecruit(c, atk)) {
      const dn = drow !== undefined && def !== null && p.canRecruit(c, def) ? k.mix.defender : 0;
      const an = Math.max(1, k.mix.attacker);
      const packCost =
        dn > 0 && drow !== undefined
          ? addRes(scaleRes(arow.cost, an), scaleRes(drow.cost, dn))
          : scaleRes(arow.cost, an);
      const packPop = arow.pop * an + (drow?.pop ?? 0) * dn;
      const packs = Math.min(
        timesAffordable(budget, packCost),
        Math.floor(Math.max(0, free) / Math.max(1, packPop)),
      );
      const each = unitTime(p, c, atk);
      const busy = queueEnd(w, c, arow.queue) > w.t;
      const long = each === null || packs * (an + dn) * each * 2 >= k.cadence;
      const stock = p.stockOf(c.id);
      const full = RESOURCE_IDS.some((r) => stock[r] * 10 >= c.cap * 8);
      if (packs > 0 && (busy || long || full)) {
        const qmax = kit.queues.get(arow.queue)?.maxCount ?? arow.maxPerOrder;
        orders.push({ unit: atk, count: Math.min(packs * an, arow.maxPerOrder, qmax) });
        if (dn > 0 && def !== null && drow !== undefined) {
          orders.push({ unit: def, count: Math.min(packs * dn, drow.maxPerOrder, qmax) });
        }
      }
    }
    if (orders.length > 0) p.recruit(c, orders);
  }
}

/** True when a stranger's colony (no one's capital) is among the nearest targets. */
function colonyInReach(w: World, prm: Rusher2Params, main: OwnCity): boolean {
  return strangers(w, main)
    .slice(0, prm.scan)
    .some((o) => o.capitalOf === null && weighable(w, w.views.get(o.id)));
}

export const rusher2: StrategyDef = Object.freeze<StrategyDef>({
  name: "rusher",
  version: 2,
  brain(rng) {
    const prm = rusher2Params(rng);
    const knobs = {
      cadence: randInt(rng, 10800, 12600),
      settle: true,
      maxCities: prm.maxCities,
      producerBase: 3,
      producerPerDay: 2,
      wallBase: 0,
      wallPerDay: 0,
      spendPm: randInt(rng, 850, 950),
      mix: { defender: 1, attacker: randInt(rng, 3, 4), navy: 0 },
      carriers: true,
      supportOwn: false,
      escort: 0,
      militaryFirst: true,
    };
    return {
      knobs,
      reads(w: World): ToolCall[] {
        const out: ToolCall[] = [];
        for (const m of w.self?.private?.movements ?? []) {
          const until = m.recallableUntil ?? null;
          if (m.kind === "attack" && m.to !== null && until !== null && until[0] >= w.t) {
            out.push(call("view_city", { city: m.to }));
          }
        }
        const main = mainCity(w);
        if (main !== null) {
          for (const o of strangers(w, main).slice(0, prm.scan)) {
            out.push(call("view_city", { city: o.id }));
          }
        }
        return out;
      },
      plan(p) {
        const { w } = p;
        p.answer(() => false);
        noteLosses(w, p);
        recallWeakened(p, prm);
        const main = mainCity(w);
        if (main === null) {
          p.economy();
          p.units();
          return;
        }
        if (w.t < w.kit.rules.time.attackFrom) {
          opening(p, prm, main);
          return;
        }
        offense(p, prm, main);
        scout(p, prm, main);
        const back = returning(w)[0];
        if (back !== undefined) p.wakeAt(back);
        if (colonyInReach(w, prm, main)) conquestFounder(p, main);
        else if (w.day >= 1) {
          p.settle();
          p.founder();
        }
        p.economy();
        recruitArmy(p, main);
      },
    };
  },
});
