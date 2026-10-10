// Test fixtures shared by the domain tests. This file holds no tests of its own; it is named
// `*.test.ts` so that it stays out of the published sources and gets the test tsconfig and lint.
//
// Two rulesets made of the testing kit's fixture hooks plus the default domain module:
//
// - the testing kit's `fixtureRuleset` itself (batch delivery, completed requirements, whole
//   stationed recalls, no dismiss, no shipment cap, no transport rule);
// - `RICH` / `RICH_OPTIONS` (`domain-test@1.0.0` / `@1.1.0`): the same config, hooks and ids, with
//   compiled rules shaped like perfidia-1 (projected requirements, trickle delivery, pro-rata and
//   `uncompleted` refunds, a wall, a build-speed building, two recruit queues, settler cost by k,
//   partial stationed recalls, dismissal, an in-flight shipment cap, the transport rule).
//   `RICH_OPTIONS` also accepts `found_city.slot` and `propose.until` (`toolOptions`).

import { idKeyFromSeed } from "@perfidia/engine/core";
import type { AnyRuleset, Ruleset } from "@perfidia/engine/contracts";
import {
  MatchConfigError,
  resolveConfig,
  type ApplyOutput,
  type Match,
} from "@perfidia/engine/kernel";
import {
  FIXTURE_REF,
  addCity,
  buildState,
  fixtureRuleset,
  matchFromState,
  type FixtureConfig,
  type FixtureExt,
} from "@perfidia/engine/testing";
import {
  CityIdSchema,
  PlayerIdSchema,
  type City,
  type CityId,
  type CompiledRules,
  type DeepReadonly,
  type GameState,
  type Json,
  type JsonObject,
  type MatchSetup,
  type Res,
  type RulesetRef,
  type UnitCounts,
  type Violation,
} from "@perfidia/protocol";
import { domain } from "./index.ts";

export const res = (wood: number, stone: number, gold: number): Res => ({ wood, stone, gold });

const MAX = 5;
const LEVELS = [0, 1, 2, 3, 4, 5];

function building(
  id: string,
  base: Res,
  baseTime: number,
  requires: Record<string, number> = {},
): CompiledRules["buildings"][number] {
  return {
    id,
    maxLevel: MAX,
    cost: LEVELS.map((l) => res(base.wood * l, base.stone * l, base.gold * l)),
    time: LEVELS.map((l) =>
      LEVELS.map((s) => Math.max(1, Math.floor((baseTime * Math.max(l, 1) * 10) / (9 + s)))),
    ),
    requires,
  };
}

function unitTimes(baseTime: number): number[] {
  return LEVELS.map((l) => Math.max(1, Math.floor((baseTime * 10) / (9 + l))));
}

/** Rich rules (see the header) for N players. */
export function richCompile(
  config: DeepReadonly<FixtureConfig>,
  players: number,
  ref: RulesetRef,
  options: { readonly foundSlot: boolean; readonly pactUntil: boolean },
): CompiledRules {
  const t = config.time;
  return {
    ruleset: ref,
    players,
    time: { matchEnd: t.matchEnd, attackFrom: t.attackFrom, minTravel: t.minTravel },
    resourceScale: config.resourceScale,
    buildings: [
      building("tower", res(50, 50, 30), 1000),
      building("woodcut", res(20, 40, 20), 600),
      building("stonecut", res(40, 20, 20), 600),
      building("goldcut", res(40, 40, 10), 600),
      building("vault", res(40, 40, 20), 500),
      building("drill", res(40, 60, 40), 800, { tower: 2 }),
      building("dock", res(80, 40, 40), 1200, { tower: 3 }),
      building("rampart", res(20, 250, 20), 900, { drill: 1 }),
    ],
    units: [
      {
        id: "soldier",
        domain: "land",
        attack: 5,
        defense: 10,
        naval: 0,
        carry: 10,
        capacity: 0,
        pop: 1,
        cost: res(10, 20, 10),
        queue: "drill",
        requires: { drill: 1 },
        time: unitTimes(60),
        maxPerOrder: 100,
      },
      {
        id: "raider",
        domain: "land",
        attack: 20,
        defense: 2,
        naval: 0,
        carry: 50,
        capacity: 0,
        pop: 1,
        cost: res(20, 10, 20),
        queue: "drill",
        requires: { drill: 2 },
        time: unitTimes(60),
        maxPerOrder: 100,
      },
      {
        id: "pioneer",
        domain: "land",
        attack: 0,
        defense: 1,
        naval: 0,
        carry: 0,
        capacity: 0,
        pop: 5,
        cost: res(100, 100, 100),
        queue: "drill",
        requires: { tower: 2, drill: 2 },
        time: unitTimes(600),
        maxPerOrder: 1,
      },
      {
        id: "ship",
        domain: "naval",
        attack: 0,
        defense: 0,
        naval: 0,
        carry: 0,
        capacity: 10,
        pop: 2,
        cost: res(30, 10, 10),
        queue: "dock",
        requires: { dock: 1 },
        time: unitTimes(300),
        maxPerOrder: 50,
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
        cost: res(60, 40, 40),
        queue: "dock",
        requires: { dock: 2 },
        time: unitTimes(600),
        maxPerOrder: 50,
      },
    ],
    roles: {
      producers: { wood: "woodcut", stone: "stonecut", gold: "goldcut" },
      storage: "vault",
      population: "tower",
      buildSpeed: "tower",
      wall: "rampart",
      settler: "pioneer",
    },
    levels: {
      production: [0, 60, 120, 180, 240, 300],
      storage: [600, 1000, 1500, 2000, 3000, 4000],
      population: [20, 40, 80, 120, 160, 200],
    },
    queues: {
      build: { max: 3, requiresOn: "projected" },
      recruit: [
        { id: "drill", building: "drill", maxBatches: 3, maxCount: 100 },
        { id: "dock", building: "dock", maxBatches: 2, maxCount: 50 },
      ],
      delivery: "trickle",
      refund: {
        build: { queuedPm: 1000, active: "prorata" },
        recruit: { queuedPm: 1000, active: "uncompleted" },
      },
    },
    settlerCost: [res(100, 100, 100), res(200, 200, 200), res(300, 300, 300), res(400, 400, 1200)],
    newCity: {
      buildings: { tower: 1, woodcut: 1, stonecut: 1, goldcut: 1, vault: 1 },
      stock: res(100, 100, 100),
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
      shipment: { base: 100, perLevel: 100, building: "dock" },
      transportRule: true,
      spyMinGold: 10,
    },
    diplomacy: {
      // 2 for N ≤ 3, 3 for N = 4: both a full alliance and a join can be tested.
      allianceMax: players >= 4 ? 3 : 2,
      maxPacts: 1,
      pactDuration: 7200,
      maxOpenProposals: 2,
      proposalTtl: 3600,
      messageMaxChars: 50,
      proposalTextMaxChars: 30,
      allianceNameMaxChars: 12,
    },
    toolOptions: { foundSlot: options.foundSlot, pactUntil: options.pactUntil },
    gateway: {
      ...config.gateway,
      selfWake: { ...config.gateway.selfWake },
      wake: {
        incoming_attack: { party: "urgent" },
        message: { target: "social" },
        build_done: { self: "own" },
        queue_empty: { self: "own" },
      },
      publicOncePerDay: [],
    },
    travelProbes: [{ label: "any", group: { kind: "attack", units: {} } }],
    eventClasses: {
      build_done: 1,
      recruit_done: 2,
      arrive_return: 3,
      arrive_support: 4,
      arrive_shipment: 4,
      arrive_found: 4,
      arrive_spy: 5,
      arrive_attack: 6,
      proposal_expire: 7,
      pact_expire: 7,
      fixture_open: 7,
      match_end: 9,
    },
  };
}

function richRuleset(
  version: "1.0.0" | "1.1.0",
  options: { readonly foundSlot: boolean; readonly pactUntil: boolean },
): Ruleset<FixtureConfig, FixtureExt> {
  const ref: RulesetRef = `domain-test@${version}`;
  const base = fixtureRuleset.hooks;
  return {
    ...fixtureRuleset,
    id: "domain-test",
    version,
    ref,
    title: "Domain test ruleset",
    compile: (config, players) => richCompile(config, players, ref, options),
    hooks: {
      ...base,
      // The fixture's capitals lack the rich buildings and the second queue: add them, empty.
      createWorld(w) {
        const setup = base.createWorld(w);
        const cities = setup.cities.map((c) => {
          const buildings: Record<string, number> = {};
          for (const b of w.rules.buildings) buildings[b.id] = c.buildings[b.id] ?? 0;
          const recruit: Record<string, (typeof c.recruit)[string]> = {};
          for (const q of w.rules.queues.recruit) recruit[q.id] = [...(c.recruit[q.id] ?? [])];
          return { ...c, buildings, recruit };
        });
        return { ...setup, cities };
      },
    },
  };
}

/** The rich ruleset without the optional tool arguments. */
export const RICH: AnyRuleset = richRuleset("1.0.0", { foundSlot: false, pactUntil: false });
/** The rich ruleset with `found_city.slot` and `propose.until`. */
export const RICH_OPTIONS: AnyRuleset = richRuleset("1.1.0", { foundSlot: true, pactUntil: true });
/** The testing kit's fixture ruleset, run on the default domain. */
export const FIXTURE: AnyRuleset = fixtureRuleset;

export { FIXTURE_REF };

/** The compiled rules of `ruleset` for N players under `overrides`. */
export function rulesOf(
  ruleset: AnyRuleset = RICH,
  players = 3,
  overrides: Readonly<Record<string, Json>> = {},
): CompiledRules {
  const resolved = resolveConfig(ruleset, overrides);
  if (!resolved.ok) throw new MatchConfigError(resolved.errors);
  return ruleset.compile(resolved.config, players);
}

/** An empty running state (players, islands i1 and i2 with 4 slots, `match_end`), renaming open. */
export function emptyState(
  o: {
    readonly ruleset?: AnyRuleset;
    readonly players?: number;
    readonly now?: number;
    readonly seed?: number;
    readonly overrides?: Readonly<Record<string, Json>>;
  } = {},
): { state: GameState; rules: CompiledRules } {
  const rules = rulesOf(o.ruleset, o.players ?? 3, o.overrides);
  const ext: FixtureExt = { opened: true, renames: 0, holds: {} };
  const state = buildState({
    rules,
    players: o.players ?? 3,
    seed: o.seed ?? 11,
    now: o.now ?? 0,
    ext,
  });
  return { state, rules };
}

/** The buildings of a fixture capital. */
export const CAPITAL: Readonly<Record<string, number>> = {
  tower: 1,
  woodcut: 1,
  stonecut: 1,
  goldcut: 1,
  vault: 1,
  drill: 1,
};

/**
 * `emptyState` plus one capital per player: c1 (p1) on i1, c2 (p2) on i2, c3 (p3) on i1, each with
 * the capital buildings, 500 of each resource and 10 soldiers. Travel: 5400 s between the islands,
 * 3600 s on one island.
 */
export function world(
  o: Parameters<typeof emptyState>[0] & {
    /** Units at home by capital id, instead of 10 soldiers. */
    readonly units?: Readonly<Record<string, UnitCounts>>;
  } = {},
): {
  state: GameState;
  rules: CompiledRules;
} {
  const { state, rules } = emptyState(o);
  const islands = ["i1", "i2", "i1", "i2"] as const;
  for (let i = 1; i <= (o.players ?? 3); i += 1) {
    const id = CityIdSchema.parse(`c${i}`);
    addCity(state, rules, {
      owner: PlayerIdSchema.parse(`p${i}`),
      id,
      island: islands[i - 1] ?? "i1",
      buildings: CAPITAL,
      stock: 500,
      units: o.units?.[id] ?? { soldier: 10 },
      capital: true,
    });
  }
  return { state, rules };
}

/** The draft record of a city of a hand-built state. */
export function cityOf(state: GameState, id: CityId): City {
  const c = Object.hasOwn(state.cities, id) ? state.cities[id] : undefined;
  if (c === undefined) throw new Error(`no city ${id}`);
  return c;
}

/** A city of a running match (read-only). */
export function cityIn(m: Match, id: CityId): DeepReadonly<City> {
  const cities = m.read().state.cities;
  const c = Object.hasOwn(cities, id) ? cities[id] : undefined;
  if (c === undefined) throw new Error(`no city ${id}`);
  return c;
}

/** A hand-built state loaded as a match on the default domain, with step invariants. */
export function load(
  state: GameState,
  ruleset: AnyRuleset = RICH,
  overrides: Readonly<Record<string, Json>> = {},
): Match {
  return matchFromState(state, ruleset, { domain, overrides, invariants: "step" });
}

/** A setup of `ruleset` with players p1..pN and `idKeyFromSeed(seed)`. */
export function setupOf(
  ruleset: AnyRuleset,
  players = 3,
  seed = 5,
  overrides: Readonly<Record<string, Json>> = {},
): MatchSetup {
  return {
    ruleset: ruleset.ref,
    overrides: { ...overrides },
    seed,
    idKey: idKeyFromSeed(seed),
    seats: Array.from({ length: players }, (_, i) => ({ id: PlayerIdSchema.parse(`p${i + 1}`) })),
  };
}

/** The violation of a rejected action (throws when it was accepted). */
export function violation(out: ApplyOutput): Violation {
  if (out.ok) throw new Error(`expected a rejection, got ${JSON.stringify(out.data)}`);
  return out.violation;
}

/** The data of an accepted action (throws when it was rejected). */
export function accepted(out: ApplyOutput): JsonObject {
  if (!out.ok) throw new Error(`expected success, got ${JSON.stringify(out.violation)}`);
  return out.data;
}
