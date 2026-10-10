import { describe, expect, test } from "bun:test";
import type { RoundInput, SeatAgent, Sleep, TimeSource } from "@perfidia/protocol";
import { describeError, UNPRINTABLE_ERROR } from "./errors.ts";
import { answering, FakeHost, hostileAnswer, revokedError, unprintableError } from "./fake-host.ts";
import { playRound, type RoundSettlement, settlementOf } from "./round.ts";
import { VirtualTime } from "./virtual.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function sampleInput(): RoundInput {
  const host = new FakeHost({ seed: 1, endsAt: 100, seats: 1 });
  host.start();
  return host.openTurn("p1").input();
}

const agent = (round: SeatAgent["round"]): SeatAgent => ({ label: "test:round@1", round });

const failure = (error: string): RoundSettlement => ({ ok: false, error, cause: "error" });

/** An object whose every property read throws, `then` included only when `then` is true. */
const trap = (then: boolean): object =>
  new Proxy(
    {},
    {
      get: (_target, key): undefined => {
        if (key === "then" && !then) return undefined;
        throw new Error(`get trap: ${String(key)}`);
      },
    },
  );

describe("describeError", () => {
  test("one line per thrown value: Error name and message, a string, anything else", () => {
    expect(describeError(new TypeError("bad"))).toBe("TypeError: bad");
    expect(describeError("plain")).toBe("plain");
    expect(describeError(42)).toBe("non-Error thrown: 42");
    expect(describeError(undefined)).toBe("non-Error thrown: undefined");
  });

  test("is total: a value it cannot print gives a fixed line instead of a throw", () => {
    const symbolName = new Error("x");
    Object.defineProperty(symbolName, "name", { value: Symbol("weird") });
    const noToString = {
      toString: (): never => {
        throw new Error("toString");
      },
    };
    for (const e of [
      unprintableError(),
      symbolName,
      revokedError(),
      noToString,
      Object.create(null),
    ]) {
      expect(describeError(e)).toBe(UNPRINTABLE_ERROR);
    }
  });
});

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

  test("never rejects, whatever the agent throws or answers", async () => {
    const input = sampleInput();
    expect(
      await playRound(
        agent(() => Promise.reject(unprintableError())),
        input,
      ),
    ).toEqual(failure(UNPRINTABLE_ERROR));
    const throwsRevoked = agent(() => {
      throw revokedError();
    });
    expect(await playRound(throwsRevoked, input)).toEqual(failure(UNPRINTABLE_ERROR));
    expect(await playRound(answering(hostileAnswer()), input)).toEqual(
      failure("invalid round output: Error: calls getter"),
    );
    // Resolving the answer reads its `then`: a throw there is a rejection; any other key, a parse failure.
    expect(await playRound(answering(trap(true)), input)).toEqual(failure("Error: get trap: then"));
    expect(await playRound(answering(trap(false)), input)).toEqual(
      failure("invalid round output: Error: get trap: calls"),
    );
    const noRound: SeatAgent = {
      label: "test:no-round@1",
      get round(): SeatAgent["round"] {
        throw new Error("round getter");
      },
    };
    expect(await playRound(noRound, input)).toEqual(failure("Error: round getter"));
  });

  test("a time source that fails while the round timeout is set up fails that round only", async () => {
    const broken: TimeSource = {
      nowMs: () => 0,
      sleepUntil: (): never => {
        throw new RangeError("no timers");
      },
    };
    const quick = agent(() => Promise.resolve({ calls: [] }));
    expect(await playRound(quick, sampleInput(), { time: broken, ms: 5000 })).toEqual(
      failure("RangeError: no timers"),
    );
  });

  test("settlementOf: a fulfilled entry passes through, a rejected one becomes an error", () => {
    const ok: RoundSettlement = { ok: true, out: { calls: [] } };
    expect(settlementOf({ status: "fulfilled", value: ok })).toBe(ok);
    expect(settlementOf({ status: "rejected", reason: new Error("bug") })).toEqual(
      failure("Error: bug"),
    );
    expect(settlementOf({ status: "rejected", reason: unprintableError() })).toEqual(
      failure(UNPRINTABLE_ERROR),
    );
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
