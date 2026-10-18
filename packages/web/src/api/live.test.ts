import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { field } from "../lib/json.ts";
import { scoreStep, TIMELINE } from "../testkit.test.ts";
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  BACKPRESSURE_RETRY_MS,
  GAP_RETRY_MS,
  LiveConnection,
  backoffMs,
  liveUrl,
  type LiveEvent,
  type SocketLike,
} from "./live.ts";

class FakeSocket extends EventTarget implements SocketLike {
  readonly sent: unknown[] = [];
  closed = false;
  send(data: string): void {
    const msg: unknown = JSON.parse(data);
    this.sent.push(msg);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.dispatchEvent(new Event("open"));
  }
  receive(msg: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: typeof msg === "string" ? msg : JSON.stringify(msg) }),
    );
  }
  drop(): void {
    this.dispatchEvent(new Event("close"));
  }
}

class FakeTimers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  set = (fn: () => void, ms: number): number => {
    const h = this.next++;
    this.pending.set(h, { fn, ms });
    return h;
  };
  clear = (h: number): void => {
    this.pending.delete(h);
  };
  /** Runs every pending timer once; returns their delays. */
  fire(): number[] {
    const all = [...this.pending.entries()];
    this.pending.clear();
    for (const [, t] of all) t.fn();
    return all.map(([, t]) => t.ms);
  }
}

function setup(cursor = 10) {
  const sockets: FakeSocket[] = [];
  const events: LiveEvent[] = [];
  const timers = new FakeTimers();
  let now = 0;
  const live = new LiveConnection({
    url: "ws://test/api/live",
    match: "m1",
    timeline: TIMELINE,
    cursor,
    onEvent: (e) => events.push(e),
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    timers,
    now: () => now,
    random: () => 1,
  });
  return {
    live,
    sockets,
    events,
    timers,
    advance: (ms: number) => {
      now += ms;
    },
    socket: (): FakeSocket => {
      const s = sockets.at(-1);
      if (s === undefined) throw new Error("no socket");
      return s;
    },
  };
}

const steps = (from: number, to: number) => ({
  type: "steps",
  match: "m1",
  timeline: TIMELINE,
  from,
  to,
  steps: to > from ? [scoreStep(to, to * 10, to)] : [],
});

const applied = (events: readonly LiveEvent[]) =>
  events.flatMap((e) => (e.type === "steps" ? [[e.from, e.to, e.steps.map((s) => s.seq)]] : []));

// Schema failures are reported in the console: collected here instead.
const reported: unknown[][] = [];
const consoleError = console.error;
beforeEach(() => {
  reported.length = 0;
  console.error = (...args: unknown[]) => {
    reported.push(args);
  };
});
afterEach(() => {
  console.error = consoleError;
});

describe("the live connection", () => {
  test("subscribes with its cursor on open and applies contiguous ranges", () => {
    const k = setup(10);
    k.live.start();
    k.socket().open();
    expect(k.socket().sent).toEqual([
      { type: "subscribe", match: "m1", timeline: TIMELINE, after: 10 },
    ]);
    k.socket().receive({ type: "hello", format: "perfidia-spectator/1" });
    k.socket().receive(steps(10, 12));
    k.socket().receive(steps(12, 15));
    expect(applied(k.events)).toEqual([
      [10, 12, [12]],
      [12, 15, [15]],
    ]);
    expect(k.live.cursor).toBe(15);
  });

  test("a gap is never applied; it subscribes again once with its cursor", () => {
    const k = setup(10);
    k.live.start();
    k.socket().open();
    k.socket().receive(steps(14, 16));
    k.socket().receive(steps(16, 18));
    expect(applied(k.events)).toEqual([]);
    const subs = () => k.socket().sent.filter((m) => field(m, "type") === "subscribe");
    expect(subs()).toHaveLength(2);
    expect(subs()[1]).toEqual({ type: "subscribe", match: "m1", timeline: TIMELINE, after: 10 });
    // Still missing after the retry delay: one more.
    k.advance(GAP_RETRY_MS);
    k.socket().receive(steps(18, 20));
    expect(subs()).toHaveLength(3);
    // The missing range arrives (the catch-up), then live ranges join.
    k.socket().receive(steps(10, 18));
    k.socket().receive(steps(18, 20));
    expect(applied(k.events)).toEqual([
      [10, 18, [18]],
      [18, 20, [20]],
    ]);
  });

  test("duplicates are skipped and an overlap applies only what is new", () => {
    const k = setup(10);
    k.live.start();
    k.socket().open();
    k.socket().receive(steps(5, 10));
    k.socket().receive({
      type: "steps",
      match: "m1",
      timeline: TIMELINE,
      from: 8,
      to: 14,
      steps: [scoreStep(9, 90, 9), scoreStep(13, 130, 13)],
    });
    expect(applied(k.events)).toEqual([[10, 14, [13]]]);
  });

  test("another timeline, a resync or an invalid message go to the caller", () => {
    const k = setup(10);
    k.live.start();
    k.socket().open();
    k.socket().receive({ ...steps(10, 12), timeline: "fedcba9876543210" });
    k.socket().receive({ type: "resync", match: "m1", reason: "log_replaced" });
    k.socket().receive({ type: "resync", match: "m1", reason: "behind" });
    k.socket().receive("{not json");
    k.socket().receive({ type: "steps", match: "m1" });
    const resyncs = k.events.flatMap((e) => (e.type === "resync" ? [e.reason] : []));
    expect(resyncs).toEqual(["timeline", "log_replaced", "behind", "invalid", "invalid"]);
    expect(reported.length).toBeGreaterThan(0);
    expect(applied(k.events)).toEqual([]);
    // Messages of another match are ignored.
    k.socket().receive({ type: "status", match: "other", status: "ended", reason: null });
    expect(k.events.some((e) => e.type === "status")).toBe(false);
  });

  test("backpressure: subscribes again after a pause, from its cursor", () => {
    const k = setup(10);
    k.live.start();
    k.socket().open();
    k.socket().receive(steps(10, 11));
    k.socket().receive({ type: "resync", match: "m1", reason: "backpressure" });
    expect(k.timers.fire()).toEqual([BACKPRESSURE_RETRY_MS]);
    expect(k.socket().sent.at(-1)).toEqual({
      type: "subscribe",
      match: "m1",
      timeline: TIMELINE,
      after: 11,
    });
  });

  test("reconnects with backoff and resumes from its cursor; a REST catch-up resubscribes", () => {
    const k = setup(10);
    k.live.start();
    k.socket().open();
    k.socket().receive(steps(10, 12));
    k.socket().drop();
    expect(k.events.at(-1)).toEqual({
      type: "connection",
      state: "closed",
      retryMs: BACKOFF_MIN_MS,
    });
    k.timers.fire();
    expect(k.sockets).toHaveLength(2);
    k.socket().open();
    expect(k.socket().sent).toEqual([
      { type: "subscribe", match: "m1", timeline: TIMELINE, after: 12 },
    ]);
    k.socket().drop();
    expect(k.events.at(-1)).toEqual({
      type: "connection",
      state: "closed",
      retryMs: 2 * BACKOFF_MIN_MS,
    });
    k.timers.fire();
    k.socket().open();
    k.live.resubscribe(40);
    expect(k.live.cursor).toBe(40);
    expect(k.socket().sent.at(-1)).toEqual({
      type: "subscribe",
      match: "m1",
      timeline: TIMELINE,
      after: 40,
    });
    k.live.stop();
    expect(k.socket().closed).toBe(true);
    k.timers.fire();
    expect(k.sockets).toHaveLength(3);
  });

  test("status, clock (anchored on receipt) and annot events", () => {
    const k = setup(10);
    k.live.start();
    k.socket().open();
    k.advance(1_234);
    k.socket().receive({ type: "status", match: "m1", status: "paused", reason: "operator_pause" });
    k.socket().receive({ type: "clock", match: "m1", t: 500, speed: [3, 1], cap: 4_100 });
    k.socket().receive({
      type: "annot",
      match: "m1",
      seat: "p1",
      turn: 3,
      round: 0,
      reasoning: ["Fake reasoning: x"],
      text: [],
      calls: ["build"],
      complete: false,
    });
    const events = k.events.filter((e) => e.type !== "connection");
    expect(events.slice(0, 2)).toEqual([
      { type: "status", status: "paused", reason: "operator_pause" },
      { type: "clock", t: 500, speed: [3, 1], cap: 4_100, at: 1_234 },
    ]);
    const annot = events[2];
    expect(
      annot?.type === "annot" ? [annot.msg.seat, annot.msg.turn, annot.msg.calls] : null,
    ).toEqual(["p1", 3, ["build"]]);
  });

  test("backoff: 1 s doubling to 30 s, jittered between half and full", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (n, r) => {
          const ms = backoffMs(n, r);
          const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(n, 10));
          return ms >= base / 2 - 1 && ms <= base && ms <= BACKOFF_MAX_MS;
        },
      ),
      { numRuns: 200 },
    );
    expect(liveUrl({ protocol: "https:", host: "x.example" })).toBe("wss://x.example/api/live");
    expect(liveUrl({ protocol: "http:", host: "127.0.0.1:8201" })).toBe(
      "ws://127.0.0.1:8201/api/live",
    );
  });
});
