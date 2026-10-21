// What is public (phase-3 design §2.4, §6.1): `publish.json` lists the public matches, re-read when
// it changes (the kill switch: a removed id disappears from every route and its sockets are told);
// a file rewritten in place (empty for a moment) unpublishes nothing; a file that still does not
// parse half a second later publishes nothing; a match published `after_end` is absent until its
// log has an end line, also after a restart; an unverifiable run is never public, not even while
// its first fold has not reached the tampered line, and is listed as such in development (no
// file); `arena.json` saying `degraded` shows as `degraded`.
// The two tests that fold several runs run in the slow suite (PERFIDIA_SLOW=1, docs/architecture.md
// §13.8: `bun run test:slow`, run by `bun run test:exit`).

// oxlint-disable no-await-in-loop -- the polls follow each other on purpose
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "@perfidia/engine/core";
import { FrameSchema, MatchListItemSchema } from "@perfidia/protocol/spectator";
import { z } from "zod";
import { startServer } from "./server.ts";
import {
  Follower,
  fakeRun,
  getJson,
  metaOf,
  rows,
  serve,
  stopServer,
  tempDir,
  testConfig,
  waitFor,
  stopServers,
} from "./testkit.test.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

afterAll(stopServers);

const LONG = 120_000;

const ids = async (url: string): Promise<string[]> =>
  (await getJson(`${url}/api/matches`, z.array(MatchListItemSchema))).map((m) => m.id);

function publishFile(path: string, matches: readonly object[]): void {
  writeFileSync(path, JSON.stringify({ format: "perfidia-publish/1", matches }));
}

describe("publish.json", () => {
  xtest(
    "lists the public matches; removing one unpublishes it live; an invalid file publishes nothing",
    async () => {
      const run = await fakeRun({ days: 1, seed: 3 });
      const root = tempDir("pub");
      cpSync(run.dir, join(root, "pub"), { recursive: true });
      cpSync(run.dir, join(root, "hidden"), { recursive: true });
      const file = join(tempDir("pub-file"), "publish.json");
      publishFile(file, [{ id: "pub", title: "A public match", featured: true }]);
      const s = serve(testConfig({ runs: root, publish: file }));
      await metaOf(s, "pub", { settled: true });
      expect(await ids(s.url)).toEqual(["pub"]);
      const list = await getJson(`${s.url}/api/matches`, z.array(MatchListItemSchema));
      expect([list[0]?.title, list[0]?.featured]).toEqual(["A public match", true]);
      expect((await fetch(`${s.url}/api/matches/hidden`)).status).toBe(404);
      expect((await fetch(`${s.url}/api/matches/hidden/latest`)).status).toBe(404);

      const f = await Follower.start(s, "pub");
      await f.until(run.lines.length - 1);
      // The kill switch.
      publishFile(file, []);
      s.reloadPublish();
      await waitFor(() => f.statuses.includes("unpublished"), 10_000, "status unpublished");
      expect((await fetch(`${s.url}/api/matches/pub`)).status).toBe(404);
      expect(await ids(s.url)).toEqual([]);
      // Back; the follower subscribes again.
      publishFile(file, [{ id: "pub", title: "Back" }]);
      s.reloadPublish();
      expect(await ids(s.url)).toEqual(["pub"]);
      const unpublished = f.statuses.filter((x) => x === "unpublished").length;
      f.subscribe();
      await waitFor(() => f.statuses.length > unpublished + 1, 10_000, "subscribed again");
      // Rewritten in place (truncated, then written 100 ms later): nothing is unpublished.
      writeFileSync(file, "");
      s.reloadPublish();
      await Bun.sleep(100);
      publishFile(file, [{ id: "pub", title: "Renamed" }]);
      await Bun.sleep(700);
      expect(await ids(s.url)).toEqual(["pub"]);
      expect(f.statuses.filter((x) => x === "unpublished")).toHaveLength(unpublished);
      // An invalid file: nothing is published until it is fixed (after the retries).
      writeFileSync(file, "{ not json");
      s.reloadPublish();
      await waitFor(async () => (await ids(s.url)).length === 0, 5_000, "fail closed");
      expect(s.warnings.some((w) => w.includes("not JSON"))).toBe(true);
      await f.disconnect();

      // A server does not start on an invalid file.
      expect(() => startServer(testConfig({ runs: root, publish: file }))).toThrow();
    },
    LONG,
  );

  test(
    "an after_end match is absent until its end line, also after a restart",
    async () => {
      const run = await fakeRun({ days: 1, seed: 3 });
      const root = tempDir("after");
      const cache = tempDir("after-cache");
      const dir = join(root, "later");
      mkdirSync(dir);
      const lines = rows(run.text);
      const half = Math.floor(lines.length / 2);
      writeFileSync(join(dir, "match.jsonl"), `${lines.slice(0, half).join("\n")}\n`);
      const file = join(tempDir("after-file"), "publish.json");
      publishFile(file, [{ id: "later", title: "Later", visibility: "after_end" }]);
      let s = serve(testConfig({ runs: root, cache, publish: file }));
      await waitFor(
        () => s.registry.entries.get("later")?.timeline?.lastSeq === half - 1,
        20_000,
        "the fold",
      );
      expect(await ids(s.url)).toEqual([]);
      expect((await fetch(`${s.url}/api/matches/later`)).status).toBe(404);
      await stopServer(s);
      s = serve(testConfig({ runs: root, cache, publish: file }));
      await waitFor(
        () => s.registry.entries.get("later")?.timeline?.lastSeq === half - 1,
        20_000,
        "the refold",
      );
      expect(await ids(s.url)).toEqual([]);
      appendFileSync(join(dir, "match.jsonl"), `${lines.slice(half).join("\n")}\n`);
      await waitFor(
        async () => (await ids(s.url)).includes("later"),
        20_000,
        "published at the end",
      );
      const meta = await metaOf(s, "later", { settled: true });
      expect([meta.status, meta.lastSeq]).toEqual(["ended", lines.length - 1]);
    },
    LONG,
  );
});

describe("status from the log and the side files", () => {
  xtest(
    "an unverifiable run is never public, listed as unverifiable in development; degraded from arena.json",
    async () => {
      const run = await fakeRun({ days: 1, seed: 3 });
      const root = tempDir("status");
      // A run whose overrides no longer resolve (like a run made by an older build).
      const stale = join(root, "stale");
      mkdirSync(stale);
      const header = {
        ...run.header,
        setup: { ...run.header.setup, overrides: { "map.kinds.frontier.slots": 1000 } },
      };
      const lines = rows(run.text);
      writeFileSync(
        join(stale, "match.jsonl"),
        `${[JSON.stringify(header), ...lines.slice(1)].join("\n")}\n`,
      );
      // A run whose arena says too many LLM turns failed.
      cpSync(run.dir, join(root, "degraded"), { recursive: true });
      const arena = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(await Bun.file(join(run.dir, "arena.json")).text()));
      writeFileSync(
        join(root, "degraded", "arena.json"),
        JSON.stringify({ ...arena, status: "degraded" }),
      );

      // A tampered log (one event's time changed near its end): with a publish file, it is never
      // served, not even while its first fold has not reached that line yet.
      const tampered = join(root, "tampered");
      mkdirSync(tampered);
      const at = lines.findLastIndex((l) => l.includes('"k":"ev"'));
      const edited = lines.map((l, i) => (i === at ? l.replace(/"t":([0-9]+)/, '"t":$1999') : l));
      expect(edited[at]).not.toBe(lines[at]);
      writeFileSync(join(tampered, "match.jsonl"), `${edited.join("\n")}\n`);
      // A line that is not a log line: unverifiable from there, in the meta and in the frames.
      mkdirSync(join(root, "bogus"));
      writeFileSync(
        join(root, "bogus", "match.jsonl"),
        `${[...lines.slice(0, 300), '{"k":"bogus"}'].join("\n")}\n`,
      );

      const dev = serve(testConfig({ runs: root }));
      const staleMeta = await metaOf(dev, "stale", { settled: true });
      expect([staleMeta.status, staleMeta.reason, staleMeta.verified.ok]).toEqual([
        "unverifiable",
        "unverifiable",
        false,
      ]);
      expect(staleMeta.verified.divergence).not.toContain(run.header.setup.idKey);
      const degraded = await metaOf(dev, "degraded", { settled: true });
      expect([degraded.status, degraded.reason]).toEqual(["degraded", "model_errors"]);
      const tamperedMeta = await metaOf(dev, "tampered", { settled: true });
      expect([tamperedMeta.status, tamperedMeta.verified.ok]).toEqual(["unverifiable", false]);
      const bogus = await metaOf(dev, "bogus", { settled: true });
      expect([bogus.status, bogus.verified, bogus.lastSeq]).toEqual([
        "unverifiable",
        { ok: false, divergence: "line 300 is not a valid log line" },
        300,
      ]);
      const bogusTail = await getJson(`${dev.url}/api/matches/bogus/latest`, FrameSchema);
      expect([bogusTail.status, bogusTail.seq]).toEqual(["unverifiable", 300]);
      expect((await ids(dev.url)).toSorted((a, b) => (a < b ? -1 : 1))).toEqual([
        "bogus",
        "degraded",
        "stale",
        "tampered",
      ]);

      const file = join(tempDir("status-file"), "publish.json");
      publishFile(file, [
        { id: "stale", title: "Stale" },
        { id: "degraded", title: "Degraded" },
        { id: "tampered", title: "Tampered" },
      ]);
      const pub = serve(testConfig({ runs: root, publish: file }));
      // Polled while the folds run: the tampered run is never listed nor served.
      let seen = false;
      for (;;) {
        const listed = await ids(pub.url);
        const meta = await fetch(`${pub.url}/api/matches/tampered`);
        await meta.arrayBuffer();
        if (listed.includes("tampered") || meta.status !== 404) seen = true;
        const e = pub.registry.entries.get("tampered");
        if (e?.timeline?.verified.ok === false && !e.loading) break;
        await Bun.sleep(5);
      }
      expect(seen).toBe(false);
      await metaOf(pub, "degraded", { settled: true });
      await waitFor(
        () => pub.registry.entries.get("stale")?.timeline?.verified.ok === false,
        20_000,
        "the stale fold",
      );
      expect(await ids(pub.url)).toEqual(["degraded"]);
      expect((await fetch(`${pub.url}/api/matches/stale`)).status).toBe(404);
      expect((await fetch(`${pub.url}/api/matches/tampered`)).status).toBe(404);
      // The same steps whichever server folded them.
      const a = await getJson(`${dev.url}/api/matches/degraded/latest`, z.unknown());
      const b = await getJson(`${pub.url}/api/matches/degraded/latest`, z.unknown());
      expect(canonicalJson(a)).toBe(canonicalJson(b));
    },
    LONG,
  );
});
