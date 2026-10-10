import { describe, expect, test } from "bun:test";
import { randInt, shuffle, streamRng } from "@perfidia/engine/core";
import type { PlayerId, RoundInput, RoundOutput, SeatAgent } from "@perfidia/protocol";
import fc from "fast-check";
import { AgentRoundError, ClockError } from "./errors.ts";
import {
  answering,
  call,
  describeRecord,
  FakeHost,
  type FakeHostOptions,
  playRounds,
  rejectionOf,
  replayFakeTrace,
  type Script,
  scriptedAgent,
  thinkingAgent,
  traceViolations,
} from "./fake-host.ts";
import { createLockstepDriver, lockstepOrder, type LockstepOptions } from "./lockstep.ts";
import { VirtualTime, VirtualTimeDeadlock } from "./virtual.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function agentsOf(host: FakeHost, make: (seat: PlayerId) => SeatAgent): Map<PlayerId, SeatAgent> {
  return new Map(host.seats.map((seat) => [seat, make(seat)]));
}

/** One script per seat (`p1` first); seats beyond the list end every turn at once. */
function bySeat(scripts: readonly Script[]): (seat: PlayerId) => SeatAgent {
  return (seat) => scriptedAgent(scripts[Number(seat.slice(1)) - 1] ?? playRounds(1, () => []));
}

/** Runs a lockstep match and checks the trace's structural invariants. */
async function play(
  options: FakeHostOptions,
  make: (seat: PlayerId) => SeatAgent,
  driver: LockstepOptions = {},
): Promise<{ host: FakeHost; lines: string[] }> {
  const host = new FakeHost(options);
  await createLockstepDriver(driver).run(host, agentsOf(host, make));
  expect(traceViolations(host.trace)).toEqual([]);
  return { host, lines: host.trace.map(describeRecord) };
}

/** The lines from the first one starting with `from` (inclusive). */
function from(lines: readonly string[], start: string): string[] {
  const i = lines.findIndex((l) => l.startsWith(start));
  expect(i).toBeGreaterThanOrEqual(0);
  return lines.slice(i);
}

const seats = (n: number): PlayerId[] => Array.from({ length: n }, (_, i) => `p${i + 1}` as const);

/** Turn 1: sleep until 100; turn 2: attack p2 and end the turn. */
const attackAt100: Script = (input) =>
  input.turn === 1
    ? { calls: [call("end_turn", { wakeAt: 100 })] }
    : { calls: [call("attack", { target: "p2" }), call("end_turn")] };

/** Attacks p2 at every turn; the first turn asks for a wake at 100. */
const attackEveryTurn: Script = (input) => ({
  calls: [
    call("attack", { target: "p2" }),
    call("end_turn", input.turn === 1 ? { wakeAt: 100 } : {}),
  ],
});

const endAtOnce: Script = () => ({ calls: [] });

/** A seeded script: per turn 1–3 rounds of attacks, messages and views; sometimes an empty round. */
const randomScript =
  (seed: number, n: number) =>
  (input: RoundInput): RoundOutput => {
    const rng = streamRng(seed, `${input.seat}:${input.turn}:${input.round}`);
    const rounds = randInt(streamRng(seed, `${input.seat}:${input.turn}`), 1, 3);
    if (randInt(rng, 0, 9) === 0) return { calls: [] };
    const target = `p${randInt(rng, 1, n)}`;
    const action = [
      call("attack", { target }),
      call("send_message", { to: target }),
      call("view_city"),
    ][randInt(rng, 0, 2)]!;
    if (input.round + 1 < rounds) return { calls: [action] };
    const delay = randInt(rng, 0, 30);
    const wake = delay === 0 ? {} : { wakeAt: input.briefing.t + delay };
    return { calls: [action, call("end_turn", wake)] };
  };

const hungAgent: SeatAgent = {
  label: "test:hung@1",
  round: () => new Promise<RoundOutput>(() => undefined),
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

describe("lockstep order", () => {
  test("golden: seed 42, six acting seats, batches 0 and 1 at t = 0", () => {
    expect(lockstepOrder(42, 0, 0, seats(6))).toEqual(["p5", "p1", "p2", "p6", "p3", "p4"]);
    expect(lockstepOrder(42, 0, 1, seats(6))).toEqual(["p5", "p4", "p2", "p1", "p6", "p3"]);
    expect(lockstepOrder(42, 3600, 0, seats(6))).toEqual(["p4", "p2", "p5", "p1", "p6", "p3"]);
  });

  test("shuffles the seats sorted by player number on the stream lockstep:<t>:<b>", () => {
    expect(lockstepOrder(42, 0, 0, ["p3", "p1", "p2"])).toEqual(lockstepOrder(42, 0, 0, seats(3)));
    expect(lockstepOrder(7, 5, 2, ["p10", "p9", "p2"])).toEqual(
      shuffle(streamRng(7, "lockstep:5:2"), ["p2", "p9", "p10"]),
    );
    expect(lockstepOrder(7, 5, 2, [])).toEqual([]);
  });
});

describe("lockstep driver", () => {
  test("plays every seat due at t in batches: one round of every open turn per batch", async () => {
    const asked: string[] = [];
    const { lines } = await play({ seed: 42, endsAt: 100, seats: 3 }, () =>
      scriptedAgent((input) => {
        asked.push(`${input.seat}.${input.round}`);
        return playRounds(2)(input);
      }),
    );
    expect(asked).toEqual(["p1.0", "p2.0", "p3.0", "p1.1", "p2.1", "p3.1"]);
    const o0 = lockstepOrder(42, 0, 0, seats(3));
    const o1 = lockstepOrder(42, 0, 1, seats(3));
    expect(lines).toEqual([
      "start",
      "wake p1#1 @0",
      "wake p2#1 @0",
      "wake p3#1 @0",
      `batch 0 @0 [${o0.join(",")}]`,
      ...o0.map((p) => `exec ${p}#1.0 @0 view_city`),
      `batch 1 @0 [${o1.join(",")}]`,
      ...o1.map((p) => `exec ${p}#1.1 @0 view_city,end_turn`),
      "turn p1#1 @0 end_turn",
      "turn p2#1 @0 end_turn",
      "turn p3#1 @0 end_turn",
      "advance 100",
      "ended @100",
      "end @100",
    ]);
  });

  test("applies acting seats in the golden order; idle seats follow and their turn ends", async () => {
    const { lines } = await play({ seed: 42, endsAt: 100, seats: 6 }, (seat) =>
      scriptedAgent(seat === "p3" ? () => ({ calls: [] }) : playRounds(2)),
    );
    const acting0 = lockstepOrder(42, 0, 0, ["p1", "p2", "p4", "p5", "p6"]);
    expect(from(lines, "batch 0")).toEqual([
      `batch 0 @0 [${acting0.join(",")}]`,
      ...acting0.map((p) => `exec ${p}#1.0 @0 view_city`),
      "exec p3#1.0 @0 -",
      "turn p3#1 @0 empty_round",
      `batch 1 @0 [${lockstepOrder(42, 0, 1, ["p1", "p2", "p4", "p5", "p6"]).join(",")}]`,
      ...lockstepOrder(42, 0, 1, ["p1", "p2", "p4", "p5", "p6"]).map(
        (p) => `exec ${p}#1.1 @0 view_city,end_turn`,
      ),
      "turn p1#1 @0 end_turn",
      "turn p2#1 @0 end_turn",
      "turn p4#1 @0 end_turn",
      "turn p5#1 @0 end_turn",
      "turn p6#1 @0 end_turn",
      "advance 100",
      "ended @100",
      "end @100",
    ]);
    // The six-seat golden applies when all six act.
    const all = await play({ seed: 42, endsAt: 100, seats: 6 }, () => scriptedAgent(playRounds(2)));
    expect(all.lines).toContain("batch 0 @0 [p5,p1,p2,p6,p3,p4]");
    expect(all.lines).toContain("batch 1 @0 [p5,p4,p2,p1,p6,p3]");
    expect(from(all.lines, "batch 0").slice(1, 7)).toEqual(
      ["p5", "p1", "p2", "p6", "p3", "p4"].map((p) => `exec ${p}#1.0 @0 view_city`),
    );
  });

  test("an urgent wake caused at t joins the next batch at the same t", async () => {
    const { lines } = await play(
      { seed: 3, endsAt: 1000, seats: 2 },
      bySeat([attackAt100, playRounds(1)]),
    );
    expect(from(lines, "advance 100")).toEqual([
      "advance 100",
      "wake p1#2 @100",
      "batch 0 @100 [p1]",
      "exec p1#2.0 @100 attack,end_turn",
      "turn p1#2 @100 end_turn",
      "wake p2#2 @100",
      "batch 1 @100 [p2]",
      "exec p2#2.0 @100 view_city,end_turn",
      "turn p2#2 @100 end_turn",
      "advance 1000",
      "ended @1000",
      "end @1000",
    ]);
  });

  test("an urgent wake waits for the seat's urgent gap", async () => {
    // p1 attacks p2 at 0 and again at 100; p2's second urgent wake waits for 0 + 600.
    const { lines } = await play(
      { seed: 3, endsAt: 1000, seats: 2, urgentGap: 600 },
      bySeat([attackEveryTurn, playRounds(1)]),
    );
    expect(lines.filter((l) => l.startsWith("wake p2"))).toEqual([
      "wake p2#1 @0",
      "wake p2#2 @0",
      "wake p2#3 @600",
    ]);
  });

  test("defers a seat over the per-second turn cap to t + 1 (cap 2, then the default 3)", async () => {
    // p1 attacks p2 in six rounds at t = 0; p2 ends each turn at once and is due again at once.
    const p1 = playRounds(6, () => [call("attack", { target: "p2" })]);
    const p2 = endAtOnce;
    const options = { seed: 9, endsAt: 50, seats: 2, urgentGap: 0 };
    const capped = await play(options, bySeat([p1, p2]), { maxTurnsPerSecond: 2 });
    expect(capped.lines.filter((l) => l.startsWith("wake p2") || l.startsWith("defer"))).toEqual([
      "wake p2#1 @0",
      "wake p2#2 @0",
      "defer p2 @0 -> 1",
      "wake p2#3 @1",
    ]);
    const byDefault = await play(options, bySeat([p1, p2]));
    expect(byDefault.lines.filter((l) => l.startsWith("wake p2") || l.startsWith("defer"))).toEqual(
      ["wake p2#1 @0", "wake p2#2 @0", "wake p2#3 @0", "defer p2 @0 -> 1", "wake p2#4 @1"],
    );
    expect(byDefault.lines.filter((l) => l.startsWith("advance"))).toEqual([
      "advance 1",
      "advance 50",
    ]);
  });

  test.each([false, true])(
    "closes every open turn when the match ends mid-batch, and opens no other (doneOnEnd: %p)",
    async (doneOnEnd) => {
      const { lines } = await play(
        {
          seed: 5,
          endsAt: 1000,
          seats: 3,
          doneOnEnd,
          onCall: (h, _seat, c) => {
            if (c.tool === "found_city") h.endMatch();
          },
        },
        bySeat([() => ({ calls: [call("found_city")] }), playRounds(4), playRounds(4)]),
      );
      expect(lines.filter((l) => l.startsWith("batch"))).toHaveLength(1);
      expect(from(lines, "turn")).toEqual([
        "turn p1#1 @0 match_ended",
        "turn p2#1 @0 match_ended",
        "turn p3#1 @0 match_ended",
        "end @0",
      ]);
      expect(lines).toContain("ended @0");
    },
  );

  test("a seat due exactly at the end does not play", async () => {
    const { lines } = await play({ seed: 1, endsAt: 500, seats: 1 }, () =>
      scriptedAgent(() => ({ calls: [call("end_turn", { wakeAt: 500 })] })),
    );
    expect(from(lines, "turn")).toEqual([
      "turn p1#1 @0 end_turn",
      "advance 500",
      "ended @500",
      "end @500",
    ]);
  });

  const failing: [string, SeatAgent, string][] = [
    [
      "rejects",
      { label: "test:failing@1", round: () => Promise.reject(new Error("boom")) },
      "Error: boom",
    ],
    [
      "throws",
      {
        label: "test:failing@1",
        round: () => {
          throw new Error("boom");
        },
      },
      "Error: boom",
    ],
    ["answers garbage", answering({ calls: "attack" }), "invalid round output: calls: "],
  ];
  test.each(failing)(
    "closes only the turn of an agent that fails, and applies the others' outputs (agent %s)",
    async (_kind, agent, error) => {
      const { lines } = await play({ seed: 42, endsAt: 100, seats: 3 }, (seat) =>
        seat === "p2" ? agent : scriptedAgent(playRounds(2)),
      );
      const acting = lockstepOrder(42, 0, 0, ["p1", "p3"]);
      const turnLine = lines.find((l) => l.startsWith("turn p2#1"));
      expect(turnLine).toStartWith(`turn p2#1 @0 error: ${error}`);
      expect(from(lines, "turn p2#1").slice(1, 4)).toEqual([
        `batch 0 @0 [${acting.join(",")}]`,
        ...acting.map((p) => `exec ${p}#1.0 @0 view_city`),
      ]);
      expect(lines.filter((l) => l.startsWith("exec p2"))).toEqual([]);
      expect(lines).toContain("turn p1#1 @0 end_turn");
      expect(lines).toContain("turn p3#1 @0 end_turn");
    },
  );

  test("strict mode: an agent error closes the turn, then the run rejects", async () => {
    const host = new FakeHost({ seed: 42, endsAt: 100, seats: 3 });
    const agents = agentsOf(host, (seat) =>
      seat === "p2"
        ? { label: "test:failing@1", round: () => Promise.reject(new Error("boom")) }
        : scriptedAgent(playRounds(2)),
    );
    const run = createLockstepDriver({ strict: true }).run(host, agents);
    const error = await rejectionOf(run);
    expect(error).toBeInstanceOf(AgentRoundError);
    expect(messageOf(error)).toBe("p2: round failed: Error: boom");
    const lines = host.trace.map(describeRecord);
    expect(lines.at(-1)).toBe("turn p2#1 @0 error: Error: boom");
    expect(host.finished).toBe(false);
  });

  test.each([null, 8000])(
    "times out a hung agent when roundTimeoutMs is set; a late answer is ignored (late: %p ms)",
    async (lateMs) => {
      const vt = new VirtualTime({ yieldMacrotask: tick });
      const host = new FakeHost({ seed: 42, endsAt: 100, seats: 2 });
      const agents = agentsOf(host, (seat) =>
        seat === "p2"
          ? lateMs === null
            ? hungAgent
            : thinkingAgent(vt, lateMs, () => ({ calls: [call("attack", { target: "p1" })] }))
          : thinkingAgent(vt, 1000, playRounds(2)),
      );
      const driver = createLockstepDriver({ roundTimeoutMs: 5000, time: vt });
      await vt.run(() => driver.run(host, agents));
      const lines = host.trace.map(describeRecord);
      expect(traceViolations(host.trace)).toEqual([]);
      expect(lines).toContain("turn p2#1 @0 timeout: no answer within 5000 ms");
      expect(lines.filter((l) => l.startsWith("exec p2"))).toEqual([]);
      expect(lines).toContain("turn p1#1 @0 end_turn");
      // Batch 0 waited for the timeout (5000 ms), batch 1 for p1's second round (1000 ms).
      expect(vt.nowMs()).toBe(6000);
      // The driver's timers are gone; only a late agent's own think timer can be left.
      expect(vt.pending).toBe(lateMs === null ? 0 : 1);
    },
  );

  test("without a round timeout, a hung agent is a virtual-time deadlock", async () => {
    const vt = new VirtualTime({ yieldMacrotask: tick });
    const host = new FakeHost({ seed: 1, endsAt: 100, seats: 1 });
    const agents = agentsOf(host, () => hungAgent);
    const error = await rejectionOf(vt.run(() => createLockstepDriver().run(host, agents)));
    expect(error).toBeInstanceOf(VirtualTimeDeadlock);
  });

  test("rejects invalid options", () => {
    expect(() => createLockstepDriver({ maxTurnsPerSecond: 0 })).toThrow(ClockError);
    expect(() => createLockstepDriver({ maxTurnsPerSecond: 1.5 })).toThrow(ClockError);
    expect(() => createLockstepDriver({ roundTimeoutMs: 5000 })).toThrow(
      "lockstep roundTimeoutMs needs a time source",
    );
    expect(() =>
      createLockstepDriver({
        roundTimeoutMs: 0,
        time: new VirtualTime({ yieldMacrotask: tick }),
      }),
    ).toThrow(ClockError);
  });

  test("fails loudly instead of looping when the host's nextTime() does not advance", async () => {
    class StuckHost extends FakeHost {
      override nextTime(): number | null {
        return this.ended() ? null : 0;
      }
    }
    const host = new StuckHost({ seed: 1, endsAt: 100, seats: 1 });
    const run = createLockstepDriver().run(
      host,
      agentsOf(host, () => scriptedAgent(playRounds(1))),
    );
    const error = await rejectionOf(run);
    expect(error).toBeInstanceOf(ClockError);
    expect(messageOf(error)).toBe(
      "host.nextTime() returned 0 after second 0 was played: lockstep needs strictly increasing times",
    );
  });

  test("random scenarios: strictly increasing times, the turn cap, determinism and replay (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          seed: fc.integer({ min: 0, max: 0xffffffff }),
          seats: fc.integer({ min: 1, max: 4 }),
          cap: fc.integer({ min: 1, max: 3 }),
          urgentGap: fc.integer({ min: 0, max: 5 }),
          groupWindow: fc.integer({ min: 0, max: 10 }),
          endsAt: fc.integer({ min: 1, max: 150 }),
        }),
        async (s) => {
          const options: FakeHostOptions = {
            seed: s.seed,
            endsAt: s.endsAt,
            seats: s.seats,
            urgentGap: s.urgentGap,
            groupWindow: s.groupWindow,
            safetyWake: 40,
          };
          const make = (): SeatAgent => scriptedAgent(randomScript(s.seed, s.seats));
          const a = await play(options, make, { maxTurnsPerSecond: s.cap });
          const b = await play(options, make, { maxTurnsPerSecond: s.cap });
          expect(b.lines).toEqual(a.lines);
          const advances = a.host.trace.flatMap((r) => (r.k === "advance" ? [r.t] : []));
          for (let i = 1; i < advances.length; i += 1) {
            expect(advances[i]!).toBeGreaterThan(advances[i - 1]!);
          }
          const perSecond = new Map<string, number>();
          for (const r of a.host.trace) {
            if (r.k !== "wake") continue;
            const key = `${r.seat}@${r.t}`;
            perSecond.set(key, (perSecond.get(key) ?? 0) + 1);
          }
          for (const count of perSecond.values()) expect(count).toBeLessThanOrEqual(s.cap);
          expect(a.host.trace.at(-1)).toEqual({ k: "end", t: s.endsAt });
          expect(replayFakeTrace(options, a.host.trace).trace).toEqual(a.host.trace);
        },
      ),
      { numRuns: 100 },
    );
  });
});
