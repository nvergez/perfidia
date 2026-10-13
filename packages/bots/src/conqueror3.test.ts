// Fixture behaviours of conqueror@3 (docs/architecture.md §11.2) on rules shaped like perfidia-1: a
// preview next to conqueror@2 (the default stays @2), its garrison sent as supports landing with the
// founders' wave, strikes kept short and on fresh intel, no siege its owner's known army would
// relieve, sieges held against a relief or given up when no help can match it, and the war calls
// (`war.ts`): a strike call to an ally before a capital is struck, its waves at the timed wake, a
// call-off cancelled to the ally, an ally's call answered and joined at its launch, calls from
// anyone but an ally ignored. Its play on real matches is tested in `sim` (`conqueror3.test.ts`).

import { describe, expect, test } from "bun:test";
import type {
  Briefing,
  CityId,
  IslandId,
  JsonObject,
  PlayerId,
  RoundInput,
  SeatAgent,
} from "@perfidia/protocol";
import {
  advance,
  callsTo,
  capital,
  counts,
  perfidiaGame,
  playTurn,
  res,
  type FakeGame,
  type FCity,
  type TurnLog,
} from "./fixtures.test.ts";
import { fmtTime } from "./kit.ts";
import { encodeMemory, parseMemory, type Memory } from "./memory.ts";
import { botLabel, botLabels, createBotVersion } from "./registry.ts";

const DAY = 86400;
const pair = (t: number): [number, string] => [t, fmtTime(t)];

/** Levels where every unit of the perfidia-1 fixture can be recruited. */
const DEVELOPED = {
  hall: 5,
  lumber: 4,
  quarry: 4,
  mine: 4,
  warehouse: 5,
  barracks: 3,
  harbor: 3,
  wall: 1,
};
/** The config numbers the perfidia-1 hints point at. */
const CONFIG: JsonObject = {
  time: { capitalImmunityEnd: 2 * DAY },
  economy: { baseDefense: { a: 0, b: 20, c: 50 } },
  combat: { wallPmPerLevel: 50, moralePmPerCity: 100, moraleFloorPm: 700 },
};
/** Islands of the fixture: p1's frontier and inner island, p2's home and backyard. */
const FRONTIER: IslandId = "i4";
const INNER: IslandId = "i5";
const P2_HOME: IslandId = "i6";
const FAR: IslandId = "i7";

function bot(seed = 11, version = 3): SeatAgent {
  return createBotVersion("conqueror", version, { seat: "p1", seed, strict: true });
}

function game(): FakeGame {
  const g = perfidiaGame(6);
  Object.assign(g.info.config, structuredClone(CONFIG));
  return g;
}

function memoryOf(g: FakeGame): Memory {
  return parseMemory(g.notes.get("p1") ?? "", "conqueror");
}

/** Notes of a conqueror with the flags `x`. */
function notesWith(x: Record<string, number>): string {
  return encodeMemory({ s: "conqueror", h: null, f: {}, m: [], x, k: [] }, 4000);
}

/** The notes of a conqueror whose victim is `victim`, chosen 10 minutes ago. */
function victimNotes(g: FakeGame, victim: number): string {
  return notesWith({ av: victim, ac: 1, vt: g.t - 600 });
}

/** A city of `owner` on `island` (slot `slot`), not a capital. */
function colony(
  id: CityId,
  owner: PlayerId,
  island: IslandId,
  slot: number,
  units: Record<string, number>,
): FCity {
  const c = capital(id, owner, island, DEVELOPED, res(300, 300, 300), units);
  c.slot = slot;
  c.capitalOf = null;
  return c;
}

/** A spy report of p1 on `city`, `ago` seconds old: `units` at home, and the levels it saw. */
function spied(
  g: FakeGame,
  city: CityId,
  units: Record<string, number>,
  buildings: Record<string, number> = { hall: 1 },
  ago = 3600,
): void {
  g.intel.set(`p1|${city}`, {
    type: "spy_report",
    at: g.t - ago,
    data: { report: "r00001", city, buildings, units: { home: units } },
  });
}

/** p1's capital with an army, founders and the carriers for all of it. */
function armed(g: FakeGame, units: Record<string, number>): void {
  const c1 = g.city("c1");
  c1.levels = { ...DEVELOPED };
  c1.stock = res(5000, 5000, 5000);
  c1.units = { ...units };
}

const ARMY = { raider: 80, guard: 20, transport: 20, settler: 2 };

/** Every island full: no free slot, so founders have nowhere to found a city. */
function noFreeSlots(g: FakeGame): void {
  for (const [i, isl] of g.islands.entries()) {
    const n = g.cities.filter((c) => c.island === isl.id).length;
    g.islands[i] = { ...isl, slots: n };
  }
}

/** Capitals of `seats` spied with a garrison no army of the fixture breaks. */
function fortified(g: FakeGame, seats: readonly number[]): void {
  for (const n of seats) spied(g, `c${n}`, { guard: 2000 }, { hall: 10, wall: 10 });
}

/** `agent` with its briefings patched (messages), as the gateway would show them. */
function briefed(agent: SeatAgent, patch: (b: Briefing) => Briefing): SeatAgent {
  return {
    label: agent.label,
    round: (input: RoundInput) => agent.round({ ...input, briefing: patch(input.briefing) }),
  };
}

/** p1 and `q` allied. */
function allied(g: FakeGame, q: PlayerId): void {
  g.relations.set("p1", [{ player: q, kind: "ally", until: null }]);
  g.relations.set(q, [{ player: "p1", kind: "ally", until: null }]);
  g.alliance.set("p1", "a1");
  g.alliance.set(q, "a1");
}

const founders = (a: Record<string, unknown>): number => counts(a["units"])["settler"] ?? 0;

const warMessages = (log: TurnLog): string[] =>
  callsTo(log, "send_message")
    .map((m) => String(m["text"]))
    .filter((t) => t.includes("WAR#"));

type Msg = Briefing["msgs"][number];

function message(
  from: PlayerId,
  to: PlayerId[] | "all",
  text: string,
  id: Msg["id"] = "g0000a",
): Msg {
  return { id, from, to, text };
}

/** Day 1, two hours into the attacks: p2's colony on p1's frontier, 2 guards, spied. */
function earlyColony(): FakeGame {
  const g = game();
  g.t = g.rules.time.attackFrom + 2 * 3600;
  armed(g, ARMY);
  g.cities.push(colony("c20", "p2", FRONTIER, 0, { guard: 2 }));
  spied(g, "c20", { guard: 2 });
  noFreeSlots(g);
  return g;
}

/** Day 3: p2's colony on its backyard (20 guards), 11818 s from p1's capital (a 150-raider army). */
function farColony(): FakeGame {
  const g = game();
  g.t = 2 * DAY + 3600;
  armed(g, { ...ARMY, raider: 150, transport: 30 });
  g.cities.push(colony("c20", "p2", FAR, 0, { guard: 20 }));
  spied(g, "c20", { guard: 20 });
  spied(g, "c2", { guard: 400 });
  noFreeSlots(g);
  return g;
}

/** Day 3: p3's colony on p1's frontier (30 guards, which 200 raiders break), spied 5 h ago. */
function staleColony(): FakeGame {
  const g = game();
  g.t = 2 * DAY + 3600;
  armed(g, { ...ARMY, raider: 200, transport: 30 });
  g.cities.push(colony("c20", "p3", FRONTIER, 0, { guard: 30 }));
  spied(g, "c20", { guard: 30 }, { hall: 1 }, 5 * 3600);
  fortified(g, [2, 3, 4, 5, 6]);
  noFreeSlots(g);
  return g;
}

/**
 * Day 3: p3's colony c20 on p1's frontier (30 guards, which 200 raiders break) and its colony c21 on
 * p1's inner island, spied with `raiders` (the relief it could send, with p3's capital's).
 */
function reliefGame(raiders: number): FakeGame {
  const g = game();
  g.t = 2 * DAY + 3600;
  armed(g, { raider: 200, guard: 200, transport: 40, settler: 2 });
  g.cities.push(colony("c20", "p3", FRONTIER, 0, { guard: 30 }));
  g.cities.push(colony("c21", "p3", INNER, 0, { raider: raiders, guard: 400 }));
  spied(g, "c20", { guard: 30 });
  spied(g, "c21", { raider: raiders, guard: 400 }, { hall: 5, wall: 5 });
  // p3's capital, more than 2.5 h away, is no target; its army counts in a relief.
  spied(g, "c3", { guard: 20 }, { hall: 10, wall: 10 });
  fortified(g, [2, 4, 5, 6]);
  noFreeSlots(g);
  return g;
}

/**
 * Day 3: p1 holds a siege of p3's colony c20 (a founder, 30 raiders, 20 guards); an attack from
 * p3's colony c21, spied with `raiders`, lands in 3 h. p1's capital has 100 guards.
 */
function siegeGame(raiders: number): FakeGame {
  const g = game();
  g.t = 2 * DAY + 3600;
  armed(g, { guard: 100, transport: 20 });
  g.cities.push(colony("c20", "p3", FRONTIER, 0, {}));
  g.cities.push(colony("c21", "p3", INNER, 0, { raider: raiders }));
  g.city("c20").stationed.push({
    owner: "p1",
    home: "c1",
    role: "hold",
    units: { raider: 30, guard: 20, settler: 1 },
  });
  spied(g, "c21", { raider: raiders }, { hall: 5 });
  g.incoming.set("p1", [
    {
      id: "m0000a",
      kind: "attack",
      from: "c21",
      by: "p3",
      foe: "p1",
      to: "c20",
      depart: pair(g.t - 600),
      arrive: pair(g.t + 3 * 3600),
    },
  ]);
  return g;
}

/**
 * Day 3: p1's colony c30 on p2's home island with an army and founders; p2's capital c2 spied with
 * 40 guards; p1 allied to p6, whose colony c31 is on p2's backyard.
 */
function jointGame(): FakeGame {
  const g = game();
  g.t = 2 * DAY + 3600;
  armed(g, { guard: 20, transport: 4 });
  g.cities.push(
    colony("c30", "p1", P2_HOME, 1, { raider: 300, guard: 120, settler: 2, transport: 4 }),
  );
  g.cities.push(colony("c31", "p6", FAR, 0, { raider: 100 }));
  spied(g, "c2", { guard: 40 }, { hall: 3, wall: 1 });
  fortified(g, [3, 4, 5]);
  allied(g, "p6");
  noFreeSlots(g);
  return g;
}

/** Day 3: p1 (100 raiders) allied to p6; p3's colony c20 on p1's frontier, too strong for p1 alone. */
function callGame(): FakeGame {
  const g = game();
  g.t = 2 * DAY + 3600;
  armed(g, { raider: 100, guard: 40, transport: 20 });
  g.cities.push(colony("c20", "p3", FRONTIER, 0, { guard: 300 }));
  spied(g, "c20", { guard: 300 });
  fortified(g, [2, 3, 4, 5, 6]);
  allied(g, "p6");
  return g;
}

/** A strike call on c20 whose window opens 4 h after `t` (on a 5-minute mark) and lasts 30 min. */
function strikeCall(t: number): { text: string; t0: number } {
  const t0 = Math.ceil((t + 4 * 3600) / 300) * 300;
  return { text: `WAR#k1 strike c20 vs p3 land ${fmtTime(t0)}-${fmtTime(t0 + 1800)}`, t0 };
}

/** The calls of conqueror@3 (seed 5) on the first turn of `jointGame`. */
async function jointCalls(): Promise<string> {
  const g = jointGame();
  const log = await playTurn(bot(5), g, "p1", { notes: victimNotes(g, 2) });
  return JSON.stringify(log.calls);
}

describe("conqueror@3 (perfidia-1 shape)", () => {
  test("a preview: registered next to conqueror@2 and @1, the default stays conqueror@2", () => {
    expect(botLabel("conqueror")).toBe("bot:conqueror@2");
    expect(botLabels()).toContain("bot:conqueror@3");
    expect(bot().label).toBe("bot:conqueror@3");
    expect(bot(11, 2).label).toBe("bot:conqueror@2");
  });

  test("its garrison follows the founders' wave as supports landing in the same second", async () => {
    const g = earlyColony();
    const log = await playTurn(bot(), g, "p1");
    expect(g.violations).toEqual([]);
    const attacks = callsTo(log, "attack");
    expect(attacks.length).toBeGreaterThan(0);
    expect(attacks.every((a) => a["to"] === "c20")).toBe(true);
    expect(founders(attacks[0]!)).toBe(2);
    const supports = callsTo(log, "support").filter((s) => s["to"] === "c20");
    expect(supports.length).toBe(1);
    expect(counts(supports[0]!["units"])["guard"]).toBeGreaterThan(0);
    const lead = g.moves.find((m) => m.kind === "attack" && (m.units["settler"] ?? 0) > 0);
    const garrison = g.moves.find((m) => m.kind === "support" && m.to === "c20");
    expect(garrison?.arrive).toBe(lead?.arrive);
    expect(log.thoughts.join(" ")).toContain("c20: garrison D");
    // conqueror@2 sends its guards as one more attack.
    const old = earlyColony();
    const log2 = await playTurn(bot(11, 2), old, "p1");
    expect(callsTo(log2, "support")).toEqual([]);
    expect(callsTo(log2, "attack").length).toBeGreaterThanOrEqual(2);
  });

  test("a city more than 2.5 h away is not struck (conqueror@2 strikes it)", async () => {
    const g = farColony();
    const log = await playTurn(bot(), g, "p1");
    expect(g.violations).toEqual([]);
    expect(callsTo(log, "attack")).toEqual([]);
    const old = farColony();
    const log2 = await playTurn(bot(11, 2), old, "p1");
    expect(callsTo(log2, "attack").some((a) => a["to"] === "c20" && founders(a) > 0)).toBe(true);
  });

  test("a strike on a report older than `fresh` waits for the spy it sends (conqueror@2 strikes)", async () => {
    const g = staleColony();
    const log = await playTurn(bot(), g, "p1");
    expect(g.violations).toEqual([]);
    expect(callsTo(log, "attack")).toEqual([]);
    expect(callsTo(log, "spy").some((s) => s["to"] === "c20")).toBe(true);
    expect(log.thoughts.join(" ")).toContain("waiting for intel");
    const old = staleColony();
    const log2 = await playTurn(bot(11, 2), old, "p1");
    expect(callsTo(log2, "attack").some((a) => a["to"] === "c20")).toBe(true);
  });

  test("no siege its owner's known army would relieve: the founders stay home", async () => {
    const g = reliefGame(3000);
    const log = await playTurn(bot(), g, "p1", { notes: victimNotes(g, 3) });
    expect(g.violations).toEqual([]);
    expect(callsTo(log, "attack")).toEqual([]);
    expect(log.thoughts.join(" ")).toMatch(/c20 D\d+: would not hold/);
    // A relief its garrison holds: the strike leaves.
    const weak = reliefGame(10);
    const struck = await playTurn(bot(), weak, "p1", { notes: victimNotes(weak, 3) });
    expect(weak.violations).toEqual([]);
    expect(callsTo(struck, "attack").some((a) => a["to"] === "c20" && founders(a) > 0)).toBe(true);
  });

  describe("a siege it holds", () => {
    test("a relief on its way is met with defenders from the cities whose support lands first", async () => {
      const g = siegeGame(100);
      const log = await playTurn(bot(), g, "p1", { notes: victimNotes(g, 3) });
      expect(g.violations).toEqual([]);
      const support = callsTo(log, "support").filter((s) => s["to"] === "c20");
      expect(support.length).toBe(1);
      expect(support[0]).toMatchObject({ from: "c1" });
      expect(counts(support[0]!["units"])["guard"]).toBeGreaterThan(0);
      expect(callsTo(log, "recall_troops")).toEqual([]);
      expect(log.thoughts.join(" ")).toContain("c20: relief due");
    });

    test("a relief stronger than every helper can match: the garrison is called home", async () => {
      const g = siegeGame(5000);
      const log = await playTurn(bot(), g, "p1", { notes: victimNotes(g, 3) });
      expect(g.violations).toEqual([]);
      expect(callsTo(log, "recall_troops")).toEqual([{ stationedAt: "c20" }]);
      expect(memoryOf(g).m.some((l) => l.startsWith("gave up c20"))).toBe(true);
    });
  });

  describe("war calls", () => {
    test("a capital is struck with its allies: a strike call first, its waves at the timed wake", async () => {
      const g = jointGame();
      const b = bot();
      const log = await playTurn(b, g, "p1", { notes: victimNotes(g, 2) });
      expect(g.violations).toEqual([]);
      expect(callsTo(log, "attack")).toEqual([]);
      const calls = warMessages(log);
      expect(calls.length).toBe(1);
      expect(calls[0]).toMatch(
        /^WAR#k1 strike c2 vs p2 land D3 \d\d:\d\d-\d\d:\d\d \(I land \d\d:\d\d\)$/,
      );
      const sent = callsTo(log, "send_message").find((m) => m["text"] === calls[0]);
      expect(sent?.["to"]).toEqual(["p6"]);
      const x = memoryOf(g).x;
      expect(x).toMatchObject({ at: 2, aj: 1, wq: 1 });
      const lands = x["aw"] ?? 0;
      // Its own waves leave so as to land just after the window, from the colony 1 h away.
      advance(g, lands - 3600);
      spied(g, "c2", { guard: 40 }, { hall: 3, wall: 1 }, 600);
      const go = await playTurn(b, g, "p1", { turn: 2 });
      expect(g.violations).toEqual([]);
      const attacks = callsTo(go, "attack");
      expect(attacks.length).toBeGreaterThan(0);
      expect(attacks.every((a) => a["from"] === "c30" && a["to"] === "c2")).toBe(true);
      expect(attacks.some((a) => founders(a) > 0)).toBe(true);
      const waves = g.moves.filter((m) => m.kind === "attack");
      expect(waves.every((m) => m.arrive === lands)).toBe(true);
      expect(memoryOf(g).x["at"]).toBeUndefined();
    });

    test("a joint strike called off on a fresher report is cancelled to the allies", async () => {
      const g = jointGame();
      const b = bot();
      await playTurn(b, g, "p1", { notes: victimNotes(g, 2) });
      const lands = memoryOf(g).x["aw"] ?? 0;
      advance(g, lands - 3600);
      spied(g, "c2", { guard: 400 }, { hall: 3, wall: 1 }, 600);
      const log = await playTurn(b, g, "p1", { turn: 2 });
      expect(g.violations).toEqual([]);
      expect(callsTo(log, "attack")).toEqual([]);
      const cancel = warMessages(log);
      expect(cancel.length).toBe(1);
      expect(cancel[0]).toMatch(/^WAR#k1 cancel: /);
      const m = memoryOf(g);
      expect(m.x["at"]).toBeUndefined();
      expect(m.x["jx"]).toBe(g.t);
      expect(m.m.some((l) => l.startsWith("joint c2 called off"))).toBe(true);
    });

    test("an ally's strike call is answered yes with its landing, and joined at its launch", async () => {
      const g = callGame();
      const { text, t0 } = strikeCall(g.t);
      const b = bot();
      const first = await playTurn(
        briefed(b, (br) => ({ ...br, msgs: [message("p6", ["p1"], text)] })),
        g,
        "p1",
      );
      expect(g.violations).toEqual([]);
      const yes = warMessages(first);
      expect(yes.length).toBe(1);
      expect(yes[0]).toMatch(/^WAR#k1 yes, landing D3 \d\d:\d\d$/);
      expect(callsTo(first, "attack")).toEqual([]);
      const line = memoryOf(g).m.find((l) => l.startsWith("wc p6 k1 s c20"));
      const launch = Number(line?.split(" ").at(-1));
      expect(launch).toBeGreaterThan(g.t);
      // Later turns keep the launch's wake.
      advance(g, first.wakeAt!);
      expect(g.t).toBeLessThan(launch);
      const between = await playTurn(b, g, "p1", { turn: 2 });
      expect(callsTo(between, "attack")).toEqual([]);
      expect(between.wakeAt).toBe(launch);
      advance(g, launch);
      const go = await playTurn(b, g, "p1", { turn: 3 });
      expect(g.violations).toEqual([]);
      const attacks = callsTo(go, "attack").filter((a) => a["to"] === "c20");
      expect(attacks.length).toBe(1);
      expect(counts(attacks[0]!["units"])["raider"]).toBeGreaterThanOrEqual(15);
      expect(founders(attacks[0]!)).toBe(0);
      const sent = g.moves.find((m) => m.kind === "attack" && m.to === "c20");
      expect(sent?.arrive).toBeGreaterThanOrEqual(t0);
      expect(sent?.arrive).toBeLessThanOrEqual(t0 + 1800);
    });

    test("calls from a non-ally, or sent in public, are not answered", async () => {
      const g = callGame();
      const { text } = strikeCall(g.t);
      const log = await playTurn(
        briefed(bot(), (br) => ({
          ...br,
          msgs: [message("p5", ["p1"], text), message("p6", "all", text, "g0000b")],
        })),
        g,
        "p1",
      );
      expect(g.violations).toEqual([]);
      expect(warMessages(log)).toEqual([]);
      expect(callsTo(log, "attack")).toEqual([]);
      expect(memoryOf(g).m.some((l) => l.startsWith("wc "))).toBe(false);
    });

    test("a call on a city it does not know is answered no; garbled ones are dropped", async () => {
      const g = callGame();
      const t0 = Math.ceil((g.t + 4 * 3600) / 300) * 300;
      const msgs = [
        message("p6", ["p1"], `WAR#k1 strike c99 land ${fmtTime(t0)}-${fmtTime(t0 + 1800)}`),
        message("p6", ["p1"], "WAR#k2 strike c20 land D3 25:00-26:00", "g0000b"),
        message("p6", ["p1"], "WAR#k3 raze everything {now}", "g0000c"),
      ];
      const log = await playTurn(
        briefed(bot(), (br) => ({ ...br, msgs })),
        g,
        "p1",
      );
      expect(g.violations).toEqual([]);
      expect(warMessages(log)).toEqual(["WAR#k1 no: unknown city"]);
    });
  });

  test("notes it cannot parse are read as empty memory and rewritten", async () => {
    const g = game();
    g.t = 3600;
    const log = await playTurn(bot(), g, "p1", {
      notes: "wc p6 k1 s c20 x y z\nWar plan: p3 first. {broken",
    });
    const notes = callsTo(log, "write_note");
    expect(notes.length).toBe(1);
    expect(notes[0]).toMatchObject({ mode: "replace" });
    expect(parseMemory(String(notes[0]!["text"]), "conqueror").s).toBe("conqueror");
  });

  test("the same seed and briefing give the same calls", async () => {
    expect(await jointCalls()).toBe(await jointCalls());
  });
});
