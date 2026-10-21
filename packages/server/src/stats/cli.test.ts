// `bun run stats` (phase-4 design §6.3, §8.8), in-process: `match` prints a seat table and, with
// `--json`, a `perfidia-stats/1` document; a capped run's hand-off and LLM figures equal the
// orchestrator's `arena.json`; `aggregate` over a rotated fake series groups its matches by
// `series.json` (one block of four), says how many more matches a claim needs and shows no ranking;
// old run directories (`perfidia-arena/1`, bots only) aggregate without error; `--no-costs`,
// `--publish`, `--out`, usage errors; `power` prints the design's table. Review fixes: `--publish`
// leaves out a listed match the server would hide (its log does not verify); a run with a 300-
// character model id aggregates (bounded ids); a run's control characters never reach the terminal;
// `power --p 0.5` measures the size.

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ArenaReportAnySchema,
  MatchStatsSchema,
  ModelStatsFileSchema,
  type MatchStats,
  type ModelStatsFile,
} from "@perfidia/protocol";
import { tempDir } from "../testkit.test.ts";
import { mixedRoot, seriesRoot } from "./fixtures.test.ts";
import { main } from "./cli.ts";
import { controlChar, table as tableText, terminalText } from "./report.ts";
import { statsOfRunDir } from "./runs.ts";

const LONG = 180_000;
setDefaultTimeout(LONG);

function run(argv: readonly string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = main(argv, { out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}

let series = "";
let mixed = "";
let agg: ModelStatsFile;

beforeAll(async () => {
  series = await seriesRoot();
  mixed = await mixedRoot();
  const r = run(["aggregate", "--runs", series, "--json", "--replicates", "50"]);
  if (r.code !== 0) throw new Error(r.err);
  agg = ModelStatsFileSchema.parse(JSON.parse(r.out));
}, LONG);

describe("stats match", () => {
  test("a table, and with --json the perfidia-stats/1 document of statsOfRunDir", () => {
    const table = run(["match", join(series, "m01")]);
    expect(table.code).toBe(0);
    expect(table.out).toContain("m01: ended");
    expect(table.out).toContain("series budget-mix, block 1, match 1");
    expect(table.out).toMatch(/\np1 +fake\//);
    const json = run(["match", join(series, "m01"), "--json"]);
    const stats = MatchStatsSchema.parse(JSON.parse(json.out));
    expect(stats.series).toEqual({ lineup: "budget-mix", block: 0, index: 1 });
    expect(stats.lineup).toBe("budget-mix");
    expect(stats).toEqual(
      statsOfRunDir(join(series, "m01"), {
        series: { lineup: "budget-mix", block: 0, index: 1 },
      }).stats,
    );
  });

  test("a capped run: its hand-off and LLM figures equal arena.json's", () => {
    const stats = MatchStatsSchema.parse(
      JSON.parse(run(["match", join(mixed, "capped"), "--json"]).out),
    );
    const arena = ArenaReportAnySchema.parse(
      JSON.parse(readFileSync(join(mixed, "capped", "arena.json"), "utf8")),
    );
    const p2 = stats.seats.find((s) => s.seat === "p2");
    expect(p2?.incidents.handoff?.reason).toBe("cap");
    expect(p2?.incidents.handoff?.label).toBe("bot:conqueror@3");
    for (const r of arena.seats) {
      const s = stats.seats.find((x) => x.seat === r.seat);
      expect([r.seat, s?.operations?.attempts, s?.cost?.nanoUsd, s?.play.wakes]).toEqual([
        r.seat,
        r.attempts,
        r.costNanoUsd,
        r.thoughts.turns,
      ]);
      expect([r.seat, s?.cost?.byKind]).toEqual([r.seat, r.costByKind]);
    }
  });

  test("--no-costs: no cost, tokens or model time", () => {
    const stats = MatchStatsSchema.parse(
      JSON.parse(run(["match", join(series, "m02"), "--json", "--no-costs"]).out),
    );
    expect(stats.published.costs).toBe(false);
    expect(stats.cost).toBeNull();
    expect(
      stats.seats.every((s) => s.cost === null && (s.operations?.latencyMs ?? null) === null),
    ).toBe(true);
  });
});

describe("stats aggregate", () => {
  test("a rotated series: grouped by series.json, one block of four, too few matches", () => {
    expect(agg.series).toEqual([
      {
        lineup: "budget-mix",
        fake: true,
        order: 4,
        blocks: 1,
        orthogonal: true,
        planned: 4,
        found: 4,
      },
    ]);
    expect(agg.matches.map((m) => [m.match, m.block, m.series?.index])).toEqual([
      ["m01", "series:budget-mix#0", 1],
      ["m02", "series:budget-mix#0", 2],
      ["m03", "series:budget-mix#0", 3],
      ["m04", "series:budget-mix#0", 4],
    ]);
    expect(agg.blocks).toBe(1);
    expect(agg.claims).toMatchObject({
      state: "too_few_matches",
      models: 4,
      pairs: 6,
      matches: 4,
      needed: 74,
      more: 70,
    });
    expect(agg.ratings).toBeNull();
    expect(
      agg.models.filter((m) => m.kind === "llm").map((m) => [m.id, m.fake, m.matches]),
    ).toEqual([
      ["fake.claude-haiku-5-5.medium", true, 4],
      ["fake.gemini-3-8-flash.medium", true, 4],
      ["fake.gpt-6-luna.medium", true, 4],
      ["fake.z-ai-glm-5-3-flash.z-ai-fp8.low", true, 4],
    ]);
    expect(agg.models.every((m) => m.outcome === null)).toBe(true);
    // Each model played each profile once (Graeco-Latin).
    for (const m of agg.models.filter((x) => x.kind === "llm")) {
      const profiles = agg.seats.filter((s) => s.id === m.id).map((s) => s.profile);
      expect(new Set(profiles).size).toBe(4);
    }
    const table = run(["aggregate", "--runs", series, "--replicates", "0"]);
    expect(table.code).toBe(0);
    expect(table.out).toContain("claims: too few matches, no ranking shown");
    expect(table.out).toContain(": 70 more");
    expect(table.out).toContain("series budget-mix (fake): 4 of 4 match(es) found");
    expect(table.out).not.toContain("ratings:");
  });

  test("old run directories aggregate without error: bots only, perfidia-arena/1, a hand-off", () => {
    const r = run(["aggregate", "--runs", mixed, "--json", "--replicates", "0"]);
    expect([r.code, r.err]).toEqual([0, ""]);
    const f = ModelStatsFileSchema.parse(JSON.parse(r.out));
    expect(f.matches.map((m) => [m.match, m.status, m.rated])).toEqual([
      ["capped", "ended", true],
      ["phase3", "ended", true],
      ["war", "ended", true],
    ]);
    expect(f.series).toEqual([]);
    const byMatch = (id: string): MatchStats => statsOfRunDir(join(mixed, id)).stats;
    const war = byMatch("war");
    expect(
      war.seats.every((s) => s.kind === "bot" && s.cost === null && s.operations === null),
    ).toBe(true);
    const phase3 = byMatch("phase3");
    const llm = phase3.seats.filter((s) => s.kind === "llm");
    expect(llm.length).toBeGreaterThan(0);
    // Phase-4 fields are absent from such a run: no prompt variant, no price card, no preflight.
    expect(llm.every((s) => s.reminders === null && s.toolsHash === null)).toBe(true);
    expect(llm.every((s) => s.cost !== null && s.cost.priceCards.length === 0)).toBe(true);
    expect(phase3.cost?.preflightNanoUsd).toBe(0);
    expect(f.models.find((m) => m.handoffs["cap"] === 1)).toBeDefined();
  });

  test("--no-costs, --publish, --out and --exploratory", () => {
    const hidden = ModelStatsFileSchema.parse(
      JSON.parse(
        run(["aggregate", "--runs", series, "--json", "--no-costs", "--replicates", "0"]).out,
      ),
    );
    expect(hidden.published.costs).toBe(false);
    expect(hidden.models.every((m) => m.cost === null)).toBe(true);
    const dir = tempDir("stats-cli");
    const publish = join(dir, "publish.json");
    writeFileSync(
      publish,
      JSON.stringify({
        format: "perfidia-publish/1",
        matches: [
          { id: "m01", title: "one" },
          { id: "m03", title: "three", visibility: "after_end" },
        ],
      }),
    );
    const out = join(dir, "stats.json");
    const r = run([
      "aggregate",
      "--runs",
      series,
      "--publish",
      publish,
      "--out",
      out,
      "--replicates",
      "0",
    ]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`wrote ${out} (2 matches)`);
    const written = ModelStatsFileSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(written.matches.map((m) => m.match)).toEqual(["m01", "m03"]);
    expect(written.series[0]?.found).toBe(2);
    const exploratory = ModelStatsFileSchema.parse(
      JSON.parse(
        run(["aggregate", "--runs", series, "--json", "--exploratory", "--replicates", "0"]).out,
      ),
    );
    expect(exploratory.exploratory).toBe(true);
    expect(exploratory.ratings?.intervals.method).toBe("laplace");
    expect(exploratory.models.find((m) => m.kind === "llm")?.outcome).not.toBeNull();
  });

  test("usage errors exit 3; a missing run directory exits 2", () => {
    expect(run([]).code).toBe(3);
    expect(run(["nope"]).code).toBe(3);
    expect(run(["aggregate"]).code).toBe(3);
    expect(run(["aggregate", "--runs", series, "--group", "seat"]).code).toBe(3);
    expect(run(["aggregate", "--runs", series, "--seed", "-1"]).code).toBe(3);
    expect(run(["match"]).code).toBe(3);
    expect(run(["match", join(series, "missing")]).code).toBe(2);
    expect(run(["--help"]).code).toBe(0);
  });
});

/** A copy of series match `from` as `to` in `root`, its `seats.json` passed through `edit`. */
function copy(
  root: string,
  from: string,
  to: string,
  edit?: (seats: Record<string, unknown>) => void,
): void {
  cpSync(join(series, from), join(root, to), { recursive: true });
  if (edit === undefined) return;
  const path = join(root, to, "seats.json");
  const seats: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(seats)) throw new Error(`${path}: not an object`);
  edit(seats);
  writeFileSync(path, JSON.stringify(seats));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

describe("review fixes", () => {
  test("--publish leaves out a listed match whose log does not verify, as the server hides it", () => {
    const root = join(tempDir("stats-publish"), "runs");
    mkdirSync(root, { recursive: true });
    copy(root, "m01", "pub1");
    copy(root, "m02", "tamper1");
    const log = join(root, "tamper1", "match.jsonl");
    const lines = readFileSync(log, "utf8").split("\n");
    const at = lines.findIndex((l) => l.includes('"k":"ckpt"'));
    lines[at] = (lines[at] ?? "").replace(/"h":"[0-9a-f]+"/, '"h":"0000000000000000"');
    writeFileSync(log, lines.join("\n"));
    const publish = join(root, "..", "publish.json");
    writeFileSync(
      publish,
      JSON.stringify({
        format: "perfidia-publish/1",
        matches: [
          { id: "pub1", title: "one" },
          { id: "tamper1", title: "two" },
        ],
      }),
    );
    const r = run([
      "aggregate",
      "--runs",
      root,
      "--publish",
      publish,
      "--json",
      "--replicates",
      "0",
    ]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("tamper1: its log does not verify (level E): the server hides it");
    const f = ModelStatsFileSchema.parse(JSON.parse(r.out));
    expect(f.matches.map((m) => m.match)).toEqual(["pub1"]);
    // Without --publish (a development root), the unverifiable match stays, unrated.
    const all = ModelStatsFileSchema.parse(
      JSON.parse(run(["aggregate", "--runs", root, "--json", "--replicates", "0"]).out),
    );
    expect(all.matches.map((m) => [m.match, m.rated])).toEqual([
      ["pub1", true],
      ["tamper1", false],
    ]);
  });

  test("a 300-character model id: bounded ids, the aggregate and the match still work", () => {
    const root = join(tempDir("stats-long"), "runs");
    mkdirSync(root, { recursive: true });
    copy(root, "m01", "long1", (seats) => {
      const list = seats["seats"];
      if (!Array.isArray(list)) throw new Error("no seats");
      const first: unknown = list.find(
        (x: unknown) => typeof x === "object" && x !== null && "provider" in x,
      );
      if (typeof first !== "object" || first === null) throw new Error("no llm seat");
      Object.assign(first, { provider: "compat", model: `${"very-long-model-".repeat(19)}x` });
    });
    const m = run(["match", join(root, "long1"), "--json"]);
    expect([m.code, m.err]).toEqual([0, ""]);
    const stats = MatchStatsSchema.parse(JSON.parse(m.out));
    const long = stats.seats.find((s) => s.model?.provider === "compat");
    expect(long?.id.length).toBeLessThanOrEqual(150);
    const r = run(["aggregate", "--runs", root, "--json", "--replicates", "0"]);
    expect(r.code).toBe(0);
    const f = ModelStatsFileSchema.parse(JSON.parse(r.out));
    expect(f.models.some((x) => x.id === long?.id)).toBe(true);
  });

  test("terminal text: C0, C1, DEL and bidi controls print as ?", () => {
    expect(terminalText("a\u001b]0;x\u0007b\u009bc\u007fd\u202ee\u2066f")).toBe("a?]0;x?b?c?d?e?f");
    expect(terminalText("plain text, $1.00 ‰")).toBe("plain text, $1.00 ‰");
    expect(tableText(["h"], [["x\u001b[2Jy"]])).toBe("h\nx?[2Jy\n");
  });

  test("control characters of a run's strings never reach the terminal", () => {
    const root = join(tempDir("stats-ctl"), "runs");
    mkdirSync(root, { recursive: true });
    copy(root, "m01", "ctl1", (seats) => {
      seats["lineup"] = "x\u001b]0;pwned\u0007\u001b[2Jy";
    });
    for (const argv of [
      ["match", join(root, "ctl1")],
      ["aggregate", "--runs", root, "--replicates", "0"],
    ]) {
      const r = run(argv);
      expect(r.code).toBe(0);
      const text = r.out + r.err;
      const shown: number[] = [];
      for (let i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (c !== 0x0a && controlChar(c)) shown.push(c);
      }
      expect(shown).toEqual([]);
    }
  });
});

test("stats power: the design's table and a deterministic simulation", () => {
  const r = run(["power", "--matches", "8", "--reps", "4", "--replicates", "0", "--json"]);
  expect(r.code).toBe(0);
  const a: unknown = JSON.parse(r.out);
  expect(
    JSON.parse(run(["power", "--matches", "8", "--reps", "4", "--replicates", "0", "--json"]).out),
  ).toEqual(a);
  const t = run(["power", "--matches", "8", "--reps", "4", "--replicates", "0"]);
  expect(t.out).toMatch(/70\/30 +49 +74/);
  expect(t.out).toMatch(/80\/20 +20 +32/);
  expect(t.out).toMatch(/60\/40 +199 +303/);
  // --p 0.5: two equal models, the rates are false claims (the size).
  const size = run(["power", "--p", "0.5", "--matches", "8", "--reps", "4", "--replicates", "0"]);
  expect(size.code).toBe(0);
  expect(size.out).toContain("size at p = 0.5");
  expect(run(["power", "--p", "0.49"]).code).toBe(3);
});
