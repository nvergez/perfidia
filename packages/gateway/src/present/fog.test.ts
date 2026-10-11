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
  applyGwEdit,
  feedP1,
  fixtureMatch,
  gatewayFor,
  grantingRuleset,
  text,
  wakeRecord,
  type GwEdit,
  type Perturbation,
} from "./testkit.test.ts";

// Property P10 at one state (docs/architecture.md §13.2), for the presentation: two states that
// differ only in data hidden from a seat give that seat byte-identical views, briefing and errors.
// The perturbations (testkit `Perturbation`, `GwEdit`) add, remove or change entities the seat
// cannot see, other owners' id counters and the other seats' gateway state, and are applied after
// every entity the seat can see exists, so no visible id changes. Checked for p1 with the default
// visibility, which hides an ally's outgoing movements, and with a ruleset that grants allies full
// access to them; and for the besiegers p1 (of c5) and p4 (of c3) against the hidden past of a
// return heading into the city they hold.

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
  // The domain's shapes on p1's own cities and groups.
  { code: "NOTHING_STATIONED", details: { city: "c1", player: P4 } },
  { code: "NOTHING_STATIONED", details: { city: "c6", home: null } },
  { code: "INVALID_TARGET", details: { player: P1, city: "c1" } },
  { code: "PACT_LIMIT", details: { player: P3, max: 1, pacts: 1, availableAt: 57200 } },
];

/** Everything `seat` can see, as canonical JSON. */
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

function seenIn(
  perturb: readonly Perturbation[],
  ruleset: AnyRuleset,
  edits: readonly GwEdit[] = [],
  seat: PlayerId = P1,
): string {
  const match = fixtureMatch(perturb, ruleset);
  const { gw, wake } = gatewayFor(match);
  feedP1(gw, wake, match.read());
  for (const e of edits) applyGwEdit(gw, wake, e);
  return seenBy(match, gw, seat);
}

/** What `seat` sees of the fixture world with one perturbation. */
function seen(p: Perturbation, seat: PlayerId): string {
  return seenIn([p], fixtureRuleset, [], seat);
}

/** Edits of data hidden from p1. */
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
  // A spy on p1's own c1 and a founder heading to p1's island i1: seen by their sender only.
  fc.record({
    kind: fc.constant("spy" as const),
    gold: fc.integer({ min: 50, max: 300 }),
    arriveIn: fc.integer({ min: 600, max: 40000 }),
  }),
  fc.record({
    kind: fc.constant("found" as const),
    arriveIn: fc.integer({ min: 600, max: 40000 }),
  }),
  fc.constant({ kind: "proposal" as const }),
  // The id counters of p3 (whose attack on c1 p1 sees) and of p4.
  fc.record({
    kind: fc.constant("counters" as const),
    owner: fc.constantFrom("p3" as const, "p4" as const),
    m: fc.nat(40),
    r: fc.nat(40),
    q: fc.nat(40),
    g: fc.nat(40),
  }),
  fc.constant({ kind: "queue" as const }),
);

/** Edits of the other seats' gateway state: their notebooks, archives and day counters. */
const otherSeats: fc.Arbitrary<GwEdit> = fc.oneof(
  fc.record({
    kind: fc.constant("note" as const),
    seat: fc.constantFrom("p2" as const, "p3" as const, "p4" as const),
    text: fc.string({ maxLength: 40 }),
  }),
  fc.record({
    kind: fc.constant("message" as const),
    from: fc.constantFrom("p3" as const, "p4" as const),
    to: fc.constantFrom("p2" as const, "p3" as const, "p4" as const),
    n: fc.nat(20),
  }),
  fc.record({
    kind: fc.constant("day" as const),
    seat: fc.constantFrom("p2" as const, "p3" as const, "p4" as const),
    attacks: fc.nat(20),
    messages: fc.nat(20),
  }),
);

/** The hidden past of a return into a held city: its recorded party and whether it turned back. */
const pastOf = fc.record({
  party: fc.constantFrom<PlayerId | null>(P1, P2, P3, P4, null),
  back: fc.boolean(),
});

describe("P10 at one state: views, briefing and errors", () => {
  for (const [name, ruleset] of [
    ["default visibility (allies never see each other's outgoing movements)", fixtureRuleset],
    ["allies granted full movement access", grantingRuleset],
  ] as const) {
    test(name, () => {
      const base = seenIn([], ruleset);
      fc.assert(
        fc.property(
          fc.array(hidden, { minLength: 1, maxLength: 5 }),
          fc.array(otherSeats, { maxLength: 4 }),
          (perturb, edits) => {
            expect(seenIn(perturb, ruleset, edits)).toBe(base);
          },
        ),
        { numRuns: 40 },
      );
    });
  }

  test("p4, besieger of c3: a return into c3 reads the same whatever its recorded party or past", () => {
    const recalled: Perturbation = { kind: "homecoming", city: "c3", party: P3, back: true };
    const base = seen(recalled, P4);
    fc.assert(
      fc.property(pastOf, ({ party, back }) => {
        expect(seen({ kind: "homecoming", city: "c3", party, back }, P4)).toBe(base);
      }),
      { numRuns: 20 },
    );
    // Only the original target differs (p3's city, or p2's): p4 cannot tell.
    expect(seen({ ...recalled, party: P2 }, P4)).toBe(base);
    // The mover, p1, sees its own return in full, when it turned back included.
    expect(seen({ ...recalled, back: false }, P1)).not.toBe(seen(recalled, P1));
  });

  test("p1, besieger of c5: the same, with every other hidden perturbation as well", () => {
    for (const ruleset of [fixtureRuleset, grantingRuleset]) {
      const first: Perturbation = { kind: "homecoming", city: "c5", party: P4, back: true };
      const base = seenIn([first], ruleset);
      fc.assert(
        fc.property(
          pastOf,
          fc.array(hidden, { maxLength: 4 }),
          fc.array(otherSeats, { maxLength: 3 }),
          ({ party, back }, perturb, edits) => {
            const homecoming: Perturbation = { kind: "homecoming", city: "c5", party, back };
            expect(seenIn([homecoming, ...perturb], ruleset, edits)).toBe(base);
          },
        ),
        { numRuns: 30 },
      );
    }
  });

  test("every kind of perturbation really changes the state (the property is not vacuous)", () => {
    const base = fixtureMatch().hash();
    const samples: Perturbation[] = [
      { kind: "stock", city: "c5", amount: 10 },
      { kind: "units", city: "c6", soldiers: 1 },
      { kind: "attack", soldiers: 1, arriveIn: 3600 },
      { kind: "support", soldiers: 1, arriveIn: 3600 },
      { kind: "spy", gold: 100, arriveIn: 3600 },
      { kind: "found", arriveIn: 3600 },
      { kind: "proposal" },
      { kind: "counters", owner: "p3", m: 1, r: 0, q: 0, g: 0 },
      { kind: "counters", owner: "p4", m: 0, r: 1, q: 0, g: 0 },
      { kind: "queue" },
    ];
    for (const p of samples) expect(fixtureMatch([p]).hash()).not.toBe(base);
    const past = fixtureMatch([{ kind: "homecoming", city: "c3", party: P3, back: true }]).hash();
    for (const p of [
      { kind: "homecoming", city: "c3", party: P2, back: true },
      { kind: "homecoming", city: "c3", party: P3, back: false },
    ] as const) {
      expect(fixtureMatch([p]).hash()).not.toBe(past);
    }
    // The gateway edits change the other seats' state.
    const plain = fixtureMatch();
    const a = gatewayFor(plain);
    const b = gatewayFor(plain);
    for (const e of [
      { kind: "note", seat: "p3", text: "x" },
      { kind: "message", from: "p3", to: "p2", n: 1 },
      { kind: "day", seat: "p4", attacks: 2, messages: 1 },
    ] as const) {
      applyGwEdit(b.gw, b.wake, e);
    }
    expect(text(b.gw)).not.toBe(text(a.gw));
  });

  test("the comparison can fail: a public change (a pact) or a visible movement shows", () => {
    const base = seenIn([], fixtureRuleset);
    expect(seenIn([{ kind: "pact" }], fixtureRuleset)).not.toBe(base);
    // Under the granting ruleset p1 sees p2's outgoing attack, which the default hides.
    expect(seenIn([], grantingRuleset)).not.toBe(base);
    // A return into the city p4 holds is visible to p4.
    const homecoming: Perturbation = { kind: "homecoming", city: "c3", party: null, back: false };
    expect(seenIn([homecoming], fixtureRuleset, [], P4)).not.toBe(
      seenIn([], fixtureRuleset, [], P4),
    );
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
