// The relief module (docs/architecture.md §11.2): moves that expander@2, turtle@2 and opportunist@2
// add to their published versions, opt-in per strategy (the published bots never call them).
//
// - Relief: an own (or, by choice, an allied) city under siege is seen in full, garrison included
//   (its `hold` groups, and the besieger's supports on their way in). The seat attacks the besieger
//   there when a battle model says its waves break the siege by a seeded margin: the last wave wins
//   (A > D), or the waves kill every founder of the garrison, which ends the siege as well (a lost
//   relief at A ≥ 0.71·D kills a lone founder, perfidia-1 §9.3). Waves must land before the siege
//   ends when the hints say when it does; the fewest that break it are sent, and a relief in flight
//   that the besieger's supports would beat is called back while it can be.
// - Support: defenders for an ally's city with an attack on its way (the supportive ally), and the
//   seat's own sieges held with defenders from its nearest cities.
// - Stop the leader: while a rival bloc runs a domination countdown, the seat spies that bloc's
//   nearest cities and strikes the weakest with founders, so that a conquest takes a city away
//   before the countdown ends (a raid does not stop a countdown; a besieged city still counts for
//   its owner). A pact partner's city only when the strategy says so (it breaks the pact).
//
// Everything is read through structured data and the optional `siege` and `domination` hints
// (`hints.ts`); battle numbers through `combatNumbers` like rusher@2 and conqueror@1. A city with
// a siege running is never attacked as a target: its foe would be the besieger, possibly an ally.
// Memory: flags `rs<city>` (a relief left), `kg<city>` (an own siege reinforced), `ks<city>` (a spy
// for a countdown strike), `kt<city>` (a countdown strike left), `sa<city>` (supports sent to an
// ally's city); handled ids `h<movement>` (an attack on an own siege answered) and `a<movement>`
// (an attack on an ally's city answered).

import {
  compareIds,
  type CityId,
  type CityRow,
  type CityView,
  type CityViewFull,
  type IslandId,
  type Json,
  type JsonObject,
  type PlayerId,
  type Res,
  type ToolCall,
  type UnitCounts,
} from "@perfidia/protocol";
import {
  baseDefenseAt,
  call,
  cleanUnits,
  combatNumbers,
  configInt,
  countOf,
  covers,
  fmtTime,
  landPop,
  levelsInReport,
  pmRes,
  power,
  reactionDefense,
  res,
  stockInReport,
  subRes,
  unitsInReport,
  type Kit,
} from "./kit.ts";
import { intelAge, type Planner } from "./plan.ts";
import { randInt, type BotRng } from "./rng.ts";
import type { OwnCity, World } from "./world.ts";

export interface ReliefParams {
  /** A relief's last wave wins when its attack (morale applied) ≥ the defense × winPm / 1000. */
  readonly winPm: number;
  /** A relief that loses but kills every founder needs this margin (‰) over the bare threshold. */
  readonly breakPm: number;
  /** A countdown strike needs this margin (‰) over what its founders need to survive. */
  readonly strikePm: number;
  /** Intel about a countdown target older than this is refreshed by a spy. */
  readonly stale: number;
  /** Spy gold = spyMinGold × spyMult + the land pop last seen. */
  readonly spyMult: number;
  /** Share (‰) of the defenders at home a city sends to support an ally or hold a siege. */
  readonly sharePm: number;
}

export function reliefParams(rng: BotRng): ReliefParams {
  return {
    winPm: randInt(rng, 1150, 1350),
    breakPm: randInt(rng, 1100, 1250),
    strikePm: randInt(rng, 1100, 1300),
    stale: randInt(rng, 14400, 28800),
    spyMult: randInt(rng, 2, 4),
    sharePm: randInt(rng, 300, 450),
  };
}

/** Morale assumed when the hints do not say how to compute it. */
const FALLBACK_MORALE_PM = 800;
/** Waves of one relief at most (one per helper city). */
const RELIEF_WAVES = 3;
/** Nearest helper cities among which the relief's waves are chosen. */
const RELIEF_SCAN = 6;
/** A relief lands this long before the siege ends at the latest. */
const RELIEF_SLACK = 120;
/** Countdown candidates read (and weighed) per turn. */
const COUNTDOWN_SCAN = 4;
/** Spies for countdown strikes per turn. */
const COUNTDOWN_SPIES = 2;
/** Founders a countdown strike carries at most (two survive a narrower win than one). */
const STRIKE_FOUNDERS = 2;
/**
 * What founders need over the defense to survive a won battle (‰), by the founders a wave carries:
 * one founder dies unless the loss rate stays under 50%, one of two under 75% (perfidia-1 §8.6).
 */
const FOUNDERS_PM: readonly number[] = Object.freeze([0, 1420, 1160]);
/** Supports sent to an ally's city are called home after this long. */
const SUPPORT_STAY = 8 * 3600;
/** Assumed growth of a city's units per hour of intel age, per mille. */
const GROWTH_PM = 50;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** `c12` → `c12` as a flag suffix (city ids are flag-safe), or null for anything else. */
function citySuffix(id: string): string | null {
  return /^c[1-9][0-9]*$/.test(id) ? id : null;
}

/** The value at `path` in a JSON object, or undefined. */
function at(v: Json | undefined, path: readonly string[]): Json | undefined {
  let cur = v;
  for (const key of path) {
    if (cur === undefined || cur === null || typeof cur !== "object" || Array.isArray(cur)) {
      return undefined;
    }
    if (!Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** A game time given as a number or as a `[time, text]` pair, or null. */
function timeOf(v: Json | undefined): number | null {
  const t = Array.isArray(v) ? v[0] : v;
  return typeof t === "number" && Number.isSafeInteger(t) ? t : null;
}

const isPlayerId = (v: unknown): v is PlayerId => typeof v === "string" && /^p[1-9][0-9]*$/.test(v);

// Countdowns.

export interface Countdown {
  readonly members: readonly PlayerId[];
  /** When it is due, or null when the briefing does not say. */
  readonly ends: number | null;
}

/** The running domination countdowns of the briefing (hints), or none. */
export function countdowns(w: World): Countdown[] {
  const h = w.hints.domination;
  if (h === undefined) return [];
  const list = at(w.briefing.ext, h.countdowns);
  if (!Array.isArray(list)) return [];
  const out: Countdown[] = [];
  for (const e of list) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
    const members = e[h.members];
    if (!Array.isArray(members)) continue;
    const ids = members.filter(isPlayerId);
    if (ids.length === 0) continue;
    out.push({ members: ids, ends: timeOf(e[h.ends]) });
  }
  return out;
}

/** The countdown of the seat's own bloc, or null. */
export function ownCountdown(w: World): Countdown | null {
  return countdowns(w).find((c) => c.members.includes(w.seat)) ?? null;
}

/** Countdowns of blocs the seat is not in, still running. */
export function rivalCountdowns(w: World): Countdown[] {
  return countdowns(w).filter(
    (c) => !c.members.includes(w.seat) && (c.ends === null || c.ends > w.t),
  );
}

/** The bloc threshold in cities from the leaderboard (hints), or null. */
export function dominationNeed(w: World): number | null {
  const path = w.hints.domination?.need;
  if (path === undefined || w.board === null) return null;
  const v = at(w.board.ext, path);
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
}

// Cities and sieges.

/** True when a city's public extras show a siege (or another state the hints say blocks it). */
export function besiegedExt(w: World, ext: JsonObject | undefined): boolean {
  if (ext === undefined) return false;
  if (w.hints.blockedExt.some((k) => Object.hasOwn(ext, k))) return true;
  const by = w.hints.siege?.by;
  return by !== undefined && isPlayerId(at(ext, by));
}

/** Map rows of cities with a siege running. */
export function besiegedRows(w: World): Set<CityId> {
  const out = new Set<CityId>();
  for (const row of w.map?.cities ?? []) if (besiegedExt(w, row.ext)) out.add(row.id);
  return out;
}

function rowOf(w: World, city: CityId): CityRow | undefined {
  return w.map?.cities.find((c) => c.id === city);
}

/** Cities the map gives to `owner`. */
function citiesOf(w: World, owner: PlayerId): number {
  let n = 0;
  for (const c of w.map?.cities ?? []) if (c.owner === owner) n += 1;
  return n;
}

export interface Siege {
  readonly city: CityId;
  readonly island: IslandId;
  readonly owner: PlayerId;
  /** The besieger, from the city's `hold` groups or its public extras; null when unknown. */
  readonly by: PlayerId | null;
  /** When the siege ends (hints), or null. */
  readonly ends: number | null;
}

/** The player holding a siege in a city seen in full: the owner of its `hold` groups. */
function holderOf(view: CityViewFull): PlayerId | null {
  const holders = view.stationed
    .filter((g) => g.role === "hold" && g.owner !== view.owner)
    .map((g) => g.owner)
    .toSorted(compareIds);
  return holders[0] ?? null;
}

/**
 * The sieges on the seat's cities and, with `allies`, on its allies' cities: from the map's public
 * extras, from its own blocked cities, and from the `hold` groups of the cities it sees in full.
 */
export function sieges(w: World, allies: boolean): Siege[] {
  const out = new Map<CityId, Siege>();
  const mine = (owner: PlayerId | null): boolean =>
    owner === w.seat || (allies && owner !== null && w.relations.get(owner) === "ally");
  const make = (city: CityId, island: IslandId, owner: PlayerId, ext: JsonObject | undefined) => {
    const view = w.views.get(city);
    const full = view !== undefined && view.access === "full" ? view : null;
    const fromExt = w.hints.siege === undefined ? undefined : at(ext, w.hints.siege.by);
    const by = (full === null ? null : holderOf(full)) ?? (isPlayerId(fromExt) ? fromExt : null);
    const ends =
      w.hints.siege === undefined
        ? null
        : timeOf(at(full?.ext ?? ext, w.hints.siege.ends) ?? at(ext, w.hints.siege.ends));
    out.set(city, { city, island, owner, by, ends });
  };
  for (const row of w.map?.cities ?? []) {
    if (row.owner === null || !mine(row.owner)) continue;
    const view = w.views.get(row.id);
    const held = view !== undefined && view.access === "full" && holderOf(view) !== null;
    if (besiegedExt(w, row.ext) || held) make(row.id, row.island, row.owner, row.ext);
  }
  for (const c of w.cities) {
    if (out.has(c.id)) continue;
    const view = w.views.get(c.id);
    const held = view !== undefined && view.access === "full" && holderOf(view) !== null;
    if (c.blocked || held) make(c.id, c.island, w.seat, view?.ext);
  }
  return [...out.values()].toSorted((a, b) => compareIds(a.city, b.city));
}

/** Reads for the relief: every besieged own (and allied) city, seen in full with its garrison. */
export function reliefReads(w: World, allies: boolean): ToolCall[] {
  const out: ToolCall[] = [];
  const rows = besiegedRows(w);
  for (const c of w.cities)
    if (c.blocked || rows.has(c.id)) out.push(call("view_city", { city: c.id }));
  if (allies) {
    for (const row of w.map?.cities ?? []) {
      if (row.owner === null || w.relations.get(row.owner) !== "ally" || !rows.has(row.id))
        continue;
      out.push(call("view_city", { city: row.id }));
    }
  }
  return out.slice(0, 6);
}

// Battle model: the land battle of the rules (square law), with the combat hints.

/** `(loser / winner)²` in per mille. */
function lossPm(loser: number, winner: number): number {
  if (winner <= 0) return 1000;
  const r = Math.min(1000, Math.floor((1000 * loser) / winner));
  return Math.floor((r * r) / 1000);
}

/** Losses of a stack of `n` at `q` ‰, rounded half up. */
function cas(n: number, q: number): number {
  return Math.floor((n * q + 500) / 1000);
}

/** What a city adds to its units' defense: base defense and wall bonus (hints), or a pad. */
interface Fort {
  readonly base: number;
  /** `1000 + wallPm × wall`. */
  readonly factor: number;
  /** No base defense in the hints: units are padded instead. */
  readonly pad: boolean;
}

function fortOf(w: World, levels: Readonly<Record<string, number>> | null): Fort {
  const kit = w.kit;
  const h = combatNumbers(kit, w.hints.combat);
  if (h === null) return { base: 0, factor: 1000, pad: true };
  const maxOf = (b: string | null): number =>
    b === null ? 0 : (kit.buildings.get(b)?.maxLevel ?? 0);
  const hall = levels?.[h.base.building] ?? maxOf(h.base.building);
  const wall = kit.wall === null ? 0 : (levels?.[kit.wall] ?? maxOf(kit.wall));
  return {
    base: baseDefenseAt(kit, h.base, hall) ?? 0,
    factor: 1000 + h.wallPm * wall,
    pad: false,
  };
}

/** The land defense of units worth `units` defense behind `f`. */
function defenseOf(f: Fort, units: number): number {
  const u = f.pad ? units + Math.floor((units * 3) / 10) + 100 : units;
  return Math.floor(((u + f.base) * f.factor) / 1000);
}

/** The seat's morale (‰) against `foe`, from the combat hints. */
export function moraleVs(w: World, foe: PlayerId | null): number {
  const h = combatNumbers(w.kit, w.hints.combat);
  if (h === null) return FALLBACK_MORALE_PM;
  if (h.moralePm <= 0 || foe === null) return 1000;
  return clamp(1000 - h.moralePm * (w.cities.length - citiesOf(w, foe)), h.moraleFloorPm, 1000);
}

/** A city's defense as a spy report shows it: in full, and what is left once every unit died. */
export interface Spied {
  readonly d: number;
  /** The base defense alone, behind a wall a level lower (after a won battle). */
  readonly bare: number;
  /** The units' defense (grown with the intel's age). */
  readonly units: number;
  readonly fort: Fort;
  /** What a won battle takes off the fort's factor (a wall level). */
  readonly breach: number;
}

/**
 * The defense a public city shows on the seat's latest spy report, landing `ahead` seconds from
 * now: the units seen, what its stock trains on warning, grown with the intel's age, behind its
 * base defense and wall; null without a usable spy report or when it is older than `stale`.
 */
export function spiedDefense(
  w: World,
  view: CityView | undefined,
  stale: number,
  ahead = 0,
): Spied | null {
  if (view === undefined || view.access !== "public" || view.intel === null) return null;
  if (view.intel.type !== "spy_report") return null;
  const age = intelAge(w, view);
  if (age === null || age > stale) return null;
  const kit = w.kit;
  const data = view.intel.data;
  const levels = levelsInReport(data);
  const units = power(kit, unitsInReport(kit, data), "defense", true);
  const react = reactionDefense(kit, levels, stockInReport(data));
  const hours = Math.floor((age + ahead) / 3600);
  const grown = units + react + Math.floor(((units + react) * GROWTH_PM * hours) / 1000);
  const f = fortOf(w, levels);
  const h = combatNumbers(kit, w.hints.combat);
  const wallPm = h === null ? 0 : h.wallPm;
  const breached = { ...f, factor: Math.max(1000, f.factor - wallPm) };
  return {
    d: defenseOf(f, grown),
    bare: defenseOf(breached, 0),
    units: grown,
    fort: f,
    breach: f.factor - breached.factor,
  };
}

/** The defense of a city seen in full (an own or an ally's): its units and supports, base and wall. */
export function seenDefense(w: World, view: CityViewFull): number {
  const kit = w.kit;
  let units = power(kit, view.units, "defense", true);
  for (const s of view.stationed) units += power(kit, s.units, "defense", true);
  return defenseOf(fortOf(w, view.buildings), units);
}

/** The naval strength a spy report shows in a city (its warships defend it across water). */
function spiedNaval(w: World, view: CityView | undefined): number {
  if (view === undefined || view.access !== "public" || view.intel === null) return 0;
  return power(w.kit, unitsInReport(w.kit, view.intel.data), "naval", false);
}

// Waves.

interface Wave {
  readonly from: OwnCity;
  readonly units: UnitCounts;
  /** Land attack before morale. */
  readonly attack: number;
  /** Naval strength before morale. */
  readonly naval: number;
  /** Crosses water (a naval phase can run). */
  readonly water: boolean;
  readonly arrive: number;
}

/**
 * What `c` can send to `island`: its attackers at home and, with `defenders`, that share of its
 * defenders, as many as its carriers lift, plus its warships when crossing water; null when nothing
 * that fights would go.
 */
function waveFrom(
  p: Planner,
  c: OwnCity,
  island: IslandId,
  defenders: number,
  founders = 0,
): Wave | null {
  const { w } = p;
  const kit = w.kit;
  const travel = w.travel(c.id, island, false);
  if (travel === null || c.blocked) return null;
  const { attacker, defender, founder, navy } = kit.roles;
  const home = p.homeOf(c.id);
  const popOf = (u: string | null): number =>
    u === null ? 1 : Math.max(1, kit.units.get(u)?.pop ?? 1);
  let lift = p.liftCapacity(c, island);
  const land: Record<string, number> = {};
  const take = (u: string | null, want: number): void => {
    if (u === null || want <= 0) return;
    const n = Math.max(
      0,
      Math.min(want, countOf(home, u) - (land[u] ?? 0), Math.floor(lift / popOf(u))),
    );
    if (n <= 0) return;
    land[u] = (land[u] ?? 0) + n;
    lift -= n * popOf(u);
  };
  take(founder, founders);
  if (founders > 0 && countOf(land, founder) < founders) return null;
  take(attacker, countOf(home, attacker));
  take(defender, Math.floor((countOf(home, defender) * defenders) / 1000));
  if (power(kit, land, "attack", true) <= 0) return null;
  const units = p.withCarriers(c, island, land);
  if (units === null) return null;
  const water = c.island !== island;
  if (water && navy !== null && countOf(home, navy) > 0) units[navy] = countOf(home, navy);
  return {
    from: c,
    units,
    attack: power(kit, units, "attack", true),
    naval: power(kit, units, "naval", false),
    water,
    arrive: w.t + travel,
  };
}

/** The garrison of a siege seen in full: its `hold` units, and the besieger's supports landing by `until`. */
function garrisonOf(view: CityViewFull, by: PlayerId, until: number): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (units: Readonly<Record<string, number>>): void => {
    for (const [u, n] of Object.entries(units)) out[u] = (out[u] ?? 0) + n;
  };
  for (const g of view.stationed) if (g.role === "hold" && g.owner === by) add(g.units);
  for (const m of view.incoming) {
    if (m.kind === "support" && m.owner === by && m.arrive[0] <= until && m.units !== undefined) {
      add(m.units);
    }
  }
  return out;
}

/** The share (‰) of a garrison's founders a lost relief must kill: q at which `cas(n, q) = n`. */
function breakQ(founders: number): number {
  return founders <= 0 ? 0 : 1000 - Math.floor(500 / founders);
}

/**
 * Whether `waves` (in landing order) break a garrison: "win" when the last wave beats what is left
 * by `winPm`, "break" when the waves kill every founder with `breakPm` to spare, else null. A wave
 * that would lose its naval phase sinks whole, so such a plan is null.
 */
function reliefOutcome(
  waves: readonly Pick<Wave, "attack" | "naval" | "water">[],
  g: { def: number; founders: number; naval: number },
  f: Fort,
  m: number,
  prm: ReliefParams,
): "win" | "break" | null {
  let def = g.def;
  let founders = g.founders;
  for (const [i, wave] of waves.entries()) {
    if (wave.water && g.naval > 0 && Math.floor((wave.naval * m) / 1000) <= g.naval) return null;
    const a = Math.floor((wave.attack * m) / 1000);
    const d = defenseOf(f, def);
    if (i === waves.length - 1) {
      if (a * 1000 >= d * prm.winPm) return "win";
      const soft = Math.floor((a * 1000) / prm.breakPm);
      if (soft <= d && lossPm(soft, d) >= breakQ(founders)) return "break";
      return null;
    }
    if (a > d) return "win";
    const q = lossPm(a, d);
    def -= Math.floor((def * q) / 1000);
    founders -= cas(founders, q);
    if (founders <= 0) return "break";
  }
  return null;
}

/**
 * The waves of a relief: among the nearest `RELIEF_SCAN` helpers (in landing order), the fewest
 * that break the garrison (`reliefOutcome`, against the besieger's supports landing before the
 * last of them), then the earliest to land; a small wave that would only die first is left home.
 */
function reliefWaves(
  kit: Kit,
  helpers: readonly Wave[],
  view: CityViewFull,
  by: PlayerId,
  f: Fort,
  m: number,
  prm: ReliefParams,
): { waves: Wave[]; how: "win" | "break" } | null {
  const pool = helpers.slice(0, RELIEF_SCAN);
  for (let n = 1; n <= Math.min(RELIEF_WAVES, pool.length); n += 1) {
    let best: { waves: Wave[]; how: "win" | "break" } | null = null;
    const pick = (start: number, chosen: Wave[]): void => {
      if (chosen.length === n) {
        const last = chosen.at(-1)!.arrive;
        if (best !== null && last >= best.waves.at(-1)!.arrive) return;
        const how = reliefOutcome(chosen, garrisonStats(kit, view, by, last), f, m, prm);
        if (how !== null) best = { waves: [...chosen], how };
        return;
      }
      for (let i = start; i < pool.length; i += 1) pick(i + 1, [...chosen, pool[i]!]);
    };
    pick(0, []);
    if (best !== null) return best;
  }
  return null;
}

/** A garrison as the battle model weighs it: its defense, founders and naval strength. */
interface GarrisonStats {
  readonly def: number;
  readonly founders: number;
  readonly naval: number;
}

/** The besieger's garrison in a city seen in full, its supports landing by `until` included. */
function garrisonStats(kit: Kit, view: CityViewFull, by: PlayerId, until: number): GarrisonStats {
  const garrison = garrisonOf(view, by, until);
  return {
    def: power(kit, garrison, "defense", true),
    founders: countOf(garrison, kit.roles.founder),
    naval: power(kit, garrison, "naval", false),
  };
}

/**
 * Relieves the seat's besieged cities (and its allies', with `allies`): the nearest cities whose
 * attackers (and, with `defendersPm`, that share of their defenders) land before the siege ends
 * attack the besieger when the battle model breaks the siege by the seeded margins: the fewest
 * waves that do (`reliefWaves`), three at most. A relief of the seat in flight is weighed again on
 * every turn (the besieger's supports may have reinforced the garrison) and called back while it
 * can be when it no longer breaks the siege; otherwise it is left to land. An ally's siege that
 * another player already relieves is left to that relief; a besieger that is an ally (or, for an
 * ally's city, a pact partner) is left alone.
 */
export function relieveSieges(
  p: Planner,
  prm: ReliefParams,
  allies: boolean,
  defendersPm: number,
): void {
  const { w } = p;
  const kit = w.kit;
  const running = sieges(w, allies);
  const keys = new Set(running.map((s) => `rs${s.city}`));
  for (const name of Object.keys(p.memory.x)) {
    if (name.startsWith("rs") && !keys.has(name)) p.clearFlag(name);
  }
  if (w.t < kit.rules.time.attackFrom) return;
  for (const s of running) {
    const by = s.by;
    if (by === null || by === w.seat || w.relations.get(by) === "ally") continue;
    if (s.owner !== w.seat && w.relations.has(by)) continue;
    const view = w.views.get(s.city);
    if (view === undefined || view.access !== "full") continue;
    const f = fortOf(w, view.buildings);
    const m = moraleVs(w, by);
    if (p.inFlight("attack", s.city)) {
      recheckRelief(p, prm, s, view, by, f, m);
      continue;
    }
    if (p.attacksLeft <= 0) return;
    // Another player's relief on its way: an ally's city is left to it.
    const theirs = view.incoming.some(
      (i) => i.kind === "attack" && i.party === by && i.owner !== by && i.owner !== w.seat,
    );
    if (theirs && s.owner !== w.seat) continue;
    const deadline = s.ends === null ? null : s.ends - RELIEF_SLACK;
    const helpers = w.cities
      .filter((c) => c.id !== s.city && !c.blocked)
      .flatMap((c) => {
        const wave = waveFrom(p, c, s.island, defendersPm);
        return wave === null || (deadline !== null && wave.arrive > deadline) ? [] : [wave];
      })
      .toSorted((a, b) => a.arrive - b.arrive || compareIds(a.from.id, b.from.id));
    if (helpers.length === 0) continue;
    if (countOf(garrisonOf(view, by, helpers.at(-1)!.arrive), kit.roles.founder) <= 0) continue;
    const plan = reliefWaves(kit, helpers, view, by, f, m, prm);
    if (plan === null) continue;
    let sent = 0;
    for (const wave of plan.waves) if (p.attack(wave.from, s.city, wave.units)) sent += 1;
    if (sent === 0) continue;
    const key = citySuffix(s.city);
    if (key !== null) p.setFlag(`rs${key}`, w.t);
    p.memo(`relief ${s.city} vs ${by} (${plan.how}, ${sent}) ${fmtTime(w.t)}`);
  }
}

/**
 * Weighs again the seat's relief in flight to a besieged city: when its waves (in landing order)
 * no longer break the garrison with the besieger's supports landing before them, those still in
 * their recall window are called back.
 */
function recheckRelief(
  p: Planner,
  prm: ReliefParams,
  s: Siege,
  view: CityViewFull,
  by: PlayerId,
  f: Fort,
  m: number,
): void {
  const { w } = p;
  const kit = w.kit;
  const mine = (w.self?.private?.movements ?? [])
    .filter((x) => x.owner === w.seat && x.kind === "attack" && x.to === s.city)
    .filter((x) => x.party === by && x.units !== undefined && (x.turnedBack ?? null) === null)
    .toSorted((a, b) => a.arrive[0] - b.arrive[0] || compareIds(a.id, b.id));
  const recallable = mine.filter((x) => (x.recallableUntil?.[0] ?? 0) > w.t);
  const last = mine.at(-1);
  if (last === undefined || recallable.length === 0) return;
  const waves = mine.map((x) => {
    const units = x.units ?? {};
    const from = w.cities.find((c) => c.id === x.from);
    return {
      attack: power(kit, units, "attack", true),
      naval: power(kit, units, "naval", false),
      water: from === undefined || from.island !== s.island,
    };
  });
  const g = garrisonStats(kit, view, by, last.arrive[0]);
  if (g.founders <= 0 || reliefOutcome(waves, g, f, m, prm) !== null) return;
  for (const x of recallable) p.recall(x.id);
  p.memo(`relief ${s.city} called back ${fmtTime(w.t)}`);
}

/**
 * Sends defenders to an ally's city with an attack on its way (its owner being the attack's foe,
 * not a relief): a share of the defenders of the nearest own city whose support lands first. Each
 * attack is answered once (`a<movement>`); supports are called home `SUPPORT_STAY` after the last
 * one left for that city, unless an attack is still on its way there.
 */
export function supportAllies(p: Planner, prm: ReliefParams): void {
  const { w } = p;
  const kit = w.kit;
  const defender = kit.roles.defender;
  if (defender === null) return;
  const pop = Math.max(1, kit.units.get(defender)?.pop ?? 1);
  const threatened = new Set<CityId>();
  for (const inc of w.briefing.incoming) {
    if (inc.kind !== "attack" || inc.arrive[0] <= w.t) continue;
    const row = rowOf(w, inc.to);
    if (row === undefined || row.owner === null || row.owner === w.seat) continue;
    if (w.relations.get(row.owner) !== "ally" || inc.foe !== row.owner) continue;
    threatened.add(inc.to);
    if (p.handled(`a${inc.id}`) || besiegedExt(w, row.ext)) continue;
    const helpers = w.cities
      .filter((c) => !c.blocked)
      .map((c) => ({ c, travel: w.travel(c.id, row.island, false) }))
      .filter((h): h is { c: OwnCity; travel: number } => h.travel !== null)
      .filter((h) => w.t + h.travel < inc.arrive[0])
      .toSorted((a, b) => a.travel - b.travel || compareIds(a.c.id, b.c.id));
    for (const { c } of helpers) {
      const have = countOf(p.homeOf(c.id), defender);
      const lift = Math.floor(p.liftCapacity(c, row.island) / pop);
      const n = Math.min(Math.floor((have * prm.sharePm) / 1000), lift);
      if (n <= 0) continue;
      const group = p.withCarriers(c, row.island, { [defender]: n });
      if (group === null) continue;
      p.support(c, inc.to, group);
      const key = citySuffix(inc.to);
      if (key !== null) p.setFlag(`sa${key}`, w.t);
      break;
    }
    p.markHandled(`a${inc.id}`);
  }
  // Supports in allies' cities go home once the danger has passed.
  const recall = kit.rules.movement.recall.stationed !== "none";
  const away = new Set<CityId>();
  for (const s of w.self?.private?.stationed ?? []) if (s.role === "support") away.add(s.city);
  for (const city of [...away].toSorted(compareIds)) {
    const key = citySuffix(city);
    if (key === null || p.w.cities.some((c) => c.id === city)) continue;
    const sent = p.flag(`sa${key}`);
    if (sent === null) {
      p.setFlag(`sa${key}`, w.t);
      continue;
    }
    if (!recall || w.t - sent < SUPPORT_STAY || threatened.has(city)) continue;
    p.recallStationed(city);
    p.clearFlag(`sa${key}`);
  }
  const awayKeys = new Set([...away].map((c) => `sa${c}`));
  for (const name of Object.keys(p.memory.x)) {
    if (name.startsWith("sa") && !awayKeys.has(name)) p.clearFlag(name);
  }
}

/** Cities where the seat holds a siege garrison. */
function heldSieges(w: World): CityId[] {
  const out = new Set<CityId>();
  for (const s of w.self?.private?.stationed ?? []) if (s.role === "hold") out.add(s.city);
  return [...out].toSorted(compareIds);
}

/**
 * Holds the seat's own sieges: once per siege, a share of the defenders of the nearest city that
 * reaches it; against each attack on it, defenders from the two nearest cities landing first.
 */
export function holdSieges(p: Planner, prm: ReliefParams): void {
  const { w } = p;
  const kit = w.kit;
  const defender = kit.roles.defender;
  const held = heldSieges(w);
  const heldKeys = new Set(held.map((c) => `kg${c}`));
  for (const name of Object.keys(p.memory.x)) {
    if (name.startsWith("kg") && !heldKeys.has(name)) p.clearFlag(name);
  }
  if (defender === null) return;
  const pop = Math.max(1, kit.units.get(defender)?.pop ?? 1);
  for (const city of held) {
    const row = rowOf(w, city);
    const key = citySuffix(city);
    if (row === undefined || key === null) continue;
    const threats = w.briefing.incoming.filter(
      (i) => i.to === city && i.kind === "attack" && i.arrive[0] > w.t && !p.handled(`h${i.id}`),
    );
    const fresh = p.flag(`kg${key}`) === null;
    if (threats.length === 0 && !fresh) continue;
    const first = Math.min(...threats.map((i) => i.arrive[0]));
    const helpers = w.cities
      .filter((c) => !c.blocked)
      .map((c) => ({ c, travel: w.travel(c.id, row.island, false) }))
      .filter((h): h is { c: OwnCity; travel: number } => h.travel !== null)
      .filter((h) => threats.length === 0 || w.t + h.travel < first)
      .toSorted((a, b) => a.travel - b.travel || compareIds(a.c.id, b.c.id));
    let sent = 0;
    for (const { c } of helpers) {
      if (sent >= (threats.length > 0 ? 2 : 1)) break;
      const have = countOf(p.homeOf(c.id), defender);
      const lift = Math.floor(p.liftCapacity(c, row.island) / pop);
      const n = Math.min(Math.floor((have * (prm.sharePm + 150)) / 1000), lift);
      if (n <= 0) continue;
      const group = p.withCarriers(c, row.island, { [defender]: n });
      if (group === null) continue;
      p.support(c, city, group);
      sent += 1;
    }
    for (const i of threats) p.markHandled(`h${i.id}`);
    if (fresh) p.setFlag(`kg${key}`, w.t);
  }
}

// Stop the leader.

/** True when the view was read and its city is not one bots leave alone (hints). */
function weighable(w: World, view: CityView | undefined): view is CityView {
  return view !== undefined && (view.tag === null || !w.hints.avoidTags.includes(view.tag));
}

/**
 * Cities of the rival countdown blocs, not besieged, nearest to `from` first: never an ally's, nor,
 * without `pacts`, a pact partner's (a battle against a pact partner ends the pact as a betrayal).
 */
function leaderCities(w: World, from: OwnCity, pacts: boolean): { row: CityRow; travel: number }[] {
  const members = new Set<PlayerId>(rivalCountdowns(w).flatMap((c) => c.members));
  if (members.size === 0) return [];
  const sieged = besiegedRows(w);
  const spared = (owner: PlayerId): boolean => {
    const kind = w.relations.get(owner);
    return kind === "ally" || (!pacts && kind === "pact");
  };
  return (w.map?.cities ?? [])
    .filter((r) => r.owner !== null && members.has(r.owner) && !sieged.has(r.id))
    .filter((r) => r.owner === null || !spared(r.owner))
    .map((row) => ({ row, travel: w.travel(from.id, row.island, false) }))
    .filter((x): x is { row: CityRow; travel: number } => x.travel !== null)
    .toSorted((a, b) => a.travel - b.travel || compareIds(a.row.id, b.row.id));
}

/**
 * The city a strike leaves from: a city with founders at home first, then one that can recruit
 * them, then any; among them the most land attack at home (ties: lowest id). The other cities'
 * attackers can still go first (`stopTheLeader`).
 */
function strikeCity(p: Planner): OwnCity | null {
  const { w } = p;
  const founder = w.kit.roles.founder;
  const cost = w.self?.private?.settler.cost ?? null;
  let best: OwnCity | null = null;
  let key = -1;
  for (const c of w.cities) {
    if (c.blocked) continue;
    const able = p.canRecruit(c, founder) || p.queued(c, founder) > 0;
    const rich = cost !== null && covers(p.stockOf(c.id), cost);
    const rank =
      countOf(p.homeOf(c.id), founder) > 0 || p.queued(c, founder) > 0
        ? 3
        : able && rich
          ? 2
          : able
            ? 1
            : 0;
    const k = rank * 100_000_000 + power(w.kit, p.homeOf(c.id), "attack", true);
    if (k > key) {
      best = c;
      key = k;
    }
  }
  return best;
}

/** What is left of a city's defense after waves of `attacks` (after morale, in landing order). */
interface Left {
  readonly units: number;
  readonly fort: Fort;
}

/**
 * The square law of the rules on a spied city: a lost wave kills `(A/D)²` of its units, a won one
 * kills them all and breaches the wall by a level.
 */
function afterWaves(spied: Spied, attacks: readonly number[]): Left {
  let units = spied.units;
  let factor = spied.fort.factor;
  for (const a of attacks) {
    const d = defenseOf({ ...spied.fort, factor }, units);
    if (a > d) {
      units = 0;
      factor = Math.max(1000, factor - spied.breach);
    } else {
      units -= Math.floor((units * lossPm(a, d)) / 1000);
    }
  }
  return { units, fort: { ...spied.fort, factor } };
}

/** The strike-city waves of a countdown strike: one wave with the founders, or a clearing wave first. */
interface Strike {
  readonly waves: readonly UnitCounts[];
}

/**
 * The strike from `from` against what `left` leaves: two waves landing in one second, every
 * attacker but the escort first (it must win by `winPm`), then the founders with the escort that
 * beats the bare city (base defense, wall a level lower) by the founders' threshold × `strikePm`;
 * else one wave of every attacker with the founders that beats `left` by that threshold. Null when
 * the attackers cover neither.
 */
function planStrike(
  p: Planner,
  from: OwnCity,
  island: IslandId,
  spied: Spied,
  left: Left,
  m: number,
  prm: ReliefParams,
  founders: number,
  defendersPm: number,
): Strike | null {
  const { w } = p;
  const kit = w.kit;
  const { attacker, founder, carrier } = kit.roles;
  if (attacker === null) return null;
  const needPm = FOUNDERS_PM[Math.min(2, founders)] ?? 1420;
  const per = Math.floor(((kit.units.get(attacker)?.attack ?? 0) * m) / 1000);
  if (per <= 0) return null;
  const d = defenseOf(left.fort, left.units);
  const all = waveFrom(p, from, island, defendersPm, founders);
  if (all === null) return null;
  const bare = Math.max(
    1,
    defenseOf({ ...left.fort, factor: Math.max(1000, left.fort.factor - spied.breach) }, 0),
  );
  const escort = Math.ceil((bare * needPm * prm.strikePm) / (1_000_000 * per)) + 2;
  const home = countOf(p.homeOf(from.id), attacker);
  const water = from.island !== island && kit.rules.movement.transportRule;
  const fpop = kit.units.get(founder)?.pop ?? 0;
  const apop = Math.max(1, kit.units.get(attacker)?.pop ?? 1);
  const cap = carrier === null ? 0 : (kit.units.get(carrier)?.capacity ?? 0);
  const lift = water ? p.carrierLift(from) : 1_000_000;
  const clearN = Math.min(home, Math.floor((lift - founders * fpop) / apop)) - escort;
  if (left.units > 0 && clearN > 0 && clearN * per * 1000 >= d * prm.winPm) {
    const clear = p.withCarriers(from, island, { [attacker]: clearN });
    const leadPop = escort * apop + founders * fpop;
    const spare = countOf(p.homeOf(from.id), carrier) - countOf(clear ?? {}, carrier);
    if (clear !== null && (!water || (carrier !== null && cap > 0 && spare * cap >= leadPop))) {
      const lead: Record<string, number> = { [attacker]: escort, [founder]: founders };
      if (water && carrier !== null) lead[carrier] = Math.ceil(leadPop / cap);
      return { waves: [clear, cleanUnits(kit, lead)] };
    }
  }
  const a = Math.floor((all.attack * m) / 1000);
  if (a * 1_000_000 >= d * needPm * prm.strikePm) return { waves: [all.units] };
  return null;
}

/**
 * Reads for a countdown strike: the rival blocs' nearest cities (their latest intel), pact
 * partners' included with `pacts`.
 */
export function countdownReads(w: World, pacts: boolean): ToolCall[] {
  if (rivalCountdowns(w).length === 0) return [];
  const from = w.cities.find((c) => c.capital) ?? w.cities[0];
  if (from === undefined) return [];
  return leaderCities(w, from, pacts)
    .slice(0, COUNTDOWN_SCAN)
    .map((x) => call("view_city", { city: x.row.id }));
}

/** The time a conquest needs once its founders land (a siege's length, hints), or 0 when unknown. */
function siegeLength(kit: Kit, w: World): number {
  return configInt(kit, w.hints.siege?.duration) ?? 0;
}

/**
 * Stops a rival bloc's domination countdown: strikes the weakest of its nearest cities (on a fresh
 * spy report) with founders from the city with the most attack at home, early enough for the
 * conquest to land before the countdown ends. The attackers of the seat's other cities that land
 * no later go first, nearest first, as few as needed; then the strike city's waves (`planStrike`).
 * Without a founder there it recruits one. A pact partner's city is a target only with `pacts` (the
 * strike breaks the pact as a betrayal). Returns true while the seat keeps its founders for the
 * strike (the strategy then founds no city this turn).
 */
export function stopTheLeader(
  p: Planner,
  prm: ReliefParams,
  defendersPm: number,
  pacts: boolean,
): boolean {
  const { w } = p;
  const kit = w.kit;
  const rivals = rivalCountdowns(w);
  for (const name of Object.keys(p.memory.x)) {
    if ((name.startsWith("ks") || name.startsWith("kt")) && rivals.length === 0) p.clearFlag(name);
  }
  if (rivals.length === 0 || ownCountdown(w) !== null) return false;
  if (w.t < kit.rules.time.attackFrom) return false;
  const from = strikeCity(p);
  if (from === null) return false;
  const ends = rivals
    .map((c) => c.ends)
    .filter((e): e is number => e !== null)
    .reduce<number | null>((a, e) => (a === null || e < a ? e : a), null);
  const latest = ends === null ? null : ends - siegeLength(kit, w) - RELIEF_SLACK;
  const cands = leaderCities(w, from, pacts)
    .filter((x) => latest === null || w.t + x.travel <= latest)
    .slice(0, COUNTDOWN_SCAN);
  if (cands.length === 0) return false;

  const founders = Math.min(STRIKE_FOUNDERS, countOf(p.homeOf(from.id), kit.roles.founder));
  if (founders === 0) {
    recruitFounder(p, from);
    scoutLeaders(p, prm, from, cands);
    return true;
  }
  // The weakest candidate on fresh intel.
  let best: { row: CityRow; travel: number; spied: Spied; naval: number } | null = null;
  for (const { row, travel } of cands) {
    const view = w.views.get(row.id);
    if (!weighable(w, view)) continue;
    const spied = spiedDefense(w, view, prm.stale, travel);
    if (spied === null) continue;
    if (best === null || spied.d < best.spied.d) {
      best = { row, travel, spied, naval: spiedNaval(w, view) };
    }
  }
  if (best === null) {
    scoutLeaders(p, prm, from, cands);
    return true;
  }
  const target = best.row;
  const m = moraleVs(w, target.owner);
  const naval = best.naval;
  const sinks = (wave: Wave): boolean =>
    wave.water && naval > 0 && Math.floor((wave.naval * m) / 1000) <= naval;
  const self = waveFrom(p, from, target.island, defendersPm, founders);
  if (self === null || sinks(self)) return true;
  const helpers = w.cities
    .filter((c) => c.id !== from.id && !c.blocked)
    .flatMap((c) => {
      const wave = waveFrom(p, c, target.island, defendersPm);
      return wave === null || wave.arrive > self.arrive || sinks(wave) ? [] : [wave];
    })
    .toSorted((a, b) => a.arrive - b.arrive || compareIds(a.from.id, b.from.id));
  for (let k = 0; k <= helpers.length; k += 1) {
    const first = helpers.slice(0, k);
    const left = afterWaves(
      best.spied,
      first.map((h) => Math.floor((h.attack * m) / 1000)),
    );
    const strike = planStrike(
      p,
      from,
      target.island,
      best.spied,
      left,
      m,
      prm,
      founders,
      defendersPm,
    );
    if (strike === null) continue;
    if (p.attacksLeft < k + strike.waves.length) break;
    for (const h of first) p.attack(h.from, target.id, h.units);
    let sent = 0;
    for (const units of strike.waves) if (p.attack(from, target.id, units)) sent += 1;
    const key = citySuffix(target.id);
    if (sent > 0 && key !== null) p.setFlag(`kt${key}`, w.t);
    p.memo(`stop ${target.owner ?? "?"}: ${target.id} in ${k + sent} ${fmtTime(w.t)}`);
    return true;
  }
  scoutLeaders(p, prm, from, cands);
  return true;
}

/** Recruits one founder in `c` for a countdown strike when none is queued there. */
function recruitFounder(p: Planner, c: OwnCity): void {
  const { w } = p;
  const kit = w.kit;
  const founder = kit.roles.founder;
  if (p.queued(c, founder) > 0) return;
  const cost = w.self?.private?.settler.cost;
  const row = kit.units.get(founder);
  if (cost === undefined || row === undefined || !p.canRecruit(c, founder)) return;
  if (p.popFreeOf(c.id) < row.pop) return;
  if (covers(p.stockOf(c.id), cost)) {
    p.recruit(c, [{ unit: founder, count: 1 }], cost);
    return;
  }
  p.reserve(c.id, cost);
  shipFor(p, c, cost);
}

/**
 * The seat's other cities ship what `c` lacks for `cost`, nearest first: half their stock of each
 * resource at most, within what their shipments may carry; nothing while a shipment of the seat is
 * already on its way to `c`.
 */
function shipFor(p: Planner, c: OwnCity, cost: Res): void {
  const { w } = p;
  const ship = w.kit.rules.movement.shipment;
  if (ship === null) return;
  const moves = w.self?.private?.movements ?? [];
  if (moves.some((m) => m.owner === w.seat && m.kind === "shipment" && m.to === c.id)) return;
  let lack = subRes(cost, p.stockOf(c.id));
  const helpers = w.cities
    .filter((o) => o.id !== c.id && !o.blocked && o.levels !== null)
    .map((o) => ({ o, travel: w.travel(o.id, c.island, false) }))
    .filter((x): x is { o: OwnCity; travel: number } => x.travel !== null)
    .toSorted((a, b) => a.travel - b.travel || compareIds(a.o.id, b.o.id));
  for (const { o } of helpers) {
    if (lack.wood + lack.stone + lack.gold <= 0) return;
    const busy = moves.some((m) => m.owner === w.seat && m.kind === "shipment" && m.from === o.id);
    if (busy) continue;
    const room = ship.base + ship.perLevel * (o.levels?.[ship.building] ?? 0);
    const half = pmRes(p.stockOf(o.id), 500);
    let give = res(
      Math.min(lack.wood, half.wood),
      Math.min(lack.stone, half.stone),
      Math.min(lack.gold, half.gold),
    );
    const total = give.wood + give.stone + give.gold;
    if (total <= 0) continue;
    if (total > room) give = pmRes(give, Math.floor((room * 1000) / total));
    if (give.wood + give.stone + give.gold <= 0) continue;
    p.ship(o, c.id, give);
    lack = subRes(lack, give);
  }
}

/** Spies the nearest countdown candidates whose intel is missing or stale (two a turn at most). */
function scoutLeaders(
  p: Planner,
  prm: ReliefParams,
  from: OwnCity,
  cands: readonly { row: CityRow; travel: number }[],
): void {
  const { w } = p;
  let sent = 0;
  for (const { row } of cands) {
    if (sent >= COUNTDOWN_SPIES) return;
    const view = w.views.get(row.id);
    if (!weighable(w, view) || view.access !== "public") continue;
    if (spiedDefense(w, view, prm.stale) !== null || p.inFlight("spy", row.id)) continue;
    const key = citySuffix(row.id);
    if (key === null) continue;
    const last = p.flag(`ks${key}`);
    if (last !== null && w.t - last < Math.floor(prm.stale / 3)) continue;
    const seen = view.intel === null ? null : landPop(w.kit, unitsInReport(w.kit, view.intel.data));
    const gold = p.spyGold(from, prm.spyMult, seen);
    if (gold === null) return;
    p.spy(from, row.id, gold);
    p.setFlag(`ks${key}`, w.t);
    sent += 1;
  }
}
