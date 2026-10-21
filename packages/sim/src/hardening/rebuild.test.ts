// The gateway state rebuild against the live state (docs/architecture.md §10.5, §15 T16): at the end
// of 1-game-day runs of the default bots, under lockstep and under real time with `VirtualTime`, for
// both rulesets, `rebuildGatewayState` over the log equals the gateway state `runMatch` returns
// (canonical JSON). Also with chaos agents on two seats (many gateway rejections and failures), a
// hand-off, and the lockstep per-second cap (defer lines); with perfidia-1's time-compressing
// overrides and a scripted conquest, which reach urgent wakes, battles, a siege, a conquest and an
// elimination (the seat's scheduler stops, its last turn has no next wake); and not strict, under
// real time, with an agent that throws in one round, one that outlasts the round timeout and an
// eliminated seat whose turn was open. And a log with a missing `turn` line rebuilds to another
// state, so the comparison can fail.

import { describe, expect, test } from "bun:test";
import type { AnyRuleset } from "@perfidia/engine";
import { canonicalJson } from "@perfidia/engine/core";
import { fixtureRuleset } from "@perfidia/engine/testing";
import { ChaosAgent, MemorySink, rebuildGatewayState, type GatewayState } from "@perfidia/gateway";
import type {
  Json,
  LogLine,
  PlayerId,
  RoundInput,
  RoundOutput,
  SeatAgent,
  TimeSource,
  ToolCall,
} from "@perfidia/protocol";
import { prepareBotRun, runBots, runPrepared, type BotRun } from "../harness/index.ts";
import { DEFAULT_REF, LOCKSTEP, REFS, VIRTUAL, daySpec, resolve } from "./kit.ts";

/**
 * The slow suite (`PERFIDIA_SLOW=1`: `bun run test:slow`, run by `bun run test:exit`; docs/
 * architecture.md §13.8) runs the per-ruleset comparisons on every ruleset of `REFS` under both
 * clocks; the default suite on `DEFAULT_REF` only, with chaos agents under lockstep, and the system
 * clock. The runs with the default bots alone and the hand-off run in the slow suite only.
 */
const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

const text = (gw: GatewayState): string => canonicalJson(gw);

const fixture = (ref: string): AnyRuleset | undefined =>
  ref === fixtureRuleset.ref ? fixtureRuleset : undefined;

function expectRebuilt(lines: readonly LogLine[], live: GatewayState, r = resolve): void {
  const rebuilt = rebuildGatewayState(lines, r);
  expect(rebuilt.report.divergence).toBeUndefined();
  expect(rebuilt.drift).toBeNull();
  expect(rebuilt.ok).toBe(true);
  expect(rebuilt.inTurn).toBe(false);
  expect(text(rebuilt.gw)).toBe(text(live));
}

/** Bots on four seats and chaos agents on p3 and p6 (strict: zero INTERNAL). */
async function mixed(ref: string, seed: number, virtual: boolean): Promise<BotRun> {
  const prepared = prepareBotRun(daySpec(ref, virtual ? VIRTUAL : LOCKSTEP, seed));
  const agents = new Map<PlayerId, SeatAgent>(prepared.options.agents);
  for (const seat of ["p3", "p6"] as const) {
    agents.set(seat, new ChaosAgent({ seat, seed: seed * 7 + seat.length }));
  }
  const sink = new MemorySink();
  const run = await runPrepared({ ...prepared, options: { ...prepared.options, agents } }, sink);
  return { run, sink, lines: sink.parsed() };
}

/**
 * perfidia-1 with P4's time-compressing overrides (attacks from the start, capitals besiegeable
 * after one hour, one-hour sieges), and capitals that start with a strike force: 40 raiders, 2
 * settlers and 3 transports (their land pop fits the transports), the hall raised to house them.
 */
const LATE: Readonly<Record<string, Json>> = {
  "time.protectionEnd": 0,
  "time.capitalImmunityEnd": 3600,
  "time.siegeDuration": 3600,
  "time.dominationStart": 7200,
  "start.capital.units": { guard: 10, raider: 40, settler: 2, transport: 3 },
  "start.capital.buildings.hall": 3,
};

function agent(label: string, play: (input: RoundInput) => readonly ToolCall[]): SeatAgent {
  return { label, round: (input) => Promise.resolve({ calls: play(input) }) };
}

/** p1 sends its whole strike force against p2's capital at once, then idles. */
const conqueror = agent("test:conqueror", (input) => {
  if (input.turn !== 1 || input.round !== 0) return [];
  const from = input.briefing.cities[0]?.id ?? "c0";
  const units = { raider: 40, settler: 2, transport: 3 };
  return [
    { tool: "attack", args: { from, to: "c2", units } },
    { tool: "end_turn", args: {} },
  ];
});

/**
 * On an urgent wake, thinks `ms` per round and keeps reading the leaderboard, so its turn stays
 * open through the siege of its city (the last round ends it); otherwise ends its turn at once.
 */
function dawdler(time: TimeSource, ms: number): SeatAgent {
  return {
    label: "test:dawdler",
    async round(input: RoundInput): Promise<RoundOutput> {
      if (!input.briefing.wake.urgent) return { calls: [{ tool: "end_turn", args: {} }] };
      if (input.round === input.maxRounds - 1) return { calls: [] };
      await time.sleepUntil(time.nowMs() + ms).done;
      return { calls: [{ tool: "leaderboard", args: {} }] };
    },
  };
}

/** `inner`, except in the first round of its turn `turn`: it throws, or first sleeps `ms`. */
function faulty(
  inner: SeatAgent | undefined,
  turn: number,
  fault: "throw" | { readonly time: TimeSource; readonly ms: number },
): SeatAgent {
  if (inner === undefined) throw new Error("no agent to wrap");
  return {
    label: inner.label,
    async round(input: RoundInput): Promise<RoundOutput> {
      if (input.turn === turn && input.round === 0) {
        if (fault === "throw") throw new Error("the agent fell over");
        await fault.time.sleepUntil(fault.time.nowMs() + fault.ms).done;
      }
      return inner.round(input);
    },
  };
}

/**
 * The compressed perfidia-1 day: p1 conquers p2's capital (p2's only city), the other seats are
 * bots. Lockstep: strict, p2 idles. Virtual time: not strict, a round timeout of 10 wall minutes
 * (200 game minutes at speed 3), p2 dawdles through its siege, p5 outlasts the timeout and p6
 * throws, each in the first round of its second turn.
 */
async function late(virtual: boolean): Promise<BotRun> {
  const prepared = prepareBotRun({
    ...daySpec("perfidia-1@1.0.0", virtual ? VIRTUAL : LOCKSTEP, 7),
    overrides: LATE,
    strict: !virtual,
  });
  const agents = new Map<PlayerId, SeatAgent>(prepared.options.agents);
  agents.set("p1", conqueror);
  let clock = prepared.options.clock;
  const time = prepared.virtual;
  if (time === null || clock.kind !== "realtime") {
    agents.set(
      "p2",
      agent("test:idle", () => []),
    );
  } else {
    agents.set("p2", dawdler(time, 200_000));
    agents.set("p5", faulty(agents.get("p5"), 2, { time, ms: 900_000 }));
    agents.set("p6", faulty(agents.get("p6"), 2, "throw"));
    clock = { ...clock, turnTimeoutMs: 600_000 };
  }
  const sink = new MemorySink();
  const run = await runPrepared(
    { ...prepared, options: { ...prepared.options, agents, clock } },
    sink,
  );
  return { run, sink, lines: sink.parsed() };
}

/** Whether `lines` hold an `ev` line of one of `types`. */
const hasEvent = (lines: readonly LogLine[], ...types: string[]): boolean =>
  lines.some((l) => l.k === "ev" && types.includes(l.e.type));

describe("rebuilt gateway state = live gateway state (§10.5)", () => {
  for (const ref of REFS) {
    for (const clock of [LOCKSTEP, VIRTUAL]) {
      if (!SLOW && (ref !== DEFAULT_REF || clock.kind !== "lockstep")) continue;
      xtest(`${ref}, default bots, ${clock.kind}`, async () => {
        const out = await runBots(daySpec(ref, clock, 3));
        expect(out.lines.at(-1)?.k).toBe("end");
        expectRebuilt(out.lines, out.run.gateway);
        // Not a vacuous comparison: the bots wrote notes, messages and actions the state keeps.
        const gw = out.run.gateway;
        expect(Object.values(gw.seats).some((s) => s.notes !== "")).toBe(true);
        expect(gw.delivered).toBeGreaterThan(20);
        expect(Object.values(gw.seats).every((s) => s.turns > 1)).toBe(true);
      }, 30000);

      test(`${ref}, bots and chaos agents, ${clock.kind}`, async () => {
        const out = await mixed(ref, 5, clock.kind === "virtual");
        expect(out.lines.at(-1)?.k).toBe("end");
        expect(out.lines.filter((l) => l.k === "gw").length).toBeGreaterThan(20);
        expectRebuilt(out.lines, out.run.gateway);
      }, 30000);
    }
  }

  for (const ref of REFS) {
    if (!SLOW && ref !== DEFAULT_REF) continue;
    test(`${ref}, default bots, system clock at very high speed: Level E, and the rebuild too`, async () => {
      const out = await runBots(
        daySpec(ref, { kind: "system", speed: { num: 864000, den: 1 } }, 3),
      );
      expect(out.lines.at(-1)?.k).toBe("end");
      expect(out.lines[0]?.k === "header" && typeof out.lines[0].wallStart).toBe("string");
      expectRebuilt(out.lines, out.run.gateway);
    }, 30000);
  }

  for (const virtual of [false, true]) {
    const name = virtual
      ? "virtual time, not strict: an agent error, a round timeout, a seat eliminated in its turn"
      : "lockstep";
    test(`perfidia-1, compressed time and a conquest: urgent wakes, battles, an elimination; ${name}`, async () => {
      const out = await late(virtual);
      const lines = out.lines;
      expect(lines.at(-1)?.k).toBe("end");
      expectRebuilt(lines, out.run.gateway);
      // The paths this run is for are in the log, so the comparison cannot become vacuous.
      expect(lines.some((l) => l.k === "wake" && l.urgent)).toBe(true);
      expect(hasEvent(lines, "battle")).toBe(true);
      expect(hasEvent(lines, "siege_started")).toBe(true);
      expect(hasEvent(lines, "city_conquered")).toBe(true);
      expect(hasEvent(lines, "player_eliminated", "domination_started")).toBe(true);
      expect(out.run.gateway.seats["p2"]?.alive).toBe(false);
      const last = lines.at(-1);
      const end = last?.k === "end" ? last.t : 0;
      const turns = lines.flatMap((l) => (l.k === "turn" ? [l] : []));
      if (virtual) {
        const whys = new Set(turns.map((l) => l.why));
        for (const why of ["error", "timeout", "eliminated"] as const) {
          expect([why, whys.has(why)]).toEqual([why, true]);
        }
        // The eliminated seat's last turn closed with no next wake, while the match went on.
        const p2Last = turns.findLast((l) => l.seat === "p2");
        expect(p2Last).toMatchObject({ why: "eliminated", next: null });
        expect(p2Last?.t ?? end).toBeLessThan(end);
      }
    }, 30000);
  }

  xtest("a hand-off (controller line) and deferred turns (defer lines)", async () => {
    const handoff = await runBots({
      ...daySpec("perfidia-1", LOCKSTEP, 6),
      handoffs: [{ seat: "p2", at: 43200, strategy: "turtle" }],
    });
    expect(handoff.lines.some((l) => l.k === "controller")).toBe(true);
    expectRebuilt(handoff.lines, handoff.run.gateway);

    const capped = await runBots({
      ruleset: fixtureRuleset,
      seed: 1,
      players: 4,
      days: 1,
      clock: { kind: "lockstep", maxTurnsPerSecond: 1 },
      bots: ["rusher", "rusher", "turtle", "opportunist"],
      strict: true,
    });
    expect(capped.lines.some((l) => l.k === "defer")).toBe(true);
    expectRebuilt(capped.lines, capped.run.gateway, fixture);
  }, 30000);

  test("the comparison can fail: a log with a missing turn line rebuilds to another state", async () => {
    const out = await runBots(daySpec("sandbox-1", LOCKSTEP, 3));
    // The last turn line: no later wake of that seat stops the fold, yet its turn stays open.
    const i = out.lines.findLastIndex((l) => l.k === "turn");
    const rebuilt = rebuildGatewayState(out.lines.toSpliced(i, 1), resolve);
    expect(rebuilt.report.ok).toBe(true);
    expect(rebuilt.inTurn).toBe(true);
    expect(text(rebuilt.gw)).not.toBe(text(out.run.gateway));
    // An earlier one: the seat's next wake cannot begin, and the fold reports where it stopped.
    const j = out.lines.findIndex((l) => l.k === "turn");
    const early = rebuildGatewayState(out.lines.toSpliced(j, 1), resolve);
    expect(early.drift?.k).toBe("wake");
    expect(text(early.gw)).not.toBe(text(out.run.gateway));
  }, 30000);
});
