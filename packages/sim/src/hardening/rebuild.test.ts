// The gateway state rebuild against the live state (docs/architecture.md §10.5, §15 T16): at the end
// of 1-game-day runs of the four bots, under lockstep and under real time with `VirtualTime`, for
// both rulesets, `rebuildGatewayState` over the log equals the gateway state `runMatch` returns
// (canonical JSON). Also with chaos agents on two seats (many gateway rejections and failures), a
// hand-off, and the lockstep per-second cap (defer lines); and a log with a missing `turn` line
// rebuilds to another state, so the comparison can fail.

import { describe, expect, test } from "bun:test";
import type { AnyRuleset } from "@perfidia/engine";
import { canonicalJson } from "@perfidia/engine/core";
import { fixtureRuleset } from "@perfidia/engine/testing";
import { ChaosAgent, MemorySink, rebuildGatewayState, type GatewayState } from "@perfidia/gateway";
import type { LogLine, PlayerId, SeatAgent } from "@perfidia/protocol";
import { prepareBotRun, runBots, runPrepared, type BotRun } from "../harness/index.ts";
import { LOCKSTEP, REFS, VIRTUAL, daySpec, resolve } from "./kit.ts";

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

describe("rebuilt gateway state = live gateway state (§10.5)", () => {
  for (const ref of REFS) {
    for (const clock of [LOCKSTEP, VIRTUAL]) {
      test(`${ref}, four bots, ${clock.kind}`, async () => {
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
    test(`${ref}, four bots, system clock at very high speed: Level E, and the rebuild too`, async () => {
      const out = await runBots(
        daySpec(ref, { kind: "system", speed: { num: 864000, den: 1 } }, 3),
      );
      expect(out.lines.at(-1)?.k).toBe("end");
      expect(out.lines[0]?.k === "header" && typeof out.lines[0].wallStart).toBe("string");
      expectRebuilt(out.lines, out.run.gateway);
    }, 30000);
  }

  test("a hand-off (controller line) and deferred turns (defer lines)", async () => {
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
