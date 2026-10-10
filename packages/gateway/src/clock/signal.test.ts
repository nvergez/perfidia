import { describe, expect, test } from "bun:test";
import { Signal } from "./signal.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Whether `p` has settled after the pending microtasks and one macrotask. */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await tick();
  return done;
}

describe("Signal", () => {
  test("a notify before the wait is not lost (level-triggered)", async () => {
    const s = new Signal();
    s.notify();
    expect(s.raised).toBe(true);
    expect(await settled(s.wait().done)).toBe(true);
    expect(s.raised).toBe(true);
    expect(await settled(s.wait().done)).toBe(true);
  });

  test("a wait settles on the next notify, and clear lowers the flag", async () => {
    const s = new Signal();
    const w = s.wait();
    expect(await settled(w.done)).toBe(false);
    s.notify();
    expect(await settled(w.done)).toBe(true);
    s.clear();
    expect(s.raised).toBe(false);
    expect(await settled(s.wait().done)).toBe(false);
  });

  test("notify wakes every waiter", async () => {
    const s = new Signal();
    const waits = [s.wait(), s.wait(), s.wait()];
    expect(s.waiting).toBe(3);
    s.notify();
    expect(s.waiting).toBe(0);
    expect(await Promise.all(waits.map((w) => settled(w.done)))).toEqual([true, true, true]);
  });

  test("a cancelled wait is dropped and never settles", async () => {
    const s = new Signal();
    const w = s.wait();
    w.cancel();
    expect(s.waiting).toBe(0);
    s.notify();
    expect(await settled(w.done)).toBe(false);
  });
});
