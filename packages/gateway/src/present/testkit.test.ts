// Shared fixtures for the presentation tests (no tests here): a hand-built fixture-ruleset world
// with four players, a perfidia-1 test descriptor assembled from the wave-3 modules (the real
// descriptor is T11's), gateway states fed with events, and helpers to compare outputs.

import { canonicalJson, idKeyFromSeed } from "@perfidia/engine/core";
import type { AnyRuleset, ReadCtx, Ruleset } from "@perfidia/engine/contracts";
import { createMatch, type Match } from "@perfidia/engine/kernel";
import * as p1 from "@perfidia/engine/rulesets/perfidia-1";
import { relation } from "@perfidia/engine/std";
import {
  addAlliance,
  addBuildItem,
  addCity,
  addMovement,
  addPact,
  addProposal,
  addRecruitBatch,
  addStationed,
  fakeDomain,
  fixtureHolds,
  fixtureRuleset,
  fixtureState,
  matchFromState,
  type FixtureConfig,
  type FixtureExt,
} from "@perfidia/engine/testing";
import {
  createGatewayState,
  createWakeScheduler,
  deliver,
  type GatewayState,
  type WakeRecord,
  type WakeScheduler,
} from "@perfidia/gateway/seat";
import {
  PlayerIdSchema,
  type DomainEvent,
  type GameState,
  type GatewayRules,
  type JsonObject,
  type MatchSetup,
  type PlayerId,
  type Role,
} from "@perfidia/protocol";
import { gatewayRulesCopy } from "./rules.ts";

export const P1: PlayerId = "p1";
export const P2: PlayerId = "p2";
export const P3: PlayerId = "p3";
export const P4: PlayerId = "p4";

// Events --------------------------------------------------------------------------------------------

export function event(
  t: number,
  type: string,
  to: readonly (readonly [PlayerId, Role])[],
  data: JsonObject = {},
  isPublic = false,
): DomainEvent {
  return { t, type, public: isPublic, to: to.map(([p, as]) => ({ p, as })), data };
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A valid opaque id of `prefix` for test number `n`. */
export function oid(prefix: "m" | "r" | "q" | "g", n: number): string {
  let rest = "";
  let v = n;
  for (let i = 0; i < 5; i += 1) {
    rest = (ALPHABET[v % 32] ?? "0") + rest;
    v = Math.floor(v / 32);
  }
  return prefix + rest;
}

/** A gateway state for the seats of `match`, with its wake scheduler. */
export function gatewayFor(match: Match): { gw: GatewayState; wake: WakeScheduler } {
  const players = Object.keys(match.read().state.players).map((p) => PlayerIdSchema.parse(p));
  const gw = createGatewayState(players);
  const wake = createWakeScheduler(gw, gatewayRulesCopy(match.rules.gateway));
  return { gw, wake };
}

export function wakeRecord(reasons: string[], urgent = false): WakeRecord {
  return { reasons, urgent, charge: urgent ? null : "own", day: 0, used: { own: 0, social: 0 } };
}

// The fixture-ruleset world ---------------------------------------------------------------------------

/**
 * The fixture ruleset with allies granted full access to each other's movements (as `sandbox-1`
 * does), the other visibility hooks unchanged.
 */
export const grantingRuleset: Ruleset<FixtureConfig, FixtureExt> = {
  ...fixtureRuleset,
  hooks: {
    ...fixtureRuleset.hooks,
    visibility: {
      ...fixtureRuleset.hooks.visibility,
      movementAccess(r, viewer, m) {
        const mv = r.state.movements[m];
        if (mv === undefined) return null;
        if (mv.owner === viewer) return "own";
        if (relation(r, viewer, mv.owner) === "ally") return "full";
        return fixtureRuleset.hooks.visibility?.movementAccess?.(r, viewer, m) ?? null;
      },
    },
  },
};

/** Edits of data hidden from p1 (property P10), applied after every entity p1 can see exists. */
export type Perturbation =
  | { kind: "stock"; city: "c5" | "c6"; amount: number }
  | { kind: "units"; city: "c5" | "c6"; soldiers: number }
  | { kind: "attack"; soldiers: number; arriveIn: number }
  | { kind: "support"; soldiers: number; arriveIn: number }
  | { kind: "proposal" }
  | { kind: "counters"; m: number; r: number; q: number; g: number }
  | { kind: "queue" }
  | { kind: "pact" };

export const NOW = 7200;

/**
 * The world (fixture ruleset, four players, t = 7200):
 * - p1 (the viewer): c1 (capital, i1), c2 (i1), c3 (i2); allied with p2 in a1. c1 has a build
 *   item and a recruit batch; c3 is held by p4 (a `hold` group of p4 stationed there).
 * - p2: c4 (i2); p1 has a support group stationed in c4; p2 attacks p4's c6 (an ally's outgoing
 *   movement).
 * - p3: c5 (i2), where p1 holds a `hold` garrison; p3 attacks p1's c1 (an incoming attack), and
 *   proposes a pact to p1.
 * - p4: c6 (i1); attacks p2's c4 (p1 sees it as an ally); p3 and p4 have a public pact.
 * - p1 sends a support from c2 to c4 (an own movement).
 */
export function fixtureWorld(perturb: readonly Perturbation[] = []): GameState {
  const { state, rules } = fixtureState({ players: 4, now: NOW });
  const c = (o: Parameters<typeof addCity>[2]) => addCity(state, rules, o);
  c({
    owner: P1,
    id: "c1",
    island: "i1",
    capital: true,
    stock: 300,
    units: { soldier: 12 },
    buildings: { tower: 2, woodcut: 1, stonecut: 1, goldcut: 1, vault: 1, drill: 1 },
  });
  c({
    owner: P1,
    id: "c2",
    island: "i1",
    stock: 120,
    units: { soldier: 6 },
    buildings: { tower: 1, woodcut: 1, stonecut: 1, goldcut: 1, vault: 1, drill: 1 },
  });
  c({
    owner: P1,
    id: "c3",
    island: "i2",
    stock: 80,
    units: { soldier: 2 },
    buildings: { tower: 1, vault: 1 },
  });
  c({
    owner: P2,
    id: "c4",
    island: "i2",
    capital: true,
    stock: 400,
    units: { soldier: 9 },
    buildings: { tower: 1, vault: 1, drill: 1 },
  });
  c({
    owner: P3,
    id: "c5",
    island: "i2",
    capital: true,
    stock: 500,
    units: { soldier: 20 },
    buildings: { tower: 2, vault: 1, drill: 1 },
  });
  c({
    owner: P4,
    id: "c6",
    island: "i1",
    capital: true,
    stock: 450,
    units: { soldier: 15 },
    buildings: { tower: 1, vault: 1, drill: 1 },
  });
  addAlliance(state, "North", [P1, P2]);
  addBuildItem(state, rules, "c1", "tower");
  addRecruitBatch(state, rules, "c1", "soldier", 5);
  addStationed(state, "c4", { owner: P1, home: "c2", role: "support", units: { soldier: 3 } });
  addStationed(state, "c3", { owner: P4, home: "c6", role: "hold", units: { soldier: 4 } });
  addStationed(state, "c5", { owner: P1, home: "c1", role: "hold", units: { soldier: 5 } });
  addMovement(state, rules, {
    kind: "attack",
    owner: P3,
    from: "c5",
    to: "c1",
    party: P1,
    units: { soldier: 8 },
    departAt: NOW - 600,
    arriveAt: NOW + 4800,
  });
  addMovement(state, rules, {
    kind: "attack",
    owner: P4,
    from: "c6",
    to: "c4",
    party: P2,
    units: { soldier: 7 },
    departAt: NOW - 1200,
    arriveAt: NOW + 4200,
  });
  addMovement(state, rules, {
    kind: "attack",
    owner: P2,
    from: "c4",
    to: "c6",
    party: P4,
    units: { soldier: 4 },
    departAt: NOW - 300,
    arriveAt: NOW + 3300,
  });
  addMovement(state, rules, {
    kind: "support",
    owner: P1,
    from: "c2",
    to: "c4",
    party: P2,
    units: { soldier: 2 },
    departAt: NOW - 100,
    arriveAt: NOW + 5300,
  });
  addProposal(state, rules, { from: P3, to: P1, kind: "pact" });
  addPact(state, rules, P3, P4, { expiresAt: NOW + 50000 });
  for (const p of perturb) applyPerturbation(state, rules, p);
  state.ext = { opened: false, renames: 0, holds: fixtureHolds(state) };
  return state;
}

function applyPerturbation(
  state: GameState,
  rules: ReturnType<typeof fixtureState>["rules"],
  p: Perturbation,
): void {
  const scale = rules.resourceScale;
  switch (p.kind) {
    case "stock": {
      const city = state.cities[p.city];
      if (city !== undefined)
        city.stock.wood = Math.min(city.stock.wood + p.amount * scale, 1000 * scale);
      return;
    }
    case "units": {
      const city = state.cities[p.city];
      const owner = city?.owner ?? null;
      if (city === undefined || owner === null) return;
      city.units["soldier"] = (city.units["soldier"] ?? 0) + p.soldiers;
      const ledger = state.ledger[owner];
      if (ledger !== undefined) ledger.made["soldier"] = (ledger.made["soldier"] ?? 0) + p.soldiers;
      return;
    }
    case "attack":
      addMovement(state, rules, {
        kind: "attack",
        owner: P3,
        from: "c5",
        to: "c6",
        party: P4,
        units: { soldier: p.soldiers },
        arriveAt: NOW + p.arriveIn,
      });
      return;
    case "support":
      addMovement(state, rules, {
        kind: "support",
        owner: P4,
        from: "c6",
        to: "c5",
        party: P3,
        units: { soldier: p.soldiers },
        arriveAt: NOW + p.arriveIn,
      });
      return;
    case "proposal":
      addProposal(state, rules, { from: P4, to: P3, kind: "alliance", name: "Secret" });
      return;
    case "counters": {
      const own = state.ids.own[P4];
      if (own !== undefined) {
        own.m += p.m;
        own.r += p.r;
        own.q += p.q;
        own.g += p.g;
      }
      return;
    }
    case "queue":
      addBuildItem(state, rules, "c6", "woodcut");
      return;
    case "pact":
      // A pact between two others is public: used only to check that it does show.
      addPact(state, rules, P2, P4);
      return;
  }
}

/** The fixture world as a match (fake domain, step invariants). */
export function fixtureMatch(
  perturb: readonly Perturbation[] = [],
  ruleset: AnyRuleset = fixtureRuleset,
): Match {
  return matchFromState(fixtureWorld(perturb), ruleset);
}

/** The id of p3's open proposal to p1 in the world. */
export function proposalToP1(r: ReadCtx): string {
  const q = Object.values(r.state.proposals).find((x) => x.from === P3 && x.to === P1);
  if (q === undefined) throw new Error("no proposal from p3 to p1");
  return q.id;
}

/** p1's archive and inbox: the proposal text, a message, a battle report, a public headline. */
export function feedP1(gw: GatewayState, wake: WakeScheduler, r: ReadCtx): void {
  deliver(
    gw,
    [
      event(
        NOW - 900,
        "proposal",
        [
          [P3, "self"],
          [P1, "target"],
        ],
        {
          proposal: proposalToP1(r),
          from: P3,
          to: P1,
          kind: "pact",
          name: null,
          text: "Peace\u0007 for two days?",
          until: null,
          expiresAt: NOW + 43200,
        },
      ),
      event(
        NOW - 800,
        "message",
        [
          [P2, "self"],
          [P1, "target"],
        ],
        {
          message: oid("g", 1),
          from: P2,
          to: [P1],
          text: "Hold c3, I come.",
        },
      ),
      event(NOW - 700, "battle_report", [[P1, "self"]], {
        report: oid("r", 1),
        city: "c6",
        attacker: P1,
        defender: P4,
        kind: "raid",
        winner: "defender",
        lost: { soldier: 3 },
      }),
      event(
        NOW - 600,
        "battle",
        [],
        { city: "c6", attacker: P1, defender: P4, kind: "raid", winner: "defender" },
        true,
      ),
    ],
    wake,
  );
}

// perfidia-1 -----------------------------------------------------------------------------------------

const noop = (): void => undefined;
const unimplemented = (): never => {
  throw new Error("a wave-4 hook (T11)");
};

/** A test-only perfidia-1 descriptor from the wave-3 modules (the real one is T11's). */
export const perfidiaRuleset: Ruleset<p1.PerfidiaConfig, p1.PerfidiaExt> = {
  id: p1.PERFIDIA_1_ID,
  version: p1.PERFIDIA_1_VERSION,
  ref: p1.PERFIDIA_1_REF,
  status: "published",
  title: "Perfidia V1",
  configSchema: p1.PerfidiaConfigSchema,
  defaults: p1.PERFIDIA_1_DEFAULTS,
  extSchema: p1.PerfidiaExtSchema,
  players: p1.playerRange,
  compile: p1.compileRules,
  check: p1.checkConfig,
  cheatSheet: p1.renderCheatSheet,
  hooks: {
    createWorld: p1.createWorld,
    travelTime: p1.travelTime,
    arrive: { attack: unimplemented, spy: unimplemented },
    on: { siege_end: noop, domination_open: noop, domination_end: noop },
    standings: (r) => p1.computeStandings(r.config, r.state, r.ext()),
    finish: unimplemented,
  },
  errors: p1.PERFIDIA_1_ERRORS,
  errorSamples: p1.PERFIDIA_1_ERROR_SAMPLES,
  eventSchemas: {},
};

export function perfidiaSetup(players: number, seed = 42): MatchSetup {
  return {
    ruleset: p1.PERFIDIA_1_REF,
    overrides: {},
    seed,
    idKey: idKeyFromSeed(seed),
    seats: Array.from({ length: players }, (_, i) => ({ id: PlayerIdSchema.parse(`p${i + 1}`) })),
  };
}

/** A fresh perfidia-1 match at t = 0 (the world of `createWorld`). */
export function perfidiaMatch(players: number, seed = 42): Match {
  return createMatch(perfidiaSetup(players, seed), perfidiaRuleset, fakeDomain, {
    invariants: "step",
  });
}

/** The perfidia-1 gateway rules. */
export function perfidiaGateway(): GatewayRules {
  return gatewayRulesCopy(p1.compileRules(p1.PERFIDIA_1_DEFAULTS, 8).gateway);
}

// Comparison helpers -----------------------------------------------------------------------------------

/** Canonical JSON of anything a view returns. */
export function text(value: unknown): string {
  return canonicalJson(value);
}

/** Mutates every object and array reachable from `value` (a chaos agent's treatment, P16-style). */
export function scribble(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) scribble(v);
    value.push("scribbled");
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    scribble(v);
    if (typeof v === "number") Reflect.set(value, key, -1);
    if (typeof v === "string") Reflect.set(value, key, "scribbled");
  }
  Reflect.set(value, "scribbled", true);
}

/** Freezes every object reachable from `value`. */
export function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const v of Object.values(value)) deepFreeze(v);
}
