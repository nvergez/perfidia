import { describe, expect, test } from "bun:test";
import type { RoundInput, SeatAgent, Sleep } from "@perfidia/protocol";
import { answering, FakeHost } from "./fake-host.ts";
import { playRound } from "./round.ts";
import { VirtualTime } from "./virtual.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function sampleInput(): RoundInput {
  const host = new FakeHost({ seed: 1, endsAt: 100, seats: 1 });
  host.start();
  return host.openTurn("p1").input();
}

const agent = (round: SeatAgent["round"]): SeatAgent => ({ label: "test:round@1", round });

describe("playRound", () => {
  test("passes a valid output through", async () => {
    const r = await playRound(
      agent(() => Promise.resolve({ calls: [{ tool: "view_city", args: {} }], thought: "hi" })),
      sampleInput(),
    );
    expect(r).toEqual({
      ok: true,
      out: { calls: [{ tool: "view_city", args: {} }], thought: "hi" },
    });
  });

  test("turns every agent failure into a settlement, never a rejection", async () => {
    const input = sampleInput();
    expect(await playRound(undefined, input)).toEqual({
      ok: false,
      error: "no agent for seat p1",
      cause: "error",
    });
    expect(
      await playRound(
        agent(() => Promise.reject(new TypeError("bad"))),
        input,
      ),
    ).toEqual({
      ok: false,
      error: "TypeError: bad",
      cause: "error",
    });
    const syncThrow = agent(() => {
      throw new Error("sync");
    });
    expect(await playRound(syncThrow, input)).toEqual({
      ok: false,
      error: "Error: sync",
      cause: "error",
    });
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- an agent may reject with anything
    const plain = agent(() => Promise.reject("plain"));
    expect(await playRound(plain, input)).toEqual({
      ok: false,
      error: "plain",
      cause: "error",
    });
  });

  test("rejects an answer that is not a RoundOutput, naming the path", async () => {
    const input = sampleInput();
    const r1 = await playRound(answering(null), input);
    expect(r1.ok).toBe(false);
    expect(r1.ok ? "" : r1.error).toStartWith("invalid round output: ");
    const r2 = await playRound(answering({ calls: [{ tool: 7 }] }), input);
    expect(r2.ok ? "" : r2.error).toStartWith("invalid round output: calls.0.tool: ");
    const r3 = await playRound(answering({ calls: [], thought: 3 }), input);
    expect(r3.ok ? "" : r3.error).toStartWith("invalid round output: thought: ");
  });

  test("times out a hung round, ignores a late answer and cancels its timer", async () => {
    const vt = new VirtualTime({ yieldMacrotask: tick });
    const input = sampleInput();
    const timers = new Set<Sleep>();
    const hung = agent(() => new Promise(() => undefined));
    const r = await vt.run(() => playRound(hung, input, { time: vt, ms: 5000 }, timers));
    expect(r).toEqual({ ok: false, error: "no answer within 5000 ms", cause: "timeout" });
    expect(vt.nowMs()).toBe(5000);
    expect(timers.size).toBe(0);

    const late = agent(async () => {
      await vt.sleepUntil(vt.nowMs() + 8000).done;
      return { calls: [{ tool: "attack", args: {} }] };
    });
    const r2 = await vt.run(() => playRound(late, input, { time: vt, ms: 5000 }));
    expect(r2.ok).toBe(false);
    expect(vt.nowMs()).toBe(10_000);

    const quick = agent(async () => {
      await vt.sleepUntil(vt.nowMs() + 10).done;
      return { calls: [] };
    });
    const r3 = await vt.run(() => playRound(quick, input, { time: vt, ms: 5000 }, timers));
    expect(r3).toEqual({ ok: true, out: { calls: [] } });
    expect(timers.size).toBe(0);
    // Only the late agent's own sleep is left (it outlives its timed-out round); the timeouts are gone.
    expect(vt.pending).toBe(1);
  });
});
