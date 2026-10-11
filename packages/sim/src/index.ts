// @perfidia/sim: the headless match runner (docs/architecture.md §12): the shared harness (as the
// `harness` namespace, so a name it adds never collides with the rest), run
// directories and log files, the `run`, `verify`, `batch`, `summary` and `golden` commands, and the
// command line itself (`cli.ts`).

export * as harness from "./harness/index.ts";
export * from "./io/index.ts";
export * from "./run/index.ts";
export * from "./verify/index.ts";
export * from "./summary/index.ts";
export * from "./batch/index.ts";
export * from "./golden/index.ts";
export {
  EXIT,
  Flags,
  UsageError,
  errorText,
  memoryIo,
  parseFlags,
  parseIntIn,
  parseLatency,
  parseSeeds,
  parseSpeed,
  usageText,
  type CliIo,
  type ExitCode,
  type FlagSpec,
  type FlagSpecs,
} from "./args.ts";
export { USAGE, main } from "./cli.ts";
