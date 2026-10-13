// Fixtures shared by the bots tests: agent rules shaped like perfidia-1 (wall, warships, projected
// requirements) and like sandbox-1 (keep/camp/depot, completed requirements, no wall, no warship,
// `foundSlot`), and a small fake game that answers every tool call with schema-valid results. The
// fake is not an engine: it applies just enough (stock, queues, units, movements) for a turn to stay
// consistent. This file holds no tests of its own; it is named `*.test.ts` so that it stays out of
// the published sources (and out of the boundary scan, which allows ruleset ids in tests).

import { expect } from "bun:test";
import {
  BriefingSchema,
  compareIds,
  JsonObjectSchema,
  MovementIdSchema,
  TOOL_ARGS,
  ToolNameSchema,
  TOOL_RESULT_DATA,
  ToolResultSchema,
  type AgentRules,
  type Briefing,
  type BriefingIncoming,
  type CityId,
  type GatewayRules,
  type IslandId,
  type JsonObject,
  type MovementId,
  type PlayerId,
  type RelationView,
  type Res,
  type RoundInput,
  type RulesInfo,
  type SeatAgent,
  type ToolCall,
  type ToolName,
  type ToolResult,
  type UnitCounts,
  z,
} from "@perfidia/protocol";
import { fmtTime } from "./kit.ts";

export const res = (wood: number, stone: number, gold: number): Res => ({ wood, stone, gold });
export const clone = <T>(v: T): T => structuredClone(v);
const pair = (t: number): [number, string] => [t, fmtTime(t)];
const dur = (s: number): [number, string] => [s, `${s}s`];

// Rules shaped like perfidia-1 (§3–§7, §14 of its spec).

const w = (l: number): number => l * l + 3 * l + 6;

function perfidiaBuilding(
  id: string,
  base: Res,
  baseTime: number,
  requires: Record<string, number>,
): AgentRules["buildings"][number] {
  const cost: Res[] = [res(0, 0, 0)];
  const time: number[][] = [[]];
  for (let l = 1; l <= 10; l += 1) {
    cost.push(
      res(
        Math.floor((base.wood * w(l)) / 10),
        Math.floor((base.stone * w(l)) / 10),
        Math.floor((base.gold * w(l)) / 10),
      ),
    );
    const row: number[] = [];
    for (let h = 0; h <= 10; h += 1) row.push(Math.max(1, Math.floor((baseTime * w(l)) / (9 + h))));
    time.push(row);
  }
  return { id, maxLevel: 10, cost, time, requires };
}

function unitTimes(base: number): number[] {
  const out: number[] = [];
  for (let l = 0; l <= 10; l += 1) out.push(Math.max(1, Math.floor((base * 10) / (9 + l))));
  return out;
}

export const P_GATEWAY: GatewayRules = {
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
  wake: {
    incoming_attack: { party: "urgent", target: "social", ally: "social", stationed: "social" },
    queue_empty: { self: "own" },
    message: { target: "social" },
  },
  publicOncePerDay: ["domination_started"],
};

/** A per-level table `f(0..max)`. */
function table(max: number, f: (l: number) => number): number[] {
  const out: number[] = [];
  for (let l = 0; l <= max; l += 1) out.push(f(l));
  return out;
}

export function perfidiaRules(players = 6): AgentRules {
  const settlerCost: Res[] = [];
  for (let k = 0; k <= 10; k += 1) {
    const m = Math.max(1, k);
    settlerCost.push(res(450 * m, 450 * m, 750 * m));
  }
  return {
    ruleset: "perfidia-1@1.0.0",
    players,
    time: { matchEnd: 604800, attackFrom: 43200, minTravel: 3600 },
    buildings: [
      perfidiaBuilding("hall", res(90, 90, 60), 1800, {}),
      perfidiaBuilding("lumber", res(20, 50, 30), 1500, {}),
      perfidiaBuilding("quarry", res(50, 20, 30), 1500, {}),
      perfidiaBuilding("mine", res(50, 50, 10), 1500, {}),
      perfidiaBuilding("warehouse", res(60, 60, 20), 1200, {}),
      perfidiaBuilding("barracks", res(60, 80, 50), 1500, { hall: 2 }),
      perfidiaBuilding("harbor", res(100, 60, 60), 2400, { hall: 3 }),
      perfidiaBuilding("wall", res(30, 120, 30), 1500, { barracks: 1 }),
    ],
    units: [
      {
        id: "guard",
        domain: "land",
        attack: 5,
        defense: 20,
        naval: 0,
        carry: 10,
        capacity: 0,
        pop: 1,
        cost: res(30, 60, 30),
        queue: "barracks",
        requires: { barracks: 1 },
        time: unitTimes(300),
        maxPerOrder: 500,
      },
      {
        id: "raider",
        domain: "land",
        attack: 20,
        defense: 5,
        naval: 0,
        carry: 50,
        capacity: 0,
        pop: 1,
        cost: res(50, 20, 60),
        queue: "barracks",
        requires: { barracks: 1 },
        time: unitTimes(300),
        maxPerOrder: 500,
      },
      {
        id: "settler",
        domain: "land",
        attack: 0,
        defense: 0,
        naval: 0,
        carry: 0,
        capacity: 0,
        pop: 10,
        cost: res(450, 450, 750),
        queue: "barracks",
        requires: { barracks: 2, hall: 3 },
        time: unitTimes(5400),
        maxPerOrder: 1,
      },
      {
        id: "transport",
        domain: "naval",
        attack: 0,
        defense: 0,
        naval: 0,
        carry: 0,
        capacity: 20,
        pop: 2,
        cost: res(120, 40, 80),
        queue: "harbor",
        requires: { harbor: 1 },
        time: unitTimes(1200),
        maxPerOrder: 500,
      },
      {
        id: "warship",
        domain: "naval",
        attack: 0,
        defense: 0,
        naval: 50,
        carry: 0,
        capacity: 0,
        pop: 4,
        cost: res(150, 100, 250),
        queue: "harbor",
        requires: { harbor: 3 },
        time: unitTimes(2400),
        maxPerOrder: 500,
      },
    ],
    roles: {
      producers: { wood: "lumber", stone: "quarry", gold: "mine" },
      storage: "warehouse",
      population: "hall",
      buildSpeed: "hall",
      wall: "wall",
      settler: "settler",
    },
    levels: {
      production: table(10, (l) => 5 * l * l + 20 * l + 50),
      storage: table(10, (l) => 60 * l * l + 280 * l + 660),
      population: table(10, (l) => 2 * l * l + 20 * l + 40),
    },
    queues: {
      build: { max: 5, requiresOn: "projected" },
      recruit: [
        { id: "barracks", building: "barracks", maxBatches: 5, maxCount: 500 },
        { id: "harbor", building: "harbor", maxBatches: 5, maxCount: 500 },
      ],
      delivery: "trickle",
      refund: {
        build: { queuedPm: 1000, active: "prorata" },
        recruit: { queuedPm: 1000, active: "uncompleted" },
      },
    },
    settlerCost,
    newCity: {
      buildings: { hall: 1, lumber: 1, quarry: 1, mine: 1, warehouse: 1 },
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
      shipment: { base: 500, perLevel: 500, building: "harbor" },
      transportRule: true,
      spyMinGold: 100,
    },
    diplomacy: {
      allianceMax: Math.max(2, Math.floor(players / 3)),
      maxPacts: 2,
      pactDuration: 172800,
      maxOpenProposals: 3,
      proposalTtl: 43200,
      messageMaxChars: 1000,
      proposalTextMaxChars: 300,
      allianceNameMaxChars: 24,
    },
    toolOptions: { foundSlot: false, pactUntil: false },
    gateway: P_GATEWAY,
    travelProbes: [
      { label: "transport", group: { kind: "attack", units: { transport: 1 } } },
      { label: "warship", group: { kind: "attack", units: { warship: 1 } } },
      { label: "spy", group: { kind: "spy", units: {} } },
    ],
    eventClasses: [
      ["build_done"],
      ["recruit_done"],
      ["arrive_return"],
      ["arrive_support"],
      ["arrive_shipment"],
      ["arrive_spy"],
      ["arrive_attack"],
      ["arrive_found"],
      ["siege_end"],
      ["proposal_expire", "pact_expire", "domination_open"],
      ["domination_end"],
      ["match_end"],
    ],
  };
}

// Rules shaped like sandbox-1 (architecture §3.8).

export const S_GATEWAY: GatewayRules = {
  roundTripsPerWake: 6,
  toolCallsPerRoundTrip: 8,
  toolCallsPerWake: 30,
  ownWakesPerDay: 8,
  socialWakesPerDay: 6,
  groupWindow: 300,
  urgentMinGap: 300,
  selfWake: { min: 1800, max: 21600 },
  safetyWake: 21600,
  attackLaunchesPerDay: 10,
  messagesPerDay: 10,
  notesMaxChars: 2000,
  wake: {
    incoming_attack: { party: "urgent", ally: "social" },
    city_conquered: { target: "urgent" },
    queue_empty: { self: "own" },
  },
  publicOncePerDay: [],
};

function sandboxBuilding(
  id: string,
  requires: Record<string, number>,
): AgentRules["buildings"][number] {
  const cost: Res[] = [res(0, 0, 0)];
  const time: number[][] = [[]];
  for (let l = 1; l <= 8; l += 1) {
    cost.push(res(30 * l, 30 * l, 10 * l));
    time.push([600 * l]);
  }
  return { id, maxLevel: 8, cost, time, requires };
}

function sandboxUnit(
  id: string,
  domain: "land" | "naval",
  stats: { attack: number; defense: number; carry: number; capacity: number; pop: number },
  cost: Res,
  queue: string,
  requires: Record<string, number>,
  time: number,
  maxPerOrder: number,
): AgentRules["units"][number] {
  return {
    id,
    domain,
    attack: stats.attack,
    defense: stats.defense,
    naval: 0,
    carry: stats.carry,
    capacity: stats.capacity,
    pop: stats.pop,
    cost,
    queue,
    requires,
    time: table(8, () => time),
    maxPerOrder,
  };
}

export function sandboxRules(players = 6): AgentRules {
  const settlerCost: Res[] = [];
  for (let k = 0; k <= 6; k += 1) {
    const m = Math.max(1, k);
    settlerCost.push(res(300 * m, 300 * m, 300 * m));
  }
  return {
    ruleset: "sandbox-1@1.0.0",
    players,
    time: { matchEnd: 604800, attackFrom: 21600, minTravel: 4800 },
    buildings: [
      sandboxBuilding("keep", {}),
      sandboxBuilding("sawmill", {}),
      sandboxBuilding("pit", {}),
      sandboxBuilding("forge", {}),
      sandboxBuilding("depot", {}),
      sandboxBuilding("camp", { keep: 2 }),
      sandboxBuilding("docks", { keep: 2 }),
    ],
    units: [
      sandboxUnit(
        "spearman",
        "land",
        { attack: 5, defense: 15, carry: 10, capacity: 0, pop: 1 },
        res(20, 30, 20),
        "camp",
        { camp: 1 },
        240,
        300,
      ),
      sandboxUnit(
        "axeman",
        "land",
        { attack: 15, defense: 5, carry: 25, capacity: 0, pop: 1 },
        res(30, 20, 25),
        "camp",
        { camp: 1 },
        240,
        300,
      ),
      sandboxUnit(
        "colonist",
        "land",
        { attack: 0, defense: 0, carry: 0, capacity: 0, pop: 5 },
        res(300, 300, 300),
        "camp",
        { camp: 2 },
        3600,
        1,
      ),
      sandboxUnit(
        "boat",
        "naval",
        { attack: 0, defense: 0, carry: 0, capacity: 15, pop: 2 },
        res(100, 30, 50),
        "docks",
        { docks: 1 },
        900,
        300,
      ),
    ],
    roles: {
      producers: { wood: "sawmill", stone: "pit", gold: "forge" },
      storage: "depot",
      population: "keep",
      buildSpeed: null,
      wall: null,
      settler: "colonist",
    },
    levels: {
      production: table(8, (l) => (l === 0 ? 20 : 40 + 40 * l)),
      storage: table(8, (l) => 800 + 700 * l),
      population: table(8, (l) => 50 + 40 * l),
    },
    queues: {
      build: { max: 4, requiresOn: "completed" },
      recruit: [
        { id: "camp", building: "camp", maxBatches: 4, maxCount: 300 },
        { id: "docks", building: "docks", maxBatches: 4, maxCount: 300 },
      ],
      delivery: "batch",
      refund: {
        build: { queuedPm: 1000, active: { pm: 500 } },
        recruit: { queuedPm: 1000, active: { pm: 500 } },
      },
    },
    settlerCost,
    newCity: {
      buildings: { keep: 1, sawmill: 1, pit: 1, forge: 1, depot: 1 },
      stock: res(200, 200, 200),
      units: {},
    },
    neutralProduction: false,
    movement: {
      recall: { window: 900, kinds: ["support"], stationed: "whole", dismiss: false },
      shipment: { base: 300, perLevel: 300, building: "docks" },
      transportRule: true,
      spyMinGold: 50,
    },
    diplomacy: {
      allianceMax: 3,
      maxPacts: 1,
      pactDuration: null,
      maxOpenProposals: 2,
      proposalTtl: 21600,
      messageMaxChars: 500,
      proposalTextMaxChars: 200,
      allianceNameMaxChars: 16,
    },
    toolOptions: { foundSlot: true, pactUntil: false },
    gateway: S_GATEWAY,
    travelProbes: [{ label: "any", group: { kind: "attack", units: {} } }],
    eventClasses: [
      ["build_done", "recruit_done"],
      ["arrive_return", "arrive_support", "arrive_shipment", "arrive_found"],
      ["arrive_spy"],
      ["arrive_attack"],
      ["proposal_expire", "pact_expire", "hill_open"],
      ["match_end"],
    ],
  };
}

const HEX = "0123456789abcdef";
/** A deterministic 64-hex config hash for a label. */
export function fakeHash(label: string): string {
  let out = "";
  let h = 7;
  for (let i = 0; out.length < 64; i += 1) {
    h = (h * 31 + label.charCodeAt(i % Math.max(1, label.length)) + i) % 65521;
    out += HEX[h % 16];
  }
  return out;
}

export function rulesInfo(rules: AgentRules, label = "default"): RulesInfo {
  return {
    ruleset: rules.ruleset,
    title: rules.ruleset,
    configHash: fakeHash(`${rules.ruleset}:${label}`),
    rulesHash: fakeHash(`${rules.ruleset}:${label}:rules`),
    interface: "Interface rules (bots never read this text).",
    cheatSheet: "Cheat sheet.",
    config: {},
    rules,
    extraTools: [],
  };
}

// The fake game.

export interface FIsland {
  readonly id: IslandId;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly richnessPm: number;
  readonly slots: number;
}

export interface FCity {
  id: CityId;
  owner: PlayerId | null;
  island: IslandId;
  slot: number;
  capitalOf: PlayerId | null;
  tag: string | null;
  levels: Record<string, number>;
  stock: Res;
  units: Record<string, number>;
  stationed: { owner: PlayerId; home: CityId; role: "support" | "hold"; units: UnitCounts }[];
  build: { item: number; building: string; level: number; start: number; end: number }[];
  recruit: Record<
    string,
    { item: number; unit: string; count: number; start: number; end: number }[]
  >;
  itemSeq: number;
  ext: JsonObject;
}

export interface FMove {
  id: MovementId;
  kind: "attack" | "support" | "found" | "spy" | "shipment" | "return";
  owner: PlayerId;
  from: CityId;
  to: CityId | null;
  island: IslandId;
  units: UnitCounts;
  depart: number;
  arrive: number;
  recallableUntil: number | null;
  /** The movement's recorded foe (a relief's: the besieger); null when not given. */
  party?: PlayerId | null;
}

export interface FIntel {
  readonly type: "spy_report" | "battle_report";
  readonly at: number;
  readonly data: JsonObject;
}

const OPAQUE = "0123456789abcdefghjkmnpqrstvwxyz";

export interface Violation {
  readonly seat: PlayerId;
  readonly call: ToolCall;
  readonly issue: string;
}

export class FakeGame {
  t = 0;
  readonly rules: AgentRules;
  readonly info: RulesInfo;
  readonly players: PlayerId[];
  readonly islands: FIsland[];
  readonly cities: FCity[];
  readonly moves: FMove[] = [];
  readonly intel = new Map<string, FIntel>();
  readonly relations = new Map<PlayerId, RelationView[]>();
  readonly alliance = new Map<PlayerId, string>();
  readonly proposals: Briefing["proposals"] = [];
  readonly incoming = new Map<PlayerId, BriefingIncoming[]>();
  readonly notes = new Map<PlayerId, string>();
  readonly ranks = new Map<PlayerId, number>();
  readonly budget = { ownWakesLeft: 12, socialWakesLeft: 8, attacksLeft: 20, messagesLeft: 20 };
  /** Calls the fake refused as malformed (a bot bug when non-empty). */
  readonly violations: Violation[] = [];
  /** Injected failures: return a code to reject the call with it. */
  fail: ((seat: PlayerId, call: ToolCall) => string | null) | null = null;
  private seq = 0;
  private readonly travelOf: (a: FIsland, b: FIsland, probe: number) => number;

  constructor(
    rules: AgentRules,
    islands: FIsland[],
    cities: FCity[],
    travel: (a: FIsland, b: FIsland, probe: number) => number,
  ) {
    this.rules = rules;
    this.info = rulesInfo(rules);
    this.islands = islands;
    this.cities = cities;
    this.travelOf = travel;
    const players: PlayerId[] = [];
    for (let i = 1; i <= rules.players; i += 1) players.push(`p${i}`);
    this.players = players;
    for (const p of players) this.ranks.set(p, Number(p.slice(1)));
  }

  island(id: IslandId): FIsland {
    const isl = this.islands.find((i) => i.id === id);
    if (isl === undefined) throw new Error(`no island ${id}`);
    return isl;
  }
  city(id: CityId): FCity {
    const c = this.cities.find((x) => x.id === id);
    if (c === undefined) throw new Error(`no city ${id}`);
    return c;
  }
  travel(from: IslandId, to: IslandId, probe: number): number {
    return this.travelOf(this.island(from), this.island(to), probe);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    let n = this.seq;
    let s = "";
    for (let i = 0; i < 5; i += 1) {
      s = OPAQUE[n % 32]! + s;
      n = Math.floor(n / 32);
    }
    return `${prefix}${s}`;
  }

  private cap(c: FCity): number {
    return this.rules.levels.storage[c.levels[this.rules.roles.storage] ?? 0] ?? 0;
  }
  private popCap(c: FCity): number {
    return this.rules.levels.population[c.levels[this.rules.roles.population] ?? 0] ?? 0;
  }
  private popUsed(c: FCity): number {
    let used = 0;
    const pop = (u: string): number => this.rules.units.find((x) => x.id === u)?.pop ?? 0;
    for (const [u, n] of Object.entries(c.units)) used += pop(u) * n;
    for (const q of Object.values(c.recruit)) for (const b of q) used += pop(b.unit) * b.count;
    for (const m of this.moves)
      if (m.from === c.id && m.owner === c.owner)
        for (const [u, n] of Object.entries(m.units)) used += pop(u) * n;
    return used;
  }
  private rate(c: FCity): Res {
    const isl = this.island(c.island);
    const r = (b: string): number =>
      Math.floor(((this.rules.levels.production[c.levels[b] ?? 0] ?? 0) * isl.richnessPm) / 1000);
    const p = this.rules.roles.producers;
    return res(r(p.wood), r(p.stone), r(p.gold));
  }

  briefing(seat: PlayerId, notes?: string, callsPerWake?: number | null): Briefing {
    const own = this.cities
      .filter((c) => c.owner === seat)
      .toSorted((a, b) => compareIds(a.id, b.id));
    const b: Briefing = {
      you: seat,
      t: this.t,
      time: fmtTime(this.t),
      left: dur(Math.max(0, this.rules.time.matchEnd - this.t)),
      ruleset: this.rules.ruleset,
      wake: { urgent: false, reasons: ["self"] },
      lastTurn: null,
      cities: own.map((c) => {
        const rate = this.rate(c);
        const recruit: Record<
          string,
          { item: number; unit: string; n: number; end: [number, string] }[]
        > = {};
        for (const [q, batches] of Object.entries(c.recruit)) {
          if (batches.length > 0)
            recruit[q] = batches.map((x) => ({
              item: x.item,
              unit: x.unit,
              n: x.count,
              end: pair(x.end),
            }));
        }
        const city: Briefing["cities"][number] = {
          id: c.id,
          isl: c.island,
          res: [c.stock.wood, c.stock.stone, c.stock.gold],
          rate: [rate.wood, rate.stone, rate.gold],
          cap: this.cap(c),
          pop: [this.popUsed(c), this.popCap(c)],
          build: c.build.map((x) => ({
            item: x.item,
            b: x.building,
            lvl: x.level,
            end: pair(x.end),
          })),
          recruit,
          units: { ...c.units },
          stationed: c.stationed.length,
        };
        if (Object.keys(c.ext).length > 0) city.ext = c.ext;
        return city;
      }),
      incoming: this.incoming.get(seat) ?? [],
      moves: this.moves
        .filter((m) => m.owner === seat)
        .map((m) => ({ id: m.id, kind: m.kind, to: m.to, arrive: pair(m.arrive) })),
      msgs: [],
      proposals: this.proposals.filter((p) => p.from === seat || p.to === seat),
      events: [],
      news: [],
      notes: notes ?? this.notes.get(seat) ?? "",
      budget: {
        roundTrips: this.rules.gateway.roundTripsPerWake,
        callsPerRoundTrip: this.rules.gateway.toolCallsPerRoundTrip,
        callsPerWake:
          callsPerWake === undefined ? this.rules.gateway.toolCallsPerWake : callsPerWake,
        ownWakesLeft: this.budget.ownWakesLeft,
        socialWakesLeft: this.budget.socialWakesLeft,
        selfWakeAt: null,
        attacksLeft: this.budget.attacksLeft,
        messagesLeft: this.budget.messagesLeft,
      },
      ext: {},
    };
    return BriefingSchema.parse(b);
  }

  private err(
    code: string,
    details?: Record<string, number | string | boolean | null>,
  ): ToolResult {
    const out: ToolResult = {
      ok: false,
      t: this.t,
      code,
      message: `${code} (fake)`,
      hint: "fake hint",
    };
    if (details !== undefined) out.details = details;
    return out;
  }

  private ok(tool: ToolName, data: JsonObject): ToolResult {
    TOOL_RESULT_DATA[tool].parse(data);
    return { ok: true, t: this.t, data };
  }

  /** Answers a call as the gateway would (layers 1–6 much simplified). */
  respond(seat: PlayerId, c: ToolCall): ToolResult {
    const out = this.answer(seat, c);
    return ToolResultSchema.parse(out);
  }

  private answer(seat: PlayerId, c: ToolCall): ToolResult {
    if (!Object.hasOwn(TOOL_ARGS, c.tool)) {
      this.violations.push({ seat, call: c, issue: "unknown tool" });
      return this.err("INVALID_ARGS");
    }
    const tool = ToolNameSchema.parse(c.tool);
    const parsed = TOOL_ARGS[tool].safeParse(c.args);
    if (!parsed.success) {
      this.violations.push({ seat, call: c, issue: parsed.error.message });
      return this.err("INVALID_ARGS");
    }
    const injected = this.fail?.(seat, c) ?? null;
    if (injected !== null) return this.err(injected, { availableAt: this.t + 1800 });
    switch (tool) {
      case "rules":
        return this.ok(tool, JsonObjectSchema.parse(this.info));
      case "view_player":
        return this.viewPlayer(seat, TOOL_ARGS.view_player.parse(c.args).player);
      case "view_map":
        return this.viewMap(seat, TOOL_ARGS.view_map.parse(c.args).fromCity);
      case "view_city":
        return this.viewCity(seat, TOOL_ARGS.view_city.parse(c.args).city);
      case "leaderboard":
        return this.ok(tool, {
          standings: this.players.map((p) => ({
            rank: this.ranks.get(p) ?? 1,
            player: p,
            score: 100,
            parts: { cityPoints: 100 },
            cities: this.cities.filter((x) => x.owner === p).length,
            alive: true,
            alliance: this.alliance.get(p) ?? null,
            relations: [],
          })),
          ext: {},
        });
      case "build":
        return this.build(seat, TOOL_ARGS.build.parse(c.args));
      case "recruit":
        return this.recruit(seat, TOOL_ARGS.recruit.parse(c.args));
      case "cancel_queue": {
        const a = TOOL_ARGS.cancel_queue.parse(c.args);
        const city = this.city(a.city);
        if (city.owner !== seat) return this.err("NOT_OWNER");
        const removed = city.build.filter((x) => x.item >= a.item).map((x) => x.item);
        if (removed.length === 0) return this.err("QUEUE_ITEM", { city: a.city, item: a.item });
        city.build = city.build.filter((x) => x.item < a.item);
        return this.ok(tool, { city: a.city, removed, refund: res(0, 0, 0), lost: res(0, 0, 0) });
      }
      case "attack":
      case "support":
      case "spy":
      case "found_city":
      case "send_resources":
        return this.launch(seat, tool, c.args);
      case "recall_troops": {
        const a = TOOL_ARGS.recall_troops.parse(c.args);
        if (a.stationedAt !== undefined) {
          const at = this.city(a.stationedAt);
          const mine = at.stationed.filter((g) => g.owner === seat);
          if (mine.length === 0) return this.err("UNKNOWN_ID");
          at.stationed = at.stationed.filter((g) => g.owner !== seat);
          return this.ok(tool, { returns: [] });
        }
        const m = this.moves.find((x) => x.id === a.movement && x.owner === seat);
        if (m === undefined) return this.err("UNKNOWN_ID");
        m.kind = "return";
        return this.ok(tool, {
          returns: [{ movement: m.id, home: m.from, arrive: pair(this.t + 600) }],
        });
      }
      case "send_message":
        this.budget.messagesLeft -= 1;
        return this.ok(tool, { message: this.nextId("g") });
      case "propose_alliance":
        return this.ok(tool, {
          proposal: this.nextId("q"),
          expires: pair(this.t + this.rules.diplomacy.proposalTtl),
        });
      case "answer_proposal": {
        const a = TOOL_ARGS.answer_proposal.parse(c.args);
        return this.ok(tool, { proposal: a.id, accept: a.accept });
      }
      case "leave_alliance":
        return this.ok(tool, {});
      case "write_note": {
        const a = TOOL_ARGS.write_note.parse(c.args);
        const max = this.rules.gateway.notesMaxChars;
        const text = a.mode === "replace" ? a.text : (this.notes.get(seat) ?? "") + a.text;
        if (text.length > max) {
          this.violations.push({
            seat,
            call: c,
            issue: `note of ${text.length} chars over ${max}`,
          });
          return this.err("NOTE_TOO_LONG");
        }
        this.notes.set(seat, text);
        return this.ok(tool, { chars: text.length, max });
      }
      case "read_notes":
        return this.ok(tool, { notes: this.notes.get(seat) ?? "" });
      case "view_island":
        return this.err("UNKNOWN_ID");
      case "end_turn": {
        const a = TOOL_ARGS.end_turn.parse(c.args);
        const { min, max } = this.rules.gateway.selfWake;
        const want = a.wakeAt ?? (a.nextWakeIn === undefined ? null : this.t + a.nextWakeIn);
        if (want === null) return this.ok(tool, { wakeAt: null, clamped: false });
        const at = Math.min(this.t + max, Math.max(this.t + min, want));
        return this.ok(tool, { wakeAt: pair(at), clamped: at !== want });
      }
    }
    return this.err("INVALID_ARGS");
  }

  private viewPlayer(seat: PlayerId, player: PlayerId): ToolResult {
    const cities = this.cities
      .filter((c) => c.owner === player)
      .map((c) => c.id)
      .toSorted(compareIds);
    const relations = this.relations.get(player) ?? [];
    const rel =
      player === seat
        ? "self"
        : (this.relations.get(seat)?.find((r) => r.player === player)?.kind ?? "none");
    const data: JsonObject = {
      id: player,
      alive: true,
      eliminatedAt: null,
      alliance: this.alliance.get(player) ?? null,
      cities,
      score: 100 * cities.length,
      parts: { cityPoints: 100 * cities.length },
      relations: relations.map((r) => ({ player: r.player, kind: r.kind, until: r.until })),
      relation: rel,
      ext: {},
    };
    if (player === seat) {
      const k = cities.length;
      const cost = this.rules.settlerCost[Math.min(k, this.rules.settlerCost.length - 1)]!;
      data["private"] = {
        movements: this.moves
          .filter((m) => m.owner === seat)
          .map((m) => ({
            id: m.id,
            kind: m.kind,
            access: "own",
            owner: m.owner,
            from: m.from,
            to: m.to,
            party: m.party ?? null,
            depart: pair(m.depart),
            arrive: pair(m.arrive),
            units: m.units,
            recallableUntil: m.recallableUntil === null ? null : pair(m.recallableUntil),
          })),
        stationed: this.cities.flatMap((c) =>
          c.stationed
            .filter((g) => g.owner === seat)
            .map((g) => ({ city: c.id, role: g.role, home: g.home, units: g.units })),
        ),
        settler: { k, cost },
        proposals: [],
        today: {
          day: Math.floor(this.t / 86400),
          ownWakes: 0,
          socialWakes: 0,
          attacks: 0,
          messages: 0,
        },
        selfWakeAt: null,
      };
    }
    return this.ok("view_player", data);
  }

  private viewMap(seat: PlayerId, fromCity: CityId | undefined): ToolResult {
    const data: JsonObject = {
      islands: this.islands.map((i) => ({
        id: i.id,
        kind: i.kind,
        x: i.x,
        y: i.y,
        richnessPm: i.richnessPm,
        slots: i.slots,
        free: i.slots - this.cities.filter((c) => c.island === i.id).length,
      })),
      cities: this.cities.map((c) => ({
        id: c.id,
        island: c.island,
        slot: c.slot,
        owner: c.owner,
        capitalOf: c.capitalOf,
      })),
    };
    if (fromCity !== undefined) {
      const from = this.cities.find((c) => c.id === fromCity);
      if (from === undefined || from.owner !== seat) return this.err("UNKNOWN_ID");
      const travel: JsonObject = {};
      for (const i of this.islands) {
        travel[i.id] = this.rules.travelProbes.map((_, p) => {
          const s = this.travel(from.island, i.id, p);
          return [s, `${s}s`];
        });
      }
      data["from"] = fromCity;
      data["probes"] = this.rules.travelProbes.map((p) => p.label);
      data["travel"] = travel;
    }
    return this.ok("view_map", data);
  }

  private sees(seat: PlayerId, c: FCity): boolean {
    if (c.owner === seat) return true;
    return (
      c.owner !== null &&
      (this.relations.get(seat) ?? []).some((r) => r.player === c.owner && r.kind === "ally")
    );
  }

  private viewCity(seat: PlayerId, id: CityId): ToolResult {
    const c = this.cities.find((x) => x.id === id);
    if (c === undefined) return this.err("UNKNOWN_ID");
    const common = {
      id: c.id,
      name: c.id,
      owner: c.owner,
      island: c.island,
      slot: c.slot,
      capitalOf: c.capitalOf,
      tag: c.tag,
      ext: c.ext,
    };
    if (this.sees(seat, c)) {
      const recruit: JsonObject = {};
      for (const [q, batches] of Object.entries(c.recruit)) {
        recruit[q] = batches.map((b) => ({
          item: b.item,
          unit: b.unit,
          count: b.count,
          done: 0,
          start: pair(b.start),
          end: pair(b.end),
        }));
      }
      return this.ok("view_city", {
        access: "full",
        ...common,
        stock: c.stock,
        rates: this.rate(c),
        cap: this.cap(c),
        pop: { used: this.popUsed(c), cap: this.popCap(c) },
        buildings: c.levels,
        build: c.build.map((b) => ({
          item: b.item,
          building: b.building,
          level: b.level,
          start: pair(b.start),
          end: pair(b.end),
        })),
        recruit,
        units: c.units,
        stationed: c.stationed,
        incoming: [],
      });
    }
    const intel = this.intel.get(`${seat}|${id}`);
    return this.ok("view_city", {
      access: "public",
      ...common,
      intel:
        intel === undefined
          ? null
          : {
              report: this.nextId("r"),
              type: intel.type,
              at: pair(intel.at),
              age: dur(Math.max(0, this.t - intel.at)),
              data: intel.data,
            },
    });
  }

  private build(seat: PlayerId, a: { city: CityId; buildings: string[] }): ToolResult {
    const c = this.cities.find((x) => x.id === a.city);
    if (c === undefined || c.owner !== seat)
      return this.err(c === undefined ? "UNKNOWN_ID" : "NOT_OWNER");
    const items: JsonObject[] = [];
    for (const b of a.buildings) {
      const row = this.rules.buildings.find((x) => x.id === b);
      const queued = c.build.filter((x) => x.building === b).length;
      const level = (c.levels[b] ?? 0) + queued + 1;
      const cost = row?.cost[level];
      if (row === undefined || cost === undefined || level > row.maxLevel) {
        items.push({ ok: false, code: "MAX_LEVEL", message: "fake", hint: "fake" });
        continue;
      }
      if (c.build.length >= this.rules.queues.build.max) {
        items.push({ ok: false, code: "QUEUE_FULL", message: "fake", hint: "fake" });
        continue;
      }
      if (c.stock.wood < cost.wood || c.stock.stone < cost.stone || c.stock.gold < cost.gold) {
        items.push({
          ok: false,
          code: "INSUFFICIENT_RESOURCES",
          message: "fake",
          hint: "fake",
          details: { availableAt: this.t + 3600 },
        });
        continue;
      }
      c.stock = res(c.stock.wood - cost.wood, c.stock.stone - cost.stone, c.stock.gold - cost.gold);
      const start = Math.max(this.t, c.build.at(-1)?.end ?? this.t);
      const end = start + 1800 * level;
      c.itemSeq += 1;
      c.build.push({ item: c.itemSeq, building: b, level, start, end });
      items.push({ ok: true, item: c.itemSeq, building: b, level, end: pair(end), cost });
    }
    return this.ok("build", { items });
  }

  private recruit(
    seat: PlayerId,
    a: { city: CityId; orders: { unit: string; count: number | "max" }[] },
  ): ToolResult {
    const c = this.cities.find((x) => x.id === a.city);
    if (c === undefined || c.owner !== seat)
      return this.err(c === undefined ? "UNKNOWN_ID" : "NOT_OWNER");
    const items: JsonObject[] = [];
    for (const o of a.orders) {
      const row = this.rules.units.find((x) => x.id === o.unit);
      if (row === undefined) {
        items.push({ ok: false, code: "UNKNOWN_ID", message: "fake", hint: "fake" });
        continue;
      }
      const each = row.cost;
      const afford = Math.min(
        each.wood > 0 ? Math.floor(c.stock.wood / each.wood) : 1_000_000,
        each.stone > 0 ? Math.floor(c.stock.stone / each.stone) : 1_000_000,
        each.gold > 0 ? Math.floor(c.stock.gold / each.gold) : 1_000_000,
      );
      const count = o.count === "max" ? Math.min(afford, row.maxPerOrder) : o.count;
      if (count <= 0 || count > afford) {
        items.push({
          ok: false,
          code: "INSUFFICIENT_RESOURCES",
          message: "fake",
          hint: "fake",
          details: { availableAt: this.t + 1800 },
        });
        continue;
      }
      c.stock = res(
        c.stock.wood - each.wood * count,
        c.stock.stone - each.stone * count,
        c.stock.gold - each.gold * count,
      );
      const q = (c.recruit[row.queue] ??= []);
      const start = Math.max(this.t, q.at(-1)?.end ?? this.t);
      const end = start + 300 * count;
      c.itemSeq += 1;
      q.push({ item: c.itemSeq, unit: o.unit, count, start, end });
      items.push({
        ok: true,
        item: c.itemSeq,
        unit: o.unit,
        count,
        end: pair(end),
        cost: res(each.wood * count, each.stone * count, each.gold * count),
      });
    }
    return this.ok("recruit", { items });
  }

  private launch(
    seat: PlayerId,
    tool: "attack" | "support" | "spy" | "found_city" | "send_resources",
    args: unknown,
  ): ToolResult {
    let from: CityId;
    let to: CityId | null = null;
    let island: IslandId;
    let units: UnitCounts = {};
    let kind: FMove["kind"];
    let probe = 0;
    if (tool === "found_city") {
      const a = TOOL_ARGS.found_city.parse(args);
      from = a.from;
      island = a.island;
      units = a.units;
      kind = "found";
    } else if (tool === "spy") {
      const a = TOOL_ARGS.spy.parse(args);
      from = a.from;
      to = a.to;
      island = this.city(a.to).island;
      kind = "spy";
      probe = this.rules.travelProbes.length - 1;
      const c = this.city(a.from);
      if (c.stock.gold < a.gold) return this.err("INSUFFICIENT_RESOURCES");
      c.stock = res(c.stock.wood, c.stock.stone, c.stock.gold - a.gold);
    } else if (tool === "send_resources") {
      const a = TOOL_ARGS.send_resources.parse(args);
      from = a.from;
      to = a.to;
      island = this.city(a.to).island;
      kind = "shipment";
    } else {
      const a = tool === "attack" ? TOOL_ARGS.attack.parse(args) : TOOL_ARGS.support.parse(args);
      from = a.from;
      to = a.to;
      island = this.city(a.to).island;
      units = a.units;
      kind = tool === "attack" ? "attack" : "support";
      if (tool === "attack") {
        if (this.t < this.rules.time.attackFrom)
          return this.err("ATTACK_PROTECTION", { availableAt: this.rules.time.attackFrom });
        this.budget.attacksLeft -= 1;
      }
    }
    const c = this.cities.find((x) => x.id === from);
    if (c === undefined || c.owner !== seat) return this.err("NOT_OWNER");
    for (const [u, n] of Object.entries(units)) {
      if ((c.units[u] ?? 0) < n) {
        this.violations.push({
          seat,
          call: { tool, args },
          issue: `${n} ${u} requested, ${c.units[u] ?? 0} at home`,
        });
        return this.err("INSUFFICIENT_UNITS", { unit: u, requested: n, home: c.units[u] ?? 0 });
      }
    }
    for (const [u, n] of Object.entries(units)) {
      c.units[u] = (c.units[u] ?? 0) - n;
      if (c.units[u] === 0) delete c.units[u];
    }
    const id = MovementIdSchema.parse(this.nextId("m"));
    const arrive = this.t + this.travel(c.island, island, probe);
    const recallable = kind === "attack" || kind === "support" || kind === "found";
    this.moves.push({
      id,
      kind,
      owner: seat,
      from,
      to,
      island,
      units,
      depart: this.t,
      arrive,
      recallableUntil: recallable ? this.t + 600 : null,
    });
    return this.ok(tool, { movement: id, arrive: pair(arrive) });
  }
}

/**
 * Moves the fake to game time `to`: production (capped by storage), completed build items and
 * recruit batches, and arrived movements (foundings create a city in the lowest free slot; returns
 * bring their units home; a spy always succeeds and files a spy report of the units at home;
 * everything else simply ends).
 */
export function advance(game: FakeGame, to: number): void {
  const dt = Math.max(0, to - game.t);
  const rules = game.rules;
  for (const c of game.cities) {
    if (c.owner === null) continue;
    const isl = game.island(c.island);
    const cap = rules.levels.storage[c.levels[rules.roles.storage] ?? 0] ?? 0;
    const p = rules.roles.producers;
    const add = (b: string): number =>
      Math.floor(
        (Math.floor(((rules.levels.production[c.levels[b] ?? 0] ?? 0) * isl.richnessPm) / 1000) *
          dt) /
          3600,
      );
    c.stock = res(
      Math.min(cap, c.stock.wood + add(p.wood)),
      Math.min(cap, c.stock.stone + add(p.stone)),
      Math.min(cap, c.stock.gold + add(p.gold)),
    );
    for (const b of c.build.filter((x) => x.end <= to))
      c.levels[b.building] = (c.levels[b.building] ?? 0) + 1;
    c.build = c.build.filter((x) => x.end > to);
    for (const [q, batches] of Object.entries(c.recruit)) {
      for (const b of batches.filter((x) => x.end <= to))
        c.units[b.unit] = (c.units[b.unit] ?? 0) + b.count;
      c.recruit[q] = batches.filter((x) => x.end > to);
    }
  }
  for (const m of game.moves.filter((x) => x.arrive <= to)) {
    const home = game.city(m.from);
    if (m.kind === "spy" && m.to !== null) {
      const target = game.city(m.to);
      game.intel.set(`${m.owner}|${m.to}`, {
        type: "spy_report",
        at: m.arrive,
        data: { report: "r00000", city: m.to, units: { home: { ...target.units } } },
      });
      continue;
    }
    if (m.kind === "found") {
      const isl = game.island(m.island);
      const used = new Set(game.cities.filter((c) => c.island === isl.id).map((c) => c.slot));
      let slot = -1;
      for (let s = 0; s < isl.slots; s += 1) {
        if (!used.has(s)) {
          slot = s;
          break;
        }
      }
      if (slot >= 0) {
        const units = { ...m.units };
        units[rules.roles.settler] = (units[rules.roles.settler] ?? 1) - 1;
        if (units[rules.roles.settler] === 0) delete units[rules.roles.settler];
        const id: CityId = `c${game.cities.length + 1}`;
        const city = capital(
          id,
          m.owner,
          isl.id,
          rules.newCity.buildings,
          rules.newCity.stock,
          units,
        );
        city.slot = slot;
        city.capitalOf = null;
        game.cities.push(city);
        continue;
      }
    }
    if (m.kind === "return" || m.kind === "found") {
      for (const [u, n] of Object.entries(m.units)) home.units[u] = (home.units[u] ?? 0) + n;
    }
  }
  game.moves.splice(0, game.moves.length, ...game.moves.filter((x) => x.arrive > to));
  game.t = to;
}

// Map builders.

/** isqrt for test geometry (exact for the small values used). */
function isqrt(n: number): number {
  let s = Math.floor(Math.sqrt(n));
  while (s * s > n) s -= 1;
  while ((s + 1) * (s + 1) <= n) s += 1;
  return s;
}

const PACES = [60, 45, 30];

export function capital(
  id: CityId,
  owner: PlayerId,
  island: IslandId,
  levels: Record<string, number>,
  stock: Res,
  units: Record<string, number>,
): FCity {
  return {
    id,
    owner,
    island,
    slot: 0,
    capitalOf: owner,
    tag: null,
    levels: { ...levels },
    stock,
    units: { ...units },
    stationed: [],
    build: [],
    recruit: {},
    itemSeq: 0,
    ext: {},
  };
}

export const P_START = {
  hall: 1,
  lumber: 1,
  quarry: 1,
  mine: 1,
  warehouse: 1,
  barracks: 0,
  harbor: 0,
  wall: 0,
};

/**
 * A perfidia-1-shaped game: the Crown in the middle, and per seat a home island (2 slots), a
 * backyard (1), a frontier (2, ×1.5) and an inner island (1, ×1.25) on a line of sectors 180 tiles
 * apart. Capitals c1..cN start as in perfidia-1 §3; the Crown is c(N+1), neutral, tagged `crown`.
 */
export function perfidiaGame(players = 6): FakeGame {
  const rules = perfidiaRules(players);
  const islands: FIsland[] = [
    { id: "i1", kind: "crown", x: 90 * players, y: 300, richnessPm: 1500, slots: 1 },
  ];
  const cities: FCity[] = [];
  for (let k = 0; k < players; k += 1) {
    const base = 2 + 4 * k;
    islands.push(
      { id: `i${base}`, kind: "home", x: 180 * k, y: 0, richnessPm: 1000, slots: 2 },
      { id: `i${base + 1}`, kind: "backyard", x: 180 * k, y: -80, richnessPm: 1000, slots: 1 },
      { id: `i${base + 2}`, kind: "frontier", x: 180 * k + 90, y: 20, richnessPm: 1500, slots: 2 },
      { id: `i${base + 3}`, kind: "inner", x: 180 * k + 90, y: 100, richnessPm: 1250, slots: 1 },
    );
    cities.push(
      capital(`c${k + 1}`, `p${k + 1}`, `i${base}`, P_START, res(800, 800, 800), { guard: 10 }),
    );
  }
  const crown = capital(`c${players + 1}`, "p1", "i1", {}, res(3000, 3000, 3000), {
    guard: 400,
    warship: 10,
  });
  crown.owner = null;
  crown.capitalOf = null;
  crown.tag = "crown";
  crown.levels = {
    hall: 5,
    lumber: 5,
    quarry: 5,
    mine: 5,
    warehouse: 5,
    barracks: 5,
    harbor: 5,
    wall: 5,
  };
  cities.push(crown);
  return new FakeGame(rules, islands, cities, (a, b, probe) => {
    if (a.id === b.id) return 3600;
    const d2 = (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
    const pace = PACES[probe] ?? 60;
    return Math.max(3600, isqrt(pace * pace * d2));
  });
}

export const S_START = { keep: 1, sawmill: 1, pit: 1, forge: 1, depot: 1, camp: 0, docks: 0 };

/** A sandbox-1-shaped game (architecture §3.8): per seat a home island and a shared island, 2 slots each. */
export function sandboxGame(players = 6): FakeGame {
  const rules = sandboxRules(players);
  const islands: FIsland[] = [];
  const cities: FCity[] = [];
  for (let k = 0; k < players; k += 1) {
    islands.push(
      { id: `i${2 * k + 1}`, kind: "home", x: 40 * k, y: 0, richnessPm: 1000, slots: 2 },
      { id: `i${2 * k + 2}`, kind: "shared", x: 40 * k + 20, y: 15, richnessPm: 1500, slots: 2 },
    );
    cities.push(
      capital(`c${k + 1}`, `p${k + 1}`, `i${2 * k + 1}`, S_START, res(500, 500, 500), {
        spearman: 8,
      }),
    );
  }
  const width = 40 * players;
  return new FakeGame(rules, islands, cities, (a, b) => {
    if (a.id === b.id) return 4800;
    const dx = Math.abs(a.x - b.x);
    return 4800 + 60 * (Math.min(dx, width - dx) + Math.abs(a.y - b.y));
  });
}

// Driving a bot through one turn.

export interface TurnLog {
  readonly rounds: readonly (readonly ToolCall[])[];
  readonly calls: readonly ToolCall[];
  readonly results: readonly ToolResult[];
  readonly thoughts: readonly string[];
  /** The `wakeAt` of the last `end_turn`, or null when the turn ended without one. */
  readonly wakeAt: number | null;
  readonly endedBy: "end_turn" | "empty_round" | "round_cap";
}

export interface TurnOptions {
  readonly turn?: number;
  readonly maxRounds?: number;
  readonly maxCalls?: number;
  readonly perWake?: number | null;
  readonly notes?: string;
  /**
   * Game seconds that pass while the bot thinks in each round, before its calls are applied (real
   * time with think time, §9.3); 0 (lockstep) by default.
   */
  readonly thinkSeconds?: number;
}

/**
 * Plays one turn of `bot` for `seat` against `game` the way the gateway's turn rules do (§8.3): the
 * caps, the order of calls, `end_turn` ending the turn after its round, `TURN_OVER` for calls after
 * it. Every call must parse with its tool schema and fit the round's cap (checked with `expect`).
 */
export async function playTurn(
  bot: SeatAgent,
  game: FakeGame,
  seat: PlayerId,
  o: TurnOptions = {},
): Promise<TurnLog> {
  const gw = game.rules.gateway;
  const maxRounds = o.maxRounds ?? gw.roundTripsPerWake;
  const perRound = o.maxCalls ?? gw.toolCallsPerRoundTrip;
  const perWake = o.perWake === undefined ? gw.toolCallsPerWake : o.perWake;
  const briefing = game.briefing(seat, o.notes, perWake);
  const rounds: ToolCall[][] = [];
  const all: ToolCall[] = [];
  const allResults: ToolResult[] = [];
  const thoughts: string[] = [];
  let results: ToolResult[] = [];
  let used = 0;
  let wakeAt: number | null = null;
  let endedBy: TurnLog["endedBy"] = "round_cap";
  for (let round = 0; round < maxRounds; round += 1) {
    const maxCalls = Math.max(0, Math.min(perRound, perWake === null ? perRound : perWake - used));
    const input: RoundInput = {
      seat,
      turn: o.turn ?? 1,
      round,
      maxRounds,
      maxCalls,
      briefing: clone(briefing),
      results: clone(results),
    };
    // oxlint-disable-next-line no-await-in-loop -- a round needs the previous round's results
    const out = await bot.round(input);
    expect(out.calls.length).toBeLessThanOrEqual(maxCalls);
    if (out.thought !== undefined) thoughts.push(out.thought);
    rounds.push([...out.calls]);
    if (out.calls.length === 0) {
      endedBy = "empty_round";
      break;
    }
    results = [];
    let ended = false;
    if ((o.thinkSeconds ?? 0) > 0) advance(game, game.t + (o.thinkSeconds ?? 0));
    for (const c of out.calls) {
      all.push(c);
      const schema = (TOOL_ARGS as Record<string, (typeof TOOL_ARGS)[ToolName]>)[c.tool];
      expect(
        schema === undefined ? `unknown tool ${c.tool}` : schema.safeParse(c.args).success,
      ).toBe(true);
      let r: ToolResult;
      if (ended) r = { ok: false, t: game.t, code: "TURN_OVER", message: "fake", hint: "fake" };
      else r = game.respond(seat, c);
      results.push(r);
      allResults.push(r);
      if (c.tool === "end_turn") {
        const a = TOOL_ARGS.end_turn.safeParse(c.args);
        if (a.success && a.data.wakeAt !== undefined) wakeAt = a.data.wakeAt;
        if (r.ok) ended = true;
      }
    }
    used += out.calls.length;
    if (ended) {
      endedBy = "end_turn";
      break;
    }
  }
  return { rounds, calls: all, results: allResults, thoughts, wakeAt, endedBy };
}

const Args = z.record(z.string(), z.unknown());

/** The calls of a turn to `tool`, with their args. */
export function callsTo(log: TurnLog, tool: ToolName): Record<string, unknown>[] {
  return log.calls.filter((c) => c.tool === tool).map((c) => Args.parse(c.args));
}

/** Typed reads of call arguments (they throw, failing the test, on another shape). */
export const str = (v: unknown): string => z.string().parse(v);
export const strs = (v: unknown): string[] => z.array(z.string()).parse(v);
export const counts = (v: unknown): Record<string, number> =>
  z.record(z.string(), z.int()).parse(v);

/** Runs `step` on each item in order: turns and rounds depend on the previous ones. */
export async function inSequence<T>(
  items: readonly T[],
  step: (item: T, i: number) => Promise<void>,
): Promise<void> {
  for (const [i, item] of items.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- each step needs the state the previous one left
    await step(item, i);
  }
}

/** `1..n`. */
export function upTo(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i + 1);
}
