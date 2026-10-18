// Helpers for the arena tests: a temporary run directory, a fake plan (the default lineup on
// bot-backed fake models, the ruleset pinned at perfidia-1@1.1.0, the seed-derived id key), the
// files of a run read back and validated, and adapters that fail on cue.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryIo, readLog } from "@perfidia/sim";
import type { LogLine } from "@perfidia/protocol";
import {
  ArenaReportSchema,
  LlmLogLineSchema,
  SeatsFileSchema,
  type ArenaReport,
  type LlmCallLine,
  type LlmLogLine,
  type SeatsFile,
} from "../log/schema.ts";
import {
  ModelError,
  type ChatRequest,
  type ModelSpec,
  type PreflightReport,
  type UsageEntry,
} from "../model/adapter.ts";
import { FakeAdapter, type Brain } from "../model/fake.ts";
import { arenaEnv, planArena, type ArenaPlan, type ArenaRequest } from "./plan.ts";
import { runArena, type ArenaOutcome, type RunArenaOptions } from "./run.ts";

export const RULESET = "perfidia-1@1.1.0";
/** The design's integration lineup of fake brains (§7, item 7). */
export const BRAINS = ["p1=opportunist@3", "p2=conqueror@3", "p3=expander@2", "p4=turtle@3"];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A fresh empty directory; the run directory is a child of it, removed after the file's tests. */
export function runDir(name = "run"): string {
  const base = mkdtempSync(join(tmpdir(), "perfidia-arena-"));
  dirs.push(base);
  return join(base, name);
}

/** A `--fake` plan with `req` on top of the defaults of the tests. */
export function fakePlan(req: ArenaRequest = {}): ArenaPlan {
  return planArena(
    {
      ruleset: RULESET,
      fake: true,
      seed: 1,
      idKey: "seed",
      brains: BRAINS,
      ...req,
    },
    arenaEnv({}),
  );
}

export interface RunFiles {
  readonly outcome: ArenaOutcome;
  readonly lines: LogLine[];
  readonly calls: LlmLogLine[];
  readonly llm: LlmCallLine[];
  readonly report: ArenaReport;
  readonly seats: SeatsFile;
  readonly stdout: string;
  readonly stderr: string;
}

export function readCalls(dir: string): LlmLogLine[] {
  return readFileSync(join(dir, "llm_calls.jsonl"), "utf8")
    .split("\n")
    .filter((r) => r !== "")
    .map((r) => LlmLogLineSchema.parse(JSON.parse(r)));
}

/** Runs `plan` into a fresh directory and reads every file back (validated by its schema). */
export async function play(plan: ArenaPlan, o: Partial<RunArenaOptions> = {}): Promise<RunFiles> {
  const io = memoryIo();
  const dir = o.dir ?? runDir();
  const outcome = await runArena(plan, { ...o, dir, io });
  const calls = readCalls(dir);
  return {
    outcome,
    lines: readLog(join(dir, "match.jsonl")),
    calls,
    llm: calls.filter((l): l is LlmCallLine => l.k === "llm_call"),
    report: ArenaReportSchema.parse(JSON.parse(readFileSync(join(dir, "arena.json"), "utf8"))),
    seats: SeatsFileSchema.parse(JSON.parse(readFileSync(join(dir, "seats.json"), "utf8"))),
    stdout: io.stdout(),
    stderr: io.stderr(),
  };
}

/**
 * A fake model whose preflight fails while `down()` holds (the pause gate's probe); a passing
 * preflight reports `usage` (default none: free).
 */
export class FlakyAdapter extends FakeAdapter {
  private readonly down: () => ModelError | null;
  private readonly usage: readonly UsageEntry[];

  constructor(
    spec: ModelSpec,
    brain: Brain,
    down: () => ModelError | null,
    usage: readonly UsageEntry[] = [],
  ) {
    super(spec, brain);
    this.down = down;
    this.usage = usage;
  }

  override async preflight(sample: ChatRequest): Promise<PreflightReport> {
    const e = this.down();
    if (e !== null) throw e;
    return { ...(await super.preflight(sample)), usage: this.usage };
  }
}

test("the rig's fake plan pins the ruleset and the brains", () => {
  const plan = fakePlan({ days: 1 });
  expect(plan.setup.ruleset).toBe(RULESET);
  expect(plan.seats.flatMap((s) => (s.kind === "llm" ? [s.brain] : []))).toEqual([
    "bot:opportunist@3",
    "bot:conqueror@3",
    "bot:expander@2",
    "bot:turtle@3",
  ]);
});
