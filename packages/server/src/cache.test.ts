// The timeline cache and the LRU (phase-3 design §2.5, §3.4): finished timelines beyond the 8
// kept in memory are dropped, leaving a summary that answers meta and `/latest` without reading
// the cache, and immutable bodies the server still holds are answered without it too; the rest (a
// dossier included) reads the timeline back from the cache (never refolds). Finished matches'
// annotations are read when asked for, at most 8 kept. A cache file that does not parse is deleted
// and its log refolded, with the same steps. A log replaced by another with the same header is
// refolded under a new timeline id, in the same process and after a restart, and so is a third one
// written in place over the second. Files of other fold versions are deleted at startup.
// Slow suite only (docs/architecture.md §13.8): skipped unless PERFIDIA_SLOW=1
// (`bun run test:slow`, which `bun run test:exit` runs).

// oxlint-disable no-await-in-loop -- one match at a time, on purpose
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "@perfidia/engine/core";
import {
  FrameSchema,
  MatchMetaSchema,
  StepsPageSchema,
  TurnAnnotationSchema,
} from "@perfidia/protocol/spectator";
import {
  GOLDEN_DIR,
  fakeRun,
  getJson,
  metaOf,
  rows,
  serve,
  stopServer,
  stopServers,
  tempDir,
  testConfig,
  waitFor,
} from "./testkit.test.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A group of tests of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xdescribe = describe.skipIf(!SLOW);

afterAll(stopServers);

const LONG = 120_000;

xdescribe("the timeline cache", () => {
  test(
    "evicted timelines are read back from the cache; a corrupt cache file is refolded",
    async () => {
      const run = await fakeRun({ days: 1, seed: 3 });
      const root = tempDir("lru");
      const cache = tempDir("lru-cache");
      const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
      for (const id of ids) cpSync(run.dir, join(root, id), { recursive: true });
      const s = serve(testConfig({ runs: root, cache }));
      for (const id of ids) await metaOf(s, id, { settled: true });
      await waitFor(
        () => readdirSync(cache).filter((n) => n.endsWith(".json.gz")).length === ids.length,
        20_000,
        "every timeline cached",
      );
      const inMemory = (): string[] =>
        ids.filter((id) => s.registry.entries.get(id)?.timeline !== null);
      expect(inMemory().length).toBeLessThanOrEqual(8);
      const evicted = ids.find((id) => s.registry.entries.get(id)?.timeline === null);
      if (evicted === undefined) throw new Error("nothing evicted");
      // Meta and the latest frame come from the summary left in memory: no cache read.
      const frame = await getJson(`${s.url}/api/matches/${evicted}/latest`, FrameSchema);
      const evictedMeta = await getJson(`${s.url}/api/matches/${evicted}`, MatchMetaSchema);
      expect(s.registry.entries.get(evicted)?.timeline).toBeNull();
      // A body the server does not hold reads the timeline back (never a refold).
      const t = `${s.url}/api/matches/${evicted}/t/${evictedMeta.timeline}`;
      const page = await getJson(`${t}/steps?after=-1&limit=2000`, StepsPageSchema);
      expect(s.registry.entries.get(evicted)?.timeline).not.toBeNull();
      expect(s.registry.folding()).toBe(0);
      expect(inMemory().length).toBeLessThanOrEqual(8);
      const first = await getJson(`${s.url}/api/matches/m0/latest`, FrameSchema);
      expect(canonicalJson({ ...frame, match: "m0" })).toBe(canonicalJson(first));
      // Evicted again, its aligned page is answered from the bodies the server holds.
      for (const id of ids) {
        if (id === evicted) continue;
        const url = `${s.url}/api/matches/${id}/t/${evictedMeta.timeline}/steps?after=-1&limit=2000`;
        await getJson(url, StepsPageSchema);
      }
      expect(s.registry.entries.get(evicted)?.timeline).toBeNull();
      const held = await getJson(`${t}/steps?after=-1&limit=2000`, StepsPageSchema);
      expect(s.registry.entries.get(evicted)?.timeline).toBeNull();
      expect(canonicalJson(held)).toBe(canonicalJson(page));
      // Finished matches' annotations are read on demand, and at most 8 stay in memory.
      const turn = run.lines.find((l) => l.k === "turn" && l.seat === "p2");
      if (turn?.k !== "turn") throw new Error("no p2 turn");
      const annotated = (): number =>
        ids.filter((id) => s.registry.entries.get(id)?.annotations !== null).length;
      expect(annotated()).toBe(0);
      for (const id of ids) {
        const a = await getJson(
          `${s.url}/api/matches/${id}/annotations/p2/${turn.turn}`,
          TurnAnnotationSchema,
        );
        expect(a.seat).toBe("p2");
      }
      expect(annotated()).toBe(8);

      // A corrupt cache file: the next server refolds that log.
      await stopServer(s);
      const files = readdirSync(cache).filter((n) => n.endsWith(".json.gz"));
      for (const name of files) writeFileSync(join(cache, name), "not gzip");
      const again = serve(testConfig({ runs: root, cache }));
      const meta = await metaOf(again, "m0", { settled: true });
      expect(meta.verified.ok).toBe(true);
      const refolded = await getJson(`${again.url}/api/matches/m0/latest`, FrameSchema);
      expect(canonicalJson(refolded)).toBe(canonicalJson(first));
    },
    LONG,
  );

  test(
    "a log replaced by another with the same header gets a new timeline, now and after a restart",
    async () => {
      // A finished 1-day golden, cached; then a shorter log with the same header over it.
      const text = await Bun.file(
        join(GOLDEN_DIR, "perfidia-1@1.1.0", "rt-virtual-6p-1d.jsonl"),
      ).text();
      const lines = rows(text);
      const root = tempDir("rerun");
      const cache = tempDir("rerun-cache");
      mkdirSync(join(root, "x"));
      writeFileSync(join(root, "x", "match.jsonl"), text);
      const s = serve(testConfig({ runs: root, cache }));
      const first = await metaOf(s, "x", { settled: true });
      expect([first.status, first.lastSeq]).toEqual(["ended", lines.length - 1]);
      await waitFor(
        () => readdirSync(cache).some((n) => n.startsWith(first.timeline)),
        10_000,
        "the cache file",
      );
      const short = join(root, "short.tmp");
      writeFileSync(short, `${lines.slice(0, 400).join("\n")}\n`);
      renameSync(short, join(root, "x", "match.jsonl"));
      let now = first;
      await waitFor(
        async () => {
          const res = await fetch(`${s.url}/api/matches/x`);
          if (res.status !== 200) return false;
          now = MatchMetaSchema.parse(await res.json());
          return now.lastSeq === 399;
        },
        20_000,
        "the new log served",
      );
      expect([now.status, now.logId]).toEqual(["live", first.logId]);
      expect(now.timeline).not.toBe(first.timeline);
      const latest = await getJson(`${s.url}/api/matches/x/latest`, FrameSchema);
      expect([latest.seq <= 399, latest.timeline]).toEqual([true, now.timeline]);
      // The old timeline's immutable URLs are gone.
      expect((await fetch(`${s.url}/api/matches/x/t/${first.timeline}/keyframes/0`)).status).toBe(
        404,
      );
      await stopServer(s);
      // After a restart: the cached old log does not match the file; the new one keeps its id.
      const r = serve(testConfig({ runs: root, cache }));
      const after = await metaOf(r, "x");
      expect([after.timeline, after.lastSeq]).toEqual([now.timeline, 399]);
      // Rewritten in place (same file) with a third log of the same header: a third timeline.
      writeFileSync(join(root, "x", "match.jsonl"), `${lines.slice(0, 300).join("\n")}\n`);
      let third = after;
      await waitFor(
        async () => {
          const res = await fetch(`${r.url}/api/matches/x`);
          if (res.status !== 200) return false;
          third = MatchMetaSchema.parse(await res.json());
          return third.lastSeq === 299;
        },
        20_000,
        "the third log served",
      );
      expect(new Set([first.timeline, now.timeline, third.timeline]).size).toBe(3);
    },
    LONG,
  );
});
