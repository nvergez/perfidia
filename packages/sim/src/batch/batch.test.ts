// `sim batch` (docs/architecture.md §12.1, §12.2, §13.9, §15 T15): two variants × two seeds print
// the table and write JSON with provenance whose rows reproduce from their seeds; `--pacing` prints
// the per-day table; results do not depend on the variant order; variants are checked before any
// match runs.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_VERSION, getRuleset, resolveConfig } from "@perfidia/engine";
import { EXIT, memoryIo } from "../args.ts";
import { main } from "../cli.ts";
import { runBots } from "../harness/index.ts";
import { summarize } from "../summary/index.ts";
import { pacingOf, parseVariant, parseVariants, runBatch, type BatchResult } from "./index.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "perfidia-sim-batch-"));
}

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo();
  const code = await main(argv, io);
  return { code, out: io.stdout(), err: io.stderr() };
}

function isBatch(v: unknown): v is BatchResult {
  return typeof v === "object" && v !== null && "format" in v && v.format === "perfidia-batch/1";
}

describe("sim batch", () => {
  test("two variants × two seeds print the table and write JSON with provenance", async () => {
    const dir = tempDir();
    try {
      const json = join(dir, "out.json");
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
        join(dir, "runs"),
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
        "bot:rusher@1",
        "bot:turtle@1",
        "bot:opportunist@1",
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
          controllers: { p1: "bot:expander@1", p2: "bot:rusher@1", p6: "bot:rusher@1" },
        });
        expect(v.rulesHash).toMatch(/^[0-9a-f]{64}$/);
        expect(v.matches.map((m) => [m.seed, m.status, m.reason])).toEqual([
          [1, "ended", "time"],
          [2, "ended", "time"],
        ]);
        // Each row reproduces from its seed: the same match run alone has the same final hash.
        for (const m of v.matches) {
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
        }
      }
      expect(parsed.variants[0]?.configHash).not.toBe(parsed.variants[1]?.configHash);
      // --out kept every match's run directory, and each passes verify.
      const v = await cli("verify", join(dir, "runs", "v2-s1"));
      expect(v.code).toBe(EXIT.ok);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test("--pacing prints the per-day table; the measures are exact on sandbox-1", async () => {
    const r = await cli(
      "batch",
      "--variant",
      "sandbox-1",
      "--allow-test",
      "--seeds",
      "4",
      "--players",
      "6",
      "--days",
      "2",
      "--pacing",
      "--per-match",
    );
    expect(r.code).toBe(EXIT.ok);
    const rows = r.out.split("\n");
    expect(rows[0]).toMatch(
      /^variant +seed +end +winners +end day +battles +conquests +elims +wakes\/seat\/day +final hash$/,
    );
    expect(rows[1]).toMatch(/^sandbox-1 +4 +time /);
    const at = rows.findIndex((l) => l.startsWith("pacing · N = 6 · 1 seed(s) per variant"));
    expect(at).toBeGreaterThan(0);
    expect(rows[at + 1]).toMatch(
      /^variant +day +runs +cities\/player mean +min +max +free slots +army pop +score +battles +sieges started +held +broken$/,
    );
    expect(rows[at + 2]).toMatch(/^sandbox-1 +D1 +1 +/);
    expect(rows[at + 3]).toMatch(/^ +D2 +1 +/);

    // sandbox-1 has 4 slots per sector and no neutral city: free slots = 4N − N − foundings.
    const out = await runBots({
      ruleset: "sandbox-1",
      seed: 4,
      players: 6,
      days: 2,
      clock: { kind: "lockstep" },
    });
    const p = pacingOf(out.lines);
    expect(p.report.ok).toBe(true);
    expect(p.days.map((d) => d.day)).toEqual([1, 2]);
    const s = summarize(out.lines);
    const last = p.days[1];
    expect(last?.freeSlots).toBe(3 * 6 - s.events.foundings);
    expect(last?.citiesMean).toBe(Math.round(((6 + s.events.foundings) / 6) * 100) / 100);
    expect((p.days[0]?.battles ?? 0) + (last?.battles ?? 0)).toBe(s.events.battles);
    expect(last?.scoreMean).toBe(
      Math.round((s.seats.reduce((a, x) => a + (x.score ?? 0), 0) / 6) * 100) / 100,
    );
  }, 30000);

  test("results do not depend on the variant order", async () => {
    const a = parseVariant("perfidia-1@1.0.0", { days: 1, allowTest: false });
    const b = parseVariant("other: perfidia-1 time.protectionEnd=21600", {
      days: 1,
      allowTest: false,
    });
    const plan = {
      seeds: [3],
      players: 6,
      bots: ["rusher", "turtle"] as const,
      days: 1,
      pacing: false,
    };
    const ab = await runBatch({ ...plan, variants: [a, b] });
    const ba = await runBatch({ ...plan, variants: [b, a] });
    expect(ab.variants[0]).toEqual(ba.variants[1]);
    expect(ab.variants[1]).toEqual(ba.variants[0]);
    expect(ab.bots).toEqual(["bot:rusher@1", "bot:turtle@1"]);
  }, 30000);

  test("variants are checked before any match runs", async () => {
    const cases: [string[], string][] = [
      [["--variant", "perfidia-1@1.0.0"], "--seeds is required"],
      [["--seeds", "1"], "at least one --variant"],
      [["--variant", "sandbox-1", "--seeds", "1"], "--allow-test"],
      [
        [
          "--variant",
          "sandbox-1",
          "--variant",
          "perfidia-1",
          "--allow-test",
          "--seeds",
          "1",
          "--players",
          "3",
        ],
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
    const v = parseVariants(["lbl: perfidia-1  time.protectionEnd=21600 "], { allowTest: false });
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
  });
});
