// Unit tests of the server's parts: the line tail (partial lines, UTF-8 cut anywhere, a replaced
// file), the status rules and stall thresholds, the HTTP token bucket, steps pages and the feed
// filters of a timeline, and the live hub's catch-up under backpressure (a socket that reports
// backpressure gets nothing more until it drains; its ranges stay contiguous).

// oxlint-disable no-await-in-loop -- the requests, pages and chunks follow each other on purpose (one cursor, one writer)
import { describe, expect, test } from "bun:test";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClockSpec } from "@perfidia/protocol";
import { ServerMsgSchema, type Step } from "@perfidia/protocol/spectator";
import fc from "fast-check";
import { DEFAULT_LIMITS } from "./config.ts";
import type { FoldBatch } from "./fold/messages.ts";
import { RateLimiter } from "./http/limits.ts";
import { LiveHub, type LiveSocket, type LiveSource } from "./service/live.ts";
import { MatchEntry } from "./service/matches.ts";
import { DEFAULT_POLICY } from "@perfidia/spectator/annotations";
import { matchStatus, stallAfterMs, type StatusInput } from "./store/status.ts";
import { LineTail, readFirstLine, readLastLine } from "./store/tail.ts";
import { Timeline } from "./timeline/timeline.ts";
import { fakeRun, foldWhole, tempDir } from "./testkit.test.ts";

describe("LineTail", () => {
  test("complete lines only, whatever the chunks (multi-byte characters cut anywhere)", () => {
    const lines = ['{"a":"Ἀχιλλεύς ⚔"}', '{"b":"🏛 Ὄλυμπος"}', "{}", '{"c":"é"}'];
    const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: bytes.length - 1 }), { maxLength: 12 }),
        (cuts) => {
          const dir = tempDir("tail");
          const path = join(dir, "match.jsonl");
          writeFileSync(path, "");
          const tail = new LineTail(path);
          const got: string[] = [];
          const at = [0, ...cuts.toSorted((a, b) => a - b), bytes.length];
          for (let i = 1; i < at.length; i += 1) {
            appendFileSync(path, bytes.subarray(at[i - 1], at[i]));
            const r = tail.read();
            expect(r.replaced).toBe(false);
            got.push(...r.lines);
          }
          expect(got).toEqual(lines);
          expect(tail.pending).toBe(0);
        },
      ),
      { numRuns: 40 },
    );
  });

  test("a partial last line waits; a shrunk, renamed or rewritten file is replaced", () => {
    const dir = tempDir("tail2");
    const path = join(dir, "match.jsonl");
    writeFileSync(path, "h1\nl1\npar");
    const tail = new LineTail(path);
    expect(tail.read().lines).toEqual(["h1", "l1"]);
    expect(tail.pending).toBe(3);
    appendFileSync(path, "tial\n");
    expect(tail.read().lines).toEqual(["partial"]);
    // Rewritten in place with another first line (same inode, larger).
    writeFileSync(path, "h2\nl1\npartial\nmore\n");
    const r = tail.read();
    expect([r.replaced, r.lines]).toEqual([true, ["h2", "l1", "partial", "more"]]);
    // Shrunk.
    writeFileSync(path, "h2\n");
    expect(tail.read()).toEqual({ lines: ["h2"], replaced: true, missing: false, more: false });
    // Replaced by a rename (a new inode).
    writeFileSync(join(dir, "next"), "h3\n");
    renameSync(join(dir, "next"), path);
    expect(tail.read().replaced).toBe(true);
    expect(readFirstLine(path)).toBe("h3");
    expect(readLastLine(path)).toBe("h3");
    expect(new LineTail(join(dir, "missing")).read().missing).toBe(true);
  });
});

const rt = (num: number, den: number): ClockSpec => ({
  kind: "realtime",
  speed: [num, den],
  time: "system",
});

describe("match status", () => {
  const base: StatusInput = {
    loading: false,
    unverifiable: false,
    endReason: null,
    fatalLine: false,
    arena: null,
    summary: null,
    clock: { kind: "lockstep", maxTurnsPerSecond: 3 },
    idleMs: 0,
  };
  test("precedence: loading, unverifiable, ended (degraded), arena and summary, paused, stalled, live", () => {
    expect(matchStatus(base)).toEqual({ status: "live", reason: null });
    expect(matchStatus({ ...base, loading: true, unverifiable: true }).status).toBe("loading");
    expect(matchStatus({ ...base, unverifiable: true, endReason: "time" }).status).toBe(
      "unverifiable",
    );
    expect(matchStatus({ ...base, endReason: "domination" })).toEqual({
      status: "ended",
      reason: "domination",
    });
    expect(matchStatus({ ...base, endReason: "custom" })).toEqual({
      status: "ended",
      reason: null,
    });
    expect(
      matchStatus({ ...base, endReason: "time", arena: { status: "degraded", fake: false } }),
    ).toEqual({ status: "degraded", reason: "model_errors" });
    expect(matchStatus({ ...base, fatalLine: true })).toEqual({
      status: "fatal",
      reason: "engine_error",
    });
    expect(matchStatus({ ...base, arena: { status: "stopped", fake: true } })).toEqual({
      status: "stopped",
      reason: "stopped_after_day",
    });
    expect(
      matchStatus({ ...base, arena: { status: "paused", fake: false }, idleMs: 1e12 }).status,
    ).toBe("paused");
    expect(matchStatus({ ...base, summary: { status: "incomplete" } }).status).toBe("incomplete");
    expect(matchStatus({ ...base, idleMs: 211 * 60_000 }).status).toBe("stalled");
    expect(matchStatus({ ...base, idleMs: 209 * 60_000 }).status).toBe("live");
  });

  test("stall thresholds follow the clock", () => {
    expect(stallAfterMs({ kind: "lockstep", maxTurnsPerSecond: 3 })).toBe(210 * 60_000);
    // Speed 3: a ckpt line every 20 wall minutes, stalled after 30.
    expect(stallAfterMs(rt(3, 1))).toBe(30 * 60_000);
    // Fast clocks keep a floor of 10 minutes.
    expect(stallAfterMs(rt(3600, 1))).toBe(10 * 60_000);
  });
});

describe("RateLimiter", () => {
  test("a burst, then the refill rate", () => {
    const r = new RateLimiter({ ...DEFAULT_LIMITS, httpPerMinute: 60, httpBurst: 3 });
    expect([r.take("a", 0), r.take("a", 0), r.take("a", 0)]).toEqual([0, 0, 0]);
    expect(r.take("a", 0)).toBe(1);
    expect(r.take("b", 0)).toBe(0);
    expect(r.take("a", 1_000)).toBe(0);
    expect(r.take("a", 1_000)).toBe(1);
  });
});

/** A timeline holding a whole fake run, applied in batches cut anywhere. */
async function timelineOf(): Promise<{ t: Timeline; steps: readonly Step[] }> {
  const run = await fakeRun({ days: 1, seed: 3 });
  const fold = foldWhole(run.lines, "unit");
  const t = new Timeline("unit", fold.logId, fold.timeline);
  const steps = fold.steps;
  const batch = (lastSeq: number, from: number): FoldBatch => ({
    lastSeq,
    lastT: 0,
    status: lastSeq === fold.lastSeq ? fold.status : "live",
    verified: { ok: true, divergence: null },
    map: fold.map(),
    steps: steps.filter((s) => s.seq > from && s.seq <= lastSeq),
    keyframes: fold.keyframes.filter((k) => k.seq > from && k.seq <= lastSeq),
    moments: [],
    reports: [],
    seats: [],
    drift: null,
    idle: true,
  });
  let at = -1;
  for (const to of [0, 100, 101, 640, fold.lastSeq]) {
    t.apply(batch(to, at));
    at = to;
  }
  // A refold of a prefix adds nothing.
  expect(t.apply(batch(640, -1))).toBeNull();
  return { t, steps };
}

describe("Timeline", () => {
  test("steps pages cover every step once; a refold adds nothing; the tail is the whole frame", async () => {
    const { t, steps } = await timelineOf();
    expect(t.steps).toEqual([...steps]);
    for (const limit of [1, 7, 500, 5000]) {
      const got: Step[] = [];
      let after = -1;
      for (;;) {
        const p = t.page(after, limit);
        expect(p.from).toBe(after);
        expect(p.steps.every((s) => s.seq > p.from && s.seq <= p.to)).toBe(true);
        got.push(...p.steps);
        after = p.to;
        if (!p.more) break;
      }
      expect(got.length).toBe(steps.length);
      expect(after).toBe(t.lastSeq);
    }
    const past = t.page(t.lastSeq + 5, 10);
    expect([past.steps.length, past.to, past.more]).toEqual([0, t.lastSeq + 5, false]);
  });

  test("feed pages: latest, after, before, kinds, players, pair, private", async () => {
    const { t } = await timelineOf();
    const all = t.feed;
    const latest = t.feedPage({ limit: 10 });
    expect(latest.items).toEqual(all.slice(-10));
    expect(latest.more).toBe(true);
    const first = t.feedPage({ after: -1, limit: 10 });
    expect(first.items).toEqual(all.slice(0, 10));
    const pivot = all[30]?.seq ?? 0;
    expect(t.feedPage({ before: pivot, limit: 1000 }).items.every((e) => e.seq < pivot)).toBe(true);
    const msgs = t.feedPage({ after: -1, kinds: ["message"], limit: 1000 });
    expect(msgs.items.every((e) => e.item.k === "message")).toBe(true);
    const pair = t.feedPage({ after: -1, pair: ["p1", "p2"], limit: 1000 });
    expect(
      pair.items.every((e) => e.item.players.includes("p1") && e.item.players.includes("p2")),
    ).toBe(true);
    const priv = t.feedPage({ after: -1, private: true, limit: 1000 });
    expect(priv.items.every((e) => e.item.k === "message" && e.item.private)).toBe(true);
    const p3 = t.feedPage({ after: -1, players: ["p3"], limit: 1000 });
    expect(p3.items.length).toBe(all.filter((e) => e.item.players.includes("p3")).length);
  });
});

describe("LiveHub", () => {
  test("catch-up under backpressure waits for drain; ranges stay contiguous; then live ranges", async () => {
    const { t } = await timelineOf();
    const dir = tempDir("hub");
    const entry = new MatchEntry(
      { id: "unit", dir, log: join(dir, "match.jsonl"), gz: false },
      DEFAULT_POLICY,
      0,
    );
    entry.visible = true;
    entry.timeline = t;
    entry.status = { status: "ended", reason: null };
    const source: LiveSource = {
      get: (id) => (id === "unit" ? entry : null),
      timelineOf: () => t,
      clockOf: () => null,
    };
    const hub = new LiveHub(source, DEFAULT_LIMITS, () => 0);
    const sent: string[] = [];
    let blocked = false;
    const topics: string[] = [];
    const sock: LiveSocket = {
      ip: "1.2.3.4",
      send: (text) => {
        sent.push(text);
        // Every catch-up message reports backpressure.
        blocked = text.includes('"type":"steps"');
        return blocked ? -1 : text.length;
      },
      close: () => undefined,
      subscribe: (topic) => topics.push(topic),
      unsubscribe: () => undefined,
    };
    const published: string[] = [];
    hub.setPublisher((_topic, text) => published.push(text));
    const key = {};
    hub.open(key, sock);
    hub.message(
      key,
      JSON.stringify({ type: "subscribe", match: "unit", timeline: t.timeline, after: 0 }),
    );
    const steps = (): { from: number; to: number }[] =>
      sent
        .map((x) => ServerMsgSchema.parse(JSON.parse(x)))
        .flatMap((m) => (m.type === "steps" ? [{ from: m.from, to: m.to }] : []));
    await Bun.sleep(5);
    // One message, then nothing until the socket drains.
    expect(steps()).toHaveLength(1);
    let rounds = 0;
    while (topics.length === 0 && rounds < 1000) {
      hub.drain(key);
      await Bun.sleep(0);
      rounds += 1;
    }
    const ranges = steps();
    expect(ranges.length).toBe(Math.ceil(t.steps.filter((s) => s.seq > 0).length / 500));
    let at = 0;
    for (const r of ranges) {
      expect(r.from).toBe(at);
      at = r.to;
    }
    expect(at).toBe(t.lastSeq);
    expect(topics).toEqual(["m:unit"]);
    // A live range goes to the topic once.
    hub.steps(entry, { from: t.lastSeq, to: t.lastSeq + 1, steps: [] });
    const live = published.map((x) => ServerMsgSchema.parse(JSON.parse(x)));
    expect(live.map((m) => (m.type === "steps" ? m.from : -1))).toEqual([t.lastSeq]);
    hub.close(key);
    expect(hub.count).toBe(0);
  });
});
