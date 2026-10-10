import type {
  BuildingTable,
  CompiledRules,
  DeepReadonly,
  GatewayRules,
  Res,
  UnitTable,
} from "@perfidia/protocol";
import {
  SANDBOX_1_REF,
  SANDBOX_BUILDINGS,
  SANDBOX_QUEUES,
  START_BUILDINGS,
  type SandboxBuilding,
  type SandboxConfig,
} from "./config.ts";

// `compile` (docs/architecture.md §3.3, §3.8): the sandbox-1 config turned into the data tables the
// core reads. Pure; every call returns fresh objects. Every field differs from perfidia-1 where
// core, gateway or bot code could quietly hard-code a perfidia-1 value: ids, event classes, gateway
// caps, wake table, recall, diplomacy, tool options, refunds, delivery and requirement levels.

/** The world timer that opens the hill victory. */
export const HILL_OPEN = "hill_open";

/**
 * Same-second event classes: six classes (docs/architecture.md §5.1). Build and recruit
 * completions share class 0, so completions of one second resolve in seq order (in perfidia-1 a
 * build completes before a recruit of the same second).
 */
export function eventClasses(): Record<string, number> {
  return {
    build_done: 0,
    recruit_done: 0,
    arrive_return: 1,
    arrive_support: 1,
    arrive_shipment: 1,
    arrive_found: 1,
    arrive_spy: 2,
    arrive_attack: 3,
    proposal_expire: 4,
    pact_expire: 4,
    [HILL_OPEN]: 4,
    match_end: 5,
  };
}

/** Wake classes by event type and recipient role (docs/architecture.md §3.8, §8.5). */
export function wakeTable(): GatewayRules["wake"] {
  return {
    incoming_attack: { party: "urgent", ally: "social" },
    city_conquered: { target: "urgent" },
    queue_empty: { self: "own" },
    battle_report: { self: "own", target: "social", stationed: "social" },
    spy_report: { self: "own" },
    spy_failed: { self: "own" },
    message: { target: "social" },
    proposal: { target: "social" },
    proposal_answered: { target: "social" },
    spy_detected: { target: "social" },
  };
}

function levelRange(max: number): number[] {
  return Array.from({ length: max + 1 }, (_, level) => level);
}

function times(cost: DeepReadonly<Res>, k: number): Res {
  return { wood: cost.wood * k, stone: cost.stone * k, gold: cost.gold * k };
}

/** Requirements: the building at `level`, or none when `level` is 0. */
function requiring(building: SandboxBuilding, level: number): Record<string, number> {
  return level > 0 ? { [building]: level } : {};
}

/**
 * The building tables: level L costs `buildCost × L` and takes `buildTime × L` s, with one
 * build-time column (there is no build speed-up). Index 0 is never a build target; it holds the
 * formula's cost and a 1 s time, so every time entry is ≥ 1.
 */
function buildingTables(config: DeepReadonly<SandboxConfig>): BuildingTable[] {
  const e = config.economy;
  const levels = levelRange(e.maxLevel);
  return SANDBOX_BUILDINGS.map((id) => ({
    id,
    maxLevel: e.maxLevel,
    cost: levels.map((L) => times(e.buildCost, L)),
    time: levels.map((L) => [Math.max(1, e.buildTime * L)]),
    requires: id === "camp" || id === "docks" ? requiring("keep", e.militaryKeep) : {},
  }));
}

/** The unit tables. Unit times do not depend on the queue building's level. */
function unitTables(config: DeepReadonly<SandboxConfig>): UnitTable[] {
  const levels = levelRange(config.economy.maxLevel);
  const u = config.units;
  const batchMax = config.queues.batchMax;
  const land = (
    id: "spearman" | "axeman",
    s: DeepReadonly<SandboxConfig["units"]["spearman"]>,
  ): UnitTable => ({
    id,
    domain: "land",
    attack: s.attack,
    defense: s.defense,
    naval: 0,
    carry: s.carry,
    capacity: 0,
    pop: s.pop,
    cost: { ...s.cost },
    queue: "camp",
    requires: requiring("camp", s.camp),
    time: levels.map(() => s.time),
    maxPerOrder: batchMax,
  });
  return [
    land("spearman", u.spearman),
    land("axeman", u.axeman),
    {
      id: "colonist",
      domain: "land",
      attack: 0,
      defense: 0,
      naval: 0,
      carry: 0,
      capacity: 0,
      pop: u.colonist.pop,
      cost: { ...u.colonist.cost },
      queue: "camp",
      requires: requiring("camp", u.colonist.camp),
      time: levels.map(() => u.colonist.time),
      maxPerOrder: u.colonist.maxPerOrder,
    },
    {
      id: "boat",
      domain: "naval",
      attack: 0,
      defense: 0,
      naval: 0,
      carry: 0,
      capacity: u.boat.capacity,
      pop: u.boat.pop,
      cost: { ...u.boat.cost },
      queue: "docks",
      requires: requiring("docks", u.boat.docks),
      time: levels.map(() => u.boat.time),
      maxPerOrder: batchMax,
    },
  ];
}

/** `settlerCost[k] = cost × min(k, scaleCap)` for k = 0..scaleCap; k ≥ 1 in play. */
function colonistCosts(config: DeepReadonly<SandboxConfig>): Res[] {
  const c = config.units.colonist;
  return levelRange(c.scaleCap).map((k) => times(c.cost, k));
}

/** The gateway caps and wake rules (docs/architecture.md §3.8). */
function gatewayRules(config: DeepReadonly<SandboxConfig>): GatewayRules {
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
    publicOncePerDay: [],
  };
}

/** `Ruleset.compile`: the `CompiledRules` of sandbox-1@1.0.0 for N players. Pure. */
export function compileRules(config: DeepReadonly<SandboxConfig>, players: number): CompiledRules {
  const e = config.economy;
  const levels = levelRange(e.maxLevel);
  const d = config.diplomacy;
  const startBuildings: Record<string, number> = {};
  for (const id of START_BUILDINGS) startBuildings[id] = config.start.level;
  const stock = config.start.cityStock;
  return {
    ruleset: SANDBOX_1_REF,
    players,
    time: {
      matchEnd: config.time.matchEnd,
      attackFrom: config.time.attackFrom,
      minTravel: config.time.minTravel,
    },
    resourceScale: e.resourceScale,
    buildings: buildingTables(config),
    units: unitTables(config),
    roles: {
      producers: { wood: "sawmill", stone: "pit", gold: "forge" },
      storage: "depot",
      population: "keep",
      buildSpeed: null,
      wall: null,
      settler: "colonist",
    },
    levels: {
      production: levels.map((L) =>
        L === 0 ? e.production.level0 : e.production.base + e.production.perLevel * L,
      ),
      storage: levels.map((L) => e.storage.base + e.storage.perLevel * L),
      population: levels.map((L) => e.population.base + e.population.perLevel * L),
    },
    queues: {
      build: { max: config.queues.buildMax, requiresOn: "completed" },
      recruit: SANDBOX_QUEUES.map((id) => ({
        id,
        building: id,
        maxBatches: config.queues.recruitBatches,
        maxCount: config.queues.batchMax,
      })),
      delivery: "batch",
      refund: {
        build: {
          queuedPm: config.queues.refundQueuedPm,
          active: { pm: config.queues.refundActivePm },
        },
        recruit: {
          queuedPm: config.queues.refundQueuedPm,
          active: { pm: config.queues.refundActivePm },
        },
      },
    },
    settlerCost: colonistCosts(config),
    newCity: {
      buildings: startBuildings,
      stock: { wood: stock, stone: stock, gold: stock },
      units: {},
    },
    neutralProduction: false,
    movement: {
      recall: {
        window: config.movement.recallWindow,
        kinds: ["support"],
        stationed: "whole",
        dismiss: false,
      },
      shipment: {
        base: config.movement.shipmentBase,
        perLevel: config.movement.shipmentPerDocks,
        building: "docks",
      },
      transportRule: true,
      spyMinGold: config.spy.minGold,
    },
    diplomacy: {
      allianceMax: d.allianceMax,
      maxPacts: d.maxPacts,
      pactDuration: d.pactDuration,
      maxOpenProposals: d.maxOpenProposals,
      proposalTtl: d.proposalTtl,
      messageMaxChars: d.messageMaxChars,
      proposalTextMaxChars: d.proposalTextMaxChars,
      allianceNameMaxChars: d.allianceNameMaxChars,
    },
    toolOptions: { foundSlot: true, pactUntil: false },
    gateway: gatewayRules(config),
    travelProbes: [{ label: "any", group: { kind: "attack", units: {} } }],
    eventClasses: eventClasses(),
  };
}
