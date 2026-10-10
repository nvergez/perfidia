import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { addAlliance, addMovement, addPact, addStationed } from "@perfidia/engine/testing";
import type { CityId, UnitCounts } from "@perfidia/protocol";
import { besiege, city, extOf, load, world } from "./fixtures.test.ts";

// Random city, relief and homecoming battles through the kernel, with step invariants (unit
// conservation, sieges, emitted-event checks…): they never throw, and their aftermath (sieges,
// conquests, returns, betrayals) keeps every invariant until the dust settles.

const T = 200000;

const attackUnits = fc.record({
  raider: fc.nat(300),
  guard: fc.nat(40),
  settler: fc.nat(3),
  warship: fc.nat(12),
  transport: fc.nat(20),
});
const homeUnits = fc.record({
  guard: fc.nat(200),
  raider: fc.nat(100),
  warship: fc.nat(10),
  transport: fc.nat(5),
});
const garrisonUnits = fc.record({
  settler: fc.integer({ min: 1, max: 3 }),
  raider: fc.nat(100),
  guard: fc.nat(100),
  warship: fc.nat(5),
});

function clean(units: Readonly<Record<string, number>>): UnitCounts {
  return Object.fromEntries(Object.entries(units).filter(([, n]) => n > 0));
}

const scenario = fc.record({
  mode: fc.constantFrom("city", "relief", "homecoming"),
  attack: attackUnits,
  home: homeUnits,
  stationed: fc.record({ guard: fc.nat(50), warship: fc.nat(3) }),
  aside: fc.nat(20),
  garrison: garrisonUnits,
  garrison2: fc.record({ guard: fc.nat(50) }),
  hall: fc.nat(10),
  wall: fc.nat(10),
  capital: fc.boolean(),
  early: fc.boolean(),
  sameIsland: fc.boolean(),
  relation: fc.constantFrom("none", "pact", "ally"),
  cargo: fc.nat(500),
});

describe("battles through the kernel", () => {
  test("never throw and keep every invariant, whatever the forces", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const now = s.early ? 100000 : T;
        const w = world({ now });
        city(w, { id: "c1", owner: "p1", island: "i1", buildings: { warehouse: 3 } });
        city(w, {
          id: "c2",
          owner: "p2",
          island: s.sameIsland ? "i1" : "i2",
          capital: s.capital,
          buildings: { hall: s.hall, wall: s.wall, warehouse: 4 },
          stock: 1500,
          units: s.mode === "city" ? clean(s.home) : {},
        });
        city(w, { id: "c3", owner: "p3", island: "i3" });
        city(w, { id: "c4", owner: "p4", island: "i4" });
        city(w, { id: "c5", owner: "p4", island: "i4" });
        if (s.relation === "pact")
          addPact(w.state, w.rules, "p1", "p2", { expiresAt: now + 90000 });
        if (s.relation === "ally") addAlliance(w.state, "Pair", ["p1", "p2"]);
        const units = clean(s.attack);
        if (s.mode === "city") {
          const third = clean(s.stationed);
          if (Object.keys(third).length > 0) {
            addStationed(w.state, "c2", { owner: "p3", home: "c3", role: "support", units: third });
          }
          if (s.aside > 0) {
            addStationed(w.state, "c2", {
              owner: "p1",
              home: "c1",
              role: "support",
              units: { guard: s.aside },
            });
          }
        } else {
          const groups: { home: CityId; units: UnitCounts }[] = [
            { home: "c4", units: clean(s.garrison) },
          ];
          const extra = clean(s.garrison2);
          if (Object.keys(extra).length > 0) groups.push({ home: "c5", units: extra });
          besiege(w, { city: "c2", by: "p4", garrison: groups, startedAt: now - 100 });
        }
        if (s.mode === "homecoming") {
          addMovement(w.state, w.rules, {
            kind: "return",
            owner: "p2",
            from: "c3",
            home: "c2",
            to: "c2",
            units,
            cargo: { wood: s.cargo },
            party: "p4",
            departAt: now - 3599,
            arriveAt: now + 1,
          });
        } else {
          fc.pre(Object.keys(units).length > 0);
          addMovement(w.state, w.rules, {
            kind: "attack",
            owner: "p1",
            from: "c1",
            to: "c2",
            units,
            party: s.mode === "city" ? "p2" : "p4",
            departAt: now - 3599,
            arriveAt: now + 1,
          });
        }
        const match = load(w);
        const { events } = match.advanceTo(now + 1);
        const battles = events.filter((e) => e.type === "battle");
        expect(battles).toHaveLength(1);
        match.advanceTo(now + 40000);
        const x = extOf(match);
        for (const bp of Object.values(x.battlePoints)) expect(bp).toBeGreaterThanOrEqual(0);
        if (s.mode !== "city") expect(x.sieges["c2"]).toBeUndefined();
      }),
      { numRuns: 120 },
    );
  });
});
