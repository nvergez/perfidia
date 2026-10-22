// The `arena` command line in-process (phase-2 design §8): a 1-day `--fake` run, usage errors (exit
// 3, nothing written), `cost`, `personalities`, and `smoke` refusing to run without the key.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { memoryIo } from "@perfidia/sim";
import { main as arenaMain } from "./cli.ts";
import { runDir } from "./rig.test.ts";

/** `arena` as the CLI runs it, with no calibration profile unless a test passes `--profiles`. */
const main = (...[argv, io, env, o]: Parameters<typeof arenaMain>) =>
  arenaMain(argv, io, env, { profilesDir: "off", ...o });

const LONG = 60_000;
const JUNK = {
  ANTHROPIC_API_KEY: "sk-junk-never-read",
  ANTHROPIC_BASE_URL: "https://junk.invalid",
};

describe("arena CLI", () => {
  test(
    "run --fake writes a run directory and exits 0; cost reads it back; a second run there is refused",
    async () => {
      const dir = runDir();
      const io = memoryIo();
      const argv = [
        "--",
        "run",
        "--fake",
        "--days",
        "1",
        "--seed",
        "5",
        "--id-key",
        "seed",
        "--out",
        dir,
        "--quiet",
      ];
      expect(await main(argv, io, JUNK)).toBe(0);
      expect(io.stdout()).toBe("");
      for (const f of [
        "match.jsonl",
        "llm_calls.jsonl",
        "arena.json",
        "seats.json",
        "feed.txt",
        "summary.json",
      ]) {
        expect(existsSync(join(dir, f))).toBe(true);
      }
      const cost = memoryIo();
      expect(await main(["cost", dir], cost, {})).toBe(0);
      expect(cost.stdout()).toMatch(/^seat {2}model/);
      expect(cost.stdout()).toContain("p1    claude-opus-5-5");
      expect(cost.stdout()).toContain("preflight $0.000000 · probes $0.000000 (0 checks)");
      expect(cost.stdout()).toMatch(/total \$[0-9]+\.[0-9]{6}\n$/);
      // Phase 4: the logged costs are the source of truth; --reprice shows today's cards beside them.
      const reprice = memoryIo();
      expect(await main(["cost", dir, "--reprice"], reprice, {})).toBe(0);
      expect(reprice.stdout()).toMatch(/repriced at today's cards: \$[0-9.]+ \(\+\$0\.000000\)\n$/);
      for (const f of ["estimate.json", "prompts/shared.txt"])
        expect(existsSync(join(dir, f))).toBe(true);
      const again = memoryIo();
      expect(await main(argv, again, {})).toBe(3);
      expect(again.stderr()).toContain("already holds a run");
    },
    LONG,
  );

  test("usage errors exit 3 and write nothing", async () => {
    const io = memoryIo();
    expect(await main(["run"], io, {})).toBe(3);
    expect(io.stderr()).toContain("--out <dir> is required");
    const dir = runDir();
    const noKey = memoryIo();
    expect(await main(["run", "--out", dir], noKey, JUNK)).toBe(3);
    expect(noKey.stderr()).toContain("PERFIDIA_ANTHROPIC_API_KEY is not set");
    expect(existsSync(dir)).toBe(false);
    const bad = memoryIo();
    expect(
      await main(
        ["run", "--fake", "--out", dir, "--seat", "p1=claude:opus-5-5:fast:odysseus"],
        bad,
        {},
      ),
    ).toBe(3);
    expect(bad.stderr()).toContain("effort must be one of");
    expect(existsSync(dir)).toBe(false);
    const unknown = memoryIo();
    expect(await main(["dance"], unknown, {})).toBe(3);
    expect(unknown.stderr()).toContain('unknown command "dance"');
    const help = memoryIo();
    expect(await main(["run", "--help"], help, {})).toBe(0);
    expect(help.stdout()).toContain("--seat <pN=spec>");
    for (const flag of [
      "--lineup",
      "--budget-usd",
      "--on-budget",
      "--budget-carry",
      "--prompt-cap",
    ]) {
      expect(help.stdout()).toContain(flag);
    }
    expect(await main([], memoryIo(), {})).toBe(3);
    // Phase 4 commands and flags.
    const all = memoryIo();
    expect(await main(["help"], all, {})).toBe(0);
    for (const c of ["estimate", "reconcile", "4 reconciliation outside tolerance", "claude-duo"]) {
      expect(all.stdout()).toContain(c);
    }
    const est = memoryIo();
    expect(await main(["estimate", "--help"], est, {})).toBe(0);
    expect(est.stdout()).not.toContain("--out <dir>");
    const lineup = memoryIo();
    expect(await main(["estimate", "--lineup", "no-such-lineup"], lineup, {})).toBe(3);
    expect(lineup.stderr()).toContain(
      "(the presets are claude-duo, claude-family, budget-mix, mid-tier, mid-tier-flash, frontier)",
    );
    const onBudget = memoryIo();
    expect(await main(["estimate", "--on-budget", "abort"], onBudget, {})).toBe(3);
    expect(onBudget.stderr()).toContain("--on-budget needs a match budget");
    const reconcile = memoryIo();
    expect(await main(["reconcile", dir], reconcile, {})).toBe(3);
    expect(reconcile.stderr()).toContain("exactly one of --input <file> and --usd");
    const missing = memoryIo();
    expect(await main(["reconcile", dir, "--usd", "anthropic=1"], missing, {})).toBe(3);
    expect(missing.stderr()).toContain("not a run directory");
  });

  test("smoke refuses to run without PERFIDIA_ANTHROPIC_API_KEY, whatever else is set", async () => {
    const io = memoryIo();
    expect(await main(["smoke"], io, JUNK)).toBe(3);
    expect(io.stderr()).toContain("set PERFIDIA_ANTHROPIC_API_KEY first. Nothing was sent.");
    // One "arena smoke:" prefix (the M1 rehearsal read it twice).
    expect(io.stderr()).toStartWith("arena smoke: this smoke makes one live API call (at most $");
  });

  test("personalities prints the four profiles' exact seat text", async () => {
    const io = memoryIo();
    expect(await main(["personalities"], io, {})).toBe(0);
    for (const id of ["odysseus@1", "achilles@1", "penelope@1", "agamemnon@1"]) {
      expect(io.stdout()).toContain(id);
    }
    expect(io.stdout()).toContain("You play {seat}.");
  });
});
