import { describe, expect, test } from "bun:test";
import { domainEvent } from "./fixtures.test.ts";
import {
  DOMAIN_EVENT_KINDS,
  DomainEventSchema,
  INTEL_EVENT_TYPES,
  ROLES,
  STANDARD_EVENT_DATA,
  STANDARD_EVENT_TYPES,
} from "./index.ts";

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Event types that rulesets declare themselves (§8.6); protocol must never name them. */
const RULESET_EVENT_TYPES = [
  "siege_started",
  "siege_broken",
  "domination_started",
  "domination_cancelled",
  "city_renamed",
];

describe("standard event types (§8.6)", () => {
  test("STANDARD_EVENT_TYPES lists exactly the types that have a data schema", () => {
    const types: readonly string[] = STANDARD_EVENT_TYPES;
    expect(types.toSorted(byCodeUnit)).toEqual(
      Object.keys(STANDARD_EVENT_DATA).toSorted(byCodeUnit),
    );
    expect(new Set(STANDARD_EVENT_TYPES).size).toBe(STANDARD_EVENT_TYPES.length);
    expect(STANDARD_EVENT_TYPES).toHaveLength(33);
  });

  test("no ruleset event is a standard type", () => {
    for (const type of RULESET_EVENT_TYPES) {
      expect(STANDARD_EVENT_TYPES as readonly string[]).not.toContain(type);
    }
  });

  test("INTEL_EVENT_TYPES names standard types only, never a ruleset event", () => {
    expect([...INTEL_EVENT_TYPES]).toEqual([
      "battle",
      "battle_report",
      "spy_report",
      "spy_failed",
      "spy_detected",
      "city_conquered",
      "player_eliminated",
      "betrayal",
    ]);
    for (const type of INTEL_EVENT_TYPES) expect(STANDARD_EVENT_TYPES).toContain(type);
    for (const type of RULESET_EVENT_TYPES) {
      expect(INTEL_EVENT_TYPES as readonly string[]).not.toContain(type);
    }
  });

  test("the shapes named in §8.6 are enforced", () => {
    const battle = STANDARD_EVENT_DATA.battle;
    const headline = {
      city: "c14",
      attacker: "p2",
      defender: "p5",
      kind: "city",
      winner: "attacker",
    };
    expect(battle.safeParse(headline).success).toBe(true);
    const { winner: _winner, ...noWinner } = headline;
    expect(battle.safeParse(noWinner).success).toBe(false);
    expect(
      STANDARD_EVENT_DATA.city_conquered.safeParse({ city: "c1", from: null, to: "p2" }).success,
    ).toBe(true);
    expect(
      STANDARD_EVENT_DATA.pact_ended.safeParse({ a: "p1", b: "p2", cause: "expired" }).success,
    ).toBe(false);
    // The sender's copy of a delivered shipment carries no amounts.
    expect(
      STANDARD_EVENT_DATA.shipment_delivered.safeParse({
        movement: "m3f8tb",
        to: "c9",
        outcome: "delivered",
      }).success,
    ).toBe(true);
  });
});

describe("DomainEvent", () => {
  test("addresses each player once", () => {
    const twice = {
      ...domainEvent,
      to: [
        { p: "p3", as: "party" },
        { p: "p3", as: "ally" },
      ],
    };
    const parsed = DomainEventSchema.safeParse(twice);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["to", 1, "p"]);
  });

  test("roles are listed in priority order", () => {
    expect([...ROLES]).toEqual(["party", "self", "target", "stationed", "ally"]);
  });

  test("domain kinds of §5.1", () => {
    expect(DOMAIN_EVENT_KINDS).toContain("match_end");
    expect(DOMAIN_EVENT_KINDS).toHaveLength(11);
  });
});
