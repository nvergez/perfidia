import { canonicalJson } from "@perfidia/engine/core";
import type { RunResult } from "@perfidia/gateway";
import { EXIT, errorText, type ExitCode } from "../args.ts";
import { prepareBotRun, runPrepared, systemWall } from "../harness/index.ts";
import { RunDirSink, readLogLines, writeFileAtomic, type RunPaths } from "../io/index.ts";
import { summarize, type MatchSummary } from "../summary/index.ts";
import type { RunPlan } from "./plan.ts";
import { writeTrace } from "./trace.ts";

// Executing a planned run into a run directory (docs/architecture.md §10.1, §12.1): the bots through
// the harness, the chosen clock, `wall` from the system clock (informational `wall*` keys), the log
// and snapshots through the run directory's file sink, then `summary.json` from the written log and,
// with `--trace-hashes`, `trace.jsonl`.

export interface RunOutcome {
  readonly paths: RunPaths;
  /**
   * 0; 2 when the match stopped on a fatal error (its log ends with the fatal line); 1 when the
   * `--trace-hashes` replay of a finished run diverged.
   */
  readonly code: ExitCode;
  readonly summary: MatchSummary;
  readonly result: RunResult | null;
  readonly error: string | null;
  /** Wall duration of the match, in ms. */
  readonly wallMs: number;
  /** Actions traced into `trace.jsonl` with `--trace-hashes`, or null. */
  readonly traced: number | null;
}

/**
 * Runs `plan` into `dir`, which must not hold a run yet (`freeRunDir`): a directory that does is
 * refused with a `UsageError` before anything is written.
 */
export async function executeRun(plan: RunPlan, dir: string): Promise<RunOutcome> {
  const sink = new RunDirSink(dir);
  const prepared = prepareBotRun({
    ruleset: plan.ruleset,
    seed: plan.setup.seed,
    players: plan.setup.seats.length,
    overrides: plan.setup.overrides,
    idKey: plan.setup.idKey,
    bots: plan.bots,
    seatBots: plan.seatBots,
    clock: plan.clock,
    invariants: plan.invariants,
    snapshotEvery: plan.snapshotEvery,
  });
  if (canonicalJson(prepared.options.setup) !== canonicalJson(plan.setup)) {
    throw new Error("sim run: the harness built another setup than the plan's");
  }
  const options = { ...prepared.options, wall: prepared.options.wall ?? systemWall };
  const t0 = performance.now();
  let result: RunResult | null = null;
  let error: string | null = null;
  try {
    result = await runPrepared({ options, virtual: prepared.virtual }, sink);
  } catch (e) {
    // The host wrote the fatal line and flushed before rethrowing (§8.7).
    error = errorText(e);
  }
  const wallMs = Math.round(performance.now() - t0);
  sink.flush();

  const summary = summarize(readLogLines(sink.paths.log), { wallMs });
  writeFileAtomic(sink.paths.summary, `${JSON.stringify(summary, null, 2)}\n`);

  let code: ExitCode = error === null ? EXIT.ok : EXIT.fatal;
  let traced: number | null = null;
  if (plan.traceHashes) {
    // Also after a fatal stop: the trace up to the fatal line is what localises it.
    const trace = writeTrace(sink.paths.log, sink.paths.trace);
    traced = trace.traced;
    if (trace.problem !== null) {
      if (error === null) {
        error = trace.problem;
        code = EXIT.divergence;
      } else error = `${error}; ${trace.problem}`;
    }
  }
  return {
    paths: sink.paths,
    code,
    summary,
    result,
    error,
    wallMs,
    traced,
  };
}
