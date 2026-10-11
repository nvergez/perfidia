import { EXIT, UsageError, type CliIo } from "./args.ts";
import { BATCH_USAGE, batchCommand } from "./batch/index.ts";
import { GOLDEN_USAGE, goldenCommand } from "./golden/index.ts";
import { RUN_USAGE, runCommand } from "./run/index.ts";
import { SUMMARY_USAGE, summaryCommand } from "./summary/index.ts";
import { VERIFY_USAGE, verifyCommand } from "./verify/index.ts";

// The `sim` command line (docs/architecture.md §12.1): `bun run sim -- <command>`, where the root
// script runs `bun packages/sim/src/cli.ts`. Exit codes: 0 ok, 1 replay divergence, 2 fatal, 3
// usage or config error. `main` takes its output streams as arguments, so tests run it in-process.

export const USAGE = [
  "usage: bun run sim -- <command> [flags]",
  "",
  "commands:",
  "  run      play a match with bots into a run directory (match.jsonl, snapshots, summary.json)",
  "  verify   replay a log at Level E (--from a snapshot, --dump on a divergence, --resim for Level G)",
  "  batch    play variants × seeds in lockstep and compare them (--pacing, --json)",
  "  summary  summarise a log",
  "  golden   check the committed goldens and fingerprints, or add missing ones",
  "",
  "`bun run sim -- <command> --help` lists a command's flags.",
  "exit codes: 0 ok, 1 replay divergence, 2 fatal error, 3 usage or config error",
  "",
].join("\n");

const COMMAND_USAGE: Readonly<Record<string, string>> = {
  run: RUN_USAGE,
  verify: VERIFY_USAGE,
  batch: BATCH_USAGE,
  summary: SUMMARY_USAGE,
  golden: GOLDEN_USAGE,
};

function dispatch(command: string, argv: readonly string[], io: CliIo): Promise<number> | number {
  switch (command) {
    case "run":
      return runCommand(argv, io);
    case "verify":
      return verifyCommand(argv, io);
    case "batch":
      return batchCommand(argv, io);
    case "summary":
      return summaryCommand(argv, io);
    case "golden":
      return goldenCommand(argv, io);
    default:
      throw new UsageError(`unknown command "${command}"\n\n${USAGE}`);
  }
}

/** Runs one `sim` command line; returns its exit code. Never throws. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = args;
  if (command === undefined) {
    io.err(USAGE);
    return EXIT.usage;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return EXIT.ok;
  }
  const usage = COMMAND_USAGE[command];
  if (usage !== undefined && (rest.includes("--help") || rest.includes("-h"))) {
    io.out(usage);
    return EXIT.ok;
  }
  try {
    return await dispatch(command, rest, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`sim ${command}: ${error.message}\n`);
      return EXIT.usage;
    }
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    io.err(`sim ${command}: error: ${text}\n`);
    return EXIT.fatal;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
