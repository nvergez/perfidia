import {
  UsageError,
  parseFlags,
  usageText,
  type CliIo,
  type ExitCode,
  type FlagSpecs,
} from "../args.ts";
import { INVARIANT_LEVELS } from "../run/index.ts";
import { verifyRun } from "./verify.ts";

// `sim verify <run-dir | match.jsonl> [--from h072] [--resim] [--dump] [--invariants step]` (§12.1).

const FLAGS: FlagSpecs = {
  from: {
    type: "string",
    value: "<hNNN | file>",
    help: "resume after the checkpoint of this snapshot (e.g. h072, or a snapshot file)",
  },
  resim: {
    type: "boolean",
    help: "also re-simulate the match (Level G) and compare the normalised logs",
  },
  dump: {
    type: "boolean",
    help: "on a divergence, write the state at the first divergent checkpoint and diff it",
  },
  invariants: {
    type: "string",
    value: "off|checkpoint|step",
    help: "invariant checks during the replay (default checkpoint)",
  },
};
export const VERIFY_USAGE = usageText("sim verify <run-dir | match.jsonl> [flags]", FLAGS);

export function verifyCommand(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  const f = parseFlags(argv, FLAGS, VERIFY_USAGE, { min: 1, max: 1, name: "run" });
  const inv = f.string("invariants");
  const level = inv === undefined ? undefined : INVARIANT_LEVELS.find((l) => l === inv);
  if (inv !== undefined && level === undefined) {
    throw new UsageError(
      `--invariants must be one of ${INVARIANT_LEVELS.join(", ")}, got "${inv}"`,
    );
  }
  return verifyRun(
    {
      target: f.positionals[0] ?? "",
      from: f.string("from"),
      resim: f.bool("resim"),
      dump: f.bool("dump"),
      invariants: level,
    },
    io,
  );
}
