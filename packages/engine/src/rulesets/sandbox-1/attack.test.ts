import { describe, expect, test } from "bun:test";
import { addBuildItem, addMovement, addStationed } from "@perfidia/engine/testing";
import {
  DomainEventSchema,
  STANDARD_EVENT_DATA,
  type DomainEvent,
  type GameState,
  type ZodType,
} from "@perfidia/protocol";
import fc from "fast-check";
import { BATTLE_KIND } from "./attack.ts";
import {
  cityOf,
  ofType,
  sandboxCity,
  sandboxMatch,
  sandboxState,
  to,
  type Overrides,
} from "./testkit.test.ts";

// The slow suite (PERFIDIA_SLOW=1: `bun run test:slow`, run by `bun run test:exit`; docs/
// architecture.md §13.8). Read through `import.meta.env`: the pure packages' tests may not name the
// `process` global.
const SLOW = import.meta.env["PERFIDIA_SLOW"] === "1";

// `hooks.arrive.attack` through the kernel (docs/architecture.md §3.8) on hand-built states, with
// step invariants (std's included, unit conservation among them) and the emitted-event check:
// immediate capture, disbanding everywhere, elimination, raids with loot, the capital immunity,
// boats, split-stack losses, and the bounce of an attack whose target changed owner.

/** No production, so stocks and loot are exact numbers. */
const NO_PRODUCTION: Overrides = {
  "economy.production.level0": 0,
  "economy.production.base": 0,
  "economy.production.perLevel": 0,
};

const STANDARD: Readonly<Record<string, ZodType>> = STANDARD_EVENT_DATA;

/** Each event parses with its standard schema (the kernel checks it too, at every step). */
function expectStandard(events: readonly DomainEvent[]): void {
  for (const e of events) {
    expect(DomainEventSchema.safeParse(e).success).toBe(true);
    const schema = Object.hasOwn(STANDARD, e.type) ? STANDARD[e.type] : undefined;
    if (schema !== undefined) expect(schema.safeParse(e.data).success).toBe(true);
  }
}

function travel(
  state: GameState,
  a: "i1" | "i3" | "i4" | "i5",
  b: "i1" | "i3" | "i4" | "i5",
): number {
  const x = state.islands[a];
  const y = state.islands[b];
  if (x === undefined || y === undefined) throw new Error("missing island");
  const w = 40 * Object.keys(state.players).length;
  const dx = Math.abs(x.x - y.x);
  return 4800 + 60 * (Math.min(dx, w - dx) + Math.abs(x.y - y.y));
}

describe("capture", () => {
  test("a surviving colonist takes the city at once; everything homed there is disbanded; the last city eliminates its owner", () => {
    const now = 30000;
    const { state, rules } = sandboxState({ players: 3, now });
    sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
    sandboxCity(state, rules, {
      owner: "p2",
      id: "c2",
      island: "i4",
      units: { spearman: 4, boat: 3 },
      stock: 600,
    });
    sandboxCity(state, rules, { owner: "p3", id: "c3", island: "i5", capital: true });
    addBuildItem(state, rules, "c2", "keep", { end: now + 30000 });
    addStationed(state, "c2", { owner: "p3", home: "c3", role: "support", units: { spearman: 2 } });
    addStationed(state, "c2", { owner: "p1", home: "c1", role: "support", units: { axeman: 5 } });
    addStationed(state, "c3", { owner: "p2", home: "c2", role: "support", units: { spearman: 3 } });
    const later = now + 20000;
    addMovement(state, rules, {
      kind: "support",
      owner: "p2",
      from: "c2",
      to: "c3",
      units: { spearman: 2 },
      party: "p3",
      arriveAt: later,
    });
    addMovement(state, rules, {
      kind: "shipment",
      owner: "p2",
      from: "c2",
      to: "c3",
      cargo: { wood: 50 },
      party: "p3",
      arriveAt: later,
    });
    const arriveAt = now + travel(state, "i1", "i4");
    const attack = addMovement(state, rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      units: { axeman: 20, colonist: 1, boat: 2 },
      party: "p2",
      arriveAt,
    });

    const match = sandboxMatch(state);
    const { events } = match.advanceTo(arriveAt);
    expectStandard(events);
    expect(events.map((e) => e.type)).toEqual([
      "battle",
      "battle_report",
      "battle_report",
      "battle_report",
      "city_conquered",
      "player_eliminated",
    ]);
    const headline = ofType(events, "battle")[0];
    expect(headline).toMatchObject({
      public: true,
      data: { city: "c2", attacker: "p1", defender: "p2", kind: BATTLE_KIND, winner: "attacker" },
    });
    expect(to(events, "battle_report", "p1").to).toEqual([{ p: "p1", as: "self" }]);
    expect(to(events, "battle_report", "p2").to).toEqual([{ p: "p2", as: "target" }]);
    expect(to(events, "battle_report", "p3").to).toEqual([{ p: "p3", as: "stationed" }]);
    const report = to(events, "battle_report", "p2").data;
    // D = 4 · 15 + 2 · 15 + 10 · keep 1 = 100; A = 20 · 15 = 300; q = lossPm(100, 300) = 110.
    expect(report).toMatchObject({
      outcome: "captured",
      attack: 300,
      defense: 100,
      keep: 1,
      lossPm: 110,
      attackerUnits: { before: { axeman: 20, colonist: 1, boat: 2 }, lost: { axeman: 2 } },
      defenders: [
        { player: "p2", before: { spearman: 4, boat: 3 }, lost: { spearman: 4, boat: 3 } },
        { player: "p3", before: { spearman: 2 }, lost: { spearman: 2 } },
      ],
      loot: { wood: 0, stone: 0, gold: 0 },
      capitalImmune: false,
    });
    const reports = ofType(events, "battle_report").map((e) => e.data["report"]);
    expect(new Set(reports).size).toBe(3);
    expect(ofType(events, "city_conquered")[0]).toMatchObject({
      public: true,
      to: [
        { p: "p1", as: "self" },
        { p: "p2", as: "target" },
      ],
      data: { city: "c2", from: "p2", to: "p1" },
    });

    const s = match.read().state;
    const c2 = cityOf(match, "c2");
    expect(c2.owner).toBe("p1");
    // 2 axemen died, the colonist settled: the survivors and the boats are the city's home units.
    expect(c2.units).toEqual({ axeman: 18, boat: 2 });
    // The attacker's own group stood aside and is untouched.
    expect(c2.stationed).toEqual([
      { owner: "p1", home: "c1", role: "support", units: { axeman: 5 } },
    ]);
    expect(c2.build).toEqual([]);
    expect(s.queue.some((e) => e.kind === "build_done")).toBe(false);
    expect(cityOf(match, "c3").stationed).toEqual([]);
    expect(Object.keys(s.movements)).toEqual([]);
    expect(s.movements[attack.id]).toBeUndefined();
    expect(s.players["p2"]).toMatchObject({ alive: false, eliminatedAt: arriveAt });
    expect(s.ledger["p1"]?.gone).toEqual({ axeman: 2, colonist: 1 });
    expect(s.ledger["p2"]?.gone).toEqual({ spearman: 9, boat: 3 });
    expect(s.ledger["p3"]?.gone).toEqual({ spearman: 2 });
    expect(match.ended).toBe(false);
  });

  test("a capital falls from t = 172800; units homed in it are disbanded, unit-less movements re-homed", () => {
    const now = 180000;
    const overrides: Overrides = { "time.hillOpen": 500000 };
    const { state, rules } = sandboxState({ players: 3, now, overrides });
    sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
    sandboxCity(state, rules, { owner: "p2", id: "c2", island: "i3", capital: true });
    sandboxCity(state, rules, { owner: "p3", id: "c3", island: "i5", capital: true });
    sandboxCity(state, rules, { owner: "p2", id: "c4", island: "i4" });
    addStationed(state, "c4", { owner: "p2", home: "c2", role: "support", units: { spearman: 5 } });
    const shipment = addMovement(state, rules, {
      kind: "shipment",
      owner: "p2",
      from: "c2",
      to: "c3",
      cargo: { wood: 30 },
      party: "p3",
      arriveAt: now + 50000,
    });
    const arriveAt = now + travel(state, "i1", "i3");
    addMovement(state, rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      units: { axeman: 10, colonist: 2 },
      party: "p2",
      arriveAt,
    });
    const match = sandboxMatch(state, overrides);
    const { events } = match.advanceTo(arriveAt);
    expectStandard(events);
    expect(events.map((e) => e.type)).toEqual([
      "battle",
      "battle_report",
      "battle_report",
      "city_conquered",
    ]);
    const c2 = cityOf(match, "c2");
    expect(c2.owner).toBe("p1");
    expect(c2.capitalOf).toBe("p2");
    expect(c2.units).toEqual({ axeman: 10, colonist: 1 });
    expect(cityOf(match, "c4").stationed).toEqual([]);
    const s = match.read().state;
    expect(s.movements[shipment.id]).toMatchObject({ home: "c4", owner: "p2", kind: "shipment" });
    expect(s.players["p2"]?.alive).toBe(true);
    expect(s.ledger["p2"]?.gone).toEqual({ spearman: 5 });
  });
});

describe("raid", () => {
  test("an immune capital is raided: loot, colonist home, the report says why", () => {
    const now = 30000;
    const { state, rules } = sandboxState({ players: 2, now, overrides: NO_PRODUCTION });
    sandboxCity(state, rules, {
      owner: "p1",
      id: "c1",
      island: "i1",
      capital: true,
      stock: 100,
    });
    sandboxCity(state, rules, {
      owner: "p2",
      id: "c2",
      island: "i3",
      capital: true,
      stock: { wood: 1000, stone: 400, gold: 101 },
    });
    const arriveAt = now + travel(state, "i1", "i3");
    addMovement(state, rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      units: { axeman: 10, colonist: 1 },
      party: "p2",
      arriveAt,
    });
    const match = sandboxMatch(state, NO_PRODUCTION);
    const { events } = match.advanceTo(arriveAt);
    expectStandard(events);
    expect(events.map((e) => e.type)).toEqual(["battle", "battle_report", "battle_report"]);
    // Lootable 500/200/50 = 750 > carry 250: floor(500·250/750) = 166, 66, 16.
    const loot = { wood: 166, stone: 66, gold: 16 };
    expect(to(events, "battle_report", "p1").data).toMatchObject({
      outcome: "raided",
      winner: "attacker",
      attack: 150,
      defense: 10,
      capitalImmune: true,
      loot,
    });
    const c2 = cityOf(match, "c2");
    expect(c2.owner).toBe("p2");
    expect(c2.stock).toEqual({
      wood: (1000 - 166) * 3600,
      stone: (400 - 66) * 3600,
      gold: (101 - 16) * 3600,
    });
    const [back] = Object.values(match.read().state.movements);
    expect(back).toMatchObject({
      kind: "return",
      owner: "p1",
      home: "c1",
      from: "c2",
      units: { axeman: 10, colonist: 1 },
      cargo: loot,
    });
    const home = arriveAt + travel(state, "i3", "i1");
    expect(back?.arriveAt).toBe(home);
    const after = match.advanceTo(home).events;
    expect(after.map((e) => e.type)).toEqual(["returned"]);
    expect(cityOf(match, "c1").units).toEqual({ axeman: 10, colonist: 1 });
    expect(cityOf(match, "c1").stock).toEqual({
      wood: 266 * 3600,
      stone: 166 * 3600,
      gold: 116 * 3600,
    });
  });

  test("everything lootable is taken when the survivors carry it", () => {
    const now = 40000;
    const { state, rules } = sandboxState({ players: 2, now, overrides: NO_PRODUCTION });
    sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
    sandboxCity(state, rules, {
      owner: "p2",
      id: "c2",
      island: "i3",
      stock: { wood: 101, stone: 0, gold: 7 },
      units: { spearman: 1 },
    });
    sandboxCity(state, rules, { owner: "p2", id: "c3", island: "i4", capital: true });
    const arriveAt = now + travel(state, "i1", "i3");
    addMovement(state, rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      units: { axeman: 4, spearman: 1 },
      party: "p2",
      arriveAt,
    });
    const match = sandboxMatch(state, NO_PRODUCTION);
    const { events } = match.advanceTo(arriveAt);
    // A = 65 > D = 25: q = lossPm(25, 65) = 147; cas(4, 147) = 1, cas(1, 147) = 0.
    expect(to(events, "battle_report", "p1").data).toMatchObject({
      outcome: "raided",
      lossPm: 147,
      attackerUnits: { lost: { axeman: 1 } },
      loot: { wood: 50, stone: 0, gold: 3 },
    });
    expect(Object.values(match.read().state.movements)[0]?.cargo).toEqual({
      wood: 50,
      stone: 0,
      gold: 3,
    });
  });
});

describe("repelled", () => {
  test("the defender wins: every attacking land unit dies, boats sail home empty, split stacks lose 44 and 29", () => {
    const now = 30000;
    const { state, rules } = sandboxState({ players: 3, now, overrides: NO_PRODUCTION });
    sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
    sandboxCity(state, rules, {
      owner: "p2",
      id: "c2",
      island: "i3",
      capital: true,
      units: { spearman: 60, boat: 1 },
      stock: 500,
    });
    sandboxCity(state, rules, { owner: "p3", id: "c3", island: "i5", capital: true });
    sandboxCity(state, rules, { owner: "p2", id: "c4", island: "i4" });
    addStationed(state, "c2", {
      owner: "p2",
      home: "c4",
      role: "support",
      units: { spearman: 40 },
    });
    const arriveAt = now + travel(state, "i1", "i3");
    addMovement(state, rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      units: { axeman: 86, boat: 2 },
      party: "p2",
      arriveAt,
    });
    const match = sandboxMatch(state, NO_PRODUCTION);
    const { events } = match.advanceTo(arriveAt);
    expectStandard(events);
    expect(ofType(events, "battle")[0]?.data["winner"]).toBe("defender");
    expect(to(events, "battle_report", "p2").data).toMatchObject({
      outcome: "repelled",
      attack: 1290,
      defense: 1510,
      lossPm: 729,
      attackerUnits: { lost: { axeman: 86 } },
      defenders: [{ player: "p2", before: { spearman: 100, boat: 1 }, lost: { spearman: 73 } }],
    });
    const c2 = cityOf(match, "c2");
    expect(c2.units).toEqual({ spearman: 16, boat: 1 });
    expect(c2.stationed).toEqual([
      { owner: "p2", home: "c4", role: "support", units: { spearman: 11 } },
    ]);
    expect(c2.stock).toEqual({ wood: 500 * 3600, stone: 500 * 3600, gold: 500 * 3600 });
    const [back] = Object.values(match.read().state.movements);
    expect(back).toMatchObject({
      kind: "return",
      units: { boat: 2 },
      cargo: { wood: 0, stone: 0, gold: 0 },
    });
    expect(match.read().state.ledger["p1"]?.gone).toEqual({ axeman: 86 });
  });

  test("an attack that loses everything leaves no return", () => {
    const now = 30000;
    const { state, rules } = sandboxState({ players: 2, now });
    sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
    sandboxCity(state, rules, {
      owner: "p2",
      id: "c2",
      island: "i3",
      capital: true,
      units: { spearman: 10 },
    });
    const arriveAt = now + travel(state, "i1", "i3");
    addMovement(state, rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      units: { axeman: 2 },
      party: "p2",
      arriveAt,
    });
    const match = sandboxMatch(state);
    match.advanceTo(arriveAt);
    expect(Object.keys(match.read().state.movements)).toEqual([]);
  });
});

describe("bounce", () => {
  test("an attack only fights the owner recorded at launch", () => {
    const now = 30000;
    const { state, rules } = sandboxState({ players: 3, now });
    sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
    sandboxCity(state, rules, { owner: "p2", id: "c2", island: "i3", capital: true });
    sandboxCity(state, rules, { owner: "p3", id: "c3", island: "i5", capital: true });
    sandboxCity(state, rules, { owner: "p1", id: "c4", island: "i4" });
    const arriveAt = now + travel(state, "i1", "i3");
    // Launched when c2 belonged to p3 (it changed hands since), and at c4 when p2 owned it.
    const a = addMovement(state, rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      units: { axeman: 50, colonist: 1 },
      party: "p3",
      arriveAt,
    });
    const b = addMovement(state, rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c4",
      units: { axeman: 5 },
      party: "p2",
      departAt: now - 10000,
      arriveAt,
    });
    const match = sandboxMatch(state);
    const { events } = match.advanceTo(arriveAt);
    expectStandard(events);
    expect(events.map((e) => [e.type, e.data["movement"], e.data["reason"]])).toEqual([
      ["bounced", a.id, "owner_changed"],
      ["bounced", b.id, "owner_changed"],
    ]);
    expect(cityOf(match, "c2").owner).toBe("p2");
    expect(match.read().state.movements[a.id]).toMatchObject({
      kind: "return",
      units: { axeman: 50, colonist: 1 },
    });
  });
});

/** Unit counts with at least one unit of `required` (stationed groups are never empty). */
function units(required: "spearman" | "axeman" | null) {
  return fc.record(
    {
      spearman: fc.integer({ min: 1, max: 40 }),
      axeman: fc.integer({ min: 1, max: 60 }),
      colonist: fc.integer({ min: 1, max: 2 }),
      boat: fc.integer({ min: 1, max: 3 }),
    },
    { requiredKeys: required === null ? [] : [required] },
  );
}

describe("random battles through the kernel (property)", () => {
  test("never throw, keep every step invariant, and the outcome matches the report", () => {
    fc.assert(
      fc.property(
        units("axeman"),
        units(null),
        fc.option(units("spearman"), { nil: undefined }),
        fc.option(units("spearman"), { nil: undefined }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (attacking, home, ally, trojan, late, capital, second) => {
          const now = late ? 180000 : 30000;
          const overrides: Overrides = { "time.hillOpen": 500000 };
          const { state, rules } = sandboxState({ players: 3, now, overrides });
          sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
          sandboxCity(state, rules, {
            owner: "p2",
            id: "c2",
            island: "i3",
            capital,
            units: home,
            stock: 300,
          });
          sandboxCity(state, rules, { owner: "p3", id: "c3", island: "i5", capital: true });
          if (second) sandboxCity(state, rules, { owner: "p2", id: "c4", island: "i4" });
          if (ally !== undefined) {
            addStationed(state, "c2", { owner: "p3", home: "c3", role: "support", units: ally });
          }
          if (trojan !== undefined) {
            addStationed(state, "c2", { owner: "p1", home: "c1", role: "support", units: trojan });
          }
          const arriveAt = now + travel(state, "i1", "i3");
          const m = addMovement(state, rules, {
            kind: "attack",
            owner: "p1",
            from: "c1",
            to: "c2",
            units: attacking,
            party: "p2",
            arriveAt,
          });
          const match = sandboxMatch(state, overrides);
          const { events } = match.advanceTo(arriveAt);
          expectStandard(events);
          const report = to(events, "battle_report", "p1").data;
          const s = match.read().state;
          const c2 = cityOf(match, "c2");
          if (report["outcome"] === "captured") {
            expect(c2.owner).toBe("p1");
            expect(s.players["p2"]?.alive).toBe(second);
            expect(ofType(events, "city_conquered")).toHaveLength(1);
            expect(capital && !late).toBe(false);
          } else {
            expect(c2.owner).toBe("p2");
            expect(ofType(events, "city_conquered")).toHaveLength(0);
          }
          if (trojan !== undefined) {
            expect(c2.stationed.find((g) => g.owner === "p1")?.units).toEqual(trojan);
          }
          expect(s.movements[m.id]).toBeUndefined();
          // Run on to the end of the returns: still consistent.
          match.advanceTo(arriveAt + 20000);
        },
      ),
      // 30 runs outside the slow suite, which runs 120.
      { numRuns: SLOW ? 120 : 30 },
    );
  });
});
