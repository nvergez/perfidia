// Fixture behaviours of the conqueror (docs/architecture.md §11.2) on rules shaped like perfidia-1
// and like sandbox-1: its victim and the notes that keep it, its strikes (founders in the wave that
// takes the city, the garrison after it, capitals left alone while immune, the train whose last
// waves are timed from the travel times), founders recruited just in time, its sieges held or given
// up, and its diplomacy. Its play on real matches is tested in `sim` (`conqueror.test.ts`).

import { describe, expect, test } from "bun:test";
import type { CityId, IslandId, JsonObject, PlayerId } from "@perfidia/protocol";
import {
  advance,
  callsTo,
  capital,
  counts,
  perfidiaGame,
  playTurn,
  res,
  sandboxGame,
  type FakeGame,
  type FCity,
} from "./fixtures.test.ts";
import { fmtTime } from "./kit.ts";
import { encodeMemory, parseMemory, type Memory } from "./memory.ts";
import { createBot } from "./registry.ts";

const DAY = 86400;
const pair = (t: number): [number, string] => [t, fmtTime(t)];

interface Shape {
  readonly name: string;
  game(): FakeGame;
  readonly defender: string;
  readonly attacker: string;
  readonly founder: string;
  readonly carrier: string;
  /** Levels where every unit of the fixture can be recruited. */
  readonly developed: Record<string, number>;
  /** The config numbers the hints point at (`hints.ts`). */
  readonly config: JsonObject;
  /** An island of p1's sector (not its home) and one of p2's, for colonies. */
  readonly near: IslandId;
  readonly far: IslandId;
}

const SHAPES: Shape[] = [
  {
    name: "perfidia-1 shape",
    game: () => perfidiaGame(6),
    defender: "guard",
    attacker: "raider",
    founder: "settler",
    carrier: "transport",
    developed: {
      hall: 5,
      lumber: 4,
      quarry: 4,
      mine: 4,
      warehouse: 5,
      barracks: 3,
      harbor: 3,
      wall: 1,
    },
    config: {
      time: { capitalImmunityEnd: 2 * DAY },
      economy: { baseDefense: { a: 0, b: 20, c: 50 } },
      combat: { wallPmPerLevel: 50, moralePmPerCity: 100, moraleFloorPm: 700 },
    },
    near: "i4",
    far: "i7",
  },
  {
    name: "sandbox-1 shape",
    game: () => sandboxGame(6),
    defender: "spearman",
    attacker: "axeman",
    founder: "colonist",
    carrier: "boat",
    developed: { keep: 3, sawmill: 3, pit: 3, forge: 3, depot: 3, camp: 2, docks: 1 },
    config: { time: { capitalImmunityEnd: 2 * DAY } },
    near: "i2",
    far: "i4",
  },
];

function bot(seed = 11) {
  return createBot("conqueror", { seat: "p1", seed, strict: true });
}

/** The game of `shape` with the config numbers its hints point at. */
function gameOf(shape: Shape): FakeGame {
  const game = shape.game();
  Object.assign(game.info.config, structuredClone(shape.config));
  return game;
}

function memoryOf(game: FakeGame): Memory {
  return parseMemory(game.notes.get("p1") ?? "", "conqueror");
}

/** Notes of a conqueror committed to victim `p<n>` (a conquest wave already left for it). */
function committedTo(n: number): string {
  return encodeMemory({ s: "conqueror", h: null, f: {}, m: [], x: { av: n, ac: 1 }, k: [] }, 4000);
}

/** A city of `owner` on `island`, not a capital. */
function colony(
  shape: Shape,
  id: CityId,
  owner: PlayerId,
  island: IslandId,
  units: Record<string, number>,
): FCity {
  const c = capital(id, owner, island, shape.developed, res(300, 300, 300), units);
  c.slot = 1;
  c.capitalOf = null;
  return c;
}

/** A fresh spy report of p1 on `city`: `units` at home, and the levels it saw. */
function spied(
  game: FakeGame,
  city: CityId,
  units: Record<string, number>,
  buildings: Record<string, number>,
): void {
  game.intel.set(`p1|${city}`, {
    type: "spy_report",
    at: game.t - 3600,
    data: { report: "r00001", city, buildings, units: { home: units } },
  });
}

/** p1's capital with an army, its founders and the carriers for all of it. */
function armed(shape: Shape, game: FakeGame, units: Record<string, number>): void {
  const c1 = game.city("c1");
  c1.levels = { ...shape.developed };
  c1.stock = res(5000, 5000, 5000);
  c1.units = { ...units };
}

/**
 * p1 armed at the day after attacks open, against p2's weak colony c20 (spied), and with `guarded`
 * p2's colony c21 on the same island with 400 defenders (spied).
 */
function weakColony(shape: Shape, guarded: boolean): FakeGame {
  const game = gameOf(shape);
  game.t = game.rules.time.attackFrom + DAY;
  armed(shape, game, {
    [shape.attacker]: 80,
    [shape.defender]: 20,
    [shape.carrier]: 20,
    [shape.founder]: 2,
  });
  game.cities.push(colony(shape, "c20", "p2", shape.near, { [shape.defender]: 2 }));
  spied(game, "c20", { [shape.defender]: 2 }, { [game.rules.roles.population]: 1 });
  if (guarded) {
    const c21 = colony(shape, "c21", "p2", shape.near, { [shape.defender]: 400 });
    c21.slot = 2;
    game.cities.push(c21);
    spied(game, "c21", { [shape.defender]: 400 }, { [game.rules.roles.population]: 1 });
  }
  return game;
}

const founderCount = (shape: Shape, a: Record<string, unknown>): number =>
  counts(a["units"])[shape.founder] ?? 0;

describe.each(SHAPES)("$name", (shape) => {
  test("its victim is the nearest player with the fewest cities, kept in its notes", async () => {
    const game = gameOf(shape);
    game.t = 3600;
    await playTurn(bot(), game, "p1");
    expect(game.violations).toEqual([]);
    const first = memoryOf(game);
    // Every player has its capital only: the nearest (p2, or p6 across the ring of sandbox-1).
    const nearest = shape.name.startsWith("perfidia") ? [2] : [2, 6];
    expect(nearest).toContain(first.x["av"] ?? 0);
    expect(first.m.some((l) => l.startsWith(`victim p${first.x["av"]}`))).toBe(true);
    expect(first.x["ac"]).toBe(0);

    // The nearest players now own three colonies each: a player with one city is chosen instead.
    const more = shape.game();
    more.t = 3600;
    Object.assign(more.info.config, structuredClone(shape.config));
    let n = 20;
    for (const p of ["p2", "p6"] as const) {
      for (let k = 0; k < 3; k += 1) {
        const isl = more.islands.find(
          (i) =>
            i.kind !== "crown" && more.cities.filter((c) => c.island === i.id).length < i.slots,
        )!;
        const c = colony(shape, `c${n}`, p, isl.id, {});
        c.slot = more.cities.filter((x) => x.island === isl.id).length;
        more.cities.push(c);
        n += 1;
      }
    }
    await playTurn(bot(), more, "p1");
    const v = memoryOf(more).x["av"];
    expect(v).not.toBe(2);
    expect(v).not.toBe(6);
    expect(more.cities.filter((c) => c.owner === `p${v}`).length).toBe(1);
  });

  test("a committed victim is kept while it has cities, and replaced once it is gone", async () => {
    const game = gameOf(shape);
    game.t = DAY;
    game.cities.push(colony(shape, "c20", "p3", shape.far, {}));
    // p3 has two cities, everyone else one: still the victim (not clearly out of reach).
    await playTurn(bot(), game, "p1", { notes: committedTo(3) });
    expect(memoryOf(game).x["av"]).toBe(3);

    for (const c of game.cities) if (c.owner === "p3") c.owner = "p4";
    await playTurn(bot(), game, "p1", { turn: 2 });
    const after = memoryOf(game);
    expect(after.x["av"]).not.toBe(3);
    expect(after.m.some((l) => l.startsWith("p3 gone"))).toBe(true);
  });

  test("notes it cannot parse are read as empty memory and rewritten", async () => {
    const game = gameOf(shape);
    game.t = 3600;
    const log = await playTurn(bot(), game, "p1", { notes: "Plan: befriend p2, then strike p3." });
    const notes = callsTo(log, "write_note");
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatchObject({ mode: "replace" });
    const memory = parseMemory(String(notes[0]!["text"]), "conqueror");
    expect(memory.s).toBe("conqueror");
    expect(memory.x["av"]).toBeGreaterThan(1);
  });

  test("it strikes its victim's weak colony: founders lead, the garrison follows in the same second", async () => {
    const game = gameOf(shape);
    game.t = game.rules.time.attackFrom + DAY;
    armed(shape, game, {
      [shape.attacker]: 80,
      [shape.defender]: 20,
      [shape.carrier]: 20,
      [shape.founder]: 2,
    });
    game.cities.push(colony(shape, "c20", "p2", shape.near, { [shape.defender]: 2 }));
    spied(game, "c20", { [shape.defender]: 2 }, { [game.rules.roles.population]: 1 });
    const log = await playTurn(bot(), game, "p1", { notes: committedTo(2) });
    expect(game.violations).toEqual([]);
    const attacks = callsTo(log, "attack");
    expect(attacks.length).toBeGreaterThanOrEqual(2);
    for (const a of attacks) expect(a).toMatchObject({ from: "c1", to: "c20" });
    // The founders' wave leaves first (it lands first: one island, one second), with two founders.
    expect(founderCount(shape, attacks[0]!)).toBe(2);
    expect(counts(attacks[0]!["units"])[shape.attacker]).toBeGreaterThan(0);
    // The garrison: the attackers left and half the capital's defenders, no founder.
    const rest = attacks.slice(1);
    expect(rest.every((a) => founderCount(shape, a) === 0)).toBe(true);
    expect(rest.reduce((n, a) => n + (counts(a["units"])[shape.defender] ?? 0), 0)).toBe(10);
    expect(memoryOf(game).x["ac"]).toBe(1);
  });

  test("a capital is left alone while immune and struck once it can fall", async () => {
    const game = gameOf(shape);
    armed(shape, game, {
      [shape.attacker]: 80,
      [shape.defender]: 20,
      [shape.carrier]: 20,
      [shape.founder]: 2,
    });
    game.t = DAY + 6 * 3600;
    spied(game, "c2", { [shape.defender]: 2 }, { [game.rules.roles.population]: 1 });
    const early = await playTurn(bot(), game, "p1", { notes: committedTo(2) });
    expect(callsTo(early, "attack")).toEqual([]);

    game.t = 2 * DAY;
    spied(game, "c2", { [shape.defender]: 2 }, { [game.rules.roles.population]: 1 });
    const open = await playTurn(bot(), game, "p1", { notes: committedTo(2) });
    const attacks = callsTo(open, "attack");
    expect(attacks.length).toBeGreaterThan(0);
    expect(attacks.every((a) => a["to"] === "c2")).toBe(true);
    expect(founderCount(shape, attacks[0]!)).toBeGreaterThan(0);
  });

  test("a strike that waits for a founder recruits one in the city that will lead it", async () => {
    const game = gameOf(shape);
    game.t = game.rules.time.attackFrom + DAY;
    armed(shape, game, { [shape.attacker]: 80, [shape.defender]: 20, [shape.carrier]: 20 });
    game.cities.push(colony(shape, "c20", "p2", shape.near, { [shape.defender]: 2 }));
    spied(game, "c20", { [shape.defender]: 2 }, { [game.rules.roles.population]: 1 });
    const log = await playTurn(bot(), game, "p1", { notes: committedTo(2) });
    expect(callsTo(log, "attack")).toEqual([]);
    const founders = callsTo(log, "recruit").filter((r) =>
      JSON.stringify(r["orders"]).includes(`"${shape.founder}"`),
    );
    expect(founders).toEqual([{ city: "c1", orders: [{ unit: shape.founder, count: 1 }] }]);
  });

  test("it reinforces a siege it holds: once when it begins, then before each attack on it", async () => {
    const game = gameOf(shape);
    game.t = game.rules.time.attackFrom + DAY;
    armed(shape, game, { [shape.defender]: 40, [shape.carrier]: 10 });
    game.city("c2").stationed.push({
      owner: "p1",
      home: "c1",
      role: "hold",
      units: { [shape.attacker]: 30, [shape.founder]: 1 },
    });
    const b = bot();
    const first = await playTurn(b, game, "p1", { notes: committedTo(2) });
    const once = callsTo(first, "support");
    expect(once.length).toBe(1);
    expect(once[0]).toMatchObject({ from: "c1", to: "c2" });
    expect(counts(once[0]!["units"])[shape.defender]).toBe(20);

    // The owner's army comes home in 4 h: three quarters of the defenders left go.
    game.t += 600;
    game.incoming.set("p1", [
      {
        id: "m0000a",
        kind: "attack",
        from: null,
        by: "p2",
        foe: "p1",
        to: "c2",
        depart: pair(game.t - 600),
        arrive: pair(game.t + 4 * 3600),
        homecoming: true,
      },
    ]);
    game.city("c1").units[shape.defender] = 20;
    const threatened = await playTurn(b, game, "p1", { turn: 2 });
    const more = callsTo(threatened, "support");
    expect(more.length).toBe(1);
    expect(counts(more[0]!["units"])[shape.defender]).toBe(15);
    // Answered once per attack.
    game.t += 600;
    game.city("c1").units[shape.defender] = 20;
    const again = await playTurn(b, game, "p1", { turn: 3 });
    expect(callsTo(again, "support")).toEqual([]);
  });

  test("a garrison no help can reach, facing an attack twice its strength, is recalled", async () => {
    const game = gameOf(shape);
    game.t = game.rules.time.attackFrom + DAY;
    armed(shape, game, { [shape.attacker]: 10 });
    game.city("c2").stationed.push({
      owner: "p1",
      home: "c1",
      role: "hold",
      units: { [shape.attacker]: 3, [shape.founder]: 1 },
    });
    game.cities.push(colony(shape, "c20", "p2", shape.far, { [shape.attacker]: 200 }));
    spied(game, "c20", { [shape.attacker]: 200 }, {});
    game.incoming.set("p1", [
      {
        id: "m0000b",
        kind: "attack",
        from: "c20",
        by: "p2",
        foe: "p1",
        to: "c2",
        depart: pair(game.t - 3000),
        arrive: pair(game.t + 600),
      },
    ]);
    const log = await playTurn(bot(), game, "p1", { notes: committedTo(2) });
    expect(game.violations).toEqual([]);
    expect(callsTo(log, "recall_troops")).toEqual([{ stationedAt: "c2" }]);
    expect(memoryOf(game).m.some((l) => l.startsWith("gave up c2"))).toBe(true);
  });

  test("its notes keep what matters: stale flags are dropped, its victim's flags sort first", async () => {
    const game = gameOf(shape);
    game.t = game.rules.time.attackFrom + 2 * DAY;
    const t = game.t;
    const notes = encodeMemory(
      {
        s: "conqueror",
        h: null,
        f: {},
        m: [],
        x: {
          av: 2,
          ac: 1,
          // A city that is not the victim's, a failure count back to 0, a day-old attacker and
          // player out of reach, a siege no longer held, a defense floor seen two days ago.
          spc99: t - 600,
          sfc99: 2,
          sfc2: 0,
          ha4: t - 2 * DAY,
          ox3: t - 2 * DAY,
          grc2: t - 600,
          dmc2: 900,
          dtc2: t - 2 * DAY,
          // Still current: an attacker within the day.
          ha5: t - 3600,
        },
        k: [],
      },
      4000,
    );
    await playTurn(bot(), game, "p1", { notes });
    expect(game.violations).toEqual([]);
    const x = memoryOf(game).x;
    for (const gone of ["spc99", "sfc99", "sfc2", "ha4", "ox3", "grc2", "dmc2", "dtc2"]) {
      expect({ gone, value: x[gone] }).toEqual({ gone, value: undefined });
    }
    expect(x).toMatchObject({ av: 2, ac: 1, ha5: t - 3600 });
    // A notebook cut to a tiny cap drops the per-city flags first, the victim last.
    const cut = parseMemory(
      encodeMemory({ ...memoryOf(game), m: [], k: [], x: { ...x, spc2: t, sfc2: 3, dkc2: 5 } }, 90),
      "conqueror",
    );
    expect(cut.x).toMatchObject({ av: 2, ac: 1 });
    expect(cut.x["spc2"]).toBeUndefined();
  });

  test("its victim's capital falls first, before an older colony", async () => {
    const game = gameOf(shape);
    game.t = 2 * DAY;
    armed(shape, game, {
      [shape.attacker]: 80,
      [shape.defender]: 20,
      [shape.carrier]: 20,
      [shape.founder]: 2,
    });
    // The capital's id sorts after the colony's: only the rank puts it first.
    const cap = game.city("c2");
    cap.id = "c40";
    game.cities.push(colony(shape, "c20", "p2", shape.near, { [shape.defender]: 1 }));
    spied(game, "c40", { [shape.defender]: 1 }, { [game.rules.roles.population]: 1 });
    spied(game, "c20", { [shape.defender]: 1 }, { [game.rules.roles.population]: 1 });
    const log = await playTurn(bot(), game, "p1", { notes: committedTo(2) });
    expect(game.violations).toEqual([]);
    const attacks = callsTo(log, "attack");
    expect(attacks.length).toBeGreaterThan(0);
    expect(attacks.every((a) => a["to"] === "c40")).toBe(true);
  });

  test("it counts the defenders the owner's other cities on that island can walk over", async () => {
    const alone = await playTurn(bot(), weakColony(shape, false), "p1", { notes: committedTo(2) });
    expect(callsTo(alone, "attack").some((a) => a["to"] === "c20")).toBe(true);
    // Half of 400 defenders next door: 80 attackers no longer break it.
    const guarded = weakColony(shape, true);
    const log = await playTurn(bot(), guarded, "p1", { notes: committedTo(2) });
    expect(guarded.violations).toEqual([]);
    expect(callsTo(log, "attack").filter((a) => a["to"] === "c20")).toEqual([]);
  });

  test("it counts the defenders a spy report shows queued, trained before its waves land", async () => {
    const queued = (end: number): FakeGame => {
      const game = weakColony(shape, false);
      const queue = game.rules.units.find((u) => u.id === shape.defender)!.queue;
      game.intel.set("p1|c20", {
        type: "spy_report",
        at: game.t - 3600,
        data: {
          report: "r00002",
          city: "c20",
          buildings: { [game.rules.roles.population]: 1 },
          units: { home: { [shape.defender]: 2 } },
          queues: [{ queue, item: 7, unit: shape.defender, count: 400, done: 0, end }],
        },
      });
      return game;
    };
    // 400 defenders done within the minute: too strong.
    const soon = queued(weakColony(shape, false).t + 60);
    const held = await playTurn(bot(), soon, "p1", { notes: committedTo(2) });
    expect(soon.violations).toEqual([]);
    expect(callsTo(held, "attack").filter((a) => a["to"] === "c20")).toEqual([]);
    // Done in ten days: long after the waves land.
    const late = queued(weakColony(shape, false).t + 10 * DAY);
    const log = await playTurn(bot(), late, "p1", { notes: committedTo(2) });
    expect(callsTo(log, "attack").some((a) => a["to"] === "c20")).toBe(true);
  });

  test("after a strike lost, a city is taken as at least as strong as the attack it beat, for a day", async () => {
    const game = gameOf(shape);
    game.t = game.rules.time.attackFrom + DAY;
    const units = {
      [shape.attacker]: 80,
      [shape.defender]: 20,
      [shape.carrier]: 20,
      [shape.founder]: 2,
    };
    armed(shape, game, units);
    game.cities.push(colony(shape, "c20", "p2", shape.near, { [shape.defender]: 2 }));
    // The last strike there (an attack of 9000 after morale) lost an hour ago.
    game.intel.set("p1|c20", {
      type: "battle_report",
      at: game.t - 3600,
      data: { attacker: "p1", winner: "defender", city: "c20" },
    });
    const notes = encodeMemory(
      { s: "conqueror", h: null, f: {}, m: [], x: { av: 2, ac: 1, dkc20: 9000 }, k: [] },
      4000,
    );
    const b = bot();
    const first = await playTurn(b, game, "p1", { notes });
    expect(callsTo(first, "attack")).toEqual([]);
    expect(memoryOf(game).x).toMatchObject({ dmc20: 9000, dtc20: game.t - 3600 });
    // A spy report catches its army away: still not struck while the day lasts.
    game.t += 1800;
    armed(shape, game, units);
    spied(game, "c20", { [shape.defender]: 2 }, { [game.rules.roles.population]: 1 });
    const second = await playTurn(b, game, "p1", { turn: 2 });
    expect(callsTo(second, "attack")).toEqual([]);
    // A day after the lost strike, a fresh report is believed again.
    game.t += DAY;
    armed(shape, game, units);
    spied(game, "c20", { [shape.defender]: 2 }, { [game.rules.roles.population]: 1 });
    const third = await playTurn(b, game, "p1", { turn: 3 });
    expect(callsTo(third, "attack").some((a) => a["to"] === "c20")).toBe(true);
    expect(memoryOf(game).x["dmc20"]).not.toBe(9000);
  });

  test("a siege is reinforced once per siege: again when the city is besieged anew", async () => {
    const game = gameOf(shape);
    game.t = game.rules.time.attackFrom + DAY;
    armed(shape, game, { [shape.defender]: 40, [shape.carrier]: 10 });
    const hold = {
      owner: "p1" as const,
      home: "c1" as const,
      role: "hold" as const,
      units: { [shape.attacker]: 30, [shape.founder]: 1 },
    };
    game.city("c2").stationed.push(hold);
    const b = bot();
    const first = await playTurn(b, game, "p1", { notes: committedTo(2) });
    expect(callsTo(first, "support").length).toBe(1);
    expect(memoryOf(game).x["grc2"]).toBe(game.t);
    // The siege breaks: the flag goes with it.
    game.t += 3600;
    game.city("c2").stationed = [];
    game.city("c1").units[shape.defender] = 40;
    const broken = await playTurn(b, game, "p1", { turn: 2 });
    expect(callsTo(broken, "support")).toEqual([]);
    expect(memoryOf(game).x["grc2"]).toBeUndefined();
    // A new siege of the same city is reinforced again.
    game.t += 3600;
    game.city("c2").stationed.push(hold);
    const again = await playTurn(b, game, "p1", { turn: 3 });
    expect(callsTo(again, "support").length).toBe(1);
  });

  test("pacts with anyone but its victim, one alliance, nothing from its victim", async () => {
    const game = gameOf(shape);
    game.t = 5000;
    for (const [id, from, kind] of [
      ["q0000a", "p2", "pact"],
      ["q0000b", "p3", "pact"],
      ["q0000c", "p4", "alliance"],
      ["q0000d", "p5", "alliance"],
    ] as const) {
      game.proposals.push({
        id,
        from,
        to: "p1",
        kind,
        name: kind === "alliance" ? "North" : null,
        text: "join",
        expires: pair(40000),
      });
    }
    const log = await playTurn(bot(), game, "p1", { notes: committedTo(2) });
    expect(callsTo(log, "answer_proposal")).toEqual([
      { id: "q0000a", accept: false },
      { id: "q0000b", accept: true },
      { id: "q0000c", accept: true },
      { id: "q0000d", accept: false },
    ]);
  });
});

test("perfidia-1 shape: a train, whose founders' wave is timed to land a minute after the helpers", async () => {
  const shape = SHAPES[0]!;
  const game = gameOf(shape);
  game.t = game.rules.time.attackFrom + DAY;
  // A colony of p1 farther from the target than its capital: 13200 s against 11818 s.
  game.islands.push({ id: "i90", kind: "inner", x: 180, y: -300, richnessPm: 1000, slots: 1 });
  armed(shape, game, { raider: 40, settler: 2, transport: 4, guard: 10 });
  const c30 = colony(shape, "c30", "p1", "i90", { raider: 200, transport: 10 });
  c30.slot = 0;
  game.cities.push(c30);
  game.cities.push(colony(shape, "c20", "p2", shape.far, { guard: 100 }));
  spied(game, "c20", { guard: 100 }, { hall: 3, wall: 0 });
  const t0 = game.t;
  const b = bot();
  const first = await playTurn(b, game, "p1", { notes: committedTo(2) });
  expect(game.violations).toEqual([]);
  // The capital's 40 raiders cannot take the colony; the helpers from c30 leave first.
  expect(callsTo(first, "attack")).toEqual([
    { from: "c30", to: "c20", units: { raider: 200, transport: 10 } },
  ]);
  const memory = memoryOf(game);
  expect(memory.x["at"]).toBe(20);
  expect(memory.x["aw"]).toBe(t0 + 13200 + 60);
  // It wakes when the capital's waves must leave to land 60 s after the helpers, and queues
  // nothing meanwhile: a queue that empties would cost the own wake that launch needs.
  expect(first.wakeAt).toBe(t0 + 13260 - 11818);
  expect([...callsTo(first, "build"), ...callsTo(first, "recruit")]).toEqual([]);

  advance(game, first.wakeAt!);
  const second = await playTurn(b, game, "p1", { turn: 2 });
  const attacks = callsTo(second, "attack");
  expect(attacks.length).toBeGreaterThan(0);
  expect(attacks.every((a) => a["from"] === "c1" && a["to"] === "c20")).toBe(true);
  expect(attacks.some((a) => (counts(a["units"])["settler"] ?? 0) > 0)).toBe(true);
  expect(memoryOf(game).x["at"]).toBeUndefined();
});

test("perfidia-1 shape: no train leaves when the own wakes left today cannot cover its timed launch", async () => {
  const shape = SHAPES[0]!;
  const game = gameOf(shape);
  game.t = game.rules.time.attackFrom + DAY;
  game.islands.push({ id: "i90", kind: "inner", x: 180, y: -300, richnessPm: 1000, slots: 1 });
  armed(shape, game, { raider: 40, settler: 2, transport: 4, guard: 10 });
  const c30 = colony(shape, "c30", "p1", "i90", { raider: 200, transport: 10 });
  c30.slot = 0;
  game.cities.push(c30);
  game.cities.push(colony(shape, "c20", "p2", shape.far, { guard: 100 }));
  spied(game, "c20", { guard: 100 }, { hall: 3, wall: 0 });
  // A recruit batch ends before the launch (its queue empties: one own wake), one own wake left.
  game.city("c1").recruit["barracks"] = [
    { item: 1, unit: "guard", count: 5, start: game.t - 600, end: game.t + 900 },
  ];
  game.budget.ownWakesLeft = 2;
  const log = await playTurn(bot(), game, "p1", { notes: committedTo(2) });
  expect(game.violations).toEqual([]);
  expect(callsTo(log, "attack")).toEqual([]);
  expect(log.thoughts.join(" ")).toContain("c20: train waits for own wakes");
  expect(memoryOf(game).x["at"]).toBeUndefined();
});
