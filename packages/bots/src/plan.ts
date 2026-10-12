// The planner shared by every strategy: a ledger of what this turn's earlier calls already spent
// (resources, units at home, pop, queue room, daily caps), and the generic moves every bot makes
// (economy, settling, unit surplus, own-city support, proposal answers). Strategies compose these
// moves and add their own (docs/architecture.md §11.2). Everything is integer and deterministic.

import {
  compareIds,
  RECRUIT_MAX_ORDERS,
  type BuildingId,
  type CityId,
  type CityView,
  type IslandId,
  type MovementId,
  type PlayerId,
  type QueueId,
  type Res,
  type ToolCall,
  type UnitCounts,
  type UnitId,
} from "@perfidia/protocol";
import {
  addRes,
  call,
  capacity,
  cleanUnits,
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
  ZERO,
  type Kit,
} from "./kit.ts";
import { handledId, isCount, isFlagName, memoLine, type Memory } from "./memory.ts";
import { freeSlots, type OtherCity, type OwnCity, type World } from "./world.ts";

/** "Raise `building` to `level`" (a projected level: completed plus queued). */
export interface Wish {
  readonly building: BuildingId;
  readonly level: number;
}

/** Unit weights of a recruitment mix, by role. */
export interface Mix {
  readonly defender: number;
  readonly attacker: number;
  readonly navy: number;
}

/** A strategy's tuning: every value is drawn per (match seed, seat) and stays fixed for the match. */
export interface Knobs {
  /** Wanted delay between own turns, in game seconds. */
  readonly cadence: number;
  /** Founds cities. */
  readonly settle: boolean;
  /** Stops settling at this many cities (foundings in flight included). */
  readonly maxCities: number;
  /** Producer target level: `producerBase + producerPerDay × day`. */
  readonly producerBase: number;
  readonly producerPerDay: number;
  /** Wall target level `wallBase + wallPerDay × day` when the ruleset has a wall (0, 0: none). */
  readonly wallBase: number;
  readonly wallPerDay: number;
  /** Share (‰) of the resources left after builds that goes to units. */
  readonly spendPm: number;
  readonly mix: Mix;
  /** Keeps enough carriers to ship its attackers across water. */
  readonly carriers: boolean;
  /** Sends defenders from its other cities to an own city under attack. */
  readonly supportOwn: boolean;
  /** Defenders sent with a founder. */
  readonly escort: number;
  /** Builds its attackers' recruit building before the economy. */
  readonly militaryFirst: boolean;
  /**
   * Packs of the unit mix below which the surplus is kept for the next turn (default
   * `MIN_PACKS`): fewer, larger batches empty their queue, and wake the seat, less often.
   */
  readonly minPacks?: number;
}

export interface BuildPlan {
  readonly items: readonly BuildingId[];
  /** The total cost of `items`. */
  readonly spent: Res;
  /** The cost being saved for (an unaffordable wish within the horizon), or null. */
  readonly saving: Res | null;
}

/**
 * Picks build items for one city, wish by wish in priority order. Requirements are queued first
 * when the ruleset checks them on projected levels; with completed levels the requirement is queued
 * and the wish waits. A wish that is unaffordable but affordable within `horizon` seconds stops the
 * plan (the city saves for it); one that is further away is skipped for cheaper wishes.
 */
export function planBuilds(
  kit: Kit,
  completed: Readonly<Record<BuildingId, number>>,
  queued: readonly BuildingId[],
  wishes: readonly Wish[],
  budget: Res,
  rate: Res,
  cap: number,
  room: number,
  horizon: number,
): BuildPlan {
  const projected: Record<BuildingId, number> = { ...completed };
  for (const b of queued) projected[b] = (projected[b] ?? 0) + 1;
  const reqLevels = kit.rules.queues.build.requiresOn === "projected" ? projected : completed;
  const items: BuildingId[] = [];
  let spent: Res = ZERO;
  let left = budget;
  let roomLeft = room;
  let saving: Res | null = null;

  const reach = (building: BuildingId, level: number, depth: number): "ok" | "skip" | "stop" => {
    const row = kit.buildings.get(building);
    if (row === undefined || depth > 6) return "skip";
    const goal = Math.min(level, row.maxLevel);
    while ((projected[building] ?? 0) < goal) {
      if (roomLeft <= 0) return "stop";
      for (const [req, need] of Object.entries(row.requires)) {
        if ((reqLevels[req] ?? 0) >= need) continue;
        const r = reach(req, need, depth + 1);
        if (r !== "ok" || (reqLevels[req] ?? 0) < need) return r === "stop" ? "stop" : "skip";
      }
      // Requirements may have used the last free places of the queue.
      if (roomLeft <= 0) return "stop";
      const target = (projected[building] ?? 0) + 1;
      const cost = row.cost[target];
      if (cost === undefined) return "skip";
      if (!covers(left, cost)) {
        const eta = etaAfford(left, rate, cost, cap);
        if (eta !== null && eta <= horizon) {
          saving = cost;
          return "stop";
        }
        return "skip";
      }
      items.push(building);
      spent = addRes(spent, cost);
      left = subRes(left, cost);
      projected[building] = target;
      roomLeft -= 1;
    }
    return "ok";
  };

  for (const wish of wishes) {
    if (reach(wish.building, wish.level, 0) === "stop") break;
  }
  return { items, spent, saving };
}

/** Projected levels of a city: completed (from `view_city`) plus queued build items. */
export function projectedLevels(c: OwnCity): Record<BuildingId, number> {
  const out: Record<BuildingId, number> = { ...c.levels };
  for (const b of c.build) out[b.building] = (out[b.building] ?? 0) + 1;
  return out;
}

/** Wishes that unlock `unit`: its requirements, and its recruit queue's building at level 1. */
export function unlockWishes(kit: Kit, unit: UnitId | null): Wish[] {
  if (unit === null) return [];
  const row = kit.units.get(unit);
  if (row === undefined) return [];
  const out: Wish[] = Object.entries(row.requires).map(([building, level]) => ({
    building,
    level,
  }));
  const q = kit.queues.get(row.queue);
  if (q !== undefined && row.requires[q.building] === undefined) {
    out.push({ building: q.building, level: 1 });
  }
  return out;
}

/** The generic economy wishes of a city, in priority order. */
export function economyWishes(p: Planner, c: OwnCity, extra: readonly Wish[]): Wish[] {
  const { w, k } = p;
  const kit = w.kit;
  const lv = projectedLevels(c);
  const at = (b: BuildingId): number => lv[b] ?? 0;
  const max = (b: BuildingId): number => kit.buildings.get(b)?.maxLevel ?? 0;
  const out: Wish[] = [];
  if (largest(c.res) * 10 >= c.cap * 8)
    out.push({ building: kit.storage, level: at(kit.storage) + 1 });
  if ((c.popCap - c.popUsed) * 4 < c.popCap) {
    out.push({ building: kit.population, level: at(kit.population) + 1 });
  }
  out.push(...extra);
  // Attackers come with the carriers that ship them, when the strategy sends them across water:
  // every other player's city may be on another island, so waiting for a founding to need the
  // carriers' building could mean never getting it.
  const military = (): Wish[] => {
    const wishes = unlockWishes(kit, kit.roles.attacker);
    if (k.carriers && kit.rules.movement.transportRule) {
      wishes.push(...unlockWishes(kit, kit.roles.carrier));
    }
    return wishes;
  };
  if (k.militaryFirst) out.push(...military());

  // Producers, balanced: the lowest projected level first (resource order breaks ties).
  const producers = [...new Set(Object.values(kit.producers))];
  const target = (b: BuildingId): number =>
    Math.min(max(b), k.producerBase + k.producerPerDay * w.day);
  const sim: Record<BuildingId, number> = {};
  for (const b of producers) sim[b] = at(b);
  for (let step = 0; step < 6; step += 1) {
    let pick: BuildingId | null = null;
    for (const b of producers) {
      if ((sim[b] ?? 0) >= target(b)) continue;
      if (pick === null || (sim[b] ?? 0) < (sim[pick] ?? 0)) pick = b;
    }
    if (pick === null) break;
    const level = (sim[pick] ?? 0) + 1;
    sim[pick] = level;
    out.push({ building: pick, level });
  }

  if (k.mix.defender > 0) out.push(...unlockWishes(kit, kit.roles.defender));
  if (k.mix.attacker > 0) out.push(...military());
  out.push({ building: kit.population, level: Math.min(max(kit.population), 3 + w.day) });
  out.push({ building: kit.storage, level: Math.min(max(kit.storage), 2 + w.day) });
  if (kit.wall !== null && k.wallPerDay > 0) {
    out.push({
      building: kit.wall,
      level: Math.min(max(kit.wall), k.wallBase + k.wallPerDay * w.day),
    });
  }
  return out;
}

/**
 * The latest intel about a city, as an estimated land defense (null: nothing usable is known).
 *
 * A spy report is a snapshot of the units present, so its unit counts are added up. A battle report
 * is ruleset-shaped (perfidia-1 §8.10 lists both sides, per phase, before / lost / survived), so
 * adding up its counts would mix the attacker's stacks with the defender's and count each several
 * times: the only battle report read is the seat's own won attack (the defenders are gone); any
 * other one is "unknown", and the caller spies for a fresh snapshot instead.
 */
export function estimateDefense(w: World, view: CityView | undefined): number | null {
  if (view === undefined) return null;
  const kit = w.kit;
  if (view.access === "full") {
    let d = power(kit, view.units, "defense", true);
    for (const s of view.stationed) d += power(kit, s.units, "defense", true);
    return d;
  }
  if (view.intel === null) return null;
  const data = view.intel.data;
  if (view.intel.type === "battle_report") {
    return data["winner"] === "attacker" && data["attacker"] === w.seat ? 0 : null;
  }
  return power(kit, unitsInReport(kit, data), "defense", true);
}

/** Age in seconds of the intel a view carries, or null when there is none (full views: 0). */
export function intelAge(w: World, view: CityView | undefined): number | null {
  if (view === undefined) return null;
  if (view.access === "full") return 0;
  return view.intel === null ? null : Math.max(0, w.t - view.intel.at[0]);
}

/** The own city with the most land attack at home (ties: lowest id). */
export function mainCity(w: World): OwnCity | null {
  let best: OwnCity | null = null;
  let bestA = -1;
  for (const c of w.cities) {
    if (c.blocked) continue;
    const a = power(w.kit, c.units, "attack", true);
    if (a > bestA) {
      best = c;
      bestA = a;
    }
  }
  return best;
}

/** Cities of other owners that pass `keep`, nearest to `from` first (travel known only). */
export function nearby(w: World, from: OwnCity, keep: (o: OtherCity) => boolean): OtherCity[] {
  return w.others
    .filter(keep)
    .map((o) => ({ o, travel: w.travel(from.id, o.island, false) }))
    .filter((x): x is { o: OtherCity; travel: number } => x.travel !== null)
    .toSorted((a, b) => a.travel - b.travel || compareIds(a.o.id, b.o.id))
    .map((x) => x.o);
}

export class Planner {
  readonly w: World;
  readonly k: Knobs;
  readonly calls: ToolCall[] = [];
  readonly summary: string[] = [];
  /** The estimated arrival of each `found_city` call planned this turn. */
  readonly foundEtas = new Map<ToolCall, number>();
  /**
   * Times this turn's plan must be awake at (a timed launch, an army coming home), whatever the
   * cadence and the wake budget spread (`wakeAt`, `chooseWake`'s `firm`).
   */
  readonly wakes: number[] = [];
  memory: Memory;
  /** Foundings in flight when the turn began (arrivals still ahead), before this turn's own. */
  readonly startFoundings: Readonly<Record<string, readonly number[]>>;
  attacksLeft: number;
  messagesLeft: number;
  private readonly stock = new Map<CityId, Res>();
  private readonly home = new Map<CityId, Record<UnitId, number>>();
  private readonly popFree = new Map<CityId, number>();
  private readonly buildRoom = new Map<CityId, number>();
  private readonly batchRoom = new Map<CityId, Map<QueueId, number>>();
  private readonly reserved = new Map<CityId, Res>();
  private readonly saving = new Map<CityId, Res>();
  private readonly extra = new Map<CityId, Wish[]>();
  /** Units ordered this turn, by city (explicit counts only). */
  private readonly planned = new Map<CityId, Record<UnitId, number>>();

  constructor(w: World, k: Knobs) {
    this.w = w;
    this.k = k;
    const f: Record<string, number[]> = {};
    for (const [island, etas] of Object.entries(w.memory.f)) {
      const ahead = etas.filter((at) => at >= w.t);
      if (ahead.length > 0) f[island] = ahead;
    }
    this.startFoundings = f;
    this.memory = { ...w.memory, f };
    this.attacksLeft = w.briefing.budget.attacksLeft;
    this.messagesLeft = w.briefing.budget.messagesLeft;
    for (const c of w.cities) {
      this.stock.set(c.id, c.res);
      this.home.set(c.id, { ...c.units });
      this.popFree.set(c.id, Math.max(0, c.popCap - c.popUsed));
      this.buildRoom.set(c.id, Math.max(0, w.kit.rules.queues.build.max - c.build.length));
      const rooms = new Map<QueueId, number>();
      for (const q of w.kit.rules.queues.recruit) {
        rooms.set(q.id, Math.max(0, q.maxBatches - (c.recruit[q.id]?.length ?? 0)));
      }
      this.batchRoom.set(c.id, rooms);
    }
  }

  // Ledger.

  city(id: CityId): OwnCity | undefined {
    return this.w.cities.find((c) => c.id === id);
  }
  stockOf(id: CityId): Res {
    return this.stock.get(id) ?? ZERO;
  }
  homeOf(id: CityId): Readonly<Record<UnitId, number>> {
    return this.home.get(id) ?? {};
  }
  private spend(id: CityId, cost: Res): void {
    this.stock.set(id, subRes(this.stockOf(id), cost));
  }
  private take(id: CityId, units: UnitCounts): void {
    const h = { ...this.homeOf(id) };
    for (const [u, n] of Object.entries(units)) h[u] = Math.max(0, (h[u] ?? 0) - n);
    this.home.set(id, h);
  }
  /** Spendable resources of a city: stock minus what a founder or a build is waiting for. */
  budgetOf(id: CityId): Res {
    return subRes(
      subRes(this.stockOf(id), this.reserved.get(id) ?? ZERO),
      this.saving.get(id) ?? ZERO,
    );
  }
  reserve(id: CityId, cost: Res): void {
    this.reserved.set(id, cost);
  }
  wish(id: CityId, ...wishes: Wish[]): void {
    this.extra.set(id, [...(this.extra.get(id) ?? []), ...wishes]);
  }
  // Memory writers keep every entry within the notebook format (memory.ts), so one bad value can
  // never make the notebook unreadable: long ids and lines are cut, an invalid flag is not stored.
  handled(id: string): boolean {
    return this.memory.k.includes(handledId(id));
  }
  markHandled(id: string): void {
    const key = handledId(id);
    if (!this.memory.k.includes(key)) this.memory = { ...this.memory, k: [...this.memory.k, key] };
  }
  flag(name: string): number | null {
    return this.memory.x[name] ?? null;
  }
  /** Stores a flag; returns false (and stores nothing) when the name or value is not storable. */
  setFlag(name: string, value: number): boolean {
    if (!isFlagName(name) || !isCount(value)) return false;
    this.memory = { ...this.memory, x: { ...this.memory.x, [name]: value } };
    return true;
  }
  memo(line: string): void {
    const text = memoLine(line);
    if (!this.memory.m.includes(text))
      this.memory = { ...this.memory, m: [...this.memory.m, text] };
  }
  /**
   * Asks to be awake at `t` (a firm self-wake, `chooseWake`): the earliest such time ahead wins over
   * the cadence and the wake budget spread. Times not ahead of the world's time are ignored.
   */
  wakeAt(t: number): void {
    if (Number.isSafeInteger(t) && t > this.w.t) this.wakes.push(t);
  }
  private push(c: ToolCall, note: string): void {
    this.calls.push(c);
    this.summary.push(note);
  }

  /** Units of `unit` in a city's recruit queues, the orders planned this turn included. */
  queued(c: OwnCity, unit: UnitId): number {
    return queuedOf(c, unit) + (this.planned.get(c.id)?.[unit] ?? 0);
  }

  /** True when `unit` can be queued in the city: requirements on completed levels and a free batch. */
  canRecruit(c: OwnCity, unit: UnitId | null): boolean {
    if (unit === null || c.levels === null || c.blocked) return false;
    const row = this.w.kit.units.get(unit);
    if (row === undefined || !meets(row.requires, c.levels)) return false;
    return (this.batchRoom.get(c.id)?.get(row.queue) ?? 0) > 0;
  }

  /**
   * `land` plus the carriers it needs to cross water from `c` to `island` (transport rule), or
   * null when the carriers at home cannot hold it.
   */
  withCarriers(c: OwnCity, island: IslandId, land: UnitCounts): UnitCounts | null {
    const kit = this.w.kit;
    if (c.island === island || !kit.rules.movement.transportRule) return cleanUnits(kit, land);
    const need = landPop(kit, land);
    if (need === 0) return cleanUnits(kit, land);
    const carrier = kit.roles.carrier;
    const cap = carrier === null ? 0 : (kit.units.get(carrier)?.capacity ?? 0);
    if (carrier === null || cap <= 0) return null;
    const n = Math.ceil(need / cap);
    if ((this.homeOf(c.id)[carrier] ?? 0) < n) return null;
    return cleanUnits(kit, { ...land, [carrier]: (land[carrier] ?? 0) + n });
  }

  /** The land pop the carriers at home in `c` can hold. */
  carrierLift(c: OwnCity): number {
    return capacity(this.w.kit, this.homeOf(c.id));
  }

  /** The most land pop `c` can move to `island` (unbounded on its own island or without the transport rule). */
  liftCapacity(c: OwnCity, island: IslandId): number {
    if (c.island === island || !this.w.kit.rules.movement.transportRule) return 1_000_000;
    return this.carrierLift(c);
  }

  // Calls.

  build(c: OwnCity, items: readonly BuildingId[]): void {
    if (items.length === 0) return;
    this.push(
      call("build", { city: c.id, buildings: [...items] }),
      `build ${c.id} ${items.join(",")}`,
    );
    this.buildRoom.set(c.id, Math.max(0, (this.buildRoom.get(c.id) ?? 0) - items.length));
  }

  /**
   * Queues recruit orders in one call. Costs come from the unit table unless `paid` gives the real
   * total (a founder's cost scales with k); a `"max"` order uses up the city's stock and pop.
   */
  recruit(
    c: OwnCity,
    orders: readonly { unit: UnitId; count: number | "max" }[],
    paid: Res | null = null,
  ): void {
    if (orders.length === 0) return;
    const kit = this.w.kit;
    const rooms = this.batchRoom.get(c.id);
    for (const o of orders) {
      const row = kit.units.get(o.unit);
      if (row === undefined) continue;
      rooms?.set(row.queue, Math.max(0, (rooms.get(row.queue) ?? 0) - 1));
      if (o.count !== "max") {
        const p = { ...this.planned.get(c.id) };
        p[o.unit] = (p[o.unit] ?? 0) + o.count;
        this.planned.set(c.id, p);
        if (paid === null) this.spend(c.id, scaleRes(row.cost, o.count));
        this.popFree.set(c.id, Math.max(0, (this.popFree.get(c.id) ?? 0) - row.pop * o.count));
      } else {
        this.stock.set(c.id, ZERO);
        this.popFree.set(c.id, 0);
      }
    }
    if (paid !== null) this.spend(c.id, paid);
    const what = orders.map((o) => `${o.count} ${o.unit}`).join(",");
    this.push(
      call("recruit", { city: c.id, orders: orders.map((o) => ({ ...o })) }),
      `recruit ${c.id} ${what}`,
    );
  }

  cancel(c: OwnCity, item: number): void {
    this.push(call("cancel_queue", { city: c.id, item }), `cancel ${c.id} #${item}`);
  }

  found(c: OwnCity, island: IslandId, units: UnitCounts, slot: number | null, eta: number): void {
    const args =
      slot !== null && this.w.kit.rules.toolOptions.foundSlot
        ? { from: c.id, island, units, slot }
        : { from: c.id, island, units };
    const founding = call("found_city", args);
    this.push(founding, `found ${island} from ${c.id}`);
    this.foundEtas.set(founding, eta);
    this.take(c.id, units);
    const etas = [...(this.memory.f[island] ?? []), eta].toSorted((a, b) => a - b);
    this.memory = { ...this.memory, f: { ...this.memory.f, [island]: etas } };
  }

  attack(c: OwnCity, to: CityId, units: UnitCounts): boolean {
    if (this.attacksLeft <= 0 || this.w.t < this.w.kit.rules.time.attackFrom) return false;
    this.push(call("attack", { from: c.id, to, units }), `attack ${to} from ${c.id}`);
    this.take(c.id, units);
    this.attacksLeft -= 1;
    return true;
  }

  support(c: OwnCity, to: CityId, units: UnitCounts): void {
    this.push(call("support", { from: c.id, to, units }), `support ${to} from ${c.id}`);
    this.take(c.id, units);
  }

  spy(c: OwnCity, to: CityId, gold: number): void {
    this.push(call("spy", { from: c.id, to, gold }), `spy ${to}`);
    this.spend(c.id, res(0, 0, gold));
  }

  ship(c: OwnCity, to: CityId, cargo: Res): void {
    this.push(call("send_resources", { from: c.id, to, ...cargo }), `ship ${to}`);
    this.spend(c.id, cargo);
  }

  recall(movement: MovementId): void {
    this.push(call("recall_troops", { movement }), `recall ${movement}`);
  }

  /** Recalls every group of the seat stationed in `city` (supports, or a siege garrison). */
  recallStationed(city: CityId): void {
    this.push(call("recall_troops", { stationedAt: city }), `recall from ${city}`);
  }

  message(to: readonly PlayerId[], text: string): boolean {
    if (this.messagesLeft <= 0 || to.length === 0) return false;
    const max = this.w.kit.rules.diplomacy.messageMaxChars;
    this.push(
      call("send_message", { to: [...to], text: text.slice(0, max) }),
      `message ${to.join(",")}`,
    );
    this.messagesLeft -= 1;
    return true;
  }

  propose(to: PlayerId, kind: "alliance" | "pact", text: string, name: string | null): void {
    const d = this.w.kit.rules.diplomacy;
    const args =
      name !== null && kind === "alliance"
        ? {
            to,
            kind,
            text: text.slice(0, d.proposalTextMaxChars),
            name: name.slice(0, d.allianceNameMaxChars),
          }
        : { to, kind, text: text.slice(0, d.proposalTextMaxChars) };
    this.push(call("propose_alliance", args), `propose ${kind} ${to}`);
  }

  answer(
    decide: (p: { id: string; from: PlayerId; kind: "alliance" | "pact" }) => boolean | null,
  ): void {
    for (const p of this.w.briefing.proposals) {
      if (p.to !== this.w.seat || this.handled(p.id)) continue;
      const accept = decide({ id: p.id, from: p.from, kind: p.kind });
      if (accept === null) continue;
      this.push(
        call("answer_proposal", { id: p.id, accept }),
        `answer ${p.id} ${accept ? "yes" : "no"}`,
      );
      this.markHandled(p.id);
    }
  }

  // Generic moves.

  /** Sends defenders from another own city to an own city under attack, when they land in time. */
  supportThreatened(): void {
    const { w } = this;
    const defender = w.kit.roles.defender;
    if (!this.k.supportOwn || defender === null) return;
    for (const inc of w.briefing.incoming) {
      if (inc.kind !== "attack" || inc.arrive[0] <= w.t || this.handled(`s${inc.id}`)) continue;
      // A relief of an own besieged city fights the besieger, not the seat: nothing to defend.
      if (inc.foe !== undefined && inc.foe !== null && inc.foe !== w.seat) continue;
      const target = this.city(inc.to);
      if (target === undefined) continue;
      const helpers = w.cities
        .filter((c) => c.id !== target.id && !c.blocked)
        .map((c) => ({ c, travel: w.travel(c.id, target.island, false) }))
        .filter((h): h is { c: OwnCity; travel: number } => h.travel !== null)
        .toSorted((a, b) => a.travel - b.travel || compareIds(a.c.id, b.c.id));
      for (const { c, travel } of helpers) {
        if (w.t + travel >= inc.arrive[0]) continue;
        const have = this.homeOf(c.id)[defender] ?? 0;
        let n = Math.floor(have / 2);
        const lift = this.liftCapacity(c, target.island);
        const pop = w.kit.units.get(defender)?.pop ?? 1;
        n = Math.min(n, Math.floor(lift / Math.max(1, pop)));
        if (n <= 0) continue;
        const group = this.withCarriers(c, target.island, { [defender]: n });
        if (group === null) continue;
        this.support(c, target.id, group);
        this.markHandled(`s${inc.id}`);
        break;
      }
    }
  }

  private pendingFoundings(): number {
    let n = 0;
    for (const etas of Object.values(this.memory.f)) n += etas.length;
    return n;
  }

  private pendingOn(island: IslandId): number {
    return this.memory.f[island]?.length ?? 0;
  }

  /** The land pop of a founder and its escort, and the escort size, for a founding from `c`. */
  private founding(c: OwnCity): { pop: number; escort: number } {
    const kit = this.w.kit;
    const fpop = kit.units.get(kit.roles.founder)?.pop ?? 0;
    const defender = kit.roles.defender;
    if (defender === null) return { pop: fpop, escort: 0 };
    const dpop = kit.units.get(defender)?.pop ?? 0;
    const escort = Math.min(this.k.escort, Math.floor(countOf(this.homeOf(c.id), defender) / 2));
    return { pop: fpop + escort * dpop, escort };
  }

  /**
   * The best free slot for a founder leaving `c`: the hinted island kind for this founding first
   * (nearest first), then richness per travel second. With `lift`, islands across water need that
   * much carrier capacity at home; without it, carriers are ignored.
   */
  pickSlot(
    c: OwnCity,
    lift: number | null,
  ): { island: IslandId; slot: number; travel: number } | null {
    const { w } = this;
    if (w.map === null) return null;
    const nth = w.cities.length + this.pendingFoundings() - 1;
    const prefer = w.hints.settleOrder[nth] ?? null;
    const water = w.kit.rules.movement.transportRule;
    let best: Slot | null = null;
    for (const isl of w.map.islands) {
      const free = freeSlots(w, isl.id);
      if (free.length <= this.pendingOn(isl.id)) continue;
      const travel = w.travel(c.id, isl.id, false);
      if (travel === null || travel <= 0) continue;
      if (lift !== null && water && isl.id !== c.island && this.carrierLift(c) < lift) continue;
      const score = Math.floor((isl.richnessPm * 3600) / travel);
      const cand: Slot = { island: isl.id, slot: free[0]!, travel, kind: isl.kind, score };
      if (best === null || better(cand, best, prefer)) best = cand;
    }
    return best === null ? null : { island: best.island, slot: best.slot, travel: best.travel };
  }

  /** Founds cities with the founders at home: one per founder, each with an escort and its carriers. */
  settle(): void {
    const { w, k } = this;
    const kit = w.kit;
    const founder = kit.roles.founder;
    const defender = kit.roles.defender;
    if (!k.settle || w.map === null) return;
    for (const c of w.cities) {
      if (c.blocked) continue;
      while ((this.homeOf(c.id)[founder] ?? 0) > 0) {
        if (w.cities.length + this.pendingFoundings() >= k.maxCities) return;
        const fpop = kit.units.get(founder)?.pop ?? 0;
        const slot = this.pickSlot(c, fpop);
        if (slot === null) break;
        let { escort } = this.founding(c);
        const lift = this.liftCapacity(c, slot.island);
        const dpop = defender === null ? 0 : (kit.units.get(defender)?.pop ?? 0);
        if (dpop > 0) escort = Math.max(0, Math.min(escort, Math.floor((lift - fpop) / dpop)));
        const land: Record<string, number> = { [founder]: 1 };
        if (defender !== null && escort > 0) land[defender] = escort;
        const group = this.withCarriers(c, slot.island, land);
        if (group === null) break;
        this.found(c, slot.island, group, slot.slot, w.t + slot.travel);
      }
    }
  }

  /**
   * Keeps one founder coming while a free slot is reachable: recruits it where requirements, pop
   * and stock allow, otherwise reserves its cost (when affordable soon) or asks for the buildings
   * it needs; recruits the carriers its next founding across water will need.
   */
  founder(): void {
    const { w, k } = this;
    const kit = w.kit;
    if (!k.settle || w.map === null) return;
    if (w.cities.length + this.pendingFoundings() >= k.maxCities) return;
    const founder = kit.roles.founder;
    const row = kit.units.get(founder);
    if (row === undefined) return;
    const ready = (c: OwnCity): boolean => c.levels !== null && meets(row.requires, c.levels);
    const candidates = w.cities
      .filter((c) => !c.blocked && c.levels !== null)
      .toSorted(
        (a, b) =>
          (this.homeOf(b.id)[founder] ?? 0) - (this.homeOf(a.id)[founder] ?? 0) ||
          Number(ready(b)) - Number(ready(a)) ||
          b.res.wood + b.res.stone + b.res.gold - (a.res.wood + a.res.stone + a.res.gold) ||
          compareIds(a.id, b.id),
      );
    const c = candidates[0];
    if (c === undefined) return;
    const target = this.pickSlot(c, null);
    if (target === null) return;
    if (target.island !== c.island) this.carriersFor(c, this.founding(c).pop);

    let have = 0;
    for (const city of w.cities) {
      have += this.homeOf(city.id)[founder] ?? 0;
      have += this.queued(city, founder);
    }
    if (have > 0) return;
    const cost =
      w.self?.private?.settler.cost ??
      kit.rules.settlerCost[Math.min(w.cities.length, kit.rules.settlerCost.length - 1)] ??
      ZERO;
    if (largest(cost) > c.cap) {
      const lvl = storageLevelFor(kit, largest(cost));
      if (lvl !== null) this.wish(c.id, { building: kit.storage, level: lvl });
      return;
    }
    if (!ready(c)) {
      this.wish(c.id, ...unlockWishes(kit, founder));
      return;
    }
    if ((this.popFree.get(c.id) ?? 0) < row.pop) {
      const lv = projectedLevels(c)[kit.population] ?? 0;
      this.wish(c.id, { building: kit.population, level: lv + 1 });
      return;
    }
    if (!this.canRecruit(c, founder)) return;
    if (covers(this.stockOf(c.id), cost)) {
      this.recruit(c, [{ unit: founder, count: 1 }], cost);
      return;
    }
    const eta = etaAfford(this.stockOf(c.id), c.rate, cost, c.cap);
    if (eta !== null && eta <= 2 * k.cadence) this.reserve(c.id, cost);
  }

  /** Makes sure `c` has (or is recruiting) carriers for `pop` land pop: recruits or unlocks them. */
  private carriersFor(c: OwnCity, pop: number): void {
    const kit = this.w.kit;
    const carrier = kit.roles.carrier;
    if (carrier === null || !kit.rules.movement.transportRule || pop <= 0) return;
    const row = kit.units.get(carrier);
    if (row === undefined || row.capacity <= 0) return;
    const have = countOf(this.homeOf(c.id), carrier) + this.queued(c, carrier);
    const need = Math.ceil(pop / row.capacity) - have;
    if (need <= 0) return;
    if (c.levels === null || !meets(row.requires, c.levels)) {
      this.wish(c.id, ...unlockWishes(kit, carrier));
      return;
    }
    if (!this.canRecruit(c, carrier)) return;
    const n = Math.min(need, timesAffordable(this.stockOf(c.id), row.cost));
    if (n > 0 && (this.popFree.get(c.id) ?? 0) >= row.pop * n) {
      this.recruit(c, [{ unit: carrier, count: n }]);
    }
  }

  /** Queues build items in every city that can act, from the generic wishes plus `more`. */
  economy(more?: (c: OwnCity) => readonly Wish[]): void {
    const { w, k } = this;
    for (const c of w.cities) {
      if (c.blocked || c.levels === null) continue;
      const extra = [...(this.extra.get(c.id) ?? []), ...(more?.(c) ?? [])];
      const wishes = economyWishes(this, c, extra);
      const plan = planBuilds(
        w.kit,
        c.levels,
        c.build.map((b) => b.building),
        wishes,
        subRes(this.stockOf(c.id), this.reserved.get(c.id) ?? ZERO),
        c.rate,
        c.cap,
        this.buildRoom.get(c.id) ?? 0,
        k.cadence,
      );
      if (plan.items.length > 0) {
        this.build(c, plan.items);
        this.spend(c.id, plan.spent);
      }
      if (plan.saving !== null) this.saving.set(c.id, plan.saving);
    }
  }

  /**
   * `economy` with the strategy's own wishes: in a city where `own(c)` returns a list, that list
   * (after the wishes the planner's moves added, such as a founder's unlock) replaces the generic
   * economy wishes; where it returns null, the generic ones apply as in `economy`.
   */
  economyWith(own: (c: OwnCity) => readonly Wish[] | null): void {
    const { w, k } = this;
    for (const c of w.cities) {
      if (c.blocked || c.levels === null) continue;
      const extra = this.extra.get(c.id) ?? [];
      const mine = own(c);
      const wishes = mine === null ? economyWishes(this, c, extra) : [...extra, ...mine];
      const plan = planBuilds(
        w.kit,
        c.levels,
        c.build.map((b) => b.building),
        wishes,
        subRes(this.stockOf(c.id), this.reserved.get(c.id) ?? ZERO),
        c.rate,
        c.cap,
        this.buildRoom.get(c.id) ?? 0,
        k.cadence,
      );
      if (plan.items.length > 0) {
        this.build(c, plan.items);
        this.spend(c.id, plan.spent);
      }
      if (plan.saving !== null) this.saving.set(c.id, plan.saving);
    }
  }

  /** Free pop of a city after this turn's orders. */
  popFreeOf(id: CityId): number {
    return this.popFree.get(id) ?? 0;
  }

  /**
   * Spends `spendPm` of what is left on units, in packs of the mix (explicit counts, so the mix
   * holds); keeps carriers for the attackers when the strategy ships them across water.
   */
  units(mix: Mix = this.k.mix): void {
    const { w, k } = this;
    const kit = w.kit;
    for (const c of w.cities) {
      if (c.blocked || c.levels === null) continue;
      let budget = pmRes(this.budgetOf(c.id), k.spendPm);
      let free = this.popFree.get(c.id) ?? 0;
      const rooms = new Map(this.batchRoom.get(c.id) ?? []);
      const orders: { unit: UnitId; count: number }[] = [];
      const order = (unit: UnitId, count: number): void => {
        const row = kit.units.get(unit)!;
        orders.push({ unit, count });
        rooms.set(row.queue, (rooms.get(row.queue) ?? 0) - 1);
        budget = subRes(budget, scaleRes(row.cost, count));
        free -= row.pop * count;
      };
      const eligible = (unit: UnitId | null): unit is UnitId => {
        if (unit === null || !this.canRecruit(c, unit)) return false;
        const row = kit.units.get(unit)!;
        return (rooms.get(row.queue) ?? 0) > 0;
      };

      const carrier = kit.roles.carrier;
      const attacker = kit.roles.attacker;
      if (k.carriers && attacker !== null && eligible(carrier)) {
        const row = kit.units.get(carrier)!;
        const apop = kit.units.get(attacker)?.pop ?? 1;
        const attackers = countOf(c.units, attacker) + this.queued(c, attacker);
        const carriers = countOf(c.units, carrier) + this.queued(c, carrier);
        const want =
          row.capacity > 0 ? Math.ceil((attackers * apop) / row.capacity) + 1 - carriers : 0;
        const n = Math.min(
          want,
          timesAffordable(budget, row.cost),
          Math.floor(free / Math.max(1, row.pop)),
          row.maxPerOrder,
        );
        if (n > 0) order(carrier, n);
      }

      const picks: { unit: UnitId; weight: number }[] = [];
      const pick = (unit: UnitId | null, weight: number): void => {
        if (weight <= 0 || !eligible(unit) || picks.some((p) => p.unit === unit)) return;
        const row = kit.units.get(unit)!;
        const sameQueue = picks.filter((p) => kit.units.get(p.unit)?.queue === row.queue).length;
        if ((rooms.get(row.queue) ?? 0) <= sameQueue) return;
        picks.push({ unit, weight });
      };
      pick(kit.roles.defender, mix.defender);
      pick(attacker, mix.attacker);
      pick(kit.roles.navy, mix.navy);
      if (picks.length > 0) {
        let packCost = ZERO;
        let packPop = 0;
        for (const p of picks) {
          const row = kit.units.get(p.unit)!;
          packCost = addRes(packCost, scaleRes(row.cost, p.weight));
          packPop += row.pop * p.weight;
        }
        const packs = Math.min(
          timesAffordable(budget, packCost),
          Math.floor(Math.max(0, free) / Math.max(1, packPop)),
        );
        // Batches are few (`maxBatches` per queue): small orders wait for a fuller budget.
        if (packs >= (k.minPacks ?? MIN_PACKS)) {
          for (const p of picks) {
            const row = kit.units.get(p.unit)!;
            const qmax = kit.queues.get(row.queue)?.maxCount ?? row.maxPerOrder;
            const n = Math.min(packs * p.weight, row.maxPerOrder, qmax);
            if (n > 0) order(p.unit, n);
          }
        }
      }
      if (orders.length > 0) this.recruit(c, orders.slice(0, RECRUIT_MAX_ORDERS));
    }
  }

  /**
   * The attack group `from` can send to `island`: its attackers at home (all of them, or as many as
   * its carriers lift), its warships when crossing water, and exactly `founders` founders when that
   * many are at home and fit (otherwise none). Returns the land attack strength too.
   */
  attackGroup(
    from: OwnCity,
    island: IslandId,
    founders: number,
  ): { units: UnitCounts; strength: number } | null {
    const kit = this.w.kit;
    const attacker = kit.roles.attacker;
    if (attacker === null) return null;
    const home = this.homeOf(from.id);
    const apop = Math.max(1, kit.units.get(attacker)?.pop ?? 1);
    const fpop = kit.units.get(kit.roles.founder)?.pop ?? 0;
    const lift = this.liftCapacity(from, island);
    const f =
      founders > 0 && countOf(home, kit.roles.founder) >= founders && founders * fpop <= lift
        ? founders
        : 0;
    const n = Math.min(countOf(home, attacker), Math.floor((lift - f * fpop) / apop));
    if (n <= 0) return null;
    const land: Record<string, number> = { [attacker]: n };
    if (f > 0) land[kit.roles.founder] = f;
    const units = this.withCarriers(from, island, land);
    if (units === null) return null;
    const navy = kit.roles.navy;
    if (navy !== null && from.island !== island && countOf(home, navy) > 0)
      units[navy] = countOf(home, navy);
    return { units, strength: power(kit, units, "attack", true) };
  }

  /** Spy gold for a target: the configured minimum times `mult`, plus the estimated pop, capped by stock. */
  spyGold(from: OwnCity, mult: number, known: number | null): number | null {
    const min = this.w.kit.rules.movement.spyMinGold;
    const gold = Math.max(min, min * mult + (known ?? 0));
    const have = this.stockOf(from.id).gold;
    if (have < min) return null;
    return Math.min(gold, have);
  }

  /** True when one of the seat's own movements of `kind` is heading to `city`. */
  inFlight(kind: string, city: CityId): boolean {
    return (this.w.self?.private?.movements ?? []).some(
      (m) => m.kind === kind && m.to === city && m.owner === this.w.seat,
    );
  }
}

/** Packs of the unit mix below which the surplus is kept for the next turn. */
const MIN_PACKS = 3;

function queuedOf(c: OwnCity, unit: UnitId): number {
  let n = 0;
  for (const batches of Object.values(c.recruit))
    for (const b of batches) if (b.unit === unit) n += b.count;
  return n;
}

interface Slot {
  readonly island: IslandId;
  readonly slot: number;
  readonly travel: number;
  readonly kind: string;
  readonly score: number;
}

function better(a: Slot, b: Slot, prefer: string | null): boolean {
  if (prefer !== null) {
    const pa = a.kind === prefer;
    const pb = b.kind === prefer;
    if (pa !== pb) return pa;
    if (pa)
      return a.travel < b.travel || (a.travel === b.travel && compareIds(a.island, b.island) < 0);
  }
  if (a.score !== b.score) return a.score > b.score;
  if (a.travel !== b.travel) return a.travel < b.travel;
  return compareIds(a.island, b.island) < 0;
}
