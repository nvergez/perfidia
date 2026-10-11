// The chaos agent at match scale (docs/architecture.md §11.2, §13.2): P12 (every result a chaos agent
// receives is schema-valid; it throws otherwise, and strict mode makes that fatal) with zero
// INTERNAL, and P16 (a chaos agent that mutates everything it receives leaves the log, the hash and
// every seat's inputs byte-identical to the same agent without mutation), under lockstep and under
// real time with `VirtualTime`, for both rulesets and the testing kit's fixture.

import { describe, expect, test } from "bun:test";
import { verifyLog, type AnyRuleset } from "@perfidia/engine";
import { canonicalJson } from "@perfidia/engine/core";
import { VirtualTime } from "@perfidia/gateway/clock";
import type { PlayerId, RoundInput, SeatAgent, TimeSource, ToolResult } from "@perfidia/protocol";
import { ChaosAgent, MemorySink, copyOf, runMatch, type RunMatchOptions } from "./index.ts";
import { FIXTURE, PERFIDIA, SANDBOX, call, setupOf } from "./testkit.test.ts";

/**
 * `agent`, recording the canonical text of every input, and a copy of every result in it, before
 * the agent sees (and mutates) it.
 */
function recorded(agent: SeatAgent, log: string[], results: ToolResult[]): SeatAgent {
  return {
    label: agent.label,
    round(input: RoundInput) {
      log.push(canonicalJson(input));
      results.push(...copyOf(input.results));
      return agent.round(input);
    },
  };
}

/**
 * Whether a failure got one of `explain`'s generic fallbacks instead of a specific explanation:
 * every code the gateway and the engine raise must have its own wording (§7.3).
 */
function generic(r: ToolResult): boolean {
  if (r.ok) return false;
  return (
    r.hint === "The rules tool explains the rules behind this code." ||
    r.message.startsWith("Invalid arguments") ||
    r.message.startsWith("An id in this call") ||
    r.message.startsWith(`${r.code} (`) ||
    r.message === `${r.code}.`
  );
}

/** `agent` answering each round after `ms` of wall time (think time under virtual time). */
function slow(agent: SeatAgent, time: TimeSource, ms: number): SeatAgent {
  return {
    label: agent.label,
    async round(input: RoundInput) {
      const out = await agent.round(input);
      await time.sleepUntil(time.nowMs() + ms).done;
      return out;
    },
  };
}

interface ChaosRun {
  readonly text: string;
  readonly inputs: string[];
  readonly finalHash: string;
}

async function chaosRun(
  ruleset: AnyRuleset,
  players: number,
  mutate: boolean,
  clock: "lockstep" | "virtual",
): Promise<ChaosRun> {
  const setup = setupOf(ruleset, players, { "time.matchEnd": 86400 }, 23);
  const inputs: string[] = [];
  const results: ToolResult[] = [];
  const virtual =
    clock === "virtual"
      ? new VirtualTime({ yieldMacrotask: () => new Promise((r) => setImmediate(r)) })
      : null;
  const agents = new Map<PlayerId, SeatAgent>(
    setup.seats.map((s, i) => {
      const chaos = recorded(new ChaosAgent({ seat: s.id, seed: 5 + i, mutate }), inputs, results);
      return [s.id, virtual === null ? chaos : slow(chaos, virtual, 1000 + 700 * i)];
    }),
  );
  const sink = new MemorySink();
  const options: RunMatchOptions = {
    setup,
    ruleset,
    agents,
    clock:
      virtual === null
        ? { kind: "lockstep" }
        : { kind: "realtime", speed: { num: 3, den: 1 }, time: virtual, timeKind: "virtual" },
    sink,
    strict: true,
    invariants: "step",
    snapshotEvery: 6,
  };
  const out = await (virtual === null ? runMatch(options) : virtual.run(() => runMatch(options)));
  const lines = sink.parsed();
  const report = verifyLog(lines, (ref) => (ref === ruleset.ref ? ruleset : undefined));
  expect(report.divergence).toBeUndefined();
  expect(report.finalHash).toBe(out.finalHash);
  const internal = lines.filter((l) => l.k === "gw" && l.r.code === "INTERNAL");
  expect(internal).toEqual([]);
  // The chaos agents reached the engine: accepted and rejected actions, gateway rejections.
  expect(lines.some((l) => l.k === "act" && l.r.ok)).toBe(true);
  expect(lines.some((l) => l.k === "act" && !l.r.ok)).toBe(true);
  expect(lines.some((l) => l.k === "gw")).toBe(true);
  // Every failure the agents saw has a specific explanation, none the generic fallback.
  const failures = results.filter((r) => !r.ok);
  expect(failures.length).toBeGreaterThan(20);
  expect(failures.filter(generic)).toEqual([]);
  return { text: sink.text() + sink.snapshots.join("\n"), inputs, finalHash: out.finalHash };
}

describe("P12 and P16 with the chaos agent", () => {
  for (const [rs, players] of [
    [SANDBOX, 3],
    [PERFIDIA, 6],
    [FIXTURE, 2],
  ] as const) {
    for (const clock of ["lockstep", "virtual"] as const) {
      test(`${rs.ref}, ${clock}: zero INTERNAL in strict mode; mutation changes nothing`, async () => {
        const mutating = await chaosRun(rs, players, true, clock);
        const quiet = await chaosRun(rs, players, false, clock);
        expect(mutating.finalHash).toBe(quiet.finalHash);
        expect(mutating.text).toBe(quiet.text);
        expect(mutating.inputs).toEqual(quiet.inputs);
        expect(mutating.inputs.length).toBeGreaterThan(20);
      }, 30000);
    }
  }
});

const BRIEFING: RoundInput["briefing"] = {
  you: "p1",
  t: 600,
  time: "D1 00:10",
  left: [85800, "23h50m"],
  ruleset: "sandbox-1@1.0.0",
  wake: { urgent: false, reasons: ["self"] },
  lastTurn: null,
  cities: [],
  incoming: [],
  moves: [],
  msgs: [],
  proposals: [],
  events: [],
  news: [],
  notes: "",
  budget: {
    roundTrips: 6,
    callsPerRoundTrip: 8,
    ownWakesLeft: 8,
    socialWakesLeft: 6,
    selfWakeAt: null,
    attacksLeft: 10,
    messagesLeft: 10,
  },
  ext: {},
};

describe("the chaos agent", () => {
  test("is deterministic and mutates what it receives", async () => {
    const briefing = BRIEFING;
    const input = (round: number): RoundInput => ({
      seat: "p1",
      turn: 3,
      round,
      maxRounds: 6,
      maxCalls: 8,
      briefing: copyOf(briefing),
      results:
        round === 0
          ? []
          : [
              { ok: false, t: 600, code: "UNKNOWN_ID", message: "m", hint: "h" },
              { ok: false, t: 600, code: "TURN_OVER", message: "m", hint: "h" },
            ],
    });
    const a = new ChaosAgent({ seat: "p1", seed: 9 });
    const b = new ChaosAgent({ seat: "p1", seed: 9, mutate: false });
    for (let round = 0; round < 6; round += 1) {
      const ia = input(round);
      const ib = input(round);
      // oxlint-disable-next-line no-await-in-loop -- a chaos agent learns from its earlier rounds
      const [oa, ob] = await Promise.all([a.round(ia), b.round(ib)]);
      expect(oa).toEqual(ob);
      expect(canonicalJson(ib)).toBe(canonicalJson(input(round)));
      expect(canonicalJson(ia)).not.toBe(canonicalJson(input(round)));
    }
    const first = await new ChaosAgent({ seat: "p1", seed: 9 }).round(input(0));
    expect(first.calls).toEqual([call("rules"), call("view_map")]);
  });

  test("a malformed result is an agent error (P12 at match scale)", async () => {
    const a = new ChaosAgent({ seat: "p1", seed: 1 });
    const first = await a.round({
      seat: "p1",
      turn: 1,
      round: 0,
      maxRounds: 6,
      maxCalls: 8,
      briefing: copyOf(BRIEFING),
      results: [],
    });
    expect(first.calls.map((c) => c.tool)).toEqual(["rules", "view_map"]);
    const bad: RoundInput = {
      seat: "p1",
      turn: 1,
      round: 1,
      maxRounds: 6,
      maxCalls: 8,
      briefing: copyOf(BRIEFING),
      results: [{ ok: true, t: 1.5, data: {} }],
    };
    expect(() => a.round(bad)).toThrow("not a ToolResult");
    // A schema-valid result whose data does not match its tool's schema is caught too.
    const wrong: RoundInput = { ...bad, results: [{ ok: true, t: 1, data: {} }] };
    expect(() => a.round(wrong)).toThrow("rules data does not match its schema");
  });
});
