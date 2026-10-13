// The first integration (docs/architecture.md §15 T14, §13.4, §13.7): the four real bots play
// 1-game-day matches of both rulesets through the gateway, under lockstep and under real time with
// `VirtualTime`; every log passes Level E, lockstep and virtual-time runs are byte-identical when
// repeated, a hand-off re-simulates at Level G, matches interleaved in one process match the same
// matches run alone (P17), P4 holds through the tools, the extra tools replay, every snapshot
// matches its checkpoint, and the memory sink writes the same bytes as the harness file writer.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { createMatch, getRuleset, verifyLog, type AnyRuleset } from "@perfidia/engine";
import type { ReadCtx } from "@perfidia/engine/contracts";
import { randInt, streamRng, type Rng } from "@perfidia/engine/core";
import { domain } from "@perfidia/engine/domain";
import type { Match } from "@perfidia/engine/kernel";
import { sortedIds, unitsAtHome } from "@perfidia/engine/std";
import { addCity, addStationed, fixtureRuleset, matchFromState } from "@perfidia/engine/testing";
import {
  ChaosAgent,
  MatchHost,
  MemorySink,
  createLockstepDriver,
  teeSink,
} from "@perfidia/gateway";
import type {
  City,
  CityId,
  IslandId,
  LogLine,
  PlayerId,
  RoundInput,
  RoundOutput,
  SeatAgent,
  ToolCall,
  ToolResult,
} from "@perfidia/protocol";
import {
  JsonlFileSink,
  jsonlText,
  normalisedHash,
  normalisedText,
  prepareBotRun,
  readLog,
  resimulate,
  runBots,
  runPrepared,
  setupFor,
  writeJsonl,
  type BotRun,
  type BotRunSpec,
  type ClockChoice,
} from "./harness/index.ts";

const RULESETS = ["perfidia-1@1.0.0", "sandbox-1@1.0.0"] as const;
const LOCKSTEP: ClockChoice = { kind: "lockstep" };
const VIRTUAL: ClockChoice = { kind: "virtual" };

/** A 1-game-day match of the default bots, six seats. */
function day(ruleset: string, clock: ClockChoice, seed = 4): BotRunSpec {
  return { ruleset, seed, players: 6, days: 1, clock, strict: true };
}

/** Level E through the registry: zero divergence. */
function levelE(
  lines: readonly LogLine[],
  resolve?: (ref: string) => AnyRuleset | undefined,
): void {
  const report = resolve === undefined ? verifyLog(lines) : verifyLog(lines, resolve);
  expect(report.divergence).toBeUndefined();
  expect(report.ok).toBe(true);
}

function kinds(lines: readonly LogLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) out[l.k] = (out[l.k] ?? 0) + 1;
  return out;
}

/** The run ended without a fatal line, at the match end or by a victory. */
function endedCleanly(r: BotRun): void {
  expect(r.lines.some((l) => l.k === "fatal")).toBe(false);
  expect(r.lines.at(-1)).toMatchObject({ k: "end", result: { endedAt: r.run.result.endedAt } });
  expect(r.run.result.endedAt).toBeLessThanOrEqual(86400);
}

/** Every act line is followed by the ev lines of the events it emitted, at its own time (§10.2). */
function actsBeforeTheirEvents(lines: readonly LogLine[]): number {
  let followed = 0;
  for (const [i, line] of lines.entries()) {
    if (line.k !== "act" || !line.r.ok) continue;
    const next = lines[i + 1];
    if (next?.k === "ev" && next.t === line.t) followed += 1;
  }
  return followed;
}

/** Three matches for the coexistence test: two of perfidia-1 and one of sandbox-1. */
const specs = (clock: ClockChoice): BotRunSpec[] => [
  day("perfidia-1", clock, 21),
  day("sandbox-1", clock, 22),
  day("perfidia-1", clock, 23),
];

/** Bots on four seats and chaos agents on two, step invariants, strict. */
async function mixed(ref: string, seed: number, clock: ClockChoice): Promise<BotRun> {
  const prepared = prepareBotRun({ ...day(ref, clock, seed), invariants: "step" });
  const agents = new Map<PlayerId, SeatAgent>(prepared.options.agents);
  for (const seat of ["p3", "p6"] as const) {
    agents.set(seat, new ChaosAgent({ seat, seed: seed * 31 + seat.length }));
  }
  const sink = new MemorySink();
  const run = await runPrepared({ ...prepared, options: { ...prepared.options, agents } }, sink);
  return { run, sink, lines: sink.parsed() };
}

/** A bot that renames its first city in its first round. */
function renaming(bot: SeatAgent): SeatAgent {
  return {
    label: "test:renamer",
    async round(input: RoundInput) {
      const out = await bot.round(input);
      const city = input.briefing.cities[0]?.id;
      if (input.turn !== 1 || input.round !== 0 || city === undefined) return out;
      return {
        ...out,
        calls: [{ tool: "rename_city", args: { city, name: "Hill Fort" } }, ...out.calls],
      };
    },
  };
}

describe("1-game-day matches of the default bots", () => {
  for (const ref of RULESETS) {
    test(`${ref}, lockstep: no fatal, Level E, and a second run is byte-identical`, async () => {
      const first = await runBots(day(ref, LOCKSTEP));
      const second = await runBots(day(ref, LOCKSTEP));
      endedCleanly(first);
      levelE(first.lines);
      expect(second.sink.text()).toBe(first.sink.text());
      expect(second.sink.snapshots).toEqual(first.sink.snapshots);
      const k = kinds(first.lines);
      expect(k["header"]).toBe(1);
      expect(k["batch"]).toBeGreaterThan(0);
      expect(k["act"]).toBeGreaterThan(50);
      expect(k["obs"]).toBeGreaterThan(50);
      expect(k["note"]).toBeGreaterThan(0);
      expect(k["ckpt"]).toBe(23);
      // Act lines come before their ev lines (Level E checks the order of every one).
      expect(actsBeforeTheirEvents(first.lines)).toBeGreaterThan(0);
      // The bots use the five strategies at their latest version, cycled over the seats.
      const header = first.lines[0];
      expect(header?.k === "header" && Object.values(header.controllers)).toEqual([
        "bot:expander@2",
        "bot:rusher@2",
        "bot:turtle@2",
        "bot:opportunist@2",
        "bot:conqueror@1",
        "bot:expander@2",
      ]);
      expect(first.run.stats.turns).toBe(k["wake"] ?? -1);
    }, 30000);

    test(`${ref}, real time under VirtualTime: no fatal, Level E, Level G, reproducible`, async () => {
      const first = await runBots(day(ref, VIRTUAL));
      endedCleanly(first);
      levelE(first.lines);
      const header = first.lines[0];
      expect(header).toMatchObject({
        k: "header",
        clock: { kind: "realtime", speed: [3, 1], time: "virtual", latencyMs: [2000, 60000] },
      });
      const again = await resimulate(first.lines);
      expect(normalisedText(again.lines)).toBe(normalisedText(first.lines));
      // Seats overlap in real time: some turn opens while another is in flight.
      let open = 0;
      let overlap = false;
      for (const l of first.lines) {
        if (l.k === "wake") {
          open += 1;
          if (open > 1) overlap = true;
        } else if (l.k === "turn") open -= 1;
      }
      expect(overlap).toBe(true);
    }, 30000);
  }

  test("lockstep Level G re-simulates the bots byte for byte", async () => {
    const first = await runBots(day("sandbox-1", LOCKSTEP, 8));
    const again = await resimulate(first.lines);
    expect(normalisedHash(again.lines)).toBe(normalisedHash(first.lines));
  }, 30000);

  test("the per-second cap writes defer lines when it binds (bots on the fixture ruleset, cap 1)", async () => {
    const out = await runBots({
      ruleset: fixtureRuleset,
      seed: 1,
      players: 4,
      days: 1,
      clock: { kind: "lockstep", maxTurnsPerSecond: 1 },
      bots: ["rusher", "rusher", "turtle", "opportunist"],
      strict: true,
    });
    const defers = out.lines.filter((l) => l.k === "defer");
    expect(defers.length).toBeGreaterThan(0);
    for (const d of defers) if (d.k === "defer") expect(d.to).toBe(d.t + 1);
    levelE(out.lines, (ref) => (ref === fixtureRuleset.ref ? fixtureRuleset : undefined));
    const wakes = out.run.stats.wakes;
    const deferred = Object.values(wakes).flatMap((days) => days.map((x) => x.deferred));
    expect(deferred.reduce((a, b) => a + b, 0)).toBe(defers.length);
  }, 30000);
});

describe("hand-offs", () => {
  test("p2 handed to another bot at t = 43200: a controller line, Level E and Level G", async () => {
    const out = await runBots({
      ...day("perfidia-1", LOCKSTEP, 6),
      handoffs: [{ seat: "p2", at: 43200, strategy: "turtle" }],
    });
    endedCleanly(out);
    const controllers = out.lines.filter((l) => l.k === "controller");
    expect(controllers).toHaveLength(1);
    const [line] = controllers;
    expect(line).toMatchObject({ k: "controller", seat: "p2", label: "bot:turtle@2" });
    expect(line?.t).toBeGreaterThanOrEqual(43200);
    const next = out.lines[out.lines.findIndex((l) => l.k === "controller") + 1];
    expect(next).toMatchObject({ k: "wake", seat: "p2", t: line?.t });
    levelE(out.lines);
    const again = await resimulate(out.lines);
    expect(normalisedText(again.lines)).toBe(normalisedText(out.lines));
  }, 30000);
});

describe("coexistence (P17)", () => {
  for (const clock of [LOCKSTEP, VIRTUAL]) {
    test(`three matches interleaved in one process equal each run alone (${clock.kind})`, async () => {
      const together = await Promise.all(specs(clock).map((s) => runBots(s)));
      for (const [i, spec] of specs(clock).entries()) {
        // oxlint-disable-next-line no-await-in-loop -- the reference runs are alone, one at a time
        const alone = await runBots(spec);
        expect(normalisedHash(together[i]?.lines ?? [])).toBe(normalisedHash(alone.lines));
      }
      expect(normalisedHash(together[0]?.lines ?? [])).not.toBe(
        normalisedHash(together[2]?.lines ?? []),
      );
    }, 60000);
  }
});

// P4 intents through the tools ---------------------------------------------------------------------

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What the intents reached, across the seeded runs of one ruleset. */
interface Reach {
  /** Accepted calls by tool. */
  accepted: Record<string, number>;
  /** `recall_troops {stationedAt}` calls at a city holding the seat's groups from several homes. */
  multi: { tried: number; accepted: number; withHome: number; withUnits: number };
  /** The ruleset recalls stationed units in part (`movement.recall.stationed`). */
  partial: boolean;
  /** Codes of failed results or batch items worded by the generic fallback (no explainer). */
  generic: string[];
}

/** The hint of a code without an explainer of its own, and of an explainer that threw (§7.3). */
const GENERIC_HINT = "The rules tool explains the rules behind this code.";

/** The codes of `r` (or of its batch items) that only the generic text explains. */
function genericCodes(r: ToolResult): string[] {
  if (!r.ok) return r.hint === GENERIC_HINT ? [r.code] : [];
  const items = r.data["items"];
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) =>
    item !== null &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    item["hint"] === GENERIC_HINT
      ? [typeof item["code"] === "string" ? item["code"] : "?"]
      : [],
  );
}

/**
 * A world of `ruleset` where recalls meet several stationed groups: the real start, plus a second
 * city of p1 on a free slot, a support group of p1 from each of its two cities stationed in p2's
 * capital, and a support group of p3 in p1's capital (to dismiss). Pacts and alliances are left to
 * the intents, so the ruleset's own records of relations stay consistent.
 */
function richStart(ruleset: AnyRuleset, seed: number): Match {
  const setup = setupFor(ruleset, { seed, players: 6, overrides: { "time.matchEnd": 43200 } });
  const base = createMatch(setup, ruleset);
  const state = base.snapshot(0).state;
  const rules = base.rules;
  const capital = (p: PlayerId): City => {
    const c = Object.values(state.cities).find((x) => x.capitalOf === p);
    if (c === undefined) throw new Error(`no capital for ${p}`);
    return c;
  };
  const freeSlot = (): { island: IslandId; slot: number } => {
    for (const island of sortedIds(state.islands)) {
      const taken = new Set(
        Object.values(state.cities)
          .filter((c) => c.island === island)
          .map((c) => c.slot),
      );
      const slots = state.islands[island]?.slots ?? 0;
      const slot = Array.from({ length: slots }, (_, i) => i).find((i) => !taken.has(i));
      if (slot !== undefined) return { island, slot };
    }
    throw new Error("no free slot");
  };
  // p1 and p4 each get a second city and station a group from each of their cities next door.
  for (const [owner, host] of [
    ["p1", "p2"],
    ["p4", "p5"],
  ] as const) {
    const home = capital(owner);
    const unit = Object.keys(home.units).toSorted(byText)[0] ?? rules.units[0]?.id ?? "x";
    const second = addCity(state, rules, {
      owner,
      ...freeSlot(),
      buildings: { ...home.buildings },
      stock: 300,
      units: { [unit]: 6 },
    });
    const at = capital(host).id;
    addStationed(state, at, { owner, home: home.id, role: "support", units: { [unit]: 4 } });
    addStationed(state, at, { owner, home: second.id, role: "support", units: { [unit]: 4 } });
  }
  const p3 = capital("p3");
  const unit = Object.keys(p3.units).toSorted(byText)[0] ?? rules.units[0]?.id ?? "x";
  addStationed(state, capital("p1").id, {
    owner: "p3",
    home: p3.id,
    role: "support",
    units: { [unit]: 2 },
  });
  return matchFromState(state, ruleset, { setup, domain, invariants: "step" });
}

const pickOf = <T>(rng: Rng, list: readonly T[]): T | undefined =>
  list.length === 0 ? undefined : list[randInt(rng, 0, list.length - 1)];

const percent = (rng: Rng, p: number): boolean => randInt(rng, 0, 99) < p;

/**
 * P4's intents as tool calls (§13.2): each turn, one round of one to six intents resolved against
 * the current state, so most are valid, plus junk, then `end_turn` with a random wake (the time
 * advances). Pacts lead to alliance proposals between the same partners, and recalls go first to
 * the city holding the seat's groups from the most homes, whole, by home, or by home and units.
 * The next round tallies what the multi-group recalls did.
 */
class IntentAgent implements SeatAgent {
  readonly label = "test:intents";
  private readonly rng: Rng;
  /** The calls of the round in progress, and which of them are multi-group recalls. */
  private calls: ToolCall[] = [];
  private multi: { index: number; home: boolean; units: boolean }[] = [];

  constructor(
    private readonly seat: PlayerId,
    seed: number,
    private readonly match: Match,
    private readonly reach: Reach,
  ) {
    this.rng = streamRng(seed, `intents:${seat}`);
  }

  round(input: RoundInput): Promise<RoundOutput> {
    if (input.round > 0) {
      for (const [i, r] of input.results.entries()) {
        const tool = this.calls[i]?.tool ?? "";
        if (r.ok) this.reach.accepted[tool] = (this.reach.accepted[tool] ?? 0) + 1;
        this.reach.generic.push(...genericCodes(r));
      }
      for (const m of this.multi) {
        if (input.results[m.index]?.ok !== true) continue;
        this.reach.multi.accepted += 1;
        if (m.home) this.reach.multi.withHome += 1;
        if (m.units) this.reach.multi.withUnits += 1;
      }
      this.multi = [];
      const nextWakeIn = randInt(this.rng, 1800, 7200);
      return Promise.resolve({ calls: [{ tool: "end_turn", args: { nextWakeIn } }] });
    }
    const r = this.match.read();
    this.multi = [];
    this.calls = Array.from({ length: randInt(this.rng, 1, 6) }, (_, i) => this.intent(r, i));
    return Promise.resolve({ calls: this.calls });
  }

  private intent(r: ReadCtx, index: number): ToolCall {
    const rng = this.rng;
    const s = r.state;
    const seat = this.seat;
    const players = sortedIds(s.players).filter((p) => s.players[p]?.alive === true);
    const others = players.filter((p) => p !== seat);
    const cities = sortedIds(s.cities);
    const own = cities.filter((c) => s.cities[c]?.owner === seat);
    const from = pickOf(rng, own) ?? "c999";
    const foreign = cities.filter((c) => s.cities[c]?.owner !== seat);
    const to = pickOf(rng, foreign) ?? "c999";
    const other = pickOf(rng, others) ?? "p9";
    const group = (city: CityId): Record<string, number> => {
      const home = s.cities[city] === undefined ? {} : unitsAtHome(r, city);
      const out: Record<string, number> = {};
      for (const [u, n] of Object.entries(home)) {
        const take = Math.ceil((n * randInt(rng, 1, 3)) / 4);
        if (take > 0 && u !== r.rules.roles.settler) out[u] = take;
      }
      return out;
    };
    const weights = [
      ["build", 2],
      ["recruit", 2],
      ["cancel_queue", 1],
      ["send_resources", 1],
      ["attack", 1],
      ["support", 2],
      ["spy", 1],
      ["recall", 4],
      ["dismiss", 1],
      ["found_city", 1],
      ["send_message", 1],
      ["propose", 4],
      ["answer", 4],
      ["leave", 1],
      ["read", 2],
      ["extra", 1],
      ["junk", 2],
    ] as const;
    let roll = randInt(rng, 0, weights.reduce((a, [, w]) => a + w, 0) - 1);
    const kind = weights.find(([, w]) => (roll -= w) < 0)?.[0] ?? "junk";
    switch (kind) {
      case "build": {
        const building = pickOf(rng, r.rules.buildings)?.id ?? "nothing";
        return { tool: "build", args: { city: from, buildings: [building] } };
      }
      case "recruit": {
        const unit = pickOf(rng, r.rules.units)?.id ?? "nothing";
        const count = percent(rng, 30) ? "max" : randInt(rng, 1, 5);
        return { tool: "recruit", args: { city: from, orders: [{ unit, count }] } };
      }
      case "cancel_queue": {
        const c = s.cities[from];
        const items = c === undefined ? [] : [...c.build, ...Object.values(c.recruit).flat()];
        const item = pickOf(rng, items)?.id ?? randInt(rng, 1, 9);
        return { tool: "cancel_queue", args: { city: from, item } };
      }
      case "send_resources":
        return {
          tool: "send_resources",
          args: { from, to: pickOf(rng, cities) ?? to, wood: randInt(rng, 0, 60) },
        };
      case "attack":
      case "support":
        return { tool: kind, args: { from, to, units: group(from) } };
      case "spy":
        return { tool: "spy", args: { from, to, gold: randInt(rng, 10, 90) } };
      case "recall": {
        const moving = sortedIds(s.movements).filter((m) => s.movements[m]?.owner === seat);
        const holding = cities
          .map((c) => {
            const groups = s.cities[c]?.stationed.filter((g) => g.owner === seat) ?? [];
            return { c, groups, homes: [...new Set(groups.map((g) => g.home))].toSorted(byText) };
          })
          .filter((x) => x.groups.length > 0)
          .toSorted((a, b) => b.homes.length - a.homes.length);
        if (holding.length === 0 || (moving.length > 0 && percent(rng, 25))) {
          return { tool: "recall_troops", args: { movement: pickOf(rng, moving) ?? "m00000" } };
        }
        const at = (percent(rng, 70) ? holding[0] : pickOf(rng, holding)) ?? holding[0];
        if (at === undefined) return { tool: "recall_troops", args: { stationedAt: to } };
        // Mostly partial recalls (by home and units), which leave the groups in place for more:
        // 0 every group whole, 1 one home's group whole, 2 part of one home's group, 3 a part
        // without a home (ambiguous when the seat has groups from several homes there).
        const draw = randInt(rng, 0, 9);
        const mode = draw === 0 ? 0 : draw <= 2 ? 1 : draw <= 7 ? 2 : 3;
        const home = mode === 1 || mode === 2 ? pickOf(rng, at.homes) : undefined;
        const g = at.groups.find((x) => x.home === home) ?? at.groups[0];
        const unit = Object.keys(g?.units ?? {}).toSorted(byText)[0];
        const units = mode >= 2 && unit !== undefined ? { [unit]: 1 } : undefined;
        if (at.homes.length > 1) {
          this.reach.multi.tried += 1;
          this.multi.push({ index, home: home !== undefined, units: units !== undefined });
        }
        return {
          tool: "recall_troops",
          args: {
            stationedAt: at.c,
            ...(home === undefined ? {} : { home }),
            ...(units === undefined ? {} : { units }),
          },
        };
      }
      case "dismiss": {
        const guests = own.flatMap((c) =>
          (s.cities[c]?.stationed ?? []).map((g) => ({ city: c, player: g.owner })),
        );
        const guest = pickOf(rng, guests) ?? { city: from, player: other };
        return { tool: "recall_troops", args: { dismiss: guest } };
      }
      case "found_city": {
        const island = pickOf(rng, sortedIds(s.islands)) ?? "i999";
        return { tool: "found_city", args: { from, island, units: group(from) } };
      }
      case "send_message":
        return {
          tool: "send_message",
          args: { to: percent(rng, 25) ? "all" : [other], text: `hello from ${seat}` },
        };
      case "propose": {
        const partners = s.pacts.flatMap((p) => (p.a === seat ? [p.b] : p.b === seat ? [p.a] : []));
        const partner = pickOf(rng, partners);
        if (partner !== undefined && percent(rng, 75)) {
          const name = s.players[seat]?.alliance === null ? { name: `Bloc ${seat}` } : {};
          return { tool: "propose_alliance", args: { to: partner, kind: "alliance", ...name } };
        }
        const kindOf = percent(rng, 70) ? "pact" : "alliance";
        return { tool: "propose_alliance", args: { to: other, kind: kindOf, text: "deal" } };
      }
      case "answer": {
        const open = sortedIds(s.proposals).filter((q) => s.proposals[q]?.to === seat);
        const id = pickOf(rng, open) ?? "q00000";
        return { tool: "answer_proposal", args: { id, accept: percent(rng, 85) } };
      }
      case "leave":
        return { tool: "leave_alliance", args: percent(rng, 50) ? {} : { with: other } };
      case "read": {
        const reads: ToolCall[] = [
          { tool: "view_city", args: { city: pickOf(rng, cities) ?? from } },
          { tool: "view_player", args: { player: pickOf(rng, players) ?? seat } },
          { tool: "leaderboard", args: {} },
          { tool: "read_notes", args: {} },
          { tool: "write_note", args: { text: `t${r.now}`, mode: "append" } },
        ];
        return pickOf(rng, reads) ?? { tool: "leaderboard", args: {} };
      }
      case "extra": {
        const extra = pickOf(rng, this.match.ruleset.tools ?? []);
        if (extra === undefined) return { tool: "leaderboard", args: {} };
        return extra.kind === "read"
          ? { tool: extra.name, args: {} }
          : { tool: extra.name, args: { city: from, name: `Fort ${randInt(rng, 1, 99)}` } };
      }
      case "junk": {
        const junk: ToolCall[] = [
          { tool: "conquer_world", args: {} },
          { tool: "build", args: { city: "c999", buildings: ["nothing"] } },
          { tool: "attack", args: { from: 7, to: [], units: "all" } },
          { tool: "recall_troops", args: { movement: "m00000", stationedAt: from } },
          { tool: "answer_proposal", args: { id: "q00000", accept: true } },
          { tool: "support", args: { from: to, to: from, units: { nothing: 1 } } },
        ];
        return pickOf(rng, junk) ?? { tool: "conquer_world", args: {} };
      }
    }
    return { tool: "leaderboard", args: {} };
  }
}

/** One run of six intent agents on the rich start, through a `MatchHost` and the lockstep driver. */
async function intentRun(ruleset: AnyRuleset, seed: number, reach: Reach): Promise<LogLine[]> {
  const match = richStart(ruleset, seed);
  reach.partial = match.rules.movement.recall.stationed === "partial";
  const agents = new Map<PlayerId, SeatAgent>(
    match.setup.seats.map((s) => [s.id, new IntentAgent(s.id, seed, match, reach)]),
  );
  const sink = new MemorySink();
  const host = new MatchHost({
    match,
    sink,
    agents,
    clock: { kind: "lockstep", maxTurnsPerSecond: 3 },
    strict: true,
  });
  await createLockstepDriver({ strict: true }).run(host, agents);
  return sink.parsed();
}

describe("P4 through the tools", () => {
  // Seeded, so that the check of the intents' reach is reproducible.
  for (const ref of RULESETS) {
    test(`${ref}: seeded intents never throw, keep step invariants, ally pact partners and recall from several groups`, async () => {
      const ruleset = getRuleset(ref);
      const reach: Reach = {
        accepted: {},
        multi: { tried: 0, accepted: 0, withHome: 0, withUnits: 0 },
        partial: false,
        generic: [],
      };
      let superseded = 0;
      for (const seed of [11, 12]) {
        // oxlint-disable-next-line no-await-in-loop -- one run at a time keeps the reach readable
        const lines = await intentRun(ruleset, seed, reach);
        expect(lines.some((l) => l.k === "fatal")).toBe(false);
        expect(lines.at(-1)?.k).toBe("end");
        expect(lines.filter((l) => l.k === "gw" && l.r.code === "INTERNAL")).toEqual([]);
        superseded += lines.filter(
          (l) => l.k === "ev" && l.e.type === "pact_ended" && l.e.data["cause"] === "superseded",
        ).length;
      }
      // Alliances between pact partners (the pact ends, superseded) and recalls meeting groups
      // from several homes, whole and by home, both happened through the tools.
      expect(superseded).toBeGreaterThan(0);
      // Every violation the tools met has its own wording: none fell back to the generic text.
      expect(reach.generic).toEqual([]);
      expect(reach.multi.accepted).toBeGreaterThan(0);
      expect(reach.multi.withHome).toBeGreaterThan(0);
      // Partial recalls name units only where the ruleset allows them (perfidia-1; sandbox-1
      // recalls whole groups).
      if (reach.partial) expect(reach.multi.withUnits).toBeGreaterThan(0);
      for (const tool of [
        "build",
        "recruit",
        "recall_troops",
        "propose_alliance",
        "answer_proposal",
      ]) {
        expect([tool, reach.accepted[tool] ?? 0]).not.toEqual([tool, 0]);
      }
    }, 60000);
  }

  for (const ref of RULESETS) {
    test(`${ref}: random matches never throw, keep step invariants and replay`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.boolean(),
          async (seed, virtual) => {
            const out = await mixed(ref, seed, virtual ? VIRTUAL : LOCKSTEP);
            endedCleanly(out);
            levelE(out.lines);
            expect(out.lines.filter((l) => l.k === "gw" && l.r.code === "INTERNAL")).toEqual([]);
          },
        ),
        { numRuns: 3 },
      );
    }, 60000);
  }
});

describe("extra tools, snapshots and sinks", () => {
  test("rename_city calls are logged as ext actions and replayed at Level E", async () => {
    const prepared = prepareBotRun(day("sandbox-1", LOCKSTEP, 5));
    const agents = new Map<PlayerId, SeatAgent>(prepared.options.agents);
    const bot = agents.get("p1");
    if (bot === undefined) throw new Error("no p1");
    agents.set("p1", renaming(bot));
    const sink = new MemorySink();
    await runPrepared({ ...prepared, options: { ...prepared.options, agents } }, sink);
    const lines = sink.parsed();
    const i = lines.findIndex((l) => l.k === "act" && l.tool === "rename_city");
    const rename = lines[i];
    if (rename?.k !== "act") throw new Error("no rename_city act line");
    expect(rename).toMatchObject({
      k: "act",
      seat: "p1",
      a: { type: "ext", tool: "rename_city", args: { name: "Hill Fort" } },
      r: { ok: true },
    });
    const ev = lines[i + 1];
    expect(ev).toMatchObject({
      k: "ev",
      e: { type: "city_renamed", public: true, data: { name: "Hill Fort" } },
    });
    levelE(lines);
    // A tampered rename is caught at its line.
    const tampered = lines.with(i, {
      ...rename,
      a: { type: "ext", tool: "rename_city", args: { city: "c1", name: "!" } },
    });
    expect(verifyLog(tampered).divergence?.n).toBe(rename.n);
  }, 30000);

  test("every snapshot's hash equals its ckpt line, and Level E resumes from each", async () => {
    const out = await runBots({ ...day("perfidia-1", LOCKSTEP, 9), snapshotEvery: 6 });
    const snaps = out.sink.parsedSnapshots();
    expect(snaps.map((s) => s.hour)).toEqual([6, 12, 18, 23]);
    for (const snap of snaps.slice(0, -1)) {
      const ckpt = out.lines.find((l) => l.k === "ckpt" && l.hour === snap.hour);
      expect(ckpt).toMatchObject({ h: snap.hash, t: snap.t });
      const report = verifyLog(out.lines, { from: snap });
      expect(report.divergence).toBeUndefined();
      expect(report.finalHash).toBe(out.run.finalHash);
    }
    expect(out.lines.at(-1)).toMatchObject({ k: "end", h: snaps.at(-1)?.hash });
  }, 30000);

  test("MemorySink text equals the harness file writer's output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perfidia-sink-"));
    try {
      const path = join(dir, "run", "match.jsonl");
      const memory = new MemorySink();
      const file = new JsonlFileSink(path, { snapshotsDir: join(dir, "run", "snapshots") });
      const prepared = prepareBotRun({ ...day("sandbox-1", LOCKSTEP, 12), snapshotEvery: 12 });
      await runPrepared(prepared, teeSink(memory, file));
      expect(readFileSync(path, "utf8")).toBe(memory.text());
      expect(jsonlText(memory.lines)).toBe(memory.text());
      expect(jsonlText(memory.parsed())).toBe(memory.text());
      const gz = join(dir, "copy.jsonl.gz");
      writeJsonl(gz, memory.parsed());
      expect(jsonlText(readLog(gz))).toBe(memory.text());
      expect(readLog(path)).toEqual(memory.parsed());
      const snapshot = readFileSync(join(dir, "run", "snapshots", "h0012.json"), "utf8");
      expect(snapshot).toBe(memory.snapshots[0] ?? "");
      expect(readFileSync(join(dir, "run", "snapshots", "final.json"), "utf8")).toBe(
        memory.snapshots.at(-1) ?? "",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
