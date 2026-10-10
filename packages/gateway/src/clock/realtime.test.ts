import { describe, expect, test } from "bun:test";
import { randInt, streamRng } from "@perfidia/engine/core";
import type { PlayerId, RoundInput, RoundOutput, SeatAgent, TimeSource } from "@perfidia/protocol";
import fc from "fast-check";
import { AgentRoundError, ClockError } from "./errors.ts";
import {
  call,
  describeRecord,
  FakeHost,
  type FakeHostOptions,
  playRounds,
  rejectionOf,
  type Script,
  scriptedAgent,
  thinkingAgent,
  traceViolations,
} from "./fake-host.ts";
import {
  createRealtimeDriver,
  type RealtimeOptions,
  type Speed,
  speedMapping,
} from "./realtime.ts";
import { VirtualTime } from "./virtual.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const SPEED_1: Speed = { num: 1, den: 1 };
/** One game second of think time at speed 1. */
const S = 1000;

type MakeAgent = (seat: PlayerId, time: TimeSource) => SeatAgent;

interface Played {
  readonly host: FakeHost;
  readonly vt: VirtualTime;
  readonly lines: string[];
  readonly iterations: number;
}

/** Runs a real-time match under `VirtualTime`, then checks the trace and that no timer is left. */
async function play(
  options: FakeHostOptions,
  make: MakeAgent,
  extra: Partial<Omit<RealtimeOptions, "time">> = {},
  host: FakeHost = new FakeHost(options),
): Promise<Played> {
  const vt = new VirtualTime({ yieldMacrotask: tick });
  const driver = createRealtimeDriver({ speed: SPEED_1, ...extra, time: vt });
  const agents = new Map(host.seats.map((seat) => [seat, make(seat, vt)]));
  await vt.run(() => driver.run(host, agents));
  expect(traceViolations(host.trace)).toEqual([]);
  expect(vt.pending).toBe(0);
  return {
    host,
    vt,
    lines: host.trace.map(describeRecord),
    iterations: driver.stats().iterations,
  };
}

/** p1 plays `p1`, every other seat `others` (default: ends each turn at once). */
function seats(p1: MakeAgent, others: MakeAgent = () => scriptedAgent(() => ({ calls: [] }))) {
  return (seat: PlayerId, time: TimeSource): SeatAgent =>
    seat === "p1" ? p1(seat, time) : others(seat, time);
}

const indexOf = (lines: readonly string[], line: string): number => {
  const i = lines.indexOf(line);
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Rounds 0 and 1: view, then attack p2; then end the turn. */
const viewAttackEnd: Script = (input) =>
  [{ calls: [call("view_city")] }, { calls: [call("attack", { target: "p2" })] }][input.round] ?? {
    calls: [call("end_turn")],
  };

/** Turn 1: five rounds, messaging itself first; later turns end at once. */
const messageSelfThenView: Script = (input) =>
  input.turn === 1
    ? playRounds(5, (i) =>
        i.round === 0 ? [call("send_message", { to: "p1" })] : [call("view_city")],
      )(input)
    : { calls: [call("end_turn")] };

const failingAgent: SeatAgent = {
  label: "test:failing@1",
  round: () => Promise.reject(new Error("boom")),
};

/** p2 fails at once; the others think 10 s per round and play two rounds. */
const p2Fails: MakeAgent = (seat, time) =>
  seat === "p2" ? failingAgent : thinkingAgent(time, 10 * S, playRounds(2));

const hungAgent: SeatAgent = {
  label: "test:hung@1",
  round: () => new Promise<RoundOutput>(() => undefined),
};

/** Four seats with seeded think times (1–60 s) and seeded calls: a busy, overlapping match. */
function scenario(seed: number): { options: FakeHostOptions; make: MakeAgent } {
  const script = (input: RoundInput): RoundOutput => {
    const rng = streamRng(seed, `${input.seat}:${input.turn}:${input.round}`);
    const target = `p${randInt(rng, 1, 4)}`;
    const action = [
      call("attack", { target }),
      call("send_message", { to: target }),
      call("view_city"),
    ][randInt(rng, 0, 2)]!;
    if (input.round < randInt(streamRng(seed, `${input.seat}:${input.turn}`), 0, 3)) {
      return { calls: [action] };
    }
    return {
      calls: [action, call("end_turn", { wakeAt: input.briefing.t + randInt(rng, 60, 900) })],
    };
  };
  const thinkMs = (input: RoundInput): number =>
    randInt(streamRng(seed, `think:${input.seat}:${input.turn}:${input.round}`), 1000, 60_000);
  return {
    options: { seed, endsAt: 4 * 3600, seats: 4, urgentGap: 300, groupWindow: 120 },
    make: (_seat, time) => thinkingAgent(time, thinkMs, script),
  };
}

describe("speedMapping", () => {
  test("examples: speed 3, speed 5/2, the end cap", () => {
    const m3 = speedMapping(1000, { num: 3, den: 1 }, 604800);
    expect([m3.gameAt(1000), m3.gameAt(1333), m3.gameAt(1334), m3.gameAt(2000)]).toEqual([
      0, 0, 1, 3,
    ]);
    expect([m3.wallAt(0), m3.wallAt(1), m3.wallAt(3)]).toEqual([1000, 1334, 2000]);
    const m52 = speedMapping(0, { num: 5, den: 2 }, 10);
    expect([m52.gameAt(1000), m52.wallAt(5), m52.gameAt(1_000_000)]).toEqual([2, 2000, 10]);
    // Beyond 1000 game-seconds per wall-second, one ms spans several game seconds.
    const fast = speedMapping(0, { num: 100800, den: 1 }, 604800);
    expect([fast.wallAt(1), fast.gameAt(fast.wallAt(1)), fast.gameAt(6000)]).toEqual([
      1, 100, 604800,
    ]);
  });

  test("rejects a speed that is not two positive integers", () => {
    expect(() => speedMapping(0, { num: 0, den: 1 }, 10)).toThrow(ClockError);
    expect(() => speedMapping(0, { num: 1, den: 1.5 }, 10)).toThrow(ClockError);
    const time = new VirtualTime({ yieldMacrotask: tick });
    expect(() => createRealtimeDriver({ speed: { num: 1, den: 0 }, time })).toThrow(ClockError);
    expect(() => createRealtimeDriver({ speed: SPEED_1, time, turnTimeoutMs: -1 })).toThrow(
      ClockError,
    );
  });

  const mapping = fc.record({
    wall0: fc.integer({ min: 0, max: 1_000_000_000 }),
    num: fc.integer({ min: 1, max: 200_000 }),
    den: fc.integer({ min: 1, max: 1000 }),
    endsAt: fc.integer({ min: 1, max: 1_000_000 }),
  });

  test("is monotone both ways and never passes the end (property)", () => {
    fc.assert(
      fc.property(
        mapping,
        fc.nat({ max: 1_000_000_000 }),
        fc.nat({ max: 1_000_000_000 }),
        fc.nat({ max: 1_000_000 }),
        fc.nat({ max: 1_000_000 }),
        (s, d1, d2, g1, g2) => {
          const m = speedMapping(s.wall0, { num: s.num, den: s.den }, s.endsAt);
          const [a, b] = [s.wall0 + Math.min(d1, d2), s.wall0 + Math.max(d1, d2)];
          expect(m.gameAt(a)).toBeLessThanOrEqual(m.gameAt(b));
          expect(m.gameAt(b)).toBeLessThanOrEqual(s.endsAt);
          expect(m.wallAt(Math.min(g1, g2))).toBeLessThanOrEqual(m.wallAt(Math.max(g1, g2)));
        },
      ),
    );
  });

  test("gameAt(wallAt(g)) = g up to 1000 game-seconds per wall-second (property)", () => {
    fc.assert(
      fc.property(
        mapping.filter((s) => s.num <= 1000 * s.den),
        fc.nat({ max: 1_000_000 }),
        (s, g0) => {
          const g = g0 % (s.endsAt + 1);
          const m = speedMapping(s.wall0, { num: s.num, den: s.den }, s.endsAt);
          expect(m.gameAt(m.wallAt(g))).toBe(g);
        },
      ),
    );
  });

  test("wallAt(g) is the first wall ms at which gameAt reaches g, at any speed (property)", () => {
    fc.assert(
      fc.property(mapping, fc.nat({ max: 1_000_000 }), (s, g0) => {
        const g = g0 % (s.endsAt + 1);
        const m = speedMapping(s.wall0, { num: s.num, den: s.den }, s.endsAt);
        const w = m.wallAt(g);
        expect(m.gameAt(w)).toBeGreaterThanOrEqual(g);
        if (w > s.wall0) expect(m.gameAt(w - 1)).toBeLessThan(g);
      }),
    );
  });
});

describe("real-time driver", () => {
  test("two seats can be in turns at once", async () => {
    let maxInTurn = 0;
    const { lines } = await play(
      {
        seed: 1,
        endsAt: 10_000,
        seats: 2,
        onCall: (h) => {
          maxInTurn = Math.max(maxInTurn, h.inTurn().length);
        },
      },
      (_seat, time) => thinkingAgent(time, 10 * S, playRounds(3)),
    );
    expect(maxInTurn).toBe(2);
    expect(lines.slice(0, 7)).toEqual([
      "start",
      "wake p1#1 @0",
      "wake p2#1 @0",
      "advance 10",
      "exec p1#1.0 @10 view_city",
      "exec p2#1.0 @10 view_city",
      "advance 20",
    ]);
    expect(lines).toContain("turn p1#1 @30 end_turn");
    expect(lines).toContain("turn p2#1 @30 end_turn");
  });

  test("one turn per seat: triggers during a seat's turn wait for its end", async () => {
    // p2 attacks p1 every 100 s while p1 plays a 3000 s turn (urgent gap 0).
    const { lines } = await play(
      { seed: 1, endsAt: 10_000, seats: 2, urgentGap: 0 },
      seats(
        (_seat, time) => thinkingAgent(time, (i) => (i.turn === 1 ? 1000 * S : 0), playRounds(3)),
        (_seat, time) =>
          thinkingAgent(
            time,
            100 * S,
            playRounds(5, () => [call("attack", { target: "p1" })]),
          ),
      ),
    );
    expect(lines.filter((l) => l.startsWith("wake p1"))).toEqual([
      "wake p1#1 @0",
      "wake p1#2 @3000",
    ]);
    expect(indexOf(lines, "turn p1#1 @3000 end_turn")).toBeLessThan(
      indexOf(lines, "wake p1#2 @3000"),
    );
  });

  const receipt: [string, Speed, number][] = [
    ["1", SPEED_1, 2],
    ["3", { num: 3, den: 1 }, 7],
    ["5/2", { num: 5, den: 2 }, 6],
  ];
  test.each(receipt)(
    "calls land at the game second of receipt (speed %s, an answer after 2500 ms)",
    async (_label, speed, t) => {
      const { lines } = await play(
        { seed: 1, endsAt: 1000, seats: 1 },
        (_seat, time) => thinkingAgent(time, 2500, playRounds(1)),
        { speed },
      );
      expect(lines).toContain(`exec p1#1.0 @${t} view_city,end_turn`);
    },
  );

  test("a finished turn wakes the loop: an urgent trigger pending at its end opens the next turn at once", async () => {
    const { lines } = await play(
      { seed: 1, endsAt: 10_000, seats: 2, events: [{ at: 500, trigger: "urgent", seat: "p1" }] },
      seats((_seat, time) =>
        thinkingAgent(time, (i) => (i.turn === 1 ? 1000 * S : 0), playRounds(2)),
      ),
    );
    expect(lines.slice(indexOf(lines, "ev urgent p1 @500"))).toEqual([
      "ev urgent p1 @500",
      "advance 500",
      "advance 1000",
      "exec p1#1.0 @1000 view_city",
      "advance 2000",
      "exec p1#1.1 @2000 view_city,end_turn",
      "turn p1#1 @2000 end_turn",
      "wake p1#2 @2000",
      "exec p1#2.0 @2000 view_city",
      "exec p1#2.1 @2000 view_city,end_turn",
      "turn p1#2 @2000 end_turn",
      "advance 10000",
      "ended @10000",
      "end @10000",
    ]);
  });

  test("a turn closed by a timeout, with no call to apply, also wakes the loop", async () => {
    const p1: SeatAgent = {
      label: "test:hangs-once@1",
      round: (input) =>
        input.turn === 1
          ? new Promise<RoundOutput>(() => undefined)
          : Promise.resolve({ calls: [call("end_turn")] }),
    };
    const { lines } = await play(
      { seed: 1, endsAt: 10_000, seats: 2, events: [{ at: 500, trigger: "urgent", seat: "p1" }] },
      seats(() => p1),
      { turnTimeoutMs: 3000 * S },
    );
    expect(lines.slice(indexOf(lines, "ev urgent p1 @500"))).toEqual([
      "ev urgent p1 @500",
      "advance 500",
      "advance 3000",
      "turn p1#1 @3000 timeout: no answer within 3000000 ms",
      "wake p1#2 @3000",
      "exec p1#2.0 @3000 end_turn",
      "turn p1#2 @3000 end_turn",
      "advance 10000",
      "ended @10000",
      "end @10000",
    ]);
  });

  test("in-flight turns finish after the end; their calls land at the end time", async () => {
    const options = { seed: 1, endsAt: 100, seats: 1 };
    const think: MakeAgent = (_seat, time) => thinkingAgent(time, 40 * S, playRounds(4));
    const open = await play({ ...options, doneOnEnd: false }, think);
    expect(open.lines).toEqual([
      "start",
      "wake p1#1 @0",
      "advance 40",
      "exec p1#1.0 @40 view_city",
      "advance 80",
      "exec p1#1.1 @80 view_city",
      "advance 100",
      "ended @100",
      "exec p1#1.2 @100 view_city!MATCH_ENDED",
      "exec p1#1.3 @100 view_city!MATCH_ENDED,end_turn!MATCH_ENDED",
      "turn p1#1 @100 end_turn",
      "end @100",
    ]);
    expect(open.vt.nowMs()).toBe(160 * S);
    const done = await play(options, think);
    expect(done.lines.slice(-4)).toEqual([
      "ended @100",
      "exec p1#1.2 @100 view_city!MATCH_ENDED",
      "turn p1#1 @100 match_ended",
      "end @100",
    ]);
  });

  test("a match won early stops game time: in-flight calls land at the winning second", async () => {
    const { lines } = await play(
      {
        seed: 1,
        endsAt: 10_000,
        seats: 2,
        onCall: (h, _seat, c) => {
          if (c.tool === "found_city") h.endMatch();
        },
      },
      seats(
        (_seat, time) => thinkingAgent(time, 50 * S, () => ({ calls: [call("found_city")] })),
        (_seat, time) => thinkingAgent(time, 80 * S, playRounds(3)),
      ),
    );
    expect(lines.slice(indexOf(lines, "ended @50"))).toEqual([
      "ended @50",
      "exec p1#1.0 @50 found_city",
      "turn p1#1 @50 match_ended",
      "exec p2#1.0 @50 view_city!MATCH_ENDED",
      "turn p2#1 @50 match_ended",
      "end @50",
    ]);
  });

  test("an action during A's long turn that makes idle B urgently due opens B's turn at that second", async () => {
    const { lines, iterations } = await play(
      { seed: 1, endsAt: 20_000, seats: 2 },
      seats(
        (_seat, time) => thinkingAgent(time, 1000 * S, viewAttackEnd),
        () => scriptedAgent((i) => (i.turn === 1 ? { calls: [] } : { calls: [call("end_turn")] })),
      ),
    );
    expect(lines.slice(indexOf(lines, "exec p1#1.1 @2000 attack"))).toEqual([
      "exec p1#1.1 @2000 attack",
      "wake p2#2 @2000",
      "exec p2#2.0 @2000 end_turn",
      "turn p2#2 @2000 end_turn",
      "advance 3000",
      "exec p1#1.2 @3000 end_turn",
      "turn p1#1 @3000 end_turn",
      "advance 20000",
      "ended @20000",
      "end @20000",
    ]);
    expect(iterations).toBeLessThanOrEqual(12);
  });

  test("a normal trigger during the seat's own long turn: no deadlock, bounded loop iterations", async () => {
    // p1 messages itself at 1000 s, early in a 5000 s turn: the trigger's window (600 s) ends long
    // before the turn does, and the next wake is the turn's end + 1.
    const { lines, iterations } = await play(
      { seed: 1, endsAt: 8000, seats: 2, groupWindow: 600 },
      seats((_seat, time) =>
        thinkingAgent(time, (i) => (i.turn === 1 ? 1000 * S : 0), messageSelfThenView),
      ),
    );
    expect(lines).toContain("turn p1#1 @5000 end_turn");
    expect(lines.filter((l) => l.startsWith("wake p1"))).toEqual([
      "wake p1#1 @0",
      "wake p1#2 @5001",
    ]);
    expect(lines.at(-1)).toBe("end @8000");
    expect(iterations).toBeLessThanOrEqual(15);
  });

  test("never sleeps until a time <= now: a host reporting a due time in the past cannot make it spin", async () => {
    class EagerHost extends FakeHost {
      override nextTime(): number | null {
        const next = super.nextTime();
        return next === null ? null : Math.min(next, this.now());
      }
    }
    const options = { seed: 1, endsAt: 300, seats: 1 };
    const { lines, iterations } = await play(
      options,
      (_seat, time) => thinkingAgent(time, 100 * S, playRounds(3)),
      {},
      new EagerHost(options),
    );
    expect(lines.at(-1)).toBe("end @300");
    // At least one game second per iteration.
    expect(iterations).toBeLessThanOrEqual(300 + 5);
  });

  test("an agent error closes only its turn; strict mode makes it fatal", async () => {
    const { lines } = await play({ seed: 1, endsAt: 100, seats: 2 }, p2Fails);
    expect(lines.slice(0, 4)).toEqual([
      "start",
      "wake p1#1 @0",
      "wake p2#1 @0",
      "turn p2#1 @0 error: Error: boom",
    ]);
    expect(lines).toContain("turn p1#1 @20 end_turn");

    const vt = new VirtualTime({ yieldMacrotask: tick });
    const host = new FakeHost({ seed: 1, endsAt: 100, seats: 2 });
    const driver = createRealtimeDriver({ speed: SPEED_1, time: vt, strict: true });
    const agents = new Map(host.seats.map((seat) => [seat, p2Fails(seat, vt)]));
    const run = vt.run(() => driver.run(host, agents));
    expect(await rejectionOf(run)).toBeInstanceOf(AgentRoundError);
    expect(host.trace.map(describeRecord)).toContain("turn p2#1 @0 error: Error: boom");
    expect(host.finished).toBe(false);
  });

  test("turnTimeoutMs closes a hung agent's turn at the second it expires, and leaves no timer behind", async () => {
    const { lines } = await play(
      { seed: 1, endsAt: 100, seats: 3 },
      (seat, time) =>
        seat === "p2"
          ? hungAgent
          : thinkingAgent(time, seat === "p1" ? 1 * S : 8 * S, playRounds(2)),
      { turnTimeoutMs: 5 * S },
    );
    // p1 answers within the bound each round; p3 thinks 8 s, so its round times out at 5 s too.
    expect(lines.filter((l) => l.startsWith("turn"))).toEqual([
      "turn p1#1 @2 end_turn",
      "turn p2#1 @5 timeout: no answer within 5000 ms",
      "turn p3#1 @5 timeout: no answer within 5000 ms",
    ]);
  });

  test("a host failure during a turn stops the run: it rejects and calls the host no more", async () => {
    const vt = new VirtualTime({ yieldMacrotask: tick });
    const host = new FakeHost({
      seed: 1,
      endsAt: 1000,
      seats: 2,
      onCall: (_h, _seat, c) => {
        if (c.tool === "explode") throw new Error("engine bug");
      },
    });
    const driver = createRealtimeDriver({ speed: SPEED_1, time: vt, turnTimeoutMs: 500 * S });
    const agents = new Map<PlayerId, SeatAgent>([
      ["p1", thinkingAgent(vt, 10 * S, () => ({ calls: [call("explode")] }))],
      ["p2", thinkingAgent(vt, 200 * S, playRounds(1))],
    ]);
    expect(messageOf(await rejectionOf(vt.run(() => driver.run(host, agents))))).toBe("engine bug");
    const length = host.trace.length;
    expect(host.finished).toBe(false);
    // p2's own think timer may still fire; the driver must not touch the host afterwards.
    await vt.run(() => vt.sleepUntil(vt.nowMs() + 1000 * S).done);
    expect(host.trace.length).toBe(length);
  });

  test("a driver runs one match at a time", async () => {
    const vt = new VirtualTime({ yieldMacrotask: tick });
    const driver = createRealtimeDriver({ speed: SPEED_1, time: vt });
    const a = new FakeHost({ seed: 1, endsAt: 10, seats: 1 });
    const b = new FakeHost({ seed: 1, endsAt: 10, seats: 1 });
    const agents = new Map<PlayerId, SeatAgent>([["p1", scriptedAgent(playRounds(1))]]);
    const first = vt.run(() => driver.run(a, agents));
    expect(messageOf(await rejectionOf(driver.run(b, agents)))).toBe(
      "this real-time driver is already running a match",
    );
    await first;
    expect(driver.stats().turns).toBe(1);
  });
});

describe("real time under VirtualTime", () => {
  test("the same scenario twice gives identical traces", async () => {
    const { options, make } = scenario(11);
    const speed = { num: 20, den: 1 };
    const a = await play(options, make, { speed });
    const b = await play(options, make, { speed });
    expect(b.lines).toEqual(a.lines);
    expect(b.vt.nowMs()).toBe(a.vt.nowMs());
    expect(a.lines.filter((l) => l.startsWith("wake")).length).toBeGreaterThan(20);
  });

  test("matches running side by side, each on its own VirtualTime, equal their solo runs", async () => {
    const speed = { num: 20, den: 1 };
    const s1 = scenario(1);
    const s2 = scenario(2);
    const solo1 = await play(s1.options, s1.make, { speed });
    const solo2 = await play(s2.options, s2.make, { speed });
    const [both1, both2] = await Promise.all([
      play(s1.options, s1.make, { speed }),
      play(s2.options, s2.make, { speed }),
    ]);
    expect(both1.lines).toEqual(solo1.lines);
    expect(both2.lines).toEqual(solo2.lines);
    expect(solo1.lines).not.toEqual(solo2.lines);
  });
});
