// rusher@2 (docs/architecture.md §11.2): the protection-end rush of perfidia-1 §15.1–§15.2, on
// rules shaped like perfidia-1 and like sandbox-1. Fixture turns check its decisions (opening
// builds, the first wave, conquest or raid, margins with support, cooldowns, its wakes); campaigns
// against the fake game check the opening end to end. The real-match behaviour (first launch and
// first battle times, determinism) is checked in `sim` (rush.test.ts).

import { describe, expect, test } from "bun:test";
import {
  CityIdSchema,
  type AgentRules,
  type CityId,
  type IslandId,
  type PlayerId,
  type SeatAgent,
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
  strs,
  type FakeGame,
  type FCity,
} from "./fixtures.test.ts";
import { encodeMemory, emptyMemory } from "./memory.ts";
import { botLabel, createBot, createBotVersion } from "./registry.ts";
import { streamOf } from "./rng.ts";
import { rusher2, rusher2Params } from "./strategies/rusher2.ts";

const DAY = 86400;

/** The game of `make` with the config numbers the combat hints point at (`hints.ts`). */
function configured(game: FakeGame, config: Record<string, unknown>): FakeGame {
  Object.assign(game.info.config, structuredClone(config));
  return game;
}

/** perfidia-1's default battle numbers (§8.2, §8.5): base defense 20·hall + 50, wall, morale. */
const PERFIDIA_COMBAT = {
  economy: { baseDefense: { a: 0, b: 20, c: 50 } },
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
  return createBotVersion("rusher", 2, { seat, seed, strict: true });
}

const prm = rusher2Params(streamOf(SEED, "p1", "rusher", "params"));

/** A notebook of rusher@2 holding `flags`. */
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

/** Spy intel of p1 about `city`, `age` seconds old: `units` at home, no stock or buildings shown. */
function spied(game: FakeGame, city: string, units: Record<string, number>, age = 600): void {
  game.intel.set(`p1|${city}`, {
    type: "spy_report",
    at: game.t - age,
    data: { report: "r00001", city, units: { home: units } },
  });
}

/** p1 with a developed capital and an army at home, just after protection ends (or at `t`). */
function armed(shape: Shape, attackers = 40, t?: number): FakeGame {
  const game = shape.game();
  game.t = t ?? game.rules.time.attackFrom + 600;
  const c1 = game.city("c1");
  c1.levels = { ...shape.developed };
  c1.stock = res(900, 900, 900);
  c1.units = { [shape.attacker]: attackers, [shape.carrier]: 4, [shape.defender]: 10 };
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

/** Plays rusher@2 for p1 from the game's time until `until`, at its own self-wakes; every call, timed. */
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
    for (const tool of ["build", "recruit", "spy", "attack"] as const) {
      for (const args of callsTo(log, tool)) acts.push({ t, tool, args });
    }
    acts.push({ t, tool: "end_turn", args: { wakeAt: log.wakeAt } });
    advance(game, log.wakeAt ?? t + 3600);
  }
  return acts;
}

test("rusher@2 is the latest rusher, registered beside the frozen rusher@1", () => {
  expect(botLabel("rusher")).toBe("bot:rusher@2");
  expect(rusher2.version).toBe(2);
  expect(createBot("rusher", { seat: "p1", seed: 1 }).label).toBe("bot:rusher@2");
  expect(createBotVersion("rusher", 1, { seat: "p1", seed: 1 }).label).toBe("bot:rusher@1");
});

test("rusher@2 margins: raids at 1.2x or more, conquests above the 1.41x a lone founder needs", () => {
  for (let seed = 0; seed < 200; seed += 1) {
    const p = rusher2Params(streamOf(seed, "p1", "rusher", "params"));
    expect(p.raidPm).toBeGreaterThanOrEqual(1200);
    expect(p.conquerPm).toBeGreaterThanOrEqual(1750);
    expect(p.minAttackers).toBeGreaterThanOrEqual(8);
    expect(p.preSpies).toBe(2);
  }
});

describe.each(SHAPES)("$name", (shape) => {
  test("rusher@2 opens with the attackers' producers and unlock, nothing else", async () => {
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
    for (const p of producers) expect(built).toContain(p);
    expect(built).not.toContain(rules.roles.storage);
    for (const tool of ["recruit", "attack", "spy"] as const)
      expect(callsTo(log, tool)).toEqual([]);
    expect(log.wakeAt ?? Infinity).toBeLessThanOrEqual(rules.time.attackFrom);
  });

  test("rusher@2 spies before protection ends, then launches on a city it spied", async () => {
    const game = shape.game();
    // p2's capital is the weak neighbour.
    game.city("c2").units = { [shape.defender]: 1 };
    const from = game.rules.time.attackFrom;
    const acts = await campaign(game, from + DAY);
    const attacks = acts.filter((a) => a.tool === "attack");
    const spies = acts.filter((a) => a.tool === "spy");
    expect(acts.filter((a) => a.tool === "attack" && a.t < from)).toEqual([]);
    // At most two spies before protection ends.
    expect(spies.filter((s) => s.t < from).length).toBeLessThanOrEqual(prm.preSpies);
    expect(attacks.length).toBeGreaterThan(0);
    const first = attacks[0]!;
    // On a city it spied, with its whole army and the carriers that lift it across water.
    expect(spies.some((s) => s.args["to"] === first.args["to"] && s.t < first.t)).toBe(true);
    const units = counts(first.args["units"]);
    expect(units[shape.attacker] ?? 0).toBeGreaterThanOrEqual(prm.minAttackers);
    const target = game.city(CityIdSchema.parse(first.args["to"]));
    expect(target.island).not.toBe(game.city("c1").island);
    expect(units[shape.carrier] ?? 0).toBeGreaterThan(0);
    // Every opening turn asked to be awake by protection end.
    for (const a of acts.filter((x) => x.tool === "end_turn" && x.t < from)) {
      expect(Number(a.args["wakeAt"])).toBeLessThanOrEqual(from);
    }
    if (shape.name.startsWith("perfidia")) {
      // perfidia-1 §15.1: twelve hours are enough for the opening; the spy report is in at
      // protection end and the first wave leaves at once.
      expect(spies.filter((s) => s.t < from).length).toBeGreaterThan(0);
      expect(first.t).toBeGreaterThanOrEqual(from);
      expect(first.t).toBeLessThanOrEqual(from + 900);
    }
  }, 60_000);

  test("rusher@2 brings one founder to a weak colony on a fresh spy report", async () => {
    const game = armed(shape);
    game.city("c1").units[shape.founder] = 1;
    nearColony(shape, game, 1);
    spied(game, "c21", { [shape.defender]: 1 });
    const log = await playTurn(bot(), game, "p1");
    expect(game.violations).toEqual([]);
    const attacks = callsTo(log, "attack");
    expect(attacks.map((a) => a["to"])).toEqual(["c21"]);
    expect(counts(attacks[0]!["units"])[shape.founder]).toBe(1);
  });

  test("rusher@2 risks no founder on a battle report: it spies the colony first", async () => {
    const game = armed(shape);
    game.city("c1").units[shape.founder] = 1;
    nearColony(shape, game, 1);
    game.intel.set("p1|c21", {
      type: "battle_report",
      at: game.t - 600,
      data: { attacker: "p1", winner: "attacker", city: "c21" },
    });
    const log = await playTurn(bot(), game, "p1", {
      notes: notesWith({ bc21: 50, uc21: 0 }),
    });
    expect(game.violations).toEqual([]);
    for (const a of callsTo(log, "attack")) {
      expect(counts(a["units"])[shape.founder] ?? 0).toBe(0);
    }
    expect(callsTo(log, "spy").map((s) => s["to"])).toContain("c21");
  });

  test("rusher@2 raids the weakest target and holds back from a strong one", async () => {
    const weak = armed(shape);
    spied(weak, "c2", { [shape.defender]: 2 });
    const log = await playTurn(bot(), weak, "p1");
    expect(callsTo(log, "attack").map((a) => a["to"])).toEqual(["c2"]);

    const strong = armed(shape);
    // 40 attackers against 60 defenders: far below any margin.
    spied(strong, "c2", { [shape.defender]: 60 });
    const held = await playTurn(bot(), strong, "p1");
    expect(callsTo(held, "attack").filter((a) => a["to"] === "c2")).toEqual([]);
  });

  test("rusher@2 counts the support the owner's capital can walk over to its colony", async () => {
    const game = armed(shape, 20);
    // p2's colony on p2's home island, next to its capital.
    const c2 = game.city("c2");
    const colony = colonyOf(shape, "c21", "p2", c2.island, 1, { [shape.defender]: 1 });
    game.cities.push(colony);
    spied(game, "c21", { [shape.defender]: 1 });
    spied(game, "c2", { [shape.defender]: 2 });
    const alone = await playTurn(bot(), game, "p1");
    expect(callsTo(alone, "attack").map((a) => a["to"])).toContain("c21");

    const guarded = armed(shape, 20);
    guarded.cities.push(colonyOf(shape, "c21", "p2", c2.island, 1, { [shape.defender]: 1 }));
    spied(guarded, "c21", { [shape.defender]: 1 });
    // Half of 60 defenders can walk over: 20 attackers are not enough any more.
    spied(guarded, "c2", { [shape.defender]: 60 });
    const log = await playTurn(bot(), guarded, "p1");
    expect(callsTo(log, "attack").filter((a) => a["to"] === "c21")).toEqual([]);
  });

  test("rusher@2 leaves a city alone after it beat an attack, and after a failed spy", async () => {
    const lost = armed(shape);
    lost.intel.set("p1|c2", {
      type: "battle_report",
      at: lost.t - 3600,
      data: { attacker: "p1", winner: "defender", city: "c2" },
    });
    const afterLoss = await playTurn(bot(), lost, "p1");
    expect(callsTo(afterLoss, "attack").filter((a) => a["to"] === "c2")).toEqual([]);
    expect(callsTo(afterLoss, "spy").filter((s) => s["to"] === "c2")).toEqual([]);
    expect(afterLoss.calls.some((c) => c.tool === "write_note")).toBe(true);

    const failed = armed(shape);
    // A spy left an hour ago and landed without a report.
    const notes = notesWith({ sc2: failed.t - 3600, gc2: 200 });
    const afterFail = await playTurn(bot(), failed, "p1", { notes });
    expect(callsTo(afterFail, "spy").filter((s) => s["to"] === "c2")).toEqual([]);
    expect(callsTo(afterFail, "attack").filter((a) => a["to"] === "c2")).toEqual([]);
  });

  test("rusher@2 spies at most six cities a game day", async () => {
    const game = armed(shape);
    const day = Math.floor(game.t / DAY) + 1;
    const capped = await playTurn(bot(), game, "p1", { notes: notesWith({ sd: day, sn: 6 }) });
    expect(callsTo(capped, "spy")).toEqual([]);
    const fresh = await playTurn(bot(), armed(shape), "p1", {
      notes: notesWith({ sd: day, sn: 5 }),
    });
    expect(callsTo(fresh, "spy").length).toBe(1);
  });

  test("rusher@2 asks to be awake when its army comes home", async () => {
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
    expect(log.wakeAt ?? Infinity).toBeLessThanOrEqual(back);
  });
});

/** A rusher@2 campaign on the perfidia-shaped fake until a day after protection ends, as text. */
async function campaignText(seed: number): Promise<string> {
  const game = configured(perfidiaGame(6), PERFIDIA_COMBAT);
  game.city("c2").units = { guard: 1 };
  return JSON.stringify(await campaign(game, game.rules.time.attackFrom + DAY, seed));
}

test("rusher@2 campaigns are deterministic: the same seed plays the same calls", async () => {
  const first = await campaignText(SEED);
  expect(await campaignText(SEED)).toBe(first);
  // The seed draws the parameters: another seed plays another campaign.
  expect(await campaignText(SEED + 1)).not.toBe(first);
}, 60_000);
