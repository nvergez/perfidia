// The war golden served through the API (phase-3 design §1.2, §6.1): a run directory holding the
// committed `perfidia-1@1.1.0/lockstep-6p-6d-war.jsonl.gz` is folded by the server's worker; a
// client that reads the meta, keyframe 0 and every steps page and reduces them ends with the final
// standings of the log's end line, the same steps as a direct fold, and every keyframe equal to the
// reduction up to its cursor. Then the server restarts from its cache: same timeline, same steps,
// no fold.

// oxlint-disable no-await-in-loop -- the requests, pages and chunks follow each other on purpose (one cursor, one writer)
import { afterAll, describe, expect, test } from "bun:test";
import { canonicalJson } from "@perfidia/engine/core";
import {
  FeedPageSchema,
  FrameSchema,
  MomentSchema,
  StepsPageSchema,
  type Frame,
  type Step,
} from "@perfidia/protocol/spectator";
import { applySteps, standingsOf } from "@perfidia/spectator/reduce";
import { z } from "zod";
import {
  foldWhole,
  getJson,
  metaOf,
  parseLog,
  serve,
  sharedWarCache,
  stopServer,
  testConfig,
  warRoot,
  warText,
  stopServers,
} from "./testkit.test.ts";

afterAll(stopServers);

const LONG = 120_000;

async function allSteps(base: string, timeline: string, limit: number): Promise<Step[]> {
  const steps: Step[] = [];
  let after = -1;
  for (;;) {
    const page = await getJson(
      `${base}/api/matches/war/t/${timeline}/steps?after=${after}&limit=${limit}`,
      StepsPageSchema,
    );
    expect(page.from).toBe(after);
    steps.push(...page.steps);
    after = page.to;
    if (!page.more) return steps;
  }
}

describe("the war golden through the API", () => {
  test(
    "reduces to the end line's standings; same steps as a direct fold; keyframes consistent; restart from the cache",
    async () => {
      const lines = parseLog(warText());
      const end = lines.at(-1);
      if (end?.k !== "end") throw new Error("the war golden has no end line");
      const root = warRoot();
      // The cache may already hold the war golden's timeline (another test file folded it); the
      // steps are compared with a direct fold either way.
      const cache = sharedWarCache();
      const t0 = performance.now();
      const s = serve(testConfig({ runs: root, cache }));
      const meta = await metaOf(s, "war", { settled: true });
      const foldMs = Math.round(performance.now() - t0);
      expect([meta.status, meta.reason, meta.verified]).toEqual([
        "ended",
        "domination",
        { ok: true, divergence: null },
      ]);
      expect(meta.lastSeq).toBe(lines.length - 1);
      expect(meta.map.islands).toHaveLength(31);
      expect(meta.seats.map((x) => x.kind)).toEqual(["bot", "bot", "bot", "bot", "bot", "bot"]);

      const base = s.url;
      const k0 = await getJson(
        `${base}/api/matches/war/t/${meta.timeline}/keyframes/0`,
        FrameSchema,
      );
      const steps = await allSteps(base, meta.timeline, 2_000);
      const frame: Frame = applySteps(k0, steps);
      expect(standingsOf(frame)).toEqual(end.result.standings);
      expect(frame.result).toEqual({ reason: end.result.reason, winners: end.result.winners });
      expect(Object.keys(frame.cities)).toHaveLength(42);

      // Compared canonically: the schemas' parse orders keys as the schemas declare them.
      const direct = foldWhole(lines, "war");
      expect(canonicalJson(steps)).toBe(canonicalJson(direct.steps));
      expect(canonicalJson(frame)).toBe(canonicalJson(direct.frame()));
      const latest = await getJson(`${base}/api/matches/war/latest`, FrameSchema);
      expect(canonicalJson(latest)).toBe(canonicalJson(frame));

      // Every keyframe equals keyframe 0 reduced by the steps up to its cursor.
      expect(meta.keyframes[0]).toBe(0);
      expect(meta.keyframes.length).toBeGreaterThan(20);
      const wanted = new Set(meta.keyframes);
      let at: Frame = k0;
      let compared = 1;
      for (const step of steps) {
        at = applySteps(at, [step]);
        if (!wanted.has(step.seq)) continue;
        const k = await getJson(
          `${base}/api/matches/war/t/${meta.timeline}/keyframes/${step.seq}`,
          FrameSchema,
        );
        expect([step.seq, canonicalJson(k)]).toEqual([step.seq, canonicalJson(at)]);
        compared += 1;
      }
      expect(compared).toBe(meta.keyframes.length);
      // Smaller pages cover the same steps.
      expect(canonicalJson(await allSteps(base, meta.timeline, 777))).toBe(canonicalJson(steps));

      // The moments and the feed carry the betrayal and the countdown.
      const moments = await getJson(
        `${base}/api/matches/war/t/${meta.timeline}/moments`,
        z.array(MomentSchema),
      );
      // p2 betrays its ally p3 at c18 at D4 12:50.
      const betrayal = moments.filter((m) => m.k === "betrayal");
      expect(betrayal.map((m) => [m.players, Math.floor(m.t / 60)])).toEqual([
        [["p2", "p3"], (3 * 86_400 + 12 * 3600 + 50 * 60) / 60],
      ]);
      const betrayals = await getJson(
        `${base}/api/matches/war/feed?kinds=betrayal`,
        FeedPageSchema,
      );
      expect(betrayals.items).toHaveLength(1);
      const pair = await getJson(
        `${base}/api/matches/war/feed?pair=p2,p3&limit=200`,
        FeedPageSchema,
      );
      expect(
        pair.items.every((e) => e.item.players.includes("p2") && e.item.players.includes("p3")),
      ).toBe(true);
      const battles = await getJson(
        `${base}/api/matches/war/feed?kinds=battle&limit=200`,
        FeedPageSchema,
      );
      expect(battles.items).toHaveLength(42);

      const bytes = JSON.stringify(steps).length;
      console.log(
        `war golden through the API: ${lines.length} lines folded (or read from the cache) and served in ${foldMs} ms; ${steps.length} steps (${bytes} bytes), ${meta.keyframes.length} keyframes, ${moments.length} moments`,
      );

      // A restart reads the cache: the same timeline and steps, ready without a fold.
      await stopServer(s);
      const t1 = performance.now();
      const again = serve(testConfig({ runs: root, cache }));
      const meta2 = await metaOf(again, "war", { settled: true });
      const loadMs = Math.round(performance.now() - t1);
      expect(meta2.timeline).toBe(meta.timeline);
      expect(again.registry.folding()).toBe(0);
      expect(canonicalJson(await allSteps(again.url, meta.timeline, 2_000))).toBe(
        canonicalJson(steps),
      );
      console.log(`war golden restarted from the cache: meta ready in ${loadMs} ms`);
    },
    LONG,
  );
});
