import { describe, expect, test } from "bun:test";
import { stockAt } from "@perfidia/engine/std";
import { addMovement, addStationed } from "@perfidia/engine/testing";
import { compareIds, type DomainEvent, type Island, type PlayerId } from "@perfidia/protocol";
import {
  city,
  cityIn,
  copyFor,
  extOf,
  load,
  movementBy,
  ofType,
  plain,
  world,
  type World,
} from "./fixtures.test.ts";

// The worked examples of perfidia-1 §8.12 and §9.8 as exact engine tests: hand-built states and
// movements, arrivals fired by `advanceTo`, step invariants on.

const T = 300000;

/** i1 (0, 0) holds c9, i2 (90, 0) holds c14; the other cities sit on i3, i4 and i5. */
const EXAMPLE_ISLANDS: readonly Partial<Island>[] = [
  { x: 0, y: 0, kind: "home", slots: 2, richnessPm: 1000 },
  { x: 90, y: 0, kind: "home", slots: 2, richnessPm: 1000 },
  { x: 0, y: 300, kind: "home", slots: 10, richnessPm: 1000 },
  { x: 300, y: 300, kind: "home", slots: 10, richnessPm: 1000 },
  { x: 600, y: 0, kind: "home", slots: 10, richnessPm: 1000 },
];

/** p2 has 6 cities (c9 on i1), p5 4 cities (c14 on i2), p7 3 cities; p1, p3, p4, p6 one each. */
function exampleWorld(c14: {
  wall: number;
  stock: number | { wood: number; stone: number; gold: number };
  units: Record<string, number>;
}): World {
  const w = world({ players: 7, now: T, islands: EXAMPLE_ISLANDS });
  city(w, { id: "c9", owner: "p2", island: "i1" });
  for (const id of ["c10", "c11", "c12", "c13", "c15"] as const) {
    city(w, { id, owner: "p2", island: "i3" });
  }
  city(w, {
    id: "c14",
    owner: "p5",
    island: "i2",
    buildings: { hall: 6, wall: c14.wall, warehouse: 5 },
    stock: c14.stock,
    units: c14.units,
  });
  for (const id of ["c16", "c17", "c18"] as const) city(w, { id, owner: "p5", island: "i4" });
  for (const id of ["c19", "c20", "c21"] as const) city(w, { id, owner: "p7", island: "i5" });
  for (const p of ["p1", "p3", "p4", "p6"] as const) {
    city(w, { id: `c${Number(p.slice(1))}`, owner: p, island: "i5" });
  }
  return w;
}

function report(events: readonly DomainEvent[], p: PlayerId): Record<string, unknown> {
  return copyFor(events, "battle_report", p).data;
}

function runExample1() {
  const w = exampleWorld({
    wall: 4,
    stock: { wood: 3200, stone: 2500, gold: 1800 },
    units: { guard: 120, raider: 30, warship: 4, transport: 2 },
  });
  addStationed(w.state, "c14", {
    owner: "p7",
    home: "c19",
    role: "support",
    units: { guard: 60, warship: 1 },
  });
  addMovement(w.state, w.rules, {
    kind: "attack",
    owner: "p2",
    from: "c9",
    to: "c14",
    units: { raider: 360, settler: 1, transport: 19, warship: 8 },
    party: "p5",
    departAt: T - 5399,
    arriveAt: T + 1,
  });
  const match = load(w);
  const out = match.advanceTo(T + 1);
  return { match, events: out.events };
}

describe("§8.12 worked example 1: naval phase, morale, a failed conquest, loot", () => {
  test("the battle numbers, losses, wall, loot and battle points are exact", () => {
    const { match, events } = runExample1();
    const r = report(events, "p5");
    expect(r["moralePm"]).toBe(800);
    expect(r["naval"]).toEqual({ Na: 320, Nd: 250, winner: "attacker", q: 609 });
    expect(r["land"]).toEqual({
      A: 5760,
      D: 4704,
      sumDefense: 3750,
      baseDefense: 170,
      wall: 4,
      wallPm: 1200,
      winner: "attacker",
      q: 665,
    });
    expect(r["stacks"]).toEqual([
      { side: "attacker", owner: "p2", unit: "raider", before: 360, lost: 239, survived: 121 },
      { side: "attacker", owner: "p2", unit: "settler", before: 1, lost: 1, survived: 0 },
      { side: "attacker", owner: "p2", unit: "transport", before: 19, lost: 0, survived: 19 },
      { side: "attacker", owner: "p2", unit: "warship", before: 8, lost: 5, survived: 3 },
      { side: "defender", owner: "p5", unit: "guard", before: 120, lost: 120, survived: 0 },
      { side: "defender", owner: "p5", unit: "raider", before: 30, lost: 30, survived: 0 },
      { side: "defender", owner: "p5", unit: "transport", before: 2, lost: 2, survived: 0 },
      { side: "defender", owner: "p5", unit: "warship", before: 4, lost: 4, survived: 0 },
      { side: "defender", owner: "p7", unit: "guard", before: 60, lost: 60, survived: 0 },
      { side: "defender", owner: "p7", unit: "warship", before: 1, lost: 1, survived: 0 },
    ]);
    expect(r["wall"]).toEqual({ before: 4, after: 3 });
    expect(r["loot"]).toEqual({ wood: 2700, stone: 2000, gold: 1300 });
    expect(r["siege"]).toBeNull();
    expect(r["points"]).toEqual([
      { player: "p2", points: 234 },
      { player: "p5", points: 195 },
      { player: "p7", points: 73 },
    ]);
    const x = extOf(match);
    expect([x.battlePoints["p2"], x.battlePoints["p5"], x.battlePoints["p7"]]).toEqual([
      234, 195, 73,
    ]);
    expect(x.sieges).toEqual({});

    const c14 = cityIn(match, "c14");
    expect(c14.buildings["wall"]).toBe(3);
    expect(plain(c14.units)).toEqual({});
    expect(c14.stationed).toHaveLength(0);
    expect(stockAt(match.read(), "c14")).toEqual({ wood: 500, stone: 500, gold: 500 });

    const back = movementBy(match, "p2", "return");
    expect(plain(back.units)).toEqual({ raider: 121, transport: 19, warship: 3 });
    expect(plain(back.cargo)).toEqual({ wood: 2700, stone: 2000, gold: 1300 });
    expect([back.from, back.fromIsland, back.home]).toEqual(["c14", "i2", "c9"]);
    expect(back.arriveAt).toBe(T + 1 + 5400);
  });

  test("one report per participant with its own id, and a public headline without numbers", () => {
    const { events } = runExample1();
    const reports = ofType(events, "battle_report");
    expect(reports.map((e) => e.to)).toEqual([
      [{ p: "p2", as: "self" }],
      [{ p: "p5", as: "party" }],
      [{ p: "p7", as: "stationed" }],
    ]);
    const ids = reports.map((e) => e.data["report"]);
    expect(new Set(ids).size).toBe(3);
    expect(report(events, "p2")["stacks"]).toEqual(report(events, "p5")["stacks"]);
    expect(ofType(events, "battle")).toEqual([
      {
        t: T + 1,
        type: "battle",
        public: true,
        to: [],
        data: { city: "c14", attacker: "p2", defender: "p5", kind: "city", winner: "attacker" },
      },
    ]);
  });
});

function runExample2(relief: number, homecoming: boolean) {
  const w = exampleWorld({ wall: 3, stock: 1000, units: { guard: 40 } });
  addMovement(w.state, w.rules, {
    kind: "attack",
    owner: "p2",
    from: "c9",
    to: "c14",
    units: { raider: 150, settler: 2, transport: 9, warship: 3 },
    party: "p5",
    departAt: T - 5399,
    arriveAt: T + 1,
  });
  for (const [from, guards, at] of [
    ["c11", 60, T + 100],
    ["c12", 40, T + 101],
  ] as const) {
    addMovement(w.state, w.rules, {
      kind: "support",
      owner: "p2",
      from,
      to: "c14",
      units: { guard: guards },
      party: "p2",
      departAt: T - 3500,
      arriveAt: at,
    });
  }
  addMovement(w.state, w.rules, {
    kind: "attack",
    owner: "p7",
    from: "c19",
    to: "c14",
    units: { warship: 4, raider: relief, transport: Math.ceil(relief / 20) },
    party: "p2",
    departAt: T + 200 - 3600,
    arriveAt: T + 200,
  });
  if (homecoming) {
    addMovement(w.state, w.rules, {
      kind: "return",
      owner: "p5",
      from: "c20",
      home: "c14",
      to: "c14",
      units: { raider: 60 },
      departAt: T - 3000,
      arriveAt: T + 300,
    });
  }
  return load(w);
}

describe("§9.8 worked example 2: train, siege, reinforcement, relief", () => {
  test("the wave wins at no naval cost, breaches the wall and starts a public 6 h siege", () => {
    const match = runExample2(130, true);
    const { events } = match.advanceTo(T + 1);
    const r = report(events, "p5");
    expect(r["naval"]).toEqual({ Na: 120, Nd: 0, winner: "attacker", q: 0 });
    expect(r["land"]).toMatchObject({ A: 2400, D: 1115, winner: "attacker", q: 215 });
    expect(r["stacks"]).toEqual([
      { side: "attacker", owner: "p2", unit: "raider", before: 150, lost: 32, survived: 118 },
      { side: "attacker", owner: "p2", unit: "settler", before: 2, lost: 0, survived: 2 },
      { side: "attacker", owner: "p2", unit: "transport", before: 9, lost: 0, survived: 9 },
      { side: "attacker", owner: "p2", unit: "warship", before: 3, lost: 0, survived: 3 },
      { side: "defender", owner: "p5", unit: "guard", before: 40, lost: 40, survived: 0 },
    ]);
    expect(r["wall"]).toEqual({ before: 3, after: 2 });
    expect(r["siege"]).toBe("started");
    expect(r["loot"]).toEqual({ wood: 0, stone: 0, gold: 0 });

    const x = extOf(match);
    expect(x.sieges["c14"]).toMatchObject({ by: "p2", startedAt: T + 1, endsAt: T + 1 + 21600 });
    expect(plain(cityIn(match, "c14").stationed)).toEqual([
      {
        owner: "p2",
        home: "c9",
        role: "hold",
        units: { raider: 118, settler: 2, transport: 9, warship: 3 },
      },
    ]);
    expect(cityIn(match, "c14").buildings["wall"]).toBe(2);
    const started = ofType(events, "siege_started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      public: true,
      data: { city: "c14", owner: "p5", by: "p2", endsAt: T + 1 + 21600 },
    });
    expect(started[0]?.to).toContainEqual({ p: "p5", as: "target" });
    expect([x.battlePoints["p2"], x.battlePoints["p5"]]).toEqual([40, 32]);

    // The return already heading into c14 is announced to the besieger at the siege start.
    const warned = ofType(events, "incoming_attack");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.to).toEqual([{ p: "p2", as: "party" }]);
    expect(warned[0]?.data).toMatchObject({
      by: "p5",
      foe: "p2",
      to: "c14",
      arriveAt: T + 300,
      homecoming: true,
    });
  });

  test("supports join the garrison as two groups; a relief that loses still kills a settler", () => {
    const match = runExample2(130, true);
    match.advanceTo(T + 101);
    const groups = plain(cityIn(match, "c14").stationed);
    expect(groups).toEqual([
      {
        owner: "p2",
        home: "c9",
        role: "hold",
        units: { raider: 118, settler: 2, transport: 9, warship: 3 },
      },
      { owner: "p2", home: "c11", role: "hold", units: { guard: 60 } },
      { owner: "p2", home: "c12", role: "hold", units: { guard: 40 } },
    ]);

    const { events } = match.advanceTo(T + 200);
    const r = report(events, "p2");
    expect(r["kind"]).toBe("relief");
    expect(r["moralePm"]).toBe(1000);
    expect(r["naval"]).toEqual({ Na: 200, Nd: 150, winner: "attacker", q: 562 });
    expect(r["land"]).toMatchObject({ A: 2600, D: 3036, winner: "defender", q: 732 });
    expect(r["siege"]).toBe("holds");
    expect(r["wall"]).toEqual({ before: 2, after: 2 });
    expect(r["stacks"]).toEqual([
      { side: "attacker", owner: "p7", unit: "raider", before: 130, lost: 130, survived: 0 },
      { side: "attacker", owner: "p7", unit: "transport", before: 7, lost: 0, survived: 7 },
      { side: "attacker", owner: "p7", unit: "warship", before: 4, lost: 2, survived: 2 },
      { side: "defender", owner: "p2", unit: "guard", before: 100, lost: 73, survived: 27 },
      { side: "defender", owner: "p2", unit: "raider", before: 118, lost: 86, survived: 32 },
      { side: "defender", owner: "p2", unit: "settler", before: 2, lost: 1, survived: 1 },
      { side: "defender", owner: "p2", unit: "transport", before: 9, lost: 9, survived: 0 },
      { side: "defender", owner: "p2", unit: "warship", before: 3, lost: 3, survived: 0 },
    ]);
    expect(ofType(events, "battle_report").map((e) => e.to[0])).toEqual([
      { p: "p7", as: "self" },
      { p: "p2", as: "party" },
    ]);
    // The split stack: c11 loses 44 (16 left), c12 loses 29 (11 left).
    expect(plain(cityIn(match, "c14").stationed)).toEqual([
      { owner: "p2", home: "c9", role: "hold", units: { raider: 32, settler: 1 } },
      { owner: "p2", home: "c11", role: "hold", units: { guard: 16 } },
      { owner: "p2", home: "c12", role: "hold", units: { guard: 11 } },
    ]);
    expect(extOf(match).sieges["c14"]?.by).toBe("p2");
    expect(ofType(events, "siege_broken")).toHaveLength(0);
    const back = movementBy(match, "p7", "return");
    expect(plain(back.units)).toEqual({ transport: 7, warship: 2 });
    expect(back.home).toBe("c19");
  });

  test("alternative: 160 raiders win the relief and break the siege, no wall change, no loot", () => {
    const match = runExample2(160, false);
    const { events } = match.advanceTo(T + 200);
    const r = report(events, "p7");
    expect(r["land"]).toMatchObject({ A: 3200, D: 3036, winner: "attacker", q: 898 });
    expect(r["siege"]).toBe("broken");
    expect(r["wall"]).toEqual({ before: 2, after: 2 });
    expect(r["loot"]).toEqual({ wood: 0, stone: 0, gold: 0 });
    expect(extOf(match).sieges).toEqual({});
    expect(cityIn(match, "c14").stationed).toHaveLength(0);
    expect(cityIn(match, "c14").buildings["wall"]).toBe(2);
    const broken = ofType(events, "siege_broken");
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({
      public: true,
      data: { city: "c14", owner: "p5", by: "p2", cause: "relief" },
    });
    const back = movementBy(match, "p7", "return");
    expect(plain(back.units)).toEqual({ raider: 16, transport: 8, warship: 2 });
    expect(plain(back.cargo)).toEqual({ wood: 0, stone: 0, gold: 0 });
    expect(match.read().state.queue.some((e) => e.kind === "siege_end")).toBe(false);
  });

  test("alternative: the homecoming of 60 raiders wins (q = 635) and breaks the siege", () => {
    const match = runExample2(130, true);
    match.advanceTo(T + 200);
    const { events } = match.advanceTo(T + 300);
    const r = report(events, "p5");
    expect(r["kind"]).toBe("homecoming");
    expect(r["attacker"]).toBe("p5");
    expect(r["defender"]).toBe("p2");
    expect(r["moralePm"]).toBe(1000);
    expect(r["naval"]).toBeNull();
    expect(r["land"]).toMatchObject({ A: 1200, D: 957, winner: "attacker", q: 635 });
    expect(r["siege"]).toBe("broken");
    expect(r["wall"]).toEqual({ before: 2, after: 2 });
    expect(plain(cityIn(match, "c14").units)).toEqual({ raider: 22 });
    expect(cityIn(match, "c14").stationed).toHaveLength(0);
    expect(extOf(match).sieges).toEqual({});
    expect(ofType(events, "siege_broken")[0]?.data).toMatchObject({ cause: "homecoming" });
    expect(copyFor(events, "returned", "p5").data).toMatchObject({
      city: "c14",
      units: { raider: 22 },
    });
    expect(Object.values(match.read().state.movements).some((m) => m.owner === "p5")).toBe(false);
  });
});

function crownWorld(attack: Record<string, number>) {
  const w = world({ players: 6, now: T, islands: EXAMPLE_ISLANDS });
  city(w, {
    id: "c7",
    owner: null,
    island: "i2",
    tag: "crown",
    buildings: {
      hall: 5,
      lumber: 5,
      quarry: 5,
      mine: 5,
      warehouse: 5,
      barracks: 5,
      harbor: 5,
      wall: 5,
    },
    stock: 3000,
    units: { guard: 400, warship: 10 },
  });
  city(w, { id: "c1", owner: "p1", island: "i1", capital: true });
  for (const id of ["c8", "c9", "c10", "c11", "c12"] as const) {
    city(w, { id, owner: "p1", island: "i3" });
  }
  for (const p of ["p2", "p3", "p4", "p5", "p6"] as const) {
    city(w, { id: `c${Number(p.slice(1))}`, owner: p, island: "i4", capital: true });
  }
  addMovement(w.state, w.rules, {
    kind: "attack",
    owner: "p1",
    from: "c1",
    to: "c7",
    units: attack,
    party: null,
    departAt: T,
    arriveAt: T + 7200,
  });
  return load(w);
}

describe("the Crown (§9.6)", () => {
  test("D = 10187, Nd = 500, morale 1000 for a 6-city attacker; 11 warships lose 9", () => {
    const match = crownWorld({ warship: 11, raider: 600, settler: 2, transport: 31 });
    match.advanceTo(T + 7199);
    expect(stockAt(match.read(), "c7")).toEqual({ wood: 3000, stone: 3000, gold: 3000 });
    const { events } = match.advanceTo(T + 7200);
    const r = report(events, "p1");
    expect(r["defender"]).toBe("neutral");
    expect(r["moralePm"]).toBe(1000);
    expect(r["naval"]).toEqual({ Na: 550, Nd: 500, winner: "attacker", q: 826 });
    expect(r["land"]).toMatchObject({ A: 12000, D: 10187, winner: "attacker", q: 719 });
    expect(r["stacks"]).toContainEqual({
      side: "attacker",
      owner: "p1",
      unit: "warship",
      before: 11,
      lost: 9,
      survived: 2,
    });
    expect(r["siege"]).toBe("started");
    expect(ofType(events, "battle_report")).toHaveLength(1);
    expect(ofType(events, "siege_started")[0]?.data).toMatchObject({ city: "c7", owner: null });
  });

  test("frozen while neutral; +100 to its owner once captured", () => {
    const match = crownWorld({ warship: 11, raider: 600, settler: 2, transport: 31 });
    const before = match.ruleset.hooks.standings(match.read()).find((s) => s.player === "p1");
    match.advanceTo(T + 7200);
    const ends = extOf(match).sieges["c7"]?.endsAt ?? 0;
    expect(stockAt(match.read(), "c7", ends)).toEqual(stockAt(match.read(), "c7"));
    const { events } = match.advanceTo(ends);
    expect(ofType(events, "city_conquered")[0]?.data).toEqual({ city: "c7", from: null, to: "p1" });
    expect(cityIn(match, "c7").owner).toBe("p1");
    const after = match.ruleset.hooks.standings(match.read()).find((s) => s.player === "p1");
    // 100 base + 39 levels (the wall was breached to 4) + the 100 Crown bonus.
    expect((after?.parts["cityPoints"] ?? 0) - (before?.parts["cityPoints"] ?? 0)).toBe(239);
    expect(match.read().ruleset.hooks.visibility?.publicCity?.(match.read(), "p2", "c7")).toEqual({
      points: 239,
      crown: true,
    });
    match.advanceTo(ends + 3600);
    expect(stockAt(match.read(), "c7").wood).toBeGreaterThan(
      stockAt(match.read(), "c7", ends).wood,
    );
  });
});

/** p1 attacks c2 (hall 2, wall 1, 20 guards, 3 warships) from c1 on `island`. */
function lostAttack(island: "i1" | "i2", units: Record<string, number>) {
  const w = world({ now: T, islands: EXAMPLE_ISLANDS });
  city(w, { id: "c1", owner: "p1", island });
  city(w, {
    id: "c2",
    owner: "p2",
    island: "i2",
    buildings: { hall: 2, wall: 1 },
    units: { guard: 20, warship: 3 },
  });
  addMovement(w.state, w.rules, {
    kind: "attack",
    owner: "p1",
    from: "c1",
    to: "c2",
    units,
    party: "p2",
    departAt: T - 5399,
    arriveAt: T + 1,
  });
  const match = load(w);
  return { match, events: match.advanceTo(T + 1).events };
}

const REDACTED_KEYS: string[] = [
  "attacker",
  "city",
  "defender",
  "kind",
  "lost",
  "phase",
  "report",
  "winner",
];

describe("reports (§8.10)", () => {
  test("a movement sunk in the naval phase: the attacker learns only outcome, phase, losses", () => {
    const { match, events } = lostAttack("i1", { raider: 4, transport: 1 });
    const own = report(events, "p1");
    expect(Object.keys(own).toSorted(compareIds)).toEqual(REDACTED_KEYS);
    expect(own).toMatchObject({
      attacker: "p1",
      defender: "p2",
      kind: "city",
      winner: "defender",
      phase: "naval",
      lost: { raider: 4, transport: 1 },
    });
    expect(report(events, "p2")).toMatchObject({
      naval: { Na: 0, Nd: 150, winner: "defender", q: 0 },
      land: null,
    });
    expect(Object.values(match.read().state.movements)).toHaveLength(0);
  });

  test("a lost land phase on the same island is redacted the same way", () => {
    const { events } = lostAttack("i2", { raider: 4 });
    const own = report(events, "p1");
    expect(Object.keys(own).toSorted(compareIds)).toEqual(REDACTED_KEYS);
    expect(own).toMatchObject({ phase: "land", winner: "defender", lost: { raider: 4 } });
    expect(report(events, "p2")).toMatchObject({ naval: null, land: { A: 80, D: 514 } });
  });

  test("ships that survive a lost land phase go home empty, with the full report", () => {
    const { match, events } = lostAttack("i1", { raider: 4, warship: 4 });
    const own = report(events, "p1");
    expect(own).toMatchObject({
      winner: "defender",
      naval: { Na: 200, Nd: 150, winner: "attacker", q: 562 },
      land: { winner: "defender" },
    });
    // cas(4, 562) = 2 warships lost at sea; the 4 raiders die in the land phase.
    const back = movementBy(match, "p1", "return");
    expect(plain(back.units)).toEqual({ warship: 2 });
    expect(plain(back.cargo)).toEqual({ wood: 0, stone: 0, gold: 0 });
  });
});
