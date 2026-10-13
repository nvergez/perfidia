// `rusher@3` (docs/architecture.md §11.2): the protection-end rush of rusher@2, played by a seat
// that means to last. rusher@1 (`rusher.ts`) and rusher@2 (`rusher2.ts`) stay registered unchanged
// (§11.1); this file copies what it keeps of rusher@2 instead of importing it, so that the frozen
// version can never move with this one.
//
// Kept from rusher@2: the opening (the attackers' producers and unlock, attackers in few batches,
// the two nearest strangers spied so that their reports land as protection ends, the first wave
// launched at once), the strike estimates (spy report, buildings' share, reaction, the support the
// owner can walk over, age margin, morale), the cooldowns after a lost attack or a failed spy, the
// recall on a fresher, stronger report, conquest attempts with one founder on fresh spy reports.
//
// What changes:
// - It grows. Once its first wave has left (or six hours after protection ends), it recruits
//   founders and settles, one city at a time, to 2 cities on day 1 and 3–4 by the end of day 2, then
//   up to 5–7 while free land is in reach, like any player; loot lands in its main city, where the
//   founder's price is reserved first. A founder at home still goes with a conquest wave when one
//   is ready that turn; once no founding is wanted it keeps one for conquests, as rusher@2 did.
// - It garrisons. Every own city keeps a defense (its defenders, the groups stationed there and its
//   buildings' share) of at least 150 + 100 per game day, raised to 1.1–1.4 times the strongest
//   attack its spy reports of the last day showed at home in a stranger's city (capped at three
//   times that floor). Cities with spare defenders support the ones that lack them, nearest first; a
//   siege it holds gets defenders once (they stay as the garrison of the city it takes); a city other
//   than its capital keeps home the attackers its defense still lacks; and what is still missing is
//   recruited first, in the city itself or, when it cannot train defenders, in the main city.
// - Strikes leave from every city with enough attackers, each on its own target; a strike is
//   planned for when enough attackers are home (counting those on their way back and those its
//   queues deliver), so a short protection does not leave it waiting for a full wave by itself.
// - Raids are worth it: a raid needs a spy report (a won battle says nothing of what came since),
//   and a city that report shows without defenders is raided only for loot worth the trip (300–500
//   resources above what its storage protects), and not again for a day after a raid found it so;
//   otherwise it is a conquest target or left alone.
// - Wakes last the day. Its queues are sized to run until its next wake (a queue that empties wakes
//   the seat on its own budget), an idle queue starts only with a batch that lasts that long unless
//   its stock nears the storage cap or its own wakes are plentiful, and every other wake it causes
//   (a spy's or a raid's report, a queue that empties off its beats, a self-wake for an army coming
//   home) is paced: only while the own wakes used by then stay within an even share of the day's
//   budget plus two (`wakePacer`). The rush's first strike goes regardless.

import {
  compareIds,
  RESOURCE_IDS,
  type BuildingId,
  type CityId,
  type CityView,
  type IslandId,
  type PlayerId,
  type QueueId,
  type ResourceId,
  type ToolCall,
  type UnitCounts,
  type UnitId,
  z,
} from "@perfidia/protocol";
import {
  addRes,
  baseDefenseAt,
  call,
  combatNumbers,
  configInt,
  countOf,
  covers,
  DAY,
  etaAfford,
  landPop,
  largest,
  levelsInReport,
  meets,
  pmRes,
  power,
  reactionDefense,
  res,
  scaleRes,
  stockInReport,
  storageLevelFor,
  subRes,
  timesAffordable,
  unitsInReport,
  type CombatNumbers,
  type Kit,
} from "../kit.ts";
import {
  economyWishes,
  mainCity,
  nearby,
  ownWakesBefore,
  planBuilds,
  projectedLevels,
  unlockWishes,
  type Planner,
  type Wish,
} from "../plan.ts";
import { unitTime } from "../pace.ts";
import { randInt, type BotRng } from "../rng.ts";
import type { OtherCity, OwnCity, World } from "../world.ts";
import type { StrategyDef } from "./strategy.ts";

export interface Rusher3Params {
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
  /** Cities it grows to (foundings and conquests) while free land is in reach. */
  readonly maxCities: number;
  /** Cities it wants by the end of day 2 (founded or taken). */
  readonly earlyCities: number;
  /** A garrison holds this much (‰) of the strongest attack seen at home in a stranger's city. */
  readonly garrisonPm: number;
  /** Least loot a raid on a city seen without defenders must bring (its carry permitting). */
  readonly emptyLoot: number;
  /** Defenders sent with a founder. */
  readonly escort: number;
}

export function rusher3Params(rng: BotRng): Rusher3Params {
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
    maxCities: randInt(rng, 5, 7),
    earlyCities: randInt(rng, 2, 3),
    garrisonPm: randInt(rng, 1100, 1400),
    emptyLoot: randInt(rng, 300, 500),
    escort: randInt(rng, 3, 5),
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
 * Intel older than this is not attacked on, whatever the margin (it is spied again first). Up to
 * it, the age margin (`agePm` per hour) asks an army far above what was seen: a spy, and the wake
 * its report costs, is saved for the targets the army does not dwarf.
 */
const MAX_AGE = 3 * DAY;
/** Pop guessed per game day in a city never spied (a capital twice as much), for its spy's gold. */
const SPY_POP_PER_DAY = 40;
/** Spies sent per game day: each report wakes the seat on its own budget. */
const SPY_PER_DAY = 6;
/** Spies in flight at once in the first hours after protection ends (one afterwards). */
const EARLY_SPIES = 2;
const EARLY_SCOUTING = 6 * 3600;
/**
 * The first wave is planned to land no earlier than this game time of day 1 (when protection ends
 * earlier): the rush economy needs the morning, and colonies to strike appear during it.
 */
const RUSH_FROM = DAY / 2;
/** Spy reports (this recent) showing targets beyond the army after which it spies no unknown city. */
const STRONG_SEEN = 2;
const STRONG_AGE = 12 * 3600;
/** See `longSteps`. */
const LONG_STEP = 3 * 3600;
/** After protection ends, founding waits for the first wave at most this long. */
const FOUND_AFTER = 6 * 3600;
/** From day 3, it founds while it owns at least this many attackers per day played. */
const ARMY_PER_DAY = 20;
/** Every own city keeps a defense of at least GARRISON_BASE + GARRISON_PER_DAY × day. */
const GARRISON_BASE = 150;
const GARRISON_PER_DAY = 100;
/** A garrison sized on the threat seen is capped at this many times its floor. */
const GARRISON_CAP = 3;
/** Spy reports older than this say nothing of the threat a garrison faces. */
const THREAT_AGE = DAY;
/** Fewest defenders worth a support movement. */
const MIN_SUPPORT = 3;
/** Margin (‰) a relief adds to `raidPm`: the besieger may reinforce its garrison before it lands. */
const RELIEF_PM = 200;
/** Fewest attackers a batch that starts an idle queue off the beats brings (or a quarter of the army). */
const MIN_WORTH = 8;
/**
 * Attackers owned below which the price of a founder past the second city is not set aside: the
 * army is fed first.
 */
const FOUNDER_ARMY = 20;
/** A city keeps this much (‰ of its storage cap) of each resource; the rest goes to the army's city. */
const SHIP_KEEP_PM = 500;
/** Smallest shipment worth sending. */
const SHIP_MIN = 300;
/** Fewest defenders a garrison order brings (unless that is all it lacks). */
const MIN_GARRISON_BATCH = 5;
/** Share (‰) of a city's unit budget that its garrison's defenders may take per turn. */
const GARRISON_SPEND_PM = 600;
/** Own wakes are plentiful while they allow one wake per PLENTY seconds for the rest of the day. */
const PLENTY = 90 * 60;
/** Own wakes a seat may run ahead of an even spread of its day's budget (`wakePacer`). */
const PACE_SLACK = 2;
/** Own wakes are scarce once they allow no more than one wake every PACE seconds for the rest of the day. */
const PACE = 3 * 3600;
/** Strangers read and weighed around each city that strikes, besides the main city's. */
const SCAN_OTHERS = 3;
/** Seconds after a landing at which the units count as home. */
const ARRIVAL_SLACK = 60;
/** A store this full (‰ of its cap) wastes production: its queue starts off the beats. */
const FULL_PM = 950;
/** A city its last raid found without a defender is not raided again for this long (spied empty). */
const EMPTY_COOLDOWN = DAY;
/** Intel flags (spies, losses, empty raids, launches) older than this are dropped from the notes. */
const FORGET = 2 * DAY;

/** When the first wave is planned: protection's end, or `RUSH_FROM` when that comes later. */
function rushAt(w: World): number {
  return Math.max(w.kit.rules.time.attackFrom, RUSH_FROM);
}

/**
 * The hours of opening beyond `RUSH_FROM` (protection ending late), in `LONG_STEP` steps: each
 * raises the rush producers one level and leaves the opening one own wake more for its batches,
 * the day left after the wave being shorter.
 */
function longSteps(w: World): number {
  return Math.max(0, Math.floor((rushAt(w) - RUSH_FROM) / LONG_STEP));
}

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
  /** Stock a raid could take, as the spy report showed it; null when unknown. */
  readonly loot: number | null;
}

/** The combat hints resolved in the effective config (`combatNumbers`): null without a base defense. */
function combatOf(w: World): CombatNumbers | null {
  return combatNumbers(w.kit, w.hints.combat);
}

/** The stock a report shows above what the city's storage protects from loot (hints), or null. */
function lootIn(w: World, data: Readonly<Record<string, unknown>>): number | null {
  const stock = stockInReport(data);
  if (stock === null) return null;
  const per = configInt(w.kit, w.hints.combat?.lootProtectPerLevel) ?? 0;
  const safe = per * (levelsInReport(data)[w.kit.storage] ?? 0);
  let n = 0;
  for (const r of RESOURCE_IDS) n += Math.max(0, stock[r] - safe);
  return n;
}

/**
 * The defense of a city from the seat's latest intel: a spy report's units, the buildings' share
 * (with the combat hints) and what its stock can still train on warning; or, after the seat's own
 * won battle there, the buildings' share and the units' share remembered at launch. Anything else
 * is unknown (null).
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
    return { d: base + units, base, units, at, pop: null, seen: false, loot: null };
  }
  const units = unitsInReport(kit, data);
  const sum = power(kit, units, "defense", true);
  const h = combatOf(w);
  const levels = levelsInReport(data);
  const own = h === null ? 0 : (baseDefenseAt(kit, h.base, levels[h.base.building] ?? 0) ?? 0);
  const wall = kit.wall === null ? 0 : (levels[kit.wall] ?? 0);
  const factor = h === null ? 1000 : 1000 + h.wallPm * wall;
  const react = reactionDefense(kit, levels, stockInReport(data));
  return {
    d: Math.floor(((sum + own + react) * factor) / 1000),
    base: Math.floor((own * factor) / 1000),
    units: sum,
    at,
    pop: landPop(kit, units),
    seen: true,
    loot: lootIn(w, data),
  };
}

/** The seat's morale against `foe` (‰), from the combat hints; 1000 without them. */
function moraleAgainst(w: World, foe: PlayerId | null): number {
  const h = combatOf(w);
  if (h === null || h.moralePm <= 0 || foe === null) return 1000;
  const mine = w.cities.length;
  const theirs = w.others.filter((o) => o.owner === foe).length;
  const m = 1000 - h.moralePm * (mine - theirs);
  return Math.max(h.moraleFloorPm, Math.min(1000, m));
}

/**
 * True when the city is left alone for now: it beat one of the seat's attacks within the cooldown
 * and no newer spy report came, or the seat's last spy there failed within the cooldown (and after
 * it while the defense that failure implies is beyond the army).
 */
function cooling(w: World, p: Planner, prm: Rusher3Params, view: CityView, army: number): boolean {
  const intel = view.access === "public" ? view.intel : null;
  const lost = p.flag(`l${view.id}`);
  if (lost !== null && w.t - lost < prm.cooldown) {
    if (intel === null || intel.type !== "spy_report" || intel.at[0] <= lost) return true;
  }
  const spied = p.flag(`s${view.id}`);
  if (spied === null || p.inFlight("spy", view.id)) return false;
  if (intel !== null && intel.at[0] >= spied) return false;
  if (w.t - spied < prm.cooldown) return true;
  return impliedDefense(w.kit, p.flag(`g${view.id}`) ?? 0) * prm.raidPm > army * 1000;
}

/** The least land defense a city that beat a spy of `gold` holds (counter-intelligence grows with pop). */
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

/**
 * Drops the flags that no longer matter, so that the notes stay small (§11.1): a loss, an empty
 * raid, a spy or a launch remembered for more than `FORGET`, with the numbers kept beside it.
 */
function tidy(p: Planner): void {
  const { w } = p;
  const drop: Record<string, readonly string[]> = { l: [], e: [], s: ["g"], a: ["b", "u"] };
  for (const [name, value] of Object.entries(p.memory.x)) {
    const m = /^([lesa])(c[1-9][0-9]*)$/.exec(name);
    if (m === null || w.t - value < FORGET) continue;
    const kind = m[1]!;
    p.clearFlag(name);
    for (const other of drop[kind] ?? []) p.clearFlag(`${other}${m[2]!}`);
  }
}

/**
 * The own movements bringing attackers home, with their home city and when they are home: a minute
 * after they land (a turn in the second they land may come before them).
 */
function returning(
  w: World,
): { readonly home: CityId | null; readonly at: number; readonly n: number }[] {
  const atk = w.kit.roles.attacker;
  return (w.self?.private?.movements ?? [])
    .filter((m) => m.kind === "return" && m.owner === w.seat && countOf(m.units ?? {}, atk) > 0)
    .map((m) => ({
      home: m.home ?? m.to,
      at: m.arrive[0] + ARRIVAL_SLACK,
      n: countOf(m.units ?? {}, atk),
    }))
    .toSorted((a, b) => a.at - b.at);
}

/** Attackers of `c` that may leave: those at home above the ones its garrison keeps. */
function launchable(p: Planner, c: OwnCity, keep: number): number {
  return Math.max(0, countOf(p.homeOf(c.id), p.w.kit.roles.attacker) - keep);
}

/**
 * When `c` can next strike: now (or `attackFrom`) when enough attackers may leave; else when its
 * attackers on their way home and those its queues deliver add up to enough; before protection
 * ends, `attackFrom` at the earliest; otherwise null.
 */
function readyAt(p: Planner, prm: Rusher3Params, c: OwnCity, keep: number): number | null {
  const { w } = p;
  const kit = w.kit;
  const from = kit.rules.time.attackFrom;
  const atk = kit.roles.attacker;
  if (atk === null) return null;
  let n = launchable(p, c, keep);
  if (n >= prm.minAttackers) return Math.max(w.t, from);
  const arrivals: { at: number; n: number }[] = [];
  for (const r of returning(w)) if (r.home === c.id) arrivals.push({ at: r.at, n: r.n });
  const each = unitTime(p, c, atk);
  const q = kit.units.get(atk)?.queue;
  for (const b of q === undefined ? [] : (c.recruit[q] ?? [])) {
    if (b.unit !== atk) continue;
    if (each === null || each <= 0) {
      arrivals.push({ at: b.end, n: b.count });
      continue;
    }
    // Units trickle: the j-th of a batch is home `(count − j) × each` before the batch ends.
    const first = Math.min(b.count, prm.minAttackers);
    for (let j = 1; j <= first; j += 1) arrivals.push({ at: b.end - (b.count - j) * each, n: 1 });
  }
  for (const a of arrivals.toSorted((x, y) => x.at - y.at)) {
    n += a.n;
    if (n >= prm.minAttackers) return Math.max(a.at, from, w.t);
  }
  return w.t < from ? from : null;
}

/** The land attack `c` can bring at `strike`: attackers at home, queued, and home by then. */
function armyAt(p: Planner, c: OwnCity, strike: number): number {
  const { w } = p;
  const atk = w.kit.roles.attacker;
  if (atk === null) return 0;
  let n = countOf(p.homeOf(c.id), atk) + p.queued(c, atk);
  for (const r of returning(w)) if (r.home === c.id && r.at <= strike) n += r.n;
  return power(w.kit, { [atk]: n }, "attack", true);
}

// Wakes.

/** True while the own wakes left allow one wake every `PLENTY` seconds for the rest of the day. */
function plentiful(w: World): boolean {
  return w.briefing.budget.ownWakesLeft * PLENTY >= (w.day + 1) * DAY - w.t;
}

/** True when the own wakes left allow at most one wake every `PACE` seconds for the rest of the day. */
function scarce(w: World): boolean {
  return w.briefing.budget.ownWakesLeft * PACE <= (w.day + 1) * DAY - w.t;
}

/** A window of time in which a queue that empties does so on a wake the seat has anyway. */
interface Beat {
  readonly lo: number;
  readonly hi: number;
}

/**
 * The windows of the wakes the seat will have anyway, earliest first (an empty queue wakes it on its
 * own budget, unless that happens on one of them): the reports of its spies and attacks on their way
 * (this turn's included), which wake it one grouping window after they land (so a queue that empties
 * within a window either side joins that wake); the times it asked to be awake at this turn, and its
 * self-wake spread over the own wakes left (a queue that empties within a window before them joins
 * that wake). Other queues' ends are not counted: they are what this spacing keeps few.
 */
function beats(p: Planner): Beat[] {
  const { w } = p;
  const g = w.kit.gateway;
  const win = g.groupWindow;
  const out: Beat[] = [];
  const trigger = (t: number): void => {
    if (t > w.t) out.push({ lo: t - win, hi: t + win });
  };
  const wake = (t: number): void => {
    if (t > w.t) out.push({ lo: t - win, hi: t });
  };
  for (const m of w.self?.private?.movements ?? []) {
    if (m.owner === w.seat && (m.kind === "spy" || m.kind === "attack")) trigger(m.arrive[0]);
  }
  for (const c of p.calls) {
    if (c.tool !== "spy" && c.tool !== "attack") continue;
    const args = MoveArgs.safeParse(c.args);
    if (!args.success) continue;
    const to = w.others.find((o) => o.id === args.data.to);
    const from = w.cities.find((x) => x.id === args.data.from);
    if (to === undefined || from === undefined) continue;
    const travel = w.travel(from.id, to.island, c.tool === "spy");
    if (travel !== null) trigger(w.t + travel);
  }
  for (const f of p.wakes) wake(Math.max(f, w.t + g.selfWake.min));
  const gap = Math.ceil(((w.day + 1) * DAY - w.t) / Math.max(1, w.briefing.budget.ownWakesLeft));
  wake(w.t + Math.max(g.selfWake.min, Math.min(gap, g.selfWake.max)));
  return out.toSorted((a, b) => a.lo - b.lo || a.hi - b.hi);
}

/**
 * True when work ending at `end` empties its queue on a wake the seat has anyway: within a beat,
 * or after the last one (a later wake takes over).
 */
function onBeat(end: number, list: readonly Beat[]): boolean {
  const last = list.at(-1);
  if (last === undefined || end >= last.lo) return true;
  return list.some((b) => end >= b.lo && end <= b.hi);
}

/** A recruit order with its time per unit. */
interface Timed {
  readonly unit: UnitId;
  readonly count: number;
  readonly each: number;
}

/**
 * The orders of one queue (after its work ending at `from`), cut so that the queue empties on a beat:
 * all of them when it does; else the last order shrinks to end on the latest beat it can reach, or
 * goes, and so on. When nothing ends on a beat: all of them when the queue is busy (it empties off
 * the beats whatever is added) or the pace of its wakes allows their end (`wakePacer`), none
 * otherwise (the stock waits for a later wake, and a longer batch).
 */
function alignQueue(
  orders: readonly Timed[],
  from: number,
  idle: boolean,
  list: readonly Beat[],
  pace: (end: number) => boolean,
): Timed[] {
  const endOf = (xs: readonly Timed[]): number =>
    xs.reduce((t, o) => t + o.count * Math.max(0, o.each), from);
  if (orders.length === 0 || onBeat(endOf(orders), list)) return [...orders];
  if (!idle || pace(endOf(orders))) return [...orders];
  const out = [...orders];
  while (out.length > 0) {
    const last = out.pop()!;
    const start = endOf(out);
    if (last.each > 0) {
      for (const b of list.toReversed()) {
        const most = Math.min(last.count - 1, Math.floor((b.hi - start) / last.each));
        const least = Math.max(1, Math.ceil((b.lo - start) / last.each));
        if (most >= least) return [...out, { ...last, count: most }];
      }
    }
    if (out.length > 0 && onBeat(endOf(out), list)) return out;
  }
  return [];
}

/**
 * The seat's own wakes, paced over the game day: a trigger at `at` (a report landing, a queue
 * emptying, a self-wake) is allowed when, counted with the triggers already known before it (its
 * spies' and attacks' reports, its busy queues' ends, those allowed this turn; triggers within a
 * grouping window make one wake), the own wakes used by then stay within an even share of the day's
 * budget plus `PACE_SLACK`. A trigger within a window of a known one, or after the day ends (a
 * fresh budget), is always allowed. An allowed trigger counts for the turn's next asks.
 */
function wakePacer(p: Planner): (at: number) => boolean {
  const { w } = p;
  const g = w.kit.gateway;
  const win = g.groupWindow;
  const dayStart = w.day * DAY;
  const dayEnd = dayStart + DAY;
  const used = g.ownWakesPerDay - w.briefing.budget.ownWakesLeft;
  const known: number[] = [];
  const add = (t: number): void => {
    if (t > w.t && t < dayEnd) known.push(t);
  };
  for (const m of w.self?.private?.movements ?? []) {
    if (m.owner === w.seat && (m.kind === "spy" || m.kind === "attack")) add(m.arrive[0]);
  }
  for (const c of w.cities) {
    add(c.build.reduce((end, b) => Math.max(end, b.end), w.t));
    for (const batches of Object.values(c.recruit)) {
      add(batches.reduce((end, b) => Math.max(end, b.end), w.t));
    }
  }
  for (const c of p.calls) {
    if (c.tool !== "spy" && c.tool !== "attack") continue;
    const args = MoveArgs.safeParse(c.args);
    if (!args.success) continue;
    const to = w.others.find((o) => o.id === args.data.to);
    const from = w.cities.find((x) => x.id === args.data.from);
    const travel =
      to === undefined || from === undefined
        ? null
        : w.travel(from.id, to.island, c.tool === "spy");
    if (travel !== null) add(w.t + travel);
  }
  /** Wakes the known triggers up to `t` cost (one per grouping window). */
  const wakesUpTo = (t: number): number => {
    let n = 0;
    let open: number | null = null;
    for (const k of known.toSorted((a, b) => a - b)) {
      if (k > t) break;
      if (open !== null && k <= open + win) continue;
      n += 1;
      open = k;
    }
    return n;
  };
  return (at: number): boolean => {
    if (at >= dayEnd || known.some((k) => Math.abs(k - at) <= win)) return true;
    const quota = Math.floor((g.ownWakesPerDay * (at - dayStart)) / DAY) + PACE_SLACK;
    if (used + wakesUpTo(at) + 1 > quota) return false;
    known.push(at);
    return true;
  };
}

/** The `from` and `to` of a spy or attack call the bot built itself. */
const MoveArgs = z.looseObject({ from: z.string(), to: z.string() });

// Spies.

interface SpyRow {
  readonly target: OtherCity;
  readonly view: CityView;
  readonly est: Estimate | null;
}

/**
 * The cities worth spying (read this turn, not avoided, not cooling, not already attacked), in
 * order: colonies before capitals, and within each the known weakest first (by their last
 * estimate), then the unknown, nearest first. With `nearFirst` (the opening, when nothing is known
 * yet), the nearest first, colonies first among cities about as far.
 */
function spyOrder(
  p: Planner,
  prm: Rusher3Params,
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
  // Never seen: its pop guessed from the day (a capital twice as much), as a failure costs a wake.
  const guess = SPY_POP_PER_DAY * (p.w.day + 1) * (view.capitalOf === null ? 1 : 2);
  let gold = Math.max(min, min * SPY_MULT + (est?.pop ?? guess));
  const last = p.flag(`s${view.id}`);
  const lastGold = p.flag(`g${view.id}`);
  const intel = view.access === "public" ? view.intel : null;
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
 * Spies for the main city's next strike after protection: nothing while a target with intel still
 * fresh then is worth a raid; otherwise the first city of `spyOrder` whose intel would be stale, that
 * no spy is on its way to and that was not last seen far beyond the army, leaving now when its
 * launch time is less than `SPY_SLACK` ahead, else asking to be awake then, both as the own wakes
 * left allow (`wakePacer`); while one spy is in flight (`EARLY_SPIES` in the first hours after
 * protection), no other leaves. Asks to be awake at the strike when a target already waits for it.
 */
function scout(
  p: Planner,
  prm: Rusher3Params,
  main: OwnCity,
  keep: number,
  conquer: boolean,
  pace: (end: number) => boolean,
): void {
  const { w } = p;
  const strike = readyAt(p, prm, main, keep);
  if (strike === null) return;
  const army = armyAt(p, main, strike);
  const carry = carryOf(w.kit, army);
  // A target the army beats at the strike on what it knows (up to twice `stale` old then, with the
  // age margin of that time), as `offense` would weigh it: no spy needed.
  const later = prm.agePm * Math.floor((strike - w.t) / 3600);
  const beatable = candidates(p, prm, main, new Set()).some(
    (c) =>
      strike - c.est.at <= 2 * prm.stale &&
      worthRaid(p, prm, c, carry) &&
      strong(army, { ...c, agePm: c.agePm + later }, prm.raidPm),
  );
  // Awake at the strike when a target already waits for it (an army coming home asks on its own).
  if (strike > w.t && beatable) p.wakeAt(strike);
  // With few own wakes left, a report that lands before the army is ready would cost one more:
  // the spy leaves at the strike, and its report becomes the wake that launches.
  if (strike > w.t && scarce(w)) return;
  const rows = spyOrder(p, prm, main, army);
  const founder = w.kit.roles.founder;
  // With a founder kept for conquests, a colony is weighed for one, which needs a spy report.
  const founding = conquer && countOf(p.homeOf(main.id), founder) + p.queued(main, founder) > 0;
  // Only a spy report is fresh: a raid needs one too (`worthRaid`).
  const fresh = (r: SpyRow): boolean =>
    r.est !== null && r.est.seen && strike - r.est.at <= prm.stale;
  const spyFor = (row: SpyRow): void => {
    const launch = spyLaunch(w, main, row.target, strike);
    if (launch === null) return;
    if (launch > w.t + SPY_SLACK) {
      // A wake just to send it (its report then lands with the strike's), when the day affords it.
      if (pace(launch)) p.wakeAt(launch);
      return;
    }
    // Its report wakes the seat where it lands: on a beat, when the day affords one more wake, or
    // when the army is home already (that wake is the strike's).
    const lands = w.t + (w.travel(main.id, row.target.island, true) ?? 0);
    const list = beats(p);
    if (strike <= w.t || list.some((b) => lands >= b.lo && lands <= b.hi) || pace(lands)) {
      sendSpy(p, main, row);
    }
  };
  const flying = (r: SpyRow): boolean => p.inFlight("spy", r.target.id);
  const early = w.t < rushAt(w) + EARLY_SCOUTING ? EARLY_SPIES : 1;
  let slots = early - rows.filter(flying).length;
  if (slots <= 0) return;
  if (founding) {
    const colony = rows.find(
      (r) =>
        r.target.capitalOf === null &&
        !fresh(r) &&
        !flying(r) &&
        (r.est === null || army * 1000 >= r.est.d * prm.conquerPm),
    );
    if (colony !== undefined) {
      spyFor(colony);
      return;
    }
  }
  if (beatable) return;
  // Recent reports keep showing cities beyond the army: it grows before it spies the unknown (once
  // its first wave has left: until then it looks further for one).
  const beyond = rows.filter(
    (r) =>
      r.est !== null &&
      r.est.seen &&
      w.t - r.est.at <= STRONG_AGE &&
      r.est.d * prm.raidPm > army * 1000,
  ).length;
  for (const row of rows) {
    if (fresh(row) || flying(row)) continue;
    if (row.est === null && beyond >= STRONG_SEEN && p.flag("fs") !== null) continue;
    if (row.est !== null && row.est.d * prm.raidPm > army * 1250) continue;
    spyFor(row);
    slots -= 1;
    if (slots <= 0) return;
  }
}

/** The loot `attack` worth of attackers can carry (the attack is that of attackers only). */
function carryOf(kit: Kit, attack: number): number {
  const atk = kit.roles.attacker;
  const row = atk === null ? undefined : kit.units.get(atk);
  if (row === undefined || row.attack <= 0) return 0;
  return Math.floor(attack / row.attack) * row.carry;
}

// Opening.

/**
 * The opening's spy targets and when their spies leave: their reports land at most `OPENING_SLACK`
 * after one grouping window before protection ends, so that the wake they cause comes as it ends
 * (a wake before it could not launch, and the next one would wait out the shortest self-wake).
 */
function openingSpies(
  p: Planner,
  prm: Rusher3Params,
  main: OwnCity,
): { row: SpyRow; launch: number }[] {
  const { w } = p;
  const strike = rushAt(w) + OPENING_SLACK;
  const out: { row: SpyRow; launch: number }[] = [];
  const travel = (o: OtherCity): number => w.travel(main.id, o.island, false) ?? 0;
  const nearest = strangers(w, main)[0];
  for (const row of spyOrder(p, prm, main, armyAt(p, main, strike), true)) {
    if (out.length >= prm.preSpies) break;
    if (nearest !== undefined && travel(row.target) > travel(nearest) + 3600) break;
    const launch = spyLaunch(w, main, row.target, strike);
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
 * attackers' unlock, those producers to `rushLevel` (higher in a long opening), then the carriers'
 * unlock when needed.
 */
function rushWishes(w: World, main: OwnCity, prm: Rusher3Params, c: OwnCity): Wish[] | null {
  if (c.id !== main.id) return null;
  const kit = w.kit;
  const lv = projectedLevels(c);
  const out: Wish[] = [];
  if ((c.popCap - c.popUsed) * 4 < c.popCap) {
    out.push({ building: kit.population, level: (lv[kit.population] ?? 0) + 1 });
  }
  const producers = [...new Set(attackResources(kit).map((r) => kit.producers[r]))];
  const top = prm.rushLevel + Math.floor(longSteps(w) / 2);
  for (const b of producers) out.push({ building: b, level: Math.min(2, prm.rushLevel) });
  out.push(...unlockWishes(kit, kit.roles.attacker));
  for (const b of producers) out.push({ building: b, level: top });
  if (firstWaveAcrossWater(w, main)) out.push(...unlockWishes(kit, kit.roles.carrier));
  return out;
}

/**
 * The opening's units in the main city: with `final`, first the carriers that lift every attacker
 * when the first wave crosses water; then every attacker the budget and pop allow, keeping
 * `keepGold`: with `final` no more than can train before `doneBy`, without it at least
 * `OVERFLOW_MIN` or none.
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
  if (atkN > 0 && (final || atkN >= OVERFLOW_MIN)) {
    orders.push({ unit: atk, count: atkN });
    budget = subRes(budget, scaleRes(arow.cost, atkN));
    free -= apop * atkN;
  }
  // The carriers' queue ends with the attackers' (one wake for both), when the rest affords it.
  const carriers = orders.find((o) => o.unit === car);
  const each = unitTime(p, main, atk);
  const ceach = car === null ? null : unitTime(p, main, car);
  if (final && carriers !== undefined && crow !== undefined && each !== null && ceach !== null) {
    const end = Math.max(0, atkN) * each - kit.gateway.groupWindow;
    const more = Math.min(
      Math.ceil(end / Math.max(1, ceach)) - carriers.count,
      timesAffordable(budget, crow.cost),
      Math.floor(Math.max(0, free) / Math.max(1, crow.pop)),
      crow.maxPerOrder - carriers.count,
    );
    if (more > 0)
      orders[orders.indexOf(carriers)] = { unit: carriers.unit, count: carriers.count + more };
  }
  if (orders.length > 0) p.recruit(main, orders);
}

/**
 * The opening turn, until the first wave is due (`rushAt`): the rush builds; the spies and the final
 * batch at the first spy's launch time (or `finalLead` before the wave is due without a target),
 * keeping the spies' gold until they leave; a batch before that when an attacker resource nears the
 * storage cap and enough own wakes are left.
 */
function opening(p: Planner, prm: Rusher3Params, main: OwnCity): void {
  const { w } = p;
  const kit = w.kit;
  const from = rushAt(w);
  p.wakeAt(from);
  p.economyWith((c) => rushWishes(w, main, prm, c));
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
    const due = final || done ? s.launch <= w.t + 3600 : s.launch <= w.t + OPENING_SLACK;
    if (due) sendSpy(p, main, s.row);
    // A spy that the final wake sends (or a report that early) needs no wake of its own.
    else if (s.launch > finalAt + 3600 || done) p.wakeAt(s.launch);
  }
  if (done) return;
  if (final) {
    if (p.canRecruit(main, kit.roles.attacker)) p.setFlag("fr", w.t);
    rushUnits(p, main, 0, true, from - kit.gateway.groupWindow);
    return;
  }
  p.wakeAt(finalAt);
  if (w.briefing.budget.ownWakesLeft <= OPENING_RESERVE - longSteps(w)) return;
  const stock = p.stockOf(main.id);
  if (attackResources(kit).some((r) => stock[r] * 10 >= main.cap * 7)) {
    const keep = kit.rules.movement.spyMinGold * SPY_MULT * pending.length;
    rushUnits(p, main, keep, false, from);
  }
}

// Strikes.

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
 * before an attack lands: half the units last seen there, or, for a city without intel, as much as
 * the target's own units or buildings' share.
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
 * The targets `from` weighs this turn: read, not avoided, not cooling down, not attacked by the
 * seat already (this turn's launches in `hit`), with intel at most `MAX_AGE` old.
 */
function candidates(
  p: Planner,
  prm: Rusher3Params,
  from: OwnCity,
  hit: ReadonlySet<CityId>,
  scan = prm.scan,
): Candidate[] {
  const { w } = p;
  const out: Candidate[] = [];
  const unhinted = combatOf(w) === null ? UNHINTED_PM : 0;
  const army = power(w.kit, p.homeOf(from.id), "attack", true);
  for (const target of strangers(w, from).slice(0, scan)) {
    if (hit.has(target.id)) continue;
    const view = w.views.get(target.id);
    if (!weighable(w, view) || cooling(w, p, prm, view, army)) continue;
    if (p.inFlight("attack", target.id)) continue;
    const seen = estimateCity(w, p, view);
    if (seen === null) continue;
    const age = Math.max(0, w.t - seen.at);
    if (age > MAX_AGE) continue;
    const travel = w.travel(from.id, target.island, false);
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

/**
 * True when a raid on the candidate is worth its trip: on a spy report (a won battle says nothing
 * of what came since), showing defenders to kill, or else loot worth `emptyLoot` (half the carry at
 * most) above what the city's storage protects, in a city its last raid did not find empty within
 * `EMPTY_COOLDOWN` (raided empty again and again, a city is one to take, not to raid).
 */
function worthRaid(p: Planner, prm: Rusher3Params, c: Candidate, carry: number): boolean {
  if (!c.est.seen) return false;
  if (c.est.units > 0) return true;
  const empty = p.flag(`e${c.target.id}`);
  if (empty !== null && p.w.t - empty < EMPTY_COOLDOWN) return false;
  const loot = c.est.loot;
  return loot === null || loot >= Math.min(prm.emptyLoot, Math.floor(carry / 2));
}

/**
 * Remembers the cities its won raids found without a defender (`e<city>`, from its latest battle
 * report there: no defending stack held a unit), for `worthRaid`.
 */
function noteEmpty(w: World, p: Planner): void {
  for (const view of w.views.values()) {
    if (view.access !== "public" || view.intel === null) continue;
    const { type, data, at } = view.intel;
    if (type !== "battle_report" || data["attacker"] !== w.seat) continue;
    if (data["winner"] !== "attacker") continue;
    const parsed = StacksSchema.safeParse(data["stacks"]);
    if (!parsed.success || parsed.data.length === 0) continue;
    if (parsed.data.some((x) => x.side === "defender" && x.before > 0)) continue;
    const flag = `e${view.id}`;
    if ((p.flag(flag) ?? -1) < at[0]) p.setFlag(flag, at[0]);
  }
}

/** The stacks of a battle report, as far as `noteEmpty` reads them (ruleset-shaped, often absent). */
const StacksSchema = z.array(z.looseObject({ side: z.string(), before: z.int().nonnegative() }));

/**
 * The attack group `from` sends to `island`: at most `max` attackers (as many as its carriers
 * lift), its warships when crossing water, and exactly `founders` founders when that many are at
 * home and fit (otherwise none). Returns the land attack strength too.
 */
function attackGroup(
  p: Planner,
  from: OwnCity,
  island: IslandId,
  founders: number,
  max: number,
): { units: UnitCounts; strength: number } | null {
  const kit = p.w.kit;
  const attacker = kit.roles.attacker;
  if (attacker === null) return null;
  const home = p.homeOf(from.id);
  const apop = Math.max(1, kit.units.get(attacker)?.pop ?? 1);
  const fpop = kit.units.get(kit.roles.founder)?.pop ?? 0;
  const lift = p.liftCapacity(from, island);
  const f =
    founders > 0 && countOf(home, kit.roles.founder) >= founders && founders * fpop <= lift
      ? founders
      : 0;
  const n = Math.min(max, countOf(home, attacker), Math.floor((lift - f * fpop) / apop));
  if (n <= 0) return null;
  const land: Record<string, number> = { [attacker]: n };
  if (f > 0) land[kit.roles.founder] = f;
  const units = p.withCarriers(from, island, land);
  if (units === null) return null;
  const navy = kit.roles.navy;
  if (navy !== null && from.island !== island && countOf(home, navy) > 0)
    units[navy] = countOf(home, navy);
  return { units, strength: power(kit, units, "attack", true) };
}

/**
 * Launches one attack from `c`: a conquest attempt on the weakest colony on a fresh spy report,
 * else a raid on the weakest target worth one. With `hold`, a colony the army could take on what
 * was last seen keeps the army home while its fresh report comes (or a spy can leave now).
 */
function strikeFrom(
  p: Planner,
  prm: Rusher3Params,
  c: OwnCity,
  max: number,
  hit: Set<CityId>,
  hold: boolean,
  pace: (at: number) => boolean,
): void {
  const { w } = p;
  const kit = w.kit;
  const atk = kit.roles.attacker;
  if (atk === null) return;
  const scan = c.id === mainCity(w)?.id ? prm.scan : SCAN_OTHERS;
  const cands = candidates(p, prm, c, hit, scan);
  const launch = (x: Candidate, units: UnitCounts, kind: string): void => {
    if (!p.attack(c, x.target.id, units)) return;
    hit.add(x.target.id);
    p.setFlag(`b${x.target.id}`, x.est.base);
    p.setFlag(`u${x.target.id}`, x.est.units);
    p.setFlag(`a${x.target.id}`, w.t);
    if (p.flag("fs") === null) p.setFlag("fs", w.t);
    p.memo(`${kind} ${x.target.id} D${w.day + 1}`);
  };
  const founder = kit.roles.founder;
  if (countOf(p.homeOf(c.id), founder) >= CONQUEST_FOUNDERS) {
    const ready = (x: Candidate): boolean => x.est.seen && w.t - x.est.at <= prm.stale;
    const colonies = cands.filter((x) => x.target.capitalOf === null);
    for (const x of colonies.filter(ready).toSorted(weakest)) {
      const g = attackGroup(p, c, x.target.island, CONQUEST_FOUNDERS, max);
      if (g === null || countOf(g.units, founder) !== CONQUEST_FOUNDERS) continue;
      if (countOf(g.units, atk) < prm.minAttackers || !strong(g.strength, x, prm.conquerPm)) {
        continue;
      }
      launch(x, g.units, "siege");
      return;
    }
    if (hold) {
      const g = attackGroup(p, c, c.island, CONQUEST_FOUNDERS, max);
      const strength = g === null ? 0 : g.strength;
      const spyGold = SPY_MULT * kit.rules.movement.spyMinGold;
      const canSpy = spiesLeft(p) > 0 && p.stockOf(c.id).gold >= spyGold;
      const held = colonies.filter((x) => !ready(x) && strength * 1000 >= x.est.d * prm.conquerPm);
      if (held.some((x) => p.inFlight("spy", x.target.id)) || (held.length > 0 && canSpy)) return;
    }
  }
  for (const x of cands.toSorted(weakest)) {
    const g = attackGroup(p, c, x.target.island, 0, max);
    if (g === null || countOf(g.units, atk) < prm.minAttackers) continue;
    if (!strong(g.strength, x, prm.raidPm)) continue;
    if (!worthRaid(p, prm, x, carryOf(kit, g.strength))) continue;
    // Its battle report wakes the seat where it lands: only as the day's wakes allow (the rush's
    // first strike goes regardless).
    if (p.flag("fs") !== null && !pace(w.t + x.travel)) continue;
    launch(x, g.units, "raid");
    return;
  }
}

/**
 * Breaks the sieges of its own cities: the garrison a besieger holds there shows in the city's own
 * view (its units, plus the city's buildings' share and wall), so from the cities whose attackers
 * may leave, nearest first, an attack on the besieged city (its foe is the besieger) goes when it
 * beats that garrison by `raidPm` plus `RELIEF_PM` (the besieger may reinforce it); one city at
 * most per besieged city and turn.
 */
function relieve(p: Planner, prm: Rusher3Params, keep: ReadonlyMap<CityId, number>): void {
  const { w } = p;
  const kit = w.kit;
  const atk = kit.roles.attacker;
  if (atk === null || w.t < kit.rules.time.attackFrom) return;
  const h = combatOf(w);
  for (const city of w.cities) {
    if (!city.blocked || p.attacksLeft <= 0) continue;
    const view = w.views.get(city.id);
    if (view === undefined || view.access !== "full") continue;
    const holds = view.stationed.filter((s) => s.role === "hold" && s.owner !== w.seat);
    const by = holds[0]?.owner ?? null;
    if (by === null || p.inFlight("attack", city.id)) continue;
    let units = 0;
    for (const s of holds) units += power(kit, s.units, "defense", true);
    const base =
      h === null || city.levels === null
        ? 0
        : (baseDefenseAt(kit, h.base, city.levels[h.base.building] ?? 0) ?? 0);
    const wall = kit.wall === null || city.levels === null ? 0 : (city.levels[kit.wall] ?? 0);
    const factor = h === null ? 1000 : 1000 + h.wallPm * wall;
    const d = Math.floor(((units + base) * factor) / 1000);
    const pm = prm.raidPm + RELIEF_PM + (h === null ? UNHINTED_PM : 0);
    const morale = moraleAgainst(w, by);
    const helpers = w.cities
      .filter((c) => c.id !== city.id && !c.blocked)
      .map((c) => ({ c, travel: w.travel(c.id, city.island, false) }))
      .filter((x): x is { c: OwnCity; travel: number } => x.travel !== null)
      .toSorted((a, b) => a.travel - b.travel || compareIds(a.c.id, b.c.id));
    for (const { c } of helpers) {
      const n = launchable(p, c, keep.get(c.id) ?? 0);
      if (n < prm.minAttackers) continue;
      const g = attackGroup(p, c, city.island, 0, n);
      if (g === null) continue;
      const a = Math.floor((g.strength * morale) / 1000);
      if (a <= d || a * 1000 < d * pm) continue;
      if (!p.attack(c, city.id, g.units)) return;
      p.memo(`relief ${city.id} D${w.day + 1}`);
      break;
    }
  }
}

/** Strikes from every city with enough attackers that may leave, the most attackers first. */
function offense(
  p: Planner,
  prm: Rusher3Params,
  keep: ReadonlyMap<CityId, number>,
  hold: boolean,
  pace: (at: number) => boolean = () => true,
): void {
  const { w } = p;
  if (w.kit.roles.attacker === null || w.t < w.kit.rules.time.attackFrom) return;
  const main = mainCity(w);
  const order = w.cities
    .filter((c) => !c.blocked)
    .map((c) => ({ c, n: launchable(p, c, keep.get(c.id) ?? 0) }))
    .filter((x) => x.n >= prm.minAttackers)
    .toSorted((a, b) => b.n - a.n || compareIds(a.c.id, b.c.id));
  const hit = new Set<CityId>();
  for (const { c, n } of order) {
    if (p.attacksLeft <= 0) return;
    strikeFrom(p, prm, c, n, hit, hold && c.id === main?.id, pace);
  }
}

/** Recalls an attack within the window when a spy report newer than its launch shows a stronger defense. */
function recallWeakened(p: Planner, prm: Rusher3Params): void {
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

// Garrisons.

/** The strongest attack a stranger's city showed at home in a spy report of the last day. */
function threatSeen(w: World): number {
  let worst = 0;
  for (const view of w.views.values()) {
    if (view.access !== "public" || view.intel === null || view.intel.type !== "spy_report") {
      continue;
    }
    if (view.owner === null || view.owner === w.seat || w.relations.has(view.owner)) continue;
    if (w.t - view.intel.at[0] > THREAT_AGE) continue;
    worst = Math.max(worst, power(w.kit, unitsInReport(w.kit, view.intel.data), "attack", true));
  }
  return worst;
}

/** The defense every own city keeps: a floor that grows by the day, raised to the threat seen. */
function garrisonTarget(w: World, prm: Rusher3Params, threat: number): number {
  const floor = GARRISON_BASE + GARRISON_PER_DAY * w.day;
  return Math.min(
    floor * GARRISON_CAP,
    Math.max(floor, Math.floor((threat * prm.garrisonPm) / 1000)),
  );
}

/** The defense of the defenders at home in `c` after this turn's moves (attackers left out). */
function homeGuard(p: Planner, c: OwnCity): number {
  const kit = p.w.kit;
  const atk = kit.roles.attacker;
  const home: Record<string, number> = { ...p.homeOf(c.id) };
  if (atk !== null) delete home[atk];
  return power(kit, home, "defense", true);
}

/**
 * The defense an own city holds without its attackers: its defenders at home, the groups stationed
 * there (not a besieger's garrison), the seat's supports on their way, and its buildings' share.
 */
function heldDefense(p: Planner, c: OwnCity): number {
  const { w } = p;
  const kit = w.kit;
  let d = homeGuard(p, c);
  const view = w.views.get(c.id);
  if (view !== undefined && view.access === "full") {
    for (const s of view.stationed)
      if (s.role !== "hold") d += power(kit, s.units, "defense", true);
  }
  for (const m of w.self?.private?.movements ?? []) {
    if (m.owner === w.seat && m.kind === "support" && m.to === c.id) {
      d += power(kit, m.units ?? {}, "defense", true);
    }
  }
  const h = combatOf(w);
  if (h === null || c.levels === null) return d;
  const base = baseDefenseAt(kit, h.base, c.levels[h.base.building] ?? 0) ?? 0;
  const wall = kit.wall === null ? 0 : (c.levels[kit.wall] ?? 0);
  return Math.floor(((d + base) * (1000 + h.wallPm * wall)) / 1000);
}

interface Garrisons {
  /** Defense each own city still lacks after this turn's supports. */
  readonly lack: ReadonlyMap<CityId, number>;
  /** Attackers each city keeps home for its defense. */
  readonly keep: ReadonlyMap<CityId, number>;
  readonly target: number;
}

/**
 * Brings every own city to the garrison target: defenders from the cities with some to spare
 * (above their own target), nearest first, to the cities that lack the most; then, outside the
 * capital, the attackers its defense still lacks stay home. What is still missing is recruited
 * (`recruitArmy`).
 */
function garrisons(p: Planner, prm: Rusher3Params): Garrisons {
  const { w } = p;
  const kit = w.kit;
  const lack = new Map<CityId, number>();
  const keep = new Map<CityId, number>();
  const target = garrisonTarget(w, prm, threatSeen(w));
  const def = kit.roles.defender;
  const drow = def === null ? undefined : kit.units.get(def);
  const atk = kit.roles.attacker;
  const arow = atk === null ? undefined : kit.units.get(atk);
  const cities = w.cities.filter((c) => !c.blocked);
  const lacking = (c: OwnCity): number => Math.max(0, target - heldDefense(p, c));
  if (def !== null && drow !== undefined && drow.defense > 0) {
    const spare = (h: OwnCity): number => {
      const own = countOf(p.homeOf(h.id), def);
      const without = heldDefense(p, h) - own * drow.defense;
      return Math.max(0, own - Math.ceil(Math.max(0, target - without) / drow.defense));
    };
    const needy = cities
      .map((c) => ({ c, need: lacking(c) }))
      .filter((x) => x.need > 0)
      .toSorted((a, b) => b.need - a.need || compareIds(a.c.id, b.c.id));
    for (const { c, need: first } of needy) {
      let need = first;
      const helpers = cities
        .filter((h) => h.id !== c.id)
        .map((h) => ({ h, travel: w.travel(h.id, c.island, false) }))
        .filter((x): x is { h: OwnCity; travel: number } => x.travel !== null)
        .toSorted((a, b) => a.travel - b.travel || compareIds(a.h.id, b.h.id));
      for (const { h } of helpers) {
        if (need <= 0) break;
        const lift = Math.floor(p.liftCapacity(h, c.island) / Math.max(1, drow.pop));
        const n = Math.min(spare(h), Math.ceil(need / drow.defense), lift);
        if (n < MIN_SUPPORT) continue;
        const group = p.withCarriers(h, c.island, { [def]: n });
        if (group === null) continue;
        p.support(h, c.id, group);
        need -= n * drow.defense;
      }
      lack.set(c.id, Math.max(0, need));
    }
  } else {
    for (const c of cities) lack.set(c.id, lacking(c));
  }
  const capital = w.cities.find((c) => c.capital)?.id ?? null;
  if (arow !== undefined && arow.defense > 0) {
    for (const c of cities) {
      const need = lack.get(c.id) ?? 0;
      if (need <= 0 || c.id === capital) continue;
      keep.set(c.id, Math.ceil(need / arow.defense));
    }
  }
  return { lack, keep, target };
}

/**
 * Sends defenders once to every siege the seat holds (marked `gr<city>` until it is no longer held),
 * from the nearest city with some to spare: they defend the garrison, and stay as the city's own
 * when it falls.
 */
function holdSieges(p: Planner, g: Garrisons): void {
  const { w } = p;
  const kit = w.kit;
  const def = kit.roles.defender;
  const drow = def === null ? undefined : kit.units.get(def);
  const holds: CityId[] = [];
  for (const s of w.self?.private?.stationed ?? []) {
    if (s.role === "hold" && !holds.includes(s.city)) holds.push(s.city);
  }
  const held = new Set<string>(holds);
  for (const name of Object.keys(p.memory.x)) {
    const m = /^gr(c[1-9][0-9]*)$/.exec(name);
    if (m !== null && !held.has(m[1]!)) p.clearFlag(name);
  }
  if (def === null || drow === undefined || drow.defense <= 0) return;
  for (const city of holds.toSorted(compareIds)) {
    if (p.flag(`gr${city}`) !== null) continue;
    const row = w.map?.cities.find((c) => c.id === city);
    if (row === undefined) continue;
    const helpers = w.cities
      .filter((c) => !c.blocked)
      .map((c) => ({ c, travel: w.travel(c.id, row.island, false) }))
      .filter((x): x is { c: OwnCity; travel: number } => x.travel !== null)
      .toSorted((a, b) => a.travel - b.travel || compareIds(a.c.id, b.c.id));
    for (const { c } of helpers) {
      const own = countOf(p.homeOf(c.id), def);
      const keepHere = Math.ceil(
        Math.max(0, g.target - (heldDefense(p, c) - own * drow.defense)) / drow.defense,
      );
      const lift = Math.floor(p.liftCapacity(c, row.island) / Math.max(1, drow.pop));
      const n = Math.min(own - keepHere, Math.ceil(g.target / drow.defense), lift);
      if (n < MIN_SUPPORT) continue;
      const group = p.withCarriers(c, row.island, { [def]: n });
      if (group === null) continue;
      p.support(c, city, group);
      break;
    }
    p.setFlag(`gr${city}`, w.t);
  }
}

// Growth.

/** Build wishes the strategy adds per city this turn (before the generic economy's). */
type Wishes = Map<CityId, Wish[]>;

function wishFor(wishes: Wishes, id: CityId, ...more: Wish[]): void {
  wishes.set(id, [...(wishes.get(id) ?? []), ...more]);
}

/** Foundings on their way (remembered in the notes). */
function pendingFoundings(p: Planner): number {
  let n = 0;
  for (const etas of Object.values(p.memory.f)) n += etas.length;
  return n;
}

/** Attackers the seat owns: at home, queued and away. */
function attackersOwned(p: Planner): number {
  const { w } = p;
  const atk = w.kit.roles.attacker;
  if (atk === null) return 0;
  let n = unitsAway(w, atk);
  for (const c of w.cities) n += countOf(p.homeOf(c.id), atk) + p.queued(c, atk);
  return n;
}

/**
 * Cities wanted now: one until its first wave has left (or `FOUND_AFTER` after it was due),
 * two on day 1, `earlyCities` on day 2; from day 3, `maxCities` while its army holds at least
 * `ARMY_PER_DAY` attackers per day played (a rusher grows once its army is fed), else no more.
 */
function citiesWanted(p: Planner, prm: Rusher3Params): number {
  const { w } = p;
  if (p.flag("fs") === null && w.t < rushAt(w) + FOUND_AFTER) return 1;
  if (w.day === 0) return 2;
  if (w.day === 1) return Math.max(2, prm.earlyCities);
  return attackersOwned(p) >= ARMY_PER_DAY * w.day ? prm.maxCities : 0;
}

/** The city that recruits founders: the capital when it can act, else the richest city. */
function hubCity(w: World): OwnCity | null {
  const free = w.cities.filter((c) => !c.blocked && c.levels !== null);
  const capital = free.find((c) => c.capital);
  if (capital !== undefined) return capital;
  return (
    free.toSorted((a, b) => largest(b.res) - largest(a.res) || compareIds(a.id, b.id))[0] ?? null
  );
}

/** True when more cities are wanted and a free slot is in reach of the founders' city. */
function foundingWanted(p: Planner, prm: Rusher3Params, hub: OwnCity | null): boolean {
  const { w } = p;
  if (hub === null || w.map === null) return false;
  if (w.cities.length + pendingFoundings(p) >= citiesWanted(p, prm)) return false;
  return p.pickSlot(hub, null) !== null;
}

/** Founds with the founders at home while cities are wanted: one per founder, with an escort and its carriers. */
function settle(p: Planner, prm: Rusher3Params): void {
  const { w } = p;
  const kit = w.kit;
  const founder = kit.roles.founder;
  const defender = kit.roles.defender;
  const want = citiesWanted(p, prm);
  const fpop = kit.units.get(founder)?.pop ?? 0;
  const dpop = defender === null ? 0 : (kit.units.get(defender)?.pop ?? 0);
  for (const c of w.cities) {
    if (c.blocked) continue;
    while (countOf(p.homeOf(c.id), founder) > 0) {
      if (w.cities.length + pendingFoundings(p) >= want) return;
      const slot = p.pickSlot(c, fpop);
      if (slot === null) break;
      let escort = Math.min(prm.escort, Math.floor(countOf(p.homeOf(c.id), defender) / 2));
      const lift = p.liftCapacity(c, slot.island);
      if (dpop > 0) escort = Math.max(0, Math.min(escort, Math.floor((lift - fpop) / dpop)));
      const land: Record<string, number> = { [founder]: 1 };
      if (defender !== null && escort > 0) land[defender] = escort;
      const group = p.withCarriers(c, slot.island, land);
      if (group === null) break;
      p.found(c, slot.island, group, slot.slot, w.t + slot.travel);
      p.memo(`found ${slot.island} D${w.day + 1}`);
    }
  }
}

/**
 * Keeps one founder coming while cities are wanted: recruits it in the hub when requirements, pop
 * and stock allow, otherwise reserves its cost (when affordable soon, so loot goes to it first) or
 * asks for the buildings it needs; with a founding across water, the carriers its group needs.
 */
function recruitFounder(p: Planner, hub: OwnCity, wishes: Wishes): void {
  const { w } = p;
  const kit = w.kit;
  const founder = kit.roles.founder;
  const row = kit.units.get(founder);
  if (row === undefined || hub.levels === null) return;
  let have = 0;
  for (const c of w.cities) have += countOf(p.homeOf(c.id), founder) + p.queued(c, founder);
  if (have > 0) return;
  const cost = w.self?.private?.settler.cost;
  if (cost === undefined) return;
  if (largest(cost) > hub.cap) {
    const level = storageLevelFor(kit, largest(cost));
    if (level !== null) wishFor(wishes, hub.id, { building: kit.storage, level });
    return;
  }
  if (!meets(row.requires, hub.levels)) {
    wishFor(wishes, hub.id, ...unlockWishes(kit, founder));
    return;
  }
  if (p.popFreeOf(hub.id) < row.pop) {
    const lv = projectedLevels(hub)[kit.population] ?? 0;
    wishFor(wishes, hub.id, { building: kit.population, level: lv + 1 });
    return;
  }
  if (!p.canRecruit(hub, founder)) return;
  if (covers(p.stockOf(hub.id), cost)) {
    p.recruit(hub, [{ unit: founder, count: 1 }], cost);
    return;
  }
  const eta = etaAfford(p.stockOf(hub.id), hub.rate, cost, hub.cap);
  // The second city's price is set aside whatever the army; later ones once the army is fed.
  const fed = w.cities.length + pendingFoundings(p) <= 1 || attackersOwned(p) >= FOUNDER_ARMY;
  if (eta !== null && eta <= 2 * p.k.cadence && fed) p.reserve(hub.id, cost);
}

/**
 * Keeps one founder at home for the next conquest: recruits it in the main city, reserving its cost
 * when it is affordable soon, or asks for the buildings (and the storage) it needs.
 */
function conquestFounder(p: Planner, main: OwnCity, wishes: Wishes): void {
  const { w } = p;
  const kit = w.kit;
  const founder = kit.roles.founder;
  if (countOf(p.homeOf(main.id), founder) + p.queued(main, founder) >= CONQUEST_FOUNDERS) return;
  const row = kit.units.get(founder);
  if (row === undefined || main.levels === null) return;
  if (!p.canRecruit(main, founder)) {
    wishFor(wishes, main.id, ...unlockWishes(kit, founder));
    return;
  }
  const cost = w.self?.private?.settler.cost;
  if (cost === undefined) return;
  if (largest(cost) > main.cap) {
    const level = storageLevelFor(kit, largest(cost));
    if (level !== null) wishFor(wishes, main.id, { building: kit.storage, level });
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

/** True when a stranger's colony (no one's capital) is among the nearest targets. */
function colonyInReach(w: World, prm: Rusher3Params, main: OwnCity): boolean {
  return strangers(w, main)
    .slice(0, prm.scan)
    .some((o) => o.capitalOf === null && weighable(w, w.views.get(o.id)));
}

// Queues.

/** Units of `unit` in the seat's own movements (attacks, returns, sieges on their way). */
function unitsAway(w: World, unit: UnitId | null): number {
  let n = 0;
  for (const m of w.self?.private?.movements ?? []) {
    if (m.owner === w.seat) n += countOf(m.units ?? {}, unit);
  }
  return n;
}

/** Units of `unit` in the city's recruit queues when the turn began. */
function queuedIn(c: OwnCity, unit: UnitId): number {
  let n = 0;
  for (const batches of Object.values(c.recruit)) {
    for (const b of batches) if (b.unit === unit) n += b.count;
  }
  return n;
}

/** When the city's recruit queue `queue` empties (now when it is empty). */
function queueEnd(w: World, c: OwnCity, queue: QueueId): number {
  return (c.recruit[queue] ?? []).reduce((end, b) => Math.max(end, b.end), w.t);
}

/** Seconds the build items take, queued after the city's current queue (completed hall speed). */
function buildSeconds(kit: Kit, c: OwnCity, items: readonly BuildingId[]): number {
  if (c.levels === null) return 0;
  const lv = projectedLevels(c);
  const speed = kit.rules.roles.buildSpeed;
  const at = speed === null ? 0 : (c.levels[speed] ?? 0);
  let total = 0;
  for (const b of items) {
    const row = kit.buildings.get(b);
    if (row === undefined) continue;
    const target = (lv[b] ?? 0) + 1;
    lv[b] = target;
    const times = row.time?.[target] ?? [];
    total += times[Math.min(at, times.length - 1)] ?? 0;
  }
  return total;
}

/**
 * True when a resource of the city's stock (of `only`, by default any) is at `pm` ‰ of its storage
 * cap or more: a full store wastes production.
 */
function nearCap(p: Planner, c: OwnCity, pm: number, only?: readonly ResourceId[]): boolean {
  const stock = p.stockOf(c.id);
  return (only ?? RESOURCE_IDS).some((r) => stock[r] * 1000 >= c.cap * pm);
}

/**
 * The generic economy with the strategy's wishes first, except that a city whose build queue is
 * empty starts it only when the items it would queue end on a beat (`onBeat`) or `pace` allows
 * their end, its store is full (`FULL_PM`) or own wakes are plentiful; with `tight` (own wakes kept
 * for a time the seat must be awake at), not at all.
 */
function economy(p: Planner, wishes: Wishes, tight: boolean, pace: (end: number) => boolean): void {
  const { w } = p;
  const kit = w.kit;
  const easy = plentiful(w);
  p.economyWith((c) => {
    const mine = wishes.get(c.id) ?? [];
    const list = economyWishes(p, c, mine);
    const busyUntil = c.build.reduce((end, b) => Math.max(end, b.end), w.t);
    if (busyUntil > w.t) return list;
    if (tight) return [];
    if (easy || nearCap(p, c, FULL_PM) || c.levels === null) return list;
    const plan = planBuilds(
      kit,
      c.levels,
      [],
      list,
      p.budgetOf(c.id),
      c.rate,
      c.cap,
      kit.rules.queues.build.max,
      p.k.cadence,
    );
    const end = w.t + buildSeconds(kit, c, plan.items);
    return plan.items.length > 0 && (onBeat(end, beats(p)) || pace(end)) ? list : [];
  });
}

/**
 * The army between waves, city by city, from `spendPm` of what is left: in the main city the
 * carriers that lift its attackers plus one (room for a founder); then the defenders its garrison
 * (and, in the main city, the garrisons of cities that cannot train them) still lacks, with at most
 * `GARRISON_SPEND_PM` of the budget; then packs of the mix (attackers and defenders; attackers only
 * when their queue has room for one batch only). A recruit queue that runs dry wakes the seat, so
 * the orders that start an idle queue are cut to end on a beat (`alignQueue`, with the off-beat
 * allowance), unless they are needed now (the attackers at home outgrow their carriers, or an attack
 * is on its way to a city whose garrison lacks defenders), the store of the attackers' resources is
 * full or own wakes are plentiful; a busy queue takes any batch.
 */
function recruitArmy(
  p: Planner,
  main: OwnCity,
  g: Garrisons,
  pace: (end: number) => boolean,
): void {
  const { w, k } = p;
  const kit = w.kit;
  const atk = kit.roles.attacker;
  const arow = atk === null ? undefined : kit.units.get(atk);
  if (atk === null || arow === undefined) return;
  const def = kit.roles.defender;
  const drow = def === null ? undefined : kit.units.get(def);
  const car = kit.roles.carrier;
  const crow = car === null ? undefined : kit.units.get(car);
  const spyGold = res(0, 0, kit.rules.movement.spyMinGold * SPY_MULT);
  const owned = attackersOwned(p);
  // Defense lacking in cities that cannot train defenders: the main city trains it for them.
  let elsewhere = 0;
  for (const c of w.cities) {
    if (c.id === main.id || def === null || p.canRecruit(c, def)) continue;
    elsewhere += g.lack.get(c.id) ?? 0;
  }
  for (const c of w.cities) {
    if (c.blocked || c.levels === null) continue;
    const spendable = c.id === main.id ? subRes(p.budgetOf(c.id), spyGold) : p.budgetOf(c.id);
    let budget = pmRes(spendable, k.spendPm);
    let free = p.popFreeOf(c.id);
    const orders: { unit: UnitId; count: number }[] = [];
    // Queues whose orders go in even when they start the queue idle: needed now.
    const urgent = new Set<string>();
    const room = new Map<string, number>();
    const roomOf = (row: { readonly queue: string }): number =>
      room.get(row.queue) ?? p.batchRoomOf(c.id, row.queue);
    const order = (unit: UnitId, count: number): void => {
      const row = kit.units.get(unit);
      if (row === undefined || count <= 0) return;
      orders.push({ unit, count });
      room.set(row.queue, roomOf(row) - 1);
      budget = subRes(budget, scaleRes(row.cost, count));
      free -= row.pop * count;
    };
    if (c.id === main.id && car !== null && crow !== undefined && crow.capacity > 0) {
      if (kit.rules.movement.transportRule && p.canRecruit(c, car) && roomOf(crow) > 0) {
        const lift = countOf(c.units, atk) + p.queued(c, atk) + unitsAway(w, atk);
        const have = countOf(c.units, car) + p.queued(c, car) + unitsAway(w, car);
        const want = Math.ceil((lift * Math.max(1, arow.pop)) / crow.capacity) + 1 - have;
        // The attackers at home already outgrow the carriers there: a wave would leave some behind.
        const home = countOf(p.homeOf(c.id), atk) * Math.max(1, arow.pop);
        if (home > p.carrierLift(c) + crow.capacity) urgent.add(crow.queue);
        order(
          car,
          Math.min(
            want,
            timesAffordable(budget, crow.cost),
            Math.floor(free / Math.max(1, crow.pop)),
            crow.maxPerOrder,
          ),
        );
      }
    }
    if (def !== null && drow !== undefined && drow.defense > 0 && p.canRecruit(c, def)) {
      const lack = (g.lack.get(c.id) ?? 0) + (c.id === main.id ? elsewhere : 0);
      const want = Math.ceil(lack / drow.defense);
      // An attack on its way: the defenders go in even when they start the queue.
      const attacked = w.briefing.incoming.some(
        (i) => i.kind === "attack" && i.to === c.id && i.arrive[0] > w.t,
      );
      if (attacked) urgent.add(drow.queue);
      if (want > 0 && roomOf(drow) > (drow.queue === arow.queue ? 1 : 0)) {
        const qmax = kit.queues.get(drow.queue)?.maxCount ?? drow.maxPerOrder;
        const n = Math.min(
          want,
          timesAffordable(pmRes(budget, GARRISON_SPEND_PM), drow.cost),
          Math.floor(Math.max(0, free) / Math.max(1, drow.pop)),
          drow.maxPerOrder,
          qmax,
        );
        // A handful of defenders now and as many later would wake the seat twice for one garrison.
        if (n >= Math.min(want, MIN_GARRISON_BATCH)) order(def, n);
      }
    }
    // The army is trained where it is ordered from: the other cities train their garrisons only.
    if (c.id === main.id && p.canRecruit(c, atk) && roomOf(arow) > 0) {
      const defRoom = drow === undefined ? 0 : roomOf(drow) - (drow.queue === arow.queue ? 1 : 0);
      const dn =
        drow !== undefined && def !== null && p.canRecruit(c, def) && defRoom > 0
          ? k.mix.defender
          : 0;
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
      if (packs > 0) {
        const qmax = kit.queues.get(arow.queue)?.maxCount ?? arow.maxPerOrder;
        order(atk, Math.min(packs * an, arow.maxPerOrder, qmax));
        if (dn > 0 && def !== null && drow !== undefined) {
          order(def, Math.min(packs * dn, drow.maxPerOrder, qmax));
        }
      }
    }
    // Each queue's orders are cut so that it empties on a beat (the last order of a queue gives
    // way first), unless they are needed now, the stock nears the cap or wakes are plentiful.
    const loose = plentiful(w) || nearCap(p, c, FULL_PM, attackResources(kit));
    // A batch that adds a quarter to the army is worth the wake its end costs.
    const worth = Math.max(MIN_WORTH, Math.ceil(owned / 4));
    const kept: { unit: UnitId; count: number }[] = [];
    for (const q of new Set(orders.map((o) => kit.units.get(o.unit)?.queue ?? ""))) {
      const mine = orders.filter((o) => (kit.units.get(o.unit)?.queue ?? "") === q);
      const adds = mine.reduce((n, o) => n + (o.unit === atk ? o.count : 0), 0);
      if (loose || urgent.has(q) || adds >= worth) {
        kept.push(...mine);
        continue;
      }
      // The queue's work: what it held when the turn began, and this turn's earlier orders there
      // (a founder).
      let from = queueEnd(w, c, q);
      for (const row of kit.rules.units) {
        if (row.queue !== q) continue;
        const earlier = p.queued(c, row.id) - queuedIn(c, row.id);
        if (earlier > 0) from += earlier * (unitTime(p, c, row.id) ?? 0);
      }
      const timed = mine.map((o): Timed => ({
        unit: o.unit,
        count: o.count,
        each: unitTime(p, c, o.unit) ?? 0,
      }));
      for (const o of alignQueue(timed, from, from <= w.t, beats(p), pace)) {
        kept.push({ unit: o.unit, count: o.count });
      }
    }
    if (kept.length > 0) p.recruit(c, kept);
  }
}

/**
 * Ships every other city's surplus to the city that trains the army: what it holds above
 * `SHIP_KEEP_PM` of its storage cap, within its shipment cap, when none of its shipments is on its
 * way and the cargo is worth `SHIP_MIN`. Each cargo fits what the receiver can still store when it
 * lands (its cap, less its stock after this turn's orders, its production on the way and the cargo
 * already heading there): above that, the cargo would be lost. A shipment wakes no one; a queue it
 * would feed instead wakes the seat when it empties. Call it after the receiver's orders.
 */
function shipSurplus(p: Planner, to: OwnCity): void {
  const { w } = p;
  const rule = w.kit.rules.movement.shipment;
  const away = new Set<string>();
  let room = subRes(res(to.cap, to.cap, to.cap), p.stockOf(to.id));
  for (const m of w.self?.private?.movements ?? []) {
    if (m.owner !== w.seat || m.cargo === undefined) continue;
    if (m.kind === "shipment" || m.kind === "return") away.add(m.home ?? m.from ?? "");
    const lands = m.kind === "shipment" ? m.to : m.kind === "return" ? (m.home ?? null) : null;
    if (lands === to.id) room = subRes(room, m.cargo);
  }
  for (const c of w.cities) {
    if (c.id === to.id || c.blocked || c.levels === null || away.has(c.id)) continue;
    const keep = Math.floor((c.cap * SHIP_KEEP_PM) / 1000);
    const stock = p.stockOf(c.id);
    const travel = w.travel(c.id, to.island, false) ?? 0;
    const fits = (r: ResourceId): number =>
      Math.max(0, room[r] - Math.floor((to.rate[r] * travel) / 3600));
    const surplus = res(
      Math.min(fits("wood"), Math.max(0, stock.wood - keep)),
      Math.min(fits("stone"), Math.max(0, stock.stone - keep)),
      Math.min(fits("gold"), Math.max(0, stock.gold - keep)),
    );
    const total = surplus.wood + surplus.stone + surplus.gold;
    if (total < SHIP_MIN) continue;
    const cap = rule === null ? total : rule.base + rule.perLevel * (c.levels[rule.building] ?? 0);
    const cargo =
      total <= cap
        ? surplus
        : res(
            Math.floor((surplus.wood * cap) / total),
            Math.floor((surplus.stone * cap) / total),
            Math.floor((surplus.gold * cap) / total),
          );
    if (cargo.wood + cargo.stone + cargo.gold < SHIP_MIN) continue;
    p.ship(c, to.id, cargo);
    room = subRes(room, cargo);
  }
}

/** Own wakes kept in hand beyond the one a time the seat must be awake at needs. */
const WAKE_SPARE = 1;

/**
 * True when the own wakes left today barely cover what will wake the seat before the next time it
 * asked to be awake at, today.
 */
function keepWakes(p: Planner): boolean {
  const { w } = p;
  const dayEnd = (w.day + 1) * DAY;
  const firm = p.wakes.filter((t) => t > w.t && t < dayEnd);
  if (firm.length === 0) return false;
  const at = Math.min(...firm);
  return ownWakesBefore(p, at) + 1 + WAKE_SPARE > w.briefing.budget.ownWakesLeft;
}

/** The cities with enough attackers at home to strike (their surroundings are read too). */
function strikers(w: World, minAttackers: number): OwnCity[] {
  const atk = w.kit.roles.attacker;
  return w.cities.filter((c) => !c.blocked && countOf(c.units, atk) >= minAttackers);
}

export const rusher3: StrategyDef = Object.freeze<StrategyDef>({
  name: "rusher",
  version: 3,
  brain(rng) {
    const prm = rusher3Params(rng);
    const knobs = {
      cadence: randInt(rng, 10800, 12600),
      settle: true,
      maxCities: prm.maxCities,
      producerBase: 3,
      producerPerDay: 2,
      wallBase: 0,
      wallPerDay: 1,
      spendPm: randInt(rng, 850, 950),
      mix: { defender: 1, attacker: randInt(rng, 3, 4), navy: 0 },
      carriers: true,
      supportOwn: false,
      escort: prm.escort,
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
        for (const c of strikers(w, prm.minAttackers)) {
          if (c.id === main?.id) continue;
          for (const o of strangers(w, c).slice(0, SCAN_OTHERS)) {
            out.push(call("view_city", { city: o.id }));
          }
        }
        return out;
      },
      plan(p) {
        const { w } = p;
        p.answer(() => false);
        tidy(p);
        noteLosses(w, p);
        noteEmpty(w, p);
        recallWeakened(p, prm);
        const main = mainCity(w);
        if (main === null) {
          p.economy();
          p.units();
          return;
        }
        if (w.t < rushAt(w) && p.flag("fs") === null) {
          // Protection may end before the wave is due: a weak target it already knows is struck.
          offense(p, prm, new Map(), false);
          if (p.flag("fs") === null) {
            opening(p, prm, main);
            return;
          }
        }
        const g = garrisons(p, prm);
        holdSieges(p, g);
        const hub = hubCity(w);
        const founding = foundingWanted(p, prm, hub);
        const pace = wakePacer(p);
        relieve(p, prm, g.keep);
        offense(p, prm, g.keep, !founding, pace);
        scout(p, prm, main, g.keep.get(main.id) ?? 0, !founding, pace);
        for (const r of returning(w)) {
          if (r.at > w.t) {
            if (pace(r.at)) p.wakeAt(r.at);
            break;
          }
        }
        const wishes: Wishes = new Map();
        if (founding && hub !== null) {
          settle(p, prm);
          recruitFounder(p, hub, wishes);
        } else if (colonyInReach(w, prm, main)) {
          conquestFounder(p, main, wishes);
        }
        economy(p, wishes, keepWakes(p), pace);
        const trainer = hub ?? main;
        recruitArmy(p, trainer, g, pace);
        shipSurplus(p, trainer);
      },
    };
  },
});
