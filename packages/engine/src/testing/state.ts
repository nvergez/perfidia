import { fnv1a64, idKeyFromSeed, insertSorted, opaqueId } from "@perfidia/engine/core";
import { compareScheduled } from "@perfidia/engine/kernel";
import {
  CityIdSchema,
  IslandIdSchema,
  MovementIdSchema,
  PlayerIdSchema,
  ProposalIdSchema,
  compareIds,
  type Alliance,
  type AllianceId,
  type BuildItem,
  type City,
  type CityId,
  type CompiledRules,
  type DeepReadonly,
  type GameState,
  type Island,
  type IslandId,
  type Json,
  type Movement,
  type MovementKind,
  type Pact,
  type PlayerId,
  type Proposal,
  type RecruitBatch,
  type Res,
  type Stationed,
  type UnitCounts,
} from "@perfidia/protocol";
import { addUnits, must } from "./util.ts";

// State builders (docs/architecture.md §15 T04): hand-built `GameState`s for any ruleset's compiled
// rules, kept consistent with the kernel invariants (every entity has its scheduled event, counters
// cover every id, the ledger counts every unit), for `matchFromState`. They edit the state in place.

type Rules = DeepReadonly<CompiledRules>;

export interface BuildStateOptions {
  readonly rules: Rules;
  /** Default `rules.players`. */
  readonly players?: number;
  /** Default 1. */
  readonly seed?: number;
  /** Default 0; must be before `rules.time.matchEnd`. */
  readonly now?: number;
  /** Island records, or a number of default islands (`i1` at (0, 0), `i2` at (10, 0), …). Default 2. */
  readonly islands?: number | readonly Partial<Island>[];
  /** `state.ext`; default null (use the ruleset's own shape when it has one). */
  readonly ext?: Json;
}

function zeroRes(): Res {
  return { wood: 0, stone: 0, gold: 0 };
}

function numberOf(id: string): number {
  const n = Number(id.slice(1));
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`testing kit: "${id}" has no number`);
  return n;
}

/** Inserts a scheduled event (at ≥ now) with the next seq and returns the seq. */
export function scheduleAt(
  state: GameState,
  rules: Rules,
  kind: string,
  at: number,
  ref: string,
): number {
  const cls = rules.eventClasses[kind];
  if (cls === undefined) throw new Error(`testing kit: ${kind} has no class in eventClasses`);
  if (!Number.isSafeInteger(at) || at < state.now) {
    throw new Error(`testing kit: ${kind} at ${at} is before now (${state.now})`);
  }
  state.seq += 1;
  insertSorted(state.queue, { at, cls, seq: state.seq, kind, ref }, compareScheduled);
  return state.seq;
}

/** Appends an island; the id defaults to the next free `i` number. */
export function addIsland(state: GameState, island: Partial<Island> = {}): Island {
  const ids = Object.keys(state.islands).map(numberOf);
  const n = ids.length === 0 ? 1 : Math.max(...ids) + 1;
  const record: Island = {
    id: island.id ?? IslandIdSchema.parse(`i${n}`),
    x: island.x ?? 10 * (n - 1),
    y: island.y ?? 0,
    kind: island.kind ?? "plain",
    slots: island.slots ?? 4,
    richnessPm: island.richnessPm ?? 1000,
  };
  state.islands[record.id] = record;
  return record;
}

/**
 * A running state with players `p1..pN`, their counters and ledger entries, the given islands and
 * `match_end` scheduled at `rules.time.matchEnd`. `ruleset` and `configHash` are placeholders until
 * `matchFromState` sets them.
 */
export function buildState(o: BuildStateOptions): GameState {
  const now = o.now ?? 0;
  if (now >= o.rules.time.matchEnd)
    throw new Error(`testing kit: now ${now} is not before matchEnd`);
  const count = o.players ?? o.rules.players;
  const state: GameState = {
    v: 1,
    ruleset: o.rules.ruleset,
    configHash: "0".repeat(64),
    seed: o.seed ?? 1,
    now,
    status: "running",
    seq: 0,
    ids: { c: 0, a: 0, own: {} },
    evHash: fnv1a64(""),
    queue: [],
    players: {},
    islands: {},
    cities: {},
    movements: {},
    proposals: {},
    alliances: {},
    pacts: [],
    ledger: { neutral: { made: {}, gone: {} } },
    ext: o.ext ?? null,
    result: null,
  };
  for (let i = 1; i <= count; i += 1) {
    const id = PlayerIdSchema.parse(`p${i}`);
    state.players[id] = { id, alive: true, eliminatedAt: null, alliance: null };
    state.ids.own[id] = { m: 0, r: 0, q: 0, g: 0 };
    state.ledger[id] = { made: {}, gone: {} };
  }
  const islands = o.islands ?? 2;
  if (typeof islands === "number") for (let i = 0; i < islands; i += 1) addIsland(state);
  else for (const island of islands) addIsland(state, island);
  scheduleAt(state, o.rules, "match_end", o.rules.time.matchEnd, "");
  return state;
}

function made(state: GameState, owner: PlayerId | null, units: Readonly<UnitCounts>): void {
  const entry = state.ledger[owner ?? "neutral"];
  if (entry === undefined)
    throw new Error(`testing kit: ${owner ?? "neutral"} has no ledger entry`);
  addUnits(entry.made, units);
}

export interface CityOptions {
  readonly owner: PlayerId | null;
  /** Default the next city number. */
  readonly id?: CityId;
  /** Default `i1`. */
  readonly island?: IslandId;
  /** Default the lowest free slot of the island. */
  readonly slot?: number;
  /** Levels by building id; every other building of the rules is at 0. */
  readonly buildings?: Readonly<Record<string, number>>;
  /** Whole units: one amount for every resource, or per resource. Default 0. */
  readonly stock?: number | Partial<Res>;
  readonly units?: UnitCounts;
  /** Marks it as the owner's capital. */
  readonly capital?: boolean;
  readonly tag?: string | null;
  readonly name?: string;
  readonly foundedAt?: number;
}

/** Adds a city with every building of the rules and an empty queue for every recruit queue. */
export function addCity(state: GameState, rules: Rules, o: CityOptions): City {
  const id = o.id ?? CityIdSchema.parse(`c${state.ids.c + 1}`);
  state.ids.c = Math.max(state.ids.c, numberOf(id));
  const island = o.island ?? IslandIdSchema.parse("i1");
  const taken = new Set(
    Object.values(state.cities)
      .filter((c) => c.island === island)
      .map((c) => c.slot),
  );
  let slot = o.slot ?? 0;
  if (o.slot === undefined) while (taken.has(slot)) slot += 1;
  const scale = rules.resourceScale;
  const stock =
    typeof o.stock === "number"
      ? { wood: o.stock, stone: o.stock, gold: o.stock }
      : { ...zeroRes(), ...o.stock };
  const buildings: Record<string, number> = {};
  for (const b of rules.buildings) buildings[b.id] = o.buildings?.[b.id] ?? 0;
  const recruit: Record<string, RecruitBatch[]> = {};
  for (const q of rules.queues.recruit) recruit[q.id] = [];
  const city: City = {
    id,
    name: o.name ?? id,
    owner: o.owner,
    island,
    slot,
    capitalOf: o.capital === true ? o.owner : null,
    tag: o.tag ?? null,
    foundedAt: o.foundedAt ?? state.now,
    stock: { wood: stock.wood * scale, stone: stock.stone * scale, gold: stock.gold * scale },
    stockAt: state.now,
    buildings,
    units: { ...o.units },
    stationed: [],
    itemSeq: 0,
    build: [],
    recruit,
  };
  state.cities[id] = city;
  made(state, o.owner, city.units);
  return city;
}

export interface MovementOptions {
  readonly kind: MovementKind;
  readonly owner: PlayerId;
  readonly from: CityId;
  /** Default `null` for found, else required. */
  readonly to?: CityId | null;
  /** Default the island of `to`. */
  readonly toIsland?: IslandId;
  /** Default `from`. */
  readonly home?: CityId;
  readonly units?: UnitCounts;
  readonly cargo?: Partial<Res>;
  readonly gold?: number;
  readonly party?: PlayerId | null;
  readonly slot?: number | null;
  /** Default `state.now`. */
  readonly departAt?: number;
  readonly arriveAt: number;
  readonly back?: Movement["back"];
  /** The match's id key; default `idKeyFromSeed(state.seed)`, as `matchFromState` uses. */
  readonly idKey?: string;
}

/** Adds a movement with its id from the owner's counter, its arrival event and its units in the ledger. */
export function addMovement(state: GameState, rules: Rules, o: MovementOptions): Movement {
  const counters = must(state.ids.own, o.owner, "player");
  counters.m += 1;
  const id = opaqueId(o.idKey ?? idKeyFromSeed(state.seed), "m", numberOf(o.owner), counters.m);
  const from = must(state.cities, o.from, "city");
  const to = o.to === undefined ? null : o.to;
  const toIsland =
    o.toIsland ?? (to === null ? from.island : must(state.cities, to, "city").island);
  const movementId = MovementIdSchema.parse(id);
  const seq = scheduleAt(state, rules, `arrive_${o.kind}`, o.arriveAt, movementId);
  const movement: Movement = {
    id: movementId,
    kind: o.kind,
    owner: o.owner,
    home: o.home ?? o.from,
    from: o.from,
    fromIsland: from.island,
    to,
    toIsland,
    slot: o.slot ?? null,
    party: o.party ?? null,
    units: { ...o.units },
    cargo: { ...zeroRes(), ...o.cargo },
    gold: o.gold ?? 0,
    departAt: o.departAt ?? state.now,
    arriveAt: o.arriveAt,
    seq,
    back: o.back ?? null,
  };
  state.movements[movementId] = movement;
  made(state, o.owner, movement.units);
  return movement;
}

/** Appends a build item (and its `build_done` event) to a city's build queue. */
export function addBuildItem(
  state: GameState,
  rules: Rules,
  cityId: CityId,
  building: string,
  o: { readonly level?: number; readonly start?: number; readonly end?: number } = {},
): BuildItem {
  const city = must(state.cities, cityId, "city");
  const queued = city.build.filter((b) => b.building === building).length;
  const level = o.level ?? (city.buildings[building] ?? 0) + queued + 1;
  const start = o.start ?? Math.max(state.now, city.build.at(-1)?.end ?? state.now);
  const table = rules.buildings.find((b) => b.id === building);
  const end = o.end ?? start + Math.max(1, table?.time[level]?.[0] ?? 600);
  city.itemSeq += 1;
  const item: BuildItem = {
    id: city.itemSeq,
    building,
    level,
    cost: table?.cost[level] === undefined ? zeroRes() : { ...table.cost[level] },
    start,
    end,
    seq: scheduleAt(state, rules, "build_done", end, cityId),
  };
  city.build.push(item);
  return item;
}

/** Appends a recruit batch (and its `recruit_done` event) to the unit's recruit queue. */
export function addRecruitBatch(
  state: GameState,
  rules: Rules,
  cityId: CityId,
  unit: string,
  count: number,
  o: { readonly start?: number; readonly unitTime?: number; readonly done?: number } = {},
): RecruitBatch {
  const city = must(state.cities, cityId, "city");
  const table = rules.units.find((u) => u.id === unit);
  if (table === undefined) throw new Error(`testing kit: no unit ${unit}`);
  const batches = city.recruit[table.queue] ?? [];
  const start = o.start ?? Math.max(state.now, batches.at(-1)?.end ?? state.now);
  const unitTime = o.unitTime ?? Math.max(1, table.time[0] ?? 1);
  const end = start + unitTime * count;
  city.itemSeq += 1;
  const batch: RecruitBatch = {
    id: city.itemSeq,
    unit,
    count,
    done: o.done ?? 0,
    unitTime,
    costEach: { ...table.cost },
    popEach: table.pop,
    start,
    end,
    seq: scheduleAt(state, rules, "recruit_done", end, cityId),
  };
  batches.push(batch);
  city.recruit[table.queue] = batches;
  return batch;
}

/** Adds an open proposal (and its `proposal_expire` event); its id comes from the proposer's counter. */
export function addProposal(
  state: GameState,
  rules: Rules,
  o: {
    readonly from: PlayerId;
    readonly to: PlayerId;
    readonly kind?: "alliance" | "pact";
    readonly name?: string | null;
    readonly until?: number | null;
    readonly expiresAt?: number;
    readonly idKey?: string;
  },
): Proposal {
  const counters = must(state.ids.own, o.from, "player");
  counters.q += 1;
  const id = ProposalIdSchema.parse(
    opaqueId(o.idKey ?? idKeyFromSeed(state.seed), "q", numberOf(o.from), counters.q),
  );
  const expiresAt = o.expiresAt ?? state.now + rules.diplomacy.proposalTtl;
  const proposal: Proposal = {
    id,
    from: o.from,
    to: o.to,
    kind: o.kind ?? "pact",
    name: o.name ?? null,
    until: o.until ?? null,
    expiresAt,
    seq: scheduleAt(state, rules, "proposal_expire", expiresAt, id),
  };
  state.proposals[id] = proposal;
  return proposal;
}

/** Adds a pact between two players (sorted, with its `pact_expire` event when it expires). */
export function addPact(
  state: GameState,
  rules: Rules,
  x: PlayerId,
  y: PlayerId,
  o: { readonly since?: number; readonly expiresAt?: number | null } = {},
): Pact {
  const [a, b] = compareIds(x, y) < 0 ? [x, y] : [y, x];
  const expiresAt = o.expiresAt === undefined ? null : o.expiresAt;
  const pact: Pact = {
    a,
    b,
    since: o.since ?? state.now,
    expiresAt,
    seq:
      expiresAt === null ? null : scheduleAt(state, rules, "pact_expire", expiresAt, `${a}|${b}`),
  };
  state.pacts = [...state.pacts, pact].toSorted(
    (u, v) => compareIds(u.a, v.a) || compareIds(u.b, v.b),
  );
  return pact;
}

/** Adds an alliance with these members (sorted) and sets their `alliance`. */
export function addAlliance(
  state: GameState,
  name: string,
  members: readonly PlayerId[],
): Alliance {
  state.ids.a += 1;
  const id: AllianceId = `a${state.ids.a}`;
  const alliance: Alliance = {
    id,
    name,
    members: members.toSorted(compareIds),
    formedAt: state.now,
  };
  state.alliances[id] = alliance;
  for (const p of members) must(state.players, p, "player").alliance = id;
  return alliance;
}

/** Stations a group in a city (merged by owner, home and role, kept sorted) and counts its units. */
export function addStationed(state: GameState, cityId: CityId, group: Stationed): void {
  const city = must(state.cities, cityId, "city");
  const same = city.stationed.find(
    (g) => g.owner === group.owner && g.home === group.home && g.role === group.role,
  );
  if (same === undefined) {
    city.stationed = [...city.stationed, { ...group, units: { ...group.units } }].toSorted(
      (u, v) =>
        compareIds(u.owner, v.owner) ||
        compareIds(u.home, v.home) ||
        (u.role < v.role ? -1 : u.role > v.role ? 1 : 0),
    );
  } else {
    addUnits(same.units, group.units);
  }
  made(state, group.owner, group.units);
}
