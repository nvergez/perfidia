import { mulDiv } from "@perfidia/engine/core";
import type {
  BuildingTable,
  CompiledRules,
  DeepReadonly,
  GatewayRules,
  Res,
  UnitTable,
} from "@perfidia/protocol";
import { type PerfidiaNames, buildingIds, unitIds } from "./names.ts";
import { entry, type PerfidiaCore, quad, RECRUIT_QUEUES } from "./schema.ts";

// `compile` (docs/architecture.md §3.3): a perfidia-1 config turned into the data tables the core
// reads, for the ids of its version. Pure; every call returns fresh objects. `compile.ts` binds it
// to 1.0.0's ids.

/** Same-second event classes (perfidia-1 §1.4, docs/architecture.md §5.1). */
export function eventClasses(): Record<string, number> {
  return {
    build_done: 1,
    recruit_done: 2,
    arrive_return: 3,
    arrive_support: 4,
    arrive_shipment: 5,
    arrive_spy: 6,
    arrive_attack: 7,
    arrive_found: 8,
    siege_end: 9,
    proposal_expire: 10,
    pact_expire: 10,
    domination_open: 10,
    domination_end: 11,
    match_end: 12,
  };
}

/** Wake classes by event type and recipient role (perfidia-1 §14.2, docs/architecture.md §8.5). */
export function wakeTable(): GatewayRules["wake"] {
  return {
    incoming_attack: { party: "urgent", target: "social", ally: "social", stationed: "social" },
    siege_started: { target: "urgent", ally: "urgent" },
    city_conquered: { target: "urgent" },
    betrayal: { target: "urgent" },
    domination_started: { public: "urgent" },
    queue_empty: { self: "own" },
    battle_report: { self: "own", target: "social", stationed: "social", party: "social" },
    spy_report: { self: "own" },
    spy_failed: { self: "own" },
    message: { target: "social" },
    proposal: { target: "social" },
    proposal_answered: { target: "social" },
    spy_detected: { target: "social" },
  };
}

function scaled(cost: DeepReadonly<Res>, num: number, den: number): Res {
  return {
    wood: mulDiv(cost.wood, num, den),
    stone: mulDiv(cost.stone, num, den),
    gold: mulDiv(cost.gold, num, den),
  };
}

function levelRange(max: number): number[] {
  return Array.from({ length: max + 1 }, (_, level) => level);
}

/**
 * The building tables: cost `[target level]`, time `[target level][hall at enqueue]` (§5.2). Index 0
 * is never a build target; it holds the formula's value too, so every row is full and every time is
 * ≥ 1 whichever way a check reads the tables.
 */
function buildingTables(names: PerfidiaNames, config: DeepReadonly<PerfidiaCore>): BuildingTable[] {
  const e = config.economy;
  const levels = levelRange(e.maxLevel);
  return buildingIds(names).map((id) => {
    const b = entry(config.buildings, id, "buildings");
    return {
      id,
      maxLevel: e.maxLevel,
      cost: levels.map((L) => scaled(b.cost, quad(e.levelWeight, L), e.levelWeightDiv)),
      time: levels.map((L) =>
        levels.map((hall) =>
          Math.max(1, mulDiv(b.time, quad(e.levelWeight, L), e.buildTimeOffset + hall)),
        ),
      ),
      requires: { ...b.requires },
    };
  });
}

/** The unit tables: time `[queue building level at enqueue]` (§6.3). */
function unitTables(names: PerfidiaNames, config: DeepReadonly<PerfidiaCore>): UnitTable[] {
  const e = config.economy;
  const levels = levelRange(e.maxLevel);
  const offset = e.recruitTimeOffset;
  return unitIds(names).map((id) => {
    const u = entry(config.units, id, "units");
    return {
      id,
      domain: u.domain,
      attack: u.attack,
      defense: u.defense,
      naval: u.naval,
      carry: u.carry,
      capacity: u.capacity,
      pop: u.pop,
      cost: { ...u.cost },
      queue: u.queue,
      requires: { ...u.requires },
      time: levels.map((L) => Math.max(1, mulDiv(u.time, offset + 1, offset + L))),
      maxPerOrder:
        id === names.units.settler ? config.settler.maxPerOrder : config.queues.batchMaxUnits,
    };
  });
}

/** `settlerCost[k] = base × min(k, scaleCap)` for k = 0..scaleCap (§6.2); k ≥ 1 in play. */
function settlerCosts(names: PerfidiaNames, config: DeepReadonly<PerfidiaCore>): Res[] {
  const base = entry(config.units, names.units.settler, "units").cost;
  return levelRange(config.settler.scaleCap).map((k) => scaled(base, k, 1));
}

/** The gateway caps of §14.1 and the wake rules of §14.2. */
function gatewayRules(config: DeepReadonly<PerfidiaCore>): GatewayRules {
  const g = config.gateway;
  return {
    roundTripsPerWake: g.roundTripsPerWake,
    toolCallsPerRoundTrip: g.toolCallsPerRoundTrip,
    toolCallsPerWake: g.toolCallsPerWake,
    ownWakesPerDay: g.ownWakesPerDay,
    socialWakesPerDay: g.socialWakesPerDay,
    groupWindow: g.groupWindow,
    urgentMinGap: g.urgentMinGap,
    selfWake: { min: g.selfWake.min, max: g.selfWake.max },
    safetyWake: g.safetyWake,
    attackLaunchesPerDay: g.attackLaunchesPerDay,
    messagesPerDay: g.messagesPerDay,
    notesMaxChars: g.notesMaxChars,
    wake: wakeTable(),
    publicOncePerDay: ["domination_started"],
  };
}

/**
 * `Ruleset.compile` of the version whose ids are `names`: its `CompiledRules` for N players. Pure.
 * Recruit queues are named after the building that trains them.
 */
export function compileRulesWith(
  names: PerfidiaNames,
): (config: DeepReadonly<PerfidiaCore>, players: number) => CompiledRules {
  const b = names.buildings;
  const u = names.units;
  return (config, players) => {
    const e = config.economy;
    const levels = levelRange(e.maxLevel);
    const seed = entry(config.start, "newCity", "start");
    const d = config.diplomacy;
    return {
      ruleset: names.ref,
      players,
      time: {
        matchEnd: config.time.matchEnd,
        attackFrom: config.time.protectionEnd,
        minTravel: config.time.minTravel,
      },
      resourceScale: e.resourceScale,
      buildings: buildingTables(names, config),
      units: unitTables(names, config),
      roles: {
        producers: { wood: b.lumber, stone: b.quarry, gold: b.mine },
        storage: b.warehouse,
        population: b.hall,
        buildSpeed: b.hall,
        wall: b.wall,
        settler: u.settler,
      },
      levels: {
        production: levels.map((L) => quad(e.production, L)),
        storage: levels.map((L) => quad(e.warehouseCap, L)),
        population: levels.map((L) => quad(e.popCap, L)),
      },
      queues: {
        build: { max: config.queues.buildMax, requiresOn: "projected" },
        recruit: RECRUIT_QUEUES.map((id) => ({
          id,
          building: b[id],
          maxBatches: config.queues.recruitBatchesMax,
          maxCount: config.queues.batchMaxUnits,
        })),
        delivery: "trickle",
        refund: {
          build: { queuedPm: 1000, active: "prorata" },
          recruit: { queuedPm: 1000, active: "uncompleted" },
        },
      },
      settlerCost: settlerCosts(names, config),
      newCity: {
        buildings: { ...seed.buildings },
        stock: { ...seed.stock },
        units: { ...seed.units },
      },
      neutralProduction: false,
      movement: {
        recall: {
          window: config.time.recallWindow,
          // §18: a window of 0 disables recalls (an inclusive window of 0 s would still allow one
          // in the launch second).
          kinds: config.time.recallWindow === 0 ? [] : ["attack", "support", "found"],
          stationed: "partial",
          dismiss: true,
        },
        shipment: {
          base: config.movement.shipment.base,
          perLevel: config.movement.shipment.perHarborLevel,
          building: b.harbor,
        },
        transportRule: true,
        spyMinGold: config.spy.minGold,
      },
      diplomacy: {
        allianceMax: Math.max(d.allianceSize.min, Math.floor(players / d.allianceSize.divisor)),
        maxPacts: d.maxPacts,
        pactDuration: config.time.pactDuration,
        maxOpenProposals: d.maxOpenProposals,
        proposalTtl: config.time.proposalTtl,
        messageMaxChars: d.messageMaxChars,
        proposalTextMaxChars: d.proposalTextMaxChars,
        allianceNameMaxChars: d.allianceNameMaxChars,
      },
      toolOptions: { foundSlot: false, pactUntil: false },
      gateway: gatewayRules(config),
      travelProbes: [
        { label: u.transport, group: { kind: "attack", units: { [u.transport]: 1 } } },
        { label: u.warship, group: { kind: "attack", units: { [u.warship]: 1 } } },
        { label: "spy", group: { kind: "spy", units: {} } },
      ],
      eventClasses: eventClasses(),
    };
  };
}
