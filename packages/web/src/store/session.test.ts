import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Frame, MatchMeta, Moment, StepsPage } from "@perfidia/protocol/spectator";
import { Api } from "../api/client.ts";
import type { SocketLike } from "../api/live.ts";
import { field } from "../lib/json.ts";
import { TIMELINE, frame, meta, scoreStep } from "../testkit.test.ts";
import { useMatchStore } from "./match.ts";
import { closeMatch, controls, openMatch } from "./session.ts";

// The match session against a fake server: a meta a cache kept from another timeline is fetched
// again past every cache; `resync {behind}` catches up over REST and subscribes again from the new
// cursor; `resync {log_replaced}` and `TIMELINE_GONE` reload from a fresh meta; a lost socket shows
// in the store and "Retry now" reconnects at once.

const NEW = "fedcba9876543210";

class FakeSocket extends EventTarget implements SocketLike {
  readonly sent: unknown[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
  open(): void {
    this.dispatchEvent(new Event("open"));
  }
  receive(msg: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(msg) }));
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
  fire(): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const t of all) t.fn();
  }
}

interface Call {
  readonly path: string;
  readonly cache: RequestCache | undefined;
}

type Route = (cache: RequestCache | undefined) => { status?: number; body: unknown };

function fakeServer(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch = (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ path: input, cache: init?.cache });
    const r = routes[input]?.(init?.cache);
    if (r === undefined) {
      return Promise.resolve(
        Response.json(
          { ok: false, code: "NO_ROUTE", message: `no route ${input}`, hint: "" },
          { status: 404 },
        ),
      );
    }
    return Promise.resolve(Response.json(r.body, { status: r.status ?? 200 }));
  };
  return { api: new Api({ fetch }), calls };
}

function setup(routes: Record<string, Route>) {
  const server = fakeServer(routes);
  const timers = new FakeTimers();
  const sockets: FakeSocket[] = [];
  let now = 1_000;
  openMatch(
    "m1",
    {},
    {
      api: server.api,
      timers,
      frames: { request: () => 0, cancel: () => undefined },
      liveUrl: () => "ws://test/api/live",
      connect: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      now: () => now,
    },
  );
  return {
    ...server,
    timers,
    sockets,
    socket: (): FakeSocket => {
      const s = sockets.at(-1);
      if (s === undefined) throw new Error("no socket");
      return s;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Lets the session's promises run. */
async function settle(): Promise<void> {
  // oxlint-disable-next-line no-await-in-loop -- one macrotask after the other, on purpose
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/** A live steps message of one score step at line `to`. */
const lineMsg = (from: number, to: number) => ({
  type: "steps",
  match: "m1",
  timeline: TIMELINE,
  from,
  to,
  steps: [scoreStep(to, to * 100, to)],
});

const moment = (title: string): Moment => ({
  item: "5:0",
  seq: 5,
  t: 500,
  k: "end",
  importance: 3,
  title,
  players: [],
  cities: [],
});

const live = (o: Partial<MatchMeta> = {}): MatchMeta => ({
  ...meta(),
  status: "live",
  reason: null,
  ...o,
});
const page = (from: number, to: number, steps: StepsPage["steps"], more = false): StepsPage => ({
  from,
  to,
  steps,
  lastSeq: to,
  more,
});
const ok =
  (body: unknown): Route =>
  () => ({ body });
const steps = (after: number, timeline = TIMELINE): string =>
  `/api/matches/m1/t/${timeline}/steps?after=${after}&limit=2000`;
const subscribes = (s: FakeSocket): unknown[] =>
  s.sent.filter((m) => field(m, "type") === "subscribe").map((m) => field(m, "after"));

// Schema failures and re-syncs are reported in the console: collected here instead.
const reported: unknown[][] = [];
const consoleError = console.error;
beforeEach(() => {
  reported.length = 0;
  console.error = (...args: unknown[]) => {
    reported.push(args);
  };
});
afterEach(() => {
  closeMatch();
  console.error = consoleError;
});

describe("the match session", () => {
  test("a meta from a cache that names another timeline is fetched again past every cache", async () => {
    const latest: Frame = frame(0, 0, { timeline: NEW, status: "ended" });
    const k = setup({
      // The browser's copy (revalidated or not) still names the old timeline; past the cache, the new.
      "/api/matches/m1": (cache) => ({
        body: cache === "reload" ? { ...meta(), timeline: NEW } : meta(),
      }),
      "/api/matches/m1/latest": ok(latest),
      [`/api/matches/m1/t/${TIMELINE}/moments`]: ok([moment("old match")]),
      [`/api/matches/m1/t/${NEW}/moments`]: ok([moment("new match")]),
    });
    await settle();
    const s = useMatchStore.getState();
    expect([s.phase, s.meta?.timeline, s.moments.map((m) => m.title)]).toEqual([
      "ready",
      NEW,
      ["new match"],
    ]);
    const metas = k.calls.filter((c) => c.path === "/api/matches/m1").map((c) => c.cache);
    expect(metas).toEqual(["no-cache", "reload"]);
  });

  test("a meta that never matches /latest ends in an error, not in a mixed view", async () => {
    setup({
      "/api/matches/m1": ok(meta()),
      "/api/matches/m1/latest": ok(frame(0, 0, { timeline: NEW })),
      [`/api/matches/m1/t/${TIMELINE}/moments`]: ok([]),
    });
    await settle();
    const s = useMatchStore.getState();
    expect([s.phase, s.error?.code]).toEqual(["error", "TIMELINE_CHANGED"]);
  });

  test("resync {behind}: the steps pages from the cursor over REST, then subscribe from the new cursor", async () => {
    const k = setup({
      "/api/matches/m1": ok(live()),
      "/api/matches/m1/latest": ok(frame(10, 1_000)),
      [`/api/matches/m1/t/${TIMELINE}/moments`]: ok([]),
      [`/api/matches/m1/t/${TIMELINE}/keyframes/0`]: ok(frame(0, 0)),
      [steps(0)]: ok(page(0, 10, [scoreStep(10, 1_000, 5)])),
      [steps(10)]: ok(page(10, 15, [scoreStep(12, 1_200, 6), scoreStep(15, 1_500, 7)])),
    });
    await settle();
    k.socket().open();
    expect(subscribes(k.socket())).toEqual([10]);
    k.socket().receive({ type: "resync", match: "m1", reason: "behind" });
    await settle();
    expect(subscribes(k.socket())).toEqual([10, 15]);
    // Live lines continue from the new cursor.
    k.socket().receive({
      type: "steps",
      match: "m1",
      timeline: TIMELINE,
      from: 15,
      to: 16,
      steps: [scoreStep(16, 1_600, 8)],
    });
    const s = useMatchStore.getState();
    expect([s.mode, s.frame?.seq, s.frame?.players.p1?.score]).toEqual(["live", 16, 8]);
  });

  test("a live line one past the cursor is applied; a gap of one line is not", async () => {
    const k = setup({
      "/api/matches/m1": ok(live()),
      "/api/matches/m1/latest": ok(frame(10, 1_000)),
      [`/api/matches/m1/t/${TIMELINE}/moments`]: ok([]),
      [`/api/matches/m1/t/${TIMELINE}/keyframes/0`]: ok(frame(0, 0)),
      [steps(0)]: ok(page(0, 10, [scoreStep(10, 1_000, 5)])),
    });
    await settle();
    k.socket().open();
    // (11, 12] leaves line 11 out: not applied, and the cursor is asked for again.
    k.socket().receive(lineMsg(11, 12));
    expect(useMatchStore.getState().frame?.seq).toBe(10);
    expect(subscribes(k.socket())).toEqual([10, 10]);
    k.socket().receive(lineMsg(10, 11));
    k.socket().receive(lineMsg(11, 12));
    expect(useMatchStore.getState().frame?.seq).toBe(12);
  });

  test("resync {log_replaced} and TIMELINE_GONE reload the match from a fresh meta", async () => {
    let gone = false;
    const k = setup({
      "/api/matches/m1": ok(live()),
      "/api/matches/m1/latest": ok(frame(10, 1_000)),
      [`/api/matches/m1/t/${TIMELINE}/moments`]: ok([]),
      [`/api/matches/m1/t/${TIMELINE}/keyframes/0`]: () =>
        gone
          ? {
              status: 404,
              body: { ok: false, code: "TIMELINE_GONE", message: "gone", hint: "refetch" },
            }
          : { body: frame(0, 0) },
      [steps(0)]: ok(page(0, 10, [scoreStep(10, 1_000, 5)])),
    });
    await settle();
    k.socket().open();
    k.socket().receive({ type: "resync", match: "m1", reason: "log_replaced" });
    expect(k.timers.pending.size).toBeGreaterThan(0);
    gone = true;
    k.timers.fire();
    await settle();
    const metas = () => k.calls.filter((c) => c.path === "/api/matches/m1").map((c) => c.cache);
    expect(metas()).toEqual(["no-cache", "reload"]);
    // That load's keyframe is gone (the timeline changed again): one more reload, past the cache.
    expect(reported.length).toBeGreaterThan(0);
    gone = false;
    k.timers.fire();
    await settle();
    expect(metas()).toEqual(["no-cache", "reload", "reload"]);
    expect(useMatchStore.getState().phase).toBe("ready");
  });

  test("a lost socket shows in the store; Retry now reconnects at once", async () => {
    const k = setup({
      "/api/matches/m1": ok(live()),
      "/api/matches/m1/latest": ok(frame(0, 0)),
      [`/api/matches/m1/t/${TIMELINE}/moments`]: ok([]),
    });
    await settle();
    k.socket().open();
    expect(useMatchStore.getState().connection).toBe("open");
    k.socket().drop();
    const s = useMatchStore.getState();
    expect(s.connection).toBe("closed");
    expect(s.retryAt).not.toBeNull();
    expect((s.retryAt ?? 0) - 1_000).toBeGreaterThanOrEqual(500);
    controls.reconnect();
    expect(k.sockets).toHaveLength(2);
    expect(useMatchStore.getState().connection).toBe("connecting");
    k.socket().open();
    expect(subscribes(k.socket())).toEqual([0]);
    expect(useMatchStore.getState().connection).toBe("open");
  });
});
