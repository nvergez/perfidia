import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RULESETS, findRuleset } from "@perfidia/engine";
import { EXIT, parseFlags, usageText, type CliIo, type FlagSpecs } from "../args.ts";
import { SUMMARY_FILE, isCorruptLog, locateLog, readLogLines } from "../io/index.ts";
import { formatSummary } from "./format.ts";
import { LogShapeError, summarize } from "./summarize.ts";

// `sim summary <run-dir | match.jsonl> [--json]` (docs/architecture.md §12.1, §12.2).

const FLAGS: FlagSpecs = {
  json: { type: "boolean", help: "print the summary as JSON" },
};
export const SUMMARY_USAGE = usageText("sim summary <run-dir | match.jsonl> [--json]", FLAGS);

/** The wall time the run recorded in its `summary.json`, if any (the log itself has none). */
function recordedWallMs(dir: string): number | null {
  const path = join(dir, SUMMARY_FILE);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value === "object" && value !== null && "wallMs" in value) {
      const ms = value.wallMs;
      return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function summaryCommand(argv: readonly string[], io: CliIo): number {
  const flags = parseFlags(argv, FLAGS, SUMMARY_USAGE, { min: 1, max: 1, name: "run" });
  const { log, dir } = locateLog(flags.positionals[0] ?? "");
  let summary;
  try {
    summary = summarize(readLogLines(log), { wallMs: recordedWallMs(dir) });
  } catch (error) {
    if (isCorruptLog(error) || error instanceof LogShapeError) {
      io.err(`${log}: ${error.message}\n`);
      return EXIT.divergence;
    }
    throw error;
  }
  // The summary needs no ruleset, but a ref this build lacks means `verify` cannot replay the log.
  if (findRuleset(summary.ruleset) === undefined) {
    io.err(
      `warning: the log's ruleset ${summary.ruleset} is not in this build (it contains ${RULESETS.map((r) => r.ref).join(", ")}), so it cannot be verified here\n`,
    );
  }
  io.out(flags.bool("json") ? `${JSON.stringify(summary, null, 2)}\n` : formatSummary(summary));
  return EXIT.ok;
}
