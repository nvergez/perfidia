import { describe, expect, test } from "bun:test";
import { fmtTime } from "@perfidia/engine/core";
import { setLevel, stockAt, unitsAtHome } from "@perfidia/engine/std";
import { addCity, testStep } from "@perfidia/engine/testing";
import type { Action, CityId } from "@perfidia/protocol";
import { recruitMax } from "./index.ts";
import {
  FIXTURE,
  accepted,
  cityIn,
  cityOf,
  emptyState,
  load,
  res,
  violation,
  world,
} from "./fixtures.test.ts";

const at = (t: number): [number, string] => [t, fmtTime(t)];
const build = (city: CityId, building: string): Action => ({ type: "build", city, building });
const recruit = (city: CityId, unit: string, count: number): Action => ({
  type: "recruit",
  city,
  unit,
  count,
});
const cancel = (city: CityId, item: number): Action => ({ type: "cancel_queue", city, item });

describe("build", () => {
  test("enqueues the projected target, pays its cost and pins its duration", () => {
    const m = load(world().state);
    expect(accepted(m.apply("p1", build("c1", "tower")))).toEqual({
      city: "c1",
      item: 1,
      building: "tower",
      level: 2,
      start: [0, "D1 00:00"],
      end: [2000, "D1 00:33:20"],
      cost: res(100, 100, 60),
    });
    expect(stockAt(m.read(), "c1")).toEqual(res(400, 400, 440));
    // The next tower item projects 3 and starts when the first ends.
    expect(accepted(m.apply("p1", build("c1", "tower")))).toMatchObject({
      item: 2,
      level: 3,
      start: at(2000),
      end: at(5000),
      cost: res(150, 150, 90),
    });
  });

  test("the duration uses the build-speed level at enqueue", () => {
    const { state } = world();
    cityOf(state, "c1").buildings["tower"] = 3;
    const m = load(state);
    // woodcut 2 at tower 3: floor(600 × 2 × 10 / 12) = 1000 s.
    expect(accepted(m.apply("p1", build("c1", "woodcut")))).toMatchObject({ end: at(1000) });
  });

  test("items of a batch are independent consecutive actions", () => {
    const { state } = world();
    cityOf(state, "c1").stock = res(200 * 3600, 200 * 3600, 200 * 3600);
    const m = load(state);
    // Projected requirements: drill needs tower 2, which the previous item queues.
    expect(violation(m.apply("p1", build("c1", "drill"))).code).toBe("REQUIREMENT_MISSING");
    expect(violation(m.apply("p1", build("c1", "castle"))).code).toBe("INVALID_ARGS");
    expect(accepted(m.apply("p1", build("c1", "tower")))).toMatchObject({ item: 1 });
    expect(accepted(m.apply("p1", build("c1", "woodcut")))).toMatchObject({ item: 2 });
    // The third item sees what the first two spent: (60, 20, 100) left.
    expect(violation(m.apply("p1", build("c1", "stonecut")))).toEqual({
      code: "INSUFFICIENT_RESOURCES",
      details: {
        building: "stonecut",
        level: 2,
        city: "c1",
        need_wood: 80,
        have_wood: 60,
        rate_wood: 60,
        need_stone: 40,
        have_stone: 20,
        rate_stone: 60,
        availableAt: 1200,
      },
    });
  });

  test("violations carry their numbers", () => {
    const { state } = world();
    cityOf(state, "c1").stock = res(50 * 3600, 50 * 3600, 50 * 3600);
    const m = load(state);
    expect(violation(m.apply("p1", build("c99", "tower")))).toEqual({
      code: "UNKNOWN_ID",
      details: { city: "c99" },
    });
    expect(violation(m.apply("p1", build("c2", "tower")))).toEqual({
      code: "NOT_OWNER",
      details: { city: "c2", owner: "p2" },
    });
    expect(violation(m.apply("p1", build("c1", "castle")))).toEqual({
      code: "INVALID_ARGS",
      details: { building: "castle", reason: "unknown_building" },
    });
    expect(violation(m.apply("p1", build("c1", "drill")))).toEqual({
      code: "REQUIREMENT_MISSING",
      details: {
        building: "drill",
        city: "c1",
        requires: "tower",
        need: 2,
        have: 1,
        on: "projected",
        availableAt: null,
      },
    });
    expect(violation(m.apply("p1", build("c1", "tower")))).toEqual({
      code: "INSUFFICIENT_RESOURCES",
      details: {
        building: "tower",
        level: 2,
        city: "c1",
        need_wood: 100,
        have_wood: 50,
        rate_wood: 60,
        need_stone: 100,
        have_stone: 50,
        rate_stone: 60,
        need_gold: 60,
        have_gold: 50,
        rate_gold: 60,
        availableAt: 3000,
      },
    });
  });

  test("MAX_LEVEL counts queued items", () => {
    const { state } = world();
    cityOf(state, "c1").buildings["tower"] = 4;
    cityOf(state, "c1").stock = res(1000 * 3600, 1000 * 3600, 1000 * 3600);
    const m = load(state);
    accepted(m.apply("p1", build("c1", "tower")));
    expect(violation(m.apply("p1", build("c1", "tower")))).toEqual({
      code: "MAX_LEVEL",
      details: { city: "c1", building: "tower", level: 4, target: 6, maxLevel: 5 },
    });
  });

  test("QUEUE_FULL is available when the active item ends", () => {
    const m = load(world().state);
    for (const b of ["tower", "woodcut", "stonecut"]) accepted(m.apply("p1", build("c1", b)));
    expect(violation(m.apply("p1", build("c1", "goldcut")))).toEqual({
      code: "QUEUE_FULL",
      details: { city: "c1", queue: "build", max: 3, availableAt: 2000 },
    });
  });

  test("EXCEEDS_STORAGE names the storage level needed", () => {
    const { state } = world();
    cityOf(state, "c1").buildings["rampart"] = 4;
    const m = load(state);
    expect(violation(m.apply("p1", build("c1", "rampart")))).toEqual({
      code: "EXCEEDS_STORAGE",
      details: {
        building: "rampart",
        level: 5,
        city: "c1",
        storage: "vault",
        storageLevel: 1,
        cap: 1000,
        requiredLevel: 2,
        need_stone: 1250,
        availableAt: null,
      },
    });
  });

  test("EXCEEDS_STORAGE is available when a queued storage item reaches the level needed", () => {
    const { state } = world();
    cityOf(state, "c1").buildings["rampart"] = 4;
    const m = load(state);
    // vault 2 at tower 1: floor(500 × 2 × 10 / 10) = 1000 s.
    expect(accepted(m.apply("p1", build("c1", "vault")))).toMatchObject({
      level: 2,
      end: at(1000),
    });
    expect(violation(m.apply("p1", build("c1", "rampart")))).toEqual({
      code: "EXCEEDS_STORAGE",
      details: {
        building: "rampart",
        level: 5,
        city: "c1",
        storage: "vault",
        storageLevel: 1,
        cap: 1000,
        requiredLevel: 2,
        need_stone: 1250,
        availableAt: 1000,
      },
    });
    m.advanceTo(1000);
    expect(violation(m.apply("p1", build("c1", "rampart"))).code).toBe("INSUFFICIENT_RESOURCES");
  });

  test("completed requirements wait for the queued item (availableAt)", () => {
    // The fixture ruleset checks requirements on completed levels: drill needs tower 1.
    const { state, rules } = emptyState({ ruleset: FIXTURE, players: 2 });
    addCity(state, rules, { owner: "p1", id: "c1", buildings: { vault: 1 }, stock: 500 });
    addCity(state, rules, { owner: "p2", id: "c2", island: "i2", stock: 500 });
    const m = load(state, FIXTURE);
    const missing = {
      building: "drill",
      city: "c1",
      requires: "tower",
      need: 1,
      have: 0,
      on: "completed",
    };
    expect(violation(m.apply("p1", build("c1", "drill")))).toEqual({
      code: "REQUIREMENT_MISSING",
      details: { ...missing, availableAt: null },
    });
    expect(accepted(m.apply("p1", build("c1", "tower")))).toMatchObject({ end: at(600) });
    expect(violation(m.apply("p1", build("c1", "drill")))).toEqual({
      code: "REQUIREMENT_MISSING",
      details: { ...missing, availableAt: 600 },
    });
    m.advanceTo(600);
    expect(accepted(m.apply("p1", build("c1", "drill")))).toMatchObject({ level: 1 });
  });
});

describe("recruit", () => {
  test("enqueues a batch with the cost, pop and unit time pinned; units trickle home", () => {
    const m = load(world().state);
    expect(accepted(m.apply("p1", recruit("c1", "soldier", 5)))).toEqual({
      city: "c1",
      item: 1,
      queue: "drill",
      unit: "soldier",
      count: 5,
      start: [0, "D1 00:00"],
      end: [300, "D1 00:05"],
      cost: res(50, 100, 50),
    });
    m.advanceTo(150);
    expect(unitsAtHome(m.read(), "c1")).toEqual({ soldier: 12 });
  });

  test("violations carry their numbers", () => {
    const { state } = world();
    cityOf(state, "c1").stock = res(50 * 3600, 50 * 3600, 50 * 3600);
    const m = load(state);
    expect(violation(m.apply("p1", recruit("c1", "dragon", 1)))).toEqual({
      code: "INVALID_ARGS",
      details: { unit: "dragon", reason: "unknown_unit" },
    });
    expect(violation(m.apply("p1", recruit("c1", "raider", 1)))).toEqual({
      code: "REQUIREMENT_MISSING",
      details: {
        unit: "raider",
        city: "c1",
        requires: "drill",
        need: 2,
        have: 1,
        on: "completed",
        availableAt: null,
      },
    });
    expect(violation(m.apply("p1", recruit("c1", "soldier", 101)))).toEqual({
      code: "BATCH_LIMIT",
      details: { city: "c1", unit: "soldier", requested: 101, max: 100 },
    });
    expect(violation(m.apply("p1", recruit("c1", "soldier", 31)))).toEqual({
      code: "INSUFFICIENT_POPULATION",
      details: {
        city: "c1",
        unit: "soldier",
        count: 31,
        need: 31,
        used: 10,
        cap: 40,
        availableAt: null,
      },
    });
    expect(violation(m.apply("p1", recruit("c1", "soldier", 3)))).toEqual({
      code: "INSUFFICIENT_RESOURCES",
      details: {
        unit: "soldier",
        count: 3,
        city: "c1",
        need_stone: 60,
        have_stone: 50,
        rate_stone: 60,
        availableAt: 600,
      },
    });
  });

  test("requirements and population wait for queued builds (availableAt)", () => {
    const { state } = world();
    cityOf(state, "c1").buildings["tower"] = 2;
    cityOf(state, "c1").buildings["vault"] = 3;
    const m = load(state);
    // drill 2 at tower 2: floor(800 × 2 × 10 / 11) = 1454 s.
    accepted(m.apply("p1", build("c1", "drill")));
    expect(violation(m.apply("p1", recruit("c1", "raider", 1))).details).toMatchObject({
      requires: "drill",
      availableAt: 1454,
    });
    // tower 2 holds 80 pop; tower 3 (queued, ends at 1454 + 2727) holds 120.
    accepted(m.apply("p1", build("c1", "tower")));
    expect(violation(m.apply("p1", recruit("c1", "soldier", 75)))).toEqual({
      code: "INSUFFICIENT_POPULATION",
      details: {
        city: "c1",
        unit: "soldier",
        count: 75,
        need: 75,
        used: 10,
        cap: 80,
        availableAt: 1454 + 2727,
      },
    });
  });

  test("QUEUE_FULL is available when the first batch ends", () => {
    const m = load(world().state);
    for (let i = 0; i < 3; i += 1) accepted(m.apply("p1", recruit("c1", "soldier", 1)));
    expect(violation(m.apply("p1", recruit("c1", "soldier", 1)))).toEqual({
      code: "QUEUE_FULL",
      details: { city: "c1", queue: "drill", max: 3, availableAt: 60 },
    });
  });

  test("the founding unit costs settlerCost[k], and EXCEEDS_STORAGE names the level needed", () => {
    const { state } = world();
    const c1 = cityOf(state, "c1");
    c1.buildings["tower"] = 2;
    c1.buildings["drill"] = 2;
    const m = load(state);
    // k = 1 city + 0 founders.
    expect(accepted(m.apply("p1", recruit("c1", "pioneer", 1)))).toMatchObject({
      cost: res(200, 200, 200),
    });
    expect(violation(m.apply("p1", recruit("c1", "pioneer", 2)))).toEqual({
      code: "BATCH_LIMIT",
      details: { city: "c1", unit: "pioneer", requested: 2, max: 1 },
    });
    // k = 2: the queued founder counts.
    expect(accepted(m.apply("p1", recruit("c1", "pioneer", 1)))).toMatchObject({
      cost: res(300, 300, 300),
    });
    expect(violation(m.apply("p1", recruit("c1", "pioneer", 1)))).toEqual({
      code: "EXCEEDS_STORAGE",
      details: {
        unit: "pioneer",
        count: 1,
        k: 3,
        city: "c1",
        storage: "vault",
        storageLevel: 1,
        cap: 1000,
        requiredLevel: 2,
        need_gold: 1200,
        availableAt: null,
      },
    });
  });

  test("recruitMax is the binding minimum, and 0 on a full queue", () => {
    const m = load(world().state);
    // Stone pays for 25 soldiers; pop allows 30.
    expect(recruitMax(m.read(), "c1", "soldier")).toBe(25);
    for (let i = 0; i < 3; i += 1) accepted(m.apply("p1", recruit("c1", "soldier", 1)));
    expect(recruitMax(m.read(), "c1", "soldier")).toBe(0);
    expect(recruitMax(m.read(), "c99", "soldier")).toBe(0);
  });
});

/** c1 with three queued build items. */
function queued() {
  const m = load(world().state);
  accepted(m.apply("p1", build("c1", "tower"))); // #1, 0..2000, (100, 100, 60)
  accepted(m.apply("p1", build("c1", "woodcut"))); // #2, 2000..3200, (40, 80, 40)
  accepted(m.apply("p1", build("c1", "stonecut"))); // #3, 3200..4400, (80, 40, 40)
  return m;
}

describe("cancel_queue", () => {
  test("is a tail cancel: the item and every later one, queued items refunded in full", () => {
    const m = queued();
    m.advanceTo(1000);
    const before = stockAt(m.read(), "c1");
    const out = m.apply("p1", cancel("c1", 2));
    expect(accepted(out)).toEqual({
      city: "c1",
      queue: "build",
      removed: [2, 3],
      refund: res(120, 120, 80),
    });
    expect(out.ok && out.events).toEqual([]);
    const after = stockAt(m.read(), "c1");
    expect([after.wood - before.wood, after.stone - before.stone]).toEqual([120, 120]);
    expect(cityIn(m, "c1").build.map((b) => b.id)).toEqual([1]);
    expect(m.read().state.queue.filter((e) => e.kind === "build_done")).toHaveLength(1);
  });

  test("the active item refunds pro rata; emptying a queue emits no queue_empty", () => {
    const m = queued();
    m.advanceTo(1000);
    const out = m.apply("p1", cancel("c1", 1));
    expect(accepted(out)).toMatchObject({ removed: [1, 2, 3], refund: res(170, 170, 110) });
    expect(out.ok && out.events).toEqual([]);
    expect(cityIn(m, "c1").build).toEqual([]);
  });

  test("a recruit batch cancelled mid-unit keeps its delivered units and refunds the rest", () => {
    const m = load(world().state);
    accepted(m.apply("p1", recruit("c1", "soldier", 5))); // 60 s per unit
    m.advanceTo(150);
    expect(accepted(m.apply("p1", cancel("c1", 1)))).toMatchObject({
      queue: "drill",
      removed: [1],
      refund: res(30, 60, 30),
    });
    expect(unitsAtHome(m.read(), "c1")).toEqual({ soldier: 12 });
  });

  test("an item that already completed, or never existed, is QUEUE_ITEM", () => {
    const m = queued();
    m.advanceTo(2000);
    expect(violation(m.apply("p1", cancel("c1", 1)))).toEqual({
      code: "QUEUE_ITEM",
      details: { city: "c1", item: 1, issued: true },
    });
    expect(violation(m.apply("p1", cancel("c1", 9)))).toEqual({
      code: "QUEUE_ITEM",
      details: { city: "c1", item: 9, issued: false },
    });
    expect(violation(m.apply("p2", cancel("c1", 2))).code).toBe("NOT_OWNER");
  });
});

describe("completions", () => {
  test("build_done emits queue_empty only when it empties the build queue", () => {
    const m = load(world().state);
    accepted(m.apply("p1", build("c1", "tower")));
    accepted(m.apply("p1", build("c1", "woodcut")));
    expect(m.advanceTo(2000).events.map((e) => e.type)).toEqual(["build_done"]);
    expect(cityIn(m, "c1").buildings["tower"]).toBe(2);
    const last = m.advanceTo(3200).events;
    expect(last.map((e) => e.type)).toEqual(["build_done", "queue_empty"]);
    expect(last[0]).toMatchObject({
      to: [{ p: "p1", as: "self" }],
      data: { city: "c1", item: 2, building: "woodcut", level: 2 },
    });
    expect(last[1]?.data).toEqual({ city: "c1", queue: "build" });
  });

  test("recruit_done emits queue_empty only when it empties its queue", () => {
    const m = load(world().state);
    accepted(m.apply("p1", recruit("c1", "soldier", 2))); // 0..120
    accepted(m.apply("p1", recruit("c1", "soldier", 1))); // 120..180
    expect(m.advanceTo(120).events.map((e) => e.type)).toEqual(["recruit_done"]);
    const last = m.advanceTo(180).events;
    expect(last.map((e) => e.type)).toEqual(["recruit_done", "queue_empty"]);
    expect(last[1]?.data).toEqual({ city: "c1", queue: "drill" });
    expect(unitsAtHome(m.read(), "c1")).toEqual({ soldier: 13 });
  });

  test("a queued wall item completes at current + 1 after a breach", () => {
    const { state } = world();
    const c1 = cityOf(state, "c1");
    c1.buildings["rampart"] = 4;
    c1.buildings["vault"] = 2;
    c1.stock = res(1500 * 3600, 1500 * 3600, 1500 * 3600);
    const m = load(state);
    // rampart 5 at tower 1: 900 × 5 = 4500 s.
    expect(accepted(m.apply("p1", build("c1", "rampart")))).toMatchObject({
      level: 5,
      end: at(4500),
    });
    testStep(m, (ctx) => setLevel(ctx, "c1", "rampart", 3));
    // While #1 is queued, a new rampart item projects 3 + 1 + 1 = 5.
    expect(violation(m.apply("p1", build("c1", "rampart"))).details).toMatchObject({
      building: "rampart",
      level: 5,
    });
    const done = m.advanceTo(4500).events.find((e) => e.type === "build_done");
    expect(done?.data).toEqual({ city: "c1", item: 1, building: "rampart", level: 4 });
    expect(cityIn(m, "c1").buildings["rampart"]).toBe(4);
  });
});
