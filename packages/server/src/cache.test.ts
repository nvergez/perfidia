// The timeline cache and the LRU (phase-3 design §2.5, §3.4): finished timelines beyond the 8
// kept in memory are dropped and read back from the cache on the next request (never refolded); a
// cache file that does not parse is deleted and its log refolded, with the same steps.

// oxlint-disable no-await-in-loop -- one match at a time, on purpose
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "@perfidia/engine/core";
import { FrameSchema } from "@perfidia/protocol/spectator";
import {
  fakeRun,
  getJson,
  metaOf,
  serve,
  stopServer,
  stopServers,
  tempDir,
  testConfig,
  waitFor,
} from "./testkit.test.ts";

afterAll(stopServers);

const LONG = 120_000;

describe("the timeline cache", () => {
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
      const frame = await getJson(`${s.url}/api/matches/${evicted}/latest`, FrameSchema);
      expect(s.registry.entries.get(evicted)?.timeline).not.toBeNull();
      expect(s.registry.folding()).toBe(0);
      expect(inMemory().length).toBeLessThanOrEqual(8);
      const first = await getJson(`${s.url}/api/matches/m0/latest`, FrameSchema);
      expect(canonicalJson({ ...frame, match: "m0" })).toBe(canonicalJson(first));

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
});
