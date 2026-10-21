// The statistics routes (phase-4 design §6.3, §8.8), against both HTTP adapters (Elysia 2 and the
// raw `Bun.serve` fallback): `GET /api/matches/:id/stats` equals the command line's statistics of
// the same run directory (the server's come from its fold workers' steps, the command line's from a
// whole fold), its series match from the root's `series.json`, with the routes' cache headers;
// `GET /api/models` and `/api/models/:id` serve the `--stats` file without its seat list, say how
// many more matches a claim needs and show no ranking; `--no-costs` withholds every cost, token and
// model-time figure; `publish.json` visibility holds (an unlisted match is a 404, a statistics file
// that aggregates one is not served, an `--exploratory` file never is); errors are data. Review
// fixes: while a match's first fold runs its statistics are a 503 `LOADING`, never figures of a
// half-folded log; a file whose claim state is not `ok` is served without ratings, outcomes or
// ranks whatever it holds.
// Slow suite only (docs/architecture.md §13.8): skipped unless PERFIDIA_SLOW=1
// (`bun run test:slow`, which `bun run test:exit` runs).

// oxlint-disable no-await-in-loop -- the requests follow each other on purpose
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelStatsFileSchema } from "@perfidia/protocol";
import {
  ApiErrorSchema,
  MatchStatsSchema,
  ModelDetailSchema,
  ModelsResponseSchema,
} from "@perfidia/protocol/spectator";
import {
  WAR_GOLDEN,
  getJson,
  metaOf,
  serve,
  stopServers,
  tempDir,
  testConfig,
  type TestServer,
} from "../testkit.test.ts";
import { main } from "./cli.ts";
import { seriesRoot } from "./fixtures.test.ts";
import { statsOfRunDir } from "./runs.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);
/** A group of tests of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xdescribe = describe.skipIf(!SLOW);

const LONG = 180_000;

afterAll(stopServers);

let root = "";
let cache = "";
let statsFile = "";
let publicStats = "";
let exploratoryStats = "";
let publish = "";
let craftedStats = "";

function aggregateTo(out: string, extra: readonly string[] = []): void {
  const code = main(["aggregate", "--runs", root, "--out", out, "--replicates", "0", ...extra], {
    out: () => undefined,
    err: () => undefined,
  });
  if (code !== 0) throw new Error(`stats aggregate exited ${code}`);
}

beforeAll(async () => {
  if (!SLOW) return;
  root = await seriesRoot();
  cache = tempDir("stats-routes-cache");
  const dir = tempDir("stats-routes");
  statsFile = join(dir, "stats.json");
  aggregateTo(statsFile);
  publish = join(dir, "publish.json");
  writeFileSync(
    publish,
    JSON.stringify({
      format: "perfidia-publish/1",
      matches: ["m01", "m02", "m03"].map((id) => ({ id, title: id })),
    }),
  );
  publicStats = join(dir, "public.json");
  aggregateTo(publicStats, ["--publish", publish]);
  exploratoryStats = join(dir, "exploratory.json");
  aggregateTo(exploratoryStats, ["--exploratory"]);
  // An exploratory file passed off as servable: its claim state is too_few_matches, yet it holds
  // ratings, outcomes and ranks (a hand-edited or buggy file).
  const crafted = ModelStatsFileSchema.parse(JSON.parse(readFileSync(exploratoryStats, "utf8")));
  craftedStats = join(dir, "crafted.json");
  writeFileSync(craftedStats, JSON.stringify({ ...crafted, exploratory: false }));
}, LONG);

async function error(url: string, status: number, code: string): Promise<void> {
  const res = await fetch(url);
  const body = ApiErrorSchema.parse(await res.json());
  expect([url, res.status, body.code]).toEqual([url, status, code]);
  expect(body.hint.length).toBeGreaterThan(0);
}

async function settled(s: TestServer, ids: readonly string[]): Promise<void> {
  for (const id of ids) await metaOf(s, id, { settled: true });
}

for (const adapter of ["elysia", "raw"] as const) {
  xdescribe(`the statistics routes (${adapter} adapter)`, () => {
    let s: TestServer;
    let hidden: TestServer;

    beforeAll(async () => {
      s = serve(testConfig({ runs: root, cache, adapter, stats: statsFile }));
      hidden = serve(
        testConfig({
          runs: root,
          cache,
          adapter,
          stats: statsFile,
          policy: { costs: false, reasoning: true },
        }),
      );
      await settled(s, ["m01", "m02", "m03", "m04"]);
      await settled(hidden, ["m01", "m02", "m03", "m04"]);
    }, LONG);

    test("a match's statistics equal the command line's, with its series match", async () => {
      for (const id of ["m01", "m04"]) {
        const res = await fetch(`${s.url}/api/matches/${id}/stats`);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
        const served = MatchStatsSchema.parse(await res.json());
        const index = Number(id.slice(1));
        const cli = statsOfRunDir(join(root, id), {
          series: { lineup: "budget-mix", block: 0, index },
        }).stats;
        expect(served).toEqual(cli);
        expect(served.series?.index).toBe(index);
        expect(served.rated).toBe(true);
      }
      await error(`${s.url}/api/matches/nope/stats`, 404, "NOT_FOUND");
    });

    test("the models: no seat list, the claim state, no ranking below the threshold", async () => {
      const res = await fetch(`${s.url}/api/models`);
      expect(res.headers.get("cache-control")).toBe("private, max-age=60");
      const body: unknown = await res.json();
      const models = ModelsResponseSchema.parse(body);
      const keys = typeof body === "object" && body !== null ? Object.keys(body) : [];
      expect(keys).not.toContain("seats");
      expect(keys).not.toContain("exploratory");
      expect(models.claims).toMatchObject({ state: "too_few_matches", needed: 74, more: 70 });
      expect(models.ratings).toBeNull();
      expect(models.models.every((m) => m.outcome === null)).toBe(true);
      expect(models.series[0]?.found).toBe(4);
      const id = "fake.gpt-6-luna.medium";
      const detail = await getJson(`${s.url}/api/models/${id}`, ModelDetailSchema);
      expect(detail.model.id).toBe(id);
      expect(detail.rating).toBeNull();
      expect(detail.seats.map((x) => [x.match, x.rank])).toEqual([
        ["m01", null],
        ["m02", null],
        ["m03", null],
        ["m04", null],
      ]);
      expect(detail.seats.every((x) => x.costNanoUsd !== null && x.costNanoUsd > 0)).toBe(true);
      await error(`${s.url}/api/models/no.such.model`, 404, "NO_MODEL");
      await error(`${s.url}/api/models/Bad%20Id`, 422, "BAD_REQUEST");
    });

    test("--no-costs: every cost, token and model-time figure is withheld", async () => {
      const m = await getJson(`${hidden.url}/api/matches/m02/stats`, MatchStatsSchema);
      expect(m.published.costs).toBe(false);
      expect(m.cost).toBeNull();
      for (const seat of m.seats) {
        expect([seat.seat, seat.cost, seat.operations?.latencyMs ?? null]).toEqual([
          seat.seat,
          null,
          null,
        ]);
      }
      const models = await getJson(`${hidden.url}/api/models`, ModelsResponseSchema);
      expect(models.published.costs).toBe(false);
      expect(models.models.every((x) => x.cost === null)).toBe(true);
      expect(models.models.every((x) => (x.operations?.latencyMs ?? null) === null)).toBe(true);
      const detail = await getJson(
        `${hidden.url}/api/models/fake.gpt-6-luna.medium`,
        ModelDetailSchema,
      );
      expect(detail.seats.every((x) => x.costNanoUsd === null)).toBe(true);
      expect(JSON.stringify(models)).not.toContain('NanoUsd":1');
    });

    test("publish.json: unlisted matches are 404s; statistics that aggregate one are not served", async () => {
      const listed = serve(testConfig({ runs: root, cache, adapter, publish, stats: statsFile }));
      await settled(listed, ["m01", "m02", "m03"]);
      await error(`${listed.url}/api/matches/m04/stats`, 404, "NOT_FOUND");
      await getJson(`${listed.url}/api/matches/m03/stats`, MatchStatsSchema);
      await error(`${listed.url}/api/models`, 404, "STATS_NOT_PUBLIC");
      await error(`${listed.url}/api/models/fake.gpt-6-luna.medium`, 404, "STATS_NOT_PUBLIC");
      const fit = serve(testConfig({ runs: root, cache, adapter, publish, stats: publicStats }));
      await settled(fit, ["m01", "m02", "m03"]);
      const models = await getJson(`${fit.url}/api/models`, ModelsResponseSchema);
      expect(models.matches.map((m) => m.match)).toEqual(["m01", "m02", "m03"]);
    });

    test("a file below the threshold is served without ratings, outcomes or ranks (defence in depth)", async () => {
      const crafted = ModelStatsFileSchema.parse(JSON.parse(readFileSync(craftedStats, "utf8")));
      expect(crafted.claims.state).toBe("too_few_matches");
      expect(crafted.ratings).not.toBeNull();
      expect(crafted.seats.some((x) => x.rank !== null)).toBe(true);
      const c = serve(testConfig({ runs: root, cache, adapter, stats: craftedStats }));
      await settled(c, ["m01", "m02", "m03", "m04"]);
      const models = await getJson(`${c.url}/api/models`, ModelsResponseSchema);
      expect(models.ratings).toBeNull();
      expect(models.models.every((m) => m.outcome === null)).toBe(true);
      const detail = await getJson(`${c.url}/api/models/fake.gpt-6-luna.medium`, ModelDetailSchema);
      expect(detail.rating).toBeNull();
      expect(detail.model.outcome).toBeNull();
      expect(detail.seats.every((x) => x.rank === null)).toBe(true);
    });

    test("no --stats, or an --exploratory file: no model statistics", async () => {
      const none = serve(testConfig({ runs: root, cache, adapter }));
      await settled(none, ["m01"]);
      await error(`${none.url}/api/models`, 404, "NO_STATS");
      const explore = serve(testConfig({ runs: root, cache, adapter, stats: exploratoryStats }));
      await settled(explore, ["m01", "m02", "m03", "m04"]);
      await error(`${explore.url}/api/models`, 404, "NO_STATS");
      expect(explore.warnings.some((w) => w.includes("--exploratory file is never served"))).toBe(
        true,
      );
    });
  });
}

xtest(
  "while a match's first fold runs, its statistics are 503 LOADING, never a half-folded log's",
  async () => {
    const runs = tempDir("stats-cold");
    mkdirSync(join(runs, "war"));
    copyFileSync(WAR_GOLDEN, join(runs, "war", "match.jsonl.gz"));
    const s = serve(testConfig({ runs, cache: tempDir("stats-cold-cache") }));
    const seen: string[] = [];
    let first: unknown = null;
    for (const end = performance.now() + LONG; performance.now() < end;) {
      const res = await fetch(`${s.url}/api/matches/war/stats`);
      const body: unknown = await res.json();
      if (res.status === 200) {
        first = body;
        break;
      }
      seen.push(`${res.status} ${ApiErrorSchema.parse(body).code}`);
      await Bun.sleep(20);
    }
    // The fold of the war golden (16,253 lines) takes seconds: the route said LOADING meanwhile.
    expect(seen).toContain("503 LOADING");
    expect(seen.every((x) => x === "503 LOADING" || x === "404 NOT_FOUND")).toBe(true);
    const stats = MatchStatsSchema.parse(first);
    expect(stats.status).toBe("ended");
    expect(stats.lastT).toBe(stats.endedAt ?? -1);
    // The first statistics served are the final ones.
    expect(await getJson(`${s.url}/api/matches/war/stats`, MatchStatsSchema)).toEqual(stats);
  },
  LONG,
);
