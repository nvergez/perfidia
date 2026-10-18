// Following matches while their logs are written (phase-3 design §1.2, §3.2, §6.1):
// - a WebSocket client that follows a fake arena match written by `bun run arena -- run --fake`
//   into the runs root ends with the frame of a fold of the whole file, its ranges contiguous;
// - with a writer appending a fake run's log in chunks cut anywhere (partial lines included): a
//   client from the start, a client that disconnects and resumes from its cursor, and a client
//   that resumes after a server restart from the cache all end with that frame, with no line
//   missed or sent twice; a client holding another timeline gets `resync`;
// - replacing the log sends `resync {log_replaced}`; a crash-truncated log stays live, then
//   stalls, and is never unverifiable; annotations of the fake run's LLM turns are served.

// oxlint-disable no-await-in-loop -- the requests, pages and chunks follow each other on purpose (one cursor, one writer)
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "@perfidia/engine/core";
import {
  FrameSchema,
  ServerMsgSchema,
  TurnAnnotationSchema,
  type ServerMsg,
} from "@perfidia/protocol/spectator";
import {
  Follower,
  REPO,
  fakeRun,
  foldWhole,
  getJson,
  metaOf,
  parseLog,
  rows,
  serve,
  stopServer,
  tempDir,
  testConfig,
  waitFor,
  stopServers,
} from "./testkit.test.ts";

afterAll(stopServers);

const LONG = 180_000;

/** Cut points of a text, from a seeded generator (the same chunks every run). */
function cuts(length: number, n: number, seed: number): number[] {
  let x = seed >>> 0;
  const out = new Set<number>();
  while (out.size < n) {
    x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0;
    out.add(1 + (x % (length - 1)));
  }
  return [0, ...[...out].toSorted((a, b) => a - b), length];
}

/** Appends `text` to `path` in chunks, `pauseMs` apart; `onChunk` runs after each. */
async function writeInChunks(
  path: string,
  text: string,
  at: readonly number[],
  pauseMs: number,
  onChunk?: (i: number) => Promise<void> | void,
): Promise<void> {
  for (let i = 1; i < at.length; i += 1) {
    appendFileSync(path, text.slice(at[i - 1], at[i]));
    await onChunk?.(i);
    await Bun.sleep(pauseMs);
  }
}

describe("a fake arena match followed while `bun run arena -- run --fake` writes it", () => {
  test(
    "the WebSocket follower ends with the frame of a fold of the whole file",
    async () => {
      const root = tempDir("arena");
      const s = serve(testConfig({ runs: root }));
      const out = join(root, "live-fake");
      const proc = Bun.spawn(
        [
          process.execPath,
          "run",
          "arena",
          "--",
          "run",
          "--fake",
          "--days",
          "2",
          "--seed",
          "5",
          "--id-key",
          "seed",
          "--out",
          out,
        ],
        { cwd: REPO, stdout: "pipe", stderr: "pipe" },
      );
      const follower = await Follower.start(s, "live-fake");
      const firstStatus = await (async () => {
        await waitFor(() => follower.statuses.length > 0, 30_000, "a status message");
        return follower.statuses[0];
      })();
      // `bun run` echoes the command on stderr; the arena itself writes nothing there.
      const code = await proc.exited;
      const stderr = await new Response(proc.stderr).text();
      expect([code, stderr.split("\n").filter((l) => l !== "" && !l.startsWith("$ "))]).toEqual([
        0,
        [],
      ]);
      const text = await Bun.file(join(out, "match.jsonl")).text();
      const lines = parseLog(text);
      await follower.until(lines.length - 1);
      await waitFor(() => follower.statuses.includes("ended"), 30_000, "status ended");
      const whole = foldWhole(lines, "live-fake");
      expect(canonicalJson(follower.frame)).toBe(canonicalJson(whole.frame()));
      follower.expectContiguous(0);
      expect([follower.gaps, follower.resyncs]).toEqual([0, []]);
      // The client subscribed while the run was still being written.
      expect(firstStatus === "live" || firstStatus === "loading").toBe(true);
      const meta = await metaOf(s, "live-fake", { settled: true });
      expect(meta.seats.filter((x) => x.kind === "llm").every((x) => x.fake)).toBe(true);
      console.log(
        `arena --fake (2 days, ${lines.length} lines) followed live: ${follower.ranges.length} steps messages, first status ${firstStatus}`,
      );
      await follower.disconnect();
    },
    LONG,
  );
});

describe("a log written in chunks cut anywhere", () => {
  test(
    "from the start, resumed after a disconnect, resumed after a restart from the cache: same frame, contiguous ranges",
    async () => {
      const run = await fakeRun({ days: 1, seed: 3 });
      const root = tempDir("chunks");
      const cache = tempDir("chunks-cache");
      const dir = join(root, "chunked");
      mkdirSync(dir);
      copyFileSync(join(run.dir, "seats.json"), join(dir, "seats.json"));
      const log = join(dir, "match.jsonl");
      writeFileSync(log, "");
      const text = run.text;
      const at = cuts(text.length, 40, 7);
      const half = Math.floor(at.length / 2);
      let s = serve(testConfig({ runs: root, cache }));

      // The first chunks, until the server has the header.
      let written = 0;
      const writeUpTo = async (n: number, pauseMs: number): Promise<void> => {
        await writeInChunks(log, text, at.slice(written, n + 1), pauseMs);
        written = n;
      };
      await writeUpTo(3, 10);
      const meta = await metaOf(s, "chunked");
      const a = await Follower.start(s, "chunked");
      const b = await Follower.start(s, "chunked");
      const c = await Follower.start(s, "chunked");
      const stale = new Follower(s, "chunked", a.frame, "0000000000000000");
      await stale.connect();
      await waitFor(() => stale.resyncs.length > 0, 10_000, "resync of a stale timeline");
      expect(stale.resyncs).toEqual(["timeline"]);
      await stale.disconnect();

      // b leaves for a while and resumes from its cursor.
      await writeUpTo(half - 6, 30);
      await b.disconnect();
      await writeUpTo(half - 2, 30);
      await b.connect();
      await writeUpTo(half, 30);
      const complete = text.slice(0, at[half]).split("\n").length - 2;
      await waitFor(
        () => s.registry.get("chunked")?.timeline?.lastSeq === complete,
        20_000,
        "the fold to reach the written half",
      );

      // The server restarts from its cache; a and c reconnect to the new server.
      await a.disconnect();
      await c.disconnect();
      await b.disconnect();
      await stopServer(s);
      s = serve(testConfig({ runs: root, cache }));
      const meta2 = await metaOf(s, "chunked");
      expect(meta2.timeline).toBe(meta.timeline);
      for (const f of [a, b, c]) {
        Object.assign(f, { url: `${s.url.replace("http", "ws")}/api/live` });
        await f.connect();
      }
      await writeUpTo(at.length - 1, 25);
      const lines = parseLog(text);
      const whole = foldWhole(lines, "chunked");
      for (const f of [a, b, c]) {
        await f.until(lines.length - 1);
        expect(canonicalJson(f.frame)).toBe(canonicalJson(whole.frame()));
        f.expectContiguous(0);
        expect(f.gaps).toBe(0);
      }
      const latest = await getJson(`${s.url}/api/matches/chunked/latest`, FrameSchema);
      expect(canonicalJson(latest)).toBe(canonicalJson(whole.frame()));

      // Replacing the log voids the clients' timeline.
      const other = await fakeRun({ days: 1, seed: 4 });
      copyFileSync(join(other.dir, "match.jsonl"), join(dir, "next.jsonl"));
      renameSync(join(dir, "next.jsonl"), log);
      await waitFor(
        () => a.resyncs.includes("log_replaced"),
        20_000,
        "resync after the log was replaced",
      );
      const meta3 = await metaOf(s, "chunked", { settled: true });
      expect(meta3.timeline).not.toBe(meta.timeline);
      expect(meta3.lastSeq).toBe(other.lines.length - 1);
      for (const f of [a, b, c]) await f.disconnect();
    },
    LONG,
  );
});

describe("a crash-truncated log", () => {
  test(
    "stays live with a partial last line, stalls after the lockstep threshold, never unverifiable",
    async () => {
      const run = await fakeRun({ days: 1, seed: 3 });
      const root = tempDir("crash");
      const dir = join(root, "crashed");
      mkdirSync(dir);
      const all = rows(run.text);
      const keep = all.slice(0, Math.floor(all.length / 2));
      const partial = all[keep.length]?.slice(0, 40) ?? "";
      writeFileSync(join(dir, "match.jsonl"), `${keep.join("\n")}\n${partial}`);
      let now = 1_000_000;
      const s = serve(testConfig({ runs: root }), { now: () => now });
      const meta = await metaOf(s, "crashed", { settled: true });
      expect([meta.status, meta.lastSeq, meta.verified.ok]).toEqual([
        "live",
        keep.length - 1,
        true,
      ]);
      now += 4 * 3600 * 1000;
      await waitFor(
        async () => (await metaOf(s, "crashed")).status === "stalled",
        10_000,
        "stalled",
      );
    },
    LONG,
  );
});

describe("annotations of a fake run's LLM turns", () => {
  test(
    "served per turn with fake reasoning; `annot` messages follow the replies being written",
    async () => {
      const run = await fakeRun({ days: 1, seed: 3 });
      const root = tempDir("annot");
      const dir = join(root, "annotated");
      mkdirSync(dir);
      copyFileSync(join(run.dir, "seats.json"), join(dir, "seats.json"));
      const log = rows(run.text);
      const replies = rows(await Bun.file(join(run.dir, "replies.jsonl")).text());
      const calls = rows(await Bun.file(join(run.dir, "llm_calls.jsonl")).text());
      // The whole log, the side files empty at first.
      writeFileSync(join(dir, "match.jsonl"), `${log.join("\n")}\n`);
      writeFileSync(join(dir, "llm_calls.jsonl"), "");
      writeFileSync(join(dir, "replies.jsonl"), "");
      const s = serve(testConfig({ runs: root }));
      const meta = await metaOf(s, "annotated", { settled: true });
      const f = await Follower.start(s, "annotated", "latest");
      await f.until(meta.lastSeq);
      // Subscribed (the status answers the subscribe) before the side files arrive.
      await waitFor(() => f.statuses.length > 0, 10_000, "the subscription");
      // The side files arrive.
      appendFileSync(join(dir, "llm_calls.jsonl"), `${calls.join("\n")}\n`);
      appendFileSync(join(dir, "replies.jsonl"), `${replies.join("\n")}\n`);
      await waitFor(() => f.messages.some((m) => m.type === "annot"), 20_000, "an annot message");
      const annot = f.messages.find(
        (m): m is Extract<ServerMsg, { type: "annot" }> => m.type === "annot",
      );
      expect(ServerMsgSchema.parse(annot).type).toBe("annot");
      const turn = run.lines.find((l) => l.k === "turn" && l.seat === "p1");
      if (turn?.k !== "turn") throw new Error("no p1 turn");
      const a = await getJson(
        `${s.url}/api/matches/annotated/annotations/p1/${turn.turn}`,
        TurnAnnotationSchema,
      );
      expect(a.complete).toBe(true);
      expect(a.rounds.filter((r) => r.kind === "round")).toHaveLength(turn.rounds);
      expect(a.rounds.every((r) => r.reasoning[0]?.startsWith("Fake reasoning:") === true)).toBe(
        true,
      );
      expect(a.spentNanoUsd).toBeGreaterThan(0);
      const res = await fetch(`${s.url}/api/matches/annotated/annotations/p5/1`);
      expect(res.status).toBe(404);
      await f.disconnect();
    },
    LONG,
  );
});

describe("a real-time match", () => {
  test(
    "its followers get clock messages: the speed, a time between the last line and the cap",
    async () => {
      const root = tempDir("rt");
      const made = join(tempDir("rt-made"), "run");
      const proc = Bun.spawn(
        [
          process.execPath,
          "run",
          "sim",
          "--",
          "run",
          "--clock",
          "realtime",
          "--days",
          "1",
          "--out",
          made,
        ],
        { cwd: REPO, stdout: "ignore", stderr: "ignore" },
      );
      expect(await proc.exited).toBe(0);
      const text = await Bun.file(join(made, "match.jsonl")).text();
      const all = rows(text);
      const dir = join(root, "rt");
      mkdirSync(dir);
      writeFileSync(
        join(dir, "match.jsonl"),
        `${all.slice(0, Math.floor(all.length / 2)).join("\n")}\n`,
      );
      const s = serve(testConfig({ runs: root }));
      const meta = await metaOf(s, "rt", { settled: true });
      expect(meta.clock.kind).toBe("realtime");
      const f = await Follower.start(s, "rt", "latest");
      await waitFor(
        () => f.messages.filter((m) => m.type === "clock").length >= 2,
        10_000,
        "clock messages",
      );
      for (const m of f.messages) {
        if (m.type !== "clock") continue;
        expect(m.speed).toEqual([3, 1]);
        expect(m.t).toBeGreaterThanOrEqual(meta.lastT);
        expect(m.t).toBeLessThanOrEqual(m.cap);
        expect(m.cap).toBe(Math.min(meta.matchEnd, meta.lastT + 3600));
      }
      await f.disconnect();
    },
    LONG,
  );
});
