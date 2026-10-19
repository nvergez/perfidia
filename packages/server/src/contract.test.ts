// The API contract (phase-3 design §3.1, §3.3, §6.1), against both HTTP adapters (Elysia 2 and
// the raw `Bun.serve` fallback): every route on the war golden and on a 1-day fake arena run, each
// body parsed with the protocol's Zod schemas; the OpenAPI document's paths pinned; errors as data
// (`{ok: false, code, message, hint}`) with 404, 405, 421, 422; exact paths only (a trailing slash
// is not a route, so `/api/live/` cannot skip the WebSocket checks), the same answers from both
// adapters on edge inputs, the Host checked (DNS rebinding) and the WebSocket origin derived from
// the server's own host names; cache headers (`private`), ETags and gzip; HEAD; one Eden `treaty`
// smoke test on the Elysia app's typed route.

// oxlint-disable no-await-in-loop -- the requests, pages and chunks follow each other on purpose (one cursor, one writer)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import {
  ApiErrorSchema,
  FeedPageSchema,
  FrameSchema,
  HealthSchema,
  MatchListItemSchema,
  MatchMetaSchema,
  MomentSchema,
  PlayerDossierSchema,
  ReportDetailSchema,
  StepsPageSchema,
  TurnAnnotationSchema,
  type MatchMeta,
} from "@perfidia/protocol/spectator";
import { z } from "zod";
import type { SpectatorApp } from "./http/elysia.ts";
import {
  WAR_GOLDEN,
  fakeRun,
  getJson,
  metaOf,
  serve,
  sharedWarCache,
  tempDir,
  testConfig,
  type FakeRun,
  type TestServer,
  stopServers,
} from "./testkit.test.ts";

afterAll(stopServers);

const LONG = 120_000;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const PATHS = [
  "/api/health",
  "/api/live",
  "/api/matches",
  "/api/matches/{id}",
  "/api/matches/{id}/annotations/{seat}/{turn}",
  "/api/matches/{id}/feed",
  "/api/matches/{id}/latest",
  "/api/matches/{id}/players/{seat}",
  "/api/matches/{id}/reports/{report}",
  "/api/matches/{id}/t/{timeline}/keyframes/{seq}",
  "/api/matches/{id}/t/{timeline}/moments",
  "/api/matches/{id}/t/{timeline}/steps",
];

let root = "";
let cache = "";
let fake: FakeRun;

beforeAll(async () => {
  fake = await fakeRun({ days: 1, seed: 3 });
  root = tempDir("contract");
  cache = sharedWarCache();
  mkdirSync(join(root, "war"));
  copyFileSync(WAR_GOLDEN, join(root, "war", "match.jsonl.gz"));
  cpSync(fake.dir, join(root, "fake"), { recursive: true });
}, LONG);

async function expectError(
  url: string,
  status: number,
  code: string,
  init?: RequestInit,
): Promise<void> {
  const res = await fetch(url, init);
  const body = ApiErrorSchema.parse(await res.json());
  expect([url, res.status, body.code]).toEqual([url, status, code]);
  expect(body.message.length).toBeGreaterThan(0);
  expect(body.hint.length).toBeGreaterThan(0);
}

for (const adapter of ["elysia", "raw"] as const) {
  describe(`the API contract (${adapter} adapter)`, () => {
    let s: TestServer;
    let war: MatchMeta;
    let fk: MatchMeta;

    beforeAll(async () => {
      s = serve(testConfig({ runs: root, cache, adapter }));
      war = await metaOf(s, "war", { settled: true });
      fk = await metaOf(s, "fake", { settled: true });
    }, LONG);

    test("health, the list, and the OpenAPI document's paths", async () => {
      const h = await getJson(`${s.url}/api/health`, HealthSchema);
      expect([h.ok, h.format]).toEqual([true, "perfidia-spectator/1"]);
      const list = await getJson(`${s.url}/api/matches`, z.array(MatchListItemSchema));
      const fakeEnd = fake.lines.at(-1);
      if (fakeEnd?.k !== "end") throw new Error("the fake run has no end line");
      expect(list.map((m) => [m.id, m.status, m.winners])).toEqual([
        ["fake", "ended", fakeEnd.result.winners],
        ["war", "ended", ["p1", "p4"]],
      ]);
      expect(list[0]?.seats.filter((x) => x.kind === "llm").every((x) => x.fake)).toBe(true);
      const doc = z
        .looseObject({
          paths: z.record(z.string(), z.unknown()),
          components: z.looseObject({ schemas: z.record(z.string(), z.unknown()) }),
        })
        .parse(await (await fetch(`${s.url}/api/openapi/json`)).json());
      expect(Object.keys(doc.paths).toSorted(byText)).toEqual(PATHS);
      expect(Object.keys(doc.components.schemas)).toContain("Frame");
      // The UI page is for development only.
      expect((await fetch(`${s.url}/api/openapi`)).status).toBe(404);
    });

    test(
      "every route of both matches parses with the protocol's schemas",
      async () => {
        for (const meta of [war, fk]) {
          const id = meta.id;
          const base = `${s.url}/api/matches/${id}`;
          const t = `${base}/t/${meta.timeline}`;
          for (const seq of [meta.keyframes[0], meta.keyframes.at(-1)]) {
            const k = await getJson(`${t}/keyframes/${seq ?? 0}`, FrameSchema);
            expect(k.seq).toBe(seq ?? 0);
          }
          const latest = await getJson(`${base}/latest`, FrameSchema);
          expect(latest.status).toBe("ended");
          let after = -1;
          let pages = 0;
          for (;;) {
            const page = await getJson(`${t}/steps?after=${after}&limit=1000`, StepsPageSchema);
            pages += 1;
            after = page.to;
            if (!page.more) break;
          }
          expect(after).toBe(meta.lastSeq);
          expect(pages).toBeGreaterThan(0);
          const moments = await getJson(`${t}/moments`, z.array(MomentSchema));
          expect(moments.length).toBeGreaterThan(0);
          const feed = await getJson(`${base}/feed`, FeedPageSchema);
          expect(feed.items.length).toBe(50);
          expect(feed.more).toBe(true);
          const first = feed.items[0];
          if (first === undefined) throw new Error("empty feed");
          const before = await getJson(`${base}/feed?before=${first.seq}&limit=10`, FeedPageSchema);
          expect(before.items.every((e) => e.seq < first.seq)).toBe(true);
          const fromStart = await getJson(`${base}/feed?after=-1&limit=200`, FeedPageSchema);
          expect(fromStart.items[0]?.seq).toBeLessThanOrEqual(fromStart.items.at(-1)?.seq ?? 0);
          const p1 = await getJson(
            `${base}/feed?players=p1&kinds=message,proposal,turn&limit=200`,
            FeedPageSchema,
          );
          expect(p1.items.every((e) => e.item.players.includes("p1"))).toBe(true);
          const priv = await getJson(`${base}/feed?private=true&limit=200`, FeedPageSchema);
          expect(priv.items.every((e) => e.item.k === "message" && e.item.private)).toBe(true);
          for (const seat of meta.seats) {
            const d = await getJson(`${base}/players/${seat.seat}`, PlayerDossierSchema);
            expect(d.seat).toEqual(seat);
          }
        }
        // A battle report of the war golden, with its other copies.
        const battles = await getJson(
          `${s.url}/api/matches/war/feed?kinds=battle&limit=1`,
          FeedPageSchema,
        );
        const battle = battles.items[0]?.item;
        if (battle?.k !== "battle") throw new Error("no battle");
        const report = battle.reports[0];
        if (report === undefined) throw new Error("no report");
        const r = await getJson(`${s.url}/api/matches/war/reports/${report}`, ReportDetailSchema);
        expect(r.copies.toSorted(byText)).toEqual(
          battle.reports.filter((x) => x !== report).toSorted(byText),
        );
        // An LLM turn of the fake run.
        const turn = fake.lines.find((l) => l.k === "turn" && l.seat === "p2");
        if (turn?.k !== "turn") throw new Error("no turn");
        const a = await getJson(
          `${s.url}/api/matches/fake/annotations/p2/${turn.turn}`,
          TurnAnnotationSchema,
        );
        expect(a.seat).toBe("p2");
        // The meta says what is published; an LLM turn's item carries its calls' verdicts.
        const fakeMeta = await getJson(`${s.url}/api/matches/fake`, MatchMetaSchema);
        expect(fakeMeta.published).toEqual({ costs: true, reasoning: true });
        const turns = await getJson(
          `${s.url}/api/matches/fake/feed?kinds=turn&players=p2&limit=20`,
          FeedPageSchema,
        );
        const llmTurn = turns.items.find((e) => e.item.k === "turn" && e.item.llm)?.item;
        expect(llmTurn?.k === "turn" ? (llmTurn.results?.length ?? 0) : 0).toBeGreaterThan(0);
      },
      LONG,
    );

    test("errors are data: 404, 405, 422, with a code, a message and a hint", async () => {
      const base = `${s.url}/api/matches/war`;
      const t = `${base}/t/${war.timeline}`;
      await expectError(`${s.url}/api/matches/nope`, 404, "NOT_FOUND");
      await expectError(`${s.url}/api/matches/no%20pe`, 422, "BAD_REQUEST");
      await expectError(`${base}/t/xyz/steps`, 422, "BAD_REQUEST");
      await expectError(`${base}/t/0123456789abcdef/steps`, 404, "TIMELINE_GONE");
      await expectError(`${t}/keyframes/5`, 404, "NO_KEYFRAME");
      await expectError(`${t}/steps?limit=0`, 422, "BAD_REQUEST");
      await expectError(`${t}/steps?limit=5000`, 422, "BAD_REQUEST");
      await expectError(`${t}/steps?after=x`, 422, "BAD_REQUEST");
      await expectError(`${t}/steps?bogus=1`, 422, "BAD_REQUEST");
      await expectError(`${t}/steps?after=1&after=2`, 422, "BAD_REQUEST");
      await expectError(`${base}/feed?kinds=bogus`, 422, "BAD_REQUEST");
      await expectError(`${base}/feed?pair=p1`, 422, "BAD_REQUEST");
      await expectError(`${base}/feed?limit=500`, 422, "BAD_REQUEST");
      await expectError(`${base}/players/p9`, 404, "NO_SEAT");
      await expectError(`${base}/players/x9`, 422, "BAD_REQUEST");
      await expectError(`${base}/reports/r999`, 422, "BAD_REQUEST");
      await expectError(`${base}/annotations/p1/1`, 404, "NO_ANNOTATION");
      await expectError(`${s.url}/api/nope`, 404, "NO_ROUTE");
      await expectError(`${s.url}/index.html`, 404, "NO_ROUTE");
      await expectError(`${s.url}/api/matches`, 405, "METHOD_NOT_ALLOWED", { method: "POST" });
      await expectError(base, 405, "METHOD_NOT_ALLOWED", { method: "DELETE" });
      await expectError(`${s.url}/api/live`, 426, "UPGRADE_REQUIRED");
    });

    test("exact paths only, the same answers from both adapters; the Host and origins checked", async () => {
      const base = `${s.url}/api/matches/war`;
      for (const path of [
        "/api/matches/war/",
        "/api/matches/war/latest/",
        "/api/matches/",
        "/api/openapi/",
        "/api/openapi/json/",
        "/api/health/",
        "/api//matches",
      ]) {
        await expectError(`${s.url}${path}`, 404, "NO_ROUTE");
      }
      await expectError(`${s.url}/api/health?x=1`, 422, "BAD_REQUEST");
      await expectError(`${s.url}/api/matches/%`, 422, "BAD_REQUEST");
      // Another Host (a DNS-rebinding page): refused everywhere but the health check.
      const port = new URL(s.url).port;
      const rebind = { headers: { host: `rebind.attacker.example:${port}` } };
      await expectError(`${s.url}/api/matches`, 421, "WRONG_HOST", rebind);
      await expectError(base, 421, "WRONG_HOST", rebind);
      expect((await fetch(`${s.url}/api/health`, rebind)).status).toBe(200);
      expect(
        (await fetch(`${s.url}/api/matches`, { headers: { host: `localhost:${port}` } })).status,
      ).toBe(200);
      // WebSocket upgrades: a foreign origin is refused on every spelling of the path, a trailing
      // slash is no route, and the origin is never taken from the request's own Host.
      const ws = s.url.replace("http", "ws");
      const open = (path: string, headers: Record<string, string>): Promise<boolean> =>
        new Promise((resolve) => {
          const sock = new WebSocket(`${ws}${path}`, { headers });
          sock.addEventListener("open", () => {
            sock.close();
            resolve(true);
          });
          sock.addEventListener("error", () => resolve(false));
        });
      const before = s.hub.count;
      for (const path of ["/api/live", "/api/live/", "/api/live/?x", "/api/live?x"]) {
        expect([path, await open(path, { origin: "https://evil.example" })]).toEqual([path, false]);
      }
      expect(await open("/api/live/", { origin: s.url })).toBe(false);
      const evil = `rebind.attacker.example:${port}`;
      expect(await open("/api/live", { host: evil, origin: `http://${evil}` })).toBe(false);
      expect(s.hub.count).toBe(before);
      expect(await open("/api/live?x", { origin: s.url })).toBe(true);
      expect(await open("/api/live", { origin: `http://localhost:${port}` })).toBe(true);
    });

    test("cache headers, ETags, gzip and HEAD", async () => {
      const base = `${s.url}/api/matches/war`;
      const t = `${base}/t/${war.timeline}`;
      const k = await fetch(`${t}/keyframes/0`);
      // `private`: browsers keep immutable bodies, shared caches do not (takedowns).
      expect(k.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
      const etag = k.headers.get("etag");
      expect(etag).not.toBeNull();
      const again = await fetch(`${t}/keyframes/0`, { headers: { "if-none-match": etag ?? "" } });
      expect(again.status).toBe(304);
      const steps = await fetch(`${t}/steps?after=-1&limit=2000`, {
        headers: { "accept-encoding": "gzip" },
        decompress: false,
      } as RequestInit);
      expect(steps.headers.get("content-encoding")).toBe("gzip");
      expect(steps.headers.get("cache-control")).toContain("immutable");
      const raw = new Uint8Array(await steps.arrayBuffer());
      StepsPageSchema.parse(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(raw))));
      expect((await fetch(`${base}/latest`)).headers.get("cache-control")).toBe("no-store");
      expect((await fetch(base)).headers.get("cache-control")).toBe("private, max-age=3600");
      expect((await fetch(`${s.url}/api/health`)).headers.get("cache-control")).toBe("no-store");
      const head = await fetch(`${s.url}/api/matches`, { method: "HEAD" });
      expect([head.status, (await head.text()).length]).toEqual([200, 0]);
    });

    if (adapter === "elysia") {
      test("Eden: a typed client of the Elysia app", async () => {
        const api = treaty<SpectatorApp>(s.url);
        const res = await api.api.health.get();
        expect(res.status).toBe(200);
        const h = HealthSchema.parse(res.data);
        expect(h.format).toBe("perfidia-spectator/1");
      });
    }
  });
}
