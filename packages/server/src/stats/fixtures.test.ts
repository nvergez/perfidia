// Run directories for the statistics tests (no tests here), generated once per test process
// through the orchestrator (a dev dependency): a rotated `budget-mix` series of four 1-day fake
// matches (`arena series --fake`, its `series.json` at the root), and a mixed root holding the war
// golden (bots only, no side file), a fake run rewritten as phase 3 wrote it (`perfidia-arena/1`, no
// phase-4 field or line) and a 2-day fake run whose p2 goes over its cap (a hand-off).

import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arenaEnv, arenaMain, planArena, runArena } from "@perfidia/orchestrator";
import { WAR_GOLDEN, fakeRun, rows, tempDir } from "../testkit.test.ts";

const quiet = { out: (): void => undefined, err: (): void => undefined };

let series: Promise<string> | null = null;

/** A runs root that is a rotated series: `series.json`, `lineups/`, `m01`…`m04`. */
export function seriesRoot(): Promise<string> {
  series ??= (async () => {
    const out = join(tempDir("stats-series"), "series");
    const code = await arenaMain(
      [
        "series",
        "--fake",
        "--lineup",
        "budget-mix",
        "--days",
        "1",
        "--seed",
        "5",
        "--id-key",
        "seed",
        "--price-date",
        "2026-10-20",
        "--profiles",
        "off",
        "--quiet",
        "--out",
        out,
      ],
      quiet,
      {},
      { profilesDir: "off" },
    );
    if (code !== 0) throw new Error(`arena series exited ${code}`);
    return out;
  })();
  return series;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function without(r: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));
}

function readObject(path: string): {
  file: Record<string, unknown>;
  seats: Record<string, unknown>[];
} {
  const file: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(file) || !Array.isArray(file["seats"])) throw new Error(`${path}: no seats`);
  const list: unknown[] = file["seats"];
  return { file, seats: list.filter(isRecord) };
}

/** `dir` rewritten as phase 3 wrote it (as `compat.test.ts` does). */
export function downgrade(dir: string): void {
  const arena = readObject(join(dir, "arena.json"));
  writeFileSync(
    join(dir, "arena.json"),
    JSON.stringify({
      ...without(arena.file, ["budget", "exit4"]),
      format: "perfidia-arena/1",
      seats: arena.seats.map((s) => without(s, ["promptCaps"])),
    }),
  );
  const seats = readObject(join(dir, "seats.json"));
  const pass1b = ["intended", "endpoint", "quantization", "promptVariant", "reminders"];
  writeFileSync(
    join(dir, "seats.json"),
    JSON.stringify({
      ...without(seats.file, [
        "lineup",
        "estimateSha256",
        "promptCapTokens",
        "budgetNanoUsd",
        "priceDate",
      ]),
      seats: seats.seats.map((s) =>
        without(s, [
          "fallbacks",
          ...pass1b,
          "sharedHash",
          "toolsHash",
          "operatorHash",
          "reasoningContext",
        ]),
      ),
    }),
  );
  const phase4 = new Set(["preflight", "prompt_cap", "kill_switch", "operator", "carry"]);
  const calls = rows(readFileSync(join(dir, "llm_calls.jsonl"), "utf8")).flatMap((r) => {
    const line: unknown = JSON.parse(r);
    if (!isRecord(line) || typeof line["k"] !== "string" || phase4.has(line["k"])) return [];
    return [
      JSON.stringify(
        without(line, [
          "endpoint",
          "priceCard",
          "feeNanoUsd",
          "reportedCostNanoUsd",
          "reasoningKind",
        ]),
      ),
    ];
  });
  writeFileSync(join(dir, "llm_calls.jsonl"), `${calls.join("\n")}\n`);
  rmSync(join(dir, "estimate.json"));
}

let mixed: Promise<string> | null = null;

/** A runs root with `war` (bots only), `phase3` (perfidia-arena/1) and `capped` (a hand-off). */
export function mixedRoot(): Promise<string> {
  mixed ??= (async () => {
    const root = tempDir("stats-mixed");
    mkdirSync(join(root, "war"));
    copyFileSync(WAR_GOLDEN, join(root, "war", "match.jsonl.gz"));
    const run = await fakeRun({ days: 1, seed: 3 });
    cpSync(run.dir, join(root, "phase3"), { recursive: true });
    downgrade(join(root, "phase3"));
    const plan = planArena(
      {
        ruleset: "perfidia-1@1.1.0",
        fake: true,
        seed: 5,
        idKey: "seed",
        days: 2,
        seatCaps: ["p2=0.5"],
      },
      arenaEnv({}),
    );
    await runArena(plan, { dir: join(root, "capped"), io: quiet, quiet: true });
    return root;
  })();
  return mixed;
}
