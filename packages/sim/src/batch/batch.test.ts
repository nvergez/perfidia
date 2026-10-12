// `sim batch` (docs/architecture.md §12.1, §12.2, §13.9, §15 T15): two variants × two seeds print
// the table and write JSON with provenance whose rows reproduce from their seeds, and `--out` keeps
// a verifiable run directory with its `summary.json` per match; `--pacing` prints the per-day table;
// test rulesets run with a note; results do not depend on the variant order; variants and run
// directories are checked before any match runs, and runs are never overwritten; a match that
// fails before its header is a fatal row and the batch goes on.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_VERSION, getRuleset, resolveConfig, type AnyRuleset } from "@perfidia/engine";
import { EXIT, memoryIo } from "../args.ts";
import { main } from "../cli.ts";
import { runBots } from "../harness/index.ts";
import { readLog } from "../io/index.ts";
import { summarize } from "../summary/index.ts";
import {
  fightTimes,
  pacingOf,
  parseVariant,
  parseVariants,
  runBatch,
  type BatchResult,
} from "./index.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perfidia-sim-batch-"));
}

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo();
  const code = await main(argv, io);
  return { code, out: io.stdout(), err: io.stderr() };
}

function isBatch(v: unknown): v is BatchResult {
  return typeof v === "object" && v !== null && "format" in v && v.format === "perfidia-batch/4";
}

/** Every file under `dir` with its bytes, for before/after comparisons. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path] = readFileSync(path, "latin1");
  }
  return out;
}

describe("sim batch", () => {
  test("two variants × two seeds print the table and write JSON with provenance; --out keeps verifiable runs", async () => {
    const dir = tempDir();
    try {
      const json = join(dir, "out.json");
      const runs = join(dir, "runs");
      const r = await cli(
        "batch",
        "--variant",
        "perfidia-1@1.0.0",
        "--variant",
        "fast: perfidia-1@1.0.0 time.protectionEnd=21600",
        "--seeds",
        "1-2",
        "--players",
        "6",
        "--days",
        "1",
        "--json",
        json,
        "--out",
        runs,
      );
      expect(r.code).toBe(EXIT.ok);
      expect(r.err.trim().split("\n")).toHaveLength(4);
      const rows = r.out.split("\n");
      expect(rows[0]).toMatch(
        /^variant +runs +winners \(by strategy\) +end day +battles +conquests +elims +wakes\/seat\/day \(mean \/ max\)$/,
      );
      expect(rows[1]).toMatch(/^perfidia-1@1\.0\.0 +2 +\S/);
      expect(rows[2]).toBe("fast: perfidia-1@1.0.0 time.protectionEnd=21600");
      expect(rows[3]).toMatch(/^ +2 +\S.* 1\.0 +\d+\.\d +\d+\.\d +\d+\.\d +\d+\.\d \/ \d+$/);
      // The fights table follows, one row per variant.
      expect(rows[4]).toBe("");
      expect(rows[5]).toStartWith("fights · ");
      expect(rows[6]).toMatch(/^variant +runs +ends +1st battle \(mean \/ min\) /);
      expect(rows[7]).toMatch(/^perfidia-1@1\.0\.0 +2 +time 2 /);
      // Then the ends and land, battles and bots tables; no countdown, no list of them.
      const ends = rows.findIndex((l) => l.startsWith("ends and land · "));
      expect(ends).toBe(11);
      expect(rows[ends + 2]).toMatch(/^perfidia-1@1\.0\.0 +2 +2 +0 +0 +0 +0 +0 +0 +0 +- +- \/ /);
      expect(rows.find((l) => l.startsWith("battles · "))).toBeDefined();
      expect(rows.find((l) => l.startsWith("bots · "))).toBeDefined();
      expect(r.out).not.toContain("domination countdowns · ");
      expect(r.out).not.toContain("seats · ");
      expect(r.out).toContain(`results with provenance: ${json}`);

      const parsed: unknown = JSON.parse(readFileSync(json, "utf8"));
      if (!isBatch(parsed)) throw new Error("not a batch result");
      expect([parsed.engine, parsed.players, parsed.seeds, parsed.days]).toEqual([
        ENGINE_VERSION,
        6,
        [1, 2],
        1,
      ]);
      expect(parsed.bots).toEqual([
        "bot:expander@1",
        "bot:rusher@2",
        "bot:turtle@1",
        "bot:opportunist@1",
        "bot:conqueror@1",
      ]);
      expect(parsed.clock).toEqual({ kind: "lockstep", maxTurnsPerSecond: 3 });
      const rs = getRuleset("perfidia-1@1.0.0");
      for (const [i, v] of parsed.variants.entries()) {
        const overrides: Record<string, number> =
          i === 0
            ? { "time.matchEnd": 86400 }
            : { "time.matchEnd": 86400, "time.protectionEnd": 21600 };
        const resolved = resolveConfig(rs, overrides);
        expect(resolved.ok).toBe(true);
        expect(v).toMatchObject({
          label: i === 0 ? null : "fast",
          ref: "perfidia-1@1.0.0",
          overrides,
          configHash: resolved.ok ? resolved.hash : "",
          engine: ENGINE_VERSION,
          seeds: [1, 2],
          controllers: {
            p1: "bot:expander@1",
            p2: "bot:rusher@2",
            p5: "bot:conqueror@1",
            p6: "bot:expander@1",
          },
        });
        expect(v.rulesHash).toMatch(/^[0-9a-f]{64}$/);
        expect(v.matches.map((m) => [m.seed, m.status, m.reason])).toEqual([
          [1, "ended", "time"],
          [2, "ended", "time"],
        ]);
        expect(v.aggregate.reasons).toEqual({ time: 2 });
        for (const m of v.matches) {
          // Each row reproduces from its seed: the same match run alone has the same final hash.
          // oxlint-disable-next-line no-await-in-loop -- one match at a time
          const again = await runBots({
            ruleset: rs,
            seed: m.seed,
            players: 6,
            overrides,
            clock: { kind: "lockstep" },
          });
          expect(again.run.finalHash).toBe(m.finalHash ?? "");
          const s = summarize(again.lines);
          expect([m.battles, m.conquests, m.eliminations, m.winners]).toEqual([
            s.events.battles,
            s.events.conquests,
            s.events.eliminations,
            s.winners,
          ]);
          expect(m).toMatchObject(fightTimes(again.lines));
          // --out kept the match's run directory: it passes verify, and its summary.json is the
          // summary of its log.
          const runDir = join(runs, `v${i + 1}-s${m.seed}`);
          // oxlint-disable-next-line no-await-in-loop -- sequential
          expect((await cli("verify", runDir)).code).toBe(EXIT.ok);
          const recorded: unknown = JSON.parse(readFileSync(join(runDir, "summary.json"), "utf8"));
          const wallMs =
            typeof recorded === "object" && recorded !== null && "wallMs" in recorded
              ? recorded.wallMs
              : null;
          if (typeof wallMs !== "number") throw new Error("summary.json has no wallMs");
          expect(recorded).toEqual(
            JSON.parse(JSON.stringify(summarize(readLog(join(runDir, "match.jsonl")), { wallMs }))),
          );
          expect(existsSync(join(runDir, "snapshots", "final.json"))).toBe(true);
        }
      }
      expect(parsed.variants[0]?.configHash).not.toBe(parsed.variants[1]?.configHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("--pacing prints the per-day table and its measures are exact; a test ruleset runs with a note", async () => {
    // Two measured days need a checkpoint at hour 24 and a later end: 25 game hours with 3 seats,
    // cheaper than one 6-seat day (the one match-length exception of this file, §13).
    const dir = tempDir();
    try {
      const r = await cli(
        "batch",
        "--variant",
        "sandbox-1 time.matchEnd=90000",
        "--seeds",
        "4",
        "--players",
        "3",
        "--pacing",
        "--per-match",
        "--out",
        dir,
        "--json",
        join(dir, "batch.json"),
      );
      expect(r.code).toBe(EXIT.ok);
      expect(r.err).toStartWith(
        'note: variant "sandbox-1 time.matchEnd=90000" plays sandbox-1@1.0.0, a test ruleset (status "test"), not a game\n',
      );
      const rows = r.out.split("\n");
      expect(rows[0]).toMatch(
        /^variant +seed +end +winners +end day +battles +conquests +elims +1st battle +1st conquest +1st elim +countdowns +wakes\/seat\/day +final hash$/,
      );
      expect(rows[1]).toMatch(/^sandbox-1 time\.matchEnd=90000 +4 +time /);
      const at = rows.findIndex((l) => l.startsWith("pacing · N = 3 · 1 seed(s) per variant"));
      expect(at).toBeGreaterThan(0);
      expect(rows[at + 1]).toMatch(
        /^variant +day +runs +cities\/player mean +min +max +free slots +army pop +score +battles +conquests +elims +sieges started +held +broken$/,
      );
      expect(rows[at + 2]).toMatch(/^sandbox-1 time\.matchEnd=90000 +D1 +1 +/);
      expect(rows[at + 3]).toMatch(/^ +D2 +1 +/);

      // sandbox-1 has 4 slots per sector and no neutral city: free slots = 4N − N − foundings.
      const lines = readLog(join(dir, "v1-s4", "match.jsonl"));
      const p = pacingOf(lines);
      expect(p.report.ok).toBe(true);
      expect(p.days.map((d) => d.day)).toEqual([1, 2]);
      const s = summarize(lines);
      const last = p.days[1];
      expect(last?.freeSlots).toBe(3 * 3 - s.events.foundings);
      expect(last?.citiesMean).toBe(Math.round(((3 + s.events.foundings) / 3) * 100) / 100);
      expect((p.days[0]?.battles ?? 0) + (last?.battles ?? 0)).toBe(s.events.battles);
      expect(last?.scoreMean).toBe(
        Math.round((s.seats.reduce((a, x) => a + (x.score ?? 0), 0) / 3) * 100) / 100,
      );
      // The batch row agrees: free slots without a replay, and sandbox-1's own score parts.
      const parsed: unknown = JSON.parse(readFileSync(join(dir, "batch.json"), "utf8"));
      if (!isBatch(parsed)) throw new Error("not a batch result");
      const m = parsed.variants[0]?.matches[0];
      expect(m?.freeSlots).toEqual({
        initial: 9,
        d5: null,
        d7: last?.freeSlots ?? -1,
        end: last?.freeSlots ?? -1,
      });
      for (const x of m?.seats ?? []) {
        expect(x.levelPoints).toBe(x.parts["levelPoints"] ?? -1);
        expect([x.crownPoints, x.battleScore]).toEqual([null, null]);
      }
      expect(rows.find((l) => l.startsWith("seats · "))).toBeDefined();
      expect(rows.find((l) => l.startsWith("battles and land per match"))).toBeDefined();
      // --allow-test silences the note (--pacing replays the match: exit 0 means it matched).
      const quiet = await cli(
        "batch",
        "--variant",
        "sandbox-1 time.matchEnd=3600",
        "--allow-test",
        "--seeds",
        "1",
        "--players",
        "2",
        "--pacing",
      );
      expect(quiet.code).toBe(EXIT.ok);
      expect(quiet.err).not.toContain("note:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("results do not depend on the variant order", async () => {
    const a = parseVariant("perfidia-1@1.0.0", { days: 1 });
    const b = parseVariant("other: perfidia-1 time.protectionEnd=21600", { days: 1 });
    const plan = {
      seeds: [3],
      players: 6,
      bots: ["rusher", "turtle", "rusher@1"] as const,
      days: 1,
      // The pacing pass replays every match at Level E.
      pacing: true,
    };
    const ab = await runBatch({ ...plan, variants: [a, b] });
    const ba = await runBatch({ ...plan, variants: [b, a] });
    expect(ab.variants[0]).toEqual(ba.variants[1]);
    expect(ab.variants[1]).toEqual(ba.variants[0]);
    expect(ab.bots).toEqual(["bot:rusher@2", "bot:turtle@1", "bot:rusher@1"]);
    expect(ab.variants[0]?.controllers["p3"]).toBe("bot:rusher@1");
    expect(ab.variants.flatMap((v) => v.matches.map((m) => m.replayOk))).toEqual([true, true]);
  }, 30000);

  test("variants are checked before any match runs", async () => {
    const cases: [string[], string][] = [
      [["--variant", "perfidia-1@1.0.0"], "--seeds is required"],
      [["--seeds", "1"], "at least one --variant"],
      [
        ["--variant", "sandbox-1", "--variant", "perfidia-1", "--seeds", "1", "--players", "3"],
        "outside the player range of:\n  perfidia-1: 6..12",
      ],
      [
        ["--variant", "x: perfidia-1@1.0.0 time.nope=1", "--seeds", "1"],
        'variant "x: perfidia-1@1.0.0 time.nope=1"',
      ],
      [["--variant", "perfidia-1", "--variant", "perfidia-1", "--seeds", "1"], "given twice"],
      [["--variant", "nope-2", "--seeds", "1"], 'unknown ruleset "nope-2"'],
      [["--variant", "a=b", "--seeds", "1"], "the ref first"],
      [["--variant", "perfidia-1", "--seeds", "2-1"], "empty"],
    ];
    for (const [args, message] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- sequential, each is fast
      const r = await cli("batch", ...args);
      expect({ args, code: r.code }).toEqual({ args, code: EXIT.usage });
      expect(r.err).toContain(message);
    }
    const v = parseVariants(["lbl: perfidia-1  time.protectionEnd=21600 "]);
    expect([
      v.players,
      v.variants[0]?.text,
      v.variants[0]?.label,
      v.variants[0]?.overrides,
    ]).toEqual([
      6,
      "lbl: perfidia-1 time.protectionEnd=21600",
      "lbl",
      { "time.protectionEnd": 21600 },
    ]);
    expect(parseVariant("sandbox-1").ruleset.status).toBe("test");
  });

  test("--out never overwrites a run: a taken directory exits 3 before any match, the first logs untouched", async () => {
    const dir = tempDir();
    try {
      const out = join(dir, "b");
      const args = [
        "batch",
        "--variant",
        "sandbox-1 time.matchEnd=21600",
        "--allow-test",
        "--seeds",
        "1",
        "--players",
        "2",
        "--out",
        out,
      ];
      expect((await cli(...args)).code).toBe(EXIT.ok);
      expect((await cli("verify", join(out, "v1-s1"))).code).toBe(EXIT.ok);
      const before = filesOf(out);
      expect(Object.keys(before).length).toBeGreaterThan(2);
      const again = await cli(...args);
      expect(again.code).toBe(EXIT.usage);
      expect(again.err).toContain(`${join(out, "v1-s1")} already holds a run (match.jsonl)`);
      expect(filesOf(out)).toEqual(before);

      // The second variant's directory holds a stray snapshot: nothing runs, not even variant 1.
      const other = join(dir, "c");
      mkdirSync(join(other, "v2-s1", "snapshots"), { recursive: true });
      writeFileSync(join(other, "v2-s1", "snapshots", "h0024.json"), "{}");
      const taken = await cli(
        "batch",
        "--variant",
        "sandbox-1 time.matchEnd=21600",
        "--variant",
        "sandbox-1 time.matchEnd=43200",
        "--seeds",
        "1",
        "--players",
        "2",
        "--out",
        other,
      );
      expect(taken.code).toBe(EXIT.usage);
      expect(taken.err).toContain(`${join(other, "v2-s1")} already holds a run (snapshots/)`);
      expect(existsSync(join(other, "v1-s1"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("a match that fails before its header is a fatal row, and the batch goes on", async () => {
    const sandbox = getRuleset("sandbox-1@1.0.0");
    // The preflight creates each match once (calls 1 and 2); the first real match is call 3.
    let calls = 0;
    const flaky: AnyRuleset = {
      ...sandbox,
      hooks: {
        ...sandbox.hooks,
        createWorld(w) {
          calls += 1;
          if (calls === 3) throw new Error("the world generator failed");
          return sandbox.hooks.createWorld(w);
        },
      },
    };
    const v = { ...parseVariant("sandbox-1 time.matchEnd=7200"), ruleset: flaky };
    const result = await runBatch({
      variants: [v],
      seeds: [1, 2],
      players: 2,
      bots: ["turtle"],
      days: null,
      pacing: true,
    });
    const [failed, ok] = result.variants[0]?.matches ?? [];
    expect(failed).toMatchObject({ seed: 1, status: "fatal", finalHash: null, reason: null });
    expect(failed?.error).toContain("the world generator failed");
    expect(failed?.replayOk).toBeUndefined();
    expect(ok).toMatchObject({ seed: 2, status: "ended", reason: "time", replayOk: true });
    expect(result.variants[0]?.aggregate).toMatchObject({ runs: 2, fatal: 1 });
  });
});
