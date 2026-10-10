// Test fixtures shared by the std tests. This file holds no tests of its own; it is named
// `*.test.ts` so that it stays out of the published sources and gets the test tsconfig and lint.
//
// The kernel is written in parallel (T04), so std is tested against a naive local `Ctx` (a plain
// sorted array for the queue), a hand-built `CompiledRules` with ids of its own, and a minimal
// fixture ruleset whose only live hook is `travelTime` (plus an optional `relations` hook).

import {
  DomainEventSchema,
  STANDARD_EVENT_DATA,
  z,
  type AllianceId,
  type City,
  type CityId,
  type CompiledRules,
  type DeepReadonly,
  type DomainEvent,
  type GameState,
  type GatewayRules,
  type IslandId,
  type MatchResult,
  type MessageId,
  type Movement,
  type MovementId,
  type PlayerId,
  type ProposalId,
  type ReportId,
  type Res,
  type ScheduledEvent,
  type UnitCounts,
} from "@perfidia/protocol";
import {
  canonicalJson,
  fnv1a64,
  insertSorted,
  opaqueId,
  removeWhere,
  streamRng,
  type Rng,
} from "@perfidia/engine/core";
import type { Ctx, ReadCtx, Relation, Ruleset, RulesetHooks } from "@perfidia/engine/contracts";
import {
  arriveHome,
  bounce,
  completeBuild,
  completeRecruit,
  deleteMovement,
  deliverShipment,
  deliverSupport,
  foundCity,
  freeSlots,
  removeUnits,
} from "./index.ts";

export const ID_KEY = "00112233445566778899aabbccddeeff";
export const res = (wood: number, stone: number, gold: number): Res => ({ wood, stone, gold });
export const SCALE = 3600;
export const MIN_TRAVEL = 3600;

const MAX = 10;
const w = (L: number): number => L * L + 3 * L + 6;
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

function costTable(base: Res): Res[] {
  return range(MAX + 1).map((L) =>
    L === 0
      ? res(0, 0, 0)
      : res(
          Math.floor((base.wood * w(L)) / 10),
          Math.floor((base.stone * w(L)) / 10),
          Math.floor((base.gold * w(L)) / 10),
        ),
  );
}

function buildTimes(baseTime: number): number[][] {
  return range(MAX + 1).map((L) =>
    range(MAX + 1).map((h) => Math.max(1, Math.floor((baseTime * w(L)) / (9 + h)))),
  );
}

function unitTimes(baseTime: number): number[] {
  return range(MAX + 1).map((L) => Math.max(1, Math.floor((baseTime * 10) / (9 + L))));
}

function building(id: string, base: Res, baseTime: number, requires: Record<string, number> = {}) {
  return { id, maxLevel: MAX, cost: costTable(base), time: buildTimes(baseTime), requires };
}

const gateway: GatewayRules = {
  roundTripsPerWake: 8,
  toolCallsPerRoundTrip: 10,
  toolCallsPerWake: null,
  ownWakesPerDay: 12,
  socialWakesPerDay: 8,
  groupWindow: 600,
  urgentMinGap: 600,
  selfWake: { min: 600, max: 43200 },
  safetyWake: 43200,
  attackLaunchesPerDay: 20,
  messagesPerDay: 20,
  notesMaxChars: 4000,
  wake: { incoming_attack: { party: "urgent" }, queue_empty: { self: "own" } },
  publicOncePerDay: [],
};

/** Rules with ids of their own: no ruleset's ids appear in std or its tests. */
export const RULES: CompiledRules = {
  ruleset: "fixture-1@1.0.0",
  players: 3,
  time: { matchEnd: 604800, attackFrom: 43200, minTravel: MIN_TRAVEL },
  resourceScale: SCALE,
  buildings: [
    building("center", res(90, 90, 60), 1800),
    building("woodcut", res(20, 50, 30), 1500),
    building("stonecut", res(50, 20, 30), 1500),
    building("goldpit", res(50, 50, 10), 1500),
    building("store", res(60, 60, 20), 1200),
    building("camp", res(60, 80, 50), 1500, { center: 2 }),
    building("dock", res(100, 60, 60), 2400, { center: 3 }),
    building("rampart", res(30, 120, 30), 1500, { camp: 1 }),
  ],
  units: [
    {
      id: "pike",
      domain: "land",
      attack: 5,
      defense: 20,
      naval: 0,
      carry: 10,
      capacity: 0,
      pop: 1,
      cost: res(30, 60, 30),
      queue: "camp",
      requires: { camp: 1 },
      time: unitTimes(300),
      maxPerOrder: 500,
    },
    {
      id: "axe",
      domain: "land",
      attack: 20,
      defense: 5,
      naval: 0,
      carry: 50,
      capacity: 0,
      pop: 1,
      cost: res(50, 20, 60),
      queue: "camp",
      requires: { camp: 1 },
      time: unitTimes(300),
      maxPerOrder: 500,
    },
    {
      id: "colonist",
      domain: "land",
      attack: 0,
      defense: 0,
      naval: 0,
      carry: 0,
      capacity: 0,
      pop: 10,
      cost: res(450, 450, 750),
      queue: "camp",
      requires: { camp: 2, center: 3 },
      time: unitTimes(5400),
      maxPerOrder: 1,
    },
    {
      id: "ferry",
      domain: "naval",
      attack: 0,
      defense: 0,
      naval: 0,
      carry: 0,
      capacity: 20,
      pop: 2,
      cost: res(120, 40, 80),
      queue: "dock",
      requires: { dock: 1 },
      time: unitTimes(1200),
      maxPerOrder: 500,
    },
    {
      id: "galley",
      domain: "naval",
      attack: 0,
      defense: 0,
      naval: 50,
      carry: 0,
      capacity: 0,
      pop: 4,
      cost: res(150, 100, 250),
      queue: "dock",
      requires: { dock: 3 },
      time: unitTimes(2400),
      maxPerOrder: 500,
    },
  ],
  roles: {
    producers: { wood: "woodcut", stone: "stonecut", gold: "goldpit" },
    storage: "store",
    population: "center",
    buildSpeed: "center",
    wall: "rampart",
    settler: "colonist",
  },
  levels: {
    production: range(MAX + 1).map((L) => 5 * L * L + 20 * L + 50),
    storage: range(MAX + 1).map((L) => 60 * L * L + 280 * L + 660),
    population: range(MAX + 1).map((L) => 2 * L * L + 20 * L + 40),
  },
  queues: {
    build: { max: 5, requiresOn: "projected" },
    recruit: [
      { id: "camp", building: "camp", maxBatches: 5, maxCount: 500 },
      { id: "dock", building: "dock", maxBatches: 5, maxCount: 500 },
    ],
    delivery: "trickle",
    refund: {
      build: { queuedPm: 1000, active: "prorata" },
      recruit: { queuedPm: 1000, active: "uncompleted" },
    },
  },
  settlerCost: range(MAX + 1).map((k) =>
    res(450 * Math.max(1, k), 450 * Math.max(1, k), 750 * Math.max(1, k)),
  ),
  newCity: {
    buildings: { center: 1, woodcut: 1, stonecut: 1, goldpit: 1, store: 1 },
    stock: res(300, 300, 300),
    units: {},
  },
  neutralProduction: false,
  movement: {
    recall: {
      window: 600,
      kinds: ["attack", "support", "found"],
      stationed: "partial",
      dismiss: true,
    },
    shipment: { base: 500, perLevel: 500, building: "dock" },
    transportRule: true,
    spyMinGold: 100,
  },
  diplomacy: {
    allianceMax: 2,
    maxPacts: 2,
    pactDuration: 172800,
    maxOpenProposals: 3,
    proposalTtl: 43200,
    messageMaxChars: 1000,
    proposalTextMaxChars: 300,
    allianceNameMaxChars: 24,
  },
  toolOptions: { foundSlot: false, pactUntil: false },
  gateway,
  travelProbes: [
    { label: "carrier", group: { kind: "attack", units: { ferry: 1 } } },
    { label: "naval", group: { kind: "attack", units: { galley: 1 } } },
    { label: "spy", group: { kind: "spy", units: {} } },
  ],
  eventClasses: {
    build_done: 1,
    recruit_done: 2,
    arrive_return: 3,
    arrive_support: 4,
    arrive_shipment: 5,
    arrive_spy: 6,
    arrive_attack: 7,
    arrive_found: 8,
    proposal_expire: 10,
    pact_expire: 10,
    match_end: 12,
  },
};

/** The same rules with batch delivery and `{pm}` refunds of the active item. */
export function batchRules(): CompiledRules {
  const r = structuredClone(RULES);
  r.queues.delivery = "batch";
  r.queues.refund = {
    build: { queuedPm: 1000, active: { pm: 500 } },
    recruit: { queuedPm: 1000, active: { pm: 500 } },
  };
  return r;
}

const notUsed = (): never => {
  throw new Error("not used by the std tests");
};

/** Manhattan tiles; pace 60 with a carrier or no ship, 45 for warships only, 30 for spies. */
function fixtureTravel(
  r: ReadCtx,
  from: IslandId,
  to: IslandId,
  group: { kind: string; units: DeepReadonly<UnitCounts> },
): number {
  if (from === to) return r.rules.time.minTravel;
  const a = r.state.islands[from];
  const b = r.state.islands[to];
  if (a === undefined || b === undefined) throw new Error(`no island ${from} or ${to}`);
  const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  let pace = 60;
  if (group.kind === "spy") pace = 30;
  else {
    const ids = Object.keys(group.units).filter((id) => (group.units[id] ?? 0) > 0);
    const tables = ids.map((id) => r.rules.units.find((u) => u.id === id));
    const naval = tables.filter((u) => u?.domain === "naval");
    if (
      ids.length > 0 &&
      naval.length === ids.length &&
      naval.every((u) => (u?.capacity ?? 0) === 0)
    )
      pace = 45;
  }
  return Math.max(r.rules.time.minTravel, pace * d);
}

function hooks(
  relations?: (r: ReadCtx, p: PlayerId) => readonly Relation[],
): RulesetHooks<unknown, unknown> {
  const base: RulesetHooks<unknown, unknown> = {
    createWorld: notUsed,
    travelTime: fixtureTravel,
    arrive: { attack: notUsed, spy: notUsed },
    standings: () => [],
    finish: notUsed,
  };
  return relations === undefined ? base : { ...base, relations };
}

/** A minimal ruleset: only `travelTime` (and optionally `relations`) is live. */
export function fixtureRuleset(
  relations?: (r: ReadCtx, p: PlayerId) => readonly Relation[],
): Ruleset {
  return {
    id: "fixture-1",
    version: "1.0.0",
    ref: "fixture-1@1.0.0",
    status: "test",
    title: "std fixture",
    configSchema: z.unknown(),
    defaults: {},
    extSchema: z.unknown(),
    players: () => ({ min: 3, max: 3 }),
    compile: notUsed,
    cheatSheet: () => "",
    hooks: hooks(relations),
    errors: {},
    errorSamples: [],
    eventSchemas: {},
  };
}

function city(
  id: CityId,
  owner: PlayerId | null,
  island: IslandId,
  slot: number,
  levels: Record<string, number>,
  stock: Res,
  units: UnitCounts,
): City {
  const buildings: Record<string, number> = {};
  for (const b of RULES.buildings) buildings[b.id] = levels[b.id] ?? 0;
  return {
    id,
    name: id,
    owner,
    island,
    slot,
    capitalOf: owner !== null && slot === 0 ? owner : null,
    tag: owner === null ? "fort" : null,
    foundedAt: 0,
    stock: res(stock.wood * SCALE, stock.stone * SCALE, stock.gold * SCALE),
    stockAt: 0,
    buildings,
    units,
    stationed: [],
    itemSeq: 0,
    build: [],
    recruit: { camp: [], dock: [] },
  };
}

const ALL2 = {
  center: 2,
  woodcut: 2,
  stonecut: 2,
  goldpit: 2,
  store: 2,
  camp: 2,
  dock: 2,
  rampart: 2,
};

/**
 * Three players on three islands. c1 (p1, i1) is well developed; c4 is p1's second city on i2,
 * next to p2's capital c2; c5 is a neutral fort on i1.
 */
export function world(): GameState {
  const cities: Record<CityId, City> = {
    c1: city(
      "c1",
      "p1",
      "i1",
      0,
      { center: 3, woodcut: 2, stonecut: 2, goldpit: 2, store: 3, camp: 2, dock: 1, rampart: 1 },
      res(800, 800, 800),
      { pike: 20, axe: 30, colonist: 1, ferry: 3 },
    ),
    c2: city(
      "c2",
      "p2",
      "i2",
      0,
      { center: 2, woodcut: 1, stonecut: 1, goldpit: 1, store: 1, camp: 1 },
      res(1000, 500, 200),
      { pike: 15 },
    ),
    c3: city(
      "c3",
      "p3",
      "i3",
      0,
      { center: 1, woodcut: 1, stonecut: 1, goldpit: 1, store: 1, camp: 1 },
      res(300, 300, 300),
      { pike: 10, axe: 10 },
    ),
    c4: city(
      "c4",
      "p1",
      "i2",
      1,
      { center: 1, woodcut: 1, stonecut: 1, goldpit: 1, store: 1 },
      res(100, 100, 100),
      {
        pike: 5,
      },
    ),
    c5: city("c5", null, "i1", 1, ALL2, res(1000, 1000, 1000), { pike: 40 }),
  };
  return {
    v: 1,
    ruleset: "fixture-1@1.0.0",
    configHash: "0".repeat(64),
    seed: 7,
    now: 0,
    status: "running",
    seq: 0,
    ids: {
      c: 5,
      a: 0,
      own: {
        p1: { m: 0, r: 0, q: 0, g: 0 },
        p2: { m: 0, r: 0, q: 0, g: 0 },
        p3: { m: 0, r: 0, q: 0, g: 0 },
      },
    },
    evHash: fnv1a64(""),
    queue: [],
    players: {
      p1: { id: "p1", alive: true, eliminatedAt: null, alliance: null },
      p2: { id: "p2", alive: true, eliminatedAt: null, alliance: null },
      p3: { id: "p3", alive: true, eliminatedAt: null, alliance: null },
    },
    islands: {
      i1: { id: "i1", x: 0, y: 0, kind: "home", slots: 4, richnessPm: 1000 },
      i2: { id: "i2", x: 100, y: 0, kind: "east", slots: 3, richnessPm: 1500 },
      i3: { id: "i3", x: 0, y: -150, kind: "south", slots: 2, richnessPm: 1000 },
    },
    cities,
    movements: {},
    proposals: {},
    alliances: {},
    pacts: [],
    ledger: {
      neutral: { made: { pike: 40 }, gone: {} },
      p1: { made: { pike: 25, axe: 30, colonist: 1, ferry: 3 }, gone: {} },
      p2: { made: { pike: 15 }, gone: {} },
      p3: { made: { pike: 10, axe: 10 }, gone: {} },
    },
    ext: {},
    result: null,
  };
}

const compareEvents = (a: ScheduledEvent, b: ScheduledEvent): number =>
  a.at - b.at || a.cls - b.cls || a.seq - b.seq;

/**
 * A naive `Ctx` over a plain state: canonical emission with `evHash` and schema checks, a sorted
 * array queue, per-owner opaque ids, item numbers. Events are collected in `events`.
 */
export class TestCtx implements Ctx {
  readonly events: DomainEvent[] = [];
  readonly config: unknown = {};
  readonly state: GameState;
  readonly rules: DeepReadonly<CompiledRules>;
  readonly ruleset: Ruleset;

  constructor(
    state: GameState = world(),
    rules: DeepReadonly<CompiledRules> = RULES,
    ruleset: Ruleset = fixtureRuleset(),
  ) {
    this.state = state;
    this.rules = rules;
    this.ruleset = ruleset;
  }

  get now(): number {
    return this.state.now;
  }

  ext(): unknown {
    return this.state.ext;
  }

  read(): ReadCtx {
    const state = this.state;
    return {
      state,
      now: state.now,
      rules: this.rules,
      config: this.config,
      ruleset: this.ruleset,
      ext: () => state.ext,
    };
  }

  emit(e: Omit<DomainEvent, "t">): void {
    const s = canonicalJson({ ...e, t: this.now });
    this.state.evHash = fnv1a64(`${this.state.evHash}\n${s}`);
    const parsed: unknown = JSON.parse(s);
    const ev = DomainEventSchema.parse(parsed);
    const schema = Object.entries(STANDARD_EVENT_DATA).find(([type]) => type === ev.type)?.[1];
    if (schema === undefined) throw new Error(`non-standard event type ${ev.type}`);
    schema.parse(ev.data);
    this.events.push(ev);
  }

  schedule(kind: string, at: number, ref: string): number {
    if (!Number.isSafeInteger(at) || at <= this.now)
      throw new Error(`schedule ${kind} at ${at}, now ${this.now}`);
    const cls = this.rules.eventClasses[kind];
    if (cls === undefined) throw new Error(`no class for ${kind}`);
    this.state.seq += 1;
    insertSorted(this.state.queue, { at, cls, seq: this.state.seq, kind, ref }, compareEvents);
    return this.state.seq;
  }

  cancel(seq: number): void {
    if (removeWhere(this.state.queue, (e) => e.seq === seq).length !== 1) {
      throw new Error(`cancel: no queued event ${seq}`);
    }
  }

  nextId(kind: "c"): CityId;
  nextId(kind: "a"): AllianceId;
  nextId(kind: "m", owner: PlayerId): MovementId;
  nextId(kind: "r", owner: PlayerId): ReportId;
  nextId(kind: "q", owner: PlayerId): ProposalId;
  nextId(kind: "g", owner: PlayerId): MessageId;
  nextId(kind: "c" | "a" | "m" | "r" | "q" | "g", owner?: PlayerId): string {
    if (kind === "c") return `c${(this.state.ids.c += 1)}`;
    if (kind === "a") return `a${(this.state.ids.a += 1)}`;
    if (owner === undefined) throw new Error(`nextId(${kind}) needs an owner`);
    const own = this.state.ids.own[owner];
    if (own === undefined) throw new Error(`no counters for ${owner}`);
    own[kind] += 1;
    return opaqueId(ID_KEY, kind, Number(owner.slice(1)), own[kind]);
  }

  nextItem(id: CityId): number {
    const c = this.state.cities[id];
    if (c === undefined) throw new Error(`no city ${id}`);
    c.itemSeq += 1;
    return c.itemSeq;
  }

  rng(stream: string): Rng {
    return streamRng(this.state.seed, stream);
  }

  endMatch(result: MatchResult): void {
    this.state.status = "ended";
    this.state.result = result;
  }

  /** Events emitted so far of one type. */
  ofType(type: string): DomainEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  /** Sets the clock without firing anything (time only moves forward). */
  setNow(t: number): void {
    if (t < this.now) throw new Error(`time goes back: ${t} < ${this.now}`);
    this.state.now = t;
  }
}

/** A fresh context over the fixture world at time `t`. */
export function ctxAt(
  t = 0,
  rules: DeepReadonly<CompiledRules> = RULES,
  ruleset?: Ruleset,
): TestCtx {
  const ctx = new TestCtx(world(), rules, ruleset);
  ctx.setNow(t);
  return ctx;
}

export function cityOf(ctx: TestCtx, id: CityId): City {
  const c = ctx.state.cities[id];
  if (c === undefined) throw new Error(`no city ${id}`);
  return c;
}

export function movementOf(ctx: TestCtx, id: MovementId): Movement {
  const m = ctx.state.movements[id];
  if (m === undefined) throw new Error(`no movement ${id}`);
  return m;
}

type Handler = (ctx: TestCtx, ev: ScheduledEvent) => void;

function eventCity(ctx: TestCtx, ev: ScheduledEvent): City {
  const c = Object.values(ctx.state.cities).find((x) => x.id === ev.ref);
  if (c === undefined) throw new Error(`${ev.kind}: no city ${ev.ref}`);
  return c;
}

function eventMovement(ctx: TestCtx, ev: ScheduledEvent): Movement {
  const m = Object.values(ctx.state.movements).find((x) => x.id === ev.ref);
  if (m === undefined) throw new Error(`${ev.kind}: no movement ${ev.ref}`);
  return m;
}

/** Simple domain-like handlers built from std, enough to drive std through time in tests. */
export const HANDLERS: Readonly<Record<string, Handler>> = {
  build_done(ctx, ev) {
    const c = eventCity(ctx, ev);
    const item = c.build.find((x) => x.seq === ev.seq);
    if (item === undefined) throw new Error(`build_done ${ev.seq}: no item`);
    completeBuild(ctx, c.id, item.id);
  },
  recruit_done(ctx, ev) {
    const c = eventCity(ctx, ev);
    const b = Object.values(c.recruit)
      .flat()
      .find((x) => x.seq === ev.seq);
    if (b === undefined) throw new Error(`recruit_done ${ev.seq}: no batch`);
    completeRecruit(ctx, c.id, b.id);
  },
  arrive_return(ctx, ev) {
    arriveHome(ctx, eventMovement(ctx, ev).id);
  },
  arrive_support(ctx, ev) {
    const m = eventMovement(ctx, ev);
    const target = m.to === null ? undefined : ctx.state.cities[m.to];
    if (target === undefined || target.owner === null || target.owner !== m.party) {
      bounce(ctx, m.id, "owner_changed");
      return;
    }
    deliverSupport(ctx, m.id);
  },
  arrive_shipment(ctx, ev) {
    const m = eventMovement(ctx, ev);
    const target = m.to === null ? undefined : ctx.state.cities[m.to];
    if (target === undefined || target.owner !== m.party) bounce(ctx, m.id, "owner_changed");
    else deliverShipment(ctx, m.id);
  },
  arrive_attack(ctx, ev) {
    bounce(ctx, eventMovement(ctx, ev).id, "test_bounce");
  },
  arrive_spy(ctx, ev) {
    deleteMovement(ctx, eventMovement(ctx, ev).id);
  },
  arrive_found(ctx, ev) {
    const m = eventMovement(ctx, ev);
    if (freeSlots(ctx.read(), m.toIsland).length === 0) {
      bounce(ctx, m.id, "no_free_slot");
      return;
    }
    removeUnits(ctx, { at: "movement", id: m.id }, { colonist: 1 }, "consumed");
    const escort = { ...m.units };
    m.units = {};
    foundCity(ctx, m.toIsland, m.owner, escort, m.slot);
    deleteMovement(ctx, m.id);
  },
};

/** Fires every queued event up to `t` in `(at, cls, seq)` order, then sets the clock to `t`. */
export function advance(
  ctx: TestCtx,
  t: number,
  handlers: Readonly<Record<string, Handler>> = HANDLERS,
): void {
  for (;;) {
    const ev = ctx.state.queue[0];
    if (ev === undefined || ev.at > t) break;
    ctx.state.queue.shift();
    ctx.setNow(ev.at);
    const handler = handlers[ev.kind];
    if (handler === undefined) throw new Error(`no handler for ${ev.kind}`);
    handler(ctx, ev);
  }
  ctx.setNow(t);
}

/** A deep-frozen copy (writes throw in strict mode). */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Structural references a std primitive must never leave dangling. */
export function danglingRefs(state: GameState): string[] {
  const out: string[] = [];
  const cities = Object.values(state.cities);
  const movements = Object.values(state.movements);
  const alive = (p: string): boolean =>
    Object.values(state.players).some((x) => x.id === p && x.alive);
  const cityExists = (id: string): boolean => cities.some((c) => c.id === id);
  for (const ev of state.queue) {
    if (ev.kind === "build_done" || ev.kind === "recruit_done") {
      const c = cities.find((x) => x.id === ev.ref);
      const items = c === undefined ? [] : [...c.build, ...Object.values(c.recruit).flat()];
      if (!items.some((x) => x.seq === ev.seq)) out.push(`event ${ev.seq} ${ev.kind} has no item`);
    } else if (ev.kind.startsWith("arrive_")) {
      const m = movements.find((x) => x.id === ev.ref);
      if (m === undefined || m.seq !== ev.seq || `arrive_${m.kind}` !== ev.kind) {
        out.push(`event ${ev.seq} ${ev.kind} has no movement`);
      }
    } else if (ev.kind === "proposal_expire") {
      const q = Object.values(state.proposals).find((x) => x.id === ev.ref);
      if (q?.seq !== ev.seq) out.push(`event ${ev.seq} has no proposal`);
    } else if (ev.kind === "pact_expire") {
      if (!state.pacts.some((x) => x.seq === ev.seq)) out.push(`event ${ev.seq} has no pact`);
    }
  }
  for (const m of movements) {
    if (!state.queue.some((e) => e.seq === m.seq)) out.push(`${m.id} has no arrival event`);
    if (!alive(m.owner)) out.push(`${m.id} belongs to ${m.owner}, who is out`);
    if (!cityExists(m.home)) out.push(`${m.id} is homed in a missing city`);
  }
  for (const c of cities) {
    for (const it of [...c.build, ...Object.values(c.recruit).flat()]) {
      if (!state.queue.some((e) => e.seq === it.seq)) out.push(`${c.id} #${it.id} has no event`);
    }
    for (const g of c.stationed) {
      if (!alive(g.owner)) out.push(`${c.id} hosts units of ${g.owner}, who is out`);
      if (!cityExists(g.home)) out.push(`${c.id} hosts units homed in a missing city`);
      if (g.home === c.id) out.push(`${c.id} hosts units homed in itself`);
    }
    if (c.owner !== null && !alive(c.owner)) out.push(`${c.id} belongs to ${c.owner}, who is out`);
  }
  for (const q of Object.values(state.proposals)) {
    if (!alive(q.from) || !alive(q.to)) out.push(`proposal ${q.id} involves a player who is out`);
  }
  for (const a of Object.values(state.alliances)) {
    for (const p of a.members) {
      const player = Object.values(state.players).find((x) => x.id === p);
      if (!alive(p) || player?.alliance !== a.id) out.push(`${a.id} lists ${p}`);
    }
  }
  for (const x of state.pacts) {
    if (!alive(x.a) || !alive(x.b)) out.push(`pact ${x.a}|${x.b} involves a player who is out`);
  }
  return out;
}
