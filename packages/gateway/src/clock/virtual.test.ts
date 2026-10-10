import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { rejectionOf } from "./fake-host.ts";
import { VirtualTime, VirtualTimeDeadlock } from "./virtual.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const virtualTime = (startMs = 0): VirtualTime =>
  new VirtualTime({ yieldMacrotask: tick, startMs });

// Each task sleeps a list of delays and logs each wake-up; the log depends only on the delays.
async function sleepers(delays: readonly (readonly number[])[]): Promise<string[]> {
  const vt = virtualTime();
  const log: string[] = [];
  await vt.run(() =>
    Promise.all(
      delays.map(async (list, task) => {
        for (const [step, delay] of list.entries()) {
          // oxlint-disable-next-line no-await-in-loop -- each task sleeps its delays one after the other
          await vt.sleepUntil(vt.nowMs() + delay).done;
          log.push(`${task}.${step}@${vt.nowMs()}`);
        }
      }),
    ),
  );
  expect(vt.pending).toBe(0);
  return log;
}

describe("VirtualTime", () => {
  test("fires timers in (deadline, creation) order and jumps to each deadline", async () => {
    const vt = virtualTime();
    const fired: string[] = [];
    const sleep = (ms: number, name: string): Promise<void> =>
      vt.sleepUntil(ms).done.then(() => {
        fired.push(`${name}@${vt.nowMs()}`);
      });
    await vt.run(() =>
      Promise.all([sleep(300, "c"), sleep(100, "a"), sleep(300, "d"), sleep(100, "b")]),
    );
    expect(fired).toEqual(["a@100", "b@100", "c@300", "d@300"]);
    expect(vt.nowMs()).toBe(300);
    expect(vt.pending).toBe(0);
  });

  test("fires one timer per macrotask yield: a timer's microtasks drain before the next timer, even at the same deadline", async () => {
    const vt = virtualTime();
    const log: string[] = [];
    const at = (name: string): void => void log.push(`${name}@${vt.nowMs()}`);
    await vt.run(() =>
      Promise.all([
        (async () => {
          await vt.sleepUntil(100).done;
          at("a0");
          await Promise.resolve();
          at("a1");
          await Promise.resolve();
          at("a2");
          await vt.sleepUntil(vt.nowMs()).done;
          at("a3");
        })(),
        (async () => {
          await vt.sleepUntil(100).done;
          at("b0");
        })(),
      ]),
    );
    // Firing every timer due at 100 in one step would give a0, b0, a1, a2, a3 instead.
    expect(log).toEqual(["a0@100", "a1@100", "a2@100", "b0@100", "a3@100"]);
    expect(vt.pending).toBe(0);
  });

  test("drops cancelled timers: time never jumps to a dead deadline", async () => {
    const vt = virtualTime();
    const dead = vt.sleepUntil(10_000);
    let deadFired = false;
    void dead.done.then(() => {
      deadFired = true;
    });
    expect(vt.pending).toBe(1);
    dead.cancel();
    dead.cancel();
    expect(vt.pending).toBe(0);
    await vt.run(() => vt.sleepUntil(500).done);
    expect(vt.nowMs()).toBe(500);
    expect(deadFired).toBe(false);
  });

  test("a deadline in the past fires at the current time; time never goes back", async () => {
    const vt = virtualTime(1000);
    const seen: number[] = [];
    await vt.run(async () => {
      await vt.sleepUntil(1500).done;
      seen.push(vt.nowMs());
      await vt.sleepUntil(200).done;
      seen.push(vt.nowMs());
    });
    expect(seen).toEqual([1500, 1500]);
  });

  test("returns the main task's value and rethrows its error", async () => {
    const vt = virtualTime();
    expect(await vt.run(Promise.resolve(42))).toBe(42);
    const failing = vt.run(async () => {
      await vt.sleepUntil(5).done;
      throw new Error("boom");
    });
    const error = await rejectionOf(failing);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", "boom");
  });

  test("throws VirtualTimeDeadlock when the task is pending and no timer is left", async () => {
    const vt = virtualTime();
    const stuck = vt.run(async () => {
      await vt.sleepUntil(250).done;
      await new Promise<void>(() => undefined);
    });
    const error = await rejectionOf(stuck);
    expect(error).toBeInstanceOf(VirtualTimeDeadlock);
    expect(error instanceof VirtualTimeDeadlock ? error.atMs : null).toBe(250);
  });

  test("one run at a time per instance; separate instances run side by side", async () => {
    const vt = virtualTime();
    const first = vt.run(() => vt.sleepUntil(10).done);
    expect(await rejectionOf(vt.run(Promise.resolve(1)))).toHaveProperty(
      "message",
      "VirtualTime.run is already running on this instance",
    );
    await first;
    const a = virtualTime();
    const b = virtualTime();
    const [x, y] = await Promise.all([
      a.run(async () => {
        await a.sleepUntil(1000).done;
        return a.nowMs();
      }),
      b.run(async () => {
        await b.sleepUntil(7).done;
        return b.nowMs();
      }),
    ]);
    expect([x, y]).toEqual([1000, 7]);
  });

  test("rejects a deadline that is not an integer", () => {
    const vt = virtualTime();
    expect(() => vt.sleepUntil(1.5)).toThrow(RangeError);
    expect(() => vt.sleepUntil(Number.NaN)).toThrow(RangeError);
  });

  test("interleaves sleeping tasks identically on every run (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.integer({ min: 0, max: 50 }), { maxLength: 5 }), { maxLength: 4 }),
        async (delays) => {
          expect(await sleepers(delays)).toEqual(await sleepers(delays));
        },
      ),
      { numRuns: 50 },
    );
  });
});
