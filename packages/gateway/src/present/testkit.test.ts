// Shared fixtures for the presentation tests (no tests here): a hand-built fixture-ruleset world
// with four players, a perfidia-1 test descriptor assembled from the wave-3 modules with T11's
// visibility extras emulated (the real descriptor is T11's), gateway states fed with events, and
// helpers to compare outputs.

import { canonicalJson, fmtTime, idKeyFromSeed } from "@perfidia/engine/core";
import type { AnyRuleset, ReadCtx, Ruleset, Visibility } from "@perfidia/engine/contracts";
import { createMatch, type Match } from "@perfidia/engine/kernel";
import * as p1 from "@perfidia/engine/rulesets/perfidia-1";
import { defaultVisibility, relation, sortedIds } from "@perfidia/engine/std";
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

/**
 * Edits of the fixture world for property P10, applied in order after every entity of the base
 * world exists. All but `pact` and `homecoming` edit data hidden from p1. A `homecoming` adds a
 * return into a held city (c3, held by p4: p1's return; c5, held by p1: p3's return), coming from
 * the city next door; its besieger sees it, but not its recorded party (the target of the attack it
 * was) nor whether it was turned back (`back`).
 */
export type Perturbation =
  | { kind: "stock"; city: "c5" | "c6"; amount: number }
  | { kind: "units"; city: "c5" | "c6"; soldiers: number }
  | { kind: "attack"; soldiers: number; arriveIn: number }
  | { kind: "support"; soldiers: number; arriveIn: number }
  | { kind: "spy"; gold: number; arriveIn: number }
  | { kind: "found"; arriveIn: number }
  | { kind: "proposal" }
  | { kind: "counters"; owner: "p3" | "p4"; m: number; r: number; q: number; g: number }
  | { kind: "queue" }
  | { kind: "pact" }
  | { kind: "homecoming"; city: "c3" | "c5"; party: PlayerId | null; back: boolean };

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
    case "spy":
      addMovement(state, rules, {
        kind: "spy",
        owner: P3,
        from: "c5",
        to: "c1",
        party: P1,
        gold: p.gold,
        arriveAt: NOW + p.arriveIn,
      });
      return;
    case "found":
      addMovement(state, rules, {
        kind: "found",
        owner: P4,
        from: "c6",
        to: null,
        toIsland: "i1",
        units: { pioneer: 1, soldier: 2 },
        arriveAt: NOW + p.arriveIn,
      });
      return;
    case "homecoming": {
      const c3 = p.city === "c3";
      addMovement(state, rules, {
        kind: "return",
        owner: c3 ? P1 : P3,
        from: c3 ? "c4" : "c6",
        to: c3 ? "c3" : "c5",
        home: c3 ? "c3" : "c5",
        party: p.party,
        units: { soldier: 6 },
        departAt: NOW - 100,
        arriveAt: NOW + 3500,
        back: p.back ? { kind: "attack", at: NOW - 100 } : null,
      });
      return;
    }
    case "proposal":
      addProposal(state, rules, { from: P4, to: P3, kind: "alliance", name: "Secret" });
      return;
    case "counters": {
      const own = state.ids.own[p.owner];
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

/** Edits of the other seats' gateway state, all hidden from p1 (property P10). */
export type GwEdit =
  | { kind: "note"; seat: "p2" | "p3" | "p4"; text: string }
  | { kind: "message"; from: "p3" | "p4"; to: "p2" | "p3" | "p4"; n: number }
  | { kind: "day"; seat: "p2" | "p3" | "p4"; attacks: number; messages: number };

export function applyGwEdit(gw: GatewayState, wake: WakeScheduler, e: GwEdit): void {
  if (e.kind === "message") {
    if (e.from === e.to) return;
    const data = { message: oid("g", 900 + e.n), from: e.from, to: [e.to], text: "secret" };
    const to: [PlayerId, Role][] = [
      [e.from, "self"],
      [e.to, "target"],
    ];
    deliver(gw, [event(NOW - 50, "message", to, data)], wake);
    return;
  }
  const s = gw.seats[e.seat];
  if (s === undefined) return;
  if (e.kind === "note") {
    s.notes = e.text;
    return;
  }
  s.day.attacks = e.attacks;
  s.day.messages = e.messages;
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

type PerfidiaRead = ReadCtx<p1.PerfidiaConfig, p1.PerfidiaExt>;

function pair(t: number): [number, string] {
  return [t, fmtTime(t)];
}

/** perfidia-1 §13.2: every running countdown with the bloc's cities against the threshold. */
function countdowns(r: PerfidiaRead): JsonObject[] {
  const need = p1.dominationThreshold(r.config, r.rules.players, p1.totalCities(r.state));
  return r.ext().domination.countdowns.map((c) => ({
    key: c.bloc,
    members: [...c.members],
    cities: p1.blocCities(r.state, c.members),
    need,
    ends: pair(c.endsAt),
  }));
}

/**
 * perfidia-1's visibility extras (§12), as T11's descriptor renders them: city points, the Crown
 * flag and the siege on every city; the tie-break position of every player; the tie-break order
 * and the domination state of the match; and, in the briefing, the sieges the seat holds and every
 * running countdown. The budget tests measure the briefing with them (they count in §8.2's 2,400).
 */
const perfidiaVisibility: Visibility<p1.PerfidiaConfig, p1.PerfidiaExt> = {
  cityAccess: (r, viewer, city) => defaultVisibility.cityAccess(r, viewer, city),
  movementAccess: (r, viewer, m) => defaultVisibility.movementAccess(r, viewer, m),
  publicCity(r, _viewer, city) {
    const c = r.state.cities[city];
    if (c === undefined) return {};
    let levels = 0;
    for (const b of p1.BUILDING_IDS) levels += c.buildings[b] ?? 0;
    const crown = c.tag === p1.CROWN_TAG;
    const out: JsonObject = { points: p1.cityPoints(r.config, levels, crown) };
    if (crown) out["crown"] = true;
    const siege = p1.siegeOf(r.ext(), city);
    if (siege !== null) out["siege"] = { by: siege.by, ends: pair(siege.endsAt) };
    return out;
  },
  publicPlayer: (r, p) => ({ tiebreak: p1.tiebreakPosition(r.ext(), p) + 1 }),
  publicMatch(r) {
    const x = r.ext();
    return {
      tiebreak: [...x.tiebreak],
      domination: {
        open: x.domination.open,
        need: p1.dominationThreshold(r.config, r.rules.players, p1.totalCities(r.state)),
        countdowns: countdowns(r),
      },
    };
  },
  briefing(r, viewer) {
    const holding = sortedIds(r.ext().sieges).flatMap((city) => {
      const siege = p1.siegeOf(r.ext(), city);
      if (siege === null || siege.by !== viewer) return [];
      return [{ city, owner: r.state.cities[city]?.owner ?? null, ends: pair(siege.endsAt) }];
    });
    return { holding, countdowns: countdowns(r) };
  },
};

/**
 * A test-only perfidia-1 descriptor from the wave-3 modules, with T11's visibility extras emulated
 * (the real descriptor is T11's `perfidia1_1_0_0`; T14 should point the tests at it).
 */
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
    visibility: perfidiaVisibility,
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
