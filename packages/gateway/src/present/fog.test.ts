import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { idKeyFromSeed, opaqueId } from "@perfidia/engine/core";
import type { AnyRuleset } from "@perfidia/engine/contracts";
import type { Match } from "@perfidia/engine/kernel";
import { fixtureRuleset } from "@perfidia/engine/testing";
import type { GatewayState } from "@perfidia/gateway/seat";
import type { PlayerId, Violation } from "@perfidia/protocol";
import {
  buildBriefing,
  leaderboard,
  toolError,
  viewCity,
  viewIsland,
  viewMap,
  viewPlayer,
} from "./index.ts";
import {
  P1,
  P2,
  P3,
  P4,
  feedP1,
  fixtureMatch,
  gatewayFor,
  grantingRuleset,
  text,
  wakeRecord,
  type Perturbation,
} from "./testkit.test.ts";

// Property P10 at one state (docs/architecture.md §13.2), for the presentation: two states that
// differ only in data hidden from p1 give p1 byte-identical views, briefing and errors. The
// perturbations (testkit `Perturbation`) add, remove or change entities p1 cannot see and other
// owners' id counters, and are applied after every entity p1 can see exists, so no visible id
// changes. Checked with the default visibility, which hides an ally's outgoing movements, and with
// a ruleset that grants allies full access to them.

/** p1's first hidden movement id in a perturbed world: p3's second movement (the first attacks c1). */
const HIDDEN_MOVEMENT = opaqueId(idKeyFromSeed(7), "m", 3, 2);

/** Violations a call of p1 could get, naming its own data or ids that may be hidden from it. */
const VIOLATIONS: readonly Violation[] = [
  { code: "INSUFFICIENT_RESOURCES", details: { city: "c1", need_wood: 900, building: "tower" } },
  { code: "EXCEEDS_STORAGE", details: { city: "c1", need_gold: 5000 } },
  { code: "INSUFFICIENT_POPULATION", details: { city: "c1", unit: "soldier", count: 100 } },
  { code: "REQUIREMENT_MISSING", details: { city: "c3", unit: "pioneer" } },
  { code: "QUEUE_FULL", details: { city: "c1", queue: "build", max: 3 } },
  { code: "QUEUE_ITEM", details: { city: "c1", item: 7 } },
  { code: "INSUFFICIENT_UNITS", details: { city: "c1" } },
  { code: "AMBIGUOUS_GROUP", details: { city: "c5" } },
  { code: "UNKNOWN_ID", details: { movement: HIDDEN_MOVEMENT } },
  { code: "NOT_RECALLABLE", details: { movement: HIDDEN_MOVEMENT } },
  { code: "NOT_OWNER", details: { city: "c6" } },
  { code: "NOT_OWNER", details: { movement: HIDDEN_MOVEMENT } },
  { code: "INSUFFICIENT_RESOURCES", details: { city: "c5", need_gold: 900, have_gold: 1 } },
  { code: "ALREADY_ALLIED", details: { player: P2 } },
];

/** Everything p1 can see, as canonical JSON. */
function seenBy(match: Match, gw: GatewayState, seat: PlayerId): string {
  const r = match.read();
  const env = { r, seat, gw };
  return text({
    cities: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c99"].map((c) => viewCity(r, seat, c, gw)),
    islands: ["i1", "i2", "i9"].map((i) => viewIsland(r, seat, i)),
    maps: [viewMap(r, seat), viewMap(r, seat, "c1"), viewMap(r, seat, "c6")],
    players: [P1, P2, P3, P4, "p9"].map((p) => viewPlayer(r, seat, p, gw)),
    board: leaderboard(r),
    briefing: buildBriefing(r, seat, gw, wakeRecord(["incoming_attack", "safety"], true)),
    errors: VIOLATIONS.map((v) => toolError(v, env)),
  });
}

function seenIn(perturb: readonly Perturbation[], ruleset: AnyRuleset): string {
  const match = fixtureMatch(perturb, ruleset);
  const { gw, wake } = gatewayFor(match);
  feedP1(gw, wake, match.read());
  return seenBy(match, gw, P1);
}

const hidden: fc.Arbitrary<Perturbation> = fc.oneof(
  fc.record({
    kind: fc.constant("stock" as const),
    city: fc.constantFrom("c5" as const, "c6" as const),
    amount: fc.integer({ min: 1, max: 500 }),
  }),
  fc.record({
    kind: fc.constant("units" as const),
    city: fc.constantFrom("c5" as const, "c6" as const),
    soldiers: fc.integer({ min: 1, max: 60 }),
  }),
  fc.record({
    kind: fc.constant("attack" as const),
    soldiers: fc.integer({ min: 1, max: 30 }),
    arriveIn: fc.integer({ min: 3600, max: 40000 }),
  }),
  fc.record({
    kind: fc.constant("support" as const),
    soldiers: fc.integer({ min: 1, max: 30 }),
    arriveIn: fc.integer({ min: 3600, max: 40000 }),
  }),
  fc.constant({ kind: "proposal" as const }),
  fc.record({
    kind: fc.constant("counters" as const),
    m: fc.nat(40),
    r: fc.nat(40),
    q: fc.nat(40),
    g: fc.nat(40),
  }),
  fc.constant({ kind: "queue" as const }),
);

describe("P10 at one state: views, briefing and errors", () => {
  for (const [name, ruleset] of [
    ["default visibility (allies never see each other's outgoing movements)", fixtureRuleset],
    ["allies granted full movement access", grantingRuleset],
  ] as const) {
    test(name, () => {
      const base = seenIn([], ruleset);
      fc.assert(
        fc.property(fc.array(hidden, { minLength: 1, maxLength: 5 }), (perturb) => {
          expect(seenIn(perturb, ruleset)).toBe(base);
        }),
        { numRuns: 40 },
      );
    });
  }

  test("every kind of perturbation really changes the state (the property is not vacuous)", () => {
    const base = fixtureMatch().hash();
    const samples: Perturbation[] = [
      { kind: "stock", city: "c5", amount: 10 },
      { kind: "units", city: "c6", soldiers: 1 },
      { kind: "attack", soldiers: 1, arriveIn: 3600 },
      { kind: "support", soldiers: 1, arriveIn: 3600 },
      { kind: "proposal" },
      { kind: "counters", m: 1, r: 0, q: 0, g: 0 },
      { kind: "queue" },
    ];
    for (const p of samples) expect(fixtureMatch([p]).hash()).not.toBe(base);
  });

  test("the comparison can fail: a public change (a pact) or a visible movement shows", () => {
    const base = seenIn([], fixtureRuleset);
    expect(seenIn([{ kind: "pact" }], fixtureRuleset)).not.toBe(base);
    // Under the granting ruleset p1 sees p2's outgoing attack, which the default hides.
    expect(seenIn([], grantingRuleset)).not.toBe(base);
  });

  test("a hidden id reads exactly like a missing one", () => {
    const plain = fixtureMatch();
    const perturbed = fixtureMatch([{ kind: "attack", soldiers: 3, arriveIn: 9000 }]);
    expect(Object.hasOwn(perturbed.read().state.movements, HIDDEN_MOVEMENT)).toBe(true);
    expect(Object.hasOwn(plain.read().state.movements, HIDDEN_MOVEMENT)).toBe(false);
    for (const match of [plain, perturbed]) {
      const { gw } = gatewayFor(match);
      const env = { r: match.read(), seat: P1, gw };
      expect(
        toolError({ code: "UNKNOWN_ID", details: { movement: HIDDEN_MOVEMENT } }, env),
      ).toEqual({
        ok: false,
        t: 7200,
        code: "UNKNOWN_ID",
        message: `No movement ${HIDDEN_MOVEMENT} is known to you.`,
        hint: "view_player on yourself lists your movements; view_city shows those you can see.",
        details: { movement: HIDDEN_MOVEMENT },
      });
    }
  });
});
