// Valid fixtures shared by the protocol tests. This file holds no tests of its own; it is named
// `*.test.ts` so that it stays out of the published sources and gets the test tsconfig and lint.

import type {
  Action,
  AgentRules,
  Briefing,
  City,
  CompiledRules,
  DomainEvent,
  GameState,
  GatewayRules,
  JsonObject,
  LogLine,
  LogLineKind,
  MatchResult,
  MatchSetup,
  Movement,
  Res,
  Snapshot,
  StandardEventType,
  ToolName,
} from "./index.ts";

export const res = (wood: number, stone: number, gold: number): Res => ({ wood, stone, gold });

/** A deep copy of a fixture. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}

const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !isArray(value);

/**
 * A copy of `value` with the field at `path` set to `next`, or removed when `next` is `undefined`
 * (an array element is spliced out). Missing intermediate objects are created.
 */
export function withAt(value: unknown, path: readonly (string | number)[], next: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return next;
  if (isArray(value) && typeof head === "number") {
    const copy: unknown[] = [...value];
    if (rest.length === 0 && next === undefined) copy.splice(head, 1);
    else copy[head] = withAt(copy[head], rest, next);
    return copy;
  }
  const copy: Record<string, unknown> = isRecord(value) ? { ...value } : {};
  const key = String(head);
  if (rest.length === 0 && next === undefined) Reflect.deleteProperty(copy, key);
  else copy[key] = withAt(copy[key], rest, next);
  return copy;
}

export const ID_KEY = "00112233445566778899aabbccddeeff";
export const HASH64 = "cbf29ce484222325";
export const SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const RULESET = "perfidia-1@1.0.0";

export const setup: MatchSetup = {
  ruleset: RULESET,
  overrides: { "time.dominationStart": 604801, "homeRadius.6": 200 },
  seed: 42,
  idKey: ID_KEY,
  seats: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
};

export const gatewayRules: GatewayRules = {
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
    domination_started: { public: "urgent" },
  },
  publicOncePerDay: ["domination_started"],
};

const levelCosts = [res(0, 0, 0), res(90, 90, 60), res(144, 144, 96)];

export const compiledRules: CompiledRules = {
  ruleset: RULESET,
  players: 3,
  time: { matchEnd: 604800, attackFrom: 43200, minTravel: 3600 },
  resourceScale: 3600,
  buildings: [
    {
      id: "hall",
      maxLevel: 2,
      cost: levelCosts,
      time: [[], [1800, 1620], [2880, 2592]],
      requires: {},
    },
    {
      id: "warehouse",
      maxLevel: 2,
      cost: levelCosts,
      time: [[], [900, 810], [1440, 1296]],
      requires: { hall: 1 },
    },
    {
      id: "barracks",
      maxLevel: 2,
      cost: levelCosts,
      time: [[], [900, 810], [1440, 1296]],
      requires: {},
    },
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
      cost: res(30, 20, 10),
      queue: "barracks",
      requires: { barracks: 1 },
      time: [300, 300, 214],
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
      pop: 5,
      cost: res(450, 450, 750),
      queue: "barracks",
      requires: { barracks: 2 },
      time: [3600, 3600, 3000],
      maxPerOrder: 1,
    },
  ],
  roles: {
    producers: { wood: "hall", stone: "hall", gold: "hall" },
    storage: "warehouse",
    population: "hall",
    buildSpeed: "hall",
    wall: null,
    settler: "settler",
  },
  levels: { production: [50, 75, 110], storage: [660, 1000, 1460], population: [40, 62, 88] },
  queues: {
    build: { max: 5, requiresOn: "projected" },
    recruit: [{ id: "barracks", building: "barracks", maxBatches: 5, maxCount: 500 }],
    delivery: "trickle",
    refund: {
      build: { queuedPm: 1000, active: "prorata" },
      recruit: { queuedPm: 1000, active: "uncompleted" },
    },
  },
  settlerCost: [res(450, 450, 750), res(900, 900, 1500)],
  newCity: { buildings: { hall: 1, warehouse: 1 }, stock: res(200, 200, 200), units: {} },
  neutralProduction: false,
  movement: {
    recall: {
      window: 600,
      kinds: ["attack", "support", "found"],
      stationed: "partial",
      dismiss: true,
    },
    shipment: { base: 500, perLevel: 500, building: "barracks" },
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
  gateway: gatewayRules,
  travelProbes: [
    { label: "transport", group: { kind: "attack", units: { transport: 1 } } },
    { label: "spy", group: { kind: "spy", units: {} } },
  ],
  eventClasses: { build_done: 1, recruit_done: 2, arrive_attack: 7, match_end: 12 },
};

/** `compiledRules` as the `rules` tool shows it (§8.1): classes as an ordered list, no `resourceScale`. */
export const agentRules = {
  ruleset: compiledRules.ruleset,
  players: compiledRules.players,
  time: compiledRules.time,
  buildings: compiledRules.buildings,
  units: compiledRules.units,
  roles: compiledRules.roles,
  levels: compiledRules.levels,
  queues: compiledRules.queues,
  settlerCost: compiledRules.settlerCost,
  newCity: compiledRules.newCity,
  neutralProduction: compiledRules.neutralProduction,
  movement: compiledRules.movement,
  diplomacy: compiledRules.diplomacy,
  toolOptions: compiledRules.toolOptions,
  gateway: compiledRules.gateway,
  travelProbes: compiledRules.travelProbes,
  eventClasses: [["build_done"], ["recruit_done"], ["arrive_attack"], ["match_end"]],
} satisfies AgentRules;

export const city: City = {
  id: "c1",
  name: "c1",
  owner: "p1",
  island: "i1",
  slot: 0,
  capitalOf: "p1",
  tag: null,
  foundedAt: 0,
  stock: res(500 * 3600, 500 * 3600, 300 * 3600),
  stockAt: 7200,
  buildings: { hall: 2, warehouse: 1, barracks: 1 },
  units: { guard: 40 },
  stationed: [{ owner: "p2", home: "c2", role: "support", units: { guard: 10 } }],
  itemSeq: 3,
  build: [
    {
      id: 2,
      building: "warehouse",
      level: 2,
      cost: res(144, 144, 96),
      start: 7200,
      end: 8640,
      seq: 5,
    },
  ],
  recruit: {
    barracks: [
      {
        id: 3,
        unit: "guard",
        count: 20,
        done: 4,
        unitTime: 300,
        costEach: res(30, 20, 10),
        popEach: 1,
        start: 6000,
        end: 12000,
        seq: 6,
      },
    ],
  },
};

export const movement: Movement = {
  id: "m0k4qz",
  kind: "attack",
  owner: "p2",
  home: "c2",
  from: "c2",
  fromIsland: "i2",
  to: "c1",
  toIsland: "i1",
  slot: null,
  party: "p1",
  units: { guard: 15 },
  cargo: res(0, 0, 0),
  gold: 0,
  departAt: 50000,
  arriveAt: 53600,
  seq: 7,
  back: null,
};

export const matchResult: MatchResult = {
  endedAt: 604800,
  reason: "time",
  winners: ["p1"],
  standings: [
    {
      player: "p1",
      rank: 1,
      score: 230,
      parts: { cityPoints: 210, battleScore: 20 },
      cities: 2,
      alive: true,
    },
    {
      player: "p2",
      rank: 2,
      score: 105,
      parts: { cityPoints: 105, battleScore: 0 },
      cities: 1,
      alive: true,
    },
    {
      player: "p3",
      rank: 3,
      score: 0,
      parts: { cityPoints: 0, battleScore: 0 },
      cities: 0,
      alive: false,
    },
  ],
};

export const gameState: GameState = {
  v: 1,
  ruleset: RULESET,
  configHash: SHA,
  seed: 42,
  now: 7200,
  status: "running",
  seq: 7,
  ids: {
    c: 3,
    a: 1,
    own: {
      p1: { m: 0, r: 0, q: 1, g: 2 },
      p2: { m: 1, r: 0, q: 0, g: 0 },
      p3: { m: 0, r: 0, q: 0, g: 0 },
    },
  },
  evHash: HASH64,
  queue: [
    { at: 8640, cls: 1, seq: 5, kind: "build_done", ref: "c1" },
    { at: 12000, cls: 2, seq: 6, kind: "recruit_done", ref: "c1" },
    { at: 53600, cls: 7, seq: 7, kind: "arrive_attack", ref: "m0k4qz" },
    { at: 604800, cls: 12, seq: 1, kind: "match_end", ref: "" },
  ],
  players: {
    p1: { id: "p1", alive: true, eliminatedAt: null, alliance: "a1" },
    p2: { id: "p2", alive: true, eliminatedAt: null, alliance: "a1" },
    p3: { id: "p3", alive: false, eliminatedAt: 5000, alliance: null },
  },
  islands: {
    i1: { id: "i1", x: 0, y: 0, kind: "crown", slots: 1, richnessPm: 1500 },
    i2: { id: "i2", x: -12, y: 7, kind: "home", slots: 4, richnessPm: 1000 },
  },
  cities: {
    c1: city,
    c2: {
      ...clone(city),
      id: "c2",
      name: "Port Royal",
      island: "i2",
      capitalOf: "p2",
      owner: "p2",
      stationed: [],
      build: [],
      recruit: {},
      units: {},
    },
    c3: {
      ...clone(city),
      id: "c3",
      name: "c3",
      owner: null,
      capitalOf: null,
      tag: "crown",
      island: "i2",
      slot: 1,
      stationed: [],
      build: [],
      recruit: {},
    },
  },
  movements: { m0k4qz: movement },
  proposals: {
    q1c7hn: {
      id: "q1c7hn",
      from: "p1",
      to: "p3",
      kind: "pact",
      name: null,
      until: null,
      expiresAt: 43200,
      seq: 4,
    },
  },
  alliances: { a1: { id: "a1", name: "Iron Pact", members: ["p1", "p2"], formedAt: 3600 } },
  pacts: [{ a: "p1", b: "p3", since: 3600, expiresAt: 176400, seq: 3 }],
  ledger: {
    neutral: { made: { guard: 40 }, gone: {} },
    p1: { made: { guard: 44 }, gone: {} },
    p2: { made: { guard: 25 }, gone: {} },
  },
  ext: { sieges: {}, battlePoints: { p1: 12 }, dominationOpen: false },
  result: null,
};

/** A valid data payload for every standard event type. */
export const standardEventData: Record<StandardEventType, JsonObject> = {
  build_done: { city: "c1", item: 2, building: "warehouse", level: 2 },
  recruit_done: { city: "c1", item: 3, queue: "barracks", unit: "guard", count: 20 },
  queue_empty: { city: "c9", queue: "build" },
  incoming_attack: {
    movement: "m0k4qz",
    from: "c3",
    by: "p2",
    foe: "p3",
    to: "c12",
    departAt: 221820,
    arriveAt: 226620,
    homecoming: false,
  },
  incoming_support: {
    movement: "m3f8ta",
    from: "c3",
    by: "p2",
    to: "c9",
    departAt: 220000,
    arriveAt: 224400,
    units: { guard: 30 },
  },
  incoming_shipment: {
    movement: "m3f8tb",
    from: "c3",
    by: "p2",
    to: "c9",
    departAt: 220000,
    arriveAt: 224400,
    cargo: res(100, 0, 50),
  },
  movement_recalled: { movement: "m0k4qz", kind: "attack", by: "p2", to: "c12", arriveAt: 222300 },
  support_arrived: { movement: "m3f8ta", by: "p2", to: "c9", units: { guard: 30 } },
  shipment_delivered: {
    movement: "m3f8tb",
    to: "c9",
    outcome: "delivered",
    by: "p2",
    from: "c3",
    res: res(100, 0, 50),
    lost: res(0, 0, 10),
  },
  bounced: { movement: "m3f8tb", kind: "shipment", reason: "owner_changed" },
  returned: { movement: "m0k4qz", city: "c3", units: { guard: 12 }, cargo: res(40, 40, 0) },
  city_founded: { city: "c14", island: "i7", slot: 2, owner: "p3" },
  message: { message: "g09xr2", from: "p5", to: ["p3"], text: "Shall we talk?" },
  proposal: {
    proposal: "q1c7hn",
    from: "p6",
    to: "p3",
    kind: "pact",
    name: null,
    text: "Peace for two days.",
    until: null,
    expiresAt: 262800,
  },
  proposal_answered: { proposal: "q1c7hn", from: "p6", to: "p3", kind: "pact", accept: true },
  proposal_expired: { proposal: "q1c7hn", from: "p6", to: "p3", kind: "alliance" },
  alliance_formed: { alliance: "a1", name: "Iron Pact", members: ["p1", "p2"] },
  alliance_joined: { alliance: "a1", player: "p4" },
  alliance_left: { alliance: "a1", player: "p2", cause: "left" },
  alliance_dissolved: { alliance: "a1" },
  pact_signed: { a: "p1", b: "p3", expiresAt: 176400 },
  pact_renewed: { a: "p1", b: "p3", expiresAt: null },
  pact_ended: { a: "p1", b: "p3", cause: "superseded" },
  pact_expired: { a: "p1", b: "p3" },
  battle: { city: "c14", attacker: "p2", defender: "neutral", kind: "city", winner: "attacker" },
  battle_report: {
    report: "r2b7kq",
    city: "c14",
    attacker: "p2",
    defender: "p5",
    kind: "relief",
    winner: "defender",
    morale: 900,
    wall: [3, 2],
  },
  spy_report: { report: "r2b7kr", city: "c14", buildings: { hall: 4 } },
  spy_failed: { movement: "m5z9aa", city: "c14" },
  spy_detected: { city: "c14", by: "p2", from: "c3", gold: 300 },
  city_conquered: { city: "c14", from: "p5", to: "p2" },
  player_eliminated: { player: "p5" },
  betrayal: { by: "p2", against: "p5", relation: "pact", city: "c14" },
  match_ended: { reason: "domination", winners: ["p1", "p2"] },
};

export const domainEvent: DomainEvent = {
  t: 5400,
  type: "incoming_attack",
  public: false,
  to: [
    { p: "p3", as: "party" },
    { p: "p4", as: "ally" },
  ],
  data: standardEventData.incoming_attack,
};

/** One valid action of every type. */
export const actions: readonly Action[] = [
  { type: "build", city: "c3", building: "hall" },
  { type: "recruit", city: "c3", unit: "guard", count: 20 },
  { type: "cancel_queue", city: "c3", item: 7 },
  { type: "send_resources", from: "c3", to: "c9", res: res(100, 0, 0) },
  { type: "attack", from: "c3", to: "c12", units: { raider: 60, transport: 3 } },
  { type: "support", from: "c3", to: "c9", units: { guard: 30 } },
  { type: "spy", from: "c3", to: "c12", gold: 400 },
  { type: "found_city", from: "c3", island: "i7", units: { settler: 1, guard: 10 }, slot: null },
  { type: "recall", movement: "m0k4qz" },
  { type: "recall_stationed", at: "c9", home: null, units: null },
  { type: "dismiss", city: "c3", player: "p4" },
  { type: "send_message", to: ["p2", "p5"], text: "We stand together." },
  { type: "propose", to: "p6", kind: "alliance", name: "North Wind", text: "", until: null },
  { type: "answer", proposal: "q1c7hn", accept: false },
  { type: "leave", with: null },
  { type: "ext", tool: "rename_city", args: { city: "c3", name: "Haven" } },
];

/** Valid arguments of every tool, several per tool where modes differ. */
export const toolArgs: Record<ToolName, readonly unknown[]> = {
  view_city: [{ city: "c12" }],
  view_island: [{ island: "i7" }],
  view_map: [{}, { fromCity: "c3" }],
  view_player: [{ player: "p3" }],
  leaderboard: [{}],
  rules: [{}],
  build: [{ city: "c3", buildings: ["hall", "warehouse", "hall"] }],
  recruit: [
    { city: "c3", orders: [{ unit: "guard", count: 20 }] },
    {
      city: "c3",
      orders: [
        { unit: "guard", count: "max" },
        { unit: "raider", count: "max" },
      ],
    },
  ],
  cancel_queue: [{ city: "c3", item: 12 }],
  send_resources: [
    { from: "c3", to: "c9", wood: 100 },
    { from: "c3", to: "c9", wood: 1, stone: 2, gold: 3 },
  ],
  attack: [{ from: "c3", to: "c12", units: { raider: 60 } }],
  support: [{ from: "c3", to: "c9", units: { guard: 30 } }],
  spy: [{ from: "c3", to: "c12", gold: 400 }],
  recall_troops: [
    { movement: "m0k4qz" },
    { stationedAt: "c9" },
    { stationedAt: "c9", home: "c3" },
    { stationedAt: "c9", home: "c3", units: { guard: 10 } },
    { dismiss: { city: "c3", player: "p4" } },
  ],
  found_city: [
    { from: "c3", island: "i7", units: { settler: 1 } },
    { from: "c3", island: "i7", units: { settler: 1 }, slot: 2 },
  ],
  send_message: [
    { to: ["p2"], text: "hello" },
    { to: "all", text: "Peace to all." },
  ],
  propose_alliance: [
    { to: "p6", kind: "pact" },
    { to: "p6", kind: "alliance", name: "North Wind", text: "Join us." },
    { to: "p6", kind: "pact", until: 259200 },
  ],
  answer_proposal: [{ id: "q1c7hn", accept: true }],
  leave_alliance: [{}, { with: "p4" }],
  write_note: [{ text: "p2 broke our pact at D2 14:00", mode: "append" }],
  read_notes: [
    {},
    { open: "g09xr2" },
    { open: "r2b7kq" },
    {
      search: {
        scope: "public",
        text: "pact",
        kinds: ["pact_ended", "betrayal"],
        with: "p2",
        since: 0,
        until: 86400,
        limit: 20,
      },
    },
  ],
  end_turn: [{}, { nextWakeIn: 7200 }, { wakeAt: 230520 }],
};

const pair = (t: number, text: string): [number, string] => [t, text];

export const views = {
  cityFull: {
    access: "full",
    id: "c12",
    name: "c12",
    owner: "p3",
    island: "i7",
    slot: 0,
    capitalOf: "p3",
    tag: null,
    ext: {},
    stock: res(1520, 800, 240),
    rates: res(180, 120, 40),
    cap: 2040,
    pop: { used: 96, cap: 118 },
    buildings: { hall: 3, barracks: 1 },
    build: [
      {
        item: 21,
        building: "barracks",
        level: 2,
        start: pair(223320, "D3 14:02"),
        end: pair(227400, "D3 15:10"),
      },
    ],
    recruit: {
      barracks: [
        {
          item: 22,
          unit: "guard",
          count: 20,
          done: 0,
          start: pair(223320, "D3 14:02"),
          end: pair(230400, "D3 16:00"),
        },
      ],
    },
    units: { guard: 40, raider: 10 },
    stationed: [{ owner: "p5", home: "c20", role: "support", units: { guard: 15 } }],
    incoming: [
      {
        id: "m0k4qz",
        kind: "attack",
        access: "incoming",
        owner: "p2",
        from: "c3",
        to: "c12",
        party: "p3",
        depart: pair(221820, "D3 13:37"),
        arrive: pair(226620, "D3 14:57"),
      },
    ],
  },
  cityPublic: {
    access: "public",
    id: "c3",
    name: "c3",
    owner: "p2",
    island: "i2",
    slot: 1,
    capitalOf: "p2",
    tag: null,
    ext: { siege: null },
    intel: {
      report: "r2b7kr",
      type: "spy_report",
      at: pair(200000, "D3 07:33:20"),
      age: pair(23320, "6h28m40s"),
      data: { buildings: { hall: 4 } },
    },
  },
  island: {
    id: "i7",
    kind: "frontier",
    x: 12,
    y: -4,
    richnessPm: 1500,
    slots: 3,
    cities: [{ id: "c12", island: "i7", slot: 0, owner: "p3", capitalOf: "p3" }],
    free: [1, 2],
    probes: ["transport", "warship", "spy"],
    travel: [{ from: "c3", times: [pair(4800, "1h20m"), pair(3600, "1h"), pair(3600, "1h")] }],
  },
  map: {
    islands: [{ id: "i7", kind: "frontier", x: 12, y: -4, richnessPm: 1500, slots: 3, free: 2 }],
    cities: [{ id: "c12", island: "i7", slot: 0, owner: "p3", capitalOf: "p3", ext: {} }],
    from: "c3",
    probes: ["transport", "warship", "spy"],
    travel: { i7: [pair(4800, "1h20m"), pair(3600, "1h"), pair(3600, "1h")] },
  },
  player: {
    id: "p3",
    alive: true,
    eliminatedAt: null,
    alliance: null,
    cities: ["c12"],
    score: 108,
    parts: { cityPoints: 108, battleScore: 0 },
    relations: [{ player: "p6", kind: "pact", until: pair(262800, "D4 01:00") }],
    relation: "self",
    ext: {},
    private: {
      movements: [
        {
          id: "m3f8ta",
          kind: "support",
          access: "own",
          owner: "p3",
          from: "c12",
          to: "c9",
          party: "p5",
          depart: pair(220000, "D3 13:06:40"),
          arrive: pair(224400, "D3 14:20"),
          units: { guard: 30 },
          cargo: res(0, 0, 0),
          home: "c12",
          recallableUntil: pair(220600, "D3 13:16:40"),
        },
      ],
      stationed: [{ city: "c9", role: "hold", home: "c12", units: { settler: 1, raider: 20 } }],
      settler: { k: 2, cost: res(900, 900, 1500) },
      proposals: [
        {
          id: "q1c7hn",
          from: "p6",
          to: "p3",
          kind: "pact",
          name: null,
          text: "Peace for two days.",
          expires: pair(262800, "D4 01:00"),
        },
      ],
      today: { day: 2, ownWakes: 5, socialWakes: 3, attacks: 0, messages: 2 },
      selfWakeAt: pair(230520, "D3 16:02"),
    },
  },
  leaderboard: {
    standings: [
      {
        rank: 1,
        player: "p3",
        score: 108,
        parts: { cityPoints: 108 },
        cities: 1,
        alive: true,
        alliance: null,
        relations: [],
      },
    ],
    ext: { tiebreak: ["p3", "p1", "p2"], countdowns: [] },
  },
  rules: {
    ruleset: RULESET,
    title: "Perfidia V1",
    configHash: SHA,
    rulesHash: SHA,
    interface: "WAKES ...",
    cheatSheet: "TIME ...",
    config: { time: { matchEnd: 604800 } },
    rules: agentRules,
    extraTools: [
      {
        name: "hill_status",
        family: "observe",
        kind: "read",
        description: "Hill status.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  },
  archiveHit: {
    e: 17,
    t: pair(223000, "D3 13:56:40"),
    type: "message",
    public: false,
    id: "g09xr2",
    summary: "p5 to p3: Shall we talk?",
  },
  archiveEntry: {
    e: 17,
    t: pair(223000, "D3 13:56:40"),
    type: "message",
    public: false,
    id: "g09xr2",
    data: standardEventData.message,
    to: [{ p: "p3", as: "target" }],
  },
};

/** The briefing example of docs/architecture.md §8.2, verbatim. */
export const briefing: Briefing = {
  you: "p3",
  t: 223320,
  time: "D3 14:02",
  left: [381480, "4d 9h58m"],
  ruleset: RULESET,
  wake: { urgent: true, reasons: ["incoming_attack m0k4qz", "message g09xr2"] },
  lastTurn: {
    ended: "end_turn",
    unseen: [
      {
        tool: "attack",
        code: "INSUFFICIENT_UNITS",
        message: "c12 has 10 raiders at home, 60 requested.",
      },
    ],
    warnings: [],
    nextWake: { at: [230520, "D3 16:02"], kind: "self" },
  },
  cities: [
    {
      id: "c12",
      isl: "i7",
      res: [1520, 800, 240],
      rate: [180, 120, 40],
      cap: 2040,
      pop: [96, 118],
      build: [{ item: 21, b: "barracks", lvl: 2, end: [227400, "D3 15:10"] }],
      recruit: {
        barracks: [{ item: 22, unit: "guard", n: 20, end: [230400, "D3 16:00"] }],
      },
      units: { guard: 40, raider: 10 },
      stationed: 1,
    },
  ],
  incoming: [
    {
      id: "m0k4qz",
      kind: "attack",
      from: "c3",
      by: "p2",
      foe: "p3",
      to: "c12",
      depart: [221820, "D3 13:37"],
      arrive: [226620, "D3 14:57"],
    },
  ],
  moves: [{ id: "m3f8ta", kind: "support", to: "c9", arrive: [224400, "D3 14:20"] }],
  msgs: [{ id: "g09xr2", from: "p5", to: ["p3"], text: "…" }],
  proposals: [
    {
      id: "q1c7hn",
      from: "p6",
      to: "p3",
      kind: "pact",
      name: null,
      text: "…",
      expires: [262800, "D4 01:00"],
    },
  ],
  events: [{ type: "queue_empty", city: "c9", queue: "build" }],
  news: [{ type: "alliance_left", player: "p2", alliance: "a1" }],
  notes: "…",
  budget: {
    roundTrips: 8,
    callsPerRoundTrip: 10,
    ownWakesLeft: 7,
    socialWakesLeft: 5,
    selfWakeAt: [230520, "D3 16:02"],
    attacksLeft: 20,
    messagesLeft: 18,
  },
  ext: {
    holding: [{ city: "c20", owner: "p6", ends: [240000, "D3 18:40"] }],
    countdowns: [],
  },
};

/** Items of a `build` result: one success, one failure. */
export const buildItems: JsonObject[] = [
  {
    ok: true,
    item: 7,
    building: "hall",
    level: 3,
    end: pair(7200, "D1 02:00"),
    cost: res(90, 90, 60),
  },
  {
    ok: false,
    code: "REQUIREMENT_MISSING",
    message: "barracks needs hall 2.",
    hint: "Queue hall first.",
    details: { building: "barracks", need_hall: 2, have_hall: 1 },
  },
];

/** Items of a `recruit` result. */
export const recruitItems: JsonObject[] = [
  {
    ok: true,
    item: 8,
    unit: "guard",
    count: 20,
    end: pair(13200, "D1 03:40"),
    cost: res(600, 400, 200),
  },
];

/** Valid result data of every tool. */
export const toolResultData: Record<ToolName, JsonObject> = {
  view_city: views.cityFull,
  view_island: views.island,
  view_map: views.map,
  view_player: views.player,
  leaderboard: views.leaderboard,
  rules: views.rules,
  build: { items: buildItems },
  recruit: { items: recruitItems },
  cancel_queue: { city: "c3", removed: [12, 13], refund: res(144, 144, 96), lost: res(0, 0, 0) },
  send_resources: { movement: "m3f8tb", arrive: pair(224400, "D3 14:20") },
  attack: { movement: "m0k4qz", arrive: pair(226620, "D3 14:57") },
  support: { movement: "m3f8ta", arrive: pair(224400, "D3 14:20") },
  spy: { movement: "m5z9aa", arrive: pair(224400, "D3 14:20") },
  recall_troops: {
    returns: [{ movement: "m0k4qz", home: "c3", arrive: pair(222300, "D3 13:45") }],
  },
  found_city: { movement: "m7c2dd", arrive: pair(230000, "D3 15:53:20") },
  send_message: { message: "g09xr3" },
  propose_alliance: { proposal: "q1c7hp", expires: pair(266520, "D4 02:02") },
  answer_proposal: { proposal: "q1c7hn", accept: true },
  leave_alliance: {},
  write_note: { chars: 1200, max: 4000 },
  read_notes: { notes: "p2 lies", hits: [views.archiveHit], more: false },
  end_turn: { wakeAt: pair(230520, "D3 16:02"), clamped: false },
};

/** One line of every kind, after the examples of docs/architecture.md §10.2. */
export const logLines: Record<LogLineKind, LogLine> = {
  header: {
    k: "header",
    format: "perfidia-log/1",
    engine: "0.1.0",
    setup,
    config: { time: { matchEnd: 604800, dominationStart: 604801 } },
    configHash: SHA,
    rulesHash: SHA,
    controllers: { p1: "bot:expander@1", p2: "bot:rusher@1", p3: "bot:turtle@1" },
    clock: { kind: "realtime", speed: [3, 1], time: "virtual", latencyMs: [2000, 60000] },
    initialHash: HASH64,
    wallStart: "2026-10-10T12:00:00Z",
  },
  wake: {
    k: "wake",
    t: 0,
    seat: "p3",
    turn: 1,
    reasons: ["start"],
    urgent: false,
    charge: null,
    day: 0,
    used: { own: 0, social: 0 },
  },
  batch: { k: "batch", t: 0, b: 0, order: ["p3", "p1", "p2"] },
  act: {
    k: "act",
    n: 17,
    t: 0,
    seat: "p3",
    turn: 1,
    rt: 0,
    tool: "build",
    i: 1,
    a: { type: "build", city: "c3", building: "barracks" },
    r: { ok: false, code: "REQUIREMENT_MISSING" },
  },
  gw: {
    k: "gw",
    n: 19,
    t: 0,
    seat: "p3",
    turn: 1,
    rt: 0,
    tool: "attack",
    r: { ok: false, code: "DAILY_CAP", details: { cap: 20, used: 20 } },
  },
  obs: {
    k: "obs",
    n: 21,
    t: 0,
    seat: "p3",
    turn: 1,
    rt: 1,
    tool: "view_city",
    args: { city: "c3" },
    bytes: 812,
  },
  note: { k: "note", n: 22, t: 0, seat: "p3", turn: 1, mode: "replace", text: "plan: expand" },
  turn: {
    k: "turn",
    t: 0,
    seat: "p3",
    turn: 1,
    rounds: 3,
    calls: 9,
    why: "end_turn",
    selfAt: 7200,
    next: { at: 7200, kind: "self" },
    thought: "Expand east first.",
    wallMs: 12,
  },
  defer: { k: "defer", t: 5400, seat: "p4", to: 5401 },
  controller: { k: "controller", t: 43200, seat: "p2", label: "bot:turtle@1" },
  ev: { k: "ev", t: 5400, e: domainEvent },
  ckpt: { k: "ckpt", t: 3600, hour: 1, h: HASH64 },
  end: { k: "end", t: 604800, h: HASH64, result: matchResult },
  fatal: {
    k: "fatal",
    t: 5400,
    error: { kind: "invariant", message: "queue not sorted", details: { at: 5400 } },
  },
};

export const snapshot: Snapshot = {
  format: "perfidia-snapshot/1",
  engine: "0.1.0",
  setup,
  configHash: SHA,
  rulesHash: SHA,
  hour: 2,
  t: 7200,
  afterN: 22,
  hash: HASH64,
  state: gameState,
};
