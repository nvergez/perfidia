// rusher@3 (docs/architecture.md §11.2): rusher@2's protection-end rush, played by a seat that
// grows, garrisons and keeps its own wakes for the whole day. Fixture turns on rules shaped like
// perfidia-1 and sandbox-1 check its decisions (the opening, founding after the first wave,
// garrisons, siege support, reliefs, raids worth their trip, queues that empty on its wakes, tidy
// notes); campaigns against the fake game check the opening end to end and determinism. The
// real-match behaviour is checked in `sim` (rush3.test.ts).

import { describe, expect, test } from "bun:test";
import {
  CityIdSchema,
  type AgentRules,
  type CityId,
  type IslandId,
  type PlayerId,
  type SeatAgent,
  z,
} from "@perfidia/protocol";
import {
  advance,
  callsTo,
  capital,
  counts,
  perfidiaGame,
  playTurn,
  res,
  sandboxGame,
  str,
  strs,
  type FakeGame,
  type FCity,
} from "./fixtures.test.ts";
import { encodeMemory, emptyMemory, parseMemory } from "./memory.ts";
import { botLabel, botVersions, createBot, createBotVersion } from "./registry.ts";
import { streamOf } from "./rng.ts";
import { rusher3, rusher3Params } from "./strategies/rusher3.ts";

const DAY = 86400;

/** The game of `make` with the config numbers the combat hints point at (`hints.ts`). */
function configured(game: FakeGame, config: Record<string, unknown>): FakeGame {
  Object.assign(game.info.config, structuredClone(config));
  return game;
}

/** perfidia-1's default battle numbers (§8.2, §8.5, §8.7). */
const PERFIDIA_COMBAT = {
  economy: { baseDefense: { a: 0, b: 20, c: 50 }, lootProtectPerLevel: 100 },
  combat: { wallPmPerLevel: 50, moralePmPerCity: 100, moraleFloorPm: 700 },
};

/** sandbox-1's default base defense (§3.8): 10 per keep level. */
const SANDBOX_COMBAT = { combat: { keepDefense: 10 } };

interface Shape {
  readonly name: string;
  game(): FakeGame;
  readonly defender: string;
  readonly attacker: string;
  readonly founder: string;
  readonly carrier: string;
  /** Levels where every unit of the fixture can be recruited. */
  readonly developed: Record<string, number>;
}

const SHAPES: Shape[] = [
  {
    name: "perfidia-1 shape",
    game: () => configured(perfidiaGame(6), PERFIDIA_COMBAT),
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
  },
  {
    name: "sandbox-1 shape",
    game: () => configured(sandboxGame(6), SANDBOX_COMBAT),
    defender: "spearman",
    attacker: "axeman",
    founder: "colonist",
    carrier: "boat",
    developed: { keep: 3, sawmill: 3, pit: 3, forge: 3, depot: 3, camp: 2, docks: 1 },
  },
];

const SEED = 11;

function bot(seat: PlayerId = "p1", seed = SEED): SeatAgent {
  return createBotVersion("rusher", 3, { seat, seed, strict: true });
}

const prm = rusher3Params(streamOf(SEED, "p1", "rusher", "params"));

/** A notebook of rusher@3 holding `flags`. */
function notesWith(flags: Record<string, number>): string {
  return encodeMemory({ ...emptyMemory("rusher"), x: flags }, 4000);
}

/** A city of `owner` on `island`, not a capital (a colony). */
function colonyOf(
  shape: Shape,
  id: CityId,
  owner: PlayerId,
  island: IslandId,
  slot: number,
  units: Record<string, number>,
): FCity {
  const c = capital(id, owner, island, { ...shape.developed }, res(300, 300, 300), units);
  c.slot = slot;
  c.capitalOf = null;
  return c;
}

/** Spy intel of p1 about `city`, `age` seconds old: `units` at home, and `data` besides. */
function spied(
  game: FakeGame,
  city: string,
  units: Record<string, number>,
  age = 600,
  data: Record<string, unknown> = {},
): void {
  game.intel.set(`p1|${city}`, {
    type: "spy_report",
    at: game.t - age,
    data: { report: "r00001", city, units: { home: units }, ...structuredClone(data) },
  });
}

/**
 * p1 with a developed capital and an army at home, just after its first wave is due (protection's
 * end, or midday when protection ends sooner, as in the sandbox-1 fixture), or at `t`.
 */
function armed(shape: Shape, attackers = 40, t?: number): FakeGame {
  const game = shape.game();
  game.t = t ?? Math.max(game.rules.time.attackFrom, DAY / 2) + 600;
  const c1 = game.city("c1");
  c1.levels = { ...shape.developed };
  c1.stock = res(900, 900, 900);
  c1.units = { [shape.carrier]: 4, [shape.defender]: 10 };
  if (attackers > 0) c1.units[shape.attacker] = attackers;
  return game;
}

/** p2's colony on the island next to c1 (the nearest stranger city). */
function nearColony(shape: Shape, game: FakeGame, defenders: number): FCity {
  const near = game.islands.find((i) => i.kind !== "home" && i.kind !== "crown")!;
  const c = colonyOf(shape, "c21", "p2", near.id, 0, { [shape.defender]: defenders });
  game.cities.push(c);
  return c;
}

/** The buildings that unlock `unit`: its recruit building, its requirements, theirs, and so on. */
function unlockClosure(rules: AgentRules, unit: string): Set<string> {
  const row = rules.units.find((u) => u.id === unit)!;
  const queue = rules.queues.recruit.find((q) => q.id === row.queue)!;
  const out = new Set<string>();
  const visit = (b: string): void => {
    if (out.has(b)) return;
    out.add(b);
    for (const req of Object.keys(rules.buildings.find((x) => x.id === b)?.requires ?? {})) {
      visit(req);
    }
  };
  for (const b of [queue.building, ...Object.keys(row.requires)]) visit(b);
  return out;
}

interface Act {
  readonly t: number;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** Plays rusher@3 for p1 from the game's time until `until`, at its own self-wakes; every call, timed. */
async function campaign(game: FakeGame, until: number, seed = SEED): Promise<Act[]> {
  const b = bot("p1", seed);
  const acts: Act[] = [];
  let turn = 0;
  while (game.t < until) {
    turn += 1;
    const t = game.t;
    // oxlint-disable-next-line no-await-in-loop -- each turn starts from the state the last one left
    const log = await playTurn(b, game, "p1", { turn });
    expect(game.violations).toEqual([]);
    expect(log.endedBy).toBe("end_turn");
    for (const tool of ["build", "recruit", "spy", "attack", "found_city", "support"] as const) {
      for (const args of callsTo(log, tool)) acts.push({ t, tool, args });
    }
    acts.push({ t, tool: "end_turn", args: { wakeAt: log.wakeAt } });
    advance(game, log.wakeAt ?? t + 3600);
  }
  return acts;
}

/** The units ordered in a turn. */
function ordered(log: Awaited<ReturnType<typeof playTurn>>): number {
  return callsTo(log, "recruit")
    .flatMap((r) => z.array(z.object({ unit: z.string(), count: z.int() })).parse(r["orders"]))
    .reduce((n, o) => n + o.count, 0);
}

test("rusher@3 is the latest rusher, registered beside the frozen rusher@1 and rusher@2", () => {
  expect(botLabel("rusher")).toBe("bot:rusher@3");
  expect(botVersions("rusher")).toEqual([1, 2, 3]);
  expect(rusher3.version).toBe(3);
  expect(createBot("rusher", { seat: "p1", seed: 1 }).label).toBe("bot:rusher@3");
  for (const v of [1, 2]) {
    expect(createBotVersion("rusher", v, { seat: "p1", seed: 1 }).label).toBe(`bot:rusher@${v}`);
  }
});

test("rusher@3 parameters: rusher@2's margins, two or three cities by day 2, five to seven", () => {
  for (let seed = 0; seed < 200; seed += 1) {
    const p = rusher3Params(streamOf(seed, "p1", "rusher", "params"));
    expect(p.raidPm).toBeGreaterThanOrEqual(1200);
    expect(p.conquerPm).toBeGreaterThanOrEqual(1750);
    expect(p.minAttackers).toBeGreaterThanOrEqual(8);
    expect([2, 3]).toContain(p.earlyCities);
    expect(p.maxCities).toBeGreaterThanOrEqual(5);
    expect(p.maxCities).toBeLessThanOrEqual(7);
    expect(p.garrisonPm).toBeGreaterThan(1000);
  }
});

describe.each(SHAPES)("$name", (shape) => {
  test("rusher@3 opens as rusher@2: the attackers' producers and unlock, nothing else", async () => {
    const game = shape.game();
    const log = await playTurn(bot(), game, "p1");
    expect(game.violations).toEqual([]);
    const rules = game.rules;
    const atk = rules.units.find((u) => u.id === shape.attacker)!;
    const total = atk.cost.wood + atk.cost.stone + atk.cost.gold;
    const producers = (["wood", "stone", "gold"] as const)
      .filter((r) => atk.cost[r] * 3 >= total)
      .map((r) => rules.roles.producers[r]);
    const allowed = new Set([
      ...producers,
      ...unlockClosure(rules, shape.attacker),
      ...unlockClosure(rules, shape.carrier),
    ]);
    const built = callsTo(log, "build").flatMap((c) => strs(c["buildings"]));
    expect(built.length).toBeGreaterThan(0);
    for (const b of built) expect(allowed.has(b)).toBe(true);
    for (const tool of ["recruit", "attack", "spy", "found_city"] as const) {
      expect(callsTo(log, tool)).toEqual([]);
    }
    expect(log.wakeAt ?? Infinity).toBeLessThanOrEqual(rules.time.attackFrom);
  });

  test("rusher@3 spies before protection ends, then launches on a city it spied", async () => {
    const game = shape.game();
    game.city("c2").units = { [shape.defender]: 1 };
    const from = game.rules.time.attackFrom;
    const acts = await campaign(game, from + DAY);
    const attacks = acts.filter((a) => a.tool === "attack");
    const spies = acts.filter((a) => a.tool === "spy");
    expect(acts.filter((a) => a.tool === "attack" && a.t < from)).toEqual([]);
    expect(spies.filter((s) => s.t < from).length).toBeLessThanOrEqual(prm.preSpies);
    expect(attacks.length).toBeGreaterThan(0);
    const first = attacks[0]!;
    expect(spies.some((s) => s.args["to"] === first.args["to"] && s.t < first.t)).toBe(true);
    const units = counts(first.args["units"]);
    expect(units[shape.attacker] ?? 0).toBeGreaterThanOrEqual(prm.minAttackers);
    const target = game.city(CityIdSchema.parse(first.args["to"]));
    expect(target.island).not.toBe(game.city("c1").island);
    expect(units[shape.carrier] ?? 0).toBeGreaterThan(0);
    // Every opening turn asked to be awake by the time its first wave is due.
    const due = Math.max(from, DAY / 2);
    for (const a of acts.filter((x) => x.tool === "end_turn" && x.t < due)) {
      expect(Number(a.args["wakeAt"])).toBeLessThanOrEqual(due);
    }
    if (shape.name.startsWith("perfidia")) {
      expect(spies.filter((s) => s.t < from).length).toBeGreaterThan(0);
      expect(first.t).toBeGreaterThanOrEqual(from);
      expect(first.t).toBeLessThanOrEqual(from + 900);
    }
  }, 60_000);

  test("rusher@3 founds a city once its first wave has left, and keeps its founder before", async () => {
    const before = armed(shape);
    before.city("c1").units[shape.founder] = 1;
    const kept = await playTurn(bot(), before, "p1");
    expect(before.violations).toEqual([]);
    expect(callsTo(kept, "found_city")).toEqual([]);

    const after = armed(shape);
    after.city("c1").units[shape.founder] = 1;
    const fs = after.t - 600;
    const log = await playTurn(bot(), after, "p1", { notes: notesWith({ fs }) });
    expect(after.violations).toEqual([]);
    const founds = callsTo(log, "found_city");
    expect(founds.length).toBe(1);
    expect(counts(founds[0]!["units"])[shape.founder]).toBe(1);
  });

  test("rusher@3 recruits a founder in its capital while cities are wanted", async () => {
    const game = armed(shape, 0);
    game.city("c1").stock = res(5000, 5000, 5000);
    const log = await playTurn(bot(), game, "p1", { notes: notesWith({ fs: game.t - 600 }) });
    expect(game.violations).toEqual([]);
    const orders = callsTo(log, "recruit").flatMap((r) => JSON.stringify(r["orders"]));
    expect(orders.join(";")).toContain(`"unit":"${shape.founder}"`);
  });

  test("rusher@3 sends defenders from its capital to a colony that has none", async () => {
    const game = armed(shape, 10, 2 * DAY + 3600);
    const c1 = game.city("c1");
    c1.units[shape.defender] = 60;
    const mine = colonyOf(shape, "c20", "p1", c1.island, 1, {});
    game.cities.push(mine);
    const log = await playTurn(bot(), game, "p1");
    expect(game.violations).toEqual([]);
    const supports = callsTo(log, "support").filter((s) => s["to"] === "c20");
    expect(supports.length).toBe(1);
    expect(counts(supports[0]!["units"])[shape.defender] ?? 0).toBeGreaterThanOrEqual(3);
  });

  /** An armed seat whose army holds a siege of the nearest colony, with defenders at home. */
  const holding = (): FakeGame => {
    const game = armed(shape, 10);
    game.city("c1").units[shape.defender] = 60;
    const c21 = nearColony(shape, game, 0);
    c21.stationed.push({
      owner: "p1",
      home: "c1",
      role: "hold",
      units: { [shape.attacker]: 12, [shape.founder]: 1 },
    });
    return game;
  };

  test("rusher@3 sends defenders once to a siege it holds", async () => {
    const game = holding();
    const log = await playTurn(bot(), game, "p1");
    expect(game.violations).toEqual([]);
    expect(callsTo(log, "support").map((s) => s["to"])).toContain("c21");
    const again = holding();
    const second = await playTurn(bot(), again, "p1", {
      notes: notesWith({ grc21: again.t - 3600 }),
    });
    expect(callsTo(second, "support").filter((s) => s["to"] === "c21")).toEqual([]);
  });

  test("rusher@3 relieves its besieged colony when its army beats the garrison seen there", async () => {
    // Only a ruleset with sieges marks a besieged city (`blockedExt`, hints): perfidia-1.
    if (!shape.name.startsWith("perfidia")) return;
    const make = (garrison: number): FakeGame => {
      const game = armed(shape, 40);
      const c1 = game.city("c1");
      const mine = colonyOf(shape, "c20", "p1", c1.island, 1, {});
      mine.ext = { siege: { by: "p2" } };
      mine.stationed.push({
        owner: "p2",
        home: "c2",
        role: "hold",
        units: { [shape.attacker]: garrison, [shape.founder]: 1 },
      });
      game.cities.push(mine);
      return game;
    };
    const weak = make(5);
    const log = await playTurn(bot(), weak, "p1");
    expect(weak.violations).toEqual([]);
    expect(callsTo(log, "attack").map((a) => a["to"])).toContain("c20");
    const strong = make(400);
    const held = await playTurn(bot(), strong, "p1");
    expect(callsTo(held, "attack").filter((a) => a["to"] === "c20")).toEqual([]);
  });

  test("rusher@3 raids on spy reports only, and a city without defenders only for its loot", async () => {
    // A battle report of its own win says nothing of what came since: it spies first.
    const blind = armed(shape);
    blind.intel.set("p1|c2", {
      type: "battle_report",
      at: blind.t - 600,
      data: { attacker: "p1", winner: "attacker", city: "c2" },
    });
    const first = await playTurn(bot(), blind, "p1", { notes: notesWith({ bc2: 70, uc2: 0 }) });
    expect(callsTo(first, "attack").filter((a) => a["to"] === "c2")).toEqual([]);
    expect(callsTo(first, "spy").map((s) => s["to"])).toContain("c2");

    // A colony with no defenders and nothing above its storage's protection: no raid.
    const bare = armed(shape);
    nearColony(shape, bare, 0);
    const level = shape.developed[bare.rules.roles.storage] ?? 1;
    const poor = shape.name.startsWith("perfidia") ? 100 * level : 0;
    spied(bare, "c21", {}, 600, {
      stock: { wood: poor, stone: poor, gold: poor },
      buildings: { ...shape.developed },
    });
    const empty = await playTurn(bot(), bare, "p1");
    expect(callsTo(empty, "attack").filter((a) => a["to"] === "c21")).toEqual([]);

    // The same colony with a full store is worth the trip.
    const rich = armed(shape);
    nearColony(shape, rich, 0);
    spied(rich, "c21", {}, 600, {
      stock: { wood: 2000, stone: 2000, gold: 2000 },
      buildings: { ...shape.developed },
    });
    const raid = await playTurn(bot(), rich, "p1");
    expect(callsTo(raid, "attack").map((a) => a["to"])).toContain("c21");
  });

  /**
   * Day 4 at 06:00 with `wakesLeft` own wakes, a garrison that lacks nothing, stock for a short
   * batch only (fewer attackers than a wake is worth), no army big enough to want more cities.
   */
  const pacing = (wakesLeft: number): FakeGame => {
    const game = armed(shape, 2, 3 * DAY + 6 * 3600);
    game.budget.ownWakesLeft = wakesLeft;
    const c1 = game.city("c1");
    c1.units[shape.defender] = 60;
    c1.stock = shape.name.startsWith("perfidia") ? res(600, 600, 600) : res(350, 350, 350);
    // A full build queue: the stock is the army's.
    const room = game.rules.queues.build.max;
    c1.build = Array.from({ length: room }, (_, i) => ({
      item: i + 1,
      building: game.rules.roles.storage,
      level: 6 + i,
      start: game.t,
      end: game.t + DAY + i,
    }));
    c1.itemSeq = room;
    return game;
  };

  test("rusher@3 starts no idle queue that would empty off its wakes ahead of the day's pace", async () => {
    // Eight own wakes used by 06:00, ahead of an even spread of twelve: no batch.
    const ahead = pacing(4);
    const idle = await playTurn(bot(), ahead, "p1");
    expect(ahead.violations).toEqual([]);
    expect(ordered(idle)).toBe(0);
    // Two used: the same batch goes in.
    const log = await playTurn(bot(), pacing(10), "p1");
    expect(ordered(log)).toBeGreaterThan(0);
  });

  test("rusher@3 asks to be awake a minute after its army comes home", async () => {
    const game = armed(shape, 2);
    const back = game.t + 5000;
    game.moves.push({
      id: "m00abc",
      kind: "return",
      owner: "p1",
      from: "c1",
      to: "c1",
      island: game.city("c1").island,
      units: { [shape.attacker]: 30 },
      depart: game.t - 5000,
      arrive: back,
      recallableUntil: null,
    });
    const log = await playTurn(bot(), game, "p1");
    expect(log.wakeAt ?? Infinity).toBeLessThanOrEqual(back + 60);
  });

  test("rusher@3 forgets intel flags older than two days", async () => {
    const game = armed(shape, 40, 4 * DAY);
    const old = game.t - 3 * DAY;
    const notes = notesWith({ sc5: old, gc5: 400, lc6: old, ac7: old, bc7: 90, uc7: 20 });
    const log = await playTurn(bot(), game, "p1", { notes });
    const writes = callsTo(log, "write_note");
    expect(writes.length).toBe(1);
    const memory = parseMemory(str(writes[0]!["text"]), "rusher");
    for (const flag of ["sc5", "gc5", "lc6", "ac7", "bc7", "uc7"]) {
      expect(memory.x[flag]).toBeUndefined();
    }
  });
});

/** A rusher@3 campaign on the perfidia-shaped fake until a day after protection ends, as text. */
async function campaignText(seed: number): Promise<string> {
  const game = configured(perfidiaGame(6), PERFIDIA_COMBAT);
  game.city("c2").units = { guard: 1 };
  return JSON.stringify(await campaign(game, game.rules.time.attackFrom + DAY, seed));
}

test("rusher@3 ships a colony's surplus to its capital only as far as the capital can store it", async () => {
  const shape = SHAPES[0]!;
  const shipped = async (stock: number): Promise<Record<string, unknown>[]> => {
    const game = armed(shape, 0, 2 * DAY + 3600);
    const c1 = game.city("c1");
    // A full build queue and no free pop: the capital spends nothing this turn.
    c1.units = { raider: 400 };
    c1.build = [1, 2, 3, 4, 5].map((item) => ({
      item,
      building: "lumber",
      level: 4 + item,
      start: game.t - 600,
      end: game.t + item * 3600,
    }));
    c1.itemSeq = 5;
    c1.stock = res(stock, stock, stock);
    // A colony on the backyard island (4800 s away) with a surplus well above half its store.
    game.cities.push(
      colonyOf(shape, "c22", "p1", "i3", 0, { [shape.defender]: 10, [shape.carrier]: 2 }),
    );
    game.city("c22").stock = res(3500, 3500, 3500);
    const log = await playTurn(bot(), game, "p1");
    expect(game.violations).toEqual([]);
    return callsTo(log, "send_resources");
  };
  // Room for about 2500 of each in the capital (3560 a resource): the surplus goes, within it.
  const roomy = await shipped(1000);
  expect(roomy.map((s) => [s["from"], s["to"]])).toEqual([["c22", "c1"]]);
  for (const r of ["wood", "stone", "gold"] as const) {
    expect(Number(roomy[0]![r] ?? 0)).toBeLessThanOrEqual(3560 - 1000);
  }
  // A capital whose store is nearly full would lose the cargo: none is sent.
  expect(await shipped(3500)).toEqual([]);
});

test("rusher@3 campaigns are deterministic: the same seed plays the same calls", async () => {
  const first = await campaignText(SEED);
  expect(await campaignText(SEED)).toBe(first);
  expect(await campaignText(SEED + 1)).not.toBe(first);
}, 60_000);
