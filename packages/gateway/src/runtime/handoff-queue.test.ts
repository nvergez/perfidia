// Hand-offs decided while the match runs (`HandoffQueue`, §8.7): the host polls the queue when a
// seat's turn opens, after the static hand-offs, writes the same `controller` line before the
// `wake` line, and plays the seat's later turns with the new agent. Level E and the gateway
// rebuild (§10.5) hold in both clocks; a queue that throws or answers garbage stops the match.

import { describe, expect, test } from "bun:test";
import { verifyLog, type AnyRuleset } from "@perfidia/engine";
import { canonicalJson } from "@perfidia/engine/core";
import { VirtualTime } from "@perfidia/gateway/clock";
import type { LogLine, PlayerId, SeatAgent } from "@perfidia/protocol";
import {
  HostFailure,
  MemorySink,
  rebuildGatewayState,
  runMatch,
  type HandoffQueue,
  type QueuedHandoff,
  type RunMatchOptions,
} from "./index.ts";
import { SANDBOX, Scripted, agentsFor, call, linesOf, setupOf } from "./testkit.test.ts";

const hourly = (label: string): Scripted =>
  new Scripted(label, () => ({ calls: [call("end_turn", { nextWakeIn: 3600 })] }));

/** Hands `seat` to `next` when its `nth` turn opens; records every poll. */
class NthTurnQueue implements HandoffQueue {
  readonly polls: [PlayerId, number][] = [];
  private seen = 0;

  constructor(
    private readonly seat: PlayerId,
    private readonly nth: number,
    private readonly next: QueuedHandoff,
  ) {}

  take(seat: PlayerId, t: number): QueuedHandoff | null {
    this.polls.push([seat, t]);
    if (seat !== this.seat) return null;
    this.seen += 1;
    return this.seen === this.nth ? this.next : null;
  }
}

const resolve = (ruleset: AnyRuleset) => (ref: string) =>
  ref === ruleset.ref ? ruleset : undefined;

async function play(
  clock: "lockstep" | "virtual",
  queue: HandoffQueue,
  extra: Partial<Pick<RunMatchOptions, "handoffs" | "agents">> = {},
): Promise<{ lines: LogLine[]; live: string }> {
  const setup = setupOf(SANDBOX, 3, { "time.matchEnd": 14400 });
  const virtual =
    clock === "virtual"
      ? new VirtualTime({ yieldMacrotask: () => new Promise((r) => setImmediate(r)) })
      : null;
  const sink = new MemorySink();
  const options: RunMatchOptions = {
    setup,
    ruleset: SANDBOX,
    agents: extra.agents ?? agentsFor(setup, { p2: hourly("test:first") }),
    clock:
      virtual === null
        ? { kind: "lockstep" }
        : { kind: "realtime", speed: { num: 3, den: 1 }, time: virtual, timeKind: "virtual" },
    sink,
    strict: true,
    invariants: "step",
    handoffQueue: queue,
    ...(extra.handoffs === undefined ? {} : { handoffs: extra.handoffs }),
  };
  const out = await (virtual === null ? runMatch(options) : virtual.run(() => runMatch(options)));
  return { lines: sink.parsed(), live: canonicalJson(out.gateway) };
}

describe("HandoffQueue", () => {
  for (const clock of ["lockstep", "virtual"] as const) {
    test(`${clock}: p2 handed over at its third turn; Level E and the rebuild hold`, async () => {
      const second = hourly("test:second");
      const queue = new NthTurnQueue("p2", 3, { label: "bot:second@1", agent: second });
      const { lines, live } = await play(clock, queue);

      expect(lines[0]).toMatchObject({ k: "header", controllers: { p2: "test:first" } });
      const controllers = linesOf(lines, "controller");
      expect(controllers).toHaveLength(1);
      const wakes = linesOf(lines, "wake").filter((l) => l.seat === "p2");
      const third = wakes[2];
      expect(third).toBeDefined();
      expect(controllers[0]).toEqual({
        k: "controller",
        t: third?.t ?? -1,
        seat: "p2",
        label: "bot:second@1",
      });
      const i = lines.findIndex((l) => l.k === "controller");
      expect(lines[i + 1]).toMatchObject({ k: "wake", seat: "p2", turn: 3 });
      // Turns 1 and 2 by the first agent, every later turn by the new one.
      expect(second.inputs.length).toBeGreaterThan(0);
      expect(second.inputs.every((x) => x.turn >= 3)).toBe(true);
      // Every opened turn polled the queue once.
      expect(queue.polls).toHaveLength(linesOf(lines, "wake").length);

      const report = verifyLog(lines, resolve(SANDBOX));
      expect(report.divergence).toBeUndefined();
      expect(report.ok).toBe(true);
      const rebuilt = rebuildGatewayState(lines, resolve(SANDBOX));
      expect(rebuilt.drift).toBeNull();
      expect(rebuilt.ok).toBe(true);
      expect(canonicalJson(rebuilt.gw)).toBe(live);
    });
  }

  test("the queue is polled after the static hand-offs of the same turn", async () => {
    const setup = setupOf(SANDBOX, 3, { "time.matchEnd": 14400 });
    const fromStatic = hourly("test:static");
    const fromQueue = hourly("test:queued");
    const queue = new NthTurnQueue("p2", 2, { label: "bot:queued@1", agent: fromQueue });
    const { lines } = await play("lockstep", queue, {
      agents: agentsFor(setup, { p2: hourly("test:first") }),
      handoffs: [{ seat: "p2", at: 1, label: "test:static", agent: fromStatic }],
    });
    const controllers = linesOf(lines, "controller");
    expect(controllers.map((l) => l.label)).toEqual(["test:static", "bot:queued@1"]);
    expect(controllers[0]?.t).toBe(controllers[1]?.t);
    expect(fromStatic.inputs).toHaveLength(0);
    expect(fromQueue.inputs.length).toBeGreaterThan(0);
    expect(verifyLog(lines, resolve(SANDBOX)).ok).toBe(true);
  });

  const broken: [string, () => QueuedHandoff][] = [
    [
      "throws",
      () => {
        throw new Error("queue bug");
      },
    ],
    ["answers an empty label", () => ({ label: "", agent: hourly("test:x") })],
    ["answers an agent without a label", () => ({ label: "bot:x@1", agent: hourly("") })],
  ];
  for (const [what, answer] of broken) {
    test(`a queue that ${what} stops the match with a fatal line (HostFailure)`, async () => {
      const setup = setupOf(SANDBOX, 2, { "time.matchEnd": 7200 });
      const sink = new MemorySink();
      const queue = {
        take: (seat: PlayerId, t: number): QueuedHandoff | null =>
          seat === "p2" && t > 0 ? answer() : null,
      };
      const agents = new Map<PlayerId, SeatAgent>(
        setup.seats.map((s) => [s.id, hourly(`test:${s.id}`)]),
      );
      const error = await runMatch({
        setup,
        ruleset: SANDBOX,
        agents,
        clock: { kind: "lockstep" },
        sink,
        handoffQueue: queue,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(HostFailure);
      const lines = sink.parsed();
      expect(linesOf(lines, "controller")).toHaveLength(0);
      expect(lines.at(-1)).toMatchObject({ k: "fatal", t: 3600, error: { kind: "driver" } });
    });
  }
});
