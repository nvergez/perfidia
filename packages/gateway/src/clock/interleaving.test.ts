import { describe, expect, test } from "bun:test";
import { randInt, streamRng } from "@perfidia/engine/core";
import type {
  PlayerId,
  RoundInput,
  RoundOutput,
  SeatAgent,
  Sleep,
  TimeSource,
} from "@perfidia/protocol";
import fc from "fast-check";
import {
  call,
  FakeHost,
  type FakeHostOptions,
  type FakeRecord,
  replayFakeTrace,
  traceViolations,
} from "./testkit.test.ts";
import { createLockstepDriver } from "./lockstep.ts";
import { createRealtimeDriver } from "./realtime.ts";

// Interleavings explored with fc.scheduler (§9.4): every agent answer and every timer is a task the
// scheduler releases in an order it picks.

/** A seeded script: 1–3 rounds per turn of attacks, messages and views, then `end_turn` with a self-wake. */
function script(seed: number, seats: number) {
  return (input: RoundInput): RoundOutput => {
    const rng = streamRng(seed, `${input.seat}:${input.turn}:${input.round}`);
    const target = `p${randInt(rng, 1, seats)}`;
    const action = [
      call("attack", { target }),
      call("send_message", { to: target }),
      call("view_city"),
    ][randInt(rng, 0, 2)]!;
    if (input.round + 1 < randInt(streamRng(seed, `${input.seat}:${input.turn}`), 1, 3)) {
      return { calls: [action] };
    }
    return {
      calls: [action, call("end_turn", { wakeAt: input.briefing.t + randInt(rng, 5, 40) })],
    };
  };
}

/** Records every round asked, so a test can check that each round is asked (and so resolves) once. */
function askLog(): { readonly keys: string[]; ask(input: RoundInput): void } {
  const keys: string[] = [];
  return { keys, ask: (input) => void keys.push(`${input.seat}#${input.turn}.${input.round}`) };
}

const unique = (keys: readonly string[]): boolean => new Set(keys).size === keys.length;

type CountedTime = TimeSource & { live(): number };

/**
 * One clock whose timers fire when the scheduler releases them (time jumps to each fired
 * deadline), seen through two `TimeSource`s that count their own live timers: the driver's and the
 * agents' (an agent's think timer may outlive a round that timed out).
 */
function scheduledClock(s: fc.Scheduler): { driver: CountedTime; agents: CountedTime } {
  let now = 0;
  const view = (owner: string): CountedTime => {
    let live = 0;
    return {
      nowMs: () => now,
      sleepUntil(ms: number): Sleep {
        let state: "live" | "fired" | "cancelled" = "live";
        live += 1;
        const { promise, resolve } = Promise.withResolvers<void>();
        void s.schedule(Promise.resolve(), `${owner} sleeps until ${ms}`).then(() => {
          if (state !== "live") return;
          state = "fired";
          live -= 1;
          now = Math.max(now, ms);
          resolve();
        });
        return {
          done: promise,
          cancel: () => {
            if (state !== "live") return;
            state = "cancelled";
            live -= 1;
          },
        };
      },
      live: () => live,
    };
  };
  return { driver: view("driver"), agents: view("agent") };
}

describe("interleavings (fc.scheduler)", () => {
  test("lockstep: the trace does not depend on the order in which agents answer", async () => {
    const options: FakeHostOptions = {
      seed: 5,
      endsAt: 150,
      seats: 4,
      urgentGap: 0,
      groupWindow: 5,
      safetyWake: 60,
    };
    const play = script(5, 4);
    const reference = new FakeHost(options);
    await createLockstepDriver().run(
      reference,
      new Map(
        reference.seats.map((seat) => [
          seat,
          { label: "s@1", round: (i: RoundInput) => Promise.resolve(play(i)) },
        ]),
      ),
    );
    expect(traceViolations(reference.trace)).toEqual([]);

    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async (s) => {
        const host = new FakeHost(options);
        const log = askLog();
        const agents = new Map<PlayerId, SeatAgent>(
          host.seats.map((seat) => [
            seat,
            {
              label: "scheduled@1",
              round: (input: RoundInput) => {
                log.ask(input);
                return s.schedule(
                  Promise.resolve(play(input)),
                  `${input.seat}#${input.turn}.${input.round}`,
                );
              },
            },
          ]),
        );
        await s.waitFor(createLockstepDriver().run(host, agents));
        expect(host.trace).toEqual(reference.trace);
        expect(unique(log.keys)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  test("real time: one turn per seat, consistent order, every round once, replay passes, no timer left", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.boolean(),
        async (s, seed, withTimeout) => {
          // Engine events every 15 s keep the loop's next deadline near, so the scheduler reaches
          // the end only after many loop cycles, with turns opening and closing in between.
          const options: FakeHostOptions = {
            seed,
            endsAt: 600,
            seats: 3,
            urgentGap: 5,
            groupWindow: 10,
            safetyWake: 120,
            events: Array.from({ length: 39 }, (_, k) => ({
              at: 15 * (k + 1),
              trigger: k % 4 === 0 ? ("urgent" as const) : ("normal" as const),
              seat: `p${(k % 3) + 1}` as const,
            })),
          };
          const clock = scheduledClock(s);
          const host = new FakeHost(options);
          const log = askLog();
          const play = script(seed, 3);
          const agents = new Map<PlayerId, SeatAgent>(
            host.seats.map((seat) => [
              seat,
              {
                label: "scheduled@1",
                async round(input: RoundInput): Promise<RoundOutput> {
                  log.ask(input);
                  const key = `${input.seat}:${input.turn}:${input.round}`;
                  // With a timeout, one round in ten hangs and only the timeout can end it.
                  if (withTimeout && randInt(streamRng(seed, `hang:${key}`), 0, 9) === 0) {
                    return new Promise<RoundOutput>(() => undefined);
                  }
                  const think = randInt(streamRng(seed, `think:${key}`), 1000, 20_000);
                  await clock.agents.sleepUntil(clock.agents.nowMs() + think).done;
                  return play(input);
                },
              },
            ]),
          );
          const driver = createRealtimeDriver({
            speed: { num: 1, den: 1 },
            time: clock.driver,
            ...(withTimeout ? { turnTimeoutMs: 30_000 } : {}),
          });
          await s.waitFor(driver.run(host, agents));

          expect(traceViolations(host.trace)).toEqual([]);
          expect(host.trace.at(-1)).toEqual({ k: "end", t: host.now() });
          expect(unique(log.keys)).toBe(true);
          const executed = host.trace.filter(
            (r): r is Extract<FakeRecord, { k: "exec" }> => r.k === "exec",
          );
          expect(unique(executed.map((r) => `${r.seat}#${r.turn}.${r.round}`))).toBe(true);
          expect(executed.length).toBeLessThanOrEqual(log.keys.length);
          expect(replayFakeTrace(options, host.trace).trace).toEqual(host.trace);
          expect(clock.driver.live()).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
