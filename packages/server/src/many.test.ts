// Many spectators (phase-3 design §3.4, §6.1, §6.3): a hundred WebSocket clients follow one match
// while its log is written, and all end with the frame of a fold of the whole file, their ranges
// contiguous, while HTTP requests keep being served; the health route answers in under 100 ms (p99)
// while two war-golden folds run in the workers (the main thread never folds).
// Slow suite only (docs/architecture.md §13.8): skipped unless PERFIDIA_SLOW=1
// (`bun run test:slow`, which `bun run test:exit` runs).

// oxlint-disable no-await-in-loop -- the chunks follow each other on purpose (one writer)
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "@perfidia/engine/core";
import { HealthSchema, MatchMetaSchema } from "@perfidia/protocol/spectator";
import {
  Follower,
  WAR_GOLDEN,
  fakeRun,
  foldWhole,
  getJson,
  metaOf,
  serve,
  tempDir,
  testConfig,
  waitFor,
  stopServers,
} from "./testkit.test.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A group of tests of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xdescribe = describe.skipIf(!SLOW);

afterAll(stopServers);

const LONG = 180_000;
const CLIENTS = 100;

xdescribe("many spectators of one live match", () => {
  test(
    `${CLIENTS} WebSocket clients end with the whole fold's frame; HTTP keeps answering`,
    async () => {
      const run = await fakeRun({ days: 1, seed: 3 });
      const root = tempDir("many");
      const dir = join(root, "crowd");
      mkdirSync(dir);
      const log = join(dir, "match.jsonl");
      const text = run.text;
      const lines = text.split("\n");
      writeFileSync(log, `${lines.slice(0, 40).join("\n")}\n`);
      const s = serve(testConfig({ runs: root }));
      await metaOf(s, "crowd");
      const followers = await Promise.all(
        Array.from({ length: CLIENTS }, () => Follower.start(s, "crowd")),
      );
      // The rest of the log in 25 parts, with HTTP requests in between.
      const rest = lines.slice(40);
      const parts = 25;
      const per = Math.ceil(rest.length / parts);
      let http = 0;
      for (let i = 0; i < parts; i += 1) {
        const chunk = rest.slice(i * per, (i + 1) * per).filter((l) => l !== "");
        if (chunk.length > 0) appendFileSync(log, `${chunk.join("\n")}\n`);
        const answers = await Promise.all(
          Array.from({ length: 8 }, () => getJson(`${s.url}/api/matches/crowd`, MatchMetaSchema)),
        );
        http += answers.length;
        await Bun.sleep(20);
      }
      const whole = foldWhole(run.lines, "crowd");
      const want = canonicalJson(whole.frame());
      const t0 = performance.now();
      for (const f of followers) await f.until(run.lines.length - 1);
      for (const f of followers) {
        expect(canonicalJson(f.frame)).toBe(want);
        f.expectContiguous(0);
        expect(f.gaps).toBe(0);
      }
      console.log(
        `${CLIENTS} followers caught up ${Math.round(performance.now() - t0)} ms after the last write; ${http} HTTP requests served meanwhile; ${s.hub.count} sockets open`,
      );
      await Promise.all(followers.map((f) => f.disconnect()));
      await waitFor(() => s.hub.count === 0, 10_000, "sockets closed");
    },
    LONG,
  );
});

xdescribe("the event loop while folds run", () => {
  test(
    "health answers within 100 ms (p99) while two war-golden folds run in the workers",
    async () => {
      const root = tempDir("busy");
      for (const id of ["war-a", "war-b"]) {
        mkdirSync(join(root, id));
        copyFileSync(WAR_GOLDEN, join(root, id, "match.jsonl.gz"));
      }
      const s = serve(testConfig({ runs: root }));
      const times: number[] = [];
      await waitFor(() => s.registry.folding() > 0, 20_000, "folds to start");
      while (s.registry.folding() > 0) {
        const t0 = performance.now();
        await getJson(`${s.url}/api/health`, HealthSchema);
        times.push(performance.now() - t0);
        await Bun.sleep(10);
      }
      times.sort((a, b) => a - b);
      const p99 = times[Math.min(times.length - 1, Math.floor(times.length * 0.99))] ?? 0;
      console.log(
        `health during two war folds: ${times.length} requests, p50 ${(times[Math.floor(times.length / 2)] ?? 0).toFixed(1)} ms, p99 ${p99.toFixed(1)} ms, max ${(times.at(-1) ?? 0).toFixed(1)} ms`,
      );
      expect(times.length).toBeGreaterThan(20);
      expect(p99).toBeLessThan(100);
      const a = await metaOf(s, "war-a", { settled: true });
      const b = await metaOf(s, "war-b", { settled: true });
      expect([a.status, b.status, a.lastSeq]).toEqual(["ended", "ended", b.lastSeq]);
    },
    LONG,
  );
});
