// The M1 rehearsal's findings (an owner-style rehearsal of docs/phase4.md §10 against a loopback
// Anthropic stub), each pinned on a 1-day `--fake` run doctored where the finding needs a real one:
// - a run against a non-default base URL records its origin in arena.json, and a loopback origin
//   (a stub or a local proxy) never meets `exit4`, even reconciled with `--force`;
// - a crashed run (arena.json still `running`) is reconciled over its logged wall window and is
//   not called a `--fake` run;
// - the report of an aborted run says Level E holds up to the abort and prints no projection from
//   minutes of spend; the start banner of a `--budget-carry` run shows the carry.
// The operator-signal finding is pinned in phase4.test.ts and review.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryIo } from "@perfidia/sim";
import {
  ArenaReportSchema,
  LlmCallLineSchema,
  ReconcileFileSchema,
  type ArenaReport,
} from "../log/schema.ts";
import { main as arenaMain } from "./cli.ts";
import { arenaEnv, planArena } from "./plan.ts";
import { lastLoggedWall, reconcileDir } from "./reconcile.ts";
import { baseUrlsOf, formatReport, onLoopback } from "./report.ts";
import { readCalls, runDir } from "./rig.test.ts";

const LONG = 60_000;
const FAKE = ["--fake", "--lineup", "claude-duo", "--seed", "1", "--id-key", "seed"];
const STUB = "http://127.0.0.1:18080";
const KEY = "sk-ant-rehearsal-0001";

async function cli(argv: readonly string[]) {
  const io = memoryIo();
  const code = await arenaMain(argv, io, {}, { profilesDir: "off" });
  return { code, out: io.stdout(), err: io.stderr() };
}

const readArena = (dir: string): ArenaReport =>
  ArenaReportSchema.parse(JSON.parse(readFileSync(join(dir, "arena.json"), "utf8")));
const writeArena = (dir: string, a: ArenaReport): void =>
  writeFileSync(join(dir, "arena.json"), `${JSON.stringify(a, null, 2)}\n`);

/** The logged spend of a run, as `arena reconcile` sums it (attempts and preflights). */
function ledger(dir: string): string {
  const nano = readCalls(dir).reduce(
    (n, l) => n + (l.k === "llm_call" || l.k === "preflight" ? l.costNanoUsd : 0),
    0,
  );
  return `${Math.floor(nano / 1e9)}.${String(nano % 1e9).padStart(9, "0")}`;
}

/** One finished 1-day `--fake` claude-duo run, shared by the tests. */
let shared: string | null = null;
async function fakeRun(): Promise<string> {
  if (shared !== null) return shared;
  const dir = runDir("fake");
  const r = await cli([
    "run",
    ...FAKE,
    "--days",
    "1",
    "--budget-usd",
    "10",
    "--quiet",
    "--out",
    dir,
  ]);
  expect(r.code).toBe(0);
  shared = dir;
  return dir;
}

/** The run as a real, ended, unreconciled one would report every part of exit4 but the check. */
function asReal(a: ArenaReport, wall: { start: string; end: string | null }): ArenaReport {
  return {
    ...a,
    fake: false,
    budget: { ...a.budget, wall },
    exit4: {
      models: 2,
      ended: true,
      estimateStored: true,
      noHandoff: true,
      withinPrediction: true,
      under: true,
      levelE: true,
      reconciled: null,
      met: false,
    },
  };
}

const WALL = { start: "2026-10-01T00:00:00.000Z", end: "2026-10-01T12:00:00.000Z" };
const LATER = Date.parse("2026-10-05T00:00:00.000Z");

/** A claude-duo plan with the key set and `env` on top. */
const plan = (env: Record<string, string>, fake = false) =>
  planArena(
    { fake, seed: 1, idKey: "seed", lineup: "claude-duo", days: 2, stopAfterDays: 1 },
    arenaEnv({ PERFIDIA_ANTHROPIC_API_KEY: KEY, ...env }),
  );

describe("a non-default base URL (M1 rehearsal: a stub run reached exit4.met)", () => {
  test("the plan's non-default origins, by provider; none by default or on --fake", () => {
    expect(baseUrlsOf(plan({ PERFIDIA_ANTHROPIC_BASE_URL: `${STUB}/v1` }))).toEqual({
      anthropic: STUB,
    });
    expect(baseUrlsOf(plan({}))).toBeNull();
    expect(
      baseUrlsOf(plan({ PERFIDIA_ANTHROPIC_BASE_URL: "https://api.anthropic.com" })),
    ).toBeNull();
    expect(baseUrlsOf(plan({ PERFIDIA_ANTHROPIC_BASE_URL: STUB }, true))).toBeNull();
    const proxy = baseUrlsOf(plan({ PERFIDIA_ANTHROPIC_BASE_URL: "https://gw.example.com/a" }));
    expect(proxy).toEqual({ anthropic: "https://gw.example.com" });
    expect([onLoopback(proxy), onLoopback({ anthropic: STUB }), onLoopback(undefined)]).toEqual([
      false,
      true,
      false,
    ]);
  });

  test(
    "reconciled within tolerance with --force, a loopback run stays unmet; the same run on the provider's host meets it",
    async () => {
      const dir = await fakeRun();
      const input = {
        format: "perfidia-reconcile-input/1" as const,
        providers: [{ provider: "fake", usd: ledger(dir) }],
      };
      const base = readArena(dir);
      try {
        writeArena(dir, { ...asReal(base, WALL), baseUrls: { anthropic: STUB } });
        expect(reconcileDir(dir, input, LATER, { force: true }).ok).toBe(true);
        expect([readArena(dir).exit4.reconciled, readArena(dir).exit4.met]).toEqual([true, false]);
        const text = formatReport(readArena(dir));
        expect(text).toContain(
          `base URLs: anthropic ${STUB} (not the providers' defaults; on loopback, a stub or a local proxy: the exit criterion of step 4 is never met)`,
        );
        // Without the origin (the provider's own host), every part holds: met.
        writeArena(dir, asReal(base, WALL));
        reconcileDir(dir, input, LATER, { force: true });
        expect(readArena(dir).exit4.met).toBe(true);
        expect(formatReport(readArena(dir))).not.toContain("base URLs:");
      } finally {
        writeArena(dir, base);
      }
    },
    LONG,
  );
});

describe("a crashed run (M1 rehearsal: reconcile called it a --fake run)", () => {
  test(
    "its window ends at its last logged wall time; the warning says it crashed",
    async () => {
      const dir = await fakeRun();
      const base = readArena(dir);
      const callsPath = join(dir, "llm_calls.jsonl");
      const calls = readFileSync(callsPath, "utf8");
      try {
        // A fake run logs virtual time only: give its last attempt the wall time a real one has.
        const lines = calls.trimEnd().split("\n");
        const last = lines.findLastIndex((l) => l.includes('"k":"llm_call"'));
        const call = LlmCallLineSchema.parse(JSON.parse(lines[last] ?? "{}"));
        lines[last] = JSON.stringify({ ...call, wallStart: "2026-10-01T09:00:00.000Z" });
        writeFileSync(callsPath, `${lines.join("\n")}\n`);
        const end = new Date(Date.parse("2026-10-01T09:00:00.000Z") + call.latencyMs).toISOString();
        expect(lastLoggedWall(readCalls(dir))).toBe(end);
        // As a crash leaves it: the report written at the start, `running`, never ended.
        const crashed = asReal(base, { start: WALL.start, end: null });
        writeArena(dir, {
          ...crashed,
          status: "running",
          exit4: { ...crashed.exit4, ended: false },
        });
        const r = await cli(["reconcile", dir, "--usd", `fake=${ledger(dir)}`]);
        expect(r.code).toBe(0);
        expect(r.err).toContain(
          `warning: the run never ended (arena.json still says running: it crashed, or it still runs); its window ends at its last logged wall-clock time, ${end}`,
        );
        expect(r.err).not.toContain("a --fake run");
        const file = ReconcileFileSchema.parse(
          JSON.parse(readFileSync(join(dir, "reconcile.json"), "utf8")),
        );
        expect(file.wall).toEqual({ start: WALL.start, end });
        expect(file.hoursAfterEnd).toBeGreaterThan(48);
        // A crashed run never ended: never met.
        expect(readArena(dir).exit4.met).toBe(false);
      } finally {
        writeFileSync(callsPath, calls);
        writeArena(dir, base);
      }
    },
    LONG,
  );
});

describe("the printed report and banner (M1 rehearsal)", () => {
  test(
    "an aborted run: Level E ok up to the abort, no projection from under one measured day",
    async () => {
      const a = readArena(await fakeRun());
      const text = formatReport({
        ...a,
        status: "aborted",
        reason: "the operator sent a second signal",
        levelE: {
          ok: false,
          actions: 12,
          checkpoints: 2,
          divergence: "end at t = 600: expected an end line; got the log stops at t = 600",
        },
        projection: { ...a.projection, fromDays: 0.007, costNanoUsd: 1_077_919_698_000 },
      });
      expect(text).toContain(
        "Level E: ok up to the abort (12 actions, 2 checkpoints; no end line: the run was aborted)",
      );
      expect(text).toContain("no projection (0.007 measured day(s), under one)");
      expect(text).not.toContain("1077.92");
      // Any other divergence of an aborted run still fails.
      const bad = formatReport({
        ...a,
        status: "aborted",
        levelE: { ok: false, actions: 1, checkpoints: 1, divergence: "result at t = 5: x" },
      });
      expect(bad).toContain("Level E: FAILED (1 actions, 1 checkpoints): result at t = 5: x");
    },
    LONG,
  );

  test(
    "a --budget-carry run shows the carry and the room left before K in its start banner",
    async () => {
      const from = await fakeRun();
      const dir = runDir("carried");
      const r = await cli([
        "run",
        ...FAKE,
        "--days",
        "1",
        "--budget-usd",
        "10",
        "--budget-carry",
        from,
        "--out",
        dir,
      ]);
      expect(r.code).toBe(0);
      const carry = readCalls(dir).find((l) => l.k === "carry");
      expect(carry?.k).toBe("carry");
      const banner = r.out.split("\n").find((l) => l.startsWith("prediction for 1 game day(s)"));
      expect(banner).toMatch(
        /; budget \$10\.00, kill threshold K = \$\d+\.\d\d; carry \$\d+\.\d\d from fake \(its logged spend\), so \$\d+\.\d\d until K$/,
      );
    },
    LONG,
  );
});
