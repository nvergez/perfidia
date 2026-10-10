import { describe, expect, test } from "bun:test";
import { stockAt } from "@perfidia/engine/std";
import {
  addAlliance,
  addBuildItem,
  addMovement,
  addPact,
  addProposal,
  addRecruitBatch,
  addStationed,
} from "@perfidia/engine/testing";
import { MovementIdSchema } from "@perfidia/protocol";
import { CAPITAL_IMMUNE } from "./errors.ts";
import {
  besiege,
  city,
  cityIn,
  copyFor,
  extOf,
  load,
  movementBy,
  ofType,
  plain,
  world,
} from "./fixtures.test.ts";

// Sieges, conquest, homecomings, re-homing and elimination through the kernel (perfidia-1 §7.4,
// §7.7, §9), on hand-built states with step invariants.

const T = 200000;

describe("siege start", () => {
  test("refunds the city's queues into its own stock and emits no queue_empty", () => {
    const w = world({ now: T });
    city(w, { id: "c1", owner: "p1", island: "i1", units: { raider: 20, settler: 1 } });
    const c2 = city(w, {
      id: "c2",
      owner: "p2",
      island: "i2",
      buildings: { hall: 3, barracks: 2, warehouse: 3 },
      stock: 500,
    });
    addBuildItem(w.state, w.rules, "c2", "lumber");
    addBuildItem(w.state, w.rules, "c2", "lumber");
    addRecruitBatch(w.state, w.rules, "c2", "guard", 5, { unitTime: 300 });
    expect(c2.build.map((b) => b.cost)).toEqual([
      { wood: 20, stone: 50, gold: 30 },
      { wood: 32, stone: 80, gold: 48 },
    ]);
    // The testing kit's builder takes the hall-0 column: 1500 × 10 / 9 = 1666 s.
    expect(c2.build[0]?.end).toBe(T + 1666);
    addMovement(w.state, w.rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      units: { raider: 20, settler: 1 },
      party: "p2",
      departAt: T - 3599,
      arriveAt: T + 1,
    });
    // The movement's units come from c1's stock of units in the builder's ledger.
    const match = load(w);
    const { events } = match.advanceTo(T + 1);
    expect(ofType(events, "siege_started")).toHaveLength(1);
    expect(ofType(events, "queue_empty")).toHaveLength(0);
    const after = cityIn(match, "c2");
    expect(after.build).toHaveLength(0);
    expect(plain(after.recruit)).toEqual({ barracks: [], harbor: [] });
    expect(
      match.read().state.queue.some((e) => e.kind === "build_done" || e.kind === "recruit_done"),
    ).toBe(false);
    // Active item pro rata (1665/1666), queued item 100%, the batch's 5 guards 100%.
    expect(stockAt(match.read(), "c2")).toEqual({
      wood: 500 + 19 + 32 + 150,
      stone: 500 + 49 + 80 + 300,
      gold: 500 + 29 + 48 + 150,
    });
  });

  test("the attacker's stand-aside units do not fight and join the garrison", () => {
    const w = world({ now: T });
    city(w, { id: "c1", owner: "p1", island: "i1" });
    city(w, { id: "c2", owner: "p2", island: "i2", units: { guard: 2 } });
    addStationed(w.state, "c2", { owner: "p1", home: "c1", role: "support", units: { guard: 10 } });
    addMovement(w.state, w.rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      units: { raider: 30, settler: 1 },
      party: "p2",
      departAt: T - 3599,
      arriveAt: T + 1,
    });
    const match = load(w);
    const { events } = match.advanceTo(T + 1);
    // A = 600 against D = 2·20 + 50 = 90: q = lossPm(90, 600) = 22, so cas(30, 22) = 1 raider.
    const stacks = copyFor(events, "battle_report", "p2").data["stacks"];
    expect(stacks).toEqual([
      { side: "attacker", owner: "p1", unit: "raider", before: 30, lost: 1, survived: 29 },
      { side: "attacker", owner: "p1", unit: "settler", before: 1, lost: 0, survived: 1 },
      { side: "defender", owner: "p2", unit: "guard", before: 2, lost: 2, survived: 0 },
    ]);
    expect(plain(cityIn(match, "c2").stationed)).toEqual([
      { owner: "p1", home: "c1", role: "hold", units: { guard: 10, raider: 29, settler: 1 } },
    ]);
  });
});

function capitalWorld(now: number) {
  const w = world({ now });
  city(w, {
    id: "c1",
    owner: "p1",
    island: "i1",
    capital: true,
    units: { raider: 50, settler: 1, transport: 3 },
  });
  city(w, {
    id: "c2",
    owner: "p2",
    island: "i2",
    capital: true,
    buildings: { warehouse: 1, hall: 1 },
    stock: 800,
  });
  return load(w);
}

describe("capital immunity (§9.5)", () => {
  test("a conquest launched on a capital before day 3 warns, then lands as a raid", () => {
    const match = capitalWorld(100000);
    const launched = match.apply("p1", {
      type: "attack",
      from: "c1",
      to: "c2",
      units: { raider: 50, settler: 1, transport: 3 },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(launched.warnings).toEqual([
      { code: CAPITAL_IMMUNE, details: { city: "c2", arriveAt: 105400, immuneUntil: 172800 } },
    ]);
    const { events } = match.advanceTo(105400);
    const r = copyFor(events, "battle_report", "p2").data;
    expect(r["siege"]).toBeNull();
    expect(r["land"]).toMatchObject({ winner: "attacker" });
    expect(extOf(match).sieges).toEqual({});
    expect(ofType(events, "siege_started")).toHaveLength(0);
    // 800 + 1.5 h at 50/h = 875 in stock, 100 of each safe from loot at warehouse 1.
    const back = movementBy(match, "p1", "return");
    expect(back.units["settler"]).toBe(1);
    expect(back.cargo).toEqual({ wood: 775, stone: 775, gold: 775 });
  });

  test("no warning without settlers, or when the attack lands from day 3 on", () => {
    const early = capitalWorld(100000);
    const plainAttack = early.apply("p1", {
      type: "attack",
      from: "c1",
      to: "c2",
      units: { raider: 50, transport: 3 },
    });
    expect(plainAttack.ok && plainAttack.warnings).toEqual([]);
    const late = capitalWorld(172800 - 5400);
    const lands = late.apply("p1", {
      type: "attack",
      from: "c1",
      to: "c2",
      units: { raider: 50, settler: 1, transport: 3 },
    });
    expect(lands.ok && lands.warnings).toEqual([]);
  });
});

/** p1's attack from c1 is under way; p2's wave besieges c1 at T + 100. */
function besiegedWhileAway(target: "c2" | "c3") {
  const w = world({ now: T });
  city(w, { id: "c1", owner: "p1", island: "i1", capital: true, units: { raider: 20 } });
  city(w, { id: "c2", owner: "p2", island: "i3", capital: true });
  city(w, { id: "c3", owner: "p3", island: "i2", capital: true });
  addMovement(w.state, w.rules, {
    kind: "attack",
    owner: "p2",
    from: "c2",
    to: "c1",
    units: { raider: 10, settler: 1 },
    party: "p1",
    departAt: T - 3500,
    arriveAt: T + 100,
  });
  const match = load(w);
  const out = match.apply("p1", {
    type: "attack",
    from: "c1",
    to: target,
    units: { raider: 20 },
  });
  if (!out.ok) throw new Error(`launch rejected: ${out.violation.code}`);
  const id = MovementIdSchema.parse(out.data["movement"]);
  match.advanceTo(T + 100);
  expect(extOf(match).sieges["c1"]?.by).toBe("p2");
  return { match, id };
}

describe("homecomings (§7.4, §9.3, §12)", () => {
  for (const target of ["c3", "c2"] as const) {
    test(`a recall into a home besieged meanwhile lands minTravel later and warns the besieger (target ${target})`, () => {
      const { match, id } = besiegedWhileAway(target);
      match.advanceTo(T + 300);
      const out = match.apply("p1", { type: "recall", movement: id });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const back = match.read().state.movements[id];
      expect(back?.kind).toBe("return");
      expect(back?.arriveAt).toBe(T + 300 + 3600);
      const warned = ofType(out.events, "incoming_attack");
      expect(warned).toHaveLength(1);
      expect(warned[0]?.to).toEqual([{ p: "p2", as: "party" }]);
      // std.turnBack keeps the movement's origin as the return's `from`.
      expect(warned[0]?.data).toEqual({
        movement: id,
        from: "c1",
        by: "p1",
        foe: "p2",
        to: "c1",
        departAt: T + 300,
        arriveAt: T + 3900,
        homecoming: true,
      });
      // Another step in the same second does not warn again.
      const again = match.apply("p1", { type: "send_message", to: ["p3"], text: "hi" });
      expect(again.ok && ofType(again.events, "incoming_attack")).toEqual([]);
      const { events } = match.advanceTo(T + 3900);
      const report = copyFor(events, "battle_report", "p1").data;
      expect(report).toMatchObject({ kind: "homecoming", attacker: "p1", defender: "p2" });
      expect(report["siege"]).toBe("broken");
      expect(extOf(match).sieges).toEqual({});
      expect(cityIn(match, "c1").units["raider"]).toBeGreaterThan(0);
    });
  }

  test("a stationed recall into a besieged home reaches the besieger as an incoming attack", () => {
    const w = world({ now: T });
    city(w, { id: "c1", owner: "p1", island: "i1" });
    city(w, { id: "c2", owner: "p2", island: "i2" });
    city(w, { id: "c3", owner: "p3", island: "i3" });
    addStationed(w.state, "c3", { owner: "p1", home: "c1", role: "support", units: { raider: 5 } });
    besiege(w, { city: "c1", by: "p2", garrison: [{ home: "c2", units: { settler: 1 } }] });
    const match = load(w);
    const out = match.apply("p1", {
      type: "recall_stationed",
      at: "c3",
      home: "c1",
      units: null,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const warned = copyFor(out.events, "incoming_attack", "p2");
    expect(warned.to).toEqual([{ p: "p2", as: "party" }]);
    expect(warned.data).toMatchObject({ by: "p1", foe: "p2", to: "c1", homecoming: true });
    expect(movementBy(match, "p1", "return").party).toBe("p2");
  });
});

function conquestWorld() {
  const w = world({ now: T });
  city(w, { id: "c9", owner: "p2", island: "i1" });
  city(w, { id: "c14", owner: "p5", island: "i2" });
  city(w, { id: "c16", owner: "p5", island: "i4" });
  city(w, { id: "c20", owner: "p6", island: "i3" });
  besiege(w, {
    city: "c14",
    by: "p2",
    garrison: [{ home: "c9", units: { raider: 30, settler: 2 } }],
    startedAt: T - 21500,
    endsAt: T + 100,
  });
  addStationed(w.state, "c20", {
    owner: "p5",
    home: "c14",
    role: "support",
    units: { guard: 5 },
  });
  const back = addMovement(w.state, w.rules, {
    kind: "return",
    owner: "p5",
    from: "c20",
    home: "c14",
    to: "c14",
    units: { raider: 10 },
    party: "p2",
    departAt: T - 100,
    arriveAt: T + 3000,
  });
  const out = addMovement(w.state, w.rules, {
    kind: "attack",
    owner: "p5",
    from: "c14",
    to: "c20",
    units: { raider: 4 },
    party: "p6",
    departAt: T - 30000,
    arriveAt: T + 5000,
  });
  return { w, back: back.id, out: out.id };
}

describe("conquest (§9.4) and re-homing (§7.7)", () => {
  test("the besieger takes the city; the former owner's units and movements fall back", () => {
    const { w, back, out } = conquestWorld();
    const match = load(w);
    const sail = match.ruleset.hooks.travelTime(match.read(), "i2", "i4", {
      kind: "return",
      units: { raider: 10 },
    });
    const { events } = match.advanceTo(T + 100);
    const c14 = cityIn(match, "c14");
    expect(c14.owner).toBe("p2");
    expect(plain(c14.units)).toEqual({ raider: 30, settler: 1 });
    expect(c14.stationed).toHaveLength(0);
    expect(extOf(match).sieges).toEqual({});
    expect(ofType(events, "city_conquered")).toEqual([
      {
        t: T + 100,
        type: "city_conquered",
        public: true,
        to: [
          { p: "p2", as: "self" },
          { p: "p5", as: "target" },
        ],
        data: { city: "c14", from: "p5", to: "p2" },
      },
    ]);
    const s = match.read().state;
    expect(s.movements[back]).toMatchObject({ home: "c16", to: "c16", arriveAt: T + 3000 + sail });
    expect(s.movements[out]?.home).toBe("c16");
    expect(plain(cityIn(match, "c20").stationed)).toEqual([
      { owner: "p5", home: "c16", role: "support", units: { guard: 5 } },
    ]);
    expect(s.players["p5"]?.alive).toBe(true);
  });

  test("returns that sail on into a besieged fallback are announced to its besieger", () => {
    const { w, back } = conquestWorld();
    city(w, { id: "c17", owner: "p3", island: "i3" });
    besiege(w, {
      city: "c16",
      by: "p3",
      garrison: [{ home: "c17", units: { settler: 1 } }],
      endsAt: T + 20000,
    });
    const match = load(w);
    const { events } = match.advanceTo(T + 100);
    const warned = copyFor(events, "incoming_attack", "p3");
    expect(warned.data).toMatchObject({ movement: back, foe: "p3", to: "c16", homecoming: true });
    expect(match.read().state.movements[back]?.party).toBe("p3");
  });

  test("losing the last city eliminates: units, movements, proposals, alliance, pacts, sieges", () => {
    const w = world({ now: T });
    city(w, { id: "c1", owner: "p1", island: "i3" });
    city(w, { id: "c2", owner: "p2", island: "i1" });
    city(w, { id: "c3", owner: "p3", island: "i3" });
    city(w, { id: "c4", owner: "p4", island: "i4" });
    city(w, { id: "c6", owner: "p6", island: "i4" });
    city(w, { id: "c14", owner: "p5", island: "i2" });
    besiege(w, {
      city: "c14",
      by: "p2",
      garrison: [{ home: "c2", units: { settler: 1, raider: 3 } }],
      endsAt: T + 100,
    });
    besiege(w, {
      city: "c3",
      by: "p5",
      garrison: [{ home: "c14", units: { settler: 1, raider: 5 } }],
      endsAt: T + 5000,
    });
    addPact(w.state, w.rules, "p5", "p4", { expiresAt: T + 90000 });
    addAlliance(w.state, "Blue", ["p5", "p6"]);
    addProposal(w.state, w.rules, { from: "p5", to: "p1" });
    addMovement(w.state, w.rules, {
      kind: "attack",
      owner: "p5",
      from: "c14",
      to: "c1",
      units: { raider: 2 },
      party: "p1",
      departAt: T - 30000,
      arriveAt: T + 4000,
    });
    const match = load(w);
    const { events } = match.advanceTo(T + 100);
    const s = match.read().state;
    expect(s.players["p5"]).toEqual({
      id: "p5",
      alive: false,
      eliminatedAt: T + 100,
      alliance: null,
    });
    expect(Object.values(s.movements).some((m) => m.owner === "p5")).toBe(false);
    expect(Object.values(s.proposals)).toHaveLength(0);
    expect(s.alliances).toEqual({});
    expect(s.pacts).toEqual([]);
    expect(cityIn(match, "c3").stationed).toHaveLength(0);
    expect(extOf(match).sieges).toEqual({});
    expect(s.queue.some((e) => e.kind === "siege_end")).toBe(false);
    expect(events.map((e) => e.type)).toEqual([
      "city_conquered",
      "player_eliminated",
      "alliance_left",
      "alliance_dissolved",
      "pact_ended",
      "siege_broken",
    ]);
    expect(ofType(events, "siege_broken")[0]?.data).toEqual({
      city: "c3",
      owner: "p3",
      by: "p5",
      cause: "eliminated",
    });
    expect(ofType(events, "pact_ended")[0]?.data).toMatchObject({ cause: "eliminated" });
    expect(match.ended).toBe(false);
  });

  test("the last player standing wins at once", () => {
    const w = world({ now: T });
    city(w, { id: "c1", owner: "p1", island: "i1" });
    city(w, { id: "c2", owner: "p2", island: "i2" });
    for (const p of ["p3", "p4", "p5", "p6"] as const) {
      const player = w.state.players[p];
      if (player !== undefined) Object.assign(player, { alive: false, eliminatedAt: 1000 });
    }
    besiege(w, {
      city: "c2",
      by: "p1",
      garrison: [{ home: "c1", units: { settler: 1 } }],
      endsAt: T + 100,
    });
    const match = load(w);
    const { events } = match.advanceTo(T + 100);
    expect(match.ended).toBe(true);
    expect(match.result?.reason).toBe("last_standing");
    expect(match.result?.winners).toEqual(["p1"]);
    expect(match.result?.standings[0]).toMatchObject({ player: "p1", rank: 1, alive: true });
    expect(match.result?.standings.map((s) => s.player)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "p5",
      "p6",
    ]);
    expect(events.at(-1)?.type).toBe("match_ended");
  });
});

describe("garrison changes (§7.4, §9.3)", () => {
  test("recalling the last settler abandons the siege; the rest of the garrison goes home", () => {
    const w = world({ now: T });
    city(w, { id: "c9", owner: "p2", island: "i1" });
    city(w, { id: "c11", owner: "p2", island: "i3" });
    city(w, { id: "c14", owner: "p5", island: "i2" });
    besiege(w, {
      city: "c14",
      by: "p2",
      garrison: [
        { home: "c9", units: { raider: 10, settler: 1 } },
        { home: "c11", units: { guard: 20 } },
      ],
    });
    const match = load(w);
    const out = match.apply("p2", {
      type: "recall_stationed",
      at: "c14",
      home: "c9",
      units: { settler: 1 },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(ofType(out.events, "siege_broken")[0]?.data).toEqual({
      city: "c14",
      owner: "p5",
      by: "p2",
      cause: "abandoned",
    });
    expect(cityIn(match, "c14").stationed).toHaveLength(0);
    expect(extOf(match).sieges).toEqual({});
    const returns = Object.values(match.read().state.movements)
      .filter((m) => m.owner === "p2")
      .map((m) => JSON.stringify([m.home, plain(m.units)]))
      .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((s): unknown => JSON.parse(s));
    expect(returns).toEqual([
      ["c11", { guard: 20 }],
      ["c9", { raider: 10 }],
      ["c9", { settler: 1 }],
    ]);
  });

  test("a relief attack addresses the besieger as party and the owner as target", () => {
    const w = world({ now: T });
    city(w, { id: "c1", owner: "p1", island: "i1" });
    city(w, { id: "c4", owner: "p1", island: "i3", units: { raider: 5 } });
    city(w, { id: "c2", owner: "p2", island: "i2" });
    city(w, { id: "c3", owner: "p3", island: "i4", units: { raider: 5 } });
    besiege(w, { city: "c1", by: "p2", garrison: [{ home: "c2", units: { settler: 1 } }] });
    const match = load(w);
    const third = match.apply("p3", { type: "attack", from: "c3", to: "c1", units: { raider: 5 } });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(copyFor(third.events, "incoming_attack", "p2").to).toEqual([
      { p: "p2", as: "party" },
      { p: "p1", as: "target" },
    ]);
    expect(copyFor(third.events, "incoming_attack", "p1").data).toMatchObject({ foe: "p2" });
    const own = match.apply("p1", { type: "attack", from: "c4", to: "c1", units: { raider: 5 } });
    expect(own.ok).toBe(true);
    if (!own.ok) return;
    expect(copyFor(own.events, "incoming_attack", "p2").to).toEqual([{ p: "p2", as: "party" }]);
  });
});
