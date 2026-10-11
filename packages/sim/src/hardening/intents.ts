import {
  createMatch,
  freeSlots,
  inFlightCargo,
  maxAffordable,
  popCap,
  popUsed,
  relation,
  relationsOf,
  sortedIds,
  stockAt,
  storageCap,
  unitCost,
  unitsAtHome,
  type AnyRuleset,
} from "@perfidia/engine";
import type { ReadCtx } from "@perfidia/engine/contracts";
import { randInt, type Rng } from "@perfidia/engine/core";
import { domain } from "@perfidia/engine/domain";
import type { InvariantLevel, Match } from "@perfidia/engine/kernel";
import { addCity, addStationed, addUnits, matchFromState } from "@perfidia/engine/testing";
import type {
  Action,
  City,
  CityId,
  CompiledRules,
  DeepReadonly,
  GameState,
  IslandId,
  Json,
  MovementId,
  PlayerId,
  ProposalId,
  Res,
  UnitCounts,
} from "@perfidia/protocol";
import { setupFor } from "../harness/index.ts";

// Engine action intents for P4 and P15 (docs/architecture.md §13.2): actions resolved against the
// current state so that most are valid, plus near misses and schema-valid junk, and a staged start
// where recalls meet stationed groups from several homes, dismissals have guests to send home, and
// every capital holds carriers, founding units and a strike force, so that moves across water,
// foundations, sieges and conquests are within reach from the start.
//
// Resolution reads the whole state (the generator is a test oracle, not a player) through the
// generic `CompiledRules` and `std` derivations only, so both rulesets get the same generator:
// units at home, the transport rule (carriers are added, or land units left behind, until the
// group fits), costs, requirements, queue and population limits, free slots, recall windows,
// open proposals and pact limits. A kind that nothing in the state can make valid for the seat
// (no proposal to answer, no movement still recallable, no guest to dismiss…) is not drawn: the
// draw moves on to another kind. Two kinds are meant to fail: `junk` (unknown ids, foreign
// cities, empty groups) and `edge`, a resolved action pushed just past one rule of the current
// state (one unit more than at home or than the budget allows, land units across water without
// carriers, cargo over the in-flight cap, a proposal that can no longer be accepted, a recall out
// of its window, a full island, a besieged origin…), so the domain's rejections with their
// computed details run on real states too.

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const pick = <T>(rng: Rng, list: readonly T[]): T | undefined =>
  list.length === 0 ? undefined : list[randInt(rng, 0, list.length - 1)];

export const percent = (rng: Rng, p: number): boolean => randInt(rng, 0, 99) < p;

type Rules = DeepReadonly<CompiledRules>;
type UnitRow = Rules["units"][number];

/** The land unit with the highest attack (not the founding unit): a capital's strike force. */
function striker(rules: Rules): UnitRow | undefined {
  return rules.units
    .filter((u) => u.domain === "land" && u.attack > 0 && u.id !== rules.roles.settler)
    .toSorted((a, b) => b.attack - a.attack || byText(a.id, b.id))[0];
}

/** The carrier with the largest capacity. */
function carrier(rules: Rules): UnitRow | undefined {
  return rules.units
    .filter((u) => u.capacity > 0)
    .toSorted((a, b) => b.capacity - a.capacity || byText(a.id, b.id))[0];
}

/** Units added to a city's home units, counted in the owner's ledger as the testing kit does. */
function addHome(state: GameState, city: City, units: Readonly<UnitCounts>): void {
  addUnits(city.units, units);
  const entry = state.ledger[city.owner ?? "neutral"];
  if (entry === undefined) throw new Error(`no ledger entry for ${city.owner ?? "neutral"}`);
  addUnits(entry.made, units);
}

/** The pop homed in `city` at the start: its units at home and its stationed groups elsewhere. */
function homedPop(state: GameState, rules: Rules, city: City): number {
  const pop = (units: Readonly<UnitCounts>): number =>
    rules.units.reduce((n, u) => n + (units[u.id] ?? 0) * u.pop, 0);
  let n = pop(city.units);
  for (const c of Object.values(state.cities)) {
    for (const g of c.stationed) if (g.home === city.id) n += pop(g.units);
  }
  return n;
}

/**
 * A match of `ruleset` from its real start for `players` seats, plus: every building of every
 * capital raised to at least `levels` (so every unit can be recruited from level 3 on); in every
 * capital, 3 of the largest carrier, 2 founding units and 20 of the strongest land attacker at home
 * (and its population building raised until they fit, with room to spare); a second city for p1
 * and for p4, a support group from each of their two cities stationed in the capital of p2 and of
 * p5, and a support group of p3 in p1's capital. Edits outside the action pipeline stay consistent
 * with the invariants (every unit is counted in the ledger).
 */
export function stagedStart(
  ruleset: AnyRuleset,
  seed: number,
  players: number,
  o: {
    readonly overrides?: Readonly<Record<string, Json>>;
    readonly invariants?: InvariantLevel;
    readonly levels?: number;
  } = {},
): Match {
  const setup = setupFor(ruleset, { seed, players, days: 1, overrides: o.overrides ?? {} });
  const base = createMatch(setup, ruleset);
  const state = base.snapshot(0).state;
  const rules = base.rules;
  const levels = o.levels ?? 0;
  const capitals = sortedIds(state.cities)
    .map((id) => state.cities[id])
    .filter((c): c is City => c !== undefined && c.capitalOf !== null);
  for (const c of capitals) {
    for (const b of rules.buildings) {
      c.buildings[b.id] = Math.max(c.buildings[b.id] ?? 0, Math.min(levels, b.maxLevel));
    }
  }
  const capital = (p: PlayerId): City => {
    const c = capitals.find((x) => x.capitalOf === p);
    if (c === undefined) throw new Error(`no capital for ${p}`);
    return c;
  };
  const freeSlot = (): { island: IslandId; slot: number } => {
    for (const island of sortedIds(state.islands)) {
      const taken = new Set(
        Object.values(state.cities)
          .filter((c) => c.island === island)
          .map((c) => c.slot),
      );
      const slots = state.islands[island]?.slots ?? 0;
      const slot = Array.from({ length: slots }, (_, i) => i).find((i) => !taken.has(i));
      if (slot !== undefined) return { island, slot };
    }
    throw new Error("no free slot");
  };
  const firstUnit = (c: City): string =>
    Object.keys(c.units).toSorted(byText)[0] ?? rules.units[0]?.id ?? "x";
  for (const [owner, host] of [
    ["p1", "p2"],
    ["p4", "p5"],
  ] as const) {
    if (!Object.hasOwn(state.players, owner) || !Object.hasOwn(state.players, host)) continue;
    const home = capital(owner);
    const unit = firstUnit(home);
    const second = addCity(state, rules, {
      owner,
      ...freeSlot(),
      buildings: { ...home.buildings },
      stock: 300,
      units: { [unit]: 6 },
    });
    const at = capital(host).id;
    addStationed(state, at, { owner, home: home.id, role: "support", units: { [unit]: 4 } });
    addStationed(state, at, { owner, home: second.id, role: "support", units: { [unit]: 4 } });
  }
  if (Object.hasOwn(state.players, "p3")) {
    const p3 = capital("p3");
    addStationed(state, capital("p1").id, {
      owner: "p3",
      home: p3.id,
      role: "support",
      units: { [firstUnit(p3)]: 2 },
    });
  }
  const force: UnitCounts = { [rules.roles.settler]: 2 };
  const ship = carrier(rules);
  const strike = striker(rules);
  if (ship !== undefined) force[ship.id] = 3;
  if (strike !== undefined) force[strike.id] = 20;
  const popBuilding = rules.roles.population;
  const popMax = rules.buildings.find((b) => b.id === popBuilding)?.maxLevel ?? 0;
  for (const c of capitals) {
    addHome(state, c, force);
    const need = homedPop(state, rules, c) + 20;
    let level = c.buildings[popBuilding] ?? 0;
    while (level < popMax && (rules.levels.population[level] ?? 0) < need) level += 1;
    c.buildings[popBuilding] = level;
  }
  return matchFromState(state, ruleset, { setup, domain, invariants: o.invariants ?? "step" });
}

export type IntentKind =
  | "build"
  | "recruit"
  | "cancel_queue"
  | "send_resources"
  | "attack"
  | "conquer"
  | "support"
  | "spy"
  | "recall"
  | "recall_stationed"
  | "dismiss"
  | "found_city"
  | "send_message"
  | "propose"
  | "answer"
  | "leave"
  | "ext"
  | "edge"
  | "junk";

/** The kinds meant to be rejected. */
export const FAILING_KINDS: readonly IntentKind[] = ["edge", "junk"];

const WEIGHTS: readonly (readonly [IntentKind, number])[] = [
  ["build", 6],
  ["recruit", 6],
  ["cancel_queue", 1],
  ["send_resources", 2],
  ["attack", 4],
  ["conquer", 2],
  ["support", 3],
  ["spy", 2],
  ["recall", 3],
  ["recall_stationed", 4],
  ["dismiss", 2],
  ["found_city", 2],
  ["send_message", 2],
  ["propose", 5],
  ["answer", 6],
  ["leave", 1],
  ["ext", 1],
  ["edge", 4],
  ["junk", 3],
];

/** The intent kinds a ruleset's rules can accept at all (the failing kinds excluded). */
export function possibleKinds(rules: Rules, ruleset: AnyRuleset): IntentKind[] {
  return WEIGHTS.map(([k]) => k).filter((k) => {
    if (FAILING_KINDS.includes(k)) return false;
    if (k === "dismiss") return rules.movement.recall.dismiss;
    if (k === "recall") return rules.movement.recall.kinds.length > 0;
    if (k === "recall_stationed") return rules.movement.recall.stationed !== "none";
    if (k === "ext") return (ruleset.tools ?? []).some((t) => t.kind !== "read");
    return true;
  });
}

/** An intent and the kind it was drawn as. */
export interface Intent {
  readonly kind: IntentKind;
  readonly action: Action;
}

/** How many kinds a draw tries before it settles for a message. */
const DRAWS = 12;

/**
 * One intent of `seat` resolved against `r`: a weighted kind, redrawn while the state offers
 * nothing valid of that kind, else a message to everyone. `edge` and `junk` (`FAILING_KINDS`) are
 * schema-valid and meant to fail.
 */
export function drawIntent(r: ReadCtx, seat: PlayerId, rng: Rng): Intent {
  const s = new Seat(r, seat, rng);
  const weights = WEIGHTS.filter(([k]) => k === "junk" || s.possible(k));
  const total = weights.reduce((a, [, w]) => a + w, 0);
  for (let i = 0; i < DRAWS; i += 1) {
    let roll = randInt(rng, 0, total - 1);
    const kind = weights.find(([, w]) => (roll -= w) < 0)?.[0] ?? "junk";
    const action = kind === "junk" ? s.junk() : s.resolve(kind);
    if (action !== null) return { kind, action };
  }
  return { kind: "send_message", action: s.message("all") };
}

/** `drawIntent`'s action. */
export function intent(r: ReadCtx, seat: PlayerId, rng: Rng): Action {
  return drawIntent(r, seat, rng).action;
}

/** One action of `kind` for `seat`, resolved against `r`; junk when nothing of that kind is valid. */
export function intentOf(kind: IntentKind, r: ReadCtx, seat: PlayerId, rng: Rng): Action {
  const s = new Seat(r, seat, rng);
  return (kind === "junk" ? null : s.resolve(kind)) ?? s.junk();
}

/** One action of `kind` for `seat` resolved against `r`, or null when none can be valid now. */
export function resolveIntent(
  kind: Exclude<IntentKind, "junk">,
  r: ReadCtx,
  seat: PlayerId,
  rng: Rng,
): Action | null {
  return new Seat(r, seat, rng).resolve(kind);
}

const RES = ["wood", "stone", "gold"] as const;

/** The resolution of one seat's intents on one state. */
class Seat {
  private readonly st: DeepReadonly<GameState>;
  private readonly rules: Rules;
  /** The other living players. */
  private readonly others: PlayerId[];
  private readonly cities: CityId[];
  private readonly own: CityId[];
  /** Own cities not held against the seat: they can build, recruit and send. */
  private readonly ready: CityId[];
  private readonly foreign: CityId[];
  private readonly r: ReadCtx;
  private readonly seat: PlayerId;
  private readonly rng: Rng;

  constructor(r: ReadCtx, seat: PlayerId, rng: Rng) {
    this.r = r;
    this.seat = seat;
    this.rng = rng;
    this.st = r.state;
    this.rules = r.rules;
    this.others = sortedIds(this.st.players).filter(
      (p) => p !== seat && this.st.players[p]?.alive === true,
    );
    this.cities = sortedIds(this.st.cities);
    this.own = this.cities.filter((c) => this.st.cities[c]?.owner === seat);
    this.ready = this.own.filter((c) => this.heldBy(c) === null);
    this.foreign = this.cities.filter((c) => this.st.cities[c]?.owner !== seat);
  }

  /** Cheap pre-checks: kinds that can never be valid for this seat now are not drawn. */
  possible(kind: IntentKind): boolean {
    const ready = (): boolean => this.ready.length > 0;
    const checks: Readonly<Record<IntentKind, () => boolean>> = {
      attack: () => this.r.now >= this.rules.time.attackFrom && ready(),
      conquer: () => this.r.now >= this.rules.time.attackFrom && ready(),
      dismiss: () => this.rules.movement.recall.dismiss && this.guests().length > 0,
      recall: () => this.recallable().length > 0,
      recall_stationed: () =>
        this.rules.movement.recall.stationed !== "none" && this.holding().length > 0,
      answer: () => this.incoming().length > 0,
      leave: () => this.leaveOptions().length > 0,
      ext: () => this.writeTools().length > 0 && this.own.length > 0,
      send_message: () => this.others.length > 0,
      propose: () => this.others.length > 0,
      build: ready,
      recruit: ready,
      send_resources: ready,
      support: ready,
      spy: ready,
      found_city: ready,
      cancel_queue: () => this.own.length > 0,
      edge: () => true,
      junk: () => true,
    };
    return checks[kind]();
  }

  resolve(kind: Exclude<IntentKind, "junk">): Action | null {
    if (!this.possible(kind)) return null;
    const resolvers: Readonly<Record<Exclude<IntentKind, "junk">, () => Action | null>> = {
      build: () => this.build(),
      recruit: () => this.recruit(),
      cancel_queue: () => this.cancel(),
      send_resources: () => this.shipment(),
      attack: () => this.attack(),
      conquer: () => this.conquer(),
      support: () => this.support(),
      spy: () => this.spy(),
      recall: () => {
        const m = pick(this.rng, this.recallable());
        return m === undefined ? null : { type: "recall", movement: m };
      },
      recall_stationed: () => this.recallStationed(),
      dismiss: () => {
        const g = pick(this.rng, this.guests());
        return g === undefined ? null : { type: "dismiss", city: g.city, player: g.player };
      },
      found_city: () => this.found(),
      send_message: () => this.message(percent(this.rng, 25) ? "all" : null),
      propose: () => this.propose(),
      answer: () => this.answer(),
      leave: () => {
        const w = pick(this.rng, this.leaveOptions());
        return w === undefined ? null : { type: "leave", with: w.with };
      },
      ext: () => this.ext(),
      edge: () => this.edge(),
    };
    return resolvers[kind]();
  }

  // Reading the state ---------------------------------------------------------------------------

  private city(id: CityId): DeepReadonly<City> | undefined {
    return this.st.cities[id];
  }

  /** The owner of the `hold` group in the city (a siege garrison), or null. */
  private heldBy(id: CityId): PlayerId | null {
    const c = this.city(id);
    return c?.stationed.find((g) => g.role === "hold" && g.owner !== c.owner)?.owner ?? null;
  }

  private level(c: DeepReadonly<City>, building: string): number {
    return c.buildings[building] ?? 0;
  }

  private landPop(units: Readonly<UnitCounts>): number {
    return this.rules.units.reduce(
      (n, u) => n + (u.domain === "land" ? (units[u.id] ?? 0) * u.pop : 0),
      0,
    );
  }

  private capacity(units: Readonly<UnitCounts>): number {
    return this.rules.units.reduce((n, u) => n + (units[u.id] ?? 0) * u.capacity, 0);
  }

  /** Whether a group fights in an attack (§7.3): a land attacker, or a warship across water. */
  private fights(units: Readonly<UnitCounts>, crossing: boolean): boolean {
    return this.rules.units.some(
      (u) =>
        (units[u.id] ?? 0) > 0 && (u.domain === "land" ? u.attack > 0 : crossing && u.naval > 0),
    );
  }

  private crossing(from: CityId, island: IslandId): boolean {
    return this.city(from)?.island !== island;
  }

  /**
   * `wanted` made to obey the transport rule from `from` to `island`: carriers at home are added
   * until they carry its land units, then land units are left behind (the founding unit last)
   * until the rest fits. Zero counts are dropped.
   */
  private carried(
    from: CityId,
    island: IslandId,
    wanted: Readonly<UnitCounts>,
    home: Readonly<UnitCounts>,
  ): UnitCounts {
    const out: UnitCounts = { ...wanted };
    if (this.rules.movement.transportRule && this.crossing(from, island)) {
      const carriers = this.rules.units
        .filter((u) => u.capacity > 0)
        .toSorted((a, b) => b.capacity - a.capacity || byText(a.id, b.id));
      for (const u of carriers) {
        while (this.landPop(out) > this.capacity(out) && (out[u.id] ?? 0) < (home[u.id] ?? 0)) {
          out[u.id] = (out[u.id] ?? 0) + 1;
        }
      }
      const settler = this.rules.roles.settler;
      const land = this.rules.units
        .filter((u) => u.domain === "land" && u.pop > 0)
        .toSorted((a, b) => Number(a.id === settler) - Number(b.id === settler));
      for (const u of land) {
        const excess = this.landPop(out) - this.capacity(out);
        if (excess <= 0) break;
        const n = out[u.id] ?? 0;
        out[u.id] = n - Math.min(n, Math.ceil(excess / u.pop));
      }
    }
    for (const id of Object.keys(out)) if ((out[id] ?? 0) <= 0) delete out[id];
    return out;
  }

  /** A part of `home`, or all of it; the founding unit only when `settlers`. */
  private partOf(home: Readonly<UnitCounts>, settlers: boolean): UnitCounts {
    const out: UnitCounts = {};
    const all = percent(this.rng, 30);
    for (const [u, n] of Object.entries(home).toSorted(([a], [b]) => byText(a, b))) {
      if (!settlers && u === this.rules.roles.settler) continue;
      const take = all ? n : Math.ceil((n * randInt(this.rng, 1, 4)) / 4);
      if (take > 0) out[u] = take;
    }
    return out;
  }

  /** Cities of `list` on the island of `from` when `same`, else all of them. */
  private near(from: CityId, list: readonly CityId[], same: boolean): CityId[] {
    if (!same) return [...list];
    const island = this.city(from)?.island;
    const local = list.filter((c) => this.city(c)?.island === island);
    return local.length > 0 ? local : [...list];
  }

  // Military -------------------------------------------------------------------------------------

  /** Targets of an attack: cities the seat does not own and does not hold. */
  private attackTargets(): CityId[] {
    return this.foreign.filter((c) => this.heldBy(c) !== this.seat);
  }

  private attack(): Action | null {
    const origins = this.ready.filter((c) => this.fights(unitsAtHome(this.r, c), false));
    const from = pick(this.rng, origins);
    if (from === undefined) return null;
    const home = unitsAtHome(this.r, from);
    const to = pick(this.rng, this.near(from, this.attackTargets(), percent(this.rng, 40)));
    const target = to === undefined ? undefined : this.city(to);
    if (to === undefined || target === undefined) return null;
    const wanted = this.partOf(home, percent(this.rng, 25));
    const units = this.carried(from, target.island, wanted, home);
    if (!this.fights(units, this.crossing(from, target.island))) return null;
    return { type: "attack", from, to, units };
  }

  /** The defense of the land units that would fight for `id` against the seat. */
  private defenseOf(id: CityId): number {
    const c = this.city(id);
    if (c === undefined) return 0;
    const present: UnitCounts = c.owner === null ? { ...c.units } : unitsAtHome(this.r, id);
    for (const g of c.stationed) if (g.owner !== this.seat) addUnits(present, g.units);
    return this.rules.units.reduce(
      (n, u) => n + (u.domain === "land" ? (present[u.id] ?? 0) * u.defense : 0),
      0,
    );
  }

  /**
   * A conquest attempt: every fighter and up to two founding units of an own city, carried, at
   * the least defended city no siege holds (or, at times, any target).
   */
  private conquer(): Action | null {
    const settler = this.rules.roles.settler;
    const origins = this.ready.filter((c) => {
      const home = unitsAtHome(this.r, c);
      return (home[settler] ?? 0) > 0 && this.fights(home, false);
    });
    const from = pick(this.rng, origins);
    if (from === undefined) return null;
    const home = unitsAtHome(this.r, from);
    const open = this.attackTargets().filter((c) => this.heldBy(c) === null);
    const ranked = open
      .map((c) => ({ c, d: this.defenseOf(c) }))
      .toSorted((a, b) => a.d - b.d || byText(a.c, b.c));
    const to = percent(this.rng, 75) ? ranked[0]?.c : pick(this.rng, open);
    const target = to === undefined ? undefined : this.city(to);
    if (to === undefined || target === undefined) return null;
    const crossing = this.crossing(from, target.island);
    const wanted: UnitCounts = { [settler]: Math.min(2, home[settler] ?? 0) };
    for (const u of this.rules.units) {
      const n = home[u.id] ?? 0;
      const fighter = u.domain === "land" ? u.attack > 0 : crossing && u.naval > 0;
      if (n > 0 && u.id !== settler && fighter) wanted[u.id] = n;
    }
    const units = this.carried(from, target.island, wanted, home);
    if (!this.fights(units, crossing)) return null;
    return { type: "attack", from, to, units };
  }

  private support(): Action | null {
    const settler = this.rules.roles.settler;
    const origins = this.ready.filter((c) =>
      Object.entries(unitsAtHome(this.r, c)).some(([u, n]) => u !== settler && n > 0),
    );
    const from = pick(this.rng, origins);
    if (from === undefined) return null;
    const targets = this.cities.filter((c) => {
      if (c === from) return false;
      const held = this.heldBy(c);
      return held === this.seat || (held === null && this.city(c)?.owner !== null);
    });
    const friends = targets.filter((c) => {
      const owner = this.city(c)?.owner ?? null;
      return owner !== null && relation(this.r, this.seat, owner) !== "none";
    });
    const pool = percent(this.rng, 50) && friends.length > 0 ? friends : targets;
    const to = pick(this.rng, this.near(from, pool, percent(this.rng, 40)));
    const target = to === undefined ? undefined : this.city(to);
    if (to === undefined || target === undefined) return null;
    const home = unitsAtHome(this.r, from);
    const units = this.carried(from, target.island, this.partOf(home, false), home);
    if (Object.keys(units).length === 0) return null;
    return { type: "support", from, to, units };
  }

  private found(): Action | null {
    const settler = this.rules.roles.settler;
    const from = pick(
      this.rng,
      this.ready.filter((c) => (unitsAtHome(this.r, c)[settler] ?? 0) > 0),
    );
    if (from === undefined) return null;
    const open = sortedIds(this.st.islands).filter((i) => freeSlots(this.r, i).length > 0);
    const local = open.filter((i) => i === this.city(from)?.island);
    const island = pick(this.rng, percent(this.rng, 50) && local.length > 0 ? local : open);
    if (island === undefined) return null;
    const home = unitsAtHome(this.r, from);
    const escort = percent(this.rng, 50) ? this.partOf(home, false) : {};
    const units = this.carried(from, island, { ...escort, [settler]: 1 }, home);
    if ((units[settler] ?? 0) < 1) return null;
    const slot =
      this.rules.toolOptions.foundSlot && percent(this.rng, 30)
        ? (pick(this.rng, freeSlots(this.r, island)) ?? null)
        : null;
    return { type: "found_city", from, island, units, slot };
  }

  private spy(): Action | null {
    const min = this.rules.movement.spyMinGold;
    const from = pick(
      this.rng,
      this.ready.filter((c) => stockAt(this.r, c).gold >= min),
    );
    const to = pick(this.rng, this.foreign);
    if (from === undefined || to === undefined) return null;
    const gold = stockAt(this.r, from).gold;
    return { type: "spy", from, to, gold: randInt(this.rng, min, Math.min(gold, min * 3)) };
  }

  /** The cargo `from` may still send: its stock within the room under the in-flight cap. */
  private shipment(): Action | null {
    const from = pick(this.rng, this.ready);
    if (from === undefined) return null;
    const c = this.city(from);
    if (c === undefined) return null;
    const rule = this.rules.movement.shipment;
    let room =
      rule === null
        ? Number.MAX_SAFE_INTEGER
        : rule.base + rule.perLevel * this.level(c, rule.building) - inFlightCargo(this.r, from);
    const to = pick(
      this.rng,
      this.cities.filter((x) => {
        const owner = this.city(x)?.owner ?? null;
        return x !== from && owner !== null && this.heldBy(x) === null;
      }),
    );
    if (to === undefined || room < 1) return null;
    const stock = stockAt(this.r, from);
    const res: Res = { wood: 0, stone: 0, gold: 0 };
    for (const id of RES) {
      const take = Math.min(room, randInt(this.rng, 0, Math.min(stock[id], 80)));
      res[id] = take;
      room -= take;
    }
    if (res.wood + res.stone + res.gold < 1) {
      const id = RES.find((x) => stock[x] > 0);
      if (id === undefined) return null;
      res[id] = 1;
    }
    return { type: "send_resources", from, to, res };
  }

  /** The seat's movements still recallable (§7.4): kind and window. */
  private recallable(): MovementId[] {
    const rule = this.rules.movement.recall;
    const kinds: readonly string[] = rule.kinds;
    return sortedIds(this.st.movements).filter((id) => {
      const m = this.st.movements[id];
      return (
        m !== undefined &&
        m.owner === this.seat &&
        m.kind !== "return" &&
        kinds.includes(m.kind) &&
        this.r.now - m.departAt <= rule.window
      );
    });
  }

  /** Cities holding the seat's groups, the ones with groups from the most homes first. */
  private holding(): { c: CityId; homes: CityId[]; units: Record<CityId, UnitCounts> }[] {
    return this.cities
      .map((c) => {
        const groups = this.city(c)?.stationed.filter((g) => g.owner === this.seat) ?? [];
        const units: Record<CityId, UnitCounts> = {};
        for (const g of groups) addUnits((units[g.home] ??= {}), g.units);
        return { c, homes: sortedIds(units), units };
      })
      .filter((x) => x.homes.length > 0)
      .toSorted((a, b) => b.homes.length - a.homes.length || byText(a.c, b.c));
  }

  /**
   * `recall_stationed`: mostly from the city with groups from the most homes; the whole of the
   * seat's groups there, one group whole, or (rules allowing it) a part of one named group.
   */
  private recallStationed(): Action | null {
    const holding = this.holding();
    const at = (percent(this.rng, 70) ? holding[0] : pick(this.rng, holding)) ?? holding[0];
    if (at === undefined) return null;
    const partial = this.rules.movement.recall.stationed === "partial";
    const draw = randInt(this.rng, 0, 9);
    if (draw === 0) return { type: "recall_stationed", at: at.c, home: null, units: null };
    const home = pick(this.rng, at.homes) ?? null;
    if (draw <= 3 || !partial || home === null) {
      return { type: "recall_stationed", at: at.c, home, units: null };
    }
    const group = at.units[home] ?? {};
    const units: UnitCounts = {};
    for (const [u, n] of Object.entries(group).toSorted(([a], [b]) => byText(a, b))) {
      if (n > 0 && Object.keys(units).length === 0) units[u] = randInt(this.rng, 1, n);
    }
    return { type: "recall_stationed", at: at.c, home, units };
  }

  /** Other players' support groups in the seat's cities (not a besieger's, which the guard keeps). */
  private guests(): { city: CityId; player: PlayerId }[] {
    const out: { city: CityId; player: PlayerId }[] = [];
    for (const c of this.own) {
      for (const g of this.city(c)?.stationed ?? []) {
        if (g.role !== "support" || g.owner === this.seat || g.owner === this.heldBy(c)) continue;
        if (!out.some((x) => x.city === c && x.player === g.owner))
          out.push({ city: c, player: g.owner });
      }
    }
    return out;
  }

  // Economy --------------------------------------------------------------------------------------

  /** Within the storage cap and in stock now. */
  private payable(id: CityId, cost: Readonly<Res>): boolean {
    const cap = storageCap(this.r, id);
    const stock = stockAt(this.r, id);
    return RES.every((x) => cost[x] <= cap && cost[x] <= stock[x]);
  }

  /** Whether `building` can be queued in `id` now: level, queue, requirements and cost. */
  private buildable(id: CityId, building: Rules["buildings"][number]): boolean {
    const c = this.city(id);
    const rule = this.rules.queues.build;
    if (c === undefined || c.build.length >= rule.max) return false;
    const projected = (b: string): number =>
      this.level(c, b) + c.build.filter((x) => x.building === b).length;
    const target = projected(building.id) + 1;
    const cost = building.cost[target];
    if (target > building.maxLevel || cost === undefined) return false;
    const met = Object.entries(building.requires).every(
      ([req, need]) =>
        (rule.requiresOn === "projected" ? projected(req) : this.level(c, req)) >= need,
    );
    return met && this.payable(id, cost);
  }

  private build(): Action | null {
    for (const id of [pick(this.rng, this.ready), pick(this.rng, this.ready)]) {
      if (id === undefined) continue;
      const b = pick(
        this.rng,
        this.rules.buildings.filter((x) => this.buildable(id, x)),
      );
      if (b !== undefined) return { type: "build", city: id, building: b.id };
    }
    return null;
  }

  /**
   * The largest count of `unit` that `id` can recruit now (requirements, queue, batch size, stock,
   * storage and population), 0 when none.
   */
  private recruitable(id: CityId, unit: UnitRow): number {
    const c = this.city(id);
    const queue = this.rules.queues.recruit.find((q) => q.id === unit.queue);
    if (c === undefined || queue === undefined) return 0;
    if ((c.recruit[queue.id]?.length ?? 0) >= queue.maxBatches) return 0;
    if (!Object.entries(unit.requires).every(([b, need]) => this.level(c, b) >= need)) return 0;
    const each = unitCost(this.r, id, unit.id);
    const cap = storageCap(this.r, id);
    let max = Math.min(unit.maxPerOrder, queue.maxCount, maxAffordable(this.r, id, each));
    if (unit.pop > 0) {
      max = Math.min(max, Math.floor((popCap(this.r, id) - popUsed(this.r, id)) / unit.pop));
    }
    for (const x of RES) if (each[x] > 0) max = Math.min(max, Math.floor(cap / each[x]));
    return Math.max(0, max);
  }

  private recruit(): Action | null {
    for (const id of [pick(this.rng, this.ready), pick(this.rng, this.ready)]) {
      if (id === undefined) continue;
      const options = this.rules.units
        .map((u) => ({ unit: u.id, max: Math.min(8, this.recruitable(id, u)) }))
        .filter((o) => o.max >= 1);
      const o = pick(this.rng, options);
      if (o !== undefined) {
        return { type: "recruit", city: id, unit: o.unit, count: randInt(this.rng, 1, o.max) };
      }
    }
    return null;
  }

  private cancel(): Action | null {
    const queued = this.own.flatMap((id) => {
      const c = this.city(id);
      if (c === undefined) return [];
      const items = [...c.build, ...Object.values(c.recruit).flat()].map((x) => x.id);
      return items.map((item) => ({ city: id, item }));
    });
    const q = pick(this.rng, queued);
    return q === undefined ? null : { type: "cancel_queue", city: q.city, item: q.item };
  }

  // Diplomacy ------------------------------------------------------------------------------------

  message(to: "all" | null): Action {
    const other = pick(this.rng, this.others);
    return {
      type: "send_message",
      to: to === "all" || other === undefined ? "all" : [other],
      text: `hello from ${this.seat} at ${this.r.now}`,
    };
  }

  /** A proposal the engine accepts: a living non-ally, no duplicate, within the open limit. */
  private propose(): Action | null {
    const d = this.rules.diplomacy;
    const mine = Object.values(this.st.proposals).filter((p) => p.from === this.seat);
    if (mine.length >= d.maxOpenProposals) return null;
    const free = (to: PlayerId, kind: "pact" | "alliance"): boolean =>
      relation(this.r, this.seat, to) !== "ally" &&
      !mine.some((p) => p.to === to && p.kind === kind);
    const partners = relationsOf(this.r, this.seat)
      .filter((x) => x.kind === "pact" && free(x.player, "alliance"))
      .map((x) => x.player);
    const partner = pick(this.rng, partners);
    const allied = this.st.players[this.seat]?.alliance !== null;
    if (partner !== undefined && percent(this.rng, 75)) {
      const name = allied ? null : `Bloc ${this.seat}`;
      return { type: "propose", to: partner, kind: "alliance", name, text: "", until: null };
    }
    const kind = percent(this.rng, 70) ? "pact" : "alliance";
    const to = pick(
      this.rng,
      this.others.filter((p) => free(p, kind)),
    );
    if (to === undefined) return null;
    const name = kind === "alliance" && !allied ? `League ${this.seat}` : null;
    return { type: "propose", to, kind, name, text: "deal", until: null };
  }

  private incoming(): ProposalId[] {
    return sortedIds(this.st.proposals).filter((q) => this.st.proposals[q]?.to === this.seat);
  }

  /** Whether accepting proposal `q` passes the checks made at acceptance (§11.3, §11.4). */
  private acceptable(q: ProposalId): boolean {
    const p = this.st.proposals[q];
    if (p === undefined || relation(this.r, p.to, p.from) === "ally") return false;
    const d = this.rules.diplomacy;
    if (p.kind === "pact") {
      if (p.until !== null && p.until <= this.r.now) return false;
      if (relation(this.r, p.to, p.from) === "pact") return true;
      return [p.to, p.from].every(
        (who) => relationsOf(this.r, who).filter((x) => x.kind === "pact").length < d.maxPacts,
      );
    }
    const allianceOf = (who: PlayerId) => {
      const a = this.st.players[who]?.alliance ?? null;
      return a === null ? undefined : this.st.alliances[a];
    };
    const mine = allianceOf(p.to);
    const theirs = allianceOf(p.from);
    if (mine !== undefined && theirs !== undefined) return false;
    const host = mine ?? theirs;
    return host === undefined ? d.allianceMax >= 2 : host.members.length < d.allianceMax;
  }

  /** An answer to an open proposal to the seat: accepted when it can be (mostly), else declined. */
  private answer(): Action | null {
    const q = pick(this.rng, this.incoming());
    if (q === undefined) return null;
    const accept = this.acceptable(q) && percent(this.rng, 85);
    return { type: "answer", proposal: q, accept };
  }

  /** What the seat can leave: a pact (its partner) or its alliance (`null`, or an ally). */
  private leaveOptions(): { with: PlayerId | null }[] {
    const rel = relationsOf(this.r, this.seat);
    const out: { with: PlayerId | null }[] = rel
      .filter((x) => x.kind === "pact")
      .map((x) => ({ with: x.player }));
    if (this.st.players[this.seat]?.alliance !== null) {
      out.push({ with: null });
      const ally = rel.find((x) => x.kind === "ally");
      if (ally !== undefined) out.push({ with: ally.player });
    }
    return out;
  }

  private writeTools(): string[] {
    return (this.r.ruleset.tools ?? []).filter((t) => t.kind !== "read").map((t) => t.name);
  }

  /** A ruleset write tool on an own city (sandbox-1's `rename_city`). */
  private ext(): Action | null {
    const tool = pick(this.rng, this.writeTools());
    const city = pick(this.rng, this.own);
    if (tool === undefined || city === undefined) return null;
    return { type: "ext", tool, args: { city, name: `Fort ${randInt(this.rng, 1, 99)}` } };
  }

  // Near misses ----------------------------------------------------------------------------------

  /** A resolved action pushed just past one rule of the current state (meant to be rejected). */
  private edge(): Action | null {
    const cases: readonly (() => Action | null)[] = [
      () => this.overRecruit(),
      () => this.overBuild(),
      () => this.uncarried(),
      () => this.overUnits(),
      () => this.overCargo(),
      () => this.overSpy(),
      () => this.lateAnswer(),
      () => this.overPropose(),
      () => this.lateRecall(),
      () => this.unnamedGroup(),
      () => this.fullIsland(),
      () => this.besiegedOrigin(),
      () => this.foreignSiege(),
    ];
    for (let i = 0; i < 6; i += 1) {
      const a = pick(this.rng, cases)?.() ?? null;
      if (a !== null) return a;
    }
    return null;
  }

  /** One more unit than the city can recruit now (or one, when it can recruit none). */
  private overRecruit(): Action | null {
    const id = pick(this.rng, this.ready);
    const u = pick(this.rng, this.rules.units);
    if (id === undefined || u === undefined) return null;
    return { type: "recruit", city: id, unit: u.id, count: this.recruitable(id, u) + 1 };
  }

  /** A building that cannot be queued now (requirement, cost, storage, queue or max level). */
  private overBuild(): Action | null {
    const id = pick(this.rng, this.ready);
    if (id === undefined) return null;
    const b = pick(
      this.rng,
      this.rules.buildings.filter((x) => !this.buildable(id, x)),
    );
    return b === undefined ? null : { type: "build", city: id, building: b.id };
  }

  /** Every land unit at home sent across water without a carrier (the transport rule). */
  private uncarried(): Action | null {
    if (!this.rules.movement.transportRule) return null;
    const from = pick(this.rng, this.ready);
    if (from === undefined) return null;
    const home = unitsAtHome(this.r, from);
    const units: UnitCounts = {};
    for (const u of this.rules.units) {
      const n = home[u.id] ?? 0;
      if (u.domain === "land" && u.id !== this.rules.roles.settler && n > 0) units[u.id] = n;
    }
    if (this.landPop(units) === 0) return null;
    const island = this.city(from)?.island;
    const away = this.attackTargets().filter((c) => this.city(c)?.island !== island);
    const to = pick(this.rng, away);
    if (to === undefined) return null;
    return this.r.now >= this.rules.time.attackFrom
      ? { type: "attack", from, to, units }
      : { type: "support", from, to, units };
  }

  /** One unit more than the city has at home. */
  private overUnits(): Action | null {
    const from = pick(this.rng, this.ready);
    const to = pick(this.rng, this.attackTargets());
    const u = pick(this.rng, this.rules.units);
    if (from === undefined || to === undefined || u === undefined) return null;
    const units = { [u.id]: (unitsAtHome(this.r, from)[u.id] ?? 0) + 1 };
    return percent(this.rng, 50)
      ? { type: "support", from, to, units }
      : { type: "attack", from, to, units };
  }

  /** Cargo over the in-flight cap, or over the stock. */
  private overCargo(): Action | null {
    const from = pick(this.rng, this.ready);
    const c = from === undefined ? undefined : this.city(from);
    const to = pick(
      this.rng,
      this.cities.filter((x) => x !== from && this.city(x)?.owner !== null),
    );
    if (from === undefined || c === undefined || to === undefined) return null;
    const stock = stockAt(this.r, from);
    const rule = this.rules.movement.shipment;
    const room =
      rule === null
        ? null
        : rule.base + rule.perLevel * this.level(c, rule.building) - inFlightCargo(this.r, from);
    if (
      room !== null &&
      room + 1 <= stock.wood + stock.stone + stock.gold &&
      percent(this.rng, 60)
    ) {
      let left = room + 1;
      const res: Res = { wood: 0, stone: 0, gold: 0 };
      for (const id of RES) {
        res[id] = Math.min(stock[id], left);
        left -= res[id];
      }
      return { type: "send_resources", from, to, res };
    }
    return { type: "send_resources", from, to, res: { wood: stock.wood + 1, stone: 0, gold: 0 } };
  }

  /** A spy paid with more gold than in stock, or less than the minimum. */
  private overSpy(): Action | null {
    const from = pick(this.rng, this.ready);
    const to = pick(this.rng, this.foreign);
    if (from === undefined || to === undefined) return null;
    const min = this.rules.movement.spyMinGold;
    const gold = min > 0 && percent(this.rng, 40) ? min - 1 : stockAt(this.r, from).gold + 1;
    return { type: "spy", from, to, gold };
  }

  /** Accepting a proposal to the seat that the acceptance checks refuse (pact limit, full alliance…). */
  private lateAnswer(): Action | null {
    const q = pick(
      this.rng,
      this.incoming().filter((x) => !this.acceptable(x)),
    );
    return q === undefined ? null : { type: "answer", proposal: q, accept: true };
  }

  /** A second open proposal to the same player of the same kind, or one to an ally. */
  private overPropose(): Action | null {
    const open = Object.values(this.st.proposals).filter((p) => p.from === this.seat);
    const same = pick(this.rng, open);
    if (same !== undefined && percent(this.rng, 60)) {
      const name = same.kind === "alliance" ? `Again ${this.seat}` : null;
      return { type: "propose", to: same.to, kind: same.kind, name, text: "", until: null };
    }
    const ally = pick(
      this.rng,
      relationsOf(this.r, this.seat).filter((x) => x.kind === "ally"),
    );
    if (ally === undefined) return null;
    return { type: "propose", to: ally.player, kind: "pact", name: null, text: "", until: null };
  }

  /** A recall of an own movement that is not (or no longer) recallable. */
  private lateRecall(): Action | null {
    const ok = new Set(this.recallable());
    const m = pick(
      this.rng,
      sortedIds(this.st.movements).filter(
        (id) => this.st.movements[id]?.owner === this.seat && !ok.has(id),
      ),
    );
    return m === undefined ? null : { type: "recall", movement: m };
  }

  /** A partial recall naming no home where the seat has groups from several homes. */
  private unnamedGroup(): Action | null {
    const at = this.holding().find((x) => x.homes.length > 1);
    const home = at?.homes[0];
    const unit =
      at === undefined || home === undefined ? undefined : Object.keys(at.units[home] ?? {})[0];
    if (at === undefined || unit === undefined) {
      const empty = pick(
        this.rng,
        this.cities.filter((c) => !this.holding().some((x) => x.c === c)),
      );
      return empty === undefined
        ? null
        : { type: "recall_stationed", at: empty, home: null, units: null };
    }
    return { type: "recall_stationed", at: at.c, home: null, units: { [unit]: 1 } };
  }

  /** A foundation on an island with no free slot. */
  private fullIsland(): Action | null {
    const settler = this.rules.roles.settler;
    const from = pick(
      this.rng,
      this.ready.filter((c) => (unitsAtHome(this.r, c)[settler] ?? 0) > 0),
    );
    const island = pick(
      this.rng,
      sortedIds(this.st.islands).filter((i) => freeSlots(this.r, i).length === 0),
    );
    if (from === undefined || island === undefined) return null;
    const units = this.carried(from, island, { [settler]: 1 }, unitsAtHome(this.r, from));
    return (units[settler] ?? 0) < 1
      ? null
      : { type: "found_city", from, island, units, slot: null };
  }

  /** A build in, or a departure from, an own city a siege holds. */
  private besiegedOrigin(): Action | null {
    const id = pick(
      this.rng,
      this.own.filter((c) => this.heldBy(c) !== null),
    );
    const b = pick(this.rng, this.rules.buildings);
    const to = pick(this.rng, this.foreign);
    if (id === undefined || b === undefined) return null;
    if (to === undefined || percent(this.rng, 50))
      return { type: "build", city: id, building: b.id };
    return { type: "spy", from: id, to, gold: this.rules.movement.spyMinGold };
  }

  /** A support to a city another player besieges. */
  private foreignSiege(): Action | null {
    const to = pick(
      this.rng,
      this.cities.filter((c) => {
        const by = this.heldBy(c);
        return by !== null && by !== this.seat;
      }),
    );
    const settler = this.rules.roles.settler;
    const from = pick(
      this.rng,
      this.ready.filter((c) => c !== to),
    );
    const target = to === undefined ? undefined : this.city(to);
    if (from === undefined || to === undefined || target === undefined) return null;
    const home = unitsAtHome(this.r, from);
    const wanted = this.partOf(home, false);
    delete wanted[settler];
    const units = this.carried(from, target.island, wanted, home);
    return Object.keys(units).length === 0 ? null : { type: "support", from, to, units };
  }

  /** Schema-valid actions the engine rejects, each through another validation path. */
  junk(): Action {
    const from = pick(this.rng, this.own) ?? "c999";
    const to = pick(this.rng, this.foreign) ?? "c999";
    const junk: Action[] = [
      { type: "build", city: "c999", building: "nothing" },
      { type: "attack", from, to: from, units: {} },
      { type: "support", from: to, to: from, units: { nothing: 1 } },
      { type: "recall", movement: "m00000" },
      { type: "answer", proposal: "q00000", accept: true },
      { type: "found_city", from, island: "i999", units: {}, slot: 3 },
      { type: "recruit", city: to, unit: "nothing", count: 1 },
      { type: "ext", tool: "conquer_world", args: {} },
      { type: "dismiss", city: to, player: this.seat },
      { type: "propose", to: this.seat, kind: "pact", name: null, text: "", until: 5 },
      { type: "spy", from, to, gold: 0 },
      { type: "cancel_queue", city: from, item: 999 },
    ];
    return pick(this.rng, junk) ?? { type: "recall", movement: "m00000" };
  }
}
