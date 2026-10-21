// Properties of the default domain (docs/architecture.md §13.2), on the testing kit's fixture hooks
// plus the domain defaults: P3 (validation and the exported derivations never write; a rejected
// action leaves the hash unchanged), P4 (random action intents and time advances never throw and keep the step
// invariants), P9 (the insertion order of the state's records changes nothing) and fog-safe
// violation details (data hidden from a seat never changes its answers).

import { describe, expect, test } from "bun:test";
import { canonicalJson, shuffle, streamRng, type Rng } from "@perfidia/engine/core";
import type { ActionHandler, AnyRuleset, ReadCtx } from "@perfidia/engine/contracts";
import {
  EngineMisuse,
  createMatch,
  loadMatch,
  resolveConfig,
  type Match,
} from "@perfidia/engine/kernel";
import { sortedIds, unitsAtHome } from "@perfidia/engine/std";
import {
  addBuildItem,
  addCity,
  addMovement,
  addPact,
  addProposal,
  addRecruitBatch,
  addStationed,
  testStep,
} from "@perfidia/engine/testing";
import {
  ACTION_TYPES,
  GameStateSchema,
  compareIds,
  JsonSchema,
  type Action,
  type CityId,
  type GameState,
  type IslandId,
  type Json,
  type JsonObject,
  type MovementId,
  type PlayerId,
  type ProposalId,
  type UnitCounts,
} from "@perfidia/protocol";
import fc from "fast-check";
import { domain, recruitMax } from "./index.ts";
import {
  CAPITAL,
  FIXTURE,
  RICH,
  RICH_OPTIONS,
  emptyState,
  load,
  setupOf,
} from "./fixtures.test.ts";

// The slow suite (PERFIDIA_SLOW=1: `bun run test:slow`, run by `bun run test:exit`; docs/
// architecture.md §13.8). Read through `import.meta.env`: the pure packages' tests may not name the
// `process` global.
const SLOW = import.meta.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

// Intents ------------------------------------------------------------------------------------------

/** An action intent, resolved against the current state so that most are valid. */
interface Act {
  readonly k: "act";
  readonly seat: number;
  readonly kind: number;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  /** 0: junk (unknown or foreign ids); otherwise a normal intent. */
  readonly junk: number;
}
type Intent =
  | Act
  | { readonly k: "advance"; readonly dt: number }
  | { readonly k: "back" }
  | { readonly k: "stranger" };

const nat = fc.nat({ max: 1_000_000 });
const actArb: fc.Arbitrary<Act> = fc.record({
  k: fc.constant("act" as const),
  seat: nat,
  kind: nat,
  a: nat,
  b: nat,
  c: nat,
  junk: fc.nat({ max: 7 }),
});
const intentArb: fc.Arbitrary<Intent> = fc.oneof(
  { weight: 12, arbitrary: actArb },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant("advance" as const),
      dt: fc.oneof(fc.integer({ min: 1, max: 900 }), fc.integer({ min: 900, max: 9000 })),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ k: "back" as const }) },
  { weight: 1, arbitrary: fc.constant({ k: "stranger" as const }) },
);

function pick<T>(list: readonly T[], n: number): T | undefined {
  return list.length === 0 ? undefined : list[n % list.length];
}

const KINDS = ACTION_TYPES;

/** A group of the city's units at home: a share of each unit, every carrier, never empty. */
function groupOf(r: ReadCtx, city: CityId, n: number): UnitCounts {
  const home = unitsAtHome(r, city);
  const out: UnitCounts = {};
  r.rules.units.forEach((u, i) => {
    const have = home[u.id] ?? 0;
    if (have === 0 || u.id === r.rules.roles.settler) return;
    const take = u.capacity > 0 ? have : Math.floor((have * ((n + i) % 4)) / 3);
    if (take > 0) out[u.id] = take;
  });
  if (Object.keys(out).length === 0) out[r.rules.units[0]?.id ?? "soldier"] = 1;
  return out;
}

/** Resolves an intent against the state (sorted ids only, so insertion order never matters). */
function resolveIntent(r: ReadCtx, i: Act): { seat: PlayerId; action: Action } {
  const s = r.state;
  const players = sortedIds(s.players);
  const seat = pick(players, i.seat) ?? "p1";
  const others = players.filter((p) => p !== seat);
  const cities = sortedIds(s.cities);
  const own = cities.filter((c) => s.cities[c]?.owner === seat);
  const junk = i.junk === 0;
  const from: CityId = junk ? (pick(cities, i.a) ?? "c99") : (pick(own, i.a) ?? "c99");
  const to: CityId = junk && i.b % 2 === 0 ? "c99" : (pick(cities, i.b) ?? "c99");
  const kind = pick(KINDS, i.kind) ?? "build";
  const other: PlayerId = junk ? "p9" : (pick(others, i.b) ?? "p9");
  switch (kind) {
    case "build":
      return {
        seat,
        action: {
          type: "build",
          city: from,
          building: junk ? "castle" : (pick(r.rules.buildings, i.b)?.id ?? "castle"),
        },
      };
    case "recruit":
      return {
        seat,
        action: {
          type: "recruit",
          city: from,
          unit: junk ? "dragon" : (pick(r.rules.units, i.b)?.id ?? "dragon"),
          count: junk ? 1 + (i.c % 1000) : 1 + (i.c % 6),
        },
      };
    case "cancel_queue": {
      const c = s.cities[from];
      const items = c === undefined ? [] : [...c.build, ...Object.values(c.recruit).flat()];
      const ids = items.map((x) => x.id).toSorted((x, y) => x - y);
      return {
        seat,
        action: { type: "cancel_queue", city: from, item: pick(ids, i.b) ?? 1 + (i.c % 9) },
      };
    }
    case "send_resources":
      return {
        seat,
        action: {
          type: "send_resources",
          from,
          to,
          res: { wood: i.c % 70, stone: (i.c * 7) % 70, gold: (i.c * 3) % 70 },
        },
      };
    case "attack":
    case "support":
      return {
        seat,
        action: {
          type: kind,
          from,
          to,
          units: junk
            ? { dragon: 1 }
            : s.cities[from] === undefined
              ? { soldier: 1 }
              : groupOf(r, from, i.c),
        },
      };
    case "spy":
      return { seat, action: { type: "spy", from, to, gold: junk ? 1 : 10 + (i.c % 60) } };
    case "found_city": {
      const units: UnitCounts = {};
      const home = s.cities[from] === undefined ? {} : unitsAtHome(r, from);
      const settler = r.rules.roles.settler;
      if ((home[settler] ?? 0) > 0) units[settler] = 1;
      for (const u of r.rules.units) {
        if (u.capacity > 0 && (home[u.id] ?? 0) > 0) units[u.id] = home[u.id] ?? 1;
      }
      if (Object.keys(units).length === 0) units[r.rules.units[0]?.id ?? "soldier"] = 1;
      const islands = sortedIds(s.islands);
      const island: IslandId = junk ? "i9" : (pick(islands, i.b) ?? "i9");
      const slot = r.rules.toolOptions.foundSlot && i.c % 2 === 0 ? i.c % 4 : null;
      return { seat, action: { type: "found_city", from, island, units, slot } };
    }
    case "recall": {
      const mine = sortedIds(s.movements).filter((m) => s.movements[m]?.owner === seat);
      const all = sortedIds(s.movements);
      const movement: MovementId = (junk ? pick(all, i.a) : pick(mine, i.a)) ?? "m00000";
      return { seat, action: { type: "recall", movement } };
    }
    case "recall_stationed": {
      const at =
        pick(
          cities.filter((c) => s.cities[c]?.stationed.some((g) => g.owner === seat)),
          i.a,
        ) ?? to;
      const groups = s.cities[at]?.stationed.filter((g) => g.owner === seat) ?? [];
      const g = pick(groups, i.b);
      const unit = r.rules.units.find((u) => (g?.units[u.id] ?? 0) > 0)?.id;
      const mode = i.c % 3;
      return {
        seat,
        action: {
          type: "recall_stationed",
          at,
          home: mode === 2 ? (g?.home ?? from) : null,
          units: mode === 0 || unit === undefined ? null : { [unit]: 1 + (i.c % 3) },
        },
      };
    }
    case "dismiss": {
      const c = s.cities[from];
      const guests = [...new Set(c?.stationed.map((g) => g.owner) ?? [])].toSorted(compareIds);
      return { seat, action: { type: "dismiss", city: from, player: pick(guests, i.b) ?? other } };
    }
    case "send_message":
      return {
        seat,
        action: {
          type: "send_message",
          to: i.c % 4 === 0 ? "all" : [other],
          text: "x".repeat(i.c % 60),
        },
      };
    case "propose": {
      const alliance = i.c % 2 === 0;
      const until =
        !alliance && r.rules.toolOptions.pactUntil && i.c % 3 === 0 ? r.now + 900 : null;
      return {
        seat,
        action: {
          type: "propose",
          to: other,
          kind: alliance ? "alliance" : "pact",
          name: alliance && i.c % 3 === 0 ? "Bloc" : null,
          text: "deal",
          until,
        },
      };
    }
    case "answer": {
      const mine = sortedIds(s.proposals).filter((q) => s.proposals[q]?.to === seat);
      const proposal: ProposalId =
        (junk ? pick(sortedIds(s.proposals), i.a) : pick(mine, i.a)) ?? "q00000";
      return { seat, action: { type: "answer", proposal, accept: i.c % 4 !== 0 } };
    }
    case "leave":
      return { seat, action: { type: "leave", with: i.c % 3 === 0 ? null : other } };
    case "ext":
      break;
  }
  return {
    seat,
    action: { type: "ext", tool: "fixture_rename", args: { city: from, name: `N${i.c % 100}` } },
  };
}

// Starts ------------------------------------------------------------------------------------------

/**
 * Three players with two cities each (each with a queued build item and recruit batch), groups
 * from two homes in one city, a held city, a pact between p1 and p2 with an alliance proposal
 * between them, a pact proposal, an attack in flight.
 */
function richStart(ruleset: AnyRuleset): GameState {
  const { state, rules } = emptyState({ ruleset });
  const cities: [PlayerId, CityId, IslandId][] = [
    ["p1", "c1", "i1"],
    ["p2", "c2", "i2"],
    ["p3", "c3", "i1"],
    ["p1", "c4", "i2"],
    ["p2", "c5", "i1"],
    ["p3", "c6", "i2"],
  ];
  for (const [owner, id, island] of cities) {
    addCity(state, rules, {
      owner,
      id,
      island,
      buildings: CAPITAL,
      stock: 800,
      units: { soldier: 20, ship: 2, pioneer: 1 },
      capital: Number(id.slice(1)) <= 3,
    });
    addBuildItem(state, rules, id, "woodcut");
    addRecruitBatch(state, rules, id, "soldier", 2);
  }
  addStationed(state, "c2", { owner: "p1", home: "c1", role: "support", units: { soldier: 5 } });
  addStationed(state, "c2", { owner: "p1", home: "c4", role: "support", units: { soldier: 3 } });
  addStationed(state, "c1", { owner: "p2", home: "c2", role: "support", units: { soldier: 4 } });
  addStationed(state, "c5", { owner: "p3", home: "c3", role: "hold", units: { soldier: 2 } });
  addPact(state, rules, "p1", "p2", { expiresAt: 7200 });
  addProposal(state, rules, { from: "p1", to: "p2", kind: "alliance" });
  addProposal(state, rules, { from: "p3", to: "p1", kind: "pact" });
  addMovement(state, rules, {
    kind: "attack",
    owner: "p2",
    from: "c5",
    to: "c3",
    party: "p3",
    units: { soldier: 3 },
    arriveAt: 3600,
  });
  return state;
}

// Running intents ---------------------------------------------------------------------------------

function handlerOf(ruleset: AnyRuleset, a: Action): ActionHandler | undefined {
  const own = ruleset.hooks.actions?.[a.type];
  if (own !== undefined) return own;
  return a.type === "ext" ? undefined : domain.actions[a.type];
}

interface Coverage {
  accepted: Record<string, number>;
  superseded: number;
  multiGroup: number;
}

function newCoverage(): Coverage {
  return { accepted: {}, superseded: 0, multiGroup: 0 };
}

/**
 * Runs one intent on `m`, checking P3 on the way: validation leaves the hash unchanged, and so does
 * a rejected action. Returns a canonical summary of what happened (for P9).
 */
function step(m: Match, intent: Intent, cov?: Coverage): string {
  if (intent.k === "advance") {
    const out = m.advanceTo(m.now + intent.dt);
    return canonicalJson({ out, h: m.hash() });
  }
  if (intent.k === "back") {
    if (m.now > 0) expect(() => m.advanceTo(m.now - 1)).toThrow(EngineMisuse);
    return "back";
  }
  if (intent.k === "stranger") {
    expect(() => m.apply("p9", { type: "leave", with: null })).toThrow(EngineMisuse);
    return "stranger";
  }
  const { seat, action } = resolveIntent(m.read(), intent);
  const before = m.hash();
  const handler = handlerOf(m.ruleset, action);
  if (handler !== undefined) {
    handler.validate(m.read(), seat, action);
    expect(m.hash()).toBe(before);
  }
  const r = m.read();
  const probed: CityId[] = [...sortedIds(r.state.cities), "c99"];
  for (const city of probed) {
    for (const unit of [...r.rules.units.map((u) => u.id), "dragon"]) recruitMax(r, city, unit);
  }
  expect(m.hash()).toBe(before);
  const out = m.apply(seat, action);
  if (!out.ok) expect(m.hash()).toBe(before);
  if (cov !== undefined) {
    if (out.ok) cov.accepted[action.type] = (cov.accepted[action.type] ?? 0) + 1;
    if (
      out.ok &&
      out.events.some((e) => e.type === "pact_ended" && e.data["cause"] === "superseded")
    ) {
      cov.superseded += 1;
    }
    const returns = out.ok ? out.data["returns"] : null;
    if (
      action.type === "recall_stationed" &&
      ((Array.isArray(returns) && returns.length > 1) ||
        (!out.ok && out.violation.code === "AMBIGUOUS_GROUP"))
    ) {
      cov.multiGroup += 1;
    }
  }
  return canonicalJson({ out, h: m.hash() });
}

// P3 and P4 ---------------------------------------------------------------------------------------

/** P4 from the hand-built start of `ruleset`, checking the invariants at the end of each run. */
function fromStart(ruleset: AnyRuleset, params: fc.Parameters<[Intent[]]>, cov?: Coverage): void {
  fc.assert(
    fc.property(fc.array(intentArb, { minLength: 1, maxLength: 40 }), (intents) => {
      const m = load(richStart(ruleset), ruleset);
      for (const intent of intents) step(m, intent, cov);
      m.checkInvariants("checkpoint");
    }),
    params,
  );
}

describe("P4: random intents never throw and keep the step invariants (P3 on the way)", () => {
  const rulesets: [string, AnyRuleset][] = [
    ["fixture", FIXTURE],
    ["rich", RICH],
    ["rich with tool options", RICH_OPTIONS],
  ];

  for (const [name, ruleset] of rulesets) {
    test(`${name}: from a hand-built world`, () => {
      // 20 runs outside the slow suite, which runs 60 (P4 at scale is there too).
      fromStart(ruleset, { numRuns: SLOW ? 60 : 20 });
    });

    // A fixed seed, so that this check of the generator's reach is reproducible: most kinds are
    // accepted, alliances between pact partners happen, and partial or whole recalls meet groups
    // from several homes.
    xtest(`${name}: the intents reach every kind of action (seeded)`, () => {
      const cov = newCoverage();
      fromStart(ruleset, { numRuns: 150, seed: 20261010 }, cov);
      for (const type of KINDS) {
        if (
          type === "dismiss" &&
          !ruleset.compile(resolvedConfig(ruleset), 3).movement.recall.dismiss
        ) {
          continue;
        }
        expect([type, cov.accepted[type] ?? 0]).not.toEqual([type, 0]);
      }
      expect(cov.superseded).toBeGreaterThan(0);
      expect(cov.multiGroup).toBeGreaterThan(0);
    }, 30000);

    test(`${name}: from createWorld`, () => {
      fc.assert(
        fc.property(
          fc.nat({ max: 1000 }),
          fc.array(intentArb, { maxLength: 40 }),
          (seed, intents) => {
            const m = createMatch(setupOf(ruleset, 3, seed), ruleset, domain, {
              invariants: "step",
            });
            for (const intent of intents) step(m, intent);
            m.advanceTo(m.rules.time.matchEnd);
            expect(m.ended).toBe(true);
          },
        ),
        { numRuns: 25 },
      );
    });
  }
});

// P9 ----------------------------------------------------------------------------------------------

function reorder(value: Json, rng: Rng): Json {
  if (Array.isArray(value)) return value.map((v) => reorder(v, rng));
  if (value === null || typeof value !== "object") return value;
  const out: JsonObject = {};
  for (const key of shuffle(rng, Object.keys(value))) {
    const v = value[key];
    if (v !== undefined) out[key] = reorder(v, rng);
  }
  return out;
}

test("P9: shuffling the insertion order of every record changes neither the hash nor what follows", () => {
  fc.assert(
    fc.property(
      fc.array(intentArb, { maxLength: 20 }),
      fc.array(intentArb, { minLength: 1, maxLength: 20 }),
      fc.nat(),
      (prefix, suffix, seed) => {
        const a = load(richStart(RICH));
        const b = load(richStart(RICH));
        for (const intent of prefix) expect(step(b, intent)).toBe(step(a, intent));
        if (a.ended) return;
        testStep(a, () => {});
        testStep(b, (ctx) => {
          const copy = JsonSchema.parse(JSON.parse(JSON.stringify(ctx.state)));
          Object.assign(ctx.state, GameStateSchema.parse(reorder(copy, streamRng(seed, "p9"))));
        });
        expect(b.hash()).toBe(a.hash());
        const c = loadMatch(a.snapshot(0), RICH, domain, { invariants: "step" });
        for (const intent of suffix) {
          const expected = step(a, intent);
          expect(step(b, intent)).toBe(expected);
          expect(step(c, intent)).toBe(expected);
        }
      },
    ),
    // 20 runs outside the slow suite, which runs 60 (P9 through bot runs:
    // sim/src/hardening/p9.test.ts).
    { numRuns: SLOW ? 60 : 20 },
  );
}, 30000);

// Fog-safe violation details ---------------------------------------------------------------------

interface Hidden {
  readonly stock: number;
  readonly units: number;
  readonly counters: number;
  readonly queue: boolean;
}

/**
 * Changes only data hidden from p1 (who shares no alliance): p2's and p3's stocks and home units,
 * p3's garrison size in p2's city, their id counters, a queued build in p3's city, a movement
 * between p3's own cities, a spy of p2 on p3, a proposal between p2 and p3. Returns the hidden ids.
 */
function hide(state: GameState, h: Hidden): { movement: MovementId; proposal: ProposalId } {
  const rules = RICH.compile(resolvedConfig(), 3);
  for (const id of ["c2", "c3", "c5", "c6"] as const) {
    const c = state.cities[id];
    if (c === undefined) continue;
    const v = (h.stock % 900) * 3600;
    c.stock = { wood: v, stone: v, gold: v };
    c.units = { soldier: 1 + (h.units % 40), ship: h.units % 3 };
    if (c.units["ship"] === 0) delete c.units["ship"];
  }
  const held = state.cities["c5"]?.stationed.find((g) => g.owner === "p3");
  if (held !== undefined) held.units = { soldier: 1 + (h.units % 7) };
  for (const p of ["p2", "p3"] as const) {
    const own = state.ids.own[p];
    if (own !== undefined) {
      own.m += h.counters % 5;
      own.q += h.counters % 3;
      own.r += h.counters % 4;
      own.g += h.counters % 6;
    }
  }
  if (h.queue) addBuildItem(state, rules, "c3", "woodcut");
  const mv = addMovement(state, rules, {
    kind: "support",
    owner: "p3",
    from: "c3",
    to: "c6",
    party: "p3",
    units: { soldier: 1 },
    arriveAt: state.now + 5400,
  });
  addMovement(state, rules, {
    kind: "spy",
    owner: "p2",
    from: "c2",
    to: "c3",
    party: "p3",
    gold: 50,
    arriveAt: state.now + 5400,
  });
  const q = addProposal(state, rules, { from: "p2", to: "p3", kind: "pact" });
  return { movement: mv.id, proposal: q.id };
}

function resolvedConfig(ruleset: AnyRuleset = RICH): unknown {
  const resolved = resolveConfig(ruleset, {});
  if (!resolved.ok) throw new Error("config");
  return resolved.config;
}

function readOf(state: GameState): ReadCtx {
  const config = resolvedConfig();
  return {
    state,
    now: state.now,
    rules: RICH.compile(config, 3),
    config,
    ruleset: RICH,
    ext: () => state.ext,
  };
}

/** The verdict of `a` for p1 as the kernel would give it: guard, then the handler's validate. */
function verdictOf(r: ReadCtx, a: Action): string {
  const guard = r.ruleset.hooks.guard?.(r, "p1", a) ?? null;
  if (guard !== null) return canonicalJson({ ok: false, violation: guard });
  const handler = handlerOf(r.ruleset, a);
  if (handler === undefined) return "no handler";
  const v = handler.validate(r, "p1", a);
  return canonicalJson(v.ok ? { ok: true, warnings: v.warnings ?? [] } : v);
}

test("violation details are fog-safe: data hidden from the seat never changes its answers", () => {
  fc.assert(
    fc.property(
      fc.record({
        stock: fc.nat(),
        units: fc.nat(),
        counters: fc.nat(),
        queue: fc.boolean(),
      }),
      fc.array(actArb, { minLength: 1, maxLength: 30 }),
      (h, acts) => {
        const base = richStart(RICH);
        const perturbed = richStart(RICH);
        const hidden = hide(perturbed, h);
        const visible = readOf(base);
        const changed = readOf(perturbed);
        const probes: Action[] = [
          { type: "recall", movement: hidden.movement },
          { type: "answer", proposal: hidden.proposal, accept: true },
          ...acts.map((i) => resolveIntent(visible, { ...i, seat: 0 }).action),
        ];
        for (const a of probes) expect(verdictOf(changed, a)).toBe(verdictOf(visible, a));
      },
    ),
    // 30 runs outside the slow suite, which runs 100.
    { numRuns: SLOW ? 100 : 30 },
  );
});
