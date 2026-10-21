// Unit tests of the server's parts: the line tail (partial lines, UTF-8 cut anywhere, a replaced
// file, a symbolic link), log fingerprints, the status rules and stall thresholds, the HTTP token
// bucket, client keys (IPv6 by /64), the gate (canonical paths, the Host), the body memo's bounds,
// `publish.json` retries, steps pages (aligned, canonical), a refold batch straddling the cached
// cursor, the feed filters of a timeline, and the live hub's catch-up: under backpressure (a socket
// that reports backpressure gets nothing more until it drains; its ranges stay contiguous), too far
// behind, past a finished tail, a socket that never drains, and the server-wide budget.

// oxlint-disable no-await-in-loop -- the requests, pages and chunks follow each other on purpose (one cursor, one writer)
import { describe, expect, test } from "bun:test";
import { appendFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClockSpec } from "@perfidia/protocol";
import { ServerMsgSchema, type ServerMsg, type Step } from "@perfidia/protocol/spectator";
import fc from "fast-check";
import { DEFAULT_LIMITS, type Limits } from "./config.ts";
import type { FoldBatch } from "./fold/messages.ts";
import { allowedHosts, gate, ipKey } from "./http/gate.ts";
import { RateLimiter } from "./http/limits.ts";
import { BodyMemo } from "./http/respond.ts";
import { CATCH_UP_STEPS, LiveHub, type LiveSocket, type LiveSource } from "./service/live.ts";
import { MatchEntry } from "./service/matches.ts";
import { DEFAULT_POLICY, createAnnotationFold } from "@perfidia/spectator/annotations";
import { PublishList } from "./store/publish.ts";
import { matchStatus, stallAfterMs, type StatusInput } from "./store/status.ts";
import {
  LineTail,
  fingerprint,
  fingerprintMatches,
  readFirstLine,
  readLastLine,
} from "./store/tail.ts";
import { CACHE_VERSION_TAG, TimelineCache } from "./timeline/cache.ts";
import { STEPS_PAGE, Timeline, summaryOf } from "./timeline/timeline.ts";
import { fakeRun, foldWhole, tempDir, testConfig } from "./testkit.test.ts";

/** The slow suite (PERFIDIA_SLOW=1, docs/architecture.md §13.8) tries more chunkings. */
const SLOW = process.env["PERFIDIA_SLOW"] === "1";

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A memo entry of `n` characters. */
const body = (n: number): { text: string; gz: null; etag: string } => ({
  text: "x".repeat(n),
  gz: null,
  etag: '"e"',
});

/** A `publish.json` listing `ids`. */
const file = (ids: string[]): string =>
  JSON.stringify({ format: "perfidia-publish/1", matches: ids.map((id) => ({ id, title: id })) });

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
      // 10 chunkings outside the slow suite, which tries all 40.
      { numRuns: SLOW ? 40 : 10 },
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
    // A symbolic link is never followed (`O_NOFOLLOW` on the open itself).
    symlinkSync(path, join(dir, "link"));
    expect(new LineTail(join(dir, "link")).read().missing).toBe(true);
    expect([readFirstLine(join(dir, "link")), readLastLine(join(dir, "link"))]).toEqual([
      null,
      null,
    ]);
  });

  test("fingerprints: a prefix is recognised; a rewrite, a shrink or a link is not", () => {
    const dir = tempDir("fp");
    const path = join(dir, "match.jsonl");
    writeFileSync(path, "h1\nl1\n");
    const fp = fingerprint(path);
    if (fp === null) throw new Error("no fingerprint");
    expect(fp.bytes).toBe(6);
    expect(fingerprintMatches(path, fp, true)).toBe(true);
    appendFileSync(path, "l2\n");
    // Grown: still the same prefix, but no longer the whole file.
    expect([fingerprintMatches(path, fp, false), fingerprintMatches(path, fp, true)]).toEqual([
      true,
      false,
    ]);
    writeFileSync(path, "h1\nl9\nl2\n");
    expect(fingerprintMatches(path, fp, false)).toBe(false);
    writeFileSync(path, "h1\n");
    expect(fingerprintMatches(path, fp, false)).toBe(false);
    symlinkSync(path, join(dir, "link"));
    expect(fingerprint(join(dir, "link"))).toBeNull();
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

describe("the gate", () => {
  test("client keys: IPv4 as is, IPv6 by its /64, IPv4-mapped as IPv4", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:DB8:1:2::ffff")).toBe("2001:db8:1:2::/64");
    expect(ipKey("[2001:db8:1:2:aaaa::1]")).toBe("2001:db8:1:2::/64");
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(ipKey("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(ipKey("0:0:0:0:0:ffff:c633:6404")).toBe("198.51.100.4");
    expect(ipKey("::1")).toBe("0:0:0:0::/64");
    expect(ipKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
    // Not an address: kept as it is (one key).
    expect(ipKey("unknown")).toBe("unknown");
    expect(ipKey("1:2:3")).toBe("1:2:3");
  });

  test("canonical paths only; the Host the server answers to (health aside)", () => {
    const config = testConfig({ runs: "r" });
    const hosts = allowedHosts(config, 8080);
    expect([...hosts].toSorted(byText)).toEqual(["127.0.0.1:8080", "[::1]:8080", "localhost:8080"]);
    const limiter = new RateLimiter({ ...DEFAULT_LIMITS, httpBurst: 1_000 });
    const at = (path: string, host: string | null, method = "GET"): number | null => {
      const headers: Record<string, string> = host === null ? {} : { host };
      const req = new Request(`http://x${path}`, { method, headers });
      return gate(req, path, "1.2.3.4", hosts, limiter, 0)?.status ?? null;
    };
    expect(at("/api/matches", "127.0.0.1:8080")).toBeNull();
    expect(at("/api/matches", "LOCALHOST:8080")).toBeNull();
    expect(at("/api/matches/", "127.0.0.1:8080")).toBe(404);
    expect(at("/api/live/", "127.0.0.1:8080")).toBe(404);
    expect(at("/api//live", "127.0.0.1:8080")).toBe(404);
    expect(at("/api/matches", "evil.example:8080")).toBe(421);
    expect(at("/api/matches", "127.0.0.1:9999")).toBe(421);
    expect(at("/api/live", "rebind.attacker.example:8080")).toBe(421);
    expect(at("/api/health", "evil.example")).toBeNull();
    expect(at("/api/matches", "127.0.0.1:8080", "POST")).toBe(405);
    const named = allowedHosts(
      testConfig({ runs: "r", host: "0.0.0.0", hosts: ["perfidia.example"] }),
      8080,
    );
    expect([...named]).toEqual(["perfidia.example"]);
  });
});

describe("BodyMemo", () => {
  test("bounded by entries and by bytes, least recently used out first", () => {
    const memo = new BodyMemo({ entries: 3, bytes: 1_000 });
    memo.set("a", body(100));
    memo.set("b", body(100));
    memo.set("c", body(100));
    memo.get("a");
    memo.set("d", body(100));
    expect(["a", "b", "c", "d"].map((k) => memo.has(k))).toEqual([true, false, true, true]);
    memo.set("e", body(240));
    memo.set("f", body(240));
    expect(memo.bytes).toBeLessThanOrEqual(1_000);
    expect(memo.size).toBeLessThanOrEqual(3);
    // A body over a quarter of the budget is not kept at all.
    memo.set("big", body(300));
    expect(memo.has("big")).toBe(false);
    // A gzip copy made later counts too.
    const m = body(200);
    memo.set("g", m);
    memo.grew("g", m, 900);
    expect(memo.bytes).toBeLessThanOrEqual(1_000);
  });
});

describe("PublishList", () => {
  test("a failed re-read keeps the list until it is failed closed", () => {
    const dir = tempDir("pub");
    const path = join(dir, "publish.json");
    writeFileSync(path, file(["war"]));
    const list = new PublishList(path);
    expect(list.load({ first: true })).toBe(true);
    writeFileSync(path, "");
    const r = list.tryLoad();
    expect([r.ok, list.entry("war")?.id]).toEqual([false, "war"]);
    writeFileSync(path, file(["war", "fake"]));
    expect(list.tryLoad()).toEqual({ ok: true, changed: true });
    writeFileSync(path, "{");
    expect(list.load()).toBe(true);
    expect([list.entry("war"), list.error === null]).toEqual([null, false]);
    writeFileSync(path, "{");
    expect(() => new PublishList(path).load({ first: true })).toThrow();
  });
});

/** Aligned pages of the unit timelines (the 1-day fake run has 720 steps). */
const PAGE = 200;

/** A timeline holding a whole fake run, applied in batches cut anywhere. */
async function timelineOf(): Promise<{ t: Timeline; steps: readonly Step[] }> {
  const run = await fakeRun({ days: 1, seed: 3 });
  const fold = foldWhole(run.lines, "unit");
  const t = new Timeline("unit", fold.logId, fold.timeline, PAGE);
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

describe("TimelineCache", () => {
  test("opening the directory deletes the files of other fold versions, and only those", () => {
    const dir = tempDir("cache-prune");
    const id = "0123456789abcdef-0123456789abcdef-0123456789abcdef";
    const names = [
      `${id}.json.gz`,
      `${id}.json.gz.tmp`,
      `${id}-t3e0.1.0.json.gz`,
      `${id}-${CACHE_VERSION_TAG}.json.gz`,
      `${id}-${CACHE_VERSION_TAG}.json.gz.tmp`,
      "notes.txt",
      "abc.json.gz",
    ];
    for (const n of names) writeFileSync(join(dir, n), "x");
    const cache = new TimelineCache(dir);
    expect(cache.pruned).toBe(3);
    expect(readdirSync(dir).toSorted(byText)).toEqual(
      [
        `${id}-${CACHE_VERSION_TAG}.json.gz`,
        `${id}-${CACHE_VERSION_TAG}.json.gz.tmp`,
        "abc.json.gz",
        "notes.txt",
      ].toSorted(byText),
    );
    expect(cache.path("m", "f".repeat(64), "0123456789abcdef")).toEndWith(
      `-${CACHE_VERSION_TAG}.json.gz`,
    );
  });
});

describe("Timeline", () => {
  test("steps pages cover every step once; a refold adds nothing; the tail is the whole frame", async () => {
    const { t, steps } = await timelineOf();
    expect(t.steps).toEqual([...steps]);
    // What an evicted timeline leaves in memory: no steps and no seat data (series, notebooks).
    expect(Object.keys(summaryOf(t)).toSorted(byText)).toEqual(
      [
        "final",
        "keyframeSeqs",
        "lastSeq",
        "lastT",
        "map",
        "match",
        "status",
        "tail",
        "timeline",
        "verified",
      ].toSorted(byText),
    );
    expect(steps.length).toBeGreaterThan(3 * PAGE);
    expect(STEPS_PAGE).toBe(2_000);
    for (const limit of [1, 7, 50, PAGE - 1, PAGE]) {
      const got: Step[] = [];
      let after = -1;
      for (;;) {
        const p = t.page(after, limit);
        expect(p.from).toBe(after);
        expect(p.steps.every((s) => s.seq > p.from && s.seq <= p.to)).toBe(true);
        // Never across an aligned page boundary.
        const first = got.length;
        expect(Math.floor(first / PAGE)).toBe(
          Math.floor((first + Math.max(0, p.steps.length - 1)) / PAGE),
        );
        got.push(...p.steps);
        after = p.to;
        if (!p.more) break;
      }
      expect(got.length).toBe(steps.length);
      expect(after).toBe(t.lastSeq);
    }
    const past = t.page(t.lastSeq + 5, 10);
    expect([past.steps.length, past.to, past.more]).toEqual([0, t.lastSeq + 5, false]);
    // From any cursor, the second page is aligned; aligned pages from the cursor that ends the
    // page before them are canonical (the only ones the server keeps serialised).
    const mid = steps[277]?.seq ?? 0;
    const p1 = t.pageOf(mid, PAGE);
    expect([p1.page.steps.length, p1.canonical]).toEqual([2 * PAGE - 278, false]);
    const p2 = t.pageOf(p1.page.to, PAGE);
    expect([p2.page.steps[0]?.seq, p2.page.steps.length, p2.canonical]).toEqual([
      steps[2 * PAGE]?.seq,
      PAGE,
      true,
    ]);
    expect(t.pageOf(-1, PAGE).canonical).toBe(true);
    expect(t.pageOf(-1, PAGE / 2).canonical).toBe(false);
    expect(t.pageOf(p1.page.to - 1, PAGE).canonical).toBe(false);
  });

  test("a running match's full page: immutable, so its lastSeq is its own `to`", async () => {
    const { t, steps } = await timelineOf();
    const live = new Timeline("live", t.logId, t.timeline, PAGE);
    const last = steps.at(-10)?.seq ?? 0;
    live.apply({
      lastSeq: last,
      lastT: 0,
      status: "live",
      verified: { ok: true, divergence: null },
      map: t.map,
      steps: steps.filter((s) => s.seq <= last),
      keyframes: t.keyframes.filter((k) => k.seq <= last),
      moments: [],
      reports: [],
      seats: [],
      drift: null,
      idle: true,
    });
    const full = live.page(-1, PAGE);
    expect([full.more, full.lastSeq]).toEqual([true, full.to]);
    const tail = live.page(steps[3 * PAGE - 1]?.seq ?? 0, PAGE);
    expect([tail.more, tail.lastSeq]).toEqual([false, last]);
  });

  test("a refold batch straddling the cursor held adds only what is new", async () => {
    const { t } = await timelineOf();
    const fold = { steps: t.steps, keyframes: t.keyframes };
    const cut = t.steps[300]?.seq ?? 0;
    const end = t.steps[600]?.seq ?? 0;
    const batch = (from: number, to: number): FoldBatch => ({
      lastSeq: to,
      lastT: 0,
      status: "live",
      verified: { ok: true, divergence: null },
      map: t.map,
      steps: fold.steps.filter((s) => s.seq > from && s.seq <= to),
      keyframes: fold.keyframes.filter((k) => k.seq > from && k.seq <= to),
      moments: [],
      reports: [],
      seats: [],
      drift: null,
      idle: true,
    });
    const a = new Timeline("a", t.logId, t.timeline, PAGE);
    a.apply(batch(-1, cut));
    // A restart refolds from the first line: its first batch covers lines the timeline holds.
    const added = a.apply(batch(-1, end));
    expect(added?.from).toBe(cut);
    expect(added?.steps.every((s) => s.seq > cut && s.seq <= end)).toBe(true);
    const b = new Timeline("b", t.logId, t.timeline, PAGE);
    b.apply(batch(-1, end));
    expect(a.steps).toEqual(b.steps);
    expect(a.keyframes.map((k) => k.seq)).toEqual(b.keyframes.map((k) => k.seq));
    expect(a.feed.length).toBe(b.feed.length);
    expect(JSON.stringify(a.tail())).toBe(JSON.stringify(b.tail()));
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

/** A hub over one finished match `unit` (the fake run's timeline), and one fake socket. */
async function hubOf(limits: Limits, send: (text: string) => number) {
  const { t } = await timelineOf();
  const dir = tempDir("hub");
  const entry = new MatchEntry(
    { id: "unit", dir, log: join(dir, "match.jsonl"), gz: false },
    DEFAULT_POLICY,
    0,
  );
  entry.visible = true;
  entry.timeline = t;
  entry.timelineId = t.timeline;
  entry.status = { status: "ended", reason: null };
  const source: LiveSource = {
    get: (id) => (id === "unit" ? entry : null),
    timelineOf: () => t,
    summaryOf: () => t,
    annotationsOf: () => createAnnotationFold(DEFAULT_POLICY),
    clockOf: () => null,
  };
  const hub = new LiveHub(source, limits, () => 0);
  const sent: string[] = [];
  const topics: string[] = [];
  const closes: number[] = [];
  const sock: LiveSocket = {
    ip: "1.2.3.4",
    send: (text) => {
      sent.push(text);
      return send(text);
    },
    close: (code) => closes.push(code),
    subscribe: (topic) => topics.push(topic),
    unsubscribe: () => undefined,
  };
  const published: string[] = [];
  hub.setPublisher((_topic, text) => published.push(text));
  const key = {};
  hub.open(key, sock);
  const subscribe = (after: number): void =>
    hub.message(
      key,
      JSON.stringify({ type: "subscribe", match: "unit", timeline: t.timeline, after }),
    );
  const messages = (): ServerMsg[] => sent.map((x) => ServerMsgSchema.parse(JSON.parse(x)));
  return { t, entry, hub, key, sent, topics, closes, published, subscribe, messages };
}

describe("LiveHub", () => {
  test("catch-up under backpressure waits for drain; ranges stay contiguous; then live ranges", async () => {
    let blocked = false;
    const h = await hubOf({ ...DEFAULT_LIMITS, catchUpSteps: 1_000_000 }, (text) => {
      // Every catch-up message reports backpressure.
      blocked = text.includes('"type":"steps"');
      return blocked ? -1 : text.length;
    });
    const { t, hub, key, topics, published } = h;
    h.subscribe(0);
    const steps = (): { from: number; to: number }[] =>
      h.messages().flatMap((m) => (m.type === "steps" ? [{ from: m.from, to: m.to }] : []));
    await Bun.sleep(5);
    // One message, then nothing until the socket drains; its bytes count in the budget.
    expect(steps()).toHaveLength(1);
    expect(hub.catchUpQueued).toBeGreaterThan(0);
    let rounds = 0;
    while (topics.length === 0 && rounds < 1000) {
      hub.drain(key);
      await Bun.sleep(0);
      rounds += 1;
    }
    const ranges = steps();
    // Catch-up pages are aligned too (`CATCH_UP_STEPS` per message, never across a boundary).
    const n = t.steps.filter((s) => s.seq > 0).length;
    const per = CATCH_UP_STEPS;
    expect(ranges.length).toBe(
      Math.floor(n / PAGE) * Math.ceil(PAGE / per) + Math.ceil((n % PAGE) / per),
    );
    let at = 0;
    for (const r of ranges) {
      expect(r.from).toBe(at);
      at = r.to;
    }
    expect(at).toBe(t.lastSeq);
    expect(topics).toEqual(["m:unit"]);
    expect(hub.catchUpQueued).toBe(0);
    // A live range goes to the topic once.
    hub.steps(h.entry, { from: t.lastSeq, to: t.lastSeq + 1, steps: [] });
    const live = published.map((x) => ServerMsgSchema.parse(JSON.parse(x)));
    expect(live.map((m) => (m.type === "steps" ? m.from : -1))).toEqual([t.lastSeq]);
    hub.close(key);
    expect(hub.count).toBe(0);
  });

  test("too far behind: resync {behind}; past a finished tail: resync {gap}; at the tail: joined", async () => {
    const h = await hubOf({ ...DEFAULT_LIMITS, catchUpSteps: 100 }, (text) => text.length);
    const { t } = h;
    h.subscribe(0);
    h.subscribe(t.steps.at(-50)?.seq ?? 0);
    await Bun.sleep(5);
    h.subscribe(t.lastSeq + 7);
    h.subscribe(t.lastSeq);
    const kinds = h
      .messages()
      .filter((m) => m.type === "resync" || m.type === "steps")
      .map((m) => (m.type === "resync" ? m.reason : "steps"));
    expect(kinds).toEqual(["behind", "steps", "gap"]);
    // Subscribed at the tail twice (after the 50 steps, and at the end).
    expect(h.topics).toEqual(["m:unit", "m:unit"]);
  });

  test("a socket that does not drain is closed; the budget refuses catch-ups beyond it", async () => {
    const stuck = await hubOf(
      { ...DEFAULT_LIMITS, catchUpSteps: 1_000_000, drainTimeoutMs: 30 },
      (text) => (text.includes('"type":"steps"') ? -1 : text.length),
    );
    stuck.subscribe(0);
    await Bun.sleep(5);
    expect(stuck.hub.catchUpQueued).toBeGreaterThan(0);
    await Bun.sleep(60);
    expect(stuck.closes).toEqual([1013]);
    expect(stuck.hub.catchUpQueued).toBe(0);
    stuck.hub.close(stuck.key);

    const tight = await hubOf(
      { ...DEFAULT_LIMITS, catchUpSteps: 1_000_000, catchUpBudgetBytes: 1_000 },
      (text) => text.length,
    );
    tight.subscribe(0);
    await Bun.sleep(5);
    const resync = tight.messages().find((m) => m.type === "resync");
    expect(resync?.type === "resync" ? resync.reason : null).toBe("backpressure");
    expect(tight.messages().some((m) => m.type === "steps")).toBe(false);
  });
});
