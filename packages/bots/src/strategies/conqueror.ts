// `conqueror` (docs/architecture.md §11.2): plays for eliminations.
//
// - Victim: among the players it can reach and is not allied with, the one with the fewest cities,
//   then the nearest (a recent attacker of the seat weighs less, a pact partner more), with a
//   seeded tie-break. It is kept in the notes once a conquest wave has left for it, and changed
//   only when it is gone or clearly out of reach (far more cities than another candidate).
// - Economy: it founds its first cities like the expander (city cap 4) until the conquests begin,
//   and spends on defenders and attackers 1:2 with the carriers to ship them and their garrison.
// - Conquest: the victim's capital first once it can be taken (the config's capital immunity, read
//   through the hints), then its oldest cities, which recruit the founders of its new colonies. A
//   city the army could break but cannot strike yet holds the founders for itself. Each strike is
//   an assault landing in one second from the founders' island (clearing waves, the founders' wave,
//   then a garrison of the rest that joins the siege), or a train when that is not enough: helpers
//   from other islands leave first and the founders' island's waves are timed, from the travel
//   times, to land a minute after them (perfidia-1 §8.11, §15.2). Battles are estimated from spy
//   reports with the config's base defense, wall bonus and morale (hints), never from prose.
// - Founders are recruited just in time (with one spare once conquering) in the city best placed
//   to lead the strike, other cities shipping what its price lacks; a strike carries two, the one
//   left over staying with the garrison in the city taken, to lead the next conquest from there.
// - Sieges: defenders from the nearest city once per siege, more against each attack on it; a
//   garrison no help can reach, facing an attack its spy report shows twice as strong, is recalled.
// - Diplomacy: pacts (and one alliance) with anyone but its victim. Its own threatened cities get
//   support.
//
// Memory (notes, §11.1): flags `vp` the victim's seat number, `vc` 1 once a conquest wave left for
// it, `tc`/`ta` a planned train (target city number, landing time of its founders' island's
// waves), `sp<city>`/`sf<city>` the last spy on a city and the failures in a row, `ox<seat>` when a
// victim went out of reach, `ha<seat>` the last attack a player launched at the seat; handled ids
// `h<movement>` (an attack on a siege answered) and `g<city>` (a siege reinforced); memo lines for
// spectators (victim changes, trains, sieges given up).

import {
  compareIds,
  type CityId,
  type CityRow,
  type CityView,
  type IslandId,
  type Json,
  type PlayerId,
  type Res,
  type ToolCall,
} from "@perfidia/protocol";
import {
  call,
  configInt,
  configValue,
  countOf,
  covers,
  DAY,
  fmtTime,
  landPop,
  largest,
  meets,
  pmRes,
  power,
  res,
  storageLevelFor,
  subRes,
  timesAffordable,
  unitsInReport,
  type Kit,
} from "../kit.ts";
import {
  estimateDefense,
  intelAge,
  projectedLevels,
  unlockWishes,
  type Knobs,
  type Planner,
  type Wish,
} from "../plan.ts";
import { fnv1a32, randInt, type BotRng } from "../rng.ts";
import type { OwnCity, World } from "../world.ts";
import type { StrategyDef } from "./strategy.ts";

export interface ConquerorParams {
  /** A conquest's last wave needs its strength after morale ≥ the defense left × marginPm / 1000. */
  readonly marginPm: number;
  /** A wave meant to break a city carries attackers for sizePm / 1000 × its defense, no more. */
  readonly sizePm: number;
  /** Fewest attackers worth a wave. */
  readonly minAttackers: number;
  /** Spy gold = spyMinGold × spyMult + the land pop last seen, doubled per failure in a row. */
  readonly spyMult: number;
  /** Intel older than this is refreshed by a spy before a conquest. */
  readonly stale: number;
  /** Assumed growth of a city's defenders per hour of intel age, per mille. */
  readonly growthPm: number;
  /** Founders a conquest wave carries (a lone one dies unless the win is wide). */
  readonly founders: number;
  /** Victim cities read (and weighed) per turn. */
  readonly scan: number;
  /** Salt of the victim tie-break. */
  readonly salt: number;
}

export function conquerorParams(rng: BotRng): ConquerorParams {
  return {
    marginPm: randInt(rng, 1400, 1600),
    sizePm: randInt(rng, 2200, 2800),
    minAttackers: randInt(rng, 12, 18),
    spyMult: randInt(rng, 2, 4),
    stale: randInt(rng, 21600, 36000),
    growthPm: randInt(rng, 40, 60),
    founders: 2,
    scan: 8,
    salt: randInt(rng, 0, 1048575),
  };
}

/** A victim city weighs as much as this much travel when choosing a victim. */
const CITY_WEIGHT = 4 * 3600;
/** A committed victim with this many more cities than another candidate is out of reach. */
const OUT_CITIES = 3;
/** Extra weight of a pact partner, and of a player that went out of reach within a day. */
const PACT_WEIGHT = 2 * DAY;
const OUT_WEIGHT = DAY;
/** Morale assumed when the hints do not say how to compute it. */
const FALLBACK_MORALE_PM = 800;
/** A wave with a single founder needs this much over the defense (‰) for the founder to survive. */
const LONE_FOUNDER_PM = 2000;
/** Cities that ship to the city saving for a founder, per turn at most. */
const POOL_CITIES = 3;
/** Strikes waiting for a founder that get one recruited for them, per turn at most. */
const FOUNDER_ORDERS = 3;
/** Fewest attackers escorting the founders behind a clearing wave. */
const FOUNDERS_ESCORT = 5;
/** A founders' wave that meets the full defense needs this much over it (‰), with 2 or 1 founders. */
const ALONE_PM = 2000;
const ALONE_LONE_PM = 2500;
/** Helpers of a train land this long before its founders' wave at most. */
const TRAIN_WINDOW = 2 * 3600;
/** A planned train is dropped this long after its landing time. */
const TRAIN_EXPIRY = 6 * 3600;
/** Waves in a train at most (attack launches are capped per day). */
const TRAIN_MAX = 4;
/** Spy gold multiplier after 0, 1, 2 and 3+ failed missions on a city. */
const SPY_DOUBLING: readonly number[] = Object.freeze([1, 2, 4, 8]);

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** `p3` → 3 (the seat number of a player id), or null. */
function seatNumber(p: PlayerId): number | null {
  const m = /^p([1-9][0-9]*)$/.exec(p);
  return m?.[1] === undefined ? null : Number(m[1]);
}

/** `c12` → 12 (the number of a city id), or null. */
function cityNumber(id: string): number | null {
  const m = /^c([1-9][0-9]*)$/.exec(id);
  return m?.[1] === undefined ? null : Number(m[1]);
}

// The victim.

/** Other players' cities from the map, by owner. */
function citiesByOwner(w: World): Map<PlayerId, CityRow[]> {
  const out = new Map<PlayerId, CityRow[]>();
  for (const c of w.map?.cities ?? []) {
    if (c.owner === null || c.owner === w.seat) continue;
    out.set(c.owner, [...(out.get(c.owner) ?? []), c]);
  }
  return out;
}

/** The shortest known travel from an own city to one of `rows`, or null. */
function reachOf(w: World, rows: readonly CityRow[]): number | null {
  let best: number | null = null;
  for (const c of w.cities) {
    for (const r of rows) {
      const t = w.travel(c.id, r.island, false);
      if (t !== null && (best === null || t < best)) best = t;
    }
  }
  return best;
}

/** The current victim from memory, or null. */
function remembered(w: World): PlayerId | null {
  const n = w.memory.x["vp"] ?? 0;
  return n > 0 ? `p${n}` : null;
}

/**
 * The victim: the remembered one once a conquest wave left for it, while it still has a city the
 * seat can reach, is not an ally and is not clearly out of reach (`OUT_CITIES` more cities than
 * the best other candidate); otherwise the best candidate: fewest cities, then nearest (a player
 * that attacked the seat within a day weighs a city less; pact partners and players recently out
 * of reach weigh more), then a seeded tie-break.
 */
export function pickVictim(w: World, prm: ConquerorParams): PlayerId | null {
  const owners = citiesByOwner(w);
  const cur = remembered(w);
  let best: { q: PlayerId; score: number; tie: number } | null = null;
  let curOk = false;
  let fewest: number | null = null;
  for (const [q, rows] of owners) {
    if (w.relations.get(q) === "ally") continue;
    const reach = reachOf(w, rows);
    if (reach === null) continue;
    if (q === cur) curOk = true;
    else fewest = fewest === null ? rows.length : Math.min(fewest, rows.length);
    let score = rows.length * CITY_WEIGHT + reach;
    if (w.relations.get(q) === "pact") score += PACT_WEIGHT;
    const n = seatNumber(q);
    const out = n === null ? undefined : w.memory.x[`ox${n}`];
    if (out !== undefined && out > 0 && w.t - out < DAY) score += OUT_WEIGHT;
    const hit = n === null ? undefined : w.memory.x[`ha${n}`];
    if (hit !== undefined && hit > 0 && w.t - hit < DAY) score -= CITY_WEIGHT;
    const tie = fnv1a32(`${prm.salt}:${q}`);
    if (
      best === null ||
      score < best.score ||
      (score === best.score && (tie < best.tie || (tie === best.tie && compareIds(q, best.q) < 0)))
    ) {
      best = { q, score, tie };
    }
  }
  const committed = (w.memory.x["vc"] ?? 0) > 0;
  const curCities = cur === null ? 0 : (owners.get(cur)?.length ?? 0);
  if (cur !== null && committed && curOk && (fewest === null || curCities < fewest + OUT_CITIES)) {
    return cur;
  }
  return best?.q ?? null;
}

/** Remembers when each player last launched an attack against the seat (`ha<seat>`). */
function rememberAttackers(p: Planner): void {
  const { w } = p;
  for (const inc of w.briefing.incoming) {
    if (inc.kind !== "attack" || inc.homecoming === true) continue;
    if (inc.foe !== undefined && inc.foe !== null && inc.foe !== w.seat) continue;
    const n = seatNumber(inc.by);
    if (n === null || inc.by === w.seat) continue;
    if ((p.flag(`ha${n}`) ?? 0) < inc.depart[0]) p.setFlag(`ha${n}`, inc.depart[0]);
  }
}

/** Picks the victim and records a change in the notes. */
function settleVictim(p: Planner, prm: ConquerorParams): PlayerId | null {
  const { w } = p;
  const before = remembered(w);
  const v = pickVictim(w, prm);
  if (v === before) return v;
  if (before !== null && (w.memory.x["vc"] ?? 0) > 0) {
    const gone = !citiesByOwner(w).has(before);
    p.memo(`${before} ${gone ? "gone" : "out of reach"} ${fmtTime(w.t)}`);
    const n = seatNumber(before);
    if (!gone && n !== null) p.setFlag(`ox${n}`, w.t);
  }
  p.setFlag("vp", v === null ? 0 : (seatNumber(v) ?? 0));
  p.setFlag("vc", 0);
  if (v !== null) p.memo(`victim ${v} ${fmtTime(w.t)}`);
  return v;
}

// Targets.

interface Target {
  readonly row: CityRow;
  /** Besieged by anyone (the seat included): not a target for an attack. */
  readonly besieged: boolean;
  /** Shortest travel from an own city. */
  readonly travel: number;
}

function besiegedRow(w: World, row: CityRow): boolean {
  const ext = row.ext ?? {};
  return w.hints.blockedExt.some((key) => Object.hasOwn(ext, key));
}

/**
 * The victim's cities the seat can reach, in the order it goes for them: a capital that can be
 * taken first (a player is eliminated only once it falls), then the other cities oldest first (the
 * developed ones, which recruit the founders of new colonies), then a capital still immune. A city
 * too strong for now is passed over for the next one.
 */
function victimTargets(w: World, victim: PlayerId): Target[] {
  const out: Target[] = [];
  for (const row of w.map?.cities ?? []) {
    if (row.owner !== victim) continue;
    const travel = reachOf(w, [row]);
    if (travel === null) continue;
    out.push({ row, besieged: besiegedRow(w, row), travel });
  }
  const rank = (t: Target): number => {
    if (t.row.capitalOf === null) return 1;
    return w.t + t.travel >= opensAt(w, t.row) ? 0 : 2;
  };
  return out.toSorted((a, b) => rank(a) - rank(b) || compareIds(a.row.id, b.row.id));
}

/** The game time from which `row` can be taken: its capital immunity (hints), else 0. */
function opensAt(w: World, row: CityRow): number {
  if (row.capitalOf === null) return 0;
  return configInt(w.kit, w.hints.combat?.capitalImmunityEnd) ?? 0;
}

// Battle estimates. These model the land battle with what the hints say about the config: the
// defense of the units present plus a base defense, times a wall bonus; a lost wave kills the
// defenders' units in the square of the strength ratio, a won one leaves the base defense behind a
// wall one level lower. Without hints, the unit defense is padded and there is no base or wall.

/** What a city's land defense is made of. */
export interface Defense {
  /** Σ defense of the units present (grown with the intel's age). */
  readonly units: number;
  readonly base: number;
  readonly wall: number;
  /** Bonus per wall level, per mille. */
  readonly wallPm: number;
  /** Age of the intel, in seconds. */
  readonly age: number;
}

/**
 * Unit defense added to every estimate: units coming home or re-homed there since the intel (a
 * conquest re-homes the loser's army to its oldest city) weigh most against small cities.
 */
const DEFENSE_PAD = 200;

/** A city with no known defense. */
const NO_DEFENSE: Defense = Object.freeze({ units: 0, base: 0, wall: 0, wallPm: 0, age: 0 });

/** The land defense: `(units + base) × (1000 + wallPm × wall) / 1000`. */
export function defenseValue(d: Defense, units = d.units, wall = d.wall): number {
  return Math.floor(((units + d.base) * (1000 + d.wallPm * wall)) / 1000);
}

function levelIn(data: Json | null, building: string | null): number | null {
  if (building === null || data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const levels = data["buildings"];
  if (levels === null || levels === undefined || typeof levels !== "object") return null;
  if (Array.isArray(levels)) return null;
  const v = levels[building];
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
}

function quadAt(q: Json | null, x: number): number | null {
  if (q === null || typeof q !== "object" || Array.isArray(q)) return null;
  const { a, b, c } = q;
  if (typeof a !== "number" || typeof b !== "number" || typeof c !== "number") return null;
  const v = a * x * x + b * x + c;
  return Number.isSafeInteger(v) ? v : null;
}

/**
 * A city's estimated defense from the latest intel (an unknown building level counts as its
 * maximum), with the unit part grown by `growthPm` per hour of age; null when nothing usable is
 * known.
 */
export function defenseOf(w: World, view: CityView, growthPm: number): Defense | null {
  const est = estimateDefense(w, view);
  const age = intelAge(w, view);
  if (est === null || age === null) return null;
  const kit = w.kit;
  const grown = est + DEFENSE_PAD + Math.floor((est * growthPm * Math.floor(age / 3600)) / 1000);
  const data = view.access === "public" && view.intel !== null ? view.intel.data : null;
  const combat = w.hints.combat;
  const maxLevel = (b: string | null): number =>
    b === null ? 0 : (kit.buildings.get(b)?.maxLevel ?? 0);
  const baseHint = combat?.baseDefense;
  const wallPm = configInt(kit, combat?.wallPmPerLevel);
  const base =
    baseHint === undefined
      ? null
      : quadAt(
          configValue(kit, baseHint.quad),
          levelIn(data, baseHint.building) ?? maxLevel(baseHint.building),
        );
  if (base === null || wallPm === null) {
    return { units: grown + Math.floor((grown * 3) / 10) + 100, base: 0, wall: 0, wallPm: 0, age };
  }
  const wall = kit.wall === null ? 0 : (levelIn(data, kit.wall) ?? maxLevel(kit.wall));
  return { units: grown, base, wall, wallPm, age };
}

/** The seat's morale (‰) against a foe with `foeCities`, counting the sieges it holds as its cities. */
function moraleAgainst(w: World, foeCities: number): number {
  const m = w.hints.combat?.morale;
  const perCity = configInt(w.kit, m?.perCity);
  const floor = configInt(w.kit, m?.floor);
  if (perCity === null || floor === null) return FALLBACK_MORALE_PM;
  const mine = w.cities.length + holdCities(w).size;
  return clamp(1000 - perCity * (mine - foeCities), floor, 1000);
}

/** `(loser / winner)²` in per mille, as a loss rate. */
function lossRate(loser: number, winner: number): number {
  if (winner <= 0) return 1000;
  const r = Math.min(1000, Math.floor((1000 * loser) / winner));
  return Math.floor((r * r) / 1000);
}

/**
 * The defense the last of `waves` (attack after morale, in landing order) meets, after the earlier
 * ones: a lost wave kills `(A/D)²` of the defenders' units, a won one kills them all and breaches
 * the wall by a level.
 */
export function defenseLeft(d: Defense, waves: readonly number[]): number {
  let units = d.units;
  let wall = d.wall;
  for (const a of waves.slice(0, -1)) {
    const now = defenseValue(d, units, wall);
    if (a > now) {
      units = 0;
      wall = Math.max(0, wall - 1);
    } else {
      units -= Math.floor((units * lossRate(a, now)) / 1000);
    }
  }
  return defenseValue(d, units, wall);
}

// Waves.

/** One movement of a conquest, in launch order. */
interface Wave {
  readonly from: OwnCity;
  readonly units: Record<string, number>;
  /** Land attack before morale. */
  readonly strength: number;
  readonly travel: number;
}

/** What one wave asks of a city: attackers, founders and defenders (each capped by what is home). */
interface Part {
  readonly attackers: number;
  readonly founders: number;
  readonly defenders: number;
}

const ALL = 1_000_000;

/**
 * Splits what `c` has at home into waves to `island`, one per part in order: each takes what is
 * still home, cut to the carriers left when crossing water (founders first, then attackers, then
 * defenders). A part that ends up with no land unit that fights gives null.
 */
function allocate(
  p: Planner,
  c: OwnCity,
  island: IslandId,
  parts: readonly Part[],
): (Wave | null)[] {
  const kit = p.w.kit;
  const travel = p.w.travel(c.id, island, false);
  const { attacker, defender, founder, carrier } = kit.roles;
  if (travel === null || c.blocked || attacker === null) return parts.map(() => null);
  const home: Record<string, number> = { ...p.homeOf(c.id) };
  const water = c.island !== island && kit.rules.movement.transportRule;
  const popOf = (u: string | null): number =>
    u === null ? 0 : Math.max(1, kit.units.get(u)?.pop ?? 1);
  const cap = carrier === null ? 0 : (kit.units.get(carrier)?.capacity ?? 0);
  const attack = kit.units.get(attacker)?.attack ?? 0;
  return parts.map((part) => {
    let lift = water ? countOf(home, carrier) * cap : ALL;
    const take = (u: string | null, want: number): number => {
      if (u === null) return 0;
      const n = Math.max(0, Math.min(want, countOf(home, u), Math.floor(lift / popOf(u))));
      lift -= n * popOf(u);
      return n;
    };
    const f = take(founder, part.founders);
    const a = take(attacker, part.attackers);
    const g = take(defender, part.defenders);
    if (a + g === 0) return null;
    const units: Record<string, number> = {};
    if (a > 0) units[attacker] = a;
    if (f > 0) units[founder] = f;
    if (g > 0 && defender !== null) units[defender] = (units[defender] ?? 0) + g;
    if (water && carrier !== null && cap > 0) {
      units[carrier] = Math.ceil(landPop(kit, units) / cap);
    }
    for (const [u, n] of Object.entries(units)) home[u] = (home[u] ?? 0) - n;
    return { from: c, units, strength: a * attack, travel };
  });
}

function foundersIn(kit: Kit, units: Readonly<Record<string, number>>): number {
  return countOf(units, kit.roles.founder);
}

/** Founders per wave to try with `n` at home: two first (see `assault`), else one. */
function foundersTried(n: number): number[] {
  return n >= 2 ? [2, 1] : n >= 1 ? [1] : [];
}

/** Attackers that give `attack` after morale `m`, rounded up. */
function attackersFor(kit: Kit, attack: number, m: number): number {
  const per = kit.roles.attacker === null ? 0 : (kit.units.get(kit.roles.attacker)?.attack ?? 0);
  if (per <= 0 || m <= 0) return 0;
  return Math.ceil((attack * 1000) / (per * m));
}

/** The wave of every attacker `c` has at home (lift-limited), or null. */
function allAttackers(p: Planner, c: OwnCity, island: IslandId): Wave | null {
  return allocate(p, c, island, [{ attackers: ALL, founders: 0, defenders: 0 }])[0] ?? null;
}

/**
 * The cities whose waves land in the same second as `f`'s (the same travel time to `island`, in
 * practice its own island), `f` excluded, strongest first.
 */
function sameSecond(p: Planner, f: OwnCity, island: IslandId): OwnCity[] {
  const { w } = p;
  const travel = w.travel(f.id, island, false);
  return w.cities
    .filter((c) => c.id !== f.id && !c.blocked && w.travel(c.id, island, false) === travel)
    .map((c) => ({ c, s: allAttackers(p, c, island)?.strength ?? 0 }))
    .toSorted((a, b) => b.s - a.s || compareIds(a.c.id, b.c.id))
    .map((x) => x.c);
}

/** The city that sends the founders: one with a founder at home whose island group hits hardest. */
function founderCity(p: Planner, island: IslandId): OwnCity | null {
  const { w } = p;
  const kit = w.kit;
  let best: { c: OwnCity; s: number } | null = null;
  for (const c of w.cities) {
    if (c.blocked || countOf(p.homeOf(c.id), kit.roles.founder) === 0) continue;
    if (w.travel(c.id, island, false) === null) continue;
    let s = allAttackers(p, c, island)?.strength ?? 0;
    for (const o of sameSecond(p, c, island)) s += allAttackers(p, o, island)?.strength ?? 0;
    if (best === null || s > best.s) best = { c, s };
  }
  return best?.c ?? null;
}

/**
 * The waves that land in one second on `tg`, in launch order, the founders' wave last (the
 * garrison follows it, see `launch`). Tried in order:
 *
 * - the founders' wave alone, from the founders' city, sized to `sizePm` × the defense, when it
 *   holds the wide margin of a wave that meets the full defense (`ALONE_PM`, or `ALONE_LONE_PM`
 *   with one founder): the rest of the army then joins the siege it starts;
 * - clearing waves first (the other cities of the founders' island, strongest first, then the
 *   founders' city's spare attackers), sized to `sizePm` × the defense and else whole, then a
 *   founders' wave that beats what they leave by `marginPm` (`LONE_FOUNDER_PM` with one founder).
 *
 * Two founders when it has them (the one left over is re-homed with the garrison in the city
 * taken: the next conquest's founder, from there), else one. `before`: the strength after morale
 * of waves that land earlier (a train's helpers). Null when nothing wins; with `force`, the last
 * plan tried.
 */
function assault(
  p: Planner,
  prm: ConquerorParams,
  tg: Target,
  d: Defense,
  m: number,
  before: readonly number[],
  force: boolean,
): Wave[] | null {
  const kit = p.w.kit;
  const island = tg.row.island;
  const f = founderCity(p, island);
  if (f === null) return null;
  const eff = (strength: number): number => Math.floor((strength * m) / 1000);
  const full = defenseLeft(d, [...before, 0]);
  const sized = attackersFor(kit, Math.ceil((full * prm.sizePm) / 1000), m);
  const have = countOf(p.homeOf(f.id), kit.roles.attacker);
  const founders = Math.min(prm.founders, countOf(p.homeOf(f.id), kit.roles.founder));

  for (const n of foundersTried(founders)) {
    const alone = n >= 2 ? ALONE_PM : ALONE_LONE_PM;
    const want = Math.max(
      2 * prm.minAttackers,
      sized,
      attackersFor(kit, Math.ceil((full * alone) / 1000), m),
    );
    const wave = allocate(p, f, island, [{ attackers: want, founders: n, defenders: 0 }])[0];
    if (wave === undefined || wave === null || foundersIn(kit, wave.units) < n) continue;
    if (eff(wave.strength) * 1000 >= full * alone) return [wave];
  }

  const others = sameSecond(p, f, island);
  const breached = defenseValue(d, 0, Math.max(0, d.wall - 1));
  let last: Wave[] | null = null;
  for (const n of foundersTried(founders)) {
    const margin = n >= 2 ? prm.marginPm : LONE_FOUNDER_PM;
    const least = Math.max(
      FOUNDERS_ESCORT,
      attackersFor(kit, Math.ceil((breached * margin * 3) / 2000), m),
    );
    for (const cap of [sized, ALL]) {
      let left = cap;
      const clear: Wave[] = [];
      for (const c of others) {
        if (left <= 0) break;
        const x = allocate(p, c, island, [{ attackers: left, founders: 0, defenders: 0 }])[0];
        if (x === undefined || x === null) continue;
        if (countOf(x.units, kit.roles.attacker) < prm.minAttackers && left >= prm.minAttackers) {
          continue;
        }
        clear.push(x);
        left -= countOf(x.units, kit.roles.attacker);
      }
      const extra = Math.max(0, Math.min(left, have - least));
      const own = allocate(p, f, island, [
        { attackers: extra, founders: 0, defenders: 0 },
        { attackers: least, founders: n, defenders: 0 },
      ]).filter((x): x is Wave => x !== null);
      const lead = own.at(-1);
      if (lead === undefined || foundersIn(kit, lead.units) < n) continue;
      const waves = [...clear, ...own];
      last = waves;
      const order = [...before, ...waves.map((x) => eff(x.strength))];
      if (eff(lead.strength) * 1000 >= defenseLeft(d, order) * margin) return waves;
    }
  }
  return force ? last : null;
}

/**
 * The garrison that follows a founders' wave from `from` and the other cities of its island, in
 * the same second: their attackers left and their defenders (the forge city keeps half of its).
 * Landing after the founders' wave, they join the siege it starts (or fight on if it lost), so
 * that the owner's army coming home meets more than the founders' escort.
 */
function garrison(p: Planner, from: OwnCity, to: CityId, island: IslandId): void {
  const { w } = p;
  const forge = forgeCity(w)?.id;
  for (const c of w.cities) {
    if (c.blocked || c.island !== from.island || p.attacksLeft <= 0) continue;
    const have = countOf(p.homeOf(c.id), w.kit.roles.defender);
    const part: Part = {
      attackers: ALL,
      founders: 0,
      defenders: c.id === forge ? Math.floor(have / 2) : have,
    };
    const wave = allocate(p, c, island, [part])[0];
    if (wave !== undefined && wave !== null) p.attack(c, to, wave.units);
  }
}

/** Launches `waves` in order, then the garrison; true when the founders' wave left. */
function launch(p: Planner, tg: CityId, island: IslandId, waves: readonly Wave[]): boolean {
  const kit = p.w.kit;
  if (p.attacksLeft < waves.length) return false;
  let sent = false;
  for (const x of waves) {
    if (p.attack(x.from, tg, x.units) && foundersIn(kit, x.units) > 0) sent = true;
  }
  const lead = waves.at(-1);
  if (sent && lead !== undefined) garrison(p, lead.from, tg, island);
  return sent;
}

/**
 * A conquest of `tg`: the waves of the founders' island in one second when they suffice;
 * otherwise a train, with waves from other islands (landing up to `TRAIN_WINDOW` earlier) leaving
 * now and the founders' island's waves timed to land just after them. Returns true when the
 * founders' wave left or a train was planned.
 */
function strike(p: Planner, prm: ConquerorParams, tg: Target, d: Defense, foes: number): boolean {
  const { w } = p;
  const kit = w.kit;
  const m = moraleAgainst(w, foes);
  const eff = (strength: number): number => Math.floor((strength * m) / 1000);
  const open = opensAt(w, tg.row);
  const island = tg.row.island;
  const f = founderCity(p, island);
  const travel = f === null ? null : w.travel(f.id, island, false);
  if (f === null || travel === null) return false;
  if (w.t + travel < open) {
    p.wakes.push(open - travel);
    return false;
  }
  const now = assault(p, prm, tg, d, m, [], false);
  if (now !== null) return launch(p, tg.row.id, island, now);

  // A train: helpers from other islands, slower than the founders' island by 10 min to 2 h.
  const helpers = w.cities
    .map((c) => allAttackers(p, c, island))
    .filter(
      (x): x is Wave =>
        x !== null &&
        countOf(x.units, kit.roles.attacker) >= prm.minAttackers &&
        x.travel >= travel + 600 &&
        x.travel <= travel + TRAIN_WINDOW,
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
    if (assault(p, prm, tg, d, m, earlier, false) === null) continue;
    const landing = Math.max(...chosen.map((x) => w.t + x.travel));
    if (landing < open || p.attacksLeft < chosen.length + 2) return false;
    for (const x of sorted) p.attack(x.from, tg.row.id, x.units);
    const n = cityNumber(tg.row.id);
    if (n === null) return true;
    p.setFlag("tc", n);
    p.setFlag("ta", landing + 60);
    p.wakes.push(landing + 60 - travel);
    p.memo(`train ${tg.row.id} ${fmtTime(landing + 60)}`);
    return true;
  }
  return false;
}

/** Launches the founders' island's waves of a planned train once their time has come. */
function trainStep(p: Planner, prm: ConquerorParams, victim: PlayerId | null): void {
  const { w } = p;
  const tc = p.flag("tc") ?? 0;
  const ta = p.flag("ta") ?? 0;
  if (tc <= 0) return;
  const id: CityId = `c${tc}`;
  const row = w.map?.cities.find((c) => c.id === id);
  const drop = (): void => {
    p.setFlag("tc", 0);
    p.setFlag("ta", 0);
  };
  if (row === undefined || row.owner !== victim || besiegedRow(w, row) || w.t > ta + TRAIN_EXPIRY) {
    drop();
    return;
  }
  const f = founderCity(p, row.island);
  const travel = f === null ? null : w.travel(f.id, row.island, false);
  if (f === null || travel === null) {
    drop();
    return;
  }
  if (w.t + travel < ta) {
    p.wakes.push(ta - travel);
    return;
  }
  // The helpers have landed (or are about to): the founders' island sends everything it has.
  const view = w.views.get(id);
  const d = (view === undefined ? null : defenseOf(w, view, prm.growthPm)) ?? NO_DEFENSE;
  const foes = w.map?.cities.filter((c) => c.owner === victim).length ?? 1;
  const tg: Target = { row, besieged: false, travel };
  const waves = assault(p, prm, tg, d, moraleAgainst(w, foes), [], true);
  if (waves !== null && launch(p, id, row.island, waves)) p.setFlag("vc", 1);
  drop();
}

// Intel.

/** Spies `tg` from the own city whose spy lands first, doubling the gold after each failure. */
function spyOn(p: Planner, prm: ConquerorParams, tg: Target, view: CityView): boolean {
  const { w } = p;
  const kit = w.kit;
  if (p.inFlight("spy", tg.row.id)) return false;
  const key = tg.row.id;
  const last = p.flag(`sp${key}`);
  const intelAt = view.access === "public" && view.intel !== null ? view.intel.at[0] : null;
  let fails = p.flag(`sf${key}`) ?? 0;
  if (last !== null && last > 0) fails = intelAt === null || intelAt < last ? fails + 1 : 0;
  const from = w.cities
    .filter((c) => !c.blocked)
    .map((c) => ({ c, travel: w.travel(c.id, tg.row.island, true) }))
    .filter((x): x is { c: OwnCity; travel: number } => x.travel !== null)
    .toSorted((a, b) => a.travel - b.travel || compareIds(a.c.id, b.c.id))
    .find((x) => p.stockOf(x.c.id).gold >= kit.rules.movement.spyMinGold)?.c;
  if (from === undefined) return false;
  const seen =
    view.access === "public" && view.intel !== null
      ? landPop(kit, unitsInReport(kit, view.intel.data))
      : null;
  const base = p.spyGold(from, prm.spyMult, seen);
  if (base === null) return false;
  const gold = Math.min(p.stockOf(from.id).gold, base * (SPY_DOUBLING[Math.min(fails, 3)] ?? 8));
  p.spy(from, tg.row.id, gold);
  p.setFlag(`sp${key}`, w.t);
  p.setFlag(`sf${key}`, fails);
  return true;
}

// Sieges.

/** Cities where the seat holds a siege garrison, with the garrison's units. */
function holdCities(w: World): Map<CityId, Record<string, number>> {
  const out = new Map<CityId, Record<string, number>>();
  for (const s of w.self?.private?.stationed ?? []) {
    if (s.role !== "hold") continue;
    const sum = { ...out.get(s.city) };
    for (const [u, n] of Object.entries(s.units)) sum[u] = (sum[u] ?? 0) + n;
    out.set(s.city, sum);
  }
  return out;
}

/**
 * The attack an incoming movement may bring, from the latest spy report on the city it left (the
 * units at home there then), or null when unknown (no report, a battle report, a hidden origin).
 */
function attackFrom(w: World, from: CityId | null): number | null {
  if (from === null) return null;
  const view = w.views.get(from);
  if (view === undefined || view.access !== "public" || view.intel === null) return null;
  if (view.intel.type !== "spy_report") return null;
  return power(w.kit, unitsInReport(w.kit, view.intel.data), "attack", true);
}

/**
 * Holds the seat's sieges: defenders from the nearest city once per siege (the owner's army may
 * come home, perfidia-1 §9.3), and from the two nearest cities that land before each attack on a
 * besieged city. A garrison no help can reach in time, facing an attack from a city whose last
 * spy report shows twice its defense, is hopeless: it is recalled, saving its units.
 */
function holdSieges(p: Planner): void {
  const { w } = p;
  const kit = w.kit;
  const defender = kit.roles.defender;
  if (defender === null) return;
  const recall = kit.rules.movement.recall.stationed !== "none";
  for (const [city, garrisonUnits] of holdCities(w)) {
    const row = w.map?.cities.find((c) => c.id === city);
    if (row === undefined) continue;
    const threats = w.briefing.incoming.filter(
      (i) => i.to === city && i.kind === "attack" && i.arrive[0] > w.t && !p.handled(`h${i.id}`),
    );
    const fresh = !p.handled(`g${city}`);
    if (threats.length === 0 && !fresh) continue;
    const first = Math.min(...threats.map((i) => i.arrive[0]));
    const helpers = w.cities
      .filter((c) => !c.blocked)
      .map((c) => ({ c, travel: w.travel(c.id, row.island, false) }))
      .filter((x): x is { c: OwnCity; travel: number } => x.travel !== null)
      .filter((x) => threats.length === 0 || w.t + x.travel < first)
      .toSorted((a, b) => a.travel - b.travel || compareIds(a.c.id, b.c.id));
    const cities = threats.length > 0 ? 2 : 1;
    const share = threats.length > 0 ? 3 : 2;
    let sent = 0;
    for (const { c } of helpers) {
      if (sent >= cities) break;
      const have = countOf(p.homeOf(c.id), defender);
      const pop = Math.max(1, kit.units.get(defender)?.pop ?? 1);
      const lift = Math.floor(p.liftCapacity(c, row.island) / pop);
      const n = Math.min(Math.floor((have * share) / 4), lift);
      if (n <= 0) continue;
      const group = p.withCarriers(c, row.island, { [defender]: n });
      if (group === null) continue;
      p.support(c, city, group);
      sent += 1;
    }
    for (const i of threats) p.markHandled(`h${i.id}`);
    if (fresh) p.markHandled(`g${city}`);
    if (sent > 0 || !recall || threats.length === 0) continue;
    const held = power(kit, garrisonUnits, "defense", true);
    const worst = Math.max(...threats.map((i) => attackFrom(w, i.from) ?? 0));
    if (worst > 2 * held) {
      p.recallStationed(city);
      p.memo(`gave up ${city} ${fmtTime(w.t)}`);
    }
  }
}

// Offense.

/**
 * Ships what `to` lacks of `cost` from the other cities, nearest first (at most `POOL_CITIES`,
 * each within its shipment cap and keeping a third of its stock), unless a shipment to `to` is
 * already on its way: a founder's price outgrows any one city's income as the seat grows.
 */
function pool(p: Planner, to: OwnCity, cost: Res): void {
  const { w } = p;
  const ship = w.kit.rules.movement.shipment;
  if (ship === null || p.inFlight("shipment", to.id)) return;
  let need = subRes(cost, p.stockOf(to.id));
  const from = w.cities
    .filter((c) => c.id !== to.id && !c.blocked)
    .map((c) => ({ c, travel: w.travel(c.id, to.island, false) }))
    .filter((x): x is { c: OwnCity; travel: number } => x.travel !== null)
    .toSorted((a, b) => a.travel - b.travel || compareIds(a.c.id, b.c.id))
    .slice(0, POOL_CITIES);
  for (const { c } of from) {
    if (largest(need) <= 0) return;
    let room = ship.base + ship.perLevel * (c.levels?.[ship.building] ?? 0);
    const surplus = pmRes(p.budgetOf(c.id), 667);
    const take = (have: number, want: number): number => {
      const n = Math.max(0, Math.min(have, want, room));
      room -= n;
      return n;
    };
    const cargo = res(
      take(surplus.wood, need.wood),
      take(surplus.stone, need.stone),
      take(surplus.gold, need.gold),
    );
    if (cargo.wood + cargo.stone + cargo.gold <= 0) continue;
    p.ship(c, to.id, cargo);
    need = subRes(need, cargo);
  }
}

/**
 * Once conquering, the forge city's storage grows ahead of the founders' price: the price of the
 * founder after next must fit (it grows with every city and founder owned, perfidia-1 §6.2).
 */
function storeAhead(p: Planner, c: OwnCity): Wish[] {
  const { w } = p;
  const kit = w.kit;
  const settler = w.self?.private?.settler;
  if (settler === undefined || !conquering(p) || forgeCity(w)?.id !== c.id) return [];
  const table = kit.rules.settlerCost;
  const ahead = table[Math.min(settler.k + 1, table.length - 1)] ?? settler.cost;
  const lvl = storageLevelFor(kit, largest(ahead));
  return lvl === null ? [] : [{ building: kit.storage, level: lvl }];
}

/**
 * Once conquering, one founder is kept in hand even before a strike asks for it: the island of the
 * victim's first city, when no founder is at home or queued anywhere.
 */
function spareFounder(p: Planner, victim: PlayerId | null): IslandId[] {
  const { w } = p;
  const founder = w.kit.roles.founder;
  if (victim === null || !conquering(p)) return [];
  if (w.cities.some((c) => countOf(p.homeOf(c.id), founder) + p.queued(c, founder) > 0)) return [];
  const first = victimTargets(w, victim)[0];
  return first === undefined ? [] : [first.row.island];
}

/** True once a conquest wave has left, or from the day after attacks open. */
function conquering(p: Planner): boolean {
  return (p.flag("vc") ?? 0) > 0 || p.w.t >= p.w.kit.rules.time.attackFrom + DAY;
}

/** A victim city as `offense` sees it this turn. */
interface Sighting {
  readonly tg: Target;
  readonly label: string;
  /** Mine already: besieged by the seat, or a wave of the seat on its way. */
  readonly taken: boolean;
  /** Its estimated defense, or null when nothing is known. */
  readonly d: Defense | null;
  /** The army could break it (on the latest intel), and it can be taken by the time a wave lands. */
  readonly breaks: boolean;
  /** `breaks`, with fresh intel and attacks open: a strike may leave now. */
  readonly ready: boolean;
}

/**
 * Goes for the victim's cities in order (`victimTargets`): spies those whose intel is missing or
 * stale, and strikes. A city the army could break but cannot strike yet (no founder there, the
 * waves still short, intel on its way) holds the founders for itself, the cities after it only
 * scouted, so that the victim's base falls before its new colonies (the base recruits the founders
 * that refound them). A city too strong for the whole army is passed over.
 *
 * Returns the islands of the strikes that wait for a founder, in order (founders are recruited
 * just in time: dear, and every one owned raises the next's price).
 */
function offense(p: Planner, prm: ConquerorParams, victim: PlayerId | null): IslandId[] {
  const { w } = p;
  const kit = w.kit;
  if (victim === null || kit.roles.attacker === null) return [];
  const targets = victimTargets(w, victim);
  const foes = targets.length;
  const holds = holdCities(w);
  const attackOpen = w.t >= kit.rules.time.attackFrom && p.attacksLeft > 0;
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
    // A capital still immune is scouted shortly before it opens, not earlier.
    if (w.t + tg.travel + 4 * 3600 < open) {
      p.wakes.push(open - tg.travel - 4 * 3600);
      seen.push({ tg, label, taken, d: null, breaks: false, ready: false });
      continue;
    }
    const d = defenseOf(w, view, prm.growthPm);
    const fresh = d !== null && d.age <= prm.stale;
    if (!fresh && spies < 2 && w.t + 2 * 3600 >= kit.rules.time.attackFrom) {
      if (spyOn(p, prm, tg, view)) spies += 1;
    }
    const breaks = d !== null && armyBreaks(p, prm, tg, d, foes);
    const ready = breaks && fresh && attackOpen && w.t + tg.travel >= open;
    const text = d === null ? label : `${label} D${defenseValue(d)}`;
    seen.push({ tg, label: text, taken, d, breaks, ready });
  }

  const wanted: IslandId[] = [];
  const train = (p.flag("tc") ?? 0) > 0;
  // A planned train keeps the founders for its last wave.
  let hold = train;
  for (const x of seen) {
    if (x.d === null || x.taken) continue;
    if (!x.breaks) {
      p.summary.push(`${x.label}: too strong`);
      continue;
    }
    const free = founderCity(p, x.tg.row.island) !== null;
    if (!free && !wanted.includes(x.tg.row.island)) {
      wanted.push(x.tg.row.island);
      p.summary.push(`${x.label}: founder wanted (k${w.self?.private?.settler.k ?? 0})`);
    }
    const now = !hold && x.ready && free;
    hold = true;
    if (!now) continue;
    if (strike(p, prm, x.tg, x.d, foes)) {
      p.setFlag("vc", 1);
      hold = (p.flag("tc") ?? 0) > 0;
    } else {
      p.summary.push(`${x.label}: waiting`);
    }
  }
  return wanted;
}

/** True when every attacker the seat has at home could break `tg` by the conquest margin. */
function armyBreaks(
  p: Planner,
  prm: ConquerorParams,
  tg: Target,
  d: Defense,
  foes: number,
): boolean {
  const m = moraleAgainst(p.w, foes);
  let total = 0;
  for (const c of p.w.cities) total += allAttackers(p, c, tg.row.island)?.strength ?? 0;
  return Math.floor((total * m) / 1000) * 1000 >= defenseValue(d) * prm.marginPm;
}

// Founders.

/** The city that recruits the conquest founders: the capital, else the most developed. */
function forgeCity(w: World): OwnCity | null {
  const capital = w.cities.find((c) => c.capital && !c.blocked);
  if (capital !== undefined) return capital;
  let best: OwnCity | null = null;
  for (const c of w.cities) {
    if (c.blocked || c.levels === null) continue;
    if (best === null || c.popCap > best.popCap) best = c;
  }
  return best;
}

/**
 * Recruits founders for the strikes that wait for one (`islands`, from `offense`, first first), each
 * in the city best placed to lead it: among those that can recruit one now (requirements, a
 * warehouse that holds its price, no founder already queued), the one whose island group hits that
 * island hardest; else the capital, which then asks for what it lacks. The price of a founder that
 * cannot be paid yet is saved for whatever the wait.
 */
function conquestFounders(p: Planner, prm: ConquerorParams, islands: readonly IslandId[]): void {
  const { w } = p;
  const kit = w.kit;
  const founder = kit.roles.founder;
  const row = kit.units.get(founder);
  const settler = w.self?.private?.settler;
  if (row === undefined || settler === undefined) return;
  // Each founder ordered raises k, and so the price of the next (the rules' table by k).
  let k = settler.k;
  let cost = settler.cost;
  const used = new Set<CityId>();
  for (const island of islands.slice(0, FOUNDER_ORDERS)) {
    const able = (c: OwnCity): boolean =>
      !c.blocked &&
      !used.has(c.id) &&
      c.levels !== null &&
      meets(row.requires, c.levels) &&
      largest(cost) <= c.cap &&
      c.popCap - c.popUsed >= row.pop &&
      p.queued(c, founder) === 0;
    let best: { c: OwnCity; s: number } | null = null;
    for (const c of w.cities) {
      if (!able(c)) continue;
      let s = allAttackers(p, c, island)?.strength ?? 0;
      for (const o of sameSecond(p, c, island)) s += allAttackers(p, o, island)?.strength ?? 0;
      if (best === null || s > best.s) best = { c, s };
    }
    const forge = best?.c ?? forgeCity(w);
    if (forge === null || forge.levels === null || used.has(forge.id)) return;
    used.add(forge.id);
    if (p.queued(forge, founder) > 0 || countOf(p.homeOf(forge.id), founder) >= prm.founders) {
      continue;
    }
    if (largest(cost) > forge.cap) {
      const lvl = storageLevelFor(kit, largest(cost));
      if (lvl !== null) p.wish(forge.id, { building: kit.storage, level: lvl });
      return;
    }
    if (!meets(row.requires, forge.levels)) {
      p.wish(forge.id, ...unlockWishes(kit, founder));
      return;
    }
    if (forge.popCap - forge.popUsed < row.pop) {
      const lv = projectedLevels(forge)[kit.population] ?? 0;
      p.wish(forge.id, { building: kit.population, level: lv + 1 });
      return;
    }
    if (!p.canRecruit(forge, founder)) continue;
    if (!covers(p.stockOf(forge.id), cost)) {
      p.reserve(forge.id, cost);
      pool(p, forge, cost);
      return;
    }
    p.recruit(forge, [{ unit: founder, count: 1 }], cost);
    k += 1;
    const table = kit.rules.settlerCost;
    cost = table[Math.min(k, table.length - 1)] ?? cost;
  }
}

/** Carriers are recruited once this many are missing, and this many more (fewer queue wakes). */
const CARRIER_BATCH = 6;

/**
 * Carriers for the garrison too: enough to lift every attacker, half the defenders and the
 * founders at home or queued, recruited where the carriers' queue is free (the generic unit plan
 * only counts attackers).
 */
function transports(p: Planner): void {
  const { w } = p;
  const kit = w.kit;
  const carrier = kit.roles.carrier;
  const row = carrier === null ? undefined : kit.units.get(carrier);
  if (carrier === null || row === undefined || row.capacity <= 0) return;
  if (!kit.rules.movement.transportRule) return;
  for (const c of w.cities) {
    if (!p.canRecruit(c, carrier)) continue;
    const count = (u: string | null): number =>
      u === null ? 0 : countOf(c.units, u) + p.queued(c, u);
    const land: Record<string, number> = {};
    if (kit.roles.attacker !== null) land[kit.roles.attacker] = count(kit.roles.attacker);
    if (kit.roles.defender !== null)
      land[kit.roles.defender] = Math.floor(count(kit.roles.defender) / 2);
    land[kit.roles.founder] = count(kit.roles.founder);
    const want = Math.ceil(landPop(kit, land) / row.capacity) + 1 - count(carrier);
    if (want < CARRIER_BATCH) continue;
    const n = Math.min(
      want + CARRIER_BATCH,
      timesAffordable(p.budgetOf(c.id), row.cost),
      row.maxPerOrder,
    );
    if (n > 0 && c.popCap - c.popUsed >= row.pop * n) p.recruit(c, [{ unit: carrier, count: n }]);
  }
}

export const conqueror: StrategyDef = Object.freeze<StrategyDef>({
  name: "conqueror",
  version: 1,
  brain(rng) {
    const prm = conquerorParams(rng);
    const knobs: Knobs = {
      cadence: randInt(rng, 5400, 7200),
      settle: true,
      maxCities: 4,
      producerBase: randInt(rng, 3, 4),
      producerPerDay: 2,
      wallBase: 0,
      wallPerDay: 0,
      spendPm: randInt(rng, 700, 800),
      mix: { defender: 1, attacker: 2, navy: 0 },
      carriers: true,
      supportOwn: true,
      escort: randInt(rng, 2, 3),
      militaryFirst: false,
      minPacks: 8,
    };
    return {
      knobs,
      reads(w: World): ToolCall[] {
        const victim = pickVictim(w, prm);
        if (victim === null) return [];
        return victimTargets(w, victim)
          .slice(0, prm.scan)
          .map((t) => call("view_city", { city: t.row.id }));
      },
      plan(p) {
        rememberAttackers(p);
        const victim = settleVictim(p, prm);
        let allied = p.w.self?.alliance !== null && p.w.self?.alliance !== undefined;
        p.answer((pr) => {
          if (pr.from === victim) return false;
          if (pr.kind === "pact") return true;
          if (allied) return false;
          allied = true;
          return true;
        });
        holdSieges(p);
        p.supportThreatened();
        trainStep(p, prm, victim);
        const wanted = offense(p, prm, victim);
        // Founders found cities until the conquests begin; then every one leads a conquest.
        if (wanted.length === 0 && !conquering(p)) {
          p.settle();
          p.founder();
        }
        conquestFounders(p, prm, wanted.length > 0 ? wanted : spareFounder(p, victim));
        p.economy((c) => storeAhead(p, c));
        transports(p);
        p.units();
      },
    };
  },
});
