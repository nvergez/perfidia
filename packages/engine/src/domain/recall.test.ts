import { describe, expect, test } from "bun:test";
import { fmtTime } from "@perfidia/engine/core";
import type { AnyRuleset } from "@perfidia/engine/contracts";
import { addCity, addMovement, addStationed } from "@perfidia/engine/testing";
import {
  MovementIdSchema,
  compareIds,
  type Action,
  type CityId,
  type MovementId,
  type PlayerId,
  type UnitCounts,
} from "@perfidia/protocol";
import { FIXTURE, RICH, accepted, cityIn, load, violation, world } from "./fixtures.test.ts";

const at = (t: number): [number, string] => [t, fmtTime(t)];
const recall = (movement: MovementId): Action => ({ type: "recall", movement });
const recallAt = (
  city: CityId,
  home: CityId | null = null,
  units: UnitCounts | null = null,
): Action => ({ type: "recall_stationed", at: city, home, units });
const dismiss = (city: CityId, player: PlayerId): Action => ({ type: "dismiss", city, player });

const ARMY = { soldier: 20, raider: 10, pioneer: 1, ship: 3 };

function launched(m: ReturnType<typeof load>, a: Action): MovementId {
  return MovementIdSchema.parse(accepted(m.apply("p1", a))["movement"]);
}

const raid: Action = { type: "attack", from: "c1", to: "c3", units: { raider: 5 } };

describe("recall", () => {
  test("turns back within the window, home at now + max(1, now − departAt)", () => {
    const m = load(world({ units: { c1: ARMY } }).state);
    const id = launched(m, raid);
    m.advanceTo(200);
    const out = m.apply("p1", recall(id));
    expect(accepted(out)).toEqual({ returns: [{ movement: id, home: "c1", arrive: at(400) }] });
    expect(out.ok && out.events).toEqual([
      {
        t: 200,
        type: "movement_recalled",
        public: false,
        to: [
          { p: "p3", as: "party" },
          { p: "p1", as: "self" },
        ],
        data: { movement: id, kind: "attack", by: "p1", to: "c3", arriveAt: 400 },
      },
    ]);
    expect(m.advanceTo(400).events.map((e) => e.type)).toEqual(["returned"]);
    expect(cityIn(m, "c1").units).toEqual(ARMY);
  });

  test("a recall in the launch second takes 1 s; the window's last second still counts", () => {
    const m = load(world({ units: { c1: ARMY } }).state);
    const first = launched(m, raid);
    expect(accepted(m.apply("p1", recall(first)))).toMatchObject({
      returns: [{ arrive: at(1) }],
    });
    const second = launched(m, raid);
    m.advanceTo(600);
    expect(accepted(m.apply("p1", recall(second)))).toMatchObject({
      returns: [{ arrive: at(1200) }],
    });
  });

  test("into a home held by another player's hold group: now + max(minTravel, now − departAt)", () => {
    const { state } = world({ units: { c1: ARMY } });
    addStationed(state, "c1", { owner: "p2", home: "c2", role: "hold", units: { soldier: 3 } });
    const m = load(state);
    const id = launched(m, raid);
    m.advanceTo(200);
    expect(accepted(m.apply("p1", recall(id)))).toEqual({
      returns: [{ movement: id, home: "c1", arrive: at(3800) }],
    });
  });

  test("NOT_RECALLABLE after the window and for kinds the rules exclude", () => {
    const { state, rules } = world({ units: { c1: ARMY } });
    const back = addMovement(state, rules, {
      kind: "return",
      owner: "p1",
      from: "c3",
      to: "c1",
      home: "c1",
      units: { soldier: 1 },
      arriveAt: 5000,
    });
    const m = load(state);
    const id = launched(m, raid);
    const spied = launched(m, { type: "spy", from: "c1", to: "c3", gold: 20 });
    m.advanceTo(601);
    expect(violation(m.apply("p1", recall(id)))).toEqual({
      code: "NOT_RECALLABLE",
      details: { movement: id, kind: "attack", window: 600, departAt: 0, recallableUntil: 600 },
    });
    expect(violation(m.apply("p1", recall(spied))).details).toMatchObject({
      kind: "spy",
      recallableUntil: null,
    });
    expect(violation(m.apply("p1", recall(back.id))).details).toMatchObject({
      kind: "return",
      recallableUntil: null,
    });
  });

  test("another player's movement answers exactly like a missing one", () => {
    const m = load(world({ units: { c1: ARMY } }).state);
    const id = launched(m, raid);
    expect(violation(m.apply("p3", recall(id)))).toEqual({
      code: "UNKNOWN_ID",
      details: { movement: id },
    });
    expect(violation(m.apply("p3", recall("m00000")))).toEqual({
      code: "UNKNOWN_ID",
      details: { movement: "m00000" },
    });
  });
});

/** p1 owns c1 (i1) and c4 (i2); p1 has groups from c1 (6 soldiers) and c4 (4 soldiers, 2 ships) in p2's c2 (i2). */
function twoHomes(ruleset = RICH) {
  const { state, rules } = world({ ruleset });
  addCity(state, rules, { owner: "p1", id: "c4", island: "i2", buildings: { vault: 1 } });
  addStationed(state, "c2", { owner: "p1", home: "c1", role: "support", units: { soldier: 6 } });
  addStationed(state, "c2", {
    owner: "p1",
    home: "c4",
    role: "support",
    units: { soldier: 4, ship: 2 },
  });
  return load(state, ruleset);
}

describe("recall_stationed", () => {
  test("a partial recall without home is AMBIGUOUS_GROUP when groups come from two homes", () => {
    const m = twoHomes();
    expect(violation(m.apply("p1", recallAt("c2", null, { soldier: 3 })))).toEqual({
      code: "AMBIGUOUS_GROUP",
      details: { city: "c2", groups: 2, homes: "c1,c4" },
    });
  });

  test("with home it takes from that group, and the rest stays", () => {
    const m = twoHomes();
    const out = accepted(m.apply("p1", recallAt("c2", "c4", { soldier: 3 })));
    expect(out).toMatchObject({ returns: [{ home: "c4", arrive: at(3600) }] });
    expect(cityIn(m, "c2").stationed).toEqual([
      { owner: "p1", home: "c1", role: "support", units: { soldier: 6 } },
      { owner: "p1", home: "c4", role: "support", units: { soldier: 1, ship: 2 } },
    ]);
    m.advanceTo(3600);
    expect(cityIn(m, "c4").units).toEqual({ soldier: 3 });
  });

  test("units: null sends every group home as its own return", () => {
    const m = twoHomes();
    const out = accepted(m.apply("p1", recallAt("c2")));
    expect(out).toMatchObject({
      returns: [
        { home: "c1", arrive: at(5400) },
        { home: "c4", arrive: at(3600) },
      ],
    });
    expect(cityIn(m, "c2").stationed).toEqual([]);
    const returns = Object.values(m.read().state.movements).toSorted((x, y) =>
      compareIds(x.home, y.home),
    );
    expect(returns.map((x) => [x.kind, x.home, x.units])).toEqual([
      ["return", "c1", { soldier: 6 }],
      ["return", "c4", { soldier: 4, ship: 2 }],
    ]);
    const one = twoHomes();
    expect(accepted(one.apply("p1", recallAt("c2", "c1")))).toMatchObject({
      returns: [{ home: "c1" }],
    });
  });

  test("violations carry their numbers", () => {
    const m = twoHomes();
    expect(violation(m.apply("p1", recallAt("c9")))).toEqual({
      code: "UNKNOWN_ID",
      details: { city: "c9" },
    });
    expect(violation(m.apply("p1", recallAt("c3")))).toEqual({
      code: "NOTHING_STATIONED",
      details: { city: "c3", home: null },
    });
    expect(violation(m.apply("p1", recallAt("c2", "c3")))).toEqual({
      code: "NOTHING_STATIONED",
      details: { city: "c2", home: "c3" },
    });
    expect(violation(m.apply("p1", recallAt("c2", "c4", { soldier: 9 })))).toEqual({
      code: "INSUFFICIENT_UNITS",
      details: {
        city: "c2",
        from: "c4",
        unit: "soldier",
        requested: 9,
        home: 4,
        where: "stationed",
      },
    });
    expect(violation(m.apply("p1", recallAt("c2", "c4", {})))).toEqual({
      code: "NO_UNITS",
      details: { city: "c2" },
    });
  });

  test("a single group needs no home; own hold groups are recalled too", () => {
    const { state } = world();
    addStationed(state, "c2", { owner: "p1", home: "c1", role: "hold", units: { soldier: 5 } });
    const m = load(state);
    expect(accepted(m.apply("p1", recallAt("c2", null, { soldier: 2 })))).toMatchObject({
      returns: [{ home: "c1", arrive: at(5400) }],
    });
    expect(cityIn(m, "c2").stationed).toEqual([
      { owner: "p1", home: "c1", role: "hold", units: { soldier: 3 } },
    ]);
  });

  test("a ruleset without stationed recalls rejects them", () => {
    const none: AnyRuleset = {
      ...RICH,
      compile(config, players) {
        const rules = RICH.compile(config, players);
        const noRecall = { ...rules.movement.recall, stationed: "none" as const };
        return { ...rules, movement: { ...rules.movement, recall: noRecall } };
      },
    };
    expect(violation(twoHomes(none).apply("p1", recallAt("c2")))).toEqual({
      code: "NOT_RECALLABLE",
      details: { city: "c2", stationed: "none" },
    });
  });

  test("a ruleset that recalls stationed groups whole rejects a unit list", () => {
    const m = twoHomes(FIXTURE);
    expect(violation(m.apply("p1", recallAt("c2", "c4", { soldier: 1 })))).toEqual({
      code: "NOT_RECALLABLE",
      details: { city: "c2", stationed: "whole", reason: "whole_only" },
    });
    expect(accepted(m.apply("p1", recallAt("c2", "c4")))).toMatchObject({
      returns: [{ home: "c4" }],
    });
  });
});

describe("dismiss", () => {
  test("sends every support group of the player home and tells it", () => {
    const m = twoHomes();
    const out = m.apply("p2", dismiss("c2", "p1"));
    const data = accepted(out);
    expect(data).toMatchObject({ returns: [{ home: "c1" }, { home: "c4" }] });
    expect(out.ok && out.events.map((e) => [e.type, e.to, e.data["dismissedBy"]])).toEqual([
      ["movement_recalled", [{ p: "p1", as: "self" }], "p2"],
      ["movement_recalled", [{ p: "p1", as: "self" }], "p2"],
    ]);
    expect(cityIn(m, "c2").stationed).toEqual([]);
  });

  test("violations carry their numbers; hold groups cannot be dismissed", () => {
    const { state } = world();
    addStationed(state, "c2", { owner: "p1", home: "c1", role: "hold", units: { soldier: 5 } });
    const m = load(state);
    expect(violation(m.apply("p2", dismiss("c2", "p1")))).toEqual({
      code: "NOTHING_STATIONED",
      details: { city: "c2", player: "p1" },
    });
    expect(violation(m.apply("p2", dismiss("c2", "p2")))).toEqual({
      code: "INVALID_TARGET",
      details: { player: "p2", city: "c2", action: "dismiss", reason: "self" },
    });
    expect(violation(m.apply("p2", dismiss("c2", "p9")))).toEqual({
      code: "UNKNOWN_ID",
      details: { player: "p9" },
    });
    expect(violation(m.apply("p1", dismiss("c2", "p3")))).toEqual({
      code: "NOT_OWNER",
      details: { city: "c2", owner: "p2" },
    });
    const fixture = twoHomes(FIXTURE);
    expect(violation(fixture.apply("p2", dismiss("c2", "p1")))).toEqual({
      code: "NOT_RECALLABLE",
      details: { city: "c2", player: "p1", dismiss: false },
    });
  });
});
